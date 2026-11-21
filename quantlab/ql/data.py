"""Data ingestion. Providers are swappable: each returns raw daily OHLCV with a
source label. Bars are cached in the database; dividends are applied as a
backward adjustment so returns include them (total-return prices).

Status vocabulary used everywhere in the UI:
  historical  end-of-day bars (the backtests and scans run on these)
  delayed     an intraday quote the provider marks as not real-time
  live        an intraday quote the provider marks as real-time
  unavailable the provider failed; nothing is substituted"""
from __future__ import annotations

import datetime as dt
import io
import re
import time
from concurrent.futures import ThreadPoolExecutor
from zoneinfo import ZoneInfo

import httpx
import numpy as np
import pandas as pd

from .db import DB

NY = ZoneInfo("America/New_York")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
WIKI_UA = "QuantSignalQuantLab/1.0 (research; https://quantsignal-portal.onrender.com)"

ETFS = ["SPY", "QQQ", "IWM", "DIA", "MDY", "XLF", "XLE", "XLK", "XLV", "XLY", "XLP", "XLI", "XLU", "XLB", "XLRE", "XLC",
        "SMH", "SOXX", "KRE", "KBE", "XBI", "IBB", "XOP", "OIH", "GDX", "GDXJ", "GLD", "SLV", "USO", "TLT", "IEF", "SHY",
        "HYG", "LQD", "EEM", "EFA", "FXI", "EWJ", "EWZ", "VNQ", "XHB", "ITB", "XRT", "IYR", "VTI", "VOO", "RSP", "ARKK", "TAN", "JETS"]


def _num(s):
    if s is None:
        return np.nan
    s = re.sub(r"[$,%\s]", "", str(s))
    try:
        return float(s)
    except ValueError:
        return np.nan


def last_session(now: dt.datetime | None = None) -> dt.date:
    """Most recent US session whose daily bar should be final (after 16:15 ET)."""
    now = (now or dt.datetime.now(NY)).astimezone(NY)
    d = now.date()
    if now.hour < 16 or (now.hour == 16 and now.minute < 15):
        d -= dt.timedelta(days=1)
    while d.weekday() >= 5:
        d -= dt.timedelta(days=1)
    return d


def market_open(now: dt.datetime | None = None) -> bool:
    now = (now or dt.datetime.now(NY)).astimezone(NY)
    if now.weekday() >= 5:
        return False
    m = now.hour * 60 + now.minute
    return 570 <= m < 960


