'use strict';
// Thin Hyperliquid wrapper. Read-only /info calls use fetch; signed /exchange actions use the
// @nktkas/hyperliquid SDK (typed, maintained TypeScript SDK) with a viem local account.
const { URLS, INTERVALS } = require('./config');
const { formatPrice, formatSize } = require('@nktkas/hyperliquid/utils');

async function info(network, body, timeoutMs = 15000) {
  const url = (URLS[network] || URLS.testnet) + '/info';
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw Error(`Hyperliquid ${network} /info HTTP ${r.status}`);
  return r.json();
}

// ---- perp dexes (HIP-3). Builder-deployed assets use id 100000 + dexIndex*10000 + indexInMeta.
const dexCache = {};
async function dexIndex(network, dex) {
  if (!dex) return 0;
  const c = dexCache[network];
  let list = c && Date.now() - c.at < 30 * 60e3 ? c.list : null;
  if (!list) { list = (await info(network, { type: 'perpDexs' })).map(d => (d ? d.name : '')); dexCache[network] = { at: Date.now(), list }; }
  const i = list.indexOf(dex);
  if (i < 1) throw Error(`Perp dex "${dex}" not found on ${network}`);
  return i;
}

const metaCache = {};
async function meta(network, dex = '') {
  const key = network + '|' + dex;
  const c = metaCache[key];
  if (c && Date.now() - c.at < 5 * 60e3) return c.map;
  const [m, ctxs] = await info(network, dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' });
  const offset = dex ? 100000 + (await dexIndex(network, dex)) * 10000 : 0;
  const map = new Map();
  m.universe.forEach((u, i) => {
    if (u.isDelisted) return;
    const x = ctxs[i] || {};
    map.set(u.name, {
      name: u.name, index: offset + i, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage,
      onlyIsolated: !!u.onlyIsolated || ['noCross', 'strictIsolated'].includes(u.marginMode), marginMode: u.marginMode || 'cross',
      markPx: Number(x.markPx) || null, oraclePx: Number(x.oraclePx) || null, midPx: Number(x.midPx) || null,
      dayNtlVlm: Number(x.dayNtlVlm) || 0, openInterest: Number(x.openInterest) || 0, funding: Number(x.funding),
    });
  });
  metaCache[key] = { at: Date.now(), map };
  return map;
}
const invalidateMeta = () => { for (const k of Object.keys(metaCache)) metaCache[k].at = 0; };

// Mark prices (oracle-anchored; robust on thin HIP-3 books) for one dex.
async function marks(network, dex = '') {
  const key = network + '|' + dex;
  if (metaCache[key] && Date.now() - metaCache[key].at > 15e3) metaCache[key].at = 0;
  const m = await meta(network, dex);
  const out = {};
  for (const [k, v] of m) if (v.markPx > 0) out[k] = v.markPx;
  return out;
}

async function mids(network, dex = '') {
  const m = await info(network, dex ? { type: 'allMids', dex } : { type: 'allMids' });
  const out = {};
  for (const [k, v] of Object.entries(m)) if (Number(v) > 0) out[k] = Number(v);
  return out;
}

async function l2Book(network, coin) {
  const b = await info(network, { type: 'l2Book', coin });
  const lv = side => (b?.levels?.[side] || []).map(l => ({ px: Number(l.px), sz: Number(l.sz) }));
  return { bids: lv(0), asks: lv(1), time: b?.time };
}

async function candles(network, coin, interval, count = 320) {
  const now = Date.now(), dur = INTERVALS[interval];
  if (!dur) throw Error('Unsupported interval ' + interval);
  const data = await info(network, { type: 'candleSnapshot', req: { coin, interval, startTime: now - dur * count, endTime: now } });
  if (!Array.isArray(data)) throw Error('Invalid candle response');
  return data.map(b => ({ t: +b.t, T: +b.T, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v }));
}

async function accountState(network, user, dex = '') {
  const s = await info(network, dex ? { type: 'clearinghouseState', user, dex } : { type: 'clearinghouseState', user });
  const positions = (s.assetPositions || []).map(p => p.position).filter(p => Number(p.szi) !== 0).map(p => ({
    coin: p.coin, size: Math.abs(Number(p.szi)), direction: Number(p.szi) > 0 ? 'LONG' : 'SHORT', entryPx: Number(p.entryPx),
    unrealizedPnl: Number(p.unrealizedPnl), positionValue: Number(p.positionValue), leverage: p.leverage?.value,
    liquidationPx: p.liquidationPx == null ? null : Number(p.liquidationPx), marginUsed: Number(p.marginUsed),
  }));
  return { equity: Number(s.marginSummary?.accountValue || 0), withdrawable: Number(s.withdrawable || 0), positions, raw: s };
}

async function openOrders(network, user, dex = '') {
  return info(network, dex ? { type: 'frontendOpenOrders', user, dex } : { type: 'frontendOpenOrders', user });
}

let exchangeCache = null;
function exchange(network, privateKey) {
  if (!privateKey) throw Error('No private key: dry-run mode');
  const key = network + ':' + privateKey.slice(-6);
  if (exchangeCache && exchangeCache.key === key) return exchangeCache.client;
  const hl = require('@nktkas/hyperliquid');
  const { privateKeyToAccount } = require('viem/accounts');
  const transport = new hl.HttpTransport({ isTestnet: network !== 'mainnet', timeout: 15000 });
  const client = new hl.ExchangeClient({ transport, wallet: privateKeyToAccount(privateKey) });
  exchangeCache = { key, client, agent: privateKeyToAccount(privateKey).address };
  return client;
}
const agentAddress = () => exchangeCache?.agent || null;
function deriveAddress(pk) { try { return pk ? require('viem/accounts').privateKeyToAccount(pk).address : null; } catch { return null; } }

const px = (p, szDecimals) => formatPrice(String(Number(p).toPrecision(12)), szDecimals, 'perp');
const sz = (s, szDecimals) => formatSize(String(Number(s).toFixed(12)), szDecimals);

module.exports = { deriveAddress, info, dexIndex, meta, invalidateMeta, marks, mids, l2Book, candles, accountState, openOrders, exchange, agentAddress, px, sz };
