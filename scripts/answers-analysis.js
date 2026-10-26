// Verifies the user's answers (26 Oct 2026) against the 78 reference sheets:
//  1. investment formula (futures margin = FQ × entry / 2, 5× leverage)   2. perp side follows the signal; exits at the short strikes
//  3. perp quantity rounded DOWN to multiples of 5                         4. calls 1 lot : puts 2 lots for near-neutral / credit theta
// Usage: node scripts/answers-analysis.js   (prints JSON summary)
'use strict';
const { run } = require('./reference-analysis');
require('../public/strategy-engine.js');
const S = globalThis.Strategy, R = 0.04;
const med = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const absMed = a => med(a.filter(Number.isFinite).map(Math.abs)), within = (a, t) => a.filter(x => Number.isFinite(x) && Math.abs(x) <= t).length;
const pct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b ? (a - b) / Math.abs(b) * 100 : null);
const floor5 = x => (Number.isFinite(x) ? Math.sign(x) * Math.floor(Math.abs(x) / 5 + 1e-9) * 5 : null);

function legsOf(r) {
  return ['callA', 'callB', 'putA', 'putB'].map((k, i) => ({ type: i < 2 ? 'call' : 'put', strike: r[k + 'Strike'], units: r[k + 'Units'], premium: r[k + 'Premium'], side: r[k + 'Units'] > 0 ? 'buy' : 'sell', qty: Math.abs(r[k + 'Units']) / 100 }));
}
// Option capital pieces of one book
function optionPieces(legs) {
  let debit = 0, creditMargin = 0, netCash = 0, maxLoss = 0;
  for (const t of ['call', 'put']) {
    const g = legs.filter(l => l.type === t); if (g.length !== 2 || g.some(l => l.premium == null)) return null;
    const cash = g.reduce((m, l) => m - l.units * l.premium, 0), width = Math.abs(g[0].strike - g[1].strike) * Math.min(...g.map(l => Math.abs(l.units)));
    netCash += cash;
    if (cash < 0) { debit += -cash; maxLoss += -cash; } else { creditMargin += Math.max(0, width - cash); maxLoss += Math.max(0, width - cash); }
  }
  return { debit, creditMargin, netCash, maxLoss, credit: Math.max(0, netCash) };
}
const CANDIDATES = {
  'FQ×E/2': (N) => N / 2,
  'FQ×E/2 + spread max-loss (debit paid + credit-spread margin)': (N, o) => N / 2 + o.maxLoss,
  'FQ×E/2 + net option debit': (N, o) => N / 2 + Math.max(0, -o.netCash),
  'FQ×E/2 + debit-spread cost': (N, o) => N / 2 + o.debit,
  'FQ×E/2 + credit-spread margin': (N, o) => N / 2 + o.creditMargin,
  'FQ×E/2 + credit-spread width (gross)': (N, o) => N / 2 + o.creditMargin + (o.netCash > 0 ? o.netCash : 0),
  'FQ×E/5 + spread max-loss': (N, o) => N / 5 + o.maxLoss,
  'FQ×E/5 + net option debit': (N, o) => N / 5 + Math.max(0, -o.netCash),
  'FQ×E (notional)': (N) => N,
  'FQ×E/2 + FQ×E/5': (N) => N / 2 + N / 5,
};
function compute() {
  const { rows, res } = run();
  const unique = rows.filter((r, i) => rows.findIndex(x => x.symbol === r.symbol && x.futureEntry === r.futureEntry && x.futureQty === r.futureQty && JSON.stringify(legsOf(x)) === JSON.stringify(legsOf(r))) === i);
  // ---- 1. investment
  const inv = {};
  for (const [name, fn] of Object.entries(CANDIDATES)) {
    const errs = [], per = [];
    for (const r of rows) { const o = optionPieces(legsOf(r)); if (!r.investment || !o) continue; const N = Math.abs(r.futureQty) * r.futureEntry, v = fn(N, o); const e = pct(v, r.investment); errs.push(e); per.push({ page: r.page, model: Math.round(v), investment: r.investment, errPct: e == null ? null : +e.toFixed(1) }); }
    inv[name] = { n: errs.length, medianErrPct: med(errs), medianAbsErrPct: absMed(errs), within2: within(errs, 2), within5: within(errs, 5), within10: within(errs, 10), per };
  }
  const best = Object.entries(inv).sort((a, b) => a[1].medianAbsErrPct - b[1].medianAbsErrPct)[0];
  // Empirical least-squares fit investment ≈ a·notional + b·spread max-loss (descriptive only, not a rule the owner gave).
  const pts = rows.map(r => ({ r, o: optionPieces(legsOf(r)) })).filter(x => x.r.investment && x.o).map(({ r, o }) => ({ N: Math.abs(r.futureQty) * r.futureEntry, L: o.maxLoss, y: r.investment }));
  const sNN = pts.reduce((m, p) => m + p.N * p.N, 0), sNL = pts.reduce((m, p) => m + p.N * p.L, 0), sLL = pts.reduce((m, p) => m + p.L * p.L, 0), sNy = pts.reduce((m, p) => m + p.N * p.y, 0), sLy = pts.reduce((m, p) => m + p.L * p.y, 0), det = sNN * sLL - sNL * sNL;
  const fa = (sNy * sLL - sLy * sNL) / det, fb = (sNN * sLy - sNL * sNy) / det, fitErr = pts.map(p => pct(fa * p.N + fb * p.L, p.y));
  const empiricalFit = { a: +fa.toFixed(3), b: +fb.toFixed(3), n: pts.length, medianAbsErrPct: absMed(fitErr), within10: within(fitErr, 10), residualOverHalfNotionalMedian: med(pts.map(p => p.y - p.N / 2)) };
  // ---- 3. futures rounding: floor to 5 of the equalising quantity (sheet TODAY P&L and our BS model)
  const q = rows.map((r, i) => { const a = res[i]; return { page: r.page, actual: r.futureQty, sheetEq: a.eqQtyToday, modelEq: a.modelQtyToday,
    floor5Sheet: floor5(a.eqQtyToday), floor5Model: floor5(a.modelQtyToday), x095Sheet: floor5(a.eqQtyToday * 0.95), x095Model: floor5(a.modelQtyToday * 0.95) }; });
  const errOf = k => q.map(x => pct(Math.abs(x.actual), Math.abs(x[k])) == null ? null : (Math.abs(x.actual) - Math.abs(x[k])) / Math.abs(x[k]) * 100);
  const qty = Object.fromEntries(['floor5Sheet', 'floor5Model', 'x095Sheet', 'x095Model'].map(k => { const e = errOf(k); return [k, { n: e.filter(Number.isFinite).length, medianAbsErrPct: absMed(e), exact: q.filter(x => x[k] != null && Math.abs(x[k]) === Math.abs(x.actual)).length, within5: within(e, 5), within10: within(e, 10) }]; }));
  const mult5 = rows.filter(r => Math.abs(r.futureQty) % 5 === 0).length, belowEq = q.filter(x => Number.isFinite(x.sheetEq) && Math.abs(x.actual) <= Math.abs(x.sheetEq) + 1e-9).length;
  // ---- 2. direction: perp side vs options direction; exit at short strikes
  const dir = rows.map((r, i) => ({ page: r.page, perp: r.futureQty > 0 ? 'LONG' : 'SHORT', options: res[i].pattern, opposes: res[i].futuresOpposesOptions, upAtShortCall: res[i].upMatchesShortCall, downAtShortPut: res[i].downMatchesShortPut, closeDirection: r.closeDirection }));
  // ---- 4. lots: calls : puts, and theta
  const lots = rows.map((r, i) => {
    const L = legsOf(r), cl = L[0].qty, pl = L[2].qty, eq = L[0].qty === L[1].qty && L[2].qty === L[3].qty;
    const a = res[i], T = a.dte > 0 ? a.dte / 365 : null; let theta = null, gross = null, theta12 = null;
    if (T && L.every(l => l.premium > 0)) {
      const g = L.map(l => { const iv = S.impliedVol(l.premium, r.futureEntry, l.strike, T, R, l.type); return iv ? S.bsGreeks(r.futureEntry, l.strike, T, iv, R, l.type) : null; });
      if (g.every(Boolean)) {
        theta = L.reduce((n, l, k) => n + (l.side === 'buy' ? 1 : -1) * l.qty * 100 * g[k].theta, 0); gross = L.reduce((n, l, k) => n + l.qty * 100 * Math.abs(g[k].theta), 0);
        const base = Math.min(cl, pl); theta12 = L.reduce((n, l, k) => n + (l.side === 'buy' ? 1 : -1) * (l.type === 'call' ? base : 2 * base) * 100 * g[k].theta, 0);
      }
    }
    const status = theta == null ? null : theta >= 0 ? 'CREDIT' : Math.abs(theta) <= 0.15 * gross ? 'NEAR-NEUTRAL' : 'DEBIT';
    return { page: r.page, perp: r.futureQty > 0 ? 'LONG' : 'SHORT', callLots: cl, putLots: pl, equalWithinType: eq, calls1puts2: eq && pl === 2 * cl, calls2puts1: eq && cl === 2 * pl, theta: theta == null ? null : +theta.toFixed(1), grossTheta: gross == null ? null : +gross.toFixed(1), thetaStatus: status, thetaIfCalls1Puts2: theta12 == null ? null : +theta12.toFixed(1) };
  });
  const by = (list, pred) => list.filter(pred).length;
  const lotSummary = {
    bySignal: (() => { const ok = x => (x.perp === 'LONG' ? x.calls2puts1 : x.calls1puts2), m = lots.filter(x => !ok(x)), th = lots.filter(x => ok(x) && x.thetaStatus);
      return { n: lots.length, matches: lots.length - m.length, mismatches: m.map(x => x.page + ' (' + x.perp + ' ' + x.callLots / 100 + 'c:' + x.putLots / 100 + 'p)'), longOk: by(lots, x => x.perp === 'LONG' && ok(x)), shortOk: by(lots, x => x.perp === 'SHORT' && ok(x)),
        theta: { evaluated: th.length, credit: by(th, x => x.thetaStatus === 'CREDIT'), nearNeutral: by(th, x => x.thetaStatus === 'NEAR-NEUTRAL'), debit: by(th, x => x.thetaStatus === 'DEBIT') } }; })(),
    all: { n: lots.length, calls1puts2: by(lots, x => x.calls1puts2), calls2puts1: by(lots, x => x.calls2puts1), other: lots.filter(x => !x.calls1puts2 && !x.calls2puts1).map(x => x.page + ' (' + x.callLots + 'c/' + x.putLots + 'p)') },
    shortPerp: { n: by(lots, x => x.perp === 'SHORT'), calls1puts2: by(lots, x => x.perp === 'SHORT' && x.calls1puts2), calls2puts1: by(lots, x => x.perp === 'SHORT' && x.calls2puts1) },
    longPerp: { n: by(lots, x => x.perp === 'LONG'), calls1puts2: by(lots, x => x.perp === 'LONG' && x.calls1puts2), calls2puts1: by(lots, x => x.perp === 'LONG' && x.calls2puts1), calls1puts2Pages: lots.filter(x => x.perp === 'LONG' && x.calls1puts2).map(x => x.page) },
    theta: { evaluated: by(lots, x => x.thetaStatus), credit: by(lots, x => x.thetaStatus === 'CREDIT'), nearNeutral: by(lots, x => x.thetaStatus === 'NEAR-NEUTRAL'), debit: by(lots, x => x.thetaStatus === 'DEBIT'),
      longPerpCalls2Puts1: { credit: by(lots, x => x.perp === 'LONG' && x.calls2puts1 && x.thetaStatus === 'CREDIT'), n: by(lots, x => x.perp === 'LONG' && x.calls2puts1 && x.thetaStatus) },
      longPerpAs1to2: { creditOrNeutral: by(lots, x => x.perp === 'LONG' && x.calls2puts1 && x.thetaIfCalls1Puts2 != null && x.thetaIfCalls1Puts2 >= -0.15 * x.grossTheta), n: by(lots, x => x.perp === 'LONG' && x.calls2puts1 && x.thetaIfCalls1Puts2 != null) } },
  };
  return {
    investment: { candidates: Object.fromEntries(Object.entries(inv).map(([k, v]) => [k, { n: v.n, medianErrPct: v.medianErrPct, medianAbsErrPct: v.medianAbsErrPct, within2: v.within2, within5: v.within5, within10: v.within10 }])), best: best[0], bestPer: best[1].per, empiricalFit },
    futuresQty: { multiplesOf5: mult5, rows: rows.length, atOrBelowSheetEqualising: belowEq, rules: qty },
    direction: { perpOpposesOptions: by(dir, x => x.opposes), rows: dir.length, conflicts: dir.filter(x => !x.opposes).map(x => x.page), upAtShortCall: by(dir, x => x.upAtShortCall), downAtShortPut: by(dir, x => x.downAtShortPut),
      closeVsPerp: { longClosedUp: by(dir, x => x.perp === 'LONG' && x.closeDirection === 'UPSIDE'), longClosedDown: by(dir, x => x.perp === 'LONG' && x.closeDirection === 'DOWNSIDE'), shortClosedDown: by(dir, x => x.perp === 'SHORT' && x.closeDirection === 'DOWNSIDE'), shortClosedUp: by(dir, x => x.perp === 'SHORT' && x.closeDirection === 'UPSIDE') } },
    lots: lotSummary, lotRows: lots, uniqueTrades: unique.length,
  };
}
module.exports = { compute, CANDIDATES, optionPieces, floor5 };
if (require.main === module) { const c = compute(); delete c.lotRows; delete c.investment.bestPer; console.log(JSON.stringify(c, null, 1)); }
