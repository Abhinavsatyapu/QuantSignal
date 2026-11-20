// Runs the 0DTE CAPPED paper book off the same option chains as ticker levels.
// Persists reads and paper trades. Never calls a broker.
"use strict";
const cap = require("./dte-cap");
const store = require("./store");

const YAHOO = process.env.YAHOO_BASE || "https://query1.finance.yahoo.com/v8/finance/chart/";
const mem = { engineSince: null, lastCycle: null, days: {}, snaps: {}, bars: {} };
let ready = null, booted = false;
const pending = [];

function nyNow(now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now)).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, mins: +p.hour * 60 + +p.minute };
}
function etMins(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return +p.hour * 60 + +p.minute;
}
async function get(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (QuantSignal Zone Monitor)", Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

function snapStrikes(chain) {
  const map = new Map();
  for (const leg of chain.legs || []) {
    if (!leg.expIso || leg.expIso !== chain.today || !(leg.K > 0)) continue;
    const row = map.get(leg.K) || { K: leg.K, callVol: 0, putVol: 0, callLast: null, putLast: null, callBought: null, callSold: null, putBought: null, putSold: null };
    if (leg.cp === "C") {
      row.callVol += leg.vol || 0;
      if (leg.mid > 0) row.callLast = leg.mid;
      if (leg.bought != null) row.callBought = (row.callBought || 0) + leg.bought;
      if (leg.sold != null) row.callSold = (row.callSold || 0) + leg.sold;
    } else if (leg.cp === "P") {
      row.putVol += leg.vol || 0;
      if (leg.mid > 0) row.putLast = leg.mid;
      if (leg.bought != null) row.putBought = (row.putBought || 0) + leg.bought;
      if (leg.sold != null) row.putSold = (row.putSold || 0) + leg.sold;
    }
    map.set(leg.K, row);
  }
  return [...map.values()];
}

function observe(chain, clock) {
  if (!booted) { pending.push([chain, clock]); return; }
  observeNow(chain, clock);
}
function observeNow(chain, clock) {
  if (!chain || !(chain.spot > 0) || !chain.today) return;
  const strikes = snapStrikes(chain);
  if (!strikes.length) return;
  const day = chain.today;
  mem.snaps[day] = mem.snaps[day] || {};
  const point = { mins: clock.mins, spot: chain.spot, strikes };
  const cur = mem.snaps[day][chain.symbol];
  if (!cur) { mem.snaps[day][chain.symbol] = { first: point, last: point }; return; }
  // Baseline is the first poll at or after 09:30. Earlier polls are replaced until then.
  if (point.mins >= 9 * 60 + 30 && (cur.first.mins < 9 * 60 + 30 || point.mins < cur.first.mins)) cur.first = point;
  if (point.mins >= cur.last.mins) cur.last = point;
}

function diffStrike(first, last) {
  const a = new Map((first.strikes || []).map(s => [s.K, s]));
  const signedUw = (last.strikes || []).some(s => s.callBought != null || s.putBought != null);
  if (signedUw) return { strikes: last.strikes, sideSource: "unusualwhales" };
  if (!(first.mins >= 9 * 60 + 30) || !(last.mins >= 10 * 60 + 30) || first.mins === last.mins) return { strikes: last.strikes, sideSource: "none" };
  let moved = 0;
  const strikes = (last.strikes || []).map(s => {
    const p = a.get(s.K) || { callVol: 0, putVol: 0, callLast: null, putLast: null };
    const callDv = Math.max(0, (s.callVol || 0) - (p.callVol || 0));
    const putDv = Math.max(0, (s.putVol || 0) - (p.putVol || 0));
    const callDir = s.callLast != null && p.callLast != null ? Math.sign(s.callLast - p.callLast) : 0;
    const putDir = s.putLast != null && p.putLast != null ? Math.sign(s.putLast - p.putLast) : 0;
    if (callDir || putDir) moved++;
    // Price up over the window → the added volume is treated as bought. Price down → sold.
    return {
      K: s.K, callVol: callDv, putVol: putDv,
      callBought: callDir > 0 ? callDv : 0, callSold: callDir < 0 ? callDv : 0,
      putBought: putDir > 0 ? putDv : 0, putSold: putDir < 0 ? putDv : 0,
    };
  });
  return { strikes, sideSource: moved ? "poll-delta" : "none" };
}

function buildRead(day) {
  const snaps = mem.snaps[day] || {};
  const names = [];
  for (const [symbol, s] of Object.entries(snaps)) {
    if (!s.last) continue;
    const diff = diffStrike(s.first, s.last);
    const row = cap.classifyName(symbol, s.last.spot, diff.strikes, diff.sideSource);
    if (row && (row.volume > 0 || row.state !== "NO SIDE")) names.push(row);
  }
  names.sort((a, b) => (b.volume || 0) - (a.volume || 0) || a.symbol.localeCompare(b.symbol));
  return { at: new Date().toISOString(), names };
}

async function minuteBars(symbol) {
  const j = await get(YAHOO + encodeURIComponent(symbol) + "?range=1d&interval=1m&includePrePost=false");
  const r = j.chart.result[0], q = r.indicators.quote[0];
  return r.timestamp.map((t, i) => ({ mins: etMins(t * 1000), open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] })).filter(b => b.close > 0 && b.mins >= 9 * 60 + 30);
}

