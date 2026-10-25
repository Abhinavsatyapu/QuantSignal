'use strict';
const config = require('./config');
const hl = require('./hl');
const store = require('./db');
require('../public/indicators.js'); // defines globalThis.Technicals (same code as the browser scanner)
require('../public/finance.js');    // defines globalThis.Finance (same webhook parser as Webhook Lab)
const { Technicals, Finance } = globalThis;

const state = {
  startedAt: Date.now(), lastScanAt: 0, nextScanAt: 0, scanBusy: false, lastScanError: null,
  lastAccountAt: 0, account: null, accountError: null, pausedReason: null, executing: new Set(),
};

const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const DEX = () => config.get().market.dex || 'xyz';
const qualify = t => (String(t).includes(':') ? String(t) : `${DEX()}:${t}`);

// US regular session (Mon-Fri 09:30-16:00 America/New_York). Outside it, trade[XYZ] oracles use internal pricing.
function usSession(t = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(t)).map(x => [x.type, x.value]));
  const mins = (Number(p.hour) % 24) * 60 + Number(p.minute);
  const open = !['Sat', 'Sun'].includes(p.weekday) && mins >= 570 && mins < 960;
  return { open, label: open ? 'US regular session (external oracle)' : 'US market closed: oracle on internal pricing' };
}
const dirSign = d => (d === 'LONG' ? 1 : -1);

// ---------------------------------------------------------------- account / equity
function dryRunPositions() {
  return store.all("SELECT * FROM trades WHERE status='open' AND mode='dry_run' ORDER BY id DESC");
}
async function refreshAccount(force = false) {
  if (!force && Date.now() - state.lastAccountAt < 10e3 && state.account) return state.account;
  const rt = config.runtime();
  const cfg = config.get();
  try {
    let account;
    if (!rt.dryRun) {
      const dex = DEX();
      const [s, abs, core] = await Promise.all([
        hl.accountState(rt.network, rt.accountAddress, dex),
        hl.info(rt.network, { type: 'userAbstraction', user: rt.accountAddress }).catch(() => null),
        hl.accountState(rt.network, rt.accountAddress).catch(() => null),
      ]);
      let equity = s.equity, equityBasis = `${dex} dex margin account`;
      if (['unifiedAccount', 'portfolioMargin'].includes(abs)) {
        const sp = await hl.info(rt.network, { type: 'spotClearinghouseState', user: rt.accountAddress });
        const usdc = (sp.balances || []).find(b => b.coin === 'USDC');
        equity = Number(usdc?.total || 0) + s.positions.reduce((a, p) => a + p.unrealizedPnl, 0);
        equityBasis = `${abs} (spot USDC + uPnL)`;
      }
      account = { mode: 'live', equity, withdrawable: s.withdrawable, positions: s.positions, abstraction: abs, equityBasis, dex, coreEquity: core?.equity ?? null };
    } else {
      const mids = await hl.marks(rt.network, DEX());
      const open = dryRunPositions();
      const realized = store.one("SELECT COALESCE(SUM(pnl),0) p FROM trades WHERE mode='dry_run' AND status='closed'").p;
      const positions = open.map(t => {
        const mark = mids[t.coin];
        const upnl = mark ? (mark - t.entry_px) * t.size * dirSign(t.direction) : 0;
        return { coin: t.coin, size: t.size, direction: t.direction, entryPx: t.entry_px, markPx: mark ?? null, unrealizedPnl: upnl, positionValue: mark ? mark * t.size : t.notional, leverage: t.leverage, stopPx: t.stop_px, tpPx: t.tp_px, tradeId: t.id, simulated: true };
      });
      const unreal = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
      account = { mode: 'dry_run', equity: cfg.risk.dryRunEquity + realized + unreal, withdrawable: null, positions, simulatedBase: cfg.risk.dryRunEquity };
      // If an address is configured we also show the real (read-only) testnet balance for reference.
      if (rt.accountAddress) { try { const s = await hl.accountState(rt.network, rt.accountAddress, DEX()); account.referenceAccount = { equity: s.equity, positions: s.positions.length }; } catch {} }
    }
    // daily baseline
    const day = utcDay();
    let row = store.one('SELECT * FROM equity_days WHERE day=?', day);
    if (!row || row.mode !== account.mode || (!(row.start_equity > 0) && account.equity > 0)) { store.db.prepare('INSERT OR REPLACE INTO equity_days(day,start_equity,mode) VALUES(?,?,?)').run(day, account.equity, account.mode); row = { day, start_equity: account.equity }; }
    account.dayStartEquity = row.start_equity;
    account.dayPnl = account.equity - row.start_equity;
    account.dayPnlPct = row.start_equity ? (account.dayPnl / row.start_equity) * 100 : 0;
    state.account = account; state.lastAccountAt = Date.now(); state.accountError = null;
    checkDailyLoss(account);
    return account;
  } catch (e) {
    state.accountError = e.message;
    throw e;
  }
}

