"""Statistical Arbitrage Lab strategies.

V  — the lecture strategy, as taught in Quantopian's "Introduction to Pairs
     Trading" / "Integration, Cointegration and Stationarity" (Margenot & Granizo-Mackenzie):
     hedge ratio from a 30-day rolling OLS on prices, spread = Y − β·X,
     z = (1-day MA of spread − 30-day MA) / 30-day s.d.; long the spread below −1,
     short above +1, exit when z returns to 0; trade only while the pair passes a
     cointegration test (p < 0.05). One deliberate deviation: the notebook regresses
     S1 on S2 but builds the spread as S2 − β·S1; here the spread uses the same
     regression it is built from (Y on X), which is the consistent form.
K  — basic correlation (distance) pairs: Gatev-Goetzmann-Rouwenhorst style.
I  — improved adaptive statistical arbitrage (see strat_i docstring).

All signals at the close of day t use data up to t only."""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import stats
from .strategies import COMMON, Output, Strategy, _pair_output, _state_machine, _vol_alloc, rolling_coint_p


def _rolling_ols_prices(y: pd.Series, x: pd.Series, w: int) -> pd.Series:
    return stats.rolling_ols(y, x, w)["beta"]


# ---------------------------------------------------------------- V: lecture strategy
def strat_v(c: pd.DataFrame, o: pd.DataFrame, p: dict) -> Output:
    y, x = c.columns[:2]
    beta = _rolling_ols_prices(c[y], c[x], int(p["beta_window"]))
    spread = c[y] - beta * c[x]
    L = int(p["lookback"])
    z = (spread.rolling(1).mean() - spread.rolling(L).mean()) / spread.rolling(L).std(ddof=0)
    pv = rolling_coint_p(c[y], c[x], int(p["coint_window"]), log=False)
    gate = np.isfinite(pv) & (pv < float(p["coint_p"])) & (beta.to_numpy() > 0)
    side, reason = _state_machine(z.to_numpy(), gate, p["entry"], p["exit"], p.get("stop", 0), int(p.get("max_hold", 0)))
    alloc = _vol_alloc(spread.diff(), p)
    return _pair_output(c, y, x, side, reason, beta.to_numpy(), alloc,
                        {"z": z, "beta": beta, "spread": spread, "coint_p": pd.Series(pv, c.index)})


# ---------------------------------------------------------------- K: correlation / distance baseline
def strat_k(c, o, p):
    y, x = c.columns[:2]
    F, R = int(p["formation"]), int(p.get("reform", 63))
    py, px = c[y].to_numpy(float), c[x].to_numpy(float)
    n = len(c)
    z = np.full(n, np.nan); ok = np.zeros(n, bool)
    f0 = None; mu = sd = np.nan; good = False
    ry, rx = np.diff(np.log(py), prepend=np.nan), np.diff(np.log(px), prepend=np.nan)
    for t in range(F - 1, n):
        if (t - (F - 1)) % R == 0:
            f0 = t - F + 1
            sp = py[f0:t + 1] / py[f0] - px[f0:t + 1] / px[f0]
            mu, sd = sp.mean(), sp.std(ddof=1)
            cc = np.corrcoef(ry[f0 + 1:t + 1], rx[f0 + 1:t + 1])[0, 1]
            good = np.isfinite(cc) and cc >= float(p["min_corr"])
        if sd and sd > 0:
            z[t] = (py[t] / py[f0] - px[t] / px[f0] - mu) / sd
        ok[t] = good
    side, reason = _state_machine(z, ok, p["entry"], p["exit"], p.get("stop", 0), int(p.get("max_hold", 0)))
    alloc = _vol_alloc(pd.Series(np.log(py / px), c.index).diff(), p)
    dollar_neutral = py / px     # equal dollars on both legs
    return _pair_output(c, y, x, side, reason, dollar_neutral, alloc, {"z": pd.Series(z, c.index)})


