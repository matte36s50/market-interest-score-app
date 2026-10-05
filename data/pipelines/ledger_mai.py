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
  * Manufacturer grouping: the ledger's `make` is kept as recorded, and
    ledger_manufacturer_groups.csv maps sub-brands onto their manufacturer
    (Mercedes-AMG, Mercedes-Maybach, Maybach -> Mercedes-Benz). Makes not in
    the file are their own manufacturer. The mapping is explicit on purpose:
    a name pattern would wrongly fold "Frazer Nash-BMW" into BMW.
  * Coverage counts per manufacturer and per event, segmented by
    premium_included (all / yes / no / unknown), so hammer-only and
    premium-inclusive figures are never blended without it being visible.

  * MAI per manufacturer, per segment: see compute_mai() for the formula.

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
DEFAULT_GROUPS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ledger_manufacturer_groups.csv")

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


def load_groups(path=DEFAULT_GROUPS):
    """{make: manufacturer} from the mapping file. A make listed twice is an
    error: which group it belongs to would depend on row order."""
    groups = {}
    with open(path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            make, manufacturer = row["make"].strip(), row["manufacturer"].strip()
            if not make or not manufacturer:
                raise ValueError(f"{path}: blank make or manufacturer in {row}")
            if make in groups:
                raise ValueError(f"{path}: make {make!r} is listed twice")
            groups[make] = manufacturer
    return groups


def apex_class(row):
    """'apex', 'non_apex' or 'apex_unknown'. A blank high_estimate_usd is
    unknown — it is never read as 0 and never as non-apex."""
    raw = row["high_estimate_usd"]
    if raw == "":
        return "apex_unknown"
    return "apex" if Decimal(raw) >= APEX_THRESHOLD_USD else "non_apex"


# ════════════════════════════════════════════════════════════════════════════
#  MAI FORMULA.  Nothing else in this module scores.
# ════════════════════════════════════════════════════════════════════════════
#
#  The P x Q x R core of the repo's MAI v1 (mai.py), adapted so nothing is
#  imputed. Per manufacturer x event, over that event's apex lots:
#
#    P  presence     = manufacturer's apex lots / all apex lots at the event.
#                      apex_unknown lots are in neither count (they are shown
#                      beside the score instead).
#    Q  realisation  = mean of price / high estimate over the manufacturer's
#                      apex lots sold WITH a price. In the house's currency
#                      (price / estimate_high) when price and estimate share a
#                      currency, so no FX enters; otherwise price_usd /
#                      high_estimate_usd as recorded. A lot sold with the
#                      price withheld is left out of Q. No priced sale: Q is
#                      unknown, never 0.
#    R  sell-through = sold (with or without a published price) /
#                      (sold + not sold).
#
#  Withdrawn lots are left out of P and R, as export_live_lots.py does for the
#  store-fed MAI: a lot that never crossed the block is neither presence nor a
#  no-sale.
#
#  term = P x Q x R. Where nothing sold, R = 0 and the term is 0 whatever Q
#  is: that is the product's value, not a filled-in Q. Where something sold
#  but no sale has a usable price, Q is unknown and so is the term; it is
#  left out and counted in events_unscored.
#
#  MAI = the plain mean of a manufacturer's known terms across events. v1
#  weights events by an auction rating built on each sale's total lot count,
#  which a curated weekly ledger does not contain, so events are unweighted.
#  No known term: MAI is None, shown as "n/a", never 0.

APEX_STATES_SCORED = ("sold_with_price", "sold_without_price", "not_sold")
NO_APEX_SCORE = {"mai": None, "avg_P": None, "avg_Q": None, "avg_R": None,
                 "events_scored": 0, "events_unscored": 0, "q_basis": {}}
MAI_FORMULA = ("MAI = mean over events of P x Q x R. P = share of the event's apex lots; "
               "Q = mean price / high estimate over apex lots sold with a price (house currency where "
               "price and estimate match, else recorded USD); R = sold / (sold + not sold). Withdrawn "
               "lots excluded; apex_unknown lots excluded and counted; an event where something sold "
               "but no price is usable is unscored, never 0.")


def lot_ratio(row):
    """(price / high estimate, basis) for an apex lot sold with a price, or
    (None, None) when no ratio can be formed from what was recorded."""
    if row["result_state"] != "sold_with_price":
        return None, None
    if row["currency"] and row["currency"] == row["estimate_currency"] and row["estimate_high"]:
        return Decimal(row["price"]) / Decimal(row["estimate_high"]), "native"
    if row["price_usd"] and row["high_estimate_usd"]:
        return Decimal(row["price_usd"]) / Decimal(row["high_estimate_usd"]), "usd"
    return None, None


def _mean(values):
    return sum(values) / len(values) if values else None


def compute_mai(apex_rows, segment_rows):
    """MAI per manufacturer over apex_rows (already filtered by status and
    premium segment, each carrying `manufacturer` after grouping).

    Returns {manufacturer: {mai, avg_P, avg_Q, avg_R, events_scored,
    events_unscored, q_basis}}; mai and the averages are None where unknown.
    segment_rows is unused by this formula; it is passed for formulas that
    need a per-event denominator beyond the apex lots.
    """
    scored_rows = [r for r in apex_rows if r["result_state"] in APEX_STATES_SCORED]
    by_event = group_coverage(scored_rows, lambda r: (r["event"], r["event_date"]))

    per_maker = defaultdict(lambda: {"terms": [], "P": [], "Q": [], "R": [], "unscored": 0,
                                     "q_basis": Counter()})
    for _, event_rows in sorted(by_event.items()):
        event_apex = len(event_rows)
        for manufacturer, mrows in group_coverage(event_rows, lambda r: r["manufacturer"]).items():
            acc = per_maker[manufacturer]
            sold = sum(1 for r in mrows if r["result_state"] != "not_sold")
            P = Decimal(len(mrows)) / event_apex
            R = Decimal(sold) / len(mrows)
            ratios = []
            for r in mrows:
                ratio, basis = lot_ratio(r)
                if ratio is not None:
                    ratios.append(ratio)
                    acc["q_basis"][basis] += 1
            Q = _mean(ratios)
            acc["P"].append(P)
            acc["R"].append(R)
            if Q is not None:
                acc["Q"].append(Q)
            if R == 0:
                acc["terms"].append(Decimal(0))
            elif Q is None:
                acc["unscored"] += 1
            else:
                acc["terms"].append(P * Q * R)

    def rnd(d):
        return None if d is None else round(float(d), 6)

    return {
        manufacturer: {
            "mai": rnd(_mean(acc["terms"])),
            "avg_P": rnd(_mean(acc["P"])),
            "avg_Q": rnd(_mean(acc["Q"])),
            "avg_R": rnd(_mean(acc["R"])),
            "events_scored": len(acc["terms"]),
            "events_unscored": acc["unscored"],
            "q_basis": dict(sorted(acc["q_basis"].items())),
        }
        for manufacturer, acc in per_maker.items()
    }

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


def build(rows, statuses=DEFAULT_STATUSES, groups=None):
    statuses = tuple(statuses)
    groups = load_groups() if groups is None else groups
    rows = [dict(r, manufacturer=groups.get(r["make"], r["make"])) for r in rows]
    included = [r for r in rows if r["status"] in statuses]
    excluded = Counter(r["status"] for r in rows if r["status"] not in statuses)

    segments = {}
    for name, keep in SEGMENTS.items():
        seg = [r for r in included if keep(r)]
        scores = compute_mai([r for r in seg if apex_class(r) == "apex"], seg)

        makers = []
        for manufacturer, mrows in sorted(group_coverage(seg, lambda r: r["manufacturer"]).items()):
            makers.append(dict(
                {"manufacturer": manufacturer, **scores.get(manufacturer, NO_APEX_SCORE),
                 "makes": dict(sorted(Counter(r["make"] for r in mrows).items())),
                 "events": len({(r["event"], r["event_date"]) for r in mrows})},
                **coverage(mrows)))
        makers.sort(key=lambda m: (m["mai"] is None, -(m["mai"] or 0), -m["apex"], m["manufacturer"]))

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
        "manufacturer_groups": {
            make: manufacturer for make, manufacturer in sorted(groups.items())
            if any(r["make"] == make for r in included)
        },
        "premium_mix": dict(sorted(Counter(r["premium_included"] for r in included).items())),
        "mai_formula": MAI_FORMULA,
        "segments": segments,
    }


