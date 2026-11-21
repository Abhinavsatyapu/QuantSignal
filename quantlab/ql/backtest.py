"""Event-driven daily backtester.

Timing (no look-ahead): target weights decided at the CLOSE of day t are
executed at the OPEN of day t+1. Positions are then marked at each close.
Weights only trade when the target changes (entries, exits, flips), so held
positions drift with prices instead of being rebalanced every day.

Costs per trade, in basis points of traded notional:
  fee_bps        commission / exchange fees
  spread_bps     full quoted bid-ask spread (half is paid on each fill)
  slippage_bps   market impact beyond the quoted spread
Shorts pay borrow_bps per year on short notional, charged daily."""
from __future__ import annotations

from dataclasses import dataclass, asdict
import numpy as np
import pandas as pd


@dataclass
class Costs:
    fee_bps: float = 0.5
    spread_bps: float = 4.0
    slippage_bps: float = 2.0
    borrow_bps: float = 50.0

    def as_dict(self):
        return asdict(self)


@dataclass
class Result:
    equity: pd.Series
    daily: pd.Series
    gross_exposure: pd.Series
    net_exposure: pd.Series
    turnover: pd.Series
    costs: pd.Series
    trades: list[dict]
    leg_pnl: pd.DataFrame
    positions: pd.DataFrame
    halted: str | None = None


