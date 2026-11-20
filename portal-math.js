// Rules for the keyless portal pages. Every cutoff below is ours: the reference screenshots
// do not publish the stall, cohort, or airpocket-fired formulas. They are labeled on the page.
"use strict";
const { bsGamma, postureOf } = require("./books-math");

const ASSUMPTIONS = [
  "Prices, volume, and ranges are Yahoo Finance daily bars (chart v8). The last bar is the latest session Yahoo has, including the session in progress.",
  "Option open interest, volume, bid, ask, and implied vol are the nearest listed expiry on Yahoo options v7. Gamma is Black–Scholes from that IV. It is not a vendor gamma print.",
  "A stall day closes in the bottom 25% of its high-low range, closes below the prior close, and trades at least 80% of the prior 20 sessions' average volume. The price to watch is that day's low.",
  "Grade uses SPY only. A: SPY's last close is below the prior close and below its 20-session average. B: below the prior close but above that average. C: SPY is not below its prior close. The grade does not size an order.",
  "Airpocket: nearest put or call wall is the strike inside ±15% of spot with the most open interest on that side. UNDER means the call wall is overhead. OVER means the put wall is underneath. Eligible when that gap is at least 2% of spot. FIRED when today's high (UNDER) or low (OVER) has traded through the wall, or the live gap is 0.4% or less. Otherwise STILL WATCHING. This app does not send the entry.",
  "Cohort phase uses the sector ETF. BREAK: under the 50-day and 200-day EMA and down over 20 sessions. IGNITION: above the 50-day, still under the 200-day, and up over 20 sessions. MATURE: above both and not down over 20 sessions. GESTATION: above the 200-day and down over 20 sessions. Anything else is REPAIR.",
  "RVOL is today's volume divided by the average of the previous 20 sessions. Flow is call contract volume minus put contract volume on the nearest expiry. Flow velocity is today's stock volume versus yesterday's, in percent. Neither is signed Unusual Whales flow.",
  "Credit-reaction percents are the sector ETF's last close versus the prior close. HY credit uses the HYG/IEF price ratio when FRED's option-adjusted spread does not answer.",
  "The paper grid, 4000-series sketch, structure payoff, fleet, and PnL are computed from those prices and strikes. They are not positions and they are not sent to a broker.",
  "CNN Fear & Greed is the public index score. Treasury yields are the Treasury.gov daily curve. FRED is used when its CSV answers and named when it does not.",
];

function ema(values, n) {
  if (!values.length || !(n > 0)) return [];
  const k = 2 / (n + 1);
  const out = [];
  let prev = values[0];
  for (const v of values) { prev = v * k + prev * (1 - k); out.push(prev); }
  return out;
}
function retN(bars, n) {
  if (!bars || bars.length <= n) return null;
  const a = bars.at(-1).c, b = bars.at(-1 - n).c;
  return b > 0 ? (a / b - 1) * 100 : null;
}
function rvol(bars) {
  if (!bars || bars.length < 6) return null;
  const today = bars.at(-1).v;
  const prev = bars.slice(-21, -1).map(b => b.v).filter(v => v > 0);
  if (!(today > 0) || !prev.length) return null;
  const avg = prev.reduce((s, v) => s + v, 0) / prev.length;
  return avg > 0 ? today / avg : null;
}
function flowVelocity(bars) {
  if (!bars || bars.length < 2) return null;
  const a = bars.at(-1).v, b = bars.at(-2).v;
  return b > 0 && a >= 0 ? (a / b - 1) * 100 : null;
}
function dayChange(bars) {
  if (!bars || bars.length < 2) return null;
  const a = bars.at(-1).c, b = bars.at(-2).c;
  return b > 0 ? (a / b - 1) * 100 : null;
}

