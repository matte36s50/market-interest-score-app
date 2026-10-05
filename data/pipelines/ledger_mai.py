#!/usr/bin/env python3
"""
Manufacturer Apex Index over the weekly ledger dataset.

Reads data/ledger/ledger_results.csv (written by ledger_ingest.py) and writes
data/ledger/mai_ledger.json for the Apex Ledger tab.

What is implemented:

  * Status filter. Default includes CONFIRMED and REPORTED and excludes
    UNVERIFIED; the excluded count is written next to every figure.
  * Apex classification, using the one rule given for this dataset:
        apex          high_estimate_usd >= 500,000
        non_apex      high_estimate_usd <  500,000
        apex_unknown  high_estimate_usd blank — unclassifiable, never non-apex
  * Coverage counts per manufacturer and per event, segmented by
    premium_included (all / yes / no / unknown), so hammer-only and
    premium-inclusive figures are never blended without it being visible.

What is NOT implemented: the MAI formula itself. See compute_mai() below —
it is a deliberate stub pending a decision from the index owner, and every
MAI figure is written as null with mai_status "pending_formula" until then.

Run:
    python data/pipelines/ledger_mai.py
    python data/pipelines/ledger_mai.py --status CONFIRMED          # stricter
    python data/pipelines/ledger_mai.py --status CONFIRMED,REPORTED,UNVERIFIED
"""

import argparse
import csv
import json
import os
import sys
from collections import Counter, defaultdict
from decimal import Decimal

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
DEFAULT_DATASET = os.path.join(ROOT, "ledger", "ledger_results.csv")
DEFAULT_OUTPUT = os.path.join(ROOT, "ledger", "mai_ledger.json")

APEX_THRESHOLD_USD = Decimal("500000")
DEFAULT_STATUSES = ("CONFIRMED", "REPORTED")
ALL_STATUSES = ("CONFIRMED", "REPORTED", "UNVERIFIED")
SEGMENTS = {
    "all": lambda r: True,
    "premium_yes": lambda r: r["premium_included"] == "yes",
    "premium_no": lambda r: r["premium_included"] == "no",
    "premium_unknown": lambda r: r["premium_included"] == "unknown",
}
RESULT_STATES = ("sold_with_price", "sold_without_price", "not_sold", "withdrawn")


def apex_class(row):
    """'apex', 'non_apex' or 'apex_unknown'. A blank high_estimate_usd is
    unknown — it is never read as 0 and never as non-apex."""
    raw = row["high_estimate_usd"]
    if raw == "":
        return "apex_unknown"
    return "apex" if Decimal(raw) >= APEX_THRESHOLD_USD else "non_apex"


# ════════════════════════════════════════════════════════════════════════════
#  MAI FORMULA — STUB, PENDING A DECISION.  Nothing else in this module scores.
# ════════════════════════════════════════════════════════════════════════════

class MaiFormulaPending(NotImplementedError):
    pass


PENDING_REASON = (
    "The repo's existing MAI (data/pipelines/mai.py + auction_rating.py) cannot be applied to the "
    "ledger data as written without imputing or inventing: it defines apex on the LOW estimate, counts "
    "an unknown Q as 0, fills missing prices and estimates with 0, and weights events by an auction "
    "rating whose apex concentration term divides by the event's total lot count, which a curated "
    "weekly ledger does not contain. The formula for this dataset needs the index owner's decision."
)


def compute_mai(apex_rows, segment_rows):
    """>>> THE MAI FORMULA GOES HERE. <<<

    Inputs, already filtered by status and premium segment:
      apex_rows     rows classified 'apex' (high_estimate_usd >= 500,000), each
                    with manufacturer = make, event, event_date, result_state
                    (sold_with_price / sold_without_price / not_sold /
                    withdrawn), price_usd, high_estimate_usd as recorded.
      segment_rows  every row in the segment, including non_apex and
                    apex_unknown, for any per-event denominator.

    Must return {manufacturer: mai_score or None}. None means "cannot be
    computed from what is known" and must be shown as such, never as 0.
    """
    raise MaiFormulaPending(PENDING_REASON)

# ════════════════════════════════════════════════════════════════════════════