function checkDailyLoss(account) {
  const cfg = config.get();
  if (cfg.trading.killSwitch) return;
  if (account.dayPnlPct <= -cfg.risk.dailyLossLimitPct) {
    config.setKillSwitch(true);
    state.pausedReason = `Daily loss limit hit (${account.dayPnlPct.toFixed(2)}% <= -${cfg.risk.dailyLossLimitPct}%). Auto-paused.`;
    store.log('warn', state.pausedReason, { equity: account.equity, dayStart: account.dayStartEquity });
  }
}

function setKill(on, reason) {
  config.setKillSwitch(on);
  state.pausedReason = on ? (reason || 'Kill switch engaged manually') : null;
  store.log('warn', on ? `KILL SWITCH ON: ${state.pausedReason}` : 'Kill switch released: trading resumed');
}

// ---------------------------------------------------------------- symbol normalisation for webhooks
const TICKER_ALIASES = { GOOG: 'GOOGL', 'BRK.B': 'BRKB', FB: 'META' };
// TradingView tickers -> stock perp names: NASDAQ:NVDA, NVDA, BATS:TSLA, NVDA.US, xyz:NVDA -> xyz:NVDA
function normalizeCoin(t) {
  let s = String(t || '').trim();
  const m = s.match(/^([a-z0-9]{1,20}):([A-Za-z0-9._]+)$/);
  if (m && m[1] === m[1].toLowerCase() && /^[a-z]/.test(m[1]) && !['nasdaq', 'nyse', 'amex', 'bats', 'arca', 'cboe'].includes(m[1])) return m[1] + ':' + m[2].toUpperCase();
  s = s.toUpperCase();
  if (s.includes(':')) s = s.split(':').pop();
  s = s.replace(/\.(US|O|N|P)$/, '').replace(/[-_/]/g, '');
  s = TICKER_ALIASES[s] || s;
  return qualify(s);
}

