(function () {
  const PAGES = {
    futures: { section: 'futures', label: 'Futures Overview', href: '/futures' },
    positions: { section: 'futures', label: 'Positions & Orders', href: '/positions' },
    whales: { section: 'futures', label: 'Whale Footprints', href: '/whales' },
    'futures-settings': { section: 'futures', label: 'Futures Settings', href: '/futures-settings' },
    builder: { section: 'options', label: 'Options Builder', href: '/builder' },
    weekly: { section: 'options', label: 'Weekly Plan', href: '/weekly' },
    strategies: { section: 'options', label: 'Saved Strategies', href: '/strategies' },
    'options-settings': { section: 'options', label: 'Options Settings', href: '/options-settings' },
    manual: { section: 'options', label: 'Labs', href: '/manual' },
    'sheet-lab': { section: 'options', label: 'Sheet Lab', href: '/sheet-lab' },
  };

  function pageId() {
    const p = (location.pathname || '/').replace(/\/+$/, '') || '/';
    if (p === '/' || p === '/index.html') return 'futures';
    const key = p.replace(/^\//, '');
    return PAGES[key] ? key : (p.includes('builder') ? 'builder' : p.includes('weekly') ? 'weekly' : p.includes('sheet') || p.includes('manual') || p.includes('lab') ? 'manual' : 'futures');
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

  async function logout() {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
    location.replace('/login');
  }

  function mountShell() {
    if (document.documentElement.dataset.qsShell === '1') return;
    document.documentElement.dataset.qsShell = '1';
    document.documentElement.classList.add('qs-shell-on');
    const id = pageId();
    const meta = PAGES[id] || PAGES.futures;
    const section = meta.section;

    if (![...document.styleSheets].some((s) => (s.href || '').includes('/ds.css'))) {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = '/ds.css';
      document.head.appendChild(l);
    }
    if (![...document.querySelectorAll('link')].some((l) => (l.href || '').includes('IBM+Plex'))) {
      const f = document.createElement('link');
      f.rel = 'stylesheet';
      f.href = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap';
      document.head.appendChild(f);
    }

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
      ['positions', 'Positions &amp; Orders'],
      ['whales', 'Whale Footprints'],
      ['futures-settings', 'Settings'],
    ];
    const opt = [
      ['builder', 'Builder'],
      ['weekly', 'Weekly Plan'],
      ['strategies', 'Saved Strategies'],
      ['options-settings', 'Settings'],
    ];
    nav.innerHTML = `<div class="nav-group">Futures</div>` +
      fut.map(([k, lab]) => `<a class="${k === id ? 'active' : ''}" href="${PAGES[k].href}"><span class="nav-ico" aria-hidden="true"></span><span class="nav-text">${lab}</span></a>`).join('') +
      `<div class="nav-group">Options</div>` +
      opt.map(([k, lab]) => `<a class="${k === id ? 'active' : ''}" href="${PAGES[k].href}"><span class="nav-ico" aria-hidden="true"></span><span class="nav-text">${lab}</span></a>`).join('') +
      `<div class="nav-foot"><button type="button" class="nav-logout" id="qsLogout">Log out</button></div>`;

    const wrap = el('div', 'app-main');
    document.querySelectorAll('header.top, header.deriv-top, header.topbar, aside.sidebar, .scrim').forEach((n) => { n.style.display = 'none'; });

    if (main && main !== document.body) {
      document.body.insertBefore(shell, document.body.firstChild);
      shell.appendChild(top);
      shell.appendChild(nav);
      shell.appendChild(wrap);
      wrap.appendChild(main);
    } else {
      const bodyKids = [...document.body.childNodes];
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

    const out = document.getElementById('qsLogout');
    if (out) out.addEventListener('click', logout);

    setInterval(() => { const c = document.getElementById('qsClock'); if (c) c.textContent = istClock(); }, 1000);
    refreshStatus();
    setInterval(refreshStatus, 5000);
  }

  function usd(v) {
    if (!Number.isFinite(+v)) return '—';
    return (v < 0 ? '−' : '') + '$' + Math.abs(+v).toLocaleString('en-US', { maximumFractionDigits: 0 });
  }

  async function refreshStatus() {
    const mode = document.getElementById('qsMode');
    const eq = document.getElementById('qsEquity');
    const day = document.getElementById('qsDayPnl');
    const pos = document.getElementById('qsPos');
    const feed = document.getElementById('qsFeed');
    const health = document.getElementById('qsHealth');
    try {
      const [pr, hr, pxr] = await Promise.all([
        fetch('/api/binance/positions', { credentials: 'same-origin' }),
        fetch('/health', { credentials: 'same-origin' }).catch(() => null),
        fetch('/api/binance/prices', { credentials: 'same-origin' }).catch(() => null),
      ]);
      if (pr && pr.ok) {
        const d = await pr.json();
        if (mode) {
          mode.textContent = d.dryRun ? 'DRY-RUN' : String(d.mode || 'LIVE').toUpperCase();
          mode.className = 'pill ' + (d.dryRun ? 'dry' : 'live');
        }
        if (eq) eq.textContent = 'Eq ' + usd(d.equity);
        const pnl = d.daily && d.daily.pnl;
        if (day) {
          day.textContent = 'Day ' + (Number.isFinite(+pnl) ? ((pnl >= 0 ? '+' : '') + (+pnl).toFixed(2)) : '—');
          day.className = 'pill ' + (pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : '');
        }
        const used = d.daily?.positionsUsed ?? (d.open || []).length;
        const max = d.daily?.maxPositions ?? 4;
        if (pos) pos.textContent = `Pos ${used}/${max}`;
        let ageMs = d.ageMs;
        let stale = d.stale === true || (ageMs != null && ageMs > 10000);
        if (pxr && pxr.ok) {
          try {
            const px = await pxr.json();
            if (px.ageMs != null) ageMs = px.ageMs;
            if (px.stale === true || (px.ageMs != null && px.ageMs > 10000) || !px.lastUpdateAt) stale = true;
            else if (px.ageMs != null) stale = px.ageMs > 10000;
          } catch {}
        }
        if (feed) {
          feed.textContent = stale ? 'Feed STALE' : ('Feed LIVE' + (ageMs != null ? ` ${Math.round(ageMs / 100) / 10}s` : ''));
          feed.className = 'pill ' + (stale ? 'stale' : 'live');
        }
      } else if (pr && (pr.status === 401 || pr.status === 503)) {
        if (!location.pathname.startsWith('/login')) location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search));
        return;
      }
      if (hr && hr.ok && health) {
        const j = await hr.json();
        health.textContent = j.ok ? 'OK' : 'DEGRADED';
        health.className = 'pill ' + (j.ok ? 'live' : 'stale');
      }
    } catch {
      if (health) { health.textContent = 'ERR'; health.className = 'pill stale'; }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountShell);
  else mountShell();
})();
