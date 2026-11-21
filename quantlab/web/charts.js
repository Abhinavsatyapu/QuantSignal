// Minimal SVG charts: line (multi-series, crosshair tooltip), bars (per-bar tooltip), monthly heatmap.
// One y-axis per chart; text uses text colours, series colour only on marks.
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const tip = () => document.getElementById('tip');
  const el = (n, a = {}, p) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); if (p) p.appendChild(e); return e; };
  function ticks(lo, hi, n = 5) {
    if (!(hi > lo)) { hi = lo + 1; }
    const span = hi - lo, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= n) || mag * 10;
    const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-12; v += step) out.push(+v.toFixed(10));
    return out;
  }
  function showTip(ev, html) { const t = tip(); t.innerHTML = html; t.hidden = false; const w = t.offsetWidth, h = t.offsetHeight;
    let x = ev.clientX + 14, y = ev.clientY + 14; if (x + w > innerWidth - 8) x = ev.clientX - w - 14; if (y + h > innerHeight - 8) y = ev.clientY - h - 14; t.style.left = x + 'px'; t.style.top = y + 'px'; }
  function hideTip() { tip().hidden = true; }

  function line(host, o) {
    host.innerHTML = ''; host.classList.add('chart');
    const series = o.series.filter(s => s.values && s.values.some(v => v != null));
    if (!series.length || !o.dates || !o.dates.length) { host.innerHTML = '<div class="muted small">No data to chart.</div>'; return; }
    if (series.length > 1) { const lg = document.createElement('div'); lg.className = 'legend';
      lg.innerHTML = series.map(s => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join(''); host.appendChild(lg); }
    const W = host.clientWidth || 600, H = o.height || 220, m = { l: 56, r: 12, t: 8, b: 24 };
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H }); host.appendChild(svg);
    let lo = Infinity, hi = -Infinity;
    for (const s of series) for (const v of s.values) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (o.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (o.refs) for (const r of o.refs) { lo = Math.min(lo, r.v); hi = Math.max(hi, r.v); }
    const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
    const n = o.dates.length, X = i => m.l + (W - m.l - m.r) * (n === 1 ? 0.5 : i / (n - 1)), Y = v => m.t + (H - m.t - m.b) * (1 - (v - lo) / (hi - lo));
    const fmt = o.fmt || (v => v.toLocaleString(undefined, { maximumFractionDigits: 2 }));
    for (const t of ticks(lo, hi, 4)) { el('line', { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), stroke: css('--line'), 'stroke-width': 1 }, svg);
      const tx = el('text', { x: m.l - 8, y: Y(t) + 4, 'text-anchor': 'end', fill: css('--muted'), 'font-size': 10.5 }, svg); tx.textContent = fmt(t); }
    if (o.refs) for (const r of o.refs) el('line', { x1: m.l, x2: W - m.r, y1: Y(r.v), y2: Y(r.v), stroke: css('--text2'), 'stroke-dasharray': '3 4', 'stroke-width': 1, opacity: .6 }, svg);
    const nx = Math.max(2, Math.min(6, Math.floor((W - m.l - m.r) / 90))); const lw = 70; let placed = [];
    for (let k = 0; k < nx; k++) { const i = Math.round(k * (n - 1) / Math.max(nx - 1, 1)); placed.push(i); }
    placed = [...new Set(placed)];
    // drop any label that would collide with its neighbour (keep the first and last)
    const keep = [placed[0]]; for (let k = 1; k < placed.length; k++) { const last = k === placed.length - 1;
      if (X(placed[k]) - X(keep[keep.length - 1]) >= lw) keep.push(placed[k]); else if (last) { if (keep.length > 1) keep[keep.length - 1] = placed[k]; else keep.push(placed[k]); } }
    keep.forEach((i, k) => { const tx = el('text', { x: X(i), y: H - 6, 'text-anchor': k === 0 ? 'start' : k === keep.length - 1 ? 'end' : 'middle', fill: css('--muted'), 'font-size': 10.5 }, svg); tx.textContent = o.dates[i]; });
    for (const s of series) {
      let d = '', pen = false;
      s.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += (pen ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); pen = true; });
      if (s.area) { const base = Y(Math.max(lo, Math.min(hi, 0))); el('path', { d: d + `L${X(n - 1)} ${base}L${X(0)} ${base}Z`, fill: s.color, opacity: .15 }, svg); }
      el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    }
    const cross = el('line', { y1: m.t, y2: H - m.b, stroke: css('--text2'), 'stroke-width': 1, opacity: 0 }, svg);
    const dots = series.map(s => el('circle', { r: 4, fill: s.color, stroke: css('--panel'), 'stroke-width': 2, opacity: 0 }, svg));
    const hit = el('rect', { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: 'transparent' }, svg);
    const move = ev => { const r = svg.getBoundingClientRect(); const px = (ev.clientX - r.left) * W / r.width;
      const i = Math.max(0, Math.min(n - 1, Math.round((px - m.l) / (W - m.l - m.r) * (n - 1))));
      cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('opacity', .5);
      series.forEach((s, k) => { const v = s.values[i]; if (v == null) dots[k].setAttribute('opacity', 0); else { dots[k].setAttribute('cx', X(i)); dots[k].setAttribute('cy', Y(v)); dots[k].setAttribute('opacity', 1); } });
      showTip(ev, `<div class="h">${o.dates[i]}</div>` + series.map(s => `<div class="r"><span><i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${s.color};margin-right:6px"></i>${s.name}</span><b>${s.values[i] == null ? '—' : fmt(s.values[i])}</b></div>`).join('')); };
    hit.addEventListener('pointermove', move); hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', () => { hideTip(); cross.setAttribute('opacity', 0); dots.forEach(d => d.setAttribute('opacity', 0)); });
  }

  function bars(host, o) {
    host.innerHTML = ''; host.classList.add('chart');
    if (!o.values || !o.values.length) { host.innerHTML = '<div class="muted small">No data to chart.</div>'; return; }
    if (o.legend) { const lg = document.createElement('div'); lg.className = 'legend'; lg.innerHTML = o.legend.map(s => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join(''); host.appendChild(lg); }
    const W = host.clientWidth || 600, H = o.height || 180, m = { l: 44, r: 8, t: 8, b: 26 };
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H }); host.appendChild(svg);
    const groups = o.values.map(v => Array.isArray(v) ? v : [v]); const k = groups[0].length;
    let hi = Math.max(0, ...groups.flat().filter(v => v != null)), lo = Math.min(0, ...groups.flat().filter(v => v != null));
    if (hi === lo) hi = lo + 1;
    const Y = v => m.t + (H - m.t - m.b) * (1 - (v - lo) / (hi - lo)), n = groups.length, bw = (W - m.l - m.r) / n;
    const fmt = o.fmt || (v => String(v));
    for (const t of ticks(lo, hi, 4)) { el('line', { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), stroke: css('--line') }, svg);
      const tx = el('text', { x: m.l - 6, y: Y(t) + 4, 'text-anchor': 'end', fill: css('--muted'), 'font-size': 10.5 }, svg); tx.textContent = (o.yfmt || fmt)(t); }
    groups.forEach((g, i) => { const sub = (bw - 2) / k;
      g.forEach((v, j) => { if (v == null) return; const y0 = Y(0), y1 = Y(v), x = m.l + i * bw + 1 + j * sub;
        const c = o.colors ? o.colors[j] : (o.colorFn ? o.colorFn(v, i) : css('--s1'));
        el('rect', { x: x + (k > 1 ? 1 : 0), y: Math.min(y0, y1), width: Math.max(1, sub - (k > 1 ? 2 : 2)), height: Math.max(1, Math.abs(y1 - y0)), rx: Math.min(2, sub / 3), fill: c }, svg); });
      const hit = el('rect', { x: m.l + i * bw, y: 0, width: bw, height: H, fill: 'transparent' }, svg);
      const show = ev => showTip(ev, `<div class="h">${o.labels[i]}</div>` + g.map((v, j) => `<div class="r"><span>${o.legend ? o.legend[j].name : (o.name || 'value')}</span><b>${v == null ? '—' : fmt(v)}</b></div>`).join(''));
      hit.addEventListener('pointermove', show); hit.addEventListener('pointerdown', show); hit.addEventListener('pointerleave', hideTip); });
    const step = Math.ceil(n / 8); o.labels.forEach((l, i) => { if (i % step) return; const tx = el('text', { x: m.l + i * bw + bw / 2, y: H - 8, 'text-anchor': 'middle', fill: css('--muted'), 'font-size': 10 }, svg); tx.textContent = l; });
  }

  // diverging: blue = gain, orange = loss, neutral grey at zero
  function divColor(v, max) {
    if (v == null) return 'transparent';
    const a = Math.min(1, Math.abs(v) / (max || 0.05));
    const c = v >= 0 ? [57, 135, 229] : [217, 89, 38];
    return `rgba(${c[0]},${c[1]},${c[2]},${0.12 + 0.78 * a})`;
  }
  function heat(host, monthly) {
    const keys = Object.keys(monthly || {}); if (!keys.length) { host.innerHTML = '<div class="muted small">No months.</div>'; return; }
    const years = [...new Set(keys.map(k => k.slice(0, 4)))].sort(); const max = Math.max(...Object.values(monthly).map(Math.abs), 0.01);
    const mn = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
    let h = '<div class="heat"><div class="hd"></div>' + mn.map(m => `<div class="hd">${m}</div>`).join('');
    for (const y of years) { h += `<div class="hd">${y}</div>`; for (let i = 1; i <= 12; i++) { const k = `${y}-${String(i).padStart(2, '0')}`, v = monthly[k];
      h += `<div title="${k}: ${v == null ? '—' : (v * 100).toFixed(2) + '%'}" style="background:${divColor(v, max)}">${v == null ? '' : (v * 100).toFixed(1)}</div>`; } }
    host.innerHTML = h + '</div>';
  }
  window.Charts = { line, bars, heat, css };
})();
