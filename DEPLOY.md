# Deploying to Render (always-on web service)

Current setup: **Free** web service in `singapore`, Docker runtime, auto-deploy from `main`.
* Free instances spin down after about 15 minutes without inbound traffic. `.github/workflows/keepalive.yml` pings
  `/health` every 10 minutes to keep the engine awake. GitHub cron can be delayed, so a short sleep is still
  possible; a paid Starter plan is truly always-on.
* Free has **no persistent disk**, so `DATA_DIR=/tmp/data` is ephemeral. SQLite history and UI-edited settings
  reset on every deploy or restart, and settings re-seed from `config.json` plus env vars. The kill switch also resets
  to OFF. For durable state, upgrade to Starter, add a disk at `/var/data` and set `DATA_DIR=/var/data`.
* Free gives 750 instance-hours/month, enough for one always-awake service.
Run exactly **one instance**: SQLite plus a single execution engine. Never run the local pm2 copy at the same time.

## Option A: Blueprint (recommended)
1. Push this repo to GitHub. `.env`, `data/`, `logs/`, `node_modules/` and `original/` are git-ignored.
2. In Render, go to **New → Blueprint**, pick the repo, and Render reads `render.yaml`. That creates:
   * a Docker web service `quantsignal` on plan `free`, health check `/health`, with ephemeral `DATA_DIR=/tmp/data`
   * env vars; `WEBHOOK_SECRET` and `ADMIN_TOKEN` are auto-generated
3. Fill in the `sync: false` secrets in the dashboard: `HL_TESTNET_PRIVATE_KEY` and `HL_ACCOUNT_ADDRESS`.
4. Deploy. Then open `https://<service>.onrender.com/health`, then `/autotrader`, and unlock with `ADMIN_TOKEN`
   (Render dashboard → Environment).
5. TradingView alert URL: `https://<service>.onrender.com/webhook`. Put `WEBHOOK_SECRET` in the JSON body as `"secret"`.

## Option B: manual web service
New → Web Service → Docker. Health check path `/health`. Add a Disk with mount path `/var/data`, and set the env vars below.
Render injects `PORT`, and the server binds to it on `0.0.0.0`.

## Environment variables
| Variable | Required | Notes |
|---|---|---|
| `DATA_DIR` | yes | `/tmp/data` on Free (ephemeral) or `/var/data` with a paid disk. Holds `quantsignal.db` and the live `config.json` |
| `WEBHOOK_SECRET` | yes | Shared secret for `POST /webhook` |
| `ADMIN_TOKEN` | yes | Bearer token for the Auto-Trader console / `/api/autotrader/*` |
| `HL_TESTNET_PRIVATE_KEY` | for live testnet | Hyperliquid **testnet** API-wallet key. Missing → DRY-RUN |
| `HL_ACCOUNT_ADDRESS` | for live testnet | Main account the API wallet trades for. Missing → DRY-RUN |
| `NETWORK` | no | `testnet` (default). This **always overrides** config. Mainnet also needs the next two |
| `HL_MAINNET_CONFIRM` / `HL_MAINNET_PRIVATE_KEY` | no | Only if you deliberately go mainnet (`yes` + key) |
| `PORT`, `HOST` | no | Render sets `PORT`; `HOST` defaults to `0.0.0.0` |
| `ALPACA_KEY_ID` / `ALPACA_SECRET_KEY` | for options data | Alpaca market-data keys (secret, server-side only) for the derivatives pages |
| `ALPACA_OPTIONS_FEED` | no | `indicative` (default) or `opra` (subscription) |
| `ALPACA_STOCK_FEED` | no | `iex` (default), `sip`, `delayed_sip` |
| `OPTIONS_FALLBACK` | no | `cboe` = Cboe delayed chain when no Alpaca keys (off by default) |
| `STOCK_DEX` | no | HIP-3 dex to trade (default `xyz`) |
| `SCANNER_ASSETS`, `SCANNER_INTERVAL`, `SCANNER_ENABLED` | no | e.g. `NVDA,TSLA,AAPL`, `1h` |
| `RISK_PER_TRADE_PCT`, `MAX_LEVERAGE`, `MAX_CONCURRENT_POSITIONS`, `MAX_POSITION_USD`, `DAILY_LOSS_LIMIT_PCT`, `TAKE_PROFIT_R`, `SLIPPAGE_PCT`, `DRY_RUN_EQUITY` | no | Seed values |

**Seed semantics:** on first boot (no `config.json` on the disk yet), the repo's `config.json` plus these env vars are
written to `$DATA_DIR/config.json`. After that, the UI edits that file and the edits survive redeploys. To re-seed, delete
the file on the disk. `NETWORK` is the exception and is read from the environment on every boot.

## Notes
* Never set `numInstances` > 1, or two engines would both trade.
* To roll back to signal-only mode, unset `HL_TESTNET_PRIVATE_KEY`; the engine runs DRY-RUN.
* Local Docker test:
  `docker build -t quantsignal . && docker run -p 8787:8787 -v $PWD/data:/var/data --env-file .env quantsignal`
