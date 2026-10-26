# Strike-selection audit against the reference sheets (26 Oct 2026)

**Question:** "it's going wrong at choosing 4 strikes". This audit checks the engine against every reference sheet page in `data/reference/` (78 pages; 30 LONG-futures, 48 SHORT-futures; 45 distinct trades, because many trades are transcribed on 2–5 pages). It derives the sheets' strike rules, backtests every method before and after the fix, and lists the bugs found.

Reproduce: `node scripts/strike-audit.js --loto --methods optimizer,weekly_atr,reference --json out.json` (add `--atr` to refetch Nasdaq history and `--write-atr` to refresh `data/reference/sheet-atr.json`). The regression tests are in `test/strike-audit.test.js`.

## 1. Method

* **Ground truth per page.** From each page: ticker, spot (futures entry), open date, expiry and calendar DTE, futures side, lot ratio, the 4 strikes, futures qty and the exit P&Ls.
  * Each strike is measured from spot in $, % of spot and σ. σ = spot × the sheet's own ATM IV (implied from the debit-long premium) × √(DTE/365).
  * Each strike is also measured in multiples of the weekly ATR. The weekly ATR is the Wilder 14-week ATR from Nasdaq daily OHLC, using the weeks completed before the open week.
* **Roles.** A SHORT-futures sheet = a **call debit** spread (CE long ≈ ATM, CE short = debit short) plus a **put credit** spread (PE short = credit short, PE long = wing). A LONG-futures sheet is the mirror image: put debit spread plus call credit spread.
* **Reconstructed chains (backtest).** Each page's chain is rebuilt as follows:
  * Spot = the sheet spot.
  * The listed grid ($1 strikes under $150, $2.50 to $500, $5 above) plus the 4 sheet strikes.
  * IV interpolated between the 4 leg IVs.
  * Black-Scholes mid ± 3%.
  * The perp at the sheet spot.
  * Time = the open date at 15:30 ET.
* **How the engine is run.** The direction is set to the sheet's futures side, which isolates strike choice. The target is 90% of the sheet's worse expiry exit, with the sheet's lot sets and MM loss.
* **Scoring.** Each leg's error is counted in listed strikes (|engine − sheet| ÷ strike increment). FQ error compares futures per lot set.
* **No look-ahead.** Results are **leave-one-trade-out (LOTO)**: the sheet anchor used for a page excludes every page of the same trade. In-sample and leave-one-page-out figures are shown too. The Reference method's calibration is in-sample (it was not re-fitted per trade).

## 2. Rules found on the sheets

Median [IQR] per hedge side and lot ratio. σ uses the sheet IV and DTE; × ATR = the weekly ATR at the open.

| Group | n | debit long σ OTM | debit short σ | credit short σ | wing σ | debit short % | credit short % | wing % | CE short ×ATR | PE short ×ATR | call width (strikes) | put width (strikes) | DTE | IV |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ALL | 78 | 0.09 [0.05–0.22] | 0.90 [0.79–1.07] | 0.63 [0.58–0.77] | 0.47 [0.40–0.52] | 7.76 [6.86–8.84] | 5.56 [4.42–6.61] | 3.97 [3.05–4.70] | 0.42 [0.36–0.54] | 0.41 [0.33–0.46] | 6.00 [4.00–8.00] | 4.50 [3.00–5.00] | 4.00 [3.00–8.00] | 0.76 [0.67–0.87] |
| LONG | 30 | 0.21 [0.10–0.24] | 0.99 [0.81–1.10] | 0.68 [0.58–0.78] | 0.51 [0.47–0.62] | 7.87 [7.37–8.62] | 5.46 [3.80–6.61] | 4.33 [3.05–5.44] | 0.34 [0.28–0.40] | 0.44 [0.40–0.56] | 3.00 [3.00–5.00] | 5.00 [4.00–8.00] | 4.00 [2.00–8.00] | 0.76 [0.67–0.91] |
| LONG 2C:1P | 25 | 0.24 [0.09–0.24] | 1.02 [0.79–1.10] | 0.62 [0.58–0.78] | 0.50 [0.47–0.52] | 7.86 [7.31–8.31] | 4.59 [3.80–6.51] | 4.00 [3.05–5.39] | 0.34 [0.26–0.40] | 0.44 [0.39–0.56] | 3.00 [3.00–5.00] | 5.00 [4.00–8.00] | 3.00 [2.00–8.00] | 0.75 [0.68–0.90] |
| LONG 1C:2P | 5 | 0.17 [0.17–0.21] | 0.99 [0.99–1.07] | 0.86 [0.76–0.86] | 0.62 [0.51–0.62] | 9.45 [7.87–9.45] | 6.48 [5.62–8.27] | 5.79 [4.49–5.91] | 0.40 [0.30–0.40] | 0.45 [0.45–0.56] | 5.00 [4.00–6.00] | 8.00 [7.00–8.00] | 4.00 [4.00–7.00] | 0.76 [0.39–0.91] |
| SHORT | 48 | 0.06 [0.05–0.13] | 0.89 [0.79–1.04] | 0.63 [0.61–0.74] | 0.44 [0.35–0.52] | 7.22 [6.79–8.97] | 5.71 [4.72–6.64] | 3.68 [2.94–4.62] | 0.47 [0.42–0.56] | 0.35 [0.30–0.44] | 7.25 [6.00–8.00] | 4.00 [3.00–5.00] | 7.00 [3.00–8.00] | 0.78 [0.67–0.86] |
| SHORT 1C:2P | 45 | 0.06 [0.05–0.13] | 0.88 [0.79–1.03] | 0.63 [0.61–0.74] | 0.43 [0.35–0.52] | 7.17 [6.55–8.97] | 5.71 [4.67–6.52] | 3.53 [2.86–4.37] | 0.47 [0.42–0.55] | 0.35 [0.29–0.45] | 7.00 [6.00–8.00] | 4.00 [3.00–5.00] | 7.00 [3.00–8.00] | 0.78 [0.67–0.86] |
| SHORT 2C:1P | 2 | 0.05 [0.05–0.05] | 0.90 [0.90–0.90] | 0.55 [0.55–0.55] | 0.51 [0.51–0.51] | 11.00 [11.00–11.00] | 6.64 [6.64–6.64] | 6.22 [6.22–6.22] | 0.59 [0.59–0.59] | 0.35 [0.35–0.35] | 10.00 [10.00–10.00] | 6.00 [6.00–6.00] | 8.00 [8.00–8.00] | 0.82 [0.82–0.82] |

**The simplest rule set that reproduces the sheets** (chosen by a leave-one-out search over σ, % of spot, × ATR and strike steps, pooled vs per side vs per ticker):

