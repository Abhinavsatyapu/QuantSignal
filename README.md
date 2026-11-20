# QuantSignal Terminal — ChatGPT version (password-protected)

This branch is the original ChatGPT-built QuantSignal Terminal, unchanged, behind a password.

* `site/` — the ChatGPT site's own files (HTML, CSS, JS), byte-for-byte as served by
  quant-signal-frontend.satyapuabhinav1609.chatgpt.site. Same signal rules (`site/indicators.js`) and
  paper-trading exits (`site/paper-engine.js`).
* `server.js` — no dependencies. Shows a password page until you sign in, then serves `site/`.
  Every `/api/*` call is passed through unchanged to the ChatGPT backend (`UPSTREAM`), so data,
  options, news and webhooks behave exactly as on ChatGPT. One sign-in per device lasts a year;
  changing the password signs every device out. 5 wrong tries lock that address out for 15 minutes.
* `backtest/` — runs `site/indicators.js` bar by bar and replays `site/paper-engine.js` rules.

## Claude additions (design + data, rules unchanged)
* `site/claude.css`, `site/claude-sheet.css` — new design layer loaded after ChatGPT's styles; grouped menu with icons,
  sign-out button, sticky header, mono numbers, phone tab strip. ChatGPT's scripts are untouched.
* `site/claude-av.js` + `/api/hl/assets` in `server.js` — no API key needed:
  **Market regime** from Hyperliquid daily candles (S&P 500 and Nasdaq-100 perp trend vs 50/200-day, Nasdaq-100 realised
  volatility percentile, TLT bonds, breadth of the stock perps → Risk-on / Neutral / Risk-off) and **Stock vs perp**
  (Hyperliquid oracle = real stock price during US hours vs perp mark, gap, 24h change, volume, funding).
* `dte-cap.js` + `dte-run.js` + `site/0dte.html` — **0DTE Capped** paper short (`/0dte`). 10:30 read, 10:31 entry, stop at the lid strike, cover at 15:50. Persists paper trades. No broker calls. The reference study column is not copied.
* `books.js` + `books-math.js` + `site/levels.html`, `site/ignitions.html`, `site/reversals.html`, `site/airpocket.html` — **Zone book** inside the same portal (Ticker levels, Ignitions, Reversals, Airpockets). Rules live in `books-math.js` and are listed on each page. Chains: Unusual Whales when `UW_API_KEY` is set, else Cboe delayed quotes (the same host Zone Monitor uses), else Nasdaq's public chain with Black–Scholes gamma on the mid. `BOOKS=off` disables the refresh. `BOOKS_REFRESH_SEC` defaults to 300. `UW_BASE` overrides the Unusual Whales host. Weekly was not in the capture, so that tab does not invent a book.
* `zone.js` + `site/zone.html` — **Zone Monitor** (free data, no keys): credit regime from FRED (HY/IG spreads, HY yield,
  10-year), RSP/SPY breadth (Yahoo, Stooq backup), gamma from Cboe delayed option chains (SPY/QQQ net GEX and gamma flip,
  +GEX breadth across the stock-perp universe, daily tide history, industry cohorts), swing-low check, regime dial and a
  rule-based claims/payrolls calendar. Refreshes credit 6 h, breadth 15 min, gamma 60 min. `ZONE=off` disables it.
* `/api/av/*` — optional Alpha Vantage endpoints (bulk quotes, regime with rates + news) if `ALPHAVANTAGE_API_KEY` is set.