// ---------------------------------------------------------------- execution
async function handleSignal(sig) {
  // sig: {source, coin, direction:'LONG'|'SHORT', entry, stop, tp?, interval?, score?, closedAt?, dedupeKey, raw}
  const cfg = config.get();
  const rt = config.runtime();
  const id = store.insertSignal({ source: sig.source, coin: sig.coin, direction: sig.direction, interval: sig.interval || null, entry: sig.entry ?? null, stop: sig.stop ?? null, tp: sig.tp ?? null, score: sig.score ?? null, closed_at: sig.closedAt ?? null, dedupe_key: sig.dedupeKey || null, raw: sig.raw });
  if (!id) { return { duplicate: true, message: 'Signal already processed (dedupe key ' + sig.dedupeKey + ')' }; }
  store.log('info', `SIGNAL ${sig.source} ${sig.direction} ${sig.coin}`, { signalId: id, entry: sig.entry, stop: sig.stop, tp: sig.tp, interval: sig.interval, score: sig.score });
  const reject = (reason, status = 'rejected') => { store.setSignalStatus(id, status, reason); store.log('warn', `Signal #${id} ${sig.coin} ${sig.direction} not traded: ${reason}`); return { signalId: id, status, reason }; };

  if (cfg.trading.killSwitch) return reject('Kill switch is ON (trading paused)');
  if (!cfg.trading.autoTrade) return reject('Auto-trade disabled in settings (signal logged only)');
  if (!rt.dryRun) {
    const agent = (state.agent?.address || '').toLowerCase();
    const authorized = agent === rt.accountAddress.toLowerCase() || (state.agent?.role?.role === 'agent' && String(state.agent.role.data?.user || '').toLowerCase() === rt.accountAddress.toLowerCase());
    if (!authorized) return reject(`API wallet ${state.agent?.address} is not an approved agent of ${rt.accountAddress} on ${rt.network} (role: ${state.agent?.role?.role || 'unknown'}). Approve it at app.hyperliquid-testnet.xyz/API.`);
  }
  if (state.executing.has(sig.coin)) return reject('Another order for this asset is in flight');
  state.executing.add(sig.coin);
  try {
    const metaMap = await hl.meta(rt.network, DEX());
    const m = metaMap.get(sig.coin);
    if (!m) return reject(`${sig.coin} is not listed (or delisted) on Hyperliquid ${rt.network} ${DEX()} dex. No mainnet fallback.`);
    const account = await refreshAccount(true);
    if (cfg.trading.killSwitch) return reject('Kill switch is ON (daily loss limit)');
    const positions = account.positions;
    if (positions.some(p => p.coin === sig.coin && p.direction === sig.direction)) return reject(`Already ${sig.direction} ${sig.coin}: duplicate position blocked`);
    if (positions.some(p => p.coin === sig.coin)) return reject(`Opposite position open in ${sig.coin}; close it first (no auto-flip)`);
    if (positions.length >= cfg.risk.maxConcurrentPositions) return reject(`Max concurrent positions reached (${positions.length}/${cfg.risk.maxConcurrentPositions})`);

    // Re-base levels onto the TRADING network's live mid, preserving the signal's % stop distance.
    const mid = (await hl.marks(rt.network, DEX()))[sig.coin];
    if (!(mid > 0)) return reject(`No ${rt.network} mark price for ${sig.coin}`);
    const sign = dirSign(sig.direction);
    const ref = sig.entry > 0 ? sig.entry : mid;
    let stopPct = sig.stop > 0 ? Math.abs(ref - sig.stop) / ref : cfg.risk.defaultStopPct / 100;
    if (sig.stop > 0 && sign * (ref - sig.stop) <= 0) return reject('Stop is on the wrong side of entry');
    if (!(stopPct > 0.0005) || stopPct > 0.5) return reject(`Unreasonable stop distance ${(stopPct * 100).toFixed(2)}%`);
    let tpPct = sig.tp > 0 ? Math.abs(sig.tp - ref) / ref : stopPct * cfg.risk.takeProfitR;
    if (sig.tp > 0 && sign * (sig.tp - ref) <= 0) return reject('Take-profit is on the wrong side of entry');
    const stopPx = mid * (1 - sign * stopPct);
    const tpPx = mid * (1 + sign * tpPct);

    // Position sizing
    const equity = account.equity;
    if (!(equity > 0)) return reject('Account equity is zero/unknown');
    const riskUsd = equity * cfg.risk.riskPerTradePct / 100;
    const leverage = Math.max(1, Math.min(cfg.risk.maxLeverage, m.maxLeverage));
    const usedNotional = positions.reduce((s, p) => s + Math.abs(p.positionValue || 0), 0);
    const maxByLeverage = Math.max(0, equity * leverage - usedNotional);
    let notional = riskUsd / stopPct;
    const caps = { riskBased: notional, maxPositionUsd: cfg.risk.maxPositionUsd, leverageHeadroom: maxByLeverage };
    notional = Math.min(notional, cfg.risk.maxPositionUsd, maxByLeverage);
    if (notional < 10) return reject(`Order notional $${notional.toFixed(2)} below Hyperliquid $10 minimum (caps: ${JSON.stringify(caps)})`);
    let size;
    try { size = hl.sz(notional / mid, m.szDecimals); } catch { return reject('Size rounds to zero for this asset'); }
    if (Number(size) * mid < 10) return reject('Rounded size below $10 minimum');
    const slip = cfg.risk.slippagePct / 100;
    const isBuy = sig.direction === 'LONG';
    const limitPx = hl.px(mid * (1 + sign * slip), m.szDecimals);
    // Liquidity gate: HIP-3 books (esp. on testnet) can be empty or one-sided. Never send an IOC that cannot fill.
    const book = await hl.l2Book(rt.network, sig.coin);
    const opp = isBuy ? book.asks : book.bids;
    if (!opp.length) return reject(`No ${isBuy ? 'asks' : 'bids'} in the ${rt.network} ${sig.coin} order book (illiquid market)`);
    const dev = Math.abs(opp[0].px - mid) / mid * 100;
    if (dev > cfg.risk.maxBookDeviationPct) return reject(`Best ${isBuy ? 'ask' : 'bid'} ${opp[0].px} is ${dev.toFixed(2)}% from mark ${mid} (> ${cfg.risk.maxBookDeviationPct}%)`);
    const fillable = opp.filter(l => (isBuy ? l.px <= Number(limitPx) : l.px >= Number(limitPx))).reduce((a, l) => a + l.sz, 0);
    if (fillable < Number(size)) {
      if (fillable * mid < 10) return reject(`Only ${fillable} ${sig.coin} available within ${cfg.risk.slippagePct}% slippage (< $10)`);
      const prev = size; size = hl.sz(fillable, m.szDecimals);
      store.log('warn', `${sig.coin}: size reduced ${prev} -> ${size} to visible book depth`);
    }
    const slTrig = hl.px(stopPx, m.szDecimals), tpTrig = hl.px(tpPx, m.szDecimals);
    const slLimit = hl.px(stopPx * (1 - sign * slip * 2), m.szDecimals);  // market trigger; limit = worst acceptable
    const tpLimit = hl.px(tpPx * (1 - sign * slip * 2), m.szDecimals);
    const isCross = !m.onlyIsolated;
    const entryOrder = { a: m.index, b: isBuy, p: limitPx, s: size, r: false, t: { limit: { tif: 'Ioc' } } };
    const slOrder = { a: m.index, b: !isBuy, p: slLimit, s: size, r: true, t: { trigger: { isMarket: true, triggerPx: slTrig, tpsl: 'sl' } } };
    const tpOrder = { a: m.index, b: !isBuy, p: tpLimit, s: size, r: true, t: { trigger: { isMarket: true, triggerPx: tpTrig, tpsl: 'tp' } } };
    const plan = {
      network: rt.network, dex: DEX(), coin: sig.coin, assetIndex: m.index, marginMode: m.marginMode, session: usSession().label, direction: sig.direction, mid, size: Number(size), notional: Number(size) * mid,
      leverage, riskUsd, stopPct: stopPct * 100, tpPct: tpPct * 100, equity, caps,
      orders: [
        { kind: 'updateLeverage', asset: m.index, isCross, leverage },
        { kind: 'entry (market IOC)', ...entryOrder },
        { kind: 'stop-loss (trigger, reduce-only)', ...slOrder },
        { kind: 'take-profit (trigger, reduce-only)', ...tpOrder },
      ],
    };

    if (rt.dryRun) {
      const tradeId = store.insertTrade({ signal_id: id, coin: sig.coin, direction: sig.direction, mode: 'dry_run', network: rt.network, size: Number(size), entry_px: mid, stop_px: Number(slTrig), tp_px: Number(tpTrig), notional: Number(size) * mid, leverage, status: 'open', orders: plan.orders, response: { dryRun: true } });
      store.setSignalStatus(id, 'dry_run', `Would place ${sig.direction} ${size} ${sig.coin} @~${mid}`);
      store.log('info', `DRY-RUN ORDER (nothing sent) #${tradeId}: ${isBuy ? 'BUY' : 'SELL'} ${size} ${sig.coin} IOC limit ${limitPx} (mid ${mid}), SL ${slTrig}, TP ${tpTrig}, ${leverage}x, notional $${(Number(size) * mid).toFixed(2)}, risk $${riskUsd.toFixed(2)}`, plan);
      state.lastAccountAt = 0;
      return { signalId: id, tradeId, status: 'dry_run', plan };
    }

    // ---------------- LIVE (testnet unless explicitly confirmed mainnet) ----------------
    const ex = hl.exchange(rt.network, rt.privateKey);
    try { await ex.updateLeverage({ asset: m.index, isCross, leverage }); }
    catch (e) { store.log('warn', `updateLeverage failed for ${sig.coin}: ${e.message}`); }
    let res;
    try { res = await ex.order({ orders: [entryOrder], grouping: 'na' }); }
    catch (e) { return reject('Entry order rejected: ' + e.message, 'error'); }
    const st = res?.response?.data?.statuses?.[0] || {};
    if (!st.filled) return reject('Entry IOC not filled: ' + JSON.stringify(st), 'error');
    const filledSz = st.filled.totalSz, avgPx = Number(st.filled.avgPx);
    // Re-anchor SL/TP to the actual fill
    const fStop = hl.px(avgPx * (1 - sign * stopPct), m.szDecimals), fTp = hl.px(avgPx * (1 + sign * tpPct), m.szDecimals);
    slOrder.s = tpOrder.s = filledSz;
    slOrder.t.trigger.triggerPx = fStop; slOrder.p = hl.px(Number(fStop) * (1 - sign * slip * 2), m.szDecimals);
    tpOrder.t.trigger.triggerPx = fTp; tpOrder.p = hl.px(Number(fTp) * (1 - sign * slip * 2), m.szDecimals);
    let tpslRes, tpslErr = null;
    try {
      tpslRes = await ex.order({ orders: [slOrder, tpOrder], grouping: 'na' });
      const sts = tpslRes?.response?.data?.statuses || [];
      if (sts.some(s => s.error)) tpslErr = JSON.stringify(sts);
    } catch (e) { tpslErr = e.message; }
    const tradeId = store.insertTrade({ signal_id: id, coin: sig.coin, direction: sig.direction, mode: 'live', network: rt.network, size: Number(filledSz), entry_px: avgPx, stop_px: Number(fStop), tp_px: Number(fTp), notional: Number(filledSz) * avgPx, leverage, status: 'open', orders: plan.orders, response: { entry: res, tpsl: tpslRes || null, tpslErr } });
    if (tpslErr) {
      // Safety: never leave an unprotected position. Flatten immediately.
      store.log('error', `SL/TP placement failed for ${sig.coin} (${tpslErr}); closing position for safety`);
      try { await closePosition(sig.coin, 'protective close: SL/TP failed'); } catch (e) { store.log('error', 'Protective close FAILED: ' + e.message + ' — kill switch engaged'); setKill(true, 'Protective close failed for ' + sig.coin); }
    }
    store.setSignalStatus(id, 'executed', `Filled ${filledSz} @ ${avgPx}`);
    store.log('info', `LIVE ORDER FILLED #${tradeId} ${rt.network}: ${isBuy ? 'BUY' : 'SELL'} ${filledSz} ${sig.coin} @ ${avgPx}, SL ${fStop}, TP ${fTp}`, { entry: st, tpslErr });
    state.lastAccountAt = 0;
    return { signalId: id, tradeId, status: 'executed', fill: st.filled, stop: fStop, tp: fTp };
  } catch (e) {
    return reject('Execution error: ' + e.message, 'error');
  } finally {
    state.executing.delete(sig.coin);
  }
}

