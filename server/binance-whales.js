'use strict';
/**
 * Whale Footprints — Binance USDⓈ-M public market-data for US equity TradFi perps.
 * Prefer first-party Binance REST; never invent prints. Rate-limit friendly batching.
 */
const bn = require('./binance');
const universe = require('./binance-universe');
const store = require('./db');
const { clusterPrints, updateWallMemory } = require('./whales-cluster');
const { ForceOrderTape } = require('./whales-force-order');
const institutions = require('./whales-institutions');
const wutil = require('./whales-util');
const limiter = require('./binance-limiter');

const DATA = 'https://fapi.binance.com'; // futures/data/* lives here
const state = {
  lastAt: 0, lastError: null, symbols: [], cards: [], refreshMs: 60_000,
  printNotionalUsd: 50_000, // whale print threshold
  wallNotionalUsd: 100_000,
  busy: false,
  wallMemory: {},
};
const forceTape = ForceOrderTape({ store, symbols: [] });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function dataGet(path, params = {}) {
  const client = bn.Client({});
  // publicGet on fapi for /futures/data/* — use absolute via fetch on DATA host
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) q.set(k, String(v));
  const url = DATA + path + (q.toString() ? '?' + q : '');
  const res = await limiter.schedule(
    () => fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }),
    { priority: 'low' },
  );
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const err = new Error(`Binance data ${res.status}: ${t.slice(0, 160)}`);
    err.code = res.status;
    throw err;
  }
  return res.json();
}

async function fapiGet(path, params = {}) {
  const client = bn.Client({});
  return client.publicGet(path, params);
}

function toIST(ms) {
  return new Date(Number(ms) + 5.5 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) + ' IST';
}

/** Score −100..+100 from OI change, taker imbalance, L/S ratios, large prints. */
function biasScore({ oiChangePct, takerBuyRatio, topAccountLong, topPosLong, printBuyNotional, printSellNotional, wallBid, wallAsk }) {
  let s = 0;
  if (oiChangePct != null) s += Math.max(-25, Math.min(25, oiChangePct * 2.5)); // ±10% OI → ±25
  if (takerBuyRatio != null) s += (takerBuyRatio - 0.5) * 40; // 0..1 → −20..+20
  if (topAccountLong != null) s += (topAccountLong - 0.5) * 20;
  if (topPosLong != null) s += (topPosLong - 0.5) * 20;
  const buy = printBuyNotional || 0, sell = printSellNotional || 0;
  const tot = buy + sell;
  if (tot > 0) s += ((buy - sell) / tot) * 25;
  if (wallBid && wallAsk) {
    const w = wallBid + wallAsk;
    if (w > 0) s += ((wallBid - wallAsk) / w) * 10;
  }
  return Math.round(Math.max(-100, Math.min(100, s)));
}

function biasLabel(score) {
  if (score >= 35) return 'WHALE_LONG';
  if (score <= -35) return 'WHALE_SHORT';
  if (score >= 15) return 'LEAN_LONG';
  if (score <= -15) return 'LEAN_SHORT';
  return 'NEUTRAL';
}

async function whalePrints(symbol, { limit = 200, minNotional = state.printNotionalUsd } = {}) {
  const rows = await fapiGet('/fapi/v1/aggTrades', { symbol, limit });
  const all = [];
  const prints = [];
  let buyN = 0, sellN = 0;
  for (const r of rows || []) {
    const px = Number(r.p), qty = Number(r.q), notional = px * qty;
    const side = r.m ? 'SELL' : 'BUY'; // m=true → buyer is maker → taker sell
    const rec = { id: r.a, price: px, qty, notional: +notional.toFixed(2), side, ts: r.T, tsIst: toIST(r.T) };
    all.push(rec);
    if (!(notional >= minNotional)) continue;
    if (side === 'BUY') buyN += notional; else sellN += notional;
    prints.push(rec);
  }
  prints.sort((a, b) => b.notional - a.notional);
  const clusters = clusterPrints(all, { windowMs: 3000, minClusterNotional: minNotional }).slice(0, 12)
    .map((c) => ({ ...c, startIst: toIST(c.startTs), endIst: toIST(c.endTs) }));
  return { prints: prints.slice(0, 25), clusters, printBuyNotional: buyN, printSellNotional: sellN, scanned: (rows || []).length };
}

async function openInterestBundle(symbol) {
  const oi = await fapiGet('/fapi/v1/openInterest', { symbol });
  let hist = [];
  try {
    hist = await dataGet('/futures/data/openInterestHist', { symbol, period: '15m', limit: 12 });
  } catch (e) { /* optional */ }
  const latest = Number(oi.openInterest);
  const prev = hist.length >= 2 ? Number(hist[hist.length - 2].sumOpenInterest) : null;
  const oiChangePct = prev > 0 ? ((latest - prev) / prev) * 100 : null;
  return {
    openInterest: latest,
    openInterestUsd: hist.length ? Number(hist.at(-1).sumOpenInterestValue) : null,
    oiChangePct: oiChangePct != null ? +oiChangePct.toFixed(3) : null,
    oiHist: (hist || []).slice(-6).map((h) => ({
      t: h.timestamp, tsIst: toIST(h.timestamp),
      oi: Number(h.sumOpenInterest), oiUsd: Number(h.sumOpenInterestValue),
    })),
  };
}

