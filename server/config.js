'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// DATA_DIR (e.g. a Railway volume) holds the SQLite DB and the live, UI-editable config.json.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const CONFIG_PATH = process.env.QS_CONFIG || (process.env.DATA_DIR ? path.join(DATA_DIR, 'config.json') : path.join(ROOT, 'config.json'));
const SEED_PATH = path.join(ROOT, 'config.json');

const DEFAULTS = {
  network: 'testnet',
  port: 8787,
  host: '0.0.0.0',
  market: { dex: 'xyz', type: 'us-stock-perps' },
  risk: {
    riskPerTradePct: 0.5, maxLeverage: 2, maxConcurrentPositions: 2, maxPositionUsd: 250,
    dailyLossLimitPct: 2, takeProfitR: 2, slippagePct: 0.5, defaultStopPct: 1.5, dryRunEquity: 10000,
    maxBookDeviationPct: 1.5,
  },
  scanner: {
    enabled: true, assets: ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'META', 'GOOGL'], interval: '1h', minStopPct: 1.5,
    minScore: 6, candleSource: 'mainnet', maxSignalAgeMinutes: 15, usMarketHoursOnly: false,
  },
  webhook: { enabled: true, allowExits: true },
  trading: { killSwitch: false, autoTrade: true },
  upstreamApi: '',
};

const INTERVALS = { '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3, '2h': 7200e3, '4h': 14400e3, '8h': 28800e3, '12h': 43200e3, '1d': 86400e3 };

const URLS = {
  testnet: 'https://api.hyperliquid-testnet.xyz',
  mainnet: 'https://api.hyperliquid.xyz',
};

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
  }
  return out;
}