// Close a position (market IOC, reduce-only) and cancel its resting TP/SL orders.
async function closePosition(coin, reason = 'manual') {
  const rt = config.runtime();
  const cfg = config.get();
  if (rt.dryRun) {
    const open = store.all("SELECT * FROM trades WHERE status='open' AND mode='dry_run' AND coin=?", coin);
    if (!open.length) throw Error('No open dry-run position in ' + coin);
    const mid = (await hl.marks(rt.network, DEX()))[coin];
    for (const t of open) { const pnl = (mid - t.entry_px) * t.size * dirSign(t.direction); store.closeTrade(t.id, 'closed', mid, reason, pnl); store.log('info', `DRY-RUN CLOSE ${t.direction} ${t.size} ${coin} @ ${mid} (${reason}) pnl ${pnl.toFixed(2)}`); }
    state.lastAccountAt = 0;
    return { closed: open.length, px: mid, dryRun: true };
  }
  const m = (await hl.meta(rt.network, DEX())).get(coin);
  if (!m) throw Error(coin + ' not listed on ' + rt.network);
  const acct = await hl.accountState(rt.network, rt.accountAddress, DEX());
  const pos = acct.positions.find(p => p.coin === coin);
  if (!pos) throw Error('No open position in ' + coin);
  const ex = hl.exchange(rt.network, rt.privateKey);
  const mid = (await hl.marks(rt.network, DEX()))[coin];
  const isBuy = pos.direction === 'SHORT';
  const p = hl.px(mid * (1 + (isBuy ? 1 : -1) * cfg.risk.slippagePct / 100), m.szDecimals);
  const res = await ex.order({ orders: [{ a: m.index, b: isBuy, p, s: hl.sz(pos.size, m.szDecimals), r: true, t: { limit: { tif: 'Ioc' } } }], grouping: 'na' });
  try {
    const oo = (await hl.openOrders(rt.network, rt.accountAddress, DEX())).filter(o => o.coin === coin);
    if (oo.length) await ex.cancel({ cancels: oo.map(o => ({ a: m.index, o: o.oid })) });
  } catch (e) { store.log('warn', 'Cancel of remaining orders failed: ' + e.message); }
  const st = res?.response?.data?.statuses?.[0];
  const fillPx = st?.filled ? Number(st.filled.avgPx) : mid;
  for (const t of store.all("SELECT * FROM trades WHERE status='open' AND mode='live' AND coin=?", coin)) store.closeTrade(t.id, 'closed', fillPx, reason, (fillPx - t.entry_px) * t.size * dirSign(t.direction));
  store.log('info', `LIVE CLOSE ${coin} (${reason})`, st);
  state.lastAccountAt = 0;
  return { status: st };
}