function stallDays(bars) {
  const events = [];
  if (!bars) return events;
  for (let i = 21; i < bars.length - 1; i++) {
    const b = bars[i], prev = bars[i - 1], nxt = bars[i + 1];
    const range = b.h - b.l;
    if (!(range > 0) || !(b.c > 0) || !(prev.c > 0)) continue;
    const closePos = (b.c - b.l) / range;
    const vols = bars.slice(Math.max(0, i - 20), i).map(x => x.v).filter(v => v > 0);
    const avg = vols.length ? vols.reduce((s, v) => s + v, 0) / vols.length : 0;
    const volOk = !(avg > 0) || b.v >= 0.8 * avg;
    if (closePos <= 0.25 && b.c < prev.c && volOk) {
      events.push({ day: b.d, low: b.l, close: b.c, watch: b.l, broke: nxt.l < b.l, nextLow: nxt.l, nextClose: nxt.c });
    }
  }
  return events;
}
function gradeSpy(spyBars) {
  if (!spyBars || spyBars.length < 21) return { grade: null, text: "SPY history is shorter than 21 sessions." };
  const last = spyBars.at(-1), prev = spyBars.at(-2);
  const sma = spyBars.slice(-20).reduce((s, b) => s + b.c, 0) / 20;
  const belowClose = last.c < prev.c, belowSma = last.c < sma;
  const grade = belowClose && belowSma ? "A" : belowClose ? "B" : "C";
  return { grade, spy: last.c, prev: prev.c, sma20: sma, belowClose, belowSma, day: last.d };
}
function stallBook(bySymbol, spyBars) {
  const grade = gradeSpy(spyBars);
  const rows = [];
  let broke = 0, n = 0;
  for (const [symbol, bars] of Object.entries(bySymbol)) {
    if (symbol === "SPY" || !bars || bars.length < 23) continue;
    const events = stallDays(bars);
    n += events.length;
    broke += events.filter(e => e.broke).length;
    const last = events.at(-1);
    if (!last) continue;
    const live = bars.at(-1);
    const fired = live.l < last.watch || live.c < last.watch;
    rows.push({
      symbol, grade: grade.grade, stallDay: last.day, watch: last.watch, close: last.close,
      spot: live.c, low: live.l, status: fired ? "BROKE" : "WATCHING",
      dist: last.watch > 0 ? (live.c / last.watch - 1) * 100 : null,
    });
  }
  rows.sort((a, b) => (a.status === "BROKE") - (b.status === "BROKE") || a.symbol.localeCompare(b.symbol));
  const hit = n ? broke / n : null;
  return { grade, rows, sample: { n, broke, hit }, rule: "Hit rate is the share of stall days in this Yahoo window whose next session traded under the stall low. It is not the reference forward score." };
}

function maxOi(rows) {
  let best = null;
  for (const r of rows) if (r.oi > 0 && (!best || r.oi > best.oi)) best = r;
  return best;
}
function airpockets(chains, barsBySymbol) {
  const out = [];
  for (const ch of chains) {
    if (!ch || !(ch.spot > 0)) continue;
    const spot = ch.spot;
    const callW = maxOi((ch.calls || []).filter(r => r.strike >= spot && r.strike <= spot * 1.15));
    const putW = maxOi((ch.puts || []).filter(r => r.strike <= spot && r.strike >= spot * 0.85));
    const sides = [];
    if (callW) sides.push({ side: "UNDER", wall: callW.strike, oi: callW.oi, gap: (callW.strike / spot - 1) * 100 });
    if (putW) sides.push({ side: "OVER", wall: putW.strike, oi: putW.oi, gap: (1 - putW.strike / spot) * 100 });
    sides.sort((a, b) => a.gap - b.gap);
    const near = sides[0];
    if (!near || near.gap < 2 && near.gap > 0.4) continue;
    const bars = barsBySymbol && barsBySymbol[ch.symbol];
    const day = bars && bars.at(-1);
    const through = near.side === "UNDER" ? (day && day.h >= near.wall) : (day && day.l <= near.wall);
    const fired = through || near.gap <= 0.4;
    if (near.gap < 2 && !fired) continue;
    out.push({ symbol: ch.symbol, spot, side: near.side, level: near.wall, oi: near.oi, dist: near.gap, tag: fired ? "FIRED" : "STILL WATCHING", expiry: ch.expiry || null });
  }
  out.sort((a, b) => (a.tag === "FIRED") - (b.tag === "FIRED") || b.dist - a.dist);
  return out;
}

