"""Replica of ChatGPT QuantSignal paper-engine.js on historical bars.
Entry: next bar after the signal candle (signal is fresh for 1.2 bars). Enters at the open if inside
max(0.5 ATR, 25% stop distance) of the signal close, otherwise when the bar trades back into that zone.
Stop = min(signal stop, entry - max(|entry-stop|, 3 ATR, 1.5%)); single target at targetR net of fees/slippage;
blocked if net RR < 2 or the target reaches the nearest opposing swing (barrier).
Exits: stop, target, opposite signal (only before the 70% partial), 70% reduce-only partial when |gross P&L| >= 10% of
initial margin (= 2% price move at 5x), runner keeps the same stop/target. Adverse events assumed first within a bar."""
import json, sys, numpy as np, pandas as pd

CFG = dict(equity=100_000, lev=5, riskPct=0.5, marginPct=10, maxPositions=10, feePct=0.05, slippagePct=0.02,
           minStopPct=1.5, targetR=2, partial=True)

def load(folder, sigfile, start=None, end=None):
    sig = json.load(open(sigfile)); data = {}
    for t, s in sig.items():
        d = pd.read_csv(f"{folder}/{t}.csv")
        d["date"] = pd.to_datetime(d["date"], utc=True).dt.tz_localize(None)
        d = d.reset_index(drop=True)
        sigs = {i: dict(side=sd, entry=e, stop=st, atr=a, barrier=b, score=sc) for i, sd, e, st, a, b, sc in s["sig"]}
        data[t] = dict(d=d, sig=sigs)
    return data

