# QuantSignal Terminal + Auto-Trader (US stock perps only)

A redesigned QuantSignal frontend plus an always-on Node.js engine that trades **Hyperliquid US stock perpetuals**.
These are HIP-3 builder-deployed markets such as `xyz:NVDA` on the trade[XYZ] dex. Crypto has been removed.
**It defaults to TESTNET.** It stays in dry-run until both an approved API-wallet key and an account address are set.
Deployment to Render is covered in [DEPLOY.md](DEPLOY.md).

## How Hyperliquid stock perps work (as used here)
* **HIP-3 dexes.** `perpDexs` lists the builder dexes; index 0 is the core crypto dex. Assets are named `{dex}:{TICKER}`.
  Mainnet stock perps come from `perpCategories` (category `stocks`). `xyz` (trade[XYZ]) is the main one.
* **Metadata and prices.** `metaAndAssetCtxs` with `dex:"xyz"` returns szDecimals, maxLeverage, marginMode
  (`noCross` / `strictIsolated` = isolated only), markPx, oraclePx and midPx. `allMids` with `dex`, `l2Book` with
  `coin:"xyz:NVDA"`, and `candleSnapshot` with `coin:"xyz:NVDA"` all work.
* **Orders.** These go through the SDK `order()` like core perps, but the asset id is `100000 + dexIndex*10000 + indexInMeta`.
  Example: `xyz:TSLA` is 110001 on mainnet and 750001 on testnet, where xyz is dex #65. Leverage is set with
  `updateLeverage` (`isCross:false` for isolated-only markets). Price and size rounding are the same as perps
  (5 significant figures, `6 - szDecimals` decimals).
* **Collateral.** xyz is USDC-margined. In the default/standard account mode each dex has its **own** margin account,
  so USDC must be moved into the xyz dex. In unified-account mode, spot USDC collateralizes it automatically.
  The engine reads `userAbstraction` and computes equity accordingly.