| Leg | Rule | Within 1 strike (rule alone, LOO) |
|---|---|---|
| Debit long | The **first listed strike beyond spot** in the debit direction (beats "nearest ATM" at 80% and "0.09σ" at 89%) | 89.5% |
| Debit short | spot ± ½·(sheet σ distance × σ) + ½·(sheet × ATR × weekly ATR). Medians: pooled 0.89σ / 0.44× ATR; per ticker when it has ≥ 3 rows | 80–83% (σ alone 76%, % alone 67%) |
| Credit short | spot ∓ the same blend. Medians: pooled 0.63σ / 0.34× ATR | 75–78% |
| Credit wing | the credit short ∓ the same blend of the wing. Medians: pooled 0.46σ / 0.24× ATR. Placing it relative to the short beats placing it from spot (59–64%) | 66–72% |
| Ratio | the credit spread carries **2× the debit lots**: SHORT hedge → 1C:2P (45 of 48 pages), LONG hedge → 2C:1P (25 of 30) | 89.7% |
| Futures qty | equalise the P&L at the two shorts today and round down to 5 (unchanged) | median error 8–12% |

Other findings:
* **Call/put asymmetry:** the debit short sits farther out than the credit short (0.90σ vs 0.63σ). On LONG hedges the put debit long is a little further OTM (0.21σ) than the call debit long on SHORT hedges (0.06σ).
* **Round numbers:** on $1-strike names, 50% of the sheet shorts are multiples of $5 (vs 20% by chance). A "prefer a multiple of 5 within 1 strike" tie-break did not improve the backtest, so it is not used.
* **Residual spread:** the sheet-to-sheet IQR of the shorts is about ±1–1.5 strikes, so even a perfect fixed rule cannot get every leg within 1 strike. The ceiling measured for a fixed rule was about 80%.
* **Data issues in the sheets:**
  * Pages 2, 13 and 62 have inverted premiums (the further-OTM leg is dearer, a transcription error).
  * Page 13 mixes the patterns.
  * Page 73 has no solvable IV.
  * 33 pages duplicate another page's trade.

## 3. Conflict: the 0.7–1.2σ zone vs the sheets

* The sheets put the **credit short at 0.63σ (median) — 45 of 76 credit shorts are inside 0.7σ** — and the debit short at 0.90σ. The zone is kept as a **sanity clamp** on the two short distances, and every binding is reported in the result (`distanceBand.conflicts`, shown under "Zone check").
* Measured cost: leave-one-out within-1 is **74.0% with the clamp vs 71.1% without** (exact matches 28% vs 36%). The clamp moves credit shorts out by about ½–1 strike but stops the occasional too-tight one, so it is roughly neutral.
* The ± variations may sit at most 0.15σ outside the zone.
* **HOOD specifically:** the 8 HOOD pages (5 distinct trades) put the **PE short 5.0–5.7% below spot (0.40–0.71σ)** and the **CE short 6.3–9.4% above (0.64–0.89σ)**.
  * The sheet rule on today's chain gives **CE 103 / PE 88**.
  * The earlier "middle distance" target of CE 104–105 / PE 84–85 puts the PE about 1.0σ (−10.5%) out, wider than every HOOD sheet. So the sheets and that target disagree. The engine now follows the sheets.

## 4. Backtest: before vs after

Legs within N listed strikes of the sheet (all 4 legs pooled). LOTO = leave-one-trade-out.

| Method | Data | Legs exact | ≤ 1 strike | ≤ 2 strikes | CE long ≤1 | CE short ≤1 | PE short ≤1 | PE long ≤1 | Ratio match | Side match | FQ median error |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Optimizer **before** (band, 0.7–1.2σ zone, anchor max(sheet, 0.95σ)) | 78 pages, in-sample | 18.4% | **48.7%** | 69.4% | 53.9% | 57.9% | 38.2% | 44.7% | 89.5% | 100% | 12.5% |
| Optimizer **before** | 78 pages, LOTO | 15.8% | **45.1%** | 67.1% | 44.7% | 55.3% | 32.9% | 47.4% | 88.2% | 100% | 12.5% |
| Optimizer **before** | 45 trades, LOTO | 15.5% | **44%** | 65.5% | 47.6% | 57.1% | 31% | 40.5% | 83.3% | 100% | 14% |
| Optimizer **after** (sheet geometry ± 2 strikes) | 78 pages, in-sample | 29.9% | **78%** | 92.1% | 81.6% | 73.7% | 81.6% | 75% | 88.2% | 100% | 7.5% |
| Optimizer **after** | 78 pages, leave-one-page-out | 27.9% | **74%** | 90.9% | 80.5% | 71.4% | 72.7% | 71.4% | 88.3% | 100% | 8% |
| Optimizer **after** | 78 pages, LOTO | 26.3% | **70.8%** | 90.3% | 80.5% | 64.9% | 72.7% | 64.9% | 88.3% | 100% | 12.5% |
| Optimizer **after** | 45 trades, LOTO | 28.5% | **68%** | 85.5% | 76.7% | 60.5% | 69.8% | 65.1% | 83.7% | 100% | 12.5% |
| Weekly ATR **before** (0.7× / 0.7× ATR) | 78 pages | 15.2% | **37.2%** | 51% | 55.4% | 28.4% | 23% | 41.9% | 89.2% | 100% | 5.3% |
| Weekly ATR **after** (sheet × ATR) | 78 pages, LOTO | 25.7% | **67.2%** | 84.5% | 70.3% | 62.2% | 70.3% | 66.2% | 89.2% | 100% | 11.8% |
| Weekly ATR **after** | 45 trades, LOTO | 26.2% | **65.2%** | 82.9% | 70.7% | 61% | 68.3% | 61% | 85.4% | 100% | 11.1% |
| Reference (unchanged; calibration in-sample) | 78 pages | 42.1% | **78.9%** | 89.5% | 82.9% | 82.9% | 72.4% | 77.6% | 89.5% | 100% | 11.1% |
| Reference (unchanged; calibration in-sample) | 45 trades | 40.5% | **73.2%** | 85.7% | 81% | 78.6% | 64.3% | 69% | 85.7% | 100% | 11.8% |

**Whole pages:** all 4 strikes within 1 strike on **29 of 77 pages after vs 9 of 76 before**, and within 2 strikes on 57 vs 33 (optimizer, LOTO). For Weekly ATR: 25 vs 5 pages within 1, and 46 vs 11 within 2.

**Target check:** "a large majority of legs within 1 strike" is **met at 71% of legs out of sample (68% on distinct trades), 78% in-sample, and 90% within 2 strikes**. The remaining misses mostly come from the sheets' own scatter (§2). The zone clamp moves the credit put on SHORT hedges, and its wing, about ½–1 strike wider.

## 5. Bugs and causes found

