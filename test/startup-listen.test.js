'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { isTransientExternal, listenThenWarmup } = require('../server/boot');
const { slimExchangeInfo, filtersOf } = require('../server/binance');

describe('startup listen-first + process guards', () => {
  it('classifies fetch timeouts, aborts, and HTTP 429 as transient', () => {
    const abort = new Error('The operation was aborted due to timeout');
    abort.name = 'AbortError';
    assert.equal(isTransientExternal(abort), true);
    const t = new Error('HTTP 429'); t.status = 429;
    assert.equal(isTransientExternal(t), true);
    const reset = new Error('socket hang up'); reset.code = 'ECONNRESET';
    assert.equal(isTransientExternal(reset), true);
    assert.equal(isTransientExternal(new Error('Cannot read properties of undefined')), false);
  });

  it('serves /health before a slow warmup finishes', async () => {
    const app = express();
    app.get('/health', (req, res) => res.json({ ok: true }));
    let warmupStarted = false, warmupDone = false;
    const warmup = () => new Promise((resolve) => {
      warmupStarted = true;
      setTimeout(() => { warmupDone = true; resolve(); }, 400);
    });
    const { server, listening } = listenThenWarmup(app, { port: 0, host: '127.0.0.1', warmup });
    await listening;
    assert.equal(warmupDone, false);
    const port = server.address().port;
    const t0 = Date.now();
    const r = await fetch('http://127.0.0.1:' + port + '/health');
    const ms = Date.now() - t0;
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.ok(ms < 250, 'health should not wait on warmup, took ' + ms + 'ms');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(warmupStarted, true);
    assert.equal(warmupDone, true);
    await new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  });

  it('slimExchangeInfo keeps only configured symbols and filter fields used by filtersOf', () => {
    const raw = {
      timezone: 'UTC',
      symbols: [
        {
          symbol: 'NVDAUSDT', status: 'TRADING', pricePrecision: 2, quantityPrecision: 3,
          extraBloat: 'x'.repeat(1000),
          filters: [
            { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
            { filterType: 'PRICE_FILTER', tickSize: '0.01' },
            { filterType: 'MIN_NOTIONAL', notional: '5' },
            { filterType: 'MAX_NUM_ORDERS', limit: 200 },
          ],
        },
        { symbol: 'BTCUSDT', status: 'TRADING', pricePrecision: 1, quantityPrecision: 3, filters: [{ filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' }] },
      ],
    };
    const slim = slimExchangeInfo(raw, ['NVDAUSDT']);
    assert.equal(slim.symbols.length, 1);
    assert.equal(slim.symbols[0].symbol, 'NVDAUSDT');
    assert.equal(slim.timezone, undefined);
    assert.equal(slim.symbols[0].extraBloat, undefined);
    assert.deepEqual(slim.symbols[0].filters.map((f) => f.filterType), ['LOT_SIZE', 'PRICE_FILTER', 'MIN_NOTIONAL']);
    const f = filtersOf(slim, 'NVDAUSDT');
    assert.equal(f.stepSize, 0.001);
    assert.equal(f.tickSize, 0.01);
    assert.equal(f.minNotional, 5);
    assert.equal(filtersOf(slim, 'BTCUSDT'), null);
    assert.deepEqual(slimExchangeInfo(raw, []).symbols, []);
  });
});
