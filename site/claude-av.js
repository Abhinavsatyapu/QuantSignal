// Claude addition: Market regime + Stock vs perp panels on the Dashboard, fed by Alpha Vantage through the server.
// Does not touch ChatGPT's scripts or elements; it only adds two panels to #dashboard.
(function () {
  const dash = document.getElementById('dashboard'); if (!dash) return;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v, d = 2) => v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (v, d = 2) => v == null || !Number.isFinite(v) ? '—' : (v > 0 ? '+' : '') + v.toFixed(d) + '%';
  const cls = v => v > 0 ? 'positive' : v < 0 ? 'negative' : '';
  const time = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';

  const regime = document.createElement('section'); regime.className = 'panel qs-regime'; regime.id = 'qsRegime';
  regime.innerHTML = `<div class="panel-head"><div><p class="eyebrow">ALPHA VANTAGE · S&amp;P 500 · NASDAQ-100 · RATES · NEWS</p><h2>Market regime</h2></div><span id="qsRegimeLabel" class="qs-regime-pill">Loading…</span></div>
    <div id="qsRegimeBody" class="qs-regime-grid"><p class="market-note">Reading the market…</p></div>
    <p id="qsRegimeWhy" class="market-note"></p>`;
  const quotes = document.createElement('section'); quotes.className = 'panel qs-quotes'; quotes.id = 'qsQuotes';
  quotes.innerHTML = `<div class="panel-head market-controls"><div><p class="eyebrow">ALPHA VANTAGE · NYSE / NASDAQ vs HYPERLIQUID</p><h2>Stock vs perp</h2></div>
      <div class="row"><input id="qsQuoteSearch" class="search" placeholder="Search ticker" aria-label="Search ticker"><select id="qsQuoteSort" aria-label="Sort"><option value="gap">Biggest perp gap</option><option value="move">Biggest stock move</option><option value="az">Ticker A–Z</option></select></div></div>
    <p class="market-note">The real stock price from the exchange next to the Hyperliquid perp price. <b>Perp gap</b> = how far the perp trades above (+) or below (−) the stock. Refreshes every 60 seconds while this page is open.</p>
    <div class="feed-meta"><span id="qsQuoteStatus">Connecting…</span><span id="qsQuoteUpdated">Updated: —</span><span id="qsQuoteFeed"></span></div>
    <div class="market-scroll"><table class="market-table qs-table"><thead><tr><th>Ticker</th><th>Stock price</th><th>Stock today</th><th>Perp price</th><th>Perp gap</th><th>Stock time</th></tr></thead><tbody id="qsQuoteRows"><tr><td colspan="6">Waiting for data…</td></tr></tbody></table></div>`;
  dash.prepend(regime);
  const firstPanel = dash.querySelector('section.panel:not(.qs-regime)'); (firstPanel ? firstPanel.after(quotes) : dash.append(quotes));

  let rows = [], lastBreadth = null, busy = false;
  async function getJson(u) { const r = await fetch(u, { headers: { accept: 'application/json' } }); const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.error || ('HTTP ' + r.status)), { status: r.status }); return j; }

  function renderQuotes() {
    const q = (document.getElementById('qsQuoteSearch').value || '').trim().toUpperCase(), sort = document.getElementById('qsQuoteSort').value;
    let list = rows.filter(r => !q || r.ticker.includes(q));
    list.sort(sort === 'az' ? (a, b) => a.ticker.localeCompare(b.ticker) : sort === 'move' ? (a, b) => Math.abs(b.chg ?? 0) - Math.abs(a.chg ?? 0) : (a, b) => Math.abs(b.gap ?? -1) - Math.abs(a.gap ?? -1));
    document.getElementById('qsQuoteRows').innerHTML = list.length ? list.map(r => `<tr><td><b>${esc(r.ticker)}</b><span class="market-detail">${esc(r.name || '')}</span></td>
      <td>${r.stock == null ? '<span class="market-detail">no quote</span>' : '$' + fmt(r.stock)}</td><td class="${cls(r.chg)}">${pct(r.chg)}</td><td>${r.perp == null ? '—' : '$' + fmt(r.perp)}</td>
      <td class="${Math.abs(r.gap ?? 0) >= 0.5 ? 'qs-gap-wide ' : ''}${cls(r.gap)}">${pct(r.gap, 2)}</td><td>${esc(r.time ? String(r.time).slice(11, 16) || r.time : '—')}</td></tr>`).join('') : '<tr><td colspan="6">No matching tickers.</td></tr>';
  }

  async function loadQuotes() {
    if (busy || document.hidden || !dash.classList.contains('active')) return; busy = true;
    const st = document.getElementById('qsQuoteStatus');
    try {
      const perps = await getJson('/api/stocks');
      const universe = (perps.rows || []).filter(r => r.kind !== 'etf' || true).map(r => ({ ticker: String(r.ticker || r.symbol || '').replace(/^.*:/, '').toUpperCase(), name: r.name, perp: Number(r.price) }))
        .filter(r => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(r.ticker));
      const uniq = [...new Map(universe.map(r => [r.ticker, r])).values()];
      const av = await getJson('/api/av/quotes?symbols=' + encodeURIComponent(uniq.map(r => r.ticker).join(',')));
      const byT = new Map((av.quotes || []).map(x => [x.symbol, x]));
      rows = uniq.map(r => { const x = byT.get(r.ticker) || {}; const stock = x.price ?? null;
        return { ...r, stock, chg: x.changePct ?? null, time: x.time, gap: stock && r.perp ? (r.perp / stock - 1) * 100 : null }; });
      const quoted = rows.filter(r => r.chg != null); lastBreadth = quoted.length ? { up: quoted.filter(r => r.chg > 0).length, n: quoted.length } : null;
      st.textContent = `Live · ${quoted.length} of ${rows.length} stocks quoted`; st.className = 'positive';
      document.getElementById('qsQuoteUpdated').textContent = 'Updated: ' + time(av.updatedAt);
      document.getElementById('qsQuoteFeed').textContent = 'Feed: ' + (av.entitlement === 'realtime' ? 'real-time' : '15-min delayed') + (av.warning ? ' · ' + av.warning : '');
      renderQuotes();
    } catch (e) {
      st.className = 'error'; st.textContent = e.status === 503 ? 'Alpha Vantage key not set on the server yet.' : 'Unavailable · ' + e.message;
      if (e.status === 503) document.getElementById('qsQuoteRows').innerHTML = '<tr><td colspan="6">Add <code>ALPHAVANTAGE_API_KEY</code> in Render → quantsignal-chatgpt → Environment, then reload.</td></tr>';
    } finally { busy = false; }
  }

  async function loadRegime() {
    if (document.hidden) return;
    const lab = document.getElementById('qsRegimeLabel'), body = document.getElementById('qsRegimeBody'), why = document.getElementById('qsRegimeWhy');
    try {
      const d = await getJson('/api/av/regime' + (lastBreadth ? `?up=${lastBreadth.up}&n=${lastBreadth.n}` : ''));
      lab.textContent = d.label; lab.className = 'qs-regime-pill ' + (d.label === 'Risk-on' ? 'on' : d.label === 'Risk-off' ? 'off' : 'mid');
      const tile = (k, v, s, c = '') => `<article><span>${k}</span><strong class="${c}">${v}</strong><small>${s}</small></article>`;
      body.innerHTML = [
        tile('Trend', d.trend + ' / 5', `S&P ${d.spy.above200 ? 'above' : 'below'} 200-day · Nasdaq-100 ${d.qqq.above200 ? 'above' : 'below'}`, d.trend >= 4 ? 'positive' : d.trend <= 1 ? 'negative' : ''),
        tile('Volatility', d.vol[0].toUpperCase() + d.vol.slice(1), `SPY 20-day ${fmt(d.spy.vol20, 1)}% · ${d.spy.volPctile}th pct of year`, d.vol === 'stressed' ? 'negative' : d.vol === 'calm' ? 'positive' : ''),
        tile('Breadth', d.breadth ? fmt(d.breadth.upPct, 0) + '% up' : '—', d.breadth ? `of ${d.breadth.n} stock perps today` : 'waiting for quotes', d.breadth ? (d.breadth.upPct >= 55 ? 'positive' : d.breadth.upPct < 35 ? 'negative' : '') : ''),
        tile('10-yr yield', d.rates ? fmt(d.rates.y10) + '%' : '—', d.rates ? `${d.rates.chg20bp >= 0 ? '+' : ''}${d.rates.chg20bp} bp in 20 days` : 'unavailable', d.rates && d.rates.chg20bp >= 25 ? 'negative' : ''),
        tile('News mood', d.news ? (d.news.score >= 0.15 ? 'Bullish' : d.news.score <= -0.15 ? 'Bearish' : 'Neutral') : '—', d.news ? `score ${fmt(d.news.score)} · ${d.news.articles} articles` : 'unavailable', d.news ? cls(d.news.score >= 0.15 ? 1 : d.news.score <= -0.15 ? -1 : 0) : ''),
        tile('S&P 500 (SPY)', '$' + fmt(d.spy.price), `${pct(d.spy.ret20, 1)} in 20 days · close ${esc(d.spy.date)}`, cls(d.spy.ret20)),
      ].join('');
      why.innerHTML = '<b>Why:</b> ' + d.why.map(esc).join(' · ') + ` · <span class="market-detail" style="display:inline">updated ${time(d.updatedAt)} · context only, not a trading rule</span>`;
    } catch (e) {
      lab.textContent = 'Unavailable'; lab.className = 'qs-regime-pill';
      body.innerHTML = `<p class="market-note">${e.status === 503 ? 'Add your Alpha Vantage key on Render (<code>ALPHAVANTAGE_API_KEY</code>) to turn this on.' : esc(e.message)}</p>`;
    }
  }

  document.getElementById('qsQuoteSearch').addEventListener('input', renderQuotes);
  document.getElementById('qsQuoteSort').addEventListener('change', renderQuotes);
  document.querySelectorAll('.nav[data-view="dashboard"]').forEach(b => b.addEventListener('click', () => setTimeout(() => { loadQuotes(); }, 50)));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadQuotes(); } });
  loadQuotes().then(loadRegime);
  setInterval(loadQuotes, 60000); setInterval(loadRegime, 300000);
})();