async function barsFor(day, symbol) {
  mem.bars[day] = mem.bars[day] || {};
  if (mem.bars[day][symbol]) return mem.bars[day][symbol];
  try { const bars = await minuteBars(symbol); mem.bars[day][symbol] = bars; return bars; }
  catch (e) { mem.bars[day][symbol] = { error: e.message }; return mem.bars[day][symbol]; }
}

async function manage(dayKey, day, clock) {
  const capped = (day.read.names || []).filter(n => n.state === "CAPPED" && n.lidStrike > n.spot1030);
  const existing = new Map((day.trades || []).map(t => [t.symbol, t]));
  const drafts = [];
  for (const n of capped) {
    const held = existing.get(n.symbol);
    if (held && held.resolved) { drafts.push(held); continue; }
    const bars = await barsFor(dayKey, n.symbol);
    if (!Array.isArray(bars)) {
      drafts.push({ symbol: n.symbol, status: "WAITING", volume: n.volume, lidStrike: n.lidStrike, note: "1-minute bars unavailable (" + (bars && bars.error || "missing") + "). No fill was invented.", rank: null, entry: null, shares: null, pnl: 0, pay: null, r: null, resolved: false });
      continue;
    }
    const vwap = cap.vwapAt(bars);
    n.vwap = vwap;
    n.vsVwap = vwap == null ? null : n.spot1030 >= vwap ? "above" : "below";
    n.vwapDelta = vwap == null ? null : n.spot1030 - vwap;
    const settled = cap.settle({ symbol: n.symbol, lidStrike: n.lidStrike, volume: n.volume, vsVwap: n.vsVwap }, bars, clock.mins);
    drafts.push({ ...n, ...settled, sizeRule: settled.rule || null, riskCap: settled.shares ? "$250 / $25k" : null, stop: n.lidStrike });
  }
  day.trades = cap.rankTrades(drafts);
  if (clock.mins >= 15 * 60 + 50 && !day.rodFilled) {
    for (const n of day.read.names) {
      if (n.rod != null || n.state === "NO SIDE") continue;
      const bars = await barsFor(dayKey, n.symbol);
      if (!Array.isArray(bars)) continue;
      const closeBar = bars.filter(b => b.mins <= 15 * 60 + 50).at(-1);
      if (!closeBar || !(n.spot1030 > 0)) continue;
      n.rod = (closeBar.close / n.spot1030 - 1) * 100;
      n.result = n.state === "CAPPED" ? (day.trades.find(t => t.symbol === n.symbol) || {}).status || "CAPPED" : "control " + (n.rod >= 0 ? "+" : "") + n.rod.toFixed(2) + "%";
    }
    day.rodFilled = day.read.names.every(n => n.state === "NO SIDE" || n.rod != null || n.state === "CAPPED");
  }
}

