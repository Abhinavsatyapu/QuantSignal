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

## Settings (Render → Environment)
| Variable | Meaning |
|---|---|
| `OWNER_PASSWORD` | the dashboard password |
| `SESSION_SECRET` | random string that signs logins |
| `UPSTREAM` | optional; backend for `/api/*` (default: the ChatGPT site) |

Run locally: `OWNER_PASSWORD=yourpass SESSION_SECRET=anything node server.js` → http://localhost:3000

The Grok version (auto-trader, futures pages) is on `main`.
