import os, time
import pytest
from fastapi.testclient import TestClient
from conftest import synth_panel, FakeProvider


@pytest.fixture
def client(tmp_path, monkeypatch):
    import ql.app as appmod
    from ql.db import DB
    from ql.data import Data
    monkeypatch.setattr(appmod, "PASSWORD", "test-pass")
    db = DB(str(tmp_path / "t.sqlite"))
    p = synth_panel()
    data = Data(db, providers=[FakeProvider(p, fail={"BAD"})])
    db.exec("INSERT INTO ql_universe (symbol, name, sector, groups, dollar_vol, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            [(s, s, "Test", "Test", 1e9, time.time()) for s in ["YYY", "XXX", "RW", "RW2", "SPY"]], many=True)
    db.kv_set("universe_info", {"updated_at": time.time(), "total": 5})
    os.environ["QL_INSECURE"] = "1"
    app = appmod.create_app(db, data, start_agent=False)
    return TestClient(app), app


def login(c):
    assert c.post("/login", data={"password": "test-pass"}).status_code == 200


def test_gate(client):
    c, _ = client
    assert c.get("/api/status").status_code == 401
    assert c.get("/", follow_redirects=False).status_code == 303
    assert c.post("/login", data={"password": "nope"}).status_code == 401
    login(c)
    assert c.get("/api/status").status_code == 200


def _wait(c, jid):
    for _ in range(300):
        j = c.get(f"/api/jobs/{jid}").json()
        if j["status"] in ("done", "error"):
            return j
        time.sleep(0.2)
    raise AssertionError("job timeout")


def test_backtest_and_compare_jobs(client):
    c, _ = client; login(c)
    j = _wait(c, c.post("/api/backtest", json={"strategy": "A", "y": "YYY", "x": "XXX"}).json()["job"])
    assert j["status"] == "done", j.get("error")
    r = j["result"]
    assert r["data"]["status"] == "historical" and r["data"]["sources"]["YYY"]["source"] == "Test provider"
    j = _wait(c, c.post("/api/compare", json={"a": "A", "b": "B", "y": "YYY", "x": "XXX", "optimise": False}).json()["job"])
    assert j["status"] == "done", j.get("error")
    assert c.get("/api/runs?kind=compare").json()


def test_missing_data_is_an_error_not_a_substitute(client):
    c, _ = client; login(c)
    j = _wait(c, c.post("/api/backtest", json={"strategy": "A", "y": "BAD", "x": "XXX"}).json()["job"])
    assert j["status"] == "error" and "unavailable" in j["error"]


def test_agent_scan_and_research(client):
    c, app = client; login(c)
    ag = app.state.agent
    for _ in range(6):
        ag.tick()
    sc = c.get("/api/scan/latest").json()
    assert not sc.get("empty")
    assert any(r["y"] in ("YYY", "XXX") and r["x"] in ("YYY", "XXX") for r in sc["accepted"])
    assert all(r["reasons"] for r in sc["rejected"])
    ag.state["queue"] = ag.state["queue"][:2]
    ag.tick(); ag.tick()
    assert c.get("/api/research").json()["results"]
    lb = c.get("/api/leaderboard").json()
    assert lb["strategies"]
    for path in ["/api/strategies", "/api/universe", "/api/settings", "/api/paper", "/api/zscan", "/api/pair?y=YYY&x=XXX", "/api/opportunities"]:
        assert c.get(path).status_code == 200, path


def test_settings_validation(client):
    c, _ = client; login(c)
    assert c.post("/api/settings", json={"risk": {"max_gross": -1}}).status_code == 400
    r = c.post("/api/settings", json={"risk": {"max_gross": 1.5}}).json()
    assert r["risk"]["max_gross"] == 1.5
