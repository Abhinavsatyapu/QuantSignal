// Unit tests for server/alpaca.js against Alpaca's documented response shapes (mocked fetch; no network, fake keys).
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ALPACA_KEY_ID = 'TEST_KEY_ID';
process.env.ALPACA_SECRET_KEY = 'TEST_SECRET';
delete process.env.ALPACA_OPTIONS_FEED; delete process.env.ALPACA_STOCK_FEED; delete process.env.ALPACA_ENV;
const alpaca = require('../server/alpaca');

const res = (status, body) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
function mock(routes) {
  const calls = [];
  alpaca._setFetch(async (url, opts) => {
    calls.push({ url: new URL(url), headers: opts.headers });
    const u = new URL(url);
    for (const [re, fn] of routes) if (re.test(u.pathname)) return fn(u, calls.length);
    return res(404, { message: 'not mocked ' + u.pathname });
  });
  return calls;
}
const snap = (bp, ap, extra = {}) => ({ latestQuote: { ap, as: 5, bp, bs: 7, t: '2026-10-23T19:59:58Z' }, latestTrade: { p: (bp + ap) / 2, t: '2026-10-23T19:50:00Z' }, greeks: { delta: 0.5, gamma: 0.03, theta: -0.1, vega: 0.2, rho: 0.01 }, impliedVolatility: 0.31, ...extra });

test('parseOcc', () => {
  assert.deepEqual(alpaca.parseOcc('AAPL261120C00250000'), { root: 'AAPL', expiry: '2026-11-20', type: 'call', strike: 250 });
  assert.deepEqual(alpaca.parseOcc('SPY261231P00612500'), { root: 'SPY', expiry: '2026-12-31', type: 'put', strike: 612.5 });
  assert.equal(alpaca.parseOcc('AAPL'), null);
});

test('normalizeSnapshot handles missing greeks / crossed quotes', () => {
  const c = alpaca.normalizeSnapshot('AAPL261120C00250000', { latestQuote: { bp: 2, ap: 1.5 } }, null, 'Alpaca INDICATIVE');
  assert.equal(c.mid, null); assert.equal(c.greeks, null); assert.equal(c.iv, null);
  const d = alpaca.normalizeSnapshot('AAPL261120C00250000', snap(1, 1.2), null, 'x');
  assert.equal(d.mid, 1.1); assert.equal(d.greeks.delta, 0.5); assert.equal(d.iv, 0.31); assert.equal(d.multiplier, 100);
});

test('chain: paginates, merges contract metadata, excludes adjusted roots, uses indicative feed and auth headers', async () => {
  const calls = mock([
    [/\/v1beta1\/options\/snapshots\/AAPL$/, (u) => u.searchParams.get('page_token')
      ? res(200, { snapshots: { AAPL261120P00240000: snap(3, 3.2) }, next_page_token: null })
      : res(200, { snapshots: { AAPL261120C00250000: snap(4, 4.2), AAPL1261120C00250000: snap(1, 2) }, next_page_token: 'abc' })],
    [/\/v2\/options\/contracts$/, () => res(200, { option_contracts: [
      { symbol: 'AAPL261120C00250000', underlying_symbol: 'AAPL', root_symbol: 'AAPL', multiplier: '100', size: '100', open_interest: '1234', style: 'american' },
      { symbol: 'AAPL261120P00240000', underlying_symbol: 'AAPL', root_symbol: 'AAPL', multiplier: '100', open_interest: '50' },
      { symbol: 'AAPL1261120C00250000', underlying_symbol: 'AAPL', root_symbol: 'AAPL1', multiplier: '100' }], next_page_token: null })],
    [/\/v2\/stocks\/snapshots$/, () => res(200, { AAPL: { latestTrade: { p: 251.3, t: '2026-10-23T19:59:59Z' }, latestQuote: { bp: 251.2, ap: 251.4, t: '2026-10-23T19:59:59Z' }, dailyBar: { c: 251.3 }, prevDailyBar: { c: 249 } } })],
  ]);
  const r = await alpaca.chain({ symbol: 'aapl', near: '2026-11-01', far: '2026-12-31' });
  assert.equal(r.feed, 'indicative'); assert.equal(r.delayed, true);
  assert.equal(r.contracts.length, 2); assert.equal(r.excludedNonStandard, 1);
  assert.equal(r.contracts[0].type, 'put'); assert.equal(r.contracts[0].strike, 240);
  assert.equal(r.contracts[1].openInterest, 1234);
  assert.equal(r.stock.price, 251.3); assert.match(r.stock.source, /IEX last trade/);
  assert.equal(r.partial, false);
  const snapCalls = calls.filter(c => c.url.pathname.includes('/v1beta1/'));
  assert.equal(snapCalls.length, 2);
  assert.equal(snapCalls[0].url.host, 'data.alpaca.markets');
  assert.equal(snapCalls[0].url.searchParams.get('feed'), 'indicative');
  assert.equal(snapCalls[0].headers['APCA-API-KEY-ID'], 'TEST_KEY_ID');
  assert.equal(calls.find(c => c.url.pathname === '/v2/options/contracts').url.host, 'paper-api.alpaca.markets');
});