def run(weights: pd.DataFrame, opens: pd.DataFrame, closes: pd.DataFrame, units: list[list[str]],
        capital: float = 100_000.0, costs: Costs | None = None, reasons: pd.DataFrame | None = None,
        max_drawdown: float | None = None) -> Result:
    """max_drawdown: once equity falls this far below its peak, NEW positions are
    blocked for the rest of the run (exits still execute). The breach date is
    reported in Result.halted."""
    costs = costs or Costs()
    syms = list(weights.columns)
    idx = weights.index
    O = opens.reindex(idx)[syms].to_numpy(float)
    C = closes.reindex(idx)[syms].to_numpy(float)
    W = weights.fillna(0.0).to_numpy(float)
    n, m = W.shape
    half = (costs.spread_bps / 2 + costs.slippage_bps) / 1e4
    fee = costs.fee_bps / 1e4
    borrow_d = costs.borrow_bps / 1e4 / 252

    sh = np.zeros(m); cash = capital
    eq = np.full(n, np.nan); gross = np.zeros(n); net = np.zeros(n); turn = np.zeros(n); cst = np.zeros(n)
    legp = np.zeros((n, m)); pos = np.zeros((n, m))
    cum_leg = np.zeros(m)
    eq_prev = capital
    peak = capital; halted = None
    sym_i = {s: i for i, s in enumerate(syms)}
    unit_idx = [[sym_i[s] for s in u] for u in units]
    open_tr: dict[int, dict] = {}
    trades: list[dict] = []
    reason_arr = reasons.reindex(idx).to_numpy(object) if reasons is not None else None

    for t in range(n):
        traded = np.zeros(m); fills = np.full(m, np.nan)
        if t > 0 and not np.array_equal(W[t - 1], W[t - 2] if t > 1 else np.zeros(m)):
            target = W[t - 1]
            prevw = W[t - 2] if t > 1 else np.zeros(m)
            for j in range(m):
                if target[j] == prevw[j]:
                    continue          # only legs whose target changed are traded
                px = O[t, j]
                if not np.isfinite(px) or px <= 0:
                    continue
                want = target[j] * eq_prev / px if target[j] != 0 else 0.0
                if halted is not None and sh[j] == 0 and want != 0:
                    continue          # risk-limit breach: no new entries
                d = want - sh[j]
                if abs(d) < 1e-9:
                    continue
                fp = px * (1 + half) if d > 0 else px * (1 - half)
                f = abs(d) * fp * fee
                cash -= d * fp + f
                c_cost = abs(d) * px * half + f
                cst[t] += c_cost
                turn[t] += abs(d) * px
                traded[j] = d; fills[j] = fp
                # leg P&L on the traded shares from fill to close, minus fee
                cum_leg[j] -= f
                sh[j] = want
        # borrow on shorts at today's close notional
        short_notional = sum(-sh[j] * C[t, j] for j in range(m) if sh[j] < 0 and np.isfinite(C[t, j]))
        bc = short_notional * borrow_d
        cash -= bc; cst[t] += bc
        # mark to market
        val = 0.0
        for j in range(m):
            if np.isfinite(C[t, j]):
                val += sh[j] * C[t, j]
        e = cash + val
        eq[t] = e
        # per-leg P&L = change in that leg's (cash flow + market value)
        for j in range(m):
            if not np.isfinite(C[t, j]):
                continue
            prev_c = C[t - 1, j] if t > 0 and np.isfinite(C[t - 1, j]) else C[t, j]
            held_prior = sh[j] - traded[j]
            pnl = held_prior * (C[t, j] - prev_c)
            if traded[j] != 0:
                pnl += traded[j] * (C[t, j] - fills[j])
            if sh[j] < 0:
                pnl -= -sh[j] * C[t, j] * borrow_d
            cum_leg[j] += pnl
        legp[t] = cum_leg
        pos[t] = sh
        gross[t] = sum(abs(sh[j] * C[t, j]) for j in range(m) if np.isfinite(C[t, j])) / e if e else 0
        net[t] = val / e if e else 0
        turn[t] = turn[t] / eq_prev if eq_prev else 0

        # trade episodes per unit
        for ui, legs in enumerate(unit_idx):
            active = any(sh[j] != 0 for j in legs)
            was = ui in open_tr
            changed = any(traded[j] != 0 for j in legs)
            if was and (not active or (changed and _flipped(open_tr[ui], sh, legs))):
                tr = open_tr.pop(ui)
                _close(tr, t, idx, cum_leg, legs, syms, reason_arr, ui, trades)
            if active and ui not in open_tr:
                open_tr[ui] = {"unit": ui, "symbols": [syms[j] for j in legs], "entry_i": t, "entry": str(idx[t].date()),
                               "side": [int(np.sign(sh[j])) for j in legs],
                               "notional": sum(abs(sh[j] * O[t, j]) for j in legs if np.isfinite(O[t, j])),
                               "start_leg": [cum_leg[j] for j in legs]}
        eq_prev = e
        peak = max(peak, e)
        if max_drawdown and halted is None and e < peak * (1 - max_drawdown):
            halted = str(idx[t].date())

    for ui, tr in list(open_tr.items()):
        legs = unit_idx[ui]
        _close(tr, n - 1, idx, cum_leg, legs, syms, reason_arr, ui, trades, still_open=True)

    eqs = pd.Series(eq, idx)
    return Result(eqs, eqs.pct_change().fillna(eqs.iloc[0] / capital - 1), pd.Series(gross, idx), pd.Series(net, idx),
                  pd.Series(turn, idx), pd.Series(cst, idx), trades, pd.DataFrame(legp, idx, syms), pd.DataFrame(pos, idx, syms), halted)


def _flipped(tr, sh, legs):
    return [int(np.sign(sh[j])) for j in legs] != tr["side"]


def _close(tr, t, idx, cum_leg, legs, syms, reason_arr, ui, trades, still_open=False):
    leg = {syms[j]: round(float(cum_leg[j] - s0), 2) for j, s0 in zip(legs, tr["start_leg"])}
    pnl = float(sum(leg.values()))
    why = ""
    if reason_arr is not None and t - 1 >= 0:
        col = ui if reason_arr.shape[1] > ui else 0
        why = reason_arr[t - 1, col] or ""
    trades.append({"symbols": tr["symbols"], "side": tr["side"], "entry": tr["entry"],
                   "exit": None if still_open else str(idx[t].date()),
                   "days": int(t - tr["entry_i"]), "pnl": round(pnl, 2), "leg_pnl": leg,
                   "ret": float(pnl / tr["notional"]) if tr["notional"] else 0.0,
                   "notional": round(float(tr["notional"]), 2), "exit_reason": "open" if still_open else (why if why in ("exit", "stop", "time") else "signal"),
                   "open": still_open})
