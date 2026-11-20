const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = v => v == null || !Number.isFinite(+v) ? "—" : (v < 0 ? "−$" : "$") + Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
const px = v => v == null || !Number.isFinite(+v) ? "—" : (+v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = v => v == null || !Number.isFinite(+v) ? "—" : ((v > 0 ? "+" : "") + (+v).toFixed(2) + "%");
const num = v => v == null || !Number.isFinite(+v) ? "—" : (+v).toLocaleString("en-US", { maximumFractionDigits: 0 });
let timer = null, day = "";

function stamp(iso, timeOnly) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const opt = { timeZone: "America/New_York", hour12: false };
  if (timeOnly) return d.toLocaleTimeString("en-GB", opt);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return day + " " + d.toLocaleTimeString("en-GB", { ...opt, hour: "2-digit", minute: "2-digit" });
}

function render(d) {
  const s = d.summary || {}, card = d.scorecard || { rows: [] };
  const gate = (card.rows || []).map(r => `<tr><td>${esc(r.line)}</td><td>${esc(r.needs)}</td><td class="${r.pass === true ? "pass" : r.pass === false ? "fail" : "wait"}">${esc(r.now)}</td><td class="dim">—</td></tr>`).join("");
  const logged = card.logged || {};
  const count = card.count || {};
  const trades = d.trades || [];
  const read = d.read || [];
  const by = d.byDay || [];
  document.getElementById("app").innerHTML = `
    <p class="rules">${esc(d.rules || "")}</p>
    <p class="note">${esc(d.sideNote || "")} STUDY is left blank on purpose: the reference backtest numbers are not copied into this book.</p>
    <div class="tools">
      <span>engine since <b>${esc(stamp(d.engineSince))}</b></span>
      <span>last cycle <b>${esc(stamp(d.lastCycle, true))}</b></span>
      <label>day <input id="day" type="date" value="${esc(d.day || "")}"></label>
      <label><input id="auto" type="checkbox" checked> refresh 30 s</label>
      ${card.retired ? '<span class="tag red">RETIRED</span>' : '<span class="tag">PAPER</span>'}
    </div>
    ${s.waiting ? '<div class="banner">No 10:30 read yet this day. The read freezes on the first chain pass at or after 10:30 ET.</div>' : ''}
    ${card.retired ? `<div class="banner retired">Retired. ${card.failed.map(esc).join("; ")} failed with ${card.count.resolved} resolved shorts.</div>` : ''}
    <h2 class="sec">Scorecard (all days) — fail any line at 100 trades = retire</h2>
    <div class="tablewrap"><table class="score"><thead><tr><th>Line</th><th>Needs</th><th>Now</th><th>Study</th></tr></thead><tbody>
      ${gate}
      <tr><td>${esc(logged.line || "")}</td><td>not a gate</td><td>above ${esc(logged.above || "—")}<br>below ${esc(logged.below || "—")}</td><td class="dim">—</td></tr>
      <tr><td>count</td><td>${esc(count.needs || "")}</td><td>${count.resolved || 0} resolved / ${count.taken || 0} taken / ${count.cappedNames || 0} CAPPED of ${count.names || 0} names</td><td class="dim">not copied</td></tr>
    </tbody></table></div>
    <p class="note">today P&amp;L <b class="${(s.todayPnl || 0) < 0 ? "pnlneg" : (s.todayPnl || 0) > 0 ? "pnlpos" : ""}">${money(s.todayPnl)}</b> (${s.todayResolved || 0} resolved of ${trades.length}${s.todayOpen ? ", " + s.todayOpen + " still open" : ""}) · all days <b class="${(s.allPnl || 0) < 0 ? "pnlneg" : (s.allPnl || 0) > 0 ? "pnlpos" : ""}">${money(s.allPnl)}</b>${s.from ? " · " + esc(s.from) + " → " + esc(s.to) : ""} · ${count.resolved || 0} resolved / ${count.taken || 0} taken / ${count.cappedNames || 0} CAPPED of ${count.names || 0} names · ${s.expiring || 0} expiring-line names this day, ${s.capped || 0} CAPPED</p>
    <h2 class="sec">Trades ${esc(d.day || "")}</h2>
    <div class="tablewrap"><table class="score"><thead><tr><th>Sym</th><th>Status</th><th>Entry</th><th>Shares</th><th>Size rule</th><th>Risk/cap</th><th>Stop (lid K)</th><th>Rank</th><th>Exit</th><th>Exit px</th><th>Pay %</th><th>P&amp;L $</th><th>R</th><th>Note</th></tr></thead><tbody>
      ${trades.length ? trades.map(t => `<tr><td>${esc(t.symbol)}</td><td>${esc(t.status)}</td><td>${px(t.entry)}</td><td>${num(t.shares)}</td><td>${esc(t.sizeRule || t.rule || "")}</td><td>${esc(t.riskCap || "")}</td><td>${px(t.stop || t.lidStrike)}</td><td>${t.rank == null ? "—" : t.rank}</td><td>${esc(t.exit || "")}</td><td>${px(t.exitPx)}</td><td class="${t.pay > 0 ? "pnlpos" : t.pay < 0 ? "pnlneg" : ""}">${pct(t.pay)}</td><td class="${t.pnl > 0 ? "pnlpos" : t.pnl < 0 ? "pnlneg" : ""}">${t.resolved || t.status === "OPEN" ? money(t.pnl) : "—"}</td><td>${t.r == null ? "—" : t.r.toFixed(2)}</td><td>${esc(t.note || "")}</td></tr>`).join("") : '<tr><td colspan="14">No trades this day.</td></tr>'}
    </tbody></table></div>
    <h2 class="sec">10:30 read, every expiring-line name (CAPPED first; rest-of-day filled after the close = the same-day control)</h2>
    <div class="tablewrap"><table class="score"><thead><tr><th>Sym</th><th>State</th><th>0DTE ctr by cut</th><th>Lid net</th><th>Floor net</th><th>Spot 10:30</th><th>Lid strike</th><th>Written there</th><th>Dist %</th><th>Vs VWAP</th><th>Rest-of-day %</th><th>Result</th></tr></thead><tbody>
      ${read.length ? read.slice().sort((a, b) => (b.state === "CAPPED") - (a.state === "CAPPED") || (b.volume || 0) - (a.volume || 0)).map(n => `<tr><td>${esc(n.symbol)}</td><td>${esc(n.state)}</td><td>${esc(n.ctr)}</td><td>${n.lidNet == null ? "—" : num(n.lidNet)}</td><td>${n.floorNet == null ? "—" : num(n.floorNet)}</td><td>${px(n.spot1030)}</td><td>${px(n.lidStrike)}</td><td>${num(n.written)}</td><td>${n.dist == null ? "—" : n.dist.toFixed(2) + "%"}</td><td>${n.vsVwap ? esc(n.vsVwap) + " " + (n.vwapDelta == null ? "" : (n.vwapDelta > 0 ? "+" : "") + n.vwapDelta.toFixed(2)) : "—"}</td><td class="${n.rod > 0 ? "pnlpos" : n.rod < 0 ? "pnlneg" : ""}">${pct(n.rod)}</td><td>${esc(n.result || n.sideSource || "")}</td></tr>`).join("") : '<tr><td colspan="12">No 10:30 read yet this day.</td></tr>'}
    </tbody></table></div>
    <h2 class="sec">By day</h2>
    <div class="tablewrap"><table class="score"><thead><tr><th>Day</th><th>Resolved</th><th>P&amp;L $</th></tr></thead><tbody>
      ${by.length ? by.map(x => `<tr><td><button class="daylink" data-day="${esc(x.day)}" type="button">${esc(x.day)}</button></td><td>${x.resolved}</td><td class="${x.pnl > 0 ? "pnlpos" : x.pnl < 0 ? "pnlneg" : ""}">${money(x.pnl)}</td></tr>`).join("") : '<tr><td colspan="3">No session has been stored yet. By-day P&amp;L appears after a paper day is saved.</td></tr>'}
    </tbody></table></div>`;
  const input = document.getElementById("day");
  input.onchange = () => { day = input.value; load(); };
  document.getElementById("auto").onchange = e => { if (timer) clearInterval(timer); timer = null; if (e.target.checked) timer = setInterval(() => load(), 30000); };
  document.querySelectorAll(".daylink").forEach(b => b.onclick = () => { day = b.dataset.day; load(); });
}

async function load() {
  try {
    const r = await fetch("/api/zone/dte" + (day ? "?day=" + encodeURIComponent(day) : ""), { headers: { accept: "application/json" } });
    if (r.status === 401) return location.assign("/");
    const data = await r.json();
    if (!day) day = data.day;
    render(data);
  } catch (e) {
    document.getElementById("app").innerHTML = `<div class="banner">Could not load the paper book: ${esc(e.message)}</div>`;
  }
}
load();
timer = setInterval(() => load(), 30000);
