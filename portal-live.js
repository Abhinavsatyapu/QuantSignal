// Builds every keyless portal page from Yahoo, Nasdaq, Treasury.gov, and CNN.
// Alpaca and Unusual Whales are not consulted. A missing public feed is named; numbers are not filled in.
"use strict";
const keyless = require("./keyless");
const math = require("./portal-math");

const SECTORS = [["XLK", "Software & IT"], ["XLF", "Financials"], ["XLV", "Health Care"], ["XLE", "Energy"], ["XLI", "Industrials"], ["XLY", "Discretionary"], ["XLP", "Staples"], ["XLU", "Utilities"], ["XLB", "Materials"], ["XLRE", "Real Estate"], ["XLC", "Communication"]];
const NAMES = ["AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "AVGO", "JPM", "UNH", "XOM", "JNJ", "LLY", "V", "MA", "COST", "HD", "PG", "BAC", "KO", "AMD", "NFLX", "CAT", "BA"];
const OPTS = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "META", "JPM", "XOM", "XLK", "XLF", "HYG", "TLT", "GLD"];
const CHARTS = [...new Set(["SPY", "QQQ", "IWM", "DIA", "TLT", "IEF", "HYG", "GLD", "USO", "UUP", "^VIX", ...SECTORS.map(s => s[0]), ...NAMES, ...OPTS])];

const state = { at: 0, running: null, error: null, data: null, priorGex: {} };

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k]); } catch (e) { out[k] = { symbol: items[k], error: e.message }; }
    }
  }
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}
const okChart = c => c && Array.isArray(c.bars) && c.bars.length;
const okOpt = o => o && o.spot > 0 && (o.calls || o.puts);

async function refresh() {
  if (state.data && Date.now() - state.at < 5 * 60e3) return state.data;
  if (state.running) return state.running;
  state.running = (async () => {
    const [charts, opts, fear, curve, fredHy] = await Promise.all([
      pool(CHARTS, 6, s => keyless.chart(s, "2y", "1d")),
      pool(OPTS, 4, s => keyless.options(s)),
      keyless.fearGreed().catch(e => ({ error: e.message, source: "CNN Fear & Greed" })),
      keyless.treasury().catch(e => ({ error: e.message, source: "Treasury.gov" })),
      keyless.fred("BAMLH0A0HYM2"),
    ]);
    const bar = Object.fromEntries(charts.filter(okChart).map(c => [c.symbol, c.bars]));
    const price = Object.fromEntries(charts.filter(okChart).map(c => [c.symbol, c.price]));
    const chains = opts.filter(okOpt);
    const gex = chains.map(math.gexOf).filter(Boolean);
    const gexBy = Object.fromEntries(gex.map(g => [g.symbol, g]));
    const built = assemble({ bar, price, chains, gex, gexBy, fear, curve, fredHy, prior: state.priorGex, chartErrors: charts.filter(c => c && c.error), optErrors: opts.filter(o => o && o.error) });
    for (const g of gex) state.priorGex[g.symbol] = { norm: g.norm, spot: g.spot };
    state.data = built;
    state.at = Date.now();
    state.error = null;
    return built;
  })().catch(e => { state.error = e.message; throw e; }).finally(() => { state.running = null; });
  return state.running;
}

function rowPx(symbol, bar, price) {
  const bars = bar[symbol];
  if (!bars) return null;
  return { symbol, last: price[symbol] || bars.at(-1).c, d1: math.dayChange(bars), d5: math.retN(bars, 5), d20: math.retN(bars, 20), d60: math.retN(bars, 60), rvol: math.rvol(bars), vel: math.flowVelocity(bars), day: bars.at(-1).d };
}

