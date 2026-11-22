"""Universe scanner: liquidity filter -> return correlation -> candidate pairs ->
Engle-Granger + Johansen + OU half-life + Hurst -> cost filter -> ranking.
Every rejection carries the statistical reason."""
from __future__ import annotations

import math
import time

import numpy as np
import pandas as pd

from . import stats

DEFAULT_RISK = {
    "max_drawdown": 0.15,          # portfolio drawdown that halts new entries
    "max_alloc_per_pair": 0.20,    # gross fraction of equity per pair
    "max_sector_gross": 0.50,
    "max_gross": 2.0,
    "max_net": 0.15,
    "max_positions": 8,
    "stop_z": 4.0,
    "min_dollar_volume": 20e6,     # 20-day median traded value per leg, USD
    "min_price": 5.0,
    "max_coint_p": 0.05,           # Engle-Granger
    "min_johansen_conf": 0.95,
    "hl_min": 2.0, "hl_max": 40.0,
    "max_hurst": 0.5,
    "min_edge_to_cost": 3.0,       # expected reversion profit / round-trip cost
    "entry_z": 2.0, "exit_z": 0.5,
}

DEFAULT_COSTS = {"fee_bps": 0.5, "spread_bps": 4.0, "slippage_bps": 2.0, "borrow_bps": 50.0}


def round_trip_bps(costs: dict) -> float:
    # two legs, in and out: 4 fills, each paying fee + half spread + slippage
    return 4 * (costs["fee_bps"] + costs["spread_bps"] / 2 + costs["slippage_bps"])


def scan(data, universe: pd.DataFrame, risk: dict, costs: dict, window: int = 504, corr_window: int = 252,
         min_corr: float = 0.75, max_pairs: int = 250, max_symbols: int = 700, progress=None) -> dict:
    t0 = time.time()
    syms = universe.sort_values("dollar_vol", ascending=False, na_position="last")["symbol"].tolist()[:max_symbols]
    sector = dict(zip(universe.symbol, universe.sector))
    closes, dvol, missing = {}, {}, []
    latest = (data.db.one("SELECT MAX(d) FROM ql_bars") or [None])[0]
    since = ((pd.Timestamp(latest) if latest else pd.Timestamp.today()) - pd.Timedelta(days=int(window * 1.6) + 30)).date().isoformat()
    bulk = data.bars_bulk(syms, since)
    for s in syms:
        b = bulk.get(s)
        if b is None or b.empty or len(b) < window * 0.9:
            missing.append(s)
            continue
        b = b.iloc[-window:]
        closes[s] = b["c"]
        dvol[s] = float((b["c"] * b["v"]).iloc[-20:].median())
    C = pd.DataFrame(closes).dropna(axis=1, thresh=int(window * 0.9))
    C = C.dropna()
    liquid = [s for s in C.columns if dvol.get(s, 0) >= risk["min_dollar_volume"] and C[s].iloc[-1] >= risk["min_price"]]
    illiquid = [s for s in C.columns if s not in liquid]
    L = np.log(C[liquid])
    R = L.diff().iloc[-corr_window:]
    corr = R.corr().to_numpy()
    cols = list(L.columns)
    cand = []
    n = len(cols)
    for i in range(n):
        for j in range(i + 1, n):
            c = corr[i, j]
            if not np.isfinite(c) or c < min_corr:
                continue
            si, sj = sector.get(cols[i]), sector.get(cols[j])
            same = si == sj and si not in (None, "Unknown")
            if same or c >= 0.85:
                cand.append((c, cols[i], cols[j], same))
    cand.sort(reverse=True)
    cand = cand[:max_pairs]
    rt = round_trip_bps(costs)
    rows = []
    for k, (c, a, b, same) in enumerate(cand):
        if progress and k % 25 == 0:
            progress(f"testing pair {k + 1}/{len(cand)}")
        rows.append(_test_pair(L[a], L[b], c, same, sector, risk, rt, dvol))
    acc = [r for r in rows if r["accepted"]]
    acc.sort(key=lambda r: -r["score"])
    rej = [r for r in rows if not r["accepted"]]
    asof = str(C.index[-1].date()) if len(C) else None
    return {"asof": asof, "status": "historical", "symbols_requested": len(syms), "symbols_with_data": len(C.columns),
            "missing_history": missing[:50], "missing_count": len(missing), "illiquid_count": len(illiquid),
            "liquid_symbols": len(liquid), "candidates": len(cand), "accepted": acc, "rejected": rej[:200],
            "rejected_count": len(rej), "round_trip_cost_bps": rt, "params": {"window": window, "corr_window": corr_window, "min_corr": min_corr},
            "seconds": round(time.time() - t0, 1)}


