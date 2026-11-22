"""Run the research agent to completion once, without the web server.
Used by the scheduled GitHub Actions job so the Quant Lab keeps working on
Render's free plan while nobody has the page open.

    DATABASE_URL=... python -m ql.daily --minutes 45
"""
from __future__ import annotations

import argparse
import os
import sys
import time

os.environ.setdefault("QL_NO_APP", "1")

from .agent import Agent  # noqa: E402
from .data import Data  # noqa: E402
from .db import DB  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=float, default=45)
    a = ap.parse_args()
    if not os.environ.get("DATABASE_URL", "").startswith("postgres"):
        print("DATABASE_URL (Postgres) is not set — refusing to run against a throwaway database", file=sys.stderr)
        return 2
    db = DB()
    agent = Agent(Data(db), owner="github-actions")
    deadline = time.time() + a.minutes * 60
    idle = 0
    while time.time() < deadline:
        agent.tick()
        agent.state["last_tick"] = time.time()
        if agent.holding:
            agent.save()
        if agent.state.get("phase") in ("idle", "busy-elsewhere"):
            idle += 1
            if idle >= 2:
                break
            time.sleep(30)
        else:
            idle = 0
    print(f"daily run finished: phase={agent.state.get('phase')} · {len(agent.state.get('queue', []))} research items left · {agent.state.get('message')}")
    agent.release()
    return 0


if __name__ == "__main__":
    sys.exit(main())
