// Zone book rules inferred from the 2026-11-20 Zone Monitor capture (ticker levels,
// ignition tape, reversals/phase column). Pure functions only — no network.
// Every threshold that was not printed on the page is listed in ASSUMPTIONS.
"use strict";

const RULES = {
  // Tape: SQQQ IGN-A at Δgex +0.30, QSI IGN-THIN at +0.32, KDP IGN-B at +0.39.
  // One entry threshold; the book letter is the liquidity tier, not a second trigger.
  IGN_DGEX: 0.30,
  // Still "in the book" during the 10:20–11:00 fingerprint (a little slack so a tick does not knock it out).
  IGN_HOLD: 0.20,
  // Confirmed break must clear the 09:30 print by this many percent. Not printed; see ASSUMPTIONS.
  BREAK_PCT: 0.30,
  THIN_SPOT: 5,
  THIN_OI: 5000,
  // ATM premium at/above this confirms the book. It does not block: the capture's ignitions printed ATM ≈ 0.
  FLOW_CONFIRM: 250000,
  EXHAUST_NORM: 0.70,   // SQQQ +0.88, PACB +0.77, PTRN +0.89 were EXHAUSTION
  EXHAUST_DGEX: 0.15,   // those same rows had |Δgex| of about 0.02, 0.05 and 0.12
  SIGN_POS: 0.30,       // ABBV +0.30 printed NEU; ABT +0.34 and GENB +0.33 printed POS
  SIGN_NEG: -0.30,
  POSTURE_BAND: 0.08,
  SHORT_NORM: 0.25,
  FRESH_NORM: 0.15,
  DECAY_DROP: 0.10,
  DIAL_GATE: 2.5,       // printed: "BUY GATED — dial < 2.5"
  BREADTH_SWING: 34,    // printed: "+GEX breadth … (needs ≥ 34%)"
  TIDE_PP: 3,
  CONFIRM_OPEN: 9 * 60 + 30,
  CONFIRM_OPEN_END: 9 * 60 + 40,
  CONFIRM_FP_START: 10 * 60 + 20,
  CONFIRM_FREEZE: 11 * 60,
  SCAN_START: 9 * 60,   // 09:00 ET the break line switches from the rule sentence to "scanning"
  FLIP_CLEAR: 1.05,     // spot more than 5% through the flip leaves a short-gamma TREND
  AIR_GAP: 2,           // percent of spot: nearer than this is not an airpocket
  DTE_LIST: 20,         // 0DTE page includes names at or above this share of |gamma|
  DTE_HEAVY: 50,        // share at which today's expiry dominates the hedge
  PIN_PCT: 0.4,         // spot within this percent of the heaviest 0DTE strike
};

const TIER_A = new Set("SPY QQQ IWM DIA TQQQ SQQQ SMH SOXL SOXS AAPL MSFT NVDA AMZN GOOGL GOOG META TSLA AVGO AMD".split(" "));

// Names visible on the 2026-11-20 ticker-levels capture. Header said 129; only these were on the page.
const BOOK = ("AAOI AAPL ABBV ABSI ABT ADBE ADPT AMAT AMD AMZN ARCT ASTS AYI BE BEAM BFLY CAT CEG CERS CMPS COHR COIN CRCL CRDO CRM CRSP CRWD CRWV CVNA DDOG DELL ENPH FSLR GE GENB GEV GLW GOOG HOOD IBB IDNA INTC IONQ IREN IWM KDP KYMR LLY LRCX MASS META MRVL MSFT MSTR MU NBIS NET NTLA NVDA PACB PANW PATH PBE PL PLTR PRME PSNL PTRN PURR PYPL QCOM QQQ QSI RBLX RXRX SDGR SHOP SMH SNDK SNOW SOFI SOXX SPCX SPY SQQQ TEAM TECH TEM TER TMO TQQQ TSLA TWST URI VCYT WDAY WDC XBI ZS").split(" ");

const INDUSTRY = (() => {
  const groups = {
    "AI & Compute": "NVDA AMD AVGO MU INTC QCOM AMAT LRCX AAOI CRDO COHR SNDK SMH SOXX ARM SMCI",
    "Software & IT Services": "MSFT CRM ADBE SNOW PLTR CRWD PANW NET DDOG SHOP TEAM ZS PATH RBLX NOW",
    "Pharma & Biotech": "LLY ABBV AMGN PFE MRK ARCT NTLA BEAM KYMR RXRX PACB QSI CRSP SDGR IDNA VCYT PSNL PRME ABSI ADPT GENB PTRN TWST MASS PBE TECH",
    "Medical Devices & Diagnostics": "TMO ABT ISRG",
    "Next-gen & Clean Energy": "CEG ENPH FSLR BE VST",
    "Machinery & Equipment": "CAT GE URI DE",
    "Crypto & Digital Assets": "COIN HOOD MSTR IREN CRCL MARA",
    "Internet & Telecom": "GOOG GOOGL META AMZN",
    "Hardware & Instruments": "DELL WDC AAPL",
    "Consumer & Retail": "TSLA CVNA WMT",
    "ETFs & Index": "SPY QQQ IWM DIA TQQQ SQQQ IBB XBI",
  };
  const map = new Map();
  for (const [g, list] of Object.entries(groups)) for (const t of list.split(" ")) map.set(t, g);
  return map;
})();

