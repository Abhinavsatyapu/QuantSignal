# Binance auto-trader — daily target & loss (informational)

- **Daily profit target** default **5%** of IST day-start equity (adjustable). **Does not stop new entries** unless `dailyProfitHaltEnabled` is turned on.
- **Daily loss reference** default **6%**. **`dailyLossHaltEnabled` defaults to OFF** — losing days keep trading. Optional halt available in settings.
- Sizing compounds: each IST day, 2% risk and margin budgets use **current equity**.
- Always on: per-trade exchange-side reduceOnly STOP_MARKET + TAKE_PROFIT_MARKET, max concurrent positions, liquidity filter, max holding time (scales with timeframe).
