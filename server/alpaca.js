'use strict';
// Alpaca market-data client (server side only). Keys come from env ALPACA_KEY_ID / ALPACA_SECRET_KEY and are
// never sent to the browser or to any third party other than Alpaca itself.
// Docs: https://docs.alpaca.markets/reference/optionchain (snapshots), /v2/options/contracts, /v2/stocks/snapshots.

const env = (k, d = '') => (process.env[k] || d).trim();
const keyId = () => env('ALPACA_KEY_ID') || env('APCA_API_KEY_ID');
const secret = () => env('ALPACA_SECRET_KEY') || env('APCA_API_SECRET_KEY');
const configured = () => !!(keyId() && secret());
const optionsFeed = () => (env('ALPACA_OPTIONS_FEED', 'indicative').toLowerCase() === 'opra' ? 'opra' : 'indicative');
const stockFeed = () => { const f = env('ALPACA_STOCK_FEED', 'iex').toLowerCase(); return ['iex', 'sip', 'delayed_sip'].includes(f) ? f : 'iex'; };
const dataUrl = () => env('ALPACA_DATA_URL', 'https://data.alpaca.markets').replace(/\/$/, '');
const tradingUrl = () => env('ALPACA_TRADING_URL', env('ALPACA_ENV') === 'live' ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets').replace(/\/$/, '');

function httpErr(status, message) { const e = Error(message); e.status = status; return e; }
const NO_KEYS = 'Alpaca API keys are not configured on this server. Set ALPACA_KEY_ID and ALPACA_SECRET_KEY in the server environment (never in the browser). Manual premium entry still works.';

let fetchImpl = (...a) => fetch(...a);
function _setFetch(f) { fetchImpl = f; } // unit tests

async function get(base, path, params = {}) {
  if (!configured()) throw httpErr(503, NO_KEYS);
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, String(v));
  const url = base + path + (q.toString() ? '?' + q : '');
  let r;
  try {
    r = await fetchImpl(url, { headers: { 'APCA-API-KEY-ID': keyId(), 'APCA-API-SECRET-KEY': secret(), Accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
  } catch (e) { throw httpErr(502, 'Alpaca request failed: ' + (e.name === 'TimeoutError' ? 'timeout' : e.message)); }
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch {}
  if (!r.ok) {
    const msg = body?.message || text.slice(0, 160) || 'HTTP ' + r.status;
    if (r.status === 401) throw httpErr(502, 'Alpaca rejected the server API keys (401). Check ALPACA_KEY_ID / ALPACA_SECRET_KEY' + (base.includes('paper') ? ' (paper-account keys expected; set ALPACA_ENV=live for live keys)' : '') + '.');
    if (r.status === 403) throw httpErr(502, 'Alpaca refused this request (403): ' + msg + (params.feed === 'opra' ? ' · OPRA requires an Alpaca options data subscription; set ALPACA_OPTIONS_FEED=indicative.' : params.feed === 'sip' ? ' · SIP requires a subscription; set ALPACA_STOCK_FEED=iex.' : ''));
    if (r.status === 429) throw httpErr(429, 'Alpaca rate limit reached (200 requests/min on the free plan). Retry shortly.');
    if (r.status === 404 || r.status === 422 || r.status === 400) throw httpErr(400, 'Alpaca: ' + msg);
    throw httpErr(502, 'Alpaca HTTP ' + r.status + ': ' + msg);
  }
  if (body == null) throw httpErr(502, 'Alpaca returned a non-JSON response');
  return body;
}

// OCC symbol: ROOT + YYMMDD + C/P + strike*1000 (8 digits). Root may contain digits for adjusted contracts.
function parseOcc(sym) {
  const m = /^([A-Z0-9.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(String(sym || '').replace(/\s+/g, ''));
  if (!m) return null;
  return { root: m[1], expiry: `20${m[2]}-${m[3]}-${m[4]}`, type: m[5] === 'C' ? 'call' : 'put', strike: Number(m[6]) / 1000 };
}
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function normalizeSnapshot(occ, s, meta, provider) {
  const p = parseOcc(occ); if (!p) return null;
  const q = s?.latestQuote || {}, t = s?.latestTrade || {};
  const bid = num(q.bp), ask = num(q.ap);
  const g = s?.greeks && typeof s.greeks === 'object' ? { delta: num(s.greeks.delta), gamma: num(s.greeks.gamma), theta: num(s.greeks.theta), vega: num(s.greeks.vega), rho: num(s.greeks.rho) } : null;
  const iv = num(s?.impliedVolatility);
  return {
    symbol: occ, underlying: meta?.underlying || p.root, root: p.root, expiry: p.expiry, type: p.type, strike: p.strike,
    multiplier: meta?.multiplier ?? 100, bid, ask, bidSize: num(q.bs), askSize: num(q.as),
    mid: bid != null && ask != null && ask >= bid && ask > 0 ? (bid + ask) / 2 : null,
    iv: iv > 0 ? iv : null, greeks: g && Object.values(g).some(v => v != null) ? g : null,
    quoteTime: q.t || null, last: num(t.p), lastTime: t.t || null, openInterest: meta?.openInterest ?? null, provider,
  };
}

const assertTicker = s => { const t = String(s || '').trim().toUpperCase(); if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(t)) throw httpErr(400, 'Enter a valid US ticker, e.g. AAPL'); return t; };
const assertDate = (d, n) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) || !Number.isFinite(Date.parse(d))) throw httpErr(400, n + ' must be YYYY-MM-DD'); return d; };

async function stockSnapshots(symbols) {
  const feed = stockFeed(), out = {};
  if (!symbols.length) return out;
  const d = await get(dataUrl(), '/v2/stocks/snapshots', { symbols: symbols.join(','), feed });
  for (const sym of symbols) {
    const s = d[sym] || d.snapshots?.[sym]; if (!s) continue;
    const tr = s.latestTrade || {}, qu = s.latestQuote || {};
    const bid = num(qu.bp), ask = num(qu.ap), last = num(tr.p);
    const mid = bid > 0 && ask >= bid ? (bid + ask) / 2 : null;
    // Prefer the latest trade; fall back to quote midpoint; then the daily close.
    const price = last > 0 ? last : mid > 0 ? mid : num(s.dailyBar?.c) || num(s.prevDailyBar?.c);
    if (!(price > 0)) continue;
    out[sym] = { price, bid, ask, time: tr.t || qu.t || s.dailyBar?.t || null, source: 'Alpaca ' + feed.toUpperCase() + (last > 0 ? ' last trade' : mid > 0 ? ' quote mid' : ' daily close'), prevClose: num(s.prevDailyBar?.c) };
  }
  return out;
}

async function contractsMeta(underlying, near, far) {
  const map = new Map(); let token = null, pages = 0;
  do {
    const d = await get(tradingUrl(), '/v2/options/contracts', { underlying_symbols: underlying, expiration_date_gte: near, expiration_date_lte: far, status: 'active', limit: 10000, page_token: token });
    for (const c of d.option_contracts || []) map.set(c.symbol, { underlying: c.underlying_symbol, root: c.root_symbol, multiplier: num(c.multiplier) ?? num(c.size) ?? 100, style: c.style, openInterest: num(c.open_interest), tradable: c.tradable !== false });
    token = d.next_page_token || null; pages++;
  } while (token && pages < 5);
  return map;
}

// Full chain for one underlying + expiry window. Internally paginates up to `maxPages` x 1000 snapshots.
async function chain({ symbol, near, far, pageToken = null, maxPages = 6 }) {
  const underlying = assertTicker(symbol); assertDate(near, 'Near expiry'); assertDate(far, 'Far expiry');
  if (far < near) throw httpErr(400, 'Far expiry must be on or after near expiry');
  const feed = optionsFeed();
  const [metaRes, stockRes] = await Promise.allSettled([contractsMeta(underlying, near, far), stockSnapshots([underlying])]);
  const meta = metaRes.status === 'fulfilled' ? metaRes.value : null;
  const snaps = {}; let token = pageToken, pages = 0;
  do {
    const d = await get(dataUrl(), '/v1beta1/options/snapshots/' + encodeURIComponent(underlying), { feed, limit: 1000, expiration_date_gte: near, expiration_date_lte: far, page_token: token });
    Object.assign(snaps, d.snapshots || {});
    token = d.next_page_token || null; pages++;
  } while (token && pages < maxPages);
  const provider = 'Alpaca ' + feed.toUpperCase();
  let excluded = 0; const contracts = [];
  for (const [occ, s] of Object.entries(snaps)) {
    const m = meta?.get(occ);
    const c = normalizeSnapshot(occ, s, m ? { ...m, underlying } : { underlying }, provider);
    if (!c) continue;
    // Standard contracts only: root must equal the ticker and multiplier 100 (adjusted roots like AAPL1 excluded).
    if (c.root !== underlying.replace('.', '') && c.root !== underlying || (m && m.multiplier !== 100)) { excluded++; continue; }
    c.underlying = underlying;
    contracts.push(c);
  }
  contracts.sort((a, b) => a.expiry.localeCompare(b.expiry) || a.strike - b.strike || a.type.localeCompare(b.type));
  const stock = stockRes.status === 'fulfilled' ? stockRes.value[underlying] || null : null;
  return {
    provider: 'alpaca', feed, stockFeed: stockFeed(), label: provider + (feed === 'indicative' ? ' (indicative: modified quotes, delayed trades)' : ' (real-time OPRA)'),
    delayed: feed !== 'opra', contracts, stock, stockError: stockRes.status === 'rejected' ? stockRes.reason.message : null,
    metaError: metaRes.status === 'rejected' ? metaRes.reason.message : null, excludedNonStandard: excluded,
    partial: !!token, nextPageToken: token, fetchedAt: new Date().toISOString(),
  };
}

async function legs(occList) {
  const list = [...new Set((occList || []).map(s => String(s).replace(/\s+/g, '').toUpperCase()))];
  if (!list.length || list.length > 100 || list.some(s => !parseOcc(s))) throw httpErr(400, 'Provide 1–100 valid OCC option symbols');
  const feed = optionsFeed();
  const d = await get(dataUrl(), '/v1beta1/options/snapshots', { symbols: list.join(','), feed });
  const contracts = Object.entries(d.snapshots || {}).map(([occ, s]) => normalizeSnapshot(occ, s, null, 'Alpaca ' + feed.toUpperCase())).filter(Boolean);
  const unders = [...new Set(contracts.map(c => c.root).concat(list.map(s => parseOcc(s).root)))].filter(r => /^[A-Z][A-Z.]{0,9}$/.test(r));
  let stocks = {}; try { stocks = await stockSnapshots(unders); } catch {}
  return { provider: 'alpaca', feed, contracts, stocks, missing: list.filter(s => !contracts.some(c => c.symbol === s)), fetchedAt: new Date().toISOString() };
}

let assetCache = null;
async function optionableAssets() {
  if (assetCache && Date.now() - assetCache.at < 6 * 3600e3) return assetCache.data;
  const d = await get(tradingUrl(), '/v2/assets', { status: 'active', asset_class: 'us_equity', attributes: 'options_enabled' });
  const assets = (Array.isArray(d) ? d : []).filter(a => a.tradable !== false).map(a => ({ symbol: a.symbol, name: a.name, exchange: a.exchange, optionable: true })).sort((a, b) => a.symbol.localeCompare(b.symbol));
  const data = { source: 'Alpaca options-enabled US equities', assets };
  assetCache = { at: Date.now(), data };
  return data;
}

async function expiries(symbol) {
  const underlying = assertTicker(symbol), map = new Map(); let token = null, pages = 0;
  const today = new Date().toISOString().slice(0, 10);
  do {
    const d = await get(tradingUrl(), '/v2/options/contracts', { underlying_symbols: underlying, expiration_date_gte: today, status: 'active', limit: 10000, page_token: token });
    for (const c of d.option_contracts || []) { if (c.root_symbol && c.root_symbol !== underlying.replace('.', '')) continue; const e = map.get(c.expiration_date) || { date: c.expiration_date, contracts: 0 }; e.contracts++; map.set(c.expiration_date, e); }
    token = d.next_page_token || null; pages++;
  } while (token && pages < 5);
  let stock = null; try { stock = (await stockSnapshots([underlying]))[underlying] || null; } catch {}
  return { provider: 'alpaca', label: 'Alpaca ' + optionsFeed().toUpperCase(), stock, expiries: [...map.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

function status() {
  return { configured: configured(), optionsFeed: optionsFeed(), stockFeed: stockFeed(), tradingApi: tradingUrl().includes('paper') ? 'paper' : 'live', docs: 'https://docs.alpaca.markets/reference/optionchain' };
}

module.exports = { configured, status, chain, legs, expiries, stockSnapshots, optionableAssets, parseOcc, normalizeSnapshot, httpErr, NO_KEYS, _setFetch };
