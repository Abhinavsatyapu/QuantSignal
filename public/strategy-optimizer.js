// QuantSignal Strategy Optimizer: the user gives ticker + expiry + target P&L; everything else is decided here from the
// live chain and the app's own indicators. Pure functions (no network); loaded after strategy-engine.js in the browser and
// on the server. Extends globalThis.Strategy with { optimize, decideDirection, OPT_DEFAULTS, DEFAULT_WEIGHTS, hedgeFromStock }.
//
// Search: for each perp side (from the signal, or both when the signal is neutral) and both lot ratios (1C:2P, 2C:1P),
// enumerate debit-spread long/short strikes and credit-spread short/wing strikes inside expected-move bands, drop unquoted
// strikes (no bid, wide spread, low open interest), price every leg at mid ± a bid/ask haircut, size the perp to equalise
// today's P&L at the two short strikes (the CE-short / PE-short exits) rounded down to 5, size the lots so the projected
// expiry P&L at both exits reaches the target with the smallest residual, then rank by transparent weighted penalties.
(function (root) {
  "use strict";
  const S = root.Strategy;
  const fin = (x) => typeof x === "number" && Number.isFinite(x);
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  const sgn = (side) => (side === "buy" ? 1 : -1);
  const usd = (x) => (x < 0 ? "−$" : "$") + Math.round(Math.abs(x)).toLocaleString("en-US");
  const OPT_DEFAULTS = { mmLoss: 50, maxLots: 60, maxSpreadPct: null, minOpenInterest: 0, slippage: 0.5, commission: 0.65, futureFeePct: 0.045, marginDivisor: 2, leverage: 5, futuresRound: 5,
    thetaTolerancePct: 15, maxPriceGapPct: 5, riskSigma: 2, r: 0.04, capital: null, maxLossPct: null, topN: 3,
    // strike selection: "sheet" (default) = TWO STAGES. Stage A, the sheet baseline: the 4 strikes of the rule learned from
    // the reference sheets (docs/strike-selection-audit.md), always given the full what-if. Stage B, the optimizer: a wider
    // search around the baseline (each short from −searchBelowSigma to +searchAboveSigma of its sheet distance, capped at
    // hardMaxSigma; longs and wing widths ± searchLongSteps listed strikes). The optimizer pick replaces the baseline only if
    // it beats it clearly: score ≥ overrideMargin (5%) lower, EV not worse, P(profit) at most overrideMaxPopDrop (3 pts)
    // lower and every gate / risk cap passed (or the baseline itself fails a gate and the pick passes).
    // "band" = the older search over the whole short-distance band. atrBlend = weight of the sheet × weekly ATR distance
    // vs the sheet σ distance (0.5 = average of both, as measured best on the sheets; 0 = σ only).
    selection: "sheet", optimizerSearch: true, searchBelowSigma: 0.35, searchAboveSigma: 0.5, searchLongSteps: 2, hardMaxSigma: 1.5,
    overrideMargin: 0.05, overrideMaxPopDrop: 0.03, atrBlend: 0.5, snapIntoZone: false,
    // short-strike distance band, anchored to the reference sheets: each short is searched within
    // [sheetBandLow, sheetBandHigh] × the sheet distance for that short (per ticker, ratio and side), capped at maxShortSigma × σ.
    // minShortSigma / minShortAtr are optional floors (null = off): σ-to-expiry multiples / weekly-ATR multiples.
    // Zone [minShortSigma, maxShortSigma] (e.g. 0.7–1.2σ) = an optional sanity clamp on both shorts; OFF by default (the sheets'
    // credit short sits at ≈ 0.63σ, inside it). Band selection: blank minShortSigma → the sheet band itself is searched.
    sheetBandLow: 0.8, sheetBandHigh: 1.3, minShortSigma: null, minShortAtr: null, maxShortSigma: 1.2 };
  // Penalty weights (lower total = better). Stored server-side; tuned from recorded outcomes once enough runs are closed.
  const DEFAULT_WEIGHTS = { fit: 3, capital: 1, risk: 1, theta: 1, reference: 1.5, skew: 0.5, probability: 1, robustness: 2, tail: 1, exitFit: 2, ev: 1.5, pop: 1.5, shortAnchor: 8, geometry: 4, ratio: 2 };
  // geometry = sheet-similarity prior: mean σ distance of the 4 strikes from the sheet-baseline strikes (shorts ×1, longs ×½) — "sheet" selection
  // ratio = 1 when the lot ratio is not the sheets' usual one (credit spread 2× the debit lots: 1C:2P on a SHORT hedge, 2C:1P on a LONG)
  // shortAnchor = mean |σ distance − anchor| of the CE and PE shorts (anchor = max(sheet, zone midpoint) in the middle zone)
  // exitFit = shortfall of the P&L if an exit (CE / PE short) is hit TODAY vs the target; ev = −EV/target; pop = 1 − P(profit) (what-if, analysed candidates)
  const REF = { debitLongSigma: 0.1, debitShortSigma: 0.9, creditShortSigma: 0.63, wingSigma: 0.47 }; // pooled reference-sheet medians (fallback)
  // Sheet anchor per lot-ratio group: "credit2" = credit spread carries 2× the debit lots (the sheets' usual 1C:2P on a SHORT
  // hedge / 2C:1P on a LONG hedge), "credit05" = the other ratio. input.sheetAnchor comes from the server (per-ticker calibration).
  function sheetGroups(a) {
    const base = { ...REF, n: 0, source: "built-in pooled reference-sheet medians" }, g = (a && a.groups) || {};
    const fix = (x) => (x && fin(x.debitShortSigma) && fin(x.creditShortSigma) ? { ...base, ...x } : null);
    const c2 = fix(g.credit2) || base, c05 = fix(g.credit05) || c2;
    return { credit2: { ...c2, key: "credit2" }, credit05: { ...c05, key: "credit05" }, source: (a && a.source) || base.source };
  }
  const ZONE_TOL = 0.15; // σ a ±-strike variation may sit outside the short zone (sheet selection)
  const VARIANTS = [{ key: "1C:2P", call: 1, put: 2 }, { key: "2C:1P", call: 2, put: 1 }];
  const MOVES = [-10, -7, -5, -3, -2, -1, 0, 1, 2, 3, 5, 7, 10], IV_SHOCKS = [-20, -10, 0, 10, 20];
  const GATES = { minProbProfit: 0.35, maxTail2SigmaX: 4, minRobustHit: 0.25, minEvX: -0.5 }; // acceptable-risk gates (× target)
  const npdf = (x) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);

  // ---------------------------------------------------------------- WHAT-IF analysis for one structure
  // c: { legs, fq, fEntry, up, dn } · k: { spot, sigma, atmIV, T, basis, cfg, now, expiryMs, T0, events, funding }
  function whatIf(c, k) {
    const { spot, atmIV, T, basis, cfg, now, expiryMs, T0 } = k, days = T * 365, sd = spot * atmIV * Math.sqrt(T);
    const mkEv = (legs) => S.evaluate({ legs, future: { qty: c.fq, entry: c.fEntry, basis }, commission: cfg.commission, futureFeePct: cfg.futureFeePct, leverage: cfg.marginDivisor, r: cfg.r, nowMs: now, expiryMs });
    const ev = mkEv(c.legs), mm = cfg.mmLoss;
    const ivEv = (shock) => (shock === 0 ? ev : mkEv(c.legs.map((l) => ({ ...l, iv: Math.max(0.01, l.iv * (1 + shock / 100)) }))));
    const dates = [{ label: "Today", daysAhead: 0 }];
    if (days > 2) dates.push({ label: "Mid-life (" + (days / 2).toFixed(1) + "d)", daysAhead: days / 2 });
    if (days > 1.5) dates.push({ label: "1 day before expiry", daysAhead: days - 1 });
    dates.push({ label: "Expiry", daysAhead: null });
    const pnlAt = (e, x, d) => (d == null ? e.expiry(x) : e.at(x, d)) - mm;
    const pts = [...MOVES.map((m) => ({ label: (m > 0 ? "+" : "") + m + "%", kind: "move", pct: m, stock: spot * (1 + m / 100) })),
      ...c.legs.map((l) => ({ label: (l.side === "buy" ? "Long " : "Short ") + l.type + " strike " + l.strike, kind: "strike", stock: l.strike })),
      { label: "CE-short exit", kind: "exit", stock: c.up }, { label: "PE-short exit", kind: "exit", stock: c.dn },
      ...ev.breakevens.filter((b) => b > 0).map((b) => ({ label: "Breakeven (expiry, before MM)", kind: "breakeven", stock: b }))];
    const seen = new Set(), priceGrid = pts.filter((p) => { const key = p.label + p.stock; if (seen.has(key)) return false; seen.add(key); return true; }).sort((a, b) => a.stock - b.stock)
      .map((p) => ({ ...p, pct: (p.stock / spot - 1) * 100, perp: ev.perpAt(p.stock), pnl: dates.map((d) => pnlAt(ev, p.stock, d.daysAhead)) }));
    // IV shock × price heatmaps (today and mid-life), plus an IV-crush scenario (−40%) for earnings
    const shocks = [...IV_SHOCKS, -40], evs = shocks.map(ivEv), hm = (d) => MOVES.map((m) => evs.map((e) => pnlAt(e, spot * (1 + m / 100), d)));
    const midD = dates.find((d) => /Mid/.test(d.label)), ivGrid = { shocks, shockLabels: shocks.map((x) => (x === -40 ? "IV crush −40%" : (x > 0 ? "+" : "") + x + "%")), moves: MOVES, today: hm(0), midLife: midD ? hm(midD.daysAhead) : null, midLifeLabel: midD ? midD.label : null };
    // time decay: flat-price path
    const steps = Math.max(1, Math.min(60, Math.ceil(days))), flatPath = Array.from({ length: steps + 1 }, (_, i) => { const d = i === steps ? null : (days * i) / steps; return { day: i === steps ? days : d, pnl: pnlAt(ev, spot, d) }; });
    const optTheta = ev.greeks.theta;
    // tail risk
    let maxLoss = ev.unlimitedLoss ? null : ev.maxLoss, at = null;
    if (!ev.unlimitedLoss) { const vals = ev.kinks.map((x) => [x, ev.expiry(x)]); at = vals.reduce((m, v) => (v[1] < m[1] ? v : m))[0]; }
    const sig = (n) => ({ up: { stock: spot + n * sd, today: pnlAt(ev, spot + n * sd, 0), expiry: pnlAt(ev, spot + n * sd, null) }, down: { stock: Math.max(0.01, spot - n * sd), today: pnlAt(ev, Math.max(0.01, spot - n * sd), 0), expiry: pnlAt(ev, Math.max(0.01, spot - n * sd), null) } });
    const tail = { maxLossExpiry: maxLoss, maxLossAt: at, unlimitedLoss: ev.unlimitedLoss, unlimitedSide: ev.unlimitedLoss ? (ev.tailSlope < 0 ? "upside" : "downside") : null, sigma1: sd, sigma2: sig(2), sigma3: sig(3) };
    tail.worst2Sigma = Math.min(tail.sigma2.up.expiry, tail.sigma2.down.expiry, tail.sigma2.up.today, tail.sigma2.down.today);
    // probabilities (lognormal, ATM IV, risk-neutral drift) and expected value at expiry
    const pAbove = (x) => (x <= 0 ? 1 : S.cdf((Math.log(spot / x) + (cfg.r - atmIV * atmIV / 2) * T) / (atmIV * Math.sqrt(T))));
    let evSum = 0, pProfit = 0, pTarget = 0;
    for (let z = -6; z <= 6 + 1e-9; z += 0.01) { const x = spot * Math.exp((cfg.r - atmIV * atmIV / 2) * T + atmIV * Math.sqrt(T) * z), w = npdf(z) * 0.01, v = pnlAt(ev, x, null); evSum += w * v; if (v > 0) pProfit += w; if (v >= T0) pTarget += w; }
    const probs = { finishAboveCE: pAbove(c.up), finishBelowPE: 1 - pAbove(c.dn), touchCE: Math.min(1, 2 * pAbove(c.up)), touchPE: Math.min(1, 2 * (1 - pAbove(c.dn))), profit: pProfit, target: pTarget, expectedValue: evSum, model: "lognormal, ATM IV " + (atmIV * 100).toFixed(1) + "%, risk-neutral drift; 'touch' ≈ 2 × finish probability (reflection)" };
    // execution realism: mids vs the haircut fills, fees, margin, funding
    const midEv = mkEv(c.legs.map((l) => ({ ...l, premium: l.mid }))), fullEv = mkEv(c.legs.map((l) => ({ ...l, premium: l.side === "buy" ? l.ask : l.bid })));
    const fundingHours = Math.max(0, (expiryMs - now) / 36e5), notional = Math.abs(c.fq) * c.fEntry;
    const execution = { fillModel: "mid ± " + Math.round(cfg.slippage * 100) + "% of half-spread",
      exitsAtMid: { up: midEv.expiry(c.up) - mm, down: midEv.expiry(c.dn) - mm }, exitsAtHaircut: { up: ev.expiry(c.up) - mm, down: ev.expiry(c.dn) - mm }, exitsAtFullSpread: { up: fullEv.expiry(c.up) - mm, down: fullEv.expiry(c.dn) - mm },
      slippageCost: (midEv.expiry(c.up) - ev.expiry(c.up)), fees: { options: ev.optionFees, hedgeEntry: ev.futuresEntryFee, hedgeExitEst: notional * cfg.futureFeePct / 100 }, capital: ev.requiredCapital, futuresMargin: ev.futuresMargin, optionsCapital: ev.optionsCapital,
      funding: k.funding != null && fin(k.funding) ? { hourlyRate: k.funding, hours: fundingHours, estCost: Math.sign(c.fq) * notional * k.funding * fundingHours, note: "Hyperliquid funding at the current hourly rate held to expiry (positive = the position pays); rates change hourly." } : { note: k.isStock ? "Stock hedge: no funding (borrow cost for shorts not modelled)." : "Funding rate unavailable." } };
    // robustness: exits at mid-life / 1 day before × IV shocks −20…+20
    const cells = []; for (const d of dates.filter((x) => x.daysAhead != null && x.daysAhead > 0)) for (const [i, sh] of shocks.entries()) { if (sh === -40) continue; for (const [lab, x] of [["CE", c.up], ["PE", c.dn]]) cells.push({ date: d.label, shock: sh, exit: lab, pnl: pnlAt(evs[i], x, d.daysAhead) }); }
    const baseHit = ev.expiry(c.up) - mm >= T0 && ev.expiry(c.dn) - mm >= T0;
    const robustness = { baseCaseHitsTarget: baseHit, cells: cells.length, hitTarget: cells.filter((x) => x.pnl >= T0).length, hit80: cells.filter((x) => x.pnl >= 0.8 * T0).length, positive: cells.filter((x) => x.pnl > 0).length,
      worstCell: cells.length ? cells.reduce((m, x) => (x.pnl < m.pnl ? x : m)) : null, note: "Cells = {CE, PE exit} × {" + dates.filter((x) => x.daysAhead > 0).map((x) => x.label).join(", ") + "} × IV shock {−20, −10, 0, +10, +20}%. Exits reached before expiry still carry time value, so early exits usually pay less than the expiry projection." };
    robustness.hitRate = cells.length ? (robustness.hit80 + robustness.positive) / (2 * cells.length) : baseHit ? 1 : 0;
    robustness.positiveRate = cells.length ? robustness.positive / cells.length : baseHit ? 1 : 0;
    const ev_ = k.events || null, inWindow = (dd) => dd && dd >= new Date(now).toISOString().slice(0, 10) && dd <= k.expiry;
    const events = ev_ ? { ...ev_, earningsBeforeExpiry: inWindow(ev_.earningsDate), exDividendBeforeExpiry: inWindow(ev_.exDividendDate) } : { note: "Event calendar unavailable." };
    const gates = [];
    if (!baseHit) gates.push("base case misses the target at an exit");
    if (pProfit < GATES.minProbProfit) gates.push("probability of profit " + (pProfit * 100).toFixed(0) + "% < " + GATES.minProbProfit * 100 + "%");
    if (-tail.worst2Sigma > GATES.maxTail2SigmaX * T0) gates.push("loss on a 2σ move " + usd(tail.worst2Sigma) + " exceeds " + GATES.maxTail2SigmaX + "× the target");
    if (evSum < GATES.minEvX * T0) gates.push("expected value " + usd(evSum) + " below −" + (-GATES.minEvX * 100) + "% of target");
    if (cells.length && robustness.positiveRate < GATES.minRobustHit) gates.push("only " + robustness.positive + "/" + cells.length + " pre-expiry what-if cells (exits × dates × IV shocks) are profitable");
    // account-level risk limits (the user's own capital): breaches reject the candidate even if it hits the target
    const acct = cfg.account || null, minExit = Math.min(ev.expiry(c.up), ev.expiry(c.dn)) - mm;
    // risk = worst P&L anywhere inside ±kσ (k = account.riskSigma, default 2), today or at expiry. The perp/stock hedge makes the
    // loss open-ended beyond that window (a long perp's "max loss" is the price going to 0), so a stop is still needed outside it.
    const kS = (acct && acct.riskSigma) || cfg.riskSigma || 2, lo = Math.max(0.01, spot - kS * sd), hi = spot + kS * sd;
    let worstIn = 0, worstAt = spot, worstWhen = "expiry";
    for (let i = 0; i <= 80; i++) { const x = lo + (hi - lo) * i / 80; for (const [w, d] of [["today", 0], ["expiry", null]]) { const v = pnlAt(ev, x, d); if (v < worstIn) { worstIn = v; worstAt = x; worstWhen = w; } } }
    const riskLoss = -worstIn;
    const account = { riskLoss, riskSigma: kS, riskWindow: { lo, hi }, worstAt, worstWhen, riskLossBasis: "worst P&L inside ±" + kS + "σ (" + lo.toFixed(2) + "–" + hi.toFixed(2) + "), today or at expiry; outside that window the " + (k.isStock ? "stock" : "perp") + " hedge keeps losing, so use a stop at the limit",
      rewardToRisk: riskLoss > 0 ? minExit / riskLoss : null, returnOnMargin: ev.futuresMargin > 0 ? minExit / ev.futuresMargin : null, returnOnStructureCapital: ev.requiredCapital > 0 ? minExit / ev.requiredCapital : null };
    if (acct && acct.capital > 0) {
      Object.assign(account, { capital: acct.capital, returnOnAccount: minExit / acct.capital, maxLossPctAccount: riskLoss / acct.capital * 100, deployedPct: ev.requiredCapital / acct.capital * 100 });
      if (acct.maxLossPct > 0 && riskLoss > acct.capital * acct.maxLossPct / 100) gates.push("RISK LIMIT: max loss " + usd(-riskLoss) + " (" + account.maxLossPctAccount.toFixed(1) + "% of account) exceeds the " + acct.maxLossPct + "% per-structure limit (" + usd(-acct.capital * acct.maxLossPct / 100) + ")");
      if (acct.maxDeployPct > 0 && ev.requiredCapital > acct.capital * acct.maxDeployPct / 100) gates.push("RISK LIMIT: capital " + usd(ev.requiredCapital) + " (" + account.deployedPct.toFixed(0) + "% of account) exceeds the " + acct.maxDeployPct + "% max deployed per trade");
      if (acct.weeklyLossRemaining != null && riskLoss > acct.weeklyLossRemaining) gates.push("RISK LIMIT: max loss " + usd(-riskLoss) + " exceeds the remaining weekly loss budget " + usd(-acct.weeklyLossRemaining));
    }
    return { dates, priceGrid, ivGrid, theta: { optionsPerDay: optTheta, flatPath }, tail, probs, execution, robustness, events, account, gates, acceptable: gates.length === 0 };
  }

  // Direction from the app's indicator engine (Technicals.analyze output on the perp's candles).
  function decideDirection(m, override) {
    if (override === "BULLISH" || override === "LONG") return { sides: ["LONG"], side: "LONG", source: "manual", reason: "Manual override: bullish → LONG perp." };
    if (override === "BEARISH" || override === "SHORT") return { sides: ["SHORT"], side: "SHORT", source: "manual", reason: "Manual override: bearish → SHORT perp." };
    if (override === "BOTH") return { sides: ["LONG", "SHORT"], side: null, source: "manual", reason: "Manual: compare both perp sides." };
    if (!m || m.error) return { sides: ["LONG", "SHORT"], side: null, source: "none", reason: "Indicators unavailable" + (m && m.error ? " (" + m.error + ")" : "") + ": both perp sides compared, best score wins." };
    const desc = `${m.interval || ""} signal ${m.direction} ${m.score}/${m.maxScore}, trend ${m.trend} (EMA20 ${fin(m.ema20) ? m.ema20.toFixed(2) : "—"} vs EMA50 ${fin(m.ema50) ? m.ema50.toFixed(2) : "—"}), MACD momentum ${m.momentum}, RSI ${fin(m.rsi) ? m.rsi.toFixed(1) : "—"}`;
    if (m.direction === "LONG" || m.direction === "SHORT") return { sides: [m.direction], side: m.direction, source: "signal", strength: m.score / (m.maxScore || 8), reason: "Indicator signal " + m.direction + " → " + m.direction + " perp. " + desc + "." };
    const t = (m.trend === "UP" ? 1 : m.trend === "DOWN" ? -1 : 0) + (m.momentum === "UP" ? 1 : m.momentum === "DOWN" ? -1 : 0) + (m.rsi > 55 ? 1 : m.rsi < 45 ? -1 : 0);
    if (t >= 2) return { sides: ["LONG"], side: "LONG", source: "trend", reason: "No qualified signal, but trend/momentum/RSI lean up (" + t + "/3) → LONG perp. " + desc + "." };
    if (t <= -2) return { sides: ["SHORT"], side: "SHORT", source: "trend", reason: "No qualified signal, but trend/momentum/RSI lean down (" + t + "/3) → SHORT perp. " + desc + "." };
    // neutral lean: follow the EMA trend (EMA20 vs EMA50) rather than a pure score tie-break between the two sides
    const emaDir = fin(m.ema20) && fin(m.ema50) && m.ema20 !== m.ema50 ? (m.ema20 > m.ema50 ? "UP" : "DOWN") : m.trend === "UP" || m.trend === "DOWN" ? m.trend : null;
    if (emaDir) { const side = emaDir === "UP" ? "LONG" : "SHORT";
      return { sides: [side], side, source: "trend-neutral", reason: "No clear direction (lean " + t + "/3), so the EMA trend decides: EMA20 " + (fin(m.ema20) ? m.ema20.toFixed(2) : "—") + (emaDir === "UP" ? " above" : " below") + " EMA50 " + (fin(m.ema50) ? m.ema50.toFixed(2) : "—") + " (trend " + emaDir + ") → " + side + " perp (not a score tie-break). " + desc + "." }; }
    return { sides: ["LONG", "SHORT"], side: null, source: "neutral", reason: "No clear direction (lean " + t + "/3) and no EMA trend: both perp sides compared, best score wins. " + desc + "." };
  }
  // When the ticker has no Hyperliquid perp, hedge with shares (real stock quote; Reg-T 50% margin ≈ the same /2 rule).
  function hedgeFromStock(ticker, stock) {
    if (!stock || !(stock.price > 0)) return null;
    return { available: true, isStock: true, symbol: ticker + " shares", bid: stock.bid > 0 ? stock.bid : stock.price, ask: stock.ask > 0 ? stock.ask : stock.price, mid: stock.price, szDecimals: 0, maxLeverage: 2, time: stock.time };
  }
  const evenPick = (list, k) => (list.length <= k ? list : Array.from({ length: k }, (_, i) => list[Math.round(i * (list.length - 1) / (k - 1))]));

  // Per-lot-set target mode: if no strike set pays the per-lot-set target at 1× lots, fall back to sizing the lots so the
  // TOTAL reaches that target, and say so (the per-lot-set P&L actually achievable is shown).
  function optimize(input) {
    const out = optimizeCore(input), c = input.cfg || {};
    if (c.targetMode === "fixed" || out.status === "INVALID") return out;
    // per-lot-set mode: rerun sized to the same TOTAL target when nothing pays the per-lot target, when nothing passes the risk
    // checks at the requested lot sets, or when the sheet baseline of the recommended ratio cannot pay it (two-stage needs it)
    const rec = out.twoStage && out.twoStage.recommended, baseMissing = !!(rec && !rec.baseline);
    if (!(out.status === "TARGET_NOT_REACHABLE" || out.status === "NO_ACCEPTABLE_STRUCTURE" || baseMissing)) return out;
    const want = out.cfg ? out.cfg.targetPnl : null, L = (out.cfg && out.cfg.lotSets) || 1; if (!(want > 0)) return out;
    const alt = optimizeCore({ ...input, cfg: { ...c, targetMode: "fixed", targetPnl: want } });
    if (alt.status === "TARGET_NOT_REACHABLE" || (out.status === "OK" && alt.status !== "OK")) return out;
    if (out.status !== "OK" && alt.status !== "OK" && out.status === "NO_ACCEPTABLE_STRUCTURE") return out;
    const b = alt.best || (alt.rejected && alt.rejected[0]), per = b ? Math.min(b.exits[0].pnlExpiry, b.exits[1].pnlExpiry) / b.lotSets : null;
    alt.targetAdjusted = { requestedPerLotSet: want / L, requestedLotSets: L, lotSets: b ? b.lotSets : null, achievablePerLotSet: per, reason: out.status === "OK" ? "baseline" : out.status };
    const lead = out.status === "TARGET_NOT_REACHABLE" ? "No strike set on " + input.expiry + " pays $" + Math.round(want / L).toLocaleString("en-US") + " per lot set at " + L + " lot set" + (L > 1 ? "s" : "") + "."
      : out.status === "NO_ACCEPTABLE_STRUCTURE" ? "No structure at " + L + " lot set" + (L > 1 ? "s" : "") + " passes the what-if gates and risk caps." : "The sheet baseline does not pay $" + Math.round(want / L).toLocaleString("en-US") + " per lot set at " + L + " lot set" + (L > 1 ? "s" : "") + ".";
    alt.warnings = [lead + " Sized instead to reach $" + Math.round(want).toLocaleString("en-US") + " in total" + (b ? " with " + b.lotSets + " lot sets (≈ " + usd(per) + " per lot set)" : "") + "; every candidate, the sheet baseline included, is sized the same way. Use a later expiry for more per lot set.", ...(alt.warnings || [])];
    return alt;
  }
  function optimizeCore(input) {
    const cfg = { ...OPT_DEFAULTS, ...input.cfg }, W = Object.fromEntries(Object.entries({ ...DEFAULT_WEIGHTS, ...(input.weights || {}) }).filter(([k]) => k !== "liquidity")), errs = [], warnings = [];
    // target mode: "perLotSet" (default) → target = targetPerLotSet × lotSets, the lots are fixed at lotSets base units
    // (1 lot set = 1C:2P or 2C:1P); "fixed" → targetPnl is a total and the optimizer sizes the lots to reach it.
    const perLot = cfg.targetMode !== "fixed", L = Math.round(Number(cfg.lotSets) || 1);
    if (perLot && !(Number.isInteger(L) && L >= 1 && L <= cfg.maxLots)) errs.push("Lot sets must be a whole number 1–" + cfg.maxLots);
    const T0 = perLot ? Number(cfg.targetPerLotSet ?? 400) * L : cfg.targetPnl;
    cfg.targetPnl = T0; cfg.lotSets = perLot ? L : null; cfg.targetMode = perLot ? "perLotSet" : "fixed";
    if (!(fin(T0) && T0 > 0)) errs.push("Target P&L must be a positive dollar amount");
    if (cfg.callLotUnits != null || cfg.putLotUnits != null) if (![cfg.callLotUnits, cfg.putLotUnits].every((x) => Number.isInteger(x) && x >= 1 && x <= 10)) errs.push("Fixed lot ratio needs two whole numbers 1–10");
    if (!(cfg.slippage >= 0 && cfg.slippage <= 1)) errs.push("Bid/ask haircut must be 0–1 (0 = mid, 1 = full bid/ask)");
    if (!(cfg.marginDivisor >= 1 && cfg.marginDivisor <= 50)) errs.push("Futures margin divisor must be 1–50");
    if (!(cfg.futuresRound > 0)) errs.push("Futures rounding must be > 0");
    const off = (x) => x == null || x === "";
    if (off(cfg.minShortSigma)) cfg.minShortSigma = null; if (off(cfg.minShortAtr)) cfg.minShortAtr = null;
    if (!((cfg.minShortSigma == null || (fin(cfg.minShortSigma) && cfg.minShortSigma >= 0)) && (cfg.minShortAtr == null || (fin(cfg.minShortAtr) && cfg.minShortAtr >= 0)) && fin(cfg.maxShortSigma) && cfg.maxShortSigma > 0 && cfg.maxShortSigma <= 5 && (cfg.minShortSigma == null || cfg.minShortSigma < cfg.maxShortSigma)))
      errs.push("Short-distance band: optional min σ and min × ATR must be ≥ 0 (blank = off), max σ must be > min σ and ≤ 5");
    if (!(fin(cfg.sheetBandLow) && fin(cfg.sheetBandHigh) && cfg.sheetBandLow > 0 && cfg.sheetBandHigh > cfg.sheetBandLow && cfg.sheetBandHigh <= 3)) errs.push("Sheet band: low × must be > 0 and below high ×, high × ≤ 3");
    if (!["sheet", "band"].includes(cfg.selection)) errs.push('Strike selection must be "sheet" or "band"');
    cfg.optimizerSearch = cfg.optimizerSearch !== false && cfg.optimizerSearch !== "false"; for (const k of ["searchBelowSigma", "searchAboveSigma", "searchLongSteps", "hardMaxSigma", "overrideMargin", "overrideMaxPopDrop", "atrBlend"]) cfg[k] = +cfg[k];
    if (!(cfg.searchBelowSigma >= 0 && cfg.searchBelowSigma <= 1 && cfg.searchAboveSigma >= 0 && cfg.searchAboveSigma <= 1.5 && Number.isInteger(cfg.searchLongSteps) && cfg.searchLongSteps >= 0 && cfg.searchLongSteps <= 4 && cfg.hardMaxSigma > 0.3 && cfg.hardMaxSigma <= 3 && cfg.overrideMargin >= 0 && cfg.overrideMargin <= 0.5 && cfg.overrideMaxPopDrop >= 0 && cfg.overrideMaxPopDrop <= 0.3 && cfg.atrBlend >= 0 && cfg.atrBlend <= 1))
      errs.push("Optimizer search: below 0–1σ, above 0–1.5σ, long/wing steps 0–4, hard ceiling 0.3–3σ, override margin 0–50%, P(profit) drop 0–30 pts, ATR blend 0–1");
    if (errs.length) return { status: "INVALID", errors: errs };
    const now = input.nowMs ?? Date.now(), expiryMs = S.expiryCloseMs(input.expiry), T = (expiryMs - now) / (365 * 864e5);
    if (!(T > 0)) return { status: "INVALID", errors: ["Expiry " + input.expiry + " has passed"] };
    let hedge = input.perp && input.perp.available ? input.perp : null;
    if (!hedge) {
      hedge = hedgeFromStock(input.ticker, input.stock);
      if (!hedge) return { status: "NO_PERP", errors: [(input.perp && input.perp.reason) || "No Hyperliquid perp", "No stock quote either, so no hedge can be sized."] };
      warnings.push(((input.perp && input.perp.reason) || "No Hyperliquid US-stock perp for " + input.ticker) + " → hedging with " + input.ticker + " SHARES at the stock quote instead (Reg-T ≈ 50% margin). Stock hedges trade only in US market hours.");
    }
    const spot = input.stock && input.stock.price > 0 ? input.stock.price : hedge.mid;
    if (!(spot > 0)) return { status: "NO_DATA", errors: ["No underlying price"] };
    const priceGapPct = !hedge.isStock && input.stock && input.stock.price > 0 ? Math.abs(hedge.mid - input.stock.price) / input.stock.price * 100 : null;
    if (priceGapPct != null && priceGapPct > cfg.maxPriceGapPct) return { status: "PRICE_MISMATCH", errors: ["Hyperliquid " + hedge.symbol + " mid " + hedge.mid + " differs from the " + input.ticker + " stock price " + input.stock.price + " by " + priceGapPct.toFixed(1) + "% (limit " + cfg.maxPriceGapPct + "%): the perp may not track this stock, or a quote is stale."], spot, priceGapPct };
    const basis = hedge.isStock ? 0 : hedge.mid - spot;
    // ---- data sanity: skip strikes with no usable quote (no bid / ask, crossed) or no implied volatility so the maths stays defined
    const ctx = { spot, T, r: cfg.r, maxSpreadPct: cfg.maxSpreadPct }, group = input.contracts.filter((c) => c.expiry === input.expiry), excluded = {}, quotes = [];
    const ex = (k) => (excluded[k] = (excluded[k] || 0) + 1);
    for (const c of group) {
      const k = S.classify(c, ctx); if (!k.ok) { ex(k.reason); continue; }
      if (cfg.minOpenInterest > 0 && fin(c.openInterest) && c.openInterest < cfg.minOpenInterest) { ex("open interest below " + cfg.minOpenInterest); continue; }
      quotes.push(k.q);
    }
    const liquidity = { listed: group.length, usable: quotes.length, excluded };
    if (!group.length) return { status: "NO_DATA", errors: ["No contracts listed for " + input.expiry], liquidity };
    const calls = quotes.filter((q) => q.type === "call").sort((a, b) => a.strike - b.strike), puts = quotes.filter((q) => q.type === "put").sort((a, b) => a.strike - b.strike);
    if (calls.length < 3 || puts.length < 3) return { status: "NO_DATA", errors: ["Not enough quoted strikes on " + input.expiry + ": " + calls.length + " calls / " + puts.length + " puts have a usable quote (bid and ask) and an implied volatility. Try another expiry."], liquidity };
    const days = T * 365; if (days < 1) warnings.push("Expiry is less than a day away: gamma risk is extreme and the 'today' model is very sensitive.");
    const atm = quotes.slice().sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot)).slice(0, 4), atmIV = atm.reduce((n, q) => n + q.iv, 0) / atm.length, sigma = spot * atmIV * Math.sqrt(T);
    const band = (list, lo, hi) => { const g = list.filter((q) => q.strike >= lo && q.strike <= hi); return g.length ? g.reduce((n, q) => n + q.iv, 0) / g.length : null; };
    const putIV = band(puts, spot - sigma, spot - 0.25 * sigma), callIV = band(calls, spot + 0.25 * sigma, spot + sigma), skewPts = putIV != null && callIV != null ? (putIV - callIV) * 100 : null;
    const dir = decideDirection(input.market, cfg.direction);
    // Weekly ATR distances method: the CE / PE short strikes are fixed from the weekly ATR (see strategy-weekly-atr.js)
    let wa = null;
    if (input.weeklyAtr) {
      wa = S.resolveWeeklyAtrShorts(input.weeklyAtr, { spot, sigma, group, calls, puts, tradingDays: input.weeklyAtr.tradingDays ?? S.tradingDaysTo(input.expiry, now) });
      if (wa.errors) return { status: wa.errors.some((e) => /quoted/i.test(e)) ? "NO_DATA" : "INVALID", method: "weekly_atr", errors: wa.errors, liquidity, spot };
      warnings.push(...wa.warnings);
    }
    // short-strike distance band (optimizer only; the weekly-ATR method fixes the shorts itself): anchored to the reference
    // sheets. For each side × ratio, the debit-spread short and the credit-spread short are searched within
    // [sheetBandLow, sheetBandHigh] × the sheet σ distance, raised by the optional σ / weekly-ATR floors, capped at maxShortSigma.
    const bAtr = input.bandAtr && fin(input.bandAtr.atr) && input.bandAtr.atr > 0 ? input.bandAtr : null, SG = sheetGroups(input.sheetAnchor);
    const groupOf = (fs, v) => { const cr = fs === "SHORT" ? v.put : v.call, db = fs === "SHORT" ? v.call : v.put; return cr >= db ? SG.credit2 : SG.credit05; };
    const sideBand = (aRaw) => {
      // zone on: the short's scoring anchor = max(sheet distance, zone midpoint), clamped into the zone → the middle distance
      // unless the sheets for this ticker / ratio sit wider; zone off: the sheet distance itself
      const zLo = cfg.minShortSigma, zHi = cfg.maxShortSigma, mid = zLo != null ? (zLo + zHi) / 2 : null;
      const aSig = Math.min(zHi, Math.max(zLo ?? 0, mid != null ? Math.max(aRaw, mid) : aRaw));
      let lo, hi, binding;
      if (zLo != null) { lo = Math.max(zLo, Math.min(cfg.sheetBandLow * aSig, zLo)); hi = Math.min(zHi, Math.max(cfg.sheetBandHigh * aSig, zHi)); binding = "middle zone"; } // the whole zone (it contains the clamped sheet band)
      else { lo = cfg.sheetBandLow * aSig; hi = Math.min(cfg.sheetBandHigh * aSig, zHi); binding = "sheet"; }
      if (cfg.minShortAtr != null && bAtr && cfg.minShortAtr * bAtr.atr / sigma > lo) { lo = cfg.minShortAtr * bAtr.atr / sigma; binding = "weekly-ATR floor"; }
      if (hi < lo) hi = Math.max(lo, Math.min(zHi, lo + (cfg.sheetBandHigh - cfg.sheetBandLow) * aSig));
      return { sheetRawSigmas: aRaw, sheetSigmas: aSig, clampedToZone: Math.abs(aSig - aRaw) > 1e-9, zoneMid: mid, anchorRule: mid != null ? "max(sheet, zone midpoint " + mid.toFixed(2) + "σ) within the zone" : "sheet distance", loSigmas: lo, hiSigmas: hi, lo: lo * sigma, hi: hi * sigma, binding };
    };
    const distOf = (k) => ({ strike: k, dollars: k - spot, pct: (k / spot - 1) * 100, sigmas: (k - spot) / sigma, atrs: bAtr ? (k - spot) / bAtr.atr : null });
    const sheetDist = (sg) => ({ sigmas: sg, dollars: sg * sigma, pct: sg * sigma / spot * 100, atrs: bAtr ? sg * sigma / bAtr.atr : null });
    const variantsAll = cfg.callLotUnits != null ? [{ key: cfg.callLotUnits + "C:" + cfg.putLotUnits + "P", call: cfg.callLotUnits, put: cfg.putLotUnits }] : VARIANTS;
    const geoSel = !wa && cfg.selection === "sheet";
    const dband = wa ? null : { mode: geoSel ? (cfg.minShortSigma != null ? "sheet baseline + optimizer + zone clamp" : "sheet baseline + optimizer") : cfg.minShortSigma != null ? "middle zone + sheet anchor" : "sheet", selection: geoSel ? "sheet" : "band", optimizerSearch: cfg.optimizerSearch, searchBelowSigma: cfg.searchBelowSigma, searchAboveSigma: cfg.searchAboveSigma, searchLongSteps: cfg.searchLongSteps, hardMaxSigma: cfg.hardMaxSigma, atrBlend: cfg.atrBlend, conflicts: [], sheetBandLow: cfg.sheetBandLow, sheetBandHigh: cfg.sheetBandHigh, minShortSigma: cfg.minShortSigma, minShortAtr: cfg.minShortAtr, maxShortSigma: cfg.maxShortSigma, sigma,
      weeklyAtr: bAtr ? bAtr.atr : null, weeklyAtrSource: bAtr ? bAtr.source || null : null, anchorSource: SG.source, anchor: input.sheetAnchor || null, fallback: [], variants: [],
      note: bAtr ? null : (input.bandAtr && input.bandAtr.error ? "Weekly ATR unavailable (" + input.bandAtr.error + ")" : "Weekly ATR not supplied") + (cfg.minShortAtr != null ? ": the × weekly ATR floor is ignored." : "; distances are shown without the × ATR column.") };
    const vband = {};
    // ---- sheet-geometry rule (selection "sheet"): learned from the 78 reference pages (docs/strike-selection-audit.md)
    //  debit long  = first listed strike beyond spot in the debit direction (call above spot on a SHORT hedge, put below on a LONG)
    //  debit short = spot ± [(1−b)·sheet σ distance·σ + b·sheet × ATR·weekly ATR]; credit short the same on the other side;
    //  credit wing = credit short ∓ the same blend of the sheet wing; each snapped to the nearest quoted strike.
    //  The optional zone [minShortSigma, maxShortSigma] is a sanity clamp on the two shorts (recorded as a conflict when it binds).
    const ruleOf = (fs, g) => {
      const D = fs === "SHORT" ? calls : puts, C = fs === "SHORT" ? puts : calls, d = fs === "SHORT" ? 1 : -1, A = bAtr ? bAtr.atr : null;
      const blend = (sg, am) => (A && fin(am) && am > 0 && cfg.atrBlend > 0 ? (1 - cfg.atrBlend) * sg * sigma + cfg.atrBlend * am * A : sg * sigma);
      const zone = (dist, leg) => { const raw = dist / sigma, lo = cfg.minShortSigma, hi = lo != null ? Math.min(cfg.maxShortSigma, cfg.hardMaxSigma) : cfg.hardMaxSigma, z = Math.min(hi, Math.max(lo ?? 0, raw));
        if (Math.abs(z - raw) > 1e-9) dband.conflicts.push({ side: fs, group: g.key, leg, ruleSigmas: +raw.toFixed(3), clampedSigmas: +z.toFixed(3), note: leg + " rule " + raw.toFixed(2) + "σ is " + (raw < z ? "inside the " + lo + "σ zone minimum" : "beyond the " + hi + "σ " + (lo != null ? "zone maximum" : "hard ceiling")) + " → clamped to " + z.toFixed(2) + "σ" });
        return z * sigma; };
      const near = (list, x, ok = () => true) => list.filter((q) => ok(q.strike)).sort((p, q) => Math.abs(p.strike - x) - Math.abs(q.strike - x) || q.openInterest - p.openInterest)[0] || null;
      const dsD = zone(blend(g.debitShortSigma, g.debitShortAtr), "debit short"), csD = zone(blend(g.creditShortSigma, g.creditShortAtr), "credit short"), wD = blend(g.wingSigma, g.wingAtr);
      const otm = D.filter((q) => d * (q.strike - spot) > 1e-9).sort((p, q) => d * (p.strike - q.strike));
      // when the zone clamp bound a short, snap to the nearest strike that keeps it inside the zone (else plain nearest)
      const zoneMin = (D2, x) => (cfg.minShortSigma != null && Math.abs(D2 / sigma - cfg.minShortSigma) < 1e-9 ? (k) => Math.abs(k - spot) >= D2 - 1e-9 : () => true), zoneMax = (D2) => (Math.abs(D2 / sigma - cfg.maxShortSigma) < 1e-9 ? (k) => Math.abs(k - spot) <= D2 + 1e-9 : () => true);
      const nearZ = (list, x, ok, D2) => (cfg.snapIntoZone ? near(list, x, (k) => ok(k) && zoneMin(D2)(k) && zoneMax(D2)(k)) : null) || near(list, x, ok);
      const dl = otm[0] || near(D, spot), ds = nearZ(D, spot + d * dsD, (k) => d * (k - dl.strike) > 0, dsD), cs = nearZ(C, spot - d * csD, (k) => d * (spot - k) > 0, csD), cw = cs && near(C, cs.strike - d * wD, (k) => d * (cs.strike - k) > 0);
      return dl && ds && cs && cw ? { dl, ds, cs, cw, D, C, d, dist: { debitShort: dsD, creditShort: csD, wing: wD }, sig: { debitShort: dsD / sigma, creditShort: csD / sigma, wing: wD / sigma } } : null;
    };
    const zoneOn = cfg.minShortSigma != null, swin = (aSig) => [Math.max(zoneOn ? cfg.minShortSigma - ZONE_TOL : 0.15, aSig - cfg.searchBelowSigma), Math.min(cfg.hardMaxSigma, zoneOn ? cfg.maxShortSigma + ZONE_TOL : Infinity, aSig + cfg.searchAboveSigma)];
    const geoBand = (rule, leg, list, sgn) => { // the Stage-B optimizer window around a baseline short, in the sideBand() shape the UI reads
      const key = leg === "ds" ? "debitShort" : "creditShort", aSig = rule.sig[key], [w0, w1] = cfg.optimizerSearch ? swin(aSig) : [aSig, aSig];
      const inW = list.filter((q) => { const y = sgn * (q.strike - spot) / sigma; return y >= w0 - 1e-9 && y <= w1 + 1e-9; }), x = (inW.length ? inW : [rule[leg]]).map((q) => sgn * (q.strike - spot) / sigma);
      return { sheetRawSigmas: aSig, sheetSigmas: aSig, clampedToZone: dband.conflicts.some((c) => c.leg === (leg === "ds" ? "debit short" : "credit short") && Math.abs(c.clampedSigmas - aSig) < 1e-6), zoneMid: null, anchorRule: cfg.optimizerSearch ? "sheet baseline −" + cfg.searchBelowSigma + "σ / +" + cfg.searchAboveSigma + "σ (optimizer window)" : "sheet baseline only",
        loSigmas: Math.min(...x), hiSigmas: Math.max(...x), lo: Math.min(...x) * sigma, hi: Math.max(...x) * sigma, binding: "sheet geometry", ruleStrike: rule[leg].strike };
    };
    if (dband) for (const fs of dir.sides) for (const v of variantsAll) {
      const g = groupOf(fs, v), rule = geoSel ? ruleOf(fs, g) : null;
      const dB = rule ? geoBand(rule, "ds", rule.D, rule.d) : sideBand(g.debitShortSigma), cB = rule ? geoBand(rule, "cs", rule.C, -rule.d) : sideBand(g.creditShortSigma), ceB = fs === "SHORT" ? dB : cB, peB = fs === "SHORT" ? cB : dB;
      const e = { side: fs, variant: v.key, group: g.key, rawSheet: { debitShortSigma: g.debitShortSigma, creditShortSigma: g.creditShortSigma }, groupSource: g.source, groupN: g.n, debitLongSigma: g.debitLongSigma, wingSigma: g.wingSigma,
        sheet: { ce: { ...sheetDist(ceB.sheetSigmas), role: fs === "SHORT" ? "debit short" : "credit short", pctSheets: fs === "SHORT" ? g.debitShortPct ?? null : g.creditShortPct ?? null, atrSheets: fs === "SHORT" ? g.debitShortAtr ?? null : g.creditShortAtr ?? null },
          pe: { ...sheetDist(peB.sheetSigmas), role: fs === "SHORT" ? "credit short" : "debit short", pctSheets: fs === "SHORT" ? g.creditShortPct ?? null : g.debitShortPct ?? null, atrSheets: fs === "SHORT" ? g.creditShortAtr ?? null : g.debitShortAtr ?? null } },
        ce: ceB, pe: peB, rule: rule ? { debitLong: rule.dl.strike, debitShort: rule.ds.strike, creditShort: rule.cs.strike, wing: rule.cw.strike, ceShort: fs === "SHORT" ? rule.ds.strike : rule.cs.strike, peShort: fs === "SHORT" ? rule.cs.strike : rule.ds.strike, sigmas: rule.sig, dollars: rule.dist,
          blend: bAtr && cfg.atrBlend > 0 && fin(g.debitShortAtr) ? "σ " + (1 - cfg.atrBlend) + " / × ATR " + cfg.atrBlend + " (sheet × ATR " + g.debitShortAtr + " / " + g.creditShortAtr + " / wing " + g.wingAtr + ")" : "σ only" } : null };
      dband.variants.push(e); vband[fs + "|" + v.key] = { e, dB, cB, rule, g: { ...g, rawDebitShortSigma: g.debitShortSigma, rawCreditShortSigma: g.creditShortSigma, debitShortSigma: dB.sheetSigmas, creditShortSigma: cB.sheetSigmas, wingSigma: rule ? rule.sig.wing : g.wingSigma } };
    }
    if (dband && dband.note && cfg.minShortAtr != null) warnings.push(dband.note);
    const step = 10 ** -(hedge.szDecimals || 0), unit = Math.max(step, cfg.futuresRound), floorQ = (x) => Math.sign(x) * Math.floor(Math.abs(x) / unit + 1e-9) * unit;
    const price = (q, side) => (side === "buy" ? q.mid + cfg.slippage * (q.ask - q.mid) : q.mid - cfg.slippage * (q.mid - q.bid));
    const mk = (q, side, qty) => ({ type: q.type, side, strike: q.strike, qty, premium: r6(price(q, side)), iv: q.iv, greeks: q.greeks, multiplier: 100, contract: q.symbol, expiry: q.expiry, bid: q.bid, ask: q.ask, mid: q.mid, spreadPct: q.spreadPct, bidSize: q.bidSize, askSize: q.askSize, openInterest: q.openInterest, volume: q.volume, quoteTime: q.quoteTime, ivSource: q.ivSource, greeksSource: q.greeksSource, provider: q.provider });
    const variants = variantsAll;
    const riskLo = Math.max(0, spot - cfg.riskSigma * sigma), riskHi = spot + cfg.riskSigma * sigma, cands = [], misses = { notReachable: 0, overLots: 0, wrongSign: 0, overCapital: 0, overRisk: 0 };
    let best1 = -Infinity;
    for (const fs of dir.sides) {
      const D = fs === "SHORT" ? calls : puts, C = fs === "SHORT" ? puts : calls, d = fs === "SHORT" ? 1 : -1;
      const sd = (K) => d * (K - spot) / sigma; // signed σ distance on the debit side
      const vbs = variants.map((v) => vband[fs + "|" + v.key]).filter(Boolean);
      const dlAnchor = vbs.length ? vbs.reduce((m, x) => m + x.g.debitLongSigma, 0) / vbs.length : 0.1;
      const dLongs = evenPick(D.filter((q) => sd(q.strike) >= -0.15 && sd(q.strike) <= 0.4).sort((a, b) => Math.abs(sd(a.strike) - dlAnchor) - Math.abs(sd(b.strike) - dlAnchor)).slice(0, 3), 3);
      // shorts inside each variant's sheet band (debit side and credit side separately → asymmetric pairs); when no quoted strike
      // is inside a band, snap to the quoted strikes nearest to it and say so
      const allowed = (list, dist, B, typ, vb) => {
        const inBand = list.filter((q) => dist(q.strike) >= B.loSigmas - 1e-9 && dist(q.strike) <= B.hiSigmas + 1e-9);
        if (inBand.length) return inBand;
        const gap = (q) => { const x = dist(q.strike); return x < B.loSigmas ? B.loSigmas - x : x - B.hiSigmas; };
        const near = list.filter((q) => dist(q.strike) >= 0.1).sort((a, b) => gap(a) - gap(b)).slice(0, 2);
        const msg = "No quoted " + typ + " strike inside the sheet band " + B.lo.toFixed(2) + "–" + B.hi.toFixed(2) + " from spot (" + B.loSigmas.toFixed(2) + "–" + B.hiSigmas.toFixed(2) + "σ, sheet " + B.sheetSigmas.toFixed(2) + "σ) for " + fs + " " + vb.e.variant + "; using the nearest listed " + (near.length ? near.map((q) => q.strike + " (" + dist(q.strike).toFixed(2) + "σ)").join(", ") : "— none") + ".";
        if (!dband.fallback.includes(msg)) { dband.fallback.push(msg); warnings.push(msg); }
        vb.e.fallback = true; return near;
      };
      const typD = fs === "SHORT" ? "call (CE short)" : "put (PE short)", typC = fs === "SHORT" ? "put (PE short)" : "call (CE short)";
      if (!geoSel) for (const vb of vbs) { vb.dSet = new Set(allowed(D, sd, vb.dB, typD, vb).map((q) => q.strike)); vb.cSet = new Set(allowed(C, (k) => -sd(k), vb.cB, typC, vb).map((q) => q.strike)); }
      const uni = (list, key) => list.filter((q) => vbs.some((vb) => vb[key].has(q.strike)));
      const dsPool = dband && !geoSel ? uni(D, "dSet") : [], csPool = dband && !geoSel ? uni(C, "cSet") : [];
      const cShorts = dband ? evenPick(csPool, 7) : evenPick(C.filter((q) => -sd(q.strike) >= 0.3 && -sd(q.strike) <= 1.3), 5);
      const wMin = vbs.length ? Math.min(...vbs.map((x) => x.g.wingSigma)) : 0.47, wMax = vbs.length ? Math.max(...vbs.map((x) => x.g.wingSigma)) : 0.47;
      const wings = (cs) => { const w = (q) => d * (cs.strike - q.strike) / sigma, anch = C.filter((q) => w(q) >= Math.max(0.12, 0.5 * wMin) && w(q) <= Math.min(1.2, 1.6 * wMax));
        return evenPick(dband && anch.length ? anch : C.filter((q) => w(q) >= 0.2 && w(q) <= 1.0), 4); };
      const sets = [];
      if (wa) sets.push(...S.weeklyAtrStrikeSets(fs, wa, { spot, sigma, calls, puts }));
      else if (geoSel) for (const vb of vbs) {
        const R0 = vb.rule; if (!R0) continue;
        // Stage A: the sheet baseline, exactly the rule strikes
        const base = [R0.dl, R0.ds, R0.cs, R0.cw]; base.vKey = vb.e.variant; base.isBase = true; base.geo = 0; base.steps = { debitLong: 0, debitShort: 0, creditShort: 0, wing: 0 }; sets.push(base);
        if (!cfg.optimizerSearch) continue;
        // Stage B: the optimizer window around it
        const ix = (list, q) => list.indexOf(q), k0 = Math.abs(ix(R0.C, R0.cw) - ix(R0.C, R0.cs)), wRule = Math.abs(R0.cw.strike - R0.cs.strike) / sigma;
        const [d0, d1] = swin(R0.sig.debitShort), [c0, c1] = swin(R0.sig.creditShort), inS = (y, a2, b2) => y >= a2 - 1e-9 && y <= b2 + 1e-9;
        const dsL = evenPick(R0.D.filter((q) => inS(sd(q.strike), d0, d1)), 7), csL = evenPick(R0.C.filter((q) => inS(-sd(q.strike), c0, c1)), 7);
        const i0 = ix(R0.D, R0.dl), dlL = []; for (let j = -cfg.searchLongSteps; j <= cfg.searchLongSteps; j++) { const q = R0.D[i0 + j]; if (q && (q === R0.dl || sd(q.strike) >= -ZONE_TOL)) dlL.push(q); }
        for (const dl of dlL) for (const ds of dsL) { if (!(d * (ds.strike - dl.strike) > 0)) continue;
          for (const cs of csL) { if (!(d * (spot - cs.strike) > 0)) continue; const ic = ix(R0.C, cs);
            for (let j = -cfg.searchLongSteps; j <= cfg.searchLongSteps; j++) { const k = k0 + j; if (k < 1) continue; const cw = R0.C[ic - d * k]; if (!cw || !(d * (cs.strike - cw.strike) > 0)) continue;
              if (dl === R0.dl && ds === R0.ds && cs === R0.cs && cw === R0.cw) continue;
              const st = [dl, ds, cs, cw]; st.vKey = vb.e.variant;
              st.geo = (Math.abs(sd(ds.strike) - R0.sig.debitShort) + Math.abs(-sd(cs.strike) - R0.sig.creditShort) + 0.5 * (Math.abs(sd(dl.strike) - sd(R0.dl.strike)) + Math.abs(Math.abs(cs.strike - cw.strike) / sigma - wRule))) / 3;
              st.steps = { debitLong: Math.abs(ix(R0.D, dl) - i0), debitShort: Math.abs(ix(R0.D, ds) - ix(R0.D, R0.ds)), creditShort: Math.abs(ic - ix(R0.C, R0.cs)), wing: Math.abs(ix(R0.C, cw) - ix(R0.C, R0.cw)) };
              sets.push(st); } } }
      }
      else for (const dl of dLongs) for (const ds of evenPick((dband ? dsPool : D.filter((q) => sd(q.strike) >= 0.4 && sd(q.strike) <= 1.5)).filter((q) => d * (q.strike - dl.strike) > 0), dband ? 7 : 5))
        for (const cs of cShorts) for (const cw of wings(cs)) sets.push([dl, ds, cs, cw]);
      for (const set of sets) { const [dl, ds, cs, cw] = set;
          for (const v of variants) {
            const vb = vband[fs + "|" + v.key];
            if (geoSel) { if (set.vKey !== v.key) continue; } // each variant searches around its own sheet-rule strikes
            else if (vb && (!vb.dSet.has(ds.strike) || !vb.cSet.has(cs.strike))) continue; // outside this ratio's sheet band
            const g = vb ? vb.g : groupOf(fs, v);
            const dU = fs === "SHORT" ? v.call : v.put, cU = fs === "SHORT" ? v.put : v.call;
            const up = fs === "SHORT" ? ds.strike : cs.strike, dn = fs === "SHORT" ? cs.strike : ds.strike;
            const legsFor = (n) => [mk(dl, "buy", n * dU), mk(ds, "sell", n * dU), mk(cs, "sell", n * cU), mk(cw, "buy", n * cU)].sort((x, y) => (x.type === y.type ? x.strike - y.strike : x.type === "call" ? -1 : 1));
            const sized = (n) => {
              const legs = legsFor(n), probe = S.evaluate({ legs, future: { qty: 0, entry: 0, basis }, commission: 0, r: cfg.r, nowMs: now, expiryMs });
              const qRaw = (probe.at(dn, 0) - probe.at(up, 0)) / (up - dn), fq = r6(floorQ(qRaw));
              const fEntry = fq > 0 ? hedge.ask : fq < 0 ? hedge.bid : hedge.mid;
              const ev = S.evaluate({ legs, future: { qty: fq, entry: fEntry, basis }, commission: cfg.commission, futureFeePct: cfg.futureFeePct, leverage: cfg.marginDivisor, r: cfg.r, nowMs: now, expiryMs });
              return { n, legs, qRaw, fq, fEntry, ev, netUp: ev.expiry(up) - cfg.mmLoss, netDn: ev.expiry(dn) - cfg.mmLoss };
            };
            // per-lot exit P&L (unrounded perp) → first guess for n, then exact checks around it
            const one = sized(1), q1 = one.qRaw;
            if (fs === "LONG" ? !(q1 > 0) : !(q1 < 0)) { misses.wrongSign++; continue; }
            const ev1 = S.evaluate({ legs: one.legs, future: { qty: q1, entry: one.fEntry || hedge.mid, basis }, commission: cfg.commission, futureFeePct: cfg.futureFeePct, r: cfg.r, nowMs: now, expiryMs });
            const e1 = Math.min(ev1.expiry(up), ev1.expiry(dn));
            if (!(e1 > 0)) { misses.notReachable++; continue; }
            best1 = Math.max(best1, e1 * cfg.maxLots - cfg.mmLoss);
            const n0 = perLot ? L : Math.ceil((T0 + cfg.mmLoss) / e1);
            if (n0 > cfg.maxLots + 1) { misses.overLots++; continue; }
            let pick = null;
            // (the sheet baseline must always be evaluated: if it cannot pay the target at the requested lot sets, optimize() reruns
            // the whole search sized to the same total target, so baseline and optimizer picks are compared on an equal footing)
            const nMax = perLot ? L : Math.min(cfg.maxLots, n0 + 2);
            for (let n = perLot ? L : Math.max(1, n0 - 1); n <= nMax; n++) {
              const s = sized(n); if (!(Math.abs(s.fq) >= unit) || Math.sign(s.fq) !== (fs === "LONG" ? 1 : -1)) continue;
              if (Math.min(s.netUp, s.netDn) >= T0) { pick = s; break; }
            }
            if (!pick) { misses.notReachable++; continue; }
            const ev = pick.ev, capitalTotal = ev.requiredCapital;
            const worstRisk = -Math.min(...[riskLo, riskHi, spot, ...ev.kinks.filter((x) => x > riskLo && x < riskHi)].map(ev.expiry)) + cfg.mmLoss;
            if (cfg.capital && capitalTotal > cfg.capital) { misses.overCapital++; continue; }
            if (cfg.capital && cfg.maxLossPct && worstRisk > cfg.capital * cfg.maxLossPct / 100) { misses.overRisk++; continue; }
            const th = S.thetaCheck(pick.legs, cfg.thetaTolerancePct);
            const doubled = v.put > v.call ? "put" : v.call > v.put ? "call" : null, doubledIsCredit = doubled && (fs === "SHORT") === (doubled === "put");
            const rich = skewPts != null && Math.abs(skewPts) >= 2 ? (skewPts > 0 ? "put" : "call") : null;
            const sig = { debitLong: sd(dl.strike), debitShort: sd(ds.strike), creditShort: -sd(cs.strike), wing: Math.abs(cw.strike - cs.strike) / sigma };
            const factors = {
              fit: (Math.abs(pick.netUp - T0) + Math.abs(pick.netDn - T0)) / (2 * T0),
              capital: capitalTotal, // normalised below
              risk: worstRisk / Math.max(1, capitalTotal),
              theta: th.status === "DEBIT" ? 1 : th.status === "NEAR-NEUTRAL" ? 0.3 : 0,
              shortAnchor: vb ? (Math.abs(sig.debitShort - g.debitShortSigma) + Math.abs(sig.creditShort - g.creditShortSigma)) / 2 : 0,
              reference: (Math.abs(sig.debitShort - g.debitShortSigma) + Math.abs(sig.creditShort - g.creditShortSigma) + Math.abs(sig.wing - g.wingSigma)) / 3, // vs the sheet geometry for this ticker / ratio
              skew: rich && doubled === rich ? (doubledIsCredit ? -0.5 : 1) : 0,
              probability: 0,
            };
            const anchor = { group: g.key, source: g.source, rawDebitShortSigma: g.rawDebitShortSigma ?? g.debitShortSigma, rawCreditShortSigma: g.rawCreditShortSigma ?? g.creditShortSigma, debitLongSigma: g.debitLongSigma, debitShortSigma: g.debitShortSigma, creditShortSigma: g.creditShortSigma, wingSigma: g.wingSigma, ceSigmas: fs === "SHORT" ? g.debitShortSigma : g.creditShortSigma, peSigmas: -(fs === "SHORT" ? g.creditShortSigma : g.debitShortSigma) };
            if (geoSel) { factors.shortAnchor = 0; factors.reference = 0; factors.geometry = set.geo; }
            factors.ratio = g.key === "credit05" ? 1 : 0;
            cands.push({ fs, v, dl, ds, cs, cw, up, dn, ...pick, worstRisk, th, factors, sig, capitalTotal, doubled, doubledIsCredit, rich, anchor, steps: set.steps || null, rule: vb && vb.rule ? vb.e.rule : null, isBase: !!set.isBase, sizedUp: perLot && pick.n > L ? pick.n : null });
          }
      }
    }
    const common = { method: wa ? "weekly_atr" : "optimizer", weeklyAtr: wa ? wa.info : undefined, ticker: input.ticker, expiry: input.expiry, expiryCloseUtc: new Date(expiryMs).toISOString(), days, spot, spotSource: input.stock && input.stock.price > 0 ? input.stock.source : "hedge mid", basis, atmIV, expectedMove: sigma, ivSkew: { putIV, callIV, diffPts: skewPts },
      liquidity, cfg, weights: W, direction: dir, warnings, priceGapPct, hedgeType: hedge.isStock ? "STOCK" : "PERP",
      perp: { symbol: hedge.symbol, bid: hedge.bid, ask: hedge.ask, mid: hedge.mid, szDecimals: hedge.szDecimals, maxLeverage: hedge.maxLeverage, time: hedge.time, isStock: !!hedge.isStock }, searched: { candidates: cands.length, misses } };
    if (!cands.length) {
      const why = wa && !cands.length && !misses.wrongSign && !misses.notReachable && !misses.overLots && !misses.overCapital && !misses.overRisk ? "no strike set could be formed around the weekly-ATR shorts (CE " + wa.info.ceShort + " / PE " + wa.info.peShort + ")" : misses.wrongSign && !misses.notReachable && !misses.overLots ? "the equalising hedge has the wrong sign for every strike set" : "no strike set reaches $" + T0.toLocaleString("en-US") + " at both exits within " + cfg.maxLots + " lots" + (best1 > -Infinity ? " (best ≈ " + usd(best1) + ")" : "") + (misses.overCapital ? "; " + misses.overCapital + " exceeded your capital limit" : "") + (misses.overRisk ? "; " + misses.overRisk + " exceeded your max-loss limit" : "");
      return { ...common, status: "TARGET_NOT_REACHABLE", errors: ["Target not reachable: " + why + ". Lower the target or pick a later expiry."], bestAchievable: best1 > -Infinity ? best1 : null, variants: [] };
    }
    // ---- score: normalise capital, then shortlist and add probability
    const minCap = Math.min(...cands.map((c) => c.capitalTotal));
    const scoreOf = (c) => Object.entries(W).reduce((m, [k, w]) => m + w * (k === "capital" ? c.capitalTotal / minCap - 1 : c.factors[k] || 0), 0);
    for (const c of cands) c.score = scoreOf(c);
    cands.sort((a, b) => a.score - b.score);
    const short = cands.slice(0, 40);
    for (const c of short) {
      const lo = Math.max(0, spot - 3 * sigma), hi = spot + 3 * sigma, reg = S.regionAtLeast((x) => c.ev.expiry(x) - cfg.mmLoss, T0, lo, hi, c.ev.kinks, 240);
      c.region = reg; c.prob = reg.reduce((m, [x, y]) => m + S.probIn(spot, x, y >= hi - 1e-9 ? 1e12 : y, atmIV, T, cfg.r), 0); c.factors.probability = 1 - c.prob; c.score = scoreOf(c);
    }
    short.sort((a, b) => a.score - b.score);
    // ---- what-if on the top candidates (and the best of every side/variant), then rank by robustness
    const wk = { spot, sigma, atmIV, T, basis, cfg, now, expiryMs, T0, events: input.events || null, funding: hedge.isStock ? null : hedge.funding, isStock: !!hedge.isStock, expiry: input.expiry };
    const analysed = new Set(short.slice(0, 12)); for (const fs of dir.sides) for (const v of variants) { const c = short.find((x) => x.fs === fs && x.v.key === v.key) || cands.find((x) => x.fs === fs && x.v.key === v.key); if (c) analysed.add(c); }
    // wider pairs must get a what-if before they can win: the best candidate of every distinct (side, variant, CE, PE) pair is analysed too
    const pairKey = (c) => c.fs + "|" + c.v.key + "|" + c.up + "|" + c.dn, seenPair = new Set([...analysed].map(pairKey));
    for (const c of cands) { if (analysed.size >= 60) break; if (!seenPair.has(pairKey(c))) { seenPair.add(pairKey(c)); analysed.add(c); } }
    if (geoSel) for (const fs of dir.sides) for (const v of variants) { // two-stage: the baseline always gets the full what-if, and so do the top optimizer picks
      const inV = short.concat(cands).filter((x) => x.fs === fs && x.v.key === v.key), b0 = cands.find((x) => x.isBase && x.fs === fs && x.v.key === v.key); if (b0) analysed.add(b0);
      inV.filter((x) => !x.isBase).slice(0, 6).forEach((x) => analysed.add(x)); }
    for (const c of analysed) {
      c.whatIf = whatIf(c, wk);
      c.factors.robustness = 1 - c.whatIf.robustness.hitRate;
      c.factors.tail = Math.max(0, -c.whatIf.tail.worst2Sigma / T0 - 1) / 2;
      c.factors.exitFit = Math.max(0, T0 - Math.min(c.ev.at(c.up, 0), c.ev.at(c.dn, 0)) + cfg.mmLoss) / T0; // exit hit today vs target
      c.factors.ev = Math.max(-1, Math.min(2, -c.whatIf.probs.expectedValue / T0));
      c.factors.pop = 1 - c.whatIf.probs.profit;
      c.baseScore = c.score; c.score = scoreOf(c);
    }
    const ranked = [...analysed].sort((a, b) => (a.whatIf.acceptable === b.whatIf.acceptable ? a.score - b.score : a.whatIf.acceptable ? -1 : 1));
    const pool = ranked;
    // ---- two-stage decision per side × ratio: keep the sheet baseline unless the optimizer pick clearly beats it
    const decisions = new Map();
    if (geoSel) for (const fs of dir.sides) for (const v of variants) {
      const inV = ranked.filter((x) => x.fs === fs && x.v.key === v.key), base = inV.find((x) => x.isBase) || null, opt = inV.find((x) => !x.isBase) || null;
      if (!base && !opt) continue;
      const pct = (x) => (x * 100).toFixed(0) + "%", sh = (c) => "CE " + c.up + " / PE " + c.dn;
      let winner = base, why;
      if (!opt) why = "Sheet baseline (" + sh(base) + ") kept: the optimizer search found no other strike set that reaches the target.";
      else if (!base) { winner = opt; why = "Optimizer pick (" + sh(opt) + ") used: the sheet-baseline strikes cannot reach the target on this chain."; }
      else {
        const bw = base.whatIf, ow = opt.whatIf, need = base.score - cfg.overrideMargin * Math.abs(base.score);
        const fails = [];
        if (!ow.acceptable) fails.push("it fails a what-if gate (" + ow.gates[0] + ")");
        if (!(opt.score <= need + 1e-9)) fails.push("its score " + opt.score.toFixed(2) + " is not " + pct(cfg.overrideMargin) + " better than " + base.score.toFixed(2));
        if (ow.probs.expectedValue < bw.probs.expectedValue - 1e-9) fails.push("its EV " + usd(ow.probs.expectedValue) + " is worse than " + usd(bw.probs.expectedValue));
        if (ow.probs.profit < bw.probs.profit - cfg.overrideMaxPopDrop - 1e-9) fails.push("its P(profit) " + pct(ow.probs.profit) + " is more than " + (cfg.overrideMaxPopDrop * 100).toFixed(0) + " pts below " + pct(bw.probs.profit));
        if (!bw.acceptable && ow.acceptable) { winner = opt; why = "Optimizer pick (" + sh(opt) + ") used: the sheet baseline (" + sh(base) + ") fails a what-if gate (" + bw.gates[0] + ") and the pick passes every gate and risk cap."; }
        else if (!fails.length) { winner = opt; why = "Optimizer pick (" + sh(opt) + ") beats the sheet baseline (" + sh(base) + "): score " + opt.score.toFixed(2) + " vs " + base.score.toFixed(2) + ", EV " + usd(ow.probs.expectedValue) + " vs " + usd(bw.probs.expectedValue) + ", P(profit) " + pct(ow.probs.profit) + " vs " + pct(bw.probs.profit) + ", within every risk cap."; }
        else why = "Sheet baseline (" + sh(base) + ") kept: the best optimizer pick (" + sh(opt) + ") does not clearly beat it — " + fails[0] + ".";
      }
      decisions.set(fs + "|" + v.key, { fs, v, base, opt, winner, stage: winner === base ? "baseline" : "optimizer", why });
    }
    const winners = [...decisions.values()].map((x) => x.winner).sort((a, b) => (a.whatIf.acceptable === b.whatIf.acceptable ? a.score - b.score : a.whatIf.acceptable ? -1 : 1));
    const best = geoSel && winners.length ? winners[0] : pool[0];
    // every candidate considered (compact) — saved with the run as training data
    const strikesOf = (c) => c.legs.map((l) => (l.side === "buy" ? "+" : "-") + l.qty + " " + l.strike + (l.type === "call" ? "C" : "P")).join(" ");
    common.considered = cands.slice(0, 60).map((c) => ({ side: c.fs, variant: c.v.key, legs: strikesOf(c), perpQty: c.fq, exits: [Math.round(c.netUp), Math.round(c.netDn)], capital: Math.round(c.capitalTotal),
      sig: { dl: +c.sig.debitLong.toFixed(2), ds: +c.sig.debitShort.toFixed(2), cs: +c.sig.creditShort.toFixed(2), w: +c.sig.wing.toFixed(2) }, factors: Object.fromEntries(Object.entries(c.factors).map(([k2, v2]) => [k2, typeof v2 === "number" ? +v2.toFixed(4) : v2])),
      baseScore: c.baseScore != null ? +c.baseScore.toFixed(4) : null, score: c.score != null ? +c.score.toFixed(4) : null, analysed: !!c.whatIf, acceptable: c.whatIf ? c.whatIf.acceptable : null, gates: c.whatIf ? c.whatIf.gates : null, pProfit: c.whatIf ? +c.whatIf.probs.profit.toFixed(4) : null }));
    common.searched.considered = cands.length;
    const withSheet = (c) => distancesOf(c, { spot, sigma, bAtr });
    if (dband) {
      const bestPair = new Map(); for (const c of ranked) { const k = pairKey(c); if (!bestPair.has(k)) bestPair.set(k, c); }
      common.distanceBand = dband;
      common.pairsTested = bestPair.size; common.distancePairs = [...bestPair.values()].slice(0, 12).map((c) => ({ side: c.fs, variant: c.v.key, ...withSheet(c), sheetRef: c.whatIf ? c.factors.reference : null, exitUp: c.netUp, exitDown: c.netDn, exitUpToday: c.ev.at(c.up, 0) - cfg.mmLoss, exitDownToday: c.ev.at(c.dn, 0) - cfg.mmLoss,
        pop: c.whatIf.probs.profit, ev: c.whatIf.probs.expectedValue, worst2Sigma: c.whatIf.tail.worst2Sigma, score: c.score, acceptable: c.whatIf.acceptable, chosen: c === best, lots: c.v.key + " × " + c.n }));
    }
    const viewR = (f) => viewOf(f, { spot, sigma, atmIV, T, T0, cfg, hedge, dir, best, minCap, W, wa, bAtr });
    if (!best.whatIf.acceptable) {
      return { ...common, status: "NO_ACCEPTABLE_STRUCTURE", errors: ["No structure meets the target with acceptable risk. Best candidate (" + best.fs + " " + best.v.key + "): " + best.whatIf.gates.join("; ") + "." + (dband && geoSel ? " Shorts were searched around the sheet baseline (−" + cfg.searchBelowSigma + "σ / +" + cfg.searchAboveSigma + "σ of the sheet distance, ≤ " + cfg.hardMaxSigma + "σ): " + dband.variants.map((x) => x.side + " " + x.variant + " CE " + x.ce.loSigmas.toFixed(2) + "–" + x.ce.hiSigmas.toFixed(2) + "σ / PE " + x.pe.loSigmas.toFixed(2) + "–" + x.pe.hiSigmas.toFixed(2) + "σ").join(", ") + "; a later expiry or fewer lot sets may find an acceptable structure." : dband ? " Shorts were searched " + (dband.minShortSigma != null ? "in the middle zone " + dband.minShortSigma + "–" + dband.maxShortSigma + "σ (" : "inside the reference-sheet band (" + dband.sheetBandLow + "–" + dband.sheetBandHigh + "× the sheet distance: ") + dband.variants.map((x) => x.side + " " + x.variant + " CE " + x.ce.loSigmas.toFixed(2) + "–" + x.ce.hiSigmas.toFixed(2) + "σ / PE " + x.pe.loSigmas.toFixed(2) + "–" + x.pe.hiSigmas.toFixed(2) + "σ").join(", ") + "); a later expiry, fewer lot sets or a wider zone may find an acceptable structure." : "")], rejected: ranked.slice(0, 4).map(viewR), variants: [], gates: GATES };
    }
    const perVariant = []; for (const fs of dir.sides) for (const v of variants) { const dd = decisions.get(fs + "|" + v.key), c = dd ? dd.winner : pool.find((x) => x.fs === fs && x.v.key === v.key); perVariant.push({ fs, v, c }); }
    const alts = []; for (const c of pool.slice(1).filter((x) => x.whatIf.acceptable)) { if (alts.length >= cfg.topN) break; if (!alts.some((a) => a.ds === c.ds && a.cs === c.cs && a.v === c.v)) alts.push(c); }
    const view = (f) => viewOf(f, { spot, sigma, atmIV, T, T0, cfg, hedge, dir, best, minCap, W, wa, bAtr });
    const vs = perVariant.map(({ fs, v, c }) => c ? summarise(c, view(c), true) : { id: fs + " " + v.key, key: v.key, side: fs, reachable: false, errors: ["No " + v.key + " strike set reaches the target for a " + fs + " hedge"] });
    for (const x of vs) { x.recommended = x.id === best.fs + " " + best.v.key; const dd = decisions.get(x.side + "|" + x.key); if (dd) { x.stage = dd.stage; x.stageWhy = dd.why; } }
    // both stages, compact (cards + training record)
    const card = (c) => { if (!c) return null; const b = view(c), w = c.whatIf;
      return { stage: c.isBase ? "baseline" : "optimizer", side: c.fs, futuresSide: c.fs, variant: c.v.key, lotSets: b.lotSets, callLots: b.callLots, putLots: b.putLots, legs: b.legs.map((l) => ({ side: l.side, type: l.type, strike: l.strike, qty: l.qty, premium: l.premium })),
        sizedUp: c.sizedUp, futures: { signedQty: b.futures.signedQty }, perpQty: b.futures.signedQty, distances: b.distances, sigmas: c.sig, stepsFromRule: c.steps, exits: b.exits, capital: b.capital.total, maxLoss: b.maxLoss, unlimitedLoss: b.unlimitedLoss, worstLossInRiskWindow: b.worstLossInRiskWindow,
        theta: b.theta, score: c.score, geometry: c.factors.geometry ?? null, whatIf: w ? { acceptable: w.acceptable, gates: w.gates, pop: w.probs.profit, ev: w.probs.expectedValue, worst2Sigma: w.tail.worst2Sigma, worst3Sigma: w.tail.sigma3 ? Math.min(w.tail.sigma3.up.expiry, w.tail.sigma3.down.expiry) : null, riskLoss: w.account ? w.account.riskLoss : null, robustHit: w.robustness.hitRate, cells: w.robustness.cells, positive: w.robustness.positive } : null }; };
    const twoStage = geoSel ? { margin: cfg.overrideMargin, maxPopDrop: cfg.overrideMaxPopDrop, optimizerSearch: cfg.optimizerSearch, window: { belowSigma: cfg.searchBelowSigma, aboveSigma: cfg.searchAboveSigma, longSteps: cfg.searchLongSteps, hardMaxSigma: cfg.hardMaxSigma },
      searched: { baselineSets: cands.filter((x) => x.isBase).length, optimizerSets: cands.filter((x) => !x.isBase).length, analysed: analysed.size },
      decisions: [...decisions.values()].map((x) => ({ id: x.fs + " " + x.v.key, side: x.fs, variant: x.v.key, stage: x.stage, why: x.why, recommended: x.winner === best, baseline: card(x.base), optimized: card(x.opt) })) } : null;
    if (twoStage) { const r = twoStage.decisions.find((x) => x.recommended); twoStage.recommended = r || null; }
    const fmtF = (c) => Object.entries(W).map(([k, w]) => k + " " + (w * (k === "capital" ? c.capitalTotal / minCap - 1 : c.factors[k] || 0)).toFixed(2)).join(", ");
    const runner = perVariant.map((p) => p.c).filter((c) => c && c !== best).sort((a, b) => a.score - b.score)[0];
    const wf = (c) => c.whatIf ? "P(profit) " + (c.whatIf.probs.profit * 100).toFixed(0) + "%, EV " + usd(c.whatIf.probs.expectedValue) + ", " + c.whatIf.robustness.positive + "/" + c.whatIf.robustness.cells + " pre-expiry what-if cells profitable (" + c.whatIf.robustness.hit80 + " ≥80% of target), 2σ worst " + usd(c.whatIf.tail.worst2Sigma) + ", capital " + usd(c.capitalTotal) + ", theta " + c.th.status.toLowerCase() : "";
    const altBest = ranked.find((c) => c !== best);
    const reason = best.fs + " " + (hedge.isStock ? "shares" : "perp") + " · " + best.v.key + " recommended — robustness-ranked score " + best.score.toFixed(2) + " (lower is better): " + wf(best) + ". Factor breakdown: " + fmtF(best) + "." +
      (runner ? " Best other variant " + runner.fs + " " + runner.v.key + " scores " + runner.score.toFixed(2) + ": " + wf(runner) + (runner.whatIf && !runner.whatIf.acceptable ? " — fails: " + runner.whatIf.gates.join("; ") : "") + "." : "") +
      (altBest && altBest !== runner ? " Next candidate overall scores " + altBest.score.toFixed(2) + "." : "") + " Direction: " + dir.reason;
    const rd = decisions.get(best.fs + "|" + best.v.key);
    return { ...common, status: "OK", best: view(best), alternatives: alts.map(view), variants: vs, twoStage, recommendation: { mode: wa ? "weekly_atr" : "optimizer", id: best.fs + " " + best.v.key, key: best.v.key, side: best.fs, score: best.score, stage: rd ? rd.stage : null, why: rd ? rd.why : null, reason: (rd ? rd.why + " " : "") + reason } };
  }
  function summarise(c, b) {
    return { key: c.v.key, side: c.fs, id: c.fs + " " + c.v.key, callLotUnits: c.v.call, putLotUnits: c.v.put, status: "OK", reachable: true, callLots: b.callLots, putLots: b.putLots,
      legs: b.legs.map((l) => ({ side: l.side, type: l.type, strike: l.strike, qty: l.qty, premium: l.premium, contract: l.contract })), perpQty: b.futures.signedQty, futuresMargin: b.capital.futuresMargin,
      optionsCapital: b.capital.optionsCapital, totalCapital: b.capital.total, exits: b.exits, theta: b.theta, maxLoss: b.maxLoss, unlimitedLoss: b.unlimitedLoss, worstLossInRiskWindow: b.worstLossInRiskWindow,
      probability: b.target.probability, score: c.score, distances: b.distances, factors: b.factors, residual: b.residual, best: b, alternatives: [],
      points: Object.entries(b.factors).map(([k, x]) => ({ points: -x.weighted, why: k + " " + x.value })) };
  }
  // chosen CE / PE short distances ($, %, σ, × weekly ATR) next to the reference-sheet distance and the deviation from it
  function distancesOf(f, k) {
    const { spot, sigma, bAtr } = k, a = f.anchor || null;
    const one = (K, sheetSig) => { const x = { strike: K, dollars: K - spot, pct: (K / spot - 1) * 100, sigmas: (K - spot) / sigma, atrs: bAtr ? (K - spot) / bAtr.atr : null };
      if (sheetSig != null) { x.sheet = { sigmas: sheetSig, dollars: sheetSig * sigma, pct: sheetSig * sigma / spot * 100, atrs: bAtr ? sheetSig * sigma / bAtr.atr : null, strike: spot + sheetSig * sigma };
        x.deviation = { sigmas: x.sigmas - sheetSig, dollars: x.dollars - sheetSig * sigma, ratio: Math.abs(x.sigmas) / Math.abs(sheetSig) }; }
      return x; };
    const o = { ce: one(f.up, a ? a.ceSigmas : null), pe: one(f.dn, a ? a.peSigmas : null) };
    if (f.rule) { // sheet selection: the sheet reference is the rule strike itself (listed, quoted) and the steps away from it
      o.ce.sheet.strike = f.rule.ceShort; o.pe.sheet.strike = f.rule.peShort; o.ce.ruleStrike = f.rule.ceShort; o.pe.ruleStrike = f.rule.peShort;
      if (f.steps) { const ceRole = f.fs === "SHORT" ? "debitShort" : "creditShort", peRole = f.fs === "SHORT" ? "creditShort" : "debitShort"; o.ce.stepsFromRule = f.steps[ceRole]; o.pe.stepsFromRule = f.steps[peRole]; o.stepsFromRule = f.steps; }
      o.rule = f.rule;
    }
    return o;
  }
  function viewOf(f, k) {
    const { spot, sigma, atmIV, T, T0, cfg, hedge, dir, minCap, W, wa } = k, ev = f.ev;
    const gl = Math.max(0, spot - 2.5 * sigma), gh = spot + 2.5 * sigma;
    const xs = [...new Set([...Array.from({ length: 121 }, (_, i) => gl + (gh - gl) * i / 120), ...ev.kinks.filter((x) => x > gl && x < gh), spot, f.up, f.dn])].sort((a, b) => a - b);
    const callLots = f.legs.find((l) => l.type === "call").qty, putLots = f.legs.find((l) => l.type === "put").qty;
    const notional = Math.abs(f.fq) * f.fEntry;
    const factors = Object.fromEntries(Object.entries(W).map(([key, w]) => { const raw = key === "capital" ? f.capitalTotal / minCap - 1 : f.factors[key] || 0; return [key, { weight: w, value: +raw.toFixed(3), weighted: +(w * raw).toFixed(3) }]; }));
    const exits = [{ label: "CE short (upside exit / target)", price: f.up, perp: ev.perpAt(f.up), pnlToday: ev.at(f.up, 0) - cfg.mmLoss, pnlExpiry: f.netUp, residual: f.netUp - T0 },
      { label: "PE short (downside exit / target)", price: f.dn, perp: ev.perpAt(f.dn), pnlToday: ev.at(f.dn, 0) - cfg.mmLoss, pnlExpiry: f.netDn, residual: f.netDn - T0 }];
    const hedgeWord = hedge.isStock ? "shares" : "perp";
    const wi = wa && wa.info, pctS = (x) => (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(2) + "%", usd2 = (x) => (x < 0 ? "−$" : "+$") + Math.abs(x).toFixed(2);
    const why = [
      ...(wi ? ["Weekly ATR distances: weekly ATR $" + wi.atr.toFixed(2) + " (Wilder, N = " + wi.n + " completed weekly bars, " + (wi.source || "price history") + ")" + (wi.scaleToExpiry ? " × √(" + wi.tradingDays + " trading days ÷ 5) = " + wi.scale.toFixed(3) + " → $" + wi.effectiveAtr.toFixed(2) : "") +
        ". CE short " + wi.ceShort + " = nearest listed strike to spot " + spot.toFixed(2) + " + " + wi.upperMult + " × $" + wi.effectiveAtr.toFixed(2) + " (" + wi.ceTarget.toFixed(2) + "): " + usd2(wi.ceDistance.dollars) + " / " + pctS(wi.ceDistance.pct) + ". PE short " + wi.peShort + " = nearest to spot − " + wi.lowerMult + " × ATR (" + wi.peTarget.toFixed(2) + "): " + usd2(wi.peDistance.dollars) + " / " + pctS(wi.peDistance.pct) +
        ". Long legs placed as in the reference-sheet method (debit long ≈ " + wi.debitLongSigma + "σ OTM, credit wing ≈ " + wi.wingSigma + "σ beyond the credit short)."] : []),
      "Direction: " + dir.reason + (dir.sides.length > 1 ? " Chosen side: " + f.fs + " (better score)." : ""),
      "Debit " + (f.fs === "SHORT" ? "call" : "put") + " spread " + f.dl.strike + "/" + f.ds.strike + " (" + f.sig.debitLong.toFixed(2) + "σ / " + f.sig.debitShort.toFixed(2) + "σ), credit " + (f.fs === "SHORT" ? "put" : "call") + " spread " + f.cs.strike + "/" + f.cw.strike + " (short " + f.sig.creditShort.toFixed(2) + "σ, wing " + f.sig.wing.toFixed(2) + "σ beyond); σ = $" + sigma.toFixed(2) + " from ATM IV " + (atmIV * 100).toFixed(1) + "% over " + (T * 365).toFixed(1) + " days. Reference-sheet geometry for this ratio (" + (f.anchor ? f.anchor.source : "pooled") + "): debit long " + (f.anchor || REF).debitLongSigma + "σ / debit short " + (f.anchor || REF).debitShortSigma + "σ / credit short " + (f.anchor || REF).creditShortSigma + "σ / wing " + (f.anchor || REF).wingSigma + "σ.",
      cfg.targetMode === "perLotSet" ? "Lots " + f.v.key + ": " + callLots + " calls : " + putLots + " puts = " + Math.round(callLots / f.v.call) + " lot set(s); target $" + (T0 / Math.round(callLots / f.v.call)).toLocaleString("en-US") + " per lot set → $" + T0.toLocaleString("en-US") + " total (upside " + usd(f.netUp) + ", downside " + usd(f.netDn) + ")." :
      "Lots " + f.v.key + ": " + callLots + " calls : " + putLots + " puts — the smallest size whose projected expiry P&L at both exits reaches $" + T0.toLocaleString("en-US") + " (upside " + usd(f.netUp) + ", downside " + usd(f.netDn) + "; residual " + usd(f.netUp - T0) + " / " + usd(f.netDn - T0) + ").",
      (hedge.isStock ? "Stock hedge " : "Perp ") + hedge.symbol + ": " + Math.abs(f.fq) + " units " + (f.fq > 0 ? "LONG" : "SHORT") + " = today's-P&L equalising quantity at the PE short " + f.dn + " and CE short " + f.up + " (" + Math.abs(f.qRaw).toFixed(2) + ") rounded down to a multiple of " + cfg.futuresRound + ".",
      "Fill model: mid ± " + Math.round(cfg.slippage * 100) + "% of the half-spread (long legs pay above mid, short legs receive below mid); MM/basket allowance " + usd(cfg.mmLoss) + ".",
      "Theta " + f.th.theta.toFixed(2) + " $/day → " + f.th.status + ". Score " + f.score.toFixed(2) + " = " + Object.entries(factors).map(([kk, x]) => kk + " " + x.weighted).join(" + ") + ".",
    ];
    return {
      signal: f.fs === "LONG" ? "BULLISH" : "BEARISH", futuresSide: f.fs, hedgeType: hedge.isStock ? "STOCK" : "PERP", variant: f.v.key, lotRule: f.v.call + ":" + f.v.put, lotSource: "optimizer", callLots, putLots, lots: f.n, scenarioPrices: { up: f.up, down: f.dn },
      sigmas: f.sig, sheetAnchor: f.anchor || null, distances: distancesOf(f, k), legs: f.legs.map((l) => ({ ...l, positionDelta: sgn(l.side) * l.qty * 100 * l.greeks.delta, cashFlow: -sgn(l.side) * l.qty * 100 * l.premium })),
      futures: { symbol: hedge.symbol, isStock: !!hedge.isStock, side: f.fq > 0 ? "LONG" : "SHORT", qty: Math.abs(f.fq), signedQty: f.fq, entry: f.fEntry, notional, equalisingQty: r6(f.qRaw), roundTo: cfg.futuresRound, deltaNeutralQty: r6(-ev.greeks.optionDelta), margin: ev.futuresMargin, marginDivisor: cfg.marginDivisor, leverage: cfg.leverage, venueInitialMargin: notional / cfg.leverage, minNotionalOk: notional >= 10 },
      exits, residual: { up: f.netUp - T0, down: f.netDn - T0, meanAbs: (Math.abs(f.netUp - T0) + Math.abs(f.netDn - T0)) / 2 }, theta: f.th,
      capital: { futuresNotional: notional, futuresMargin: ev.futuresMargin, marginDivisor: cfg.marginDivisor, leverage: cfg.leverage, venueInitialMargin: notional / cfg.leverage, optionsCapital: ev.optionsCapital, fees: ev.optionFees + ev.futuresEntryFee, total: ev.requiredCapital,
        formula: "Total = " + (hedge.isStock ? "stock" : "futures") + " margin (qty × entry / " + cfg.marginDivisor + ") + options capital (max loss of each defined-risk spread) + entry fees. Venue initial margin at " + cfg.leverage + "× = qty × entry / " + cfg.leverage + "." },
      netCreditDebit: ev.netCreditDebit, maxProfit: ev.maxProfit, maxLoss: ev.maxLoss, unlimitedProfit: ev.unlimitedProfit, unlimitedLoss: ev.unlimitedLoss, breakevens: ev.breakevens,
      worstLossInRiskWindow: f.worstRisk, riskWindow: [Math.max(0, spot - cfg.riskSigma * sigma), spot + cfg.riskSigma * sigma], greeks: ev.greeks, optionsCapital: ev.optionsCapital, futuresMargin: ev.futuresMargin, requiredCapital: ev.requiredCapital,
      fees: { options: ev.optionFees, futuresEntry: ev.futuresEntryFee }, mmLoss: cfg.mmLoss,
      expected: { upExpiry: f.netUp, downExpiry: f.netDn, upToday: ev.at(f.up, 0) - cfg.mmLoss, downToday: ev.at(f.dn, 0) - cfg.mmLoss, unchangedExpiry: ev.expiry(spot) - cfg.mmLoss },
      target: { pnl: T0, prices: [f.dn, f.up], regions: (f.region || []).map(([a, b]) => [a, b >= spot + 3 * sigma - 1e-9 ? null : b]), probability: f.prob ?? null },
      scenarios: [["Today · up to CE short", f.up, 0], ["Today · down to PE short", f.dn, 0], ["Expiry · up at " + f.up, f.up, null], ["Expiry · down at " + f.dn, f.dn, null]].map(([name, x, d]) => ({ name, stock: x, perp: ev.perpAt(x), pnl: (d == null ? ev.expiry(x) : ev.at(x, d)) - cfg.mmLoss })),
      thinSize: f.legs.filter((l) => !fin(l.side === "buy" ? l.askSize : l.bidSize) || (l.side === "buy" ? l.askSize : l.bidSize) < l.qty).map((l) => l.contract),
      lotSets: Math.round(callLots / f.v.call), targetMode: cfg.targetMode, perLotSet: { target: T0 / Math.round(callLots / f.v.call), up: f.netUp / Math.round(callLots / f.v.call), down: f.netDn / Math.round(callLots / f.v.call) },
      liquidityCheck: sizeCheck(f.legs), whatIf: f.whatIf || null, baseScore: f.baseScore ?? f.score, factors, score: f.score, why, friction: f.legs.reduce((m, l) => m + (l.ask - l.bid) * l.qty * 100, 0),
      curve: xs.map((x) => ({ stock: x, expiry: ev.expiry(x) - cfg.mmLoss, today: ev.at(x, 0) - cfg.mmLoss })),
    };
  }
  // ---- size checks and instant rescaling (browser + server share this)
  // order size vs the market is not considered (the owner sizes and works the orders); kept as a no-op for callers
  function sizeCheck() { return { ok: true, flags: [], blocking: [] }; }

  // Rescale a built structure to `lotSets` lot sets: legs × factor, perp re-equalised then floored to the rounding unit,
  // target = per-lot-set target × lotSets, and the full what-if re-run on the same quotes.
  function rescale(out, best, lotSets) {
    const L0 = best.lotSets || 1, f = lotSets / L0, cfg = out.cfg, unit = cfg.futuresRound || 5;
    if (!(Number.isInteger(lotSets) && lotSets >= 1)) throw Error("Lot sets must be a whole number ≥ 1");
    const legs = best.legs.map((l) => ({ ...l, qty: Math.round(l.qty * f) }));
    const qRaw = best.futures.equalisingQty * f, fq = Math.sign(qRaw) * Math.floor(Math.abs(qRaw) / unit + 1e-9) * unit;
    const up = best.exits[0].price, dn = best.exits[1].price, perLotT = best.perLotSet ? best.perLotSet.target : cfg.targetPnl / L0;
    const T0 = perLotT * lotSets, expiryMs = Date.parse(out.expiryCloseUtc), now = Date.now();
    const ev = S.evaluate({ legs, future: { qty: fq, entry: best.futures.entry, basis: out.basis || 0 }, commission: cfg.commission, futureFeePct: cfg.futureFeePct, leverage: cfg.marginDivisor, r: cfg.r, nowMs: now, expiryMs });
    const w = best.whatIf;
    const wi = whatIf({ legs, fq, fEntry: best.futures.entry, up, dn }, { spot: out.spot, sigma: out.expectedMove, atmIV: out.atmIV, T: Math.max(1e-6, (expiryMs - now) / (365 * 864e5)), basis: out.basis || 0, cfg, now, expiryMs, T0,
      events: w && w.events && w.events.source ? w.events : null, funding: w && w.execution.funding ? w.execution.funding.hourlyRate : null, isStock: !!best.futures.isStock, expiry: out.expiry });
    const netUp = ev.expiry(up) - cfg.mmLoss, netDn = ev.expiry(dn) - cfg.mmLoss, liq = sizeCheck(legs);
    const flags = [...wi.gates.filter((g) => /RISK LIMIT/.test(g)), ...liq.blocking];
    if (Math.min(netUp, netDn) < T0) flags.unshift("At " + lotSets + " lot sets the exits pay " + usd(netUp) + " / " + usd(netDn) + ", below the " + usd(T0) + " target (perp rounding / fixed costs).");
    return { lotSets, factor: f, legs, perpQty: fq, equalisingQty: qRaw, target: T0, perLotTarget: perLotT, exits: { up: netUp, down: netDn }, perLotSet: { up: netUp / lotSets, down: netDn / lotSets },
      capital: ev.requiredCapital, futuresMargin: ev.futuresMargin, optionsCapital: ev.optionsCapital, whatIf: wi, liquidity: liq, warnings: liq.flags.filter((f) => !liq.blocking.some((b) => b.endsWith(f))), flags, ok: !flags.length };
  }

  // ---- weekly plan: combine 1–3 structures under correlated lognormal moves (Monte Carlo, seeded → reproducible)
  function cholesky(m) {
    const n = m.length, L = m.map(() => Array(n).fill(0));
    for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
      let s = m[i][j]; for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j][j];
    }
    return L;
  }
  function rng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
  // legs: [{ spot, atmIV, T, pnl(S) → expiry P&L incl. MM allowance, riskLoss, capital }]; corr: n×n; opts { targetMin, targetMax, weeklyLossLimit, sims, seed, r }
  function combine(legs, corr, opts = {}) {
    const n = legs.length, sims = opts.sims || 20000, r = opts.r ?? 0.04, L = cholesky(corr), u = rng(opts.seed || 12345);
    const gauss = () => { let a = 0; while (a === 0) a = u(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * u()); };
    const tot = new Float64Array(sims);
    for (let s = 0; s < sims; s++) {
      const z = Array.from({ length: n }, gauss); let sum = 0;
      for (let i = 0; i < n; i++) { let e = 0; for (let k = 0; k <= i; k++) e += L[i][k] * z[k]; const g = legs[i], sg = g.atmIV * Math.sqrt(g.T); sum += g.pnl(g.spot * Math.exp((r - g.atmIV * g.atmIV / 2) * g.T + sg * e)); }
      tot[s] = sum;
    }
    const sorted = Array.from(tot).sort((a, b) => a - b), q = (p) => sorted[Math.min(sims - 1, Math.max(0, Math.floor(p * sims)))];
    const frac = (f) => sorted.filter(f).length / sims, mean = sorted.reduce((a, b) => a + b, 0) / sims;
    const lim = opts.weeklyLossLimit;
    // common-move scenarios: every underlying moves by the same % (correlation 1 — the stress case for a "diversified" plan)
    const grid = MOVES.map((m) => ({ move: m, pnl: legs.reduce((t, g) => t + g.pnl(g.spot * (1 + m / 100)), 0), each: legs.map((g) => g.pnl(g.spot * (1 + m / 100))) }));
    return { sims, model: "correlated lognormal at each underlying's ATM IV to expiry, risk-neutral drift, " + sims + " seeded simulations; P&L at expiry incl. MM allowance",
      probHitMin: opts.targetMin != null ? frac((x) => x >= opts.targetMin) : null, probHitMax: opts.targetMax != null ? frac((x) => x >= opts.targetMax) : null,
      probProfit: frac((x) => x > 0), expectedValue: mean, p5: q(0.05), p25: q(0.25), median: q(0.5), p95: q(0.95), worstSim: sorted[0],
      probLossOverLimit: lim != null ? frac((x) => x <= -lim) : null, combinedMaxLoss: legs.reduce((t, g) => t + g.riskLoss, 0), capitalUsed: legs.reduce((t, g) => t + g.capital, 0), commonMoveGrid: grid };
  }

  Object.assign(S, { sheetGroups, sizeCheck, rescale, combine, cholesky, optimize, whatIf, decideDirection, hedgeFromStock, OPT_DEFAULTS, DEFAULT_WEIGHTS, GATES, MOVES, IV_SHOCKS });
})(typeof globalThis !== "undefined" ? globalThis : window);
