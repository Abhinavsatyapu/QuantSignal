const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const n = (v, d = 2) => v == null || !Number.isFinite(+v) ? "—" : (+v).toFixed(d);
const sg = (v, d = 2) => v == null || !Number.isFinite(+v) ? "—" : (v > 0 ? "+" : "") + (+v).toFixed(d);
const cls = v => v > 0 ? "pos" : v < 0 ? "neg" : "";
const page = document.body.dataset.live;

function table(heads, rows) {
  return `<div class="wrap"><table><thead><tr>${heads.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("") || `<tr><td colspan="${heads.length}">No rows in this pass.</td></tr>`}</tbody></table></div>`;
}
function sources(d) {
  const s = d.sources || {};
  const bits = [s.prices, s.options, s.fear, s.treasury].filter(Boolean);
  const miss = [].concat(s.missedCharts || [], s.missedOptions || []);
  return `<p class="note">${esc(bits.join(" · "))}${s.fred ? " · FRED: " + esc(s.fred) : ""}${miss.length ? " · missed " + esc(miss.slice(0, 6).join("; ")) : ""}</p>`;
}
function assumptions(d) {
  return `<details class="note"><summary>Rules used on this page</summary><ul>${(d.assumptions || []).map(a => `<li>${esc(a)}</li>`).join("")}</ul></details>`;
}
function shell(d, body) {
  const src = document.getElementById("src");
  if (src) src.textContent = d.updatedAt ? new Date(d.updatedAt).toLocaleTimeString() : "";
  return sources(d) + body + assumptions(d);
}