// Dry-run SL/TP simulation + live reconciliation (marks trades closed when the exchange position is gone).
async function monitor() {
  const rt = config.runtime();
  try {
    if (rt.dryRun) {
      const open = dryRunPositions();
      if (!open.length) return;
      const mids = await hl.marks(rt.network, DEX());
      for (const t of open) {
        const p = mids[t.coin]; if (!p) continue;
        const s = dirSign(t.direction);
        const hitSl = s * (p - t.stop_px) <= 0, hitTp = s * (p - t.tp_px) >= 0;
        if (hitSl || hitTp) {
          const exit = hitSl ? t.stop_px : t.tp_px, pnl = (exit - t.entry_px) * t.size * s;
          store.closeTrade(t.id, 'closed', exit, hitSl ? 'stop-loss (simulated)' : 'take-profit (simulated)', pnl);
          store.log('info', `DRY-RUN ${hitSl ? 'STOP-LOSS' : 'TAKE-PROFIT'} ${t.coin} @ ${exit} pnl ${pnl.toFixed(2)}`, { tradeId: t.id });
        }
      }
    } else {
      const open = store.all("SELECT * FROM trades WHERE status='open' AND mode='live' AND network=?", rt.network);
      if (!open.length) return;
      const acct = await hl.accountState(rt.network, rt.accountAddress, DEX());
      for (const t of open) if (!acct.positions.some(p => p.coin === t.coin && p.direction === t.direction)) {
        let exitPx = null, pnl = null;
        try {
          const fills = await hl.info(rt.network, { type: 'userFillsByTime', user: rt.accountAddress, startTime: t.ts });
          const closes = fills.filter(f => f.coin === t.coin && /Close/.test(f.dir || ''));
          if (closes.length) { const last = closes.at(-1); exitPx = Number(last.px); pnl = closes.reduce((s, f) => s + Number(f.closedPnl || 0), 0); }
        } catch {}
        store.closeTrade(t.id, 'closed', exitPx, 'closed on exchange (SL/TP or manual)', pnl);
        store.log('info', `Position ${t.coin} closed on exchange`, { tradeId: t.id, exitPx, pnl });
      }
    }
    state.lastAccountAt = 0;
  } catch (e) { store.log('error', 'monitor: ' + e.message); }
}