async function ratioBundle(symbol) {
  const period = '15m', limit = 8;
  const out = {};
  try {
    const a = await dataGet('/futures/data/topLongShortAccountRatio', { symbol, period, limit });
    const last = a?.at?.(-1) || a?.[a.length - 1];
    if (last) out.topAccountLong = Number(last.longAccount), out.topAccountShort = Number(last.shortAccount), out.topAccountRatio = Number(last.longShortRatio), out.topAccountTs = last.timestamp;
  } catch {}
  try {
    const a = await dataGet('/futures/data/topLongShortPositionRatio', { symbol, period, limit });
    const last = a?.at?.(-1) || a?.[a.length - 1];
    if (last) out.topPosLong = Number(last.longAccount), out.topPosShort = Number(last.shortAccount), out.topPosRatio = Number(last.longShortRatio), out.topPosTs = last.timestamp;
  } catch {}
  try {
    const a = await dataGet('/futures/data/globalLongShortAccountRatio', { symbol, period, limit });
    const last = a?.at?.(-1) || a?.[a.length - 1];
    if (last) out.globalLong = Number(last.longAccount), out.globalShort = Number(last.shortAccount), out.globalRatio = Number(last.longShortRatio), out.globalTs = last.timestamp;
  } catch {}
  try {
    const a = await dataGet('/futures/data/takerlongshortRatio', { symbol, period, limit });
    const last = a?.at?.(-1) || a?.[a.length - 1];
    if (last) {
      out.takerBuyVol = Number(last.buyVol); out.takerSellVol = Number(last.sellVol);
      out.takerBuyRatio = Number(last.buySellRatio) / (1 + Number(last.buySellRatio)); // approx if ratio = buy/sell
      // Binance takerlongshortRatio: buySellRatio = buyVol/sellVol
      const r = Number(last.buySellRatio);
      if (r > 0) out.takerBuyRatio = r / (1 + r);
      out.takerTs = last.timestamp;
    }
  } catch {}
  return out;
}

async function bookWalls(symbol, { minNotional = state.wallNotionalUsd } = {}) {
  const depth = await fapiGet('/fapi/v1/depth', { symbol, limit: 100 });
  const walls = [];
  let wallBid = 0, wallAsk = 0;
  for (const [p, q] of depth.bids || []) {
    const px = Number(p), qty = Number(q), n = px * qty;
    if (n >= minNotional) { walls.push({ side: 'BID', price: px, qty, notional: +n.toFixed(2) }); wallBid += n; }
  }
  for (const [p, q] of depth.asks || []) {
    const px = Number(p), qty = Number(q), n = px * qty;
    if (n >= minNotional) { walls.push({ side: 'ASK', price: px, qty, notional: +n.toFixed(2) }); wallAsk += n; }
  }
  walls.sort((a, b) => b.notional - a.notional);
  const persisted = updateWallMemory(state.wallMemory, symbol, walls, Date.now(), { needSeen: 2, maxAgeMs: 30 * 60e3 });
  state.wallMemory = persisted.memory;
  return { walls: walls.slice(0, 12), persistentWalls: persisted.walls.slice(0, 12), wallBid, wallAsk };
}

/** Liquidations: REST has no full history; use recent allMarket force orders via premium index workaround — document WS. */
async function recentLiquidations(symbol) {
  const rows = forceTape.recent({ symbol, limit: 20 });
  const snap = forceTape.snapshot();
  return {
    liquidations: rows,
    transport: snap.transport,
    note: rows.length
      ? 'Binance public WS !forceOrder@arr (persisted 48h). Largest force-order per symbol per second; not a complete history.'
      : snap.note,
  };
}

async function cardFor(symbol) {
  const [prints, oi, ratios, book, liq] = await Promise.all([
    whalePrints(symbol).catch((e) => ({ error: e.message, prints: [], printBuyNotional: 0, printSellNotional: 0 })),
    openInterestBundle(symbol).catch((e) => ({ error: e.message })),
    ratioBundle(symbol).catch((e) => ({ error: e.message })),
    bookWalls(symbol).catch((e) => ({ error: e.message, walls: [], wallBid: 0, wallAsk: 0 })),
    recentLiquidations(symbol),
  ]);
  const score = biasScore({
    oiChangePct: oi.oiChangePct,
    takerBuyRatio: ratios.takerBuyRatio,
    topAccountLong: ratios.topAccountLong,
    topPosLong: ratios.topPosLong,
    printBuyNotional: prints.printBuyNotional,
    printSellNotional: prints.printSellNotional,
    wallBid: book.wallBid,
    wallAsk: book.wallAsk,
  });
  return {
    symbol,
    score,
    bias: biasLabel(score),
    updatedAt: Date.now(),
    updatedAtIst: toIST(Date.now()),
    prints, oi, ratios, book, liq,
  };
}

