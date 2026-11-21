"""Statistical building blocks. Every function looks only at the data it is given,
so callers control the information set (no look-ahead happens in here)."""
from __future__ import annotations

import math
import numpy as np
import pandas as pd
from statsmodels.tsa.stattools import adfuller, coint
from statsmodels.tsa.vector_ar.vecm import coint_johansen


def ols_beta(y: np.ndarray, x: np.ndarray) -> tuple[float, float]:
    """OLS y = a + b x. Returns (a, b)."""
    x = np.asarray(x, float); y = np.asarray(y, float)
    xm, ym = x.mean(), y.mean()
    vx = ((x - xm) ** 2).sum()
    if vx <= 0:
        return float("nan"), float("nan")
    b = ((x - xm) * (y - ym)).sum() / vx
    return float(ym - b * xm), float(b)


def rolling_ols(y: pd.Series, x: pd.Series, window: int) -> pd.DataFrame:
    """Rolling OLS hedge ratio using the trailing `window` bars INCLUDING bar t
    (value at t is known at the close of t)."""
    mx = x.rolling(window).mean(); my = y.rolling(window).mean()
    cov = (x * y).rolling(window).mean() - mx * my
    var = (x * x).rolling(window).mean() - mx * mx
    b = cov / var.replace(0, np.nan)
    a = my - b * mx
    return pd.DataFrame({"alpha": a, "beta": b})


def kalman_beta(y: pd.Series, x: pd.Series, delta: float = 1e-4, r: float | None = None, lam: float = 0.97) -> pd.DataFrame:
    """Kalman filter for y_t = a_t + b_t x_t + e_t with random-walk state.
    The state at t uses observations up to and including t. `err` is the
    one-step-ahead forecast error (made BEFORE seeing y_t) and `var` its predicted
    variance. If r is None the observation noise is estimated online from past
    innovations (EWMA), so the z-score err/sqrt(var) adapts to the pair."""
    n = len(y)
    yv = y.to_numpy(float); xv = x.to_numpy(float)
    theta = np.array([0.0, 1.0]); P = np.eye(2)
    Vw = delta / (1 - delta) * np.eye(2)
    rr = r if r is not None else 1e-4
    e2 = None
    out = np.full((n, 4), np.nan)
    for t in range(n):
        F = np.array([1.0, xv[t]])
        R = P + Vw
        yhat = F @ theta
        frf = F @ R @ F
        Q = frf + rr
        e = yv[t] - yhat
        out[t] = (np.nan, np.nan, e, Q)
        K = R @ F / Q
        theta = theta + K * e
        P = R - np.outer(K, F) @ R
        out[t, 0], out[t, 1] = theta
        if r is None:   # update observation-noise estimate AFTER using it (no look-ahead)
            e2 = e * e if e2 is None else lam * e2 + (1 - lam) * e * e
            rr = max(e2 - frf, 1e-8)
    return pd.DataFrame(out, index=y.index, columns=["alpha", "beta", "err", "var"])


def zscore(s: pd.Series, window: int) -> pd.Series:
    m = s.rolling(window).mean(); sd = s.rolling(window).std(ddof=1)
    return (s - m) / sd.replace(0, np.nan)


def adf_p(series: np.ndarray) -> float:
    s = np.asarray(series, float)
    s = s[np.isfinite(s)]
    if len(s) < 30 or np.std(s) == 0:
        return float("nan")
    try:
        return float(adfuller(s, autolag="AIC")[1])  # noqa
    except Exception:
        return float("nan")


def engle_granger(y: np.ndarray, x: np.ndarray) -> dict:
    """Engle-Granger two-step test (MacKinnon p-values via statsmodels)."""
    y = np.asarray(y, float); x = np.asarray(x, float)
    a, b = ols_beta(y, x)
    try:
        t, p, _ = coint(y, x, trend="c", autolag="AIC")
    except Exception:
        t, p = float("nan"), float("nan")
    resid = y - a - b * x
    return {"t": float(t), "p": float(p), "alpha": a, "beta": b, "resid": resid}


def eg_fast_p(y: np.ndarray, x: np.ndarray) -> float:
    """Engle-Granger p-value with a fixed lag of 1 (faster; used for rolling gates)."""
    try:
        return float(coint(y, x, trend="c", maxlag=1, autolag=None)[1])
    except Exception:
        return float("nan")


def johansen(y: np.ndarray, x: np.ndarray, k_ar_diff: int = 1) -> dict:
    """Johansen trace test, r=0 vs r>=1. Returns trace stat, 90/95/99% crit and
    the highest confidence level at which r=0 is rejected (0 if none)."""
    data = np.column_stack([np.asarray(y, float), np.asarray(x, float)])
    try:
        res = coint_johansen(data, det_order=0, k_ar_diff=k_ar_diff)
        tr = float(res.lr1[0]); cv = [float(c) for c in res.cvt[0]]
        conf = 0.99 if tr > cv[2] else 0.95 if tr > cv[1] else 0.90 if tr > cv[0] else 0.0
        vec = res.evec[:, 0]
        vec = np.real(vec); hedge = float(-vec[1] / vec[0]) if vec[0] != 0 else float("nan")
        return {"trace": tr, "crit90": cv[0], "crit95": cv[1], "crit99": cv[2], "reject_conf": conf, "beta": hedge}
    except Exception:
        return {"trace": float("nan"), "crit90": float("nan"), "crit95": float("nan"), "crit99": float("nan"), "reject_conf": 0.0, "beta": float("nan")}


