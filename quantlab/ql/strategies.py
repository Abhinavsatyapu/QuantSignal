"""Strategy library. Each strategy maps a price panel to TARGET WEIGHTS
(fraction of equity per symbol) decided at the close of day t. The backtester
executes them at the next session's open, so nothing here can trade on
information it would not have had.

Every strategy runs on the same input: a pair of symbols (y, x). Single-asset
strategies (B, D, G, M) trade each of the two stocks on its own with half the
allocation, so A-vs-B comparisons always use the same stocks and capital."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable
import numpy as np
import pandas as pd

from . import stats


@dataclass
class Output:
    weights: pd.DataFrame                  # dates x symbols, fraction of equity
    units: list[list[str]]                 # symbols traded together (trade grouping)
    reason: pd.DataFrame | None = None     # dates x unit-index: exit reason codes
    diag: dict = field(default_factory=dict)  # series for charts (z, beta, regime...)


@dataclass
class Strategy:
    key: str
    name: str
    family: str
    kind: str                       # "pair" or "single"
    method: str
    defaults: dict
    grid: dict
    fn: Callable[[pd.DataFrame, pd.DataFrame, dict], Output]


# ---------------------------------------------------------------- helpers
def _state_machine(z: np.ndarray, ok: np.ndarray, entry: float, exit_: float, stop: float,
                   max_hold: int, momentum: bool = False, lpx: np.ndarray | None = None,
                   vol: np.ndarray | None = None, vol_stop: float = 0.0):
    """Generic threshold state machine over a signal z (mean-reversion by default).
    side +1 = long the spread/asset, -1 = short. Returns (side array, reason array).
    reason codes: 'entry', 'exit', 'stop', 'time', '' (no change).
    After a stop, no re-entry until |z| has come back inside the entry band."""
    n = len(z)
    side = np.zeros(n); reason = np.array([""] * n, dtype=object)
    cur, held, locked = 0, 0, False
    p0 = v0 = np.nan
    mh_arr = np.ndim(max_hold) > 0
    mh = 0
    for t in range(n):
        zt = z[t]
        if not np.isfinite(zt):
            side[t] = cur; held += cur != 0
            continue
        if locked and abs(zt) < entry:
            locked = False
        if cur != 0:
            held += 1
            if momentum:
                done = (cur > 0 and zt <= exit_) or (cur < 0 and zt >= -exit_)
                stopped = False
            else:
                done = (cur > 0 and zt >= -exit_) or (cur < 0 and zt <= exit_)
                stopped = stop > 0 and abs(zt) >= stop
            if not stopped and vol_stop > 0 and lpx is not None and np.isfinite(v0):
                # volatility stop: adverse log move beyond vol_stop x (daily sd at entry) x sqrt(days held)
                stopped = cur * (lpx[t] - p0) < -vol_stop * v0 * np.sqrt(max(held, 1))
            if stopped:
                cur, held, locked = 0, 0, True; reason[t] = "stop"
            elif done:
                cur, held = 0, 0; reason[t] = "exit"
            elif mh and held >= mh:
                cur, held, locked = 0, 0, True; reason[t] = "time"
        if cur == 0 and not locked and reason[t] == "" and ok[t]:
            if momentum:
                if zt >= entry: cur = 1
                elif zt <= -entry: cur = -1
            else:
                if zt >= entry and (stop <= 0 or zt < stop): cur = -1
                elif zt <= -entry and (stop <= 0 or zt > -stop): cur = 1
            if cur != 0:
                held = 0; reason[t] = "entry"
                mh = int(max_hold[t]) if mh_arr else int(max_hold or 0)
                if lpx is not None:
                    p0 = lpx[t]; v0 = vol[t] if vol is not None else np.nan
        side[t] = cur
    return side, reason


def _pair_weights(side: np.ndarray, beta: np.ndarray, py: np.ndarray, px: np.ndarray, alloc: np.ndarray):
    """Freeze dollar weights at entry: long spread = +1 share y, -beta shares x,
    scaled so gross notional = alloc * equity. Weights stay fixed while held
    (no daily rebalancing churn)."""
    n = len(side)
    wy = np.zeros(n); wx = np.zeros(n)
    cur_y = cur_x = 0.0; prev = 0
    for t in range(n):
        s = side[t]
        if s != prev:
            if s == 0 or not np.isfinite(beta[t]):
                cur_y = cur_x = 0.0
            else:
                b = beta[t]
                gross = py[t] + abs(b) * px[t]
                a = alloc[t] if np.isfinite(alloc[t]) else 0.0
                cur_y = s * py[t] / gross * a
                cur_x = -s * b * px[t] / gross * a
            prev = s
        wy[t], wx[t] = cur_y, cur_x
    return wy, wx


def _vol_alloc(ret: pd.Series, p: dict) -> np.ndarray:
    """Position size: fixed fraction, or volatility-targeted (capped at 2x)."""
    base = float(p.get("alloc", 0.5))
    if p.get("sizing", "fixed") != "vol":
        return np.full(len(ret), base)
    rv = ret.rolling(20).std() * np.sqrt(252)
    scale = (float(p.get("target_vol", 0.10)) / rv).clip(upper=2.0)
    return (base * scale).to_numpy()


_PV_CACHE: dict = {}


def rolling_coint_p(y: pd.Series, x: pd.Series, window: int, every: int = 21) -> np.ndarray:
    """Engle-Granger p-value on the trailing window ending at t, re-estimated every
    `every` bars and carried forward. Cached per (pair, dates, window)."""
    key = (y.name, x.name, len(y), str(y.index[0]), str(y.index[-1]), float(y.iloc[-1]), float(x.iloc[-1]), window, every)
    if key in _PV_CACHE:
        return _PV_CACHE[key]
    n = len(y)
    pv = np.full(n, np.nan); last = np.nan
    yl, xl = np.log(y.to_numpy()), np.log(x.to_numpy())
    for t in range(window - 1, n):
        if (t - (window - 1)) % every == 0:
            last = stats.eg_fast_p(yl[t - window + 1:t + 1], xl[t - window + 1:t + 1])
        pv[t] = last
    if len(_PV_CACHE) > 500:
        _PV_CACHE.clear()
    _PV_CACHE[key] = pv
    return pv


def _rolling_coint_gate(y: pd.Series, x: pd.Series, window: int, pmax: float, every: int = 21) -> np.ndarray:
    if pmax >= 1:
        return np.ones(len(y), bool)
    pv = rolling_coint_p(y, x, window, every)
    return np.isfinite(pv) & (pv < pmax)


def _pair_output(c, y, x, side, reason, beta, alloc, diag) -> Output:
    wy, wx = _pair_weights(side, beta, c[y].to_numpy(), c[x].to_numpy(), alloc)
    w = pd.DataFrame({y: wy, x: wx}, index=c.index)
    return Output(w, [[y, x]], pd.DataFrame({0: reason}, index=c.index), diag)


# ---------------------------------------------------------------- A: cointegration stat-arb
def strat_a(c: pd.DataFrame, o: pd.DataFrame, p: dict) -> Output:
    y, x = c.columns[:2]
    ly, lx = np.log(c[y]), np.log(c[x])
    L = int(p["lookback"])
    rb = stats.rolling_ols(ly, lx, int(p.get("beta_window", 60)))
    spread = ly - rb["beta"] * lx
    z = stats.zscore(spread, L)
    gate = _rolling_coint_gate(c[y], c[x], int(p.get("coint_window", 252)), float(p["coint_p"]))
    side, reason = _state_machine(z.to_numpy(), gate, p["entry"], p["exit"], p["stop"], int(p.get("max_hold", 0)))
    alloc = _vol_alloc(spread.diff(), p)
    beta_px = (rb["beta"] * c[y] / c[x]).to_numpy()   # log-beta -> share hedge ratio
    return _pair_output(c, y, x, side, reason, beta_px, alloc, {"z": z, "beta": rb["beta"], "gate": pd.Series(gate, c.index)})


# ---------------------------------------------------------------- B: z-score mean reversion (single asset)
def _single(c, p, signal_fn, momentum=False, alloc_fn=None):
    ws, rs, diag = {}, {}, {}
    for i, s in enumerate(c.columns[:2]):
        z, ok, extra = signal_fn(c[s])
        lp = np.log(c[s])
        side, reason = _state_machine(z.to_numpy(), ok, p["entry"], p["exit"], p.get("stop", 0), int(p.get("max_hold", 0)), momentum,
                                      lp.to_numpy(), lp.diff().rolling(20).std().to_numpy(), float(p.get("vol_stop", 0)))
        a = alloc_fn(c[s]) if alloc_fn else _vol_alloc(c[s].pct_change(), p)
        ws[s] = side * a * 0.5
        # freeze size at entry
        w = ws[s].copy(); held = 0.0
        for t in range(len(w)):
            if side[t] != (side[t - 1] if t else 0):
                held = w[t]
            w[t] = held if side[t] != 0 else 0.0
        ws[s] = w; rs[i] = reason
        diag[f"z_{s}"] = z
        diag.update({f"{k}_{s}": v for k, v in extra.items()})
    return Output(pd.DataFrame(ws, index=c.index), [[s] for s in c.columns[:2]], pd.DataFrame(rs, index=c.index), diag)


def strat_b(c, o, p):
    L = int(p["lookback"])

    def sig(px):
        z = stats.zscore(np.log(px), L)
        return z, np.ones(len(px), bool), {}
    return _single(c, p, sig)


# ---------------------------------------------------------------- C: classic pairs trading (formation / trading)
def strat_c(c, o, p):
    y, x = c.columns[:2]
    ly, lx = np.log(c[y]).to_numpy(), np.log(c[x]).to_numpy()
    F, R = int(p["formation"]), int(p.get("reform", 63))
    n = len(c)
    z = np.full(n, np.nan); beta = np.full(n, np.nan); ok = np.zeros(n, bool)
    a = b = mu = sd = np.nan; corr_ok = False
    ry = np.diff(ly, prepend=np.nan); rx = np.diff(lx, prepend=np.nan)
    for t in range(F - 1, n):
        if (t - (F - 1)) % R == 0:   # re-form on trailing window ending at t
            sl = slice(t - F + 1, t + 1)
            a, b = stats.ols_beta(ly[sl], lx[sl])
            res = ly[sl] - a - b * lx[sl]
            mu, sd = res.mean(), res.std(ddof=1)
            cc = np.corrcoef(ry[sl][1:], rx[sl][1:])[0, 1]
            corr_ok = np.isfinite(cc) and cc >= float(p["min_corr"])
        if sd and np.isfinite(sd) and sd > 0:
            z[t] = (ly[t] - a - b * lx[t] - mu) / sd
        beta[t] = b * c[y].iat[t] / c[x].iat[t]
        ok[t] = corr_ok
    side, reason = _state_machine(z, ok, p["entry"], p["exit"], p["stop"], int(p.get("max_hold", 0)))
    alloc = _vol_alloc(pd.Series(ly - lx, index=c.index).diff(), p)
    return _pair_output(c, y, x, side, reason, beta, alloc, {"z": pd.Series(z, c.index)})


# ---------------------------------------------------------------- D: Bollinger band mean reversion
def strat_d(c, o, p):
    L, k = int(p["lookback"]), float(p["entry"])

    def sig(px):
        m = px.rolling(L).mean(); sd = px.rolling(L).std(ddof=1)
        z = (px - m) / sd.replace(0, np.nan)
        return z, np.ones(len(px), bool), {"ma": m}
    q = dict(p); q["exit"] = 0.0          # exit at the moving average
    q.setdefault("sizing", "vol")
    return _single(c, q, sig)


# ---------------------------------------------------------------- E: Kalman filter stat-arb
def strat_e(c, o, p):
    y, x = c.columns[:2]
    ly, lx = np.log(c[y]), np.log(c[x])
    kf = stats.kalman_beta(ly, lx, float(p["delta"]), None if p.get("obs_var") in (None, "auto") else float(p["obs_var"]))
    z = kf["err"] / np.sqrt(kf["var"])           # adaptive threshold: one-step forecast sd
    z.iloc[:int(p.get("warmup", 60))] = np.nan
    gate = _rolling_coint_gate(c[y], c[x], int(p.get("coint_window", 252)), float(p.get("coint_p", 1.0)))
    side, reason = _state_machine(z.to_numpy(), gate, p["entry"], p["exit"], p["stop"], int(p.get("max_hold", 0)))
    alloc = _vol_alloc(kf["err"], p)
    beta_px = (kf["beta"] * c[y] / c[x]).to_numpy()
    return _pair_output(c, y, x, side, reason, beta_px, alloc, {"z": z, "beta": kf["beta"]})


# ---------------------------------------------------------------- F: Ornstein-Uhlenbeck
def strat_f(c, o, p):
    y, x = c.columns[:2]
    ly, lx = np.log(c[y]), np.log(c[x])
    W = int(p["window"])
    rb = stats.rolling_ols(ly, lx, W)
    n = len(c)
    z = np.full(n, np.nan); ok = np.zeros(n, bool); hl = np.full(n, np.nan)
    b = rb["beta"].to_numpy(); lyv, lxv = ly.to_numpy(), lx.to_numpy()
    fit = None
    for t in range(W - 1, n):
        if fit is None or (t - (W - 1)) % 5 == 0:
            bt = b[t]
            if np.isfinite(bt):
                sp = lyv[t - W + 1:t + 1] - bt * lxv[t - W + 1:t + 1]
                fit = stats.ou_fit(sp); fit["b"] = bt
        if fit and fit.get("ok"):
            s_now = lyv[t] - fit["b"] * lxv[t]
            z[t] = (s_now - fit["mu"]) / fit["sigma_eq"]
            hl[t] = fit["half_life"]
            ok[t] = p["hl_min"] <= fit["half_life"] <= p["hl_max"] and fit["t"] < -2.9
    # maximum holding uses the half-life estimated at entry time (no look-ahead)
    hold = np.where(np.isfinite(hl), np.maximum(1, np.round(hl * p["hold_mult"])), 0)
    side, reason = _state_machine(z, ok, p["entry"], p["exit"], p["stop"], hold)
    alloc = _vol_alloc(pd.Series(z, c.index).diff(), p)
    beta_px = (rb["beta"] * c[y] / c[x]).to_numpy()
    return _pair_output(c, y, x, side, reason, beta_px, alloc, {"z": pd.Series(z, c.index), "half_life": pd.Series(hl, c.index)})


# ---------------------------------------------------------------- M: time-series momentum (benchmark for G)
def strat_m(c, o, p):
    L = int(p["lookback"])

    def sig(px):
        r = np.log(px).diff(L)
        vol = np.log(px).diff().rolling(60).std() * np.sqrt(L)
        return r / vol.replace(0, np.nan), np.ones(len(px), bool), {}
    return _single(c, p, sig, momentum=True)


# ---------------------------------------------------------------- G: regime switch momentum / mean reversion
def strat_g(c, o, p):
    L, n_er = int(p["lookback"]), int(p.get("er_window", 20))

    def run(px):
        er = stats.efficiency_ratio(px, n_er)
        trending = (er > float(p["er_threshold"])).to_numpy()
        zmr = stats.zscore(np.log(px), L).to_numpy()
        mom = (np.log(px).diff(L) / (np.log(px).diff().rolling(60).std() * np.sqrt(L))).to_numpy()
        s_mr, r_mr = _state_machine(zmr, ~trending, p["entry"], p["exit"], p["stop"], int(p.get("max_hold", 0)))
        s_mo, r_mo = _state_machine(mom, trending, p["entry"], 0.0, 0, int(p.get("max_hold", 0)), momentum=True)
        side = np.where(s_mr != 0, s_mr, s_mo)
        reason = np.where(r_mr != "", r_mr, r_mo)
        return side, reason, pd.Series(np.where(trending, 1.0, 0.0), index=px.index)
    ws, rs, diag = {}, {}, {}
    for i, s in enumerate(c.columns[:2]):
        side, reason, reg = run(c[s])
        a = _vol_alloc(c[s].pct_change(), p) * 0.5
        w = np.zeros(len(side)); held = 0.0
        for t in range(len(side)):
            if side[t] != (side[t - 1] if t else 0):
                held = side[t] * a[t] if np.isfinite(a[t]) else 0.0
            w[t] = held if side[t] != 0 else 0.0
        ws[s] = w; rs[i] = reason; diag[f"trending_{s}"] = reg
    return Output(pd.DataFrame(ws, index=c.index), [[s] for s in c.columns[:2]], pd.DataFrame(rs, index=c.index), diag)


COMMON = {"alloc": 0.5, "sizing": "fixed", "target_vol": 0.10}

LIBRARY: dict[str, Strategy] = {s.key: s for s in [
    Strategy("A", "Cointegration statistical arbitrage", "pairs", "pair",
             "Log-price spread y − β·x with a rolling-OLS hedge ratio; trades the rolling z-score of the spread, "
             "but only while a rolling Engle-Granger test on the trailing window rejects 'no cointegration' at the chosen p-value.",
             {**COMMON, "lookback": 30, "beta_window": 60, "entry": 2.0, "exit": 0.5, "stop": 4.0, "coint_p": 0.10, "coint_window": 252, "max_hold": 40},
             {"lookback": [20, 30, 50], "entry": [1.5, 2.0, 2.5], "exit": [0.0, 0.5], "stop": [3.5, 4.5], "coint_p": [0.05, 0.10]}, strat_a),
    Strategy("B", "Z-score mean reversion", "mean-reversion", "single",
             "Rolling z-score of each stock's log price against its own mean. Long below −entry, short above +entry, "
             "exit when the z-score returns to ±exit, stop when it extends to ±stop or (if vol_stop > 0) when the adverse move exceeds vol_stop × daily volatility × √days held. Each stock gets half the allocation.",
             {**COMMON, "lookback": 20, "entry": 2.0, "exit": 0.0, "stop": 3.5, "vol_stop": 0.0, "max_hold": 20},
             {"lookback": [10, 20, 30, 50, 100], "entry": [1.0, 1.5, 2.0, 2.5], "exit": [0.0, 0.5], "stop": [3.0, 4.0], "vol_stop": [0.0, 3.0]}, strat_b),
    Strategy("C", "Classic pairs trading", "pairs", "pair",
             "Formation window: static OLS hedge ratio, residual mean and sd, and return correlation (must exceed min_corr). "
             "Trading: z of the residual vs the formation statistics; enter on divergence, exit on convergence; re-formed every 63 sessions.",
             {**COMMON, "formation": 252, "reform": 63, "min_corr": 0.7, "entry": 2.0, "exit": 0.0, "stop": 4.0, "max_hold": 60},
             {"formation": [126, 252], "entry": [1.5, 2.0, 2.5], "exit": [0.0, 0.5], "min_corr": [0.6, 0.8]}, strat_c),
    Strategy("D", "Bollinger band mean reversion", "mean-reversion", "single",
             "Close outside the k-sd Bollinger band → fade it; exit at the moving average; volatility-targeted size (10% annual).",
             {**COMMON, "sizing": "vol", "lookback": 20, "entry": 2.0, "exit": 0.0, "stop": 3.5, "max_hold": 20},
             {"lookback": [10, 20, 50], "entry": [1.5, 2.0, 2.5], "stop": [3.0, 4.0]}, strat_d),
    Strategy("E", "Kalman filter statistical arbitrage", "pairs", "pair",
             "Time-varying intercept and hedge ratio estimated by a Kalman filter; the signal is the one-step forecast error divided by its "
             "predicted standard deviation (observation noise estimated online from past errors), so entry/exit thresholds adapt to the filter's own uncertainty.",
             {**COMMON, "delta": 1e-6, "obs_var": "auto", "entry": 2.0, "exit": 0.5, "stop": 4.0, "coint_p": 1.0, "max_hold": 30, "warmup": 60},
             {"delta": [1e-7, 1e-6, 1e-5], "entry": [1.5, 2.0, 2.5], "exit": [0.0, 0.5], "coint_p": [1.0, 0.10]}, strat_e),
    Strategy("F", "Ornstein-Uhlenbeck mean reversion", "pairs", "pair",
             "Fits an OU process to the trailing spread (AR(1) form): speed κ, long-run mean μ, equilibrium sd, half-life. Trades only when the "
             "half-life is inside [hl_min, hl_max] and the AR(1) slope is significantly below 1 (t < −2.9); maximum holding = hold_mult × half-life.",
             {**COMMON, "window": 120, "entry": 1.5, "exit": 0.25, "stop": 3.5, "hl_min": 2, "hl_max": 30, "hold_mult": 2.0},
             {"window": [60, 120, 250], "entry": [1.0, 1.5, 2.0], "hl_max": [15, 30], "hold_mult": [1.5, 3.0]}, strat_f),
    Strategy("G", "Regime switch: momentum vs mean reversion", "regime", "single",
             "Kaufman efficiency ratio decides the regime per stock: above the threshold = trending → follow L-day momentum; below = ranging → "
             "fade the L-day z-score. Diagnostics record the regime so performance can be split by regime.",
             {**COMMON, "lookback": 20, "er_window": 20, "er_threshold": 0.35, "entry": 1.5, "exit": 0.0, "stop": 3.5, "max_hold": 20},
             {"lookback": [10, 20, 50], "er_threshold": [0.25, 0.35, 0.5], "entry": [1.0, 1.5, 2.0]}, strat_g),
    Strategy("M", "Time-series momentum", "momentum", "single",
             "Vol-normalised L-day return of each stock; long above +entry, short below −entry, exit when it fades to the exit band. "
             "Benchmark for the momentum side of G.",
             {**COMMON, "lookback": 50, "entry": 1.0, "exit": 0.0, "max_hold": 40},
             {"lookback": [20, 50, 100], "entry": [0.5, 1.0, 1.5]}, strat_m),
]}


def run(key: str, closes: pd.DataFrame, opens: pd.DataFrame, params: dict | None = None) -> Output:
    s = LIBRARY[key]
    p = {**s.defaults, **(params or {})}
    return s.fn(closes, opens, p)
