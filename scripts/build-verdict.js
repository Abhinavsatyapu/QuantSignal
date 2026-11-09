'use strict';
/** Honest verdict from study-report.json — no oversell. */
const fs = require('fs');
const path = require('path');
const report = JSON.parse(fs.readFileSync(path.join(__dirname, 'out/study-report.json'), 'utf8'));

function verdictOf(report) {
  const rec = report.recommendation;
  const s60 = report.sixtyDay || {};
  const cur = s60.current?.summary || {};
  const best = s60.recommended?.summary || {};
  const mc = s60.recommended?.monteCarlo || s60.current?.monteCarlo || {};
  const reasons = [];
  let tier = 'Not worth it';

  const oos = rec?.test || {};
  const oosTrades = oos.trades || 0;
  const oosPnl = oos.totalPnlPct || 0;
  const oosPf = oos.profitFactor || 0;
  const oosDd = oos.maxDdPct || 0;
  const lowN = !!(rec?.lowSample || oos.lowSample || oosTrades < 30);
  const edgeAfterFees = oosPnl > 0 && oosPf >= 1.15;
  const ddOk = oosDd < 35;
  const hit5 = best.hit5plusPctDays ?? cur.hit5plusPctDays ?? 0;
  const vsTheo = best.realisticVsTheo ?? cur.realisticVsTheo ?? 0;
  const ruin = mc.ruinRate;

  if (lowN) reasons.push(`Low trade count / short stock-perp history (OOS trades=${oosTrades}). Statistical significance is weak.`);
  if (!edgeAfterFees) reasons.push(`No clear out-of-sample edge after fees/funding/slippage (OOS P&L ${oosPnl.toFixed?.(2) ?? oosPnl}%, PF ${oosPf}).`);
  else reasons.push(`OOS P&L ${oosPnl}% with profit factor ${oosPf} after costs — mild positive signal, not a proven edge.`);
  if (!ddOk) reasons.push(`Drawdown ${oosDd}% is large vs $800 capital (risk of large equity swings).`);
  else reasons.push(`Max DD ~${oosDd}% of peak in OOS window.`);
  if (hit5 < 15) reasons.push(`Only ~${hit5}% of days reached ≥5% — 5–6%/day is not supported by the evidence.`);
  else if (hit5 < 40) reasons.push(`~${hit5}% of days hit ≥5%; 5–6%/day is occasional, not a reliable daily expectation.`);
  else reasons.push(`~${hit5}% of days hit ≥5% in the 60d window — still far from every-day 5%.`);
  if (vsTheo != null && vsTheo < 0.15) reasons.push(`Compounded growth realized only ~${(vsTheo * 100).toFixed(1)}% of a theoretical 5%/day curve — that curve is fantasy here.`);
  if (ruin != null) reasons.push(`Monte Carlo reshuffle ruin rate (−50% equity): ${(ruin * 100).toFixed(1)}% (${mc.note || ''}).`);
  reasons.push(`Would-have 6% loss-halt days (reference, halt OFF in live defaults): current ${s60.current?.haltDays ?? '—'}, recommended ${s60.recommended?.haltDays ?? '—'}.`);

  // Consistency: look at ranked top vs matrix dispersion
  const ranked = report.ranked || [];
  const positiveOos = ranked.filter((r) => (r.test?.totalPnlPct || 0) > 0).length;
  if (ranked.length && positiveOos / ranked.length < 0.35) {
    reasons.push(`Only ${positiveOos}/${ranked.length} ranked variants positive OOS — edge not consistent across TF×signal.`);
  }

  if (edgeAfterFees && ddOk && !lowN && oosPnl >= 5 && (ruin == null || ruin < 0.25) && hit5 >= 20) {
    tier = 'Worth trading live';
    reasons.unshift('Verdict: Worth trading live (small size) — OOS edge with acceptable DD and enough trades.');
  } else if (edgeAfterFees && (lowN || oosPnl < 8 || (ruin != null && ruin >= 0.25) || !ddOk)) {
    tier = 'Only with changes';
    reasons.unshift('Verdict: Only with changes — some OOS hint exists but sample, DD, or consistency is not good enough to go live as-is.');
  } else {
    tier = 'Not worth it';
    reasons.unshift('Verdict: Not worth it — evidence does not support a durable edge at $800 / 5x on these US equity perps with the tested rules.');
  }

  const needs = [];
  if (tier !== 'Worth trading live') {
    needs.push('Longer listing history / more liquid names before trusting 4h–1d results.');
    needs.push('Stricter signal (confirm mode) or fewer TFs if low-TF noise dominates.');
    needs.push('Re-validate live in dry-run for ≥30 days; do not scale until OOS PF stays >1.2 with N≥50.');
    if (hit5 < 40) needs.push('Treat 5–6%/day as an aspirational ceiling, not a plan — size for realistic expectancy near backtest median day.');
  }

  return { tier, reasons, needs, oos, hit5, vsTheo, ruin, lowN };
}

const v = verdictOf(report);
fs.writeFileSync(path.join(__dirname, 'out/verdict.json'), JSON.stringify(v, null, 2));
console.log(JSON.stringify(v, null, 2));
