'use strict';
/**
 * Dual-password site auth (owner + guest).
 * OWNER_PASSWORD → full control. GUEST_PASSWORD → read-only (shared manually).
 * Changing a password invalidates that role's sessions (password version in signed cookie).
 * Fail closed when OWNER_PASSWORD is unset. Never log password values.
 */
const crypto = require('crypto');

const COOKIE = 'qs_session';
const MAX_AGE_MS = 7 * 24 * 3600e3;
const LOGIN_WINDOW_MS = 60e3;
const LOGIN_MAX = 10;

const loginHits = new Map();

/** Resolve OWNER/GUEST secrets. Supports plain, `b64:<base64>`, `hex:<hex>`, or NAME_HEX / NAME_HEX_A+NAME_HEX_B (deployer-safe encodings). */
function resolveEnvSecret(name) {
  const fromParts = () => {
    const a = process.env[name + '_HEX_A'];
    const b = process.env[name + '_HEX_B'];
    if (typeof a === 'string' && typeof b === 'string' && a.length && b.length) {
      try { return Buffer.from(a + b, 'hex').toString('utf8'); } catch { return ''; }
    }
    const h = process.env[name + '_HEX'];
    if (typeof h === 'string' && h.length) {
      try { return Buffer.from(h, 'hex').toString('utf8'); } catch { return ''; }
    }
    const b64 = process.env[name + '_B64'];
    if (typeof b64 === 'string' && b64.length) {
      try { return Buffer.from(b64, 'base64').toString('utf8'); } catch { return ''; }
    }
    return '';
  };
  const raw = process.env[name];
  if (typeof raw === 'string' && raw.length) {
    if (raw.startsWith('b64:')) {
      try { return Buffer.from(raw.slice(4), 'base64').toString('utf8'); } catch { return fromParts(); }
    }
    if (raw.startsWith('hex:')) {
      try { return Buffer.from(raw.slice(4), 'hex').toString('utf8'); } catch { return fromParts(); }
    }
    return raw;
  }
  return fromParts();
}
function ownerPassword() { return resolveEnvSecret('OWNER_PASSWORD'); }
function guestPassword() { return resolveEnvSecret('GUEST_PASSWORD'); }

function ownerConfigured() {
  return ownerPassword().length > 0;
}
function guestConfigured() {
  return guestPassword().length > 0;
}

function sessionSecret() {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  if (!globalThis.__qsSessionSecret) globalThis.__qsSessionSecret = crypto.randomBytes(32).toString('hex');
  return globalThis.__qsSessionSecret;
}

/** Short fingerprint of a password — embedded in session so env rotation kills old cookies. */
function passwordVersion(pw) {
  return crypto.createHash('sha256').update(String(pw || ''), 'utf8').digest('hex').slice(0, 16);
}

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function fromB64url(s) { return Buffer.from(String(s), 'base64url'); }

function signPayload(obj) {
  const body = b64url(JSON.stringify(obj));
  const sig = crypto.createHmac('sha256', sessionSecret()).update(body).digest('base64url');
  return body + '.' + sig;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expect = crypto.createHmac('sha256', sessionSecret()).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(fromB64url(body).toString('utf8')); } catch { return null; }
  if (!payload || (payload.role !== 'owner' && payload.role !== 'guest')) return null;
  if (!(payload.exp > Date.now())) return null;
  // Invalidate when env password changed
  const wantPv = payload.role === 'owner'
    ? passwordVersion(ownerPassword())
    : passwordVersion(guestPassword());
  if (!payload.pv || !safeEqStr(payload.pv, wantPv)) return null;
  if (payload.role === 'owner' && !ownerConfigured()) return null;
  if (payload.role === 'guest' && !guestConfigured()) return null;
  return payload;
}

function safeEqStr(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length || x.length === 0) {
    crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    return false;
  }
  return crypto.timingSafeEqual(x, y);
}

function verifyAgainstEnv(supplied, stored) {
  if (!stored) return false;
  if (stored.startsWith('scrypt$')) {
    const parts = stored.split('$');
    if (parts.length !== 6) return false;
    const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
    const salt = Buffer.from(parts[4], 'base64');
    const want = Buffer.from(parts[5], 'base64');
    try {
      const got = crypto.scryptSync(String(supplied || ''), salt, want.length, { N, r, p });
      return got.length === want.length && crypto.timingSafeEqual(got, want);
    } catch { return false; }
  }
  return safeEqStr(supplied, stored);
}

