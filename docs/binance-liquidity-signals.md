# Binance liquidity / price-action signals

Deterministic rules used by the QuantSignal Binance USDⓈ-M trader (`public/strategy-liquidity-signals.js`).
All levels are taken from **completed** candles only.

## Parameters (Advanced / config.binance.liquidity)

| Param | Default | Meaning |
|---|---|---|
| `lookback` | 5 | Pivot strength: a bar is a swing high/low if it is the extreme of ±lookback neighbours |
| `tolPct` | 0.0015 (0.15%) | Equal-highs / equal-lows clustering tolerance |
| `reclaimN` | 3 | Max candles after a break for a reclaim to count as a sweep |

## Signals

### (a) Liquidity grab
- **Bearish:** wick high trades **above** the prior swing high (or equal-highs cluster) and the **same candle closes back below** that level.
- **Bullish:** wick low trades **below** the prior swing low (or equal-lows cluster) and closes back **above**.

### (b) Liquidity sweep
- Break **beyond** a prior swing high/low (close outside), then **reclaim** (close back inside) within `reclaimN` candles.
- Direction is opposite the break (sweep of highs → SHORT; sweep of lows → LONG).

### (c) Buy-side liquidity taken
- Prior swing highs / equal highs are traded through and price closes back **below** → **SHORT**.
- Interprets resting buy stops above highs as taken, then rejection.

### (d) Sell-side liquidity taken
- Prior swing lows / equal lows are traded through and price closes back **above** → **LONG**.

## Combining with the indicator engine

Modes (config `signalMode`):

- `indicators` (default) — existing Technicals.analyze only
- `liquidity` — liquidity signals only
- `confirm` — indicator direction must agree with at least one liquidity signal on the same side
- `any` — either source may fire (first wins per bar, still deduped)

Extra filters (ATR regime, HTF trend, session, funding) are optional and only recommended when the out-of-sample study shows improvement.