function assemble(src) {
  const { bar, price, chains, gex, gexBy, fear, curve, fredHy, prior } = src;
  const spy = bar.SPY;
  const fundamentals = ["SPY", "QQQ", "IWM", "DIA", "TLT", "HYG", "GLD", "USO", "UUP", "^VIX"].map(s => rowPx(s, bar, price)).filter(Boolean);
  const quants = SECTORS.map(([s, name]) => {
    const px = rowPx(s, bar, price);
    const phase = math.cohortPhase(bar[s]);
    const spy20 = math.retN(spy, 20);
    return px && phase ? { ...px, name, phase: phase.phase, e50: phase.e50, e200: phase.e200, rel20: px.d20 != null && spy20 != null ? px.d20 - spy20 : null } : null;
  }).filter(Boolean).sort((a, b) => (b.rel20 ?? -99) - (a.rel20 ?? -99));
  const hyg = bar.HYG, ief = bar.IEF;
  let credit = null;
  if (hyg && ief && hyg.length > 21 && ief.length > 21) {
    const map = new Map(ief.map(b => [b.d, b.c]));
    const ratio = hyg.filter(b => map.get(b.d) > 0).map(b => ({ d: b.d, v: b.c / map.get(b.d) }));
    const last = ratio.at(-1), prev = ratio.at(-2), back = ratio.at(-21);
    credit = { ratio: last && last.v, d1: last && prev && prev.v ? (last.v / prev.v - 1) * 100 : null, d20: last && back && back.v ? (last.v / back.v - 1) * 100 : null, asOf: last && last.d, source: "Yahoo HYG/IEF" };
  }
  const blocks = [
    { id: "growth", name: "Growth", value: math.retN(spy, 60), unit: "% SPY 60 sessions", note: "Equity proxy. Real GDP is a FRED series and is not substituted." },
    { id: "inflation", name: "Inflation", value: null, unit: "", note: fredHy && fredHy.error ? "CPI is a FRED series. " + fredHy.error : "CPI was not requested as a price." },
    { id: "fed", name: "Fed path", value: curve && curve.y2 != null && curve.y10 != null ? curve.y10 - curve.y2 : null, unit: "pp 10y − 2y", note: curve && curve.source },
    { id: "yields", name: "Yields", value: curve && curve.y10, unit: "% 10-year", note: curve && !curve.error ? curve.asOf + " · " + curve.source : (curve && curve.error) },
    { id: "credit", name: "Credit", value: credit && credit.d20, unit: "% HYG/IEF 20 sessions", note: fredHy && fredHy.error ? "FRED OAS did not answer (" + fredHy.error + "). This is the HYG/IEF price ratio, not an OAS." : "FRED OAS is in the pack." },
    { id: "m2", name: "M2", value: null, unit: "", note: fredHy && fredHy.error ? "M2SL is a FRED series. " + fredHy.error : "M2 was not on the price feed." },
    { id: "dollar", name: "Dollar", value: math.retN(bar.UUP, 20), unit: "% UUP 20 sessions", note: "UUP, the dollar bull ETF, from Yahoo. Not the DXY index print." },
  ];
  const cohorts = quants.map(q => ({ symbol: q.symbol, name: q.name, phase: q.phase, last: q.last, d20: q.d20, rel20: q.rel20, rvol: q.rvol }));
  const strategies = strategyScan(cohorts, credit, fear, curve);
  const plan = cohorts.map(c => ({ ...c, mode: c.phase === "IGNITION" || c.phase === "MATURE" ? "PAPER WATCH" : "STAND ASIDE" }));
  const fleet = plan.filter(c => c.mode === "PAPER WATCH").map(c => ({ ...c, shares: 0, note: "Roster only. Share count stays 0. No order is created." }));
  const focus = fleet[0] || cohorts[0];
  const grid = focus ? { symbol: focus.symbol, last: focus.last, levels: math.paperGrid(focus.last), note: "Paper levels at ±1%, ±2%, ±3% of the last trade. Nothing is sent." } : null;
  const pnl = cohorts.map(c => ({ symbol: c.symbol, name: c.name, last: c.last, day: c.d1, mark: "1 share × the session change. Not a booked position." }));
  const stall = math.stallBook(Object.fromEntries(NAMES.filter(s => bar[s]).map(s => [s, bar[s]])), spy);
  const air = math.airpockets(chains, bar);
  const rvolRows = NAMES.map(s => {
    const px = rowPx(s, bar, price);
    const g = gexBy[s];
    return px ? { ...px, callVol: g ? g.callVol : null, putVol: g ? g.putVol : null, netVol: g ? g.netVol : null, posture: g ? g.posture : null } : null;
  }).filter(Boolean).sort((a, b) => (b.rvol ?? 0) - (a.rvol ?? 0));
  const weekly = ["SPY", "QQQ", ...SECTORS.map(s => s[0])].map(s => math.weeklyRead(s, bar[s], gexBy[s])).filter(Boolean);
  const reaction = SECTORS.map(([s, name]) => { const px = rowPx(s, bar, price); return px ? { symbol: s, name, d1: px.d1 } : null; }).filter(Boolean);
  const swing = swingPack(gex, prior, fear, credit, reaction);
  const bots = gex.filter(g => g.putWall).slice(0, 12).map(g => ({ symbol: g.symbol, spot: g.spot, put: g.putWall, call: g.callWall, note: "Paper sketch of a short put at the put wall. Not submitted." }));
  const spyG = gexBy.SPY;
  const planner = spyG ? { symbol: "SPY", spot: spyG.spot, put: spyG.putWall, payoff: math.structurePayoff(spyG.spot, spyG.putWall), note: "Payoff of a 1-share short put at the put wall versus holding the share, at expiry, intrinsic only. Not a trade." } : null;
  return {
    updatedAt: new Date().toISOString(),
    assumptions: math.ASSUMPTIONS,
    sources: {
      prices: "Yahoo chart v8",
      options: chains[0] ? chains[0].source : "Yahoo options v7",
      fear: fear && fear.source, fearError: fear && fear.error || null,
      treasury: curve && curve.source, treasuryError: curve && curve.error || null,
      fred: fredHy && (fredHy.error || fredHy.source),
      missedCharts: src.chartErrors.map(e => e.symbol + ": " + e.error),
      missedOptions: src.optErrors.map(e => e.symbol + ": " + e.error),
    },
    fundamentals, quants, blocks, fear, curve, credit, cohorts, strategies, plan, fleet, grid, pnl,
    stall, air, rvol: rvolRows, weekly, reaction, swing, bots, planner, gex,
  };
}