function gexOf(ch) {
  if (!ch || !(ch.spot > 0) || !ch.expiry) return null;
  const S = ch.spot, T = Math.max((ch.expiry - Date.now()) / (365 * 864e5), 1 / 365);
  let call = 0, put = 0;
  const byK = new Map();
  const add = (row, cp) => {
    if (!(row.oi > 0) || !(row.iv > 0)) return;
    const g = bsGamma(S, row.strike, T, row.iv);
    if (!(g > 0)) return;
    const dollar = g * row.oi * 100 * S * S * 0.01;
    if (cp === "C") call += dollar; else put += dollar;
    if (Math.abs(row.strike / S - 1) <= 0.25) {
      const w = byK.get(row.strike) || { c: 0, p: 0 };
      cp === "C" ? w.c += dollar : w.p += dollar;
      byK.set(row.strike, w);
    }
  };
  for (const r of ch.calls || []) add(r, "C");
  for (const r of ch.puts || []) add(r, "P");
  const gross = call + put;
  if (!(gross > 0)) return null;
  let callWall = null, putWall = null, cw = 0, pw = 0;
  for (const [K, w] of byK) { if (w.c > cw) { cw = w.c; callWall = K; } if (w.p > pw) { pw = w.p; putWall = K; } }
  const norm = (call - put) / gross;
  let flip = null;
  if (byK.size) {
    const legs = [];
    for (const r of ch.calls || []) if (r.oi > 0 && r.iv > 0 && Math.abs(r.strike / S - 1) <= 0.12) legs.push([1, r]);
    for (const r of ch.puts || []) if (r.oi > 0 && r.iv > 0 && Math.abs(r.strike / S - 1) <= 0.12) legs.push([-1, r]);
    const netAt = x => legs.reduce((s, [sg, r]) => s + sg * bsGamma(x, r.strike, T, r.iv) * r.oi * 100 * x * x * 0.01, 0);
    let prev = null;
    for (let k = -40; k <= 40; k++) {
      const x = S * (1 + k * 0.003), v = netAt(x);
      if (prev && Math.sign(v) !== Math.sign(prev.v) && v !== prev.v) {
        const f = prev.x + (x - prev.x) * (-prev.v) / (v - prev.v);
        if (flip == null || Math.abs(f - S) < Math.abs(flip - S)) flip = f;
      }
      prev = { x, v };
    }
  }
  const callVol = (ch.calls || []).reduce((s, r) => s + (r.vol || 0), 0);
  const putVol = (ch.puts || []).reduce((s, r) => s + (r.vol || 0), 0);
  return { symbol: ch.symbol, spot: S, norm, callWall, putWall, flip, callVol, putVol, netVol: callVol - putVol, posture: postureOf(norm, S, flip, putWall, callWall), expiry: ch.expiry };
}

function cohortPhase(bars) {
  if (!bars || bars.length < 60) return null;
  const c = bars.map(b => b.c);
  const last = c.at(-1);
  const e50 = ema(c, 50).at(-1);
  const e200 = bars.length >= 200 ? ema(c, 200).at(-1) : null;
  const d20 = retN(bars, 20);
  let phase = "REPAIR";
  if (e200 != null && last < e50 && last < e200 && d20 < 0) phase = "BREAK";
  else if (e200 != null && last > e50 && last < e200 && d20 > 0) phase = "IGNITION";
  else if (e200 != null && last > e50 && last > e200 && !(d20 < 0)) phase = "MATURE";
  else if (e200 != null && last > e200 && d20 < 0) phase = "GESTATION";
  else if (e200 == null && last > e50 && d20 > 0) phase = "IGNITION";
  return { phase, last, e50, e200, d20, d5: retN(bars, 5), rvol: rvol(bars) };
}

function weeklyRead(symbol, bars, gex) {
  if (!bars || bars.length < 6) return null;
  const last = bars.at(-1), prev = bars.at(-6);
  const week = last.c > 0 && prev.c > 0 ? (last.c / prev.c - 1) * 100 : null;
  const lean = !gex ? null : gex.callVol > gex.putVol * 1.15 ? "BULLISH" : gex.putVol > gex.callVol * 1.15 ? "BEARISH" : "NEUTRAL";
  return { symbol, last: last.c, week, low: Math.min(...bars.slice(-5).map(b => b.l)), high: Math.max(...bars.slice(-5).map(b => b.h)), lean, callWall: gex && gex.callWall, putWall: gex && gex.putWall, norm: gex && gex.norm };
}

function paperGrid(last) {
  if (!(last > 0)) return [];
  return [-3, -2, -1, 1, 2, 3].map(p => ({ pct: p, level: last * (1 + p / 100) }));
}
function structurePayoff(spot, putStrike) {
  if (!(spot > 0) || !(putStrike > 0)) return null;
  const points = [];
  for (let p = -20; p <= 10; p += 2) {
    const s = spot * (1 + p / 100);
    const naked = s - spot;
    const shortPut = Math.min(0, s - putStrike);
    points.push({ pct: p, spot: s, naked, shortPut });
  }
  return points;
}

module.exports = {
  ASSUMPTIONS, ema, retN, rvol, flowVelocity, dayChange, stallDays, gradeSpy, stallBook, airpockets, gexOf, cohortPhase, weeklyRead, paperGrid, structurePayoff,
};