def run(data, portfolio=True, start=None, end=None, cfg=CFG):
    fee, slip, lev = cfg["feePct"] / 100, cfg["slippagePct"] / 100, cfg["lev"]
    cal = sorted(set().union(*[set(v["d"].date) for v in data.values()]))
    if start: cal = [x for x in cal if x >= pd.Timestamp(start)]
    if end: cal = [x for x in cal if x <= pd.Timestamp(end)]
    idx = {t: {dt: i for i, dt in enumerate(v["d"].date)} for t, v in data.items()}
    cash = cfg["equity"]; pos = {}; hist = []; curve = []; pending = {}; log = dict(signals=0, retest=0, noroom=0, full=0, opened=0)

    def close(p, px, reason, dt, qty=None, market=True):
        nonlocal cash
        q = p["qty"] if qty is None else qty
        exit_ = px * (1 - p["m"] * slip) if market else px
        gross = p["m"] * (exit_ - p["entry"]) * q; efee = exit_ * q * fee; afee = p["entryFee"] * q / p["qty"]
        cash += gross - efee
        p["legs"].append(dict(reason=reason, net=gross - afee - efee, qty=q, px=exit_))
        p["entryFeeLeft"] = p["entryFee"] - afee
        p["entryFee"] -= afee; p["margin"] *= (p["qty"] - q) / p["qty"]; p["qty"] -= q
        if p["qty"] <= 1e-12:
            hist.append(dict(ticker=p["t"], side="LONG" if p["m"] == 1 else "SHORT", entry_date=str(p["date"]), exit_date=str(dt),
                             entry=p["entry"], stop=p["stop"], target=p["target"], exits=" | ".join(l["reason"] for l in p["legs"]),
                             pnl=sum(l["net"] for l in p["legs"]), risk=p["risk0"], notional=p["entry"] * p["qty0"],
                             bars=p["bars"]))
            return True
        return False

    for dt in cal:
        unreal = sum(p["m"] * (data[t]["d"].close.iat[p["last"]] - p["entry"]) * p["qty"] for t, p in pos.items())
        equity = cash + unreal; used = sum(p["margin"] for p in pos.values())
        # --- 1) entries from signals of the previous bar (fresh for 1.2 bars)
        for t, s in sorted(pending.items(), key=lambda kv: -kv[1]["score"]):
            i = idx[t].get(dt)
            if i is None: continue
            pending.pop(t)
            if t in pos: continue
            if portfolio and len(pos) >= cfg["maxPositions"]: log["full"] += 1; continue
            d = data[t]["d"]; o, h, l = d.open.iat[i], d.high.iat[i], d.low.iat[i]
            tol = max(0.5 * s["atr"], 0.25 * abs(s["entry"] - s["stop"]))
            lo_, hi_ = s["entry"] - tol, s["entry"] + tol
            if lo_ <= o <= hi_: q = o
            elif o > hi_ and l <= hi_: q = hi_
            elif o < lo_ and h >= lo_: q = lo_
            else: log["retest"] += 1; continue
            m = s["side"]; entry = q * (1 + m * slip)
            dist = max(abs(entry - s["stop"]), 3 * s["atr"], entry * cfg["minStopPct"] / 100)
            stop = min(s["stop"], entry - dist) if m == 1 else max(s["stop"], entry + dist)
            stopFill = stop * (1 - m * slip); rpu = abs(entry - stopFill) + (entry + stopFill) * fee; R = cfg["targetR"]
            target = (entry * (1 + fee) + R * rpu) / ((1 - slip) * (1 - fee)) if m == 1 else (entry * (1 - fee) - R * rpu) / ((1 + slip) * (1 + fee))
            netReward = m * (target * (1 - m * slip) - entry) - (entry + target * (1 - m * slip)) * fee
            if netReward / rpu < 2 - 1e-9 or (s["barrier"] is not None and m * (target - s["barrier"]) >= 0) or (m == 1 and stop <= 0):
                log["noroom"] += 1; continue
            if portfolio:
                free = equity - used; cpu = entry / lev + entry * fee + abs(entry - q)
                qty = min(equity * cfg["riskPct"] / 100 / rpu, equity * cfg["marginPct"] / 100 / cpu, free / cpu)
            else:
                qty = 10_000 / entry
            if not qty > 0: continue
            ef = entry * qty * fee; cash -= ef
            pos[t] = dict(t=t, m=m, entry=entry, stop=stop, target=target, qty=qty, qty0=qty, entryFee=ef, margin=entry * qty / lev,
                          im=entry * qty / lev, partial=False, legs=[dict(reason="entry fee", net=0, qty=0, px=entry)][:0], date=dt,
                          risk0=rpu * qty, last=i, bars=0, first=True)
            used += entry * qty / lev; log["opened"] += 1
        # --- 2) manage open positions on this bar
        for t in list(pos):
            p = pos[t]; d = data[t]["d"]; i = idx[t].get(dt)
            if i is None: continue
            o, h, l, c = d.open.iat[i], d.high.iat[i], d.low.iat[i], d.close.iat[i]; m = p["m"]; p["last"] = i; p["bars"] += 1
            adv, fav = (l, h) if m == 1 else (h, l)
            worse = (lambda a, b: a <= b) if m == 1 else (lambda a, b: a >= b)
            trig = p["entry"] * (1 + m * 0.1 / lev); trig_dn = p["entry"] * (1 - m * 0.1 / lev)
            done = False
            path = [o] if not p["first"] else []
            p["first"] = False
            # gap at open
            if path:
                if worse(o, p["stop"]): done = close(p, o, "STOP LOSS (gap)", dt)
                elif not worse(o, p["target"]) and o != p["target"] and (o >= p["target"] if m == 1 else o <= p["target"]): done = close(p, o, "TAKE PROFIT (gap)", dt)
            if not done and cfg["partial"] and not p["partial"] and worse(adv, trig_dn) and not worse(trig_dn, p["stop"]):
                close(p, trig_dn, "70% partial · LOSS", dt, qty=0.7 * p["qty0"]); p["partial"] = True
            if not done and worse(adv, p["stop"]): done = close(p, p["stop"], "STOP LOSS", dt)
            if not done and cfg["partial"] and not p["partial"] and (fav >= trig if m == 1 else fav <= trig) and m * (p["target"] - trig) > 0:
                close(p, trig, "70% partial · PROFIT", dt, qty=0.7 * p["qty0"], market=False); p["partial"] = True
            if not done and (fav >= p["target"] if m == 1 else fav <= p["target"]): done = close(p, p["target"], "TAKE PROFIT", dt)
            if not done:
                s = data[t]["sig"].get(i)
                if s and s["side"] != m and not p["partial"]: done = close(p, c, "OPPOSITE SIGNAL", dt)
            if done: del pos[t]
        # --- 3) new signals on this closed bar
        for t, v in data.items():
            i = idx[t].get(dt)
            if i is None: continue
            s = v["sig"].get(i)
            if s and t not in pos: pending[t] = s; log["signals"] += 1
        unreal = sum(p["m"] * (data[t]["d"].close.iat[p["last"]] - p["entry"]) * p["qty"] for t, p in pos.items())
        curve.append((dt, cash + unreal))
    for t, p in list(pos.items()):
        d = data[t]["d"]; close(p, d.close.iat[p["last"]], "END OF TEST", d.date.iat[p["last"]])
    tr = pd.DataFrame(hist)
    if len(tr): tr["r"] = tr.pnl / tr.risk
    return tr, pd.DataFrame(curve, columns=["date", "equity"]).set_index("date"), log

