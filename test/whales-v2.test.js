'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const { clusterPrints, updateWallMemory } = require('../server/whales-cluster');
const { parseForm4, parse13dg, matchesIssuer } = require('../server/whales-edgar');
const { parseOcc, unusualFromChain } = require('../server/whales-cboe');
const { parseCdnShortVolume, priorWeekday } = require('../server/whales-institutions');
const { lagLabel, FEATURED, CUSIP, CIK } = require('../server/whales-util');
const { ForceOrderTape } = require('../server/whales-force-order');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');

test('clusterPrints groups same-side same-price prints in a 3s window', () => {
  const ts = 1_700_000_000_000;
  const trades = [
    { id: 1, price: 100, qty: 200, side: 'BUY', ts }, // 20k
    { id: 2, price: 100, qty: 400, side: 'BUY', ts: ts + 500 }, // 40k → cluster 60k
    { id: 3, price: 100, qty: 50, side: 'SELL', ts: ts + 200 },
    { id: 4, price: 101, qty: 800, side: 'BUY', ts: ts + 200 }, // different price, 80.8k alone
    { id: 5, price: 100, qty: 10, side: 'BUY', ts: ts + 10_000 }, // outside window
  ];
  const c = clusterPrints(trades, { windowMs: 3000, minClusterNotional: 50000 });
  assert.ok(c.some((x) => x.side === 'BUY' && x.price === 100 && x.prints === 2 && x.notional >= 50000));
  assert.ok(c.some((x) => x.price === 101 && x.prints === 1));
  assert.ok(!c.some((x) => x.side === 'SELL'));
});

test('updateWallMemory only returns walls seen in two snapshots', () => {
  let mem = {};
  const snap1 = updateWallMemory(mem, 'NVDAUSDT', [{ side: 'BID', price: 170, qty: 1000, notional: 170000 }], 1000, { needSeen: 2 });
  assert.equal(snap1.walls.length, 0);
  mem = snap1.memory;
  const snap2 = updateWallMemory(mem, 'NVDAUSDT', [{ side: 'BID', price: 170, qty: 900, notional: 153000 }], 4000, { needSeen: 2 });
  assert.equal(snap2.walls.length, 1);
  assert.equal(snap2.walls[0].persistent, true);
  assert.equal(snap2.walls[0].snapshots, 2);
});

test('Form 4 parser reads 10b5-1 sale; 13G matches issuer CIK/CUSIP only', () => {
  const f4 = parseForm4(fs.readFileSync(path.join(FIX, 'form4-sample.xml'), 'utf8'));
  assert.equal(f4.ticker, 'AAPL');
  assert.equal(f4.aff10b5One, 'true');
  assert.equal(f4.owners[0].name, 'Newstead Jennifer');
  assert.equal(f4.transactions[0].code, 'S');
  assert.equal(f4.transactions[0].shares, '2399');
  const ok = parse13dg(fs.readFileSync(path.join(FIX, 'sched13g-ok.xml'), 'utf8'));
  assert.equal(matchesIssuer(ok, { cik: CIK.HOOD, cusip: CUSIP.HOOD }), true);
  const bad = parse13dg(fs.readFileSync(path.join(FIX, 'sched13g-wrong-issuer.xml'), 'utf8'));
  assert.equal(matchesIssuer(bad, { cik: CIK.HOOD, cusip: CUSIP.HOOD }), false);
});

test('Cboe unusual screen flags high premium or vol/OI and parses OCC', () => {
  const occ = parseOcc('AAPL281215C00350000');
  assert.deepEqual(occ, { root: 'AAPL', expiry: '2028-12-15', cp: 'C', strike: 350 });
  const payload = {
    timestamp: '2026-11-10T14:35:00',
    data: {
      symbol: 'AAPL', current_price: 352, last_trade_time: '2026-11-09T15:59:59',
      options: [
        { option: 'AAPL281215C00350000', volume: 1175, open_interest: 4092, bid: 70, ask: 76 },
        { option: 'AAPL251101C00300000', volume: 9000, open_interest: 10, bid: 1, ask: 1 }, // expired before asof
        { option: 'AAPL281215P00100000', volume: 50, open_interest: 10, bid: 0.1, ask: 0.1 },
      ],
    },
  };
  const u = unusualFromChain(payload, new Date('2026-11-10T00:00:00Z'));
  assert.equal(u.unusualCount, 1);
  assert.equal(u.unusualTop[0].contract, 'AAPL281215C00350000');
  assert.ok(u.unusualTop[0].premiumUsd >= 250000);
});