function macro(d) {
  return shell(d, table(["Symbol", "Last", "Day %", "5d %", "20d %", "60d %", "RVOL"], (d.rows || []).map(r => `<tr><td>${esc(r.symbol)}</td><td>${n(r.last)}</td><td class="${cls(r.d1)}">${sg(r.d1)}</td><td class="${cls(r.d5)}">${sg(r.d5)}</td><td class="${cls(r.d20)}">${sg(r.d20)}</td><td class="${cls(r.d60)}">${sg(r.d60)}</td><td>${n(r.rvol)}</td></tr>`)));
}
function quants(d) {
  return shell(d, table(["Cohort", "ETF", "Phase", "Last", "20d %", "vs SPY 20d", "RVOL"], (d.rows || []).map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.symbol)}</td><td><span class="tag">${esc(r.phase)}</span></td><td>${n(r.last)}</td><td class="${cls(r.d20)}">${sg(r.d20)}</td><td class="${cls(r.rel20)}">${sg(r.rel20)}</td><td>${n(r.rvol)}</td></tr>`)));
}
function blocks(d) {
  const fear = d.fear && d.fear.score != null ? `<div class="card"><div class="k">CNN Fear & Greed</div><div class="v">${n(d.fear.score, 1)}</div><div>${esc(d.fear.rating || "")}</div><p class="note">Prior close ${n(d.fear.prevClose, 1)} · week ${n(d.fear.week, 1)} · month ${n(d.fear.month, 1)}</p></div>` : `<div class="card"><div class="k">CNN Fear & Greed</div><p>${esc((d.fear && d.fear.error) || "No score.")}</p></div>`;
  const curve = d.curve && !d.curve.error ? `<div class="card"><div class="k">Treasury ${esc(d.curve.asOf || "")}</div><p>3m ${n(d.curve.m3)} · 2y ${n(d.curve.y2)} · 10y ${n(d.curve.y10)} · 30y ${n(d.curve.y30)}</p></div>` : `<div class="card"><p>${esc((d.curve && d.curve.error) || "Treasury curve missing.")}</p></div>`;
  const cards = (d.blocks || []).map(b => `<div class="card"><div class="k">${esc(b.name)}</div><div class="v ${cls(b.value)}">${b.value == null ? "—" : n(b.value)}</div><p class="note">${esc(b.unit || "")} ${esc(b.note || "")}</p></div>`).join("");
  return shell(d, `<div class="grid">${fear}${curve}${cards}</div>`);
}
function cohorts(d) { return quants(d); }
function strategies(d) {
  return shell(d, (d.rules || []).map(r => `<div class="card"><span class="tag ${r.on ? "green" : "amber"}">${r.on ? "ON" : "OFF"}</span> <b>${esc(r.name)}</b><p class="note">${esc(r.detail)}</p></div>`).join(""));
}
function plan(d) {
  return shell(d, table(["Cohort", "ETF", "Phase", "Mode", "Last", "20d %"], (d.rows || []).map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.symbol)}</td><td>${esc(r.phase)}</td><td><span class="tag ${r.mode === "PAPER WATCH" ? "green" : "amber"}">${esc(r.mode)}</span></td><td>${n(r.last)}</td><td class="${cls(r.d20)}">${sg(r.d20)}</td></tr>`)));
}
function fleet(d) {
  const rows = d.rows || [];
  return shell(d, `<p class="note">Paper roster. Share count is 0. This page does not launch a bot and does not send an order.</p>` + (rows.length ? table(["ETF", "Phase", "Last", "20d %", "Shares"], rows.map(r => `<tr><td>${esc(r.symbol)}</td><td>${esc(r.phase)}</td><td>${n(r.last)}</td><td class="${cls(r.d20)}">${sg(r.d20)}</td><td>0</td></tr>`)) : `<div class="card">No cohort is in IGNITION or MATURE on this pass, so the roster is empty. That is the rule, not a missing feed.</div>`));
}
function grid(d) {
  const g = d.grid;
  if (!g) return shell(d, `<div class="card">No reference price yet.</div>`);
  return shell(d, `<div class="card"><b>${esc(g.symbol)}</b> last ${n(g.last)}<p class="note">${esc(g.note)}</p></div>` + table(["Offset", "Level"], (g.levels || []).map(l => `<tr><td>${sg(l.pct, 0)}%</td><td>${n(l.level)}</td></tr>`)));
}
function config(d) {
  const c = d.config || {};
  return shell(d, `<div class="card"><div class="k">Rebalance</div><div class="v">OFF</div><p class="note">${esc(c.note || "")} Orders: ${c.orders ? "on" : "off"}.</p><p class="note">Documented inputs: RVOL at least ${n(c.rvolMin)} · stall close in the bottom ${n((c.stallClosePos || 0) * 100, 0)}% of the range · airpocket gap at least ${n(c.airGapPct, 0)}%.</p></div>`);
}
function pnl(d) {
  return shell(d, `<p class="note">Each line is one share marked on the session change of that ETF. It is not an account and it is not a fill.</p>` + table(["Cohort", "ETF", "Last", "Day %"], (d.rows || []).map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.symbol)}</td><td>${n(r.last)}</td><td class="${cls(r.day)}">${sg(r.day)}</td></tr>`)));
}
function rvol(d) {
  return shell(d, `<p class="note">RVOL is stock volume versus the prior 20 sessions. Net option volume is calls minus puts on the nearest Yahoo expiry. Velocity is today's stock volume versus yesterday. Blank option cells mean that name was not in the option set.</p>` + table(["Symbol", "Last", "RVOL", "Velocity %", "Call vol", "Put vol", "Net"], (d.rows || []).map(r => `<tr><td>${esc(r.symbol)}</td><td>${n(r.last)}</td><td>${n(r.rvol)}</td><td class="${cls(r.vel)}">${sg(r.vel)}</td><td>${r.callVol == null ? "—" : Math.round(r.callVol)}</td><td>${r.putVol == null ? "—" : Math.round(r.putVol)}</td><td class="${cls(r.netVol)}">${r.netVol == null ? "—" : Math.round(r.netVol)}</td></tr>`)));
}
function weekly(d) {
  return shell(d, `<p class="note">This week's range is the last five Yahoo sessions. Lean is call versus put contract volume on the nearest expiry. The reference multi-year hit-rate tables are not copied; this board is only the live read.</p>` + table(["Symbol", "Last", "5-session %", "Low", "High", "Lean", "Put wall", "Call wall", "GEX"], (d.rows || []).map(r => `<tr><td>${esc(r.symbol)}</td><td>${n(r.last)}</td><td class="${cls(r.week)}">${sg(r.week)}</td><td>${n(r.low)}</td><td>${n(r.high)}</td><td>${esc(r.lean || "—")}</td><td>${n(r.putWall)}</td><td>${n(r.callWall)}</td><td class="${cls(r.norm)}">${sg(r.norm, 2)}</td></tr>`)));
}
function air(d) {
  const rows = d.rows || [];
  const fired = rows.filter(r => r.tag === "FIRED"), wait = rows.filter(r => r.tag !== "FIRED");
  const draw = list => table(["Symbol", "Side", "Level", "Dist %", "Spot", "Tag"], list.map(r => `<tr><td>${esc(r.symbol)}</td><td>${esc(r.side)}</td><td>${n(r.level)}</td><td>${n(r.dist)}</td><td>${n(r.spot)}</td><td><span class="tag ${r.tag === "FIRED" ? "red" : "amber"}">${esc(r.tag)}</span></td></tr>`));
  return shell(d, `<h2>Fired</h2>${fired.length ? draw(fired) : `<p class="note">None of the eligible walls have been traded through on this pass.</p>`}<h2>Still watching</h2>${draw(wait)}`);
}
function stall(d) {
  const s = d.stall || {};
  const g = s.grade || {};
  const hit = s.sample && s.sample.hit != null ? (s.sample.hit * 100).toFixed(0) + "% of " + s.sample.n + " stall days in this window" : "no stall days in the window";
  return shell(d, `<div class="card"><span class="tag ${g.grade === "A" ? "red" : g.grade === "B" ? "amber" : ""}">GRADE ${esc(g.grade || "—")}</span> <b>SPY ${n(g.spy)}</b> prior ${n(g.prev)} · 20-session average ${n(g.sma20)}<p class="note">${esc(s.rule || "")} Next-session break rate: ${esc(hit)}.</p></div>` + table(["Symbol", "Grade", "Stall day", "Price to watch", "Spot", "Status", "Dist %"], (s.rows || []).map(r => `<tr><td>${esc(r.symbol)}</td><td>${esc(r.grade || "")}</td><td>${esc(r.stallDay)}</td><td>${n(r.watch)}</td><td>${n(r.spot)}</td><td><span class="tag ${r.status === "BROKE" ? "red" : "amber"}">${esc(r.status)}</span></td><td class="${cls(r.dist)}">${sg(r.dist)}</td></tr>`)));
}
function names(list) { return (list || []).map(r => esc(r.symbol || r)).join(" ") || "—"; }
function swing(d) {
  const s = d.swing || {}, danger = s.danger || {};
  const tabs = ["Danger", "Campaigns", "Cockpit", "Flip-reclaim", "S1–S6", "Ignition", "Washout", "Credit"];
  const body = {
    Danger: table(["Symbol", "Posture", "GEX", "Flip", "Put", "Call", "Spot"], (s.rows || []).map(r => `<tr><td>${esc(r.symbol)}</td><td>${esc(r.posture || "—")}</td><td class="${cls(r.norm)}">${sg(r.norm)}</td><td>${n(r.flip)}</td><td>${n(r.putWall)}</td><td>${n(r.callWall)}</td><td>${n(r.spot)}</td></tr>`)),
    Campaigns: `<p class="note">Names with normalized gamma at least +0.15 on this expiry. A prior pass is required before a name can be called a held campaign.</p><p>${names(s.campaigns)}</p>`,
    Cockpit: `<div class="grid"><div class="card"><div class="k">Mean revert</div><div class="v">${danger.mean ?? "—"}</div></div><div class="card"><div class="k">Trend</div><div class="v">${danger.trend ?? "—"}</div></div><div class="card"><div class="k">Neutral</div><div class="v">${danger.hold ?? "—"}</div></div><div class="card"><div class="k">Elevated +GEX</div><div class="v">${danger.fresh ?? "—"}</div></div></div>`,
    "Flip-reclaim": `<p class="note">Above the flip means spot is at or above the gamma flip and net gamma is positive. Reclaimed means the prior pass had spot under that flip.</p>` + table(["Symbol", "Spot", "Flip", "Reclaimed"], (s.flip || []).map(r => `<tr><td>${esc(r.symbol)}</td><td>${n(r.spot)}</td><td>${n(r.flip)}</td><td>${r.reclaimed ? "YES" : "above, first pass"}</td></tr>`)),
    "S1–S6": table(["Stage", "N", "Names"], (s.stages || []).map(st => `<tr><td>${esc(st.stage)}</td><td>${st.n}</td><td>${esc((st.names || []).join(" "))}</td></tr>`)) + `<p class="note">S1 ≥ +0.25, S2 ≥ +0.08, S3 ≥ +0.02, S4 near zero, S5 down to −0.25, S6 below that. Bands are ours.</p>`,
    Ignition: `<p class="note">Listed when normalized gamma is at least +0.30. Δgex versus a prior session is not claimed on the first pass.</p><p>${names(s.ignition)}</p>`,
    Washout: `<div class="card"><span class="tag ${(s.washout && s.washout.on) ? "red" : "green"}">${s.washout && s.washout.on ? "WASHOUT" : "NOT A WASHOUT"}</span><p class="note">${esc(s.washout && s.washout.note || "")}</p></div>`,
    Credit: `<p class="note">Sector day percents from Yahoo. This is the credit-reaction strip.</p>` + table(["Sector", "ETF", "Day %"], ((s.credit && s.credit.reaction) || []).map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.symbol)}</td><td class="${cls(r.d1)}">${sg(r.d1)}</td></tr>`)),
  };
  return shell(d, `<div class="tabs">${tabs.map((t, i) => `<button type="button" data-tab="${esc(t)}" class="${i ? "" : "on"}">${esc(t)}</button>`).join("")}</div><div id="panel">${body[tabs[0]]}</div>`) + `<template id="bodies">${tabs.map(t => `<section data-b="${esc(t)}">${body[t]}</section>`).join("")}</template>`;
}
function bots(d) {
  return shell(d, `<p class="note">PAPER / read only. A one-leg short put is sketched at the put wall of the nearest expiry. No order is sent.</p>` + table(["Symbol", "Spot", "Put wall", "Call wall", "Note"], (d.rows || []).map(r => `<tr><td>${esc(r.symbol)}</td><td>${n(r.spot)}</td><td>${n(r.put)}</td><td>${n(r.call)}</td><td>${esc(r.note)}</td></tr>`)));
}
function planner(d) {
  const p = d.planner;
  if (!p) return shell(d, `<div class="card">SPY chain is not in this pass, so the payoff is blank.</div>`);
  return shell(d, `<div class="card"><b>SPY</b> ${n(p.spot)} · short put strike ${n(p.put)}<p class="note">${esc(p.note)}</p></div>` + table(["Move", "Spot", "Share vs last", "Short put intrinsic"], (p.payoff || []).map(x => `<tr><td>${sg(x.pct, 0)}%</td><td>${n(x.spot)}</td><td class="${cls(x.naked)}">${n(x.naked)}</td><td class="${cls(x.shortPut)}">${n(x.shortPut)}</td></tr>`)));
}
const views = { macro, quants, blocks, cohorts, strategies, plan, fleet, grid, config, pnl, rvol, weekly, airpocket: air, stall, swing, bots, planner };

async function load(which, into) {
  const r = await fetch("/api/live/" + which, { headers: { accept: "application/json" } });
  if (r.status === 401) return location.assign("/");
  const d = await r.json();
  const el = document.querySelector(into);
  if (!el) return;
  if (d.pending) { el.innerHTML = `<div class="card">${esc(d.message || "Loading…")}</div>`; return; }
  if (d.error && !views[which]) { el.innerHTML = `<div class="card">${esc(d.error)}</div>`; return; }
  el.innerHTML = views[which](d);
  const lv = document.getElementById("src"); if (lv && into === "#app") { let t = document.getElementById("liveAt"); if (!t) { t = document.createElement("span"); t.id = "liveAt"; t.style.cssText = "margin-left:8px;color:#2fc27a;font-size:12px"; lv.after(t); } t.textContent = "● live · updated " + new Date().toLocaleTimeString(); }
  if (which === "swing") bindTabs();
}
function bindTabs() {
  const panel = document.getElementById("panel");
  const root = document.getElementById("bodies");
  document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => {
    document.querySelectorAll(".tabs button").forEach(x => x.classList.toggle("on", x === b));
    const sec = root && root.content && root.content.querySelector(`section[data-b="${CSS.escape(b.dataset.tab)}"]`);
    if (panel && sec) panel.innerHTML = sec.innerHTML;
  });
}
if (page) {
  const tick = () => load(page, "#app").catch(e => { const el = document.getElementById("app"); if (el) el.innerHTML = `<div class="card">${esc(e.message)}</div>`; });
  tick();
  setInterval(() => { if (!document.hidden) tick(); }, 30000);           // live: re-read every 30 s
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
}
const stallEl = document.getElementById("stall");
if (stallEl) {
  const tick = () => load("stall", "#stall").catch(e => { stallEl.innerHTML = `<div class="card">${esc(e.message)}</div>`; });
  tick();
  setInterval(() => { if (!document.hidden) tick(); }, 30000);
}
