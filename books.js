// Live book for Ticker Levels, Ignitions and Reversals.
// Chain order: Unusual Whales when UW_API_KEY is set, otherwise Cboe delayed quotes
// (same host the Zone Monitor already uses), otherwise Nasdaq's public chain.
// Gamma on Nasdaq is Black–Scholes on the bid/ask mid — never a stand-in number.
"use strict";
const math = require("./books-math");
const store = require("./store");
const zone = require("./zone");
const dte = require("./dte-run");

const SRC = {
  cboe: process.env.CBOE_BASE || "https://cdn-api.cboe.com/api/global/delayed_quotes/options/",
  yahoo: process.env.YAHOO_BASE || "https://query1.finance.yahoo.com/v8/finance/chart/",
  uw: process.env.UW_BASE || "https://api.unusualwhales.com",
};
const UA = { "User-Agent": "Mozilla/5.0 (QuantSignal Zone Monitor)", Accept: "application/json" };
const REFRESH = Math.max(60, Number(process.env.BOOKS_REFRESH_SEC || 300)) * 1000;

function nyNow(now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now)).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, mins: +p.hour * 60 + +p.minute };
}
async function get(url, extra) {
  const r = await fetch(url, { headers: { ...UA, ...extra }, redirect: "follow", signal: AbortSignal.timeout(25000) });
  const text = await r.text();
  if (!r.ok) throw new Error("HTTP " + r.status + " from " + new URL(url).host);
  if (text.trim().startsWith("<")) throw new Error("HTML from " + new URL(url).host);
  return JSON.parse(text);
}
function midOf(bid, ask, last) {
  const b = math.parseNum(bid), a = math.parseNum(ask), l = math.parseNum(last);
  if (b > 0 && a > 0 && a >= b) return (a + b) / 2;
  if (l > 0) return l;
  return null;
}
function parseOcc(sym) {
  const m = /^([A-Z.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(String(sym || "").replace(/\s/g, ""));
  if (!m) return null;
  const iso = `20${m[2]}-${m[3]}-${m[4]}`;
  return { exp: math.closeMs(iso), expIso: iso, cp: m[5], K: +m[6] / 1000 };
}

async function cboeChain(symbol, clock) {
  const j = await get(SRC.cboe + encodeURIComponent(symbol) + ".json?_=" + Date.now());
  const d = j && j.data;
  if (!d || !Array.isArray(d.options)) throw new Error("no Cboe chain");
  const spot = Number(d.current_price || d.close || d.prev_day_close);
  if (!(spot > 0)) throw new Error("no Cboe price");
  const legs = [];
  for (const o of d.options) {
    const p = parseOcc(o.option || o.symbol);
    if (!p || !(p.K > 0) || !(p.exp > Date.now())) continue;
    const oi = Number(o.open_interest) || 0, vol = Number(o.volume) || 0;
    if (!(oi > 0) && !(vol > 0)) continue;
    if (Math.abs(p.K - spot) / spot > 0.35 && oi < 500) continue;
    legs.push({ cp: p.cp, K: p.K, exp: p.exp, expIso: p.expIso, oi, vol, mid: midOf(o.bid, o.ask, o.last_trade_price), iv: math.parseNum(o.iv), gamma: math.parseNum(o.gamma) });
  }
  if (legs.length < 4) throw new Error("Cboe chain too thin");
  return { symbol, spot, source: "Cboe delayed", today: clock.day, asOf: j.timestamp || null, legs };
}

async function nasdaqPage(symbol, asset, offset, money) {
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/option-chain?assetclass=${asset}&limit=500&offset=${offset}&money=${money}`;
  const j = await get(url);
  const data = j && j.data;
  if (!data || !data.table) return null;
  const spotMatch = /\$([0-9][0-9,.]*)/.exec(String(data.lastTrade || ""));
  const spot = spotMatch ? math.parseNum(spotMatch[1]) : null;
  const rows = (data.table.rows || []).filter(r => r && r.strike);
  return { spot, total: Number(data.totalRecord) || rows.length, rows };
}
async function nasdaqCollect(symbol, asset, money, clock) {
  const legs = [];
  let spot = null, offset = 0, pages = 0, total = Infinity;
  while (pages < 4 && offset < total) {
    const page = await nasdaqPage(symbol, asset, offset, money);
    if (!page || !page.rows.length) break;
    spot = spot || page.spot;
    total = page.total;
    for (const r of page.rows) {
      const exp = math.parseExpiry(r.expiryDate, clock.day);
      const K = math.parseNum(r.strike);
      if (!exp || !(K > 0)) continue;
      const callOi = math.parseNum(r.c_Openinterest) || 0, putOi = math.parseNum(r.p_Openinterest) || 0;
      const callVol = math.parseNum(r.c_Volume) || 0, putVol = math.parseNum(r.p_Volume) || 0;
      const callMid = midOf(r.c_Bid, r.c_Ask, r.c_Last), putMid = midOf(r.p_Bid, r.p_Ask, r.p_Last);
      if (callOi || callVol) legs.push({ cp: "C", K, exp: exp.ms, expIso: exp.iso, oi: callOi, vol: callVol, mid: callMid });
      if (putOi || putVol) legs.push({ cp: "P", K, exp: exp.ms, expIso: exp.iso, oi: putOi, vol: putVol, mid: putMid });
    }
    pages++;
    const ks = legs.map(l => l.K);
    if (spot && ks.length && Math.min(...ks) <= spot * 0.92 && Math.max(...ks) >= spot * 1.08) break;
    offset += page.rows.length;
    if (page.rows.length < 50) break;
  }
  return { spot, legs };
}
async function nasdaqChain(symbol, clock) {
  let lastErr = "no Nasdaq chain";
  for (const asset of ["stocks", "etf"]) {
    for (const money of ["at", "all"]) {
      try {
        const got = await nasdaqCollect(symbol, asset, money, clock);
        if (got.spot > 0 && got.legs.length >= 4) return { symbol, spot: got.spot, source: "Nasdaq chain · Black–Scholes gamma", today: clock.day, asOf: null, legs: got.legs };
        lastErr = asset + " " + money + " returned " + got.legs.length + " contracts";
      } catch (e) { lastErr = e.message; }
    }
  }
  throw new Error(lastErr);
}

function atmFromUwFlow(payload, spot) {
  const rows = payload && (Array.isArray(payload) ? payload : payload.data);
  if (!Array.isArray(rows) || !rows.length || !(spot > 0)) return { prem: null, recognized: false };
  const sample = rows.find(r => r && typeof r === "object") || {};
  const strikeKey = ["strike", "strike_price"].find(k => sample[k] != null);
  const callKey = ["call_premium", "call_premium_ask", "bullish_premium"].find(k => sample[k] != null);
  const putKey = ["put_premium", "bearish_premium"].find(k => sample[k] != null);
  const netKey = ["net_premium", "net_call_premium"].find(k => sample[k] != null);
  if (!strikeKey || (!netKey && !(callKey && putKey))) return { prem: null, recognized: false };
  const near = rows.filter(r => Math.abs(Number(r[strikeKey]) - spot) / spot <= 0.01);
  if (!near.length) return { prem: null, recognized: true };
  let prem = 0;
  for (const r of near) prem += callKey && putKey ? Number(r[callKey] || 0) - Number(r[putKey] || 0) : Number(r[netKey] || 0);
  return { prem: Number.isFinite(prem) ? prem : null, recognized: true };
}
function historyFromUw(payload) {
  const rows = payload && (Array.isArray(payload) ? payload : payload.data);
  if (!Array.isArray(rows)) return [];
  return rows.map(r => {
    const call = Number(r.call_gamma ?? r.call_gex), put = Number(r.put_gamma ?? r.put_gex);
    if (!Number.isFinite(call) || !Number.isFinite(put)) return null;
    const gross = Math.abs(call) + Math.abs(put);
    const net = put < 0 ? call + put : call - put;
    const day = String(r.date || "").slice(0, 10);
    return gross > 0 && day ? { day, norm: net / gross } : null;
  }).filter(Boolean).sort((a, b) => a.day < b.day ? -1 : 1);
}
async function uwGet(path) {
  return get(SRC.uw + path, { Authorization: "Bearer " + process.env.UW_API_KEY });
}
async function uwPack(symbol) {
  const [strike, daily, flow] = await Promise.all([
    uwGet(`/api/stock/${encodeURIComponent(symbol)}/greek-exposure/strike`),
    uwGet(`/api/stock/${encodeURIComponent(symbol)}/greek-exposure?timeframe=1M`).catch(() => null),
    uwGet(`/api/stock/${encodeURIComponent(symbol)}/flow-per-strike-intraday`).catch(() => null),
  ]);
  const rows = strike && (Array.isArray(strike) ? strike : strike.data);
  if (!Array.isArray(rows) || !rows.length) throw new Error("UW strike gamma empty");
  return { rows, history: historyFromUw(daily), flow };
}

async function yahooDaily(symbol) {
  const j = await get(SRC.yahoo + encodeURIComponent(symbol) + "?range=1mo&interval=1d");
  const r = j.chart.result[0], q = r.indicators.quote[0];
  const bars = r.timestamp.map((t, i) => ({ d: new Date(t * 1000).toISOString().slice(0, 10), c: q.close[i], l: q.low[i] })).filter(x => x.c > 0 && x.l > 0);
  const price = Number(r.meta && r.meta.regularMarketPrice) || (bars.at(-1) && bars.at(-1).c);
  return { bars, price };
}

let sourceChoice = null, sourceAt = 0, flowNote = null;
async function chooseSource(log) {
  if (process.env.UW_API_KEY && process.env.BOOKS_SOURCE !== "chain") {
    sourceChoice = { name: "unusualwhales", detail: "Unusual Whales greek-exposure by strike" };
    sourceAt = Date.now();
    return sourceChoice;
  }
  if (sourceChoice && Date.now() - sourceAt < 30 * 60e3) return sourceChoice;
  if (process.env.BOOKS_SOURCE !== "nasdaq") {
    try {
      const probe = await cboeChain("AAPL", nyNow());
      if (probe.legs.length > 20) {
        sourceChoice = { name: "cboe", detail: "Cboe delayed option chains (vendor gamma)" };
        sourceAt = Date.now();
        return sourceChoice;
      }
    } catch (e) { if (log) log("books Cboe probe: " + e.message); }
  }
  sourceChoice = { name: "nasdaq", detail: "Nasdaq public option chain. Cboe did not return a chain from this host, so gamma is Black–Scholes on the bid/ask mid. Set UW_API_KEY for Unusual Whales." };
  sourceAt = Date.now();
  return sourceChoice;
}

const state = {
  rows: [], memory: { sessions: {}, polls: [], tape: [], gexbr: [] },
  source: null, sourceDetail: null, progress: { done: 0, total: math.BOOK.length, running: false },
  updatedAt: null, errors: {}, at: 0, confirmed: null,
};
let running = null;

function historyFor(symbol, today) {
  return Object.keys(state.memory.sessions).filter(d => d < today).sort()
    .map(d => { const s = state.memory.sessions[d][symbol]; return s && s.norm != null ? { day: d, norm: s.norm } : null; })
    .filter(Boolean);
}
function priorSession(today) {
  const day = Object.keys(state.memory.sessions).filter(d => d < today).sort().at(-1);
  return day ? { day, book: state.memory.sessions[day] } : null;
}

async function loadOne(src, symbol, clock) {
  if (src.name === "cboe") return { chain: await cboeChain(symbol, clock), uwHistory: null, uwPrem: null };
  if (src.name === "unusualwhales") {
    const pack = await uwPack(symbol);
    const daily = await yahooDaily(symbol).catch(() => null);
    const spot = daily && daily.price;
    if (!(spot > 0)) throw new Error("no spot to scale UW gamma");
    const flow = atmFromUwFlow(pack.flow, spot);
    if (pack.flow && !flow.recognized) flowNote = "Unusual Whales flow did not include a premium field this build recognizes, so ATM $ is blank rather than guessed.";
    const legs = [];
    for (const row of pack.rows) {
      const K = Number(row.strike);
      if (!(K > 0)) continue;
      const call = Number(row.call_gex ?? row.call_gamma) || 0;
      const putRaw = Number(row.put_gex ?? row.put_gamma) || 0;
      const put = putRaw < 0 ? -putRaw : putRaw;
      // Scale dollar gamma back to a per-share gamma with oi=1 so structure() rebuilds the same dollars.
      const scale = 100 * spot * spot * 0.01;
      const exp = math.parseExpiry("Dec 31", clock.day); // strike route has no expiry, so 0DTE stays blank
      // oi carries the dollar gamma so the wall is the heaviest strike, and gamma × oi rebuilds those dollars.
      if (call > 0) legs.push({ cp: "C", K, exp: exp.ms, expIso: null, oi: call, vol: 0, gamma: 1 / scale });
      if (put > 0) legs.push({ cp: "P", K, exp: exp.ms, expIso: null, oi: put, vol: 0, gamma: 1 / scale });
    }
    const chain = { symbol, spot, source: "Unusual Whales strike gamma", today: clock.day, asOf: null, legs };
    return { chain, bars: daily && daily.bars, uwHistory: pack.history, uwPrem: flow.prem };
  }
  return { chain: await nasdaqChain(symbol, clock), uwHistory: null, uwPrem: null };
}

async function finishBook(rows, errors, clock, log) {
  const prior = priorSession(clock.day);
  const session = {};
  for (const r of rows) if (r.norm != null) session[r.symbol] = { norm: r.norm, spot: r.spot, putWall: r.putWall, callWall: r.callWall, flip: r.flip, ivAtm: r.ivAtm };
  // The cash close is the baseline. A later pass, after today's options have expired, must not replace it.
  if (clock.mins < 16 * 60 && Object.keys(session).length) {
    state.memory.sessions[clock.day] = session;
    for (const d of Object.keys(state.memory.sessions).sort().slice(0, -30)) delete state.memory.sessions[d];
  }
  const br = math.breadthsOf(rows);
  if (br.gexbr != null) state.memory.gexbr = [...state.memory.gexbr.filter(x => x.day !== clock.day), { day: clock.day, v: br.gexbr, plus: br.plus }].slice(-400);
  const prevPoll = [...state.memory.polls].reverse().find(p => p.day === clock.day);
  const events = math.tapeFromPolls(prevPoll && prevPoll.book, rows, clock);
  state.memory.tape = [...(state.memory.tape || []).filter(e => e.day === clock.day), ...events].slice(-80);
  state.memory.polls = math.trimPolls(state.memory.polls, { day: clock.day, mins: clock.mins, at: Date.now(), book: math.compactBook(rows) });
  const confirmed = math.confirmedBreaks(state.memory.polls, clock);
  if (confirmed.status === "frozen") state.memory.confirmedFreeze = { day: clock.day, confirmed };
  state.confirmed = state.memory.confirmedFreeze && state.memory.confirmedFreeze.day === clock.day ? state.memory.confirmedFreeze.confirmed : confirmed;
  state.rows = rows.slice().sort((a, b) => a.symbol.localeCompare(b.symbol));
  await dte.finish(nyNow(), log);
  state.errors = errors;
  state.updatedAt = new Date().toISOString();
  state.at = Date.now();
  state.baselineDay = prior ? prior.day : null;
  try { await store.saveCache("books", { memory: state.memory, rows: state.rows, source: state.source, sourceDetail: state.sourceDetail, updatedAt: state.updatedAt, baselineDay: state.baselineDay }, state.at); }
  catch (e) { if (log) log("books save failed: " + e.message); }
  if (log) log(`books: ${rows.length} names via ${state.source}, ${Object.keys(errors).length} skipped`);
}
function rowsFromZone(z, creditState, spyRet) {
  return (z.levels.rows || []).map(r => {
    const n = r.now; if (!n || !(n.spot > 0) || n.norm == null) return null;
    const b = r.base;
    return math.evaluateSymbol({
      symbol: r.t,
      structure: { symbol: r.t, spot: n.spot, source: z.dataSource === "alpaca" ? "Alpaca" : "Cboe", norm: n.norm, putWall: n.putWall, callWall: n.callWall, flip: n.flip, oi: null, volume: null, pct0: null, pct17: null, atmPrem: null, ivAtm: null, gex0: null, abs0: null, prem0: null, oi0: null, pinStrike: null },
      history: b && b.norm != null ? [{ norm: b.norm }] : [],
      baseline: b ? { norm: b.norm, spot: b.spot, putWall: b.putWall, callWall: b.callWall, flip: b.flip, ivAtm: null } : null,
      broke: false, sessionRet: b && b.spot > 0 ? (n.spot / b.spot - 1) * 100 : null, ret5: null, creditState, spyRet,
    });
  }).filter(Boolean);
}
async function refresh(log) {
  if (running) return running;
  running = (async () => {
    const zFirst = zone.snapshot();
    const ownScan = process.env.BOOKS_SOURCE === "nasdaq" || process.env.BOOKS_SOURCE === "chain";
    if (!ownScan && zFirst.levels && zFirst.levels.rows && zFirst.levels.rows.length) {
      const creditState = zFirst.credit ? zFirst.credit.week || zFirst.credit.state : null;
      const spyRow = zFirst.levels.rows.find(r => r.t === "SPY");
      const spyRet = spyRow && spyRow.base && spyRow.base.spot > 0 && spyRow.now ? (spyRow.now.spot / spyRow.base.spot - 1) * 100 : (zFirst.breadth ? zFirst.breadth.spy5 : null);
      const built = rowsFromZone(zFirst, creditState, spyRet);
      state.source = zFirst.dataSource === "alpaca" ? "alpaca" : "cboe";
      state.sourceDetail = "Same chain as Zone Monitor (" + (zFirst.dataSource === "alpaca" ? "Alpaca" : "Cboe") + "). Ignitions, reversals and airpockets are computed from those levels.";
      state.progress = { done: built.length, total: built.length, running: false };
      await finishBook(built, {}, nyNow(), log);
      return;
    }
    if (!ownScan && !(zFirst.levels && zFirst.levels.rows && zFirst.levels.rows.length)) {
      const gammaFailed = zFirst.errors && zFirst.errors.gamma;
      const gammaBusy = zFirst.loading && zFirst.loading.gamma;
      // Zone Monitor left off (ZONE=off) never sets a gamma error. That is not "still starting" — use the book's own chain.
      if (zFirst.scheduled && (!gammaFailed || gammaBusy)) {
        state.source = "zone"; state.sourceDetail = "Waiting for the Zone Monitor chain pass.";
        state.progress = { done: 0, total: 0, running: true };
        return;
      }
    }
    state.progress = { done: 0, total: math.BOOK.length, running: true };
    const src = await chooseSource(log);
    state.source = src.name; state.sourceDetail = src.detail;
    const clock = nyNow();
    const z = zone.snapshot();
    const creditState = z.credit ? z.credit.week || z.credit.state : null;
    const prior = priorSession(clock.day);
    const rows = [];
    const errors = {};
    let cursor = 0;
    async function worker() {
      while (cursor < math.BOOK.length) {
        const symbol = math.BOOK[cursor++];
        try {
          const loaded = await loadOne(src, symbol, clock);
          try { dte.observe(loaded.chain, nyNow()); } catch (e) { errors[symbol] = (errors[symbol] ? errors[symbol] + " · " : "") + e.message; }
          const daily = loaded.bars ? { bars: loaded.bars, price: loaded.chain.spot } : await yahooDaily(symbol).catch(() => null);
          if (daily && daily.price > 0 && !(loaded.chain.spot > 0)) loaded.chain.spot = daily.price;
          const bars = daily && daily.bars;
          const rets = math.retFrom(bars, clock.day, loaded.chain.spot, 5);
          const structure = math.structure(loaded.chain, Date.now());
          if (loaded.uwPrem != null && structure) structure.atmPrem = loaded.uwPrem;
          let history = historyFor(symbol, clock.day);
          let baseline = prior && prior.book[symbol] ? { ...prior.book[symbol] } : null;
          if (loaded.uwHistory && loaded.uwHistory.length) {
            const older = loaded.uwHistory.filter(x => x.day < clock.day);
            if (!history.length) history = older;
            if (!baseline && older.length) baseline = { norm: older.at(-1).norm, spot: null, putWall: null, callWall: null, flip: null, ivAtm: null };
          }
          const row = structure && math.evaluateSymbol({
            symbol, structure, history, baseline, broke: math.brokeD1(bars, clock.day),
            sessionRet: rets.session, ret5: rets.d5, prevClose: rets.prevClose, creditState, spyRet: null,
          });
          if (row) rows.push(row);
          else errors[symbol] = "no usable gamma or open interest";
        } catch (e) { errors[symbol] = e.message; }
        state.progress.done = rows.length + Object.keys(errors).length;
        state.rows = rows.slice().sort((a, b) => a.symbol.localeCompare(b.symbol));
        state.errors = { ...errors };
        await new Promise(r => setTimeout(r, 120));
      }
    }
    await Promise.all([worker(), worker(), worker()]);
    const spy = rows.find(r => r.symbol === "SPY");
    const spyRet = spy ? (spy.sessionRet ?? spy.vsBase) : (z.breadth ? z.breadth.spy5 : null);
    if (spyRet != null) for (const r of rows) r.credit = math.creditTag(r.group, creditState, r.vsBase ?? r.sessionRet, spyRet);
    await finishBook(rows, errors, clock, log);
  })().finally(() => { running = null; state.progress.running = false; });
  return running;
}

function trimGamma(g) {
  if (!g) return null;
  return {
    day: g.day, breadth: g.breadth, names: g.names, missing: g.missing, d1: g.d1, d7: g.d7, pctile: g.pctile,
    historyDays: g.historyDays, series: g.series, tide: g.tide,
    spy: g.spy ? { norm: g.spy.norm, spot: g.spy.spot, flip: g.spy.flip, net: g.spy.net, quoteTime: g.spy.quoteTime } : null,
    qqq: g.qqq ? { norm: g.qqq.norm, spot: g.qqq.spot, flip: g.qqq.flip } : null,
  };
}
function snapshot() {
  const z = zone.snapshot();
  const clock = nyNow();
  const creditState = z.credit ? z.credit.week || z.credit.state : null;
  const spySeed = state.rows.find(r => r.symbol === "SPY");
  const spyRet = spySeed ? (spySeed.sessionRet ?? spySeed.vsBase) : (z.breadth ? z.breadth.spy5 : null);
  const rows = state.rows.map(r => ({ ...r, credit: math.creditTag(r.group, creditState, r.vsBase ?? r.sessionRet, spyRet) }));
  const br = math.breadthsOf(rows);
  const tide = math.tideState(state.memory.gexbr);
  const spyRow = rows.find(r => r.symbol === "SPY");
  const spyNorm = (z.gamma && z.gamma.spy && Number.isFinite(z.gamma.spy.norm) ? z.gamma.spy.norm : null) ?? (spyRow && spyRow.norm);
  const spyPrev = spyRow && spyRow.base && spyRow.base.norm != null ? spyRow.base.norm : null;
  const dial = math.bullDial({
    spyAboveEma20: !!(z.breadth && z.breadth.spyAboveEma20),
    creditCalm: !!(z.credit && (z.credit.state === "CALM" || z.credit.state === "EASING")),
    spyLongGamma: spyNorm > 0,
  });
  const plus = br.plus != null ? br.plus : (state.memory.gexbr.at(-1) && state.memory.gexbr.at(-1).plus);
  return {
    updatedAt: state.updatedAt, ny: clock, source: state.source, sourceDetail: state.sourceDetail, flowNote,
    atmNote: state.source === "unusualwhales"
      ? "ATM $ is Unusual Whales near-spot premium when that payload includes a premium field. Strike gamma is the Unusual Whales strike breakdown. 0DTE is blank on that feed because the strike route has no expiry."
      : "ATM $ is near-spot call premium minus put premium, times volume, from the chain in hand. It is not Unusual Whales signed flow.",
    progress: state.progress, errors: state.errors, errorCount: Object.keys(state.errors || {}).length,
    baselineDay: Object.keys(state.memory.sessions).filter(d => d < clock.day).sort().at(-1) || null,
    assumptions: math.ASSUMPTIONS,
    breadth: br, tide, tideAdvice: math.tideAdvice(tide), gexbrSeries: (state.memory.gexbr || []).slice(-40), dial,
    ignition: math.ignitionContext(spyNorm, spyPrev),
    ogap: math.ogapGate(spyNorm, plus),
    swing: math.swingCheck(z.breadth && z.breadth.qqq, plus, spyNorm),
    confirmed: state.memory.confirmedFreeze && state.memory.confirmedFreeze.day === clock.day ? state.memory.confirmedFreeze.confirmed : math.confirmedBreaks(state.memory.polls, clock),
    tape: state.memory.tape || [],
    cohorts: math.cohortsOf(rows),
    ofi: { available: false, reason: "No order-flow imbalance feed is configured. Set UW_API_KEY for Unusual Whales. This panel does not invent a percent-of-names-bid figure." },
    stall: z.breadth ? { below: !z.breadth.spyAboveEma20, spy5: z.breadth.spy5, ema: z.breadth.spyAboveEma20, text: z.breadth.spyAboveEma20 ? "SPY is above its 20-day EMA." : "Stall shorts: SPY closed below its 20-day EMA → go easy (the capture cites about 25% wins versus 52%)." } : null,
    context: { credit: z.credit, breadth: z.breadth, econ: z.econ, gamma: trimGamma(z.gamma), dial: z.dial, ages: z.ages, errors: z.errors, loading: z.loading, updatedAt: z.updatedAt },
    rows,
    counts: {
      n: rows.length,
      ignA: rows.filter(r => r.book === "A").length,
      ignB: rows.filter(r => r.book === "B").length,
      ignThin: rows.filter(r => r.book === "THIN").length,
      exhaust: rows.filter(r => r.flow === "EXHAUSTION").length,
      revert: rows.filter(r => r.reversal && (r.reversal.kind === "REVERT" || r.reversal.kind === "REVERT-PENDING")).length,
      broke: rows.filter(r => r.broke).length,
      air: rows.filter(r => r.airpocket).length,
    },
  };
}

async function start(log) {
  zone.setChainHook((chain, clock) => dte.observe(chain, clock));
  zone.setDoneHook(() => refresh(log));
  try {
    const saved = await store.loadCache();
    const d = saved.books && saved.books.data;
    if (d) {
      state.memory = d.memory || state.memory;
      state.rows = Array.isArray(d.rows) ? d.rows : [];
      state.source = d.source || null;
      state.sourceDetail = d.sourceDetail || null;
      state.updatedAt = d.updatedAt || null;
      state.baselineDay = d.baselineDay || null;
      if (saved.books.at) state.at = Number(saved.books.at) || 0;
      if (!state.rows.length || !("airpocket" in (state.rows[0] || {}))) state.at = 0;
      if (state.source === "nasdaq" && process.env.BOOKS_SOURCE !== "nasdaq") state.at = 0;
      if (log) log(`books store: restored ${state.rows.length} rows`);
    }
  } catch (e) { if (log) log("books store unavailable: " + e.message); }
  const tick = () => { if (!state.at || Date.now() - state.at > REFRESH) refresh(log); };
  tick();
  setInterval(tick, 30000).unref();
}
function kick() { refresh(m => console.log(new Date().toISOString(), m)); }

module.exports = { start, kick, snapshot, refresh };
