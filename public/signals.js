(function () {
  const STALE_MS = 10000;
  const REST_MS = 5000;
  const $ = (id) => document.getElementById(id);

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtIst(ts) {
    if (!ts) return '—';
    try {
      return new Date(ts).toLocaleString('en-IN', {
        timeZone: 'Asia/Calcutta', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }) + ' IST';
    } catch { return new Date(ts).toISOString(); }
  }

  function fmtPx(n) {
    const x = Number(n);
    if (!(x > 0)) return '—';
    if (x >= 1000) return x.toFixed(2);
    if (x >= 10) return x.toFixed(3);
    return x.toFixed(4);
  }

  function sideClass(dir) {
    const d = String(dir || '').toUpperCase();
    if (d === 'LONG' || d === 'BUY') return 'side-long';
    if (d === 'SHORT' || d === 'SELL') return 'side-short';
    return '';
  }

  function chips(cond) {
    const c = cond || {};
    const bits = [
      ['trend', 'trend', c.trend],
      ['flow', 'flow', c.flow],
      ['buy-side', 'buySide', c.buySide],
    ];
    return '<span class="chips">' + bits.map(([lab, , on]) =>
      '<span class="chip' + (on ? ' on' : '') + '">' + lab + '</span>'
    ).join('') + '</span>';
  }

  function setPill(el, text, kind) {
    if (!el) return;
    el.textContent = text;
    el.classList.remove('stale', 'ok');
    if (kind) el.classList.add(kind);
  }

  let lastPrices = { marks: {}, lastUpdateAt: 0, transport: 'idle', stale: true, ageMs: null };
  let lastHealth = null;
  let lastSignals = [];
  let lastBoard = [];
  let es = null;
  let esBackoff = 1000;
  let esTimer = null;
  let restTimer = null;

  function priceAgeMs() {
    if (lastPrices.ageMs != null) return lastPrices.ageMs;
    if (!lastPrices.lastUpdateAt) return null;
    return Math.max(0, Date.now() - lastPrices.lastUpdateAt);
  }

  function isStale() {
    if (lastPrices.stale === true) return true;
    const age = priceAgeMs();
    return age == null || age > STALE_MS;
  }

  function renderHeartbeat() {
    const h = lastHealth || {};
    const stale = isStale();
    const scanAge = h.lastScanAt ? (Date.now() - h.lastScanAt) : null;
    const engineStale = !h.lastScanAt || (scanAge != null && scanAge > 180000) || !!h.lastScanError;
    setPill($('hbEngine'), engineStale ? 'Engine STALE' : 'Engine OK', engineStale ? 'stale' : 'ok');
    setPill($('hbScan'), 'Last scan ' + (h.lastScanAtIst || fmtIst(h.lastScanAt)));
    setPill($('hbBar'), 'Next 30m close ' + (h.nextBarCloseAtIst || fmtIst(h.nextBarCloseAt)));
    setPill($('hbMode'), h.dryRun === false ? 'LIVE' : 'DRY-RUN', h.dryRun === false ? 'stale' : 'ok');
    const tr = (h.prices && h.prices.transport) || lastPrices.transport || '—';
    const feedStale = stale || (h.prices && h.prices.stale);
    setPill($('hbFeed'), (feedStale ? 'STALE · ' : '') + String(tr).toUpperCase(), feedStale ? 'stale' : 'ok');
    const fresh = $('priceFresh');
    if (fresh) {
      const age = priceAgeMs();
      const label = feedStale ? 'STALE' : ('LIVE · ' + (age != null ? Math.round(age / 1000) + 's' : tr));
      setPill(fresh, label, feedStale ? 'stale' : 'ok');
    }
    const preset = h.preset || '—';
    const line = $('presetLine');
    if (line) line.textContent = 'Active preset: ' + preset + (h.interval ? ' · ' + h.interval : '') + (h.usCashOnly ? ' · US cash only' : '');
  }

  function renderTicker() {
    const marks = lastPrices.marks || {};
    const keys = Object.keys(marks).sort();
    const el = $('ticker');
    if (!el) return;
    if (!keys.length) {
      el.innerHTML = '<p class="muted">Waiting for Binance marks…</p>';
      return;
    }
    el.innerHTML = keys.map((sym) => {
      const m = marks[sym] || {};
      const px = m.markPrice || m.lastPrice || m;
      return '<div class="tick"><span class="sym">' + escapeHtml(sym.replace(/USDT$/, '')) + '</span><span class="px">' + escapeHtml(fmtPx(px)) + '</span></div>';
    }).join('');
  }

  function renderFeed() {
    const el = $('sigFeed');
    if (!el) return;
    const rows = lastSignals || [];
    if (!rows.length) {
      el.innerHTML = '<p class="muted">No signals yet — the engine logs entries and skipped setups (US cash hours, duplicates, max positions) as they fire.</p>';
      return;
    }
    const head = '<table><thead><tr><th>Time (IST)</th><th>Symbol</th><th>Side</th><th>Entry</th><th>SL</th><th>TP</th><th>R:R</th><th>Conditions</th><th>Status</th></tr></thead><tbody>';
    const body = rows.map((r) => {
      const st = r.statusLabel || r.status || 'new';
      const reason = r.reason ? ' · ' + r.reason : '';
      return '<tr>' +
        '<td>' + escapeHtml(r.tsIst || fmtIst(r.ts)) + '</td>' +
        '<td>' + escapeHtml(r.symbol) + '</td>' +
        '<td class="' + sideClass(r.direction) + '">' + escapeHtml(r.direction || '—') + '</td>' +
        '<td>' + escapeHtml(fmtPx(r.entry)) + '</td>' +
        '<td>' + escapeHtml(fmtPx(r.stop)) + '</td>' +
        '<td>' + escapeHtml(fmtPx(r.tp)) + '</td>' +
        '<td>' + escapeHtml(r.rr != null ? Number(r.rr).toFixed(2) : '—') + '</td>' +
        '<td>' + chips(r.conditions) + '</td>' +
        '<td class="st-' + escapeHtml(st) + '">' + escapeHtml(st) + escapeHtml(reason) + '</td>' +
        '</tr>';
    }).join('');
    el.innerHTML = head + body + '</tbody></table>';
  }

  function renderBoard() {
    const el = $('board');
    if (!el) return;
    const rows = lastBoard || [];
    const count = $('uniCount');
    if (count) count.textContent = rows.length ? '· ' + rows.length + ' names' : '';
    if (!rows.length) {
      el.innerHTML = '<p class="muted">Universe scans appear after the first 30m pass.</p>';
      return;
    }
    el.innerHTML = rows.map((r) => {
      const dir = r.direction;
      const side = dir ? escapeHtml(String(dir).toUpperCase()) : 'WAIT';
      const cls = dir ? sideClass(dir) : 'uni-wait';
      const skip = r.skipReason ? '<div class="muted">' + escapeHtml(r.skipReason) + '</div>' : '';
      return '<div class="uni-card"><div class="row"><span class="sym">' + escapeHtml((r.symbol || '').replace(/USDT$/, '')) + '</span><span class="' + cls + '">' + side + '</span></div>' +
        chips(r.conditions) +
        '<div class="muted">' + escapeHtml(fmtPx(r.mark)) + '</div>' + skip + '</div>';
    }).join('');
  }

  function renderAll() {
    renderHeartbeat();
    renderTicker();
    renderFeed();
    renderBoard();
  }

  function applyPayload(p) {
    if (!p) return;
    if (p.health) lastHealth = p.health;
    if (Array.isArray(p.signals)) lastSignals = p.signals;
    if (Array.isArray(p.board)) lastBoard = p.board;
    if (p.prices) lastPrices = p.prices;
    renderAll();
  }

  async function restPull() {
    try {
      const [h, s, b, p] = await Promise.all([
        fetch('/api/binance/signals/health', { credentials: 'same-origin' }).then((r) => r.ok ? r.json() : null),
        fetch('/api/binance/signals?limit=80', { credentials: 'same-origin' }).then((r) => r.ok ? r.json() : []),
        fetch('/api/binance/signals/board', { credentials: 'same-origin' }).then((r) => r.ok ? r.json() : null),
        fetch('/api/binance/prices', { credentials: 'same-origin' }).then((r) => r.ok ? r.json() : null),
      ]);
      if (h) lastHealth = h;
      if (Array.isArray(s)) lastSignals = s;
      if (b && Array.isArray(b.scans)) lastBoard = b.scans;
      else if (Array.isArray(b)) lastBoard = b;
      if (p) lastPrices = p;
      renderAll();
    } catch { /* REST retry on next tick / SSE reconnect */ }
  }

  function openStream() {
    if (es) { try { es.close(); } catch {} es = null; }
    try {
      es = new EventSource('/api/binance/signals/stream');
      es.onopen = () => { esBackoff = 1000; };
      es.onmessage = (ev) => {
        try { applyPayload(JSON.parse(ev.data)); } catch {}
      };
      es.onerror = () => {
        try { es.close(); } catch {}
        es = null;
        if (esTimer) clearTimeout(esTimer);
        esTimer = setTimeout(() => { esBackoff = Math.min(esBackoff * 2, 15000); openStream(); }, esBackoff);
      };
    } catch {
      if (esTimer) clearTimeout(esTimer);
      esTimer = setTimeout(openStream, esBackoff);
    }
  }

  openStream();
  restPull();
  restTimer = setInterval(restPull, REST_MS);
  setInterval(renderHeartbeat, 1000);
})();
