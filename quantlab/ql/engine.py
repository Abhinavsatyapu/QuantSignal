"""Research engine: single backtests, grid + walk-forward optimisation,
A-vs-B comparison with out-of-sample significance, and rule-based reports.

Why computing signals once over the full history is safe: every strategy's
weight at day t is a function of prices up to t only (rolling windows,
filters and state machines run forward in time). The walk-forward therefore
slices the same weight series into train and test windows, and parameters for
a test window are chosen using the train window's results only."""
from __future__ import annotations

import itertools
import math
import random
import uuid

import numpy as np
import pandas as pd

from . import backtest as bt
from . import metrics, stats
from .strategies import LIBRARY, run as run_strategy

BENCH = "SPY"


def _grid(key: str, max_combos: int = 24, seed: int = 11) -> list[dict]:
    g = LIBRARY[key].grid
    keys = list(g)
    combos = [dict(zip(keys, v)) for v in itertools.product(*[g[k] for k in keys])]
    if len(combos) > max_combos:
        rnd = random.Random(seed)
        combos = rnd.sample(combos, max_combos)
    return combos


def _slice_bt(out, opens, closes, start, end, capital, costs):
    w = out.weights.copy()
    mask = (w.index < pd.Timestamp(start)) | (w.index > pd.Timestamp(end))
    w[mask] = 0.0
    sl = (w.index >= pd.Timestamp(start)) & (w.index <= pd.Timestamp(end))
    # include the day before start so a signal from the prior close can execute on the first day
    return bt.run(w[sl], opens[sl], closes[sl], out.units, capital, costs, out.reason[sl] if out.reason is not None else None)


def backtest(panel: dict, key: str, pair: list[str], params: dict | None, start: str, end: str,
             capital: float, costs: bt.Costs) -> dict:
    C, O = panel["close"][pair], panel["open"][pair]
    out = run_strategy(key, C, O, params)
    res = _slice_bt(out, O, C, start, end, capital, costs)
    bench = panel["close"].get(BENCH)
    reg = metrics.regimes(bench) if bench is not None else None
    m = metrics.compute(res, capital, bench, reg)
    return {"metrics": m, "series": metrics.series(res, capital), "trades": res.trades[-400:],
            "params": {**LIBRARY[key].defaults, **(params or {})}, "_res": res, "_out": out}