// ---------------------------------------------------------------- scanner (server-side port of Trading Signals)
function candleSourceNetwork() {
  const c = config.get();
  return c.scanner.candleSource === 'trading' ? config.runtime().network : 'mainnet'; // mainnet = public read-only market data
}

async function scanOnce(reason = 'candle close') {
  const cfg = config.get();
  if (state.scanBusy) return { busy: true };
  state.scanBusy = true;
  const interval = cfg.scanner.interval, dur = config.INTERVALS[interval];
  const source = candleSourceNetwork();
  const results = [];
  try {
    const session = usSession();
    if (cfg.scanner.usMarketHoursOnly && !session.open) {
      state.lastScanAt = Date.now();
      store.log('info', `Scan skipped: ${session.label} (usMarketHoursOnly)`);
      return { interval, source, skipped: session.label, results };
    }
    for (const ticker of cfg.scanner.assets) {
      const coin = qualify(ticker);
      try {
        const now = Date.now();
        const candles = await hl.candles(source, coin, interval);
        const a = Technicals.analyze(candles, now, { minStopPct: cfg.scanner.minStopPct });
        const ageMin = (now - a.closedAt) / 60e3;
        const row = { coin, interval, source, session: session.label, ...a, ageMinutes: ageMin };
        store.saveScan(coin, interval, row);
        let action = 'none';
        if (a.direction !== 'WAIT') {
          if (a.score < cfg.scanner.minScore) action = `score ${a.score} < min ${cfg.scanner.minScore}`;
          else if (ageMin > cfg.scanner.maxSignalAgeMinutes) action = `candle too old (${ageMin.toFixed(1)} min)`;
          else {
            const tp = a.entry + dirSign(a.direction) * Math.abs(a.entry - a.stop) * cfg.risk.takeProfitR;
            const r = await handleSignal({ source: 'scanner', coin, direction: a.direction, entry: a.entry, stop: a.stop, tp, interval, score: a.score, closedAt: a.closedAt, dedupeKey: `scan|${coin}|${interval}|${a.closedAt}|${a.direction}`, raw: { analysis: { ...a, checks: a.checks }, candleSource: source } });
            action = r.duplicate ? 'already processed' : r.status + (r.reason ? ': ' + r.reason : '');
          }
        }
        results.push({ coin, direction: a.direction, score: a.score, entry: a.entry, stop: a.stop, closedAt: a.closedAt, action });
      } catch (e) {
        results.push({ coin, error: e.message });
        store.log('warn', `scanner ${coin}: ${e.message}`);
      }
    }
    state.lastScanAt = Date.now(); state.lastScanError = null;
    store.log('info', `Scan (${reason}) ${interval} via ${source} candles: ` + results.map(r => r.error ? `${r.coin}=ERR` : `${r.coin}=${r.direction}(${r.score}/8)`).join(' '));
    return { interval, source, results };
  } catch (e) { state.lastScanError = e.message; throw e; }
  finally {
    state.scanBusy = false;
    // next scan: 5s after the next candle close
    state.nextScanAt = Math.floor(Date.now() / dur) * dur + dur + 5000;
  }
}

