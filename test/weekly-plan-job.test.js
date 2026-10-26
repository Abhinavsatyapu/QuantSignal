// Weekly Plan background job: per-ticker progress, a failing ticker and a hanging ticker are flagged and skipped (never block
// the plan), the full universe is analysed (no silent truncation), and the finished plan is returned by the job endpoint.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path'), os = require('os'), fs = require('fs');

test('weekly plan job: progress, per-ticker timeout and errors, all tickers analysed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-wpjob-'));
  process.env.QS_DB = path.join(dir, 't.db'); process.env.NODE_ENV = 'test'; delete process.env.DATABASE_URL;
  process.env.QS_PLAN_TICKER_MS = '1500';
  const deriv = require('../server/derivatives'), hl = require('../server/hl');
  const { httpErr } = require('../server/alpaca');
  const day = new Date(Date.now() + 4 * 864e5).toISOString().slice(0, 10);
  deriv.getExpiries = async (t) => { if (t === 'BAD') throw httpErr(404, 'No listed options found for BAD (Cboe)'); if (t === 'SLOW') return new Promise(() => {}); return { expiries: [{ date: day, contracts: 10, quoted: 10 }] }; };
  deriv.getChain = async () => ({ contracts: [], stock: { price: 100, source: 'fixture' } }); // empty chain → NO_DATA, analysed without a crash
  hl.candles = async () => []; const origFetch = global.fetch; global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  delete require.cache[require.resolve('../server/strategy')];
  const strategy = require('../server/strategy'), express = require('express'), app = express(); app.use(express.json()); app.use('/api', strategy.router({ stockSymbols: async () => [] }));
  const srv = app.listen(0); const base = 'http://127.0.0.1:' + srv.address().port + '/api';
  global.fetch = origFetch; const f = (u, b) => fetch(base + u, b ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) } : {}).then(async (r) => [r.status, await r.json()]);
  try {
    const tickers = ['OKA', 'BAD', 'SLOW', ...Array.from({ length: 24 }, (_, i) => 'T' + String.fromCharCode(65 + i))]; // 27 > the old silent 24 cap
    const [s0, j0] = await f('/strategy/weekly-plan/jobs', { tickers, lotSets: [1, 2] });
    assert.equal(s0, 202); assert.equal(j0.state, 'running'); assert.equal(j0.total, 27);
    const [s1, again] = await f('/strategy/weekly-plan/jobs', { tickers, lotSets: [1, 2] }); assert.equal(s1, 202); assert.equal(again.jobId, j0.jobId); assert.equal(again.reused, true);
    let j = j0; const t0 = Date.now();
    while (j.state === 'running' && Date.now() - t0 < 20000) { await new Promise((r) => setTimeout(r, 100)); [, j] = await f('/strategy/weekly-plan/jobs/' + j0.jobId); }
    assert.equal(j.state, 'done', JSON.stringify(j).slice(0, 400)); assert.equal(j.done, 27);
    const by = Object.fromEntries(j.tickers.map((t) => [t.ticker, t]));
    assert.equal(by.BAD.status, 'error'); assert.match(by.BAD.detail, /No listed options/);
    assert.equal(by.SLOW.status, 'timeout'); assert.match(by.SLOW.detail, /timed out after 2 s/);
    const R = j.result; assert.equal(R.tickers.length, 27); assert.ok(R.planId); assert.ok(!('liquidityRank' in R)); assert.ok(R.elapsedMs >= 0);
    assert.equal(R.tickers.find((t) => t.ticker === 'SLOW').status, 'ERROR');
    const [s404, e404] = await f('/strategy/weekly-plan/jobs/nope'); assert.equal(s404, 404); assert.match(e404.error, /Build the plan again/);
    const [s400] = await f('/strategy/weekly-plan/jobs', { tickers: Array.from({ length: 41 }, (_, i) => 'X' + i) }); assert.equal(s400, 400);
  } finally { srv.close(); delete process.env.QS_PLAN_TICKER_MS; }
});
