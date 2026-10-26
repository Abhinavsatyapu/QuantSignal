// Strike-selection audit against the reference sheets (data/reference/reference-sheets.json).
// 1) ground truth per page (4 strikes as $, %, σ, × weekly ATR; wings; ratio; futures qty)
// 2) rule statistics (median / IQR per hedge side and ratio) + leave-one-out search for the simplest rule set
// 3) backtest: each engine method on a chain reconstructed from the page (sheet spot, strike grid, leg IVs interpolated)
// Usage: node scripts/strike-audit.js [--json out.json] [--atr] [--methods optimizer,reference,weekly_atr,sheet_rules]
'use strict';
const fs = require('fs'), path = require('path');
require('../public/strategy-engine.js'); require('../public/strategy-weekly-atr.js'); require('../public/strategy-optimizer.js');
const S_ = globalThis.Strategy, { analyse, loadRows } = require('./reference-analysis');
const R = 0.04, med = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const q = (a, p) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); if (!s.length) return null; const i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.min(s.length - 1, lo + 1)] - s[lo]) * (i - lo); };
const r2 = (x, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
// standard listed-strike increment for a price level (US equity options: $0.5 < $25, $1 < $150 (weeklies), $2.5 < $500, $5 above)
const incFor = (S) => (S < 25 ? 0.5 : S < 150 ? 1 : S < 500 ? 2.5 : 5);

function truth(r, a) {
  const legs = ['callA', 'callB', 'putA', 'putB'].map((k, i) => ({ type: i < 2 ? 'call' : 'put', strike: r[k + 'Strike'], units: r[k + 'Units'], premium: r[k + 'Premium'] }));
  const cl = legs.find(l => l.type === 'call' && l.units > 0), cs = legs.find(l => l.type === 'call' && l.units < 0), pl = legs.find(l => l.type === 'put' && l.units > 0), ps = legs.find(l => l.type === 'put' && l.units < 0);
  if (!cl || !cs || !pl || !ps) return null;
  const side = r.futureQty > 0 ? 'LONG' : 'SHORT', S = r.futureEntry, dte = a.dte, T = dte > 0 ? dte / 365 : null;
  const cU = Math.abs(cl.units) / 100, pU = Math.abs(pl.units) / 100, ratio = pU === 2 * cU ? '1C:2P' : cU === 2 * pU ? '2C:1P' : cU + 'C:' + pU + 'P';
  const ivs = legs.map(l => (T && l.premium > 0 ? S_.impliedVol(l.premium, S, l.strike, T, R, l.type) : null));
  const iv = a.atmIV || med(ivs.filter(Boolean)), sigma = iv && T ? S * iv * Math.sqrt(T) : null;
  const d = (K) => ({ strike: K, dollars: r2(K - S), pct: r2((K / S - 1) * 100), sigmas: sigma ? r2((K - S) / sigma, 3) : null });
  // roles: SHORT hedge = call DEBIT spread (CE long ≈ ATM, CE short = debit short) + put CREDIT spread (PE short = credit short, PE long = wing)
  //        LONG hedge  = put DEBIT spread (PE long ≈ ATM, PE short = debit short) + call CREDIT spread (CE short = credit short, CE long = wing)
  const bull = cl.strike < cs.strike && ps.strike > pl.strike, bear = cl.strike > cs.strike && pl.strike > ps.strike;
  const pattern = bull ? 'call debit + put credit' : bear ? 'call credit + put debit' : 'mixed';
  const geo = sigma ? (bull ? { dl: (cl.strike - S) / sigma, ds: (cs.strike - S) / sigma, cs: (S - ps.strike) / sigma, cw: (ps.strike - pl.strike) / sigma } : bear ? { dl: (S - pl.strike) / sigma, ds: (S - ps.strike) / sigma, cs: (cs.strike - S) / sigma, cw: (cl.strike - cs.strike) / sigma } : null) : null;
  const pctGeo = bull ? { dl: (cl.strike / S - 1) * 100, ds: (cs.strike / S - 1) * 100, cs: (1 - ps.strike / S) * 100, cw: (ps.strike - pl.strike) / S * 100 } : bear ? { dl: (1 - pl.strike / S) * 100, ds: (1 - ps.strike / S) * 100, cs: (cs.strike / S - 1) * 100, cw: (cl.strike - cs.strike) / S * 100 } : null;
  return { page: r.page, symbol: r.symbol, S, openDate: r.openDate, expiry: r.expiry, dte, iv: r2(iv, 4), sigma: r2(sigma, 3), side, ratio, pattern, opposes: (bull && side === 'SHORT') || (bear && side === 'LONG'),
    ceLong: d(cl.strike), ceShort: d(cs.strike), peLong: d(pl.strike), peShort: d(ps.strike), callWidth: Math.abs(cl.strike - cs.strike), putWidth: Math.abs(pl.strike - ps.strike),
    lots: { call: cU, put: pU, sets: Math.min(cU, pU) }, futureQty: r.futureQty, fqPerSet: r.futureQty / Math.min(cU, pU), up: r.upDistance, down: r.downDistance,
    exits: { upToday: r.netUpToday, upExpiry: r.netUpExpiry, downToday: r.netDownToday, downExpiry: r.netDownExpiry }, mm: r.mmLoss, legs, ivs, geo, pctGeo, inc: incFor(S) };
}

// ---------- historical weekly ATR at each sheet's open (Nasdaq daily OHLC; cached under /tmp) -------------------
async function attachAtr(T) {
  const cacheF = '/tmp/strike-audit-daily.json', cache = fs.existsSync(cacheF) ? JSON.parse(fs.readFileSync(cacheF, 'utf8')) : {};
  for (const sym of [...new Set(T.map(t => t.symbol))]) {
    if (!cache[sym]) {
      try {
        const u = `https://api.nasdaq.com/api/quote/${sym}/historical?assetclass=stocks&fromdate=2026-03-01&limit=400`;
        const j = await (await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 QuantSignal', Accept: 'application/json' }, signal: AbortSignal.timeout(10000) })).json();
        const n = (x) => Number(String(x).replace(/[$,]/g, ''));
        cache[sym] = (j?.data?.tradesTable?.rows || []).map(x => { const m = String(x.date).match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? { date: m[3] + '-' + m[1] + '-' + m[2], o: n(x.open), h: n(x.high), l: n(x.low), c: n(x.close) } : null; }).filter(Boolean);
      } catch (e) { cache[sym] = []; }
    }
  }
  fs.writeFileSync(cacheF, JSON.stringify(cache));
  for (const t of T) {
    const w = cache[t.symbol] && cache[t.symbol].length ? S_.wilderAtr(S_.weeklyBarsFromDaily(cache[t.symbol], { beforeWeek: S_.weekStartOf(t.openDate) }), 14) : null;
    t.atr = w ? r2(w.atr, 3) : null;
    for (const k of ['ceLong', 'ceShort', 'peLong', 'peShort']) t[k].atrs = t.atr ? r2(t[k].dollars / t.atr, 3) : null;
  }
}

// ---------- reconstructed chain for a page: listed grid + sheet strikes, IV interpolated from the 4 legs -----------------
function chainFor(t) {
  const S = t.S, inc = t.inc, grid = new Set(t.legs.map(l => l.strike));
  for (let k = Math.ceil(S * 0.6 / inc) * inc; k <= S * 1.4; k += inc) grid.add(r2(k, 2));
  const pts = t.legs.map((l, i) => [l.strike, t.ivs[i]]).filter(([, v]) => v > 0.05 && v < 5).sort((a, b) => a[0] - b[0]);
  const ivAt = (K) => { if (!pts.length) return t.iv; if (K <= pts[0][0]) return pts[0][1]; if (K >= pts.at(-1)[0]) return pts.at(-1)[1];
    for (let i = 1; i < pts.length; i++) if (K <= pts[i][0]) { const [k0, v0] = pts[i - 1], [k1, v1] = pts[i]; return k1 === k0 ? v1 : v0 + (v1 - v0) * (K - k0) / (k1 - k0); } return t.iv; };
  const now = nowFor(t), Tm = (S_.expiryCloseMs(t.expiry) - now) / (365 * 864e5), out = [];
  for (const K of [...grid].sort((a, b) => a - b)) for (const type of ['call', 'put']) {
    const iv = ivAt(K), mid = S_.bs(S, K, Tm, iv, R, type), g = S_.bsGreeks(S, K, Tm, iv, R, type), half = Math.max(0.01, mid * 0.03);
    if (mid < 0.03) continue; // nothing quoted that far out
    out.push({ symbol: t.symbol + (type === 'call' ? 'C' : 'P') + K, type, strike: K, expiry: t.expiry, multiplier: 100, bid: r2(mid - half, 2), ask: r2(mid + half, 2), iv, greeks: g, quoteTime: new Date(now).toISOString(), bidSize: 100, askSize: 100, openInterest: 1000, volume: 200 });
  }
  return out;
}
const nowFor = (t) => Date.parse(t.openDate + 'T19:30:00Z'); // 15:30 ET on the open date

// ---------- engine runs ----------------------------------------------------------------------------------------
function runEngine(t, method, extra = {}) {
  const contracts = chainFor(t), perp = { available: true, symbol: 'xyz:' + t.symbol, bid: t.S - 0.01, ask: t.S + 0.01, mid: t.S, szDecimals: 2, maxLeverage: 10, funding: 0 };
  const base = { weights: extra.weights, nowMs: nowFor(t), ticker: t.symbol, expiry: t.expiry, contracts, stock: { price: t.S, source: 'sheet' }, perp, market: null, sheetAnchor: extra.sheetAnchor, bandAtr: t.atr ? { atr: t.atr, source: 'nasdaq at open' } : null };
  const target = Math.max(50, 0.9 * Math.min(t.exits.upExpiry, t.exits.downExpiry)), sets = t.lots.sets;
  const cfg = { targetMode: 'perLotSet', lotSets: sets, targetPerLotSet: target / sets, mmLoss: t.mm, direction: t.side === 'LONG' ? 'BULLISH' : 'BEARISH', maxLots: 200, ...(extra.cfg || {}) };
  if (method === 'optimizer') return S_.optimize({ ...base, cfg });
  if (method === 'weekly_atr') return t.atr ? S_.optimize({ ...base, cfg, weeklyAtr: { atr: t.atr, n: 14, upperMult: (extra.sheetAnchor && extra.sheetAnchor.atrMultiples && extra.sheetAnchor.atrMultiples.ce) || 0.42, lowerMult: (extra.sheetAnchor && extra.sheetAnchor.atrMultiples && extra.sheetAnchor.atrMultiples.pe) || 0.41, zoneMinSigma: 0.7, zoneMaxSigma: 1.2, scaleToExpiry: false, tradingDays: S_.tradingDaysTo(t.expiry, nowFor(t)), debitLongSigma: 0.1, wingSigma: 0.47, ...(extra.wa || {}) } }) : { status: 'NO_ATR' };
  if (method === 'reference') return S_.buildReference({ ...base, cfg: { signal: t.side === 'LONG' ? 'BULLISH' : 'BEARISH', futuresSide: t.side, targetPnl: target, mmLoss: t.mm, maxLots: 200, capital: 1e6, ...(extra.refCfg || {}) }, calibration: extra.calibration });
  throw Error('method ' + method);
}
// compare the engine's 4 strikes with the sheet's
function score(t, out) {
  const b = out && (out.best || (out.rejected && out.rejected[0]));
  if (!b || !b.legs) return { ok: false, status: out && out.status };
  const L = b.legs, f = (type, side) => L.find(l => l.type === type && l.side === side);
  const e = { ceLong: f('call', 'buy'), ceShort: f('call', 'sell'), peLong: f('put', 'buy'), peShort: f('put', 'sell') };
  const res = { ok: true, status: out.status, accepted: !!out.best, side: b.futuresSide, sideMatch: b.futuresSide === t.side, ratio: b.variant || (b.callLots && b.putLots ? (b.putLots === 2 * b.callLots ? '1C:2P' : b.callLots === 2 * b.putLots ? '2C:1P' : b.callLots + 'C:' + b.putLots + 'P') : null), legs: {} };
  res.ratioMatch = res.ratio === t.ratio;
  for (const k of Object.keys(e)) { if (!e[k]) { res.legs[k] = null; continue; } const steps = (e[k].strike - t[k].strike) / t.inc; res.legs[k] = { engine: e[k].strike, sheet: t[k].strike, steps: r2(steps, 2), pctErr: r2((e[k].strike - t[k].strike) / t.S * 100, 2) }; }
  const sets = b.lotSets || Math.max(1, Math.round(Math.min(b.callLots || 1, b.putLots || 1)));
  res.fq = b.futures ? b.futures.signedQty : null; res.fqPerSet = res.fq != null ? res.fq / sets : null; res.fqErrPct = res.fqPerSet != null ? r2((res.fqPerSet - t.fqPerSet) / Math.abs(t.fqPerSet) * 100, 1) : null;
  return res;
}
function summary(T, scored) {
  const legsAll = [], perLeg = { ceLong: [], ceShort: [], peLong: [], peShort: [] };
  let ok = 0, side = 0, ratio = 0, acc = 0; const fq = [];
  scored.forEach((s) => { if (!s.ok) return; ok++; if (s.sideMatch) side++; if (s.ratioMatch) ratio++; if (s.accepted) acc++; if (Number.isFinite(s.fqErrPct)) fq.push(Math.abs(s.fqErrPct));
    for (const k of Object.keys(perLeg)) if (s.legs[k]) { perLeg[k].push(Math.abs(s.legs[k].steps)); legsAll.push(Math.abs(s.legs[k].steps)); } });
  const w = (a, x) => (a.length ? r2(a.filter(v => v <= x + 1e-9).length / a.length * 100, 1) : null);
  return { pages: T.length, produced: ok, accepted: acc, sideMatchPct: ok ? r2(side / ok * 100, 1) : null, ratioMatchPct: ok ? r2(ratio / ok * 100, 1) : null,
    legs: { n: legsAll.length, exactPct: w(legsAll, 0), within1Pct: w(legsAll, 1), within2Pct: w(legsAll, 2), medianSteps: r2(med(legsAll), 2) },
    perLeg: Object.fromEntries(Object.entries(perLeg).map(([k, a]) => [k, { within1Pct: w(a, 1), exactPct: w(a, 0), medianSteps: r2(med(a), 2) }])), fqMedianAbsErrPct: r2(med(fq), 1) };
}
function stats(T) {
  const grp = {}, add = (k, t) => (grp[k] = grp[k] || []).push(t);
  for (const t of T) { add('ALL', t); add(t.side, t); add(t.side + ' ' + t.ratio, t); }
  const st = (a) => ({ median: r2(med(a), 3), q1: r2(q(a, 0.25), 3), q3: r2(q(a, 0.75), 3), n: a.filter(Number.isFinite).length });
  const out = {};
  for (const [k, g] of Object.entries(grp)) {
    const G = g.filter(t => t.geo);
    out[k] = { n: g.length, sigma: { debitLong: st(G.map(t => t.geo.dl)), debitShort: st(G.map(t => t.geo.ds)), creditShort: st(G.map(t => t.geo.cs)), wing: st(G.map(t => t.geo.cw)) },
      pct: { debitLong: st(g.map(t => t.pctGeo && t.pctGeo.dl)), debitShort: st(g.map(t => t.pctGeo && t.pctGeo.ds)), creditShort: st(g.map(t => t.pctGeo && t.pctGeo.cs)), wing: st(g.map(t => t.pctGeo && t.pctGeo.cw)) },
      atr: { ceShort: st(g.map(t => t.ceShort.atrs)), peShort: st(g.map(t => -t.peShort.atrs)), ceLong: st(g.map(t => t.ceLong.atrs)), peLong: st(g.map(t => -t.peLong.atrs)) },
      steps: { callWidth: st(g.map(t => t.callWidth / t.inc)), putWidth: st(g.map(t => t.putWidth / t.inc)) },
      dte: st(g.map(t => t.dte)), iv: st(g.map(t => t.iv)), opposesPct: r2(g.filter(t => t.opposes).length / g.length * 100, 1) };
  }
  return out;
}
// offline: the frozen per-sheet ATR (data/reference/sheet-atr.json) instead of fetching Nasdaq history
function attachAtrStatic(T) {
  let A = {}; try { A = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/reference/sheet-atr.json'), 'utf8')).pages || {}; } catch { /* none */ }
  for (const t of T) { const a = A[t.page]; t.atr = a ? a.atr : null; for (const k of ['ceLong', 'ceShort', 'peLong', 'peShort']) t[k].atrs = t.atr ? r2(t[k].dollars / t.atr, 3) : null; }
}
module.exports = { attachAtrStatic, truth, chainFor, runEngine, score, summary, stats, attachAtr, incFor, nowFor, med, q, r2 };

if (require.main === module) (async () => {
  const args = process.argv.slice(2), rows = loadRows(), T = rows.map(r => truth(r, analyse(r))).filter(Boolean);
  if (args.includes('--atr')) await attachAtr(T); else attachAtrStatic(T);
  const methods = (args[args.indexOf('--methods') + 1] && args.includes('--methods') ? args[args.indexOf('--methods') + 1] : 'optimizer,reference,weekly_atr').split(',');
  let anchorFor = () => undefined, calFor = () => undefined;
  try { process.env.QS_DB = process.env.QS_DB || '/tmp/qs-audit.db'; process.env.DATABASE_URL = ''; const st = require('../server/strategy'); anchorFor = (s, page) => st.sheetAnchor(s, args.includes('--loto') ? { excludePages: sameTrade(page) } : args.includes('--loo') ? { excludePage: page } : {}); calFor = (s) => st.calibration(s); } catch (e) { console.error('server calibration unavailable: ' + e.message); }
  // the same trade is often transcribed on several pages (updates of one position) → leave-one-TRADE-out excludes them all
  const tradeKey = (t) => [t.symbol, t.openDate, t.ceLong.strike, t.ceShort.strike, t.peShort.strike, t.peLong.strike].join('|');
  const sameTrade = (page) => { const k = tradeKey(T.find((t) => t.page === page)); return T.filter((t) => tradeKey(t) === k).map((t) => t.page); };
  const opt = (k) => (args.includes(k) ? JSON.parse(args[args.indexOf(k) + 1]) : undefined);
  const res = { stats: stats(T), methods: {} };
  for (const m of methods) {
    const scored = T.map(t => { try { return { page: t.page, ...score(t, runEngine(t, m, { sheetAnchor: anchorFor(t.symbol, t.page), calibration: calFor(t.symbol), cfg: opt('--cfg'), weights: opt('--weights'), wa: opt('--wa') })) }; } catch (e) { return { page: t.page, ok: false, error: e.message }; } });
    const firstOf = new Set([...new Map(T.map((t) => [tradeKey(t), t.page])).values()]), uT = T.filter((t) => firstOf.has(t.page));
    res.methods[m] = { summary: summary(T, scored), uniqueTrades: summary(uT, scored.filter((x) => firstOf.has(x.page))), rows: scored };
  }
  res.truth = T.map(({ legs, ivs, ...x }) => x);
  if (args.includes('--write-atr')) { // static per-sheet weekly-ATR multiples (read by server/strategy.js → no network at request time)
    const out = {}; for (const t of T) if (t.atr) { const dbt = t.side === 'SHORT' ? t.ceShort.dollars : -t.peShort.dollars, cr = t.side === 'SHORT' ? -t.peShort.dollars : t.ceShort.dollars, w = t.side === 'SHORT' ? t.putWidth : t.callWidth;
      out[t.page] = { symbol: t.symbol, openDate: t.openDate, atr: t.atr, ceShortAtr: r2(t.ceShort.dollars / t.atr, 3), peShortAtr: r2(-t.peShort.dollars / t.atr, 3), debitShortAtr: r2(dbt / t.atr, 3), creditShortAtr: r2(cr / t.atr, 3), wingAtr: r2(w / t.atr, 3) }; }
    fs.writeFileSync(path.join(__dirname, '../data/reference/sheet-atr.json'), JSON.stringify({ note: 'Wilder-14 weekly ATR (Nasdaq daily OHLC, weeks completed before each sheet open week) and each sheet short / wing as a multiple of it. Generated by scripts/strike-audit.js --atr --write-atr.', pages: out }, null, 1));
  }
  if (args.includes('--json')) fs.writeFileSync(args[args.indexOf('--json') + 1], JSON.stringify(res, null, 1));
  console.log(JSON.stringify({ stats: { ALL: res.stats.ALL, LONG: res.stats.LONG, SHORT: res.stats.SHORT }, ...Object.fromEntries(Object.entries(res.methods).map(([k, v]) => [k, v.summary])), uniqueTrades: Object.fromEntries(Object.entries(res.methods).map(([k, v]) => [k, v.uniqueTrades])) }, null, 1));
  process.exit(0);
})();