# ---------------------------------------------------------------- I: improved adaptive stat-arb
def strat_i(c, o, p):
    """Improved adaptive statistical arbitrage.
      hedge     Kalman-filter hedge ratio on log prices (adapts to drift in the relationship)
      filter    trade only while, on the trailing window: Engle-Granger p < coint_p,
                ADF on the spread p < adf_p, OU half-life inside [hl_min, hl_max]
      z-score   spread vs its rolling mean/s.d. over an ADAPTIVE lookback = lb_mult × half-life (20–90)
      entry     |z| ≥ entry × volatility factor √(σ20/σ120) clipped to [0.85, 1.5]
                (enter later when the spread is unusually turbulent)
      exit      z back inside ±exit; stop at |z| ≥ stop; time stop hold_mult × half-life
      break     emergency exit when the rolling cointegration p-value rises above break_p
      cooldown  no new entry for `cooldown` sessions after any exit"""
    y, x = c.columns[:2]
    ly, lx = np.log(c[y]), np.log(c[x])
    kf = stats.kalman_beta(ly, lx, float(p["delta"]), None)
    b = kf["beta"].to_numpy()
    spread = (ly - kf["beta"] * lx).to_numpy()
    n = len(c); W = int(p["coint_window"])
    pv = rolling_coint_p(c[y], c[x], W, every=21)
    adfp = np.full(n, np.nan); hl = np.full(n, np.nan)
    lyv, lxv = ly.to_numpy(), lx.to_numpy()
    last_a = last_h = np.nan
    for t in range(W - 1, n):
        if (t - (W - 1)) % 21 == 0:
            sl = slice(t - W + 1, t + 1)
            a0, b0 = stats.ols_beta(lyv[sl], lxv[sl])
            res = lyv[sl] - a0 - b0 * lxv[sl]
            last_a = stats.adf_p(res)
            f = stats.ou_fit(res)
            last_h = f["half_life"] if f.get("ok") else np.inf
        adfp[t], hl[t] = last_a, last_h
    ds = pd.Series(spread).diff()
    volf = np.clip(np.sqrt((ds.rolling(20).std() / ds.rolling(120).std()).to_numpy()), 0.85, 1.5)
    z = np.full(n, np.nan)
    for t in range(n):
        h = hl[t]
        L = int(np.clip(round(float(p["lb_mult"]) * h), 20, 90)) if np.isfinite(h) else 40
        if t + 1 >= L:
            w = spread[t - L + 1:t + 1]
            s = w.std(ddof=1)
            if np.isfinite(s) and s > 0:
                z[t] = (spread[t] - w.mean()) / s
    ok = (np.isfinite(pv) & (pv < float(p["coint_p"])) & np.isfinite(adfp) & (adfp < float(p["adf_p"]))
          & np.isfinite(hl) & (hl >= float(p["hl_min"])) & (hl <= float(p["hl_max"])) & (b > 0))
    brk = np.isfinite(pv) & (pv > float(p["break_p"]))
    side = np.zeros(n); reason = np.array([""] * n, dtype=object)
    cur = held = mh = cool = 0
    entry_b, exit_b, stop_b = float(p["entry"]), float(p["exit"]), float(p["stop"])
    for t in range(n):
        zt = z[t]
        if cur != 0:
            held += 1
            why = ""
            if brk[t]:
                why = "breakdown"
            elif np.isfinite(zt) and abs(zt) >= stop_b:
                why = "stop"
            elif np.isfinite(zt) and ((cur > 0 and zt >= -exit_b) or (cur < 0 and zt <= exit_b)):
                why = "exit"
            elif mh and held >= mh:
                why = "time"
            if why:
                cur, held = 0, 0; reason[t] = why; cool = int(p["cooldown"])
        elif cool > 0:
            cool -= 1
        elif ok[t] and np.isfinite(zt) and np.isfinite(volf[t]):
            e = entry_b * volf[t]
            if e <= zt < stop_b:
                cur = -1
            elif -stop_b < zt <= -e:
                cur = 1
            if cur:
                held = 0; reason[t] = "entry"; mh = int(max(1, round(float(p["hold_mult"]) * hl[t])))
        side[t] = cur
    alloc = _vol_alloc(ds.set_axis(c.index), p)
    beta_px = b * c[y].to_numpy() / c[x].to_numpy()
    return _pair_output(c, y, x, side, reason, beta_px, alloc,
                        {"z": pd.Series(z, c.index), "beta": kf["beta"], "coint_p": pd.Series(pv, c.index),
                         "adf_p": pd.Series(adfp, c.index), "half_life": pd.Series(hl, c.index),
                         "entry_band": pd.Series(entry_b * volf, c.index)})


STRATS = {s.key: s for s in [
    Strategy("V", "Lecture pairs trade (Quantopian video)", "pairs", "pair",
             "As taught in the video's source notebooks: 30-day rolling OLS hedge ratio on prices, spread = Y − β·X, "
             "z = (1-day MA − 30-day MA) / 30-day s.d. of the spread. Long the spread when z < −1, short when z > +1, "
             "exit when z returns to 0. Trades only while a rolling Engle-Granger test on the last 252 sessions gives p < 0.05.",
             {**COMMON, "beta_window": 30, "lookback": 30, "entry": 1.0, "exit": 0.0, "stop": 0.0, "coint_p": 0.05, "coint_window": 252, "max_hold": 0},
             {"lookback": [20, 30, 60], "entry": [1.0, 1.5, 2.0], "exit": [0.0, 0.5]}, strat_v),
    Strategy("K", "Basic correlation (distance) pairs", "pairs", "pair",
             "Normalised prices over a 252-session formation window (re-formed every 63); trades when the gap between the two "
             "normalised prices moves more than `entry` formation s.d. from its mean and the return correlation ≥ min_corr; "
             "exits on convergence. Dollar-neutral. No cointegration test — the baseline the video argues against.",
             {**COMMON, "formation": 252, "reform": 63, "min_corr": 0.8, "entry": 2.0, "exit": 0.0, "stop": 0.0, "max_hold": 60},
             {"entry": [1.5, 2.0, 2.5], "min_corr": [0.7, 0.8], "exit": [0.0, 0.5]}, strat_k),
    Strategy("I", "Improved adaptive statistical arbitrage", "pairs", "pair",
             "Kalman hedge ratio on log prices; trades only while rolling Engle-Granger (p < 0.05) and ADF on the spread "
             "(p < 0.05) pass and the OU half-life is 2–30 sessions; z-score lookback adapts to 3 × half-life (20–90 sessions); entry ±2 scaled "
             "up in turbulent spread regimes; exit inside ±0.5; stop at ±3.5; time stop 3 × half-life; emergency exit when "
             "rolling cointegration p > 0.20; 5-session cooldown after every exit.",
             {**COMMON, "delta": 1e-8, "coint_window": 252, "coint_p": 0.05, "adf_p": 0.05, "hl_min": 2, "hl_max": 30, "lb_mult": 3.0,
              "entry": 2.0, "exit": 0.5, "stop": 3.5, "hold_mult": 3.0, "break_p": 0.20, "cooldown": 5},
             {"delta": [1e-9, 1e-8, 1e-7], "entry": [1.5, 2.0, 2.5], "lb_mult": [2.0, 4.0]}, strat_i),
]}
