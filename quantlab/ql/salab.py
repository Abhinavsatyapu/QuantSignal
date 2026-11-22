"""Statistical Arbitrage Lab: horizon backtests (30/60/90/180 days), pooled
comparison across pairs, and the independent $1,000 paper-trading engine.

Horizon backtests use each strategy's DEFAULT parameters (fixed in advance, not
fitted on the window being reported) with full history before the window as
warm-up. Walk-forward results for the same strategies come from the research
agent and are reported separately as the out-of-sample evidence."""
from __future__ import annotations

import math
import time
import uuid

import numpy as np
import pandas as pd

from . import backtest as bt
from . import engine
from .data import last_session
from .strategies import LIBRARY, run as run_strategy

HORIZONS = (30, 60, 90, 180)
COMPARE = ["K", "A", "V", "B", "I"]      # correlation, cointegration, video z-score, single-stock z-score, improved
LABELS = {"K": "Basic correlation pairs", "A": "Cointegration pairs", "V": "Video z-score pairs (lecture rules)",
          "B": "Single-stock z-score", "I": "Improved adaptive stat-arb"}

DEFAULT_CONFIG = {"capital": 1000.0, "max_pairs": 3, "risk_per_pair": 0.30, "leverage": 1.0, "entry": 2.0, "exit": 0.5,
                  "stop": 3.5, "hold_mult": 3.0, "max_drawdown": 0.15, "max_per_sector": 2, "strategy": "I",
                  "stale_sessions": 2, "min_dollar_volume": 20e6}


def _r(x, n=4):
    try:
        x = float(x)
        return round(x, n) if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


KEEP = ["net_pnl", "gross_pnl", "total_return", "win_rate", "trades", "avg_win", "avg_loss", "profit_factor", "sharpe", "sortino",
        "max_drawdown", "calmar", "avg_holding_days", "max_consecutive_losses", "fees", "slippage_costs", "borrow_costs",
        "exposure", "capital_utilization", "open_trades"]


def pair_study(panel: dict, pair: list[str], capital: float, costs: bt.Costs) -> dict:
    """All comparison strategies × all horizons on one pair."""
    C = panel["close"]
    end = C.index[-1]
    out = {"pair": pair, "end": str(end.date()), "horizons": {}}
    for h in HORIZONS:
        start = end - pd.Timedelta(days=h)
        sess = int(((C.index > start) & (C.index <= end)).sum())
        row = {"sessions": sess, "start": str(C.index[C.index > start][0].date()) if sess else None}
        for k in COMPARE:
            r = engine.backtest(panel, k, pair, None, str(start.date()), str(end.date()), capital, costs)
            m = r["metrics"]
            d = r["_res"].daily.reindex(r["_res"].equity.dropna().index).fillna(0)
            row[k] = {**{x: m.get(x) for x in KEEP}, "daily": [_r(v, 6) for v in d.to_numpy()], "dates": [str(t.date()) for t in d.index],
                      "trades_list": r["trades"][-20:]}
        out["horizons"][str(h)] = row
    return out