async function finish(clock, log) {
  try {
    await (ready || start(log));
    while (pending.length) { const [c, k] = pending.shift(); observeNow(c, k); }
    mem.lastCycle = new Date().toISOString();
    if (!mem.engineSince) mem.engineSince = mem.lastCycle;
    if (clock.mins >= 10 * 60 + 30) {
      const day = mem.days[clock.day] || (mem.days[clock.day] = { read: null, trades: [], rodFilled: false });
      if (!day.read) day.read = buildRead(clock.day);
      if (clock.mins >= 10 * 60 + 31) await manage(clock.day, day, clock);
    }
    const keep = new Set(Object.keys(mem.days).concat([clock.day]));
    for (const d of Object.keys(mem.snaps)) if (!keep.has(d) && d < clock.day) delete mem.snaps[d];
    await store.saveCache("dtecap", { engineSince: mem.engineSince, lastCycle: mem.lastCycle, days: mem.days, snaps: mem.snaps }, Date.now());
  } catch (e) { if (log) log("dte paper: " + e.message); }
}

function dayPnl(d) {
  return (d.trades || []).filter(t => t.resolved).reduce((n, t) => n + (t.pnl || 0), 0);
}
function snapshot(day) {
  const clock = nyNow();
  const key = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : clock.day;
  const card = cap.scorecard(mem.days);
  const d = mem.days[key] || { read: null, trades: [], rodFilled: false };
  const resolved = (d.trades || []).filter(t => t.resolved);
  const span = card.span || [];
  return {
    paper: true, orders: false,
    engineSince: mem.engineSince, lastCycle: mem.lastCycle, clock, day: key,
    rules: cap.RULES_TEXT,
    sideNote: "Bought−sold uses Unusual Whales when a print carries a side. Otherwise it uses the change in contract price between the first poll at or after 09:30 and the 10:30 poll: added volume counts as bought if the contract rose and sold if it fell. One poll is not enough, and that day stays NO SIDE — no paper short is opened. The reference study column is not copied.",
    scorecard: card,
    summary: {
      todayPnl: resolved.reduce((n, t) => n + (t.pnl || 0), 0),
      todayResolved: resolved.length,
      todayOpen: (d.trades || []).filter(t => t.status === "OPEN" || t.status === "WAITING").length,
      allPnl: card.allPnl,
      dayCount: card.dayCount,
      from: span[0] || null,
      to: span.at(-1) || null,
      expiring: d.read ? d.read.names.length : 0,
      capped: d.read ? d.read.names.filter(n => n.state === "CAPPED").length : 0,
      waiting: !d.read && key === clock.day && clock.mins < 10 * 60 + 30,
    },
    trades: d.trades || [],
    read: d.read ? d.read.names : [],
    byDay: Object.keys(mem.days).sort().reverse().map(k => {
      const x = mem.days[k];
      const res = (x.trades || []).filter(t => t.resolved);
      return { day: k, resolved: res.length, pnl: res.reduce((n, t) => n + (t.pnl || 0), 0), capped: x.read ? x.read.names.filter(n => n.state === "CAPPED").length : 0 };
    }),
  };
}

async function start(log) {
  if (ready) return ready;
  ready = (async () => {
  try {
    const saved = await store.loadCache();
    const d = saved.dtecap && saved.dtecap.data;
    if (d) {
      mem.engineSince = d.engineSince || null;
      mem.lastCycle = d.lastCycle || null;
      mem.days = d.days || {};
      mem.snaps = d.snaps || {};
      if (log) log("dte paper: restored " + Object.keys(mem.days).length + " days");
    }
  } catch (e) { if (log) log("dte paper store: " + e.message); }
    booted = true;
  })();
  return ready;
}

module.exports = { start, observe, finish, snapshot, _mem: mem };
