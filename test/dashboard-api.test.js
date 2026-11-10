'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');

describe('dashboard API + pages', () => {
  const prev = { ...process.env };
  let server, base, auth;

  before(async () => {
    process.env.OWNER_PASSWORD = 'dash-owner-pass';
    process.env.GUEST_PASSWORD = 'dash-guest-pass';
    process.env.SESSION_SECRET = 'dashboard-test-session-secret!!';
    delete require.cache[require.resolve('../server/auth')];
    auth = require('../server/auth');
    const app = express();
    app.use(express.json());
    app.use(auth.attachUser);
    auth.mountRoutes(app, { wrap: (fn) => fn });
    app.get('/health', (req, res) => res.json(auth.publicHealth(1)));
    app.get('/api/health', (req, res) => res.json(auth.publicHealth(1)));
    app.use((req, res, next) => (auth.publicPath(req.path) ? next() : auth.requireAuth(req, res, next)));
    app.use(auth.gateMiddleware);
    app.get('/api/binance/positions', (req, res) => res.json({
      dryRun: true, equity: 800, ageMs: 250, stale: false,
      daily: { pnl: 1.25, pnlPct: 0.16, positionsUsed: 1, maxPositions: 4 },
      open: [{ symbol: 'NVDAUSDT', side: 'LONG', entryPx: 100, qty: 1, stopPx: 97, tpPx: 106, markPx: 101, upnl: 1 }],
      pending: [{ symbol: 'AAPLUSDT', side: 'SHORT', remainSec: 40, entryStatus: 'LIMIT_WORKING', protectionStatus: 'SL/TP planned — attach on fill', stopPx: 200, tpPx: 180, limitPx: 190, filledQty: 0, targetQty: 2 }],
      closed: [],
    }));
    app.get('/api/binance/whales', (req, res) => res.json({
      ok: true, cards: [], thirdParty: [{ name: 'Coinglass', use: 'OI', access: 'Paid', status: 'not_wired' }],
      forceOrderNote: 'Public WS not hooked',
    }));
    app.get('/api/binance/signals', (req, res) => res.json([{ id: 1, ts: Date.now(), symbol: 'NVDAUSDT', direction: 'LONG', entry: 100, stop: 97, tp: 106, status: 'open' }]));
    app.get('/futures', (req, res) => res.sendFile(path.join(PUB, 'futures.html')));
    app.get('/positions', (req, res) => res.sendFile(path.join(PUB, 'positions.html')));
    app.get('/whales', (req, res) => res.sendFile(path.join(PUB, 'whales.html')));
    app.get('/builder', (req, res) => res.sendFile(path.join(PUB, 'builder.html')));
    app.get('/weekly', (req, res) => res.sendFile(path.join(PUB, 'weekly.html')));
    app.get('/strategies', (req, res) => res.sendFile(path.join(PUB, 'strategies.html')));
    app.get('/options-settings', (req, res) => res.sendFile(path.join(PUB, 'options-settings.html')));
    app.get('/futures-settings', (req, res) => res.sendFile(path.join(PUB, 'futures-settings.html')));
    app.get('/', (req, res) => res.redirect(302, '/futures'));
    app.get('/index.html', (req, res) => res.redirect(302, '/futures'));
    for (const p of ['/signals', '/news', '/webhook', '/risk', '/paper', '/autotrader']) app.get(p, (req, res) => res.redirect(302, '/futures'));
    for (const p of ['/options']) app.get(p, (req, res) => res.redirect(301, '/builder'));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = 'http://127.0.0.1:' + server.address().port;
  });

  after(() => {
    if (server) server.close();
    for (const k of ['OWNER_PASSWORD', 'GUEST_PASSWORD', 'SESSION_SECRET']) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
    delete require.cache[require.resolve('../server/auth')];
  });

  const json = async (url, opts = {}) => {
    const r = await fetch(base + url, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
    const body = await r.json().catch(() => ({}));
    return { status: r.status, body, headers: r.headers };
  };

  it('GET /health and /api/health are public and mark guest disabled', async () => {
    for (const p of ['/health', '/api/health']) {
      const { status, body } = await json(p);
      assert.equal(status, 200, p);
      assert.equal(body.ok, true);
      assert.equal(body.guest, 'disabled');
    }
  });

  it('unauthenticated HTML redirects to login; API returns 401', async () => {
    const html = await fetch(base + '/futures', { redirect: 'manual', headers: { accept: 'text/html' } });
    assert.equal(html.status, 302);
    assert.match(html.headers.get('location') || '', /\/login/);
    const api = await json('/api/binance/positions');
    assert.equal(api.status, 401);
  });

  it('owner login succeeds; leftover guest password is rejected', async () => {
    const bad = await json('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: 'dash-guest-pass' }) });
    assert.equal(bad.status, 401);
    assert.notEqual(bad.body.role, 'guest');
    const ok = await json('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: 'dash-owner-pass' }) });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.role, 'owner');
    assert.equal(ok.body.readOnly, false);
    const cookie = ok.headers.get('set-cookie');
    assert.ok(cookie && cookie.includes('qs_session'));
    const me = await json('/api/auth/me', { headers: { cookie } });
    assert.equal(me.status, 200);
    assert.equal(me.body.role, 'owner');
    const pos = await json('/api/binance/positions', { headers: { cookie } });
    assert.equal(pos.status, 200);
    assert.equal(pos.body.dryRun, true);
    assert.equal(pos.body.pending[0].entryStatus, 'LIMIT_WORKING');
    const sig = await json('/api/binance/signals', { headers: { cookie } });
    assert.equal(sig.status, 200);
    assert.equal(sig.body[0].symbol, 'NVDAUSDT');
    const whales = await json('/api/binance/whales', { headers: { cookie } });
    assert.equal(whales.status, 200);
    const page = await fetch(base + '/futures', { headers: { accept: 'text/html', cookie }, redirect: 'manual' });
    assert.equal(page.status, 200);
    for (const p of ['/positions', '/whales', '/builder', '/weekly', '/strategies', '/options-settings', '/futures-settings']) {
      const r = await fetch(base + p, { headers: { accept: 'text/html', cookie }, redirect: 'manual' });
      assert.equal(r.status, 200, p + ' ' + r.status);
    }
  });

  it('legacy mixed pages redirect away from index/backtest UI', async () => {
    const cookie = (await json('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: 'dash-owner-pass' }) })).headers.get('set-cookie');
    for (const p of ['/signals', '/paper', '/autotrader', '/index.html']) {
      const r = await fetch(base + p, { headers: { cookie, accept: 'text/html' }, redirect: 'manual' });
      assert.equal(r.status, 302, p);
      assert.match(r.headers.get('location') || '', /\/futures/, p);
    }
    const opt = await fetch(base + '/options', { headers: { cookie, accept: 'text/html' }, redirect: 'manual' });
    assert.equal(opt.status, 301);
    assert.match(opt.headers.get('location') || '', /\/builder/);
  });

  it('dashboard HTML has no backtest board and login is owner-only', () => {
    const login = fs.readFileSync(path.join(PUB, 'login.html'), 'utf8');
    assert.match(login, /Owner password/);
    assert.doesNotMatch(login, /guest password/i);
    const shell = fs.readFileSync(path.join(PUB, 'shell.js'), 'utf8');
    for (const id of ['qsMode', 'qsEquity', 'qsDayPnl', 'qsPos', 'qsFeed', 'qsHealth', 'qsClock']) {
      assert.match(shell, new RegExp(id));
    }
    assert.match(shell, /5000/);
    const fut = fs.readFileSync(path.join(PUB, 'futures.html'), 'utf8') + fs.readFileSync(path.join(PUB, 'futures.js'), 'utf8');
    assert.match(fut, /Equity/);
    assert.match(fut, /Recent signals/);
    assert.doesNotMatch(fut, /\bbacktest results\b/i);
    const pos = fs.readFileSync(path.join(PUB, 'positions.js'), 'utf8');
    assert.match(pos, /LIMIT_WORKING|entryStatus|protectionStatus/);
    const whales = fs.readFileSync(path.join(PUB, 'whales.html'), 'utf8');
    assert.doesNotMatch(whales, /Guest read-only/);
    assert.match(whales, /aggTrade|open-interest|Binance/i);
  });
});
