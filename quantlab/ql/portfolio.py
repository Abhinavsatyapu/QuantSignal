"""Strategy H — market-neutral portfolio built from the scanner's accepted pairs.

Each pair runs its own pair strategy in a separate book (columns 'Y|X:SYM'),
so leg P&L stays attributable. Portfolio rules applied day by day using only
information known at that close:
  * capital per pair  <= max_alloc_per_pair (risk-parity: inverse spread vol)
  * concurrent pairs  <= max_positions
  * sector gross      <= max_sector_gross
  * total gross       <= max_gross, |net| <= max_net
  * neutrality: 'dollar' (equal $ long/short) or 'beta' (legs scaled by trailing
    252-day beta to SPY so the pair's beta is ~0)
  * portfolio drawdown beyond max_drawdown blocks all new entries."""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import backtest as bt
from . import metrics
from .strategies import run as run_strategy


def build(panel: dict, pairs: list[dict], key: str, params: dict | None, start: str, end: str, capital: float,
          costs: bt.Costs, risk: dict, neutral: str = "dollar") -> dict:
    C, O = panel["close"], panel["open"]
    spy = C.get("SPY")
    rets = np.log(C).diff()
    betas = None
    if spy is not None:
        sr = rets["SPY"]
        betas = rets.rolling(252, min_periods=120).cov(sr).div(sr.rolling(252, min_periods=120).var(), axis=0)
    books, units, Wcols, Ccols, Ocols, info = {}, [], {}, {}, {}, []
    for pr in pairs:
        y, x = pr["y"], pr["x"]
        if y not in C or x not in C:
            continue
        out = run_strategy(key, C[[y, x]], O[[y, x]], params)
        w = out.weights.copy()
        side = np.sign(w[y]).to_numpy()
        vol = np.log(C[y] / C[x]).diff().rolling(60).std() * np.sqrt(252)
        books[(y, x)] = {"w": w, "side": side, "vol": vol, "sector": pr.get("sector") or "Unknown"}
    if not books:
        return {"ok": False, "error": "no pairs with data"}
    idx = C.index
    sl = (idx >= pd.Timestamp(start)) & (idx <= pd.Timestamp(end))
    days = idx[sl]
    names = list(books)
    W = {f"{y}|{x}:{s}": np.zeros(len(days)) for (y, x) in names for s in (y, x)}
    active: dict = {}
    blocked = {"max_positions": 0, "max_sector_gross": 0, "max_gross": 0, "max_net": 0}
    for ti, d in enumerate(days):
        t = idx.get_loc(d)
        # exits first
        for k in list(active):
            if books[k]["side"][t] == 0 or np.sign(books[k]["side"][t]) != active[k]["sign"]:
                del active[k]
        # candidate entries: pairs whose own strategy just turned on
        new = [k for k in names if k not in active and books[k]["side"][t] != 0 and (t == 0 or books[k]["side"][t - 1] != books[k]["side"][t])]
        new.sort(key=lambda k: books[k]["vol"].iat[t] if np.isfinite(books[k]["vol"].iat[t]) else 9)
        for k in new:
            if len(active) >= risk["max_positions"]:
                blocked["max_positions"] += 1; continue
            v = books[k]["vol"].iat[t]
            alloc = min(risk["max_alloc_per_pair"], 0.10 / v * risk["max_alloc_per_pair"] if np.isfinite(v) and v > 0 else risk["max_alloc_per_pair"])
            y, x = k
            sgn = np.sign(books[k]["side"][t])
            wy, wx = sgn * alloc / 2, -sgn * alloc / 2
            if neutral == "beta" and betas is not None:
                by, bx = betas[y].iat[t], betas[x].iat[t]
                if np.isfinite(by) and np.isfinite(bx) and bx > 0.1 and by > 0.1:
                    wx = -sgn * alloc / 2 * by / bx
                    sc = alloc / (abs(wy) + abs(wx)); wy *= sc; wx *= sc
            sec = books[k]["sector"]
            sec_g = sum(abs(a["wy"]) + abs(a["wx"]) for kk, a in active.items() if books[kk]["sector"] == sec)
            if sec_g + abs(wy) + abs(wx) > risk["max_sector_gross"]:
                blocked["max_sector_gross"] += 1; continue
            gross = sum(abs(a["wy"]) + abs(a["wx"]) for a in active.values())
            if gross + abs(wy) + abs(wx) > risk["max_gross"]:
                blocked["max_gross"] += 1; continue
            net = sum(a["wy"] + a["wx"] for a in active.values())
            if abs(net + wy + wx) > risk["max_net"]:
                blocked["max_net"] += 1; continue
            active[k] = {"sign": sgn, "wy": wy, "wx": wx}
        for (y, x), a in active.items():
            W[f"{y}|{x}:{y}"][ti] = a["wy"]; W[f"{y}|{x}:{x}"][ti] = a["wx"]
    Wdf = pd.DataFrame(W, index=days)
    Cp = pd.DataFrame({c: C[c.split(":")[1]].loc[days] for c in Wdf.columns})
    Op = pd.DataFrame({c: O[c.split(":")[1]].loc[days] for c in Wdf.columns})
    units = [[f"{y}|{x}:{y}", f"{y}|{x}:{x}"] for (y, x) in names]
    res = bt.run(Wdf, Op, Cp, units, capital, costs, None, risk.get("max_drawdown"))
    for tr in res.trades:
        tr["symbols"] = [s.split(":")[1] for s in tr["symbols"]]
        tr["leg_pnl"] = {k.split(":")[1]: v for k, v in tr["leg_pnl"].items()}
    reg = metrics.regimes(spy) if spy is not None else None
    m = metrics.compute(res, capital, spy, reg)
    pair_pnl = {}
    for (y, x) in names:
        cols = [f"{y}|{x}:{y}", f"{y}|{x}:{x}"]
        pair_pnl[f"{y}/{x}"] = round(float(res.leg_pnl[cols].iloc[-1].sum()), 2)
    sector_gross = {}
    for (y, x) in names:
        cols = [f"{y}|{x}:{y}", f"{y}|{x}:{x}"]
        g = (res.positions[cols].abs() * Cp[cols]).sum(axis=1) / res.equity
        sector_gross.setdefault(books[(y, x)]["sector"], []).append(g)
    sec = {k: round(float(pd.concat(v, axis=1).sum(axis=1).max()), 3) for k, v in sector_gross.items()}
    return {"ok": True, "metrics": m, "series": metrics.series(res, capital), "trades": res.trades[-400:], "pair_pnl": pair_pnl,
            "max_sector_gross_seen": sec, "max_gross_seen": round(float(res.gross_exposure.max()), 3),
            "max_abs_net_seen": round(float(res.net_exposure.abs().max()), 3), "blocked_entries": blocked,
            "halted_on": res.halted, "pairs": [f"{y}/{x}" for (y, x) in names], "neutral": neutral, "strategy": key}