def coverage(rows):
    c = Counter(apex_class(r) for r in rows)
    out = {"lots": len(rows), "apex": c["apex"], "non_apex": c["non_apex"], "apex_unknown": c["apex_unknown"]}
    apex_states = Counter(r["result_state"] for r in rows if apex_class(r) == "apex")
    out["apex_by_result"] = {s: apex_states[s] for s in RESULT_STATES}
    return out


def group_coverage(rows, key):
    groups = defaultdict(list)
    for r in rows:
        groups[key(r)].append(r)
    return groups


def build(rows, statuses=DEFAULT_STATUSES):
    statuses = tuple(statuses)
    included = [r for r in rows if r["status"] in statuses]
    excluded = Counter(r["status"] for r in rows if r["status"] not in statuses)

    segments = {}
    mai_status, mai_note = "computed", None
    for name, keep in SEGMENTS.items():
        seg = [r for r in included if keep(r)]
        try:
            scores = compute_mai([r for r in seg if apex_class(r) == "apex"], seg)
        except MaiFormulaPending as e:
            scores, mai_status, mai_note = {}, "pending_formula", str(e)

        makers = []
        for make, mrows in sorted(group_coverage(seg, lambda r: r["make"]).items()):
            makers.append(dict(
                {"manufacturer": make, "mai": scores.get(make),
                 "events": len({(r["event"], r["event_date"]) for r in mrows})},
                **coverage(mrows)))
        makers.sort(key=lambda m: (-m["apex"], -m["apex_unknown"], m["manufacturer"]))

        events = []
        for (event, event_date, house), erows in group_coverage(
                seg, lambda r: (r["event"], r["event_date"], r["auction_house"])).items():
            events.append(dict({"event": event, "event_date": event_date, "auction_house": house}, **coverage(erows)))
        events.sort(key=lambda e: (e["event_date"], e["event"]), reverse=True)

        segments[name] = {"totals": coverage(seg), "manufacturers": makers, "events": events}

    return {
        "as_of": max((r["ledger_date"] for r in rows), default=None),
        "apex_rule": f"high_estimate_usd >= {int(APEX_THRESHOLD_USD)}",
        "status_filter": {
            "included": list(statuses),
            "excluded": sorted(set(ALL_STATUSES) - set(statuses)),
            "rows_in_dataset": len(rows),
            "rows_included": len(included),
            "rows_excluded": sum(excluded.values()),
            "rows_excluded_by_status": dict(sorted(excluded.items())),
        },
        "premium_mix": dict(sorted(Counter(r["premium_included"] for r in included).items())),
        "mai_status": mai_status,
        "mai_note": mai_note,
        "segments": segments,
    }


def load(path):
    with open(path, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def main(argv=None):
    p = argparse.ArgumentParser(description="MAI over the weekly ledger dataset")
    p.add_argument("--dataset", default=DEFAULT_DATASET)
    p.add_argument("--output", default=DEFAULT_OUTPUT)
    p.add_argument("--status", default=",".join(DEFAULT_STATUSES),
                   help="comma-separated statuses to include (default CONFIRMED,REPORTED)")
    args = p.parse_args(argv)

    statuses = [s.strip() for s in args.status.split(",") if s.strip()]
    bad = [s for s in statuses if s not in ALL_STATUSES]
    if bad or not statuses:
        p.error(f"--status must be a subset of {','.join(ALL_STATUSES)}; got {args.status!r}")
    if not os.path.exists(args.dataset):
        print(f"No dataset at {args.dataset}. Run ledger_ingest.py first.", file=sys.stderr)
        return 1

    out = build(load(args.dataset), statuses)
    with open(args.output, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2, ensure_ascii=False)
        fh.write("\n")

    sf, t = out["status_filter"], out["segments"]["all"]["totals"]
    print(f"Ledger MAI — as of {out['as_of']}")
    print(f"  status filter {sf['included']}: {sf['rows_included']} rows in, "
          f"{sf['rows_excluded']} excluded {sf['rows_excluded_by_status']}")
    print(f"  apex {t['apex']}, non-apex {t['non_apex']}, apex_unknown {t['apex_unknown']} (blank high_estimate_usd)")
    print(f"  premium_included mix {out['premium_mix']}")
    print(f"  MAI: {out['mai_status']}")
    if out["mai_note"]:
        print(f"  {out['mai_note']}")
    print(f"Wrote {os.path.abspath(args.output)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
