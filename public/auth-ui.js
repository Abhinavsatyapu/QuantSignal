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
    // Logout lives in the shell nav. No floating guest badge.
    const bar = document.getElementById('qsAuthBar');
    if (bar) bar.remove();
  }
  me().then(mount);
  window.QSAuth = { me, logout };
})();