def _test_pair(la: pd.Series, lb: pd.Series, corr: float, same: bool, sector: dict, risk: dict, rt_bps: float, dvol: dict) -> dict:
    # quick pre-test (Engle-Granger with one lag, both directions); clearly non-cointegrated
    # pairs are rejected here without the slower full battery of tests
    q = min(stats.eg_fast_p(la.to_numpy(), lb.to_numpy()), stats.eg_fast_p(lb.to_numpy(), la.to_numpy()))
    if np.isfinite(q) and q > max(0.25, 5 * risk["max_coint_p"]):
        return {"y": la.name, "x": lb.name, "sector": sector.get(la.name) if same else f"{sector.get(la.name)} / {sector.get(lb.name)}",
                "corr": round(float(corr), 3), "eg_p": _r(q), "half_life": None, "accepted": False, "score": 0.0, "signal": None,
                "reasons": [f"Engle-Granger p ≈ {q:.2f} on the quick test — far from cointegrated"]}
    # choose the dependent leg that gives the stronger Engle-Granger rejection
    e1 = stats.engle_granger(la.to_numpy(), lb.to_numpy())
    e2 = stats.engle_granger(lb.to_numpy(), la.to_numpy())
    if (e2["p"] if np.isfinite(e2["p"]) else 1) < (e1["p"] if np.isfinite(e1["p"]) else 1):
        y, x, eg = lb, la, e2
    else:
        y, x, eg = la, lb, e1
    jo = stats.johansen(y.to_numpy(), x.to_numpy())
    resid = eg["resid"]
    ou = stats.ou_fit(resid)
    hl = ou.get("half_life", float("inf")) if ou.get("ok") else float("inf")
    hu = stats.hurst(resid)
    mu, sd = resid.mean(), resid.std(ddof=1)
    z = (resid[-1] - mu) / sd if sd > 0 else float("nan")
    r60 = resid[-60:]
    z60 = (resid[-1] - r60.mean()) / r60.std(ddof=1) if r60.std(ddof=1) > 0 else float("nan")
    # expected reversion profit per unit gross if the spread returns from entry_z to exit_z
    edge_bps = (risk["entry_z"] - risk["exit_z"]) * sd / (1 + abs(eg["beta"])) * 1e4
    reasons = []
    if not (eg["p"] < risk["max_coint_p"]):
        reasons.append(f"Engle-Granger p = {eg['p']:.3f} ≥ {risk['max_coint_p']}")
    if jo["reject_conf"] < risk["min_johansen_conf"]:
        reasons.append(f"Johansen trace {jo['trace']:.1f} below the {int(risk['min_johansen_conf'] * 100)}% critical value {jo['crit95']:.1f}")
    if not (risk["hl_min"] <= hl <= risk["hl_max"]):
        reasons.append("no reliable mean reversion (AR(1) slope ≥ 1)" if not math.isfinite(hl) else f"half-life {hl:.1f} d outside [{risk['hl_min']:g}, {risk['hl_max']:g}]")
    if np.isfinite(hu) and hu >= risk["max_hurst"]:
        reasons.append(f"Hurst exponent {hu:.2f} ≥ {risk['max_hurst']} (not mean-reverting)")
    if edge_bps < risk["min_edge_to_cost"] * rt_bps:
        reasons.append(f"expected edge {edge_bps:.0f} bp < {risk['min_edge_to_cost']:g}× round-trip cost {rt_bps:.0f} bp")
    if eg["beta"] <= 0:
        reasons.append(f"negative hedge ratio ({eg['beta']:.2f})")
    score = 0.0
    if not reasons:
        score = (0.35 * min(1.0, -math.log10(max(eg["p"], 1e-6)) / 4) + 0.20 * min(1.5, jo["trace"] / jo["crit95"]) / 1.5
                 + 0.25 * max(0.0, 1 - abs(math.log(hl / 8)) / 2.5) + 0.20 * min(1.0, edge_bps / (10 * rt_bps)))
    sig = None
    if not reasons and np.isfinite(z60) and abs(z60) >= risk["entry_z"]:
        sig = "short spread" if z60 > 0 else "long spread"
    return {"y": y.name, "x": x.name, "sector": sector.get(y.name) if same else f"{sector.get(y.name)} / {sector.get(x.name)}",
            "corr": round(float(corr), 3), "eg_p": _r(eg["p"]), "eg_t": _r(eg["t"]), "johansen_trace": _r(jo["trace"]), "johansen_crit95": _r(jo["crit95"]),
            "johansen_conf": jo["reject_conf"], "hedge_ratio": _r(eg["beta"]), "half_life": _r(hl) if math.isfinite(hl) else None,
            "ou_kappa": _r(ou.get("kappa")), "hurst": _r(hu), "z": _r(z), "z60": _r(z60), "spread_sd": _r(sd, 5),
            "edge_bps": _r(edge_bps, 1), "min_dollar_vol": _r(min(dvol.get(y.name, 0), dvol.get(x.name, 0)), 0),
            "accepted": not reasons, "reasons": reasons, "score": round(score, 4), "signal": sig}


