(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = (v, d = 2) => Number.isFinite(+v) ? ((v < 0 ? '−' : '') + '$' + Math.abs(+v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })) : '—';
  const px = (v) => Number.isFinite(+v) ? (+v).toLocaleString('en-US', { maximumFractionDigits: +v < 1 ? 6 : +v < 100 ? 4 : 2 }) : '—';
  const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  const ago = (ms) => { if (!ms) return '—'; const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : Math.round(s / 3600) + 'h ago'; };
  const t = (ms) => ms ? new Date(ms).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';

  let lastPrices = null, lastPos = null, es = null;

  function renderPrices(snap) {
    lastPrices = snap;
    const lat = snap.lastUpdateAt && snap.serverNow ? Math.max(0, snap.serverNow - snap.lastUpdateAt) : null;
    // Prefer mark event latency if present on marks
    let pushLat = null;
    for (const m of Object.values(snap.marks || {})) {
      if (m.ts && snap.serverNow) { const l = snap.serverNow - m.ts; if (pushLat == null || l < pushLat) pushLat = l; }
    }
    $('srcLine').innerHTML = `Source: <b>${esc(snap.source || 'Binance')}</b> · transport <b>${esc(snap.transport || '—')}</b>` +
      (snap.lastUpdateAt ? ` · last update ${esc(ago(snap.lastUpdateAt))}` : '') +
      (pushLat != null ? ` · <span class="lat">feed lag <b>${Math.round(pushLat)} ms</b></span>` : '') +
      (lat != null && pushLat == null ? ` · <span class="lat">age <b>${Math.round(lat)} ms</b></span>` : '');
    if (snap.geoBlocked || snap.note) { $('geoNote').hidden = false; $('geoNote').textContent = snap.note || 'Binance geo-blocked from this host (HTTP 451). Move Render to Frankfurt or Singapore.'; }
    else $('geoNote').hidden = true;
  }

  function cardOpen(p) {
    const side = String(p.side || '').toLowerCase();
    return `<article class="pos-card ${side}">
      <h3><span>${esc(p.symbol)} · ${esc(p.side)}</span><span class="badge ${p.mode === 'dry_run' ? 'info' : ''}">${esc(p.mode || '')}</span></h3>
      <div class="badge-row">
        <span class="badge ${p.protectionOk ? '' : 'bad'}">SL ${esc(p.stopStatus)}</span>
        <span class="badge ${p.protectionOk ? '' : 'bad'}">TP ${esc(p.tpStatus)}</span>
        <span class="badge muted">${esc(p.entryType || '—')}</span>
      </div>
      <dl>
        <dt>Entry price</dt><dd>${px(p.entryPx)}</dd>
        <dt>Quantity</dt><dd>${px(p.qty)}</dd>
        <dt>Leverage</dt><dd>${esc(p.leverage)}×</dd>
        <dt>Margin</dt><dd>${usd(p.margin)}</dd>
        <dt>Stop (SL)</dt><dd>${px(p.stopPx)}</dd>
        <dt>Target (TP)</dt><dd>${px(p.tpPx)}</dd>
        <dt>Live mark (Binance)</dt><dd>${px(p.markPx)}</dd>
        <dt>Unrealized P&amp;L</dt><dd class="${cls(p.upnl)}">${usd(p.upnl)}${p.upnlPct != null ? ` (${p.upnlPct.toFixed(2)}%)` : ''}</dd>
        <dt>Liq. price (est.)</dt><dd>${px(p.liqPx)}</dd>
        <dt>Entered</dt><dd>${t(p.entryTime)}</dd>
      </dl>
      <details class="b-more"><summary>Show raw</summary><pre class="mono" style="font-size:11px;white-space:pre-wrap">${esc(JSON.stringify(p, null, 2))}</pre></details>
    </article>`;
  }

  function cardPending(p) {
    return `<article class="pos-card">
      <h3><span>${esc(p.symbol)} · ${esc(p.side)}</span><span class="pending-cd">${p.remainSec}s</span></h3>
      <dl>
        <dt>Limit price</dt><dd>${px(p.limitPx)}</dd>
        <dt>Filled / target</dt><dd>${px(p.filledQty)} / ${px(p.targetQty)}</dd>
        <dt>Leverage</dt><dd>${esc(p.leverage)}×</dd>
        <dt>Planned SL</dt><dd>${px(p.stopPx)}</dd>
        <dt>Planned TP</dt><dd>${px(p.tpPx)}</dd>
        <dt>Deadline</dt><dd>${t(p.deadlineTs)}</dd>
        <dt>Created</dt><dd>${t(p.createdAt)}</dd>
      </dl>
      <p class="market-note">If unfilled when the countdown hits 0, the remainder goes market (restart-safe).</p>
    </article>`;
  }

  function renderPos(d) {
    lastPos = d;
    if (d.source) renderPrices({ source: d.source, transport: d.transport, lastUpdateAt: d.lastUpdateAt, geoBlocked: d.geoBlocked, note: d.priceNote, marks: {}, serverNow: Date.now() });
    $('modeBadge').textContent = (d.dryRun ? 'DRY-RUN' : String(d.mode || '').toUpperCase());
    $('modeBadge').className = 'badge ' + (d.dryRun ? 'info' : 'bad');
    const day = d.daily || {};
    const tgt = day.targetPct != null ? day.targetPct : 5;
    const lossRef = day.lossLimitPct != null ? day.lossLimitPct : 6;
    const prog = day.pnlPct != null ? `${day.pnlPct.toFixed(2)}% of day-start` : '—';
    $('daily').innerHTML = [
      ['Equity (compounding)', usd(d.equity)],
      ["Today's P&L (IST)", usd(day.pnl) + (day.pnlPct != null ? ` (${day.pnlPct.toFixed(2)}%)` : '')],
      ['Progress vs ' + tgt + '% target', prog + (day.profitReached ? ' · reached (info only)' : '')],
      ['vs −' + lossRef + '% loss ref', day.lossBreached ? 'breached (info — halt OFF)' : 'OK'],
      ['Positions', `${day.positionsUsed ?? 0} / ${day.maxPositions ?? 4}`],
      ['Kill switch', day.killSwitch ? 'ON' : 'OFF'],
    ].map(([k, v]) => `<div class="m"><span>${esc(k)}</span><b class="${String(k).includes('P&L') ? cls(day.pnl) : ''}">${v}</b></div>`).join('');
    $('daily').innerHTML += `<p class="market-note">Daily ${tgt}% target and −${lossRef}% loss level are <b>informational</b> by default — bot keeps opening trades. Per-trade exchange SL/TP still apply. Loss-halt setting: ${day.lossHaltEnabled ? 'ON' : 'OFF'}.</p>`;
    if (day.pausedReason) $('daily').innerHTML += `<p class="market-note warn-text">${esc(day.pausedReason)}</p>`;

    const open = d.open || [];
    $('openCount').textContent = open.length ? open.length + ' open' : 'None';
    $('open').innerHTML = open.length ? open.map(cardOpen).join('') : '<p class="empty">No open positions.</p>';

    const pending = d.pending || [];
    $('pending').innerHTML = pending.length ? pending.map(cardPending).join('') : '<p class="empty">No pending limit entries.</p>';

    const body = $('closed').querySelector('tbody');
    const closed = d.closed || [];
    body.innerHTML = closed.length ? closed.map((c) => `<tr>
      <td class="num">${c.id}</td><td><b>${esc(c.symbol)}</b></td><td>${esc(c.side)}</td>
      <td class="num">${px(c.entryPx)}</td><td class="num">${px(c.exitPx)}</td><td>${esc(c.reason)}</td>
      <td class="num">${px(c.qty)}</td><td class="num ${cls(c.pnl)}">${usd(c.pnl)}</td><td class="num">${usd(c.fees)}</td>
      <td>${esc(c.entryType)}</td><td>${t(c.closedAt)}</td></tr>`).join('') : '<tr><td colspan="11" class="empty">No closed trades yet.</td></tr>';
  }

  async function refresh() {
    try {
      const r = await fetch('/api/binance/positions');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      renderPos(d);
    } catch (e) { $('srcLine').textContent = 'Positions unavailable: ' + e.message; }
  }

  function connectSSE() {
    if (es) { try { es.close(); } catch {} }
    es = new EventSource('/api/binance/prices/stream');
    es.onmessage = (ev) => { try { renderPrices(JSON.parse(ev.data)); } catch {} };
    es.onerror = () => { /* browser will retry; REST refresh still runs */ };
  }

  refresh(); connectSSE();
  setInterval(refresh, 3000);
})();
