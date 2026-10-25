'use strict';
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });
const express = require('express');
const config = require('./config');
config.load();
const store = require('./db');
const engine = require('./engine');
const hl = require('./hl');
const { Finance } = globalThis;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: ['text/plain'], limit: '1mb' }));
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); next(); });

const safeEq = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };
const ADMIN = () => process.env.ADMIN_TOKEN || '';
function requireAdmin(req, res, next) {
  const tok = (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.get('x-admin-token');
  if (!ADMIN()) return res.status(503).json({ error: 'ADMIN_TOKEN not configured on server' });
  if (!safeEq(tok, ADMIN())) return res.status(401).json({ error: 'Admin token required (see .env ADMIN_TOKEN)' });
  next();
}
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => res.status(e.status || 500).json({ error: e.message }));

// ------------------------------------------------------------------ health
app.get('/health', (req, res) => { const rt = config.runtime(); res.json({ ok: true, network: rt.network, dryRun: rt.dryRun, uptimeSec: Math.round(process.uptime()), lastScanAt: engine.state.lastScanAt || null }); });

// ------------------------------------------------------------------ TradingView webhook
const webhookHits = new Map();
app.post('/webhook', wrap(async (req, res) => {
  const ip = req.ip; const now = Date.now();
  const hits = (webhookHits.get(ip) || []).filter(t => now - t < 60e3); hits.push(now); webhookHits.set(ip, hits);
  if (hits.length > 60) return res.status(429).json({ error: 'Too many webhook requests' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Body must be JSON' }); } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Body must be a JSON object' });
  const secret = process.env.WEBHOOK_SECRET || '';
  const supplied = req.get('x-webhook-token') || req.query.token || body.secret || body.token || body.passphrase;
  if (!secret || !safeEq(supplied, secret)) { store.log('warn', 'Webhook rejected: bad or missing secret', { ip }); return res.status(401).json({ error: 'Invalid webhook secret' }); }
  try {
    const out = await engine.onWebhook(body);
    res.json({ ok: true, receivedAt: new Date().toISOString(), ...out });
  } catch (e) {
    store.log('warn', 'Webhook payload error: ' + e.message);
    res.status(e.status || 400).json({ error: e.message });
  }
}));

// ------------------------------------------------------------------ Auto-trader API (admin token)
const at = express.Router();
at.use(requireAdmin);
at.get('/status', wrap(async (req, res) => {
  const cfg = config.get(), rt = config.runtime();
  let account = engine.state.account;
  try { account = await engine.refreshAccount(); } catch {}
  res.json({
    running: true, startedAt: engine.state.startedAt, network: rt.network, apiUrl: rt.apiUrl, mode: rt.dryRun ? 'dry_run' : 'live',
    mainnetBlocked: rt.mainnetBlocked, problems: rt.problems, accountAddress: rt.accountAddress ? rt.accountAddress.slice(0, 6) + '…' + rt.accountAddress.slice(-4) : null,
    agentAddress: engine.state.agent?.address || null, agentRole: engine.state.agent?.role?.role || null, keyPresent: rt.keyPresent, keyVar: rt.keyVar, killSwitch: cfg.trading.killSwitch, pausedReason: engine.state.pausedReason,
    autoTrade: cfg.trading.autoTrade, account, accountError: engine.state.accountError,
    scanner: { ...cfg.scanner, candleNetwork: engine.candleSourceNetwork(), lastScanAt: engine.state.lastScanAt, nextScanAt: engine.state.nextScanAt, busy: engine.state.scanBusy, lastError: engine.state.lastScanError },
    webhook: { ...cfg.webhook, path: '/webhook', secretConfigured: !!process.env.WEBHOOK_SECRET },
    market: { ...cfg.market, session: engine.usSession() },
    risk: cfg.risk,
    stats: store.one("SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END),0) wins, COALESCE(SUM(pnl),0) pnl FROM trades WHERE status='closed'"),
    serverTime: Date.now(),
  });
}));
at.get('/signals', (req, res) => res.json(store.all('SELECT id,ts,source,coin,direction,interval,entry,stop,tp,score,closed_at,status,reason FROM signals ORDER BY id DESC LIMIT ?', Math.min(500, Number(req.query.limit) || 50))));
at.get('/trades', (req, res) => res.json(store.all('SELECT * FROM trades ORDER BY id DESC LIMIT ?', Math.min(500, Number(req.query.limit) || 50))));
at.get('/events', (req, res) => res.json(store.all('SELECT * FROM events ORDER BY id DESC LIMIT ?', Math.min(1000, Number(req.query.limit) || 100))));
at.get('/scans', (req, res) => { const sc = config.get().scanner; const want = sc.assets.map(engine.normalizeCoin); res.json(store.all('SELECT * FROM scans WHERE interval=? ORDER BY coin', sc.interval).filter(r => want.includes(r.coin))); });
let marketsCache = null;
at.get('/markets', wrap(async (req, res) => {
  const cfg = config.get(), rt = config.runtime(), dex = cfg.market.dex;
  if (marketsCache && Date.now() - marketsCache.at < 60e3 && marketsCache.key === cfg.scanner.assets.join() + rt.network) return res.json(marketsCache.data);
  const [main, trade] = await Promise.all([hl.meta('mainnet', dex), hl.meta(rt.network, dex)]);
  const rows = [];
  for (const t of cfg.scanner.assets) {
    const coin = engine.normalizeCoin(t), a = main.get(coin), b = trade.get(coin);
    let bid = null, ask = null;
    if (b) { try { const bk = await hl.l2Book(rt.network, coin); bid = bk.bids[0] || null; ask = bk.asks[0] || null; } catch {} }
    rows.push({ coin, ticker: t, mainnet: a ? { markPx: a.markPx, maxLeverage: a.maxLeverage, dayNtlVlm: a.dayNtlVlm } : null,
      trading: b ? { markPx: b.markPx, oraclePx: b.oraclePx, maxLeverage: b.maxLeverage, marginMode: b.marginMode, szDecimals: b.szDecimals, assetId: b.index, bid, ask } : null });
  }
  const tradingList = [...trade.values()].map(x => x.name);
  const data = { dex, network: rt.network, session: engine.usSession(), rows, tradingListed: tradingList, mainnetListed: main.size, fetchedAt: Date.now() };
  marketsCache = { at: Date.now(), key: cfg.scanner.assets.join() + rt.network, data };
  res.json(data);
}));
at.post('/kill', wrap(async (req, res) => { engine.setKill(req.body?.on !== false, req.body?.reason); res.json({ killSwitch: config.get().trading.killSwitch }); }));
at.post('/config', wrap(async (req, res) => {
  const before = JSON.stringify(config.get());
  const c = config.update(req.body || {});
  store.log('info', 'Settings updated from UI', { risk: c.risk, scanner: c.scanner, webhook: c.webhook, autoTrade: c.trading.autoTrade });
  if (JSON.stringify(c.scanner) !== JSON.stringify(JSON.parse(before).scanner)) engine.state.nextScanAt = 0;
  res.json({ ok: true, config: { risk: c.risk, scanner: c.scanner, webhook: c.webhook, trading: c.trading, network: c.network } });
}));
at.post('/scan-now', wrap(async (req, res) => res.json(await engine.scanOnce('manual'))));
at.post('/close', wrap(async (req, res) => res.json(await engine.closePosition(engine.normalizeCoin(req.body?.coin), 'manual close from UI'))));
app.use('/api/autotrader', at);

