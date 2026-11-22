"""Live paper trading for the Statistical Arbitrage Lab.

During US market hours, roughly once a minute:
  1. fetch current quotes (Nasdaq quote API; each labelled live / delayed by the
     provider's own real-time flag) for every watched pair and open position
  2. recompute each pair's z-score with the current prices against the pair's
     daily spread history (strategy I: Kalman hedge ratio, adaptive lookback)
  3. exit open positions on convergence, stop, cointegration breakdown or time stop
  4. open new positions when |z| crosses the volatility-adjusted entry band AND
     the statistical gates (rolling Engle-Granger, ADF, half-life) passed at the
     last close AND every risk limit allows it
Fills are simulated at the quoted ask (buys) / bid (sells); when the provider
gives no bid/ask, the last price plus the configured half-spread + slippage is
used and the fill is labelled that way. Nothing is ever sent to a broker.

    DATABASE_URL=... python -m ql.live --minutes 175     (GitHub Actions)
"""
from __future__ import annotations

import argparse
import datetime as dt
import math
import os
import sys
import time
import uuid

import numpy as np
import pandas as pd

os.environ.setdefault("QL_NO_APP", "1")

from .data import NY, Data, market_open  # noqa: E402
from .db import DB  # noqa: E402
from .salab import DEFAULT_CONFIG, equity as book_equity  # noqa: E402
from .strategies import LIBRARY, run as run_strategy  # noqa: E402

POLL_SECONDS = 60
MAX_EQUITY_POINTS = 3000


def _r(x, n=4):
    try:
        x = float(x)
        return round(x, n) if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def now_ny() -> str:
    return dt.datetime.now(NY).strftime("%Y-%m-%d %H:%M:%S ET")


