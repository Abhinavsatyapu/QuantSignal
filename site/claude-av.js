// Claude addition: Market regime + Stock vs perp panels on the Dashboard. No API key needed:
//  - Stock vs perp: Hyperliquid oracle price (the real stock price during US hours) vs perp mark, via this server's /api/hl/assets
//  - Market regime: daily candles of the S&P 500, Nasdaq-100, VIX, TLT and DXY perps on Hyperliquid, plus live breadth
// Does not touch ChatGPT's scripts or elements; it only adds two panels to #dashboard.
(function () {
  const dash = document.getElementById('dashboard'); if (!dash) return;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v, d = 2) => v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (v, d = 2) => v == null || !Number.isFinite(v) ? '—' : (v > 0 ? '+' : '') + v.toFixed(d) + '%';
  const cls = v => v > 0 ? 'positive' : v < 0 ? 'negative' : '';
  const clock = d => d ? new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
  const NON_STOCK = new Set(['XYZ100', 'SP500', 'GOLD', 'SILVER', 'CL', 'BRENTOIL', 'NATGAS', 'COPPER', 'PLATINUM', 'PALLADIUM', 'URANIUM', 'ALUMINIUM', 'VIX', 'DXY', 'EUR', 'JPY', 'GBP', 'JP225', 'KR200', 'DAX', 'HK50', 'CORN', 'WHEAT', 'SOY', 'COFFEE']);
  const usOpen = () => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date()).map(x => [x.type, x.value]));
    const m = (+p.hour % 24) * 60 + +p.minute; return !['Sat', 'Sun'].includes(p.weekday) && m >= 570 && m < 960; };

  const regime = document.createElement('section'); regime.className = 'panel qs-regime'; regime.id = 'qsRegime';
  regime.innerHTML = `<div class="panel-head"><div><p class="eyebrow">S&amp;P 500 · NASDAQ-100 · VOLATILITY · BONDS · BREADTH</p><h2>Market regime</h2></div><span id="qsRegimeLabel" class="qs-regime-pill">Loading…</span></div>
    <div id="qsRegimeBody" class="qs-regime-grid"><p class="market-note">Reading the market…</p></div><p id="qsRegimeWhy" class="market-note"></p>`;
  const quotes = document.createElement('section'); quotes.className = 'panel qs-quotes'; quotes.id = 'qsQuotes';
  quotes.innerHTML = `<div class="panel-head market-controls"><div><p class="eyebrow">HYPERLIQUID ORACLE vs PERP</p><h2>Stock vs perp</h2></div>
      <div class="row"><input id="qsQuoteSearch" class="search" placeholder="Search ticker" aria-label="Search ticker"><select id="qsQuoteSort" aria-label="Sort"><option value="gap">Biggest perp gap</option><option value="move">Biggest 24h move</option><option value="vol">Most traded</option><option value="az">Ticker A–Z</option></select></div></div>
    <p class="market-note"><b>Stock price</b> is Hyperliquid's oracle, which tracks the real NYSE/Nasdaq price while US markets are open. <b>Perp gap</b> is how far the perp trades above (+) or below (−) it. Refreshes every 30 seconds.</p>
    <div class="feed-meta"><span id="qsQuoteStatus">Connecting…</span><span id="qsSession"></span><span id="qsQuoteUpdated">Updated: —</span></div>
    <div class="market-scroll"><table class="market-table qs-table"><thead><tr><th>Ticker</th><th>Stock price</th><th>Perp price</th><th>Perp gap</th><th>24h change</th><th>24h volume</th><th>Funding / hr</th></tr></thead><tbody id="qsQuoteRows"><tr><td colspan="7">Waiting for data…</td></tr></tbody></table></div>`;
  dash.prepend(regime);
  const firstPanel = dash.querySelector('section.panel:not(.qs-regime)'); (firstPanel ? firstPanel.after(quotes) : dash.append(quotes));

  let rows = [], breadth = null, busy = false;
  async function getJson(u, opt) { const r = await fetch(u, opt); const j = await r.json().catch(() => ({})); if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status)); return j; }
  const big = v => v == null ? '—' : v >= 1e9 ? '$' + fmt(v / 1e9, 2) + 'B' : v >= 1e6 ? '$' + fmt(v / 1e6, 1) + 'M' : '$' + fmt(v / 1e3, 0) + 'K';

  function renderQuotes() {
    const q = (document.getElementById('qsQuoteSearch').value || '').trim().toUpperCase(), sort = document.getElementById('qsQuoteSort').value;
    const list = rows.filter(r => !q || r.ticker.includes(q)).sort(
      sort === 'az' ? (a, b) => a.ticker.localeCompare(b.ticker) : sort === 'move' ? (a, b) => Math.abs(b.chg ?? 0) - Math.abs(a.chg ?? 0)
      : sort === 'vol' ? (a, b) => (b.dayVolume ?? 0) - (a.dayVolume ?? 0) : (a, b) => Math.abs(b.gap ?? -1) - Math.abs(a.gap ?? -1));
    document.getElementById('qsQuoteRows').innerHTML = list.length ? list.map(r => `<tr><td><b>${esc(r.ticker)}</b></td><td>${r.oracle == null ? '—' : '$' + fmt(r.oracle)}</td>
      <td>${r.mark == null ? '—' : '$' + fmt(r.mark)}</td><td class="${Math.abs(r.gap ?? 0) >= 0.5 ? 'qs-gap-wide ' : ''}${cls(r.gap)}">${pct(r.gap)}</td>
      <td class="${cls(r.chg)}">${pct(r.chg)}</td><td>${big(r.dayVolume)}</td><td class="${cls(-(r.funding ?? 0))}">${r.funding == null ? '—' : (r.funding * 100).toFixed(4) + '%'}</td></tr>`).join('')
      : '<tr><td colspan="7">No matching tickers.</td></tr>';
  }

  async function loadQuotes() {
    if (busy || document.hidden || !dash.classList.contains('active')) return; busy = true;
    const st = document.getElementById('qsQuoteStatus');
    try {
      const d = await getJson('/api/hl/assets');
      rows = d.rows.filter(r => !NON_STOCK.has(r.ticker) && r.mark).map(r => ({ ...r, gap: r.oracle ? (r.mark / r.oracle - 1) * 100 : null, chg: r.prevDay ? (r.mark / r.prevDay - 1) * 100 : null }));
      const withChg = rows.filter(r => r.chg != null); breadth = withChg.length ? { up: withChg.filter(r => r.chg > 0).length, n: withChg.length } : null;
      st.textContent = `Live · ${rows.length} stock perps`; st.className = 'positive';
      const open = usOpen(); document.getElementById('qsSession').innerHTML = open ? 'US market open · oracle = live stock price' : '<span style="color:var(--amber)">US market closed · oracle uses Hyperliquid\'s own pricing until the open</span>';
      document.getElementById('qsQuoteUpdated').textContent = 'Updated: ' + clock(d.updatedAt) + (d.warning ? ' · ' + d.warning : '');
      renderQuotes();
    } catch (e) { st.className = 'error'; st.textContent = 'Unavailable · ' + e.message + ' · retrying in 30 s'; }
    finally { busy = false; }
  }

  // ---------- regime from Hyperliquid daily candles ----------
  async function daily(coin) {
    const now = Date.now();
    const c = await getJson('/api/hyperliquid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: '1d', startTime: now - 430 * 864e5, endTime: now } }) });
    return (Array.isArray(c) ? c : []).map(b => ({ t: +b.t, c: +b.c })).filter(b => Number.isFinite(b.c) && b.c > 0).sort((a, b) => a.t - b.t);
  }
  const sma = (a, n) => a.length >= n ? a.slice(-n).reduce((x, y) => x + y, 0) / n : null;
  function trendOf(rows) {
    const c = rows.map(r => r.c), last = c.at(-1), s50 = sma(c, 50), s200 = sma(c, 200);
    const r = c.slice(1).map((v, i) => Math.log(v / c[i])); const vol = k => { const x = r.slice(k - 20, k), m = x.reduce((a, b) => a + b, 0) / x.length; return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length - 1) * 365) * 100; };
    return { last, s50, s200, above50: s50 != null && last > s50, above200: s200 != null ? last > s200 : null, golden: s50 != null && s200 != null ? s50 > s200 : null,
             ret20: c.length > 20 ? (last / c.at(-21) - 1) * 100 : null, vol20: r.length >= 20 ? vol(r.length) : null, bars: c.length };
  }
  async function loadRegime() {
    if (document.hidden) return;
    const lab = document.getElementById('qsRegimeLabel'), body = document.getElementById('qsRegimeBody'), whyEl = document.getElementById('qsRegimeWhy');
    try {
      const [spx, ndx, tlt] = await Promise.all(['xyz:SP500', 'xyz:XYZ100', 'xyz:TLT'].map(c => daily(c).catch(() => [])));
      if (spx.length < 60 || ndx.length < 60) throw new Error('not enough index history yet');
      const S = trendOf(spx), N = trendOf(ndx);
      const checks = [S.above200, S.above50, S.golden, N.above200, N.above50].filter(x => x !== null);
      const trend = checks.filter(Boolean).length, trendMax = checks.length;
      // volatility: Nasdaq-100 perp 20-day realised vol vs its own history (VIX perp has no candles)
      const nc = ndx.map(b => b.c), lr = nc.slice(1).map((v, i) => Math.log(v / nc[i])), rv = [];
      for (let k = 20; k <= lr.length; k++) { const x = lr.slice(k - 20, k), m = x.reduce((a, b) => a + b, 0) / 20; rv.push(Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / 19 * 252) * 100); }
      const volNow = rv.at(-1) ?? null, volPct = rv.length > 30 ? Math.round(rv.filter(v => v <= volNow).length / rv.length * 100) : null;
      const vol = volNow == null ? 'unknown' : volPct >= 80 ? 'stressed' : volPct >= 55 ? 'elevated' : 'calm';
      const T = tlt.length > 21 ? trendOf(tlt) : null;
      const up = breadth ? breadth.up / breadth.n * 100 : null, strong = trend >= Math.ceil(trendMax * 0.8), weak = trend <= Math.floor(trendMax * 0.2);
      let label = 'Neutral';
      if (strong && vol !== 'stressed' && !(up != null && up < 35)) label = 'Risk-on';
      if (weak || (vol === 'stressed' && trend <= trendMax - 2) || (up != null && up < 25 && trend <= trendMax / 2)) label = 'Risk-off';
      lab.textContent = label; lab.className = 'qs-regime-pill ' + (label === 'Risk-on' ? 'on' : label === 'Risk-off' ? 'off' : 'mid');
      const tile = (k, v, s, c = '') => `<article><span>${k}</span><strong class="${c}">${v}</strong><small>${s}</small></article>`;
      body.innerHTML = [
        tile('Trend', `${trend} / ${trendMax}`, `S&P ${S.above200 == null ? (S.above50 ? 'above' : 'below') + ' 50-day' : (S.above200 ? 'above' : 'below') + ' 200-day'} · Nasdaq-100 ${N.above200 == null ? (N.above50 ? 'above' : 'below') + ' 50-day' : (N.above200 ? 'above' : 'below') + ' 200-day'}`, strong ? 'positive' : weak ? 'negative' : ''),
        tile('Volatility', vol[0].toUpperCase() + vol.slice(1), volNow == null ? 'unavailable' : `Nasdaq-100 20-day ${fmt(volNow, 1)}%${volPct != null ? ' · ' + volPct + 'th pct of ' + rv.length + ' days' : ''}`, vol === 'stressed' ? 'negative' : vol === 'calm' ? 'positive' : ''),
        tile('Breadth', up == null ? '—' : fmt(up, 0) + '% up', breadth ? `of ${breadth.n} stock perps, 24h` : 'waiting for prices', up == null ? '' : up >= 55 ? 'positive' : up < 35 ? 'negative' : ''),
        tile('Bonds (TLT)', T ? pct(T.ret20, 1) : '—', T ? (T.ret20 <= -3 ? 'falling: yields rising, headwind' : T.ret20 >= 3 ? 'rising: yields falling, tailwind' : 'steady yields') + ' · 20 days' : 'unavailable', T ? cls(T.ret20 <= -3 ? -1 : T.ret20 >= 3 ? 1 : 0) : ''),
        tile('Nasdaq-100 perp', fmt(N.last, 0), `${pct(N.ret20, 1)} in 20 days`, cls(N.ret20)),
        tile('S&P 500 perp', '$' + fmt(S.last), `${pct(S.ret20, 1)} in 20 days · 20-day vol ${fmt(S.vol20, 1)}%`, cls(S.ret20)),
      ].join('');
      const why = [`Trend ${trend}/${trendMax} on the S&P 500 and Nasdaq-100 perps (50- and 200-day averages)`, volNow != null ? `volatility ${vol} (${volPct}th percentile)` : null,
                   up != null ? `${fmt(up, 0)}% of stock perps up over 24h` : null, T ? `bonds ${pct(T.ret20, 1)} in 20 days` : null].filter(Boolean);
      whyEl.innerHTML = '<b>Why:</b> ' + why.map(esc).join(' · ') + ` · <span class="market-detail" style="display:inline">updated ${clock(Date.now())} · context only, not a trading rule${S.bars < 200 ? ' · S&P perp has ' + S.bars + ' days of history' : ''}</span>`;
    } catch (e) { lab.textContent = 'Unavailable'; lab.className = 'qs-regime-pill'; body.innerHTML = `<p class="market-note">${esc(e.message)} · retrying in 5 minutes</p>`; }
  }

  document.getElementById('qsQuoteSearch').addEventListener('input', renderQuotes);
  document.getElementById('qsQuoteSort').addEventListener('change', renderQuotes);
  document.querySelectorAll('.nav[data-view="dashboard"]').forEach(b => b.addEventListener('click', () => setTimeout(loadQuotes, 50)));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadQuotes(); });
  loadQuotes().then(loadRegime);
  setInterval(loadQuotes, 30000); setInterval(loadRegime, 300000);
})();
