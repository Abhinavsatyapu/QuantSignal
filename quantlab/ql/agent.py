"""Autonomous research agent (rule-based, no LLM).

Each tick does ONE bounded piece of work so the web pages stay responsive:
  1. refresh the universe lists (weekly)
  2. bring daily bars up to the last completed session (40 symbols per tick)
  3. scan for cointegrated pairs once the data for the new session is in
  4. update the paper book (fills at the next session's official open)
  5. walk-forward test one (pair, strategy) from the research queue
  6. when every strategy for a pair is done, write the pair's research report

Every decision is explained with the statistics that drove it."""
from __future__ import annotations

import datetime as dt
import math
import os
import threading
import time
import traceback
import uuid

import numpy as np
import pandas as pd

from . import backtest as bt
from . import engine, salab, scanner
from .data import Data, last_session
from .strategies import LIBRARY

RESEARCH_STRATS = ["B", "I", "V", "K", "A", "C", "E", "F", "D", "G", "M"]   # Z-score, improved, video, correlation first
AGENT_VERSION = 2
QUALIFY = {"min_oos_sharpe": 0.5, "min_trades": 10, "min_fold_positive": 0.5, "min_deflated": 0.5, "min_sharpe_2x_costs": 0.0, "max_dd": -0.20}


class Agent:
    def __init__(self, data: Data, interval: float = 45.0, busy=None, owner: str | None = None):
        self.data, self.db = data, data.db
        self.owner = owner or f"web-{os.getpid()}-{int(time.time())}"
        self.busy = busy or (lambda: False)
        self.interval = interval
        self.lock = threading.Lock()
        self.thread = None
        self.stop_flag = False
        st = self.db.kv_get("agent_state") or {}
        self.state = {"enabled": st.get("enabled", True), "phase": "idle", "message": "starting", "log": st.get("log", [])[-150:],
                      "queue": sorted(st.get("queue", []), key=lambda i: -1 if i.get("type") == "study" else (RESEARCH_STRATS.index(i["strategy"]) if i.get("strategy") in RESEARCH_STRATS else 99)), "done": st.get("done", 0), "last_tick": None, "scan_asof": st.get("scan_asof")}

    # ------------------------------------------------------------ plumbing
    def log(self, msg):
        line = f"{dt.datetime.utcnow().strftime('%Y-%m-%d %H:%M')} UTC · {msg}"
        self.state["log"] = (self.state["log"] + [line])[-150:]
        self.state["message"] = msg
        print("agent:", msg, flush=True)

    def save(self):
        self.db.kv_set("agent_state", {k: v for k, v in self.state.items()})

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.thread = threading.Thread(target=self._loop, daemon=True, name="quant-agent")
        self.thread.start()

    def _loop(self):
        time.sleep(5)
        while not self.stop_flag:
            if self.state.get("enabled", True) and self.busy():
                self.state["phase"] = "paused"; self.state["message"] = "paused while your request runs"
            elif self.state.get("enabled", True):
                try:
                    self.tick()
                except Exception as e:
                    self.log(f"error: {e}")
                    traceback.print_exc()
                self.state["last_tick"] = time.time()
                if self.holding:
                    self.save()
            time.sleep(self.interval if not self.busy() else 5)

    def risk(self):
        return {**scanner.DEFAULT_RISK, **(self.db.kv_get("risk_limits") or {})}

    def costs(self):
        return {**scanner.DEFAULT_COSTS, **(self.db.kv_get("costs") or {})}

    # ------------------------------------------------------------ one unit of work
    def _lease(self) -> bool:
        """Only one agent (web server or scheduled job) works at a time. The lease is
        renewed every tick and expires 10 minutes after its holder stops."""
        cur = self.db.kv_get("agent_lease") or {}
        now = time.time()
        if cur.get("owner") not in (None, self.owner) and cur.get("until", 0) > now:
            self.state["phase"] = "busy-elsewhere"
            self.state["message"] = f"another agent is working ({cur.get('owner', '').split('-')[0]}); waiting"
            return False
        if cur.get("owner") != self.owner:
            # taking over from another agent: continue from the state it saved
            st = self.db.kv_get("agent_state") or {}
            for k in ("queue", "done", "scan_asof", "log"):
                if k in st:
                    self.state[k] = st[k]
        self.db.kv_set("agent_lease", {"owner": self.owner, "until": now + 600})
        self.holding = True
        return True

    def release(self):
        cur = self.db.kv_get("agent_lease") or {}
        if cur.get("owner") == self.owner:
            self.db.kv_set("agent_lease", {})

    holding = False

    def tick(self):
        self.holding = False
        if not self._lease():
            return
        with self.lock:
            info = self.db.kv_get("universe_info") or {}
            if not info.get("updated_at") or time.time() - info["updated_at"] > 7 * 86400:
                self.state["phase"] = "universe"
                self.log("refreshing the stock universe (S&P 500, Nasdaq 100, ETFs, high-volume names)")
                r = self.data.universe.refresh(self.data.nasdaq)
                self.log(f"universe: {r.get('total', 'unchanged')} symbols" + (f"; problems: {'; '.join(r['errors'])}" if r.get("errors") else ""))
                return
            uni = self.data.universe.list()
            if uni.empty:
                self.log("universe is empty — will retry")
                return
            syms = ["SPY"] + [s for s in uni.symbol if s != "SPY"]
            target = last_session().isoformat()
            stale = self._stale(syms, target)
            if stale:
                self.state["phase"] = "data"
                batch = stale[:60]
                r = self.data.ensure(batch, workers=6)
                ok = sum(1 for v in r.values() if v["status"] == "ok"); bad = len(r) - ok
                self.log(f"daily bars: updated {ok}, failed {bad}, {max(len(stale) - len(batch), 0)} still to check (target session {target})")
                return
            latest = self.db.kv_get("latest_scan_meta") or {}
            if latest.get("asof") != self._data_asof() or time.time() - latest.get("at", 0) > 24 * 3600:
                self.state["phase"] = "scan"
                self.log("scanning for cointegrated pairs")
                res = scanner.scan(self.data, uni, self.risk(), self.costs(), progress=lambda m: self.state.update(message=m))
                rid = "scan-" + uuid.uuid4().hex[:8]
                self.db.save_run(rid, "scan", f"Scan {res['asof']}", {"asof": res["asof"], "accepted": len(res["accepted"]), "candidates": res["candidates"]}, res)
                self.db.kv_set("latest_scan", res)
                self.db.kv_set("latest_scan_meta", {"asof": res["asof"], "at": time.time(), "id": rid})
                self.state["scan_asof"] = res["asof"]
                self.log(f"scan {res['asof']}: {res['candidates']} candidate pairs, {len(res['accepted'])} passed every test, {res['rejected_count']} rejected")
                self._build_queue(res)
                self._paper_update(res)
                try:
                    salab.paper_update(self.data, self.db, res, self.log)
                except Exception as e:
                    self.log(f"stat-arb paper: error {e}")
                return
            if (self.db.kv_get("agent_version") or 1) < AGENT_VERSION:
                self._migrate()
                return
            if self.state["queue"]:
                self.state["phase"] = "research"
                item = self.state["queue"].pop(0)
                if item.get("type") == "study":
                    self._study(item)
                else:
                    self._research(item)
                self.state["done"] += 1
                return
            self.state["phase"] = "idle"
            self.state["message"] = f"up to date (data {self._data_asof()}); next scan after the next session closes"

    def _stale(self, syms, target):
        rows = dict(((r[0], (r[1], r[2], r[3])) for r in self.db.all("SELECT symbol, last_d, status, fetched_at FROM ql_meta")))
        out = []
        now = time.time()
        for s in syms:
            m = rows.get(s)
            if not m:
                out.append(s); continue
            last_d, status, fetched = m
            if status == "error" and now - (fetched or 0) < 3600:
                continue
            if status == "ok" and (last_d or "") >= target:
                continue
            if status == "ok" and now - (fetched or 0) < 3 * 3600:
                continue      # checked recently; provider has no newer bar yet (e.g. holiday)
            out.append(s)
        return out

    def _data_asof(self):
        r = self.db.one("SELECT last_d FROM ql_meta WHERE symbol='SPY'")
        return r[0] if r else None

    # ------------------------------------------------------------ research
    def _build_queue(self, scan_res, top=6):
        pairs = [(r["y"], r["x"]) for r in scan_res["accepted"][:top]]
        self.state["queue"] = ([{"type": "study", "pair": list(p), "scan": scan_res["asof"]} for p in pairs]
                               + [{"pair": list(p), "strategy": k, "scan": scan_res["asof"]} for k in RESEARCH_STRATS for p in pairs])
        self.log(f"research queue: {len(pairs)} pairs × {len(RESEARCH_STRATS)} strategies = {len(self.state['queue'])} walk-forward tests")

    def _migrate(self):
        """One-off after an upgrade: queue the stat-arb study and the new strategies for the latest scan."""
        sc = self.db.kv_get("latest_scan")
        if sc and sc.get("accepted"):
            pairs = [(r["y"], r["x"]) for r in sc["accepted"][:6]]
            done = {r["id"] for r in self.db.runs("research", 2000)}
            new = [{"type": "study", "pair": list(p), "scan": sc["asof"]} for p in pairs]
            new += [{"pair": list(p), "strategy": k, "scan": sc["asof"]} for k in RESEARCH_STRATS for p in pairs
                    if f"res-{p[0]}-{p[1]}-{k}" not in done]
            self.state["queue"] = new
            self.log(f"upgrade: queued the stat-arb study (30/60/90/180 days) for {len(pairs)} pairs and {len(new) - len(pairs)} walk-forward tests")
            try:
                salab.paper_update(self.data, self.db, sc, self.log)
            except Exception as e:
                self.log(f"stat-arb paper: error {e}")
        self.db.kv_set("agent_version", AGENT_VERSION)

    def _study(self, item):
        y, x = item["pair"]
        self.state["message"] = f"stat-arb horizon study {y}/{x}"
        panel = self.data.panel([y, x, "SPY"])
        if not panel["ok"]:
            self.log(f"study {y}/{x}: data missing"); return
        st = salab.pair_study(panel, [y, x], 1000.0, bt.Costs(**self.costs()))
        st["scan"] = item["scan"]
        self.db.save_run(f"sa-{y}-{x}", "sa_study", f"Stat-arb study {y}/{x}", {"pair": f"{y}/{x}", "scan": item["scan"], "end": st["end"]}, st)
        h = st["horizons"]["180"]
        self.log(f"study {y}/{x} 180 days: " + "; ".join(f"{k} {_p(h[k]['total_return'])} ({h[k]['trades']} tr)" for k in salab.COMPARE))
        if not any(i.get("type") == "study" for i in self.state["queue"]):
            studies = [self.db.run(r["id"])["payload"] for r in self.db.runs("sa_study", 50) if r["summary"].get("scan") == item["scan"]]
            pooled = salab.pooled(studies, 1000.0)
            pooled.update(scan=item["scan"], pairs=[s["pair"] for s in studies], at=time.time(), end=st["end"])
            self.db.kv_set("sa_summary", pooled)
            for hz in salab.HORIZONS:
                row = pooled["by_horizon"][str(hz)]
                self.log(f"stat-arb {hz}d pooled ({len(studies)} pairs): " + "; ".join(
                    f"{k} ret {_p(v['total_return'])} PnL {v['net_pnl']:+.2f} win {_p(v['win_rate'])} DD {_p(v['max_drawdown'])} tr {v['trades']}" for k, v in row.items()))

    def _research(self, item):
        y, x = item["pair"]
        k = item["strategy"]
        self.state["message"] = f"walk-forward {k} on {y}/{x}"
        panel = self.data.panel([y, x, "SPY"])
        if not panel["ok"]:
            self.log(f"{y}/{x}: data missing ({'; '.join(panel['warnings'])})"); return
        C = panel["close"]
        start = str(C.index[min(260, len(C) - 1)].date()); end = str(C.index[-1].date())
        costs = bt.Costs(**self.costs())
        wf = engine.walk_forward(panel, k, [y, x], start, end, 100_000, costs)
        if not wf.get("ok"):
            self.log(f"{k} on {y}/{x}: {wf.get('error')}"); return
        m = wf["metrics"]
        # cost stress on the most recent fold's parameters
        last_params = wf["folds"][-1]["params"] if wf["folds"] else None
        s2 = engine.backtest(panel, k, [y, x], last_params, start, end, 100_000,
                             bt.Costs(costs.fee_bps * 2, costs.spread_bps * 2, costs.slippage_bps * 2, costs.borrow_bps * 2))["metrics"]["sharpe"]
        q, why = qualifies(m, s2)
        summary = {"pair": f"{y}/{x}", "strategy": k, "name": LIBRARY[k].name, "family": LIBRARY[k].family,
                   "oos_sharpe": m["sharpe"], "oos_sortino": m["sortino"], "oos_return": m["total_return"], "oos_cagr": m["cagr"],
                   "max_drawdown": m["max_drawdown"], "profit_factor": m["profit_factor"] if not isinstance(m["profit_factor"], str) else 99.0,
                   "trades": m["trades"], "win_rate": m["win_rate"], "fold_positive_share": m.get("fold_positive_share"),
                   "deflated_sharpe": m.get("deflated_sharpe"), "sharpe_pvalue": m.get("sharpe_pvalue"), "sharpe_2x_costs": s2,
                   "positive_months": m.get("positive_months"), "qualifies": q, "reasons": why, "scan": item["scan"],
                   "start": start, "end": end, "last_params": last_params}
        rid = f"res-{y}-{x}-{k}"
        self.db.save_run(rid, "research", f"{k} on {y}/{x}", summary, {"folds": wf["folds"], "series": wf["series"], "metrics": m, "trades": wf["trades"][-50:]})
        self.log(f"{k} on {y}/{x}: OOS P&L {_p(m['total_return'])} on 100k, Sharpe {_n(m['sharpe'])}, win rate {_p(m['win_rate'])}, max DD {_p(m['max_drawdown'])}, "
                 f"{m['trades']} trades → {'QUALIFIES' if q else 'fails'}" + ("" if q else f" ({why[0]})"))
        rest = [i for i in self.state["queue"] if i["pair"] == [y, x]]
        if not rest and self.db.one("SELECT COUNT(*) FROM ql_runs WHERE kind='research' AND id LIKE ?", (f"res-{y}-{x}-%",))[0] >= len(RESEARCH_STRATS):
            self._pair_report(y, x, item["scan"])

    def _pair_report(self, y, x, scan_asof):
        rows = [r["summary"] for r in self.db.runs("research", 500) if r["summary"].get("pair") == f"{y}/{x}" and r["summary"].get("scan") == scan_asof]
        if not rows:
            return
        rows.sort(key=lambda s: -(s["oos_sharpe"] or -9))
        scan = self.db.kv_get("latest_scan") or {}
        st = next((r for r in scan.get("accepted", []) if r["y"] == y and r["x"] == x), {})
        lines = [f"Pair {y}/{x} ({st.get('sector', '')}). Selected because Engle-Granger p = {st.get('eg_p')}, Johansen trace {st.get('johansen_trace')} vs 95% critical "
                 f"{st.get('johansen_crit95')}, half-life {st.get('half_life')} sessions, Hurst {st.get('hurst')}, return correlation {st.get('corr')}."]
        ok = [r for r in rows if r["qualifies"]]
        for r in rows:
            lines.append(f"{r['strategy']} ({r['name']}): OOS Sharpe {_n(r['oos_sharpe'])}, return {_p(r['oos_return'])}, max DD {_p(r['max_drawdown'])}, "
                         f"{r['trades']} trades, deflated Sharpe {_n(r['deflated_sharpe'])}, Sharpe at 2× costs {_n(r['sharpe_2x_costs'])} → "
                         + ("qualifies." if r["qualifies"] else "fails: " + "; ".join(r["reasons"]) + "."))
        if ok:
            b = ok[0]
            concl = f"Best qualifying strategy on this pair: {b['strategy']} ({b['name']}) with OOS Sharpe {_n(b['oos_sharpe'])}."
        else:
            concl = "No strategy qualifies on this pair: none passed every out-of-sample, significance and cost test. Do not trade it on this evidence."
        lines.append(concl)
        self.db.save_run(f"pairrep-{y}-{x}", "pair_report", f"Research report {y}/{x}", {"pair": f"{y}/{x}", "qualified": [r["strategy"] for r in ok], "scan": scan_asof,
                         "conclusion": concl}, {"lines": lines, "results": rows})
        self.log(f"report {y}/{x}: " + concl)

    # ------------------------------------------------------------ paper book
    def _paper_update(self, scan_res):
        """Paper trading on end-of-day bars. Decisions use the close of day t;
        fills use the official OPEN of the next session once its bar exists."""
        risk, costs = self.risk(), self.costs()
        book = self.db.kv_get("paper_book") or {"cash": 100_000.0, "start_cash": 100_000.0, "positions": [], "closed": [], "equity": [], "halted": None}
        half = (costs["spread_bps"] / 2 + costs["slippage_bps"]) / 1e4
        fee = costs["fee_bps"] / 1e4
        today = scan_res["asof"]

        def bar(s, d):
            b = self.data.bars(s)
            b = b[b.index > pd.Timestamp(d)]
            return b.iloc[0] if len(b) else None, (str(b.index[0].date()) if len(b) else None)

        def last_close(s):
            b = self.data.bars(s)
            return float(b["c"].iloc[-1]) if len(b) else None

        # 1) fills for pending entries / exits
        for p in book["positions"]:
            if p["status"] in ("pending_entry", "pending_exit"):
                by, dy = bar(p["y"], p["signal_date"]); bx, dx = bar(p["x"], p["signal_date"])
                if by is None or bx is None or dy != dx:
                    continue
                if p["status"] == "pending_entry":
                    eq = book["cash"] + _mtm(book, last_close)
                    gross = p["alloc"] * eq
                    sy = p["side"]
                    p["sh_y"] = sy * gross / 2 / by["o"]; p["sh_x"] = -sy * gross / 2 / bx["o"]
                    fy = by["o"] * (1 + half * np.sign(p["sh_y"])); fx = bx["o"] * (1 + half * np.sign(p["sh_x"]))
                    book["cash"] -= p["sh_y"] * fy + p["sh_x"] * fx + (abs(p["sh_y"]) * fy + abs(p["sh_x"]) * fx) * fee
                    p.update(status="open", entry_date=dy, entry_y=fy, entry_x=fx, held=0)
                    self.log(f"paper: opened {p['y']}/{p['x']} {('long' if sy > 0 else 'short')} spread at {dy} open")
                else:
                    fy = by["o"] * (1 - half * np.sign(p["sh_y"])); fx = bx["o"] * (1 - half * np.sign(p["sh_x"]))
                    book["cash"] += p["sh_y"] * fy + p["sh_x"] * fx - (abs(p["sh_y"]) * fy + abs(p["sh_x"]) * fx) * fee
                    pnl_y = p["sh_y"] * (fy - p["entry_y"]); pnl_x = p["sh_x"] * (fx - p["entry_x"])
                    book["closed"].append({**p, "status": "closed", "exit_date": dy, "exit_y": fy, "exit_x": fx,
                                           "pnl": round(pnl_y + pnl_x, 2), "leg_pnl": {p["y"]: round(pnl_y, 2), p["x"]: round(pnl_x, 2)}})
                    p["status"] = "closed"
                    self.log(f"paper: closed {p['y']}/{p['x']} at {dy} open ({p['exit_reason']}), P&L {pnl_y + pnl_x:,.0f} USD")
        book["positions"] = [p for p in book["positions"] if p["status"] != "closed"]
        # 2) exit decisions on today's close
        for p in book["positions"]:
            if p["status"] != "open":
                continue
            z = _pair_z(self.data, p["y"], p["x"], p["a"], p["b"])
            p["z"] = z; p["held"] = p.get("held", 0) + 1
            why = None
            if z is not None:
                if (p["side"] > 0 and z >= -risk["exit_z"]) or (p["side"] < 0 and z <= risk["exit_z"]):
                    why = "converged"
                elif abs(z) >= risk["stop_z"]:
                    why = "stop (z beyond stop level)"
            if why is None and p.get("half_life") and p["held"] >= 3 * p["half_life"]:
                why = "time stop (3 × half-life)"
            if why:
                p.update(status="pending_exit", signal_date=today, exit_reason=why)
        # 3) equity & drawdown halt
        eq = book["cash"] + _mtm(book, last_close)
        if not book["equity"] or book["equity"][-1][0] != today:
            book["equity"].append([today, round(eq, 2)])
        peak = max([e for _, e in book["equity"]] + [book["start_cash"]])
        if book.get("halted") is None and eq < peak * (1 - risk["max_drawdown"]):
            book["halted"] = today
            self.log(f"paper: drawdown limit {risk['max_drawdown']:.0%} breached — new entries blocked")
        # 4) new entries — statistical + execution checks, then portfolio limits
        if book.get("halted") is None:
            held = {(p["y"], p["x"]) for p in book["positions"]}
            syms_held = {s for p in book["positions"] for s in (p["y"], p["x"])}
            for r in scan_res["accepted"]:
                if len(book["positions"]) >= risk["max_positions"]:
                    break
                if not r.get("signal") or (r["y"], r["x"]) in held or r["y"] in syms_held or r["x"] in syms_held:
                    continue
                if not (abs(r["z60"]) < risk["stop_z"]):
                    continue
                sec_g = sum(p["alloc"] for p in book["positions"] if p.get("sector") == r["sector"])
                if sec_g + risk["max_alloc_per_pair"] > risk["max_sector_gross"]:
                    continue
                gross = sum(p["alloc"] for p in book["positions"])
                if gross + risk["max_alloc_per_pair"] > risk["max_gross"]:
                    continue
                a, b = _formation(self.data, r["y"], r["x"])
                book["positions"].append({"id": uuid.uuid4().hex[:8], "y": r["y"], "x": r["x"], "sector": r["sector"], "side": 1 if r["z60"] < 0 else -1,
                                          "a": a, "b": b, "alloc": risk["max_alloc_per_pair"], "half_life": r["half_life"], "z_entry": r["z60"],
                                          "status": "pending_entry", "signal_date": today,
                                          "why": f"z {r['z60']:.2f} beyond ±{risk['entry_z']}; EG p {r['eg_p']}, Johansen {r['johansen_conf']:.0%}, half-life {r['half_life']} d, edge {r['edge_bps']} bp"})
                held.add((r["y"], r["x"])); syms_held |= {r["y"], r["x"]}
                self.log(f"paper: entry signal {r['y']}/{r['x']} (z {r['z60']:.2f}); fills at the next session's open")
        book["updated"] = today
        self.db.kv_set("paper_book", book)