def stats(tr, curve=None):
    if not len(tr): return dict(trades=0)
    w, l = tr[tr.pnl > 0], tr[tr.pnl <= 0]
    s = dict(trades=len(tr), win_rate=len(w) / len(tr), profit_factor=w.pnl.sum() / max(1e-9, -l.pnl.sum()), avg_r=tr.r.mean(),
             net_pnl=tr.pnl.sum(), avg_win=w.pnl.mean() if len(w) else 0, avg_loss=l.pnl.mean() if len(l) else 0,
             avg_bars=tr.bars.mean(), longs=int((tr.side == "LONG").sum()), shorts=int((tr.side == "SHORT").sum()),
             tp_rate=tr.exits.str.contains("TAKE PROFIT").mean(), sl_rate=tr.exits.str.contains("STOP LOSS").mean(),
             partial_rate=tr.exits.str.contains("70%").mean())
    if curve is not None and len(curve):
        e = curve.equity
        s.update(final_equity=e.iat[-1], total_return=e.iat[-1] / CFG["equity"] - 1, max_dd=(e / e.cummax() - 1).min())
    return s

def accuracy(data, start=None, end=None, H=(1, 3, 5, 10, 20)):
    rows = []
    for t, v in data.items():
        d = v["d"]
        for i, s in v["sig"].items():
            dt = d.date.iat[i]
            if (start and dt < pd.Timestamp(start)) or (end and dt > pd.Timestamp(end)): continue
            r = dict(side=s["side"])
            for h in H:
                if i + h < len(d): r[h] = s["side"] * (d.close.iat[i + h] / d.close.iat[i] - 1)
            rows.append(r)
    a = pd.DataFrame(rows)
    return dict(n=len(a), **{f"hit{h}": float((a[h].dropna() > 0).mean()) for h in H if h in a}, **{f"long{h}": float((a[a.side == 1][h].dropna() > 0).mean()) for h in H if h in a},
                **{f"short{h}": float((a[a.side == -1][h].dropna() > 0).mean()) for h in H if h in a}, **{f"avg{h}": float(a[h].dropna().mean()) for h in H if h in a})

if __name__ == "__main__":
    folder, sigf, label = sys.argv[1:4]; start = sys.argv[4] if len(sys.argv) > 4 else None; end = sys.argv[5] if len(sys.argv) > 5 else None
    data = load(folder, sigf)
    out = dict(label=label, tickers=len(data), accuracy=accuracy(data, start, end), runs={})
    for pf in (True, False):
        for R in (2, 3, 4):
            for partial in (True, False):
                CFG["targetR"] = R; CFG["partial"] = partial
                tr, cv, log = run(data, portfolio=pf, start=start, end=end)
                key = f"{'portfolio' if pf else 'each'}_{R}R_{'partial' if partial else 'nopartial'}"
                out["runs"][key] = dict(stats=stats(tr, cv if pf else None), log=log)
                if pf and R == 2 and partial:
                    tr.to_csv(f"out/exact_{label}_trades.csv", index=False)
                    out["curve"] = [[str(i.date()), round(v, 2)] for i, v in cv.equity.resample("W").last().dropna().items()]
    CFG["targetR"] = 2; CFG["partial"] = True
    json.dump(out, open(f"out/exact_{label}.json", "w"), default=float, indent=1)
    a = out["accuracy"]; s = out["runs"]["portfolio_2R_partial"]["stats"]; e = out["runs"]["each_2R_partial"]["stats"]
    print(f"{label:4s} acc1 {a['hit1']:.3f} acc5 {a.get('hit5', float('nan')):.3f} n={a['n']} | each: {e['trades']} trades win {e['win_rate']:.3f} PF {e['profit_factor']:.2f} | "
          f"paper: {s['trades']} win {s['win_rate']:.3f} PF {s['profit_factor']:.2f} ret {s.get('total_return', 0):+.3f} dd {s.get('max_dd', 0):.3f} | partial {s['partial_rate']:.2f} tp {s['tp_rate']:.2f} sl {s['sl_rate']:.2f}")