def load(path):
    with open(path, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def main(argv=None):
    p = argparse.ArgumentParser(description="MAI over the weekly ledger dataset")
    p.add_argument("--dataset", default=DEFAULT_DATASET)
    p.add_argument("--output", default=DEFAULT_OUTPUT)
    p.add_argument("--groups", default=DEFAULT_GROUPS, help="make -> manufacturer mapping CSV")
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

    out = build(load(args.dataset), statuses, load_groups(args.groups))
    with open(args.output, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2, ensure_ascii=False)
        fh.write("\n")

    sf, t = out["status_filter"], out["segments"]["all"]["totals"]
    print(f"Ledger MAI — as of {out['as_of']}")
    print(f"  status filter {sf['included']}: {sf['rows_included']} rows in, "
          f"{sf['rows_excluded']} excluded {sf['rows_excluded_by_status']}")
    print(f"  apex {t['apex']}, non-apex {t['non_apex']}, apex_unknown {t['apex_unknown']} (blank high_estimate_usd)")
    print(f"  premium_included mix {out['premium_mix']}")
    if out["manufacturer_groups"]:
        print(f"  makes grouped {out['manufacturer_groups']}")
    for m in out["segments"]["all"]["manufacturers"]:
        if m["mai"] is not None or m["events_unscored"]:
            print(f"  {m['manufacturer']:<16} MAI {m['mai']}  (scored {m['events_scored']}, "
                  f"unscored {m['events_unscored']}, apex {m['apex']}, apex_unknown {m['apex_unknown']})")
    print(f"Wrote {os.path.abspath(args.output)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