def qualifies(m: dict, sharpe_2x) -> tuple[bool, list[str]]:
    why = []
    q = QUALIFY
    if (m.get("sharpe") or -9) < q["min_oos_sharpe"]:
        why.append(f"OOS Sharpe {_n(m.get('sharpe'))} < {q['min_oos_sharpe']}")
    if m.get("trades", 0) < q["min_trades"]:
        why.append(f"only {m.get('trades', 0)} OOS trades (< {q['min_trades']})")
    if (m.get("fold_positive_share") or 0) < q["min_fold_positive"]:
        why.append(f"positive in only {_p(m.get('fold_positive_share'))} of walk-forward folds")
    if (m.get("deflated_sharpe") or 0) < q["min_deflated"]:
        why.append(f"deflated Sharpe {_n(m.get('deflated_sharpe'))} < {q['min_deflated']} (edge may be luck from parameter search)")
    if sharpe_2x is None or sharpe_2x <= q["min_sharpe_2x_costs"]:
        why.append(f"Sharpe at 2× costs {_n(sharpe_2x)} — does not survive higher costs")
    if (m.get("max_drawdown") or 0) < q["max_dd"]:
        why.append(f"max drawdown {_p(m.get('max_drawdown'))} worse than {_p(q['max_dd'])}")
    return not why, why


