from ql import backtest as bt, engine


def test_compare_structure_and_honest_verdict(panel):
    r = engine.compare(panel, "C", "B", ["YYY", "XXX"], "2020-06-01", "2025-09-30", 1e5, bt.Costs())
    v = r["verdict"]
    assert set(r["oos"]) == {"A", "B"} and "recommendation" in r["report"]
    assert r["oos"]["A"]["folds"][0]["test"] == r["oos"]["B"]["folds"][0]["test"]   # same folds
    assert (v["winner"] is None) == ("no winner" in v["label"].lower() or "no verdict" in v["label"].lower())


def test_no_winner_on_noise(panel):
    r = engine.compare(panel, "A", "E", ["RW", "RW2"], "2020-06-01", "2025-09-30", 1e5, bt.Costs())
    assert r["verdict"]["winner"] is None and r["verdict"]["why"]


def test_walk_forward_params_from_train_only(panel):
    wf = engine.walk_forward(panel, "F", ["YYY", "XXX"], "2020-06-01", "2025-09-30", 1e5, bt.Costs(), 504, 126, max_combos=6)
    assert wf["ok"] and len(wf["folds"]) >= 3
    for f in wf["folds"]:
        assert f["train"][1] < f["test"][0]


def test_optimiser_reports_overfit_diagnostics(panel):
    o = engine.optimise(panel, "B", ["YYY", "XXX"], "2020-06-01", "2025-09-30", 1e5, bt.Costs(), max_combos=12)
    assert o["ok"] and "is_oos_rank_corr" in o and o["selected"]["params"]
