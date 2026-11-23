"""Runs the scanner and every read endpoint against a real Postgres when
QL_TEST_PG is set (e.g. postgres://postgres@127.0.0.1:5433/postgres)."""
import os, time
import pandas as pd, pytest
from conftest import synth_panel, FakeProvider

PG = os.environ.get("QL_TEST_PG")


@pytest.mark.skipif(not PG, reason="QL_TEST_PG not set")
def test_postgres_paths():
    from ql.db import DB; from ql.data import Data; from ql import scanner
    import ql.app as A
    from fastapi.testclient import TestClient
    db = DB(PG)
    for t in ("ql_bars", "ql_meta", "ql_kv", "ql_universe", "ql_runs"):
        db.exec(f"DELETE FROM {t}")
    p = synth_panel(); data = Data(db, providers=[FakeProvider(p)])
    data.ensure(["YYY", "XXX", "RW", "RW2", "SPY"]); db.kv_set("div:YYY", [["2024-01-05", 0.1]])
    u = pd.DataFrame({"symbol": ["YYY", "XXX", "RW", "RW2"], "sector": "T", "dollar_vol": 1e9})
    assert scanner.scan(data, u, scanner.DEFAULT_RISK, scanner.DEFAULT_COSTS)["accepted"]
    db.exec("INSERT INTO ql_universe (symbol,name,sector,groups,dollar_vol,updated_at) VALUES (?,?,?,?,?,?)",
            [(s, s, "T", "T", 1e9, time.time()) for s in ["YYY", "XXX", "RW", "RW2", "SPY"]], many=True)
    db.kv_set("universe_info", {"updated_at": time.time()})
    os.environ["QL_INSECURE"] = "1"; A.PASSWORD = "x"
    app = A.create_app(db, data, start_agent=False); c = TestClient(app); c.post("/login", data={"password": "x"})
    for _ in range(4):
        app.state.agent.tick()
    for path in ["/api/status", "/api/universe", "/api/scan/latest", "/api/opportunities", "/api/zscan", "/api/pair?y=YYY&x=XXX", "/api/leaderboard",
                 "/api/research", "/api/paper", "/api/sa/summary", "/api/sa/paper", "/api/sa/live", "/api/sa/monitor?y=YYY&x=XXX"]:
        assert c.get(path).status_code == 200, path
