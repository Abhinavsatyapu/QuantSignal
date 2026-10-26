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
const derivatives = require('./derivatives');
const { Finance } = globalThis;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
const log = require('./log');
const helmet = require('helmet'), compression = require('compression');
const fs = require('fs');
// ---- version (commit sha + build time) — Render exposes RENDER_GIT_COMMIT; the Docker build writes BUILD_TIME
const VERSION = (() => {
  let commit = process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null, builtAt = null;
  try { builtAt = fs.readFileSync(path.join(__dirname, '..', 'BUILD_TIME'), 'utf8').trim(); } catch {}
  if (!commit) try { commit = require('child_process').execSync('git rev-parse HEAD', { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
  return { name: 'quantsignal', version: require('../package.json').version, commit: commit || 'unknown', builtAt: builtAt || null, startedAt: new Date().toISOString(), node: process.version };
})();
app.use(helmet({
  contentSecurityPolicy: { useDefaults: true, directives: {
    'default-src': ["'self'"], 'script-src': ["'self'"], 'style-src': ["'self'", "'unsafe-inline'"], 'img-src': ["'self'", 'data:', 'blob:'],
    'connect-src': ["'self'", 'https://api.hyperliquid.xyz', 'https://api.hyperliquid-testnet.xyz', 'wss://api.hyperliquid.xyz', 'https://data-api.binance.vision'],
    'font-src': ["'self'", 'data:'], 'object-src': ["'none'"], 'frame-ancestors': ["'none'"], 'base-uri': ["'self'"], 'form-action': ["'self'"], 'upgrade-insecure-requests': null } },
  crossOriginEmbedderPolicy: false, referrerPolicy: { policy: 'same-origin' } }));
app.use(compression());
// structured request log (one JSON line per API request; static assets are not logged)
app.use((req, res, next) => { const t0 = Date.now(); res.on('finish', () => { if (req.path.startsWith('/api/') || res.statusCode >= 500) log.info('http', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0 }); }); next(); });
app.get('/version', (req, res) => res.json(VERSION));
app.use('/api/strategy/import', express.json({ limit: '50mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: ['text/plain'], limit: '1mb' }));


const safeEq = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };
const ADMIN = () => process.env.ADMIN_TOKEN || '';
function requireAdmin(req, res, next) {
  const tok = (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.get('x-admin-token');
  if (!ADMIN()) return res.status(503).json({ error: 'ADMIN_TOKEN not configured on server' });
  if (!safeEq(tok, ADMIN())) return res.status(401).json({ error: 'Admin token required (see .env ADMIN_TOKEN)' });
  next();
}
const { plainError } = require('./alpaca');
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => { if (!e.status) log.error('http.bug', { path: req.path, error: (e.name || 'Error') + ': ' + e.message }); res.status(e.status || 500).json({ error: plainError(e) }); });

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

// US stock-perp universe, options chain (Alpaca, server-side keys) and the derivatives calculation endpoints.
// Everything is served natively; nothing is proxied to the original hosted backend any more.
app.get('/api/stream/universe', wrap(async (req, res) => {
  if (req.query.scope === 'crypto') return res.status(400).json({ error: 'Crypto markets are disabled (US stock perps only).' });
  try { return res.json({ symbols: await stockSymbols() }); }
  catch (e) { return res.status(502).json({ error: e.message }); }
}));
// US stock-perp catalogue from Hyperliquid's own perpCategories ("stocks"), with company names / ETF flags joined
// from the public Nasdaq Trader symbol directory. Tickers not in that US-listed directory (e.g. Korean names) are
// marked kind 'non-us' and excluded from the stock-perp universe (US stocks only).
let stockCache = null;
const ETF = new Set(['SPY', 'QQQ', 'IWM', 'DIA', 'SMH', 'XLE', 'XBI', 'TLT', 'GDX', 'IGV', 'EWJ', 'EWY', 'EWT', 'EWZ', 'SOXL', 'URNM', 'KORU', 'MAGS', 'ARKK']);
async function stockCatalogue() {
  if (stockCache && Date.now() - stockCache.at < 60e3) return stockCache.data;
  const cats = await hl.info('mainnet', { type: 'perpCategories' });
  const stockSet = new Set(cats.filter(c => /^stocks?$/i.test(c[1])).map(c => c[0]));
  const dexes = [...new Set([...stockSet].map(s => s.split(':')[0]))];
  let names = new Map();
  try { names = new Map((await derivatives.symbolDirectory()).assets.map(a => [a.symbol, a])); } catch {}
  const rows = [], errors = [];
  await Promise.all(dexes.map(async dex => { try { const m = await hl.meta('mainnet', dex); for (const v of m.values()) if (stockSet.has(v.name)) { const t = v.name.split(':')[1], d = names.get(t); rows.push({ symbol: v.name, ticker: t, dex, name: d?.name || t, kind: names.size && !d ? 'non-us' : d?.etf || ETF.has(t) ? 'etf' : 'us-stock', price: v.markPx, change: v.prevDayPx > 0 && v.markPx > 0 ? (v.markPx / v.prevDayPx - 1) * 100 : null, volume: v.dayNtlVlm, funding: Number.isFinite(v.funding) ? v.funding * 100 : null, maxLeverage: v.maxLeverage }); } } catch { errors.push(dex); } }));
  rows.sort((a, b) => b.volume - a.volume);
  const data = { rows, errors, source: 'hyperliquid perpCategories + Nasdaq Trader names', fetchedAt: new Date().toISOString() };
  stockCache = { at: Date.now(), data };
  return data;
}
async function stockSymbols() { const d = await stockCatalogue(); return d.rows.filter(r => r.kind === 'us-stock').map(r => r.symbol); }
app.get('/api/stocks', wrap(async (req, res) => res.json(await stockCatalogue())));
app.get('/api/paper-background', (req, res) => res.status(404).json({ error: 'Server paper runner not enabled; paper trading runs in the browser.' }));
app.use('/api', derivatives.router({ stockSymbols }));
app.use('/api', require('./strategy').router({ stockSymbols }));
app.all(/^\/api\/.*/, (req, res) => res.status(404).json({ error: 'Unknown API endpoint ' + req.path }));

// ------------------------------------------------------------------ frontend
const PUB = path.join(config.ROOT, 'public');
// static assets: HTML revalidated every time (no stale UI after a deploy); JS/CSS/images cached 1 h with ETag revalidation
app.use(express.static(PUB, { extensions: ['html'], index: 'index.html', etag: true, setHeaders: (res, file) => res.setHeader('Cache-Control', /\.html$/.test(file) ? 'no-cache' : /sheet-data\.js$/.test(file) ? 'public, max-age=86400' : 'public, max-age=3600, must-revalidate') }));
for (const p of ['/options', '/gamma', '/hedge', '/ratio', '/live-hedge', '/options-studio', '/gamma-book']) app.get(p, (req, res) => res.redirect(301, '/builder'));
for (const p of ['/signals', '/news', '/webhook', '/risk', '/paper', '/autotrader']) app.get(p, (req, res) => res.sendFile(path.join(PUB, 'index.html')));
app.get('/manual', (req, res) => res.sendFile(path.join(PUB, 'manual.html')));
app.get('/builder', (req, res) => res.sendFile(path.join(PUB, 'builder.html')));
app.get('/docs/four-leg-methodology.md', (req, res) => res.type('text/markdown; charset=utf-8').sendFile(path.join(__dirname, '..', 'docs', 'four-leg-methodology.md')));
app.get('/sheet-lab', (req, res) => res.sendFile(path.join(PUB, 'sheet-lab.html')));
app.get('/weekly', (req, res) => res.sendFile(path.join(PUB, 'weekly.html')));
app.get('/lab', (req, res) => res.redirect(302, '/manual'));
app.get('/derivatives', (req, res) => res.redirect(302, '/builder'));
// friendly 404 / 500 pages (JSON for API callers)
app.use((req, res) => { res.status(404); if (req.accepts('html')) return res.sendFile(path.join(PUB, '404.html')); res.json({ error: 'Not found' }); });
app.use((err, req, res, next) => { log.error('http.error', { path: req.path, error: err.message }); if (res.headersSent) return next(err); res.status(err.status || 500); if (req.path.startsWith('/api/') || !req.accepts('html')) return res.json({ error: err.status && err.status < 500 ? err.message : 'Internal error' }); res.sendFile(path.join(PUB, '500.html')); });

const cfg = config.get();
const port = Number(process.env.PORT) || cfg.port;
const strategyMod = require('./strategy');
strategyMod.initPersistence().catch(e => log.error('persist.init_crash', { error: e.message })).finally(() => {
  const server = app.listen(port, cfg.host, () => {
    store.log('info', `QuantSignal server listening on http://${cfg.host}:${port}`);
    log.info('server.start', { port, commit: VERSION.commit, storage: require('./persist').backend() });
    engine.start();
  });
  const stop = (sig) => { log.info('server.stop', { signal: sig }); server.close(); require('./persist').close().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 8000).unref(); };
  process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));
});
process.on('unhandledRejection', e => store.log('error', 'unhandledRejection: ' + (e?.message || e)));
