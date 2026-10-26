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
let based = null;
const outs = () => T.map((t) => [t, A.runEngine(t, 'optimizer', { sheetAnchor: strategy.sheetAnchor(t.symbol, { excludePages: same(t) }) })]);
const run1 = () => { if (scored) return; scored = []; based = []; for (const [t, o] of outs()) { const ts = o.twoStage && o.twoStage.recommended;
  scored.push({ page: t.page, t, stage: ts ? ts.stage : null, why: ts ? ts.why : null, ...A.score(t, o) }); based.push({ page: t.page, t, ...A.score(t, A.baselineOut(t, o)) }); } };
const backtest = () => (run1(), scored), baseRows = () => (run1(), based);

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

test('Stage A sheet baseline reproduces the sheet strikes: ≥ 70% of legs within 1 strike, ≥ 86% within 2 (leave-one-trade-out; the old band search: 45% / 67%)', () => {
  const s = A.summary(T, baseRows());
  assert.ok(s.produced >= 75, 'produced ' + s.produced);
  assert.ok(s.legs.within1Pct >= 70, 'within 1: ' + s.legs.within1Pct); assert.ok(s.legs.within2Pct >= 86, 'within 2: ' + s.legs.within2Pct);
  assert.equal(s.sideMatchPct, 100); assert.ok(s.ratioMatchPct >= 83, 'ratio ' + s.ratioMatchPct);
  for (const [k, v] of Object.entries(s.perLeg)) assert.ok(v.within1Pct >= 60, k + ' ' + v.within1Pct);
});
test('two-stage: the optimizer overrides the baseline only sometimes, and every override is justified', () => {
  const rows = backtest().filter((x) => x.stage), ov = rows.filter((x) => x.stage === 'optimizer');
  assert.ok(rows.length >= 70); const pct = ov.length / rows.length * 100; assert.ok(pct > 5 && pct < 60, 'override rate ' + pct);
  for (const x of ov) assert.ok(/beats the sheet baseline|fails a what-if gate|cannot reach the target/.test(x.why), x.why);
  const fin = A.summary(T, backtest()); assert.ok(fin.legs.within1Pct >= 60 && fin.legs.within2Pct >= 80, JSON.stringify(fin.legs)); // the final pick stays close to the sheets
});
test('no call/put swap or long/short inversion: every engine structure has the sheet shape for its hedge side', () => {
  for (const r of backtest().filter((x) => x.ok)) {
    const L = r.legs, t = r.t;
    if (t.side === 'SHORT') assert.ok(L.ceLong.engine < L.ceShort.engine && L.peLong.engine < L.peShort.engine && L.peShort.engine < t.S && L.ceShort.engine > t.S, 'page ' + r.page);
    else assert.ok(L.peLong.engine > L.peShort.engine && L.ceLong.engine > L.ceShort.engine && L.ceShort.engine > t.S && L.peShort.engine < t.S, 'page ' + r.page);
  }
});

test('regression pages: all 4 sheet-baseline strikes within 1 listed strike of the sheet (CRWV, CRCL, NBIS, PLTR, INTC, HOOD, MSTR, AMD)', () => {
  const pages = [1, 3, 4, 7, 10, 17, 33, 72, 74], by = Object.fromEntries(baseRows().map((x) => [x.page, x]));
  for (const p of pages) { const r = by[p]; assert.ok(r && r.ok, 'page ' + p + ' ' + (r && r.status));
    for (const [k, l] of Object.entries(r.legs)) assert.ok(Math.abs(l.steps) <= 1, 'page ' + p + ' ' + r.t.symbol + ' ' + k + ' engine ' + l.engine + ' vs sheet ' + l.sheet); }
});

