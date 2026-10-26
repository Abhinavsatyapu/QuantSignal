// Strike-selection regression against the 78 reference-sheet pages (docs/strike-selection-audit.md).
// Offline: chains are reconstructed from each page (sheet spot, listed grid, leg IVs) and the weekly ATR at each open comes
// from data/reference/sheet-atr.json. The sheet anchor excludes the page being tested (leave-one-out → no look-ahead).
'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-audit-'));
process.env.QS_DB = path.join(dir, 't.db'); process.env.NODE_ENV = 'test'; delete process.env.DATABASE_URL;
const A = require('../scripts/strike-audit'), { loadRows, analyse } = require('../scripts/reference-analysis'), strategy = require('../server/strategy');
const T = loadRows().map((r) => A.truth(r, analyse(r))).filter(Boolean); A.attachAtrStatic(T);
// leave-one-TRADE-out: a trade transcribed on several pages is excluded from its own anchor on all of them
const key = (t) => [t.symbol, t.openDate, t.ceLong.strike, t.ceShort.strike, t.peShort.strike, t.peLong.strike].join('|'), same = (t) => T.filter((x) => key(x) === key(t)).map((x) => x.page);
let scored = null;
const backtest = () => scored || (scored = T.map((t) => ({ page: t.page, t, ...A.score(t, A.runEngine(t, 'optimizer', { sheetAnchor: strategy.sheetAnchor(t.symbol, { excludePages: same(t) }) })) })));

test('sheet ground truth: 78 pages, options always oppose the futures, credit spread carries 2× the lots', () => {
  assert.equal(T.length, 78);
  assert.ok(T.filter((t) => t.opposes).length >= 77); // SHORT futures = call debit + put credit; LONG futures = put debit + call credit
  const L = T.filter((t) => t.side === 'LONG'), Sx = T.filter((t) => t.side === 'SHORT');
  assert.equal(L.length, 30); assert.equal(Sx.length, 48);
  assert.ok(L.filter((t) => t.ratio === '2C:1P').length >= 25 && Sx.filter((t) => t.ratio === '1C:2P').length >= 45);
  for (const t of T.filter((x) => x.opposes)) {
    if (t.side === 'SHORT') assert.ok(t.ceLong.strike < t.ceShort.strike && t.peLong.strike < t.peShort.strike && t.peShort.strike < t.S, 'page ' + t.page);
    else assert.ok(t.peLong.strike > t.peShort.strike && t.ceLong.strike > t.ceShort.strike && t.ceShort.strike > t.S, 'page ' + t.page);
  }
});

test('sheet rules (median σ): debit long ≈ 0.09σ OTM, debit short ≈ 0.9σ, credit short ≈ 0.63σ, wing ≈ 0.47σ', () => {
  const s = A.stats(T).ALL.sigma, near = (x, y, tol) => Math.abs(x - y) <= tol;
  assert.ok(near(s.debitLong.median, 0.09, 0.03) && near(s.debitShort.median, 0.9, 0.05) && near(s.creditShort.median, 0.63, 0.04) && near(s.wing.median, 0.47, 0.04), JSON.stringify(s));
  // the credit short sits inside the 0.7σ zone minimum on most sheets → the zone clamp is a documented conflict
  assert.ok(s.creditShort.q3 < 0.8 && s.creditShort.median < 0.7);
  const atr = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/reference/sheet-atr.json'), 'utf8')).pages;
  assert.ok(Object.keys(atr).length >= 70);
  const ce = A.med(Object.values(atr).map((x) => x.ceShortAtr)), pe = A.med(Object.values(atr).map((x) => x.peShortAtr));
  assert.ok(near(ce, 0.42, 0.05) && near(pe, 0.41, 0.05), ce + ' / ' + pe); // = the Weekly ATR method defaults
});

