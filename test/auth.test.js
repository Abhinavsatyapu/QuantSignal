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
  });
});
