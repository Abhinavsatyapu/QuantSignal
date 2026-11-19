# Backtest: QuantSignal signals with the site's exact rules

* `gen_signals.js` runs the site's own `public/indicators.js` (`Technicals.analyze`) on every closed candle,
  using the same 320-candle window the live page fetches.
* `paper_exact.py` replays trades with the rules of `public/paper-engine.js`: 0.5% risk, 10% margin cap, 5×,
  10 positions, 0.05% fee, 0.02% slippage, stop / single 2R-3R-4R net target / opposite signal / 70% partial at
  ±10% of initial margin.
* `fetch_data.py` downloads candles (Binance USDT-M stock perps + Yahoo) on a machine with internet.

```bash
python fetch_data.py                       # -> qs_data.zip; unzip it
node gen_signals.js stock_15m 15 sig_15m.json   # folder of <TICKER>.csv (date,open,high,low,close,volume), bar minutes
python paper_exact.py stock_15m sig_15m.json 15m   # writes out/exact_15m.json and out/exact_15m_trades.csv
```

Results (Nov 2026): direction accuracy 43–52% on 5m–1d. The small 10m/15m profit in Mar–Jun 2026
reversed in Jun–Sep and did not appear on 8 other markets, so it is not treated as an edge.