def walk_forward(panel: dict, key: str, pair: list[str], start: str, end: str, capital: float, costs: bt.Costs,
                 train_days: int = 504, test_days: int = 126, max_combos: int = 24, fixed: dict | None = None) -> dict:
    """Rolling walk-forward. For each fold: evaluate the parameter grid on the
    train window, pick the most ROBUST combination (average Sharpe of it and its
    grid neighbours, penalised when it trades too rarely), then apply it to the
    following unseen test window. OOS returns are stitched together."""
    C, O = panel["close"][pair], panel["open"][pair]
    idx = C.index[(C.index >= pd.Timestamp(start)) & (C.index <= pd.Timestamp(end))]
    combos = [fixed] if fixed else _grid(key, max_combos)
    outs = [run_strategy(key, C, O, p) for p in combos]
    folds, oos_parts, trades, all_train_sr = [], [], [], []
    i = train_days
    while i + 20 <= len(idx):
        tr0, tr1 = idx[i - train_days], idx[i - 1]
        te0, te1 = idx[i], idx[min(i + test_days, len(idx)) - 1]
        srs, ntr = [], []
        for out in outs:
            r = _slice_bt(out, O, C, tr0, tr1, capital, costs)
            d = r.daily
            sr = d.mean() / d.std() * math.sqrt(252) if d.std() > 0 else 0.0
            srs.append(sr); ntr.append(sum(1 for t in r.trades if not t["open"]))
        all_train_sr.extend(srs)
        score = _robust_scores(combos, srs, ntr)
        best = int(np.argmax(score))
        r = _slice_bt(outs[best], O, C, te0, te1, capital, costs)
        d = r.daily
        folds.append({"train": [str(tr0.date()), str(tr1.date())], "test": [str(te0.date()), str(te1.date())],
                      "params": combos[best], "train_sharpe": _r(srs[best]), "train_trades": ntr[best],
                      "test_return": _r(float((1 + d).prod() - 1)), "test_sharpe": _r(d.mean() / d.std() * math.sqrt(252) if d.std() > 0 else 0.0),
                      "test_trades": sum(1 for t in r.trades if not t["open"])})
        oos_parts.append(d)
        trades.extend(r.trades)
        i += test_days
    if not oos_parts:
        return {"ok": False, "error": f"not enough history: need more than {train_days + 20} sessions in the selected range, have {len(idx)}"}
    oos = pd.concat(oos_parts)
    oos = oos[~oos.index.duplicated()]
    eq = capital * (1 + oos).cumprod()
    res = bt.Result(eq, oos, pd.Series(0.0, oos.index), pd.Series(0.0, oos.index), pd.Series(0.0, oos.index),
                    pd.Series(0.0, oos.index), trades, pd.DataFrame(), pd.DataFrame())
    # exposure / turnover / costs for the stitched OOS run come from re-running each test window
    gross, turn, cst = [], [], []
    for f in folds:
        bi = combos.index(f["params"])
        r = _slice_bt(outs[bi], O, C, f["test"][0], f["test"][1], capital, costs)
        gross.append(r.gross_exposure); turn.append(r.turnover); cst.append(r.costs)
    res.gross_exposure = pd.concat(gross).reindex(oos.index).fillna(0)
    res.turnover = pd.concat(turn).reindex(oos.index).fillna(0)
    res.costs = pd.concat(cst).reindex(oos.index).fillna(0)
    bench = panel["close"].get(BENCH)
    reg = metrics.regimes(bench) if bench is not None else None
    m = metrics.compute(res, capital, bench, reg)
    sr_var = float(np.var(np.array(all_train_sr) / math.sqrt(252))) if len(all_train_sr) > 1 else 0.0
    m["deflated_sharpe"] = _r(stats.deflated_sharpe(oos.to_numpy(), max(len(combos), 1), sr_var))
    m["fold_positive_share"] = _r(np.mean([f["test_sharpe"] > 0 for f in folds]))
    m["n_trials"] = len(combos)
    return {"ok": True, "folds": folds, "metrics": m, "series": metrics.series(res, capital), "oos_daily": oos,
            "trades": trades[-400:], "combos_tested": len(combos)}


def _robust_scores(combos, srs, ntr, min_trades=4):
    """Score = mean Sharpe over the combo and its neighbours (combos that differ in
    exactly one parameter by one grid step), minus a penalty for thin trading."""
    keys = list(combos[0].keys()) if combos and combos[0] else []
    out = []
    for i, c in enumerate(combos):
        neigh = [srs[i]]
        for j, d in enumerate(combos):
            if i != j and sum(c[k] != d[k] for k in keys) == 1:
                neigh.append(srs[j])
        s = float(np.mean(neigh))
        if ntr[i] < min_trades:
            s -= 1.0
        out.append(s)
    return out


def _r(x, n=4):
    try:
        x = float(x)
        return round(x, n) if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def cost_sensitivity(panel, key, pair, params, start, end, capital, costs: bt.Costs) -> dict:
    out = {}
    for mult in (0.0, 1.0, 2.0, 3.0):
        c = bt.Costs(costs.fee_bps * mult, costs.spread_bps * mult, costs.slippage_bps * mult, costs.borrow_bps * mult)
        r = backtest(panel, key, pair, params, start, end, capital, c)
        out[f"{mult:g}x"] = {"sharpe": r["metrics"]["sharpe"], "total_return": r["metrics"]["total_return"]}
    return out


