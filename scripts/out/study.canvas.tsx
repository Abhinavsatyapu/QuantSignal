import {
  Page, Section, Text, Callout, Table, Metrics, Grid, Rows,
  LineChart, ColumnSeries, BulletList, Steps, Segmented, useState, type TableCell,
} from "grok/canvas";

const TONE = { "Worth trading live": "success", "Only with changes": "warning", "Not worth it": "danger" } as const;
function usd(n: number) { return (n < 0 ? "−" : "") + "$" + Math.abs(n).toFixed(2); }
function pct(n: number) { return (n >= 0 ? "+" : "") + n.toFixed(2) + "%"; }

const EQ = [
  { x: "09-11", y: 831.93 }, { x: "09-26", y: 830.19 }, { x: "10-28", y: 813.14 }, { x: "10-31", y: 827.52 }, { x: "11-09", y: 827.52 },
];
const PNL_L = ["09-11", "09-26", "10-28", "10-31"];
const PNL_V = [31.93, -1.73, -17.06, 14.38];
const DAYS: TableCell[][] = [
  ["2026-09-11", "1", "+$31.93", "+3.99%", "$831.93", "—"],
  ["2026-09-26", "1", "−$1.73", "−0.21%", "$830.19", "—"],
  ["2026-10-28", "1", "−$17.06", "−2.05%", "$813.14", "—"],
  ["2026-10-31", "1", "+$14.38", "+1.77%", "$827.52", "—"],
];
const RANKED: TableCell[][] = [
  ["4h", "Indicators OR liquidity", "8", "+23.32%", "88%", "11.58", "1.97%", { text: "LOW N", tone: "warning" }],
  ["4h", "Liquidity grab alone", "8", "+19.98%", "75%", "5.63", "3.86%", { text: "LOW N", tone: "warning" }],
  ["4h", "All 4 liquidity", "8", "+19.98%", "75%", "5.63", "3.86%", { text: "LOW N", tone: "warning" }],
  ["30m", "Indicators OR liquidity", "8", "+17.29%", "75%", "4.68", "0.0%", { text: "LOW N", tone: "warning" }],
  ["30m", "Sweep alone", "8", "+12.95%", "63%", "3.59", "0.33%", { text: "LOW N", tone: "warning" }],
  ["15m", "Indicators (current default)", "2", "−4.25%", "—", "—", "—", { text: "LOW N", tone: "danger" }],
];