function strategyScan(cohorts, credit, fear, curve) {
  const ign = cohorts.filter(c => c.phase === "IGNITION");
  const mature = cohorts.filter(c => c.phase === "MATURE");
  const brk = cohorts.filter(c => c.phase === "BREAK");
  const rules = [
    { name: "Ignition cohort", on: ign.length > 0, detail: ign.length ? ign.map(c => c.symbol).join(", ") + " above the 50-day and under the 200-day, up 20 sessions." : "No sector ETF is in IGNITION." },
    { name: "Mature trend", on: mature.length > 0, detail: mature.length ? mature.map(c => c.symbol).join(", ") + " above both moving averages." : "No sector ETF is MATURE." },
    { name: "Stand aside on break", on: brk.length > 0, detail: brk.length ? brk.map(c => c.symbol).join(", ") + " under both averages and down 20 sessions." : "No sector ETF is in BREAK." },
    { name: "Credit not sliding", on: !!credit && credit.d20 != null && credit.d20 > -1, detail: credit && credit.d20 != null ? "HYG/IEF 20-session change " + credit.d20.toFixed(2) + "%." : "HYG/IEF unavailable." },
    { name: "Curve not deeply inverted", on: !!(curve && curve.y10 != null && curve.y2 != null && curve.y10 - curve.y2 > -0.5), detail: curve && curve.y10 != null && curve.y2 != null ? "10y − 2y = " + (curve.y10 - curve.y2).toFixed(2) + " pp." : (curve && curve.error) || "Treasury curve unavailable." },
    { name: "Fear washout", on: !!(fear && fear.score != null && fear.score <= 25), detail: fear && fear.score != null ? fear.rating + " " + fear.score.toFixed(1) : (fear && fear.error) || "CNN score unavailable." },
  ];
  return rules;
}