class LiveEngine:
    def __init__(self, data: Data, owner: str, log=print):
        self.data, self.db, self.owner, self.log = data, data.db, owner, log
        self.ctx: dict = {}
        self.ctx_day = None

    # ------------------------------------------------------------ lease
    def lease(self) -> bool:
        cur = self.db.kv_get("live_lease") or {}
        t = time.time()
        if cur.get("owner") not in (None, self.owner) and cur.get("until", 0) > t:
            return False
        self.db.kv_set("live_lease", {"owner": self.owner, "until": t + 180})
        return True

    def release(self):
        if (self.db.kv_get("live_lease") or {}).get("owner") == self.owner:
            self.db.kv_set("live_lease", {})

    # ------------------------------------------------------------ daily context
    def prepare(self, cfg) -> None:
        """Per-pair statistics from daily closes, refreshed once per day."""
        scan = self.db.kv_get("latest_scan") or {}
        day = scan.get("asof")
        book = self.db.kv_get("sa_paper") or {}
        held = {(p["y"], p["x"]) for p in book.get("positions", [])}
        pairs = [(r["y"], r["x"], r) for r in scan.get("accepted", [])[:int(cfg.get("watch_pairs", 12))]]
        pairs += [(y, x, None) for (y, x) in held if (y, x) not in {(a, b) for a, b, _ in pairs}]
        if self.ctx_day == (day, tuple(sorted(held))) and self.ctx:
            return
        key = cfg["strategy"] if cfg["strategy"] in LIBRARY else "I"
        params = {"entry": cfg["entry"], "exit": cfg["exit"], "stop": cfg["stop"], "hold_mult": cfg["hold_mult"]}
        ctx = {}
        for y, x, row in pairs:
            p = self.data.panel([y, x])
            if not p["ok"]:
                continue
            C = p["close"][[y, x]]
            out = run_strategy(key, C, p["open"][[y, x]], params)
            d = out.diag
            if "beta" not in d or "half_life" not in d:
                continue
            beta = float(d["beta"].iloc[-1]); hl = float(d["half_life"].iloc[-1])
            lbm = float(LIBRARY["I"].defaults["lb_mult"])
            L = int(np.clip(round(lbm * hl), 20, 90)) if math.isfinite(hl) else 40
            spread_hist = (np.log(C[y]) - d["beta"] * np.log(C[x])).to_numpy()[-(L - 1):]
            cp = float(d["coint_p"].iloc[-1]) if "coint_p" in d else float("nan")
            ap = float(d["adf_p"].iloc[-1]) if "adf_p" in d else float("nan")
            band = float(d["entry_band"].iloc[-1]) if "entry_band" in d and math.isfinite(d["entry_band"].iloc[-1]) else cfg["entry"]
            gate = (math.isfinite(cp) and cp < 0.05 and math.isfinite(ap) and ap < 0.05 and math.isfinite(hl)
                    and 2 <= hl <= 30 and beta > 0)
            ctx[(y, x)] = {"y": y, "x": x, "beta": beta, "half_life": hl, "L": L, "hist": spread_hist, "coint_p": cp, "adf_p": ap,
                           "band": band, "gate": gate, "breakdown": math.isfinite(cp) and cp > 0.20, "close_date": str(C.index[-1].date()),
                           "last_close": {y: float(C[y].iloc[-1]), x: float(C[x].iloc[-1])},
                           "sector": (row or {}).get("sector"), "min_dollar_vol": (row or {}).get("min_dollar_vol")}
        self.ctx, self.ctx_day = ctx, (day, tuple(sorted(held)))
        self.log(f"live: prepared {len(ctx)} pairs from closes to {day}")

    # ------------------------------------------------------------ quotes & fills
    def quotes(self, symbols) -> dict:
        out = {}
        for s in symbols:
            out[s] = self.data.quote(s, max_age=20)
        return out

    @staticmethod
    def fill_price(q: dict, qty: float, half: float):
        """Buy at the ask, sell at the bid; else last ± half-spread + slippage."""
        bid, ask, last = q.get("bid"), q.get("ask"), q.get("price")
        if qty > 0 and ask and ask > 0 and math.isfinite(ask):
            return ask, "ask"
        if qty < 0 and bid and bid > 0 and math.isfinite(bid):
            return bid, "bid"
        return last * (1 + half * np.sign(qty)), "last±cost"

    def z_live(self, c, py, px):
        s = math.log(py) - c["beta"] * math.log(px)
        w = np.append(c["hist"], s)
        sd = w.std(ddof=1)
        return (s - w.mean()) / sd if sd > 0 else float("nan")

    # ------------------------------------------------------------ one poll
    def poll(self) -> dict:
        cfg = {**DEFAULT_CONFIG, **(self.db.kv_get("sa_config") or {})}
        costs = {**{"fee_bps": 0.5, "spread_bps": 4.0, "slippage_bps": 2.0, "borrow_bps": 50.0}, **(self.db.kv_get("costs") or {})}
        half = (costs["spread_bps"] / 2 + costs["slippage_bps"]) / 1e4
        fee = costs["fee_bps"] / 1e4
        snap = {"at": time.time(), "at_ny": now_ny(), "market_open": market_open(), "owner": self.owner.split("-")[0], "pairs": []}
        if not market_open():
            snap["note"] = "US market closed — live paper trading resumes at the next open (9:30 ET / 8:00 PM IST)."
            self.db.kv_set("sa_live", snap)
            return snap
        self.prepare(cfg)
        book = self.db.kv_get("sa_paper") or {"cash": cfg["capital"], "start_cash": cfg["capital"], "positions": [], "closed": [], "equity": [],
                                                "halted": None, "events": [], "fees": 0.0, "slippage": 0.0, "borrow": 0.0}
        book.setdefault("trade_log", []); book.setdefault("intraday", [])
        syms = sorted({s for c in self.ctx.values() for s in (c["y"], c["x"])} | {s for p in book["positions"] for s in (p["y"], p["x"])})
        Q = self.quotes(syms)
        today = dt.datetime.now(NY).date().isoformat()

        def log_trade(kind, p, prices, note, extra=None):
            e = {"time": now_ny(), "ts": time.time(), "kind": kind, "pair": f"{p['y']}/{p['x']}", "side": "long spread" if p["side"] > 0 else "short spread",
                 "y": p["y"], "x": p["x"], "qty_y": _r(p["qty_y"], 4), "qty_x": _r(p["qty_x"], 4), "px_y": _r(prices[0], 4), "px_x": _r(prices[1], 4),
                 "fill_y": prices[2], "fill_x": prices[3], "quote_status": prices[4], "source": f"{(Q.get(p['y']) or {}).get('source', '')} / {(Q.get(p['x']) or {}).get('source', '')}",
                 "z": _r(p.get("z_live"), 3), "note": note, **(extra or {})}
            book["trade_log"] = (book["trade_log"] + [e])[-500:]
            self.log(f"live paper {kind}: {e['pair']} {e['side']} · {note}")

        def ok_quote(q):
            return q and q.get("price") and q.get("status") in ("live", "delayed")

        # ---- exits
        for p in list(book["positions"]):
            if p["status"] not in ("open",):
                continue
            c = self.ctx.get((p["y"], p["x"]))
            qy, qx = Q.get(p["y"]), Q.get(p["x"])
            if not (c and ok_quote(qy) and ok_quote(qx)):
                continue
            z = self.z_live(c, qy["price"], qx["price"]); p["z_live"] = z
            sessions = len(pd.bdate_range(p.get("entry_date") or today, today)) - 1
            why = None
            if c["breakdown"]:
                why = "cointegration breakdown (rolling EG p > 0.20)"
            elif abs(z) >= cfg["stop"]:
                why = f"stop |z| ≥ {cfg['stop']}"
            elif (p["side"] > 0 and z >= -cfg["exit"]) or (p["side"] < 0 and z <= cfg["exit"]):
                why = f"converged (|z| ≤ {cfg['exit']})"
            elif p.get("half_life") and sessions >= cfg["hold_mult"] * p["half_life"]:
                why = f"time stop ({sessions} sessions ≥ {cfg['hold_mult']} × half-life)"
            if not why:
                continue
            fy, sy = self.fill_price(qy, -p["qty_y"], half); fx, sx = self.fill_price(qx, -p["qty_x"], half)
            f = (abs(p["qty_y"]) * fy + abs(p["qty_x"]) * fx) * fee
            sl = abs(p["qty_y"]) * abs(fy - qy["price"]) + abs(p["qty_x"]) * abs(fx - qx["price"])
            book["cash"] += p["qty_y"] * fy + p["qty_x"] * fx - f
            p["fees"] += f; p["slippage"] += sl; book["fees"] += f; book["slippage"] += sl
            gross = p["qty_y"] * (fy - p["entry_y"]) + p["qty_x"] * (fx - p["entry_x"])
            net = gross - p["fees"] - p["borrow"]
            book["closed"].append({**p, "status": "closed", "exit_date": today, "exit_time": now_ny(), "exit_y": fy, "exit_x": fx, "exit_reason": why,
                                   "gross_pnl": round(gross + p["slippage"], 4), "net_pnl": round(net, 4), "z_exit": _r(z, 3),
                                   "leg_pnl": {p["y"]: round(p["qty_y"] * (fy - p["entry_y"]), 4), p["x"]: round(p["qty_x"] * (fx - p["entry_x"]), 4)}})
            book["positions"].remove(p)
            log_trade("EXIT", p, (fy, fx, sy, sx, f"{qy['status']}/{qx['status']}"), f"{why}; net {net:+.2f} USD", {"net_pnl": round(net, 4)})

        # ---- marks, equity, halt
        def mark(s):
            q = Q.get(s)
            if q and q.get("price"):
                return q["price"]
            b = self.data.bars(s)
            return float(b["c"].iloc[-1]) if len(b) else None
        eq = book_equity(book, mark)
        peak = max([e for _, e in book.get("equity", [])] + [v for _, v in book["intraday"][-500:]] + [book["start_cash"]])
        if not book.get("halted") and eq < peak * (1 - cfg["max_drawdown"]):
            book["halted"] = today; book["events"] = (book.get("events", []) + [f"{now_ny()} · drawdown limit breached — new entries blocked"])[-200:]

        # ---- entries
        live = [q for q in book["positions"]]
        for (y, x), c in self.ctx.items():
            qy, qx = Q.get(y), Q.get(x)
            row = {"pair": f"{y}/{x}", "y": y, "x": x, "beta": _r(c["beta"]), "half_life": _r(c["half_life"], 2), "coint_p": _r(c["coint_p"]),
                   "adf_p": _r(c["adf_p"]), "band": _r(c["band"], 3), "gate": bool(c["gate"]), "close_date": c["close_date"],
                   "py": _r((qy or {}).get("price")), "px": _r((qx or {}).get("price")), "status_y": (qy or {}).get("status"), "status_x": (qx or {}).get("status"),
                   "time_y": (qy or {}).get("provider_time"), "time_x": (qx or {}).get("provider_time"),
                   "src_y": (qy or {}).get("source"), "src_x": (qx or {}).get("source")}
            if ok_quote(qy) and ok_quote(qx):
                z = self.z_live(c, qy["price"], qx["price"]); row["z"] = _r(z, 3)
            else:
                z = float("nan"); row["z"] = None; row["why_not"] = "quote unavailable"
            held = next((p for p in book["positions"] if (p["y"], p["x"]) == (y, x)), None)
            row["position"] = (held or {}).get("side", 0)
            snap["pairs"].append(row)
            if held or not math.isfinite(z) or not (c["band"] <= abs(z) < cfg["stop"]):
                continue
            blocked = []
            if not c["gate"]:
                blocked.append("statistical gate closed (EG/ADF/half-life at last close)")
            if book.get("halted"):
                blocked.append("drawdown halt")
            if len(live) >= cfg["max_pairs"]:
                blocked.append("max simultaneous pairs")
            if any({y, x} & {q["y"], q["x"]} for q in live):
                blocked.append("a leg is already held")
            if c["sector"] and sum(1 for q in live if q.get("sector") == c["sector"]) >= cfg["max_per_sector"]:
                blocked.append("sector concentration")
            if (c["min_dollar_vol"] or 0) < cfg["min_dollar_volume"]:
                blocked.append("liquidity")
            for q in (qy, qx):
                if q.get("bid") and q.get("ask") and q["ask"] > q["bid"] > 0 and (q["ask"] - q["bid"]) / q["price"] * 1e4 > 25:
                    blocked.append(f"{q['symbol']} bid-ask wider than 25 bp")
            if any(p.get("y") == y and p.get("x") == x and p.get("exit_date") == today for p in book["closed"][-50:]):
                blocked.append("cooldown (exited this pair today)")
            if blocked:
                row["why_not"] = "; ".join(blocked)
                continue
            side = -1 if z > 0 else 1
            notional = min(cfg["risk_per_pair"] * eq * cfg["leverage"], max(0.0, cfg["leverage"] * eq - _gross(book, mark)))
            if notional < 5:
                row["why_not"] = "no capital capacity"; continue
            wy, wx = 1 / (1 + c["beta"]), c["beta"] / (1 + c["beta"])
            qty_y = side * wy * notional / qy["price"]; qty_x = -side * wx * notional / qx["price"]
            fy, sy = self.fill_price(qy, qty_y, half); fx, sx = self.fill_price(qx, qty_x, half)
            f = (abs(qty_y) * fy + abs(qty_x) * fx) * fee
            sl = abs(qty_y) * abs(fy - qy["price"]) + abs(qty_x) * abs(fx - qx["price"])
            book["cash"] -= qty_y * fy + qty_x * fx + f
            p = {"id": uuid.uuid4().hex[:8], "y": y, "x": x, "sector": c["sector"], "side": side, "qty_y": qty_y, "qty_x": qty_x,
                 "entry_y": fy, "entry_x": fx, "entry_date": today, "entry_time": now_ny(), "hedge_ratio": _r(c["beta"]), "half_life": _r(c["half_life"], 2),
                 "z_entry": _r(z, 3), "z_live": z, "status": "open", "fees": f, "slippage": sl, "borrow": 0.0, "strategy": "I-live",
                 "why": f"live z {z:.2f} beyond band ±{c['band']:.2f}; EG p {c['coint_p']:.3f}, ADF p {c['adf_p']:.3f}, half-life {c['half_life']:.1f}"}
            book["positions"].append(p); live.append(p)
            book["fees"] += f; book["slippage"] += sl
            log_trade("ENTRY", p, (fy, fx, sy, sx, f"{qy['status']}/{qx['status']}"), p["why"])
            row["position"] = side

        eq = book_equity(book, mark)
        book["intraday"] = (book["intraday"] + [[now_ny(), round(eq, 4)]])[-MAX_EQUITY_POINTS:]
        book["live_updated"] = now_ny()
        for p in book["positions"]:
            if p["status"] == "open":
                p["unrealized_live"] = _r(p["qty_y"] * (mark(p["y"]) - p["entry_y"]) + p["qty_x"] * (mark(p["x"]) - p["entry_x"]), 4)
        self.db.kv_set("sa_paper", book)
        snap.update(equity=round(eq, 4), positions=len(book["positions"]), quotes={s: {k: Q[s].get(k) for k in ("price", "bid", "ask", "status", "provider_time", "error", "source")} for s in syms})
        statuses = [q.get("status") for q in Q.values()]
        snap["data_status"] = "live" if statuses and all(s == "live" for s in statuses) else "delayed" if any(s in ("live", "delayed") for s in statuses) else "unavailable"
        self.db.kv_set("sa_live", snap)
        return snap


