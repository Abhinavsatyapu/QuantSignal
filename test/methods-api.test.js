// End-to-end through the HTTP API: POST /api/strategy/build for every Method (optimizer, weekly_atr, reference, delta) and
// several tickers (a perp-hedged name, HOOD, and SPY without a perp). Offline: the chain, perp book, candles and Nasdaq data
// are synthetic fixtures (they exercise the code paths only; nothing here is a market quote). Regression for the Weekly ATR
// "ticker is not defined" ReferenceError (blank / "sheet" ATR multipliers) and for raw JS errors reaching the UI.
'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-methods-'));
process.env.QS_DB = path.join(dir, 't.db'); process.env.NODE_ENV = 'test'; delete process.env.DATABASE_URL;
require('../public/indicators.js');
const express = require('express'), deriv = require('../server/derivatives'), hl = require('../server/hl'), strategy = require('../server/strategy'), alpaca = require('../server/alpaca');
const S = globalThis.Strategy, realFetch = globalThis.fetch;
const EXP = new Date(Date.now() + 6 * 864e5).toISOString().slice(0, 10), SPOT = { SPCX: 149.05, HOOD: 94.9, SPY: 760 };
function chain(t) {
  const spot = SPOT[t], step = spot > 500 ? 5 : spot > 120 ? 2.5 : 1, T = (S.expiryCloseMs(EXP) - Date.now()) / (365 * 864e5), iv = t === 'SPY' ? 0.18 : 0.7, out = [];
  for (let i = -30; i <= 30; i++) { const K = Math.round(spot / step) * step + i * step; for (const type of ['call', 'put']) {
    const mid = S.bs(spot, K, T, iv, 0.04, type), g = S.bsGreeks(spot, K, T, iv, 0.04, type), half = Math.max(0.01, mid * 0.02);
    if (mid < 0.03) continue;
    out.push({ symbol: t + type[0] + K, underlying: t, root: t, type, strike: K, expiry: EXP, multiplier: 100, bid: +(mid - half).toFixed(2), ask: +(mid + half).toFixed(2), mid: +mid.toFixed(3), iv, greeks: g,
      quoteTime: new Date().toISOString(), bidSize: 50, askSize: 50, openInterest: 5000, volume: 1000, provider: 'fixture' });
  } }
  return { provider: 'fixture', feed: 'fixture', label: 'synthetic test chain', delayed: false, contracts: out, snapshotTime: new Date().toISOString(), stock: { price: spot, source: 'fixture' } };
}
const candles = (sym, interval, count = 320) => { const t = sym.split(':')[1], spot = SPOT[t], dur = { '15m': 9e5, '1h': 36e5, '1d': 864e5 }[interval] || 36e5, n = Math.min(count, 400), now = Date.now();
  return Array.from({ length: n }, (_, i) => { const c = spot * (1 + 0.03 * Math.sin(i / 9)) * (1 - 0.0004 * (n - i)), r = spot * 0.012; return { t: now - (n - i) * dur, T: now - (n - i - 1) * dur, o: c, h: c + r, l: c - r, c, v: 1000 }; }); };
deriv.getExpiries = async () => ({ expiries: [{ date: EXP, contracts: 100, quoted: 100 }] });
deriv.getChain = async ({ symbol }) => chain(symbol);
deriv.perpBook = async (sym) => { const s = SPOT[sym.split(':')[1]]; return { bid: s - 0.02, ask: s + 0.02, mid: s, time: Date.now() }; };
deriv.perpMeta = async () => ({ szDecimals: 2, maxLeverage: 10, funding: 0.00001 });
hl.candles = async (net, sym, interval, count) => candles(sym, interval, count);
globalThis.fetch = async (u, o) => { u = String(u);
  if (/^http:\/\/127\.0\.0\.1/.test(u)) return realFetch(u, o);
  const m = u.match(/nasdaq\.com\/api\/quote\/([A-Z]+)\/historical/);
  if (m) { const rows = candles('x:' + m[1], '1d', 260).map((b) => { const d = new Date(b.t); return { date: String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + String(d.getUTCDate()).padStart(2, '0') + '/' + d.getUTCFullYear(), open: '$' + b.o.toFixed(2), high: '$' + b.h.toFixed(2), low: '$' + b.l.toFixed(2), close: '$' + b.c.toFixed(2) }; }).reverse();
    return new Response(JSON.stringify({ data: { tradesTable: { rows } } }), { status: 200, headers: { 'content-type': 'application/json' } }); }
  return new Response('offline test', { status: 503 }); };