def pooled(studies: list[dict], capital: float) -> dict:
    """Equal-capital portfolio across all studied pairs, per horizon and strategy."""
    res = {}
    for h in HORIZONS:
        hs = str(h)
        res[hs] = {}
        for k in COMPARE:
            frames, trades, net, gross, fees, slip, bor = [], [], 0.0, 0.0, 0.0, 0.0, 0.0
            for s in studies:
                row = (s.get("horizons") or {}).get(hs, {}).get(k)
                if not row:
                    continue
                frames.append(pd.Series(row["daily"], index=pd.to_datetime(row["dates"])))
                trades.extend(row.get("trades_list") or [])
                net += row.get("net_pnl") or 0; gross += row.get("gross_pnl") or 0
                fees += row.get("fees") or 0; slip += row.get("slippage_costs") or 0; bor += row.get("borrow_costs") or 0
            if not frames:
                continue
            d = pd.concat(frames, axis=1).fillna(0).mean(axis=1)
            eq = (1 + d).cumprod()
            dd = float((eq / eq.cummax() - 1).min())
            sd = d.std(ddof=1)
            nt = sum((s.get("horizons") or {}).get(hs, {}).get(k, {}).get("trades") or 0 for s in studies)
            wins = sum(round((s.get("horizons") or {}).get(hs, {}).get(k, {}).get("win_rate") or 0, 6) * ((s.get("horizons") or {}).get(hs, {}).get(k, {}).get("trades") or 0) for s in studies)
            closed = [t for t in trades if not t.get("open")]
            streak = mx = 0
            for t in sorted(closed, key=lambda t: t["exit"] or ""):
                streak = streak + 1 if t["pnl"] <= 0 else 0; mx = max(mx, streak)
            wl = [t["pnl"] for t in closed]
            res[hs][k] = {"pairs": len(frames), "total_return": _r(eq.iloc[-1] - 1), "net_pnl": _r(net, 2), "gross_pnl": _r(gross, 2),
                          "trades": nt, "win_rate": _r(wins / nt) if nt else None,
                          "avg_win": _r(np.mean([x for x in wl if x > 0]), 2) if any(x > 0 for x in wl) else None,
                          "avg_loss": _r(np.mean([x for x in wl if x <= 0]), 2) if any(x <= 0 for x in wl) else None,
                          "profit_factor": _r(sum(x for x in wl if x > 0) / -sum(x for x in wl if x <= 0)) if any(x <= 0 for x in wl) and sum(x for x in wl if x <= 0) < 0 else None,
                          "sharpe": _r(d.mean() / sd * math.sqrt(252)) if sd > 0 and len(d) > 5 else None,
                          "sortino": _r(d.mean() * 252 / (math.sqrt((d[d < 0] ** 2).sum() / len(d)) * math.sqrt(252))) if (d < 0).any() else None,
                          "max_drawdown": _r(dd), "calmar": _r((eq.iloc[-1] ** (252 / max(len(d), 1)) - 1) / abs(dd)) if dd < 0 else None,
                          "max_consecutive_losses": mx, "fees": _r(fees, 2), "slippage_costs": _r(slip, 2), "borrow_costs": _r(bor, 2),
                          "capital": capital * len(frames), "sessions": len(d)}
    best = {}
    for hs, row in res.items():
        c = [(k, v) for k, v in row.items() if v.get("sharpe") is not None and v["sharpe"] > 0 and (v.get("trades") or 0) >= 5]
        best[hs] = max(c, key=lambda kv: kv[1]["sharpe"])[0] if c else None
    return {"by_horizon": res, "best_by_sharpe": best}


