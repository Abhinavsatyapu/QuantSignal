"""FastAPI service for the Quant Lab. Every page and API call sits behind the
password gate. Heavy work (backtests, comparisons, optimisation) runs as a
background job; results are stored in the database."""
from __future__ import annotations

import hashlib
import hmac
import math
import os
import secrets
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response

from . import backtest as bt
from . import engine, portfolio, scanner, stats
from .agent import Agent, leaderboard
from .data import Data, last_session, market_open
from .db import DB
from .strategies import LIBRARY

WEB = Path(__file__).resolve().parent.parent / "web"
PASSWORD = os.environ.get("QL_PASSWORD", "")
SECRET = (os.environ.get("QL_SECRET") or secrets.token_hex(32)).encode()
COOKIE = "ql_session"
MAX_AGE = 14 * 86400


def clean(o):
    """JSON-safe: NaN/inf -> None, numpy -> python, timestamps -> strings."""
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, (np.floating, float)):
        f = float(o)
        return f if math.isfinite(f) else None
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, (pd.Timestamp,)):
        return str(o.date())
    if isinstance(o, (pd.Series, pd.DataFrame)):
        return None
    return o


def create_app(db: DB | None = None, data: Data | None = None, start_agent: bool = True) -> FastAPI:
    db = db or DB()
    data = data or Data(db)
    agent = Agent(data)
    jobs: dict[str, dict] = {}
    pool = ThreadPoolExecutor(max_workers=1)
    app = FastAPI(title="QuantSignal Quant Lab", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.db, app.state.data, app.state.agent = db, data, agent

    # ------------------------------------------------------------ auth
    def sign(exp: int) -> str:
        return f"{exp}.{hmac.new(SECRET, str(exp).encode(), hashlib.sha256).hexdigest()}"

    def authed(req: Request) -> bool:
        v = req.cookies.get(COOKIE, "")
        try:
            exp, sig = v.split(".", 1)
            return int(exp) > time.time() and hmac.compare_digest(sign(int(exp)), v)
        except Exception:
            return False

    fails: dict[str, list] = {}

    @app.middleware("http")
    async def gate(req: Request, call_next):
        p = req.url.path
        if p in ("/login", "/health", "/favicon.ico") or p.startswith("/static/login"):
            return await call_next(req)
        if not authed(req):
            if p.startswith("/api/"):
                return JSONResponse({"error": "login required"}, status_code=401)
            return RedirectResponse("/login", status_code=303)
        resp = await call_next(req)
        resp.headers["X-Frame-Options"] = "SAMEORIGIN"
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "same-origin"
        return resp

    @app.get("/login", response_class=HTMLResponse)
    def login_page():
        return (WEB / "login.html").read_text()

    @app.post("/login")
    async def login(req: Request):
        ip = req.headers.get("x-forwarded-for", req.client.host if req.client else "?").split(",")[0]
        recent = [t for t in fails.get(ip, []) if time.time() - t < 600]
        if len(recent) >= 8:
            return JSONResponse({"error": "too many attempts — wait 10 minutes"}, status_code=429)
        form = await req.form()
        pw = str(form.get("password", ""))
        if not PASSWORD:
            return JSONResponse({"error": "QL_PASSWORD is not configured on the server"}, status_code=503)
        if not hmac.compare_digest(pw.encode(), PASSWORD.encode()):
            fails[ip] = recent + [time.time()]
            return JSONResponse({"error": "wrong password"}, status_code=401)
        r = JSONResponse({"ok": True})
        r.set_cookie(COOKIE, sign(int(time.time()) + MAX_AGE), max_age=MAX_AGE, httponly=True, secure=os.environ.get("QL_INSECURE") != "1", samesite="lax")
        return r

    @app.post("/logout")
    def logout():
        r = JSONResponse({"ok": True}); r.delete_cookie(COOKIE); return r

    @app.get("/favicon.ico")
    def favicon():
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#11161d"/><path d="M6 22 L13 12 L19 18 L26 9" stroke="#3987e5" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        return Response(svg, media_type="image/svg+xml")

    @app.get("/health")
    def health():
        return {"ok": True, "db": db.kind}

    # ------------------------------------------------------------ static
    @app.get("/", response_class=HTMLResponse)
    def index():
        return (WEB / "index.html").read_text()

    @app.get("/static/{name}")
    def static(name: str):
        f = (WEB / name).resolve()
        if f.parent != WEB.resolve() or not f.exists():
            raise HTTPException(404)
        return FileResponse(f, headers={"Cache-Control": "no-cache"})

    # ------------------------------------------------------------ helpers
    def settings():
        return {"risk": {**scanner.DEFAULT_RISK, **(db.kv_get("risk_limits") or {})}, "costs": {**scanner.DEFAULT_COSTS, **(db.kv_get("costs") or {})}}

    def costs_from(body):
        c = {**settings()["costs"], **(body.get("costs") or {})}
        return bt.Costs(float(c["fee_bps"]), float(c["spread_bps"]), float(c["slippage_bps"]), float(c["borrow_bps"]))

    def load_panel(symbols):
        syms = list(dict.fromkeys([s.upper().strip() for s in symbols if s] + ["SPY"]))
        for s in syms:
            if not s.replace("-", "").replace(".", "").isalnum() or len(s) > 10:
                raise HTTPException(400, f"bad symbol {s}")
        r = data.ensure(syms)
        errs = {s: v["error"] for s, v in r.items() if v["status"] == "error"}
        p = data.panel(syms)
        if not p["ok"]:
            raise RuntimeError("data unavailable — " + "; ".join(p["warnings"] + [f"{k}: {v}" for k, v in errs.items()]))
        return p

    def dates(body, panel):
        idx = panel["close"].index
        start = body.get("start") or str(idx[min(260, len(idx) - 1)].date())
        end = body.get("end") or str(idx[-1].date())
        return start, end

    def submit(kind, title, fn):
        jid = uuid.uuid4().hex[:12]
        jobs[jid] = {"id": jid, "kind": kind, "title": title, "status": "queued", "created": time.time()}

        def work():
            jobs[jid]["status"] = "running"; jobs[jid]["started"] = time.time()
            try:
                res = clean(fn())
                db.save_run(jid, kind, title, res.get("summary", {}), res)
                jobs[jid].update(status="done", result=res)
                print(f"job done: {title} · {res.get('summary', {})}", flush=True)
            except Exception as e:
                traceback.print_exc()
                jobs[jid].update(status="error", error=str(e)[:500])
                print(f"job failed: {title} · {str(e)[:300]}", flush=True)
            jobs[jid]["finished"] = time.time()
        pool.submit(work)
        return {"job": jid}

    def data_meta(panel):
        return {"status": "historical", "asof": panel.get("asof"), "warnings": panel.get("warnings", []), "sources": panel.get("info", {})}

    # ------------------------------------------------------------ status
    @app.get("/api/status")
    def status():
        ds = data.status()
        st = dict(agent.state); st["log"] = st.get("log", [])[-40:]; st["queue_len"] = len(st.pop("queue", []))
        sc = db.kv_get("latest_scan_meta") or {}
        book = db.kv_get("paper_book") or {}
        return clean({"server_time": time.time(), "market_open": market_open(), "last_session": last_session().isoformat(), "data": ds,
                      "agent": st, "scan": sc, "paper": {"equity": (book.get("equity") or [[None, None]])[-1], "positions": len(book.get("positions", [])),
                                                         "halted": book.get("halted")}, "db": db.kind})

    @app.get("/api/strategies")
    def strategies():
        return [{"key": s.key, "name": s.name, "family": s.family, "kind": s.kind, "method": s.method, "defaults": s.defaults, "grid": s.grid} for s in LIBRARY.values()]

    @app.get("/api/universe")
    def universe():
        u = data.universe.list()
        return clean({"info": db.kv_get("universe_info") or {}, "rows": u.to_dict("records")})

    @app.get("/api/settings")
    def get_settings():
        return {**settings(), "agent_enabled": agent.state.get("enabled", True)}

    @app.post("/api/settings")
    async def set_settings(req: Request):
        b = await req.json()
        if "risk" in b:
            cur = settings()["risk"]
            new = {k: float(v) for k, v in b["risk"].items() if k in scanner.DEFAULT_RISK and v is not None and v != ""}
            if any(v < 0 for v in new.values()):
                raise HTTPException(400, "limits must be non-negative")
            db.kv_set("risk_limits", {**cur, **new})
        if "costs" in b:
            cur = settings()["costs"]
            db.kv_set("costs", {**cur, **{k: float(v) for k, v in b["costs"].items() if k in scanner.DEFAULT_COSTS and v not in (None, "")}})
        if "agent_enabled" in b:
            agent.state["enabled"] = bool(b["agent_enabled"]); agent.save()
        return get_settings()

    # ------------------------------------------------------------ jobs
    @app.get("/api/jobs/{jid}")
    def job(jid: str):
        j = jobs.get(jid)
        if not j:
            r = db.run(jid)
            if r:
                return {"id": jid, "status": "done", "result": r["payload"], "kind": r["kind"], "title": r["title"]}
            raise HTTPException(404, "unknown job")
        return {k: v for k, v in j.items()}

    @app.get("/api/runs")
    def runs(kind: str | None = None, limit: int = 50):
        return db.runs(kind, min(limit, 500))

    @app.get("/api/runs/{rid}")
    def run(rid: str):
        r = db.run(rid)
        if not r:
            raise HTTPException(404)
        return r

    @app.post("/api/backtest")
    async def api_backtest(req: Request):
        b = await req.json()
        k, y, x = b["strategy"], b["y"].upper(), b["x"].upper()
        if k not in LIBRARY:
            raise HTTPException(400, "unknown strategy")

        def fn():
            p = load_panel([y, x]); s, e = dates(b, p)
            r = engine.backtest(p, k, [y, x], b.get("params"), s, e, float(b.get("capital", 100000)), costs_from(b))
            r.pop("_res"); out = r.pop("_out")
            diag = {}
            for name, ser in out.diag.items():
                if isinstance(ser, pd.Series):
                    ss = ser[(ser.index >= pd.Timestamp(s)) & (ser.index <= pd.Timestamp(e))]
                    step = max(1, len(ss) // 600)
                    diag[name] = {"dates": [str(d.date()) for d in ss.index[::step]], "values": [None if not np.isfinite(v) else round(float(v), 4) for v in ss.to_numpy(float)[::step]]}
            m = r["metrics"]
            return {**r, "diag": diag, "strategy": k, "pair": [y, x], "start": s, "end": e, "data": data_meta(p),
                    "summary": {"strategy": k, "pair": f"{y}/{x}", "sharpe": m["sharpe"], "total_return": m["total_return"], "trades": m["trades"]}}
        return submit("backtest", f"Backtest {k} {y}/{x}", fn)

    @app.post("/api/compare")
    async def api_compare(req: Request):
        b = await req.json()
        a, bb, y, x = b["a"], b["b"], b["y"].upper(), b["x"].upper()
        if a not in LIBRARY or bb not in LIBRARY:
            raise HTTPException(400, "unknown strategy")

        def fn():
            p = load_panel([y, x]); s, e = dates(b, p)
            r = engine.compare(p, a, bb, [y, x], s, e, float(b.get("capital", 100000)), costs_from(b), b.get("params_a"), b.get("params_b"),
                               bool(b.get("optimise", True)), int(b.get("train_days", 504)), int(b.get("test_days", 126)))
            v = r["verdict"]
            r["data"] = data_meta(p)
            r["summary"] = {"a": a, "b": bb, "pair": f"{y}/{x}", "winner": v["winner"], "label": v["label"],
                            "oos_sharpe_a": v.get("oos_sharpe_A"), "oos_sharpe_b": v.get("oos_sharpe_B")}
            return r
        return submit("compare", f"{a} vs {bb} on {y}/{x}", fn)

    @app.post("/api/optimize")
    async def api_optimize(req: Request):
        b = await req.json()
        k, y, x = b["strategy"], b["y"].upper(), b["x"].upper()

        def fn():
            p = load_panel([y, x]); s, e = dates(b, p)
            r = engine.optimise(p, k, [y, x], s, e, float(b.get("capital", 100000)), costs_from(b), float(b.get("is_frac", 0.7)))
            r.update(strategy=k, pair=[y, x], start=s, end=e, data=data_meta(p))
            r["summary"] = {"strategy": k, "pair": f"{y}/{x}", "selected": (r.get("selected") or {}).get("params"), "rank_corr": r.get("is_oos_rank_corr")}
            return r
        return submit("optimize", f"Optimise {k} {y}/{x}", fn)

    @app.post("/api/walkforward")
    async def api_wf(req: Request):
        b = await req.json()
        k, y, x = b["strategy"], b["y"].upper(), b["x"].upper()

        def fn():
            p = load_panel([y, x]); s, e = dates(b, p)
            r = engine.walk_forward(p, k, [y, x], s, e, float(b.get("capital", 100000)), costs_from(b), int(b.get("train_days", 504)), int(b.get("test_days", 126)))
            r.pop("oos_daily", None)
            r.update(strategy=k, pair=[y, x], start=s, end=e, data=data_meta(p))
            m = r.get("metrics") or {}
            r["summary"] = {"strategy": k, "pair": f"{y}/{x}", "oos_sharpe": m.get("sharpe"), "folds": len(r.get("folds", []))}
            return r
        return submit("walkforward", f"Walk-forward {k} {y}/{x}", fn)

    @app.post("/api/portfolio")
    async def api_portfolio(req: Request):
        b = await req.json()
        k = b.get("strategy", "A")
        scan = db.kv_get("latest_scan")
        if not scan or not scan.get("accepted"):
            raise HTTPException(409, "no accepted pairs yet — wait for the agent's first scan or run one on the Scanner page")
        n = int(b.get("n_pairs", 8))
        pairs = scan["accepted"][:n]

        def fn():
            syms = sorted({s for p in pairs for s in (p["y"], p["x"])})
            p = load_panel(syms); s, e = dates(b, p)
            risk = settings()["risk"]
            r = portfolio.build(p, pairs, k, b.get("params"), s, e, float(b.get("capital", 100000)), costs_from(b), risk, b.get("neutral", "dollar"))
            r.update(start=s, end=e, data=data_meta(p), risk=risk, scan_asof=scan.get("asof"))
            m = r.get("metrics") or {}
            r["summary"] = {"strategy": k, "pairs": len(pairs), "sharpe": m.get("sharpe"), "neutral": b.get("neutral", "dollar")}
            return r
        return submit("portfolio", f"Portfolio {k} × {len(pairs)} pairs", fn)

    @app.post("/api/scan")
    def api_scan():
        def fn():
            u = data.universe.list()
            if u.empty:
                raise RuntimeError("universe not loaded yet — the agent loads it first")
            st = settings()
            r = scanner.scan(data, u, st["risk"], st["costs"])
            db.kv_set("latest_scan", r)
            db.kv_set("latest_scan_meta", {"asof": r["asof"], "at": time.time(), "id": "manual"})
            r["summary"] = {"asof": r["asof"], "accepted": len(r["accepted"]), "candidates": r["candidates"]}
            return r
        return submit("scan", "Manual scan", fn)

    @app.get("/api/scan/latest")
    def scan_latest():
        r = db.kv_get("latest_scan")
        if not r:
            return {"empty": True, "note": "No scan yet. The agent scans once the universe's daily bars are loaded."}
        return {**r, "meta": db.kv_get("latest_scan_meta")}

    @app.get("/api/opportunities")
    def opportunities(limit: int = 8):
        r = db.kv_get("latest_scan")
        if not r:
            return {"rows": [], "note": "No scan yet."}
        risk = settings()["risk"]
        rows = [x for x in r["accepted"] if x.get("signal")][:limit]
        near = [x for x in r["accepted"] if not x.get("signal") and x.get("z60") is not None and abs(x["z60"]) >= risk["entry_z"] * 0.75][:limit]
        out = []
        for x in rows + near:
            try:
                lc = scanner.live_check(data, x, risk)
            except Exception as e:
                lc = {"error": str(e)[:200], "eligible": False, "checks": []}
            out.append({**x, "live": lc})
        return clean({"asof": r["asof"], "rows": out, "entry_z": risk["entry_z"], "market_open": market_open()})

    zcache: dict = {}

    @app.get("/api/zscan")
    def zscan(lookback: int = 20, limit: int = 40):
        if lookback not in (10, 20, 30, 50, 100):
            raise HTTPException(400, "lookback must be 10, 20, 30, 50 or 100")
        u = data.universe.list()
        if u.empty:
            return {"rows": [], "note": "universe not loaded yet"}
        asof = (db.one("SELECT MAX(last_d) FROM ql_meta WHERE status='ok'") or [None])[0]
        risk = settings()["risk"]
        key = (asof, len(u), risk["min_dollar_volume"])
        if zcache.get("key") != key:
            zcache.update(key=key, rows=_zrows(u, risk))
        rows = sorted(zcache["rows"], key=lambda r: -abs(r.get(f"z{lookback}") or 0))
        return clean({"rows": rows[:limit], "lookback": lookback, "status": "historical", "universe_liquid": len(rows)})

    def _zrows(u, risk):
        rows = []
        for s in u.symbol:
            b = data.bars(s)
            if len(b) < 105:
                continue
            lp = np.log(b["c"])
            z = {L: float(stats.zscore(lp, L).iloc[-1]) for L in (10, 20, 30, 50, 100)}
            dv = float((b["c"] * b["v"]).iloc[-20:].median())
            rows.append({"symbol": s, "last": float(b["c"].iloc[-1]), "date": str(b.index[-1].date()), "dollar_vol": dv, **{f"z{L}": v for L, v in z.items()}})
        return [r for r in rows if r["dollar_vol"] >= risk["min_dollar_volume"]]

    @app.get("/api/pair")
    def pair(y: str, x: str, window: int = 504):
        y, x = y.upper(), x.upper()
        p = load_panel([y, x])
        C = p["close"][[y, x]].iloc[-max(window, 300):]
        ly, lx = np.log(C[y]), np.log(C[x])
        eg = stats.engle_granger(ly.to_numpy(), lx.to_numpy())
        eg2 = stats.engle_granger(lx.to_numpy(), ly.to_numpy())
        jo = stats.johansen(ly.to_numpy(), lx.to_numpy())
        resid = pd.Series(eg["resid"], C.index)
        ou = stats.ou_fit(resid.to_numpy())
        z = (resid - resid.rolling(60).mean()) / resid.rolling(60).std()
        rb = stats.rolling_ols(ly, lx, 60)["beta"]
        kf = stats.kalman_beta(ly, lx, 1e-6, None)["beta"]
        corr = ly.diff().corr(lx.diff())
        f = lambda s: [None if not np.isfinite(v) else round(float(v), 5) for v in s.to_numpy(float)]
        return clean({"y": y, "x": x, "dates": [str(d.date()) for d in C.index], "norm_y": f(C[y] / C[y].iloc[0]), "norm_x": f(C[x] / C[x].iloc[0]),
                      "spread": f(resid), "z": f(z), "beta_ols": f(rb), "beta_kalman": f(kf),
                      "stats": {"eg_p": eg["p"], "eg_t": eg["t"], "eg_p_reverse": eg2["p"], "alpha": eg["alpha"], "beta": eg["beta"],
                                "johansen": jo, "ou": {k: v for k, v in ou.items()}, "hurst": stats.hurst(resid.to_numpy()),
                                "adf_p_spread": stats.adf_p(resid.to_numpy()), "corr_returns": corr, "z_now": z.iloc[-1]},
                      "data": data_meta(p)})

    @app.get("/api/leaderboard")
    def api_leaderboard():
        return clean(leaderboard(db))

    @app.get("/api/research")
    def research():
        rows = [r["summary"] for r in db.runs("research", 1000)]
        reps = db.runs("pair_report", 50)
        return clean({"results": rows, "reports": reps})

    @app.get("/api/paper")
    def paper():
        book = db.kv_get("paper_book") or {"positions": [], "closed": [], "equity": [], "cash": 100000.0, "start_cash": 100000.0}
        marks = {}
        for p in book.get("positions", []):
            for s in (p["y"], p["x"]):
                if s not in marks:
                    b = data.bars(s)
                    marks[s] = {"close": float(b["c"].iloc[-1]) if len(b) else None, "date": str(b.index[-1].date()) if len(b) else None, "status": "historical"}
                    q = data.quote(s) if market_open() else None
                    if q and q.get("price"):
                        marks[s].update(quote=q["price"], quote_status=q["status"], quote_time=q.get("provider_time"))
        return clean({**book, "marks": marks, "risk": settings()["risk"]})

    @app.post("/api/agent/tick")
    def agent_tick():
        threading.Thread(target=agent.tick, daemon=True).start()
        return {"ok": True}

    if start_agent:
        @app.on_event("startup")
        def _start():
            agent.start()
    return app


app = None
if os.environ.get("QL_NO_APP") != "1":
    app = create_app(start_agent=os.environ.get("QL_AGENT", "1") == "1")
