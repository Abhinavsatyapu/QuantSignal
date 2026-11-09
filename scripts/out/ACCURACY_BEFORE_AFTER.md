# Accuracy improvement pass — before / after

Universe: **62** liquid US equity TradFi perps · capital $800 · 5× · max 4 · dry-run

## BEFORE (legacy live default)
- **15m indicators only**
- OOS (this harness): N=9, WR=78%, PF=11.23, net **18.88%**, max DD 0.99%
- 60d: N=5, net **4.97%**, end $839.73, DD 2.22%

## STUDY baseline (single-signal matrix winner — kept selectable)
- **4h liq_buy_side** (canonical study report): OOS N=9, WR=67%, PF=3.74, net **17.03%**; 60d end $927.09 (**+15.89%**), DD 4.12%
- Re-run in final harness (shorter/capped bars): OOS net 2.98% PF 1.34 N 10

## What was tested (rejected unless noted)
| Idea | Result |
|------|--------|
| Whale confirm (OI/taker/top-trader) | **NO_ADOPT** — INCONCLUSIVE / N≈0 confirmed OOS |
| HTF 1d EMA filter | No lift vs baseline |
| ATR stops on 4h buy-side / 1h AND | **Hurt accuracy** (PF↓); ATR1.5 on 1h AND 60d −31% |
| AND same-bar (4h) | Weak / negative OOS |
| OR (1h/5m) | More trades, **worse** OOS accuracy |
| 30m liq_sweep alone | Below 1h AND on OOS score |
| 5m AND window 3 | High raw score but short OOS calendar / PF only ~1.26 — not default |

## AFTER — ADOPTED dry-run config
- **Preset:** `combine_1h_and_window_3`
- **1h · confirm_window · liqWindowBars=3** (indicators score≥6 AND any liquidity within 3 bars, either order)
- OOS: N=11, WR=46%, PF=**3.22**, net **+11.07%**, max DD 2.08%
- 60d: N=**40**, WR=53%, PF=1.45, net **+13.85%**, end $910.76, DD 12.21%
- Avg daily % (60d all days): mean 0.3328%, geo 0.3188%

### Why this vs 4h buy-side alone
Walk-forward in the same harness: 1h AND-window-3 beat the re-run 4h buy-side on OOS net **and** PF with similar+ trade count, and delivers **~8× more 60d trades** (40 vs 5 legacy / 3–7 study packs) without collapsing PF below 1.4 on 60d. Canonical study still favors 4h buy-side on its original matrix — **kept selectable** as `study_best_4h_liq_buy_side`.

### Selectable presets (Futures Settings)
1. `combine_1h_and_window_3` — **active**
2. `study_best_4h_liq_buy_side` — prior study winner
3. `legacy_15m_indicators` — pre-study

## Artifacts
- `scripts/out/final-accuracy-report.json`
- `scripts/out/combine-modes-report.json` + `/workspace/binance-combine-modes-oos.csv`
- `scripts/out/improve-oos-report.json` (whale/HTF NO_ADOPT)
- Canvas: https://cursor.com/canvas/store-c41b4fc2-2005-43ff-86e7-c1faca75b1d4/369db771-fa73-47c9-9ad7-e30857c84b24

Dry-run only. Futures/Whale/redesign **paused** per steering.
