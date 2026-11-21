import numpy as np, pandas as pd, pytest
from ql import backtest as bt, engine
from ql.strategies import LIBRARY, run


@pytest.mark.parametrize("key", list(LIBRARY))
def test_no_lookahead(panel, key):
    """Changing prices after day T must not change any weight up to T."""
    C, O = panel["close"][["YYY", "XXX"]], panel["open"][["YYY", "XXX"]]
    T = 1000
    w1 = run(key, C, O).weights
    C2 = C.copy(); C2.iloc[T + 1:] *= np.linspace(1.5, 0.4, len(C2) - T - 1)[:, None]
    w2 = run(key, C2, O).weights
    pd.testing.assert_frame_equal(w1.iloc[:T + 1], w2.iloc[:T + 1])


def test_execution_is_next_open():
    idx = pd.bdate_range("2024-01-01", periods=5)
    C = pd.DataFrame({"A": [10, 10, 10, 10, 10.0]}, idx); O = pd.DataFrame({"A": [10, 11, 12, 13, 14.0]}, idx)
    W = pd.DataFrame({"A": [0, 1.0, 1.0, 1.0, 1.0]}, idx)
    r = bt.run(W, O, C, [["A"]], 1000, bt.Costs(0, 0, 0, 0))
    assert r.positions["A"].iloc[1] == 0          # decided at close of day 1
    assert r.positions["A"].iloc[2] == pytest.approx(1000 / 12)   # bought at day 2 open


def test_costs_reduce_returns(panel):
    a = engine.backtest(panel, "A", ["YYY", "XXX"], None, "2021-01-01", "2025-09-30", 1e5, bt.Costs(0, 0, 0, 0))["metrics"]
    b = engine.backtest(panel, "A", ["YYY", "XXX"], None, "2021-01-01", "2025-09-30", 1e5, bt.Costs(5, 20, 10, 100))["metrics"]
    assert b["total_return"] < a["total_return"] and b["transaction_costs"] > 0


def test_leg_pnl_adds_up(panel):
    r = engine.backtest(panel, "C", ["YYY", "XXX"], None, "2021-01-01", "2025-09-30", 1e5, bt.Costs())
    res = r["_res"]
    assert res.leg_pnl.iloc[-1].sum() == pytest.approx(res.equity.iloc[-1] - 1e5, rel=1e-6, abs=1e-3)
    for t in r["trades"]:
        assert sum(t["leg_pnl"].values()) == pytest.approx(t["pnl"], abs=0.05)


def test_drawdown_halt_blocks_new_entries():
    idx = pd.bdate_range("2024-01-01", periods=8)
    C = pd.DataFrame({"A": [10, 10, 5, 5, 5, 5, 5, 5.0], "B": [10.0] * 8}, idx); O = C.shift(1).bfill()
    W = pd.DataFrame({"A": [1, 1, 1, 0, 0, 0, 0, 0.0], "B": [0, 0, 0, 0, 1, 1, 1, 1.0]}, idx)
    r = bt.run(W, O, C, [["A"], ["B"]], 1000, bt.Costs(0, 0, 0, 0), max_drawdown=0.2)
    assert r.halted is not None and (r.positions["B"] == 0).all()


def test_signals_are_traded_with_statistics(panel):
    """Strategy A only trades while cointegration is confirmed."""
    r = engine.backtest(panel, "A", ["RW", "RW2"], None, "2021-01-01", "2025-09-30", 1e5, bt.Costs())
    good = engine.backtest(panel, "A", ["YYY", "XXX"], None, "2021-01-01", "2025-09-30", 1e5, bt.Costs())
    assert r["metrics"]["trades"] < good["metrics"]["trades"]