1. **The optimizer did not follow the sheet geometry. This was the main cause.** In zone mode it anchored both shorts at max(sheet distance, zone midpoint 0.95σ) and searched the whole 0.7–1.2σ zone, with 7 evenly picked strikes per side, 3 debit longs and 4 wings. With a strong shortAnchor weight, both shorts were pulled to about 0.95σ. The sheets use 0.90σ for the debit short and **0.63σ** for the credit short, so the credit short (the PE on SHORT hedges) landed 1–3 strikes too wide: **PE short only 33–38% within 1 strike**. **Fixed:** the 4 strikes are now computed from the learned rule (§2). The what-if only chooses among **± 2 listed strikes on each short and ± 1 on each long**, with a *geometry* penalty (weight 6) for every step away from the rule.
2. **Weekly ATR defaults (0.7× / 0.7×) were far wider than the sheets (0.42× / 0.41×):** CE short 28% and PE short 23% within 1 strike. **Fixed:** the multiples now default (blank field) to the sheets' own CE / PE × ATR for the ticker (≥ 3 rows), otherwise pooled 0.42 / 0.41. The 0.7–1.2σ clamp still applies.
3. **Variations sliding into near-ATM structures.** With a live AAPL chain, the first version of the fix moved CE 355 → 350 and PE 342.5 → 347.5, a short at spot, because the rule structure failed the risk gates and gate-passing candidates rank first. **Fixed:** a variation may not move a short more than 0.15σ outside the zone, or the debit long more than 0.15σ in the money. AAPL now returns exactly the rule strikes, 350/355C and 342.5/337.5P.
4. **Ratio preference.** The other ratio (credit ½×) was free to win on score. It now carries a *ratio* penalty (weight 2). Ratio match is about 88–89%, the most a fixed rule can reach, because 8 pages use the other ratio.
5. **Checked, no bug found:**
   * **Call/put swap and long/short inversion:** a test asserts the sheet shape on every backtested structure.
   * **1C:2P / 2C:1P mapping by direction:** credit 2× = 1C:2P on SHORT and 2C:1P on LONG, in both the engine and the sheets.
   * **Snapping:** nearest liquid listed strike; the debit short must lie beyond the debit long, and the wing beyond the credit short.
   * **σ convention:** ATM IV (mean of the 4 quotes nearest spot) × √(calendar time to 16:00 ET on the expiry). The sheets use the same convention (calendar DTE/365).
   * **Spot:** the Cboe underlying quote, not the perp. The perp is only the hedge (basis recorded; > 5% gap → PRICE_MISMATCH).
6. **Caveats, not bugs:**
   * Out of hours and at weekends the Cboe spot and chain are the last close (delayed), so strikes are computed from the close while the perp mid is live.
   * The trading-day count ignores holidays.

## 6. What changed in the engine

* `public/strategy-optimizer.js`:
  * New default `selection: "sheet"` with `shortSteps 2`, `longSteps 1`, `atrBlend 0.5` and `snapIntoZone false`. Snapping into the zone costs 1.6 points and stays optional.
  * New weights `geometry 6` and `ratio 2`.
  * The rule strikes, blend and zone conflicts are recorded per variant (`distanceBand.variants[].rule`, `distanceBand.conflicts`), along with the steps from the rule (`best.distances.stepsFromRule`).
  * `selection: "band"` keeps the old search.
* `server/strategy.js`:
  * The sheet anchor adds the sheet × ATR medians to every group (from the frozen `data/reference/sheet-atr.json`, so there are no network calls at request time) and `atrMultiples` (CE / PE short × ATR) for the Weekly ATR defaults.
  * `sheetAnchor(t, { excludePages })` supports the leave-one-trade-out audit.
* `public/strategy-weekly-atr.js`: defaults 0.42 / 0.41. The UI fields are blank, meaning "sheet".
* UI ("How this was chosen"): steps are now *Sheet rule*, *Zone check* and *Variations tested*. The pairs header reads "sheet rule ± 2 strikes · zone clamp …". The card's *Sheet reference* is the rule strike.

## 6b. Live check (deploy 4746978, 26 Oct 2026, expiry 30 Oct, Cboe delayed quotes from the 23 Oct close, $800 target)

| Ticker | Spot · σ · weekly ATR | Sheet-rule strikes (debit long / debit short / credit short / wing) | Chosen | Steps from rule | Zone conflicts |
|---|---|---|---|---|---|
| HOOD | 94.90 · $9.64 · $14.98 | SHORT 1C:2P: 95C / 103C / 88P / 84P (HOOD sheets, 8 rows) | +4 96C −4 103C +8 84P −8 88P, perp −175 (CE 103 +8.5% 0.84σ; PE 88 −7.3% 0.72σ); exits $1,038 / $865; P(profit) 52% | debit long +1 | credit short 0.65σ → 0.70σ |
| SPY | 759.97 · $13.68 · $17.45 | LONG 2C:1P: 759P / 750P / 770C / 775C (pooled) | −4 768C +4 775C −2 750P +2 759P, +100 shares (no perp); exits $862 / $863; P(profit) 70.5% | credit short −2 (770 → 768) | credit short 0.61σ → 0.70σ |
| AAPL | 347.61 · $8.34 · $17.15 | SHORT 1C:2P: 350C / 355C / 342.5P / 337.5P (pooled) | +6 352.5C −6 357.5C +12 337.5P −12 340P, perp −170; exits $898 / $874; P(profit) 38% | 3 legs ±1 (the 2% risk cap at 6 lot sets) | credit short 0.67σ → 0.70σ |