// ------------------------------------------------------------------ market data used by the original UI
const HL_INFO_TYPES = new Set(['meta', 'allMids', 'candleSnapshot', 'l2Book', 'metaAndAssetCtxs', 'perpDexs']);
app.post('/api/hyperliquid', wrap(async (req, res) => {
  const b = req.body || {};
  if (!HL_INFO_TYPES.has(b.type)) return res.status(400).json({ error: 'Unsupported info type' });
  if (b.type === 'candleSnapshot' && b.req && !b.req.startTime) { const now = Date.now(), d = config.INTERVALS[b.req.interval] || 900e3; b.req = { ...b.req, startTime: now - d * 320, endTime: now }; }
  res.json(await hl.info('mainnet', b)); // public read-only market data (same as original site)
}));

app.post('/api/webhook/validate', (req, res) => {
  try { const v = Finance.validateWebhook(req.body); res.json({ ok: true, event: v.payload.event, signals: v.rows, warnings: v.warnings, validatedAt: new Date().toISOString() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

const FEEDS = [
  { source: 'CoinDesk', category: 'crypto', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { source: 'Cointelegraph', category: 'crypto', url: 'https://cointelegraph.com/rss' },
  { source: 'Google News · US stocks', category: 'stocks', url: 'https://news.google.com/rss/search?q=US+stock+market&hl=en-US&gl=US&ceid=US:en' },
  { source: 'CNBC Markets', category: 'stocks', url: 'https://www.cnbc.com/id/15839069/device/rss/rss.html' },
  { source: 'Google News · Global macro', category: 'macro', url: 'https://news.google.com/rss/search?q=global+economy+central+bank&hl=en-US&gl=US&ceid=US:en' },
  { source: 'BBC Business', category: 'macro', url: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
];
let newsCache = null;
app.get('/api/news', wrap(async (req, res) => {
  if (newsCache && Date.now() - newsCache.at < 120e3) return res.json(newsCache.data);
  const errors = [], feeds = [];
  await Promise.all(FEEDS.map(async f => { try { const r = await fetch(f.url, { headers: { 'User-Agent': 'Mozilla/5.0 QuantSignal' }, signal: AbortSignal.timeout(10000) }); if (!r.ok) throw Error(r.status); feeds.push({ source: f.source, category: f.category, xml: (await r.text()).slice(0, 400000) }); } catch { errors.push(f.source); } }));
  const data = { feeds, errors, fetchedAt: new Date().toISOString() };
  newsCache = { at: Date.now(), data };
  res.json(data);
}));

// Crypto universe natively; everything else (stock-perp catalogue, Alpaca options proxy, options-math
// endpoints) is forwarded to the original hosted backend, since its server code is not published.
app.get('/api/stream/universe', wrap(async (req, res, next) => {
  if (req.query.scope === 'crypto') return res.status(400).json({ error: 'Crypto markets are disabled (US stock perps only).' });
  try { const d = await stockCatalogue(); return res.json({ symbols: d.rows.filter(r => r.kind === 'us-stock').map(r => r.symbol) }); }
  catch (e) { return res.status(502).json({ error: e.message }); }
}));
async function proxyUpstream(req, res) {
  const base = config.get().upstreamApi;
  if (!base) return res.status(501).json({ error: 'This endpoint needs the upstream API (config.upstreamApi).' });
  const url = base.replace(/\/$/, '') + req.originalUrl;
  const init = { method: req.method, headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 QuantSignal-selfhosted', Accept: 'application/json' }, signal: AbortSignal.timeout(90000) };
  if (!['GET', 'HEAD'].includes(req.method)) init.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  try {
    const r = await fetch(url, init);
    const text = await r.text();
    res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(text);
  } catch (e) { res.status(502).json({ error: 'Upstream API unavailable: ' + e.message }); }
}
// US stock-perp catalogue (dashboard table, signals, paper trading). Prefer the original site's curated list
// (company names + stock/ETF classification); fall back to Hyperliquid's own perpCategories data.
let stockCache = null;
const ETF = new Set(['SPY', 'QQQ', 'IWM', 'DIA', 'SMH', 'XLE', 'XBI', 'TLT', 'GDX', 'IGV', 'EWJ', 'EWY', 'EWT', 'EWZ', 'SOXL', 'URNM', 'KORU', 'MAGS', 'ARKK']);
async function stockCatalogue() {
  if (stockCache && Date.now() - stockCache.at < 60e3) return stockCache.data;
  let data = null;
  const base = config.get().upstreamApi;
  if (base) { try { const r = await fetch(base.replace(/\/$/, '') + '/api/stocks', { headers: { 'User-Agent': 'Mozilla/5.0 QuantSignal' }, signal: AbortSignal.timeout(20000) }); if (r.ok) { const j = await r.json(); if (Array.isArray(j.rows) && j.rows.length) data = { ...j, source: 'upstream' }; } } catch {} }
  if (!data) {
    const cats = await hl.info('mainnet', { type: 'perpCategories' });
    const stockSet = new Set(cats.filter(c => /^stocks?$/i.test(c[1])).map(c => c[0]));
    const dexes = [...new Set([...stockSet].map(s => s.split(':')[0]))];
    const rows = [], errors = [];
    await Promise.all(dexes.map(async dex => { try { const m = await hl.meta('mainnet', dex); for (const v of m.values()) if (stockSet.has(v.name)) { const t = v.name.split(':')[1]; rows.push({ symbol: v.name, ticker: t, dex, name: t, kind: ETF.has(t) ? 'etf' : 'us-stock', price: v.markPx, change: null, volume: v.dayNtlVlm, funding: Number.isFinite(v.funding) ? v.funding * 100 : null, maxLeverage: v.maxLeverage }); } } catch { errors.push(dex); } }));
    rows.sort((a, b) => b.volume - a.volume);
    data = { rows, errors, source: 'hyperliquid perpCategories', fetchedAt: new Date().toISOString() };
  }
  stockCache = { at: Date.now(), data };
  return data;
}
app.get('/api/stocks', wrap(async (req, res) => res.json(await stockCatalogue())));
app.get('/api/paper-background', (req, res) => res.status(404).json({ error: 'Server paper runner not enabled; paper trading runs in the browser.' }));
app.all(/^\/api\/.*/, (req, res) => { if (req.path.startsWith('/api/autotrader')) return res.status(404).json({ error: 'Not found' }); return proxyUpstream(req, res); });

// ------------------------------------------------------------------ frontend
const PUB = path.join(config.ROOT, 'public');
app.use(express.static(PUB, { extensions: ['html'], maxAge: '5m', index: 'index.html' }));
for (const p of ['/signals', '/news', '/webhook', '/risk', '/paper', '/hedge', '/autotrader', '/options', '/gamma', '/ratio']) app.get(p, (req, res) => res.sendFile(path.join(PUB, 'index.html')));
app.get('/manual', (req, res) => res.sendFile(path.join(PUB, 'manual.html')));
app.get('/sheet-lab', (req, res) => res.sendFile(path.join(PUB, 'sheet-lab.html')));

const cfg = config.get();
const port = Number(process.env.PORT) || cfg.port;
app.listen(port, cfg.host, () => {
  store.log('info', `QuantSignal server listening on http://${cfg.host}:${port}`);
  engine.start();
});
process.on('unhandledRejection', e => store.log('error', 'unhandledRejection: ' + (e?.message || e)));
