// Runs ChatGPT's own Technicals.analyze() bar by bar, on the same 320-candle window the live site fetches.
// usage: node gen_signals.js <csv folder> <bar minutes> <out.json>
require('../public/indicators.js');   // the site's own signal engine
const fs = require('fs'), path = require('path');
const [dir, mins, out] = process.argv.slice(2), dur = Number(mins) * 60000, WIN = 320;
const res = {};
for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.csv'))) {
  const rows = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n'); const h = rows.shift().split(',');
  const ix = k => h.indexOf(k);
  const c = rows.map(r => r.split(',')).map(x => { const t = Date.parse(x[ix('date')].replace(' ', 'T') + (/[zZ+]|-\d\d:\d\d$/.test(x[ix('date')].slice(10)) ? '' : 'Z'));
    return { t, T: t + dur - 1, o: +x[ix('open')], h: +x[ix('high')], l: +x[ix('low')], c: +x[ix('close')], v: +x[ix('volume')] }; })
    .filter(b => Number.isFinite(b.t));
  const sig = [];
  for (let i = 219; i < c.length; i++) {
    const w = c.slice(Math.max(0, i - WIN + 1), i + 1);
    try {
      const a = Technicals.analyze(w, c[i].T + 1, { minStopPct: 1.5 });
      if (a.direction !== 'WAIT') sig.push([i, a.direction === 'LONG' ? 1 : -1, a.entry, a.stop, a.atr, a.barrier, a.score]);
    } catch (e) { }
  }
  res[f.replace('.csv', '')] = { n: c.length, sig };
}
fs.writeFileSync(out, JSON.stringify(res));
console.log(dir, Object.values(res).reduce((s, r) => s + r.sig.length, 0), 'signals');