async function onWebhook(body) {
  const cfg = config.get();
  if (!cfg.webhook.enabled) throw Object.assign(Error('Webhook source disabled'), { status: 403 });
  const clean = { ...body }; delete clean.secret; delete clean.token; delete clean.passphrase;
  const v = Finance.validateWebhook(clean);
  const out = [];
  for (const r of v.rows) {
    const coin = normalizeCoin(r.ticker);
    const dir = (r.direction || r.side || '').toLowerCase();
    const isExit = !dir && /exit|close|flat/i.test(String(r.status || r.action || ''));
    if (isExit) {
      if (!cfg.webhook.allowExits) { out.push({ coin, status: 'ignored', reason: 'exits disabled' }); continue; }
      try { out.push({ coin, status: 'closed', result: await closePosition(coin, 'webhook exit') }); store.log('info', `Webhook exit ${coin}`); }
      catch (e) { out.push({ coin, status: 'error', reason: e.message }); store.log('warn', `Webhook exit ${coin}: ${e.message}`); }
      continue;
    }
    if (!['long', 'short', 'buy', 'sell'].includes(dir)) { out.push({ coin, status: 'ignored', reason: 'no long/short direction' }); continue; }
    const direction = ['long', 'buy'].includes(dir) ? 'LONG' : 'SHORT';
    const crypto = require('crypto');
    const dedupeKey = 'wh|' + (r.id || r.alert_id || crypto.createHash('sha1').update(JSON.stringify(r) + (v.payload.sentAt || Math.floor(Date.now() / 60e3))).digest('hex'));
    const res = await handleSignal({ source: 'webhook', coin, direction, entry: r.entry ?? null, stop: r.stop ?? null, tp: r.target ?? null, interval: r.timeframe || r.interval || null, dedupeKey, raw: r });
    out.push({ coin, direction, ...res, plan: undefined, orders: res.plan?.orders });
  }
  return { event: v.payload.event, warnings: v.warnings, results: out };
}

