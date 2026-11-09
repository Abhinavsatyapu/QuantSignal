'use strict';
// Discover Binance USDⓈ-M US-equity (TradFi) perpetuals from exchangeInfo — never invent symbols.
const bn = require('./binance');

const DEFAULT_LIQ = {
  minQuoteVolume24h: 5_000_000,  // USDT — configurable; user accepts thinner books
  maxSpreadBps: 20,              // ~20 bps; configurable via config.binance.maxSpreadBps
  // $1000 notional ≤ 10% of ±0.5% depth ⇒ minDepth ≥ $10k
  minDepthUsd: 10_000,
  minOpenInterestUsd: 0, // optional; user filter is spread/vol/depth
  maxNotionalPctOfDepth: 10,     // allow ~$1000 orders within 10% of visible ±0.5% depth
  targetOrderNotionalUsd: 1000,
};

async function listEquityPerps(client, opts = {}) {
  const c = client || bn.Client({});
  const includePremarket = !!opts.includePremarket;
  const info = await c.exchangeInfo();
  const EXCLUDE_UT = new Set(['KR_EQUITY', 'HK_EQUITY', 'CN_EQUITY', 'PREMARKET', 'COMMODITY', 'FX', 'INDEX', 'COIN']);
  // Non-US country / regional ETF perps that share EQUITY+TradFi tagging
  const EXCLUDE_SYM = /^(EWJ|EWY|KORU|SKHYNIX|SAMSUNG|HK)/;
  const out = [];
  const seenAt = Date.now();
  for (const s of info.symbols || []) {
    if (s.status !== 'TRADING') continue;
    if (s.contractType !== 'TRADIFI_PERPETUAL') continue;
    const ut = s.underlyingType || '';
    if (ut === 'PREMARKET' && !includePremarket) continue; // OPENAI etc. — pre-IPO / premarket
    if (EXCLUDE_UT.has(ut) && ut !== 'EQUITY') continue;
    if (ut !== 'EQUITY') continue; // US stocks/ETFs only
    if (EXCLUDE_SYM.test(s.symbol)) continue;
    out.push({
      symbol: s.symbol, base: s.baseAsset, status: s.status, contractType: s.contractType,
      underlyingType: s.underlyingType, underlyingSubType: s.underlyingSubType || [],
      onboardDate: s.onboardDate,
      filters: bn.filtersOf(info, s.symbol),
      listedAt: seenAt,
    });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** Cached equity-perp list; refresh periodically (default 6h). */
let _eqCache = { at: 0, list: null };
async function listEquityPerpsCached(client, opts = {}) {
  const ttlMs = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : 6 * 3600e3;
  if (_eqCache.list && Date.now() - _eqCache.at < ttlMs && !opts.force) return _eqCache.list;
  const list = await listEquityPerps(client, opts);
  _eqCache = { at: Date.now(), list };
  return list;
}

async function liquiditySnapshot(client, symbol, opts = {}) {
  const c = client || bn.Client({});
  const thr = { ...DEFAULT_LIQ, ...opts };
  const [t24, book, oi, mark] = await Promise.all([
    c.publicGet('/fapi/v1/ticker/24hr', { symbol }),
    c.publicGet('/fapi/v1/depth', { symbol, limit: 20 }),
    c.publicGet('/fapi/v1/openInterest', { symbol }).catch(() => null),
    c.markPrice(symbol),
  ]);
  const mid = Number(mark.markPrice) || Number(t24.lastPrice);
  const bid = Number(book.bids?.[0]?.[0] || 0), ask = Number(book.asks?.[0]?.[0] || 0);
  const spreadBps = bid > 0 && ask > 0 ? ((ask - bid) / mid) * 1e4 : Infinity;
  const band = mid * 0.005;
  let bidDepth = 0, askDepth = 0;
  for (const [p, q] of book.bids || []) { if (mid - Number(p) <= band) bidDepth += Number(p) * Number(q); else break; }
  for (const [p, q] of book.asks || []) { if (Number(p) - mid <= band) askDepth += Number(p) * Number(q); else break; }
  const depthUsd = Math.min(bidDepth, askDepth);
  const quoteVolume = Number(t24.quoteVolume) || 0;
  const oiQty = oi ? Number(oi.openInterest) : 0;
  const oiUsd = oiQty * mid;
  const reasons = [];
  if (quoteVolume < thr.minQuoteVolume24h) reasons.push(`24h quote vol $${Math.round(quoteVolume).toLocaleString()} < $${thr.minQuoteVolume24h.toLocaleString()}`);
  if (spreadBps > thr.maxSpreadBps) reasons.push(`spread ${spreadBps.toFixed(2)} bps > ${thr.maxSpreadBps}`);
  if (depthUsd < thr.minDepthUsd) reasons.push(`±0.5% depth $${Math.round(depthUsd).toLocaleString()} < $${thr.minDepthUsd.toLocaleString()}`);
  if (oiUsd > 0 && oiUsd < thr.minOpenInterestUsd) reasons.push(`OI $${Math.round(oiUsd).toLocaleString()} < $${thr.minOpenInterestUsd.toLocaleString()}`);
  return {
    symbol, mid, bid, ask, spreadBps, depthUsd, quoteVolume, oiUsd,
    ok: reasons.length === 0, reasons, thresholds: thr,
    maxNotional: depthUsd * (thr.maxNotionalPctOfDepth / 100),
  };
}

/** Max holding time in ms, scaled by timeframe. */
function maxHoldMs(interval, overrideHours) {
  if (overrideHours > 0) return overrideHours * 3600e3;
  const map = { '3m': 6, '5m': 8, '10m': 12, '15m': 18, '30m': 36, '1h': 72, '4h': 14 * 24, '1d': 60 * 24 };
  const hours = map[interval] || 24;
  return hours * 3600e3;
}

module.exports = { listEquityPerps, liquiditySnapshot, maxHoldMs, DEFAULT_LIQ };