const ASSUMPTIONS = [
  "Ignition is one threshold, Δgex ≥ +0.30 versus the prior session's normalized GEX. The capture's three prints were +0.30 (IGN-A), +0.32 (IGN-THIN) and +0.39 (IGN-B). The letter is the liquidity tier, not a different trigger.",
  "Tier A is a fixed liquid list (index ETFs and the largest names). Tier THIN is spot under $5 or listed option open interest under 5,000 contracts. Everyone else is tier B. QSI was THIN, KDP was B, SQQQ was A.",
  "ATM premium does not block an ignition. The capture fired books with ATM around $0. A near-spot call-minus-put premium of at least $250,000 is tagged flow-confirmed; at or below −$250,000 is tagged flow-opposed.",
  "EXHAUSTION is normalized GEX ≥ +0.70 and |Δgex| ≤ 0.15 (SQQQ, PACB, PTRN). [IV] means at-the-money implied vol is at least 10% above the stored prior session. [VOL] means today's option volume exceeds 25% of open interest. Both tags need a prior session or a live chain; they are omitted when that input is missing.",
  "GEX sign badges: POS above +0.30, NEG below −0.30, else NEU. +0.30 itself stays NEU so it matches the ABBV print; +0.33 and above matches GENB and ABT.",
  "Posture MEAN REVERT: normalized GEX ≥ +0.08 and spot is at or above the gamma flip (or, with no flip, spot is between the put and call walls). TREND: normalized GEX ≤ −0.08 and spot has not cleared the flip by more than 5%. Otherwise NEUTRAL. The arrow is the prior session's posture pointing at today's.",
  "Phase uses the prior session only. FRESH: crossed up through +0.05. +GEX held: stayed positive and did not fall by 0.10 or more. DECAYING: still positive but down at least 0.10. EXIT: was clearly signed and has faded through zero or into the dead zone. SHORT γ: normalized GEX ≤ −0.25 and the prior session was already negative. With no prior session the phase is marked provisional (FRESH if ≥ +0.15, SHORT γ if ≤ −0.25, otherwise blank).",
  "The capture's \"regime gone\" label (LLY, MASS) did not have a rule that could be separated from the other columns, so this build does not emit it.",
  "Confirmed break is live-session only. The name must be in an ignition book on a poll between 09:30 and 09:40 ET, then on a poll between 10:20 and 11:00 spot must be at least 0.30% above that 09:30 print and Δgex must still be ≥ +0.20. The set freezes at 11:00. The 0.30% extension was not printed.",
  "BROKE D−1 is yesterday's low under the prior session's low, from daily bars. It is a flag, not an entry.",
  "+GEX breadth is the share of the book with spot above the flip and normalized GEX > 0. gexbr is the share with normalized GEX > 0. The capture showed 22% and 56% at the same time; these two definitions are the split this build uses. Swing-low confirmation needs +GEX breadth ≥ 34%, SPY normalized GEX > 0, and QQQ no longer sitting on the low (bounce ≥ 0.5%). The existing Zone Monitor page keeps its own 36% / +3% wording.",
  "Bull dial is three lights: SPY above its 20-day EMA, credit CALM or EASING, SPY normalized GEX > 0. Buys are gated when the score is under 2.5, which means only 3 of 3 passes. This dial is separate from the six-part dial already on /zone.",
  "Gamma tide FALLING / RISING uses a 3 percentage-point move versus five sessions earlier (one session earlier until five exist). At or below the 5th percentile of stored gexbr readings the tide is WASHED OUT: multi-day only, small size. Ignition context AVOID (SPY normalized GEX < −0.15 and down on the day) is a warning, not a size gate, matching the capture. O-GAP GATE SHUT when SPY gamma is negative and +GEX breadth is under 40%; the capture says that gate applies to an O-GAP book only, and this build does not trade that book.",
  "Credit size tags: while the credit week is FEAR or WATCH, Pharma & Biotech names show L×1.25 S×0.75 and other groups show WAIT. A name is \"reacting\" when its session return differs from SPY by more than 1.5 percentage points, otherwise \"inline\". The capture's per-sector −11.2 (0) study figures are not recomputed.",
  "Order-flow imbalance (the capture's \"34.4% of names bid\") is not invented. The OFI panel stays unavailable until UW_API_KEY is set. SPY versus its 20-day EMA still drives the stall-short line, because that input exists.",
  "Normalized GEX is (call dollar-gamma − put dollar-gamma) / (call + put), the same convention the existing Zone Monitor uses. Dollar gamma is gamma × open interest × 100 × spot² × 1%.",
  "Without Unusual Whales, ATM $ is near-spot option premium times volume, calls minus puts, from the chain in hand. It is not signed Unusual Whales flow. The column is labeled so.",
  "Nasdaq's public chain has no greeks. Implied vol is solved from the bid/ask mid (Black–Scholes, 4% rate, no dividend) and gamma is computed from that vol. Cboe delayed chains are preferred when Cloudflare returns them, because they include a vendor gamma. The chain window is near-the-money front-month contracts, not every listed expiry.",
  "Row order on the reference page was not a documented ranking. This table is alphabetical.",
  "DEEPENING is short gamma getting shorter: normalized GEX under −0.05, prior session already negative, and at least 0.10 more negative. The second capture shows it on FSLR. With no prior session a deep negative print is provisional SHORT γ instead.",
  "CONFIRMED BREAK says scanning from 09:00 ET until the 09:30 poll. The 08:39 capture still showed the rule sentence; the 09:00 capture said scanning.",
  "An airpocket is a name whose nearest put or call wall is at least 2% of spot away. UNDER means that wall is above the price (the shelf is overhead). OVER means the wall is below. The Airpocket tab was not opened in either capture, so the 2% gap is a documented default, not a printed threshold. Names with no wall are left off the list.",
  "The 0DTE page keeps names where today's expiry is at least 20% of absolute dollar gamma. HEAVY means that share is at least 50%. PIN means spot is within 0.4% of the strike with the most 0DTE open interest. 0DTE flow is call premium minus put premium, times volume, on today's expiry and within 1% of spot. The levels table's 0DTE% column was blank in both captures, so these cutoffs are defaults. Unusual Whales strike gamma has no expiry, so 0DTE stays blank on that feed.",
  "Weekly was a tab on the reference and was not in either capture, so that route does not invent a weekly book.",
  "The tape updates when chains refresh (default every 5 minutes), not every 30 seconds. A 30-second poll of this book would hammer the public chain hosts. Premarket books can still print; the confirmed-break window does not open before 09:30 ET.",
];

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const median = a => {
  const s = [...a].filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const stdev = a => {
  const s = a.filter(Number.isFinite);
  if (s.length < 2) return null;
  const m = mean(s);
  return Math.sqrt(s.reduce((n, x) => n + (x - m) ** 2, 0) / (s.length - 1));
};
const nPdf = x => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
function nCdf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1, t = 1 / (1 + p * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1 + sign * y);
}
function bsPrice(S, K, T, iv, cp, r = 0.04) {
  if (!(S > 0 && K > 0 && T > 0 && iv > 0)) return null;
  const s = iv * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + iv * iv / 2) * T) / s;
  const d2 = d1 - s;
  const call = S * nCdf(d1) - K * Math.exp(-r * T) * nCdf(d2);
  return cp === "P" ? call - S + K * Math.exp(-r * T) : call;
}
function bsGamma(S, K, T, iv) {
  if (!(S > 0 && K > 0 && T > 0 && iv > 0)) return 0;
  const d1 = (Math.log(S / K) + (0.04 + iv * iv / 2) * T) / (iv * Math.sqrt(T));
  return nPdf(d1) / (S * iv * Math.sqrt(T));
}
function impliedVol(price, S, K, T, cp) {
  if (!(price > 0 && S > 0 && K > 0 && T > 0)) return null;
  const disc = Math.exp(-0.04 * T);
  const intrinsic = cp === "C" ? Math.max(S - K * disc, 0) : Math.max(K * disc - S, 0);
  if (price < intrinsic + Math.max(0.02, S * 0.0002)) return null;
  let iv = 0.45;
  for (let i = 0; i < 14; i++) {
    const px = bsPrice(S, K, T, iv, cp);
    const d1 = (Math.log(S / K) + (0.04 + iv * iv / 2) * T) / (iv * Math.sqrt(T));
    const vega = S * nPdf(d1) * Math.sqrt(T);
    if (!(vega > 1e-6) || px == null) break;
    const next = iv - (px - price) / vega;
    iv = Math.min(4, Math.max(0.02, next));
    if (Math.abs(px - price) < 0.01) break;
  }
  return iv;
}

