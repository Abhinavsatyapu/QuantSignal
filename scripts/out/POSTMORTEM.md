# Losing-trade post-mortem

Universe 62 · generated 2026-11-09T20:28:40.422Z

## Setup A: Setup A · 4h liq_buy_side

Losses classified: 45 · OOS WR 23% PF 0.58 net -8.34%

| Cause | Count | % losses | $ lost |
|---|---:|---:|---:|
| correlated_cluster | 35 | 77.8% | -598.77 |
| illiquid_session | 20 | 44.4% | -347.32 |
| noise_stop_out | 17 | 37.8% | -285.34 |
| unclassified_stop_or_thesis | 14 | 31.1% | -241.91 |
| against_htf_trend | 3 | 6.7% | -53.38 |
| weekend_risk_window | 2 | 4.4% | -34.36 |
| late_entry_extended | 1 | 2.2% | -19.12 |
| gap_or_slippage_like | 1 | 2.2% | -16.69 |

## Setup B: Setup B · 1h AND window 3

Losses classified: 11 · OOS WR 46% PF 3.22 net 11.07%

| Cause | Count | % losses | $ lost |
|---|---:|---:|---:|
| illiquid_session | 3 | 27.3% | -56.75 |
| gap_or_slippage_like | 3 | 27.3% | -52.79 |
| noise_stop_out | 2 | 18.2% | -35.81 |
| against_htf_trend | 3 | 27.3% | -20.36 |
| weekend_risk_window | 2 | 18.2% | -17.82 |
| correlated_cluster | 4 | 36.4% | -12.98 |
| unclassified_stop_or_thesis | 3 | 27.3% | -10.44 |
| late_entry_extended | 1 | 9.1% | -7.8 |

## Fix tests (adopt = OOS WR↑ AND PF↑, trades not collapsed)

### Setup A
- **us_cash_only** ADOPT (low N): OOS N=9 WR=33% PF=0.94 net=-0.76% (ΔWR 10.2pp ΔPF 0.36)
- **htf_align** reject (low N): OOS N=13 WR=23% PF=0.58 net=-8.34% (ΔWR 0pp ΔPF 0)
- **wider_stop_2atr** ADOPT (low N): OOS N=12 WR=25% PF=0.68 net=-5.52% (ΔWR 1.9pp ΔPF 0.1)
- **max_stop_2_5atr** ADOPT (low N): OOS N=13 WR=31% PF=0.85 net=-2.85% (ΔWR 7.7pp ΔPF 0.27)
- **fresh_level** reject (low N): OOS N=13 WR=23% PF=0.58 net=-8.34% (ΔWR 0pp ΔPF 0)
- **cash_htf** ADOPT (low N): OOS N=9 WR=33% PF=0.94 net=-0.76% (ΔWR 10.2pp ΔPF 0.36)
- **cash_htf_fresh** ADOPT (low N): OOS N=9 WR=33% PF=0.94 net=-0.76% (ΔWR 10.2pp ΔPF 0.36)
- **cash_htf_maxext** ADOPT (low N): OOS N=9 WR=33% PF=0.94 net=-0.68% (ΔWR 10.2pp ΔPF 0.36)

### Setup B
- **us_cash_only** ADOPT (low N): OOS N=11 WR=55% PF=3.3 net=9.36% (ΔWR 9pp ΔPF 0.08)
- **htf_align** reject (low N): OOS N=11 WR=46% PF=3.22 net=11.07% (ΔWR 0pp ΔPF 0)
- **wider_stop_2atr** reject (low N): OOS N=24 WR=42% PF=1.04 net=1.27% (ΔWR -3.8pp ΔPF -2.18)
- **max_stop_2_5atr** reject (low N): OOS N=2 WR=100% PF=999 net=8.04% (ΔWR 54.5pp ΔPF 995.78)
- **fresh_level** reject (low N): OOS N=11 WR=46% PF=3.22 net=11.07% (ΔWR 0pp ΔPF 0)
- **cash_htf** ADOPT (low N): OOS N=11 WR=55% PF=3.3 net=9.36% (ΔWR 9pp ΔPF 0.08)
- **cash_htf_fresh** ADOPT (low N): OOS N=11 WR=55% PF=3.3 net=9.36% (ΔWR 9pp ΔPF 0.08)
- **cash_htf_maxext** reject (low N): OOS N=1 WR=100% PF=999 net=3.95% (ΔWR 54.5pp ΔPF 995.78)

## Recommended
{
  "id": "B_us_cash_only",
  "setup": "B",
  "oos": {
    "trades": 11,
    "wins": 6,
    "losses": 5,
    "winRate": 0.545,
    "profitFactor": 3.3,
    "totalPnlPct": 9.36,
    "endEquity": 874.89,
    "maxDdPct": 2.08,
    "avgDailyPctAllDays": 0.5369,
    "geoAvgDailyPct": 0.467,
    "meanDailyPctTradeDays": 1.6106,
    "tradeDays": 6,
    "calendarDays": 18,
    "lowSample": true
  },
  "sixty": {
    "trades": 29,
    "wins": 21,
    "losses": 8,
    "winRate": 0.724,
    "profitFactor": 4.91,
    "totalPnlPct": 36.3,
    "endEquity": 1090.39,
    "maxDdPct": 2.15,
    "avgDailyPctAllDays": 0.7428,
    "geoAvgDailyPct": 0.7096,
    "meanDailyPctTradeDays": 1.8787,
    "tradeDays": 17,
    "calendarDays": 43,
    "lowSample": true
  },
  "fix": {
    "fix": "us_cash_only",
    "desc": "Trade only during US cash session (≈14:30–21:00 UTC)",
    "oos": {
      "trades": 11,
      "wins": 6,
      "losses": 5,
      "winRate": 0.545,
      "profitFactor": 3.3,
      "totalPnlPct": 9.36,
      "endEquity": 874.89,
      "maxDdPct": 2.08,
      "avgDailyPctAllDays": 0.5369,
      "geoAvgDailyPct": 0.467,
      "meanDailyPctTradeDays": 1.6106,
      "tradeDays": 6,
      "calendarDays": 18,
      "lowSample": true
    },
    "sixty": {
      "trades": 29,
      "wins": 21,
      "losses": 8,
      "winRate": 0.724,
      "profitFactor": 4.91,
      "totalPnlPct": 36.3,
      "endEquity": 1090.39,
      "maxDdPct": 2.15,
      "avgDailyPctAllDays": 0.7428,
      "geoAvgDailyPct": 0.7096,
      "meanDailyPctTradeDays": 1.8787,
      "tradeDays": 17,
      "calendarDays": 43,
      "lowSample": true
    },
    "train": {
      "trades": 12,
      "wins": 10,
      "losses": 2,
      "winRate": 0.833,
      "profitFactor": 8.76,
      "totalPnlPct": 14.64,
      "endEquity": 917.1,
      "maxDdPct": 0,
      "avgDailyPctAllDays": 0.5325,
      "geoAvgDailyPct": 0.4346,
      "meanDailyPctTradeDays": 1.978,
      "tradeDays": 7,
      "calendarDays": 26,
      "lowSample": true
    },
    "vsBaseline": {
      "dWR": 9,
      "dPF": 0.08,
      "dNet": -1.71,
      "tradeRatio": 1
    },
    "adopt": true,
    "lowN": true
  }
}