def _formation(data, y, x, n=504):
    by, bx = data.bars(y).iloc[-n:], data.bars(x).iloc[-n:]
    j = pd.concat([np.log(by["c"]), np.log(bx["c"])], axis=1).dropna()
    from .stats import ols_beta
    a, b = ols_beta(j.iloc[:, 0].to_numpy(), j.iloc[:, 1].to_numpy())
    return a, b


def _pair_z(data, y, x, a, b, n=60):
    by, bx = data.bars(y).iloc[-n:], data.bars(x).iloc[-n:]
    j = pd.concat([np.log(by["c"]), np.log(bx["c"])], axis=1).dropna()
    if len(j) < 20:
        return None
    r = j.iloc[:, 0] - a - b * j.iloc[:, 1]
    sd = r.std(ddof=1)
    return float((r.iloc[-1] - r.mean()) / sd) if sd > 0 else None


def _mtm(book, last_close):
    v = 0.0
    for p in book["positions"]:
        if p["status"] in ("open", "pending_exit"):
            cy, cx = last_close(p["y"]), last_close(p["x"])
            if cy and cx:
                v += p["sh_y"] * cy + p["sh_x"] * cx
    return v


def _n(x, d=2):
    return "n/a" if x is None or (isinstance(x, float) and not math.isfinite(x)) else f"{x:.{d}f}"


