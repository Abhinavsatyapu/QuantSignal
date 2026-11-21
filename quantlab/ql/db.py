"""Storage: Postgres when DATABASE_URL is set (Render), SQLite otherwise (local/tests).
Tables are prefixed ql_ so they sit safely beside the portal's own tables."""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from urllib.parse import urlparse

SCHEMA = [
    "CREATE TABLE IF NOT EXISTS ql_bars (symbol TEXT NOT NULL, d TEXT NOT NULL, o REAL, h REAL, l REAL, c REAL, v REAL, src TEXT, PRIMARY KEY (symbol, d))",
    "CREATE TABLE IF NOT EXISTS ql_meta (symbol TEXT PRIMARY KEY, fetched_at REAL, src TEXT, first_d TEXT, last_d TEXT, status TEXT, error TEXT)",
    "CREATE TABLE IF NOT EXISTS ql_universe (symbol TEXT PRIMARY KEY, name TEXT, sector TEXT, groups TEXT, dollar_vol REAL, updated_at REAL)",
    "CREATE TABLE IF NOT EXISTS ql_runs (id TEXT PRIMARY KEY, kind TEXT, created_at REAL, title TEXT, summary TEXT, payload TEXT)",
    "CREATE TABLE IF NOT EXISTS ql_kv (k TEXT PRIMARY KEY, v TEXT, updated_at REAL)",
]


class DB:
    def __init__(self, url: str | None = None):
        self.url = url if url is not None else os.environ.get("DATABASE_URL", "")
        self.lock = threading.RLock()
        if self.url.startswith("postgres"):
            import psycopg
            host = urlparse(self.url).hostname or ""
            internal = "." not in host or host in ("localhost", "127.0.0.1")
            self.kind = "postgres"
            self._connect = lambda: psycopg.connect(self.url, autocommit=True, sslmode="disable" if internal else "require")
        else:
            path = self.url or os.environ.get("QL_SQLITE", "/tmp/quantlab.sqlite")
            self.kind = "sqlite"
            self._connect = lambda: sqlite3.connect(path, check_same_thread=False)
        self.conn = self._connect()
        for s in SCHEMA:
            self.exec(s)

    def _sql(self, q: str) -> str:
        return q.replace("?", "%s") if self.kind == "postgres" else q

    def exec(self, q, args=(), many=False, retry=True):
        with self.lock:
            try:
                cur = self.conn.cursor()
                if many:
                    cur.executemany(self._sql(q), args)
                else:
                    cur.execute(self._sql(q), args)
                if self.kind == "sqlite":
                    self.conn.commit()
                return cur
            except Exception as e:
                # reconnect once on a dropped Postgres connection
                if retry and self.kind == "postgres" and "closed" in str(e).lower():
                    self.conn = self._connect()
                    return self.exec(q, args, many, retry=False)
                raise

    def all(self, q, args=()):
        return self.exec(q, args).fetchall()

    def one(self, q, args=()):
        r = self.exec(q, args).fetchone()
        return r

    # ---- json helpers
    def kv_get(self, k, default=None):
        r = self.one("SELECT v FROM ql_kv WHERE k=?", (k,))
        return json.loads(r[0]) if r else default

    def kv_set(self, k, v):
        self.exec("INSERT INTO ql_kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT (k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at",
                  (k, json.dumps(v, default=str), time.time()))

    def save_run(self, rid, kind, title, summary, payload):
        self.exec("INSERT INTO ql_runs (id, kind, created_at, title, summary, payload) VALUES (?, ?, ?, ?, ?, ?) "
                  "ON CONFLICT (id) DO UPDATE SET summary=excluded.summary, payload=excluded.payload, title=excluded.title",
                  (rid, kind, time.time(), title, json.dumps(summary, default=str), json.dumps(payload, default=str)))

    def runs(self, kind=None, limit=50):
        if kind:
            rows = self.all("SELECT id, kind, created_at, title, summary FROM ql_runs WHERE kind=? ORDER BY created_at DESC LIMIT ?", (kind, limit))
        else:
            rows = self.all("SELECT id, kind, created_at, title, summary FROM ql_runs ORDER BY created_at DESC LIMIT ?", (limit,))
        return [{"id": r[0], "kind": r[1], "created_at": r[2], "title": r[3], "summary": json.loads(r[4] or "{}")} for r in rows]

    def run(self, rid):
        r = self.one("SELECT id, kind, created_at, title, summary, payload FROM ql_runs WHERE id=?", (rid,))
        if not r:
            return None
        return {"id": r[0], "kind": r[1], "created_at": r[2], "title": r[3], "summary": json.loads(r[4] or "{}"), "payload": json.loads(r[5] or "{}")}
