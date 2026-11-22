"""Performance metrics. All computed from the backtest's own equity curve and
trade list; regime splits use the benchmark (SPY) only as of each day."""
from __future__ import annotations

import math
import numpy as np
import pandas as pd

from . import stats
from .backtest import Result

TD = 252


def _f(x):
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return None if not math.isfinite(x) else x


def regimes(bench_close: pd.Series) -> pd.DataFrame:
    """Per-day regime labels known at that day's close:
    vol: 'high' if 20d realised vol is above its trailing 252d median, else 'low'
    trend: 'trending' if 20d efficiency ratio > 0.3, else 'ranging'
    market: 'bull' if 126d return > +8%, 'bear' if < -8%, else 'sideways'."""
    r = np.log(bench_close).diff()
    rv = r.rolling(20).std() * math.sqrt(TD)
    med = rv.rolling(252, min_periods=60).median()
    er = stats.efficiency_ratio(bench_close, 20)
    r126 = bench_close / bench_close.shift(126) - 1
    out = pd.DataFrame(index=bench_close.index)
    out["vol"] = np.where(rv > med, "high", np.where(rv.notna() & med.notna(), "low", None))
    out["trend"] = np.where(er > 0.3, "trending", np.where(er.notna(), "ranging", None))
    out["market"] = np.where(r126 > 0.08, "bull", np.where(r126 < -0.08, "bear", np.where(r126.notna(), "sideways", None)))
    return out


def _block(d: pd.Series) -> dict:
    d = d.dropna()
    if len(d) < 5:
        return {"days": int(len(d)), "ret": None, "sharpe": None}
    ann = d.mean() * TD
    sd = d.std(ddof=1)
    return {"days": int(len(d)), "ret": _f((1 + d).prod() - 1), "ann_ret": _f(ann), "sharpe": _f(d.mean() / sd * math.sqrt(TD)) if sd > 0 else None}


def compute(res: Result, capital: float, bench: pd.Series | None = None, reg: pd.DataFrame | None = None) -> dict:
    eq = res.equity.dropna()
    d = res.daily.reindex(eq.index).fillna(0.0)
    n = len(eq)
    years = n / TD if n else float("nan")
    total = eq.iloc[-1] / capital - 1 if n else float("nan")
    cagr = (eq.iloc[-1] / capital) ** (1 / years) - 1 if n and years > 0 and eq.iloc[-1] > 0 else float("nan")
    sd = d.std(ddof=1)
    sharpe = d.mean() / sd * math.sqrt(TD) if sd > 0 else float("nan")
    down = d[d < 0]
    dsd = math.sqrt((down ** 2).sum() / max(len(d), 1))
    sortino = d.mean() * TD / (dsd * math.sqrt(TD)) if dsd > 0 else float("nan")
    peak = eq.cummax(); dd = eq / peak - 1
    mdd = dd.min() if n else float("nan")
    calmar = cagr / abs(mdd) if mdd and mdd < 0 and math.isfinite(cagr) else float("nan")
    closed = [t for t in res.trades if not t["open"]]
    wins = [t for t in closed if t["pnl"] > 0]; losses = [t for t in closed if t["pnl"] <= 0]
    gp = sum(t["pnl"] for t in wins); gl = -sum(t["pnl"] for t in losses)
    pf = gp / gl if gl > 0 else (float("inf") if gp > 0 else float("nan"))
    beta = float("nan")
    if bench is not None:
        br = bench.reindex(eq.index).pct_change()
        j = pd.concat([d, br], axis=1).dropna()
        if len(j) > 30 and j.iloc[:, 1].var() > 0:
            beta = j.iloc[:, 0].cov(j.iloc[:, 1]) / j.iloc[:, 1].var()
    monthly = (1 + d).resample("ME").prod() - 1
    pos_months = (monthly > 0).mean() if len(monthly) else float("nan")
    roll = d.rolling(63).apply(lambda x: x.mean() / x.std() * math.sqrt(TD) if x.std() > 0 else np.nan, raw=True)
    def _cs(s):
        return _f(s.reindex(eq.index).sum()) if s is not None else None
    net_pnl = float(eq.iloc[-1] - capital) if n else float("nan")
    tot_cost = float(res.costs.reindex(eq.index).sum())
    streak = mx = 0
    for t in closed:
        streak = streak + 1 if t["pnl"] <= 0 else 0
        mx = max(mx, streak)
    out = {
        "net_pnl": _f(net_pnl), "gross_pnl": _f(net_pnl + tot_cost),
        "avg_win": _f(np.mean([t["pnl"] for t in wins])) if wins else None,
        "avg_loss": _f(np.mean([t["pnl"] for t in losses])) if losses else None,
        "max_consecutive_losses": mx,
        "fees": _cs(res.cost_fee), "slippage_costs": _cs(res.cost_slip), "borrow_costs": _cs(res.cost_borrow),
        "capital_utilization": _f(res.gross_exposure.reindex(eq.index).mean()),
        "total_return": _f(total), "ann_return": _f(d.mean() * TD), "cagr": _f(cagr),
        "win_rate": _f(len(wins) / len(closed)) if closed else None,
        "profit_factor": _f(pf) if math.isfinite(pf) else ("∞" if pf == float("inf") else None),
        "sharpe": _f(sharpe), "sortino": _f(sortino), "max_drawdown": _f(mdd), "calmar": _f(calmar),
        "avg_trade_return": _f(np.mean([t["ret"] for t in closed])) if closed else None,
        "avg_holding_days": _f(np.mean([t["days"] for t in closed])) if closed else None,
        "trades": len(closed), "winning_trades": len(wins), "losing_trades": len(losses), "open_trades": len(res.trades) - len(closed),
        "exposure": _f((res.gross_exposure.reindex(eq.index) > 1e-6).mean()),
        "avg_gross_exposure": _f(res.gross_exposure.reindex(eq.index).mean()),
        "turnover_annual": _f(res.turnover.reindex(eq.index).sum() / years) if years and years > 0 else None,
        "transaction_costs": _f(res.costs.sum()), "costs_pct_capital": _f(res.costs.sum() / capital),
        "beta": _f(beta), "volatility": _f(sd * math.sqrt(TD)),
        "positive_months": _f(pos_months), "rolling_sharpe_sd": _f(roll.std()),
        "sharpe_pvalue": _f(stats.sharpe_pvalue(d.to_numpy())),
        "days": n, "start": str(eq.index[0].date()) if n else None, "end": str(eq.index[-1].date()) if n else None,
    }
    if reg is not None:
        rg = reg.reindex(eq.index)
        out["by_regime"] = {col: {lab: _block(d[rg[col] == lab]) for lab in sorted(set(rg[col].dropna()))} for col in rg.columns}
    return out


def series(res: Result, capital: float, max_points: int = 600) -> dict:
    eq = res.equity.dropna()
    dd = eq / eq.cummax() - 1
    step = max(1, len(eq) // max_points)
    sl = slice(None, None, step)
    monthly = ((1 + res.daily.reindex(eq.index).fillna(0)).resample("ME").prod() - 1)
    return {"dates": [str(x.date()) for x in eq.index[sl]], "equity": [round(v, 2) for v in eq.iloc[sl]],
            "drawdown": [round(v, 5) for v in dd.iloc[sl]],
            "monthly": {str(k.date())[:7]: round(float(v), 5) for k, v in monthly.items()},
            "trade_returns": [round(t["ret"], 5) for t in res.trades if not t["open"]]}
