(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = (v, d = 2) => Number.isFinite(+v) ? ((v < 0 ? '−' : '') + '$' + Math.abs(+v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })) : '—';
  const px = (v) => Number.isFinite(+v) ? (+v).toLocaleString('en-US', { maximumFractionDigits: +v < 1 ? 6 : +v < 100 ? 4 : 2 }) : '—';
  const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  const ago = (ms) => { if (!ms) return '—'; const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : Math.round(s / 3600) + 'h ago'; };
  const tIST = (ms) => {
    if (!ms) return '—';
    try { return new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Calcutta', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) + ' IST'; }
    catch { return new Date(ms).toISOString(); }
  };

  let es = null;

  function renderPrices(snap) {
    if (!$('srcLine')) return;
    const ageMs = snap.ageMs != null ? snap.ageMs : (snap.lastUpdateAt ? Math.max(0, Date.now() - snap.lastUpdateAt) : null);
    const stale = snap.stale === true || (ageMs != null && ageMs > 10000) || snap.lastUpdateAt == null;
    const lastAbs = snap.lastUpdateAt ? new Date(snap.lastUpdateAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
    $('srcLine').innerHTML = `Source: <b>${esc(snap.source || 'Binance')}</b> · transport <b>${esc(snap.transport || '—')}</b>` +
      ` · last update <b>${esc(lastAbs)}</b> (${esc(ago(snap.lastUpdateAt))})` +
      (stale ? ' · <span class="pill stale">STALE</span>' : ' · <span class="pill live">LIVE</span>') +
      (ageMs != null ? ` · age <b>${Math.round(ageMs)} ms</b>` : '');
    if ($('geoNote')) {
      if (snap.geoBlocked || snap.note) { $('geoNote').hidden = false; $('geoNote').textContent = snap.note || 'Binance geo-blocked from this host (HTTP 451).'; }
      else $('geoNote').hidden = true;
    }
  }

  function drawCurve(days) {
    const c = $('eqCanvas'); if (!c) return;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    ctx.fillStyle = '#141e30'; ctx.fillRect(0, 0, w, h);
    if (!days.length) {
      ctx.fillStyle = '#7f8eab'; ctx.font = '13px IBM Plex Sans, sans-serif';
      ctx.fillText('No closed-trade equity series yet', 16, h / 2);
      return;
    }
    const ys = days.map((d) => +d.equity).filter(Number.isFinite);
    if (!ys.length) return;
    const min = Math.min(...ys), max = Math.max(...ys);
    const pad = 12;
    const up = ys[ys.length - 1] >= ys[0];
    ctx.strokeStyle = up ? '#3dd68c' : '#ff6b7a';
    ctx.lineWidth = 2; ctx.beginPath();
    days.forEach((d, i) => {
      const x = pad + (i / (days.length - 1 || 1)) * (w - 2 * pad);
      const y = h - pad - ((d.equity - min) / ((max - min) || 1)) * (h - 2 * pad);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  }

  async function enrich() {
    try {
      const [posR, stR, sigR] = await Promise.all([
        fetch('/api/binance/positions', { credentials: 'same-origin' }),
        fetch('/api/binance/status', { credentials: 'same-origin' }),
        fetch('/api/binance/signals?limit=25', { credentials: 'same-origin' }),
      ]);
      if (posR.status === 401) { location.replace('/login?next=/futures'); return; }
      const pos = posR.ok ? await posR.json() : {};
      const st = stR.ok ? await stR.json() : null;
      const ev = sigR.ok ? await sigR.json() : [];

      const day = pos.daily || {};
      const ar = pos.actualReturns || {};
      const openN = (pos.open || []).length;
      const wr = (pos.closed && pos.closed.length)
        ? (100 * pos.closed.filter((t) => t.pnl > 0).length / pos.closed.length)
        : null;
      if ($('kpis')) {
        $('kpis').innerHTML = [
          ['Equity', usd(pos.equity), pos.dryRun ? 'DRY-RUN compounding' : 'LIVE compounding'],
          ["Today's P&L", usd(day.pnl) + (day.pnlPct != null ? ` (${day.pnlPct.toFixed(2)}%)` : ''), 'IST day-start'],
          ['Avg daily %', ar.meanDailyPctAllDays != null ? ((ar.meanDailyPctAllDays >= 0 ? '+' : '') + Number(ar.meanDailyPctAllDays).toFixed(3) + '%') : '—', 'closed trades · 60d'],
          ['Win rate', wr != null ? wr.toFixed(0) + '%' : '—', 'last 50 closed'],
          ['Open positions', `${day.positionsUsed ?? openN}/${day.maxPositions ?? 4}`, 'max 4'],
        ].map(([k, v, d]) => `<div class="kpi"><div class="k">${k}</div><div class="v ${String(k).includes('P&L') ? cls(day.pnl) : (k === 'Avg daily %' ? cls(ar.meanDailyPctAllDays) : '')}">${v}</div><div class="d">${d}</div></div>`).join('');
      }

      if ($('avgDaily')) {
        const pct = (x) => (x == null || !Number.isFinite(+x)) ? '—' : ((+x >= 0 ? '+' : '') + (+x).toFixed(3) + '%');
        $('avgDaily').innerHTML = [
          ['Mean daily %', pct(ar.meanDailyPctAllDays)],
          ['Compounded avg', pct(ar.geoAvgDailyPct)],
          ['Net P&L (window)', usd(ar.netPnl)],
          ['Trade / calendar days', `${ar.tradeDays ?? 0} / ${ar.calendarDays ?? 0}`],
        ].map(([k, v]) => `<div class="kpi"><div class="k">${k}</div><div class="v ${k.includes('P&L') ? cls(ar.netPnl) : ''}">${v}</div></div>`).join('');
      }

      const s = st && (st.settings || st);
      if ($('presetLine') && s) {
        const preset = s.activePreset || (st.settings && st.settings.activePreset) || '—';
        const interval = s.interval || (st.settings && st.settings.interval) || '';
        const mode = s.signalMode || (st.settings && st.settings.signalMode) || '';
        const n = s.universeCount || (s.assets || []).length || '';
        $('presetLine').textContent = `Active: ${preset} · ${interval} · ${mode} · universe ${n}`;
      }

      const rows = Array.isArray(ev) ? ev : [];
      if ($('sigFeed')) {
        $('sigFeed').innerHTML = rows.length
          ? `<table class="inst"><thead><tr><th>Time (IST)</th><th>Symbol</th><th>Side</th><th class="num">Entry</th><th class="num">SL</th><th class="num">TP</th><th>Status</th></tr></thead><tbody>` +
            rows.slice(0, 20).map((e) => `<tr>
              <td>${esc(tIST(e.ts))}</td>
              <td><b>${esc(e.symbol || e.coin || '')}</b></td>
              <td class="${String(e.direction).toUpperCase() === 'LONG' ? 'pos' : String(e.direction).toUpperCase() === 'SHORT' ? 'neg' : ''}">${esc(e.direction || '')}</td>
              <td class="num">${px(e.entry)}</td>
              <td class="num">${px(e.stop)}</td>
              <td class="num">${px(e.tp)}</td>
              <td>${esc(e.status || e.reason || e.source || '')}</td>
            </tr>`).join('') + '</tbody></table>'
          : '<p class="muted">No signals recorded yet.</p>';
      }

      if (pos.source) renderPrices(pos);
      drawCurve(Array.isArray(ar.days) ? ar.days : (Array.isArray(ar.daily) ? ar.daily : []));
    } catch (e) { console.warn(e); }
  }

  function connectSSE() {
    if (es) { try { es.close(); } catch {} }
    es = new EventSource('/api/binance/prices/stream');
    es.onmessage = (ev) => { try { renderPrices(JSON.parse(ev.data)); } catch {} };
  }

  enrich();
  connectSSE();
  setInterval(enrich, 5000);
})();
