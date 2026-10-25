// Reverse-engineers the four-leg + futures methodology from the reference sheets (data/reference/reference-sheets.json)
// and measures how well the engine rules reproduce each row. Usage: node scripts/reference-analysis.js [--json out.json] [--md docs/table.md]
'use strict';
const fs = require('fs'), path = require('path');
require('../public/strategy-engine.js');
const { Strategy } = globalThis;
const REF_PATH = path.join(__dirname, '../data/reference/reference-sheets.json');
const loadRows = () => JSON.parse(fs.readFileSync(REF_PATH, 'utf8'));
const R = 0.04, pct = (a, b) => (b ? (a - b) / Math.abs(b) * 100 : null), round = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

function analyse(r) {
  const S = r.futureEntry, out = { page: r.page, symbol: r.symbol, S, openDate: r.openDate, expiry: r.expiry };
  const legs = ['callA', 'callB', 'putA', 'putB'].map((k, i) => ({ type: i < 2 ? 'call' : 'put', strike: r[k + 'Strike'], units: r[k + 'Units'], premium: r[k + 'Premium'] }));
  legs.forEach(l => { l.side = l.units > 0 ? 'buy' : 'sell'; l.qty = Math.abs(l.units) / 100; });
  const dte = r.openDate && r.expiry ? (Date.parse(r.expiry) - Date.parse(r.openDate)) / 864e5 : null;
  out.dte = dte;
  const calls = legs.filter(l => l.type === 'call'), puts = legs.filter(l => l.type === 'put');
  const cb = calls.find(l => l.side === 'buy'), cs = calls.find(l => l.side === 'sell'), pb = puts.find(l => l.side === 'buy'), ps = puts.find(l => l.side === 'sell');
  if (!cb || !cs || !pb || !ps) { out.structure = 'not a call pair + put pair'; return out; }
  out.callSpread = cb.strike < cs.strike ? 'bull call DEBIT' : 'bear call CREDIT';
  out.putSpread = pb.strike > ps.strike ? 'bear put DEBIT' : 'bull put CREDIT';
  const debit = out.callSpread.includes('DEBIT') ? 'call' : 'put';
  out.pattern = out.callSpread.includes('DEBIT') && out.putSpread.includes('CREDIT') ? 'BULLISH options (call debit + put credit)' : out.callSpread.includes('CREDIT') && out.putSpread.includes('DEBIT') ? 'BEARISH options (call credit + put debit)' : 'mixed';
  const dLots = debit === 'call' ? cb.qty : pb.qty, cLots = debit === 'call' ? ps.qty : cs.qty;
  out.creditToDebitLots = round(cLots / dLots, 3);
  out.futuresSide = r.futureQty > 0 ? 'LONG' : 'SHORT';
  out.futuresOpposesOptions = (out.pattern.startsWith('BULLISH') && r.futureQty < 0) || (out.pattern.startsWith('BEARISH') && r.futureQty > 0);
  // strike geometry
  const longATM = debit === 'call' ? cb : pb;
  out.debitLongMoneynessPct = round((longATM.strike / S - 1) * 100, 2);
  out.shortCallPct = round((cs.strike / S - 1) * 100, 2); out.shortPutPct = round((ps.strike / S - 1) * 100, 2);
  out.upMatchesShortCall = Math.abs(S + r.upDistance - cs.strike) <= 1.0; out.downMatchesShortPut = Math.abs(S - r.downDistance - ps.strike) <= 1.0;
  out.callWidthPct = round(Math.abs(cb.strike - cs.strike) / S * 100, 2); out.putWidthPct = round(Math.abs(pb.strike - ps.strike) / S * 100, 2);
  // implied vols and deltas (S = futures entry as stock proxy; T = calendar days / 365)
  const T = dte > 0 ? dte / 365 : null;
  if (T && legs.every(l => l.premium > 0)) {
    legs.forEach(l => { l.iv = Strategy.impliedVol(l.premium, S, l.strike, T, R, l.type); l.greeks = l.iv ? Strategy.bsGreeks(S, l.strike, T, l.iv, R, l.type) : null; });
    const atmIV = longATM.iv; out.atmIV = round(atmIV, 4);
    if (atmIV) {
      const sigma = S * atmIV * Math.sqrt(T); out.sigmaMove = round(sigma, 2);
      out.upSigmas = round(r.upDistance / sigma, 2); out.downSigmas = round(r.downDistance / sigma, 2);
    }
    out.deltas = legs.map(l => round(l.greeks?.delta, 3));
    if (legs.every(l => l.greeks)) {
      const optDelta = legs.reduce((n, l) => n + (l.side === 'buy' ? 1 : -1) * l.qty * 100 * l.greeks.delta, 0);
      out.deltaNeutralQty = round(-optDelta, 1); out.deltaNeutralErrPct = round(pct(r.futureQty, -optDelta), 1);
      // engine rule: equalise the 1-day ("today") estimated net P&L at the two short strikes, options valued by Black-Scholes one day later
      const Tm = Math.max(T - 1 / 365, 1e-6), val = (Sx, TT) => legs.reduce((n, l) => n + (l.side === 'buy' ? 1 : -1) * l.qty * 100 * (Strategy.bs(Sx, l.strike, TT, l.iv, R, l.type) - l.premium), 0);
      const up = S + r.upDistance, dn = S - r.downDistance;
      out.modelOptUpToday = round(val(up, Tm), 0); out.modelOptDownToday = round(val(dn, Tm), 0);
      out.modelQtyToday = round((out.modelOptDownToday - out.modelOptUpToday) / (r.upDistance + r.downDistance), 1);
      out.modelQtyTodayErrPct = round(pct(r.futureQty, out.modelQtyToday), 1);
    }
  }
  // strike-selection reproduction: apply the engine rule (calibrated 0.75σ short strikes, 0.46σ wing, long leg nearest the money)
  // to a standard strike grid ($1 below $150, $2.50 above) that also contains the four sheet strikes
  if (out.sigmaMove) {
    const inc = S < 150 ? 1 : 2.5, grid = new Set(legs.map(l => l.strike));
    for (let k = Math.floor(S * 0.7 / inc) * inc; k <= S * 1.3; k += inc) grid.add(Math.round(k * 100) / 100);
    const g = [...grid].sort((x, y) => x - y), near = (x, pred = () => true) => g.filter(pred).sort((p, q) => Math.abs(p - x) - Math.abs(q - x))[0];
    const D0 = Strategy.REFERENCE_DEFAULTS, a = D0.debitShortSigma, ac = D0.creditShortSigma, w = D0.wingSigma, sg = out.sigmaMove, bull = out.pattern.startsWith('BULLISH'), dir = bull ? 1 : -1;
    const pdl = near(S + dir * D0.debitLongSigma * sg, k => dir * (k - S) >= 0), pds = near(S + dir * a * sg, k => dir * (k - pdl) > 0), pcs = near(S - dir * ac * sg, k => dir * (S - k) > 0), pcw = near(pcs - dir * w * sg, k => dir * (pcs - k) > 0);
    const act = bull ? { dl: cb.strike, ds: cs.strike, cs: ps.strike, cw: pb.strike } : { dl: pb.strike, ds: ps.strike, cs: cs.strike, cw: cb.strike };
    out.sigmaGeometry = { debitLongOtm: round(dir * (act.dl - S) / sg, 3), debitShort: round(dir * (act.ds - S) / sg, 3), creditShort: round(dir * (S - act.cs) / sg, 3), creditWing: round(dir * (act.cs - act.cw) / sg, 3) };
    out.rule = { debitLong: pdl, debitShort: pds, creditShort: pcs, creditWing: pcw };
    out.ruleErrPct = { debitLong: round((pdl - act.dl) / S * 100, 2), debitShort: round((pds - act.ds) / S * 100, 2), creditShort: round((pcs - act.cs) / S * 100, 2), creditWing: round((pcw - act.cw) / S * 100, 2) };
    out.ruleExact = [pdl === act.dl, pds === act.ds, pcs === act.cs, pcw === act.cw].filter(Boolean).length;
  }
  // equalisation using the sheet's own printed option P&Ls
  const span = r.upDistance + r.downDistance;
  out.eqQtyToday = round((r.optDownToday - r.optUpToday) / span, 1); out.eqQtyExpiry = round((r.optDownExpiry - r.optUpExpiry) / span, 1);
  out.eqTodayErrPct = round(pct(r.futureQty, out.eqQtyToday), 1); out.eqExpiryErrPct = round(pct(r.futureQty, out.eqQtyExpiry), 1);
  // expiry option P&L reproduction from transcribed strikes/units/premiums (intrinsic value, exact)
  if (legs.every(l => l.premium != null)) {
    const ex = Sx => legs.reduce((n, l) => n + l.units * (Math.max(l.type === 'call' ? Sx - l.strike : l.strike - Sx, 0) - l.premium), 0);
    out.calcOptUpExpiry = round(ex(S + r.upDistance), 0); out.calcOptDownExpiry = round(ex(S - r.downDistance), 0);
    out.optExpiryReproduces = Math.abs(out.calcOptUpExpiry - r.optUpExpiry) <= 25 && Math.abs(out.calcOptDownExpiry - r.optDownExpiry) <= 25;
  }
  // printed net = options + futures − MM allowance
  const netUpExp = r.optUpExpiry + r.futureQty * r.upDistance - r.mmLoss, netDnExp = r.optDownExpiry - r.futureQty * r.downDistance - r.mmLoss;
  out.netFormulaReproduces = Math.abs(netUpExp - r.netUpExpiry) <= 5 && Math.abs(netDnExp - r.netDownExpiry) <= 5;
  out.netUpExpiryCalc = round(netUpExp, 0); out.netDownExpiryCalc = round(netDnExp, 0);
  out.equalisedGap = round(Math.abs(r.netUpExpiry - r.netDownExpiry), 0);
  // capital: investment vs futures notional and defined-risk option capital
  const optCap = ['call', 'put'].reduce((n, t) => { const g = legs.filter(l => l.type === t), cash = g.reduce((m, l) => m - l.units * l.premium, 0), w = Math.abs(g[0].strike - g[1].strike) * Math.abs(g[0].units); return n + (cash < 0 ? -cash : Math.max(0, w - cash)); }, 0);
  out.futuresNotional = round(Math.abs(r.futureQty) * S, 0); out.optionsCapital = round(optCap, 0);
  if (r.investment) { out.investment = r.investment; out.investmentToNotional = round(r.investment / out.futuresNotional, 3); }
  if (r.bookedPnl != null && r.investment) { const held = (Date.parse(r.endDate) - Date.parse(r.openDate)) / 864e5; out.daysHeld = held; out.apyCheck = round((r.bookedPnl + (r.marketMakingPnl || 0)) / r.investment * 365 / Math.max(held, 1) * 100, 2); out.apyPrinted = r.apyPct; }
  return out;
}
function run() {
const rows = loadRows(), res = rows.map(analyse);
const args = require.main === module ? process.argv.slice(2) : [], jsonOut = args[args.indexOf('--json') + 1];
if (args.includes('--json')) fs.writeFileSync(jsonOut, JSON.stringify(res, null, 1));
const med = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const mean = a => { const s = a.filter(Number.isFinite); return s.length ? s.reduce((n, x) => n + x, 0) / s.length : null; };
const abs = a => a.filter(Number.isFinite).map(Math.abs);
const summary = {
  rows: res.length, patterns: res.reduce((m, r) => (m[r.pattern] = (m[r.pattern] || 0) + 1, m), {}),
  futuresOpposesOptions: res.filter(r => r.futuresOpposesOptions).length,
  creditToDebit2: res.filter(r => r.creditToDebitLots === 2).length, creditToDebitOther: res.filter(r => r.creditToDebitLots != null && r.creditToDebitLots !== 2).map(r => r.page + ':' + r.creditToDebitLots),
  upIsShortCall: res.filter(r => r.upMatchesShortCall).length, downIsShortPut: res.filter(r => r.downMatchesShortPut).length,
  medianDebitLongMoneynessPct: med(res.map(r => r.debitLongMoneynessPct)), medianAbsDebitLongMoneynessPct: med(abs(res.map(r => r.debitLongMoneynessPct))),
  medianShortCallPct: med(res.map(r => r.shortCallPct)), medianShortPutPct: med(res.map(r => r.shortPutPct)),
  medianUpSigmas: med(res.map(r => r.upSigmas)), medianDownSigmas: med(res.map(r => r.downSigmas)), meanUpSigmas: mean(res.map(r => r.upSigmas)), meanDownSigmas: mean(res.map(r => r.downSigmas)),
  medianCallWidthPct: med(res.map(r => r.callWidthPct)), medianPutWidthPct: med(res.map(r => r.putWidthPct)),
  medianAbsErr: { eqToday: med(abs(res.map(r => r.eqTodayErrPct))), eqExpiry: med(abs(res.map(r => r.eqExpiryErrPct))), deltaNeutral: med(abs(res.map(r => r.deltaNeutralErrPct))), modelToday: med(abs(res.map(r => r.modelQtyTodayErrPct))) },
  meanSignedErr: { eqToday: mean(res.map(r => r.eqTodayErrPct)), modelToday: mean(res.map(r => r.modelQtyTodayErrPct)), deltaNeutral: mean(res.map(r => r.deltaNeutralErrPct)) },
  optExpiryReproduces: res.filter(r => r.optExpiryReproduces).length, netFormulaReproduces: res.filter(r => r.netFormulaReproduces).length,
  sigmaGeometryMedian: Object.fromEntries(['debitLongOtm', 'debitShort', 'creditShort', 'creditWing'].map(k => [k, med(res.map(r => r.sigmaGeometry?.[k]))])),
  strikeRule: { rows: res.filter(r => r.rule).length, exact4: res.filter(r => r.ruleExact === 4).length, exactAtLeast3: res.filter(r => r.ruleExact >= 3).length, medianAbsErrPct: Object.fromEntries(['debitLong', 'debitShort', 'creditShort', 'creditWing'].map(k => [k, med(abs(res.map(r => r.ruleErrPct?.[k])))])), within1pct: Object.fromEntries(['debitLong', 'debitShort', 'creditShort', 'creditWing'].map(k => [k, res.filter(r => r.ruleErrPct && Math.abs(r.ruleErrPct[k]) <= 1).length])) },
  medianInvestmentToNotional: med(res.map(r => r.investmentToNotional)), medianDte: med(res.map(r => r.dte)), medianAtmIV: med(res.map(r => r.atmIV)),
};
if (args.includes('--md')) fs.writeFileSync(args[args.indexOf('--md') + 1], JSON.stringify({ summary, res }));
if (require.main === module) console.log(JSON.stringify(summary, null, 1));
return { rows, res, summary };
}
module.exports = { analyse, run, loadRows, REF_PATH };
if (require.main === module) run();
