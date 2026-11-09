'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

describe('auth dual password', () => {
  const prev = { ...process.env };
  before(() => {
    process.env.OWNER_PASSWORD = 'owner-secret-test';
    process.env.GUEST_PASSWORD = 'guest-secret-test';
    process.env.SESSION_SECRET = 'test-session-secret-32chars!!';
    delete require.cache[require.resolve('../server/auth')];
  });
  after(() => {
    for (const k of ['OWNER_PASSWORD','GUEST_PASSWORD','SESSION_SECRET']) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
    delete require.cache[require.resolve('../server/auth')];
  });

  it('mints owner and guest sessions; guest pv rotates on password change', () => {
    const auth = require('../server/auth');
    assert.equal(auth.ownerConfigured(), true);
    assert.equal(auth.guestConfigured(), true);
    const ot = auth.mintSession('owner');
    const gt = auth.mintSession('guest');
    assert.equal(auth.verifyToken(ot).role, 'owner');
    assert.equal(auth.verifyToken(gt).role, 'guest');
    process.env.GUEST_PASSWORD = 'guest-secret-rotated';
    assert.equal(auth.verifyToken(gt), null); // invalidated
    assert.equal(auth.verifyToken(ot).role, 'owner'); // owner still ok
  });

  it('guestAllowed blocks writes and settings', () => {
    const auth = require('../server/auth');
    assert.equal(auth.guestAllowed({ method: 'GET', path: '/api/binance/positions' }), true);
    assert.equal(auth.guestAllowed({ method: 'POST', path: '/api/binance/settings' }), false);
    assert.equal(auth.guestAllowed({ method: 'POST', path: '/api/autotrader/kill' }), false);
    assert.equal(auth.guestAllowed({ method: 'GET', path: '/positions' }), true);
  });

  it('resolves b64: and HEX env passwords', () => {
    process.env.GUEST_PASSWORD = 'b64:' + Buffer.from('guest-secret-test', 'utf8').toString('base64');
    delete require.cache[require.resolve('../server/auth')];
    let auth = require('../server/auth');
    assert.equal(auth.guestPassword(), 'guest-secret-test');
    delete process.env.GUEST_PASSWORD;
    process.env.GUEST_PASSWORD_HEX = Buffer.from('guest-via-hex', 'utf8').toString('hex');
    delete require.cache[require.resolve('../server/auth')];
    auth = require('../server/auth');
    assert.equal(auth.guestPassword(), 'guest-via-hex');
    delete process.env.GUEST_PASSWORD_HEX;
    process.env.GUEST_PASSWORD = 'guest-secret-test';
    delete require.cache[require.resolve('../server/auth')];
  });

  it('redacts secret-looking keys', () => {
    const auth = require('../server/auth');
    const out = auth.redactSecrets({ apiKey: 'abc', nested: { privateKey: 'x', ok: 1 } });
    assert.equal(out.apiKey, '[redacted]');
    assert.equal(out.nested.privateKey, '[redacted]');
    assert.equal(out.nested.ok, 1);
  });
});