def _p(x):
    return "n/a" if x is None else f"{x * 100:.1f}%"


def leaderboard(db) -> dict:
    """Rank strategies on the agent's out-of-sample research across all pairs."""
    rows = [r["summary"] for r in db.runs("research", 2000)]
    if not rows:
        return {"strategies": [], "categories": {}, "note": "No research results yet — the agent fills this in after its first scan."}
    df = pd.DataFrame(rows)
    out = []
    for k, g in df.groupby("strategy"):
        sh = g["oos_sharpe"].astype(float)
        pf = g["profit_factor"].astype(float).clip(upper=10)
        out.append({"strategy": k, "name": LIBRARY[k].name, "family": LIBRARY[k].family, "pairs_tested": int(len(g)),
                    "median_oos_sharpe": _r(sh.median()), "median_sortino": _r(g["oos_sortino"].astype(float).median()),
                    "median_max_dd": _r(g["max_drawdown"].astype(float).median()), "median_profit_factor": _r(pf.median()),
                    "stability": _r(g["fold_positive_share"].astype(float).mean()), "share_positive_pairs": _r((sh > 0).mean()),
                    "median_deflated_sharpe": _r(g["deflated_sharpe"].astype(float).median()),
                    "median_sharpe_2x_costs": _r(g["sharpe_2x_costs"].astype(float).median()),
                    "cost_drag": _r((sh - g["sharpe_2x_costs"].astype(float)).median()),
                    "consistency": _r(g["positive_months"].astype(float).mean()),
                    "qualified_pairs": int(g["qualifies"].sum())})
    t = pd.DataFrame(out)
    if len(t):
        ranks = pd.DataFrame({
            "sharpe": t["median_oos_sharpe"].rank(ascending=False), "sortino": t["median_sortino"].rank(ascending=False),
            "dd": t["median_max_dd"].rank(ascending=False), "pf": t["median_profit_factor"].rank(ascending=False),
            "stab": t["stability"].rank(ascending=False), "sig": t["median_deflated_sharpe"].rank(ascending=False),
            "cost": t["cost_drag"].rank(ascending=True), "cons": t["consistency"].rank(ascending=False)})
        t["composite_rank"] = ranks.mean(axis=1).round(2)
        t = t.sort_values("composite_rank")
    recs = t.to_dict("records")

    def best(filter_fn, key, asc=False, label=""):
        c = [r for r in recs if filter_fn(r) and r.get(key) is not None]
        if not c:
            return None
        r = sorted(c, key=lambda r: r[key], reverse=not asc)[0]
        return {"strategy": r["strategy"], "name": r["name"], "value": r[key], "metric": label}
    enough = sum(r["pairs_tested"] for r in recs) >= 12
    cats = {
        "Best overall": best(lambda r: True, "composite_rank", True, "composite rank"),
        "Best mean-reversion": best(lambda r: r["family"] in ("mean-reversion",), "median_oos_sharpe", False, "median OOS Sharpe"),
        "Best pairs": best(lambda r: r["family"] == "pairs", "median_oos_sharpe", False, "median OOS Sharpe"),
        "Best risk-adjusted": best(lambda r: True, "median_sortino", False, "median OOS Sortino"),
        "Most consistent": best(lambda r: True, "stability", False, "share of positive walk-forward folds"),
        "Lowest drawdown": best(lambda r: True, "median_max_dd", False, "median max drawdown"),
    }
    note = None if enough else "Fewer than 12 strategy-pair tests so far — treat the leaderboard as preliminary."
    if recs and all((r["median_oos_sharpe"] or 0) <= 0 for r in recs):
        note = (note + " " if note else "") + "No strategy has a positive median out-of-sample Sharpe yet; the 'best' labels rank losers."
    return {"strategies": recs, "categories": cats, "note": note, "tests": int(len(df))}


def _r(x, n=3):
    try:
        x = float(x)
        return round(x, n) if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None
