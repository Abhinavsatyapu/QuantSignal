// QuantSignal liquidity & fill model (shared by the browser and the server, every method): per-leg liquidity grade,
// the entry cost of a fallback MARKET fill (far side of every option leg + the perp spread), a ticker-level verdict
// ("too illiquid for this target") and a combo-order execution plan. Pure functions on real quotes; nothing is invented —
// a leg without a bid / ask / open interest is graded on what is known and says so.
(function (root) {
  "use strict";
  const S = root.Strategy || (root.Strategy = {});
  const fin = (x) => typeof x === "number" && Number.isFinite(x);
  const usd = (x) => (x < 0 ? "−$" : "$") + Math.round(Math.abs(x)).toLocaleString("en-US");
  const usd2 = (x) => (x < 0 ? "−$" : "$") + Math.abs(x).toFixed(2);
  // defaults (all adjustable in Advanced): Good = spread ≤ 6% of mid AND (≤ $0.15 wide or ≤ 3%) AND OI ≥ 500 AND volume ≥ 50;
  // Illiquid = no bid, spread > 15% of mid or OI < 100; everything else Thin. A structure is "too illiquid for this target"
  // when its market-fill slippage exceeds 25% of the target (caution above 12% or with any illiquid leg).
  const LIQ_DEFAULTS = { liqGoodSpreadPct: 6, liqGoodSpreadAbs: 0.15, liqIlliquidSpreadPct: 15, liqGoodOI: 500, liqMinOI: 100, liqGoodVolume: 50, tooIlliquidPct: 25, cautionPct: 12, comboSteps: 5 };
  const GRADE_PENALTY = { Good: 0, Thin: 0.5, Illiquid: 2 };
  const GRADE_RANK = { Good: 0, Thin: 1, Illiquid: 2 };
  const opts = (o) => ({ ...LIQ_DEFAULTS, ...Object.fromEntries(Object.entries(o || {}).filter(([k, v]) => k in LIQ_DEFAULTS && fin(+v) && v !== "" && v != null).map(([k, v]) => [k, +v])) });
  const roundStrike = (k, spot) => { const u = spot >= 500 ? 10 : spot >= 50 ? 5 : 1; return Math.abs(k / u - Math.round(k / u)) < 1e-9; };

  // one option quote (chain contract or built leg)
  function legLiquidity(q, o, spot) {
    const c = opts(o), bid = +q.bid, ask = +q.ask, zeroBid = !(bid > 0), mid = fin(+q.mid) && q.mid > 0 ? +q.mid : ask > 0 && bid > 0 ? (bid + ask) / 2 : null;
    const spreadAbs = ask > 0 && ask >= bid ? ask - Math.max(0, bid) : null, spreadPct = spreadAbs != null && mid ? spreadAbs / mid * 100 : null;
    const oi = fin(q.openInterest) ? q.openInterest : null, vol = fin(q.volume) ? q.volume : null, why = [];
    let grade;
    if (zeroBid) { grade = "Illiquid"; why.push("no bid"); }
    else if (spreadPct == null) { grade = "Illiquid"; why.push("no two-sided quote"); }
    else if (spreadPct > c.liqIlliquidSpreadPct) { grade = "Illiquid"; why.push("spread " + spreadPct.toFixed(1) + "% > " + c.liqIlliquidSpreadPct + "%"); }
    else if (oi != null && oi < c.liqMinOI) { grade = "Illiquid"; why.push("open interest " + oi + " < " + c.liqMinOI); }
    else {
      if (!(spreadPct <= c.liqGoodSpreadPct)) why.push("spread " + spreadPct.toFixed(1) + "% > " + c.liqGoodSpreadPct + "%");
      if (!(spreadAbs <= c.liqGoodSpreadAbs + 1e-9 || spreadPct <= 3)) why.push("spread " + usd2(spreadAbs) + " wide");
      if (oi == null) why.push("open interest unknown"); else if (oi < c.liqGoodOI) why.push("open interest " + oi + " < " + c.liqGoodOI);
      if (vol != null && vol < c.liqGoodVolume) why.push("volume " + vol + " < " + c.liqGoodVolume);
      grade = why.length ? "Thin" : "Good";
    }
    return { grade, penalty: GRADE_PENALTY[grade], spreadPct, spreadAbs, halfSpread: spreadAbs != null ? spreadAbs / 2 : null, mid, openInterest: oi, volume: vol, zeroBid, round: fin(spot) ? roundStrike(q.strike, spot) : null, why: why.join(", ") || "tight spread, deep open interest" };
  }
  // the cost of entering the whole structure: limit at mid (best case) vs market at the far side (fallback), $ vs mid
  // legs: built legs {side, qty, bid, ask, mid, premium, strike, type}; hedge: {bid, ask, mid, symbol, isStock}; fq signed hedge qty;
  // fEntry the hedge entry the model used; exits: modelled exit P&L(s); target: $ target; ev: modelled EV
  function fillAnalysis(a, o) {
    const c = opts(o), legs = a.legs || [], h = a.hedge || null, fq = fin(a.fq) ? a.fq : 0, spot = a.spot;
    let optMarket = 0, optCharged = 0, worst = "Good";
    const rows = legs.map((l) => {
      const g = legLiquidity(l, c, spot), q = Math.abs(l.qty || 0), mid = g.mid;
      const far = l.side === "buy" ? +l.ask : +l.bid, market = mid != null && fin(far) ? Math.abs(far - mid) * q * 100 : null;
      const charged = mid != null && fin(+l.premium) ? (l.side === "buy" ? l.premium - mid : mid - l.premium) * q * 100 : 0;
      if (market != null) optMarket += market; optCharged += charged;
      if (GRADE_RANK[g.grade] > GRADE_RANK[worst]) worst = g.grade;
      return { tag: (l.side === "buy" ? "+" : "−") + q + " " + l.strike + (l.type === "call" ? "C" : "P"), side: l.side, type: l.type, strike: l.strike, qty: q, bid: +l.bid, ask: +l.ask, ...g, marketCost: market, modelCost: charged };
    });
    const hMid = h && fin(+h.mid) ? +h.mid : null, hHalf = h && +h.ask > 0 && +h.bid > 0 && h.ask >= h.bid ? (h.ask - h.bid) / 2 : null;
    const perpMarket = hHalf != null ? Math.abs(fq) * hHalf : 0, perpCharged = hMid != null && fin(a.fEntry) ? Math.abs(fq) * Math.abs(a.fEntry - hMid) : 0;
    const market = optMarket + perpMarket, charged = optCharged + perpCharged, extra = Math.max(0, market - charged);
    const exits = (a.exits || []).filter(fin), minExit = exits.length ? Math.min(...exits) : null, T0 = a.target;
    const share = T0 > 0 ? market / T0 : null, counts = { Good: 0, Thin: 0, Illiquid: 0 }; for (const r of rows) counts[r.grade]++;
    const afterSlip = minExit != null ? minExit - extra : null, atLimit = minExit != null ? minExit + charged : null;
    let verdict = "OK", text;
    if (share != null && share * 100 > c.tooIlliquidPct) { verdict = "TOO_ILLIQUID"; text = "Too illiquid for this target: a market fill would cost " + usd(market) + " (" + Math.round(share * 100) + "% of the " + usd(T0) + " target) before the trade moves. More lot sets do not help (the spread cost grows with the size, like the target); use a later expiry with tighter spreads, a more liquid ticker, or skip it — and if you trade it, enter only with a combo limit order."; }
    else if ((share != null && share * 100 > c.cautionPct) || counts.Illiquid) { verdict = "CAUTION"; text = "Thin market: a market fill would cost " + usd(market) + (share != null ? " (" + Math.round(share * 100) + "% of the target)" : "") + (counts.Illiquid ? "; " + counts.Illiquid + " leg" + (counts.Illiquid > 1 ? "s are" : " is") + " illiquid" : "") + ". Enter only with a combo limit order (see the execution plan)."; }
    else text = "Liquid enough: a market fill would cost " + usd(market) + (share != null ? " (" + Math.round(share * 100) + "% of the target)" : "") + "; still enter with a combo limit order.";
    if (afterSlip != null && T0 > 0 && afterSlip < T0 - 0.5 && verdict === "OK") { verdict = "CAUTION"; text = "After a market fill the exits pay " + usd(afterSlip) + ", below the " + usd(T0) + " target. " + text; }
    return { legs: rows, worstGrade: worst, counts, gradePenalty: rows.length ? rows.reduce((m, r) => m + r.penalty, 0) / rows.length : 0, roundStrikes: rows.filter((r) => r.round).length,
      optionsMarket: optMarket, perpMarket, marketSlippage: market, modelCharged: charged, extraVsModel: extra, shareOfTarget: share,
      exitsAtLimit: atLimit, targetAfterSlippage: afterSlip, evAfterSlippage: fin(a.ev) ? a.ev - extra : null, evAtLimit: fin(a.ev) ? a.ev + charged : null,
      verdict, verdictText: text, thresholds: { tooIlliquidPct: c.tooIlliquidPct, cautionPct: c.cautionPct },
      model: "limit at mid = best case; market = every option leg at the far side (buy at ask, sell at bid) + the " + (h && h.isStock ? "stock" : "perp") + " half-spread; targets, risk caps and EV are checked at the market-fill price" };
  }
  // reasons a structure must not be shown as a recommendation (each switchable in Advanced, all on by default)
  function recommendBlockers(f, cfg) {
    const c = cfg || {}, out = [];
    if (!f) return out;
    if (c.requirePositiveEv !== false && fin(f.evAfterSlippage) && f.evAfterSlippage < 0) out.push("expected value after a market fill is " + usd(f.evAfterSlippage));
    if (c.rejectIlliquidLegs !== false && f.counts && f.counts.Illiquid) out.push(f.counts.Illiquid + " illiquid leg" + (f.counts.Illiquid > 1 ? "s" : "") + " (" + f.legs.filter((r) => r.grade === "Illiquid").map((r) => r.tag + ": " + r.why).join(", ") + ")");
    if (c.rejectTooIlliquid !== false && f.verdict === "TOO_ILLIQUID") out.push("a market fill costs " + Math.round(f.shareOfTarget * 100) + "% of the target");
    return out;
  }
  const gcd = (x, y) => (y ? gcd(y, x % y) : x);
  // combo-order plan: net price per combo unit at mid and at natural, step size, and the worst net price that still pays
  // the target (and keeps the max loss inside the cap). Debit > 0, credit < 0.
  function executionPlan(a, o) {
    const c = opts(o), legs = a.legs || []; if (!legs.length) return null;
    const n = legs.map((l) => Math.abs(l.qty)).reduce(gcd), unit = legs.map((l) => ({ ...l, ratio: Math.abs(l.qty) / n }));
    const net = (px) => unit.reduce((m, l) => m + (l.side === "buy" ? 1 : -1) * l.ratio * px(l), 0);
    const mid = net((l) => (fin(+l.mid) && l.mid > 0 ? +l.mid : (+l.bid + +l.ask) / 2)), natural = net((l) => (l.side === "buy" ? +l.ask : +l.bid));
    const f = a.fill || {}, per$ = n * 100, T0 = a.target;
    // headroom at mid: modelled min exit + what the model already charged on the options − target − the perp crossing its spread
    const exitMid = f.exitsAtLimit != null ? f.exitsAtLimit - (f.perpMarket || 0) : null;
    let room = exitMid != null && T0 > 0 ? exitMid - T0 : null, capNote = "";
    if (fin(a.riskLoss) && fin(a.riskCap) && a.riskCap > 0) { const rMid = a.riskLoss - (f.modelCharged || 0) + (f.perpMarket || 0), capRoom = a.riskCap - rMid; if (room == null || capRoom < room) { room = capRoom; capNote = " and keeps the max loss inside the " + usd(a.riskCap) + " cap"; } }
    const maxNet = room != null ? mid + room / per$ : null, step = Math.max(0.01, Math.round(Math.abs(natural - mid) / c.comboSteps * 100) / 100);
    const fmt = (x) => (x >= 0 ? "debit " : "credit ") + usd2(Math.abs(x)), within = maxNet != null && maxNet >= natural - 1e-9;
    const hs = a.hedge || {}, hq = a.fq || 0, hName = hs.isStock ? (a.ticker || "") + " shares" : (hs.symbol || "perp");
    const steps = [];
    if (a.stale) steps.push("Check the quotes are live first: these are " + a.stale + ". Re-run after the US open (9:30 ET = 7:00 PM IST) before placing anything.");
    steps.push("Send the four option legs as ONE combo (multi-leg spread) order: " + n + " × [" + unit.map((l) => (l.side === "buy" ? "+" : "−") + l.ratio + " " + l.strike + (l.type === "call" ? "C" : "P")).join(" ") + "], net limit " + fmt(mid) + " (mid) per combo.");
    steps.push("If it does not fill in about a minute, improve the limit by " + usd2(step) + " toward the natural price (" + fmt(natural) + ") and wait again; repeat in small steps.");
    if (maxNet == null) steps.push("Do not go past the natural price, and never leg in with market orders.");
    else if (room < 0) steps.push("Even at mid this structure does not pay the " + usd(T0) + " target after the hedge cost" + capNote + " — do not trade it.");
    else steps.push("Never go beyond " + fmt(maxNet) + " per combo: that is the worst net price that still pays the " + usd(T0) + " target" + capNote + (within ? " (the natural price is inside it)" : "") + ". If it does not fill there, cancel — do not leg in and do not switch to market orders.");
    if (hq) steps.push("Only after the options combo has filled: " + (hq > 0 ? "BUY " : "SELL ") + Math.abs(hq) + " " + hName + " with a limit at mid" + (fin(+hs.mid) ? " (" + usd2(+hs.mid) + ")" : "") + (fin(+hs.bid) && fin(+hs.ask) ? ", inside the " + usd2(+hs.bid) + " / " + usd2(+hs.ask) + " market" : "") + ".");
    steps.push("Record the actual fills in History → Taken; the model learns your real slippage per spread bucket from them.");
    return { comboUnits: n, unitLegs: unit.map((l) => ({ side: l.side, type: l.type, strike: l.strike, ratio: l.ratio })), netMid: mid, netNatural: natural, step, maxNet, maxNetMeetsTarget: room != null && room >= 0, naturalWithinMax: within,
      steps, note: "Guidance only — QuantSignal never sends orders to a broker, and the auto-trader stays in dry-run." };
  }
  // expected value at expiry of the structure AS PRICED (legs at their modelled premium — natural for Reference / Delta), under
  // the same lognormal / ATM-IV / risk-neutral drift the optimizer's what-if uses. Used for methods that have no what-if EV.
  function expectedValueAtExpiry(x, out, cfg) {
    const E = S.evaluate, spot = out.spot, iv = out.atmIV || out.atmIv, days = out.days, r = fin(cfg.r) ? cfg.r : 0.04;
    if (!E || !fin(spot) || !(iv > 0) || !(days > 0) || !Array.isArray(x.legs)) return null;
    const now = 0, expiryMs = days * 864e5, T = days / 365, f = x.futures || {};
    const ev = E({ legs: x.legs, future: { qty: fin(f.signedQty) ? f.signedQty : 0, entry: fin(f.entry) ? f.entry : spot, basis: out.basis || 0 }, commission: cfg.commission, futureFeePct: cfg.futureFeePct, r, nowMs: now, expiryMs });
    const npdf = (z) => Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI), mm = fin(x.mmLoss) ? x.mmLoss : fin(cfg.mmLoss) ? cfg.mmLoss : 0;
    let sum = 0; for (let z = -6; z <= 6 + 1e-9; z += 0.01) sum += npdf(z) * 0.01 * ev.expiry(spot * Math.exp((r - iv * iv / 2) * T + iv * Math.sqrt(T) * z));
    return sum - mm;
  }
  // attach the fill model, the verdict and the execution plan to a built result (any method)
  function attachLiquidity(out, o) {
    if (!out || !out.best || !Array.isArray(out.best.legs) || !out.best.legs.length) return out;
    const cfg = { ...(out.cfg || {}), ...(o || {}) }, b = out.best, T0 = (out.cfg && out.cfg.targetPnl) || (b.target && b.target.pnl) || null;
    const ex = (x) => (Array.isArray(x.exits) ? x.exits.map((e) => (fin(e.pnlExpiry) ? e.pnlExpiry : e.pnl)) : x.expected ? [x.expected.upExpiry, x.expected.downExpiry] : []);
    const evOf = (x) => (x.whatIf && x.whatIf.probs && fin(x.whatIf.probs.expectedValue) ? x.whatIf.probs.expectedValue : expectedValueAtExpiry(x, out, cfg));
    const hedge = (out.perp && fin(+out.perp.mid) ? out.perp : null) || (o && o.hedge) || null, mk = (x) => fillAnalysis({ legs: x.legs, hedge, fq: x.futures ? x.futures.signedQty : 0, fEntry: x.futures ? x.futures.entry : null, exits: ex(x), target: T0, ev: evOf(x), spot: out.spot }, cfg);
    if (!b.fill) b.fill = mk(b);
    for (const a of out.alternatives || []) if (a && a.legs && !a.fill) a.fill = mk(a);
    for (const v of out.variants || []) if (v && v.best && v.best.legs && !v.best.fill) v.best.fill = mk(v.best);
    const acct = cfg.account || (out.cfg && out.cfg.account) || null, wiA = b.whatIf && b.whatIf.account;
    out.execPlan = executionPlan({ legs: b.legs, fill: b.fill, target: T0, hedge, fq: b.futures ? b.futures.signedQty : 0, ticker: out.ticker, stale: o && o.stale, riskLoss: wiA ? wiA.riskLoss : null, riskCap: acct && acct.capital > 0 && acct.maxLossPct > 0 ? acct.capital * acct.maxLossPct / 100 : null }, cfg);
    out.liquidityVerdict = { verdict: b.fill.verdict, text: b.fill.verdictText, marketSlippage: b.fill.marketSlippage, shareOfTarget: b.fill.shareOfTarget, targetAfterSlippage: b.fill.targetAfterSlippage, worstGrade: b.fill.worstGrade, counts: b.fill.counts };
    out.warnings = out.warnings || [];
    // liquidity strike moves (any method): report only those that ended up in the final structure
    const mlist = out.liquidityMoveList || (out.distanceBand && out.distanceBand.liquidityMoveList) || [];
    out.liquidityMoves = mlist.filter((m) => b.legs.some((l) => l.type === m.type && l.strike === m.to)).map((m) => m.msg).filter((m, i, a) => a.indexOf(m) === i);
    if (out.liquidityMoves.length) { const w = "Liquidity: " + out.liquidityMoves.join("; ") + "."; if (!out.warnings.includes(w)) out.warnings.push(w); }
    if (b.fill.verdict !== "OK" && !out.warnings.some((w) => w === b.fill.verdictText)) out.warnings.unshift(b.fill.verdictText);
    // never present a structure as a recommendation when it loses money on average after a market fill, or a leg has no real market
    const why = recommendBlockers(b.fill, cfg);
    out.liquidityVerdict.recommended = !why.length; out.liquidityVerdict.blockers = why;
    if (why.length) {
      const msg = "Not recommended: " + why.join("; ") + ".";
      if (!out.warnings.includes(msg)) out.warnings.unshift(msg);
      if (out.recommendation && !/^NOT (A CLEAN|RECOMMENDED)/.test(out.recommendation.reason || "")) { out.recommendation.liquidityVerdict = b.fill.verdict; out.recommendation.notRecommended = true; out.recommendation.reason = "NOT RECOMMENDED — " + why.join("; ") + ". " + (out.recommendation.reason || ""); }
    } else if (out.recommendation && b.fill.verdict === "TOO_ILLIQUID" && !/^NOT A CLEAN/.test(out.recommendation.reason || "")) { out.recommendation.liquidityVerdict = "TOO_ILLIQUID"; out.recommendation.reason = "NOT A CLEAN RECOMMENDATION — " + b.fill.verdictText + " " + (out.recommendation.reason || ""); }
    return out;
  }
  // chain-level liquidity summary (expiry / ticker ranking): median spread %, share of usable strikes graded Good near the money
  function chainLiquidity(contracts, spot, sigma, o) {
    const near = (contracts || []).filter((q) => fin(q.strike) && (!fin(sigma) || Math.abs(q.strike - spot) <= 1.5 * sigma));
    const g = near.map((q) => legLiquidity(q, o, spot)), ok = g.filter((x) => x.spreadPct != null), sp = ok.map((x) => x.spreadPct).sort((a, b) => a - b);
    const med = sp.length ? sp[sp.length >> 1] : null, good = g.filter((x) => x.grade === "Good").length, ill = g.filter((x) => x.grade === "Illiquid").length;
    const score = g.length ? (good - 2 * ill) / g.length - (med != null ? med / 100 : 1) : -2; // higher = more liquid
    return { strikes: g.length, good, thin: g.length - good - ill, illiquid: ill, medianSpreadPct: med, score, grade: !g.length ? "Illiquid" : med != null && med <= 6 && good / g.length >= 0.4 ? "Good" : med == null || med > 15 || ill / g.length > 0.5 ? "Illiquid" : "Thin" };
  }
  Object.assign(S, { LIQ_DEFAULTS, GRADE_PENALTY, legLiquidity, fillAnalysis, executionPlan, attachLiquidity, chainLiquidity, roundStrike, recommendBlockers, expectedValueAtExpiry });
})(typeof globalThis !== "undefined" ? globalThis : window);
