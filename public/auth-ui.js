(function () {
  async function me() {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
      const d = await r.json().catch(() => ({}));
      if (r.status === 401 || r.status === 503) {
        if (!location.pathname.startsWith('/login')) location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search));
        return null;
      }
      return d;
    } catch { return null; }
  }
  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    location.replace('/login');
  }
  function mount(d) {
    if (!d || !d.authenticated) return;
    let bar = document.getElementById('qsAuthBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'qsAuthBar';
      bar.style.cssText = 'position:fixed;top:8px;right:10px;z-index:9999;display:flex;gap:8px;align-items:center;font:12px/1.2 var(--sans,system-ui);';
      document.body.appendChild(bar);
    }
    bar.innerHTML = '';
    const badge = document.createElement('span');
    badge.textContent = d.role === 'owner' ? 'Owner' : 'Guest · read-only';
    badge.style.cssText = 'background:' + (d.role === 'owner' ? 'rgba(76,141,255,.2)' : 'rgba(242,179,61,.15)') + ';color:#e6eaf2;border:1px solid #273042;padding:4px 8px;border-radius:999px;';
    const btn = document.createElement('button');
    btn.type = 'button'; btn.textContent = 'Log out';
    btn.style.cssText = 'background:#131823;border:1px solid #273042;color:#b3bccb;padding:4px 8px;border-radius:8px;cursor:pointer;font:12px system-ui';
    btn.onclick = logout;
    bar.appendChild(badge); bar.appendChild(btn);
    if (d.role === 'guest') {
      document.querySelectorAll('button.danger,button[data-close],#atKill,[data-owner-only]').forEach((el) => {
        el.disabled = true; el.title = 'Guest read-only';
      });
    }
  }
  me().then(mount);
  window.QSAuth = { me, logout };
})();