test('two-stage selection: baseline = the rule strikes with a full what-if, optimizer window, override rule, zone clamp optional', () => {
  const t = T.find((x) => x.page === 17), anchor = strategy.sheetAnchor('HOOD', { excludePages: same(t) }), out = A.runEngine(t, 'optimizer', { sheetAnchor: anchor }), b = out.distanceBand, ts = out.twoStage;
  assert.equal(out.status, 'OK', JSON.stringify(out.errors)); assert.equal(b.selection, 'sheet'); assert.equal(b.mode, 'sheet baseline + optimizer'); assert.equal(b.minShortSigma, null);
  const v = b.variants.find((x) => x.side === 'SHORT' && x.variant === '1C:2P'); assert.ok(v.rule && v.rule.ceShort > t.S && v.rule.peShort < t.S);
  assert.ok(v.rule.debitLong > t.S && v.rule.debitLong - t.S <= t.inc + 1e-9, 'debit long = first strike above spot');
  const d = ts.decisions.find((x) => x.id === 'SHORT 1C:2P'); assert.ok(d.baseline && d.optimized && d.baseline.whatIf && d.optimized.whatIf);
  const bs = d.baseline.legs.map((l) => l.strike).sort((x, y) => x - y), rs = [v.rule.debitLong, v.rule.debitShort, v.rule.creditShort, v.rule.wing].sort((x, y) => x - y); assert.deepEqual(bs, rs);
  assert.ok(ts.searched.optimizerSets > 20 && ts.searched.baselineSets >= 1);
  // optimizer window: shorts within −0.35σ / +0.5σ of the sheet distance and ≤ 1.5σ
  const o = d.optimized; assert.ok(Math.abs(o.sigmas.debitShort - v.rule.sigmas.debitShort) <= 0.5 + 1e-6 && o.sigmas.debitShort <= 1.5 + 1e-9 && o.sigmas.creditShort >= v.rule.sigmas.creditShort - 0.35 - 1e-6);
  // override rule
  if (d.stage === 'optimizer' && d.baseline.whatIf.acceptable) { assert.ok(o.score <= d.baseline.score * 0.95 + 1e-9 && o.whatIf.ev >= d.baseline.whatIf.ev - 1e-9 && o.whatIf.pop >= d.baseline.whatIf.pop - 0.03 - 1e-9 && o.whatIf.acceptable); }
  assert.ok(typeof out.recommendation.why === 'string' && out.recommendation.why.length > 20 && ['baseline', 'optimizer'].includes(out.recommendation.stage));
  // strict margin → baseline kept unless it fails; optimizer search off → baseline only
  const strict = A.runEngine(t, 'optimizer', { sheetAnchor: anchor, cfg: { overrideMargin: 0.5 } }).twoStage.decisions.find((x) => x.id === 'SHORT 1C:2P'); if (strict.baseline && strict.baseline.whatIf.acceptable) assert.equal(strict.stage, 'baseline');
  const off = A.runEngine(t, 'optimizer', { sheetAnchor: anchor, cfg: { optimizerSearch: false } }); assert.equal(off.twoStage.searched.optimizerSets, 0); assert.equal(off.twoStage.recommended.stage, 'baseline');
  // zone clamp: optional override, recorded as a conflict
  const z = A.runEngine(t, 'optimizer', { sheetAnchor: anchor, cfg: { minShortSigma: 0.7, maxShortSigma: 1.2 } }); assert.equal(z.distanceBand.mode, 'sheet baseline + optimizer + zone clamp');
  for (const c of z.distanceBand.conflicts) assert.ok(c.clampedSigmas >= 0.7 - 1e-9 && c.clampedSigmas <= 1.2 + 1e-9 && /clamped/.test(c.note));
  assert.equal(A.runEngine(t, 'optimizer', { cfg: { selection: 'x' } }).status, 'INVALID'); assert.equal(A.runEngine(t, 'optimizer', { cfg: { searchAboveSigma: 9 } }).status, 'INVALID');
  assert.ok(anchor.atrMultiples && anchor.atrMultiples.ce > 0.3 && anchor.atrMultiples.ce < 0.8 && anchor.atrMultiples.scope === 'ticker');
});
