'use strict';
/**
 * Official lagged institutional / short / ATS / delayed-options panels.
 * Cache compact JSON on disk. Never load a 13F ZIP in the web process.
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const util = require('./whales-util');
const edgar = require('./whales-edgar');
const cboe = require('./whales-cboe');

const ROOT = () => require('./config').ROOT || path.join(__dirname, '..');
const SEED_13F = () => path.join(ROOT(), 'data', 'reference', 'whales', '13f-compact.json');

const state = {
  lastError: null,
  finra: null,
  filings: null,
  options: null,
  thirteenF: null,
  busy: {},
};

function cacheFile(name) { return path.join(util.cacheDir(), name); }

function loadCaches() {
  state.finra = util.readJson(cacheFile('finra.json'), state.finra);
  state.filings = util.readJson(cacheFile('filings.json'), state.filings);
  state.options = util.readJson(cacheFile('cboe.json'), state.options);
  state.thirteenF = util.readJson(cacheFile('13f-compact.json'), state.thirteenF)
    || util.readJson(SEED_13F(), state.thirteenF);
}

function priorWeekday(d) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  while (x.getUTCDay() === 0 || x.getUTCDay() === 6) x.setUTCDate(x.getUTCDate() - 1);
  return x;
}

function ymd(d) { return d.toISOString().slice(0, 10); }
function compactDate(d) { return ymd(d).replace(/-/g, ''); }

function parseCdnShortVolume(text, tickers) {
  const wanted = new Set(tickers);
  const rows = {};
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines.slice(1)) {
    const parts = line.split('|');
    if (parts.length >= 5 && wanted.has(parts[1])) {
      const shortVolume = Number(parts[2] || 0);
      const shortExemptVolume = Number(parts[3] || 0);
      const totalVolume = Number(parts[4] || 0);
      rows[parts[1]] = {
        date: parts[0], symbol: parts[1], shortVolume, shortExemptVolume, totalVolume,
        market: parts[5] || null,
        shortRatioOffExchange: totalVolume ? shortVolume / totalVolume : null,
      };
    }
  }
  return rows;
}

async function finraPost(dataset, payload) {
  return util.httpJson('https://api.finra.org/data/group/otcMarket/name/' + dataset, {
    method: 'POST', body: payload, timeout: 30000, userAgent: 'QuantSignalDashboard/1.0',
  });
}

async function refreshFinra(tickers = util.FEATURED) {
  if (state.busy.finra) return state.finra;
  state.busy.finra = true;
  try {
    const today = new Date();
    const trade = priorWeekday(new Date(today.getTime() - 86400e3));
    const tradeS = ymd(trade);
    let cdn = await util.httpJson('https://cdn.finra.org/equity/regsho/daily/CNMSshvol' + compactDate(trade) + '.txt', { timeout: 20000 });
    let usedTrade = trade;
    if (!cdn.ok || !cdn.text) {
      const prev = priorWeekday(new Date(trade.getTime() - 86400e3));
      const retry = await util.httpJson('https://cdn.finra.org/equity/regsho/daily/CNMSshvol' + compactDate(prev) + '.txt', { timeout: 20000 });
      if (retry.ok && retry.text) { cdn = retry; usedTrade = prev; }
    }
    const cdnRows = parseCdnShortVolume(cdn.text || '', tickers);
    const tradeUse = ymd(usedTrade);

    const apiVol = {};
    for (const t of tickers) {
      const p = await finraPost('regShoDaily', {
        compareFilters: [
          { compareType: 'EQUAL', fieldName: 'tradeReportDate', fieldValue: tradeUse },
          { compareType: 'EQUAL', fieldName: 'securitiesInformationProcessorSymbolIdentifier', fieldValue: t },
        ],
      });
      const rows = Array.isArray(p.json) ? p.json : [];
      if (rows.length) {
        const short = rows.reduce((s, r) => s + Number(r.shortParQuantity || 0), 0);
        const tot = rows.reduce((s, r) => s + Number(r.totalParQuantity || 0), 0);
        apiVol[t] = {
          tradeReportDate: tradeUse, shortParQuantity: short, totalParQuantity: tot,
          shortRatioOffExchange: tot ? short / tot : null,
          note: 'FINRA off-exchange (TRF/ADF/ORF) volume only — not consolidated lit+dark share.',
        };
      }
    }

    let siDate = null;
    const si = {};
    let d = priorWeekday(today);
    const candidates = [];
    for (let i = 0; i < 40; i++) {
      if ([13, 14, 15, 16, 28, 29, 30, 31, 1].includes(d.getUTCDate())) candidates.push(ymd(d));
      d = new Date(d.getTime() - 86400e3);
    }
    for (const ds of candidates) {
      const p = await finraPost('consolidatedShortInterest', {
        compareFilters: [
          { compareType: 'EQUAL', fieldName: 'settlementDate', fieldValue: ds },
          { compareType: 'EQUAL', fieldName: 'symbolCode', fieldValue: tickers[0] },
        ],
      });
      if (Array.isArray(p.json) && p.json.length) { siDate = ds; break; }
    }
    if (siDate) {
      for (const t of tickers) {
        const p = await finraPost('consolidatedShortInterest', {
          compareFilters: [
            { compareType: 'EQUAL', fieldName: 'settlementDate', fieldValue: siDate },
            { compareType: 'EQUAL', fieldName: 'symbolCode', fieldValue: t },
          ],
        });
        if (Array.isArray(p.json) && p.json[0]) {
          const r = p.json[0];
          si[t] = {
            symbolCode: t,
            settlementDate: siDate,
            currentShortPositionQuantity: r.currentShortPositionQuantity ?? r.shortInterestQuantity,
            previousShortPositionQuantity: r.previousShortPositionQuantity,
            changePercent: r.changePercent ?? r.changePercentNumber,
            averageDailyVolumeQuantity: r.averageDailyVolumeQuantity,
            daysToCover: r.daysToCoverQuantity ?? r.daysToCover,
          };
        }
      }
    }

    const ats = { weeks: [], latestWeek: null, publishedDates: [], byTicker: {} };
    const weekStart = ymd(new Date(today.getTime() - 70 * 86400e3));
    const weekEnd = ymd(today);
    const probe = await finraPost('weeklySummary', {
      limit: 5000,
      dateRangeFilters: [{ fieldName: 'weekStartDate', startDate: weekStart, endDate: weekEnd }],
      compareFilters: [
        { compareType: 'EQUAL', fieldName: 'tierIdentifier', fieldValue: 'T1' },
        { compareType: 'EQUAL', fieldName: 'issueSymbolIdentifier', fieldValue: tickers[0] },
      ],
    });
    const probeRows = Array.isArray(probe.json) ? probe.json : [];
    const weeks = [...new Set(probeRows.map((r) => r.weekStartDate).filter(Boolean))].sort();
    const pubs = [...new Set(probeRows.map((r) => r.initialPublishedDate).filter(Boolean))].sort();
    ats.weeks = weeks; ats.publishedDates = pubs; ats.latestWeek = weeks[weeks.length - 1] || null;
    if (ats.latestWeek) {
      for (const t of tickers) {
        const q = await finraPost('weeklySummary', {
          limit: 5000,
          dateRangeFilters: [{ fieldName: 'weekStartDate', startDate: ats.latestWeek, endDate: ats.latestWeek }],
          compareFilters: [
            { compareType: 'EQUAL', fieldName: 'tierIdentifier', fieldValue: 'T1' },
            { compareType: 'EQUAL', fieldName: 'issueSymbolIdentifier', fieldValue: t },
          ],
        });
        const rws = Array.isArray(q.json) ? q.json : [];
        const buckets = {};
        let pub = null;
        for (const r of rws) {
          const typ = r.summaryTypeCode || '';
          if (!typ.endsWith('SMBL_FIRM')) continue;
          const bucket = typ.startsWith('ATS') ? 'ATS' : (typ.startsWith('OTC') ? 'OTC_WHOLESALE' : typ);
          const b = buckets[bucket] || { shares: 0, trades: 0, notional: 0, venues: [] };
          const shares = Number(r.totalWeeklyShareQuantity || 0);
          b.shares += shares;
          b.trades += Number(r.totalWeeklyTradeCount || 0);
          b.notional += Number(r.totalNotionalSum || 0);
          b.venues.push({ name: r.marketParticipantName || r.MPID, mpid: r.MPID, shares, notional: r.totalNotionalSum });
          pub = r.initialPublishedDate || pub;
          buckets[bucket] = b;
        }
        for (const b of Object.values(buckets)) b.venues = b.venues.sort((a, c) => (c.shares || 0) - (a.shares || 0)).slice(0, 8);
        ats.byTicker[t] = { weekStartDate: ats.latestWeek, initialPublishedDate: pub, buckets };
      }
    }

    const asOfMs = usedTrade.getTime() + 12 * 3600e3;
    const out = {
      ok: !!(Object.keys(cdnRows).length || Object.keys(apiVol).length || Object.keys(si).length),
      fetchedAt: Date.now(),
      fetchedAtIst: util.toIST(Date.now()),
      tradeDate: tradeUse,
      cdnShortVolume: { rows: cdnRows, tradeDate: tradeUse, lastModified: cdn.lastModified, status: cdn.status },
      apiShortVolume: apiVol,
      shortInterest: { settlementDate: siDate, rows: si },
      weeklyAtsOtc: ats,
      caveats: [
        'Daily short-sale volume is off-exchange only and is not short interest.',
        'Short interest is bi-monthly and publishes about 8–11 business days after settlement.',
        'ATS/OTC weekly data is delayed about two to three weeks after the week start.',
        'Wholesaler (OTC) volume is internalization, not the same thing as ATS dark pools.',
      ],
    };
    util.writeJsonAtomic(cacheFile('finra.json'), out);
    state.finra = out;
    return out;
  } catch (e) {
    state.lastError = e.message;
    return state.finra;
  } finally { state.busy.finra = false; }
}

async function refreshFilings(tickers = util.FEATURED) {
  if (state.busy.filings) return state.filings;
  state.busy.filings = true;
  try {
    const ua = util.secUserAgent();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const form4 = {}, sched13 = {}, index = {};
    for (const t of tickers) {
      const cik = util.CIK[t];
      if (!cik) continue;
      await sleep(500);
      const sub = await util.httpJson('https://data.sec.gov/submissions/CIK' + cik + '.json', { timeout: 25000, userAgent: ua });
      const js = sub.json || {};
      const recent = (js.filings && js.filings.recent) || {};
      const forms = recent.form || [];
      const rec = { name: js.name, recentForm4: [], recent13: [] };
      for (let i = 0; i < forms.length; i++) {
        const f = forms[i];
        const item = { form: f, filingDate: recent.filingDate[i], accession: recent.accessionNumber[i], primaryDocument: recent.primaryDocument[i] };
        if ((f === '4' || f === '4/A') && rec.recentForm4.length < 6) rec.recentForm4.push(item);
        if ((/13/.test(f) && (/SC/.test(f) || /SCHEDULE/.test(f) || /^13D/.test(f) || /^13G/.test(f))) && rec.recent13.length < 6) rec.recent13.push(item);
      }
      index[t] = rec;
      if (rec.recentForm4[0]) {
        await sleep(500);
        const item = rec.recentForm4[0];
        const url = edgar.form4DocUrl(cik, item.accession, item.primaryDocument);
        const q = await util.httpJson(url, { timeout: 20000, userAgent: ua });
        const xml = q.text || (q.buf ? q.buf.toString('utf8') : '');
        if (xml && xml.includes('ownershipDocument')) {
          const parsed = edgar.parseForm4(xml);
          parsed.sourceUrl = url;
          parsed.filingDate = item.filingDate;
          parsed.accession = item.accession;
          form4[t] = parsed;
        } else {
          form4[t] = { error: q.ok ? 'no ownershipDocument' : ('HTTP ' + q.status), url };
        }
      }
      let picked = null;
      for (const item of rec.recent13) {
        await sleep(400);
        const url = edgar.form4DocUrl(cik, item.accession, item.primaryDocument);
        const q = await util.httpJson(url, { timeout: 20000, userAgent: ua });
        const xml = q.text || (q.buf ? q.buf.toString('utf8') : '');
        if (!xml) continue;
        const parsed = edgar.parse13dg(xml);
        parsed.sourceUrl = url;
        parsed.filingDate = item.filingDate;
        parsed.accession = item.accession;
        parsed.form = item.form;
        if (edgar.matchesIssuer(parsed, { cik, cusip: util.CUSIP[t] })) {
          parsed.matchedIssuer = true;
          picked = parsed;
          break;
        }
        if (!picked) {
          parsed.matchedIssuer = false;
          parsed.skipReason = `Issuer CIK ${parsed.issuerCik} / CUSIP ${parsed.issuerCusip} does not match ${t}`;
          picked = parsed;
        }
      }
      if (picked) sched13[t] = picked;
    }
    const out = {
      ok: Object.keys(form4).length + Object.keys(sched13).length > 0,
      fetchedAt: Date.now(),
      fetchedAtIst: util.toIST(Date.now()),
      source: 'SEC EDGAR',
      userAgentConfigured: true,
      form4, sched13, index,
      notes: [
        'Free official APIs at data.sec.gov / www.sec.gov. User-Agent includes a name and contact email.',
        'Form 4 sales marked 10b5-1 are pre-planned and are a weak directional tell; open-market (code P) buys are more useful.',
        '13D (or 13G amended to 13D) signals activist or control intent; 13G under Rule 13d-1(b) is usually a passive institution.',
        'Filings are always filtered by issuer CIK or CUSIP so related-entity submissions are not shown as this stock.',
      ],
    };
    util.writeJsonAtomic(cacheFile('filings.json'), out);
    state.filings = out;
    return out;
  } catch (e) {
    state.lastError = e.message;
    return state.filings;
  } finally { state.busy.filings = false; }
}

async function refreshCboe(tickers = util.FEATURED) {
  if (state.busy.cboe) return state.options;
  state.busy.cboe = true;
  try {
    const asof = new Date();
    const byTicker = {};
    let ok = false;
    for (const t of tickers) {
      const url = 'https://cdn.cboe.com/api/global/delayed_quotes/options/' + t + '.json';
      const p = await util.httpJson(url, { timeout: 40000 });
      if (p.json && p.json.data) {
        const rec = cboe.unusualFromChain(p.json, asof);
        rec.ok = true;
        rec.sourceUrl = url;
        byTicker[t] = rec;
        ok = true;
      } else {
        byTicker[t] = { ok: false, error: p.ok ? 'no json' : ('HTTP ' + p.status) };
      }
    }
    const out = {
      ok, fetchedAt: Date.now(), fetchedAtIst: util.toIST(Date.now()),
      rth: util.isRthNewYork(),
      byTicker,
      notes: [
        'Cboe delayed-quotes CDN — free, no key. This is not a live options-flow tape (no sweeps or splits).',
        'If last_trade_time is the prior session close, treat contract volume as the prior session until RTH is underway.',
        'Large call volume can be a buy-write or a hedge — contracts are listed, not auto-tagged as smart-money longs.',
      ],
    };
    util.writeJsonAtomic(cacheFile('cboe.json'), out);
    state.options = out;
    return out;
  } catch (e) {
    state.lastError = e.message;
    return state.options;
  } finally { state.busy.cboe = false; }
}

function loadThirteenF() {
  const cached = util.readJson(cacheFile('13f-compact.json'), null);
  const seed = util.readJson(SEED_13F(), null);
  const pick = (cached && cached.byTicker) ? cached : seed;
  state.thirteenF = pick;
  return pick;
}

function spawn13fRefresh() {
  if (state.busy.thirteenF) return;
  const script = path.join(ROOT(), 'scripts', 'parse-13f-compact.py');
  if (!fs.existsSync(script)) return;
  state.busy.thirteenF = true;
  const outFile = cacheFile('13f-compact.json');
  const child = spawn('python3', [script, '--out', outFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SEC_USER_AGENT: util.secUserAgent() },
  });
  child.on('close', () => {
    state.busy.thirteenF = false;
    loadThirteenF();
  });
  child.on('error', () => { state.busy.thirteenF = false; });
}

function panelSnapshot() {
  loadCaches();
  const finra = state.finra;
  const filings = state.filings;
  const options = state.options;
  const f13 = state.thirteenF || loadThirteenF();

  const tradeMs = finra && finra.tradeDate ? Date.parse(finra.tradeDate + 'T21:00:00Z') : null;
  const siMs = finra && finra.shortInterest && finra.shortInterest.settlementDate
    ? Date.parse(finra.shortInterest.settlementDate + 'T20:00:00Z') : null;
  const atsWeek = finra && finra.weeklyAtsOtc && finra.weeklyAtsOtc.latestWeek;
  const atsPub = finra && finra.weeklyAtsOtc && (finra.weeklyAtsOtc.publishedDates || []).slice(-1)[0];
  const atsMs = atsPub ? Date.parse(atsPub + 'T20:00:00Z') : (atsWeek ? Date.parse(atsWeek + 'T20:00:00Z') : null);

  return {
    short: {
      title: 'Cash short positioning',
      source: util.sourceMeta({
        name: 'FINRA Reg SHO daily short volume + consolidated short interest',
        asOf: finra && finra.tradeDate ? ('short volume ' + finra.tradeDate + (finra.shortInterest && finra.shortInterest.settlementDate ? '; SI settlement ' + finra.shortInterest.settlementDate : '')) : null,
        asOfMs: tradeMs,
        lag: util.lagLabel(tradeMs),
        note: 'Off-exchange short volume is not short interest. Short interest is lagged ~8–11 business days after settlement.',
        status: finra && finra.ok ? 'ok' : (finra ? 'stale' : 'pending'),
      }),
      tradeDate: finra && finra.tradeDate,
      shortVolume: finra && finra.cdnShortVolume && finra.cdnShortVolume.rows,
      apiShortVolume: finra && finra.apiShortVolume,
      shortInterest: finra && finra.shortInterest,
      caveats: (finra && finra.caveats) || [],
    },
    ats: {
      title: 'Dark pool / ATS (weekly, lagged)',
      source: util.sourceMeta({
        name: 'FINRA weekly ATS / OTC transparency',
        asOf: atsWeek ? ('week of ' + atsWeek + (atsPub ? ', published ' + atsPub : '')) : null,
        asOfMs: atsMs,
        lag: util.lagLabel(atsMs),
        note: 'Wholesaler volume is internalization, shown separately from ATS dark pools.',
        status: atsWeek ? 'ok' : (finra ? 'stale' : 'pending'),
      }),
      weekStartDate: atsWeek || null,
      publishedDate: atsPub || null,
      byTicker: (finra && finra.weeklyAtsOtc && finra.weeklyAtsOtc.byTicker) || {},
    },
    institutional: {
      title: 'Institutional filings',
      source: util.sourceMeta({
        name: 'SEC EDGAR 13F / Form 4 / SC 13D-G',
        asOf: f13 && f13.periodOfReport ? ('13F period ' + f13.periodOfReport) : (filings && filings.fetchedAtIst),
        asOfMs: filings && filings.fetchedAt,
        lag: f13 && f13.asOfNote ? f13.asOfNote : util.lagLabel(filings && filings.fetchedAt),
        note: 'Lagged official filings. Not an automatic entry. 13F top holders are usually index sponsors.',
        status: (filings && filings.ok) || (f13 && f13.ok) ? 'ok' : 'pending',
      }),
      thirteenF: f13,
      form4: (filings && filings.form4) || {},
      sched13: (filings && filings.sched13) || {},
      notes: (filings && filings.notes) || [],
    },
    options: {
      title: 'Options unusual activity (delayed screen)',
      source: util.sourceMeta({
        name: 'Cboe delayed options JSON',
        asOf: options && options.fetchedAtIst,
        asOfMs: options && options.fetchedAt,
        lag: util.lagLabel(options && options.fetchedAt),
        note: 'Not a live flow tape. Prefer RTH or official close snapshots.',
        status: options && options.ok ? 'ok' : (options ? 'stale' : 'pending'),
      }),
      rth: options ? options.rth : null,
      byTicker: (options && options.byTicker) || {},
      notes: (options && options.notes) || [],
    },
    thirdPartyPaid: [
      { name: 'Coinglass', use: 'Cross-exchange OI / liq dashboards', access: 'Paid API, no free tier', status: 'not_wired' },
      { name: 'Unusual Whales', use: 'Labeled unusual options flow', access: 'Paid API key required; do not scrape the delayed dashboard', status: 'not_wired' },
    ],
  };
}

async function refreshAll({ reason } = {}) {
  loadCaches();
  const jobs = [refreshFinra(), refreshCboe()];
  if (reason === 'boot' || util.isEdgarWindow()) jobs.push(refreshFilings());
  await Promise.allSettled(jobs);
  return panelSnapshot();
}

function start() {
  loadCaches();
  const boot = () => {
    refreshAll({ reason: 'boot' }).catch((e) => { state.lastError = e.message; });
  };
  setTimeout(boot, 8000);
  setInterval(() => {
    refreshFinra().catch(() => {});
  }, 6 * 3600e3);
  setInterval(() => {
    if (util.isRthNewYork() || !state.options) refreshCboe().catch(() => {});
  }, 15 * 60e3);
  setInterval(() => {
    if (util.isEdgarWindow()) refreshFilings().catch(() => {});
  }, 20 * 60e3);
  setInterval(() => { spawn13fRefresh(); }, 24 * 3600e3);
}

module.exports = {
  state, start, refreshFinra, refreshFilings, refreshCboe, refreshAll,
  panelSnapshot, loadCaches, loadThirteenF, spawn13fRefresh,
  parseCdnShortVolume, priorWeekday,
};