# ------------------------------------------------------------------ A vs B
def compare(panel: dict, a: str, b: str, pair: list[str], start: str, end: str, capital: float, costs: bt.Costs,
            params_a: dict | None = None, params_b: dict | None = None, optimise: bool = True,
            train_days: int = 504, test_days: int = 126) -> dict:
    """Both strategies get identical stocks, dates, capital, costs, sizing rules
    and walk-forward folds. The verdict uses OUT-OF-SAMPLE daily returns only."""
    full_a = backtest(panel, a, pair, params_a, start, end, capital, costs)
    full_b = backtest(panel, b, pair, params_b, start, end, capital, costs)
    wf_a = walk_forward(panel, a, pair, start, end, capital, costs, train_days, test_days, fixed=None if optimise else {**LIBRARY[a].defaults, **(params_a or {})})
    wf_b = walk_forward(panel, b, pair, start, end, capital, costs, train_days, test_days, fixed=None if optimise else {**LIBRARY[b].defaults, **(params_b or {})})
    sens_a = cost_sensitivity(panel, a, pair, params_a, start, end, capital, costs)
    sens_b = cost_sensitivity(panel, b, pair, params_b, start, end, capital, costs)
    verdict = decide(wf_a, wf_b, a, b)
    rep = report(a, b, pair, full_a, full_b, wf_a, wf_b, sens_a, sens_b, verdict, costs, start, end, capital)
    strip = lambda r: {k: v for k, v in r.items() if not k.startswith("_")}
    stripwf = lambda r: {k: v for k, v in r.items() if k != "oos_daily"}
    return {"id": uuid.uuid4().hex[:12], "a": a, "b": b, "pair": pair, "start": start, "end": end, "capital": capital,
            "costs": costs.as_dict(), "full": {"A": strip(full_a), "B": strip(full_b)},
            "oos": {"A": stripwf(wf_a), "B": stripwf(wf_b)}, "cost_sensitivity": {"A": sens_a, "B": sens_b},
            "verdict": verdict, "report": rep, "data_warnings": panel.get("warnings", [])}


def decide(wf_a, wf_b, a, b, min_trades=10, min_days=250, alpha=0.10) -> dict:
    if not (wf_a.get("ok") and wf_b.get("ok")):
        return {"winner": None, "label": "No verdict", "why": [wf_a.get("error") or wf_b.get("error") or "walk-forward failed"]}
    ma, mb = wf_a["metrics"], wf_b["metrics"]
    why = []
    if ma["days"] < min_days or mb["days"] < min_days:
        why.append(f"out-of-sample period is only {min(ma['days'], mb['days'])} sessions (need ≥ {min_days})")
    for k, m in (("A", ma), ("B", mb)):
        if m["trades"] < min_trades:
            why.append(f"strategy {k} closed only {m['trades']} out-of-sample trades (need ≥ {min_trades})")
    da, db_ = wf_a["oos_daily"], wf_b["oos_daily"]
    j = pd.concat([da, db_], axis=1).dropna()
    diff = (j.iloc[:, 0] - j.iloc[:, 1]).to_numpy()
    p_a = stats.block_bootstrap_pvalue(diff)
    p_b = stats.block_bootstrap_pvalue(-diff)
    sa, sb = ma["sharpe"] or 0.0, mb["sharpe"] or 0.0
    lead = "A" if sa >= sb else "B"
    p = p_a if lead == "A" else p_b
    lm = ma if lead == "A" else mb
    detail = {"oos_sharpe_A": sa, "oos_sharpe_B": sb, "p_value_lead_beats_other": _r(p), "lead": lead,
              "lead_sharpe_pvalue": lm.get("sharpe_pvalue"), "lead_deflated_sharpe": lm.get("deflated_sharpe")}
    if not np.isfinite(p) or p >= alpha:
        why.append(f"the out-of-sample return difference is not significant (bootstrap p = {p:.2f}, need < {alpha})" if np.isfinite(p) else "too few overlapping days to test the difference")
    if (lm["sharpe"] or 0) <= 0:
        why.append(f"the leading strategy ({lead}) has a non-positive out-of-sample Sharpe ({lm['sharpe']:.2f})")
    if why:
        return {"winner": None, "label": "Insufficient evidence — no winner declared", "why": why, **detail}
    name = LIBRARY[a if lead == "A" else b].name
    return {"winner": lead, "label": f"{lead} ({name}) is better out-of-sample", "why": [
        f"higher out-of-sample Sharpe ({max(sa, sb):.2f} vs {min(sa, sb):.2f})",
        f"block-bootstrap p = {p:.3f} that the daily return advantage is due to chance",
        f"{lm['trades']} out-of-sample trades over {lm['days']} sessions"], **detail}


