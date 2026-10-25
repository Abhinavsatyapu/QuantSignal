// Read-only probe: runs the server's scanner logic over many markets/timeframes and prints actionable setups.
require('../public/indicators.js');
const hl = require('../server/hl');
(async () => {
  const intervals = (process.argv[2] || '5m,15m,1h').split(',');
  const coins = (process.argv[3] || 'xyz:NVDA,xyz:TSLA,xyz:AAPL,xyz:MSFT,xyz:AMZN,xyz:META,xyz:GOOGL,xyz:PLTR,xyz:HOOD,xyz:COIN,xyz:AMD,xyz:MU,xyz:ORCL,xyz:NFLX,xyz:MSTR,xyz:CRCL,xyz:INTC,xyz:TSM,xyz:LLY,xyz:COST,xyz:AVGO,xyz:SNDK,xyz:CRWV,xyz:RIVN').split(',');
  let n = 0;
  for (const iv of intervals) for (const c of coins) {
    try {
      const a = Technicals.analyze(await hl.candles('mainnet', c, iv), Date.now(), { minStopPct: 1.5 });
      n++;
      if (a.direction !== 'WAIT') console.log(JSON.stringify({ coin: c, interval: iv, direction: a.direction, score: a.score, entry: a.entry, stop: +a.stop.toPrecision(6), tp1: +a.tp1.toPrecision(6), stopPct: +a.stopPct.toFixed(2), closedAt: new Date(a.closedAt + 1).toISOString() }));
    } catch (e) {}
  }
  console.log('analyzed', n);
})();