let server, base;
test.before(async () => { const app = express(); app.use(express.json()); app.use('/api', strategy.router({ stockSymbols: async () => ['xyz:SPCX', 'xyz:HOOD'] })); await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); base = 'http://127.0.0.1:' + server.address().port; });
test.after(() => { globalThis.fetch = realFetch; server && server.close(); });
const post = async (body) => { const r = await realFetch(base + '/api/strategy/build', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
// the abhinav SPCX bug report settings (Weekly ATR section, auto direction / ratio, haircut 0.5, capital limit 30k, max lots 60, calibrated σ, SHORT delta)
const UI = { atrPeriod: 14, priceSource: 'auto', scaleToExpiry: true, upperMult: '', lowerMult: '', haircut: 0.5, capitalLimit: 30000, maxLots: 60, useCalibration: true, direction: 'SHORT', targetMode: 'fixed', targetPnl: 800 };
const JS_ERR = /is not defined|is not a function|Cannot read propert|undefined \(reading/;

for (const method of ['optimizer', 'weekly_atr', 'reference', 'delta']) for (const ticker of ['SPCX', 'HOOD', 'SPY']) {
  test(`API build: ${method} on ${ticker} answers without a JS error (status < 500, result or a plain-language refusal)`, async () => {
    const cfg = method === 'delta' ? { direction: 'SHORT', targetPnl: 800, capital: 30000 } : method === 'reference' ? { ...UI, direction: undefined } : UI;
    const { status, body } = await post({ ticker, expiry: EXP, method, cfg });
    assert.ok(status < 500, status + ' ' + JSON.stringify(body).slice(0, 400));
    const text = JSON.stringify(body.error || body.errors || '');
    assert.ok(!JS_ERR.test(text), 'raw JS error leaked: ' + text.slice(0, 300));
    if (status === 200) { assert.ok(body.status, 'no status'); if (body.ticker) assert.equal(body.ticker, ticker); }
  });
}
test('weekly ATR with blank multipliers uses the sheets\' own × ATR for the ticker (the "ticker is not defined" regression)', async () => {
  const { status, body } = await post({ ticker: 'SPCX', expiry: EXP, method: 'weekly_atr', cfg: UI });
  assert.equal(status, 200, JSON.stringify(body).slice(0, 300));
  assert.ok(body.status && body.status !== 'INVALID', body.status + ' ' + JSON.stringify(body.errors || body.error));
  const w = body.weeklyAtr || (body.inputs && body.inputs.weeklyAtr) || {};
  assert.ok(Number.isFinite(w.upperMult) && Number.isFinite(w.lowerMult), JSON.stringify(w).slice(0, 300)); // sheet × ATR multiples resolved for SPCX
});
test('code bugs reach the client in plain language with HTTP 500, not as a raw ReferenceError', () => {
  let msg; try { undefinedThing; } catch (e) { msg = alpaca.plainError(e); } // eslint-disable-line no-undef
  assert.match(msg, /^Internal error in QuantSignal .*ReferenceError: undefinedThing is not defined.*Nothing was saved or sent\.$/);
  assert.equal(alpaca.plainError(alpaca.httpErr(400, 'Enter a valid US ticker')), 'Enter a valid US ticker');
});