test('FINRA CDN short-volume parser and lag labels', () => {
  const text = 'Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market\n20261109|AAPL|10|0|20|CNMS\n20261109|NVDA|1|0|10|CNMS\n';
  const rows = parseCdnShortVolume(text, ['AAPL', 'NVDA']);
  assert.equal(rows.AAPL.shortRatioOffExchange, 0.5);
  assert.equal(rows.NVDA.totalVolume, 10);
  const mon = priorWeekday(new Date('2026-11-08T12:00:00Z')); // Sunday
  assert.equal(mon.toISOString().slice(0, 10), '2026-11-06');
  assert.match(lagLabel(Date.now() - 30 * 60e3), /m lag/);
  assert.match(lagLabel(Date.now() - 3 * 86400e3), /d lag/);
});

test('13F compact job streams a fixture zip and keeps only the latest period + common shares', () => {
  const out = path.join(__dirname, 'fixtures', '13f-out.json');
  const r = spawnSync('python3', [
    path.join(ROOT, 'scripts', 'parse-13f-compact.py'),
    '--zip', path.join(FIX, 'form13f-mini.zip'),
    '--out', out,
    '--period', '30-JUN-2026',
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(j.ok, true);
  assert.equal(j.byTicker.AAPL.managers, 2);
  assert.equal(j.byTicker.AAPL.totalShares, 1500); // 1000+500, excludes CALL and prior quarter 999999
  assert.equal(j.byTicker.NVDA.totalShares, 2000);
  fs.unlinkSync(out);
});

test('ForceOrderTape persists equity-perp force orders and ignores other symbols', () => {
  const db = new Database(':memory:');
  const tape = ForceOrderTape({ store: { db }, symbols: ['NVDAUSDT', 'AAPLUSDT'] });
  tape.ensureTable();
  const ts = Date.now();
  tape.ingest({ e: 'forceOrder', E: ts, o: { s: 'NVDAUSDT', S: 'SELL', ap: 175, z: 20, T: ts } });
  tape.ingest({ e: 'forceOrder', E: ts, o: { s: 'BTCUSDT', S: 'BUY', ap: 90000, z: 1, T: ts } });
  const rows = tape.recent({ limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'NVDAUSDT');
  assert.equal(rows[0].notional, 3500);
  const snap = tape.snapshot();
  assert.equal(snap.count48h, 1);
  assert.match(snap.source, /forceOrder/);
});

test('Live Signals / Whale pages: no inline scripts, no blended-score copy, 13F seed present', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'whales.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'public', 'whales.js'), 'utf8');
  assert.match(html, /src="\/whales\.js"/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)/);
  assert.doesNotMatch(html + js, /\bbacktest results\b/i);
  assert.doesNotMatch(html, /How bias is chosen/);
  assert.doesNotMatch(js, /WHALE_LONG|blended score/i);
  assert.match(html, /no blended score/);
  assert.match(html, /automatic entry/i);
  assert.match(html, /Institutional filings/);
  assert.match(html, /Options unusual activity/);
  assert.match(js, /persistentWalls|Clusters|!forceOrder|10b5-1|off-exchange/i);
  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reference', 'whales', '13f-compact.json'), 'utf8'));
  assert.equal(seed.periodOfReport, '30-JUN-2026');
  assert.ok(seed.byTicker.AAPL.top10[0].manager);
  assert.ok(FEATURED.length === 4);
});
