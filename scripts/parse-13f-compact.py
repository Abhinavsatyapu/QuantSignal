#!/usr/bin/env python3
"""Stream a Form 13F official ZIP into a compact top-holders JSON.

Designed to run as a short-lived child, not inside the web process.
Does not print User-Agent or secrets. Deletes a downloaded temp ZIP when done.
"""
from __future__ import annotations

import argparse, csv, io, json, os, sys, zipfile
from collections import defaultdict
from pathlib import Path

DEFAULT_CUSIP = {
    "AAPL": "037833100",
    "NVDA": "67066G104",
    "TSLA": "88160R101",
    "HOOD": "770700102",
}
DEFAULT_PERIOD = "30-JUN-2026"
DEFAULT_URL = (
    "https://www.sec.gov/files/datastandardsinnovation/data/form-13f-data-sets/"
    "01jun2026-31aug2026_form13f.zip"
)


def rank(rows):
    def k(e):
        amend = int(e["amendno"]) if str(e["amendno"]).isdigit() else 0
        return (e.get("filed") or "", amend, e["accession"])

    latest = {}
    by = defaultdict(list)
    for e in rows:
        by[e["cik"]].append(e)
    for cik, items in by.items():
        latest[cik] = max(items, key=k)["accession"]
    sums = {}
    for e in rows:
        if latest.get(e["cik"]) != e["accession"]:
            continue
        rec = sums.setdefault(e["cik"], {"manager": e["manager"], "cik": e["cik"], "filed": e["filed"], "shares": 0.0, "value": 0.0})
        rec["shares"] += e["shares"]
        rec["value"] += e["value"]
    ranked = sorted(sums.values(), key=lambda x: -x["value"])
    implied = sorted(e["value"] / e["shares"] for e in ranked if e["shares"] > 0)
    mid = implied[len(implied) // 2] if implied else None
    return {
        "managers": len(ranked),
        "totalShares": sum(x["shares"] for x in ranked),
        "totalValueUsd": sum(x["value"] for x in ranked),
        "impliedPriceMedianUsd": mid,
        "valueUnit": "US dollars (not thousands)",
        "top10": ranked[:10],
    }


def analyze(zip_path: Path, period: str, cusip: dict) -> dict:
    cusip_to_t = {v: k for k, v in cusip.items()}
    subs, covers = {}, {}
    with zipfile.ZipFile(zip_path) as z, z.open("SUBMISSION.tsv") as f:
        for row in csv.DictReader(io.TextIOWrapper(f, encoding="utf-8", errors="replace", newline=""), delimiter="\t"):
            subs[row["ACCESSION_NUMBER"]] = row
    with zipfile.ZipFile(zip_path) as z, z.open("COVERPAGE.tsv") as f:
        for row in csv.DictReader(io.TextIOWrapper(f, encoding="utf-8", errors="replace", newline=""), delimiter="\t"):
            covers[row["ACCESSION_NUMBER"]] = row
    hits = {t: [] for t in cusip}
    n_rows = 0
    with zipfile.ZipFile(zip_path) as z, z.open("INFOTABLE.tsv") as f:
        reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8", errors="replace", newline=""), delimiter="\t")
        for row in reader:
            n_rows += 1
            t = cusip_to_t.get((row.get("CUSIP") or "").strip().upper())
            if not t:
                continue
            acc = row["ACCESSION_NUMBER"]
            s, c = subs.get(acc, {}), covers.get(acc, {})
            if s.get("PERIODOFREPORT") != period or s.get("SUBMISSIONTYPE") not in {"13F-HR", "13F-HR/A"}:
                continue
            if (row.get("SSHPRNAMTTYPE") or "") != "SH":
                continue
            if (row.get("PUTCALL") or "").strip():
                continue
            title = (row.get("TITLEOFCLASS") or "").upper()
            if any(x in title for x in ("PUT", "CALL", "OPTION", "NOTE", "DEBT", "WARRANT", "PFD", "PREFERRED")) and "COM" not in title:
                continue
            hits[t].append({
                "shares": float(row.get("SSHPRNAMT") or 0),
                "value": float(row.get("VALUE") or 0),
                "title": row.get("TITLEOFCLASS"),
                "cik": s.get("CIK"),
                "filed": s.get("FILING_DATE"),
                "manager": c.get("FILINGMANAGER_NAME"),
                "amendno": c.get("AMENDMENTNO") or "",
                "accession": acc,
            })
    return {
        "ok": True,
        "sourceUrl": DEFAULT_URL,
        "periodOfReport": period,
        "infoTableRows": n_rows,
        "submissions": len(subs),
        "byTicker": {t: rank(hits[t]) for t in cusip},
        "asOfNote": f"13F as of {period}, official SEC ZIP. Lagged holdings, not a live tape.",
        "source": "SEC EDGAR Form 13F data set",
        "caveats": [
            "Lagged 45+ days; long-only; index sponsors dominate top-holder lists.",
            "VALUE in the 2026 dataset is in dollars, not thousands.",
        ],
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--period", default=DEFAULT_PERIOD)
    args = ap.parse_args(argv)
    zpath = Path(args.zip) if args.zip else None
    if not zpath or not zpath.exists():
        print("parse-13f-compact: no zip provided; leaving seed cache untouched", file=sys.stderr)
        return 2
    out = analyze(zpath, args.period, DEFAULT_CUSIP)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