function parseNum(v) {
  if (v == null || v === "" || v === "--" || v === "-") return null;
  const n = Number(String(v).replace(/[$,%]/g, "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
function nyOffsetHours(ms) {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" }).formatToParts(new Date(ms)).find(p => p.type === "timeZoneName");
  const m = /GMT([+-]\d+)/.exec(part ? part.value : "");
  return m ? Number(m[1]) : -5;
}
function closeMs(isoDay) {
  const probe = Date.parse(isoDay + "T21:00:00Z");
  const off = nyOffsetHours(probe);
  return Date.parse(isoDay + "T00:00:00Z") + (16 - off) * 3600e3;
}
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function parseExpiry(label, todayIso) {
  const m = /^([A-Za-z]{3})\s+(\d{1,2})$/.exec(String(label || "").trim());
  if (!m || !MONTHS[m[1].toLowerCase()] || !todayIso) return null;
  const year0 = +todayIso.slice(0, 4), month = MONTHS[m[1].toLowerCase()], day = String(+m[2]).padStart(2, "0"), mm = String(month).padStart(2, "0");
  const candidates = [year0, year0 + 1].map(year => `${year}-${mm}-${day}`);
  const iso = candidates.find(d => d >= todayIso) || candidates[0];
  return { iso, ms: closeMs(iso) };
}
function addDays(iso, n) {
  const d = new Date(Date.parse(iso + "T12:00:00Z") + n * 864e5);
  return d.toISOString().slice(0, 10);
}
function yearFrac(expMs, nowMs) {
  return Math.max((expMs - nowMs) / (365.25 * 864e5), 20 / (365.25 * 24 * 60));
}

function gexSign(norm) {
  if (norm == null || !Number.isFinite(norm)) return null;
  if (norm > RULES.SIGN_POS) return "POS";
  if (norm < RULES.SIGN_NEG) return "NEG";
  return "NEU";
}
function industryOf(symbol) { return INDUSTRY.get(symbol) || "Other"; }
function bookTier(symbol, spot, oi) {
  if (TIER_A.has(symbol)) return "A";
  if ((spot > 0 && spot < RULES.THIN_SPOT) || (oi != null && oi < RULES.THIN_OI)) return "THIN";
  return "B";
}

function postureOf(norm, spot, flip, putWall, callWall) {
  if (norm == null || !(spot > 0)) return null;
  const pos = norm >= RULES.POSTURE_BAND, neg = norm <= -RULES.POSTURE_BAND;
  const between = putWall > 0 && callWall > 0 && spot >= Math.min(putWall, callWall) && spot <= Math.max(putWall, callWall);
  if (pos && flip > 0 && spot >= flip) return "MEAN REVERT";
  if (pos && !(flip > 0) && between) return "MEAN REVERT";
  if (neg && (!(flip > 0) || spot <= flip * RULES.FLIP_CLEAR)) return "TREND";
  return "NEUTRAL";
}

function phaseOf(norm, history) {
  if (norm == null || !Number.isFinite(norm)) return { phase: null, provisional: false };
  const prior = history && history.length ? history[history.length - 1].norm : null;
  if (prior == null || !Number.isFinite(prior)) {
    if (norm >= RULES.FRESH_NORM) return { phase: "FRESH", provisional: true };
    if (norm <= -RULES.SHORT_NORM) return { phase: "SHORT_GAMMA", provisional: true };
    return { phase: null, provisional: true };
  }
  if (prior <= 0.05 && norm > 0.05) return { phase: "FRESH", provisional: false };
  if (norm > 0.05 && prior > 0.05 && norm < prior - RULES.DECAY_DROP) return { phase: "DECAYING", provisional: false };
  if (norm > 0.05 && prior > 0.05) return { phase: "HELD", provisional: false };
  if ((prior > 0.15 && norm <= 0.08) || (prior < -0.15 && norm >= -0.08)) return { phase: "EXIT", provisional: false };
  if (norm < -0.05 && prior < 0 && norm < prior - RULES.DECAY_DROP) return { phase: "DEEPENING", provisional: false };
  if (norm <= -RULES.SHORT_NORM && prior < 0) return { phase: "SHORT_GAMMA", provisional: false };
  if (norm < -0.05 && prior >= -0.05) return { phase: "EXIT", provisional: false };
  return { phase: null, provisional: false };
}

function flowOf(norm, dgex, iv, prevIv, volume, oi) {
  const tags = [];
  if (prevIv > 0 && iv > prevIv * 1.10) tags.push("IV");
  if (oi > 0 && volume > 0.25 * oi) tags.push("VOL");
  const exhaustion = norm >= RULES.EXHAUST_NORM && dgex != null && Math.abs(dgex) <= RULES.EXHAUST_DGEX;
  return { flow: exhaustion ? "EXHAUSTION" : "NEUTRAL", tags };
}

function ignitionOf(dgex, tier, atmPrem) {
  if (!(dgex >= RULES.IGN_DGEX) || !tier) return null;
  let flowTag = null;
  if (atmPrem >= RULES.FLOW_CONFIRM) flowTag = "confirmed";
  else if (atmPrem <= -RULES.FLOW_CONFIRM) flowTag = "opposed";
  return { book: tier, flowTag };
}

function airpocketOf(row) {
  if (!row || !(row.spot > 0)) return null;
  const walls = [row.putWall, row.callWall].filter(w => w > 0);
  if (!walls.length) return null;
  let nearest = walls[0], dist = Math.abs(row.spot - walls[0]);
  for (const w of walls) { const d = Math.abs(row.spot - w); if (d < dist) { dist = d; nearest = w; } }
  const gap = dist / row.spot * 100;
  if (gap < RULES.AIR_GAP) return null;
  return { kind: "AIRPOCKET", side: nearest > row.spot ? "UNDER" : "OVER", gap, wall: nearest };
}
function dteSignal(row) {
  if (!row || row.pct0 == null || row.pct0 < RULES.DTE_LIST) return null;
  const tags = [row.pct0 >= RULES.DTE_HEAVY ? "HEAVY" : "PRESENT"];
  if (row.pinStrike > 0 && Math.abs(row.spot - row.pinStrike) / row.spot * 100 <= RULES.PIN_PCT) tags.push("PIN");
  if (row.prem0 > 0) tags.push("CALL-FLOW");
  else if (row.prem0 < 0) tags.push("PUT-FLOW");
  return { kind: tags[0], tags };
}
function reversalOf(row) {
  if (!row || row.phase === "SHORT_GAMMA") return null;
  const live = row.posture, base = row.basePosture;
  if (base === "MEAN REVERT" && (live === "NEUTRAL" || live === "TREND")) return { kind: "REVERT-FAILED", side: "stand aside" };
  if (base === "NEUTRAL" && live === "MEAN REVERT") return { kind: "REVERT-PENDING", side: "fade" };
  if (base === "TREND" && live === "NEUTRAL" && (row.dgex == null || row.dgex > 0)) return { kind: "TREND-EXHAUST", side: "cover" };
  if (live === "MEAN REVERT" && row.norm >= RULES.POSTURE_BAND) return { kind: "REVERT", side: "fade" };
  return null;
}

function creditTag(group, creditState, nameRet, spyRet) {
  if (!creditState) return null;
  const stressed = creditState === "FEAR" || creditState === "WATCH";
  const pharma = /pharma|biotech/i.test(group || "");
  const align = nameRet != null && spyRet != null && Math.abs(nameRet - spyRet) > 1.5 ? "reacting" : "inline";
  return { align, size: stressed && pharma ? "L×1.25 S×0.75" : "1×", wait: stressed && !pharma };
}

function brokeD1(bars, todayIso) {
  const done = (bars || []).filter(b => b && b.d && b.d < todayIso && b.l > 0);
  if (done.length < 2) return null;
  return done.at(-1).l < done.at(-2).l;
}
function retFrom(bars, todayIso, spot, sessionsBack) {
  const done = (bars || []).filter(b => b && b.d && b.d < todayIso && b.c > 0);
  const prev = done.at(-1);
  const back = done.at(-1 - sessionsBack);
  return {
    prevClose: prev ? prev.c : null,
    session: prev && spot > 0 ? (spot / prev.c - 1) * 100 : null,
    d5: back && spot > 0 ? (spot / back.c - 1) * 100 : null,
  };
}

function structure(chain, nowMs) {
  const S = chain.spot;
  if (!(S > 0) || !Array.isArray(chain.legs)) return null;
  const todayIso = chain.today;
  let call = 0, put = 0, oi = 0, volume = 0, g0 = 0, g17 = 0, gAll = 0, call0 = 0, put0 = 0, oi0 = 0, vol0 = 0, prem0 = 0, prem0seen = false;
  const oi0Strike = new Map();
  const putOi = new Map(), callOi = new Map(), strikeNet = new Map();
  const byStrike = new Map();
  const ivs = [];
  for (const leg of chain.legs) {
    const K = Number(leg.K), exp = Number(leg.exp);
    if (!(K > 0) || !(exp > 0)) continue;
    const open = Number(leg.oi) || 0, vol = Number(leg.vol) || 0;
    oi += open; volume += vol;
    const T = yearFrac(exp, nowMs);
    let iv = Number(leg.iv);
    if (!(iv > 0) && leg.mid > 0) iv = impliedVol(leg.mid, S, K, T, leg.cp);
    let gamma = Number(leg.gamma);
    if (!(gamma > 0) && iv > 0) gamma = bsGamma(S, K, T, iv);
    const dollar = gamma > 0 && open > 0 ? gamma * open * 100 * S * S * 0.01 : 0;
    if (leg.cp === "C") call += dollar; else put += dollar;
    if (dollar > 0) strikeNet.set(K, (strikeNet.get(K) || 0) + (leg.cp === "C" ? dollar : -dollar));
    gAll += Math.abs(dollar);
    const iso = leg.expIso || null;
    if (iso && todayIso) {
      if (iso === todayIso) {
        g0 += Math.abs(dollar);
        if (leg.cp === "C") call0 += dollar; else put0 += dollar;
        oi0 += open; vol0 += vol;
        if (open > 0) oi0Strike.set(K, (oi0Strike.get(K) || 0) + open);
        if (Math.abs(K - S) / S <= 0.01 && leg.mid > 0 && vol > 0) { prem0seen = true; prem0 += (leg.cp === "C" ? 1 : -1) * vol * leg.mid * 100; }
      } else if (iso > todayIso && iso <= addDays(todayIso, 7)) g17 += Math.abs(dollar);
    }
    if (open > 0) {
      if (leg.cp === "P") putOi.set(K, (putOi.get(K) || 0) + open);
      else callOi.set(K, (callOi.get(K) || 0) + open);
    }
    const rec = byStrike.get(K) || { callVol: 0, putVol: 0, callMid: null, putMid: null };
    if (leg.cp === "C") { rec.callVol += vol; if (leg.mid > 0) rec.callMid = leg.mid; }
    else { rec.putVol += vol; if (leg.mid > 0) rec.putMid = leg.mid; }
    byStrike.set(K, rec);
    if (iv > 0 && Math.abs(K - S) / S < 0.03) ivs.push(iv);
  }
  const gross = call + put;
  if (!(gross > 0) && putOi.size + callOi.size === 0) return null;
  const norm = gross > 0 ? (call - put) / gross : null;
  const wall = map => { let best = null, bestOi = 0; for (const [k, v] of map) if (v > bestOi) { best = k; bestOi = v; } return best; };
  const putWall = wall(putOi), callWall = wall(callOi);
  // Gamma flip: reprice net dollar gamma across a ±12% spot grid when iv is known.
  let flip = null, flipMethod = null;
  const priced = chain.legs.filter(leg => {
    const T = yearFrac(Number(leg.exp), nowMs);
    const iv = Number(leg.iv) > 0 ? Number(leg.iv) : (leg.mid > 0 ? impliedVol(leg.mid, S, leg.K, T, leg.cp) : null);
    leg._iv = iv; leg._T = T; return iv > 0 && leg.oi > 0 && leg.K > 0;
  });
  if (priced.length >= 4) {
    const netAt = x => priced.reduce((sum, leg) => sum + (leg.cp === "C" ? 1 : -1) * bsGamma(x, leg.K, leg._T, leg._iv) * leg.oi * 100 * x * x * 0.01, 0);
    let prev = null;
    for (let k = -48; k <= 48; k++) {
      const x = S * (1 + k * 0.0025), v = netAt(x);
      if (prev && Math.sign(v) !== Math.sign(prev.v) && v !== 0 && prev.v !== 0) {
        const f = prev.x + (x - prev.x) * (-prev.v) / (v - prev.v);
        if (flip == null || Math.abs(f - S) < Math.abs(flip - S)) flip = f;
      }
      prev = { x, v };
    }
    if (flip) flipMethod = "grid";
  }
  if (flip == null && strikeNet.size >= 4) {
    const ks = [...strikeNet.keys()].sort((a, b) => a - b);
    let cum = 0, prev = null;
    for (const k of ks) {
      const next = cum + strikeNet.get(k);
      if (prev && Math.sign(cum) !== Math.sign(next) && cum !== 0 && next !== 0) { flip = k; flipMethod = "cumulative"; break; }
      cum = next; prev = true;
    }
  }
  // ATM premium: closest strikes, within 1% when any exist there.
  const strikes = [...byStrike.keys()].sort((a, b) => Math.abs(a - S) - Math.abs(b - S));
  const near = strikes.filter(k => Math.abs(k - S) / S <= 0.01);
  const used = (near.length ? near : strikes.slice(0, 1));
  let atmPrem = null;
  if (used.length && used.some(k => byStrike.get(k).callMid || byStrike.get(k).putMid)) {
    atmPrem = 0;
    for (const k of used) {
      const r = byStrike.get(k);
      if (r.callMid > 0) atmPrem += r.callVol * r.callMid * 100;
      if (r.putMid > 0) atmPrem -= r.putVol * r.putMid * 100;
    }
  }
  return {
    symbol: chain.symbol, spot: S, source: chain.source || null, asOf: chain.asOf || null,
    norm, call, put, putWall, callWall, flip, flipMethod,
    oi, volume, pct0: gAll > 0 ? g0 / gAll * 100 : null, pct17: gAll > 0 ? g17 / gAll * 100 : null,
    gex0: call0 + put0 > 0 ? call0 - put0 : null, abs0: call0 + put0 > 0 ? call0 + put0 : null,
    prem0: prem0seen ? prem0 : null, oi0, vol0, pinStrike: wall(oi0Strike),
    atmPrem, ivAtm: ivs.length ? mean(ivs) : null,
  };
}

function evaluateSymbol(input) {
  const s = input.structure;
  if (!s) return null;
  const history = input.history || [];
  const base = input.baseline || null;
  const norm = s.norm;
  const dgex = base && base.norm != null && norm != null ? norm - base.norm : null;
  const ph = phaseOf(norm, history);
  const posture = postureOf(norm, s.spot, s.flip, s.putWall, s.callWall);
  const basePosture = base ? postureOf(base.norm, base.spot, base.flip, base.putWall, base.callWall) : null;
  const flow = flowOf(norm, dgex, s.ivAtm, base && base.ivAtm, s.volume, s.oi);
  const tier = bookTier(input.symbol, s.spot, s.oi);
  const ign = ignitionOf(dgex, tier, s.atmPrem);
  const group = industryOf(input.symbol);
  const nameRet = base && base.spot > 0 ? (s.spot / base.spot - 1) * 100 : input.sessionRet;
  const row = {
    symbol: input.symbol, group, source: s.source, asOf: s.asOf,
    spot: s.spot, norm, sign: gexSign(norm), dgex,
    putWall: s.putWall, callWall: s.callWall, flip: s.flip,
    pct0: s.pct0, pct17: s.pct17, gex0: s.gex0, abs0: s.abs0, prem0: s.prem0, oi0: s.oi0, pinStrike: s.pinStrike,
    atmPrem: s.atmPrem, ivAtm: s.ivAtm, oi: s.oi, volume: s.volume,
    posture, basePosture, phase: ph.phase, phaseProvisional: ph.provisional,
    flow: flow.flow, flowTags: flow.tags,
    book: ign ? ign.book : null, flowTag: ign ? ign.flowTag : null,
    tier,
    base: base ? { spot: base.spot, norm: base.norm, putWall: base.putWall, callWall: base.callWall, flip: base.flip, sign: gexSign(base.norm) } : null,
    vsBase: base && base.spot > 0 ? (s.spot / base.spot - 1) * 100 : null,
    sessionRet: input.sessionRet ?? null, ret5: input.ret5 ?? null, prevClose: input.prevClose ?? null,
    broke: input.broke === true, credit: creditTag(group, input.creditState, nameRet, input.spyRet),
    quote: "chain",
  };
  row.reversal = reversalOf(row);
  row.airpocket = airpocketOf(row);
  row.dte = dteSignal(row);
  return row;
}

function fmtGex(v) { return v == null || !Number.isFinite(v) ? "—" : (v > 0 ? "+" : "") + v.toFixed(2); }
function fmtAtm(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v), sign = v < 0 ? "−" : "+";
  return sign + "$" + (a >= 1e6 ? (a / 1e6).toFixed(1) + "M" : a >= 1e3 ? (a / 1e3).toFixed(0) + "k" : a.toFixed(0));
}
function clockLabel(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

function tapeFromPolls(prev, rows, clock) {
  const events = [];
  const first = !prev;
  for (const r of rows) {
    const p = prev && prev[r.symbol];
    if (r.book && (!p || p.book !== r.book)) {
      const extra = first ? " · on at the first poll" : "";
      events.push({ day: clock.day, mins: clock.mins, symbol: r.symbol, kind: "IGN BOOK", text: `IGN-${r.book === "THIN" ? "THIN" : r.book} Δgex ${fmtGex(r.dgex)} · ATM ${fmtAtm(r.atmPrem)}${extra}` });
      if (!p || !p.book) events.push({ day: clock.day, mins: clock.mins, symbol: r.symbol, kind: "TRACKER FIRE", text: `book ${r.book === "THIN" ? "THIN" : r.book} · ${r.posture || "NEUTRAL"} first seen ${clockLabel(clock.mins)} · Δgex ${fmtGex(r.dgex)} · ATM ${fmtAtm(r.atmPrem)} · provisional` });
    }
    if (r.flow === "EXHAUSTION" && (!p || p.flow !== "EXHAUSTION")) {
      const tag = r.flowTags && r.flowTags.length ? " [" + r.flowTags.join("+") + "]" : "";
      events.push({ day: clock.day, mins: clock.mins, symbol: r.symbol, kind: "FLOW STATE", text: `EXHAUSTION Δgex ${fmtGex(r.dgex)} · ATM ${fmtAtm(r.atmPrem)}${tag}` });
    }
  }
  return events;
}

function confirmedBreaks(polls, clock) {
  const detail = "CONFIRMED BREAK live day only — reads from the 09:30 poll, fingerprint 10:20–11:00, freezes 11:00";
  const today = (polls || []).filter(p => p.day === clock.day && p.mins <= clock.mins).sort((a, b) => a.mins - b.mins);
  const open = today.find(p => p.mins >= RULES.CONFIRM_OPEN && p.mins < RULES.CONFIRM_OPEN_END);
  if (!open) return { status: clock.mins >= RULES.SCAN_START && clock.mins < RULES.CONFIRM_OPEN ? "scanning" : clock.mins < RULES.CONFIRM_OPEN ? "idle" : "waiting", names: [], detail: clock.mins >= RULES.SCAN_START && clock.mins < RULES.CONFIRM_OPEN ? "CONFIRMED BREAK scanning…" : detail };
  const window = today.filter(p => p.mins >= RULES.CONFIRM_FP_START && p.mins <= RULES.CONFIRM_FREEZE);
  if (!window.length) return { status: clock.mins < RULES.CONFIRM_FP_START ? "fingerprint" : "none", names: [], detail };
  const names = [];
  for (const [sym, o] of Object.entries(open.book || {})) {
    if (!o || !o.book || !(o.spot > 0)) continue;
    const hit = window.some(p => {
      const w = p.book && p.book[sym];
      return w && w.dgex >= RULES.IGN_HOLD && w.spot > o.spot * (1 + RULES.BREAK_PCT / 100);
    });
    if (hit) names.push(sym);
  }
  names.sort();
  return { status: clock.mins >= RULES.CONFIRM_FREEZE ? "frozen" : "live", names, detail };
}

function bullDial(input) {
  const parts = [
    ["SPY above 20-day EMA", !!input.spyAboveEma20],
    ["Credit calm or easing", !!input.creditCalm],
    ["SPY long gamma", !!input.spyLongGamma],
  ];
  const score = parts.filter(p => p[1]).length;
  const buyGated = score < RULES.DIAL_GATE;
  return {
    score, max: 3, parts, buyGated,
    text: buyGated ? "BUY GATED — dial < 2.5: regime change, bounces fail (knife buys ~52%, no edge)" : "Dial is 3/3. This gate is open.",
  };
}
function tideState(series) {
  const vals = (series || []).map(x => x.v).filter(Number.isFinite);
  if (!vals.length) return { tide: "BUILDING", pctile: null, last: null, d7: null };
  const last = vals.at(-1);
  const back = n => vals.length > n ? vals[vals.length - 1 - n] : null;
  const ref = back(5) ?? back(1);
  const d7 = ref == null ? null : last - ref;
  let tide = "FLAT";
  if (ref == null) tide = "BUILDING";
  else if (d7 <= -RULES.TIDE_PP) tide = "FALLING";
  else if (d7 >= RULES.TIDE_PP) tide = "RISING";
  const pctile = vals.length > 5 ? Math.round(vals.filter(v => v <= last).length / vals.length * 100) : null;
  return { tide, pctile, last, d7, days: vals.length };
}
function tideAdvice(tide) {
  if (tide.pctile != null && tide.pctile <= 5) return { code: "WASHED", text: "WASHED OUT. Multi-day (D+2) only, small size — the gap is worthless on this rule." };
  if (tide.tide === "FALLING") return { code: "HALVE", text: "Gamma tide falling. Halve size or stand aside — on IGNITION. Δgex-family setups only." };
  if (tide.tide === "RISING") return { code: "OPEN", text: "Gamma tide rising. The capture's ignition gap-up rate was higher in rising tides than in falling ones." };
  if (tide.tide === "BUILDING") return { code: "BUILDING", text: "Gamma tide needs more than one stored session before it has a direction." };
  return { code: "FLAT", text: "Gamma tide flat." };
}
function ignitionContext(spyNorm, spyPrev) {
  const falling = spyPrev != null && spyNorm != null && spyNorm < spyPrev - 0.02;
  if (spyNorm != null && spyNorm < -0.15 && falling) return { code: "AVOID", text: "AVOID. SPY is deep short gamma and still falling. Context for the IGNITION family only — never a size gate. The capture calls this the cell that lost versus the tape." };
  if (spyNorm != null && spyNorm < 0) return { code: "CAUTION", text: "SPY gamma is negative. Ignition context is a caution, not a size gate." };
  if (spyNorm == null) return { code: "UNKNOWN", text: "SPY gamma is not in yet, so ignition context is unknown." };
  return { code: "OPEN", text: "SPY gamma is positive. The avoid cell is not active." };
}
function ogapGate(spyNorm, plusBreadth) {
  if (spyNorm == null) return { code: "UNKNOWN", text: "O-GAP gate is waiting on SPY gamma. It would apply to an O-GAP book only." };
  const shut = spyNorm < 0 && (plusBreadth == null || plusBreadth < 40);
  return shut
    ? { code: "SHUT", text: "O-GAP BACKDROP · GATE SHUT. Structure is collapsed on this rule. It applies to the O-GAP book only — not a market read. This build does not run an O-GAP book." }
    : { code: "OPEN", text: "O-GAP gate is open on this rule. It would apply to an O-GAP book only." };
}
function swingCheck(qqq, plusBreadth, spyNorm) {
  const need = [];
  if (!(plusBreadth >= RULES.BREADTH_SWING)) need.push(`+GEX breadth ${plusBreadth == null ? "—" : plusBreadth.toFixed(0) + "%"} (needs ≥ 34%)`);
  if (!(spyNorm > 0)) need.push(`SPY gamma ${spyNorm == null ? "—" : spyNorm.toFixed(2)} (needs above 0)`);
  if (qqq && !(qqq.bounce >= 0.5)) need.push("today is the low");
  return { confirmed: need.length === 0 && !!qqq, need, qqq };
}

function cohortsOf(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (r.norm == null) continue;
    const g = groups.get(r.group) || [];
    g.push(r); groups.set(r.group, g);
  }
  const out = [...groups.entries()].map(([sector, a]) => ({
    sector, n: a.length,
    posBreadth: a.filter(x => x.norm > 0).length / a.length * 100,
    avgNorm: mean(a.map(x => x.norm)),
    medRet: median(a.map(x => x.sessionRet).filter(Number.isFinite)),
    thin: a.length < 6,
  })).sort((a, b) => b.n - a.n || a.sector.localeCompare(b.sector));
  const disp = stdev(out.map(c => c.posBreadth));
  return { rows: out, dispersion: disp };
}
function breadthsOf(rows) {
  const ok = rows.filter(r => r.norm != null && r.spot > 0);
  if (!ok.length) return { gexbr: null, plus: null, n: 0 };
  const gexbr = ok.filter(r => r.norm > 0).length / ok.length * 100;
  const plus = ok.filter(r => r.norm > 0 && r.flip > 0 && r.spot > r.flip).length / ok.length * 100;
  return { gexbr, plus, n: ok.length };
}

function compactBook(rows) {
  const book = {};
  for (const r of rows) book[r.symbol] = { book: r.book, dgex: r.dgex, spot: r.spot, flow: r.flow, posture: r.posture, norm: r.norm };
  return book;
}

module.exports = {
  RULES, BOOK, ASSUMPTIONS, TIER_A, industryOf, bookTier, gexSign, postureOf, phaseOf, flowOf, ignitionOf, reversalOf,
  creditTag, brokeD1, retFrom, structure, evaluateSymbol, tapeFromPolls, confirmedBreaks, bullDial, tideState, tideAdvice,
  ignitionContext, ogapGate, swingCheck, cohortsOf, breadthsOf, compactBook, airpocketOf, dteSignal, parseNum, parseExpiry, closeMs, impliedVol, bsPrice, bsGamma,
  fmtGex, fmtAtm, clockLabel, addDays,
};