export default function BinanceEquityPerpStudy() {
  const [tab, setTab] = useState<"recommended" | "current">("recommended");
  const theo5 = 800 * Math.pow(1.05, 60);
  const isRec = tab === "recommended";

  return (
    <Page title="Binance US equity perps — timeframe & signal study" description="Real Binance klines · $800 · 5x · max 4 · 2% risk · compounding · 5% target info-only · loss halt OFF">
      <Callout tone="warning" lead="Verdict: Only with changes">
        Some OOS hint on 4h · indicators-OR-liquidity (8 trades, +23% OOS, PF 11.6) but sample is too small and train was negative. Not durable enough to trade live as-is. 5–6%/day is not supported.
      </Callout>

      <Section title="1. Is this setup valuable?">
        <BulletList items={[
          "Verdict: Only with changes — OOS hint exists but N=8 and consistency are not good enough for live.",
          "Low trade count / short stock-perp listing history. Statistical significance is weak.",
          "OOS +23.32% / PF 11.58 after fees looks strong on paper — treat as tentative, not proven.",
          "Max OOS DD ~2% of peak in that tiny sample (not a comfort blanket).",
          "Only ~0% of 60d days reached ≥5% — 5–6%/day is not evidenced.",
          "Realized growth ~0.2% of a theoretical 5%/day curve — that curve is fantasy here.",
          "Monte Carlo (−50% ruin) on 4 sixty-day trades: 0% (also low-N).",
          "Would-have 6% daily loss-halt days (reference; halt OFF by default): 0 in 60d.",
        ]} />
        <Text weight="semibold">What would need to change</Text>
        <Steps steps={[
          { title: "Longer listing history / more liquid names before trusting 4h–1d results." },
          { title: "Dry-run ≥30 days; do not scale until OOS PF stays >1.2 with N≥50." },
          { title: "Treat 5–6%/day as an aspirational ceiling, not a daily plan." },
          { title: "Keep current live default (15m indicators) until you explicitly select a variant — it was weak OOS here." },
        ]} />
      </Section>

      <Section title="2. Setup & universe">
        <Metrics items={[
          { value: "$800", label: "Start capital", detail: "compounds IST day-start" },
          { value: "5× / 4", label: "Leverage / max pos" },
          { value: "2%", label: "Risk per trade" },
          { value: "5%", label: "Daily target", detail: "informational — does not stop entries" },
          { value: "OFF", label: "Daily loss halt", detail: "6% is reference only" },
          { value: "8", label: "Study symbols", detail: "SOXL, SOXS, MSTR, SPCX, PAYP, OPENAI, AMZN, SPY" },
        ]} />
        <Callout tone="info" lead="Short listing history">
          US stock perps onboarded in 2026. 1d excluded several names (&lt;230 bars). Holding / max-hold scale with TF (4h → 84 bars). Fees ~8 bps RT, funding ~1 bp/8h, slip 3 bps; limit→market after 2 min.
        </Callout>
      </Section>

      <Section title="3. Recommendation (OOS-ranked)">
        <Metrics items={[
          { value: "4h", label: "Timeframe", detail: "LOW SAMPLE — tentative", tone: "warning" },
          { value: "Indicators OR liquidity", label: "Signal mode" },
          { value: "+23.32%", label: "OOS P&L", detail: "8 trades · PF 11.58" },
          { value: "1.97%", label: "OOS max DD", detail: "2026-10-21 → 10-22 · recovered 10-26" },
        ]} />
        <Table headers={["TF", "Variant", "Trades", "OOS P&L", "Win%", "PF", "Max DD%", "Sample"]} rows={RANKED} />
      </Section>

      <Section title="4. Last 60 days (IST) — compounding, no daily halts">
        <Segmented value={tab} onChange={(v: string) => setTab(v as any)} options={[
          { value: "recommended", label: "Recommended 4h" },
          { value: "current", label: "Current 15m indicators" },
        ]} />
        {!isRec && (
          <Callout tone="warning" lead="No trades">15m indicators produced 0 trades in the last 60 IST days on this universe (strict filters + short history).</Callout>
        )}
        <Metrics items={isRec ? [
          { value: "+$27.52", label: "60d P&L", detail: "+3.44% · end $827.52", tone: "success" },
          { value: "4", label: "Trades", detail: "WR 50% · PF 2.46", tone: "warning" },
          { value: "$18.79", label: "Max DD", detail: "2.26% · 09-25 → 10-28 · not recovered" },
          { value: "+$31.93", label: "Best day", detail: "2026-09-11" },
          { value: "−$17.06", label: "Worst day", detail: "2026-10-28" },
          { value: "2 / 2", label: "Win / loss days", detail: "≥5% days: 0 · 5–6% band: 0" },
          { value: "0", label: "Would-have 6% halt", detail: "reference — halt OFF", tone: "info" },
          { value: "0.2%", label: "vs theo 5%/day", detail: "theo end ~" + usd(theo5), tone: "danger" },
        ] : [
          { value: "$0", label: "60d P&L", detail: "end $800" },
          { value: "0", label: "Trades", detail: "no signals fired", tone: "warning" },
          { value: "0", label: "Would-have 6% halt", detail: "reference — halt OFF" },
        ]} />
        {isRec && (
          <Grid columns={2}>
            <Rows>
              <Text weight="semibold">Equity</Text>
              <LineChart points={EQ} ceiling={850} floor={800} unit="$" labels={["Equity"]} />
            </Rows>
            <Rows>
              <Text weight="semibold">Daily P&L (trade days)</Text>
              <ColumnSeries labels={PNL_L} series={[{ name: "P&L", values: PNL_V }]} format={(v: number) => usd(v)} />
            </Rows>
          </Grid>
        )}
        <Callout tone="warning" lead="Is 5–6%/day achievable?">
          No. Recommended combo: 0 days ≥5% in this 60d window. End $827.52 vs theoretical ~{usd(theo5)} at +5% every day. Keep 5% as an aspiration meter on Positions — not a promise.
        </Callout>
        {isRec && (
          <>
            <Text>Monte Carlo (2000 paths, 4 trades): ruin 0% · p50 ~$827 · Bootstrap reshuffle; ruin = −50% equity.</Text>
            <Table headers={["Date IST", "Trades", "P&L $", "P&L % day-start", "Equity", "6% halt ref"]} rows={DAYS} />
          </>
        )}
      </Section>

      <Section title="5. Export & live defaults">
        <Text>CSV: /workspace/binance-equity-perp-60d-daily-pnl.csv (current + recommended daily rows).</Text>
        <Callout tone="info" lead="Bot defaults after this study">
          TradFi equity perps from exchangeInfo · liquidity skip · depth-capped notional · TF-scaled max hold ·
          LIMIT→MARKET 120s · compounding size · 5% target & 6% loss informational (halts OFF) ·
          DRY-RUN until BINANCE_LIVE + allowSignedOrders · UI /positions
        </Callout>
      </Section>
    </Page>
  );
}
