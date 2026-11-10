'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const fmt = (n, d = 2) => (n == null || !Number.isFinite(n) ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d }));
  const usd = (n) => (n == null ? '—' : '$' + fmt(n, 0));

  function cardHtml(c) {
    if (c.error) {
      return `<article class="wcard"><h3>${c.symbol}<span class="bias NEUTRAL">ERROR</span></h3><p class="market-note">${c.error}</p></article>`;
    }
    const sc = c.score || 0;
    const scCls = sc > 0 ? 'pos' : sc < 0 ? 'neg' : '';
    const oi = c.oi || {}, r = c.ratios || {}, p = c.prints || {}, b = c.book || {};
    const prints = (p.prints || []).slice(0, 6).map((x) =>
      `<div><span class="${x.side === 'BUY' ? 'pos' : 'neg'}">${x.side}</span><span>${usd(x.notional)}</span><span>${x.tsIst || ''}</span></div>`
    ).join('') || '<div><span>No prints ≥ threshold in last window</span></div>';
    return `<article class="wcard">
      <h3>${c.symbol}<span class="bias ${c.bias}">${c.bias} <span class="score ${scCls}">${sc > 0 ? '+' : ''}${sc}</span></span></h3>
      <p class="market-note">${c.updatedAtIst || ''}</p>
      <dl>
        <dt>OI change (≈15m)</dt><dd class="${(oi.oiChangePct||0)>=0?'pos':'neg'}">${oi.oiChangePct == null ? '—' : fmt(oi.oiChangePct, 2) + '%'}</dd>
        <dt>OI (contracts)</dt><dd>${fmt(oi.openInterest, 2)}</dd>
        <dt>Taker buy share</dt><dd>${r.takerBuyRatio == null ? '—' : fmt(r.takerBuyRatio * 100, 1) + '%'}</dd>
        <dt>Top trader acct long</dt><dd>${r.topAccountLong == null ? '—' : fmt(r.topAccountLong * 100, 1) + '%'}</dd>
        <dt>Top trader pos long</dt><dd>${r.topPosLong == null ? '—' : fmt(r.topPosLong * 100, 1) + '%'}</dd>
        <dt>Global long</dt><dd>${r.globalLong == null ? '—' : fmt(r.globalLong * 100, 1) + '%'}</dd>
        <dt>Whale buy / sell notional</dt><dd>${usd(p.printBuyNotional)} / ${usd(p.printSellNotional)}</dd>
        <dt>Book walls bid / ask</dt><dd>${usd(b.wallBid)} / ${usd(b.wallAsk)}</dd>
      </dl>
      <div class="prints">${prints}</div>
    </article>`;
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
      if (!j.ok && j.error) throw new Error(j.error);
      $('upd').textContent = 'Last refresh: ' + (j.lastAtIst || '—');
      $('uni').textContent = 'Universe: ' + (j.universeSize || 0) + ' · cards ' + (j.cards || []).length;
      $('thr').textContent = 'Print ≥ $' + ((j.printNotionalUsd || 50000) / 1000) + 'k · Wall ≥ $' + ((j.wallNotionalUsd || 100000) / 1000) + 'k';
      const cards = j.cards || [];
      $('grid').innerHTML = cards.length ? cards.map(cardHtml).join('') : '<p class="market-note">No cards yet — click Refresh (batches to respect rate limits).</p>';
      if (j.thirdParty) {
        const src = [];
        src.push('Primary: Binance USD-M public REST (aggTrades, openInterest, OI hist, top-trader L/S, global L/S, taker ratio, depth).');
        src.push('Third-party: ' + j.thirdParty.map((t) => t.name + ' — ' + t.use + ' (' + t.access + '; ' + t.status + ')').join(' · '));
        $('sources').textContent = src.join(' ');
      }
      if ($('liqNote')) {
        $('liqNote').textContent = j.forceOrderNote || 'Liquidations: public REST history is not offered without auth; not fabricated.';
      }
      if (j.lastError) { $('err').hidden = false; $('err').textContent = j.lastError; }
    } catch (e) {
      $('err').hidden = false; $('err').textContent = e.message;
    }
  }

  $('btnRefresh').addEventListener('click', () => load(true));
  load(true);
  setInterval(() => load(false), 60_000);
})();