test('optimizer (sheet selection) reproduces the sheet strikes: ≥ 68% of legs within 1 strike, ≥ 88% within 2 (leave-one-trade-out; the old band search: 45% / 67%)', () => {
  const s = A.summary(T, backtest());
  assert.ok(s.produced >= 75, 'produced ' + s.produced);
  assert.ok(s.legs.within1Pct >= 68, 'within 1: ' + s.legs.within1Pct); assert.ok(s.legs.within2Pct >= 88, 'within 2: ' + s.legs.within2Pct);
  assert.equal(s.sideMatchPct, 100); assert.ok(s.ratioMatchPct >= 85, 'ratio ' + s.ratioMatchPct);
  for (const [k, v] of Object.entries(s.perLeg)) assert.ok(v.within1Pct >= 60, k + ' ' + v.within1Pct);
  assert.ok(s.fqMedianAbsErrPct <= 15, 'FQ error ' + s.fqMedianAbsErrPct);
});

test('no call/put swap or long/short inversion: every engine structure has the sheet shape for its hedge side', () => {
  for (const r of backtest().filter((x) => x.ok)) {
    const L = r.legs, t = r.t;
    if (t.side === 'SHORT') assert.ok(L.ceLong.engine < L.ceShort.engine && L.peLong.engine < L.peShort.engine && L.peShort.engine < t.S && L.ceShort.engine > t.S, 'page ' + r.page);
    else assert.ok(L.peLong.engine > L.peShort.engine && L.ceLong.engine > L.ceShort.engine && L.ceShort.engine > t.S && L.peShort.engine < t.S, 'page ' + r.page);
  }
});

test('regression pages: all 4 strikes within 1 listed strike of the sheet (CRWV, CRCL, PLTR, BE, INTC, HOOD, MSTR, AMD)', () => {
  const pages = [1, 3, 7, 9, 10, 17, 19, 33, 72, 74], by = Object.fromEntries(backtest().map((x) => [x.page, x]));
  for (const p of pages) { const r = by[p]; assert.ok(r && r.ok, 'page ' + p + ' ' + (r && r.status));
    for (const [k, l] of Object.entries(r.legs)) assert.ok(Math.abs(l.steps) <= 1, 'page ' + p + ' ' + r.t.symbol + ' ' + k + ' engine ' + l.engine + ' vs sheet ' + l.sheet); }
});

test('sheet selection: rule strikes, ± steps variations only, zone clamp recorded as a conflict', () => {
  const t = T.find((x) => x.page === 17), anchor = strategy.sheetAnchor('HOOD', { excludePages: same(t) }), out = A.runEngine(t, 'optimizer', { sheetAnchor: anchor }), b = out.distanceBand;
  assert.equal(out.status, 'OK', JSON.stringify(out.errors)); assert.equal(b.selection, 'sheet'); assert.equal(b.mode, 'sheet geometry + zone clamp');
  const v = b.variants.find((x) => x.side === 'SHORT' && x.variant === '1C:2P'); assert.ok(v.rule && v.rule.ceShort > t.S && v.rule.peShort < t.S);
  assert.ok(v.rule.debitLong > t.S && v.rule.debitLong - t.S <= t.inc + 1e-9, 'debit long = first strike above spot');
  const best = out.best, st = best.distances.stepsFromRule; assert.ok(st && st.debitShort <= 2 && st.creditShort <= 2 && st.debitLong <= 1 && st.wing <= 1);
  assert.equal(best.distances.ce.sheet.strike, v.rule.ceShort);
  for (const c of b.conflicts) assert.ok(c.clampedSigmas >= 0.7 - 1e-9 && c.clampedSigmas <= 1.2 + 1e-9 && /clamped/.test(c.note));
  const off = A.runEngine(t, 'optimizer', { sheetAnchor: anchor, cfg: { minShortSigma: null } }); assert.equal(off.distanceBand.conflicts.filter((c) => c.ruleSigmas < 0.7).length, 0);
  assert.equal(A.runEngine(t, 'optimizer', { cfg: { selection: 'x' } }).status, 'INVALID'); assert.equal(A.runEngine(t, 'optimizer', { cfg: { shortSteps: 9 } }).status, 'INVALID');
  // the weekly ATR method defaults to the sheets' own × ATR for the ticker
  assert.ok(anchor.atrMultiples && anchor.atrMultiples.ce > 0.3 && anchor.atrMultiples.ce < 0.8 && anchor.atrMultiples.scope === 'ticker');
});