class Nasdaq:
    name = "Nasdaq historical"

    def __init__(self, client: httpx.Client):
        self.c = client

    def _get(self, url):
        r = self.c.get(url, headers={"User-Agent": UA, "Accept": "application/json"}, timeout=25)
        if r.status_code == 429:
            raise RuntimeError("Nasdaq 429 rate limit")
        r.raise_for_status()
        return r.json()

    @staticmethod
    def _sym(s):
        return s.replace("-", ".")

    def history(self, symbol: str, start: dt.date) -> pd.DataFrame:
        classes = ["etf", "stocks"] if symbol in ETFS else ["stocks", "etf"]
        last_err = None
        for asset in classes:
            try:
                j = self._get(f"https://api.nasdaq.com/api/quote/{self._sym(symbol)}/historical?assetclass={asset}"
                              f"&fromdate={start.isoformat()}&todate={dt.date.today().isoformat()}&limit=9999")
                rows = (((j or {}).get("data") or {}).get("tradesTable") or {}).get("rows") or []
                recs = []
                for r in rows:
                    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", str(r.get("date", "")))
                    c = _num(r.get("close"))
                    if not m or not c > 0:
                        continue
                    recs.append((f"{m[3]}-{int(m[1]):02d}-{int(m[2]):02d}", _num(r.get("open")), _num(r.get("high")), _num(r.get("low")), c, _num(r.get("volume"))))
                if len(recs) >= 5:
                    df = pd.DataFrame(recs, columns=["d", "o", "h", "l", "c", "v"]).drop_duplicates("d").sort_values("d")
                    for k in ("o", "h", "l"):
                        df[k] = df[k].where(df[k] > 0, df["c"])
                    return df
                last_err = RuntimeError(f"{asset}: empty history")
            except Exception as e:
                last_err = e
        raise last_err or RuntimeError("no history")

    def dividends(self, symbol: str) -> list[tuple[str, float]]:
        classes = ["etf", "stocks"] if symbol in ETFS else ["stocks", "etf"]
        for asset in classes:
            try:
                j = self._get(f"https://api.nasdaq.com/api/quote/{self._sym(symbol)}/dividends?assetclass={asset}")
                rows = ((((j or {}).get("data") or {}).get("dividends") or {}).get("rows")) or []
                out = []
                for r in rows:
                    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", str(r.get("exOrEffDate", "")))
                    a = _num(r.get("amount"))
                    if m and a > 0:
                        out.append((f"{m[3]}-{int(m[1]):02d}-{int(m[2]):02d}", a))
                return out
            except Exception:
                continue
        return []

    def quote(self, symbol: str) -> dict:
        classes = ["etf", "stocks"] if symbol in ETFS else ["stocks", "etf"]
        last_err = None
        for asset in classes:
            try:
                j = self._get(f"https://api.nasdaq.com/api/quote/{self._sym(symbol)}/info?assetclass={asset}")
                p = ((j or {}).get("data") or {}).get("primaryData") or {}
                last = _num(p.get("lastSalePrice"))
                if not last > 0:
                    raise RuntimeError("empty quote")
                rt = bool(p.get("isRealTime"))
                status = ("live" if rt else "delayed") if market_open() else "closed"
                return {"symbol": symbol, "price": last, "bid": _num(p.get("bidPrice")), "ask": _num(p.get("askPrice")),
                        "status": status, "provider_time": p.get("lastTradeTimestamp"), "source": "Nasdaq quote",
                        "fetched_at": time.time()}
            except Exception as e:
                last_err = e
        raise last_err or RuntimeError("quote failed")

    def screener(self) -> pd.DataFrame:
        j = self._get("https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true")
        rows = ((j or {}).get("data") or {}).get("rows") or []
        df = pd.DataFrame(rows)
        if df.empty:
            raise RuntimeError("screener empty")
        df["price"] = df["lastsale"].map(_num); df["volume"] = df["volume"].map(_num); df["mcap"] = df["marketCap"].map(_num)
        df["dollar_vol"] = df["price"] * df["volume"]
        return df[["symbol", "name", "sector", "industry", "price", "volume", "mcap", "dollar_vol"]]


class Yahoo:
    """Fallback. Yahoo usually refuses cloud servers; failures are reported, never hidden."""
    name = "Yahoo chart v8"

    def __init__(self, client: httpx.Client):
        self.c = client

    def history(self, symbol: str, start: dt.date) -> pd.DataFrame:
        p1 = int(dt.datetime.combine(start, dt.time()).timestamp())
        r = self.c.get(f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?period1={p1}&period2={int(time.time())}&interval=1d&events=div",
                       headers={"User-Agent": UA}, timeout=20)
        r.raise_for_status()
        res = r.json()["chart"]["result"][0]
        q = res["indicators"]["quote"][0]
        df = pd.DataFrame({"d": [dt.datetime.fromtimestamp(t, NY).date().isoformat() for t in res["timestamp"]],
                           "o": q["open"], "h": q["high"], "l": q["low"], "c": q["close"], "v": q["volume"]}).dropna(subset=["c"])
        return df.drop_duplicates("d", keep="last")

    def dividends(self, symbol: str):
        return []