test('chain: OPRA feed via env, 403 surfaces subscription hint', async () => {
  process.env.ALPACA_OPTIONS_FEED = 'opra';
  mock([[/snapshots\/MSFT$/, () => res(403, { message: 'subscription does not permit querying opra data' })], [/contracts|stocks/, () => res(200, { option_contracts: [] })]]);
  await assert.rejects(alpaca.chain({ symbol: 'MSFT', near: '2026-11-01', far: '2026-11-30' }), e => e.status === 502 && /OPRA requires/.test(e.message));
  delete process.env.ALPACA_OPTIONS_FEED;
});

test('chain: metadata failure is non-fatal; stock falls back to quote mid', async () => {
  mock([
    [/snapshots\/NVDA$/, () => res(200, { snapshots: { NVDA261120C00200000: snap(5, 5.5) } })],
    [/contracts$/, () => res(500, 'boom')],
    [/stocks\/snapshots$/, () => res(200, { NVDA: { latestQuote: { bp: 199, ap: 201, t: '2026-10-23T20:00:00Z' } } })],
  ]);
  const r = await alpaca.chain({ symbol: 'NVDA', near: '2026-11-01', far: '2026-11-30' });
  assert.equal(r.contracts.length, 1); assert.match(r.metaError, /HTTP 500/); assert.equal(r.stock.price, 200); assert.match(r.stock.source, /quote mid/);
});

test('legs: multi-symbol snapshots, reports missing', async () => {
  const calls = mock([
    [/\/v1beta1\/options\/snapshots$/, () => res(200, { snapshots: { AAPL261120C00250000: snap(4, 4.2) } })],
    [/stocks\/snapshots$/, () => res(200, { AAPL: { latestTrade: { p: 250, t: '2026-10-23T20:00:00Z' } } })],
  ]);
  const r = await alpaca.legs(['AAPL261120C00250000', 'AAPL261120P00240000']);
  assert.equal(r.contracts.length, 1); assert.deepEqual(r.missing, ['AAPL261120P00240000']); assert.equal(r.stocks.AAPL.price, 250);
  assert.equal(calls[0].url.searchParams.get('symbols'), 'AAPL261120C00250000,AAPL261120P00240000');
  await assert.rejects(alpaca.legs(['nope']), e => e.status === 400);
});

test('errors: 401, 429, invalid input, missing keys', async () => {
  mock([[/./, () => res(401, { message: 'unauthorized' })]]);
  await assert.rejects(alpaca.legs(['AAPL261120C00250000']), e => /rejected the server API keys/.test(e.message) && !/TEST_SECRET/.test(e.message));
  mock([[/./, () => res(429, { message: 'too many' })]]);
  await assert.rejects(alpaca.legs(['AAPL261120C00250000']), e => e.status === 429);
  await assert.rejects(alpaca.chain({ symbol: 'AAPL; DROP', near: '2026-11-01', far: '2026-11-30' }), e => e.status === 400);
  await assert.rejects(alpaca.chain({ symbol: 'AAPL', near: '2026-12-01', far: '2026-11-30' }), e => e.status === 400);
  const k = process.env.ALPACA_KEY_ID; delete process.env.ALPACA_KEY_ID;
  assert.equal(alpaca.status().configured, false);
  await assert.rejects(alpaca.legs(['AAPL261120C00250000']), e => e.status === 503 && e.message === alpaca.NO_KEYS);
  process.env.ALPACA_KEY_ID = k;
});

test('optionableAssets filters and sorts', async () => {
  mock([[/\/v2\/assets$/, (u) => { assert.equal(u.searchParams.get('attributes'), 'options_enabled'); return res(200, [{ symbol: 'MSFT', name: 'Microsoft', tradable: true }, { symbol: 'AAPL', name: 'Apple' }, { symbol: 'X', tradable: false }]); }]]);
  const d = await alpaca.optionableAssets();
  assert.deepEqual(d.assets.map(a => a.symbol), ['AAPL', 'MSFT']);
});
