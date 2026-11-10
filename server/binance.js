'use strict';
// Binance USDⓈ-M Futures REST + user-data stream client.
// Secrets stay in env (BINANCE_API_KEY / BINANCE_API_SECRET); never logged.
// Signing uses HMAC-SHA256. Server time is synced to avoid -1021 drift.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const limiter = require('./binance-limiter');

const URLS = {
  // fapi.binance.com returns HTTP 451 from many cloud/US IPs; www.binance.com/fapi proxies the same public endpoints.
  live: { rest: 'https://fapi.binance.com', publicRest: 'https://www.binance.com', ws: 'wss://fstream.binance.com' },
  testnet: { rest: 'https://testnet.binancefuture.com', publicRest: 'https://testnet.binancefuture.com', ws: 'wss://stream.binancefuture.com' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = (k) => (process.env[k] && process.env[k].trim()) || '';

function runtime() {
  const key = env('BINANCE_API_KEY'), secret = env('BINANCE_API_SECRET');
  const liveFlag = env('BINANCE_LIVE').toLowerCase() === 'yes';
  const preferTestnet = env('BINANCE_USE_TESTNET') === '1' || env('BINANCE_USE_TESTNET') === 'true' || !liveFlag;
  const problems = [];
  if (key && !secret) problems.push('BINANCE_API_KEY is set but BINANCE_API_SECRET is missing.');
  if (secret && !key) problems.push('BINANCE_API_SECRET is set but BINANCE_API_KEY is missing.');
  if (liveFlag && !(key && secret)) problems.push('BINANCE_LIVE=yes but API keys are missing: staying in DRY-RUN.');
  if (liveFlag && preferTestnet && env('BINANCE_USE_TESTNET')) problems.push('BINANCE_LIVE=yes overrides BINANCE_USE_TESTNET; live mainnet would be used if keys are present.');
  const keysOk = !!(key && secret);
  // LIVE only when keys present AND BINANCE_LIVE=yes. Otherwise dry-run (no signed order posts).
  // Testnet REST is used for read-only / optional signed calls only when keys exist and LIVE is off.
  const mode = (keysOk && liveFlag) ? 'live' : 'dry_run';
  const network = (keysOk && liveFlag) ? 'live' : (keysOk && preferTestnet ? 'testnet' : 'dry_run');
  return {
    mode, // dry_run | live
    network, // dry_run | testnet | live — where REST would point if keys allow
    keyPresent: keysOk,
    liveEnabled: liveFlag,
    canTrade: keysOk && (liveFlag || preferTestnet), // signed orders allowed only when keys + (live or testnet)
    allowSignedOrders: false, // hard gate: the trader must flip this only after explicit enable; default never
    problems,
    urls: URLS[network === 'live' ? 'live' : 'testnet'],
    keyHint: key ? (key.slice(0, 4) + '…' + key.slice(-4)) : null,
  };
}

function Client(opts = {}) {
  const rt0 = runtime();
  const state = {
    network: opts.network || (rt0.network === 'live' ? 'live' : 'testnet'),
    timeOffsetMs: 0,
    lastServerTimeAt: 0,
    listenKey: null,
    listenKeyAt: 0,
    ws: null,
    wsStatus: 'idle',
    lastWsMsgAt: 0,
    lastError: null,
    rateLimitedUntil: 0,
  };
  const emitter = new EventEmitter();
  const urls = () => URLS[state.network === 'live' ? 'live' : 'testnet'];

  async function raw(method, path, { query = {}, signed = false, body = null, publicOk = false, signal = null, timeoutMs = 8000, priority = 'normal' } = {}, attempt = 0) {
    if (signal && signal.aborted) throw limiter.abortError(signal);
    if (Date.now() < state.rateLimitedUntil) {
      const wait = state.rateLimitedUntil - Date.now();
      await sleep(Math.min(wait, 3000));
    }
    const run = () => rawOnce(method, path, { query, signed, body, publicOk, signal, timeoutMs, priority }, attempt);
    // Signed / already-inside-limiter recursive retries skip the queue to preserve attempt state.
    if (attempt > 0) return run();
    return limiter.schedule(run, { signal, priority: signed ? 'high' : priority });
  }

  async function rawOnce(method, path, { query = {}, signed = false, body = null, publicOk = false, signal = null, timeoutMs = 8000, priority = 'normal' } = {}, attempt = 0) {
    if (signal && signal.aborted) throw limiter.abortError(signal);
    if (Date.now() < state.rateLimitedUntil) {
      const wait = state.rateLimitedUntil - Date.now();
      await sleep(Math.min(wait, 3000));
    }
    // Unsigned market-data GETs ALWAYS use live www.binance.com — even in dry-run/testnet mode —
    // so exchangeInfo/klines see the full TRADIFI equity universe (testnet lists are truncated).
    // Signed trading calls still use urls().rest (testnet or live per keys).
    const livePublic = URLS.live.publicRest || URLS.live.rest;
    const base = (!signed && method === 'GET')
      ? ((publicOk || state.network !== 'live') ? livePublic : (urls().publicRest || livePublic))
      : urls().rest;
    const u = new URL(path, base);
    const params = { ...query };
    if (signed) {
      params.timestamp = Date.now() + state.timeOffsetMs;
      params.recvWindow = params.recvWindow || 5000;
      const qs = new URLSearchParams(params).toString();
      const secret = env('BINANCE_API_SECRET');
      if (!secret) throw Object.assign(new Error('Binance secret missing for signed request'), { code: 'NO_KEYS' });
      params.signature = crypto.createHmac('sha256', secret).update(qs).digest('hex');
    }
    const qs = new URLSearchParams(params).toString();
    const url = qs ? u.toString() + (u.search ? '&' : '?') + qs : u.toString();
    const headers = { 'User-Agent': 'QuantSignal-Binance/1.0', 'Content-Type': 'application/json' };
    const key = env('BINANCE_API_KEY');
    if (key) headers['X-MBX-APIKEY'] = key;
    let res;
    const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 8000;
    let fetchSignal = AbortSignal.timeout(timeout);
    if (signal) {
      const ac = new AbortController();
      const onAbort = () => ac.abort(signal.reason || 'aborted');
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      fetchSignal = AbortSignal.any ? AbortSignal.any([fetchSignal, ac.signal]) : ac.signal;
      // If AbortSignal.any is missing, still honor timeout:
      if (!AbortSignal.any) setTimeout(() => { try { ac.abort('timeout'); } catch {} }, timeout);
    }
    try {
      res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: fetchSignal });
    } catch (e) {
      if (signal && signal.aborted) throw limiter.abortError(signal);
      if (attempt < 1) { await sleep(200 * 2 ** attempt); return raw(method, path, { query, signed, body, publicOk, signal, timeoutMs, priority }, attempt + 1); }
      state.lastError = e.message; throw e;
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (res.status === 429 || res.status === 418) {
      const retry = Math.min(5000, Math.max(250, Number(res.headers.get('retry-after') || 1) * 1000 || 1000));
      state.rateLimitedUntil = Date.now() + retry;
      try { limiter.pause(retry); } catch {}
      if (attempt < 2) { await sleep(retry); return raw(method, path, { query, signed, body, publicOk, signal, timeoutMs, priority }, attempt + 1); }
    }
    // -1021 timestamp drift: resync and retry once
    if (data && data.code === -1021 && attempt < 2) {
      await syncTime();
      return raw(method, path, { query, signed, body, publicOk, signal, timeoutMs, priority }, attempt + 1);
    }
    if (!res.ok) {
      const err = Object.assign(new Error((data && (data.msg || data.message)) || ('HTTP ' + res.status)), { status: res.status, code: data && data.code, data });
      state.lastError = err.message;
      // Geo-block on fapi → fall back to www.binance.com public proxy for unsigned GETs
      if ((res.status === 451 || res.status === 403) && !signed && method === 'GET' && attempt < 2 && urls().publicRest && !String(u).startsWith(urls().publicRest)) {
        return raw(method, path, { query, signed, body, publicOk: true, signal, timeoutMs, priority }, attempt + 1);
      }
      if (attempt < 2 && res.status >= 500) { await sleep(300 * 2 ** attempt); return raw(method, path, { query, signed, body, publicOk, signal, timeoutMs, priority }, attempt + 1); }
      throw err;
    }
    return data;
  }

  async function syncTime() {
    const t0 = Date.now();
    const d = await raw('GET', '/fapi/v1/time', {});
    const t1 = Date.now();
    // serverTime ≈ mid-RTT
    state.timeOffsetMs = d.serverTime - Math.round((t0 + t1) / 2);
    state.lastServerTimeAt = Date.now();
    return state.timeOffsetMs;
  }

  const publicGet = (path, query, opts = {}) => raw('GET', path, { query, ...opts });
  const signedGet = (path, query) => raw('GET', path, { query, signed: true });
  const signedPost = (path, query) => raw('POST', path, { query, signed: true });
  const signedDelete = (path, query) => raw('DELETE', path, { query, signed: true });

  async function exchangeInfo() { return publicGet('/fapi/v1/exchangeInfo'); }
  async function markPrice(symbol) { return publicGet('/fapi/v1/premiumIndex', symbol ? { symbol } : {}); }
  async function klines(symbol, interval, limit = 200, opts = {}) {
    const rows = await publicGet('/fapi/v1/klines', { symbol, interval, limit }, opts);
    if (!Array.isArray(rows)) return [];
    return rows.map((r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], T: r[6], closed: true }));
  }
  async function positionRisk(symbol) {
    const rows = await signedGet('/fapi/v2/positionRisk', symbol ? { symbol } : {});
    return (Array.isArray(rows) ? rows : []).filter((p) => Math.abs(Number(p.positionAmt)) > 0);
  }
  async function openOrders(symbol) { return signedGet('/fapi/v1/openOrders', symbol ? { symbol } : {}); }
  async function account() { return signedGet('/fapi/v2/account'); }
  async function setLeverage(symbol, leverage) { return signedPost('/fapi/v1/leverage', { symbol, leverage }); }
  async function setMarginType(symbol, marginType) {
    try { return await signedPost('/fapi/v1/marginType', { symbol, marginType }); }
    catch (e) { if (e.code === -4046) return { msg: 'No need to change margin type.' }; throw e; } // already set
  }
  async function placeOrder(params) { return signedPost('/fapi/v1/order', params); }
  async function cancelOrder(params) { return signedDelete('/fapi/v1/order', params); }
  async function cancelAll(symbol) { return signedDelete('/fapi/v1/allOpenOrders', { symbol }); }

  async function startUserStream() {
    const d = await signedPost('/fapi/v1/listenKey', {});
    state.listenKey = d.listenKey; state.listenKeyAt = Date.now();
    return state.listenKey;
  }
  async function keepListenKey() {
    if (!state.listenKey) return startUserStream();
    await signedPutSafe('/fapi/v1/listenKey', {});
    state.listenKeyAt = Date.now();
    return state.listenKey;
  }
  async function signedPutSafe(path, query) {
    // listenKey keepalive uses PUT
    return raw('PUT', path, { query, signed: false }); // listenKey PUT is key-header auth, no signature per Binance docs
  }

  function connectUserStream(onEvent) {
    const WebSocket = require('ws');
    if (!state.listenKey) throw new Error('listenKey missing');
    if (state.ws) { try { state.ws.close(); } catch {} }
    const url = urls().ws + '/ws/' + state.listenKey;
    state.wsStatus = 'connecting';
    const ws = new WebSocket(url);
    state.ws = ws;
    ws.on('open', () => { state.wsStatus = 'open'; state.lastWsMsgAt = Date.now(); emitter.emit('ws', 'open'); });
    ws.on('message', (buf) => {
      state.lastWsMsgAt = Date.now();
      let msg; try { msg = JSON.parse(String(buf)); } catch { return; }
      if (typeof onEvent === 'function') onEvent(msg);
      emitter.emit('event', msg);
    });
    ws.on('close', () => { state.wsStatus = 'closed'; emitter.emit('ws', 'closed'); });
    ws.on('error', (e) => { state.wsStatus = 'error'; state.lastError = e.message; emitter.emit('ws', 'error', e); });
    return ws;
  }

  function disconnect() {
    if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
    state.wsStatus = 'idle';
  }

  return {
    state, emitter, runtime, urls, syncTime, publicGet, signedGet, signedPost,
    exchangeInfo, markPrice, klines, positionRisk, openOrders, account,
    setLeverage, setMarginType, placeOrder, cancelOrder, cancelAll,
    startUserStream, keepListenKey, connectUserStream, disconnect,
    setNetwork: (n) => { state.network = n === 'live' ? 'live' : 'testnet'; },
  };
}

