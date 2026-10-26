// QuantSignal Strategy Engine: one shared engine for the four-leg options + perp-futures methodology used by
// Strategy Builder, Manual Four-Leg Lab, 1:2 Options + Futures, Live Hedge Compare and Sheet Scenario Lab.
// Pure functions only (no network). Loaded in the browser (window.Strategy) and on the server (globalThis.Strategy).
//
// Methodology (from the original Live Hedge / 1:2 / Manual Four-Leg code):
//   LONG  (bullish perp):  sell ~0.40Δ call, buy ~0.15Δ higher call (bear call credit spread)
//                          buy ~0.50Δ put,  sell ~0.20Δ lower put  (bear put debit spread)
//                          → options delta is negative; the perp is LONG: −optionsΔ × (1 + directional increment).
//   SHORT (bearish perp):  mirror image (bull call debit spread + bull put credit spread, perp SHORT).
//   NEUTRAL (condor):      bear call credit spread + bull put credit spread (iron condor), perp = −optionsΔ.
//   Put lots = ratio × call lots (1:2 by default). Long legs pay the ask, short legs receive the bid.
(function (root) {
  "use strict";
  const sgn = (side) => (side === "buy" ? 1 : -1);
  const fin = (x) => typeof x === "number" && Number.isFinite(x);
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  function cdf(x) { // standard normal CDF (Abramowitz-Stegun 7.1.26 via erf), |err| < 1.5e-7
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
    return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
  }
  const pdf = (x) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  function bs(S, K, T, v, r, type) {
    if (T <= 0 || v <= 0) return Math.max(type === "call" ? S - K : K - S, 0);
    if (S <= 0) return type === "put" ? K * Math.exp(-r * T) : 0;
    const d1 = (Math.log(S / K) + (r + v * v / 2) * T) / (v * Math.sqrt(T)), d2 = d1 - v * Math.sqrt(T);
    return type === "call" ? S * cdf(d1) - K * Math.exp(-r * T) * cdf(d2) : K * Math.exp(-r * T) * cdf(-d2) - S * cdf(-d1);
  }
  // Greeks in the providers' conventions: delta per share, gamma per $1, theta $/share per calendar day, vega $/share per 1 IV point.
  function bsGreeks(S, K, T, v, r, type) {
    if (!(T > 0 && v > 0 && S > 0 && K > 0)) return null;
    const sq = Math.sqrt(T), d1 = (Math.log(S / K) + (r + v * v / 2) * T) / (v * sq), d2 = d1 - v * sq;
    const delta = type === "call" ? cdf(d1) : cdf(d1) - 1, gamma = pdf(d1) / (S * v * sq), vega = S * pdf(d1) * sq / 100;
    const thetaYr = -S * pdf(d1) * v / (2 * sq) + (type === "call" ? -r * K * Math.exp(-r * T) * cdf(d2) : r * K * Math.exp(-r * T) * cdf(-d2));
    return { delta, gamma, theta: thetaYr / 365, vega };
  }
  function impliedVol(price, S, K, T, r, type) {
    const intrinsic = Math.max(type === "call" ? S - K * Math.exp(-r * T) : K * Math.exp(-r * T) - S, 0);
    if (!(price > intrinsic + 1e-6) || !(T > 0)) return null;
    let lo = 1e-4, hi = 6;
    if (bs(S, K, T, hi, r, type) < price) return null;
    for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2; if (bs(S, K, T, mid, r, type) > price) hi = mid; else lo = mid; }
    return (lo + hi) / 2;
  }
  // US equity options stop trading 16:00 America/New_York on expiry day (20:00Z in EDT, 21:00Z in EST).
  function expiryCloseMs(date) {
    const noon = new Date(date + "T16:00:00Z");
    let edt = true;
    try { edt = /EDT/.test(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "short" }).format(noon)); } catch (e) {}
    return Date.parse(date + (edt ? "T20:00:00Z" : "T21:00:00Z"));
  }
  // ---------------------------------------------------------------- quotes / liquidity
  function classify(q, ctx) {
    if (q.multiplier != null && q.multiplier !== 100) return { ok: false, reason: "non-standard multiplier" };
    if (!(q.bid > 0)) return { ok: false, reason: "no bid (zero-bid strike)" };
    if (!(q.ask > 0) || q.ask < q.bid) return { ok: false, reason: "no ask / crossed quote" };
    const mid = (q.bid + q.ask) / 2, spreadPct = (q.ask - q.bid) / mid * 100;
    if (spreadPct > ctx.maxSpreadPct) return { ok: false, reason: "bid/ask spread wider than " + ctx.maxSpreadPct + "%" };
    let iv = q.iv > 0 && q.iv < 6 ? q.iv : null, ivSource = "provider";
    if (!iv) { iv = impliedVol(mid, ctx.spot, q.strike, ctx.T, ctx.r, q.type); ivSource = "solved from mid"; }
    if (!iv) return { ok: false, reason: "no implied volatility" };
    const g = q.greeks || {}, provided = ["delta", "gamma", "theta", "vega"].every((k) => fin(g[k])) && Math.abs(g.delta) <= 1 && g.gamma >= 0 && g.vega >= 0 && (g.gamma > 0 || g.vega > 0);
    const greeks = provided ? { delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega } : bsGreeks(ctx.spot, q.strike, ctx.T, iv, ctx.r, q.type);
    if (!greeks) return { ok: false, reason: "no greeks" };
    return { ok: true, q: { ...q, mid, spreadPct, iv, ivSource, greeks, greeksSource: provided ? "provider" : "Black-Scholes from IV" } };
  }
  // ---------------------------------------------------------------- strike-pair search (same targets as LiveHedge.pairs)
  function pairs(quotes, type, direction, move, atr, strategy) {
    const highBuy = strategy === "condor" ? type === "call" : direction === "LONG",
      buyTarget = type === "call" ? (highBuy ? 0.15 : 0.5) : highBuy ? 0.5 : 0.15,
      sellTarget = type === "call" ? (highBuy ? 0.4 : 0.2) : highBuy ? 0.2 : 0.4,
      list = quotes.filter((q) => q.type === type), out = [];
    for (const buy of list) for (const sell of list) {
      const width = Math.abs(buy.strike - sell.strike);
      if (buy.symbol === sell.symbol || (highBuy ? buy.strike <= sell.strike : buy.strike >= sell.strike) || width < Math.max(0.2 * move, 1.5 * (atr || 0)) || width > 2 * move) continue;
      const execution = buy.ask - buy.bid + sell.ask - sell.bid;
      const score = Math.abs(Math.abs(buy.greeks.delta) - buyTarget) + Math.abs(Math.abs(sell.greeks.delta) - sellTarget) + Math.abs(width - 0.5 * move) / move * 0.25 + execution / width;
      out.push({ buy, sell, score, width });
    }
    return out.sort((a, b) => a.score - b.score).slice(0, 6);
  }
  // ---------------------------------------------------------------- evaluation of any 4-leg (or n-leg) + perp book
  // legs: {type, side, strike, qty, premium, iv?, greeks?, multiplier?}; future: {qty (signed units), entry, basis (perp − stock)}
  function evaluate(o) {
    const legs = o.legs, m = (l) => l.multiplier || 100, fut = o.future || { qty: 0, entry: 0 }, q = fut.qty || 0, aq = Math.abs(q);
    const basis = fin(fut.basis) ? fut.basis : 0, feePct = o.futureFeePct || 0, commission = o.commission || 0, r = fin(o.r) ? o.r : 0.04;
    const perpAt = (S) => Math.max(0, S + basis);
    const optionCash = legs.reduce((n, l) => n - sgn(l.side) * l.qty * m(l) * l.premium, 0); // + credit / − debit
    const optionFees = commission * legs.reduce((n, l) => n + l.qty, 0), futEntryFee = aq * (fut.entry || 0) * feePct / 100;
    const futPnl = (S) => (q ? q * (perpAt(S) - fut.entry) - futEntryFee - aq * perpAt(S) * feePct / 100 : 0);
    const optionsAtExpiry = (S) => optionCash + legs.reduce((n, l) => n + sgn(l.side) * l.qty * m(l) * Math.max(l.type === "call" ? S - l.strike : l.strike - S, 0), 0) - optionFees;
    const expiry = (S) => optionsAtExpiry(S) + futPnl(S);
    const T0 = Math.max(0, (o.expiryMs - o.nowMs) / (365 * 864e5));
    const optionsAt = (S, T) => optionCash + legs.reduce((n, l) => n + sgn(l.side) * l.qty * m(l) * bs(S, l.strike, T, l.iv, r, l.type), 0) - optionFees;
    const at = (S, daysAhead = 0) => optionsAt(S, Math.max(0, T0 - daysAhead / 365)) + futPnl(S);
    const callSlope = legs.filter((l) => l.type === "call").reduce((n, l) => n + sgn(l.side) * l.qty * m(l), 0);
    const tail = callSlope + q - aq * feePct / 100; // dP/dS for S above every strike
    const kinks = [...new Set([0, ...legs.map((l) => l.strike), ...(basis < 0 ? [-basis] : [])])].sort((a, b) => a - b);
    const vals = kinks.map(expiry), be = [];
    for (let i = 0; i < kinks.length - 1; i++) { if (Math.abs(vals[i]) < 1e-9) be.push(kinks[i]); if (vals[i] * vals[i + 1] < 0) be.push(kinks[i] - vals[i] * (kinks[i + 1] - kinks[i]) / (vals[i + 1] - vals[i])); }
    const last = kinks.at(-1), lv = vals.at(-1);
    if (Math.abs(lv) < 1e-9) be.push(last);
    if (Math.abs(tail) > 1e-12 && -lv / tail > 0) be.push(last - lv / tail);
    const best = Math.max(...vals), worst = Math.min(...vals);
    const greeks = legs.reduce((g, l) => { const k = sgn(l.side) * l.qty * m(l), x = l.greeks || {}; g.delta += k * (x.delta || 0); g.gamma += k * (x.gamma || 0); g.theta += k * (x.theta || 0); g.vega += k * (x.vega || 0); return g; }, { delta: 0, gamma: 0, theta: 0, vega: 0 });
    const optionDelta = greeks.delta;
    // Capital: each same-type vertical (equal lots) is defined risk → requirement = its max loss (Reg-T spread rule).
    let optionsCapital = 0, nakedRisk = false;
    for (const type of ["call", "put"]) {
      const g = legs.filter((l) => l.type === type); if (!g.length) continue;
      const cash = g.reduce((n, l) => n - sgn(l.side) * l.qty * m(l) * l.premium, 0);
      const f = (S) => cash + g.reduce((n, l) => n + sgn(l.side) * l.qty * m(l) * Math.max(type === "call" ? S - l.strike : l.strike - S, 0), 0);
      const pts = [0, ...g.map((l) => l.strike)];
      if (g.reduce((n, l) => n + sgn(l.side) * l.qty, 0) < 0) nakedRisk = true; // more short than long contracts of a type
      optionsCapital += Math.max(0, -Math.min(...pts.map(f)));
    }
    const futuresMargin = q ? aq * fut.entry / (o.leverage || 5) : 0;
    return {
      optionCash, netCreditDebit: optionCash, optionFees, futuresEntryFee: futEntryFee,
      maxProfit: tail > 1e-9 ? null : best, maxLoss: tail < -1e-9 ? null : Math.max(0, -worst),
      unlimitedProfit: tail > 1e-9, unlimitedLoss: tail < -1e-9, breakevens: [...new Set(be.map(r6))].sort((a, b) => a - b),
      greeks: { ...greeks, delta: optionDelta + q, optionDelta, futuresDelta: q },
      optionsCapital, futuresMargin, requiredCapital: optionsCapital + futuresMargin + optionFees + futEntryFee, nakedRisk,
      expiry, at, perpAt, kinks, tailSlope: tail, T: T0,
    };
  }
  // Exact price intervals where f(S) ≥ target, f piecewise-smooth: grid + kinks, crossings by linear interpolation.
  function regionAtLeast(f, target, lo, hi, kinks, n = 600) {
    const xs = [...new Set([...Array.from({ length: n + 1 }, (_, i) => lo + (hi - lo) * i / n), ...kinks.filter((k) => k > lo && k < hi)])].sort((a, b) => a - b);
    const out = []; let start = null, prevX = xs[0], prevV = f(xs[0]) - target;
    if (prevV >= 0) start = prevX;
    for (let i = 1; i < xs.length; i++) {
      const x = xs[i], v = f(x) - target;
      if (start == null && v >= 0) start = prevV < 0 ? prevX + (x - prevX) * (-prevV) / (v - prevV) : x;
      else if (start != null && v < 0) { out.push([start, prevX + (x - prevX) * prevV / (prevV - v)]); start = null; }
      prevX = x; prevV = v;
    }
    if (start != null) out.push([start, hi]);
    return out;
  }
  // Risk-neutral lognormal probability that S_T lies in [a,b] (not a forecast).
  function probIn(S, a, b, iv, T, r) {
    if (!(T > 0 && iv > 0)) return S >= a && S <= b ? 1 : 0;
    const P = (x) => (x <= 0 ? 1 : cdf((Math.log(S / x) + (r - iv * iv / 2) * T) / (iv * Math.sqrt(T)))); // P(S_T > x)
    return Math.max(0, P(a) - (b >= 1e12 ? 0 : P(b)));
  }
  // ---------------------------------------------------------------- builder
  function build(input) {
    const cfg = { ratio: 2, directionalPct: 25, maxSpreadPct: 25, commission: 0.65, futureFeePct: 0.045, leverage: 5, maxScale: 25, reachSigma: 1, riskSigma: 2, maxLossPct: 50, r: 0.04, ...input.cfg };
    const errs = [];
    const need = (ok, msg) => { if (!ok) errs.push(msg); };
    need(["LONG", "SHORT", "NEUTRAL"].includes(cfg.direction), "Choose a direction: bullish (long perp), bearish (short perp) or neutral (condor)");
    need(fin(cfg.targetPnl) && cfg.targetPnl > 0, "Target P&L must be a positive dollar amount");
    need(fin(cfg.capital) && cfg.capital > 0, "Capital must be a positive dollar amount");
    need(fin(cfg.maxLossPct) && cfg.maxLossPct > 0 && cfg.maxLossPct <= 100, "Max loss must be between 0 and 100% of capital");
    need(Number.isInteger(cfg.ratio) && cfg.ratio >= 1 && cfg.ratio <= 4, "Put:call lot ratio must be a whole number 1–4");
    need(fin(cfg.directionalPct) && cfg.directionalPct >= 0 && cfg.directionalPct <= 100, "Directional increment must be 0–100%");
    need(fin(cfg.maxSpreadPct) && cfg.maxSpreadPct > 0 && cfg.maxSpreadPct <= 100, "Max bid/ask spread must be 0–100%");
    need(fin(cfg.leverage) && cfg.leverage >= 1 && cfg.leverage <= 50, "Leverage must be 1–50×");
    need(Number.isInteger(cfg.maxScale) && cfg.maxScale >= 1 && cfg.maxScale <= 200, "Max call lots must be 1–200");
    need(fin(cfg.commission) && cfg.commission >= 0 && fin(cfg.futureFeePct) && cfg.futureFeePct >= 0, "Fees must be ≥ 0");
    if (errs.length) return { status: "INVALID", errors: errs };
    const now = input.nowMs ?? Date.now(), expiryMs = expiryCloseMs(input.expiry), T = (expiryMs - now) / (365 * 864e5), days = T * 365;
    if (!(T > 0)) return { status: "INVALID", errors: ["Expiry " + input.expiry + " has passed"] };
    const perp = input.perp && input.perp.available ? input.perp : null;
    if (!perp) return { status: "NO_PERP", errors: [(input.perp && input.perp.reason) || "No Hyperliquid US stock perp for " + input.ticker, "The futures leg cannot be placed, so no four-leg + perp recommendation is made."] };
    const spot = input.stock && input.stock.price > 0 ? input.stock.price : perp ? perp.mid : null;
    if (!(spot > 0)) return { status: "NO_DATA", errors: ["No underlying price from the options provider or Hyperliquid"] };
    if (perp && cfg.leverage > (perp.maxLeverage || 5)) cfg.leverage = perp.maxLeverage;
    const basis = perp && input.stock && input.stock.price > 0 ? perp.mid - input.stock.price : 0;
    const ctx = { spot, T, r: cfg.r, maxSpreadPct: cfg.maxSpreadPct };
    const group = input.contracts.filter((c) => c.expiry === input.expiry), excluded = {}, quotes = [];
    for (const c of group) { const k = classify(c, ctx); if (k.ok) quotes.push(k.q); else excluded[k.reason] = (excluded[k.reason] || 0) + 1; }
    const liquidity = { listed: group.length, usable: quotes.length, excluded };
    if (!group.length) return { status: "NO_DATA", errors: ["No contracts listed for " + input.expiry], liquidity };
    if (quotes.length < 4) return { status: "NO_LIQUIDITY", errors: ["Only " + quotes.length + " strikes have two-sided quotes within the " + cfg.maxSpreadPct + "% spread limit"], liquidity };
    const atm = quotes.slice().sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot)).slice(0, 4);
    const atmIV = atm.reduce((n, q) => n + q.iv, 0) / atm.length, move = spot * atmIV * Math.sqrt(T);
    const strategy = cfg.direction === "NEUTRAL" ? "condor" : "directional", dir = cfg.direction === "SHORT" ? "SHORT" : "LONG";
    const callPairs = pairs(quotes, "call", dir, move, 0, strategy), putPairs = pairs(quotes, "put", dir, move, 0, strategy);
    if (!callPairs.length || !putPairs.length) return { status: "NO_LIQUIDITY", errors: ["No liquid " + (!callPairs.length ? "call" : "put") + " spread with width between 0.2σ and 2σ (σ move ≈ $" + move.toFixed(2) + ")"], liquidity, atmIV, expectedMove: move };
    const step = perp ? 10 ** -perp.szDecimals : 1, roundQ = (x) => Math.round(Math.round(x / step) * step * 1e8) / 1e8;
    const lo = Math.max(0, spot - 3 * move), hi = spot + 3 * move;
    const reachLo = cfg.direction === "SHORT" ? spot - cfg.reachSigma * move : cfg.direction === "NEUTRAL" ? spot : spot, reachHi = cfg.direction === "SHORT" ? spot : spot + cfg.reachSigma * move;
    const riskLo = Math.max(0, spot - cfg.riskSigma * move), riskHi = spot + cfg.riskSigma * move;
    const lossBudget = cfg.capital * cfg.maxLossPct / 100;
    const mk = (q, side, qty) => ({ type: q.type, side, strike: q.strike, qty, premium: side === "buy" ? q.ask : q.bid, iv: q.iv, greeks: q.greeks, multiplier: 100, contract: q.symbol, expiry: q.expiry, bid: q.bid, ask: q.ask, mid: q.mid, spreadPct: q.spreadPct, bidSize: q.bidSize, askSize: q.askSize, openInterest: q.openInterest, quoteTime: q.quoteTime, ivSource: q.ivSource, greeksSource: q.greeksSource, provider: q.provider });
    const feasible = [], nearMiss = [];
    for (const c of callPairs) for (const p of putPairs) {
      if (strategy === "condor" && !(p.sell.strike < c.sell.strike)) continue;
      for (let k = 1; k <= cfg.maxScale; k++) {
        const nc = k, np = k * cfg.ratio;
        const legs = [mk(c.sell, "sell", nc), mk(c.buy, "buy", nc), mk(p.buy, "buy", np), mk(p.sell, "sell", np)].sort((a, b) => (a.type === b.type ? a.strike - b.strike : a.type === "call" ? -1 : 1));
        const optDelta = legs.reduce((n, l) => n + sgn(l.side) * l.qty * 100 * l.greeks.delta, 0);
        const neutral = -optDelta, inc = cfg.direction === "NEUTRAL" ? 0 : cfg.directionalPct;
        const fq = perp ? roundQ(neutral * (1 + inc / 100)) : 0;
        if (perp && cfg.direction === "LONG" && !(fq > 0)) break; // structure must hedge with a LONG perp
        if (perp && cfg.direction === "SHORT" && !(fq < 0)) break;
        const fEntry = perp ? (fq > 0 ? perp.ask : fq < 0 ? perp.bid : perp.mid) : 0;
        const ev = evaluate({ legs, future: { qty: fq, entry: fEntry, basis }, commission: cfg.commission, futureFeePct: cfg.futureFeePct, leverage: cfg.leverage, r: cfg.r, nowMs: now, expiryMs });
        if (strategy === "condor" && ev.optionCash <= 0) break;
        if (ev.nakedRisk) break;
        const worstRisk = -Math.min(...[riskLo, riskHi, ...ev.kinks.filter((x) => x > riskLo && x < riskHi)].map(ev.expiry));
        const overCapital = ev.requiredCapital > cfg.capital, overRisk = worstRisk > lossBudget;
        const region = regionAtLeast(ev.expiry, cfg.targetPnl, lo, hi, ev.kinks);
        let targetPrice = null;
        if (cfg.direction === "LONG") { const iv = region.find(([a, b]) => b >= spot); targetPrice = iv ? Math.max(iv[0], spot) : null; }
        else if (cfg.direction === "SHORT") { const iv = region.filter(([a]) => a <= spot).at(-1); targetPrice = iv ? Math.min(iv[1], spot) : null; }
        else { const iv = region.find(([a, b]) => a <= spot && b >= spot); targetPrice = iv ? spot : null; }
        const reached = targetPrice != null && targetPrice >= reachLo - 1e-9 && targetPrice <= reachHi + 1e-9;
        const atReach = cfg.direction === "SHORT" ? ev.expiry(reachLo) : cfg.direction === "LONG" ? ev.expiry(reachHi) : ev.expiry(spot);
        if (overCapital || overRisk) { if (k === 1 || nearMiss.length < 200) nearMiss.push({ k, atReach, overCapital, overRisk, requiredCapital: ev.requiredCapital, worstRisk }); break; }
        if (!reached) { nearMiss.push({ k, atReach, requiredCapital: ev.requiredCapital, worstRisk }); continue; }
        const prob = region.reduce((n, [a, b]) => n + probIn(spot, a, b >= hi - 1e-9 ? 1e12 : b, atmIV, T, cfg.r), 0);
        const friction = legs.reduce((n, l) => n + (l.ask - l.bid) * l.qty * 100, 0) + 2 * ev.optionFees + 2 * ev.futuresEntryFee;
        feasible.push({ k, legs, ev, fq, fEntry, region, targetPrice, prob, friction, worstRisk, callPair: c, putPair: p, score: -prob + friction / cfg.targetPnl * 0.25 + (c.score + p.score) * 0.05 });
        break; // smallest size that reaches the target within the reach window
      }
    }
    const common = { ticker: input.ticker, expiry: input.expiry, expiryCloseUtc: new Date(expiryMs).toISOString(), days, spot, spotSource: input.stock && input.stock.price > 0 ? input.stock.source : "Hyperliquid perp mid (proxy: no stock quote)", basis, atmIV, expectedMove: move, liquidity, cfg, perp: perp ? { symbol: perp.symbol, bid: perp.bid, ask: perp.ask, mid: perp.mid, szDecimals: perp.szDecimals, maxLeverage: perp.maxLeverage, time: perp.time } : null, methodology: strategy };
    if (!feasible.length) {
      const best = nearMiss.filter((x) => !x.overCapital && !x.overRisk).sort((a, b) => b.atReach - a.atReach)[0];
      const why = nearMiss.length && nearMiss.every((x) => x.overCapital || x.overRisk) ? "even 1 call lot exceeds your capital or max-loss limit" : best ? "the best structure within your capital/max-loss makes about $" + Math.round(best.atReach).toLocaleString("en-US") + (cfg.direction === "NEUTRAL" ? " if the stock is unchanged at expiry" : " at a " + cfg.reachSigma + "σ move ($" + (cfg.direction === "SHORT" ? reachLo : reachHi).toFixed(2) + ")") : "no candidate structure qualified";
      return { ...common, status: "TARGET_NOT_REACHABLE", errors: ["Target $" + cfg.targetPnl.toLocaleString("en-US") + " is not reachable: " + why + ". Lower the target, add capital, raise the max-loss limit, widen the reach window, or pick a later expiry."], bestAchievable: best ? best.atReach : null };
    }
    feasible.sort((a, b) => a.score - b.score);
    const view = (f) => {
      const ev = f.ev, gridLo = Math.max(0, spot - 2.5 * move), gridHi = spot + 2.5 * move;
      const xs = [...new Set([...Array.from({ length: 121 }, (_, i) => gridLo + (gridHi - gridLo) * i / 120), ...ev.kinks.filter((x) => x > gridLo && x < gridHi), spot])].sort((a, b) => a - b);
      const dayMove = spot * atmIV * Math.sqrt(1 / 365);
      const scenarios = [["1-day up", spot + dayMove, 1], ["1-day down", Math.max(0, spot - dayMove), 1], ["Expiry up (+1σ)", spot + move, null], ["Expiry down (−1σ)", Math.max(0, spot - move), null]]
        .map(([name, S, d]) => ({ name, stock: S, perp: ev.perpAt(S), pnl: d == null ? ev.expiry(S) : ev.at(S, Math.min(1, ev.T * 365)) }));
      const liq = f.legs.filter((l) => !fin(l.side === "buy" ? l.askSize : l.bidSize) || (l.side === "buy" ? l.askSize : l.bidSize) < l.qty).map((l) => l.contract);
      return {
        callLots: f.k, putLots: f.k * cfg.ratio, legs: f.legs.map(({ greeks, ...l }) => ({ ...l, greeks, positionDelta: sgn(l.side) * l.qty * 100 * greeks.delta, cashFlow: -sgn(l.side) * l.qty * 100 * l.premium })),
        futures: perp ? { symbol: perp.symbol, side: f.fq > 0 ? "LONG" : f.fq < 0 ? "SHORT" : "NONE", qty: Math.abs(f.fq), signedQty: f.fq, entry: f.fEntry, notional: Math.abs(f.fq) * f.fEntry, neutralQty: r6(-ev.greeks.optionDelta), margin: ev.futuresMargin, leverage: cfg.leverage, minNotionalOk: !f.fq || Math.abs(f.fq) * f.fEntry >= 10 } : null,
        netCreditDebit: ev.netCreditDebit, maxProfit: ev.maxProfit, maxLoss: ev.maxLoss, unlimitedProfit: ev.unlimitedProfit, unlimitedLoss: ev.unlimitedLoss, breakevens: ev.breakevens,
        worstLossInRiskWindow: f.worstRisk, riskWindow: [riskLo, riskHi], greeks: ev.greeks, optionsCapital: ev.optionsCapital, futuresMargin: ev.futuresMargin, requiredCapital: ev.requiredCapital, fees: { options: ev.optionFees, futuresEntry: ev.futuresEntryFee },
        target: { pnl: cfg.targetPnl, price: f.targetPrice, movePct: (f.targetPrice / spot - 1) * 100, sigmas: (f.targetPrice - spot) / move, regions: f.region.map(([a, b]) => [a, b >= hi - 1e-9 ? null : b]), probability: f.prob, pnlAtTargetPrice: ev.expiry(f.targetPrice) },
        scenarios, friction: f.friction, thinSize: liq,
        curve: xs.map((S) => ({ stock: S, expiry: ev.expiry(S), today: ev.at(S, 0) })),
      };
    };
    return { ...common, status: "OK", best: view(feasible[0]), alternatives: feasible.slice(1, 3).map(view), searched: { callPairs: callPairs.length, putPairs: putPairs.length, qualifying: feasible.length } };
  }
  // ---------------------------------------------------------------- reference-sheet methodology (docs/four-leg-methodology.md)
  // Calibrated from the 78 reference sheets (σ = spot × ATM IV × √(days/365)): debit spread long leg = first OTM strike
  // (≈0.1σ OTM), debit short ≈0.9σ, credit short ≈0.63σ on the other side, credit wing ≈0.47σ beyond it, credit lots =
  // Owner's rules (26 Oct 2026): perp side follows the SIGNAL (bullish → LONG, bearish → SHORT); lots by signal: bullish
  // 2 calls : 1 put, bearish 1 call : 2 puts (the credit spread carries 2× lots → theta near-neutral or credit); perp sized to EQUALISE today's P&L at the two short strikes (the exit / target levels,
  // "CE short" and "PE short") and rounded DOWN to a multiple of 5; futures margin = FQ × entry / 2, 5× leverage.
  const REFERENCE_DEFAULTS = { debitLongSigma: 0.1, debitShortSigma: 0.9, creditShortSigma: 0.63, wingSigma: 0.47, callLotUnits: null, putLotUnits: null, // null = compute BOTH 1C:2P and 2C:1P and recommend one; numbers = a fixed override
    futuresRound: 5, futuresFactor: 1, marginDivisor: 2, leverage: 5, thetaTolerancePct: 15, mmLoss: 50, maxLots: 30, maxLossPct: 50, riskSigma: 2, commission: 0.65, futureFeePct: 0.045, maxSpreadPct: 25, maxPriceGapPct: 5, r: 0.04 };
  const SIGNAL_SIDE = { BULLISH: "LONG", BEARISH: "SHORT" };
  // Net options theta ($/day). CREDIT ≥ 0; NEAR-NEUTRAL when the debit is within tolPct of the gross |theta|; otherwise DEBIT.
  function thetaCheck(legs, tolPct = 15) {
    let theta = 0, gross = 0;
    for (const l of legs) { const t = sgn(l.side) * l.qty * (l.multiplier || 100) * ((l.greeks && l.greeks.theta) || 0); theta += t; gross += Math.abs(t); }
    const status = theta >= 0 ? "CREDIT" : -theta <= gross * tolPct / 100 ? "NEAR-NEUTRAL" : "DEBIT";
    return { theta, gross, status, ok: status !== "DEBIT", tolerancePct: tolPct, note: status === "DEBIT" ? "Theta is a net debit beyond " + tolPct + "% of gross theta: the 1:2 rule's aim (theta near-neutral or credit) is not met; consider the alternative or another expiry." : status === "CREDIT" ? "Theta credit: time decay works for the book." : "Theta near-neutral (debit within " + tolPct + "% of gross)." };
  }
  function buildReferenceOne(input) {
    const cfg = { ...REFERENCE_DEFAULTS, ...(input.calibration || {}), ...input.cfg }, errs = [];
    const need = (ok, msg) => { if (!ok) errs.push(msg); };
    if (cfg.signal && cfg.signal !== "AUTO") { need(!!SIGNAL_SIDE[cfg.signal], "Signal must be BULLISH, BEARISH or AUTO"); cfg.futuresSide = SIGNAL_SIDE[cfg.signal] || cfg.futuresSide; }
    if (!cfg.futuresSide) cfg.futuresSide = "AUTO";
    need(["LONG", "SHORT", "AUTO"].includes(cfg.futuresSide), "Choose the signal (BULLISH / BEARISH) or perp side LONG, SHORT or AUTO");
    const lotOverride = cfg.callLotUnits != null || cfg.putLotUnits != null;
    if (lotOverride) need([cfg.callLotUnits, cfg.putLotUnits].every((x) => Number.isInteger(x) && x >= 1 && x <= 10), "Lot ratio (calls : puts) must use two whole numbers 1–10, or leave both blank for the signal default");
    const lotUnits = () => (lotOverride ? [cfg.callLotUnits, cfg.putLotUnits] : [1, 2]);
    need(fin(cfg.futuresRound) && cfg.futuresRound > 0, "Futures rounding multiple must be > 0");
    need(fin(cfg.futuresFactor) && cfg.futuresFactor > 0 && cfg.futuresFactor <= 1.5, "Futures factor must be 0–1.5");
    need(fin(cfg.marginDivisor) && cfg.marginDivisor >= 1 && cfg.marginDivisor <= 50, "Futures margin divisor must be 1–50");
    need(fin(cfg.targetPnl) && cfg.targetPnl > 0, "Target P&L must be a positive dollar amount");
    need(fin(cfg.capital) && cfg.capital > 0, "Capital must be a positive dollar amount");
    need(fin(cfg.maxLossPct) && cfg.maxLossPct > 0 && cfg.maxLossPct <= 100, "Max loss must be 0–100% of capital");
    need(fin(cfg.mmLoss) && cfg.mmLoss >= 0, "Basket / market-making allowance must be ≥ 0");
    need(fin(cfg.maxSpreadPct) && cfg.maxSpreadPct > 0 && cfg.maxSpreadPct <= 100, "Max bid/ask spread must be 0–100%");
    need(Number.isInteger(cfg.maxLots) && cfg.maxLots >= 1 && cfg.maxLots <= 200, "Max debit-spread lots must be 1–200");
    need([cfg.debitShortSigma, cfg.creditShortSigma].every((x) => fin(x) && x > 0.1 && x <= 3) && fin(cfg.debitLongSigma) && cfg.debitLongSigma >= 0 && cfg.debitLongSigma < 1 && fin(cfg.wingSigma) && cfg.wingSigma > 0.05 && cfg.wingSigma <= 3, "Strike distances (σ) out of range");
    need(fin(cfg.leverage) && cfg.leverage >= 1 && cfg.leverage <= 50, "Leverage must be 1–50×");
    if (errs.length) return { status: "INVALID", errors: errs };
    const now = input.nowMs ?? Date.now(), expiryMs = expiryCloseMs(input.expiry), T = (expiryMs - now) / (365 * 864e5);
    if (!(T > 0)) return { status: "INVALID", errors: ["Expiry " + input.expiry + " has passed"] };
    const perp = input.perp && input.perp.available ? input.perp : null;
    if (!perp) return { status: "NO_PERP", errors: [(input.perp && input.perp.reason) || "No Hyperliquid US stock perp for " + input.ticker, "The reference methodology needs the perp leg (it is sized to equalise the up/down scenarios), so no recommendation is made. Options-only analysis is available in Options Studio / Manual Four-Leg Lab."] };
    const spot = input.stock && input.stock.price > 0 ? input.stock.price : perp.mid;
    if (!(spot > 0)) return { status: "NO_DATA", errors: ["No underlying price from the options provider or Hyperliquid"] };
    if (perp.maxLeverage && cfg.leverage > perp.maxLeverage) cfg.leverage = perp.maxLeverage;
    const basis = perp && input.stock && input.stock.price > 0 ? perp.mid - input.stock.price : 0;
    const ctx = { spot, T, r: cfg.r, maxSpreadPct: cfg.maxSpreadPct }, group = input.contracts.filter((c) => c.expiry === input.expiry), excluded = {}, quotes = [];
    for (const c of group) { const k = classify(c, ctx); if (k.ok) quotes.push(k.q); else excluded[k.reason] = (excluded[k.reason] || 0) + 1; }
    const liquidity = { listed: group.length, usable: quotes.length, excluded };
    if (!group.length) return { status: "NO_DATA", errors: ["No contracts listed for " + input.expiry], liquidity };
    const calls = quotes.filter((q) => q.type === "call").sort((a, b) => a.strike - b.strike), puts = quotes.filter((q) => q.type === "put").sort((a, b) => a.strike - b.strike);
    if (calls.length < 2 || puts.length < 2) return { status: "NO_LIQUIDITY", errors: ["Not enough liquid strikes (" + calls.length + " calls, " + puts.length + " puts within the " + cfg.maxSpreadPct + "% spread limit)"], liquidity };
    const atm = quotes.slice().sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot)).slice(0, 4), atmIV = atm.reduce((n, q) => n + q.iv, 0) / atm.length;
    const sigma = spot * atmIV * Math.sqrt(T), step = perp ? 10 ** -perp.szDecimals : 1;
    const unit = Math.max(step, cfg.futuresRound), toward0 = (x) => Math.sign(x) * Math.floor(Math.abs(x) / unit + 1e-9) * unit; // rounded DOWN to a multiple of 5
    const priceGapPct = input.stock && input.stock.price > 0 && perp.mid > 0 ? Math.abs(perp.mid - input.stock.price) / input.stock.price * 100 : null;
    if (priceGapPct != null && priceGapPct > cfg.maxPriceGapPct) return { status: "PRICE_MISMATCH", errors: ["Hyperliquid " + perp.symbol + " mid " + perp.mid + " differs from the options provider's " + input.ticker + " price " + input.stock.price + " by " + priceGapPct.toFixed(1) + "% (limit " + cfg.maxPriceGapPct + "%). The perp may not track this stock (or a quote is stale), so no recommendation is made."], perp: { symbol: perp.symbol, mid: perp.mid }, spot: input.stock.price };
    // nearest listed strike, liquidity-aware (same rule as the optimizer): among the 3 nearest, cost = strikes away + liquidity
    // penalty (Good 0 / Thin 0.6 / Illiquid 1.5) − 0.15 for a round strike; moves away from the plain nearest are reported
    const liqMoves = [], LQ = root.Strategy && root.Strategy.legLiquidity, RS = root.Strategy && root.Strategy.roundStrike;
    const nearest = (list, x, pred = () => true, leg) => { const L2 = list.filter(pred).sort((a, b) => Math.abs(a.strike - x) - Math.abs(b.strike - x)); if (!L2.length || !LQ || cfg.liquidityAware === false) return L2[0];
      const c3 = L2.slice(0, 3), gap = c3.length > 1 ? Math.max(1e-9, Math.abs(c3[1].strike - c3[0].strike)) : 1, lq = (q) => LQ(q, cfg, spot);
      const cost = (q) => Math.abs(q.strike - x) / gap + { Good: 0, Thin: 0.6, Illiquid: 1.5 }[lq(q).grade] - (RS && RS(q.strike, spot) ? 0.15 : 0);
      const pick = c3.reduce((m, q) => (cost(q) < cost(m) - 1e-9 ? q : m), c3[0]);
      const RK = { Good: 0, Thin: 1, Illiquid: 2 };
      if (leg && pick !== c3[0] && RK[lq(pick).grade] < RK[lq(c3[0]).grade]) { const a = lq(c3[0]), b2 = lq(pick), msg = leg + " " + pick.type + ": rule strike " + c3[0].strike + " is " + a.grade + " (" + a.why + ") → moved to " + pick.strike + " (" + b2.grade + (b2.spreadPct != null ? ", spread " + b2.spreadPct.toFixed(1) + "%" : "") + (b2.openInterest != null ? ", OI " + b2.openInterest : "") + ")"; if (!liqMoves.some((m) => m.msg === msg)) liqMoves.push({ type: pick.type, from: c3[0].strike, to: pick.strike, msg }); }
      return pick; };
    const sides = cfg.futuresSide === "AUTO" ? ["SHORT", "LONG"] : [cfg.futuresSide];
    const dsig = [...new Set([cfg.debitShortSigma, 0.75, 0.9, 1.05].map(r6))], csig = [...new Set([cfg.creditShortSigma, 0.55, 0.65, 0.8].map(r6))], wings = [...new Set([cfg.wingSigma, 0.35, 0.47, 0.6].map(r6))];
    const combos = []; for (const a of dsig) for (const c of csig) combos.push([a, c]);
    const lossBudget = cfg.capital * cfg.maxLossPct / 100, riskLo = Math.max(0, spot - cfg.riskSigma * sigma), riskHi = spot + cfg.riskSigma * sigma;
    const mk = (q, side, qty) => ({ type: q.type, side, strike: q.strike, qty, premium: side === "buy" ? q.ask : q.bid, iv: q.iv, greeks: q.greeks, multiplier: 100, contract: q.symbol, expiry: q.expiry, bid: q.bid, ask: q.ask, mid: q.mid, spreadPct: q.spreadPct, bidSize: q.bidSize, askSize: q.askSize, openInterest: q.openInterest, quoteTime: q.quoteTime, ivSource: q.ivSource, greeksSource: q.greeksSource, provider: q.provider });
    const seen = new Set(), found = [], misses = [];
    for (const fs of sides) for (const [a, ac] of combos) for (const w of wings) {
      // SHORT perp → bullish options: call DEBIT (long ≈ATM, short +aσ) + put CREDIT (short −aσ, wing −wσ further).
      // LONG perp  → bearish options: put DEBIT (long ≈ATM, short −aσ) + call CREDIT (short +aσ, wing +wσ further).
      const debitList = fs === "SHORT" ? calls : puts, creditList = fs === "SHORT" ? puts : calls, dir = fs === "SHORT" ? 1 : -1;
      const dLong = nearest(debitList, spot + dir * cfg.debitLongSigma * sigma, (q) => dir * (q.strike - spot) >= 0, "debit long") || nearest(debitList, spot); if (!dLong) continue;
      const dShort = nearest(debitList, spot + dir * a * sigma, (q) => dir * (q.strike - dLong.strike) > 0, "debit short");
      const cShort = nearest(creditList, spot - dir * ac * sigma, (q) => dir * (spot - q.strike) > 0, "credit short");
      if (!dShort || !cShort) continue;
      const cWing = nearest(creditList, cShort.strike - dir * w * sigma, (q) => dir * (cShort.strike - q.strike) > 0, "wing");
      if (!cWing) continue;
      const key = [fs, dLong.symbol, dShort.symbol, cShort.symbol, cWing.symbol].join("|"); if (seen.has(key)) continue; seen.add(key);
      const up = fs === "SHORT" ? dShort.strike : cShort.strike, dn = fs === "SHORT" ? cShort.strike : dShort.strike; // scenario prices = the two short strikes
      let prevAchieved = null;
      for (let n = 1; n <= cfg.maxLots; n++) {
        const [cu, pu] = lotUnits(fs), callN = n * cu, putN = n * pu, dN = fs === "SHORT" ? callN : putN, cN = fs === "SHORT" ? putN : callN;
        const legs = [mk(dLong, "buy", dN), mk(dShort, "sell", dN), mk(cShort, "sell", cN), mk(cWing, "buy", cN)].sort((x, y) => (x.type === y.type ? x.strike - y.strike : x.type === "call" ? -1 : 1));
        const probe = evaluate({ legs, future: { qty: 0, entry: 0, basis }, commission: 0, r: cfg.r, nowMs: now, expiryMs });
        const day = 0; // "today" = an immediate move (fits the sheets better than a 1-day horizon: 7.4% vs 11.1% median error)
        const qRaw = (probe.at(dn, day) - probe.at(up, day)) / (up - dn); // equalise today's P&L at the two short strikes
        const fq = perp ? r6(toward0(qRaw * cfg.futuresFactor)) : 0;
        if (perp && (fs === "LONG" ? !(fq > 0) : !(fq < 0))) { misses.push({ n, reason: "equalising perp quantity has the wrong sign" }); break; }
        const fEntry = perp ? (fq > 0 ? perp.ask : fq < 0 ? perp.bid : perp.mid) : 0;
        const ev = evaluate({ legs, future: { qty: fq, entry: fEntry, basis }, commission: cfg.commission, futureFeePct: cfg.futureFeePct, leverage: cfg.marginDivisor, r: cfg.r, nowMs: now, expiryMs });
        const netUp = ev.expiry(up) - cfg.mmLoss, netDn = ev.expiry(dn) - cfg.mmLoss;
        const worstRisk = -Math.min(...[riskLo, riskHi, spot, ...ev.kinks.filter((x) => x > riskLo && x < riskHi)].map(ev.expiry)) + cfg.mmLoss;
        if (ev.requiredCapital > cfg.capital || worstRisk > lossBudget) { misses.push({ n, fs, a, ac, w, overCapital: ev.requiredCapital > cfg.capital, overRisk: worstRisk > lossBudget, achieved: prevAchieved, requiredCapital: ev.requiredCapital, worstRisk }); break; }
        if (Math.min(netUp, netDn) < cfg.targetPnl) { prevAchieved = Math.min(netUp, netDn); if (n === cfg.maxLots) misses.push({ n, fs, a, ac, w, achieved: prevAchieved, lotLimit: true }); continue; }
        const lo = Math.max(0, spot - 3 * sigma), hi = spot + 3 * sigma, region = regionAtLeast((S) => ev.expiry(S) - cfg.mmLoss, cfg.targetPnl, lo, hi, ev.kinks);
        const prob = region.reduce((m, [x, y]) => m + probIn(spot, x, y >= hi - 1e-9 ? 1e12 : y, atmIV, T, cfg.r), 0);
        const friction = legs.reduce((m, l) => m + (l.ask - l.bid) * l.qty * 100, 0) + 2 * ev.optionFees + 2 * ev.futuresEntryFee;
        const deviation = Math.abs(a - cfg.debitShortSigma) + Math.abs(ac - cfg.creditShortSigma) + Math.abs(w - cfg.wingSigma);
        const th = thetaCheck(legs, cfg.thetaTolerancePct);
        found.push({ fs, a, ac, w, n, legs, ev, fq, qRaw, fEntry, up, dn, netUp, netDn, region, prob, friction, worstRisk, day, dLong, dShort, cShort, cWing, th, callN, putN, lotRule: cu + ":" + pu, lotSource: cfg.lotSource || (lotOverride ? "override" : "default"),
          score: -prob + 0.1 * deviation + 0.25 * friction / cfg.targetPnl + 0.05 * ev.requiredCapital / cfg.capital + (th.status === "DEBIT" ? 0.5 : 0) });
        break;
      }
    }
    // IV skew: mean IV of OTM puts (−1σ…−0.25σ) minus OTM calls (+0.25σ…+1σ), in vol points
    const band = (list, lo, hi) => { const g = list.filter((q) => q.strike >= lo && q.strike <= hi); return g.length ? g.reduce((n, q) => n + q.iv, 0) / g.length : null; };
    const putIV = band(puts, spot - sigma, spot - 0.25 * sigma), callIV = band(calls, spot + 0.25 * sigma, spot + sigma);
    const ivSkew = { putIV, callIV, diffPts: putIV != null && callIV != null ? (putIV - callIV) * 100 : null };
    const common = { method: "reference", priceGapPct, ivSkew, ticker: input.ticker, expiry: input.expiry, expiryCloseUtc: new Date(expiryMs).toISOString(), days: T * 365, spot, spotSource: input.stock && input.stock.price > 0 ? input.stock.source : "Hyperliquid perp mid (proxy: no stock quote)", basis, atmIV, expectedMove: sigma, liquidity, liquidityMoveList: liqMoves, cfg, calibration: input.calibration || null,
      perp: perp ? { symbol: perp.symbol, bid: perp.bid, ask: perp.ask, mid: perp.mid, szDecimals: perp.szDecimals, maxLeverage: perp.maxLeverage, time: perp.time } : null };
    if (!found.length) {
      const ok = misses.filter((m) => fin(m.achieved)).sort((x, y) => y.achieved - x.achieved)[0];
      const allLimited = misses.length && misses.every((m) => m.overCapital || m.overRisk || !fin(m.achieved));
      const why = !seen.size ? "no strike set matched the reference geometry on this chain (too few liquid strikes)" : ok ? "the best equalised scenario P&L within your capital / max-loss limits is about $" + Math.round(ok.achieved).toLocaleString("en-US") + (ok.overCapital ? " (the next lot breaks the capital limit)" : ok.overRisk ? " (the next lot breaks the max-loss limit)" : ok.lotLimit ? " (max lots reached)" : "") : allLimited ? "even 1 debit lot exceeds your capital or max-loss limit" : "no candidate qualified (" + [...new Set(misses.map((m) => m.reason).filter(Boolean))].join("; ") + ")";
      return { ...common, status: "TARGET_NOT_REACHABLE", errors: ["Target $" + cfg.targetPnl.toLocaleString("en-US") + " is not reachable: " + why + ". Lower the target, add capital, raise the max-loss limit, or pick another expiry."], bestAchievable: ok ? ok.achieved : null };
    }
    found.sort((x, y) => x.score - y.score);
    const view = (f) => {
      const ev = f.ev, gl = Math.max(0, spot - 2.5 * sigma), gh = spot + 2.5 * sigma;
      const xs = [...new Set([...Array.from({ length: 121 }, (_, i) => gl + (gh - gl) * i / 120), ...ev.kinks.filter((x) => x > gl && x < gh), spot, f.up, f.dn])].sort((a, b) => a - b);
      const sc = [["Today · up to CE short", f.up, f.day], ["Today · down to PE short", f.dn, f.day], ["Expiry · up at " + f.up, f.up, null], ["Expiry · down at " + f.dn, f.dn, null]]
        .map(([name, S, d]) => ({ name, stock: S, perp: ev.perpAt(S), pnl: (d == null ? ev.expiry(S) : ev.at(S, d)) - cfg.mmLoss }));
      const thin = f.legs.filter((l) => !fin(l.side === "buy" ? l.askSize : l.bidSize) || (l.side === "buy" ? l.askSize : l.bidSize) < l.qty).map((l) => l.contract);
      const debitType = f.fs === "SHORT" ? "call" : "put", creditType = f.fs === "SHORT" ? "put" : "call";
      const why = [
        (cfg.signal && SIGNAL_SIDE[cfg.signal] ? cfg.signal + " signal → perp " + f.fs + " (the perp follows the signal). " : "Signal AUTO → perp " + f.fs + " chosen by score. ") + "The options hedge the other way: " + (f.fs === "SHORT" ? "bullish (call debit spread + put credit spread)" : "bearish (put debit spread + call credit spread)") + ", the pattern of 77 of 78 reference sheets.",
        "Debit " + debitType + " spread: long " + f.dLong.strike + " is the first out-of-the-money strike (" + ((f.dLong.strike - spot) / sigma).toFixed(2) + "σ; reference ≈0.1σ, spot " + spot.toFixed(2) + "); short " + f.dShort.strike + " at " + ((f.dShort.strike - spot) / sigma).toFixed(2) + "σ (reference median 0.9σ; σ = $" + sigma.toFixed(2) + " from ATM IV " + (atmIV * 100).toFixed(1) + "% over " + (T * 365).toFixed(1) + " days).",
        "Credit " + creditType + " spread: short " + f.cShort.strike + " at " + ((f.cShort.strike - spot) / sigma).toFixed(2) + "σ (reference median 0.63σ), wing " + f.cWing.strike + " " + (Math.abs(f.cWing.strike - f.cShort.strike) / sigma).toFixed(2) + "σ beyond it (reference median 0.47σ).",
        "Lots: calls " + f.callN + " : puts " + f.putN + " (" + f.lotRule + ", " + (f.lotSource === "override" ? "your override" : f.lotSource) + ", to keep theta near-neutral or a credit). Net options theta " + f.th.theta.toFixed(2) + " $/day (" + f.th.status + "). This is the smallest size whose equalised expiry P&L reaches the $" + cfg.targetPnl.toLocaleString("en-US") + " target.",
        "Perp " + perp.symbol + ": " + Math.abs(f.fq) + " units = the quantity that equalises today's P&L at the PE short " + f.dn + " and CE short " + f.up + " (" + Math.abs(f.qRaw).toFixed(2) + (cfg.futuresFactor !== 1 ? " × " + cfg.futuresFactor : "") + "), rounded down to a multiple of " + unit + ".",
        "Exit / profit targets: close near the CE short " + f.up + " (upside) or the PE short " + f.dn + " (downside).",
        "Chosen among " + found.length + " qualifying strike sets by risk-neutral probability of finishing in the target zone, closeness to the calibrated distances, bid/ask friction and capital use.",
      ];
      return {
        signal: cfg.signal || "AUTO", futuresSide: f.fs, debitShortSigma: f.a, creditShortSigma: f.ac, wingSigma: f.w, callLots: f.callN, putLots: f.putN, lotRule: f.lotRule, lotSource: f.lotSource, scenarioPrices: { up: f.up, down: f.dn },
        exits: [{ label: "CE short (upside exit / target)", price: f.up, perp: ev.perpAt(f.up), pnlToday: ev.at(f.up, 0) - cfg.mmLoss, pnlExpiry: f.netUp }, { label: "PE short (downside exit / target)", price: f.dn, perp: ev.perpAt(f.dn), pnlToday: ev.at(f.dn, 0) - cfg.mmLoss, pnlExpiry: f.netDn }],
        theta: f.th,
        capital: { futuresNotional: Math.abs(f.fq) * f.fEntry, futuresMargin: ev.futuresMargin, marginDivisor: cfg.marginDivisor, leverage: cfg.leverage, venueInitialMargin: Math.abs(f.fq) * f.fEntry / cfg.leverage, optionsCapital: ev.optionsCapital, fees: ev.optionFees + ev.futuresEntryFee, total: ev.requiredCapital,
          formula: "Total = futures margin (FQ × entry / " + cfg.marginDivisor + ") + options capital (max loss of each defined-risk spread) + entry fees. Venue initial margin at " + cfg.leverage + "× = FQ × entry / " + cfg.leverage + "." },
        legs: f.legs.map((l) => ({ ...l, positionDelta: sgn(l.side) * l.qty * 100 * l.greeks.delta, cashFlow: -sgn(l.side) * l.qty * 100 * l.premium })),
        futures: perp ? { symbol: perp.symbol, side: f.fq > 0 ? "LONG" : "SHORT", qty: Math.abs(f.fq), signedQty: f.fq, entry: f.fEntry, notional: Math.abs(f.fq) * f.fEntry, equalisingQty: r6(f.qRaw), roundTo: unit, deltaNeutralQty: r6(-ev.greeks.optionDelta), margin: ev.futuresMargin, marginDivisor: cfg.marginDivisor, leverage: cfg.leverage, venueInitialMargin: Math.abs(f.fq) * f.fEntry / cfg.leverage, minNotionalOk: Math.abs(f.fq) * f.fEntry >= 10 } : null,
        netCreditDebit: ev.netCreditDebit, maxProfit: ev.maxProfit, maxLoss: ev.maxLoss, unlimitedProfit: ev.unlimitedProfit, unlimitedLoss: ev.unlimitedLoss, breakevens: ev.breakevens,
        worstLossInRiskWindow: f.worstRisk, riskWindow: [riskLo, riskHi], greeks: ev.greeks, optionsCapital: ev.optionsCapital, futuresMargin: ev.futuresMargin, requiredCapital: ev.requiredCapital, fees: { options: ev.optionFees, futuresEntry: ev.futuresEntryFee }, mmLoss: cfg.mmLoss,
        expected: { upExpiry: f.netUp, downExpiry: f.netDn, upToday: ev.at(f.up, f.day) - cfg.mmLoss, downToday: ev.at(f.dn, f.day) - cfg.mmLoss, unchangedExpiry: ev.expiry(spot) - cfg.mmLoss },
        target: { pnl: cfg.targetPnl, prices: [f.dn, f.up], regions: f.region.map(([a, b]) => [a, b >= spot + 3 * sigma - 1e-9 ? null : b]), probability: f.prob },
        scenarios: sc, friction: f.friction, thinSize: thin, why,
        curve: xs.map((S) => ({ stock: S, expiry: ev.expiry(S) - cfg.mmLoss, today: ev.at(S, 0) - cfg.mmLoss })),
      };
    };
    return { ...common, status: "OK", best: view(found[0]), alternatives: found.slice(1, 3).map(view), searched: { strikeSets: seen.size, qualifying: found.length } };
  }
  // ---------------------------------------------------------------- both lot-ratio variants + transparent recommendation
  // Owner (26 Oct 2026): 1 call : 2 puts AND 2 calls : 1 put are both valid for bullish and bearish trades; the perp side
  // follows the signal. Every run computes both (for both perp sides when the signal is AUTO) and recommends one.
  const VARIANTS = [{ key: "1C:2P", call: 1, put: 2 }, { key: "2C:1P", call: 2, put: 1 }];
  const STRUCTURAL = ["INVALID", "NO_PERP", "NO_DATA", "NO_LIQUIDITY", "PRICE_MISMATCH"];
  function summariseVariant(out, v, side) {
    const b = out.best;
    return { key: v.key, side, id: side + " " + v.key, callLotUnits: v.call, putLotUnits: v.put, status: out.status, reachable: out.status === "OK", errors: out.errors || null, bestAchievable: out.bestAchievable ?? null,
      callLots: b ? b.callLots : null, putLots: b ? b.putLots : null, legs: b ? b.legs.map((l) => ({ side: l.side, type: l.type, strike: l.strike, qty: l.qty, premium: l.premium, contract: l.contract })) : null,
      perpQty: b && b.futures ? b.futures.signedQty : null, futuresMargin: b ? b.capital.futuresMargin : null, optionsCapital: b ? b.capital.optionsCapital : null, totalCapital: b ? b.capital.total : null,
      exits: b ? b.exits : null, theta: b ? b.theta : null, maxLoss: b ? b.maxLoss : null, unlimitedLoss: b ? b.unlimitedLoss : null, worstLossInRiskWindow: b ? b.worstLossInRiskWindow : null, probability: b ? b.target.probability : null,
      best: b || null, alternatives: out.alternatives || [] };
  }
  function recommendVariant(list, ctx) {
    const ok = list.filter((v) => v.reachable), m = ctx.market, ref = ctx.referenceLots || {}, skew = ctx.ivSkew && ctx.ivSkew.diffPts;
    if (!ok.length) return null;
    const minCap = Math.min(...ok.map((v) => v.totalCapital)), maxCap = Math.max(...ok.map((v) => v.totalCapital));
    const trendSide = m && (m.direction === "LONG" || m.direction === "SHORT") ? m.direction : null, strong = m && m.maxScore ? m.score / m.maxScore >= 0.75 : false;
    for (const v of ok) {
      const pts = [], add = (x, t) => pts.push({ points: x, why: t });
      add(v.theta.status === "CREDIT" ? 2 : v.theta.status === "NEAR-NEUTRAL" ? 1 : -2, "theta " + v.theta.status.toLowerCase() + " (" + v.theta.theta.toFixed(0) + " $/day)");
      if (ok.length > 1 && v.totalCapital === minCap && maxCap > minCap * 1.1) add(2, "least capital for the target ($" + Math.round(minCap).toLocaleString("en-US") + " vs $" + Math.round(maxCap).toLocaleString("en-US") + ")");
      const doubled = v.put > v.call ? "put" : "call", doubledIsCredit = (v.side === "SHORT") === (doubled === "put");
      if (skew != null && Math.abs(skew) >= 2) { const rich = skew > 0 ? "put" : "call";
        if (doubled === rich) add(doubledIsCredit ? 1 : -1, (doubledIsCredit ? "sells" : "buys") + " the richer " + rich + "s twice (put−call IV skew " + skew.toFixed(1) + " pts)"); }
      const upExit = v.exits[0].pnlExpiry, dnExit = v.exits[1].pnlExpiry;
      if (trendSide) {
        if (ctx.sides > 1) add(trendSide === v.side ? 2 : -1, "indicators " + (trendSide === v.side ? "agree with" : "oppose") + " a " + v.side + " perp (" + m.direction + " " + m.score + "/" + m.maxScore + ")");
        const inTrend = trendSide === "LONG" ? upExit : dnExit, others = ok.filter((x) => x.side === v.side && x !== v).map((x) => (trendSide === "LONG" ? x.exits[0].pnlExpiry : x.exits[1].pnlExpiry));
        if (others.length && inTrend > Math.max(...others)) add(strong ? 2 : 1, (strong ? "strong " : "") + trendSide.toLowerCase() + " trend: larger P&L at the " + (trendSide === "LONG" ? "CE" : "PE") + "-short exit ($" + Math.round(inTrend).toLocaleString("en-US") + ")");
      } else {
        const others = ok.filter((x) => x.side === v.side && x !== v).map((x) => Math.min(x.exits[0].pnlExpiry, x.exits[1].pnlExpiry));
        if (others.length && Math.min(upExit, dnExit) > Math.max(...others)) add(1, "no clear trend (" + (m ? m.direction : "indicators unavailable") + "): better worst exit ($" + Math.round(Math.min(upExit, dnExit)).toLocaleString("en-US") + ")");
      }
      const r = ref[v.side]; if (r) { const tot = (r["1C:2P"] || 0) + (r["2C:1P"] || 0), mine = r[v.key] || 0; if (tot && mine / tot >= 0.6) add(1, "reference sheets used " + v.key + " on " + mine + "/" + tot + " " + v.side + "-perp pages"); }
      v.points = pts; v.score = pts.reduce((n, p) => n + p.points, 0);
    }
    const sorted = ok.slice().sort((a, b) => b.score - a.score || a.totalCapital - b.totalCapital), rec = sorted[0];
    return { id: rec.id, key: rec.key, side: rec.side, score: rec.score,
      reason: rec.side + " perp · " + rec.key + " recommended (score " + rec.score + "): " + rec.points.map((p) => (p.points > 0 ? "+" : "") + p.points + " " + p.why).join("; ") + "." + (sorted.length > 1 ? " Next: " + sorted.slice(1).map((v) => v.id + " " + v.score).join(", ") + "." : "") };
  }
  function buildReference(input) {
    const c = input.cfg || {};
    if (c.callLotUnits != null || c.putLotUnits != null) { const o = buildReferenceOne({ ...input, cfg: { ...c, lotSource: "your override" } }); return { ...o, variants: null, recommendation: { mode: "override", reason: "Fixed lot ratio " + c.callLotUnits + "C:" + c.putLotUnits + "P (your override); both-variant comparison skipped." } }; }
    const side = SIGNAL_SIDE[c.signal] || (c.futuresSide === "LONG" || c.futuresSide === "SHORT" ? c.futuresSide : null), sides = side ? [side] : ["LONG", "SHORT"], runs = [];
    for (const fs of sides) for (const v of VARIANTS) {
      const out = buildReferenceOne({ ...input, cfg: { ...c, signal: fs === "LONG" ? "BULLISH" : "BEARISH", futuresSide: fs, callLotUnits: v.call, putLotUnits: v.put, lotSource: v.key + " variant" } });
      if (STRUCTURAL.includes(out.status)) return { ...out, variants: null, recommendation: null };
      runs.push({ out, v: summariseVariant(out, v, fs) });
    }
    const list = runs.map((r) => r.v), ctx = { market: input.market || null, referenceLots: input.referenceLots || null, ivSkew: runs[0].out.ivSkew, sides: sides.length };
    const rec = recommendVariant(list, ctx);
    for (const v of list) v.recommended = !!rec && v.id === rec.id;
    const base = rec ? runs.find((r) => r.v.id === rec.id).out : runs.slice().sort((a, b) => (b.out.bestAchievable ?? -Infinity) - (a.out.bestAchievable ?? -Infinity))[0].out;
    const status = rec ? "OK" : "TARGET_NOT_REACHABLE";
    return { ...base, status, signal: c.signal || "AUTO", variants: list, recommendation: rec ? { mode: "both", ...rec, market: ctx.market, ivSkew: ctx.ivSkew } : { mode: "both", reason: "Neither lot ratio reaches the target within your limits.", market: ctx.market, ivSkew: ctx.ivSkew },
      errors: rec ? undefined : list.map((v) => v.id + ": " + (v.errors || []).join(" ")) };
  }
  // Payload for a future "Execute on Alpaca" multi-leg (mleg) limit order. NOT submitted anywhere.
  function alpacaOrderPreview(legs) {
    const gcd = (a, b) => (b ? gcd(b, a % b) : a), g = legs.reduce((n, l) => gcd(n, l.qty), 0) || 1;
    const net = legs.reduce((n, l) => n + sgn(l.side) * l.premium * l.qty / g, 0);
    return { order_class: "mleg", qty: String(g), type: "limit", limit_price: (Math.round(net * 100) / 100).toFixed(2), time_in_force: "day",
      legs: legs.map((l) => ({ symbol: l.contract, ratio_qty: String(l.qty / g), side: l.side, position_intent: l.side === "buy" ? "buy_to_open" : "sell_to_open" })) };
  }
  root.Strategy = Object.assign(root.Strategy || {}, { build, buildReference, buildReferenceOne, recommendVariant, VARIANTS, REFERENCE_DEFAULTS, thetaCheck, SIGNAL_SIDE, evaluate, classify, pairs, regionAtLeast, probIn, bs, bsGreeks, impliedVol, expiryCloseMs, alpacaOrderPreview, cdf });
})(typeof globalThis !== "undefined" ? globalThis : window);