function stageOf(norm) {
  if (norm == null) return null;
  if (norm >= 0.25) return "S1";
  if (norm >= 0.08) return "S2";
  if (norm >= 0.02) return "S3";
  if (norm > -0.02) return "S4";
  if (norm > -0.25) return "S5";
  return "S6";
}
function swingPack(gex, prior, fear, credit, reaction) {
  const rows = gex.map(g => {
    const prev = prior && prior[g.symbol];
    const reclaimed = !!(prev && prev.spot < (g.flip || Infinity) && g.flip && g.spot >= g.flip);
    return { ...g, stage: stageOf(g.norm), aboveFlip: g.flip > 0 && g.spot >= g.flip && g.norm > 0, reclaimed, elevated: g.norm >= 0.30 };
  });
  const count = (pred) => rows.filter(pred).length;
  return {
    rows,
    danger: { mean: count(r => r.posture === "MEAN REVERT"), trend: count(r => r.posture === "TREND"), hold: count(r => r.posture === "NEUTRAL" || !r.posture), fresh: count(r => r.norm >= 0.15), exit: count(r => r.norm != null && Math.abs(r.norm) < 0.02) },
    campaigns: rows.filter(r => r.norm >= 0.15),
    flip: rows.filter(r => r.aboveFlip),
    stages: ["S1", "S2", "S3", "S4", "S5", "S6"].map(s => ({ stage: s, n: count(r => r.stage === s), names: rows.filter(r => r.stage === s).map(r => r.symbol) })),
    ignition: rows.filter(r => r.elevated),
    washout: { on: !!(fear && fear.score != null && fear.score <= 25), fear, note: "Washout is CNN Fear & Greed at or under 25. It is not a trade." },
    credit: { credit, reaction, fear },
  };
}

function snapshot(page) {
  if (!state.data) return { pending: true, error: state.error, page, message: state.error || "The first Yahoo pass is still running." };
  const d = state.data;
  const base = { page, updatedAt: d.updatedAt, assumptions: d.assumptions, sources: d.sources };
  const map = {
    macro: { ...base, rows: d.fundamentals },
    quants: { ...base, rows: d.quants },
    blocks: { ...base, blocks: d.blocks, fear: d.fear, curve: d.curve, credit: d.credit },
    cohorts: { ...base, rows: d.cohorts },
    strategies: { ...base, rules: d.strategies },
    plan: { ...base, rows: d.plan },
    fleet: { ...base, rows: d.fleet },
    grid: { ...base, grid: d.grid },
    config: { ...base, config: { rebalance: false, orders: false, rvolMin: 1.5, stallClosePos: 0.25, airGapPct: 2, note: "Rebalance is not implemented. This page cannot send an order." } },
    pnl: { ...base, rows: d.pnl },
    rvol: { ...base, rows: d.rvol },
    weekly: { ...base, rows: d.weekly },
    stall: { ...base, stall: d.stall },
    airpocket: { ...base, rows: d.air },
    swing: { ...base, swing: d.swing },
    bots: { ...base, rows: d.bots },
    planner: { ...base, planner: d.planner },
  };
  return map[page] || { ...base, error: "Unknown page" };
}

function start(log) {
  const tick = () => refresh().then(() => log && log("keyless portal refreshed")).catch(e => log && log("keyless portal: " + e.message));
  tick();
  setInterval(tick, 10 * 60e3).unref();
}
module.exports = { start, refresh, snapshot, _assemble: assemble };