// Pure helpers (no I/O) — used by the trader and by tests
function roundStep(qty, step) {
  if (!(step > 0)) return qty;
  const p = Math.max(0, Math.round(-Math.log10(step)));
  const n = Math.floor(qty / step + 1e-12) * step;
  return Number(n.toFixed(p));
}
function roundTick(px, tick) {
  if (!(tick > 0)) return px;
  const p = Math.max(0, Math.round(-Math.log10(tick)));
  const n = Math.round(px / tick) * tick;
  return Number(n.toFixed(p));
}
function filtersOf(info, symbol) {
  const s = (info.symbols || []).find((x) => x.symbol === symbol);
  if (!s) return null;
  const lot = (s.filters || []).find((f) => f.filterType === 'LOT_SIZE') || {};
  const price = (s.filters || []).find((f) => f.filterType === 'PRICE_FILTER') || {};
  const minNotional = (s.filters || []).find((f) => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL') || {};
  const pct = (s.filters || []).find((f) => f.filterType === 'PERCENT_PRICE' || f.filterType === 'PERCENT_PRICE_BY_SIDE') || {};
  return {
    symbol, status: s.status, pricePrecision: s.pricePrecision, quantityPrecision: s.quantityPrecision,
    stepSize: Number(lot.stepSize || Math.pow(10, -(s.quantityPrecision || 3))),
    tickSize: Number(price.tickSize || Math.pow(10, -(s.pricePrecision || 2))),
    minQty: Number(lot.minQty || 0),
    minNotional: Number(minNotional.notional || minNotional.minNotional || 5),
    multiplierUp: pct.multiplierUp != null ? Number(pct.multiplierUp) : undefined,
    multiplierDown: pct.multiplierDown != null ? Number(pct.multiplierDown) : undefined,
    bidMultiplierUp: pct.bidMultiplierUp != null ? Number(pct.bidMultiplierUp) : undefined,
    bidMultiplierDown: pct.bidMultiplierDown != null ? Number(pct.bidMultiplierDown) : undefined,
    askMultiplierUp: pct.askMultiplierUp != null ? Number(pct.askMultiplierUp) : undefined,
    askMultiplierDown: pct.askMultiplierDown != null ? Number(pct.askMultiplierDown) : undefined,
  };
}

/** Keep only the filter fields we need for configured symbols so the full exchangeInfo payload is not retained. */
function slimExchangeInfo(info, assets) {
  if (!info || !Array.isArray(info.symbols)) return info || { symbols: [] };
  const wanted = new Set((assets || []).map((s) => String(s).toUpperCase()).filter(Boolean));
  const keepTypes = new Set(['LOT_SIZE', 'PRICE_FILTER', 'MIN_NOTIONAL', 'NOTIONAL', 'PERCENT_PRICE', 'PERCENT_PRICE_BY_SIDE']);
  const src = wanted.size ? info.symbols.filter((s) => wanted.has(String(s.symbol || '').toUpperCase())) : [];
  return {
    symbols: src.map((s) => ({
      symbol: s.symbol,
      status: s.status,
      pricePrecision: s.pricePrecision,
      quantityPrecision: s.quantityPrecision,
      filters: (s.filters || []).filter((f) => keepTypes.has(f.filterType)),
    })),
  };
}

/** Size a USD-M futures order so the $ loss at the stop ≈ riskUsd, capped by margin budget and leverage. */
function sizePosition({ capital, leverage, riskPerTradePct, maxConcurrent, entry, stopPct, stepSize, minQty, minNotional, openCount }) {
  if (!(capital > 0 && leverage >= 1 && entry > 0 && stopPct > 0)) throw new Error('Invalid sizing inputs');
  const riskUsd = capital * (riskPerTradePct / 100);
  const marginBudget = capital / Math.max(1, maxConcurrent);
  const maxNotionalByMargin = marginBudget * leverage;
  let notional = riskUsd / stopPct;
  notional = Math.min(notional, maxNotionalByMargin);
  if (openCount >= maxConcurrent) return { ok: false, reason: 'max concurrent positions reached', riskUsd, notional: 0, qty: 0, margin: 0 };
  let qty = notional / entry;
  qty = roundStep(qty, stepSize || 0.001);
  if (qty < (minQty || 0)) return { ok: false, reason: 'qty below minQty after step rounding', riskUsd, notional: 0, qty: 0, margin: 0 };
  notional = qty * entry;
  if (minNotional && notional < minNotional) return { ok: false, reason: 'notional below exchange minimum', riskUsd, notional, qty, margin: notional / leverage };
  const stopLossUsd = notional * stopPct;
  return { ok: true, riskUsd, notional, qty, margin: notional / leverage, stopLossUsd, leverage, stopPct };
}

function clientOrderId(parts) {
  // Binance: max 36 chars, ^[\.A-Z\:/a-z0-9_-]{1,36}$
  const raw = ['qs', ...parts].join('-').replace(/[^A-Za-z0-9._\-:\/]/g, '').slice(0, 36);
  return raw;
}

module.exports = {
  slimExchangeInfo,
  URLS, runtime, Client, roundStep, roundTick, filtersOf, sizePosition, clientOrderId,
};
