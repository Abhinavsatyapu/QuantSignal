// 0DTE CAPPED rest-of-day short. Paper only.
// Rules from the reference engine page (read-only scorecard). Nothing here sends an order.
//
// At 10:30 ET, on every name with a line expiring that day:
//   floor = 0DTE puts bought−sold at strikes <= spot and within 15% of spot
//   lid   = 0DTE calls bought−sold at strikes >= spot
//   CAPPED     = calls net written above (lid < 0) and puts not net written below (floor >= 0)
//   FLOOR ONLY = puts net written below, calls not net written above
//   BOX        = both sides net written
//   NEITHER    = neither side net written
// FLOOR ONLY, BOX and NEITHER are the same-day control. They are not shorted.
// A CAPPED name is shorted at the 10:31 open, stopped at the strike with the most
// written expiring calls, and covered at 15:50. No target.
// Size = min($250 of risk / stop distance, $25k notional).
// Rank is expiring volume. The top 3 each day are scored on their own scorecard line.
// The book retires only after 100 resolved shorts, if any gated line fails.
"use strict";

const RISK = 250;
const NOTIONAL = 25000;
const BAND = 0.15;
const RETIRE_AT = 100;

const RULES_TEXT = "At 10:30 ET on every name with an expiring line: floor = 0DTE puts bought−sold at strikes at or below spot, inside a 15% band, from the 09:30 poll to 10:30. Lid = 0DTE calls bought−sold at strikes at or above spot. CAPPED = calls written above and puts not written below. Short the 10:31 open, stop at the strike with the most written expiring calls, cover at 15:50. Size = min($250 / stop distance, $25k notional). Every CAPPED name is papered. Rank is expiring volume; the top 3 are scored on their own line. FLOOR ONLY, BOX and NEITHER are the same-day control, filled after the close. Short only. No target. No live orders.";

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function classifyName(symbol, spot, strikes, sideSource) {
  const signed = sideSource === "unusualwhales" || sideSource === "poll-delta";
  let lidNet = 0, floorNet = 0, callVol = 0, putVol = 0, volume = 0;
  let best = null;
  let sided = 0;
  for (const s of strikes || []) {
    const K = num(s.K);
    if (!(K > 0)) continue;
    const cv = num(s.callVol) || 0, pv = num(s.putVol) || 0;
    volume += cv + pv;
    if (K + 1e-9 >= spot) {
      callVol += cv;
      if (signed && s.callBought != null && s.callSold != null) {
        sided++;
        const net = s.callBought - s.callSold;
        lidNet += net;
        const written = s.callSold - s.callBought;
        if (written > 0 && (!best || written > best.written || (written === best.written && K > best.K))) best = { K, written };
      }
    }
    if (K <= spot + 1e-9 && K >= spot * (1 - BAND)) {
      putVol += pv;
      if (signed && s.putBought != null && s.putSold != null) { sided++; floorNet += s.putBought - s.putSold; }
    }
  }
  const base = { symbol, spot1030: spot, volume, callVol, putVol, ctr: "C " + callVol + " / P " + putVol, sideSource: sideSource || "none" };
  if (!signed || sided === 0) {
    return { ...base, state: "NO SIDE", lidNet: null, floorNet: null, lidStrike: null, written: null, dist: null };
  }
  const callsWritten = lidNet < 0, putsWritten = floorNet < 0;
  const state = callsWritten && !putsWritten ? "CAPPED" : !callsWritten && putsWritten ? "FLOOR ONLY" : callsWritten && putsWritten ? "BOX" : "NEITHER";
  const dist = best && spot > 0 ? (best.K / spot - 1) * 100 : null;
  return { ...base, state, lidNet, floorNet, lidStrike: best ? best.K : null, written: best ? best.written : null, dist };
}

function sizeShort(entry, stop) {
  const dist = stop - entry;
  if (!(entry > 0) || !(dist > 0)) return null;
  const byRisk = RISK / dist;
  const byCap = NOTIONAL / entry;
  const shares = Math.floor(Math.min(byRisk, byCap));
  if (!(shares >= 1)) return { shares: 0, blocked: "size rounds below 1 share" };
  return { shares, risk: RISK, cap: NOTIONAL, dist, rule: "min($250 / stop distance, $25k notional)" };
}

