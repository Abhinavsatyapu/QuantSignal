(function () {
  const PAGES = {
    futures: { section: 'futures', label: 'Futures Overview', href: '/futures' },
    positions: { section: 'futures', label: 'Positions & Orders', href: '/positions' },
    whales: { section: 'futures', label: 'Whale Footprints', href: '/whales' },
    'futures-settings': { section: 'futures', label: 'Futures Settings', href: '/futures-settings' },
    options: { section: 'options', label: 'Options Overview', href: '/options' },
    builder: { section: 'options', label: 'Options Builder', href: '/builder' },
    weekly: { section: 'options', label: 'Weekly Plan', href: '/weekly' },
    strategies: { section: 'options', label: 'Saved Strategies', href: '/strategies' },
    'options-settings': { section: 'options', label: 'Options Settings', href: '/options-settings' },
  };

  function pageId() {
    const p = (location.pathname || '/').replace(/\/+$/, '') || '/';
    if (p === '/' || p === '/index.html') return 'futures';
    const key = p.replace(/^\//, '');
    return PAGES[key] ? key : (p.includes('builder') ? 'builder' : p.includes('weekly') ? 'weekly' : p.includes('sheet') || p.includes('manual') || p.includes('lab') ? 'options' : 'futures');
  }

  function istClock() {
    try {
      return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Calcutta', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) + ' IST';
    } catch { return new Date().toISOString(); }
  }

  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function mountShell() {
    if (document.documentElement.dataset.qsShell === '1') return;
    document.documentElement.dataset.qsShell = '1';
    const id = pageId();
    const meta = PAGES[id] || PAGES.futures;
    const section = meta.section;

    // Ensure ds.css
    if (![...document.styleSheets].some(s => (s.href || '').includes('/ds.css'))) {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = '/ds.css';
      document.head.appendChild(l);
    }
    // Fonts
    if (![...document.querySelectorAll('link')].some(l => (l.href || '').includes('IBM+Plex'))) {
      const f = document.createElement('link');
      f.rel = 'stylesheet';
      f.href = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap';
      document.head.appendChild(f);
    }

    const existingTop = document.querySelector('header.top, header.deriv-top, header.topbar, .app > aside.sidebar');
    const main = document.querySelector('main') || document.body;

    const shell = el('div', 'app-shell');
    const top = el('div', 'app-top');
    top.innerHTML = `
      <div class="app-brand">QuantSignal <span>${section === 'futures' ? 'FUTURES' : 'OPTIONS'}</span></div>
      <div class="app-status" id="qsStatusBar">
        <span class="pill dry" id="qsMode">DRY-RUN</span>
        <span class="pill" id="qsEquity">Eq —</span>
        <span class="pill" id="qsDayPnl">Day —</span>
        <span class="pill" id="qsPos">Pos —/4</span>
        <span class="pill" id="qsFeed">Feed —</span>
        <span class="pill" id="qsHealth">Health —</span>
        <span class="pill mono" id="qsClock">${istClock()}</span>
      </div>`;

    const nav = el('nav', 'app-nav', '');
    const fut = [
      ['futures', 'Overview'],
      ['positions', 'Positions & Orders'],
      ['whales', 'Whale Footprints'],
      ['futures-settings', 'Futures Settings'],
    ];
    const opt = [
      ['options', 'Overview'],
      ['builder', 'Options Builder'],
      ['weekly', 'Weekly Plan'],
      ['strategies', 'Saved Strategies'],
      ['options-settings', 'Options Settings'],
    ];
    nav.innerHTML = `<div class="nav-group">Futures</div>` +
      fut.map(([k, lab]) => `<a class="${k === id ? 'active' : ''}" href="${PAGES[k].href}"><span class="label">${lab}</span></a>`).join('') +
      `<div class="nav-group">Options</div>` +
      opt.map(([k, lab]) => `<a class="${k === id ? 'active' : ''}" href="${PAGES[k].href}"><span class="label">${lab}</span></a>`).join('') +
      `<div class="nav-group">Account</div><a href="/login"><span class="label">Login / role</span></a>`;

    // Wrap body content
    const wrap = el('div', 'app-main');
    // Move children of body except scripts into wrap, then shell
    const bodyKids = [...document.body.childNodes];
    // Hide old headers/sidebars
    document.querySelectorAll('header.top, header.deriv-top, header.topbar, aside.sidebar, .scrim').forEach((n) => { n.style.display = 'none'; });

    if (main && main !== document.body) {
      // keep main, put shell around
      document.body.insertBefore(shell, document.body.firstChild);
      shell.appendChild(top);
      shell.appendChild(nav);
      shell.appendChild(wrap);
      wrap.appendChild(main);
    } else {
      document.body.insertBefore(shell, document.body.firstChild);
      shell.appendChild(top);
      shell.appendChild(nav);
      shell.appendChild(wrap);
      for (const n of bodyKids) {
        if (n === shell) continue;
        if (n.nodeType === 1 && (n.tagName === 'SCRIPT' || n.classList?.contains('app-shell'))) continue;
        if (n.nodeType === 1 && (n.matches?.('header.top, header.deriv-top, aside.sidebar'))) continue;
        wrap.appendChild(n);
      }
    }

    setInterval(() => { const c = document.getElementById('qsClock'); if (c) c.textContent = istClock(); }, 1000);
    refreshStatus(section);
    setInterval(() => refreshStatus(section), 5000);
  }

  async function refreshStatus(section) {
    const mode = document.getElementById('qsMode');
    const eq = document.getElementById('qsEquity');
    const day = document.getElementById('qsDayPnl');
    const pos = document.getElementById('qsPos');
    const feed = document.getElementById('qsFeed');
    const health = document.getElementById('qsHealth');
    try {
      if (section === 'futures') {
        const r = await fetch('/api/binance/positions', { credentials: 'same-origin' });
        if (r.ok) {
          const d = await r.json();
          if (mode) {
            mode.textContent = d.dryRun ? 'DRY-RUN' : String(d.mode || 'LIVE').toUpperCase();
            mode.className = 'pill ' + (d.dryRun ? 'dry' : 'live');
          }
          if (eq) eq.textContent = 'Eq ' + (Number.isFinite(+d.equity) ? ('$' + (+d.equity).toLocaleString('en-US', { maximumFractionDigits: 0 })) : '—');
          const pnl = d.daily && d.daily.pnl;
          if (day) {
            day.textContent = 'Day ' + (Number.isFinite(+pnl) ? ((pnl >= 0 ? '+' : '') + (+pnl).toFixed(2)) : '—');
            day.className = 'pill ' + (pnl > 0 ? 'live' : pnl < 0 ? 'stale' : '');
          }
          const used = d.daily?.positionsUsed ?? (d.open || []).length;
          const max = d.daily?.maxPositions ?? 4;
          if (pos) pos.textContent = `Pos ${used}/${max}`;
          const stale = d.stale === true || (d.ageMs != null && d.ageMs > 10000);
          if (feed) {
            feed.textContent = stale ? 'Feed STALE' : ('Feed LIVE' + (d.ageMs != null ? ` ${Math.round(d.ageMs)}ms` : ''));
            feed.className = 'pill ' + (stale ? 'stale' : 'live');
          }
        }
        try {
          const h = await fetch('/api/health', { credentials: 'same-origin' });
          if (h.ok && health) { const j = await h.json(); health.textContent = j.ok ? 'OK' : 'DEGRADED'; health.className = 'pill ' + (j.ok ? 'live' : 'stale'); }
        } catch { if (health) health.textContent = '—'; }
      } else {
        // Options context — lighter status
        if (mode) { mode.textContent = 'OPTIONS'; mode.className = 'pill dry'; }
        if (eq) eq.textContent = 'Builder';
        if (day) day.textContent = 'No futures mix';
        if (pos) pos.textContent = '—';
        if (feed) feed.textContent = 'Sheet / chain';
        try {
          const h = await fetch('/api/health', { credentials: 'same-origin' });
          if (h.ok && health) { const j = await h.json(); health.textContent = j.ok ? 'OK' : 'DEGRADED'; health.className = 'pill ' + (j.ok ? 'live' : 'stale'); }
        } catch {}
      }
    } catch (e) {
      if (health) { health.textContent = 'ERR'; health.className = 'pill stale'; }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountShell);
  else mountShell();
})();