// ---------------------------------------------------------------- loop
function start() {
  const rt = config.runtime();
  store.log('info', `Engine starting: network=${rt.network} mode=${rt.dryRun ? 'DRY-RUN' : 'LIVE'} url=${rt.apiUrl}`, { problems: rt.problems });
  // Read-only identity check of the API wallet (no signing, no orders).
  const agent = hl.deriveAddress(rt._key);
  state.agent = { address: agent, role: null };
  const checkRole = () => agent && hl.info(rt.network, { type: 'userRole', user: agent }).then(r => { const changed = JSON.stringify(r) !== JSON.stringify(state.agent.role); state.agent.role = r; if (changed && state.agent.checked) store.log('info', `API wallet role changed: ${JSON.stringify(r)}`); state.agent.checked = true; }).catch(() => {});
  setInterval(checkRole, 120e3);
  if (agent) hl.info(rt.network, { type: 'userRole', user: agent }).then(r => {
    state.agent.role = r; state.agent.checked = true;
    store.log('info', `API wallet ${agent} role on ${rt.network}: ${JSON.stringify(r)}`);
    if (r?.role === 'missing') store.log('warn', `API wallet is not registered on ${rt.network}. Approve it as an API wallet for your main account (app.hyperliquid-testnet.xyz/API), or if this key IS your main wallet, set HL_ACCOUNT_ADDRESS=${agent}.`);
  }).catch(e => store.log('warn', 'userRole check failed: ' + e.message));
  if (rt.keyPresent && !rt.accountAddress) store.log('warn', 'HL_TESTNET_PRIVATE_KEY present but HL_ACCOUNT_ADDRESS missing: staying in DRY-RUN. Add HL_ACCOUNT_ADDRESS to .env and run ./qs.sh restart.');
  if (config.get().trading.killSwitch) state.pausedReason = 'Kill switch was ON at startup (persisted)';
  const tick = async () => {
    const cfg = config.get();
    if (cfg.scanner.enabled && !state.scanBusy && Date.now() >= state.nextScanAt) { try { await scanOnce(state.lastScanAt ? 'candle close' : 'startup'); } catch (e) { store.log('error', 'scan: ' + e.message); } }
  };
  setInterval(tick, 2000); tick();
  setInterval(monitor, 15000);
  setInterval(() => refreshAccount().catch(() => {}), 20000);
  refreshAccount(true).catch(e => store.log('warn', 'account: ' + e.message));
}

module.exports = { usSession, qualify, state, start, scanOnce, handleSignal, onWebhook, closePosition, refreshAccount, setKill, normalizeCoin, candleSourceNetwork };