def _gross(book, mark):
    g = 0.0
    for p in book["positions"]:
        if p["status"] == "open":
            g += abs(p["qty_y"] * mark(p["y"])) + abs(p["qty_x"] * mark(p["x"]))
    return g


def run_loop(engine: LiveEngine, minutes: float, stop=lambda: False):
    deadline = time.time() + minutes * 60
    closed_polls = 0
    while time.time() < deadline and not stop():
        t0 = time.time()
        if engine.lease():
            try:
                s = engine.poll()
                closed_polls = 0 if s.get("market_open") else closed_polls + 1
            except Exception as e:
                engine.log(f"live: error {e}")
        n = dt.datetime.now(NY)
        after_close = n.weekday() >= 5 or n.hour >= 16
        if closed_polls >= 3 and after_close and minutes < 600:
            break          # scheduled job: today's session is over, stop early
        time.sleep(max(5, POLL_SECONDS - (time.time() - t0)))
    engine.release()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=float, default=175)
    a = ap.parse_args()
    if not os.environ.get("DATABASE_URL", "").startswith("postgres"):
        print("DATABASE_URL (Postgres) is not set", file=sys.stderr)
        return 2
    eng = LiveEngine(Data(DB()), owner=f"github-{os.getpid()}")
    run_loop(eng, a.minutes)
    print("live run finished")
    return 0


if __name__ == "__main__":
    sys.exit(main())