def _pct(x):
    return "n/a" if x is None else f"{x * 100:.1f}%"


def _n(x, d=2):
    return "n/a" if x is None else (x if isinstance(x, str) else f"{x:.{d}f}")


def _regime_lines(m):
    out = []
    br = m.get("by_regime") or {}
    for col, labels in br.items():
        parts = [f"{lab}: Sharpe {_n(v.get('sharpe'))} over {v['days']} d" for lab, v in labels.items() if v.get("days")]
        if parts:
            out.append(f"{col} — " + "; ".join(parts))
    return out


def _weak(m, sens, label):
    w = []
    if m.get("max_drawdown") is not None and m["max_drawdown"] < -0.15:
        w.append(f"{label}: deep drawdown ({_pct(m['max_drawdown'])})")
    if m.get("trades", 0) < 20:
        w.append(f"{label}: few trades ({m.get('trades', 0)}), so statistics are noisy")
    s1, s2 = (sens.get("1x") or {}).get("sharpe"), (sens.get("2x") or {}).get("sharpe")
    if s1 is not None and s2 is not None and s1 > 0 and s2 < s1 * 0.5:
        w.append(f"{label}: cost-sensitive — Sharpe falls from {s1:.2f} to {s2:.2f} when costs double")
    if (m.get("deflated_sharpe") is not None) and m["deflated_sharpe"] < 0.5:
        w.append(f"{label}: deflated Sharpe {m['deflated_sharpe']:.2f} — after allowing for the number of parameter sets tried, the edge may be luck")
    if m.get("beta") is not None and abs(m["beta"]) > 0.3:
        w.append(f"{label}: not market-neutral (beta {m['beta']:.2f})")
    return w or [f"{label}: no major weakness flagged by the rules"]


def report(a, b, pair, fa, fb, wa, wb, sa, sb, verdict, costs, start, end, capital) -> dict:
    A, B = LIBRARY[a], LIBRARY[b]

    def block(S, full, wf, sens, lab):
        m, mo = full["metrics"], (wf.get("metrics") or {})
        ex = [t for t in full["trades"] if not t["open"]]
        best = max(ex, key=lambda t: t["pnl"]) if ex else None
        worst = min(ex, key=lambda t: t["pnl"]) if ex else None
        return {
            "name": f"{lab} — {S.name}", "methodology": S.method, "parameters": full["params"],
            "walk_forward_parameters": [f["params"] for f in wf.get("folds", [])][-3:],
            "historical": f"Full period with the parameters above: total {_pct(m['total_return'])}, CAGR {_pct(m['cagr'])}, Sharpe {_n(m['sharpe'])}, "
                          f"max drawdown {_pct(m['max_drawdown'])}, {m['trades']} trades, win rate {_pct(m['win_rate'])}.",
            "out_of_sample": (f"Walk-forward out-of-sample ({mo.get('days')} sessions, {len(wf.get('folds', []))} folds): total {_pct(mo.get('total_return'))}, "
                              f"Sharpe {_n(mo.get('sharpe'))}, Sortino {_n(mo.get('sortino'))}, max drawdown {_pct(mo.get('max_drawdown'))}, "
                              f"{mo.get('trades')} trades, positive in {_pct(mo.get('fold_positive_share'))} of folds, deflated Sharpe {_n(mo.get('deflated_sharpe'))}.")
            if wf.get("ok") else f"Walk-forward not available: {wf.get('error')}",
            "risk": f"Volatility {_pct(m['volatility'])}, beta {_n(m['beta'])}, Calmar {_n(m['calmar'])}, average gross exposure {_n(m['avg_gross_exposure'])}x, "
                    f"time in market {_pct(m['exposure'])}.",
            "costs": f"Costs paid {_n(m['transaction_costs'], 0)} USD ({_pct(m['costs_pct_capital'])} of capital). Sharpe at 0× / 1× / 2× / 3× costs: "
                     + " / ".join(_n((sens.get(k) or {}).get("sharpe")) for k in ("0x", "1x", "2x", "3x")) + ".",
            "trade_examples": [x for x in (best, worst) if x],
            "regimes": _regime_lines(mo if wf.get("ok") else m),
            "weaknesses": _weak(mo if wf.get("ok") else m, sens, lab),
        }

    rec = verdict["label"] + ". " + " ".join(r[0].upper() + r[1:] + "." for r in verdict["why"])
    if verdict["winner"] is None:
        rec += " Neither strategy should be preferred on this evidence; test more pairs or a longer period."
    return {"title": f"{a} vs {b} on {pair[0]}/{pair[1]}", "setup": f"{start} → {end}, capital {capital:,.0f} USD, costs per side: fee {costs.fee_bps} bp + half of "
            f"{costs.spread_bps} bp spread + {costs.slippage_bps} bp slippage; shorts pay {costs.borrow_bps} bp/yr borrow. Signals at the close, fills at the next open.",
            "A": block(A, fa, wa, sa, "A"), "B": block(B, fb, wb, sb, "B"), "recommendation": rec}