def _r(x, n=4):
    try:
        x = float(x)
        return round(x, n) if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def live_check(data, row: dict, risk: dict) -> dict:
    """Recompute today's z with the current quotes and run the pre-trade checks.
    A z-score cross alone is never enough: the statistical tests, liquidity,
    cost filter and quote quality must all pass."""
    qy, qx = data.quote(row["y"]), data.quote(row["x"])
    out = {"quotes": {row["y"]: qy, row["x"]: qx}, "checks": []}
    by, bx = data.bars(row["y"]).iloc[-504:], data.bars(row["x"]).iloc[-504:]
    j = pd.concat([np.log(by["c"]), np.log(bx["c"])], axis=1).dropna()
    a, b = stats.ols_beta(j.iloc[:, 0].to_numpy(), j.iloc[:, 1].to_numpy())
    res = j.iloc[:, 0] - a - b * j.iloc[:, 1]
    r60 = res.iloc[-60:]
    status = "historical"
    z_now = (res.iloc[-1] - r60.mean()) / r60.std(ddof=1)
    if qy.get("price") and qx.get("price") and qy["status"] in ("live", "delayed") and qx["status"] in ("live", "delayed"):
        s_now = math.log(qy["price"]) - a - b * math.log(qx["price"])
        z_now = (s_now - r60.mean()) / r60.std(ddof=1)
        status = "live" if qy["status"] == qx["status"] == "live" else "delayed"
    out["z"] = _r(z_now); out["z_status"] = status
    chk = out["checks"]
    chk.append(("statistical tests (EG, Johansen, half-life, Hurst)", row["accepted"], "; ".join(row["reasons"]) or "all passed"))
    chk.append((f"|z| ≥ entry {risk['entry_z']}", abs(z_now) >= risk["entry_z"], f"z = {z_now:.2f} ({status})"))
    chk.append((f"|z| < stop {risk['stop_z']}", abs(z_now) < risk["stop_z"], "spread not already broken"))
    for q in (qy, qx):
        ok = q.get("status") in ("live", "delayed", "closed") and q.get("price")
        spread_bp = None
        if q.get("bid") and q.get("ask") and q["ask"] > q["bid"] > 0:
            spread_bp = (q["ask"] - q["bid"]) / ((q["ask"] + q["bid"]) / 2) * 1e4
        chk.append((f"{q['symbol']} quote quality", bool(ok) and (spread_bp is None or spread_bp < 25),
                    f"{q.get('status')}; bid-ask {spread_bp:.1f} bp" if spread_bp is not None else f"{q.get('status')}; no bid/ask" + (f" ({q.get('error')})" if q.get("error") else "")))
    out["checks"] = [{"check": c, "pass": bool(p), "detail": d} for c, p, d in chk]
    out["eligible"] = all(c["pass"] for c in out["checks"])
    return out
