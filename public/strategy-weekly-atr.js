// QuantSignal "Weekly ATR distances" strike selection. Pure functions (no network); loaded after strategy-engine.js and
// strategy-optimizer.js in the browser and on the server. Extends globalThis.Strategy.
//
//   Weekly ATR = Wilder ATR over N completed weekly bars (default 14), true range of each weekly bar
//                TR = max(H − L, |H − prevC|, |L − prevC|); seed = mean of the first N TRs, then ATR = (ATR·(N−1) + TR) / N.
//   CE short   = nearest listed call strike to spot + upperMult × ATR_eff
//   PE short   = nearest listed put strike to spot − lowerMult × ATR_eff
//   ATR_eff    = ATR (default) or ATR × √(trading days to expiry ÷ 5) when "scale to expiry" is on.
// Everything else (perp side from the signal, both lot ratios, equalising perp qty floored to 5, margin = FQ × entry / 2,
// theta check, data-sanity filters, risk caps, per-lot targets, what-if) is the optimizer's machinery with the two short
// strikes fixed and the long legs placed the way the reference-sheet method places them.
(function (root) {
  "use strict";
  const S = root.Strategy;
  const fin = (x) => typeof x === "number" && Number.isFinite(x);
  const DAY = 864e5;
  const WEEKLY_ATR_DEFAULTS = { atrPeriod: 14, upperMult: 0.42, lowerMult: 0.41, zoneMinSigma: 0.7, zoneMaxSigma: 1.2, scaleToExpiry: false, atrSource: "auto", debitLongSigma: 0.1, wingSigma: 0.47 };
  // Monday (YYYY-MM-DD) of the week containing an ISO date
  function weekStartOf(date) {
    const d = new Date(String(date).slice(0, 10) + "T00:00:00Z"), dow = (d.getUTCDay() + 6) % 7;
    return new Date(d.getTime() - dow * DAY).toISOString().slice(0, 10);
  }
  // daily [{date:'YYYY-MM-DD', o,h,l,c}] → weekly bars [{week, start, end, o,h,l,c, days}] ascending; weeks ≥ beforeWeek are dropped
  // (the current week is still forming, and a partial bar would understate its true range).
  function weeklyBarsFromDaily(daily, opts = {}) {
    const by = new Map();
    for (const x of daily.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
      if (![x.o, x.h, x.l, x.c].every(fin) || !(x.h >= x.l) || !(x.c > 0)) continue;
      const w = weekStartOf(x.date); if (opts.beforeWeek && w >= opts.beforeWeek) continue;
      const b = by.get(w);
      if (!b) by.set(w, { week: w, start: x.date, end: x.date, o: x.o, h: x.h, l: x.l, c: x.c, days: 1 });
      else { b.h = Math.max(b.h, x.h); b.l = Math.min(b.l, x.l); b.c = x.c; b.end = x.date; b.days++; }
    }
    return [...by.values()].sort((a, b) => (a.week < b.week ? -1 : 1));
  }
  // Wilder ATR. Needs N + 1 bars (each TR uses the previous close). Returns null when there are too few bars.
  function wilderAtr(bars, n = 14) {
    if (!(Number.isInteger(n) && n >= 1) || !Array.isArray(bars) || bars.length < n + 1) return null;
    const trs = [];
    for (let i = 1; i < bars.length; i++) { const b = bars[i], pc = bars[i - 1].c; trs.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc))); }
    let atr = trs.slice(0, n).reduce((m, x) => m + x, 0) / n;
    for (let i = n; i < trs.length; i++) atr = (atr * (n - 1) + trs[i]) / n;
    return { atr, n, barsUsed: bars.length, trueRanges: trs, firstWeek: bars[0].week, lastWeek: bars[bars.length - 1].week, lastClose: bars[bars.length - 1].c };
  }
  // nearest strike to target; an exact tie goes to the strike farther from spot (the more conservative short)
  function snapStrike(strikes, target, spot) {
    const list = [...new Set(strikes.filter(fin))]; if (!list.length) return null;
    return list.reduce((best, k) => { const d = Math.abs(k - target), db = Math.abs(best - target); return d < db - 1e-9 || (Math.abs(d - db) <= 1e-9 && fin(spot) && Math.abs(k - spot) > Math.abs(best - spot)) ? k : best; });
  }
  // US trading sessions left until expiry (weekdays, America/New_York; today counts if before the 16:00 close). Exchange
  // holidays are not removed. Minimum 1.
  function tradingDaysTo(expiry, nowMs = Date.now()) {
    const ny = (ms) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return { date: p.year + "-" + p.month + "-" + p.day, hour: +p.hour }; };
    const t = ny(nowMs); let n = 0;
    for (let d = new Date(t.date + "T00:00:00Z"); d.toISOString().slice(0, 10) <= expiry; d = new Date(d.getTime() + DAY)) {
      const iso = d.toISOString().slice(0, 10), dow = d.getUTCDay(); if (dow === 0 || dow === 6) continue;
      if (iso === t.date && t.hour >= 16) continue; n++;
    }
    return Math.max(1, n);
  }
  function validateWeeklyAtr(w) {
    const e = [];
    if (!(fin(w.atr) && w.atr > 0)) e.push("Weekly ATR is not available");
    if (!(Number.isInteger(w.n) && w.n >= 2 && w.n <= 52)) e.push("Weekly ATR period N must be a whole number 2–52");
    if (!(fin(w.upperMult) && w.upperMult > 0 && w.upperMult <= 5)) e.push("Upper distance must be > 0 and ≤ 5 × weekly ATR");
    if (!(fin(w.lowerMult) && w.lowerMult > 0 && w.lowerMult <= 5)) e.push("Lower distance must be > 0 and ≤ 5 × weekly ATR");
    const zl = w.zoneMinSigma, zh = w.zoneMaxSigma;
    if (!((zl == null || (fin(zl) && zl >= 0 && zl <= 5)) && (zh == null || (fin(zh) && zh > 0 && zh <= 5)) && (zl == null || zh == null || zl < zh))) e.push("σ zone: min ≥ 0, max > min and ≤ 5 (blank = off)");
    return e;
  }
  // Fix the CE / PE short strikes from the weekly ATR. group = every contract listed at the expiry; calls / puts = the
  // quotes that have a usable quote and IV. A snapped strike without one is moved to the nearest quoted
  // strike on the same side, with a warning (quotes are never invented).
  function resolveWeeklyAtrShorts(w, { spot, sigma, group, calls, puts, tradingDays }) {
    const errs = validateWeeklyAtr(w); if (errs.length) return { errors: errs };
    const scale = w.scaleToExpiry ? Math.sqrt(Math.max(1, tradingDays) / 5) : 1, eff = w.atr * scale, warnings = [];
    // the ATR distance, clamped into the σ "middle zone" (default 0.7–1.2σ to expiry) so the shorts are neither too close nor too wide
    const zl = fin(w.zoneMinSigma) && sigma > 0 ? w.zoneMinSigma * sigma : null, zh = fin(w.zoneMaxSigma) && sigma > 0 ? w.zoneMaxSigma * sigma : null;
    const clampD = (x) => { let y = x; if (zl != null && y < zl) y = zl; if (zh != null && y > zh) y = zh; return y; };
    const ceRaw = w.upperMult * eff, peRaw = w.lowerMult * eff, ceD = clampD(ceRaw), peD = clampD(peRaw);
    const ceTarget = spot + ceD, peTarget = spot - peD, ceRawTarget = spot + ceRaw, peRawTarget = spot - peRaw;
    const zoneTxt = (raw, used) => (raw < used ? "raised to the " + w.zoneMinSigma + "σ zone minimum" : "lowered to the " + w.zoneMaxSigma + "σ zone maximum");
    if (Math.abs(ceD - ceRaw) > 1e-9) warnings.push("CE distance " + w.upperMult + "×ATR = $" + ceRaw.toFixed(2) + " (" + (ceRaw / sigma).toFixed(2) + "σ) " + zoneTxt(ceRaw, ceD) + " → $" + ceD.toFixed(2) + ".");
    if (Math.abs(peD - peRaw) > 1e-9) warnings.push("PE distance " + w.lowerMult + "×ATR = $" + peRaw.toFixed(2) + " (" + (peRaw / sigma).toFixed(2) + "σ) " + zoneTxt(peRaw, peD) + " → $" + peD.toFixed(2) + ".");
    const listed = (type) => group.filter((c) => c.type === type).map((c) => c.strike);
    let ceSnap = snapStrike(listed("call"), ceTarget, spot), peSnap = snapStrike(listed("put"), peTarget, spot);
    if (ceSnap != null && !(ceSnap > spot)) { const up = listed("call").filter((k) => k > spot).sort((a, b) => a - b)[0]; warnings.push("Nearest call strike to spot + " + w.upperMult + "×ATR is " + ceSnap + ", not above spot " + spot.toFixed(2) + "; using the first strike above spot" + (up != null ? " (" + up + ")" : "") + "."); ceSnap = up ?? null; }
    if (peSnap != null && !(peSnap < spot)) { const dn = listed("put").filter((k) => k < spot).sort((a, b) => b - a)[0]; warnings.push("Nearest put strike to spot − " + w.lowerMult + "×ATR is " + peSnap + ", not below spot " + spot.toFixed(2) + "; using the first strike below spot" + (dn != null ? " (" + dn + ")" : "") + "."); peSnap = dn ?? null; }
    if (ceSnap == null || peSnap == null) return { errors: ["No listed " + (ceSnap == null ? "call strike above" : "put strike below") + " spot for the weekly-ATR short strike"] };
    const liquid = (list, k, side) => { const q = list.find((x) => x.strike === k); if (q) return { q, moved: false };
      const cand = list.filter((x) => (side > 0 ? x.strike > spot : x.strike < spot)).sort((a, b) => Math.abs(a.strike - k) - Math.abs(b.strike - k))[0]; return cand ? { q: cand, moved: true } : null; };
    const ce = liquid(calls, ceSnap, 1), pe = liquid(puts, peSnap, -1);
    if (!ce || !pe) return { errors: ["No quoted " + (!ce ? "call above" : "put below") + " spot for the weekly-ATR short strike"] };
    if (ce.moved) warnings.push("CE short " + ceSnap + " (nearest listed to spot + " + w.upperMult + "×ATR) has no usable quote; using the nearest quoted call " + ce.q.strike + ".");
    if (pe.moved) warnings.push("PE short " + peSnap + " (nearest listed to spot − " + w.lowerMult + "×ATR) has no usable quote; using the nearest quoted put " + pe.q.strike + ".");
    const dist = (k) => ({ dollars: k - spot, pct: (k / spot - 1) * 100, atrs: (k - spot) / eff, sigmas: sigma > 0 ? (k - spot) / sigma : null });
    const info = { atr: w.atr, n: w.n, source: w.source || null, sourceKind: w.sourceKind || null, barsUsed: w.barsUsed ?? null, firstWeek: w.firstWeek || null, lastWeek: w.lastWeek || null, recentBars: w.recentBars || null,
      upperMult: w.upperMult, lowerMult: w.lowerMult, multSource: w.multSource || null, scaleToExpiry: !!w.scaleToExpiry, tradingDays, scale, effectiveAtr: eff, spot,
      zoneMinSigma: fin(w.zoneMinSigma) ? w.zoneMinSigma : null, zoneMaxSigma: fin(w.zoneMaxSigma) ? w.zoneMaxSigma : null, ceRawTarget, peRawTarget, ceClamped: Math.abs(ceD - ceRaw) > 1e-9, peClamped: Math.abs(peD - peRaw) > 1e-9,
      ceTarget, peTarget, ceSnapped: ceSnap, peSnapped: peSnap, ceShort: ce.q.strike, peShort: pe.q.strike, ceMoved: ce.moved, peMoved: pe.moved,
      ceDistance: dist(ce.q.strike), peDistance: dist(pe.q.strike), debitLongSigma: fin(w.debitLongSigma) ? w.debitLongSigma : WEEKLY_ATR_DEFAULTS.debitLongSigma, wingSigma: fin(w.wingSigma) ? w.wingSigma : WEEKLY_ATR_DEFAULTS.wingSigma };
    return { ceQ: ce.q, peQ: pe.q, info, warnings };
  }
  // Candidate strike sets for one perp side with the shorts fixed: long legs as in the reference-sheet method (debit long =
  // first OTM strike near debitLongSigma·σ; credit wing ≈ wingSigma·σ beyond the credit short, also 0.35/0.47/0.6σ).
  function weeklyAtrStrikeSets(fs, wa, { spot, sigma, calls, puts }) {
    const D = fs === "SHORT" ? calls : puts, C = fs === "SHORT" ? puts : calls, d = fs === "SHORT" ? 1 : -1;
    const ds = fs === "SHORT" ? wa.ceQ : wa.peQ, cs = fs === "SHORT" ? wa.peQ : wa.ceQ, info = wa.info;
    const nearest = (list, x, pred) => list.filter(pred).sort((a, b) => Math.abs(a.strike - x) - Math.abs(b.strike - x))[0];
    const dl = nearest(D, spot + d * info.debitLongSigma * sigma, (q) => d * (q.strike - spot) >= 0 && d * (ds.strike - q.strike) > 0) || nearest(D, spot, (q) => d * (ds.strike - q.strike) > 0);
    if (!dl) return [];
    const out = [], seen = new Set();
    for (const w of [...new Set([info.wingSigma, 0.35, 0.47, 0.6].map((x) => Math.round(x * 1e6) / 1e6))]) {
      const cw = nearest(C, cs.strike - d * w * sigma, (q) => d * (cs.strike - q.strike) > 0); if (!cw || seen.has(cw.strike)) continue;
      seen.add(cw.strike); out.push([dl, ds, cs, cw]);
    }
    return out;
  }
  Object.assign(S, { WEEKLY_ATR_DEFAULTS, weekStartOf, weeklyBarsFromDaily, wilderAtr, snapStrike, tradingDaysTo, validateWeeklyAtr, resolveWeeklyAtrShorts, weeklyAtrStrikeSets });
})(typeof globalThis !== "undefined" ? globalThis : window);
