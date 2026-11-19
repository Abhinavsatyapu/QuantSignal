"""
QuantSignal data downloader — run on YOUR machine (needs internet; Binance/Yahoo are blocked in Claude's sandbox).

    pip install yfinance pandas requests
    python fetch_data.py

Creates qs_data.zip. Attach it in the chat (or run `python run_all.py qs_data.zip` yourself).

Folders inside the zip (one CSV per ticker):
  binance_<tf>/  real Binance USDT-M stock-perp klines since each listing (Jan 2026 onward)
                 tf = 5m 10m 15m 30m 1h 4h 1d   (10m is resampled from 5m; Binance has no 10m)
  stock_1d/      underlying stock, daily, from 2023-09-01 (2 yrs test + SMA200 warm-up)
  stock_1h/      underlying stock, 1h, last ~729 days (Yahoo's max)   + stock_4h/ resampled
  stock_5m/ stock_10m/ stock_15m/ stock_30m/   underlying, last ~59 days (Yahoo's max)
Universe = all Hyperliquid xyz stock perps (what the QuantSignal site scans) + all Binance stock perps.
"""
import json, time, zipfile, datetime as dt
import requests, pandas as pd, yfinance as yf

NON_STOCK = {"XYZ100", "SP500", "SPX", "USA500", "US500", "NDX", "GOLD", "SILVER", "CL", "WTI", "BRENT",
             "NATGAS", "COPPER", "PLATINUM", "PALLADIUM", "URANIUM", "EUR", "JPY", "GBP", "DXY", "OPENAI",
             "ANTHROPIC", "XAI", "VIX", "JP225", "KR200", "DAX", "HK50", "ALUMINIUM", "ALUMINUM", "WHEAT",
             "CORN", "SOY", "COFFEE"}
yahoo = lambda t: t.replace(".", "-")

def hyperliquid_xyz():
    r = requests.post("https://api.hyperliquid.xyz/info", json={"type": "meta", "dex": "xyz"}, timeout=20); r.raise_for_status()
    return [a["name"].split(":")[-1].upper() for a in r.json().get("universe", [])
            if not a.get("isDelisted") and a["name"].split(":")[-1].upper() not in NON_STOCK]

def binance_stock_perps():
    r = requests.get("https://fapi.binance.com/fapi/v1/exchangeInfo", timeout=20); r.raise_for_status()
    out = []
    for s in r.json()["symbols"]:
        tags = " ".join([str(s.get("underlyingType", ""))] + [str(x) for x in s.get("underlyingSubType", [])]).upper()
        if s.get("status") == "TRADING" and s["quoteAsset"] == "USDT" and any(k in tags for k in ("EQUITY", "STOCK", "TRADFI")) \
           and s["baseAsset"] not in ("XAU", "XAG", "XPT", "XPD", "PAXG"):
            out.append(s["symbol"])
    return out

def binance_klines(sym, interval, start_ms):
    rows, cur = [], start_ms
    while True:
        r = requests.get("https://fapi.binance.com/fapi/v1/klines",
                         params={"symbol": sym, "interval": interval, "startTime": cur, "limit": 1500}, timeout=20)
        r.raise_for_status(); k = r.json()
        if not k: break
        rows += k; cur = k[-1][0] + 1
        if len(k) < 1500: break
        time.sleep(0.15)
    df = pd.DataFrame(rows, columns=["t", "open", "high", "low", "close", "volume", "ct", "qv", "n", "tb", "tq", "i"])
    df["date"] = pd.to_datetime(df.t, unit="ms", utc=True)
    return df[["date", "open", "high", "low", "close", "volume"]].astype({c: float for c in ("open", "high", "low", "close", "volume")})

def resample(df, rule):
    x = df.set_index("date")
    return x.resample(rule, label="left", closed="left").agg(
        dict(open="first", high="max", low="min", close="last", volume="sum")).dropna().reset_index()

def yahoo_dl(tickers, **kw):
    d = yf.download([yahoo(t) for t in tickers], group_by="ticker", auto_adjust=True, progress=False, threads=True, **kw)
    out = {}
    for t in tickers:
        try:
            x = d[yahoo(t)].dropna(how="all")
            if len(x) < 50: continue
            x = x.reset_index(); x.columns = [str(c).lower() for c in x.columns]
            x = x.rename(columns={x.columns[0]: "date"})
            out[t] = x[["date", "open", "high", "low", "close", "volume"]]
        except Exception: pass
    return out

def main():
    try: hl = hyperliquid_xyz()
    except Exception as e: print("Hyperliquid list failed:", e); hl = []
    try: bn = binance_stock_perps()
    except Exception as e: print("Binance list failed:", e); bn = []
    universe = sorted(set(hl) | {s[:-4] for s in bn})
    print(f"Hyperliquid xyz stocks: {len(hl)} | Binance stock perps: {len(bn)} {bn} | universe: {len(universe)}")
    z = zipfile.ZipFile("qs_data.zip", "w", zipfile.ZIP_DEFLATED)
    z.writestr("universe.json", json.dumps(dict(hyperliquid_xyz=hl, binance=bn, universe=universe,
                                                downloaded=dt.datetime.utcnow().isoformat()), indent=1))
    put = lambda folder, t, df: z.writestr(f"{folder}/{t}.csv", df.to_csv(index=False))

    # --- real Binance stock perps, every timeframe
    start = int(dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc).timestamp() * 1000)
    for s in bn:
        t = s[:-4]
        for tf in ("5m", "15m", "30m", "1h", "4h", "1d"):
            try:
                df = binance_klines(s, tf, start); put(f"binance_{tf}", t, df)
                if tf == "5m": put("binance_10m", t, resample(df, "10min"))
            except Exception as e: print("binance", s, tf, e)
        print("binance", s, "ok")

    # --- underlying stocks (Yahoo limits: 1d unlimited, 1h 730 days, 5m/15m/30m 60 days)
    for tf, kw in (("1d", dict(start="2023-09-01", interval="1d")), ("1h", dict(period="729d", interval="1h")),
                   ("5m", dict(period="59d", interval="5m")), ("15m", dict(period="59d", interval="15m")),
                   ("30m", dict(period="59d", interval="30m"))):
        got = yahoo_dl(universe, **kw); print(f"Yahoo {tf}: {len(got)}/{len(universe)}")
        for t, df in got.items():
            put(f"stock_{tf}", t, df)
            if tf == "1h": put("stock_4h", t, resample(df, "4h"))
            if tf == "5m": put("stock_10m", t, resample(df, "10min"))
    z.close(); print("Done -> qs_data.zip")

if __name__ == "__main__":
    main()