The earlier baselines for HOOD were 99/89 (run #92), 111/76 (band run #103) and 104/85 (the middle-zone anchor). HOOD's own sheets put the shorts at 6.3–9.4% / 5.0–5.7% from spot; today's rule gives +8.5% / −7.3%.

## 7. Per-page ground truth and engine result (optimizer, LOTO)

CE/PE short distances are $ · % · σ · × weekly ATR from spot. Engine = CE long / CE short / PE short / PE long.

| Page | Ticker | Open → expiry (DTE) | Spot | Side · ratio | CE long / CE short | PE short / PE long | CE short $ · % · σ · ×ATR | PE short $ · % · σ · ×ATR | Wings C / P | FQ | Exits up / down (expiry) | Engine (sheet selection, LOO) | Max err (strikes) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | CRWV | 2026-10-06 → 2026-10-09 (3) | 92.6 | LONG · 2C:1P | 101 / 97 | 86 / 92 | +4.40 · +4.8% · 0.70σ · 0.26× | -6.60 · -7.1% · -1.05σ · -0.39× | 4 / 6 | 270 | 1033 / 1063 | 101/97/86/92 2C:1P FQ 275 | 0 |
| 2 | CRWV | 2026-10-05 → 2026-10-09 (4) | 89 | LONG · 1C:2P | 98 / 94 | 82 / 89 | +5.00 · +5.6% · 2.59σ · 0.30× | -7.00 · -7.9% · -3.63σ · -0.42× | 4 / 7 | 240 | 931 / 2045 | 95/92/86/89 2C:1P FQ 190 | 4 |
| 3 | CRCL | 2026-10-06 → 2026-10-09 (3) | 85 | SHORT · 1C:2P | 86 / 91 | 80 / 77 | +6.00 · +7.1% · 1.22σ · 0.39× | -5.00 · -5.9% · -1.02σ · -0.32× | 5 / 3 | -210 | 1050 / 912 | 85/90/81/77 1C:2P FQ -280 | 1 |
| 4 | NBIS | 2026-10-06 → 2026-10-09 (3) | 251.77 | SHORT · 1C:2P | 255 / 275 | 240 / 230 | +23.23 · +9.2% · 1.25σ · 0.55× | -11.77 · -4.7% · -0.63σ · -0.28× | 20 / 10 | -48 | 700 / 486 | 252.5/270/237.5/227.5 1C:2P FQ -50 | 2 |
| 5 | CRCL | 2026-10-06 → 2026-10-09 (3) | 85 | SHORT · 5C:6P | 86 / 91 | 80 / 77 | +6.00 · +7.1% · 1.22σ · 0.39× | -5.00 · -5.9% · -1.02σ · -0.32× | 5 / 3 | -210 | 1050 / 912 | 85/90/81/77 1C:2P FQ -280 | 1 |
| 6 | NBIS | 2026-10-01 → 2026-10-09 (8) | 231.71 | LONG · 2C:1P | 265 / 252.5 | 212.5 / 232.5 | +20.79 · +9.0% · 0.87σ · 0.47× | -19.21 · -8.3% · -0.81σ · -0.44× | 12.5 / 20 | 45 | 693 / 893 | 262.5/247.5/210/230 2C:1P FQ 50 | 2 |
| 7 | PLTR | 2026-10-02 → 2026-10-09 (7) | 189.68 | LONG · 1C:2P | 202.5 / 197.5 | 180 / 187.5 | +7.82 · +4.1% · 0.76σ · 0.45× | -9.68 · -5.1% · -0.95σ · -0.56× | 5 / 7.5 | 130 | 949 / 924 | 202.5/197.5/177.5/187.5 2C:1P FQ 145 | 1 |
| 8 | BE | 2026-09-30 → 2026-10-02 (2) | 279.95 | LONG · 2C:1P | 297.5 / 290 | 262.5 / 275 | +10.05 · +3.6% · 0.54σ · 0.20× | -17.45 · -6.2% · -0.94σ · -0.34× | 7.5 / 12.5 | 80 | 754 / 1250 | 305/295/260/277.5 2C:1P FQ 100 | 3 |
| 9 | BE | 2026-10-02 → 2026-10-09 (7) | 289 | LONG · 2C:1P | 320 / 307.5 | 265 / 287.5 | +18.50 · +6.4% · 0.68σ · 0.36× | -24.00 · -8.3% · -0.88σ · -0.47× | 12.5 / 22.5 | 95 | 1227.5 / 1690 | 320/307.5/267.5/287.5 2C:1P FQ 95 | 1 |
| 10 | INTC | 2026-09-30 → 2026-10-02 (2) | 118 | SHORT · 1C:2P | 120 / 125 | 113 / 110 | +7.00 · +5.9% · 1.05σ · 0.44× | -5.00 · -4.2% · -0.75σ · -0.31× | 5 / 3 | -200 | 1050 / 950 | 119/125/113/109 1C:2P FQ -255 | 1 |
| 11 | CRCL | 2026-09-28 → 2026-10-02 (4) | 85.5 | SHORT · 1C:2P | 88 / 95 | 80 / 79 | +9.50 · +11.1% · 1.15σ · 0.59× | -5.50 · -6.4% · -0.67σ · -0.34× | 7 / 1 | -135 | 794.5 / 719.5 | 86/92/80/79 1C:2P FQ -215 | 3 |
| 12 | NBIS | 2026-10-01 → 2026-10-09 (8) | 231.76 | LONG · 2C:1P | 265 / 252.5 | 212.5 / 232.5 | +20.74 · +8.9% · 0.87σ · 0.47× | -19.26 · -8.3% · -0.81σ · -0.44× | 12.5 / 20 | 45 | 693 / 893 | 262.5/247.5/210/230 2C:1P FQ 50 | 2 |
| 13 | NBIS | 2026-10-01 → 2026-10-09 (8) | 231.76 | LONG · 2C:1P | 265 / 252.5 | 232.5 / 212.5 | +20.74 · +8.9% · 0.44σ · 0.47× | +0.74 · +0.3% · 0.02σ · 0.02× | 12.5 / 20 | 45 | 693 / 893 | 255/242.5/217.5/232.5 2C:1P FQ 35 | 8 |
| 14 | NBIS | 2026-09-24 → 2026-10-02 (8) | 241 | SHORT · 2C:1P | 242.5 / 267.5 | 225 / 210 | +26.50 · +11.0% · 0.90σ · 0.59× | -16.00 · -6.6% · -0.55σ · -0.35× | 25 / 15 | -100 | 2210 / 1430 | 242.5/265/220/205 1C:2P FQ -95 | 2 |
| 15 | INTC | 2026-09-30 → 2026-10-02 (2) | 118 | SHORT · 1C:2P | 120 / 125 | 113 / 110 | +7.00 · +5.9% · 1.05σ · 0.44× | -5.00 · -4.2% · -0.75σ · -0.31× | 5 / 3 | -200 | 1050 / 950 | 119/125/113/109 1C:2P FQ -255 | 1 |
| 16 | BE | 2026-09-30 → 2026-10-02 (2) | 279.95 | LONG · 2C:1P | 297.5 / 290 | 262.5 / 275 | +10.05 · +3.6% · 0.54σ · 0.20× | -17.45 · -6.2% · -0.94σ · -0.34× | 7.5 / 12.5 | 80 | 754 / 1250 | 305/295/260/277.5 2C:1P FQ 100 | 3 |
| 17 | HOOD | 2026-09-30 → 2026-10-09 (9) | 114.55 | SHORT · 1C:2P | 116 / 124 | 108 / 103 | +9.45 · +8.3% · 0.89σ · 0.67× | -6.55 · -5.7% · -0.61σ · -0.46× | 8 / 5 | -220 | 1735 / 1255 | 115/123/107/102 1C:2P FQ -235 | 1 |
| 18 | BE | 2026-09-29 → 2026-10-02 (3) | 293.5 | SHORT · 1C:2P | 295 / 315 | 280 / 267.5 | +21.50 · +7.3% · 0.89σ · 0.42× | -13.50 · -4.6% · -0.56σ · -0.26× | 20 / 12.5 | -95 | 2030 / 1260 | 295/312.5/275/262.5 1C:2P FQ -90 | 2 |
| 19 | HOOD | 2026-09-25 → 2026-10-02 (7) | 118.5 | SHORT · 1C:2P | 119 / 126 | 112 / 108 | +7.50 · +6.3% · 0.81σ · 0.52× | -6.50 · -5.5% · -0.71σ · -0.45× | 7 / 4 | -220 | 3830 / 1070 | 119/126/112/108 1C:2P FQ -220 | 0 |
| 20 | PLTR | 2026-09-25 → 2026-10-02 (7) | 193.3 | SHORT · 1C:2P | 195 / 205 | 185 / 180 | +11.70 · +6.0% · 0.88σ · 0.68× | -8.30 · -4.3% · -0.62σ · -0.48× | 10 / 5 | -120 | 1315 / 655 | 197.5/207.5/185/180 1C:2P FQ -120 | 1 |
| 21 | BE | 2026-09-29 → 2026-10-02 (3) | 293.5 | SHORT · 1C:2P | 295 / 315 | 280 / 267.5 | +21.50 · +7.3% · 0.89σ · 0.42× | -13.50 · -4.6% · -0.56σ · -0.26× | 20 / 12.5 | -95 | 2030 / 1260 | 295/312.5/275/262.5 1C:2P FQ -90 | 2 |
| 22 | BE | 2026-09-29 → 2026-10-02 (3) | 293.5 | SHORT · 1C:2P | 295 / 315 | 280 / 267.5 | +21.50 · +7.3% · 0.89σ · 0.42× | -13.50 · -4.6% · -0.56σ · -0.26× | 20 / 12.5 | -95 | 2030 / 1260 | 295/312.5/275/262.5 1C:2P FQ -90 | 2 |
| 23 | PLTR | 2026-09-25 → 2026-10-02 (7) | 193.3 | SHORT · 1C:2P | 195 / 205 | 185 / 180 | +11.70 · +6.0% · 0.88σ · 0.68× | -8.30 · -4.3% · -0.62σ · -0.48× | 10 / 5 | -120 | 1315 / 655 | 197.5/207.5/185/180 1C:2P FQ -120 | 1 |
| 24 | CRCL | 2026-09-24 → 2026-10-02 (8) | 92.8 | SHORT · 1C:2P | 93 / 101 | 85 / 81 | +8.20 · +8.8% · 0.89σ · 0.50× | -7.80 · -8.4% · -0.85σ · -0.48× | 8 / 4 | -190 | 2112 / 1152 | 93/100/86/82 1C:2P FQ -220 | 1 |
| 25 | SPCX | 2026-09-17 → 2026-09-25 (8) | 154.85 | SHORT · 1C:2P | 157.5 / 165 | 146 / 142 | +10.15 · +6.5% · 1.30σ · —× | -8.85 · -5.7% · -1.13σ · —× | 7.5 / 4 | -95 | 955 / 531 | 157.5/162.5/147.5/145 1C:2P FQ -75 | 1.2 |
| 26 | BE | 2026-09-24 → 2026-10-02 (8) | 266.12 | SHORT · 1C:2P | 265 / 285 | 245 / 232.5 | +18.88 · +7.1% · 0.65σ · 0.36× | -21.12 · -7.9% · -0.73σ · -0.41× | 20 / 12.5 | -45 | 340 / 740 | 267.5/290/245/232.5 1C:2P FQ -45 | 2 |
| 27 | NBIS | 2026-09-24 → 2026-10-02 (8) | 241 | SHORT · 2C:1P | 242.5 / 267.5 | 225 / 210 | +26.50 · +11.0% · 0.90σ · 0.59× | -16.00 · -6.6% · -0.55σ · -0.35× | 25 / 15 | -100 | 2280 / 1430 | 242.5/265/220/205 1C:2P FQ -95 | 2 |
| 28 | BE | 2026-09-24 → 2026-10-02 (8) | 266.12 | SHORT · 1C:2P | 255 / 285 | 245 / 232.5 | +18.88 · +7.1% · 1.68σ · 0.36× | -21.12 · -7.9% · -1.88σ · -0.41× | 30 / 12.5 | -45 | 940 / 740 | 265/290/245/235 2C:1P FQ -60 | 4 |
| 29 | BE | 2026-09-24 → 2026-10-02 (8) | 266.12 | SHORT · 1C:2P | 265 / 285 | 245 / 232.5 | +18.88 · +7.1% · 0.65σ · 0.36× | -21.12 · -7.9% · -0.73σ · -0.41× | 20 / 12.5 | -45 | 940 / 740 | 267.5/290/245/230 1C:2P FQ -45 | 2 |
| 30 | CRCL | 2026-09-24 → 2026-10-02 (8) | 92.8 | SHORT · 1C:2P | 93 / 101 | 85 / 81 | +8.20 · +8.8% · 0.89σ · 0.50× | -7.80 · -8.4% · -0.85σ · -0.48× | 8 / 4 | -190 | 2112 / 1152 | 93/100/86/82 1C:2P FQ -220 | 1 |
| 31 | CRCL | 2026-09-24 → 2026-10-02 (8) | 92.8 | SHORT · 1C:2P | 93 / 100 | 85 / 81 | +7.20 · +7.8% · 0.79σ · 0.44× | -7.80 · -8.4% · -0.85σ · -0.48× | 7 / 4 | -190 | 2112 / 1152 | 93/100/86/82 1C:2P FQ -220 | 1 |
| 32 | CRWV | 2026-09-24 → 2026-10-02 (8) | 87.1 | SHORT · 1C:2P | 88 / 95 | 81 / 77 | +7.90 · +9.1% · 0.83σ · 0.44× | -6.10 · -7.0% · -0.64σ · -0.34× | 7 / 4 | -125 | 990 / 640 | 88/95/80/76 1C:2P FQ -130 | 1 |
| 33 | MSTR | 2026-09-23 → 2026-09-25 (2) | 164.17 | LONG · 2C:1P | 175 / 170 | 157.5 / 162.5 | +5.83 · +3.5% · 0.56σ · 0.28× | -6.67 · -4.1% · -0.64σ · -0.32× | 5 / 5 | 110 | 535 / 810 | 177.5/172.5/157.5/162.5 2C:1P FQ 110 | 1 |
| 34 | HOOD | 2026-09-24 → 2026-10-02 (8) | 121.56 | SHORT · 1C:2P | 124 / 132 | 115 / 110 | +10.44 · +8.6% · 0.64σ · 0.72× | -6.56 · -5.4% · -0.40σ · -0.45× | 8 / 5 | -120 | 1150 / 730 | 121/130/113/105 1C:2P FQ -160 | 5 |
| 35 | HOOD | 2026-09-21 → 2026-09-25 (4) | 122.13 | SHORT · 1C:2P | 123 / 130 | 116 / 113 | +7.87 · +6.4% · 0.79σ · 0.54× | -6.13 · -5.0% · -0.61σ · -0.42× | 7 / 3 | -200 | 1390 / 890 | 123/130/115/111 1C:2P FQ -215 | 2 |
| 36 | NBIS | 2026-09-23 → 2026-10-02 (9) | 229.8 | LONG · 2C:1P | 257.5 / 245 | 210 / 230 | +15.20 · +6.6% · 0.58σ · 0.34× | -19.80 · -8.6% · -0.75σ · -0.44× | 12.5 / 20 | 88 | 1150 / 2018 | 260/247.5/205/227.5 2C:1P FQ 95 | 2 |
| 37 | NBIS | 2026-09-23 → 2026-10-02 (9) | 229.8 | LONG · 2C:1P | 257.5 / 245 | 210 / 230 | +15.20 · +6.6% · 0.58σ · 0.34× | -19.80 · -8.6% · -0.75σ · -0.44× | 12.5 / 20 | 88 | 1150 / 2018 | 260/247.5/205/227.5 2C:1P FQ 95 | 2 |
| 38 | MSTR | 2026-09-23 → 2026-09-25 (2) | 164.17 | LONG · 2C:1P | 175 / 170 | 157.5 / 162.5 | +5.83 · +3.5% · 0.56σ · 0.28× | -6.67 · -4.1% · -0.64σ · -0.32× | 5 / 5 | 110 | 535 / 810 | 177.5/172.5/157.5/162.5 2C:1P FQ 110 | 1 |
| 39 | BE | 2026-09-17 → 2026-09-25 (8) | 280.14 | SHORT · 1C:2P | 228.5 / 310 | 255 / 240 | +29.86 · +10.7% · 0.88σ · 0.56× | -25.14 · -9.0% · -0.74σ · -0.47× | 81.5 / 15 | -88 | 2302.32 / 1642.32 | 282.5/305/255/240 1C:2P FQ -85 | 21.6 |
| 40 | NBIS | 2026-09-23 → 2026-10-02 (9) | 229.8 | LONG · 2C:1P | 257.5 / 245 | 210 / 230 | +15.20 · +6.6% · 0.58σ · 0.34× | -19.80 · -8.6% · -0.75σ · -0.44× | 12.5 / 20 | 88 | 1150 / 2018 | 260/247.5/205/227.5 2C:1P FQ 95 | 2 |
| 41 | NBIS | 2026-09-22 → 2026-09-25 (3) | 236.31 | SHORT · 1C:2P | 237.5 / 257.5 | 227.5 / 215 | +21.19 · +9.0% · 1.14σ · 0.47× | -8.81 · -3.7% · -0.47σ · -0.20× | 20 / 12.5 | -120 | 1560 / 1160 | 237.5/255/222.5/210 1C:2P FQ -110 | 2 |
| 42 | NBIS | 2026-09-22 → 2026-09-25 (3) | 236.31 | SHORT · 1C:2P | 237.5 / 257.5 | 227.5 / 215 | +21.19 · +9.0% · 1.14σ · 0.47× | -8.81 · -3.7% · -0.47σ · -0.20× | 20 / 12.5 | -120 | 1560 / 1160 | 237.5/255/222.5/210 1C:2P FQ -110 | 2 |
| 43 | CRCL | 2026-09-21 → 2026-09-25 (4) | 95.45 | SHORT · 1C:2P | 96 / 102 | 90 / 87 | +6.55 · +6.9% · 0.76σ · 0.40× | -5.45 · -5.7% · -0.63σ · -0.34× | 6 / 3 | -200 | 1470 / 870 | 97/103/89/86 1C:2P FQ -185 | 1 |
| 44 | CRCL | 2026-09-21 → 2026-09-25 (4) | 95.45 | SHORT · 1C:2P | 96 / 102 | 90 / 87 | +6.55 · +6.9% · 0.76σ · 0.40× | -5.45 · -5.7% · -0.63σ · -0.34× | 6 / 3 | -200 | 1470 / 870 | 97/103/89/86 1C:2P FQ -185 | 1 |
| 45 | CRCL | 2026-09-21 → 2026-09-25 (4) | 95.45 | SHORT · 1C:2P | 96 / 102 | 90 / 87 | +6.55 · +6.9% · 0.76σ · 0.40× | -5.45 · -5.7% · -0.63σ · -0.34× | 6 / 3 | -200 | 1470 / 870 | 97/103/89/86 1C:2P FQ -185 | 1 |
| 46 | MSTR | 2026-09-23 → 2026-09-25 (2) | 164.17 | LONG · 2C:1P | 175 / 170 | 157.5 / 162.5 | +5.83 · +3.5% · 0.56σ · 0.28× | -6.67 · -4.1% · -0.64σ · -0.32× | 5 / 5 | 110 | 535 / 810 | 177.5/172.5/157.5/162.5 2C:1P FQ 110 | 1 |
| 47 | NBIS | 2026-09-22 → 2026-09-25 (3) | 243 | SHORT · 1C:2P | 245 / 265 | 230 / 217.5 | +22.00 · +9.1% · 1.02σ · 0.49× | -13.00 · -5.3% · -0.60σ · -0.29× | 20 / 12.5 | -100 | 1690 / 1190 | 245/262.5/222.5/212.5 1C:2P FQ -115 | 3 |
| 48 | NBIS | 2026-09-22 → 2026-09-25 (3) | 236.31 | SHORT · 1C:2P | 237.5 / 257.5 | 227.5 / 215 | +21.19 · +9.0% · 1.14σ · 0.47× | -8.81 · -3.7% · -0.47σ · -0.20× | 20 / 12.5 | -120 | 1560 / 1160 | 237.5/255/222.5/210 1C:2P FQ -110 | 2 |
| 49 | CRCL | 2026-09-21 → 2026-09-25 (4) | 95.45 | SHORT · 1C:2P | 96 / 102 | 90 / 87 | +6.55 · +6.9% · 0.76σ · 0.40× | -5.45 · -5.7% · -0.63σ · -0.34× | 6 / 3 | -200 | 1470 / 870 | 97/103/89/86 1C:2P FQ -185 | 1 |
| 50 | HOOD | 2026-09-21 → 2026-09-25 (4) | 122.13 | SHORT · 1C:2P | 123 / 130 | 116 / 113 | +7.87 · +6.4% · 0.79σ · 0.54× | -6.13 · -5.0% · -0.61σ · -0.42× | 7 / 3 | -200 | 1590 / 890 | 123/130/115/111 1C:2P FQ -215 | 2 |
| 51 | PLTR | 2026-09-17 → 2026-09-25 (8) | 175.42 | LONG · 2C:1P | 190 / 185 | 162.5 / 172.5 | +9.58 · +5.5% · 0.78σ · 0.54× | -12.92 · -7.4% · -1.06σ · -0.73× | 5 / 10 | 120 | 895 / 1195 | 190/185/162.5/172.5 2C:1P FQ 125 | 0 |
| 52 | NBIS | 2026-09-17 → 2026-09-25 (8) | 216 | LONG · 2C:1P | 242.5 / 230 | 190 / 210 | +14.00 · +6.5% · 0.57σ · 0.30× | -26.00 · -12.0% · -1.07σ · -0.56× | 12.5 / 20 | 95 | 1320 / 1520 | 247.5/232.5/195/212.5 2C:1P FQ 95 | 2 |
| 53 | HOOD | 2026-09-21 → 2026-09-25 (4) | 122.13 | SHORT · 1C:2P | 123 / 130 | 116 / 113 | +7.87 · +6.4% · 0.79σ · 0.54× | -6.13 · -5.0% · -0.61σ · -0.42× | 7 / 3 | -200 | 1590 / 890 | 123/130/115/111 1C:2P FQ -215 | 2 |
| 54 | CRCL | 2026-09-21 → 2026-09-25 (4) | 95.45 | SHORT · 1C:2P | 96 / 102 | 90 / 87 | +6.55 · +6.9% · 0.76σ · 0.40× | -5.45 · -5.7% · -0.63σ · -0.34× | 6 / 3 | -200 | 1470 / 870 | 97/103/89/86 1C:2P FQ -185 | 1 |
| 55 | NBIS | 2026-09-21 → 2026-09-25 (4) | 228.35 | SHORT · 1C:2P | 230 / 247.5 | 212.5 / 205 | +19.15 · +8.4% · 0.90σ · 0.42× | -15.85 · -6.9% · -0.74σ · -0.35× | 17.5 / 7.5 | -120 | 2420 / 1370 | 230/250/212.5/200 1C:2P FQ -160 | 2 |
| 56 | PLTR | 2026-09-17 → 2026-09-25 (8) | 175.42 | LONG · 2C:1P | 190 / 185 | 162.5 / 172.5 | +9.58 · +5.5% · 0.78σ · 0.54× | -12.92 · -7.4% · -1.06σ · -0.73× | 5 / 10 | 135 | 1045 / 1345 | 192.5/185/162.5/175 2C:1P FQ 165 | 1 |
| 57 | PLTR | 2026-09-17 → 2026-09-25 (8) | 175.42 | LONG · 2C:1P | 190 / 185 | 162.5 / 172.5 | +9.58 · +5.5% · 0.78σ · 0.54× | -12.92 · -7.4% · -1.06σ · -0.73× | 5 / 10 | 120 | 895 / 1195 | 190/185/162.5/172.5 2C:1P FQ 125 | 0 |
| 58 | CRCL | 2026-09-16 → 2026-09-18 (2) | 81.4 | LONG · 2C:1P | 88 / 85 | 75 / 80 | +3.60 · +4.4% · 0.62σ · 0.23× | -6.40 · -7.9% · -1.10σ · -0.40× | 3 / 5 | 225 | 787 / 1037 | 89/86/76/81 2C:1P FQ 250 | 1 |
| 59 | CRCL | 2026-09-16 → 2026-09-18 (2) | 81.4 | LONG · 2C:1P | 88 / 85 | 75 / 80 | +3.60 · +4.4% · 0.62σ · 0.23× | -6.40 · -7.9% · -1.10σ · -0.40× | 3 / 5 | 225 | 787 / 1037 | 89/86/76/81 2C:1P FQ 250 | 1 |
| 60 | SPCX | 2026-09-17 → 2026-09-25 (8) | 154.85 | SHORT · 1C:2P | 157.5 / 165 | 146 / 142 | +10.15 · +6.5% · 1.01σ · —× | -8.85 · -5.7% · -0.88σ · —× | 7.5 / 4 | -95 | 955 / 531 | 157.5/162.5/150/146 1C:2P FQ -100 | 1.6 |
| 61 | BE | 2026-09-17 → 2026-09-25 (8) | 280.14 | SHORT · 1C:2P | 228.5 / 310 | 255 / 240 | +29.86 · +10.7% · 0.88σ · 0.56× | -25.14 · -9.0% · -0.74σ · -0.47× | 81.5 / 15 | -88 | 2302.32 / 1642.32 | 282.5/305/255/240 1C:2P FQ -85 | 21.6 |
| 62 | NBIS | 2026-09-17 → 2026-09-25 (8) | 216 | LONG · 1C:2P | 242.5 / 230 | 190 / 210 | +14.00 · +6.5% · 0.57σ · 0.30× | -26.00 · -12.0% · -1.07σ · -0.56× | 12.5 / 20 | 95 | 1320 / 1520 | 250/240/192.5/212.5 1C:2P FQ 365 | 4 |
| 63 | CRCL | 2026-09-16 → 2026-09-18 (2) | 81.4 | LONG · 2C:1P | 88 / 85 | 75 / 80 | +3.60 · +4.4% · 0.62σ · 0.23× | -6.40 · -7.9% · -1.10σ · -0.40× | 3 / 5 | 225 | 787 / 1037 | 89/86/76/81 2C:1P FQ 250 | 1 |
| 64 | PLTR | 2026-09-16 → 2026-09-18 (2) | 171 | LONG · 2C:1P | 185 / 177.5 | 157.5 / 167.5 | +6.50 · +3.8% · 0.77σ · 0.37× | -13.50 · -7.9% · -1.60σ · -0.76× | 7.5 / 10 | 110 | 797 / 597 | 182.5/177.5/160/170 2C:1P FQ 165 | 1 |
| 65 | NBIS | 2026-09-17 → 2026-09-25 (8) | 217.2 | SHORT · 1C:2P | 220 / 247.5 | 195 / 180 | +30.30 · +13.9% · 1.25σ · 0.65× | -22.20 · -10.2% · -0.91σ · -0.48× | 27.5 / 15 | -100 | 2260 / 1804 | 217.5/237.5/200/187.5 1C:2P FQ -140 | 4 |
| 66 | PLTR | 2026-09-16 → 2026-09-18 (2) | 171 | LONG · 2C:1P | 185 / 177.5 | 157.5 / 167.5 | +6.50 · +3.8% · 0.77σ · 0.37× | -13.50 · -7.9% · -1.60σ · -0.76× | 7.5 / 10 | 110 | 797 / 597 | 182.5/177.5/160/170 2C:1P FQ 165 | 1 |
| 67 | MSTR | 2026-09-10 → 2026-09-18 (8) | 130.51 | SHORT · 1C:2P | 130 / 140 | 122 / 117 | +9.49 · +7.3% · 0.66σ · 0.46× | -8.51 · -6.5% · -0.60σ · -0.41× | 10 / 5 | -200 | 2450 / 1050 | 131/141/120/114 1C:2P FQ -200 | 3 |
| 68 | BE | 2026-09-14 → 2026-09-18 (4) | 254 | LONG · 2C:1P | 290 / 275 | 230 / 250 | +21.00 · +8.3% · 0.86σ · 0.40× | -24.00 · -9.4% · -0.99σ · -0.45× | 15 / 20 | 90 | 1500 / 1460 | 285/267.5/230/252.5 2C:1P FQ 120 | 3 |
| 69 | NBIS | 2026-09-16 → 2026-09-18 (2) | 215 | SHORT · 1C:2P | 215 / 225 | 205 / 197.5 | +10.00 · +4.7% · 0.70σ · 0.21× | -10.00 · -4.7% · -0.70σ · -0.21× | 10 / 7.5 | -90 | 1040 / 840 | 217.5/232.5/202.5/192.5 1C:2P FQ -105 | 3 |
| 70 | CRCL | 2026-09-16 → 2026-09-18 (2) | 81.4 | LONG · 2C:1P | 88 / 85 | 75 / 80 | +3.60 · +4.4% · 0.62σ · 0.23× | -6.40 · -7.9% · -1.10σ · -0.40× | 3 / 5 | 225 | 787 / 1037 | 89/86/76/81 2C:1P FQ 250 | 1 |
| 71 | PLTR | 2026-09-16 → 2026-09-18 (2) | 171 | LONG · 2C:1P | 185 / 177.5 | 157.5 / 167.5 | +6.50 · +3.8% · 0.77σ · 0.37× | -13.50 · -7.9% · -1.60σ · -0.76× | 7.5 / 10 | 120 | 2872 / -1648 | 182.5/180/165/167.5 1C:2P FQ 45 | 3 |
| 72 | HOOD | 2026-09-10 → 2026-09-18 (8) | 114.1 | SHORT · 1C:2P | 115 / 122 | 108 / 104 | +7.90 · +6.9% · 0.79σ · 0.56× | -6.10 · -5.3% · -0.61σ · -0.43× | 7 / 4 | -200 | 1095 / 1005 | 115/122/107/103 1C:2P FQ -190 | 1 |
| 73 | SPCX | 2026-09-10 → 2026-09-18 (8) | 149.3 | SHORT · 1C:2P | 152.5 / 160 | 141 / 139 | +10.70 · +7.2% · —σ · —× | -8.30 · -5.6% · —σ · —× | 7.5 / 2 | -170 | 1805 / 945 | NO_LIQUIDITY | — |
| 74 | AMD | 2026-09-10 → 2026-09-18 (8) | 506.5 | SHORT · 1C:2P | 507.5 / 537.5 | 482.5 / 467.5 | +31.00 · +6.1% · 0.81σ · 0.51× | -24.00 · -4.7% · -0.63σ · -0.39× | 30 / 15 | -40 | 1225 / 379 | 507.5/537.5/480/465 1C:2P FQ -45 | 0.5 |
| 75 | BE | 2026-09-14 → 2026-09-18 (4) | 254 | LONG · 1C:2P | 290 / 275 | 230 / 250 | +21.00 · +8.3% · 0.86σ · 0.40× | -24.00 · -9.4% · -0.99σ · -0.45× | 15 / 20 | 90 | 1500 / 1460 | 285/267.5/230/252.5 2C:1P FQ 120 | 3 |
| 76 | BE | 2026-09-14 → 2026-09-18 (4) | 254 | LONG · 1C:2P | 290 / 275 | 230 / 250 | +21.00 · +8.3% · 0.86σ · 0.40× | -24.00 · -9.4% · -0.99σ · -0.45× | 15 / 20 | 90 | 1500 / 1460 | 285/267.5/230/252.5 2C:1P FQ 120 | 3 |
| 77 | HOOD | 2026-09-03 → 2026-09-11 (8) | 121.54 | SHORT · 1C:2P | 124 / 133 | 115 / 110 | +11.46 · +9.4% · 0.82σ · 0.85× | -6.54 · -5.4% · -0.47σ · -0.49× | 9 / 5 | -200 | 2330 / 1305 | 122/131/113/107 1C:2P FQ -230 | 3 |
| 78 | MSTR | 2026-09-03 → 2026-09-11 (8) | 139.92 | SHORT · 1C:2P | 141 / 153.5 | 131 / 127 | +13.58 · +9.7% · 0.94σ · 0.66× | -8.92 · -6.4% · -0.62σ · -0.43× | 12.5 / 4 | -180 | 2800 / 928 | 140/150/130/124 1C:2P FQ -215 | 3.5 |

## 8. Two-stage selection: sheet baseline + optimizer (deploy e30947a, 26 Oct 2026)

**Stage A, sheet baseline:** the 4 rule strikes from section 2, always given the full what-if.

**Stage B, optimizer:**
* Each short is searched from −0.35σ to +0.5σ of its sheet distance.
* The debit long and the wing width are searched ±2 listed strikes.
* Both ratios are tried, with a hard ceiling of 1.5σ.
* The 0.7–1.2σ zone clamp is now optional and **off by default**.
* The top 6 picks per side and ratio, plus every baseline, get the full what-if. The score includes a sheet-similarity prior: `geometry` 4 × the mean σ distance from the baseline.

**Override rule:** the optimizer pick wins only if all of these hold:
* its score is ≥ 5% better;
* its EV is not worse;
* its P(profit) is no more than 3 points lower;
* it passes every gate and risk cap.

A baseline that fails a gate, or cannot reach the target, loses to an acceptable pick.

**Per-lot-set mode:** when the baseline (or everything) cannot pay the per-lot target at the requested lot sets, or nothing passes the risk checks, the run is redone sized to the same **total** target. Both stages are then compared on an equal footing.

### Backtest (78 pages, reconstructed chains)

| Mode | Baseline ≤ 1 strike | Baseline ≤ 2 | Final pick ≤ 1 | Final pick ≤ 2 | Override rate (clear win / baseline gated / baseline unreachable) |
|---|---|---|---|---|---|
| Leave-one-trade-out | 73.1% | 88.0% | 66.6% | 84.4% | 37.3% (28 of 75: 19 / 5 / 4) |
| Leave-one-out | 74.7% | 89.9% | 66.9% | 84.4% | 30.7% (23 of 75: 16 / 5 / 2) |
| In-sample | 78.2% | 90.3% | 70.8% | 86.0% | 28.0% (21 of 75: 14 / 5 / 2) |

The final pick is by design less sheet-like than the baseline. It departs from the sheet only where the what-if shows a clearly better structure.

### Live (26 Oct 2026, expiry 30 Oct, $800 target = 2 lot sets × $400, Cboe delayed quotes from the 23 Oct close)

| Ticker | Recommended | Sheet baseline | Optimized | Why |
|---|---|---|---|---|
| HOOD (run 123) | **Optimized**, SHORT 1C:2P | +5 95C −5 103C +10 85P −10 89P, perp −245; CE +8.5% / PE −6.2%; exits $1,478 / $909; POP 52.0%, EV −$81, 2σ worst −$1,628, max loss −$2,063, capital $15,997. **Fails the 2% risk cap.** | +3 96C −3 100C +6 87P −6 92P, perp −140; CE +5.4% / PE −3.1%; exits $907 / $828; POP 57.6%, EV −$51, 2σ worst −$1,185, max loss −$1,434, capital $9,106 | The baseline fails the risk cap; the pick passes every gate. |
| SPY (run 124) | **Sheet baseline**, LONG 2C:1P | −6 767C +6 772C −3 750P +3 759P, +135 shares; CE +0.9% / PE −1.3%; exits $874 / $1,280; POP 63.5%, EV $141, 2σ worst −$1,295, max loss −$1,418, capital $54,198 | −4 765C +4 772C −2 752P +2 758P, +100 shares; exits $949 / $849; POP 65.5%, EV $134, 2σ worst −$1,182, max loss −$1,182, capital $40,211 | The pick has a better score but a lower EV ($134 < $141), so the baseline is kept. |
| AAPL | none (NO_LIQUIDITY) | — | — | Cboe refreshed AAPL (and HOOD) at 15:32 IST on 26 Oct with every bid and ask at 0 before the open; no quotes, so no structure. |

**Sizing:** neither HOOD nor SPY pays $400 per lot set at 2 lot sets on the 30 Oct expiry. Both were sized to $800 in total with 3 lot sets.

**Overrides:** across all live decisions (side × ratio), the optimizer won 2 of 4 decisions on HOOD and 3 of 4 on SPY. The *recommended* override rate is 1 of 2 tickers.
