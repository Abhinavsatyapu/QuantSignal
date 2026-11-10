(function () {
  var form = document.getElementById('f');
  if (!form) return;
  var nextField = form.elements.namedItem('next');
  var err = document.getElementById('err');
  var btn = document.getElementById('btn');
  function safeNext(raw) {
    var s = String(raw || '');
    if (s.indexOf('/') !== 0 || s.indexOf('//') === 0) return '/futures';
    return s;
  }
  var next = safeNext((nextField && nextField.value) || '/futures');
  form.addEventListener('submit', function (e) {
    if (typeof fetch !== 'function') return;
    e.preventDefault();
    if (err) err.textContent = '';
    if (btn) btn.disabled = true;
    var pw = document.getElementById('pw');
    fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ password: pw ? pw.value : '' })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { r: r, d: d }; });
    }).then(function (x) {
      if (!x.r.ok) {
        if (err) err.textContent = x.d.error || ('Login failed (' + x.r.status + ')');
        if (btn) btn.disabled = false;
        return;
      }
      if (x.d.role && x.d.role !== 'owner') {
        if (err) err.textContent = 'Owner login required';
        if (btn) btn.disabled = false;
        return;
      }
      location.replace(safeNext((nextField && nextField.value) || next));
    }).catch(function () {
      // Fetch blocked (CSP / Cloudflare / network): native form POST works without JS.
      form.submit();
    });
  });
  fetch('/api/auth/me', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
    if (d.authenticated && d.role === 'owner') location.replace(next);
    if (d.configured === false && err && !err.textContent) err.textContent = 'Server locked: OWNER_PASSWORD is not set.';
  }).catch(function () {});
})();