let current = null;
const envNum = k => (process.env[k] !== undefined && process.env[k] !== '' && Number.isFinite(Number(process.env[k])) ? Number(process.env[k]) : undefined);
// Env vars SEED the config on first boot (no config file yet). NETWORK always comes from env when set.
function envSeed() {
  const e = process.env, o = { risk: {}, scanner: {}, market: {} };
  const map = { RISK_PER_TRADE_PCT: 'riskPerTradePct', MAX_LEVERAGE: 'maxLeverage', MAX_CONCURRENT_POSITIONS: 'maxConcurrentPositions', MAX_POSITION_USD: 'maxPositionUsd', DAILY_LOSS_LIMIT_PCT: 'dailyLossLimitPct', TAKE_PROFIT_R: 'takeProfitR', SLIPPAGE_PCT: 'slippagePct', DRY_RUN_EQUITY: 'dryRunEquity' };
  for (const [k, f] of Object.entries(map)) if (envNum(k) !== undefined) o.risk[f] = envNum(k);
  if (e.SCANNER_ASSETS) o.scanner.assets = e.SCANNER_ASSETS.split(',').map(x => x.trim().toUpperCase().replace(/^[A-Z0-9]+:/i, '')).filter(Boolean);
  if (e.SCANNER_INTERVAL) o.scanner.interval = e.SCANNER_INTERVAL;
  if (e.SCANNER_ENABLED) o.scanner.enabled = e.SCANNER_ENABLED !== 'false';
  if (e.STOCK_DEX) o.market.dex = e.STOCK_DEX;
  if (e.UPSTREAM_API !== undefined) o.upstreamApi = e.UPSTREAM_API;
  return o;
}
function load() {
  let file = null;
  try { file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const seeded = !file;
  if (!file) { try { file = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8')); } catch { file = {}; } file = merge(file, envSeed()); }
  current = merge(DEFAULTS, file);
  if (process.env.NETWORK) current.network = process.env.NETWORK.trim().toLowerCase();
  if (process.env.HOST) current.host = process.env.HOST;
  if (seeded) { try { save(); } catch {} }
  return current;
}
function get() { return current || load(); }
function save() { fs.writeFileSync(CONFIG_PATH + '.tmp', JSON.stringify(current, null, 2) + '\n'); fs.renameSync(CONFIG_PATH + '.tmp', CONFIG_PATH); }

const num = (v, lo, hi, name) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw Error(`${name} must be between ${lo} and ${hi}`);
  return n;
};

// Validates and applies a partial update coming from the UI. The network can NOT be changed here.
function update(patch) {
  const c = get();
  const next = JSON.parse(JSON.stringify(c));
  if (patch.network !== undefined && patch.network !== c.network) throw Error('Network can only be changed in config.json (see README).');
  const r = patch.risk || {};
  const R = next.risk;
  if (r.riskPerTradePct !== undefined) R.riskPerTradePct = num(r.riskPerTradePct, 0.01, 10, 'Risk per trade %');
  if (r.maxLeverage !== undefined) R.maxLeverage = num(r.maxLeverage, 1, 50, 'Max leverage');
  if (r.maxConcurrentPositions !== undefined) R.maxConcurrentPositions = Math.round(num(r.maxConcurrentPositions, 1, 50, 'Max concurrent positions'));
  if (r.maxPositionUsd !== undefined) R.maxPositionUsd = num(r.maxPositionUsd, 10, 10_000_000, 'Max position USD');
  if (r.dailyLossLimitPct !== undefined) R.dailyLossLimitPct = num(r.dailyLossLimitPct, 0.1, 100, 'Daily loss limit %');
  if (r.takeProfitR !== undefined) R.takeProfitR = num(r.takeProfitR, 0.5, 10, 'Take-profit R');
  if (r.slippagePct !== undefined) R.slippagePct = num(r.slippagePct, 0.01, 5, 'Slippage %');
  if (r.defaultStopPct !== undefined) R.defaultStopPct = num(r.defaultStopPct, 0.1, 20, 'Default stop %');
  if (r.dryRunEquity !== undefined) R.dryRunEquity = num(r.dryRunEquity, 10, 1e9, 'Dry-run equity');
  const s = patch.scanner || {};
  const S = next.scanner;
  if (s.enabled !== undefined) S.enabled = !!s.enabled;
  if (s.interval !== undefined) { if (!INTERVALS[s.interval]) throw Error('Unsupported interval'); S.interval = s.interval; }
  if (s.minStopPct !== undefined) S.minStopPct = num(s.minStopPct, 0.1, 10, 'Min stop %');
  if (s.minScore !== undefined) S.minScore = Math.round(num(s.minScore, 6, 8, 'Min score'));
  if (s.maxSignalAgeMinutes !== undefined) S.maxSignalAgeMinutes = num(s.maxSignalAgeMinutes, 1, 1440, 'Max signal age');
  if (s.usMarketHoursOnly !== undefined) S.usMarketHoursOnly = !!s.usMarketHoursOnly;
  if (r.maxBookDeviationPct !== undefined) R.maxBookDeviationPct = num(r.maxBookDeviationPct, 0.1, 20, 'Max book deviation %');
  if (s.candleSource !== undefined) { if (!['mainnet', 'trading'].includes(s.candleSource)) throw Error('candleSource must be mainnet or trading'); S.candleSource = s.candleSource; }
  if (s.assets !== undefined) {
    const list = (Array.isArray(s.assets) ? s.assets : String(s.assets).split(',')).map(x => String(x).trim().toUpperCase().replace(/^[A-Z0-9]+:/, '')).filter(Boolean);
    if (!list.length || list.length > 25 || list.some(a => !/^[A-Z0-9]{1,20}$/.test(a))) throw Error('Assets: 1-25 comma-separated stock tickers (e.g. NVDA,TSLA)');
    S.assets = [...new Set(list)];
  }
  const w = patch.webhook || {};
  if (w.enabled !== undefined) next.webhook.enabled = !!w.enabled;
  if (w.allowExits !== undefined) next.webhook.allowExits = !!w.allowExits;
  const t = patch.trading || {};
  if (t.autoTrade !== undefined) next.trading.autoTrade = !!t.autoTrade;
  current = next;
  save();
  return current;
}

function setKillSwitch(on) { get().trading.killSwitch = !!on; save(); }

const env = k => (process.env[k] && process.env[k].trim()) || '';

// Resolves which network / credentials are in effect. Mainnet requires BOTH config + HL_MAINNET_CONFIRM=yes.
function runtime() {
  const c = get();
  const problems = [];
  let network = c.network === 'mainnet' ? 'mainnet' : 'testnet';
  if (c.network !== 'testnet' && c.network !== 'mainnet') problems.push(`Unknown network "${c.network}", using testnet.`);
  let mainnetBlocked = false;
  if (network === 'mainnet' && env('HL_MAINNET_CONFIRM').toLowerCase() !== 'yes') {
    mainnetBlocked = true;
    problems.push('config.network is "mainnet" but HL_MAINNET_CONFIRM=yes is not set: trading is forced into DRY-RUN.');
  }
  const keyVar = network === 'mainnet' ? 'HL_MAINNET_PRIVATE_KEY' : 'HL_TESTNET_PRIVATE_KEY';
  let privateKey = env(keyVar);
  if (privateKey && !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    if (/^[0-9a-fA-F]{64}$/.test(privateKey)) privateKey = '0x' + privateKey;
    else { problems.push(`${keyVar} is not a valid 32-byte hex private key: DRY-RUN.`); privateKey = ''; }
  }
  const account = env('HL_ACCOUNT_ADDRESS');
  if (account && !/^0x[0-9a-fA-F]{40}$/.test(account)) problems.push('HL_ACCOUNT_ADDRESS is not a valid 0x address.');
  if (privateKey && !account) problems.push('HL_ACCOUNT_ADDRESS is missing: DRY-RUN (needed to read equity and positions).');
  const live = !!privateKey && /^0x[0-9a-fA-F]{40}$/.test(account) && !mainnetBlocked;
  return {
    network, apiUrl: URLS[network], keyVar, privateKey: live ? privateKey : '', keyPresent: !!privateKey, _key: privateKey,
    accountAddress: /^0x[0-9a-fA-F]{40}$/.test(account) ? account : '',
    dryRun: !live, mainnetBlocked, problems,
  };
}

module.exports = { ROOT, DATA_DIR, CONFIG_PATH, INTERVALS, URLS, load, get, update, setKillSwitch, runtime };