# ------------------------------------------------------------------ parameter optimisation
def optimise(panel: dict, key: str, pair: list[str], start: str, end: str, capital: float, costs: bt.Costs,
             is_frac: float = 0.7, max_combos: int = 60) -> dict:
    """Grid search with an in-sample / out-of-sample split.
    The chosen set is the most ROBUST in-sample one (neighbourhood-averaged Sharpe),
    never simply the highest return. We also report how well in-sample rank
    predicts out-of-sample rank — a weak or negative correlation is a warning
    sign of overfitting."""
    C, O = panel["close"][pair], panel["open"][pair]
    idx = C.index[(C.index >= pd.Timestamp(start)) & (C.index <= pd.Timestamp(end))]
    if len(idx) < 300:
        return {"ok": False, "error": f"need at least 300 sessions, have {len(idx)}"}
    cut = idx[int(len(idx) * is_frac)]
    combos = _grid(key, max_combos)
    rows, is_sr, oos_sr, ntr = [], [], [], []
    for p in combos:
        out = run_strategy(key, C, O, p)
        ri = _slice_bt(out, O, C, idx[0], idx[idx < cut][-1], capital, costs)
        ro = _slice_bt(out, O, C, cut, idx[-1], capital, costs)
        si = _sr(ri.daily); so = _sr(ro.daily)
        ti = sum(1 for t in ri.trades if not t["open"]); to = sum(1 for t in ro.trades if not t["open"])
        is_sr.append(si); oos_sr.append(so); ntr.append(ti)
        rows.append({"params": p, "is_sharpe": _r(si), "oos_sharpe": _r(so), "is_return": _r(float((1 + ri.daily).prod() - 1)),
                     "oos_return": _r(float((1 + ro.daily).prod() - 1)), "is_trades": ti, "oos_trades": to})
    score = _robust_scores(combos, is_sr, ntr)
    best = int(np.argmax(score)); top_raw = int(np.argmax(is_sr))
    for i, r in enumerate(rows):
        r["robust_score"] = _r(score[i])
    rc = pd.Series(is_sr).rank().corr(pd.Series(oos_sr).rank()) if len(rows) > 3 else float("nan")
    warn = []
    if not np.isfinite(rc) or rc < 0.2:
        warn.append(f"in-sample rank barely predicts out-of-sample rank (Spearman {rc:.2f}) — results are likely overfit or noise")
    if best != top_raw:
        warn.append("the robust choice differs from the highest in-sample Sharpe; the top raw combination sits on an unstable peak")
    sr_var = float(np.var(np.array(is_sr) / math.sqrt(252)))
    return {"ok": True, "split": str(cut.date()), "rows": rows, "selected": rows[best], "highest_in_sample": rows[top_raw],
            "is_oos_rank_corr": _r(rc), "warnings": warn, "n_trials": len(combos),
            "grid": LIBRARY[key].grid, "trials_note": f"{len(combos)} combinations tested" + (" (random subset of the full grid)" if len(combos) < math.prod(len(v) for v in LIBRARY[key].grid.values()) else ""),
            "sr_var_trials": sr_var}


def _sr(d):
    return float(d.mean() / d.std() * math.sqrt(252)) if d.std() > 0 else 0.0