class Universe:
    def __init__(self, db: DB, client: httpx.Client):
        self.db, self.c = db, client

    def _wiki(self, url, sym_cols, sector_col=None):
        r = self.c.get(url, headers={"User-Agent": WIKI_UA}, timeout=25)
        r.raise_for_status()
        for t in pd.read_html(io.StringIO(r.text)):
            cols = [str(c) for c in t.columns]
            sc = next((c for c in sym_cols if c in cols), None)
            if sc and len(t) > 80:
                out = pd.DataFrame({"symbol": t[sc].astype(str).str.replace(".", "-", regex=False).str.strip()})
                out["sector"] = t[sector_col].astype(str) if sector_col and sector_col in cols else None
                name_col = next((c for c in ("Security", "Company") if c in cols), None)
                out["name"] = t[name_col].astype(str) if name_col else ""
                return out
        raise RuntimeError("constituent table not found")

    def refresh(self, nasdaq: Nasdaq, top_liquid: int = 100) -> dict:
        info = {"sp500": 0, "ndx": 0, "etf": len(ETFS), "liquid": 0, "errors": []}
        groups: dict[str, set] = {}
        meta: dict[str, dict] = {}
        try:
            sp = self._wiki("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies", ["Symbol"], "GICS Sector")
            for _, r in sp.iterrows():
                groups.setdefault(r.symbol, set()).add("S&P 500"); meta[r.symbol] = {"name": r["name"], "sector": r.sector}
            info["sp500"] = len(sp)
        except Exception as e:
            info["errors"].append(f"S&P 500 list: {e}")
        try:
            nd = self._wiki("https://en.wikipedia.org/wiki/Nasdaq-100", ["Ticker", "Symbol"], "GICS Sector")
            for _, r in nd.iterrows():
                groups.setdefault(r.symbol, set()).add("Nasdaq 100")
                meta.setdefault(r.symbol, {"name": r["name"], "sector": r.sector if r.sector and r.sector != "None" else None})
            info["ndx"] = len(nd)
        except Exception as e:
            info["errors"].append(f"Nasdaq-100 list: {e}")
        dv = {}
        try:
            sc = nasdaq.screener()
            sc = sc[~sc["symbol"].str.contains(r"[\^/]", regex=True)]
            dv = dict(zip(sc.symbol.str.replace("/", "-"), sc.dollar_vol))
            sec = dict(zip(sc.symbol, sc.sector))
            for s, m in meta.items():
                if not m.get("sector"):
                    m["sector"] = sec.get(s) or "Unknown"
            liquid = sc[(sc.price > 5)].sort_values("dollar_vol", ascending=False).head(top_liquid)
            for _, r in liquid.iterrows():
                groups.setdefault(r.symbol, set()).add("High volume")
                meta.setdefault(r.symbol, {"name": r["name"], "sector": r.sector or "Unknown"})
            info["liquid"] = len(liquid)
        except Exception as e:
            info["errors"].append(f"Nasdaq screener: {e}")
        for s in ETFS:
            groups.setdefault(s, set()).add("ETF"); meta.setdefault(s, {"name": s, "sector": "ETF"})
            meta[s]["sector"] = "ETF"
        if info["sp500"] == 0 and info["ndx"] == 0 and info["liquid"] == 0:
            info["kept_previous"] = True
            return info          # keep the previous universe rather than shrinking to ETFs only
        now = time.time()
        self.db.exec("DELETE FROM ql_universe")
        self.db.exec("INSERT INTO ql_universe (symbol, name, sector, groups, dollar_vol, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                     [(s, meta[s].get("name"), meta[s].get("sector"), ",".join(sorted(g)), _f(dv.get(s)), now) for s, g in groups.items()], many=True)
        info["total"] = len(groups)
        self.db.kv_set("universe_info", {**info, "updated_at": now})
        return info

    def list(self) -> pd.DataFrame:
        rows = self.db.all("SELECT symbol, name, sector, groups, dollar_vol, updated_at FROM ql_universe")
        return pd.DataFrame(rows, columns=["symbol", "name", "sector", "groups", "dollar_vol", "updated_at"])


def _f(x):
    try:
        x = float(x)
        return x if np.isfinite(x) else None
    except (TypeError, ValueError):
        return None


class Data:
    YEARS = 6

    def __init__(self, db: DB, providers=None, client: httpx.Client | None = None):
        self.db = db
        self.client = client or httpx.Client(follow_redirects=True)
        self.providers = providers if providers is not None else [Nasdaq(self.client), Yahoo(self.client)]
        self.universe = Universe(db, self.client)
        self._quotes: dict[str, dict] = {}

    @property
    def nasdaq(self):
        return next((p for p in self.providers if isinstance(p, Nasdaq)), None)

    def _meta(self, s):
        r = self.db.one("SELECT fetched_at, src, first_d, last_d, status, error FROM ql_meta WHERE symbol=?", (s,))
        return dict(zip(["fetched_at", "src", "first_d", "last_d", "status", "error"], r)) if r else None

    def ensure(self, symbols: list[str], force: bool = False, workers: int = 4) -> dict:
        """Make sure each symbol has bars up to the last completed session.
        Fetches only what is missing; returns per-symbol status."""
        target = last_session().isoformat()
        todo = []
        for s in symbols:
            m = self._meta(s)
            fresh = m and m["status"] == "ok" and m["last_d"] and m["last_d"] >= target
            recently_failed = m and m["status"] == "error" and time.time() - (m["fetched_at"] or 0) < 3600
            recently_checked = m and m["status"] == "ok" and time.time() - (m["fetched_at"] or 0) < 3 * 3600
            if force or not (fresh or recently_failed or recently_checked):
                todo.append((s, m))
        out = {}
        with ThreadPoolExecutor(max_workers=workers) as ex:
            for s, r in zip([t[0] for t in todo], ex.map(lambda t: self._fetch(*t), todo)):
                out[s] = r
        return out

    def _fetch(self, s, meta):
        start = dt.date.today() - dt.timedelta(days=int(365.25 * self.YEARS))
        if meta and meta.get("last_d") and meta.get("status") == "ok":
            start = dt.date.fromisoformat(meta["last_d"]) - dt.timedelta(days=10)
        errs = []
        for p in self.providers:
            try:
                df = p.history(s, start)
                if meta and meta.get("status") == "ok" and len(df):
                    # incremental update: if overlapping closes no longer match (a split was
                    # applied retroactively by the provider), reload the full history
                    old = dict(self.db.all("SELECT d, c FROM ql_bars WHERE symbol=? AND d>=?", (s, df["d"].iloc[0])))
                    diffs = [abs(r.c / old[r.d] - 1) for r in df.itertuples() if r.d in old and old[r.d]]
                    if diffs and max(diffs) > 0.01:
                        self.db.exec("DELETE FROM ql_bars WHERE symbol=?", (s,))
                        df = p.history(s, dt.date.today() - dt.timedelta(days=int(365.25 * self.YEARS)))
                self.db.exec("INSERT INTO ql_bars (symbol, d, o, h, l, c, v, src) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                              "ON CONFLICT (symbol, d) DO UPDATE SET o=excluded.o, h=excluded.h, l=excluded.l, c=excluded.c, v=excluded.v, src=excluded.src",
                              [(s, r.d, _f(r.o), _f(r.h), _f(r.l), float(r.c), _f(r.v), p.name) for r in df.itertuples()], many=True)
                divs = p.dividends(s) if hasattr(p, "dividends") else []
                if divs:
                    self.db.kv_set(f"div:{s}", divs)
                rng = self.db.one("SELECT MIN(d), MAX(d) FROM ql_bars WHERE symbol=?", (s,))
                self._set_meta(s, p.name, rng[0], rng[1], "ok", None)
                return {"status": "ok", "src": p.name, "last": rng[1]}
            except Exception as e:
                errs.append(f"{p.name}: {str(e)[:120]}")
        self._set_meta(s, None, meta and meta.get("first_d"), meta and meta.get("last_d"), "error", "; ".join(errs))
        return {"status": "error", "error": "; ".join(errs)}

    def _set_meta(self, s, src, first, last, status, err):
        self.db.exec("INSERT INTO ql_meta (symbol, fetched_at, src, first_d, last_d, status, error) VALUES (?, ?, ?, ?, ?, ?, ?) "
                     "ON CONFLICT (symbol) DO UPDATE SET fetched_at=excluded.fetched_at, src=COALESCE(excluded.src, ql_meta.src), first_d=excluded.first_d, "
                     "last_d=excluded.last_d, status=excluded.status, error=excluded.error", (s, time.time(), src, first, last, status, err))

    def bars(self, symbol: str, adjust: bool = True) -> pd.DataFrame:
        rows = self.db.all("SELECT d, o, h, l, c, v, src FROM ql_bars WHERE symbol=? ORDER BY d", (symbol,))
        df = pd.DataFrame(rows, columns=["d", "o", "h", "l", "c", "v", "src"])
        if df.empty:
            return df
        df["d"] = pd.to_datetime(df["d"]); df = df.set_index("d")
        for k in ("o", "h", "l", "c", "v"):
            df[k] = pd.to_numeric(df[k], errors="coerce")
        if adjust:
            divs = self.db.kv_get(f"div:{symbol}", [])
            if divs:
                f = pd.Series(1.0, index=df.index)
                for d, amt in divs:
                    d = pd.Timestamp(d)
                    prev = df.index[df.index < d]
                    if len(prev) and d <= df.index[-1]:
                        pc = df.at[prev[-1], "c"]
                        if pc > 0 and amt < pc:
                            f[df.index < d] *= (1 - amt / pc)
                for k in ("o", "h", "l", "c"):
                    df[k] = df[k] * f
        return df

    def panel(self, symbols: list[str], start: str | None = None, end: str | None = None) -> dict:
        """Aligned adjusted panel. Days where any symbol is missing are dropped
        (never forward-filled); the count is reported as a data-quality warning."""
        frames, warn, info = {}, [], {}
        for s in symbols:
            b = self.bars(s)
            if b.empty:
                warn.append(f"{s}: no data")
                continue
            if start: b = b[b.index >= pd.Timestamp(start)]
            if end: b = b[b.index <= pd.Timestamp(end)]
            frames[s] = b
            r = b["c"].pct_change().abs()
            jumps = r[r > 0.4]
            if len(jumps):
                warn.append(f"{s}: {len(jumps)} daily move(s) over 40% (e.g. {jumps.index[0].date()}) — check for an unadjusted split")
            m = self._meta(s) or {}
            info[s] = {"source": m.get("src") or (b["src"].iloc[-1] if "src" in b else None), "first": str(b.index[0].date()), "last": str(b.index[-1].date()),
                       "bars": len(b), "dividends_adjusted": bool(self.db.kv_get(f"div:{s}", []))}
        if len(frames) < len(symbols):
            return {"ok": False, "warnings": warn, "info": info}
        idx = None
        for b in frames.values():
            idx = b.index if idx is None else idx.intersection(b.index)
        union = set()
        for b in frames.values():
            union |= set(b.index)
        dropped = len(union) - len(idx)
        if dropped:
            warn.append(f"{dropped} day(s) dropped because at least one symbol had no bar (no forward-fill)")
        C = pd.DataFrame({s: frames[s]["c"].reindex(idx) for s in symbols})
        O = pd.DataFrame({s: frames[s]["o"].reindex(idx) for s in symbols})
        V = pd.DataFrame({s: frames[s]["v"].reindex(idx) for s in symbols})
        return {"ok": True, "close": C, "open": O, "volume": V, "warnings": warn, "info": info,
                "status": "historical", "asof": str(idx[-1].date()) if len(idx) else None}

    def quote(self, symbol: str) -> dict:
        q = self._quotes.get(symbol)
        if q and time.time() - q["fetched_at"] < 60:
            return q
        nq = self.nasdaq
        if not nq:
            return {"symbol": symbol, "status": "unavailable", "error": "no quote provider"}
        try:
            q = nq.quote(symbol)
        except Exception as e:
            return {"symbol": symbol, "status": "unavailable", "error": str(e)[:160]}
        self._quotes[symbol] = q
        return q

    def status(self) -> dict:
        rows = self.db.all("SELECT status, COUNT(*), MAX(last_d), MAX(fetched_at) FROM ql_meta GROUP BY status")
        errs = self.db.all("SELECT symbol, error, fetched_at FROM ql_meta WHERE status='error' ORDER BY fetched_at DESC LIMIT 20")
        srcs = self.db.all("SELECT src, COUNT(*) FROM ql_meta WHERE status='ok' GROUP BY src")
        return {"by_status": {r[0]: {"symbols": r[1], "latest_bar": r[2], "last_fetch": r[3]} for r in rows},
                "sources": {r[0]: r[1] for r in srcs}, "errors": [{"symbol": r[0], "error": r[1], "at": r[2]} for r in errs],
                "expected_last_session": last_session().isoformat(), "market_open": market_open(),
                "universe": self.db.kv_get("universe_info", {})}