## Settings (Render → Environment)
| Variable | Meaning |
|---|---|
| `OWNER_PASSWORD` | the dashboard password |
| `SESSION_SECRET` | random string that signs logins |
| `UPSTREAM` | optional; backend for `/api/*` (default: the ChatGPT site) |
| `DATABASE_URL` | Neon (or any Postgres) connection string; keeps Zone Monitor history and last readings across restarts |
| `ALPHAVANTAGE_API_KEY` | premium Alpha Vantage key for Market regime + Stock vs perp |
| `UW_API_KEY` | optional Unusual Whales bearer token for the zone book's strike gamma and flow. Without it the book uses Cboe, then Nasdaq |
| `BOOKS` | set to `off` to disable the zone-book refresh |
| `BOOKS_REFRESH_SEC` | optional; seconds between chain passes (default 300) |
| `BOOKS_SOURCE` | optional; `nasdaq` skips the Cboe probe, `chain` skips Unusual Whales even if a key is set |
| `AV_ENTITLEMENT` | optional; `realtime` (default, falls back to `delayed`) |

Run locally: `OWNER_PASSWORD=yourpass SESSION_SECRET=anything node server.js` → http://localhost:3000

The Grok version (auto-trader, futures pages) is on `main`.

## OMS (paper by default)

Order management on your own Alpaca account. Code: `oms/` (alpaca.js broker adapter, db.js schema, risk.js risk engine,
engine.js lifecycle, routes.js HTTP API), page `site/oms.html` at `/oms`. Tests: `test/oms.test.js` with `test/mock-alpaca.js`.

**Order lifecycle** (every change stored in `oms_events`):
`proposed → approved → submitted → acknowledged → partially_filled → filled`, or `blocked` (risk), `declined`, `rejected`
(broker), `canceled`, `expired`, `replaced` (modify creates a child order). An order is never marked filled because a
request was sent; only the broker's order status and fill activities move it.

**Safety**
* PAPER unless `ALPACA_ENV=live` **and** `OMS_LIVE_APPROVED=yes` are both set (owner only).
* Idempotency key per order = Alpaca `client_order_id`; repeats return the same order, the broker rejects duplicates.
* Risk checks run on the server at proposal **and again right before** the broker call: kill switch, max order value,
  max position per symbol, gross exposure, max open positions, stop-loss required + on the right side, risk to stop
  (% of equity), daily loss, drawdown vs peak, shorting allowed, session rules (market orders regular hours only,
  extended hours = DAY limit), duplicate open order protection. Closing orders skip the opening-only checks.
* Reason required for every action; all actions in `oms_audit`. Mutating calls need `X-QS-OMS: 1`.
* Restart recovery: approved-but-unconfirmed orders are looked up by client_order_id, never blindly resent.
  Unknown submit outcomes stay open and are reconciled.
* Keys only in Render environment variables; never sent to the page or logged. Withdrawals are not possible through
  the trading API.

**API** (`/api/oms`, owner session required): `GET /status`, `GET /key`, `GET /orders?status=&limit=`, `GET /orders/:id`
(events + fills), `POST /orders` (propose), `POST /orders/:id/approve|decline|cancel|modify`, `GET /fills`, `GET /pnl`
(realized FIFO), `GET /audit`, `POST /reconcile`, `POST /sync`, `POST /kill` {on, cancelAll, flatten}, `POST /limits`.

**Tables**: `oms_orders`, `oms_events`, `oms_fills`, `oms_config` (limits, kill switch, peak equity, fill cursor),
`oms_audit`, `oms_recon`.

**Background services** (inside the web process): broker sync every 5 s while orders are working (30 s otherwise),
fill import with de-duplication, peak-equity tracking, position reconciliation every 10 min.

**Settings**: `DATABASE_URL` (required), `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY` (paper keys), optional `ALPACA_ENV=live` +
`OMS_LIVE_APPROVED=yes` for real money.

**Tests**: `TEST_DATABASE_URL=postgres://… node --test test/oms.test.js` — 15 tests: lifecycle incl. partial fills,
idempotency, concurrent approvals, duplicate protection, request-time and exchange rejections, risk re-check at approval,
kill switch (+ cancel-all), cancel, modify/replace, restart recovery, broker outage during submit, fills, realized P&L,
reconciliation, input validation.