function parseCookies(req) {
  const h = req.headers.cookie || '';
  const out = {};
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function isSecure() {
  return process.env.NODE_ENV === 'production' || process.env.RENDER === 'true' || !!process.env.RENDER_EXTERNAL_URL;
}

function setSessionCookie(res, token) {
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${Math.floor(MAX_AGE_MS / 1000)}`,
  ];
  if (isSecure()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  const parts = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecure()) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function readSession(req) {
  return verifyToken(parseCookies(req)[COOKIE]);
}

function rateLimitLogin(ip) {
  const now = Date.now();
  const hits = (loginHits.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  hits.push(now);
  loginHits.set(ip, hits);
  return hits.length <= LOGIN_MAX;
}

function mintSession(role) {
  const pw = role === 'owner' ? ownerPassword() : guestPassword();
  return signPayload({
    role,
    pv: passwordVersion(pw),
    iat: Date.now(),
    exp: Date.now() + MAX_AGE_MS,
    nonce: crypto.randomBytes(8).toString('hex'),
  });
}

function attachUser(req, _res, next) {
  req.user = readSession(req);
  next();
}

function wantsHtml(req) {
  const a = req.get('accept') || '';
  return a.includes('text/html') && !req.path.startsWith('/api/');
}

function requireAuth(req, res, next) {
  if (req.user && (req.user.role === 'owner' || req.user.role === 'guest')) return next();
  if (wantsHtml(req)) return res.redirect(302, '/login?next=' + encodeURIComponent(req.originalUrl || '/'));
  return res.status(401).json({ error: 'Login required' });
}

function requireOwner(req, res, next) {
  if (req.user && req.user.role === 'owner') return next();
  if (req.user && req.user.role === 'guest') {
    if (wantsHtml(req)) return res.status(403).send('Owner access required');
    return res.status(403).json({ error: 'Owner access required' });
  }
  if (wantsHtml(req)) return res.redirect(302, '/login?next=' + encodeURIComponent(req.originalUrl || '/'));
  return res.status(401).json({ error: 'Owner login required' });
}

/** Paths that skip session auth (webhook uses its own secret). */
function publicPath(path) {
  if (path === '/version' || path === '/health') return true;
  if (path === '/login') return true;
  if (path === '/api/auth/login' || path === '/api/auth/logout' || path === '/api/auth/me') return true;
  if (path === '/webhook') return true;
  if (path === '/styles.css' || path === '/favicon.svg') return true;
  return false;
}

/**
 * Guest may only use safe read endpoints. Everything else (writes, settings, keys, admin) is owner-only.
 * Returns true if this request is allowed for a guest.
 */
function guestAllowed(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') return false;
  const p = req.path;
  // Explicit denylist of sensitive GETs
  if (p === '/api/health/detail') return false;
  if (p.startsWith('/api/autotrader')) {
    // guest: status/signals/trades/events/scans/markets ok; no config dumps with secrets
    if (p === '/api/autotrader/status' || p === '/api/autotrader/signals' || p === '/api/autotrader/trades'
      || p === '/api/autotrader/events' || p === '/api/autotrader/scans' || p === '/api/autotrader/markets') return true;
    return false;
  }
  if (p.startsWith('/api/binance')) {
    if (p === '/api/binance/prices' || p === '/api/binance/prices/stream' || p === '/api/binance/positions' || p === '/api/binance/whales') return true;
    if (p === '/futures') return true;
    // status/health/events/trades/settings — no settings; allow status/events/trades read
    if (p === '/api/binance/status' || p === '/api/binance/events' || p === '/api/binance/trades') return true;
    return false;
  }
  // Strategy / builder reads
  if (p.startsWith('/api/strategy')) {
    if (p.includes('import') || p.includes('export') || p.includes('weights') && req.method !== 'GET') return false;
    return true; // GET strategy data
  }
  if (p.startsWith('/api/')) {
    // derivatives, news, stocks, hyperliquid public reads
    if (p === '/api/news' || p === '/api/stocks' || p === '/api/stream/universe') return true;
    if (p.startsWith('/api/') && (p.includes('chain') || p.includes('quote') || p.includes('builder')
      || p.includes('optimize') || p.includes('weekly') || p.includes('runs') || p.includes('plan')
      || p.includes('reference') || p.includes('sheet') || p.includes('gamma') || p.includes('hedge'))) return true;
    // POST /api/hyperliquid is market data — allow as "read" even though POST
    return false;
  }
  // HTML pages — guest may view UI; client should hide write controls; server blocks write APIs
  if (!p.startsWith('/api/')) return true;
  return false;
}

function gateMiddleware(req, res, next) {
  if (publicPath(req.path)) return next();
  // Special-case: Hyperliquid public market-data POST used by UI charts
  if (req.method === 'POST' && req.path === '/api/hyperliquid') {
    return requireAuth(req, res, next);
  }
  if (req.user && req.user.role === 'owner') return next();
  if (req.user && req.user.role === 'guest') {
    if (guestAllowed(req) || (req.method === 'POST' && req.path === '/api/hyperliquid')) return next();
    return res.status(403).json({ error: 'Read-only guest session — action not permitted' });
  }
  return requireAuth(req, res, next);
}

function publicHealth(uptimeSec) {
  return {
    ok: true,
    uptimeSec,
    auth: ownerConfigured() ? 'configured' : 'missing_owner_password',
    guest: guestConfigured() ? 'configured' : 'missing_guest_password',
  };
}

function publicVersion(versionObj) {
  return {
    name: versionObj.name,
    version: versionObj.version,
    commit: versionObj.commit ? String(versionObj.commit).slice(0, 12) : null,
    builtAt: versionObj.builtAt || null,
  };
}

/** Strip secrets from objects before sending to guests */
function redactSecrets(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const SENSITIVE = /password|secret|api[_-]?key|private[_-]?key|mnemonic|seed|token|authorization/i;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const o = {};
    for (const [k, val] of Object.entries(v)) {
      if (SENSITIVE.test(k)) o[k] = typeof val === 'string' && val ? '[redacted]' : null;
      else o[k] = walk(val);
    }
    return o;
  };
  return walk(obj);
}

function mountRoutes(app, { wrap }) {
  app.get('/api/auth/me', (req, res) => {
    if (!ownerConfigured()) {
      return res.status(503).json({
        authenticated: false, role: null, configured: false, guestConfigured: guestConfigured(),
        error: 'OWNER_PASSWORD not set — site is locked',
      });
    }
    if (req.user) {
      return res.json({
        authenticated: true, role: req.user.role, configured: true,
        guestConfigured: guestConfigured(), exp: req.user.exp, readOnly: req.user.role === 'guest',
      });
    }
    return res.status(401).json({ authenticated: false, role: null, configured: true, guestConfigured: guestConfigured() });
  });

  app.post('/api/auth/login', (req, res) => {
    if (!ownerConfigured()) {
      return res.status(503).json({ error: 'OWNER_PASSWORD not configured — cannot log in' });
    }
    const ip = req.ip || 'unknown';
    if (!rateLimitLogin(ip)) return res.status(429).json({ error: 'Too many login attempts — try again shortly' });
    const password = req.body && req.body.password;
    // Owner match first, then guest (constant-time-ish: always check both lengths via verify)
    const asOwner = verifyAgainstEnv(password, ownerPassword());
    const asGuest = guestConfigured() && verifyAgainstEnv(password, guestPassword());
    if (asOwner) {
      setSessionCookie(res, mintSession('owner'));
      return res.json({ ok: true, role: 'owner', readOnly: false });
    }
    if (asGuest) {
      setSessionCookie(res, mintSession('guest'));
      return res.json({ ok: true, role: 'guest', readOnly: true });
    }
    return res.status(401).json({ error: 'Invalid password' });
  });

  app.post('/api/auth/logout', (req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });
}

module.exports = {
  COOKIE, attachUser, gateMiddleware, requireAuth, requireOwner, mountRoutes,
  publicHealth, publicVersion, publicPath, guestAllowed, redactSecrets,
  ownerConfigured, guestConfigured, ownerPassword, guestPassword, resolveEnvSecret, passwordVersion,
  verifyAgainstEnv, mintSession, verifyToken, setSessionCookie, clearSessionCookie, readSession,
};
