import time
import numpy as np, pandas as pd, pytest
from conftest import synth_panel, FakeProvider
from ql import stats, salab, backtest as bt, engine
from ql.strategies import run
from ql.db import DB
from ql.data import Data


def test_hedge_ratio_and_spread():
    x = np.linspace(10, 20, 200); y = 3 + 1.5 * x
    a, b = stats.ols_beta(y, x)
    assert a == pytest.approx(3) and b == pytest.approx(1.5)
    assert np.allclose(y - b * x, 3)


def test_zscore_definition():
    s = pd.Series(np.r_[np.zeros(29), 1.0] + np.arange(30) * 0)
    z = stats.zscore(s, 30)
    assert z.iloc[-1] == pytest.approx((1 - s.mean()) / s.std(ddof=1))


def test_adf_and_coint(panel):
    C = np.log(panel["close"])
    assert stats.adf_p((C.YYY - 1.2 * C.XXX).values) < 0.01
    assert stats.adf_p(C.RW.values) > 0.05


def test_lecture_rules_direction(panel):
    """V: long the spread (buy Y, sell X) when z < -entry, short when z > +entry."""
    C = panel["close"][["YYY", "XXX"]]
    out = run("V", C, panel["open"][["YYY", "XXX"]])
    z = out.diag["z"].to_numpy(); w = out.weights
    entries = np.where((w["YYY"].to_numpy() != 0) & (np.r_[0, w["YYY"].to_numpy()[:-1]] == 0))[0]
    assert len(entries) > 5
    for t in entries:
        if w["YYY"].iat[t] > 0:
            assert z[t] <= -1 and w["XXX"].iat[t] < 0
        else:
            assert z[t] >= 1 and w["XXX"].iat[t] > 0


def test_improved_respects_statistical_gate(panel):
    good = run("I", panel["close"][["YYY", "XXX"]], panel["open"][["YYY", "XXX"]])
    bad = run("I", panel["close"][["RW", "RW2"]], panel["open"][["RW", "RW2"]])
    trades = lambda o: int(((o.weights.iloc[:, 0] != 0) & (o.weights.iloc[:, 0].shift(1).fillna(0) == 0)).sum())
    assert trades(good) > 5 and trades(bad) < trades(good)


def test_horizon_study_and_pool(panel):
    st = salab.pair_study(panel, ["YYY", "XXX"], 1000.0, bt.Costs())
    assert set(st["horizons"]) == {"30", "60", "90", "180"}
    for h in st["horizons"].values():
        for k in salab.COMPARE:
            m = h[k]
            assert m["gross_pnl"] >= m["net_pnl"] - 1e-6        # costs only reduce P&L
    pool = salab.pooled([st, st], 1000.0)
    assert pool["by_horizon"]["180"]["I"]["pairs"] == 2


def _paper_env(tmp_path, **cfg):
    db = DB(str(tmp_path / "p.sqlite")); p = synth_panel()
    data = Data(db, providers=[FakeProvider(p)])
    data.ensure(["YYY", "XXX"])
    db.kv_set("sa_config", {**salab.DEFAULT_CONFIG, **cfg})
    return db, data, p


def test_paper_fill_pnl_and_costs(tmp_path):
    db, data, p = _paper_env(tmp_path)
    d0 = str(p["close"].index[-3].date())
    db.kv_set("sa_paper", {"cash": 1000.0, "start_cash": 1000.0, "closed": [], "equity": [], "events": [], "fees": 0.0, "slippage": 0.0, "borrow": 0.0,
                           "positions": [{"id": "t", "y": "YYY", "x": "XXX", "side": 1, "wy": 0.5, "wx": -0.5, "status": "pending_entry", "signal_date": d0, "sector": "T"}]})
    book = salab.paper_update(data, db, {"asof": str(p["close"].index[-1].date()), "accepted": []}, lambda m: None)
    pos = [q for q in book["positions"] if q["id"] == "t"][0]
    oy = p["open"]["YYY"].iloc[-2]; ox = p["open"]["XXX"].iloc[-2]
    assert pos["status"] in ("open", "pending_exit")
    assert pos["qty_y"] * oy == pytest.approx(0.5 * 300, rel=1e-6)      # 30% of 1000 gross, half per leg
    assert pos["qty_x"] < 0 and pos["fees"] > 0 and pos["slippage"] > 0
    assert book["cash"] < 1000.0 + abs(pos["qty_x"]) * ox                # paid costs


def test_paper_risk_blocks(tmp_path):
    db, data, p = _paper_env(tmp_path, max_pairs=0)
    last = str(p["close"].index[-1].date())
    book = salab.paper_update(data, db, {"asof": last, "accepted": [{"y": "YYY", "x": "XXX", "sector": "T", "min_dollar_vol": 1e9}]}, lambda m: None)
    assert not [q for q in book["positions"] if q["status"] == "pending_entry"]


def test_agent_lease_one_at_a_time(tmp_path):
    from ql.agent import Agent
    db = DB(str(tmp_path / "l.sqlite")); data = Data(db, providers=[])
    a, b = Agent(data, owner="web-1"), Agent(data, owner="github-actions")
    assert a._lease() and not b._lease()
    a.state["queue"] = [{"pair": ["Y", "X"], "strategy": "I", "scan": "d"}]; a.save(); a.release()
    assert b._lease() and b.state["queue"] == a.state["queue"]      # b continues a's queue