function vwapAt(bars) {
  const win = (bars || []).filter(b => b.mins >= 9 * 60 + 30 && b.mins <= 10 * 60 + 30 && b.volume > 0 && b.close > 0);
  if (!win.length) return null;
  let pv = 0, v = 0;
  for (const b of win) { const tp = ((b.high || b.close) + (b.low || b.close) + b.close) / 3; pv += tp * b.volume; v += b.volume; }
  return v > 0 ? pv / v : null;
}

// bars are ET minute bars: {mins, open, high, low, close, volume}
function settle(entryPlan, bars, nowMins) {
  const stop = entryPlan.lidStrike;
  const ordered = (bars || []).filter(b => b.mins >= 10 * 60 + 31).sort((a, b) => a.mins - b.mins);
  const entryBar = ordered.find(b => b.open > 0);
  if (!entryBar) return { status: "WAITING", note: "no 10:31 print yet" };
  const entry = entryBar.open;
  const sized = sizeShort(entry, stop);
  if (!sized || sized.blocked) return { status: "SKIPPED", entry, note: sized ? sized.blocked : "lid is not above the 10:31 open" };
  let stopped = null;
  for (const b of ordered) {
    if (b.mins > 15 * 60 + 50) break;
    if (b.high >= stop) { stopped = b; break; }
  }
  if (stopped) {
    return finish({ ...entryPlan, ...sized, entry, status: "STOPPED", exitPx: stop, exit: "stop " + clock(stopped.mins), note: "stopped at the lid strike" });
  }
  if (nowMins < 15 * 60 + 50) {
    const mark = ordered.filter(b => b.mins <= nowMins).at(-1);
    const px = mark ? mark.close : entry;
    return finish({ ...entryPlan, ...sized, entry, status: "OPEN", exitPx: px, exit: "open", note: "marked, not resolved" });
  }
  const cover = ordered.filter(b => b.mins <= 15 * 60 + 50).at(-1) || ordered.at(-1);
  return finish({ ...entryPlan, ...sized, entry, status: "COVERED", exitPx: cover.close, exit: "15:50", note: "covered at 15:50" });
}

function finish(t) {
  const pay = t.entry > 0 && t.exitPx > 0 ? (t.entry - t.exitPx) / t.entry * 100 : null;
  const pnl = t.entry > 0 && t.exitPx > 0 && t.shares > 0 ? (t.entry - t.exitPx) * t.shares : 0;
  const riskDollars = t.shares > 0 ? t.shares * (t.lidStrike - t.entry) : RISK;
  return { ...t, pay, pnl, r: riskDollars > 0 ? pnl / riskDollars : null, resolved: t.status === "STOPPED" || t.status === "COVERED" };
}

function clock(mins) { return String(Math.floor(mins / 60)).padStart(2, "0") + ":" + String(mins % 60).padStart(2, "0"); }

function weekKey(iso) {
  const d = new Date(iso + "T12:00:00Z");
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - first) / 864e5 - 3 + (first.getUTCDay() + 6) % 7) / 7);
  return d.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
}

function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }

function lineStats(trades) {
  const done = trades.filter(t => t.resolved);
  const below = done.filter(t => t.exitPx < t.entry).length;
  const win = done.length ? below / done.length * 100 : null;
  const pay = mean(done.map(t => t.pay).filter(n => n != null));
  const stops = done.length ? done.filter(t => t.status === "STOPPED").length / done.length * 100 : null;
  return { n: done.length, win, pay, stops };
}

