#!/usr/bin/env python3
"""
HAGI Top at the summit: the HAGI Top Index (2010, ex Porsche and Ferrari; 24
cars, the data/variants.csv rows tagged hagi-top) in the lots behind the
Manufacturer Apex Index.

This is index_lots.py limited to one index and to the lots MAI scores. Every
lot of every sale (live auctions and Bring a Trailer months) is matched to
the HAGI Top car it is, if any, with variants.matches on its title: the
Bring a Trailer listing slug where the lot has one (notes "bat:<slug>"), else
"<year> <make> <model>". mai.py calls write() once it has marked each sale's
highlights, and data/hagi_top_lots.csv gets one row per matched lot:

  highlight   whether the lot was one of its sale's highlights
  share       its share of all highlight weight: the weight mai.py gives a
              highlight (the sale's auction_rating over its highlight count)
              over the sum of all sales' ratings. A make's MAI_score is the
              sum of its highlights' shares, so the HAGI Top's shares add up
              to the score the index would have if it were one make.
  suspect     a sold price under SUSPECT_SHARE of the car's median (with at
              least three prices to take a median of): most likely not the
              car the title says, so mai.html sets it aside

data/index_lots.csv (index_lots.py) has the same rows for every index, with
the same values in these columns.

Run: python3 data/pipelines/hagi_top.py prints the matches without writing.
"""

import csv
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import index_lots  # noqa: E402

INDEX = "hagi-top"
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "hagi_top_lots.csv")
COLS = index_lots.LOT_COLS
SLUG = index_lots.SLUG
lot_title = index_lots.lot_title


def match(lots, variants=None):
    """[(variant, lot)] for every lot that is a HAGI Top car; first match wins."""
    return index_lots.match(lots, variants, index=INDEX)


def suspects(matched):
    """ids of lots sold under SUSPECT_SHARE of their car's median price."""
    return index_lots.suspects(matched)


def rows(matched, ratings_lookup, highlight_counts, total_rating):
    return [{k: r[k] for k in COLS}
            for r in index_lots.scored_rows(matched, ratings_lookup, highlight_counts, total_rating)]


def write(lots, ratings_lookup, total_rating, path=OUTPUT_PATH):
    """lots: mai.py's DataFrame after add_apex_columns."""
    records = lots.to_dict("records")
    out = rows(match(records), ratings_lookup, index_lots.highlight_counts(records), total_rating)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLS)
        w.writeheader()
        w.writerows(out)
    cars = {r["variant_id"] for r in out if r["suspect"] != "true"}
    score = sum(float(r["share"]) for r in out if r["suspect"] != "true")
    print(f"Wrote {len(out)} HAGI Top lots ({len(cars)} of the index's cars, "
          f"{sum(r['highlight'] == 'true' for r in out)} highlights, score {score:.4f}) "
          f"to {os.path.basename(path)}")
    return out


def main():
    from apex import add_apex_columns, read_lots
    import mai
    lots = read_lots(mai.LOTS_PATH, mai.ONLINE_PATH)
    lots["sold"] = lots["sold"].astype(str).str.strip().str.lower().isin(["true", "1", "yes"])
    add_apex_columns(lots)
    for v, lot in match(lots.to_dict("records")):
        flag = "highlight" if lot.get("is_apex") else ""
        print(f"{v['variant']:<28} {lot.get('event'):<40} {lot_title(lot):<60} {flag}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
