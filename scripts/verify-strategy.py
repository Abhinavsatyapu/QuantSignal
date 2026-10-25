#!/usr/bin/env python3
"""Independent re-computation of a saved Strategy Builder run (no shared code with the JS engine).
Usage: python3 scripts/verify-strategy.py http://localhost:8799 RUN_ID [RUN_ID ...]"""
import json, sys, urllib.request
base = sys.argv[1]
ok_all = True
for rid in sys.argv[2:]:
    run = json.load(urllib.request.urlopen(f"{base}/api/strategy/history/{rid}"))
    res, cfg = run['result'], run['inputs']['cfg']
    b = res.get('best')
    if not b: print(rid, run['status'], 'no recommendation'); continue
    legs, fut = run['legs']['legs'], run['legs']['futures']
    basis, comm, fee, mm = res['basis'], cfg.get('commission', 0.65), cfg.get('futureFeePct', 0.045), cfg.get('mmLoss', 50)
    q, E = fut['signedQty'], fut['entry']
    def pnl(S):
        opt = sum((1 if l['side'] == 'buy' else -1) * l['qty'] * 100 * (max(S - l['strike'], 0) if l['type'] == 'call' else max(l['strike'] - S, 0)) for l in legs)
        cash = sum(-(1 if l['side'] == 'buy' else -1) * l['qty'] * 100 * l['premium'] for l in legs)
        F = max(0.0, S + basis)
        return opt + cash - comm * sum(l['qty'] for l in legs) + q * (F - E) - abs(q) * E * fee / 100 - abs(q) * F * fee / 100 - mm
    up, dn = b['scenarioPrices']['up'], b['scenarioPrices']['down']
    checks = [('expiry up', pnl(up), b['expected']['upExpiry']), ('expiry down', pnl(dn), b['expected']['downExpiry'])]
    checks += [('breakeven %.2f' % x, pnl(x) + mm, 0.0) for x in b['breakevens']]
    cash = sum(-(1 if l['side'] == 'buy' else -1) * l['qty'] * 100 * l['premium'] for l in legs)
    checks.append(('net credit/debit', cash, b['netCreditDebit']))
    print(f"run {rid} {run['ticker']} {run['expiry']}: perp {fut['symbol']} {q:+} @ {E}")
    for S in [dn - 10, dn, (up + dn) / 2, up, up + 10]: print(f"   P&L at expiry S={S:8.2f}: {pnl(S):10.2f}")
    for name, mine, theirs in checks:
        good = abs(mine - theirs) < 0.05
        ok_all &= good
        print(f"   {'OK ' if good else 'BAD'} {name:18} independent={mine:12.4f} engine={theirs:12.4f}")
print('ALL MATCH' if ok_all else 'MISMATCH'); sys.exit(0 if ok_all else 1)
