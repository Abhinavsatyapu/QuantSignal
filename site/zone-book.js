/* Renders Ticker levels, Ignitions and Reversals from /api/zone/books. */
const page = document.body.dataset.page;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v, d = 2) => v == null || !Number.isFinite(+v) ? "—" : (+v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const sgn = (v, d = 2, u = "") => v == null || !Number.isFinite(+v) ? "—" : ((+v) > 0 ? "+" : "") + (+v).toFixed(d) + u;
const cls = v => v > 0 ? "pos" : v < 0 ? "neg" : "";
const money = v => { if (v == null || !Number.isFinite(+v)) return "—"; const a = Math.abs(v), sign = v < 0 ? "−" : ""; return sign + "$" + (a >= 1e9 ? (a / 1e9).toFixed(2) + "B" : (a / 1e6).toFixed(0) + "M"); };
const atm = v => { if (v == null || !Number.isFinite(+v)) return "—"; const a = Math.abs(v), sign = v < 0 ? "−" : "+"; return sign + "$" + (a >= 1e6 ? (a / 1e6).toFixed(1) + "M" : a >= 1e3 ? (a / 1e3).toFixed(0) + "k" : a.toFixed(0)); };
const tagCls = s => ({ FEAR: "red", WATCH: "amber", CALM: "green", EASING: "green", BROADENING: "green", NARROWING: "red", MIXED: "amber", BULL: "green", BEAR: "red", NEUTRAL: "amber", FALLING: "red", RISING: "green", FLAT: "amber", BUILDING: "", AVOID: "red", SHUT: "red", HALVE: "amber", WASHED: "red", OPEN: "green" }[s] || "");
const phaseName = p => ({ FRESH: "FRESH +GEX", HELD: "+GEX held", DECAYING: "DECAYING", DEEPENING: "DEEPENING", EXIT: "EXIT", SHORT_GAMMA: "SHORT γ" }[p] || "—");
const phaseCls = p => ({ FRESH: "fresh", HELD: "held", DECAYING: "decay", DEEPENING: "short", EXIT: "exit", SHORT_GAMMA: "short" }[p] || "");
const age = s => s == null ? "—" : s < 90 ? s + "s" : s < 5400 ? Math.round(s / 60) + "m" : Math.round(s / 3600) + "h";
let last = null;

function posture(r) {
  if (r.basePosture && r.posture && r.basePosture !== r.posture) return esc(r.basePosture) + " → " + esc(r.posture);
  return esc(r.posture || "—");
}
function wallMove(live, base) {
  if (live == null) return "—";
  if (base == null) return num(live);
  const d = live - base;
  if (Math.abs(d) < 0.009) return "held";
  return (d > 0 ? "↑ " : "↓ ") + sgn(d);
}
function assumptions(d) {
  return `<details><summary>Signal rules and assumptions</summary><ul>${(d.assumptions || []).map(a => `<li>${esc(a)}</li>`).join("")}</ul>
    <p>Chain source: ${esc(d.sourceDetail || "not chosen yet")}. ${esc(d.atmNote || "")} ${esc(d.flowNote || "")}</p></details>`;
}
function progress(d) {
  const p = d.progress || {};
  if (!p.running && d.counts && d.counts.n) return "";
  const msg = p.running ? `Reading option chains ${p.done || 0}/${p.total || "…"}` : "Waiting for the first chain pass";
  return `<div class="banner">${esc(msg)}. Rows appear as each name finishes. ${d.errorCount ? esc(d.errorCount) + " names have no chain yet." : ""}</div>`;
}
function contextBands(d) {
  const z = d.context || {}, C = z.credit, B = z.breadth, G = z.gamma, sw = d.swing || {};
  const q = B && B.qqq;
  let banner = `<div class="banner skeleton">Swing check is waiting on QQQ daily bars.</div>`;
  if (q) {
    const missing = (sw.need || []).map(esc).join("; ");
    banner = `<div class="banner">${sw.confirmed ? "Swing low <b>confirmed</b>" : "Swing low <b>not confirmed</b>"} — QQQ ${sgn(q.fromHigh)} off the ${esc(q.highDay)} high, low ${num(q.low)} on ${esc(q.lowDay)}, now ${num(q.last)}${missing ? " · missing: " + missing : ""}. <span class="dim">Closes as of ${esc(B.asOf)}. +GEX breadth here is spot above the flip, which is stricter than the share of names with positive gamma.</span></div>`;
  } else if (z.errors && (z.errors.breadth || z.errors.gamma)) banner = `<div class="banner">Regime inputs still coming in: ${esc(Object.entries(z.errors).filter(e => e[1]).map(e => e[0] + " (" + e[1] + ")").join(" · "))}</div>`;
  const econ = `<div class="strip"><span>Econ</span>${(z.econ || []).map(e => `<span class="chip ${e.inDays <= 1 ? "hot" : ""}"><b>${esc(e.name.split(" (")[0])}</b> ${esc(e.date)} · ${esc(e.time)} · ${e.inDays === 0 ? "today" : "in " + e.inDays + "d"}</span>`).join("") || "<span class='dim'>calendar loading</span>"}</div>`;
  const credit = C ? `<section class="band ${C.state === "FEAR" ? "fear" : C.state === "WATCH" ? "watch" : "calm"}"><div class="head"><span class="title">Credit regime</span><span class="tag ${tagCls(C.state)}">${esc(C.state)}</span>${C.atHighs ? '<span class="tag red">At the highs</span>' : ""}<span><b>${num(C.hy)}%</b> vs line ${num(C.line)}% (${sgn(C.vsLineBp, 0, "bp")}) · week <span class="tag ${tagCls(C.week)}">${esc(C.week)}</span> month <span class="tag ${tagCls(C.month)}">${esc(C.month)}</span></span></div><div class="sub">HY ${num(C.hy)}% ${esc(C.trend)} · Δ5 ${sgn(C.d5, 0, "bp")} (${C.d5pct == null ? "—" : C.d5pct + "th pct"}) · Δ20 ${sgn(C.d20, 0, "bp")} · Δ60 ${sgn(C.d60, 0, "bp")}${C.ig != null ? ` · IG ${num(C.ig)}%` : ""}${C.t10 != null ? ` · 10-year ${num(C.t10)}%` : ""}${C.hyYield != null ? ` · HY yield ${num(C.hyYield)}%` : ""} <span class="dim">· ${esc(C.asOf)}</span></div></section>` : `<section class="band"><span class="skeleton">${z.loading && z.loading.credit ? "Credit regime loading from FRED…" : "Credit unavailable: " + esc((z.errors && z.errors.credit) || "waiting")}</span></section>`;
  const breadth = B ? `<section class="band ${B.state === "BROADENING" ? "calm" : B.state === "NARROWING" ? "fear" : "watch"}"><div class="head"><span class="title">Breadth RSP/SPY</span><span class="tag ${tagCls(B.state)}">${esc(B.state)}</span><span>ratio ${num(B.ratio, 4)} ${B.aboveEma50 ? "above" : "below"} EMA50 · Δ10 ${sgn(B.d10)} · Δ20 ${sgn(B.d20)}</span></div><div class="sub">SPY 10d ${sgn(B.spy10)} · SPY ${B.spyAboveEma20 ? "above" : "<b class='neg'>below</b>"} EMA20 (5d ${sgn(B.spy5)}) · ${B.spyAbove200 ? "above" : "<b class='neg'>below</b>"} the 200-day <span class="dim">· ${esc(B.asOf)}</span></div></section>` : `<section class="band"><span class="skeleton">${z.loading && z.loading.breadth ? "Breadth loading…" : "Breadth unavailable: " + esc((z.errors && z.errors.breadth) || "waiting")}</span></section>`;
  const og = d.ogap || {}, ig = d.ignition || {};
  const gates = `<section class="band ${og.code === "SHUT" ? "fear" : ""}"><div class="head"><span class="title">O-gap backdrop</span><span class="tag ${tagCls(og.code)}">${esc(og.code || "…")}</span></div><div class="sub">${esc(og.text || "")}</div></section>
    <section class="band ${ig.code === "AVOID" ? "fear" : ig.code === "CAUTION" ? "watch" : ""}"><div class="head"><span class="title">Ignition context</span><span class="tag ${tagCls(ig.code)}">${esc(ig.code || "…")}</span>${spyLine(d, G)}</div><div class="sub">${esc(ig.text || "")}</div></section>`;
  return banner + econ + credit + breadth + gates;
}
function spyLine(d, G) {
  const n = (G && G.spy && G.spy.norm) || (d.rows || []).find(r => r.symbol === "SPY");
  const v = G && G.spy ? G.spy.norm : n && n.norm;
  return v == null ? "" : `<span>SPY gex ${sgn(v, 3, "")}</span>`;
}
function tideCard(d) {
  const t = d.tide || {}, a = d.tideAdvice || {}, series = (d.gexbrSeries && d.gexbrSeries.length ? d.gexbrSeries.map(x => [x.day, x.v]) : null) || (d.context && d.context.gamma && d.context.gamma.series) || [];
  const max = Math.max(60, ...series.map(x => x[1]).filter(Number.isFinite));
  const bars = series.length ? `<div class="bars" aria-label="gex breadth">${series.map((x, i) => `<i title="${esc(x[0])}: ${num(x[1], 1)}%" class="${i && x[1] < series[i - 1][1] ? "down" : ""}" style="height:${Math.max(6, x[1] / max * 100)}%"></i>`).join("")}</div>` : `<p class="note">The tide chart fills in after the first stored session. One reading is not a direction.</p>`;
  const br = d.breadth || {};
  return `<section class="card"><h2>Gamma tide <span class="tag ${tagCls(t.tide)}">${esc(t.tide || "…")}</span></h2>
    <div class="big">${br.gexbr == null ? "—" : num(br.gexbr, 1) + "%"} <span class="dim" style="font-size:13px">gexbr · +GEX breadth ${br.plus == null ? "—" : num(br.plus, 1) + "%"} of ${br.n || 0}</span></div>
    <p class="note">Book Δ ${sgn(t.d7, 1, "pp")} across ${t.days || 0} stored session${t.days === 1 ? "" : "s"}${t.pctile == null ? "" : " · " + t.pctile + "th pct of those sessions"}. ${esc(a.text || "")}</p>${bars}</section>`;
}
function dialCard(d) {
  const dial = d.dial || { score: 0, max: 3, parts: [], text: "" };
  const zoneDial = d.context && d.context.dial;
  return `<section class="card"><h2>Bull dial <span class="tag ${dial.buyGated ? "red" : "green"}">${dial.score}/${dial.max}</span></h2>
    <div class="dial" aria-label="${dial.score} of ${dial.max}">${(dial.parts || []).map(p => `<span class="${p[1] ? "on" : ""}" title="${esc(p[0])}"></span>`).join("")}</div>
    <ul class="note">${(dial.parts || []).map(p => `<li>${p[1] ? "✓" : "✗"} ${esc(p[0])}</li>`).join("")}</ul>
    <p class="note">${esc(dial.text || "")}</p>
    ${zoneDial ? `<p class="note">The regime page's own dial is ${esc(zoneDial.label)} ${zoneDial.score}/${zoneDial.max}. That score is unchanged.</p>` : ""}
    ${d.stall ? `<p class="note">${esc(d.stall.text)}</p>` : ""}
    <p class="note">${esc((d.ofi && d.ofi.reason) || "")}</p></section>`;
}
function cohortTable(d) {
  const c = d.cohorts || { rows: [] };
  if (!c.rows || !c.rows.length) return "";
  return `<section class="card"><h2>GEX breadth by industry</h2><p class="note">Dispersion ${c.dispersion == null ? "—" : num(c.dispersion, 1) + "pp"} (standard deviation of group breadth). Descriptive: where the book sits, not a forecast. Thin means fewer than 6 names.</p>
    <div class="tablewrap"><table><thead><tr><th>Industry</th><th>N</th><th>+GEX breadth</th><th>Avg GEX</th><th>Median session</th></tr></thead><tbody>
    ${c.rows.map(r => `<tr><td class="sym">${esc(r.sector)}${r.thin ? " <span class='dim'>thin</span>" : ""}</td><td>${r.n}</td><td class="${r.posBreadth >= 60 ? "pos" : r.posBreadth < 35 ? "neg" : ""}">${num(r.posBreadth, 1)}%</td><td class="${cls(r.avgNorm)}">${sgn(r.avgNorm, 2, "")}</td><td class="${cls(r.medRet)}">${sgn(r.medRet)}</td></tr>`).join("")}
    </tbody></table></div></section>`;
}
function tape(d, limit) {
  const rows = (d.tape || []).slice().reverse();
  const show = limit ? rows.slice(0, limit) : rows;
  if (!show.length) return `<p class="note">No tape lines yet. An IGN BOOK line prints when Δgex versus the prior stored session reaches +0.30. Until a prior session exists, Δgex is blank and the book stays empty — that is the rule, not a hidden signal.</p>`;
  return `<div class="tape">${show.map(e => `<div><span>${esc(String(e.mins).padStart ? clock(e.mins) : e.mins)}</span><b>${esc(e.symbol)}</b><span class="kind">${esc(e.kind)}</span><span>${esc(e.text)}</span></div>`).join("")}</div>`;
}
function clock(mins) { const h = Math.floor(mins / 60), m = mins % 60; return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0"); }
function flags(r) {
  const bits = [];
  if (r.broke) bits.push("BROKE D−1");
  if (r.book) bits.push("IGN-" + (r.book === "THIN" ? "THIN" : r.book));
  if (r.flow === "EXHAUSTION") bits.push("EXHAUSTION" + (r.flowTags && r.flowTags.length ? " [" + r.flowTags.join("+") + "]" : ""));
  if (r.flowTag) bits.push(r.flowTag === "confirmed" ? "flow confirmed" : "flow opposed");
  if (r.phaseProvisional && r.phase) bits.push("phase provisional");
  if (r.airpocket) bits.push(r.airpocket.side + " " + r.airpocket.gap.toFixed(1) + "%");
  if (r.dte) bits.push("0DTE " + r.dte.tags.join(" "));
  return bits.join(" · ") || "—";
}
function rowHtml(r) {
  const credit = r.credit ? `${r.credit.align}${r.credit.wait ? " · WAIT" : ""} · ${r.credit.size}` : "";
  return `<tr data-sym="${esc(r.symbol)}" data-phase="${esc(r.phase || "")}" data-book="${esc(r.book || "")}" data-rev="${esc(r.reversal ? r.reversal.kind : "")}">
    <td class="sym">${esc(r.symbol)}<small>${esc(r.group)}${credit ? " · " + esc(credit) : ""}</small></td>
    <td>${posture(r)}</td>
    <td class="phase ${phaseCls(r.phase)}">${phaseName(r.phase)}</td>
    <td>${r.base ? num(r.base.putWall) : "—"}</td><td>${r.base && r.base.flip ? num(r.base.flip) : "—"}</td><td>${r.base ? num(r.base.callWall) : "—"}</td>
    <td class="${cls(r.base && r.base.norm)}">${r.base ? sgn(r.base.norm, 2, "") : "—"}</td>
    <td>${num(r.putWall)}<small class="dim" style="display:block">${wallMove(r.putWall, r.base && r.base.putWall)}</small></td>
    <td>${r.flip ? num(r.flip) : "—"}</td>
    <td>${num(r.callWall)}<small class="dim" style="display:block">${wallMove(r.callWall, r.base && r.base.callWall)}</small></td>
    <td class="${cls(r.norm)}">${sgn(r.norm, 2, "")}<small class="dim" style="display:block">${esc(r.sign || "")}</small></td>
    <td class="${cls(r.vsBase)}">${num(r.spot)}<small class="dim" style="display:block">${sgn(r.vsBase)} vs base</small></td>
    <td class="${cls(r.dgex)}">${sgn(r.dgex, 2, "")}</td>
    <td>${r.pct0 == null ? "—" : num(r.pct0, 0) + "%"}</td>
    <td>${r.pct17 == null ? "—" : num(r.pct17, 0) + "%"}</td>
    <td>${atm(r.atmPrem)}</td>
    <td>${esc(r.flow)}</td>
    <td class="sym">${esc(flags(r))}</td>
  </tr>`;
}
const HEAD = `<thead><tr><th>Symbol</th><th>Posture</th><th>Phase</th><th>Put base</th><th>Flip base</th><th>Call base</th><th>GEX base</th><th>Put now</th><th>Flip</th><th>Call now</th><th>GEX</th><th>Spot</th><th>ΔGEX</th><th>0DTE</th><th>1–7D</th><th>ATM $</th><th>Flow</th><th>Flags</th></tr></thead>`;
function table(rows) {
  if (!rows.length) return `<div class="empty">No names in this view yet.</div>`;
  return `<div class="tablewrap"><table>${HEAD}<tbody>${rows.map(rowHtml).join("")}</tbody></table></div>`;
}
function counts(d) {
  const c = d.counts || {};
  const cells = [["Book", c.n], ["IGN-A", c.ignA], ["IGN-B", c.ignB], ["IGN-THIN", c.ignThin], ["Exhaustion", c.exhaust], ["Reversions", c.revert], ["Broke D−1", c.broke]];
  return `<div class="counts">${cells.map(([k, v]) => `<div>${esc(k)}<b>${v == null ? "—" : v}</b></div>`).join("")}</div>`;
}
function metaLine(d) {
  const base = d.baselineDay ? `Daily baseline ${d.baselineDay}` : "No prior session stored yet — Δgex stays blank until one close is on file";
  const when = d.updatedAt ? new Date(d.updatedAt).toLocaleString() : "not yet";
  return `<div class="banner"><b>${esc(d.ny ? d.ny.day : "")}</b> ${esc(d.ny ? clock(d.ny.mins) : "")} ET · ${esc(base)} · intraday pass ${esc(when)} · ${esc(d.source || "source pending")} · ${d.counts ? d.counts.n : 0} names${d.errorCount ? " · " + d.errorCount + " without a chain" : ""}</div>`;
}
function levels(d) {
  return progress(d) + contextBands(d) + `<div class="grid2">${tideCard(d)}${dialCard(d)}</div>` + cohortTable(d) + metaLine(d) +
    `<section class="card"><h2>Signal tape</h2>${tape(d, 12)}</section>` +
    `<div class="rowbar"><input id="q" type="search" placeholder="Filter symbol or industry" aria-label="Filter symbols"><select id="phase" aria-label="Phase"><option value="">All phases</option><option>FRESH</option><option>HELD</option><option>DECAYING</option><option>EXIT</option><option>SHORT_GAMMA</option><option>DEEPENING</option></select><label class="note"><input id="onlybook" type="checkbox"> Ignition book only</label></div>` +
    table(d.rows || []) + assumptions(d);
}
function ignitions(d) {
  const conf = d.confirmed || {};
  const booked = (d.rows || []).filter(r => r.book || r.flow === "EXHAUSTION");
  return progress(d) + metaLine(d) + counts(d) +
    `<section class="band ${conf.status === "frozen" ? "calm" : "watch"}"><div class="head"><span class="title">Confirmed break</span><span class="tag">${esc(conf.status || "…")}</span></div><div class="sub">${esc(conf.detail || "")}${conf.names && conf.names.length ? " · " + conf.names.map(esc).join(" · ") : " · none"}</div></section>` +
    `<div class="grid2">${tideCard(d)}${dialCard(d)}</div>` +
    `<section class="card"><div class="head"><h2>Ignition context</h2></div><p class="note">${esc((d.ignition && d.ignition.text) || "")}</p><p class="note">${esc((d.tideAdvice && d.tideAdvice.text) || "")}</p></section>` +
    `<section class="card"><h2>Signal tape</h2>${tape(d)}</section>` +
    `<section class="card"><h2>Names in a book, or exhaustion</h2><p class="note">Entry is Δgex ≥ +0.30 versus the prior session. Tier A / B / THIN is the label, not a second threshold. Flow near zero does not block.</p>${table(booked)}</section>` +
    assumptions(d);
}
function reversals(d) {
  const rows = d.rows || [];
  const lead = `<section class="banner">The reference Reversals tab is a short-stall playbook: pre-market plan, grade A/B/C, price to watch, and a forward score. That study is not in this app, so those grades and prices are not shown. Below is the gamma posture book from the same chain as Ticker Levels. An empty group means no name met that rule.</section>`;
  const groups = ["REVERT", "REVERT-PENDING", "TREND-EXHAUST", "REVERT-FAILED"];
  const blocks = groups.map(kind => {
    const list = rows.filter(r => r.reversal && r.reversal.kind === kind);
    const blurb = { REVERT: "Live posture is mean revert and gamma is positive.", "REVERT-PENDING": "Prior session was neutral and the live posture has shifted to mean revert.", "TREND-EXHAUST": "Prior session was trend, live posture is neutral, and gamma is not still falling.", "REVERT-FAILED": "A mean-revert posture has slipped back to neutral or trend." }[kind];
    return `<section class="card"><h2>${esc(kind)} · ${list.length}</h2><p class="note">${esc(blurb)}</p>${table(list)}</section>`;
  }).join("");
  return lead + progress(d) + metaLine(d) + `<section class="band ${d.dial && d.dial.buyGated ? "fear" : "calm"}"><div class="head"><span class="title">Reversal gate</span></div><div class="sub">${esc((d.dial && d.dial.text) || "")} ${esc((d.tideAdvice && d.tideAdvice.text) || "")} ${esc((d.stall && d.stall.text) || "")} Short-gamma names are left out of the long fade.</div></section>` +
    `<div class="grid2">${tideCard(d)}${dialCard(d)}</div>` + blocks + assumptions(d);
}
function airpockets(d) {
  const list = (d.rows || []).filter(r => r.airpocket).sort((a, b) => b.airpocket.gap - a.airpocket.gap);
  return progress(d) + metaLine(d) + `<section class="band"><div class="head"><span class="title">Airpockets</span><span class="tag">${list.length} of ${(d.rows || []).length}</span></div><div class="sub">A name is listed when the nearest put or call wall is at least 2% of spot away. UNDER: that wall is above the price. OVER: the wall is below. The reference long-eligible book (fired, still waiting, zone in window) is a different engine and is not computed here. Tag stays STILL WATCHING because this app does not fire an airpocket entry.</div></section>` +
    (list.length ? `<div class="tablewrap"><table><thead><tr><th>Symbol</th><th>Level</th><th>Dist</th><th>Zone</th><th>Spot</th><th>Phase</th><th>Tag</th></tr></thead><tbody>${list.map(r => `<tr><td class="sym">${esc(r.symbol)}<small>${esc(r.group)}</small></td><td>${num(r.airpocket.wall)}</td><td>${r.airpocket.gap.toFixed(1)}%</td><td>${esc(r.airpocket.side)}</td><td>${num(r.spot)}</td><td class="phase ${phaseCls(r.phase)}">${phaseName(r.phase)}</td><td><span class="tag amber">STILL WATCHING</span></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">No name is 2% or more from its nearest wall. The list stays empty until a chain pass produces walls.</div>`) +
    assumptions(d);
}
function danger(d) {
  const rows = d.rows || [];
  const n = (pred) => rows.filter(pred).length;
  const mean = n(r => r.basePosture === "MEAN REVERT"), trend = n(r => r.basePosture === "TREND"), hold = n(r => r.basePosture !== "MEAN REVERT" && r.basePosture !== "TREND");
  const fresh = n(r => r.phase === "FRESH"), decay = n(r => r.phase === "DECAYING"), exit = n(r => r.phase === "EXIT");
  const flips = n(r => r.basePosture && r.posture && r.basePosture !== r.posture);
  const walls = n(r => r.base && ((r.putWall != null && r.base.putWall != null && Math.abs(r.putWall - r.base.putWall) >= 0.01) || (r.callWall != null && r.base.callWall != null && Math.abs(r.callWall - r.base.callWall) >= 0.01)));
  const empty = !rows.length;
  return progress(d) + (empty ? `<div class="empty">Danger Zones has no names yet. Counts stay at zero until the chain pass that feeds Zone Monitor finishes. Campaigns, cockpit, flip-reclaim, 51–56, ignition, washout, and credit on the 8042 bar are not built.</div>` : "") +
    `<div class="boxes">
      <section class="box"><h2>Deploy at open</h2><p class="note">${rows.length} tickers · prior-session posture. No stored baseline counts as hold.</p><div class="rowbar"><div><div class="k">Mean revert</div><b>${mean}</b></div><div><div class="k">Trend</div><b>${trend}</b></div><div><div class="k">Neutral / hold</div><b>${hold}</b></div></div></section>
      <section class="box"><h2>Regime signals</h2><p class="note">+GEX phase on this pass</p><div class="rowbar"><div><div class="k">Fresh +GEX</div><b>${fresh}</b></div><div><div class="k">Decaying</div><b>${decay}</b></div><div><div class="k">Exit</div><b>${exit}</b></div></div></section>
      <section class="box"><h2>Needs adjustment</h2><p class="note">Live drift vs the stored baseline</p><div class="rowbar"><div><div class="k">Posture flips</div><b>${flips}</b></div><div><div class="k">Walls moved</div><b>${walls}</b></div></div></section>
    </div>` +
    (rows.length ? table(rows) : "") +
    `<p class="note">These counts use the Zone Monitor chain (Alpaca when ALPACA_KEY_ID and ALPACA_SECRET_KEY are set, otherwise Cboe). They are not the reference 8042 bot ledger, and this page does not place orders.</p>` + assumptions(d);
}
function stub(title, copy) {
  return `<section class="card"><h2>${esc(title)}</h2><p>${esc(copy)}</p><p class="note"><a href="/zone#levels">Ticker levels</a> · <a href="/ignitions">Ignitions</a> · <a href="/reversals">Reversals</a> · <a href="/airpocket">Airpockets</a></p></section>`;
}

function weekly() {
  return `<section class="card"><h2>Weekly</h2>
    <p>The reference Weekly tab is an options-positioning board: bullish or bearish read, regime, lean, call and put days, wall up or down, and forward scorecards. That ledger is not in this app.</p>
    <div class="empty">No weekly rows. The read, regime, lean, call/put days, wall, and scorecard columns stay blank. Nothing is filled from the reference screenshot.</div>
    <p class="note"><a href="/zone#levels">Ticker levels</a> · <a href="/reversals">Reversals</a> · <a href="/airpocket">Airpocket</a></p>
  </section>`;
}
function render(d) {
  if (page === "weekly") return weekly();
  if (page === "swing") return danger(d);
  if (page === "airpocket") return airpockets(d);
  if (page === "ignitions") return ignitions(d);
  if (page === "reversals") return reversals(d);
  return levels(d);
}
function applyFilter() {
  const q = ($("#q") && $("#q").value || "").trim().toLowerCase();
  const phase = $("#phase") ? $("#phase").value : "";
  const only = $("#onlybook") && $("#onlybook").checked;
  document.querySelectorAll("tbody tr").forEach(tr => {
    const blob = tr.innerText.toLowerCase();
    const ok = (!q || blob.includes(q)) && (!phase || tr.dataset.phase === phase) && (!only || tr.dataset.book);
    tr.style.display = ok ? "" : "none";
  });
}
function bind() {
  ["q", "phase", "onlybook"].forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener("input", applyFilter); });
}
async function load(force) {
  if (!force && document.activeElement && ["q", "phase"].includes(document.activeElement.id)) return;
  const y = document.scrollingElement.scrollTop;
  try {
    const r = await fetch("/api/zone/books" + (force ? "?refresh=1" : ""), { headers: { accept: "application/json" } });
    if (r.status === 401) return location.assign("/");
    const d = await r.json();
    last = d;
    const src = $("#src");
    if (src) src.textContent = (d.sourceDetail || "Choosing a chain source…") + (d.context && d.context.ages ? ` · credit ${age(d.context.ages.credit)}` : "");
    $("#app").innerHTML = render(d);
    bind();
    document.scrollingElement.scrollTop = y;
  } catch (e) {
    if (!$("#app").innerHTML || $("#app").querySelector(".skeleton")) $("#app").innerHTML = `<div class="banner">Could not reach the book: ${esc(e.message)}</div>`;
  }
}
$("#refresh").onclick = () => load(true);
setInterval(() => { const c = $("#clock"); if (c) c.textContent = new Date().toLocaleTimeString(); }, 1000);
load(false);
setInterval(() => { if (!document.hidden) load(false); }, 20000);