function scorecard(days) {
  const allTrades = [];
  const top3 = [];
  const rodCap = [], rodOther = [];
  let cappedNames = 0, names = 0, taken = 0;
  const weeks = new Map();
  for (const [day, d] of Object.entries(days || {})) {
    const list = (d.read && d.read.names) || [];
    names += list.length;
    cappedNames += list.filter(n => n.state === "CAPPED").length;
    for (const n of list) {
      if (n.rod == null) continue;
      if (n.state === "CAPPED") rodCap.push(n.rod);
      else if (n.state === "FLOOR ONLY" || n.state === "BOX" || n.state === "NEITHER") rodOther.push(n.rod);
    }
    const trades = (d.trades || []).filter(t => t.resolved);
    taken += (d.trades || []).filter(t => t.status !== "SKIPPED" && t.status !== "WAITING").length;
    for (const t of trades) {
      allTrades.push(t);
      const wk = weeks.get(weekKey(day)) || 0;
      weeks.set(weekKey(day), wk + t.pnl);
    }
    const ranked = (d.trades || []).filter(t => t.resolved).slice().sort((a, b) => (b.volume || 0) - (a.volume || 0)).slice(0, 3);
    top3.push(...ranked);
  }
  const book = lineStats(allTrades);
  const top = lineStats(top3);
  const capM = mean(rodCap), othM = mean(rodOther);
  const diff = capM != null && othM != null ? capM - othM : null;
  const total = [...weeks.values()].reduce((n, v) => n + v, 0);
  let conc = null;
  if (weeks.size && total !== 0) conc = Math.max(...[...weeks.values()].map(v => Math.abs(v / total) * 100));
  const above = allTrades.filter(t => t.vsVwap === "above");
  const below = allTrades.filter(t => t.vsVwap === "below");
  const sideLine = (arr) => { const s = lineStats(arr); return s.n ? `${s.pay == null ? "—" : (s.pay >= 0 ? "+" : "") + s.pay.toFixed(2) + "%"} pay / ${s.win == null ? "—" : s.win.toFixed(0) + "%"} below entry · n ${s.n}` : "n 0"; };
  const gated = [
    row("trades closing below entry", ">= 60%", book.win, book.n ? book.win >= 60 : null, pct(book.win)),
    row("mean pay (short)", ">= +0.30%", book.pay, book.n ? book.pay >= 0.30 : null, signedPct(book.pay)),
    row("CAPPED rest-of-day vs same-day non-CAPPED", "<= −0.20%", diff, diff == null ? null : diff <= -0.20, diff == null ? "—" : `${signedPct(capM)} (n ${rodCap.length}) vs ${signedPct(othM)} (n ${rodOther.length}) = ${signedPct(diff)}`),
    row("top-3 by expiring volume", "same lines", top.pay, top.n ? top.win >= 60 && top.pay >= 0.30 && top.stops <= 20 : null, top.n ? `${signedPct(top.pay)} mean pay · ${pct(top.win)} below entry · stops ${pct(top.stops)} · n ${top.n}` : "—"),
    row("stops", "<= 20%", book.stops, book.n ? book.stops <= 20 : null, pct(book.stops)),
    row("concentration", "no week > 40% of sum", conc, conc == null ? null : conc <= 40, conc == null ? "—" : conc.toFixed(0) + "% max week"),
  ];
  const resolved = book.n;
  const failed = gated.filter(g => g.pass === false);
  const retired = resolved >= RETIRE_AT && failed.length > 0;
  return {
    rows: gated,
    logged: { line: "LOGGED, not a gate: CAPPED with entry above vs below session VWAP at 10:30", above: sideLine(above), below: sideLine(below) },
    count: { needs: "100 trades scored", resolved, taken, cappedNames, names },
    retired, failed: failed.map(f => f.line),
    allPnl: allTrades.reduce((n, t) => n + (t.pnl || 0), 0),
    dayCount: Object.keys(days || {}).filter(k => (days[k].trades || []).some(t => t.resolved) || (days[k].read && days[k].read.names.length)).length,
    span: Object.keys(days || {}).sort(),
  };
}

function row(line, needs, raw, pass, now) { return { line, needs, pass, now, raw }; }
function pct(v) { return v == null ? "—" : v.toFixed(0) + "%"; }
function signedPct(v) { return v == null ? "—" : (v > 0 ? "+" : "") + v.toFixed(2) + "%"; }

function windowReady(snaps) {
  return Object.values(snaps || {}).some(s => s && s.last && s.first && s.last.mins >= 10 * 60 + 30 && s.first.mins >= 9 * 60 + 30 && s.last.mins > s.first.mins);
}
function rodComplete(names) {
  return (names || []).every(n => n.state === "NO SIDE" || n.rod != null);
}
function rankTrades(trades) {
  const ordered = trades.slice().sort((a, b) => (b.volume || 0) - (a.volume || 0));
  ordered.forEach((t, i) => { t.rank = i + 1; });
  return ordered;
}

module.exports = {
  RISK, NOTIONAL, BAND, RETIRE_AT, RULES_TEXT, classifyName, sizeShort, vwapAt, settle, scorecard, rankTrades, weekKey, lineStats, windowReady, rodComplete,
};
