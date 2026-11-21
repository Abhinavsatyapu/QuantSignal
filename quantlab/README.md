# QuantSignal Quant Lab

Statistical-arbitrage research and paper-trading service. **No real orders are ever sent.**

## Architecture

```
ql/data.py        ingestion — swappable providers (Nasdaq primary, Yahoo fallback), dividend
                  adjustment, bar cache, universe (S&P 500, Nasdaq-100, ETFs, high-volume names)
ql/stats.py       Engle-Granger, Johansen, ADF, OU fit / half-life, Hurst, rolling OLS, Kalman,
                  Sharpe p-value, deflated Sharpe, block bootstrap
ql/strategies.py  A cointegration stat-arb · B z-score MR · C classic pairs · D Bollinger ·
                  E Kalman stat-arb · F Ornstein-Uhlenbeck · G regime switch · M momentum
ql/portfolio.py   H market-neutral portfolio (dollar / beta neutral, sector, gross, net limits)
ql/backtest.py    daily event loop: signal at close t, fill at open t+1, fees, half-spread,
                  slippage, borrow, frozen entry sizing, leg P&L, drawdown halt
ql/metrics.py     20+ metrics, regime splits (volatility, trend, bull/bear/sideways)
ql/engine.py      backtest, grid optimisation (robust selection), walk-forward, A vs B + reports
ql/scanner.py     universe scan → correlation → cointegration → half-life → Hurst → cost filter
ql/agent.py       rule-based research agent, paper book, strategy leaderboard
ql/app.py         FastAPI API + password gate; web/ is the 14-page front end
```

## Data honesty rules

- Backtests and scans use end-of-day bars and are labelled **historical**.
- Quotes are labelled **live** or **delayed** from the provider's own real-time flag; **unavailable** when it fails. Nothing is substituted.
- Universe = today's index membership (no free point-in-time membership), so survivorship bias is reduced, not removed.

## Run locally

```
pip install -r requirements.txt
QL_PASSWORD=... QL_INSECURE=1 uvicorn ql.app:app --port 8000     # SQLite in /tmp when DATABASE_URL is unset
python -m pytest tests                                            # 30 tests
```

## Deploy (Render)

Web service, runtime Docker, Dockerfile path `quantlab/Dockerfile`, build context `quantlab`.
Environment variables (set in Render, never in code):

| Variable       | Purpose                                                      |
|----------------|--------------------------------------------------------------|
| `QL_PASSWORD`  | login password                                               |
| `QL_SECRET`    | random string that signs session cookies                     |
| `DATABASE_URL` | Postgres (use the database's *internal* URL); SQLite if unset |
| `QL_AGENT`     | `1` (default) runs the research agent; `0` disables it       |