async function refresh(opts = {}) {
  if (state.busy) return { busy: true, cards: state.cards };
  state.busy = true;
  try {
    const client = bn.Client({});
    let symbols = opts.symbols;
    if (!symbols || !symbols.length) {
      const cfg = require('./config').get().binance || {};
      symbols = (cfg.assets && cfg.assets.length) ? cfg.assets.slice() : [];
      if (!symbols.length) {
        const eqs = await universe.listEquityPerps(client);
        // liquidity screen lightly — use configured defaults
        const ok = [];
        for (const e of eqs.slice(0, 80)) {
          try {
            const snap = await universe.liquiditySnapshot(client, e.symbol, {});
            if (snap.ok) ok.push(e.symbol);
            await sleep(40);
          } catch {}
        }
        symbols = ok;
      }
    }
    // Cap refresh batch to avoid rate limits (rotate)
    const max = opts.limit || 24;
    const start = state.rotate || 0;
    const batch = [];
    for (let i = 0; i < Math.min(max, symbols.length); i++) batch.push(symbols[(start + i) % symbols.length]);
    state.rotate = (start + batch.length) % Math.max(1, symbols.length);
    state.symbols = symbols;

    const cards = [];
    for (const sym of batch) {
      try {
        cards.push(await cardFor(sym));
      } catch (e) {
        cards.push({ symbol: sym, error: e.message, score: 0, bias: 'NEUTRAL', updatedAt: Date.now() });
      }
      await sleep(120);
    }
    // Merge into cache by symbol
    const by = new Map(state.cards.map((c) => [c.symbol, c]));
    for (const c of cards) by.set(c.symbol, c);
    state.cards = [...by.values()].sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)));
    state.lastAt = Date.now();
    state.lastError = null;
    return { ok: true, cards: state.cards, batch: batch.length, universe: symbols.length, lastAt: state.lastAt };
  } catch (e) {
    state.lastError = e.message;
    return { ok: false, error: e.message, cards: state.cards };
  } finally {
    state.busy = false;
  }
}

function snapshot() {
  const inst = institutions.panelSnapshot();
  const fo = forceTape.snapshot();
  return {
    ok: true,
    venue: 'binance-usdsm',
    universeNote: 'US equity TradFi perps only (no commodities). Binance public REST and public !forceOrder stream, plus official lagged SEC / FINRA / Cboe panels.',
    printNotionalUsd: state.printNotionalUsd,
    wallNotionalUsd: state.wallNotionalUsd,
    lastAt: state.lastAt,
    lastAtIst: state.lastAt ? toIST(state.lastAt) : null,
    lastError: state.lastError,
    universeSize: state.symbols.length,
    cards: state.cards,
    blendedScore: false,
    autoEntries: false,
    liquidations: fo,
    panels: {
      perp: {
        title: 'Perp tape (live, Binance)',
        source: {
          name: 'Binance USDⓈ-M public REST + !forceOrder@arr',
          asOf: state.lastAt ? toIST(state.lastAt) : fo.asOf,
          lag: fo.transport === 'ws' ? 'live stream' : (state.lastAt ? wutil.lagLabel(state.lastAt) : null),
          note: 'Large prints, same-side clusters, OI / taker / top-trader ratios, and walls that persist across snapshots. No blended score.',
          status: fo.transport === 'ws' || state.cards.length ? 'ok' : 'pending',
        },
        cards: state.cards,
        liquidations: fo,
      },
      short: inst.short,
      ats: inst.ats,
      institutional: inst.institutional,
      options: inst.options,
    },
    thirdParty: inst.thirdPartyPaid,
    forceOrderNote: fo.note,
  };
}

/** Feature vector for backtest: from ratios + OI hist + recent prints summary at bar time — simplified using cached card fields. */
function signalFromCard(card, { minAbsScore = 25 } = {}) {
  if (!card || card.error) return null;
  if (Math.abs(card.score) < minAbsScore) return null;
  if (card.bias === 'WHALE_LONG' || card.bias === 'LEAN_LONG') return 'LONG';
  if (card.bias === 'WHALE_SHORT' || card.bias === 'LEAN_SHORT') return 'SHORT';
  return null;
}

function start() {
  try {
    const cfg = require('./config').get().binance || {};
    const symbols = (cfg.assets && cfg.assets.length) ? cfg.assets.slice() : [];
    forceTape.setSymbols(symbols);
    state.symbols = symbols;
  } catch {}
  forceTape.start();
  institutions.start();
  // Delay the first REST batch so the signal scanner can finish its warmup klines.
  setTimeout(() => { refresh({ limit: 12 }).catch((e) => { state.lastError = e.message; }); }, 45000);
  setInterval(() => { refresh({ limit: 12 }).catch(() => {}); }, 5 * 60e3);
}

module.exports = { start,
  state, refresh, snapshot, cardFor, biasScore, biasLabel, signalFromCard, whalePrints, openInterestBundle, ratioBundle, bookWalls,
  toIST, forceTape, institutions,
};