* **Hours.** Stock perps trade 24/7. While US markets are closed, the trade[XYZ] oracle switches to internal pricing
  (an EMA of the perp's own book) and later re-anchors to the external price. Weekend and overnight moves can be thin
  and volatile. The UI shows the session, and `scanner.usMarketHoursOnly` can restrict scanning to regular hours.
* **Testnet.** xyz exists on testnet with most large-cap names. Books there are thin or one-sided, so the engine
  checks the book before every order and rejects it if the opposite side is empty, too far from mark
  (`risk.maxBookDeviationPct`), or too shallow. Assets not listed on testnet are rejected. Mainnet is never used as a fallback.

```
public/            redesigned frontend (original feature JS kept + autotrader.js, new styles.css)
server/index.js    Express server: serves UI, JSON API, POST /webhook
server/engine.js   scanner loop, risk checks, execution, dry-run simulator, reconciliation
server/hl.js       Hyperliquid info calls + signed exchange calls via @nktkas/hyperliquid SDK
server/config.js   config loading/validation, network + credential gating
config.json        all tunable settings (risk, scanner, webhook, network)
.env               WEBHOOK_SECRET, ADMIN_TOKEN, HL_ACCOUNT_ADDRESS (chmod 600, never commit)
data/quantsignal.db SQLite: signals, trades, events, scans, equity_days
original/          untouched copy of the original site
```

## Start / stop (pm2)

```bash
cd /workspace/quantsignal
./qs.sh start      # start engine (+ optional tunnel app) under pm2, auto-restart on crash
./qs.sh restart    # reload after editing .env / config.json (uses --update-env)
./qs.sh stop       # stop everything
./qs.sh status     # pm2 list + /health
./qs.sh logs 100   # engine log (logs/engine.out.log)
```

Run `start`/`restart` from a shell where `HL_TESTNET_PRIVATE_KEY` is exported. pm2 passes it to the
process from the environment, and it is never written to disk. Do **not** run `pm2 save`, because pm2 would then write the
environment into `~/.pm2/dump.pm2`. After a machine reboot, run `./qs.sh start` again.

UI: `http://<host>:8787/` (Auto-Trader view: `/autotrader`). Engine controls need the `ADMIN_TOKEN`
from `.env`. Paste it once into the Auto-Trader unlock box (it is stored in browser localStorage).

## Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `HL_TESTNET_PRIVATE_KEY` | process env | Testnet API-wallet private key. Missing → DRY-RUN |
| `HL_ACCOUNT_ADDRESS` | `.env` or env | Main account address the API wallet trades for. Missing → DRY-RUN |
| `WEBHOOK_SECRET` | `.env` | Shared secret for `POST /webhook` |
| `ADMIN_TOKEN` | `.env` | Bearer token for `/api/autotrader/*` (UI controls) |
| `HL_MAINNET_CONFIRM` | env | Must be `yes` (plus config change) for mainnet |
| `HL_MAINNET_PRIVATE_KEY` | env | Separate key used only for mainnet |
| `PORT` | env | Override `config.json` port |

**Going live on testnet:** put `HL_ACCOUNT_ADDRESS=0x…` in `.env`, then run `./qs.sh restart`. Both the key and the
address must be valid. The API wallet must also be approved for that account on
https://app.hyperliquid-testnet.xyz/API. If the key is the account's own wallet, use that wallet's address instead.
On startup the engine logs the API wallet's `userRole`. `missing` means it is not registered on testnet yet.

## How it trades

1. **Signals**
   * *Scanner*: it reuses the site's own `indicators.js` (`Technicals.analyze`) on the server. It runs 5 s after
     each candle close for the stock watchlist (`scanner.assets`, e.g. `NVDA` → `xyz:NVDA`), and uses completed,
     read-only mainnet candles. It acts on
     LONG/SHORT setups whose score is at least `minScore` and whose candle is newer than `maxSignalAgeMinutes`.
     Signals are deduplicated per asset, interval, candle and direction.
   * *Webhook*: `POST /webhook` with the secret in the JSON body field `secret` (TradingView can't send
     headers), in the `X-Webhook-Token` header, or as `?token=`. The payload is parsed by the site's own
     `Finance.validateWebhook`. Supported fields: `ticker`, `action`/`side`
     (`buy|sell|long|short|close`), and optional `price`, `stop`, `target`, `id`. TradingView stock tickers map to the perp:
     `NASDAQ:NVDA` → `xyz:NVDA` and `GOOG` → `xyz:GOOGL`. Crypto or unlisted symbols are rejected.
2. **Risk checks** (in order): kill switch, auto-execute flag, asset listed on the trading network, no
   position already open in the asset (same direction = duplicate, opposite = blocked), max concurrent
   positions, and the daily loss limit (auto-engages the kill switch).
3. **Sizing**: risk $ = equity × `riskPerTradePct`. Notional = risk $ / stop %, capped by `maxPositionUsd` and the
   leverage headroom (equity × min(`maxLeverage`, asset max) − open notional). Orders below $10 are rejected.
4. **Execution**: `updateLeverage`, then an IOC limit at mid ± `slippagePct` (Hyperliquid's market order),
   then reduce-only stop-loss and take-profit **trigger-market** orders re-anchored to the actual fill price.
   If SL/TP placement fails, the position is closed immediately. If that close also fails, the kill switch engages.
   The signal's stop/target distances are kept as percentages and re-based on the trading network's live mid,
   because scanner candles come from mainnet market data by default.
5. **Dry-run**: the same plan is computed and logged ("DRY-RUN ORDER (nothing sent)"). A simulated position is
   tracked, and SL/TP are simulated every 15 s, so duplicate, max-position and daily-loss rules behave realistically.

## config.json options

* `network`: `"testnet"` (default) or `"mainnet"`. This can't be changed from the UI.
* `risk`: `riskPerTradePct`, `maxLeverage`, `maxConcurrentPositions`, `maxPositionUsd`, `dailyLossLimitPct`,
  `takeProfitR` (target when a signal has none / scanner TP = stop × R), `slippagePct`, `defaultStopPct`
  (webhooks without a stop), `dryRunEquity`.
* `market.dex`: the HIP-3 dex to trade (`xyz`). `risk.maxBookDeviationPct`: the furthest the best opposite price may be from mark.
* `scanner`: `enabled`, `assets` (stock tickers), `interval` (5m…1d), `usMarketHoursOnly`, `minStopPct`, `minScore` (6–8), `candleSource`
  (`mainnet` = public read-only mainnet candles, as on the original site; `trading` = candles of the trading
  network), `maxSignalAgeMinutes`.
* `webhook`: `enabled`, `allowExits`.  `trading`: `killSwitch` (persisted), `autoTrade`.
* `upstreamApi`: the original hosted backend. Options-math endpoints (Alpaca options proxy, ratio setup,
  manual four-leg, sheet lab, US stock-perp catalogue) are forwarded there, because their server code isn't public.

Risk, scanner and webhook settings can also be edited in the Auto-Trader view. Changes are validated and saved back to `config.json`.

## API

`GET /health` (public) · `POST /webhook` (secret) · `/api/autotrader/{status,signals,trades,events,scans,markets}` (GET) and
`/api/autotrader/{kill,config,scan-now,close}` (POST). All `/api/autotrader` routes need `Authorization: Bearer $ADMIN_TOKEN`.

Example test alert:
```bash
curl -X POST http://127.0.0.1:8787/webhook -H 'Content-Type: application/json' \
  -d '{"secret":"<WEBHOOK_SECRET>","ticker":"NASDAQ:NVDA","action":"buy","price":212.3,"stop":208,"id":"test-1"}'
```

## Switching to mainnet later (deliberately hard)

1. Test thoroughly on testnet first.
2. Set `"network": "mainnet"` in `config.json`.
3. Export `HL_MAINNET_CONFIRM=yes` **and** `HL_MAINNET_PRIVATE_KEY=<mainnet API wallet key>`, and set `HL_ACCOUNT_ADDRESS`.
4. Run `./qs.sh restart`, then check that the Auto-Trader badge shows **MAINNET · LIVE ORDERS**.

If any of these is missing, the engine stays in DRY-RUN and shows the reason in the UI.

## Public URL

`scripts/tunnel.sh` (pm2 app `quantsignal-tunnel`) starts a Cloudflare quick tunnel and writes the URL to
`logs/public_url.txt` (`./qs.sh url`). It needs outbound TCP 7844. On this box that port is blocked, so the
tunnel app is stopped. On a host that allows it, run `./qs.sh tunnel`. The URL changes on every
restart, so update the TradingView alert URL after each one.

## Scripts

`node scripts/scan-probe.js [intervals] [coins]`: a read-only probe that runs the scanner rules over many markets.
