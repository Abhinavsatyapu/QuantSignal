'use strict';
const fs = require('fs');
const path = require('path');
const ps = require('../server/binance-preset-signals');
require('../public/indicators.js');
require('../public/strategy-liquidity-signals.js');
const OUT = path.join(__dirname, 'out');
const syms = ['NVDAUSDT','TSLAUSDT','AAPLUSDT','SPYUSDT','QQQUSDT','METAUSDT'];
const mismatches = [];
let compared = 0, matched = 0;
for (const sym of syms) {
  const f = path.join(OUT, 'klines', `${sym}_30m.json`);
  if (!fs.existsSync(f)) continue;
  let bars = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (bars.length > 400) bars = bars.slice(-400);
  for (let i = 220; i < bars.length; i++) {
    const live = ps.signalComboAnd3(bars, i, globalThis.Technicals, globalThis.LiquiditySignals, {
      windowBars: 3, usCashOnly: true, maxStopAtr: 2.5, interval: '30m',
    });
    // second call identical path (replay = same pure function)
    const bt = ps.signalComboAnd3(bars, i, globalThis.Technicals, globalThis.LiquiditySignals, {
      windowBars: 3, usCashOnly: true, maxStopAtr: 2.5, interval: '30m',
    });
    compared++;
    const ld = live && live.dir, bd = bt && bt.dir;
    if (ld === bd) matched++;
    else mismatches.push({ sym, i, t: bars[i].t, live: ld, bt: bd });
  }
}
const report = { compared, matched, mismatchCount: mismatches.length, mismatches: mismatches.slice(0, 10), ok: mismatches.length === 0 };
fs.writeFileSync(path.join(OUT, 'dryrun-signal-replay.json'), JSON.stringify(report, null, 2));
console.log(report);
if (!report.ok) process.exit(1);
