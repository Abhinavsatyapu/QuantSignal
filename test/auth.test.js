'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

describe('auth owner-only', () => {
  const prev = { ...process.env };
  function loadAuth() {
    delete require.cache[require.resolve('../server/auth')];
    return require('../server/auth');
  }
  before(() => {
    process.env.OWNER_PASSWORD = 'owner-secret-test';
    process.env.GUEST_PASSWORD = 'guest-secret-test';
    process.env.SESSION_SECRET = 'test-session-secret-32chars!!';
    loadAuth();
  });
  after(() => {
    for (const k of ['OWNER_PASSWORD', 'GUEST_PASSWORD', 'SESSION_SECRET', 'OWNER_PASSWORD_HEX', 'GUEST_PASSWORD_HEX']) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
    delete require.cache[require.resolve('../server/auth')];
  });

  it('mints owner sessions and invalidates them when the owner password rotates', () => {
    const auth = loadAuth();
    assert.equal(auth.ownerConfigured(), true);
    assert.equal(auth.guestConfigured(), false);
    const ot = auth.mintSession('owner');
    assert.equal(auth.verifyToken(ot).role, 'owner');
    process.env.OWNER_PASSWORD = 'owner-secret-rotated';
    const auth2 = loadAuth();
    assert.equal(auth2.verifyToken(ot), null);
    process.env.OWNER_PASSWORD = 'owner-secret-test';
    loadAuth();
  });

  it('does not issue or accept guest sessions even when GUEST_PASSWORD is set', () => {
    const auth = loadAuth();
    assert.throws(() => auth.mintSession('guest'), /owner/i);
    // Forge a guest-shaped token with the same signing secret — verifyToken must reject it.
    const body = Buffer.from(JSON.stringify({
      role: 'guest',
      pv: auth.passwordVersion(process.env.GUEST_PASSWORD),
      iat: Date.now(),
      exp: Date.now() + 86400e3,
      nonce: 'abc',
    })).toString('base64url');
    const crypto = require('crypto');
    const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(body).digest('base64url');
    assert.equal(auth.verifyToken(body + '.' + sig), null);
    assert.equal(auth.guestAllowed({ method: 'GET', path: '/api/binance/positions' }), false);
  });

  it('resolves b64: and HEX env passwords for OWNER', () => {
    process.env.OWNER_PASSWORD = 'b64:' + Buffer.from('owner-secret-test', 'utf8').toString('base64');
    let auth = loadAuth();
    assert.equal(auth.ownerPassword(), 'owner-secret-test');
    delete process.env.OWNER_PASSWORD;
    process.env.OWNER_PASSWORD_HEX = Buffer.from('owner-via-hex', 'utf8').toString('hex');
    auth = loadAuth();
    assert.equal(auth.ownerPassword(), 'owner-via-hex');
    delete process.env.OWNER_PASSWORD_HEX;
    process.env.OWNER_PASSWORD = 'owner-secret-test';
    loadAuth();
  });

  it('redacts secret-looking keys', () => {
    const auth = loadAuth();
    const out = auth.redactSecrets({ apiKey: 'abc', nested: { privateKey: 'x', ok: 1 } });
    assert.equal(out.apiKey, '[redacted]');
    assert.equal(out.nested.privateKey, '[redacted]');
    assert.equal(out.nested.ok, 1);
  });

  it('public health reports guest disabled and locks when owner password is missing', () => {
    const auth = loadAuth();
    const h = auth.publicHealth(1);
    assert.equal(h.ok, true);
    assert.equal(h.guest, 'disabled');
    assert.equal(h.auth, 'configured');
    assert.equal(auth.publicPath('/api/health'), true);
    assert.equal(auth.publicPath('/health'), true);
    assert.equal(auth.publicPath('/login.js'), true);
  });
});

describe('HTML form login (no JS) and safe next', () => {
  const prev = { ...process.env };
  const express = require('express');
  const path = require('path');
  const fs = require('fs');
  let server, base, auth;

  function loadAuth() {
    delete require.cache[require.resolve('../server/auth')];
    return require('../server/auth');
  }

  before(async () => {
    process.env.OWNER_PASSWORD = 'owner-secret-test';
    process.env.GUEST_PASSWORD = 'guest-secret-test';
    process.env.SESSION_SECRET = 'test-session-secret-32chars!!';
    auth = loadAuth();
    const app = express();
    app.use(express.urlencoded({ extended: false, limit: '16kb' }));
    app.use(express.json());
    app.use(auth.attachUser);
    auth.mountRoutes(app, { wrap: (fn) => fn });
    app.get('/login', (req, res) => {
      const next = auth.safeNext(req.query && req.query.next);
      const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8');
      res.type('html').send(auth.fillLoginPage(html, { next, error: req.query && req.query.error }));
    });
    app.use((req, res, next) => (auth.publicPath(req.path) ? next() : auth.requireAuth(req, res, next)));
    app.get('/futures', (req, res) => res.type('html').send('<html><body>Futures Overview</body></html>'));
    app.get('/positions', (req, res) => res.type('html').send('<html><body>Positions</body></html>'));
    app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));
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

  it('safeNext allows same-origin paths and rejects open redirects', () => {
    assert.equal(auth.safeNext('/positions'), '/positions');
    assert.equal(auth.safeNext('/futures?x=1'), '/futures?x=1');
    assert.equal(auth.safeNext('//evil.example'), '/futures');
    assert.equal(auth.safeNext('https://evil.example'), '/futures');
    assert.equal(auth.safeNext('/\\evil'), '/futures');
    assert.equal(auth.safeNext('/login'), '/futures');
    assert.equal(auth.safeNext(''), '/futures');
  });

  it('form POST /login sets the session cookie and 303s to a safe next path', async () => {
    const body = new URLSearchParams({ password: 'owner-secret-test', next: '/positions' }).toString();
    const r = await fetch(base + '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body,
    });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/positions');
    const cookie = r.headers.get('set-cookie') || '';
    assert.match(cookie, /qs_session=/);
    assert.match(cookie, /HttpOnly/i);
    const page = await fetch(base + '/positions', { headers: { cookie, accept: 'text/html' }, redirect: 'manual' });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Positions/);
  });

  it('form POST rejects open-redirect next and invalid passwords without JSON', async () => {
    const open = await fetch(base + '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({ password: 'owner-secret-test', next: '//evil.example' }).toString(),
    });
    assert.equal(open.status, 303);
    assert.equal(open.headers.get('location'), '/futures');

    const bad = await fetch(base + '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({ password: 'wrong-password', next: '/futures' }).toString(),
    });
    assert.equal(bad.status, 303);
    assert.match(bad.headers.get('location') || '', /\/login\?error=invalid/);
    const page = await fetch(base + (bad.headers.get('location') || '/login'), { redirect: 'manual' });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Invalid password/);
    assert.doesNotMatch(html, /\{\{ERROR\}\}|\{\{NEXT\}\}/);
    assert.match(html, /action="\/login"/);
  });

  it('JSON POST /api/auth/login is unchanged and /login.js is public', async () => {
    const r = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'owner-secret-test' }),
    });
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.ok, true);
    assert.equal(d.role, 'owner');
    const js = await fetch(base + '/login.js');
    assert.equal(js.status, 200);
    assert.match(await js.text(), /api\/auth\/login/);
  });
});
