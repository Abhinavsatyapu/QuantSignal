'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const fmt = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d }));
  const usd = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : '$' + fmt(n, 0));
  const pct = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : fmt(n * 100, 1) + '%');
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function srcLine(src) {
    if (!src) return '';
    const bits = [src.name, src.asOf, src.lag].filter(Boolean);
    return esc(bits.join(' · ')) + (src.note ? '<div class="caveat">' + esc(src.note) + '</div>' : '');
  }

  function cardHtml(c) {
    if (c.error) {
      return '<article class="wcard"><h3>' + esc(c.symbol) + '</h3><p class="muted">' + esc(c.error) + '</p></article>';
    }
    const oi = c.oi || {}, r = c.ratios || {}, p = c.prints || {}, b = c.book || {}, liq = c.liq || {};
    const prints = (p.prints || []).slice(0, 5).map((x) =>
      '<div><span class="' + (x.side === 'BUY' ? 'pos' : 'neg') + '">' + esc(x.side) + '</span><span>' + usd(x.notional) + '</span><span>' + esc(x.tsIst || '') + '</span></div>'
    ).join('') || '<div><span>No prints ≥ threshold in the last window</span></div>';
    const clusters = (p.clusters || []).slice(0, 4).map((x) =>
      '<div><span class="' + (x.side === 'BUY' ? 'pos' : 'neg') + '">' + esc(x.side) + ' ×' + esc(x.prints) + '</span><span>' + usd(x.notional) + ' @ ' + esc(x.price) + '</span></div>'
    ).join('');
    const walls = (b.persistentWalls || []).slice(0, 4).map((x) =>
      '<div><span>' + esc(x.side) + '</span><span>' + usd(x.notional) + ' @ ' + esc(x.price) + ' · ' + esc(x.snapshots) + ' snaps</span></div>'
    ).join('');
    const liqs = (liq.liquidations || []).slice(0, 3).map((x) =>
      '<div><span>' + esc(x.side) + '</span><span>' + usd(x.notional) + '</span><span>' + esc(x.tsIst || '') + '</span></div>'
    ).join('');
    return '<article class="wcard">' +
      '<h3>' + esc(c.symbol) + '</h3>' +
      '<p class="muted">' + esc(c.updatedAtIst || '') + '</p>' +
      '<dl>' +
      '<dt>OI change (≈15m)</dt><dd class="' + ((oi.oiChangePct || 0) >= 0 ? 'pos' : 'neg') + '">' + (oi.oiChangePct == null ? '—' : fmt(oi.oiChangePct, 2) + '%') + '</dd>' +
      '<dt>OI (contracts)</dt><dd>' + fmt(oi.openInterest, 2) + '</dd>' +
      '<dt>Taker buy share</dt><dd>' + (r.takerBuyRatio == null ? '—' : fmt(r.takerBuyRatio * 100, 1) + '%') + '</dd>' +
      '<dt>Top trader acct long</dt><dd>' + (r.topAccountLong == null ? '—' : fmt(r.topAccountLong * 100, 1) + '%') + '</dd>' +
      '<dt>Top trader pos long</dt><dd>' + (r.topPosLong == null ? '—' : fmt(r.topPosLong * 100, 1) + '%') + '</dd>' +
      '<dt>Global long</dt><dd>' + (r.globalLong == null ? '—' : fmt(r.globalLong * 100, 1) + '%') + '</dd>' +
      '<dt>Whale buy / sell</dt><dd>' + usd(p.printBuyNotional) + ' / ' + usd(p.printSellNotional) + '</dd>' +
      '<dt>Persistent walls bid/ask</dt><dd>' + usd(b.wallBid) + ' / ' + usd(b.wallAsk) + '</dd>' +
      '</dl>' +
      '<div class="prints">' + prints + '</div>' +
      (clusters ? '<div class="clusters"><strong>Clusters</strong>' + clusters + '</div>' : '') +
      (walls ? '<div class="clusters"><strong>Persistent walls</strong>' + walls + '</div>' : '<div class="muted" style="font-size:11px;margin-top:6px">Walls need two snapshots before they are shown as persistent.</div>') +
      (liqs ? '<div class="clusters"><strong>Liquidations</strong>' + liqs + '</div>' : '') +
      '</article>';
  }

  function renderLiq(fo) {
    const el = $('liqTape');
    if (!el) return;
    if (!fo) { el.innerHTML = '<p class="muted">Liquidation tape unavailable.</p>'; return; }
    const rows = fo.recent || [];
    const head = '<div class="muted">' + esc(fo.source || 'Binance !forceOrder@arr') +
      ' · ' + esc(fo.transport || '—') +
      (fo.count48h != null ? ' · ' + fo.count48h + ' prints / 48h' : '') +
      '</div>';
    if (!rows.length) {
      el.innerHTML = head + '<p class="muted">' + esc(fo.note || 'No liquidations captured in this window.') + '</p>';
      return;
    }
    el.innerHTML = head + rows.slice(0, 16).map((x) =>
      '<div><span>' + esc(x.symbol) + '</span><span class="' + (/SELL/.test(x.side) ? 'neg' : 'pos') + '">' + esc(x.side) + '</span><span>' + usd(x.notional) + '</span><span>' + esc(x.tsIst || '') + '</span></div>'
    ).join('');
  }

  let selected = 'AAPL';
  function tickersFrom(j) {
    const set = new Set(['AAPL', 'NVDA', 'TSLA', 'HOOD']);
    const add = (obj) => { if (obj) Object.keys(obj).forEach((k) => set.add(k)); };
    add(j.panels && j.panels.short && j.panels.short.shortVolume);
    add(j.panels && j.panels.ats && j.panels.ats.byTicker);
    add(j.panels && j.panels.institutional && j.panels.institutional.form4);
    add(j.panels && j.panels.options && j.panels.options.byTicker);
    add(j.panels && j.panels.institutional && j.panels.institutional.thirteenF && j.panels.institutional.thirteenF.byTicker);
    return [...set];
  }
  function tabs(id, list) {
    return '<div class="tick-tabs" id="' + id + '">' + list.map((t) =>
      '<button type="button" data-t="' + esc(t) + '" class="' + (t === selected ? 'on' : '') + '">' + esc(t) + '</button>'
    ).join('') + '</div>';
  }
  function bindTabs(id) {
    const root = $(id);
    if (!root) return;
    root.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => { selected = b.getAttribute('data-t'); if (window.__whalesLast) renderPanels(window.__whalesLast); });
    });
  }

  function renderShort(p, list) {
    $('shortMeta').innerHTML = srcLine(p && p.source);
    const vol = (p && p.shortVolume) || {};
    const si = (p && p.shortInterest && p.shortInterest.rows) || {};
    const api = (p && p.apiShortVolume) || {};
    const t = selected;
    const v = vol[t] || {};
    const s = si[t] || {};
    const a = api[t] || {};
    const ratio = v.shortRatioOffExchange != null ? v.shortRatioOffExchange : a.shortRatioOffExchange;
    const body = tabs('shortTabs', list) +
      '<table><tbody>' +
      '<tr><th>Off-exchange short ratio</th><td>' + (ratio == null ? '—' : pct(ratio)) + '</td></tr>' +
      '<tr><th>Short volume / total (off-exch.)</th><td>' + fmt(v.shortVolume, 0) + ' / ' + fmt(v.totalVolume, 0) + '</td></tr>' +
      '<tr><th>Short interest (shares)</th><td>' + fmt(s.currentShortPositionQuantity, 0) + '</td></tr>' +
      '<tr><th>Prev SI / change</th><td>' + fmt(s.previousShortPositionQuantity, 0) + ' / ' + (s.changePercent == null ? '—' : fmt(Number(s.changePercent), 2) + '%') + '</td></tr>' +
      '<tr><th>Days to cover</th><td>' + fmt(s.daysToCover, 2) + '</td></tr>' +
      '<tr><th>SI settlement</th><td>' + esc((p.shortInterest && p.shortInterest.settlementDate) || '—') + '</td></tr>' +
      '</tbody></table>' +
      '<p class="caveat">' + esc((p.caveats || [])[0] || 'Short volume is not short interest.') + '</p>';
    $('shortBody').innerHTML = body;
    bindTabs('shortTabs');
  }

  function renderAts(p, list) {
    $('atsMeta').innerHTML = srcLine(p && p.source);
    const rec = ((p && p.byTicker) || {})[selected] || {};
    const buckets = rec.buckets || {};
    const ats = buckets.ATS || {};
    const otc = buckets.OTC_WHOLESALE || {};
    const topA = (ats.venues || [])[0];
    const topW = (otc.venues || [])[0];
    $('atsBody').innerHTML = tabs('atsTabs', list) +
      '<table><tbody>' +
      '<tr><th>Week starting</th><td>' + esc(rec.weekStartDate || p.weekStartDate || '—') + '</td></tr>' +
      '<tr><th>Published</th><td>' + esc(rec.initialPublishedDate || p.publishedDate || '—') + '</td></tr>' +
      '<tr><th>ATS shares / notional</th><td>' + fmt(ats.shares, 0) + ' / ' + usd(ats.notional) + '</td></tr>' +
      '<tr><th>Top ATS</th><td>' + esc(topA ? (topA.name || topA.mpid) : '—') + '</td></tr>' +
      '<tr><th>Wholesaler shares / notional</th><td>' + fmt(otc.shares, 0) + ' / ' + usd(otc.notional) + '</td></tr>' +
      '<tr><th>Top wholesaler</th><td>' + esc(topW ? (topW.name || topW.mpid) : '—') + '</td></tr>' +
      '</tbody></table>' +
      '<p class="caveat">Wholesaler volume is internalization, not a dark pool.</p>';
    bindTabs('atsTabs');
  }

  function renderInst(p, list) {
    $('instMeta').innerHTML = srcLine(p && p.source);
    const f13 = ((p && p.thirteenF && p.thirteenF.byTicker) || {})[selected];
    const form4 = ((p && p.form4) || {})[selected];
    const s13 = ((p && p.sched13) || {})[selected];
    let html = tabs('instTabs', list);
    if (f13) {
      html += '<h3 style="font-size:14px;margin:8px 0">13F top holders</h3><div class="table-wrap"><table><thead><tr><th>#</th><th>Manager</th><th>Shares</th><th>Value</th></tr></thead><tbody>';
      (f13.top10 || []).forEach((m, i) => {
        html += '<tr><td>' + (i + 1) + '</td><td>' + esc(m.manager) + '</td><td>' + fmt(m.shares, 0) + '</td><td>' + usd(m.value) + '</td></tr>';
      });
      html += '</tbody></table></div><p class="caveat">' + esc((p.thirteenF && (p.thirteenF.asOfNote || p.thirteenF.periodOfReport)) || 'Lagged 13F holdings. Index sponsors usually top the list.') + '</p>';
    }
    if (form4 && !form4.error) {
      const own = ((form4.owners || [])[0] || {});
      const txs = (form4.transactions || []).map((tx) => esc(tx.code) + ' ' + esc(tx.shares) + ' @ ' + esc(tx.price) + ' (' + esc(tx.acquiredOrDisposed) + ')').join('; ');
      html += '<h3 style="font-size:14px;margin:12px 0 6px">Latest Form 4</h3><p>' +
        esc(form4.filingDate || '') + ' · ' + esc(own.name || '') + (own.officerTitle ? ' (' + esc(own.officerTitle) + ')' : '') +
        (String(form4.aff10b5One) === 'true' || form4.aff10b5One === '1' ? ' · 10b5-1' : '') +
        '<br>' + esc(txs || 'No coded transactions') + '</p>';
    }
    if (s13) {
      html += '<h3 style="font-size:14px;margin:12px 0 6px">' + esc(s13.form || s13.submissionType || '13D/G') + '</h3>';
      if (s13.matchedIssuer === false) {
        html += '<p class="caveat">' + esc(s13.skipReason || 'Issuer CIK/CUSIP did not match — not shown as this stock.') + '</p>';
      } else {
        html += '<p>' + esc(s13.reportingPersonName || '') + ' · ' + esc(s13.aggregateShares || '') + ' shares' +
          (s13.percentOfClass ? ' (' + esc(s13.percentOfClass) + '%)' : '') +
          '<br>Event ' + esc(s13.eventDate || '—') + ' · filed ' + esc(s13.filingDate || '—') +
          (s13.rule ? ' · ' + esc(s13.rule) : '') + '</p>';
      }
    }
    if (!f13 && !form4 && !s13) html += '<p class="muted">No filings cached yet — the server fills this from EDGAR in the background.</p>';
    $('instBody').innerHTML = html;
    bindTabs('instTabs');
  }

  function renderOpt(p, list) {
    $('optMeta').innerHTML = srcLine(p && p.source);
    const rec = ((p && p.byTicker) || {})[selected] || {};
    const und = rec.underlying || {};
    let html = tabs('optTabs', list);
    html += '<p class="caveat">Last trade ' + esc(und.last_trade_time || '—') + ' · spot ' + esc(und.current_price) + ' · unusual ' + esc(rec.unusualCount) + ' / live ' + esc(rec.liveContracts) + '. ' + esc(rec.definition || (p.notes && p.notes[0]) || 'Delayed screen, not a live tape.') + '</p>';
    const rows = rec.unusualTop || [];
    if (rows.length) {
      html += '<div class="table-wrap"><table><thead><tr><th>Contract</th><th>CP</th><th>Expiry</th><th>Strike</th><th>Vol</th><th>OI</th><th>Vol/OI</th><th>Premium</th></tr></thead><tbody>';
      rows.slice(0, 8).forEach((r) => {
        html += '<tr><td>' + esc(r.contract) + '</td><td>' + esc(r.cp) + '</td><td>' + esc(r.expiry) + '</td><td>' + esc(r.strike) + '</td><td>' + fmt(r.volume, 0) + '</td><td>' + fmt(r.openInterest, 0) + '</td><td>' + (r.volumeToOi == null ? '—' : fmt(r.volumeToOi, 2)) + '</td><td>' + usd(r.premiumUsd) + '</td></tr>';
      });
      html += '</tbody></table></div>';
    } else {
      html += '<p class="muted">' + esc(rec.error || 'No unusual contracts in this delayed snapshot (or the screen has not loaded yet).') + '</p>';
    }
    $('optBody').innerHTML = html;
    bindTabs('optTabs');
  }

  function renderPanels(j) {
    const list = tickersFrom(j);
    if (!list.includes(selected)) selected = list[0] || 'AAPL';
    const p = j.panels || {};
    if (p.perp && p.perp.source) $('perpMeta').innerHTML = srcLine(p.perp.source);
    renderLiq(j.liquidations || (p.perp && p.perp.liquidations));
    renderShort(p.short || {}, list);
    renderAts(p.ats || {}, list);
    renderInst(p.institutional || {}, list);
    renderOpt(p.options || {}, list);
  }

  async function load(force) {
    $('err').hidden = true;
    try {
      if (force) {
        await fetch('/api/binance/whales/refresh', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
      }
      const r = await fetch('/api/binance/whales', { credentials: 'same-origin' });
      if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent('/whales'); return; }
      const j = await r.json();
      window.__whalesLast = j;
      if (!j.ok && j.error) throw new Error(j.error);
      $('upd').textContent = 'Last refresh: ' + (j.lastAtIst || '—');
      $('uni').textContent = 'Universe: ' + (j.universeSize || 0) + ' · cards ' + (j.cards || []).length;
      $('thr').textContent = 'Print ≥ $' + ((j.printNotionalUsd || 50000) / 1000) + 'k · Wall ≥ $' + ((j.wallNotionalUsd || 100000) / 1000) + 'k';
      const cards = j.cards || [];
      $('grid').innerHTML = cards.length ? cards.map(cardHtml).join('') : '<p class="muted">No perp cards yet — click Refresh (batches respect rate limits). Institutional panels still load from cache.</p>';
      renderPanels(j);
      if (j.lastError) { $('err').hidden = false; $('err').textContent = j.lastError; }
    } catch (e) {
      $('err').hidden = false; $('err').textContent = e.message;
    }
  }

  $('btnRefresh').addEventListener('click', () => load(true));
  load(false);
  setInterval(() => load(false), 60_000);
})();
