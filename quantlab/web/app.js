/* Quant Lab front end — 14 pages, hash-routed. All numbers come from the API;
   nothing is computed or invented in the browser except formatting. */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const view = $('#view');
  const C = () => ({ a: Charts.css('--s1'), b: Charts.css('--s2'), c: Charts.css('--s3'), d: Charts.css('--s4') });
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (v, d = 1) => v == null || v === '' ? '—' : (v * 100).toFixed(d) + '%';
  const num = (v, d = 2) => v == null || v === '' ? '—' : (typeof v === 'string' ? v : (+v).toFixed(d));
  const usd = v => v == null ? '—' : (v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
  const ago = t => { if (!t) return '—'; const s = Date.now() / 1000 - t; return s < 90 ? Math.round(s) + ' s ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 172800 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };
  const store = { get(k, d) { try { return JSON.parse(localStorage.getItem('ql:' + k)) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem('ql:' + k, JSON.stringify(v)); } catch { } } };
  let STRATS = [];

  async function api(path, opt = {}) {
    const r = await fetch(path, { credentials: 'same-origin', headers: opt.body ? { 'Content-Type': 'application/json' } : {}, ...opt, body: opt.body ? JSON.stringify(opt.body) : undefined });
    if (r.status === 401) { location.href = '/login'; throw new Error('login required'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail || j.error || ('HTTP ' + r.status));
    return j;
  }
  async function job(path, body, box) {
    box.innerHTML = '<div class="status spin">Queued…</div>';
    let id;
    try { ({ job: id } = await api(path, { method: 'POST', body })); }
    catch (e) { box.innerHTML = `<div class="status err">${esc(e.message)}</div>`; throw e; }
    const t0 = Date.now(); let first = true;
    for (;;) {
      await new Promise(r => setTimeout(r, first ? 150 : 1800)); first = false;
      const j = await api('/api/jobs/' + id);
      if (j.status === 'done') { box.innerHTML = ''; return j.result; }
      if (j.status === 'error') { box.innerHTML = `<div class="status err">Failed: ${esc(j.error)}</div>`; throw new Error(j.error); }
      box.innerHTML = `<div class="status spin">${j.status === 'running' ? 'Running' : 'Queued'} · ${Math.round((Date.now() - t0) / 1000)} s — walk-forward and comparisons can take a few minutes on the free server</div>`;
    }
  }
  const pill = (status, extra = '') => `<span class="pill ${esc(status)}">${esc(status)}${extra ? ' · ' + esc(extra) : ''}</span>`;
  const okPill = (ok, t) => `<span class="pill ${ok ? 'good' : 'bad'}">${esc(t)}</span>`;
  const dataLine = d => d ? `<div class="small dim" style="margin:6px 0 12px">${pill('historical', 'daily bars to ' + (d.asof || '—'))} &nbsp;Source: ${esc([...new Set(Object.values(d.sources || {}).map(s => s.source))].join(', ') || '—')} · ${Object.values(d.sources || {}).every(s => s.dividends_adjusted) ? 'dividend-adjusted' : 'dividends applied where the provider lists them'} · signals at the close, fills at the next open${(d.warnings || []).length ? `<div style="margin-top:4px">${d.warnings.map(w => `<span class="pill warn">${esc(w)}</span>`).join(' ')}</div>` : ''}</div>` : '';

  // ------------------------------------------------------------------ nav
  const PAGES = [
    ['', 'Executive Overview', 'Overview'], ['library', 'Strategy Library', 'Research'], ['scanner', 'Statistical Arbitrage Scanner'], ['zscore', 'Z-Score Scanner'],
    ['pairs', 'Pairs Discovery'], ['compare', 'Strategy A vs B', 'Testing'], ['optimize', 'Parameter Optimization'], ['backtest', 'Historical Backtesting'],
    ['walkforward', 'Walk-Forward Analysis'], ['portfolio', 'Portfolio Construction', 'Portfolio & risk'], ['risk', 'Risk Monitor'], ['trades', 'Trade History'],
    ['performance', 'Performance Analytics'], ['settings', 'Data Connections & Settings', 'System'], ['statarb', 'Statistical Arbitrage Lab', 'Stat-Arb Lab']];
  $('#nav').innerHTML = PAGES.map((p, i) => (p[2] ? `<div class="grp">${p[2]}</div>` : '') + `<a href="#/${p[0]}" data-p="${p[0]}"><span class="n">${String(i + 1).padStart(2, '0')}</span>${p[1]}</a>`).join('');
  $('#menu').onclick = () => $('#nav').classList.toggle('open');

  let GEN = 0;
  function route() {
    const gen = ++GEN;
    const [p, q] = (location.hash.replace(/^#\/?/, '') || '').split('?');
    const params = Object.fromEntries(new URLSearchParams(q || ''));
    document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.p === p));
    $('#nav').classList.remove('open');
    const fn = R[p] || R[''];
    const title = (PAGES.find(x => x[0] === p) || PAGES[0])[1];
    document.title = title + ' · Quant Lab';
    view.innerHTML = '';
    fn(params).catch(e => { if (gen === GEN) view.insertAdjacentHTML('beforeend', `<div class="status err">${esc(e.message)}</div>`); });
    scrollTo(0, 0);
  }

  async function clock() {
    try { const s = await api('/api/status'); $('#clock').textContent = `US market ${s.market_open ? 'open' : 'closed'} · data to ${s.data.by_status?.ok?.latest_bar || '—'} · agent ${s.agent.phase}`; } catch { }
  }

  // ------------------------------------------------------------------ shared form bits
  const stratSel = (name, sel, filter) => `<select name="${name}">${STRATS.filter(s => !filter || filter(s)).map(s => `<option value="${s.key}" ${s.key === sel ? 'selected' : ''}>${s.key} · ${esc(s.name)}</option>`).join('')}</select>`;
  function pairFields(p) {
    const lp = store.get('pair', { y: '', x: '' });
    const y = p.y || lp.y || 'KO', x = p.x || lp.x || 'PEP';
    return `<label class="fld">Stock Y<input class="sym" name="y" value="${esc(y)}" required></label><label class="fld">Stock X<input class="sym" name="x" value="${esc(x)}" required></label>`;
  }
  const dateFields = p => `<label class="fld">Start<input type="date" name="start" value="${esc(p.start || '')}"></label><label class="fld">End<input type="date" name="end" value="${esc(p.end || '')}"></label>`;
  const capField = () => `<label class="fld">Capital (USD)<input type="number" name="capital" value="100000" min="1000" step="1000"></label>`;
  function formData(f) {
    const o = Object.fromEntries(new FormData(f));
    for (const k of ['capital', 'train_days', 'test_days', 'n_pairs']) if (o[k]) o[k] = +o[k];
    if (o.y) o.y = o.y.toUpperCase().trim(); if (o.x) o.x = o.x.toUpperCase().trim();
    if (o.y && o.x) store.set('pair', { y: o.y, x: o.x });
    for (const k of ['start', 'end']) if (!o[k]) delete o[k];
    const c = {}; for (const k of ['fee_bps', 'spread_bps', 'slippage_bps', 'borrow_bps']) if (o[k] !== undefined && o[k] !== '') { c[k] = +o[k]; delete o[k]; }
    if (Object.keys(c).length) o.costs = c;
    o.optimise = o.optimise === 'on';
    return o;
  }
  let SETTINGS = null;
  async function costFields() {
    SETTINGS = SETTINGS || await api('/api/settings');
    const c = SETTINGS.costs;
    return `<details style="flex-basis:100%"><summary>Costs: fee ${c.fee_bps} bp · spread ${c.spread_bps} bp · slippage ${c.slippage_bps} bp · borrow ${c.borrow_bps} bp/yr (edit)</summary><div class="f" style="display:flex;gap:10px;margin-top:8px;flex-wrap:wrap">
      <label class="fld">Fee bp/side<input type="number" step="0.1" name="fee_bps" value="${c.fee_bps}"></label><label class="fld">Quoted spread bp<input type="number" step="0.5" name="spread_bps" value="${c.spread_bps}"></label>
      <label class="fld">Slippage bp/side<input type="number" step="0.5" name="slippage_bps" value="${c.slippage_bps}"></label><label class="fld">Borrow bp/yr<input type="number" step="5" name="borrow_bps" value="${c.borrow_bps}"></label></div></details>`;
  }

  const METRICS = [['total_return', 'Total net return', pct], ['ann_return', 'Annualized return', pct], ['cagr', 'CAGR', pct], ['win_rate', 'Win rate', pct],
    ['profit_factor', 'Profit factor', num], ['sharpe', 'Sharpe ratio', num], ['sortino', 'Sortino ratio', num], ['max_drawdown', 'Maximum drawdown', pct],
    ['calmar', 'Calmar ratio', num], ['avg_trade_return', 'Average trade return', v => pct(v, 2)], ['avg_holding_days', 'Average holding (sessions)', v => num(v, 1)],
    ['trades', 'Number of trades', v => num(v, 0)], ['winning_trades', 'Winning trades', v => num(v, 0)], ['losing_trades', 'Losing trades', v => num(v, 0)],
    ['exposure', 'Exposure (time in market)', pct], ['turnover_annual', 'Turnover (× equity / yr)', v => num(v, 1)], ['transaction_costs', 'Transaction costs', usd],
    ['beta', 'Market beta (SPY)', num], ['vol_split', 'Sharpe in high / low volatility', null], ['trend_split', 'Sharpe trending / ranging', null],
    ['positive_months', 'Return consistency (positive months)', pct], ['rolling_sharpe_sd', 'Rolling 63-d Sharpe s.d. (lower = steadier)', num],
    ['sharpe_pvalue', 'p-value Sharpe ≤ 0', v => num(v, 3)], ['deflated_sharpe', 'Deflated Sharpe (prob. edge is real)', num]];
  function regimeCell(m, col, a, b) { const r = (m.by_regime || {})[col] || {}; return `${num(r[a]?.sharpe)} / ${num(r[b]?.sharpe)}`; }
  function metricCell(m, k, f) {
    if (!m) return '—';
    if (k === 'vol_split') return regimeCell(m, 'vol', 'high', 'low');
    if (k === 'trend_split') return regimeCell(m, 'trend', 'trending', 'ranging');
    return f(m[k]);
  }
  function metricsTable(cols) { // cols: [{label, m}]
    return `<table><thead><tr><th>Metric</th>${cols.map(c => `<th class="n">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>` +
      METRICS.filter(([k]) => cols.some(c => c.m && (c.m[k] !== undefined || k.endsWith('_split')))).map(([k, l, f]) => `<tr><td>${l}</td>${cols.map(c => `<td class="n">${metricCell(c.m, k, f || num)}</td>`).join('')}</tr>`).join('') + '</tbody></table>';
  }
  function regimeTable(m) {
    const br = m && m.by_regime; if (!br) return '';
    return `<table><thead><tr><th>Regime (SPY)</th><th class="n">Sessions</th><th class="n">Return</th><th class="n">Sharpe</th></tr></thead><tbody>` +
      Object.entries(br).flatMap(([col, labs]) => Object.entries(labs).map(([lab, v]) => `<tr><td>${col}: ${lab}</td><td class="n">${v.days}</td><td class="n">${pct(v.ret)}</td><td class="n">${num(v.sharpe)}</td></tr>`)).join('') + '</tbody></table>';
  }
  function tradesTable(trades, limit = 200) {
    if (!trades || !trades.length) return '<div class="muted small">No trades.</div>';
    const t = trades.slice(-limit).reverse();
    return `<div class="scroll"><table><thead><tr><th>Entry</th><th>Exit</th><th>Legs</th><th class="n">Days</th><th class="n">Leg P&amp;L</th><th class="n">P&amp;L</th><th class="n">Return</th><th>Exit reason</th></tr></thead><tbody>` +
      t.map(x => `<tr><td class="mono">${x.entry}</td><td class="mono">${x.exit || 'open'}</td><td>${x.symbols.map((s, i) => `${x.side[i] > 0 ? 'long' : 'short'} ${esc(s)}`).join(' / ')}</td><td class="n">${x.days}</td>
        <td class="n small">${Object.entries(x.leg_pnl || {}).map(([s, v]) => `${esc(s)} ${usd(v)}`).join('<br>')}</td><td class="n">${usd(x.pnl)}</td><td class="n">${pct(x.ret, 2)}</td><td>${esc(x.exit_reason)}</td></tr>`).join('') + '</tbody></table></div>';
  }
  function hist(values, bins = 24) {
    const v = (values || []).filter(x => x != null); if (!v.length) return { labels: [], values: [] };
    let lo = Math.min(...v), hi = Math.max(...v); if (hi === lo) hi = lo + 0.01;
    const w = (hi - lo) / bins, c = new Array(bins).fill(0); for (const x of v) c[Math.min(bins - 1, Math.floor((x - lo) / w))]++;
    return { labels: c.map((_, i) => ((lo + (i + .5) * w) * 100).toFixed(1) + '%'), values: c };
  }
  function resultCharts(host, s, color, title = '') {
    host.innerHTML = `<div class="grid g2"><div class="card"><h2>Equity ${title}</h2><div class="eq"></div></div><div class="card"><h2>Drawdown</h2><div class="dd"></div></div>
      <div class="card"><h2>Monthly returns (%)</h2><div class="hm"></div></div><div class="card"><h2>Trade return distribution</h2><div class="th"></div></div></div>`;
    Charts.line($('.eq', host), { dates: s.dates, series: [{ name: 'Equity', values: s.equity, color }], fmt: v => '$' + Math.round(v).toLocaleString() });
    Charts.line($('.dd', host), { dates: s.dates, series: [{ name: 'Drawdown', values: s.drawdown, color, area: true }], fmt: v => (v * 100).toFixed(1) + '%', zero: true });
    Charts.heat($('.hm', host), s.monthly);
    const h = hist(s.trade_returns); Charts.bars($('.th', host), { labels: h.labels, values: h.values, name: 'trades', fmt: v => v + ' trades', colorFn: () => color });
  }

  // ------------------------------------------------------------------ pages
  const R = {};

  R[''] = async () => {
    view.innerHTML = `<h1>Executive Overview</h1><p class="sub">The research agent scans the universe after each session, tests every candidate pair statistically, walk-forward tests each strategy on the best pairs, and runs a paper book. Nothing here places real orders.</p>
      <div class="grid g4" id="kpis"></div><div class="grid g2" style="margin-top:14px"><div class="card"><h2>Strategy leaderboard (out-of-sample)</h2><div id="lb"></div></div><div class="card"><h2>Current opportunities</h2><div id="opp"></div></div></div>
      <div class="grid g2" style="margin-top:14px"><div class="card"><h2>Paper book equity</h2><div id="peq"></div></div><div class="card"><h2>Agent activity</h2><div id="alog" class="log"></div></div></div>`;
    const [s, lb, sc, pb] = await Promise.all([api('/api/status'), api('/api/leaderboard'), api('/api/scan/latest'), api('/api/paper')]);
    const ok = s.data.by_status?.ok || {}, er = s.data.by_status?.error || {};
    const eqLast = (pb.equity || []).slice(-1)[0];
    $('#kpis').innerHTML = [
      ['Daily data', ok.latest_bar || '—', `${ok.symbols || 0} symbols ok · ${er.symbols || 0} failing · expected ${s.data.expected_last_session}`],
      ['Pairs passing all tests', sc.empty ? '—' : sc.accepted.length, sc.empty ? 'no scan yet' : `of ${sc.candidates} candidates · scan ${sc.asof}`],
      ['Paper equity', eqLast ? usd(eqLast[1]) : usd(pb.start_cash || 100000), `${(pb.positions || []).length} positions · ${(pb.closed || []).length} closed${pb.halted ? ' · HALTED ' + pb.halted : ''}`],
      ['Research agent', s.agent.enabled ? s.agent.phase : 'paused', `${s.agent.done || 0} tests done · ${s.agent.queue_len} queued · last tick ${ago(s.agent.last_tick)}`]]
      .map(([l, v, x]) => `<div class="card kpi"><div class="l">${l}</div><div class="v">${esc(v)}</div><div class="s">${esc(x)}</div></div>`).join('');
    const cats = Object.entries(lb.categories || {}).filter(([, v]) => v);
    $('#lb').innerHTML = (lb.note ? `<div class="small dim" style="margin-bottom:8px">${esc(lb.note)}</div>` : '') + (cats.length ? `<table><tbody>${cats.map(([k, v]) => `<tr><td>${k}</td><td><b>${v.strategy}</b> ${esc(v.name)}</td><td class="n">${/drawdown|share/.test(v.metric) ? pct(v.value) : num(v.value)}</td><td class="small dim">${esc(v.metric)}</td></tr>`).join('')}</tbody></table>` : '<div class="muted small">Waiting for the first research results.</div>') +
      `<div style="margin-top:10px"><a href="#/performance">Full leaderboard →</a></div>`;
    const sig = sc.empty ? [] : sc.accepted.filter(r => r.signal).slice(0, 6);
    $('#opp').innerHTML = sc.empty ? `<div class="muted small">${esc(sc.note)}</div>` : sig.length ? `<table><thead><tr><th>Pair</th><th class="n">z (60d)</th><th class="n">Half-life</th><th class="n">EG p</th><th>Signal</th></tr></thead><tbody>${sig.map(r => `<tr class="click" data-y="${r.y}" data-x="${r.x}"><td>${r.y}/${r.x}</td><td class="n">${num(r.z60)}</td><td class="n">${num(r.half_life, 1)} d</td><td class="n">${num(r.eg_p, 3)}</td><td>${r.signal}</td></tr>`).join('')}</tbody></table><div class="small dim" style="margin-top:8px">${pill('historical', 'close ' + sc.asof)} Live pre-trade checks on the <a href="#/zscore">Z-Score Scanner</a>.</div>` : '<div class="muted small">No accepted pair is beyond the entry z-score right now.</div>';
    view.querySelectorAll('#opp tr.click').forEach(tr => tr.onclick = () => location.hash = `#/pairs?y=${tr.dataset.y}&x=${tr.dataset.x}`);
    const e = pb.equity || [];
    if (e.length > 1) Charts.line($('#peq'), { dates: e.map(x => x[0]), series: [{ name: 'Paper equity', values: e.map(x => x[1]), color: C().a }], fmt: v => '$' + Math.round(v).toLocaleString() });
    else $('#peq').innerHTML = '<div class="muted small">The paper book records one point per session once the agent starts trading signals.</div>';
    $('#alog').textContent = (s.agent.log || []).slice().reverse().join('\n') || 'No activity yet.';
  };

  R.library = async () => {
    view.innerHTML = `<h1>Strategy Library</h1><p class="sub">Each strategy is an independent module. Signals are decided at the close using only past data and executed at the next open. Single-stock strategies (B, D, G, M) trade each stock of the chosen pair with half the capital, so every A-vs-B test uses the same stocks and money. Strategy H (market-neutral portfolio) is on the Portfolio page.</p><div class="grid g2" id="lib"></div>`;
    $('#lib').innerHTML = STRATS.map(s => `<div class="card"><h2>${s.key} · ${esc(s.name)} <span class="pill">${s.family}</span></h2><p class="small dim">${esc(s.method)}</p>
      <div class="small"><b>Defaults:</b> <span class="mono">${esc(Object.entries(s.defaults).map(([k, v]) => `${k}=${v}`).join(', '))}</span></div>
      <div class="small" style="margin-top:4px"><b>Search grid:</b> <span class="mono">${esc(Object.entries(s.grid).map(([k, v]) => `${k} ∈ {${v.join(', ')}}`).join('; '))}</span></div>
      <div style="margin-top:10px;display:flex;gap:8px"><a href="#/backtest?s=${s.key}"><button class="b2">Backtest</button></a><a href="#/walkforward?s=${s.key}"><button class="b2">Walk-forward</button></a><a href="#/optimize?s=${s.key}"><button class="b2">Optimize</button></a></div></div>`).join('') +
      `<div class="card"><h2>H · Market-neutral portfolio <span class="pill">portfolio</span></h2><p class="small dim">Combines the scanner's accepted pairs, each run with a chosen pair strategy, under dollar- or beta-neutral sizing, per-pair, sector, gross and net limits, a position cap, and a portfolio drawdown halt that blocks new entries.</p><a href="#/portfolio"><button class="b2">Build portfolio</button></a></div>`;
  };

  R.scanner = async () => {
    view.innerHTML = `<h1>Statistical Arbitrage Scanner</h1><p class="sub">Universe → liquidity filter → return correlation (same sector, or ≥ 0.85 across sectors) → Engle-Granger and Johansen cointegration → Ornstein-Uhlenbeck half-life → Hurst exponent → expected edge vs round-trip cost. A pair is accepted only if it passes every test. Click a row for full diagnostics.</p>
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px"><button class="b" id="run">Run scan now</button><label class="small dim"><input type="checkbox" id="force"> re-scan even if no new session</label><span id="meta" class="small dim"></span></div><div id="st"></div>
      <div class="tabs"><button class="on" data-t="acc">Accepted</button><button data-t="rej">Rejected (with reasons)</button></div><div class="card"><div id="tbl" class="scroll" style="max-height:640px"></div></div>`;
    let sc = await api('/api/scan/latest'), tab = 'acc';
    const draw = () => {
      if (sc.empty) { $('#tbl').innerHTML = `<div class="muted">${esc(sc.note)}</div>`; return; }
      $('#meta').innerHTML = `${pill('historical', 'closes to ' + sc.asof)} ${sc.symbols_with_data} symbols with history · ${sc.liquid_symbols} liquid · ${sc.candidates} candidates · ${sc.accepted.length} accepted · round-trip cost ${sc.round_trip_cost_bps} bp · ${sc.missing_count} symbols lacked history`;
      if (tab === 'acc') $('#tbl').innerHTML = `<table><thead><tr><th>#</th><th>Pair (Y/X)</th><th>Sector</th><th class="n">Corr</th><th class="n">EG p</th><th class="n">Johansen trace / 95%</th><th class="n">Hedge β</th><th class="n">Half-life</th><th class="n">Hurst</th><th class="n">z (60d)</th><th class="n">Edge bp</th><th class="n">Score</th><th>Signal</th></tr></thead><tbody>` +
        sc.accepted.map((r, i) => `<tr class="click" data-y="${r.y}" data-x="${r.x}"><td class="n">${i + 1}</td><td><b>${r.y}</b>/${r.x}</td><td class="small">${esc(r.sector)}</td><td class="n">${num(r.corr)}</td><td class="n">${num(r.eg_p, 4)}</td><td class="n">${num(r.johansen_trace, 1)} / ${num(r.johansen_crit95, 1)}</td><td class="n">${num(r.hedge_ratio)}</td><td class="n">${num(r.half_life, 1)}</td><td class="n">${num(r.hurst)}</td><td class="n">${num(r.z60)}</td><td class="n">${num(r.edge_bps, 0)}</td><td class="n">${num(r.score, 3)}</td><td>${r.signal ? `<span class="pill warn">${r.signal}</span>` : '<span class="muted small">inside band</span>'}</td></tr>`).join('') + '</tbody></table>';
      else $('#tbl').innerHTML = `<div class="small dim" style="margin-bottom:6px">Showing ${sc.rejected.length} of ${sc.rejected_count} rejected candidates.</div><table><thead><tr><th>Pair</th><th class="n">Corr</th><th class="n">EG p</th><th class="n">Half-life</th><th>Why rejected</th></tr></thead><tbody>` +
        sc.rejected.map(r => `<tr class="click" data-y="${r.y}" data-x="${r.x}"><td>${r.y}/${r.x}</td><td class="n">${num(r.corr)}</td><td class="n">${num(r.eg_p, 3)}</td><td class="n">${num(r.half_life, 1)}</td><td class="small">${esc(r.reasons.join('; '))}</td></tr>`).join('') + '</tbody></table>';
      view.querySelectorAll('tr.click').forEach(tr => tr.onclick = () => location.hash = `#/pairs?y=${tr.dataset.y}&x=${tr.dataset.x}`);
    };
    view.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { tab = b.dataset.t; view.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b)); draw(); });
    $('#run').onclick = async () => { $('#run').disabled = true; try { const r = await job('/api/scan', { force: $('#force').checked }, $('#st')); sc = await api('/api/scan/latest'); draw();
      if (r && r.cached) $('#st').innerHTML = `<div class="status">Already up to date for the ${esc(r.asof)} close — no new session since the last scan. Tick "re-scan" to run it again anyway (takes a few minutes).</div>`; } finally { $('#run').disabled = false; } };
    draw();
  };

  R.zscore = async () => {
    view.innerHTML = `<h1>Z-Score Scanner</h1><p class="sub">Top: spread z-scores of accepted pairs with pre-trade checks recomputed on current quotes. A z-score cross is never enough on its own — the statistical tests, quote quality (bid-ask) and stop band must pass too. Bottom: the most stretched single stocks (log price vs its rolling mean) across lookbacks.</p>
      <div class="card"><h2>Pair opportunities — pre-trade checks</h2><div id="opp"></div></div>
      <div class="card" style="margin-top:14px"><h2>Single-stock z-scores</h2><form class="f" id="zf"><label class="fld">Sort by lookback<select name="lb">${[10, 20, 30, 50, 100].map(l => `<option ${l === 20 ? 'selected' : ''}>${l}</option>`).join('')}</select></label></form><div id="zs" style="margin-top:10px"></div></div>`;
    const o = await api('/api/opportunities');
    $('#opp').innerHTML = !o.rows.length ? `<div class="muted small">${esc(o.note || 'No accepted pair is near its entry threshold.')}</div>` :
      `<div class="small dim" style="margin-bottom:8px">Scan closes ${o.asof}. Market ${o.market_open ? 'open — quotes below are as labelled' : 'closed — z uses the last close'}. Entry |z| ≥ ${o.entry_z}.</div>` +
      o.rows.map(r => `<div style="border-top:1px solid var(--line);padding:10px 0"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center"><b><a href="#/pairs?y=${r.y}&x=${r.x}">${r.y}/${r.x}</a></b>
        <span class="mono">z now ${num(r.live.z)}</span>${pill(r.live.z_status || 'unavailable')}${okPill(r.live.eligible, r.live.eligible ? 'eligible (paper)' : 'not eligible')}
        ${Object.values(r.live.quotes || {}).map(q => `<span class="small dim">${esc(q.symbol)} ${q.price ? '$' + num(q.price) : '—'} ${pill(q.status)}${q.provider_time ? ' ' + esc(q.provider_time) : ''}</span>`).join(' ')}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${(r.live.checks || []).map(c => `<span class="pill ${c.pass ? 'good' : 'bad'}" title="${esc(c.detail)}">${esc(c.check)}: ${esc(c.detail)}</span>`).join('')}</div></div>`).join('');
    const load = async () => {
      const lb = $('#zf [name=lb]').value; $('#zs').innerHTML = '<div class="status spin">Computing…</div>';
      const z = await api('/api/zscan?lookback=' + lb);
      $('#zs').innerHTML = !z.rows.length ? `<div class="muted small">${esc(z.note || 'No data yet.')}</div>` : `<div class="small dim" style="margin-bottom:6px">${pill('historical', 'daily closes')} ${z.universe_liquid} liquid stocks; showing the 40 most extreme by the ${z.lookback}-session z.</div><div class="scroll"><table><thead><tr><th>Symbol</th><th>Close date</th><th class="n">Last close</th>${[10, 20, 30, 50, 100].map(l => `<th class="n">z${l}</th>`).join('')}<th class="n">$ vol (20d med)</th></tr></thead><tbody>` +
        z.rows.map(r => `<tr><td><b>${r.symbol}</b></td><td class="mono small">${r.date}</td><td class="n">${num(r.last)}</td>${[10, 20, 30, 50, 100].map(l => `<td class="n">${num(r['z' + l])}</td>`).join('')}<td class="n">${usd(r.dollar_vol)}</td></tr>`).join('') + '</tbody></table></div>';
    };
    $('#zf [name=lb]').onchange = load; load();
  };

  R.pairs = async (p) => {
    view.innerHTML = `<h1>Pairs Discovery</h1><p class="sub">Full statistical diagnostics for any two US stocks or ETFs on the last two years of daily closes. Use the scanner to find candidates, or type your own.</p>
      <form class="f card" id="pf">${pairFields(p)}<button class="b">Analyse</button></form><div id="st"></div><div id="out"></div>`;
    const go = async () => {
      const o = formData($('#pf')); $('#st').innerHTML = '<div class="status spin">Loading data and running tests…</div>';
      const d = await api(`/api/pair?y=${encodeURIComponent(o.y)}&x=${encodeURIComponent(o.x)}`); $('#st').innerHTML = '';
      const s = d.stats, j = s.johansen, ou = s.ou;
      const tests = [
        ['Engle-Granger (Y on X)', `p = ${num(s.eg_p, 4)} · t = ${num(s.eg_t)}`, s.eg_p < 0.05],
        ['Engle-Granger (X on Y)', `p = ${num(s.eg_p_reverse, 4)}`, s.eg_p_reverse < 0.05],
        ['Johansen trace (r = 0)', `${num(j.trace, 2)} vs 90/95/99%: ${num(j.crit90, 1)} / ${num(j.crit95, 1)} / ${num(j.crit99, 1)}`, j.reject_conf >= 0.95],
        ['ADF on spread', `p = ${num(s.adf_p_spread, 4)}`, s.adf_p_spread < 0.05],
        ['OU half-life', ou.ok ? `${num(ou.half_life, 1)} sessions · κ ${num(ou.kappa, 4)} · μ ${num(ou.mu, 4)} · σ_eq ${num(ou.sigma_eq, 4)}` : esc(ou.reason), ou.ok && ou.half_life >= 2 && ou.half_life <= 40],
        ['Hurst exponent (spread)', num(s.hurst), s.hurst < 0.5],
        ['Return correlation', num(s.corr_returns), s.corr_returns >= 0.7],
        ['Hedge ratio (log OLS)', `β = ${num(s.beta, 3)}, α = ${num(s.alpha, 3)}`, s.beta > 0],
        ['Current z (60-session)', num(s.z_now), null]];
      $('#out').innerHTML = dataLine(d.data) + `<div class="grid g2"><div class="card"><h2>Statistical tests</h2><table><tbody>${tests.map(([a, b, ok]) => `<tr><td style="width:34%">${a}</td><td class="mono small">${b}</td><td>${ok == null ? '' : okPill(ok, ok ? 'pass' : 'fail')}</td></tr>`).join('')}</tbody></table>
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><a href="#/compare?y=${d.y}&x=${d.x}"><button class="b2">A vs B on this pair</button></a><a href="#/backtest?y=${d.y}&x=${d.x}&s=A"><button class="b2">Backtest</button></a><a href="#/walkforward?y=${d.y}&x=${d.x}&s=A"><button class="b2">Walk-forward</button></a></div></div>
        <div class="card"><h2>Normalised prices</h2><div id="c1"></div></div><div class="card"><h2>Spread z-score (60-session)</h2><div id="c2"></div></div><div class="card"><h2>Hedge ratio: rolling OLS vs Kalman</h2><div id="c3"></div></div></div>`;
      Charts.line($('#c1'), { dates: d.dates, series: [{ name: d.y, values: d.norm_y, color: C().a }, { name: d.x, values: d.norm_x, color: C().b }], fmt: v => v.toFixed(3) });
      Charts.line($('#c2'), { dates: d.dates, series: [{ name: 'z', values: d.z, color: C().a }], refs: [{ v: 2 }, { v: -2 }, { v: 0 }], fmt: v => v.toFixed(2) });
      Charts.line($('#c3'), { dates: d.dates, series: [{ name: 'Rolling OLS (60)', values: d.beta_ols, color: C().a }, { name: 'Kalman', values: d.beta_kalman, color: C().b }], fmt: v => v.toFixed(3) });
    };
    $('#pf').onsubmit = e => { e.preventDefault(); go().catch(err => $('#st').innerHTML = `<div class="status err">${esc(err.message)}</div>`); };
    if (p.y && p.x) go().catch(err => $('#st').innerHTML = `<div class="status err">${esc(err.message)}</div>`);
  };

  R.compare = async (p) => {
    view.innerHTML = `<h1>Strategy A vs B</h1><p class="sub">Both strategies run on the same stocks, dates, capital, costs, sizing rules and walk-forward folds. Parameters for each test window are chosen on the preceding training window only. The verdict uses out-of-sample risk-adjusted returns and a block-bootstrap significance test; if the evidence is weak, no winner is declared.</p>
      <form class="f card" id="cf"><label class="fld">Strategy A${stratSel('a', p.a || 'A')}</label><label class="fld">Strategy B${stratSel('b', p.b || 'B')}</label>${pairFields(p)}${dateFields(p)}${capField()}
      <label class="fld">Train / test sessions<span><input type="number" name="train_days" value="504" style="width:72px"> / <input type="number" name="test_days" value="126" style="width:64px"></span></label>
      <label class="fld">&nbsp;<span><input type="checkbox" name="optimise" checked> walk-forward optimise</span></label>${await costFields()}<button class="b">Run comparison</button></form><div id="st"></div><div id="out"></div>
      <div class="card" style="margin-top:14px"><h2>Previous comparisons</h2><div id="prev"></div></div>`;
    const show = r => renderCompare($('#out'), r);
    $('#cf').onsubmit = async e => { e.preventDefault(); const b = $('#cf button.b'); b.disabled = true; try { show(await job('/api/compare', formData($('#cf')), $('#st'))); prev(); } catch { } finally { b.disabled = false; } };
    const prev = async () => { const rs = await api('/api/runs?kind=compare&limit=20');
      $('#prev').innerHTML = rs.length ? `<table><tbody>${rs.map(r => `<tr class="click" data-id="${r.id}"><td>${esc(r.title)}</td><td>${esc(r.summary.label || '')}</td><td class="n">${num(r.summary.oos_sharpe_a)} / ${num(r.summary.oos_sharpe_b)}</td><td class="small dim">${ago(r.created_at)}</td></tr>`).join('')}</tbody></table>` : '<div class="muted small">None yet.</div>';
      $('#prev').querySelectorAll('tr.click').forEach(tr => tr.onclick = async () => { const r = await api('/api/runs/' + tr.dataset.id); show(r.payload); scrollTo(0, $('#out').offsetTop - 60); }); };
    prev();
    if (p.id) { const r = await api('/api/runs/' + p.id); show(r.payload); }
  };

  function renderCompare(host, r) {
    const v = r.verdict, A = r.full.A, B = r.full.B, oA = r.oos.A, oB = r.oos.B, sa = STRATS.find(s => s.key === r.a), sb = STRATS.find(s => s.key === r.b);
    const rep = r.report;
    const block = x => `<p><b>Methodology.</b> ${esc(x.methodology)}</p><p><b>Parameters.</b> <span class="mono small">${esc(JSON.stringify(x.parameters))}</span></p>
      ${x.walk_forward_parameters.length ? `<p><b>Walk-forward choices (last folds).</b> <span class="mono small">${esc(x.walk_forward_parameters.map(p => JSON.stringify(p)).join(' · '))}</span></p>` : ''}
      <p><b>Historical.</b> ${esc(x.historical)}</p><p><b>Out-of-sample.</b> ${esc(x.out_of_sample)}</p><p><b>Risk.</b> ${esc(x.risk)}</p><p><b>Transaction costs.</b> ${esc(x.costs)}</p>
      <h3>Market regimes</h3><ul>${x.regimes.map(l => `<li>${esc(l)}</li>`).join('') || '<li>n/a</li>'}</ul><h3>Weaknesses</h3><ul>${x.weaknesses.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
      <h3>Trade examples (best / worst)</h3><ul>${x.trade_examples.map(t => `<li>${t.entry} → ${t.exit}: ${t.symbols.map((s, i) => (t.side[i] > 0 ? 'long ' : 'short ') + s).join(' / ')}, ${t.days} sessions, ${usd(t.pnl)} (${pct(t.ret, 2)}), exit: ${esc(t.exit_reason)}</li>`).join('') || '<li>none</li>'}</ul>`;
    host.innerHTML = dataLine(r.data) + `<div class="verdict ${v.winner ? 'win' : 'none'}"><div class="t">${esc(v.label)}</div><ul class="small" style="margin:6px 0 0;padding-left:18px">${v.why.map(w => `<li>${esc(w)}</li>`).join('')}</ul>
      <div class="small dim" style="margin-top:6px">OOS Sharpe A ${num(v.oos_sharpe_A)} · B ${num(v.oos_sharpe_B)} · bootstrap p ${num(v.p_value_lead_beats_other, 3)}</div></div>
      <div class="grid g2" style="margin-top:14px"><div class="card"><h2>Out-of-sample (walk-forward)</h2>${metricsTable([{ label: 'A · ' + r.a, m: oA.metrics }, { label: 'B · ' + r.b, m: oB.metrics }])}</div>
      <div class="card"><h2>Full period (fixed parameters)</h2>${metricsTable([{ label: 'A · ' + r.a, m: A.metrics }, { label: 'B · ' + r.b, m: B.metrics }])}</div>
      <div class="card"><h2>Out-of-sample equity</h2><div id="ce"></div></div><div class="card"><h2>Out-of-sample drawdown</h2><div id="cd"></div></div>
      <div class="card"><h2>Monthly returns — A (${r.a}), out-of-sample</h2><div id="ha"></div></div><div class="card"><h2>Monthly returns — B (${r.b}), out-of-sample</h2><div id="hb"></div></div>
      <div class="card"><h2>Trade return distribution (full period)</h2><div id="td"></div></div><div class="card"><h2>Transaction-cost sensitivity (Sharpe, full period)</h2><div id="cs"></div></div>
      <div class="card"><h2>Regimes — A</h2>${regimeTable(oA.metrics)}</div><div class="card"><h2>Regimes — B</h2>${regimeTable(oB.metrics)}</div></div>
      <div class="card rep" style="margin-top:14px"><h2>Research report — ${esc(rep.title)}</h2><p class="small dim">${esc(rep.setup)}</p>
      <div class="grid g2"><div><h3>A · ${esc(sa ? sa.name : r.a)}</h3>${block(rep.A)}</div><div><h3>B · ${esc(sb ? sb.name : r.b)}</h3>${block(rep.B)}</div></div>
      <h3>Final recommendation</h3><p>${esc(rep.recommendation)}</p></div>
      <div class="grid g2" style="margin-top:14px"><div class="card"><h2>Trades — A (full period)</h2>${tradesTable(A.trades, 80)}</div><div class="card"><h2>Trades — B (full period)</h2>${tradesTable(B.trades, 80)}</div></div>`;
    const ja = oA.series || {}, jb = oB.series || {};
    const dates = [...new Set([...(ja.dates || []), ...(jb.dates || [])])].sort();
    const al = (s, k) => { const m = new Map((s.dates || []).map((d, i) => [d, s[k][i]])); return dates.map(d => m.get(d) ?? null); };
    Charts.line($('#ce'), { dates, series: [{ name: 'A · ' + r.a, values: al(ja, 'equity'), color: C().a }, { name: 'B · ' + r.b, values: al(jb, 'equity'), color: C().b }], fmt: v => '$' + Math.round(v).toLocaleString() });
    Charts.line($('#cd'), { dates, series: [{ name: 'A · ' + r.a, values: al(ja, 'drawdown'), color: C().a }, { name: 'B · ' + r.b, values: al(jb, 'drawdown'), color: C().b }], fmt: v => (v * 100).toFixed(1) + '%', zero: true });
    Charts.heat($('#ha'), ja.monthly); Charts.heat($('#hb'), jb.monthly);
    const ha = hist(A.series.trade_returns, 20), all = [...(A.series.trade_returns || []), ...(B.series.trade_returns || [])];
    if (all.length) { const lo = Math.min(...all), hi = Math.max(...all) + 1e-9, n = 20, w = (hi - lo) / n, cA = new Array(n).fill(0), cB = new Array(n).fill(0);
      for (const x of A.series.trade_returns || []) cA[Math.min(n - 1, Math.floor((x - lo) / w))]++; for (const x of B.series.trade_returns || []) cB[Math.min(n - 1, Math.floor((x - lo) / w))]++;
      Charts.bars($('#td'), { labels: cA.map((_, i) => ((lo + (i + .5) * w) * 100).toFixed(1) + '%'), values: cA.map((v, i) => [v, cB[i]]), colors: [C().a, C().b], legend: [{ name: 'A · ' + r.a, color: C().a }, { name: 'B · ' + r.b, color: C().b }], fmt: v => v + ' trades' }); }
    else $('#td').innerHTML = '<div class="muted small">No closed trades.</div>'; void ha;
    const ks = ['0x', '1x', '2x', '3x'];
    Charts.bars($('#cs'), { labels: ks.map(k => k + ' costs'), values: ks.map(k => [r.cost_sensitivity.A[k]?.sharpe, r.cost_sensitivity.B[k]?.sharpe]), colors: [C().a, C().b], legend: [{ name: 'A · ' + r.a, color: C().a }, { name: 'B · ' + r.b, color: C().b }], fmt: v => (+v).toFixed(2), yfmt: v => v.toFixed(1) });
  }

  R.optimize = async (p) => {
    view.innerHTML = `<h1>Parameter Optimization</h1><p class="sub">Grid search with an in-sample / out-of-sample split. The selected parameter set is the most <i>robust</i> one in-sample (average Sharpe of the set and its grid neighbours, penalised for too few trades) — never simply the highest return. The in-sample vs out-of-sample rank correlation shows whether in-sample results carry any information; use Walk-Forward Analysis for rolling validation.</p>
      <form class="f card" id="of"><label class="fld">Strategy${stratSel('strategy', p.s || 'A')}</label>${pairFields(p)}${dateFields(p)}<label class="fld">In-sample share<select name="is_frac"><option value="0.6">60%</option><option value="0.7" selected>70%</option><option value="0.8">80%</option></select></label>${await costFields()}<button class="b">Optimise</button></form><div id="st"></div><div id="out"></div>`;
    $('#of').onsubmit = async e => { e.preventDefault(); const o = formData($('#of')); o.is_frac = +o.is_frac; const r = await job('/api/optimize', o, $('#st')); render(r); };
    function render(r) {
      if (!r.ok) { $('#out').innerHTML = `<div class="status err">${esc(r.error)}</div>`; return; }
      const keys = Object.keys(r.grid); const rows = r.rows.slice().sort((a, b) => (b.robust_score ?? -9) - (a.robust_score ?? -9));
      $('#out').innerHTML = dataLine(r.data) + `<div class="grid g3"><div class="card kpi"><div class="l">Selected (robust)</div><div class="v small mono" style="font-size:13px">${esc(JSON.stringify(r.selected.params))}</div><div class="s">IS Sharpe ${num(r.selected.is_sharpe)} → OOS ${num(r.selected.oos_sharpe)} · ${r.selected.oos_trades} OOS trades</div></div>
        <div class="card kpi"><div class="l">Highest in-sample Sharpe</div><div class="v small mono" style="font-size:13px">${esc(JSON.stringify(r.highest_in_sample.params))}</div><div class="s">IS ${num(r.highest_in_sample.is_sharpe)} → OOS ${num(r.highest_in_sample.oos_sharpe)}</div></div>
        <div class="card kpi"><div class="l">IS → OOS rank correlation</div><div class="v">${num(r.is_oos_rank_corr)}</div><div class="s">${esc(r.trials_note)} · split at ${r.split}</div></div></div>
        ${r.warnings.map(w => `<div class="status err">${esc(w)}</div>`).join('')}
        <div class="grid g2" style="margin-top:14px"><div class="card"><h2>In-sample vs out-of-sample Sharpe (each dot = one parameter set)</h2><div id="sc"></div></div>
        <div class="card"><h2>Heatmap: mean OOS Sharpe</h2><form class="f" id="hf"><label class="fld">Rows<select name="r">${keys.map((k, i) => `<option ${i === 0 ? 'selected' : ''}>${k}</option>`).join('')}</select></label><label class="fld">Columns<select name="c">${keys.map((k, i) => `<option ${i === 1 ? 'selected' : ''}>${k}</option>`).join('')}</select></label></form><div id="hm" style="margin-top:8px"></div></div></div>
        <div class="card" style="margin-top:14px"><h2>All parameter sets (ranked by robust score)</h2><div class="scroll"><table><thead><tr>${keys.map(k => `<th>${k}</th>`).join('')}<th class="n">Robust score</th><th class="n">IS Sharpe</th><th class="n">OOS Sharpe</th><th class="n">IS return</th><th class="n">OOS return</th><th class="n">IS / OOS trades</th></tr></thead><tbody>
        ${rows.map(x => `<tr>${keys.map(k => `<td class="mono">${x.params[k]}</td>`).join('')}<td class="n">${num(x.robust_score)}</td><td class="n">${num(x.is_sharpe)}</td><td class="n">${num(x.oos_sharpe)}</td><td class="n">${pct(x.is_return)}</td><td class="n">${pct(x.oos_return)}</td><td class="n">${x.is_trades} / ${x.oos_trades}</td></tr>`).join('')}</tbody></table></div></div>`;
      scatter($('#sc'), r.rows);
      const hm = () => { const rk = $('#hf [name=r]').value, ck = $('#hf [name=c]').value, rv = r.grid[rk], cv = r.grid[ck];
        const cell = (a, b) => { const v = r.rows.filter(x => x.params[rk] === a && x.params[ck] === b).map(x => x.oos_sharpe).filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
        const mx = Math.max(0.5, ...r.rows.map(x => Math.abs(x.oos_sharpe || 0)));
        $('#hm').innerHTML = `<table><thead><tr><th>${rk} \\ ${ck}</th>${cv.map(c => `<th class="n">${c}</th>`).join('')}</tr></thead><tbody>${rv.map(a => `<tr><td class="mono">${a}</td>${cv.map(b => { const v = cell(a, b); const col = v == null ? 'transparent' : `rgba(${v >= 0 ? '57,135,229' : '217,89,38'},${0.12 + 0.7 * Math.min(1, Math.abs(v) / mx)})`; return `<td class="n" style="background:${col}">${v == null ? '—' : v.toFixed(2)}</td>`; }).join('')}</tr>`).join('')}</tbody></table>`; };
      $('#hf').onchange = hm; hm();
    }
  };
  function scatter(host, rows) {
    const pts = rows.filter(r => r.is_sharpe != null && r.oos_sharpe != null); if (!pts.length) { host.innerHTML = '<div class="muted small">No points.</div>'; return; }
    const W = host.clientWidth || 500, H = 240, m = { l: 44, r: 10, t: 10, b: 30 };
    const xs = pts.map(p => p.is_sharpe), ys = pts.map(p => p.oos_sharpe);
    const x0 = Math.min(0, ...xs), x1 = Math.max(0, ...xs) + 1e-9, y0 = Math.min(0, ...ys), y1 = Math.max(0, ...ys) + 1e-9;
    const X = v => m.l + (W - m.l - m.r) * (v - x0) / (x1 - x0), Y = v => m.t + (H - m.t - m.b) * (1 - (v - y0) / (y1 - y0));
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" style="width:100%"><line x1="${X(0)}" x2="${X(0)}" y1="${m.t}" y2="${H - m.b}" stroke="${Charts.css('--line2')}"/><line x1="${m.l}" x2="${W - m.r}" y1="${Y(0)}" y2="${Y(0)}" stroke="${Charts.css('--line2')}"/>
      ${pts.map((p, i) => `<circle cx="${X(p.is_sharpe)}" cy="${Y(p.oos_sharpe)}" r="5" fill="${Charts.css('--s1')}" stroke="${Charts.css('--panel')}" stroke-width="2" data-i="${i}"/>`).join('')}
      <text x="${W - m.r}" y="${H - 8}" text-anchor="end" fill="${Charts.css('--muted')}" font-size="10.5">in-sample Sharpe →</text><text x="${m.l + 4}" y="${m.t + 10}" fill="${Charts.css('--muted')}" font-size="10.5">↑ out-of-sample Sharpe</text></svg>`;
    host.querySelectorAll('circle').forEach(c => { const p = pts[+c.dataset.i]; const f = ev => { const t = $('#tip'); t.innerHTML = `<div class="h mono">${esc(JSON.stringify(p.params))}</div><div class="r"><span>IS Sharpe</span><b>${num(p.is_sharpe)}</b></div><div class="r"><span>OOS Sharpe</span><b>${num(p.oos_sharpe)}</b></div>`; t.hidden = false; t.style.left = ev.clientX + 12 + 'px'; t.style.top = ev.clientY + 12 + 'px'; };
      c.addEventListener('pointermove', f); c.addEventListener('pointerdown', f); c.addEventListener('pointerleave', () => $('#tip').hidden = true); });
  }

  R.backtest = async (p) => {
    view.innerHTML = `<h1>Historical Backtesting</h1><p class="sub">Daily bars, dividend-adjusted where the provider lists dividends. Signals at the close; fills at the next session's open with half the quoted spread plus slippage and fees per side; shorts pay borrow. Positions keep their entry sizing until exit (no daily rebalancing). Survivorship note: the universe is today's index membership — free historical membership data is not available, so delisted names are missing.</p>
      <form class="f card" id="bf"><label class="fld">Strategy${stratSel('strategy', p.s || 'A')}</label>${pairFields(p)}${dateFields(p)}${capField()}${await costFields()}<details style="flex-basis:100%"><summary>Parameters (JSON, optional — blank uses defaults)</summary><textarea name="params" rows="3" style="width:100%;margin-top:6px;background:var(--bg);color:var(--text);border:1px solid var(--line2);border-radius:7px;font-family:var(--mono);font-size:12px" placeholder='{"entry": 2.0, "lookback": 30}'></textarea></details><button class="b">Run backtest</button></form><div id="st"></div><div id="out"></div>`;
    $('#bf').onsubmit = async e => { e.preventDefault(); const o = formData($('#bf'));
      if (o.params) { try { o.params = JSON.parse(o.params); } catch { $('#st').innerHTML = '<div class="status err">Parameters must be valid JSON.</div>'; return; } } else delete o.params;
      const r = await job('/api/backtest', o, $('#st')); renderBT($('#out'), r); };
  };
  function renderBT(host, r) {
    const m = r.metrics;
    host.innerHTML = dataLine(r.data) + `<div class="grid g4">${[['Total return', pct(m.total_return)], ['CAGR', pct(m.cagr)], ['Sharpe', num(m.sharpe)], ['Max drawdown', pct(m.max_drawdown)]].map(([l, v]) => `<div class="card kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('')}</div>
      <div class="grid g2" style="margin-top:14px"><div class="card"><h2>${r.strategy} on ${r.pair.join('/')} · ${r.start} → ${r.end}</h2>${metricsTable([{ label: r.strategy, m }])}<div class="small dim" style="margin-top:6px">Parameters: <span class="mono">${esc(JSON.stringify(r.params))}</span></div></div>
      <div class="card"><h2>Regimes (SPY)</h2>${regimeTable(m)}<h2 style="margin-top:14px">Signal</h2><div id="dg"></div></div></div><div id="rc" style="margin-top:14px"></div><div class="card" style="margin-top:14px"><h2>Trades</h2>${tradesTable(r.trades)}</div>`;
    resultCharts($('#rc', host), r.series, C().a);
    const zk = Object.keys(r.diag || {}).find(k => k === 'z' || k.startsWith('z_'));
    if (zk) { const d = r.diag[zk]; const e = r.params.entry; Charts.line($('#dg', host), { dates: d.dates, series: [{ name: zk, values: d.values, color: C().a }], refs: e ? [{ v: e }, { v: -e }] : [], fmt: v => v.toFixed(2), height: 160 }); }
    else $('#dg', host).innerHTML = '<div class="muted small">—</div>';
  }

  R.walkforward = async (p) => {
    view.innerHTML = `<h1>Walk-Forward Analysis</h1><p class="sub">Rolling train → test. In each fold the parameter grid is evaluated on the training window only; the most robust set is then applied to the next, unseen test window. The stitched test windows form the out-of-sample record. The deflated Sharpe ratio adjusts for the number of parameter sets tried.</p>
      <form class="f card" id="wf"><label class="fld">Strategy${stratSel('strategy', p.s || 'A')}</label>${pairFields(p)}${dateFields(p)}${capField()}<label class="fld">Train / test sessions<span><input type="number" name="train_days" value="504" style="width:72px"> / <input type="number" name="test_days" value="126" style="width:64px"></span></label>${await costFields()}<button class="b">Run walk-forward</button></form><div id="st"></div><div id="out"></div>`;
    $('#wf').onsubmit = async e => { e.preventDefault(); const r = await job('/api/walkforward', formData($('#wf')), $('#st'));
      if (!r.ok) { $('#out').innerHTML = `<div class="status err">${esc(r.error)}</div>`; return; }
      const m = r.metrics;
      $('#out').innerHTML = dataLine(r.data) + `<div class="grid g4">${[['OOS Sharpe', num(m.sharpe)], ['OOS total return', pct(m.total_return)], ['Deflated Sharpe', num(m.deflated_sharpe)], ['Positive folds', pct(m.fold_positive_share, 0)]].map(([l, v]) => `<div class="card kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('')}</div>
        <div class="card" style="margin-top:14px"><h2>Folds (${r.folds.length}) · ${r.combos_tested} parameter sets per fold</h2><div class="scroll"><table><thead><tr><th>Train</th><th>Test</th><th>Chosen parameters</th><th class="n">Train Sharpe</th><th class="n">Test Sharpe</th><th class="n">Test return</th><th class="n">Test trades</th></tr></thead><tbody>
        ${r.folds.map(f => `<tr><td class="mono small">${f.train[0]} → ${f.train[1]}</td><td class="mono small">${f.test[0]} → ${f.test[1]}</td><td class="mono small">${esc(JSON.stringify(f.params))}</td><td class="n">${num(f.train_sharpe)}</td><td class="n">${num(f.test_sharpe)}</td><td class="n">${pct(f.test_return)}</td><td class="n">${f.test_trades}</td></tr>`).join('')}</tbody></table></div></div>
        <div class="grid g2" style="margin-top:14px"><div class="card"><h2>Out-of-sample metrics</h2>${metricsTable([{ label: 'OOS', m }])}</div><div class="card"><h2>Regimes (SPY)</h2>${regimeTable(m)}</div></div><div id="rc" style="margin-top:14px"></div><div class="card" style="margin-top:14px"><h2>Out-of-sample trades</h2>${tradesTable(r.trades)}</div>`;
      resultCharts($('#rc'), r.series, C().a, '(stitched out-of-sample)'); };
  };

  R.portfolio = async (p) => {
    view.innerHTML = `<h1>Portfolio Construction</h1><p class="sub">Strategy H: the top accepted pairs from the latest scan, each traded by the chosen pair strategy in its own book. Risk limits from Settings apply day by day: capital per pair (risk-parity), max concurrent pairs, sector gross, total gross and net exposure, and a portfolio drawdown halt that blocks new entries. Note: pairs are selected with today's scan, so this backtest carries selection bias — read it as a construction test, not a forecast.</p>
      <form class="f card" id="hf"><label class="fld">Pair strategy${stratSel('strategy', 'A', s => s.kind === 'pair')}</label><label class="fld">Pairs<input type="number" name="n_pairs" value="8" min="2" max="20"></label>
      <label class="fld">Neutrality<select name="neutral"><option value="dollar">Dollar-neutral</option><option value="beta">Beta-neutral</option></select></label>${dateFields(p)}${capField()}${await costFields()}<button class="b">Build portfolio</button></form><div id="st"></div><div id="out"></div>`;
    $('#hf').onsubmit = async e => { e.preventDefault(); const r = await job('/api/portfolio', formData($('#hf')), $('#st'));
      if (!r.ok) { $('#out').innerHTML = `<div class="status err">${esc(r.error)}</div>`; return; }
      const m = r.metrics, rk = r.risk;
      $('#out').innerHTML = dataLine(r.data) + `<div class="grid g4">${[['Sharpe', num(m.sharpe)], ['CAGR', pct(m.cagr)], ['Max drawdown', pct(m.max_drawdown)], ['Beta to SPY', num(m.beta)]].map(([l, v]) => `<div class="card kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('')}</div>
        ${r.halted_on ? `<div class="status err">Drawdown limit breached on ${r.halted_on}: new entries were blocked from then on.</div>` : ''}
        <div class="grid g2" style="margin-top:14px"><div class="card"><h2>Limits vs what the backtest reached</h2><table><tbody>
          <tr><td>Max gross exposure</td><td class="n">${num(r.max_gross_seen)} / ${num(rk.max_gross)}</td></tr><tr><td>Max |net| exposure</td><td class="n">${num(r.max_abs_net_seen)} / ${num(rk.max_net)}</td></tr>
          ${Object.entries(r.max_sector_gross_seen).map(([k, v]) => `<tr><td>Sector gross — ${esc(k)}</td><td class="n">${num(v)} / ${num(rk.max_sector_gross)}</td></tr>`).join('')}
          <tr><td>Entries blocked by limits</td><td class="n">${esc(Object.entries(r.blocked_entries).map(([k, v]) => `${k} ${v}`).join(' · '))}</td></tr></tbody></table></div>
        <div class="card"><h2>P&amp;L by pair</h2><table><tbody>${Object.entries(r.pair_pnl).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${k}</td><td class="n">${usd(v)}</td></tr>`).join('')}</tbody></table></div>
        <div class="card"><h2>Metrics</h2>${metricsTable([{ label: 'Portfolio', m }])}</div><div class="card"><h2>Regimes</h2>${regimeTable(m)}</div></div><div id="rc" style="margin-top:14px"></div><div class="card" style="margin-top:14px"><h2>Trades</h2>${tradesTable(r.trades)}</div>`;
      resultCharts($('#rc'), r.series, C().a); };
  };

  R.risk = async () => {
    view.innerHTML = `<h1>Risk Monitor</h1><p class="sub">Limits are enforced on the server before any paper entry is recorded. A breach blocks new entries; exits still execute.</p><div class="grid g2"><div class="card"><h2>Paper book vs limits</h2><div id="lim"></div></div><div class="card"><h2>Open and pending positions</h2><div id="pos"></div></div></div>
      <div class="card" style="margin-top:14px"><h2>Pre-trade checks on current opportunities</h2><div id="chk"></div></div>`;
    const [pb, o] = await Promise.all([api('/api/paper'), api('/api/opportunities')]);
    const rk = pb.risk, pos = pb.positions || [];
    const eq = (pb.equity || []).slice(-1)[0]?.[1] || pb.start_cash || 100000; const peak = Math.max(pb.start_cash || 100000, ...(pb.equity || []).map(e => e[1]));
    const gross = pos.reduce((s, p) => s + (p.status !== 'pending_entry' ? p.alloc : 0), 0);
    const bySec = {}; pos.forEach(p => bySec[p.sector] = (bySec[p.sector] || 0) + p.alloc);
    const dd = eq / peak - 1;
    const row = (l, v, lim, ok) => `<tr><td>${l}</td><td class="n">${v}</td><td class="n">${lim}</td><td>${okPill(ok, ok ? 'within' : 'breach')}</td></tr>`;
    $('#lim').innerHTML = `<table><thead><tr><th>Limit</th><th class="n">Now</th><th class="n">Limit</th><th></th></tr></thead><tbody>` +
      row('Portfolio drawdown', pct(dd), '−' + pct(rk.max_drawdown), !pb.halted && -dd < rk.max_drawdown) + row('Concurrent pairs', pos.length, rk.max_positions, pos.length <= rk.max_positions) +
      row('Gross exposure (alloc)', num(gross), num(rk.max_gross), gross <= rk.max_gross) +
      Object.entries(bySec).map(([k, v]) => row('Sector gross — ' + esc(k), num(v), num(rk.max_sector_gross), v <= rk.max_sector_gross)).join('') +
      `</tbody></table><div class="small dim" style="margin-top:8px">Other enforced filters: per-pair allocation ${pct(rk.max_alloc_per_pair, 0)}, min 20-day median traded value ${usd(rk.min_dollar_volume)} per leg, min price $${rk.min_price}, Engle-Granger p &lt; ${rk.max_coint_p}, Johansen ≥ ${pct(rk.min_johansen_conf, 0)}, half-life ${rk.hl_min}–${rk.hl_max} d, Hurst &lt; ${rk.max_hurst}, edge ≥ ${rk.min_edge_to_cost}× round-trip cost, stop at |z| ≥ ${rk.stop_z}.${pb.halted ? `<br><b>HALTED since ${pb.halted}.</b>` : ''}</div>`;
    $('#pos').innerHTML = pos.length ? `<table><thead><tr><th>Pair</th><th>Side</th><th>Status</th><th class="n">z</th><th class="n">Alloc</th><th>Why</th></tr></thead><tbody>${pos.map(p => `<tr><td>${p.y}/${p.x}</td><td>${p.side > 0 ? 'long' : 'short'} spread</td><td>${esc(p.status)}</td><td class="n">${num(p.z ?? p.z_entry)}</td><td class="n">${pct(p.alloc, 0)}</td><td class="small">${esc(p.why)}</td></tr>`).join('')}</tbody></table>` : '<div class="muted small">No positions.</div>';
    $('#chk').innerHTML = o.rows.length ? `<table><thead><tr><th>Pair</th><th class="n">z now</th><th>Data</th>${(o.rows[0].live.checks || []).map(c => `<th>${esc(c.check.replace(/\(.*\)/, ''))}</th>`).join('')}<th>Eligible</th></tr></thead><tbody>${o.rows.map(r => `<tr><td>${r.y}/${r.x}</td><td class="n">${num(r.live.z)}</td><td>${pill(r.live.z_status || 'unavailable')}</td>${(r.live.checks || []).map(c => `<td title="${esc(c.detail)}">${okPill(c.pass, c.pass ? 'pass' : 'fail')}</td>`).join('')}<td>${okPill(r.live.eligible, r.live.eligible ? 'yes' : 'no')}</td></tr>`).join('')}</tbody></table>` : `<div class="muted small">${esc(o.note || 'No pair near its entry threshold.')}</div>`;
  };

  R.trades = async () => {
    view.innerHTML = `<h1>Trade History</h1><p class="sub">Paper trades are decided on the session close and filled at the next session's official open (from daily bars), with the configured spread, slippage and fees. Backtest trades come from saved runs.</p>
      <div class="card"><h2>Paper book</h2><div id="pb"></div></div><div class="card" style="margin-top:14px"><h2>Backtest trades</h2><form class="f"><label class="fld">Saved run<select id="run"><option value="">—</option></select></label></form><div id="bt" style="margin-top:10px"></div></div>`;
    const pb = await api('/api/paper');
    const open = pb.positions || [], closed = (pb.closed || []).slice().reverse();
    $('#pb').innerHTML = `<div class="small dim" style="margin-bottom:8px">Cash ${usd(pb.cash)} · started with ${usd(pb.start_cash)} · last update ${esc(pb.updated || '—')}${pb.halted ? ' · <b>new entries halted since ' + pb.halted + '</b>' : ''}</div>` +
      (open.length ? `<h2 style="font-size:12.5px">Open / pending</h2><table><thead><tr><th>Pair</th><th>Status</th><th>Signal</th><th>Entry fill</th><th class="n">Shares Y / X</th><th class="n">Mark (Y / X)</th><th>Why</th></tr></thead><tbody>${open.map(p => { const my = pb.marks[p.y] || {}, mx = pb.marks[p.x] || {};
        return `<tr><td>${p.y}/${p.x}</td><td>${esc(p.status)}</td><td class="mono small">${p.signal_date}</td><td class="mono small">${p.entry_date || 'next open'}</td><td class="n">${num(p.sh_y, 0)} / ${num(p.sh_x, 0)}</td><td class="small">${my.quote ? '$' + num(my.quote) + ' ' + pill(my.quote_status) : '$' + num(my.close) + ' ' + pill('historical', my.date)} · ${mx.quote ? '$' + num(mx.quote) + ' ' + pill(mx.quote_status) : '$' + num(mx.close) + ' ' + pill('historical', mx.date)}</td><td class="small">${esc(p.why)}</td></tr>`; }).join('')}</tbody></table>` : '<div class="muted small">No open positions.</div>') +
      `<h2 style="font-size:12.5px;margin-top:14px">Closed</h2>` + (closed.length ? `<table><thead><tr><th>Pair</th><th>Entry</th><th>Exit</th><th>Exit reason</th><th class="n">Leg P&amp;L</th><th class="n">P&amp;L</th></tr></thead><tbody>${closed.map(p => `<tr><td>${p.y}/${p.x} (${p.side > 0 ? 'long' : 'short'} spread)</td><td class="mono small">${p.entry_date}</td><td class="mono small">${p.exit_date}</td><td>${esc(p.exit_reason)}</td><td class="n small">${Object.entries(p.leg_pnl).map(([s, v]) => `${s} ${usd(v)}`).join('<br>')}</td><td class="n">${usd(p.pnl)}</td></tr>`).join('')}</tbody></table>` : '<div class="muted small">No closed paper trades yet.</div>');
    const runs = (await api('/api/runs?limit=60')).filter(r => ['backtest', 'walkforward', 'portfolio', 'compare'].includes(r.kind));
    $('#run').innerHTML = '<option value="">—</option>' + runs.map(r => `<option value="${r.id}">${esc(r.title)} · ${ago(r.created_at)}</option>`).join('');
    $('#run').onchange = async () => { if (!$('#run').value) return; const r = (await api('/api/runs/' + $('#run').value)).payload;
      if (r.full) $('#bt').innerHTML = `<h2 style="font-size:12.5px">A · ${r.a}</h2>${tradesTable(r.full.A.trades)}<h2 style="font-size:12.5px;margin-top:12px">B · ${r.b}</h2>${tradesTable(r.full.B.trades)}`;
      else $('#bt').innerHTML = tradesTable(r.trades); };
  };

  R.performance = async () => {
    view.innerHTML = `<h1>Performance Analytics</h1><p class="sub">Rankings use the research agent's walk-forward, out-of-sample results across every pair it has tested. Composite rank = average of the ranks on OOS Sharpe, Sortino, drawdown, profit factor, fold stability, deflated Sharpe (significance), cost sensitivity and monthly consistency.</p>
      <div class="card"><h2>Leaderboard</h2><div id="lb"></div></div><div class="card" style="margin-top:14px"><h2>Research reports (per pair)</h2><div id="rp"></div></div><div class="card" style="margin-top:14px"><h2>All strategy × pair results</h2><div id="rs"></div></div>`;
    const [lb, rs] = await Promise.all([api('/api/leaderboard'), api('/api/research')]);
    const cats = Object.entries(lb.categories || {});
    $('#lb').innerHTML = (lb.note ? `<div class="status">${esc(lb.note)}</div>` : '') + `<div class="grid g3" style="margin-bottom:12px">${cats.map(([k, v]) => `<div class="card kpi"><div class="l">${k}</div><div class="v" style="font-size:16px">${v ? v.strategy + ' · ' + esc(v.name) : '—'}</div><div class="s">${v ? esc(v.metric) + ' ' + (/drawdown|share/.test(v.metric) ? pct(v.value) : num(v.value)) : 'no data'}</div></div>`).join('')}</div>` +
      (lb.strategies.length ? `<div class="scroll"><table><thead><tr><th>Rank</th><th>Strategy</th><th class="n">Pairs</th><th class="n">Qualified</th><th class="n">Med. OOS Sharpe</th><th class="n">Med. Sortino</th><th class="n">Med. max DD</th><th class="n">Med. PF</th><th class="n">Stability</th><th class="n">Med. deflated SR</th><th class="n">Sharpe @2× costs</th><th class="n">Consistency</th></tr></thead><tbody>
      ${lb.strategies.map(s => `<tr><td class="n">${num(s.composite_rank, 1)}</td><td><b>${s.strategy}</b> ${esc(s.name)}</td><td class="n">${s.pairs_tested}</td><td class="n">${s.qualified_pairs}</td><td class="n">${num(s.median_oos_sharpe)}</td><td class="n">${num(s.median_sortino)}</td><td class="n">${pct(s.median_max_dd)}</td><td class="n">${num(s.median_profit_factor)}</td><td class="n">${pct(s.stability, 0)}</td><td class="n">${num(s.median_deflated_sharpe)}</td><td class="n">${num(s.median_sharpe_2x_costs)}</td><td class="n">${pct(s.consistency, 0)}</td></tr>`).join('')}</tbody></table></div>` : '');
    $('#rp').innerHTML = rs.reports.length ? rs.reports.map(r => `<details style="border-top:1px solid var(--line);padding:8px 0"><summary><b>${esc(r.summary.pair)}</b> — ${esc(r.summary.conclusion)} <span class="small muted">(scan ${r.summary.scan})</span></summary><div class="rep small" data-id="${r.id}" style="margin-top:6px">Loading…</div></details>`).join('') : '<div class="muted small">Reports appear once the agent finishes all strategies for a pair.</div>';
    $('#rp').querySelectorAll('details').forEach(d => d.addEventListener('toggle', async () => { const b = $('.rep', d); if (!d.open || b.dataset.done) return; const r = await api('/api/runs/' + b.dataset.id); b.innerHTML = r.payload.lines.map(l => `<p>${esc(l)}</p>`).join(''); b.dataset.done = 1; }));
    const rows = rs.results;
    $('#rs').innerHTML = rows.length ? `<div class="scroll"><table><thead><tr><th>Pair</th><th>Strategy</th><th class="n">OOS Sharpe</th><th class="n">Return</th><th class="n">Max DD</th><th class="n">Trades</th><th class="n">Deflated</th><th class="n">@2× costs</th><th>Verdict</th></tr></thead><tbody>${rows.map(r => `<tr><td>${r.pair}</td><td>${r.strategy} ${esc(r.name)}</td><td class="n">${num(r.oos_sharpe)}</td><td class="n">${pct(r.oos_return)}</td><td class="n">${pct(r.max_drawdown)}</td><td class="n">${r.trades}</td><td class="n">${num(r.deflated_sharpe)}</td><td class="n">${num(r.sharpe_2x_costs)}</td><td>${r.qualifies ? okPill(true, 'qualifies') : `<span class="pill bad" title="${esc(r.reasons.join('; '))}">fails: ${esc(r.reasons[0] || '')}</span>`}</td></tr>`).join('')}</tbody></table></div>` : '<div class="muted small">No research results yet.</div>';
  };

  R.settings = async () => {
    view.innerHTML = `<h1>Data Connections &amp; Settings</h1><p class="sub">Data status vocabulary: ${pill('live')} provider marks the quote real-time · ${pill('delayed')} intraday but not real-time · ${pill('historical')} end-of-day bars · ${pill('unavailable')} the provider failed and nothing was substituted.</p>
      <div class="grid g2"><div class="card"><h2>Providers</h2><div id="prov"></div></div><div class="card"><h2>Universe</h2><div id="uni"></div></div><div class="card"><h2>Risk limits</h2><form id="rf" class="f"></form></div><div class="card"><h2>Costs &amp; agent</h2><form id="cf" class="f"></form></div></div>
      <div class="card" style="margin-top:14px"><h2>Recent data errors</h2><div id="errs"></div></div><div class="card" style="margin-top:14px"><h2>Agent log</h2><div id="log" class="log"></div></div>`;
    const [s, st] = await Promise.all([api('/api/status'), api('/api/settings')]);
    const d = s.data, ok = d.by_status?.ok || {}, er = d.by_status?.error || {};
    $('#prov').innerHTML = `<table><tbody><tr><td>Daily bars (primary)</td><td>Nasdaq historical API ${pill('historical')}</td></tr><tr><td>Daily bars (fallback)</td><td>Yahoo chart v8 — usually refused from cloud servers; failures are logged, not hidden</td></tr>
      <tr><td>Dividends</td><td>Nasdaq dividend history → backward total-return adjustment</td></tr><tr><td>Quotes</td><td>Nasdaq quote API — labelled live / delayed per the provider's own real-time flag</td></tr>
      <tr><td>Constituents</td><td>Wikipedia S&amp;P 500 &amp; Nasdaq-100 lists, Nasdaq screener (sectors, high-volume names), fixed ETF list</td></tr>
      <tr><td>Symbols OK</td><td class="n">${ok.symbols || 0} · latest bar ${ok.latest_bar || '—'} · last fetch ${ago(ok.last_fetch)}</td></tr><tr><td>Symbols failing</td><td class="n">${er.symbols || 0}</td></tr>
      <tr><td>Sources in use</td><td>${esc(Object.entries(d.sources || {}).map(([k, v]) => `${k}: ${v}`).join(' · ') || '—')}</td></tr><tr><td>Expected last session</td><td class="n">${d.expected_last_session}</td></tr><tr><td>Storage</td><td>${esc(s.db)}</td></tr></tbody></table>
      <div class="small dim" style="margin-top:8px">Not available from free sources: point-in-time index membership (so survivorship bias is reduced but not removed), Russell 1000 constituents, and real-time consolidated quotes.</div>`;
    const u = d.universe || {};
    $('#uni').innerHTML = u.updated_at ? `<table><tbody><tr><td>S&amp;P 500</td><td class="n">${u.sp500}</td></tr><tr><td>Nasdaq-100</td><td class="n">${u.ndx}</td></tr><tr><td>ETFs</td><td class="n">${u.etf}</td></tr><tr><td>High-volume names</td><td class="n">${u.liquid}</td></tr><tr><td>Total unique</td><td class="n">${u.total ?? '—'}</td></tr><tr><td>Updated</td><td class="n">${ago(u.updated_at)}</td></tr></tbody></table>${(u.errors || []).map(e => `<div class="pill warn" style="margin-top:6px">${esc(e)}</div>`).join('')}` : '<div class="muted small">Not loaded yet — the agent loads it on its first tick.</div>';
    const lab = { max_drawdown: 'Max portfolio drawdown (0–1)', max_alloc_per_pair: 'Max allocation per pair', max_sector_gross: 'Max sector gross', max_gross: 'Max gross exposure', max_net: 'Max |net| exposure', max_positions: 'Max concurrent pairs', stop_z: 'Stop |z|', min_dollar_volume: 'Min $ volume per leg', min_price: 'Min price', max_coint_p: 'Max Engle-Granger p', min_johansen_conf: 'Min Johansen confidence', hl_min: 'Min half-life', hl_max: 'Max half-life', max_hurst: 'Max Hurst', min_edge_to_cost: 'Min edge ÷ cost', entry_z: 'Entry |z|', exit_z: 'Exit |z|' };
    $('#rf').innerHTML = Object.entries(st.risk).map(([k, v]) => `<label class="fld">${lab[k] || k}<input type="number" step="any" name="${k}" value="${v}"></label>`).join('') + '<button class="b">Save limits</button><span id="rs" class="small dim"></span>';
    $('#cf').innerHTML = Object.entries(st.costs).map(([k, v]) => `<label class="fld">${k}<input type="number" step="any" name="${k}" value="${v}"></label>`).join('') + `<label class="fld">Research agent<select name="agent"><option value="1" ${st.agent_enabled ? 'selected' : ''}>running</option><option value="0" ${!st.agent_enabled ? 'selected' : ''}>paused</option></select></label><button class="b">Save</button><span id="cs" class="small dim"></span>`;
    $('#rf').onsubmit = async e => { e.preventDefault(); const o = Object.fromEntries(new FormData(e.target)); await api('/api/settings', { method: 'POST', body: { risk: o } }); SETTINGS = null; $('#rs').textContent = ' saved'; };
    $('#cf').onsubmit = async e => { e.preventDefault(); const o = Object.fromEntries(new FormData(e.target)); const ag = o.agent === '1'; delete o.agent; await api('/api/settings', { method: 'POST', body: { costs: o, agent_enabled: ag } }); SETTINGS = null; $('#cs').textContent = ' saved'; };
    $('#errs').innerHTML = d.errors.length ? `<table><tbody>${d.errors.map(e => `<tr><td><b>${esc(e.symbol)}</b></td><td class="small">${esc(e.error)}</td><td class="small dim">${ago(e.at)}</td></tr>`).join('')}</tbody></table>` : '<div class="muted small">None.</div>';
    $('#log').textContent = (s.agent.log || []).slice().reverse().join('\n') || '—';
  };

  // ------------------------------------------------------------------ Statistical Arbitrage Lab
  const SA_TABS = [['overview', 'Strategy Overview'], ['scanner', 'Live Pair Scanner'], ['coint', 'Cointegration Analysis'], ['zmon', 'Z-Score Monitor'],
    ['opps', 'Pair Opportunities'], ['paper', 'Active Paper Positions'], ['backtest', 'Historical Backtesting'], ['perf', 'Performance Analytics'],
    ['risk', 'Risk Management'], ['config', 'Strategy Configuration']];
  const SA_KEYS = ['K', 'A', 'V', 'B', 'I'];
  const saColor = k => ({ K: Charts.css('--s4'), A: Charts.css('--s3'), V: Charts.css('--s2'), B: '#8b7fd6', I: Charts.css('--s1') }[k]);
  R.statarb = async (p) => {
    const tab = p.tab || 'overview';
    view.innerHTML = `<h1>Statistical Arbitrage Lab</h1><p class="sub">Pairs trading built from the Quantopian lecture "Basic Statistical Arbitrage: Understanding the Math Behind Pairs Trading" (Max Margenot), plus an improved adaptive version. US stocks and ETFs, daily Nasdaq bars; paper only — no orders are sent anywhere.</p>
      <div class="tabs" style="flex-wrap:wrap">${SA_TABS.map(([k, l]) => `<button class="${k === tab ? 'on' : ''}" data-t="${k}">${l}</button>`).join('')}</div><div id="sa"></div>`;
    view.querySelectorAll('.tabs button').forEach(b => b.onclick = () => location.hash = '#/statarb?tab=' + b.dataset.t);
    const host = $('#sa');
    await (SA[tab] || SA.overview)(host, p);
  };
  const SA = {};
  SA.overview = async (h) => {
    const s = await api('/api/sa/summary'); const sm = s.summary;
    h.innerHTML = `<div class="grid g2"><div class="card rep"><h2>What the video teaches</h2>
      <p class="small dim">The video is the talk version of two public Quantopian notebooks ("Integration, Cointegration and Stationarity" and "Introduction to Pairs Trading"); I could not open the video or its transcript, so the method below is taken from those notebooks, which the talk walks through.</p>
      <ul class="small"><li><b>Stationarity.</b> A series is stationary when its mean and variance do not change over time. Prices are usually I(1) — integrated of order one — while their day-to-day changes are I(0), stationary.</li>
      <li><b>Cointegration ≠ correlation.</b> Two I(1) prices are cointegrated if some combination Y − β·X is I(0). Correlated series can drift apart forever; cointegrated ones are pulled back. Tested with Engle-Granger (statsmodels <span class="mono">coint</span>) and the ADF test on the spread, using p &lt; 0.05.</li>
      <li><b>Hedge ratio.</b> β from an ordinary least-squares regression of one price on the other; the lecture then uses a 30-day rolling regression so β keeps up with the market.</li>
      <li><b>Spread and z-score.</b> Spread = Y − β·X; z = (1-day average − 30-day average) / 30-day standard deviation.</li>
      <li><b>Rules.</b> Long the spread (buy Y, sell β·X) when z &lt; −1; short it when z &gt; +1; exit as z returns to zero.</li>
      <li><b>Warnings from the lecture.</b> Searching many pairs creates multiple-comparison bias; z-scores assume a distribution that financial data often violates; and a pair can stop being cointegrated — the lecture's own example pair failed the test in the following year. It lists ADF, Hurst exponent, Ornstein-Uhlenbeck half-life and Kalman filters as the next steps.</li></ul></div>
      <div class="card rep"><h2>The strategies compared</h2><ul class="small">
      <li><b>K · Basic correlation pairs</b> — distance method, no cointegration test (the approach the lecture warns against).</li>
      <li><b>A · Cointegration pairs</b> — log-price spread, rolling OLS hedge, trades only while rolling Engle-Granger passes.</li>
      <li><b>V · Video z-score pairs</b> — the lecture's rules exactly: 30-day rolling β on prices, z from 1-day vs 30-day averages, ±1 entry, exit at 0, trade only while cointegrated (p &lt; 0.05). The notebook regresses S1 on S2 but builds S2 − β·S1; V uses the consistent form.</li>
      <li><b>B · Single-stock z-score</b> — each stock against its own average.</li>
      <li><b>I · Improved adaptive stat-arb</b> — the lecture's "further research" list implemented: Kalman hedge ratio; trades only while rolling Engle-Granger <i>and</i> ADF on the spread pass and the OU half-life is 2–30 sessions; z-score lookback = 3 × half-life; entry ±2 raised automatically when the spread is turbulent; exit ±0.5; stop ±3.5; time stop 3 × half-life; emergency exit when cointegration breaks (rolling p &gt; 0.20); 5-session cooldown.</li></ul>
      <h3>Maths of I</h3><p class="small mono">β<sub>t</sub> : Kalman, y<sub>t</sub> = α<sub>t</sub> + β<sub>t</sub>x<sub>t</sub> + ε (log prices)<br>s<sub>t</sub> = ln Y<sub>t</sub> − β<sub>t</sub> ln X<sub>t</sub><br>z<sub>t</sub> = (s<sub>t</sub> − mean<sub>L</sub>(s)) / sd<sub>L</sub>(s), L = 3·HL<br>HL = ln2 / κ, s<sub>t+1</sub> = c + φ s<sub>t</sub> + e, κ = −ln φ<br>enter |z| ≥ 2·clip(√(σ<sub>20</sub>/σ<sub>120</sub>), 0.85, 1.5)</p></div></div>
      <div class="card" style="margin-top:14px"><h2>Latest comparison (pooled across the scanner's top pairs, after costs)</h2><div id="ov"></div></div>`;
    $('#ov', h).innerHTML = sm ? saTable(sm, '180') + `<div class="small dim" style="margin-top:8px">${pill('historical', 'to ' + sm.end)} Pairs: ${esc(sm.pairs.map(x => x.join('/')).join(', '))}. Full tables on <a href="#/statarb?tab=backtest">Historical Backtesting</a>.</div>` : '<div class="muted small">The agent runs the 30/60/90/180-day study after each scan; results appear here when it finishes.</div>';
  };
  function saTable(sm, hz) {
    const row = sm.by_horizon[hz] || {}; const best = sm.best_by_sharpe[hz];
    const cols = [['total_return', 'Return', pct], ['net_pnl', 'Net P&L $', v => num(v, 2)], ['gross_pnl', 'Gross P&L $', v => num(v, 2)], ['win_rate', 'Win rate', pct], ['trades', 'Trades', v => num(v, 0)],
      ['avg_win', 'Avg win $', v => num(v, 2)], ['avg_loss', 'Avg loss $', v => num(v, 2)], ['profit_factor', 'PF', num], ['sharpe', 'Sharpe', num], ['sortino', 'Sortino', num],
      ['max_drawdown', 'Max DD', pct], ['calmar', 'Calmar', num], ['max_consecutive_losses', 'Max consec. losses', v => num(v, 0)], ['fees', 'Fees $', v => num(v, 2)], ['slippage_costs', 'Spread+slippage $', v => num(v, 2)], ['borrow_costs', 'Borrow $', v => num(v, 2)]];
    return `<div class="scroll"><table><thead><tr><th>Strategy</th>${cols.map(c => `<th class="n">${c[1]}</th>`).join('')}</tr></thead><tbody>${SA_KEYS.filter(k => row[k]).map(k => `<tr><td><b>${k}</b> ${esc(({ K: 'Correlation', A: 'Cointegration', V: 'Video z-score', B: 'Single-stock z', I: 'Improved' })[k])}${k === best ? ' <span class="pill good">best Sharpe</span>' : ''}</td>${cols.map(([c, , f]) => `<td class="n">${f(row[k][c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="small dim" style="margin-top:6px">$1,000 per pair, ${row.I ? row.I.pairs : '—'} pairs, ${row.I ? row.I.sessions : '—'} sessions. Fixed default parameters (not fitted on this window). "Best Sharpe" needs a positive Sharpe and ≥ 5 trades; short windows hold few trades, so treat 30–90-day figures as anecdotal.</div>`;
  }
  SA.scanner = async (h) => {
    const [sc, pb] = await Promise.all([api('/api/scan/latest'), api('/api/sa/paper')]);
    const sig = Object.fromEntries((pb.signals || []).map(s => [s.y + '/' + s.x, s]));
    h.innerHTML = sc.empty ? `<div class="muted">${esc(sc.note)}</div>` : `<div class="card"><div class="small dim" style="margin-bottom:8px">${pill('historical', 'closes ' + sc.asof)} ${sc.candidates} candidate pairs from ${sc.liquid_symbols} liquid stocks; ${sc.accepted.length} passed Engle-Granger, Johansen, half-life, Hurst and the cost filter. Strategy-I columns from the paper engine's last update (${esc(pb.updated || '—')}).</div><div class="scroll"><table><thead><tr><th>Pair</th><th>Sector</th><th class="n">Corr</th><th class="n">EG p</th><th class="n">ADF p (I)</th><th class="n">Hedge β (I)</th><th class="n">Half-life</th><th class="n">z (I)</th><th>Status</th></tr></thead><tbody>
      ${sc.accepted.map(r => { const s = sig[r.y + '/' + r.x] || {}; return `<tr class="click" data-y="${r.y}" data-x="${r.x}"><td><b>${r.y}</b>/${r.x}</td><td class="small">${esc(r.sector)}</td><td class="n">${num(r.corr)}</td><td class="n">${num(r.eg_p, 4)}</td><td class="n">${num(s.adf_p, 4)}</td><td class="n">${num(s.beta, 3)}</td><td class="n">${num(s.half_life ?? r.half_life, 1)}</td><td class="n">${num(s.z)}</td><td>${s.side ? `<span class="pill warn">${s.side > 0 ? 'long' : 'short'} spread</span>` : s.coint_p != null && s.coint_p > 0.2 ? '<span class="pill bad">cointegration broken</span>' : '<span class="muted small">inside band</span>'}</td></tr>`; }).join('')}</tbody></table></div></div>`;
    h.querySelectorAll('tr.click').forEach(tr => tr.onclick = () => location.hash = `#/statarb?tab=zmon&y=${tr.dataset.y}&x=${tr.dataset.x}`);
  };
  SA.coint = async (h, p) => {
    h.innerHTML = `<form class="f card" id="cf">${pairFields(p)}<button class="b">Test pair</button></form><div id="co"></div>`;
    const go = async () => { const o = formData($('#cf')); $('#co').innerHTML = '<div class="status spin">Testing…</div>';
      const d = await api(`/api/pair?y=${o.y}&x=${o.x}`); const s = d.stats, j = s.johansen, ou = s.ou;
      $('#co').innerHTML = dataLine(d.data) + `<div class="grid g2"><div class="card"><h2>Tests (last two years)</h2><table><tbody>
        <tr><td>Return correlation</td><td class="mono small">${num(s.corr_returns)}</td><td class="small dim">correlation alone does not imply cointegration</td></tr>
        <tr><td>Engle-Granger Y on X</td><td class="mono small">p = ${num(s.eg_p, 4)}</td><td>${okPill(s.eg_p < 0.05, s.eg_p < 0.05 ? 'cointegrated' : 'not cointegrated')}</td></tr>
        <tr><td>Engle-Granger X on Y</td><td class="mono small">p = ${num(s.eg_p_reverse, 4)}</td><td>${okPill(s.eg_p_reverse < 0.05, s.eg_p_reverse < 0.05 ? 'pass' : 'fail')}</td></tr>
        <tr><td>ADF on the spread</td><td class="mono small">p = ${num(s.adf_p_spread, 4)}</td><td>${okPill(s.adf_p_spread < 0.05, s.adf_p_spread < 0.05 ? 'stationary' : 'not stationary')}</td></tr>
        <tr><td>Johansen trace</td><td class="mono small">${num(j.trace, 2)} vs 95% ${num(j.crit95, 2)}</td><td>${okPill(j.reject_conf >= 0.95, j.reject_conf >= 0.95 ? 'pass' : 'fail')}</td></tr>
        <tr><td>Hedge ratio (OLS, log)</td><td class="mono small">β ${num(s.beta, 4)}</td><td></td></tr>
        <tr><td>OU half-life</td><td class="mono small">${ou.ok ? num(ou.half_life, 1) + ' sessions' : esc(ou.reason)}</td><td>${okPill(ou.ok && ou.half_life >= 2 && ou.half_life <= 30, ou.ok && ou.half_life <= 30 ? 'tradeable' : 'too slow / none')}</td></tr>
        <tr><td>Hurst (spread)</td><td class="mono small">${num(s.hurst)}</td><td>${okPill(s.hurst < 0.5, s.hurst < 0.5 ? 'mean-reverting' : 'trending')}</td></tr></tbody></table></div>
        <div class="card"><h2>Spread (Y − β·X, log)</h2><div id="c1"></div></div></div>`;
      Charts.line($('#c1'), { dates: d.dates, series: [{ name: 'spread', values: d.spread, color: C().a }], fmt: v => v.toFixed(3) }); };
    $('#cf').onsubmit = e => { e.preventDefault(); go().catch(er => $('#co').innerHTML = `<div class="status err">${esc(er.message)}</div>`); };
    if (p.y) go().catch(er => $('#co').innerHTML = `<div class="status err">${esc(er.message)}</div>`);
  };
  SA.zmon = async (h, p) => {
    h.innerHTML = `<form class="f card" id="zf">${pairFields(p)}<label class="fld">Strategy<select name="strategy">${['I', 'V', 'A', 'K'].map(k => `<option ${k === (p.strategy || 'I') ? 'selected' : ''}>${k}</option>`).join('')}</select></label><button class="b">Show</button></form><div id="zo"></div>`;
    const go = async () => { const o = Object.fromEntries(new FormData($('#zf'))); o.y = o.y.toUpperCase(); o.x = o.x.toUpperCase(); store.set('pair', { y: o.y, x: o.x });
      $('#zo').innerHTML = '<div class="status spin">Calculating…</div>';
      const d = await api(`/api/sa/monitor?y=${o.y}&x=${o.x}&strategy=${o.strategy}`);
      const lz = d.live; const last = d.z ? d.z[d.z.length - 1] : null;
      $('#zo').innerHTML = dataLine(d.data) + `<div class="grid g4">${[['z at last close', num(last), pill('historical', d.dates[d.dates.length - 1])], ['z now', num(lz.z), pill(lz.status)], ['Hedge ratio β', num(d.beta ? d.beta[d.beta.length - 1] : null, 4), ''], ['Position (signal)', ['short spread', 'flat', 'long spread'][(d.position[d.position.length - 1] || 0) + 1], '']].map(([l, v, s]) => `<div class="card kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('')}</div>
        <div class="grid g2" style="margin-top:14px"><div class="card"><h2>Z-score with entry / exit / stop bands (${d.strategy})</h2><div id="z1"></div></div><div class="card"><h2>Normalised prices</h2><div id="z2"></div></div>
        ${d.coint_p ? '<div class="card"><h2>Rolling cointegration p-value (≤ 0.05 = trade allowed; > 0.20 = breakdown exit for I)</h2><div id="z3"></div></div>' : ''}${d.half_life ? '<div class="card"><h2>Half-life (sessions)</h2><div id="z4"></div></div>' : ''}
        <div class="card" style="grid-column:1/-1"><h2>Trades on this pair ($1,000, full history, default rules)</h2>${tradesTable(d.trades, 30)}</div></div>`;
      const refs = [{ v: d.entry }, { v: -d.entry }, { v: d.exit }, { v: -d.exit }].concat(d.stop ? [{ v: d.stop }, { v: -d.stop }] : []);
      const ser = [{ name: 'z', values: d.z, color: C().a }];
      if (d.entry_band) { ser.push({ name: 'entry band (vol-adjusted)', values: d.entry_band, color: C().b }); ser.push({ name: '−entry band', values: d.entry_band.map(v => v == null ? null : -v), color: C().b }); }
      Charts.line($('#z1'), { dates: d.dates, series: ser, refs, fmt: v => v.toFixed(2) });
      Charts.line($('#z2'), { dates: d.dates, series: [{ name: d.y, values: d.norm_y, color: C().a }, { name: d.x, values: d.norm_x, color: C().b }], fmt: v => v.toFixed(3) });
      if (d.coint_p) Charts.line($('#z3'), { dates: d.dates, series: [{ name: 'EG p', values: d.coint_p, color: C().a }], refs: [{ v: 0.05 }, { v: 0.2 }], fmt: v => v.toFixed(3) });
      if (d.half_life) Charts.line($('#z4'), { dates: d.dates, series: [{ name: 'half-life', values: d.half_life.map(v => v != null && v < 200 ? v : null), color: C().a }], fmt: v => v.toFixed(1) }); };
    $('#zf').onsubmit = e => { e.preventDefault(); go().catch(er => $('#zo').innerHTML = `<div class="status err">${esc(er.message)}</div>`); };
    go().catch(er => $('#zo').innerHTML = `<div class="status err">${esc(er.message)}</div>`);
  };
  SA.opps = async (h) => {
    const pb = await api('/api/sa/paper'); const cfg = pb.config; const sig = (pb.signals || []).filter(s => s.side || (s.z != null && Math.abs(s.z) >= cfg.entry * 0.75));
    h.innerHTML = `<div class="card"><div class="small dim" style="margin-bottom:8px">Strategy ${esc(cfg.strategy)} on the scanner's pairs at the ${esc(pb.updated || '—')} close. A signal requires the z-score threshold <i>and</i> rolling cointegration, ADF and half-life checks. You review and trade manually — nothing is sent to a broker.</div>
      ${sig.length ? `<table><thead><tr><th>Pair</th><th class="n">z</th><th>Signal</th><th>What to do (if you take it)</th><th class="n">β</th><th class="n">EG p</th><th class="n">ADF p</th><th class="n">Half-life</th></tr></thead><tbody>${sig.map(s => `<tr class="click" data-y="${s.y}" data-x="${s.x}"><td><b>${s.y}</b>/${s.x}</td><td class="n">${num(s.z)}</td><td>${s.side ? `<span class="pill warn">${s.side > 0 ? 'LONG' : 'SHORT'} spread${s.prev === 0 ? ' · new' : ''}</span>` : '<span class="muted small">near threshold</span>'}</td>
        <td class="small">${s.side > 0 ? `buy ${s.y}, sell ${num(s.beta, 2)}× (log-hedged) ${s.x}` : s.side < 0 ? `sell ${s.y}, buy ${num(s.beta, 2)}× (log-hedged) ${s.x}` : '—'}</td><td class="n">${num(s.beta, 3)}</td><td class="n">${num(s.coint_p, 3)}</td><td class="n">${num(s.adf_p, 3)}</td><td class="n">${num(s.half_life, 1)}</td></tr>`).join('')}</tbody></table>` : '<div class="muted small">No pair is at or near its entry threshold.</div>'}</div>`;
    h.querySelectorAll('tr.click').forEach(tr => tr.onclick = () => location.hash = `#/statarb?tab=zmon&y=${tr.dataset.y}&x=${tr.dataset.x}`);
  };
  SA.paper = async (h) => {
    const pb = await api('/api/sa/paper'); const e = pb.equity || []; const eq = e.length ? e[e.length - 1][1] : pb.start_cash;
    h.innerHTML = `<div class="grid g4">${[['Equity', '$' + num(eq + 0, 2), `started $${num(pb.start_cash, 2)}`], ['Realized net P&L', '$' + num(pb.realized, 2), `${(pb.closed || []).length} closed trades`], ['Unrealized P&L', '$' + num(pb.unrealized, 2), `${(pb.positions || []).length} open / pending`], ['Costs paid', '$' + num((pb.fees || 0) + (pb.slippage || 0) + (pb.borrow || 0), 2), `fees ${num(pb.fees, 2)} · spread+slip ${num(pb.slippage, 2)} · borrow ${num(pb.borrow, 2)}`]].map(([l, v, s]) => `<div class="card kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('')}</div>
      ${pb.halted ? `<div class="status err">New entries halted since ${pb.halted} (drawdown limit).</div>` : ''}
      <div class="card" style="margin-top:14px"><h2>Open and pending positions</h2>${(pb.positions || []).length ? `<table><thead><tr><th>Pair</th><th>Side</th><th>Status</th><th class="n">Qty Y / X</th><th class="n">Entry Y / X</th><th class="n">Mark Y / X</th><th class="n">Hedge β</th><th class="n">Unrealized</th><th class="n">Fees / borrow</th></tr></thead><tbody>${pb.positions.map(q => { const my = pb.marks[q.y] || {}, mx = pb.marks[q.x] || {};
        return `<tr><td>${q.y}/${q.x}</td><td>${q.side > 0 ? 'long' : 'short'} spread</td><td>${esc(q.status)}${q.status === 'pending_entry' ? ' (next open)' : ''}</td><td class="n">${num(q.qty_y, 3)} / ${num(q.qty_x, 3)}</td><td class="n">${num(q.entry_y)} / ${num(q.entry_x)}</td>
        <td class="n small">${num(my.price ?? my.close)} ${pill(my.status || 'historical')} / ${num(mx.price ?? mx.close)} ${pill(mx.status || 'historical')}</td><td class="n">${num(q.hedge_ratio, 3)}</td><td class="n">${num(q.unrealized, 2)}</td><td class="n">${num(q.fees, 2)} / ${num(q.borrow, 2)}</td></tr>`; }).join('')}</tbody></table>` : '<div class="muted small">No positions.</div>'}</div>
      <div class="grid g2" style="margin-top:14px"><div class="card"><h2>Equity</h2><div id="pe"></div></div><div class="card"><h2>Event log</h2><div class="log">${esc((pb.events || []).slice().reverse().join('\n') || '—')}</div></div></div>
      <div class="card" style="margin-top:14px"><h2>Closed trades</h2>${(pb.closed || []).length ? `<table><thead><tr><th>Pair</th><th>Entry</th><th>Exit</th><th>Reason</th><th class="n">Entry Y / X</th><th class="n">Exit Y / X</th><th class="n">Gross</th><th class="n">Fees</th><th class="n">Borrow</th><th class="n">Net</th></tr></thead><tbody>${pb.closed.slice().reverse().map(c => `<tr><td>${c.y}/${c.x} (${c.side > 0 ? 'long' : 'short'})</td><td class="mono small">${c.entry_date}</td><td class="mono small">${c.exit_date}</td><td>${esc(c.exit_reason)}</td><td class="n">${num(c.entry_y)} / ${num(c.entry_x)}</td><td class="n">${num(c.exit_y)} / ${num(c.exit_x)}</td><td class="n">${num(c.gross_pnl, 2)}</td><td class="n">${num(c.fees, 2)}</td><td class="n">${num(c.borrow, 2)}</td><td class="n">${num(c.net_pnl, 2)}</td></tr>`).join('')}</tbody></table>` : '<div class="muted small">None yet.</div>'}</div>`;
    if (e.length > 1) Charts.line($('#pe'), { dates: e.map(x => x[0]), series: [{ name: 'Equity', values: e.map(x => x[1]), color: C().a }], fmt: v => '$' + v.toFixed(2) }); else $('#pe').innerHTML = '<div class="muted small">One point per session once the paper book runs.</div>';
  };
  SA.backtest = async (h, p) => {
    const s = await api('/api/sa/summary'); const sm = s.summary; let hz = p.h || '180';
    h.innerHTML = `<div class="card"><div class="tabs" id="hz">${s.horizons.map(x => `<button class="${String(x) === hz ? 'on' : ''}" data-h="${x}">${x} days</button>`).join('')}</div><div id="ht"></div><div id="hc" style="margin-top:12px"></div></div>
      <div class="card" style="margin-top:14px"><h2>Per pair</h2><form class="f" id="pf"><label class="fld">Pair<select name="pair">${s.studies.map(r => `<option>${esc(r.pair)}</option>`).join('')}</select></label></form><div id="pp" style="margin-top:10px"></div></div>
      <div class="card" style="margin-top:14px"><h2>Study another pair</h2><form class="f" id="nf">${pairFields(p)}<button class="b">Run 30/60/90/180-day study</button></form><div id="ns"></div></div>`;
    const draw = () => { if (!sm) { $('#ht').innerHTML = '<div class="muted small">Waiting for the agent\'s first study.</div>'; return; }
      $('#ht').innerHTML = saTable(sm, hz);
      const row = sm.by_horizon[hz] || {}; const ks = SA_KEYS.filter(k => row[k]);
      Charts.bars($('#hc'), { labels: ks, values: ks.map(k => row[k].total_return), colorFn: (v, i) => saColor(ks[i]), fmt: v => (v * 100).toFixed(2) + '%', yfmt: v => (v * 100).toFixed(1) + '%', name: 'return' }); };
    $('#hz').querySelectorAll('button').forEach(b => b.onclick = () => { hz = b.dataset.h; $('#hz').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); draw(); });
    draw();
    const pair = async () => { const v = $('#pf [name=pair]').value; if (!v) { $('#pp').innerHTML = '<div class="muted small">No studies yet.</div>'; return; } const [y, x] = v.split('/');
      const st = await api(`/api/sa/study?y=${y}&x=${x}`); renderStudy($('#pp'), st); };
    $('#pf').onchange = pair; pair().catch(() => { });
    $('#nf').onsubmit = async e => { e.preventDefault(); const o = formData($('#nf')); const r = await job('/api/sa/study', { y: o.y, x: o.x }, $('#ns')); renderStudy($('#ns'), r); };
  };
  function renderStudy(host, st) {
    const hs = Object.keys(st.horizons);
    host.innerHTML = `<table><thead><tr><th>Window</th>${SA_KEYS.map(k => `<th class="n">${k} return</th><th class="n">${k} trades</th>`).join('')}</tr></thead><tbody>${hs.map(hh => { const r = st.horizons[hh]; return `<tr><td>${hh} d (${r.sessions} sessions)</td>${SA_KEYS.map(k => `<td class="n">${pct(r[k]?.total_return, 2)}</td><td class="n">${r[k]?.trades ?? '—'}</td>`).join('')}</tr>`; }).join('')}</tbody></table><div id="sc" style="margin-top:10px"></div>`;
    const r = st.horizons['180'] || st.horizons[hs[hs.length - 1]]; const dates = r.I.dates;
    const cum = a => { let e = 1; return a.map(v => (e *= 1 + (v || 0))); };
    Charts.line($('#sc', host), { dates, series: SA_KEYS.filter(k => r[k]).map(k => ({ name: k, values: cum(r[k].daily), color: saColor(k) })), fmt: v => ((v - 1) * 100).toFixed(2) + '%' });
  }
  SA.perf = async (h) => {
    const rs = await api('/api/research'); const rows = rs.results.filter(r => SA_KEYS.includes(r.strategy));
    const by = {}; rows.forEach(r => (by[r.strategy] = by[r.strategy] || []).push(r));
    const med = a => { const v = a.filter(x => x != null).sort((p, q) => p - q); return v.length ? v[Math.floor(v.length / 2)] : null; };
    h.innerHTML = `<div class="card"><h2>Walk-forward, out-of-sample (2-year train → 6-month unseen test, rolling; $100k per test)</h2>${Object.keys(by).length ? `<table><thead><tr><th>Strategy</th><th class="n">Pairs</th><th class="n">Qualified</th><th class="n">Median OOS return</th><th class="n">Median Sharpe</th><th class="n">Median win rate</th><th class="n">Median max DD</th><th class="n">Median Sharpe @2× costs</th></tr></thead><tbody>${SA_KEYS.filter(k => by[k]).map(k => `<tr><td><b>${k}</b> ${esc(s_name(k))}</td><td class="n">${by[k].length}</td><td class="n">${by[k].filter(r => r.qualifies).length}</td><td class="n">${pct(med(by[k].map(r => r.oos_return)))}</td><td class="n">${num(med(by[k].map(r => r.oos_sharpe)))}</td><td class="n">${pct(med(by[k].map(r => r.win_rate)))}</td><td class="n">${pct(med(by[k].map(r => r.max_drawdown)))}</td><td class="n">${num(med(by[k].map(r => r.sharpe_2x_costs)))}</td></tr>`).join('')}</tbody></table>` : '<div class="muted small">Walk-forward results appear as the agent works through its queue.</div>'}</div>
      <div class="card" style="margin-top:14px"><h2>Each test</h2>${rows.length ? `<div class="scroll"><table><thead><tr><th>Pair</th><th>Strategy</th><th class="n">OOS return</th><th class="n">Sharpe</th><th class="n">Win rate</th><th class="n">Max DD</th><th class="n">Trades</th><th>Verdict</th></tr></thead><tbody>${rows.map(r => `<tr><td>${r.pair}</td><td>${r.strategy}</td><td class="n">${pct(r.oos_return)}</td><td class="n">${num(r.oos_sharpe)}</td><td class="n">${pct(r.win_rate)}</td><td class="n">${pct(r.max_drawdown)}</td><td class="n">${r.trades}</td><td>${r.qualifies ? okPill(true, 'qualifies') : `<span class="pill bad" title="${esc(r.reasons.join('; '))}">fails</span>`}</td></tr>`).join('')}</tbody></table></div>` : ''}</div>`;
  };
  const s_name = k => (STRATS.find(s => s.key === k) || {}).name || k;
  SA.risk = async (h) => {
    const pb = await api('/api/sa/paper'); const c = pb.config; const e = pb.equity || []; const eq = e.length ? e[e.length - 1][1] : pb.start_cash;
    const peak = Math.max(pb.start_cash, ...e.map(x => x[1])); const dd = eq / peak - 1; const live = pb.positions || [];
    const stale = (pb.signals || []).filter(s => s.stale_sessions > c.stale_sessions); const broken = (pb.signals || []).filter(s => s.coint_p != null && s.coint_p > 0.2);
    const row = (l, v, lim, ok) => `<tr><td>${l}</td><td class="n">${v}</td><td class="n">${lim}</td><td>${okPill(ok, ok ? 'ok' : 'blocked')}</td></tr>`;
    h.innerHTML = `<div class="grid g2"><div class="card"><h2>Limits (enforced before any paper entry)</h2><table><thead><tr><th>Check</th><th class="n">Now</th><th class="n">Limit</th><th></th></tr></thead><tbody>
      ${row('Portfolio drawdown', pct(dd), '−' + pct(c.max_drawdown), !pb.halted && -dd < c.max_drawdown)}${row('Simultaneous pairs', live.length, c.max_pairs, live.length <= c.max_pairs)}
      ${row('Capital per pair', pct(c.risk_per_pair * c.leverage, 0) + ' of equity', '', true)}${row('Leverage (gross ÷ equity)', '', num(c.leverage, 1) + '×', true)}
      ${row('Pairs per sector', Math.max(0, ...Object.values(live.reduce((a, q) => (a[q.sector] = (a[q.sector] || 0) + 1, a), {}))), c.max_per_sector, true)}
      ${row('Correlated exposure', 'no stock in two pairs', '', true)}${row('Stale data', stale.length ? stale.map(s => s.y + '/' + s.x).join(', ') : 'none', `> ${c.stale_sessions} sessions`, !stale.length)}
      ${row('Liquidity', 'per leg', usd(c.min_dollar_volume) + ' / day', true)}</tbody></table>${pb.halted ? `<div class="status err">Halted since ${pb.halted}.</div>` : ''}</div>
      <div class="card"><h2>Cointegration breakdown watch</h2>${broken.length ? `<table><tbody>${broken.map(s => `<tr><td>${s.y}/${s.x}</td><td class="n">EG p ${num(s.coint_p, 3)}</td><td>${okPill(false, 'breakdown — I exits / will not enter')}</td></tr>`).join('')}</tbody></table>` : '<div class="muted small">No monitored pair has a rolling cointegration p-value above 0.20.</div>'}
      <h2 style="margin-top:14px">Emergency exits &amp; execution handling</h2><ul class="small"><li>Strategy I exits on its stop (|z| ≥ ${c.stop}), time stop (${c.hold_mult} × half-life) or cointegration breakdown.</li><li>Fills use the next session's official open for both legs; if either leg has no bar, the order waits and is cancelled after 3 sessions.</li><li>No live orders: this engine never contacts a broker.</li></ul></div></div>`;
  };
  SA.config = async (h) => {
    const c = await api('/api/sa/config');
    const lab = { capital: 'Starting capital (USD)', max_pairs: 'Max simultaneous pairs', risk_per_pair: 'Capital per pair (share of equity)', leverage: 'Leverage (0–4)', entry: 'Entry |z|', exit: 'Exit |z|', stop: 'Stop |z|', hold_mult: 'Max hold (× half-life)', max_drawdown: 'Max portfolio drawdown', max_per_sector: 'Max pairs per sector', stale_sessions: 'Stale after (sessions)', min_dollar_volume: 'Min $ volume per leg' };
    h.innerHTML = `<div class="card"><form class="f" id="cfg">${Object.entries(lab).map(([k, l]) => `<label class="fld">${l}<input type="number" step="any" name="${k}" value="${c[k]}"></label>`).join('')}<label class="fld">Strategy<select name="strategy">${['I', 'V', 'A', 'K'].map(k => `<option ${k === c.strategy ? 'selected' : ''}>${k}</option>`).join('')}</select></label><button class="b">Save</button><span id="cs" class="small dim"></span></form>
      <div style="margin-top:14px;display:flex;gap:10px;align-items:center"><button class="b2" id="rst">Reset paper account to starting capital</button><span id="rs" class="small dim"></span></div>
      <div class="small dim" style="margin-top:10px">Entry/exit/stop/max-hold apply to strategy I in the paper engine and the Z-score Monitor. Changes take effect at the next session update. Nothing here can place a real order.</div></div>`;
    $('#cfg').onsubmit = async e => { e.preventDefault(); try { await api('/api/sa/config', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); $('#cs').textContent = ' saved'; } catch (er) { $('#cs').textContent = ' ' + er.message; } };
    $('#rst').onclick = async () => { await api('/api/sa/paper/reset', { method: 'POST', body: { capital: +$('#cfg [name=capital]').value } }); $('#rs').textContent = 'reset'; };
  };

  // ------------------------------------------------------------------ boot
  (async () => {
    STRATS = await api('/api/strategies');
    addEventListener('hashchange', route);
    route(); clock(); setInterval(clock, 60000);
    // refresh the overview / risk pages while visible
    setInterval(() => { if (document.visibilityState === 'visible' && ['', '#', '#/', '#/risk'].includes(location.hash)) route(); }, 120000);
  })().catch(e => view.innerHTML = `<div class="status err">${esc(e.message)}</div>`);
})();