def ou_fit(spread: np.ndarray, dt: float = 1.0) -> dict:
    """Fit an Ornstein-Uhlenbeck process by exact AR(1) regression:
    s_{t+1} = c + phi s_t + eps. kappa = -ln(phi)/dt, mu = c/(1-phi),
    sigma_eq = sd(eps)/sqrt(1-phi^2), half-life = ln2/kappa (in bars).
    Also returns the slope t-stat and R^2 so unreliable fits can be rejected."""
    s = np.asarray(spread, float); s = s[np.isfinite(s)]
    if len(s) < 30:
        return {"ok": False, "reason": "fewer than 30 observations"}
    x, y = s[:-1], s[1:]
    c, phi = ols_beta(y, x)
    resid = y - c - phi * x
    n = len(x)
    sxx = ((x - x.mean()) ** 2).sum()
    se_phi = math.sqrt((resid ** 2).sum() / max(n - 2, 1) / sxx) if sxx > 0 else float("nan")
    t_phi = (phi - 1) / se_phi if se_phi and se_phi > 0 else float("nan")
    if not (0 < phi < 1):
        return {"ok": False, "phi": phi, "t": t_phi, "reason": "AR(1) coefficient outside (0,1): no mean reversion"}
    kappa = -math.log(phi) / dt
    mu = c / (1 - phi)
    sd = float(np.std(resid, ddof=2))
    sig_eq = sd / math.sqrt(1 - phi * phi)
    return {"ok": True, "phi": phi, "kappa": kappa, "mu": mu, "sigma": sd * math.sqrt(2 * kappa / (1 - phi * phi)),
            "sigma_eq": sig_eq, "half_life": math.log(2) / kappa, "t": t_phi}


def half_life(spread: np.ndarray) -> float:
    f = ou_fit(spread)
    return float(f["half_life"]) if f.get("ok") else float("inf")


def hurst(series: np.ndarray, max_lag: int = 50) -> float:
    s = np.asarray(series, float); s = s[np.isfinite(s)]
    if len(s) < max_lag * 2:
        return float("nan")
    lags = np.arange(2, max_lag)
    tau = np.array([np.std(s[l:] - s[:-l]) for l in lags])
    ok = tau > 0
    if ok.sum() < 5:
        return float("nan")
    return float(np.polyfit(np.log(lags[ok]), np.log(tau[ok]), 1)[0])


def efficiency_ratio(close: pd.Series, n: int = 20) -> pd.Series:
    """Kaufman efficiency ratio: |net move| / sum |moves|. ~1 = trending, ~0 = ranging."""
    net = (close - close.shift(n)).abs()
    path = close.diff().abs().rolling(n).sum()
    return net / path.replace(0, np.nan)


def norm_cdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def sharpe_pvalue(daily: np.ndarray) -> float:
    """One-sided p-value that the true Sharpe <= 0 (Lo 2002, iid approximation)."""
    r = np.asarray(daily, float); r = r[np.isfinite(r)]
    n = len(r)
    if n < 20 or r.std(ddof=1) == 0:
        return float("nan")
    sr = r.mean() / r.std(ddof=1)
    se = math.sqrt((1 + 0.5 * sr * sr) / n)
    return 1 - norm_cdf(sr / se)


def deflated_sharpe(daily: np.ndarray, n_trials: int, sr_var_trials: float) -> float:
    """Bailey & Lopez de Prado deflated Sharpe ratio: probability that the observed
    (per-period) Sharpe beats the max Sharpe expected from n_trials of pure noise."""
    from scipy.stats import kurtosis, skew
    r = np.asarray(daily, float); r = r[np.isfinite(r)]
    n = len(r)
    if n < 30 or r.std(ddof=1) == 0 or n_trials < 1:
        return float("nan")
    sr = r.mean() / r.std(ddof=1)
    g = 0.5772156649
    from scipy.stats import norm
    if n_trials > 1 and sr_var_trials > 0:
        sr0 = math.sqrt(sr_var_trials) * ((1 - g) * norm.ppf(1 - 1 / n_trials) + g * norm.ppf(1 - 1 / (n_trials * math.e)))
    else:
        sr0 = 0.0
    sk = float(skew(r)); ku = float(kurtosis(r, fisher=False))
    den = math.sqrt(max(1e-12, 1 - sk * sr + (ku - 1) / 4 * sr * sr))
    return float(norm.cdf((sr - sr0) * math.sqrt(n - 1) / den))


def block_bootstrap_pvalue(diff: np.ndarray, block: int = 10, n_boot: int = 2000, seed: int = 7) -> float:
    """Stationary-style moving-block bootstrap, one-sided p-value that mean(diff) <= 0.
    Used to test whether A's daily returns beat B's on the same days."""
    d = np.asarray(diff, float); d = d[np.isfinite(d)]
    n = len(d)
    if n < 40:
        return float("nan")
    rng = np.random.default_rng(seed)
    obs = d.mean()
    centered = d - obs
    nb = int(math.ceil(n / block))
    starts = rng.integers(0, n - block + 1, size=(n_boot, nb))
    idx = (starts[:, :, None] + np.arange(block)[None, None, :]).reshape(n_boot, -1)[:, :n]
    means = centered[idx].mean(axis=1)
    return float((means >= obs).mean())