# ---------------------------------------------------------------- $1,000 paper engine
def paper_update(data, db, scan_res: dict, log) -> dict:
    cfg = {**DEFAULT_CONFIG, **(db.kv_get("sa_config") or {})}
    costs = {**{"fee_bps": 0.5, "spread_bps": 4.0, "slippage_bps": 2.0, "borrow_bps": 50.0}, **(db.kv_get("costs") or {})}
    book = db.kv_get("sa_paper") or {"cash": cfg["capital"], "start_cash": cfg["capital"], "positions": [], "closed": [], "equity": [],
                                     "halted": None, "events": [], "fees": 0.0, "slippage": 0.0, "borrow": 0.0}
    half = (costs["spread_bps"] / 2 + costs["slippage_bps"]) / 1e4
    fee = costs["fee_bps"] / 1e4
    bday = (costs["borrow_bps"] / 1e4) / 252
    today = scan_res["asof"]
    bars_cache = {}

    def bars(s):
        if s not in bars_cache:
            bars_cache[s] = data.bars(s)
        return bars_cache[s]

    def next_bar(s, d):
        b = bars(s); b = b[b.index > pd.Timestamp(d)]
        return (b.iloc[0], str(b.index[0].date())) if len(b) else (None, None)

    def close(s):
        b = bars(s)
        return float(b["c"].iloc[-1]) if len(b) else None

    def event(msg):
        book["events"] = (book.get("events", []) + [f"{today} · {msg}"])[-200:]
        log("stat-arb paper: " + msg)

    # 1) fills at the next session's official open
    for p in book["positions"]:
        if p["status"] not in ("pending_entry", "pending_exit"):
            continue
        by, dy = next_bar(p["y"], p["signal_date"]); bx, dx = next_bar(p["x"], p["signal_date"])
        if by is None or bx is None or dy != dx:
            p["wait"] = p.get("wait", 0) + 1
            if p["status"] == "pending_entry" and p["wait"] >= 3:
                p["status"] = "cancelled"; event(f"{p['y']}/{p['x']} entry cancelled — no common next-session bar after 3 sessions")
            continue
        if p["status"] == "pending_entry":
            eq = equity(book, close)
            notional = min(cfg["risk_per_pair"] * eq * cfg["leverage"], max(0.0, cfg["leverage"] * eq - gross(book, close)))
            if notional <= 1:
                p["status"] = "cancelled"; event(f"{p['y']}/{p['x']} entry cancelled — no gross capacity left"); continue
            wy, wx = p["wy"], p["wx"]
            p["qty_y"] = wy * notional / by["o"]; p["qty_x"] = wx * notional / bx["o"]
            fy = by["o"] * (1 + half * np.sign(p["qty_y"])); fx = bx["o"] * (1 + half * np.sign(p["qty_x"]))
            f = (abs(p["qty_y"]) * fy + abs(p["qty_x"]) * fx) * fee
            sl = (abs(p["qty_y"]) * by["o"] + abs(p["qty_x"]) * bx["o"]) * half
            book["cash"] -= p["qty_y"] * fy + p["qty_x"] * fx + f
            p.update(status="open", entry_date=dy, entry_y=fy, entry_x=fx, held=0, fees=f, slippage=sl, borrow=0.0)
            book["fees"] += f; book["slippage"] += sl
            event(f"opened {p['y']}/{p['x']} {'long' if p['side'] > 0 else 'short'} spread at the {dy} open — {p['qty_y']:+.3f} {p['y']} @ {fy:.2f}, {p['qty_x']:+.3f} {p['x']} @ {fx:.2f}")
        else:
            fy = by["o"] * (1 - half * np.sign(p["qty_y"])); fx = bx["o"] * (1 - half * np.sign(p["qty_x"]))
            f = (abs(p["qty_y"]) * fy + abs(p["qty_x"]) * fx) * fee
            sl = (abs(p["qty_y"]) * by["o"] + abs(p["qty_x"]) * bx["o"]) * half
            book["cash"] += p["qty_y"] * fy + p["qty_x"] * fx - f
            p["fees"] += f; p["slippage"] += sl; book["fees"] += f; book["slippage"] += sl
            gross_pnl = p["qty_y"] * (fy - p["entry_y"]) + p["qty_x"] * (fx - p["entry_x"])
            net = gross_pnl - p["fees"] - p["borrow"]
            book["closed"].append({**p, "status": "closed", "exit_date": dy, "exit_y": fy, "exit_x": fx,
                                   "gross_pnl": round(gross_pnl + p["slippage"], 4), "net_pnl": round(net, 4),
                                   "leg_pnl": {p["y"]: round(p["qty_y"] * (fy - p["entry_y"]), 4), p["x"]: round(p["qty_x"] * (fx - p["entry_x"]), 4)}})
            p["status"] = "closed"
            event(f"closed {p['y']}/{p['x']} at the {dy} open ({p['exit_reason']}): net {net:+.2f} USD")
    book["positions"] = [p for p in book["positions"] if p["status"] not in ("closed", "cancelled")]

    # 2) borrow on short legs for this session
    for p in book["positions"]:
        if p["status"] in ("open", "pending_exit") and p.get("last_borrow") != today:
            for q, s in ((p["qty_y"], p["y"]), (p["qty_x"], p["x"])):
                if q < 0 and close(s):
                    c = -q * close(s) * bday
                    p["borrow"] += c; book["borrow"] += c; book["cash"] -= c
            p["last_borrow"] = today

    # 3) strategy signals on today's close for held pairs and candidates
    params = {"entry": cfg["entry"], "exit": cfg["exit"], "stop": cfg["stop"], "hold_mult": cfg["hold_mult"]}
    key = cfg["strategy"] if cfg["strategy"] in LIBRARY else "I"
    held = {(p["y"], p["x"]): p for p in book["positions"]}
    cands = [(r["y"], r["x"], r) for r in scan_res.get("accepted", [])[:12]]
    cands += [(p["y"], p["x"], None) for p in book["positions"] if (p["y"], p["x"]) not in {(a, b) for a, b, _ in cands}]
    expected = pd.Timestamp(last_session().isoformat())
    signals = []
    for y, x, row in cands:
        p = data.panel([y, x])
        if not p["ok"]:
            continue
        Cp = p["close"]
        stale = len(pd.bdate_range(Cp.index[-1], expected)) - 1
        out = run_strategy(key, Cp[[y, x]], p["open"][[y, x]], params)
        side = out.weights[y].apply(np.sign).to_numpy()
        z = out.diag.get("z")
        zt = float(z.iloc[-1]) if z is not None and np.isfinite(z.iloc[-1]) else None
        why = (out.reason[0].iloc[-1] if out.reason is not None else "") or ""
        signals.append({"y": y, "x": x, "z": _r(zt, 3), "side": int(side[-1]), "prev": int(side[-2]) if len(side) > 1 else 0,
                        "reason": why, "stale_sessions": int(stale), "date": str(Cp.index[-1].date()),
                        "coint_p": _r(out.diag["coint_p"].iloc[-1]) if "coint_p" in out.diag else None,
                        "adf_p": _r(out.diag["adf_p"].iloc[-1]) if "adf_p" in out.diag else None,
                        "half_life": _r(out.diag["half_life"].iloc[-1], 2) if "half_life" in out.diag else None,
                        "beta": _r(out.diag["beta"].iloc[-1]) if "beta" in out.diag else None,
                        "sector": (row or {}).get("sector") or (held.get((y, x)) or {}).get("sector")})
        pos = held.get((y, x))
        if pos and pos["status"] == "open":
            pos["held"] = pos.get("held", 0) + 1; pos["z"] = _r(zt, 3)
            if side[-1] != pos["side"]:
                pos.update(status="pending_exit", signal_date=today, exit_reason=why or "signal off")
        elif not pos and side[-1] != 0 and (len(side) < 2 or side[-2] == 0):
            blocked = []
            eq = equity(book, close)
            peak = max([e for _, e in book["equity"]] + [book["start_cash"]])
            if book.get("halted") or eq < peak * (1 - cfg["max_drawdown"]):
                blocked.append("portfolio drawdown limit")
            if stale > cfg["stale_sessions"]:
                blocked.append(f"stale data ({stale} sessions old)")
            live = [q for q in book["positions"] if q["status"] != "cancelled"]
            if len(live) >= cfg["max_pairs"]:
                blocked.append("max simultaneous pairs")
            if any({y, x} & {q["y"], q["x"]} for q in live):
                blocked.append("correlated exposure (a leg is already held)")
            sec = (row or {}).get("sector")
            if sec and sum(1 for q in live if q.get("sector") == sec) >= cfg["max_per_sector"]:
                blocked.append("sector concentration")
            if row and (row.get("min_dollar_vol") or 0) < cfg["min_dollar_volume"]:
                blocked.append("liquidity")
            w = out.weights.iloc[-1]
            g = abs(w[y]) + abs(w[x])
            if g <= 0:
                blocked.append("no hedge weights")
            if blocked:
                event(f"signal {y}/{x} (z {zt:.2f}) not taken: " + ", ".join(blocked)) if zt is not None else None
                continue
            book["positions"].append({"id": uuid.uuid4().hex[:8], "y": y, "x": x, "sector": sec, "side": int(side[-1]),
                                      "wy": float(w[y] / g), "wx": float(w[x] / g), "hedge_ratio": signals[-1]["beta"],
                                      "z_entry": _r(zt, 3), "half_life": signals[-1]["half_life"], "status": "pending_entry",
                                      "signal_date": today, "strategy": key})
            event(f"entry signal {y}/{x}: {'long' if side[-1] > 0 else 'short'} spread, z {zt:.2f}; fills at the next session's open")
    # 4) equity, drawdown halt
    eq = equity(book, close)
    if not book["equity"] or book["equity"][-1][0] != today:
        book["equity"].append([today, round(eq, 4)])
    else:
        book["equity"][-1][1] = round(eq, 4)
    peak = max([e for _, e in book["equity"]] + [book["start_cash"]])
    if not book.get("halted") and eq < peak * (1 - cfg["max_drawdown"]):
        book["halted"] = today; event(f"drawdown limit {cfg['max_drawdown']:.0%} breached — new entries blocked")
    book["signals"] = signals; book["updated"] = today; book["updated_at"] = time.time(); book["config"] = cfg
    db.kv_set("sa_paper", book)
    return book


def equity(book, close) -> float:
    v = book["cash"]
    for p in book["positions"]:
        if p["status"] in ("open", "pending_exit"):
            cy, cx = close(p["y"]), close(p["x"])
            if cy and cx:
                v += p["qty_y"] * cy + p["qty_x"] * cx
    return v


def gross(book, close) -> float:
    g = 0.0
    for p in book["positions"]:
        if p["status"] in ("open", "pending_exit"):
            cy, cx = close(p["y"]), close(p["x"])
            if cy and cx:
                g += abs(p["qty_y"] * cy) + abs(p["qty_x"] * cx)
    return g
