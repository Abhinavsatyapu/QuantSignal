import numpy as np, pandas as pd
from ql import stats


def test_engle_granger_detects_cointegration(panel):
    C = np.log(panel["close"])
    assert stats.engle_granger(C.YYY.values, C.XXX.values)["p"] < 0.01
    assert stats.engle_granger(C.RW.values, C.XXX.values)["p"] > 0.05


def test_johansen_agrees(panel):
    C = np.log(panel["close"])
    assert stats.johansen(C.YYY.values, C.XXX.values)["reject_conf"] >= 0.95
    assert stats.johansen(C.RW.values, C.RW2.values)["reject_conf"] < 0.95


def test_ou_half_life_close_to_truth():
    rng = np.random.default_rng(3); phi = 0.9; s = np.zeros(5000)
    for t in range(1, 5000):
        s[t] = phi * s[t - 1] + rng.normal(0, 0.01)
    f = stats.ou_fit(s)
    assert f["ok"] and abs(f["half_life"] - np.log(2) / -np.log(phi)) < 1.0


def test_ou_rejects_random_walk():
    s = np.cumsum(np.random.default_rng(4).normal(0, 1, 3000))
    f = stats.ou_fit(s)
    assert (not f["ok"]) or f["half_life"] > 100 or f["t"] > -2.9


def test_hurst_orders_processes():
    rng = np.random.default_rng(5)
    mr = np.zeros(3000)
    for t in range(1, 3000):
        mr[t] = 0.5 * mr[t - 1] + rng.normal()
    assert stats.hurst(mr) < stats.hurst(np.cumsum(rng.normal(size=3000)))


def test_kalman_tracks_beta(panel):
    C = np.log(panel["close"])
    k = stats.kalman_beta(C.YYY, C.XXX, 1e-6, None)
    assert abs(k["beta"].iloc[-200:].mean() - 1.2) < 0.25


def test_rolling_ols_uses_only_past():
    y = pd.Series(np.arange(100.0)); x = pd.Series(np.arange(100.0) * 0.5)
    a = stats.rolling_ols(y, x, 20)["beta"]
    y2 = y.copy(); y2.iloc[60:] *= 3
    b = stats.rolling_ols(y2, x, 20)["beta"]
    assert np.allclose(a.iloc[:60].dropna(), b.iloc[:60].dropna())


def test_bootstrap_pvalue():
    rng = np.random.default_rng(1)
    assert stats.block_bootstrap_pvalue(rng.normal(0.002, 0.01, 1000)) < 0.05
    assert stats.block_bootstrap_pvalue(rng.normal(0.0, 0.01, 1000)) > 0.05
