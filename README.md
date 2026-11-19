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
* `/api/av/*` — optional Alpha Vantage endpoints (bulk quotes, regime with rates + news) if `ALPHAVANTAGE_API_KEY` is set.

## Settings (Render → Environment)
| Variable | Meaning |
|---|---|
| `OWNER_PASSWORD` | the dashboard password |
| `SESSION_SECRET` | random string that signs logins |
| `UPSTREAM` | optional; backend for `/api/*` (default: the ChatGPT site) |
| `ALPHAVANTAGE_API_KEY` | premium Alpha Vantage key for Market regime + Stock vs perp |
| `AV_ENTITLEMENT` | optional; `realtime` (default, falls back to `delayed`) |

Run locally: `OWNER_PASSWORD=yourpass SESSION_SECRET=anything node server.js` → http://localhost:3000

The Grok version (auto-trader, futures pages) is on `main`.
