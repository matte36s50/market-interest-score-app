#!/usr/bin/env python3
"""
HAGI Top at the summit: the HAGI Top Index (2010, ex Porsche and Ferrari; 24
cars, the data/variants.csv rows tagged hagi-top) in the lots behind the
Manufacturer Apex Index.

Every lot of every sale (live auctions and Bring a Trailer months) is matched
to the HAGI Top car it is, if any, with variants.matches on its title: the
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

Run: python3 data/pipelines/hagi_top.py prints the matches without writing.
"""

import os
import re
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import variants as V  # noqa: E402

INDEX = "hagi-top"
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "hagi_top_lots.csv")
COLS = [
    "variant_id", "variant", "event", "event_date", "auction_house", "manufacturer",
    "model", "year_of_car", "sold", "sold_price_usd", "high_estimate_usd",
    "apex_value_usd", "highlight", "share", "suspect",
]
SLUG = re.compile(r"\bbat:([^\s;]+)")


def lot_title(lot):
    """The lot as a listing title: '1955 mercedes benz 300 sl gullwing'."""
    m = SLUG.search(str(lot.get("notes") or ""))
    if m:
        return V.title_of(m.group(1))
    parts = [lot.get("year_of_car"), lot.get("manufacturer"), lot.get("model")]
    text = " ".join(str(p) for p in parts if p is not None and p == p and str(p).strip())
    text = re.sub(r"(\d)\.0\b", r"\1", text)  # a year read as a float
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def match(lots, variants=None):
    """[(variant, lot)] for every lot that is a HAGI Top car; first match wins."""
    variants = [v for v in (variants or V.load_variants()) if INDEX in v["index_list"]]
    out = []
    for lot in lots:
        title = lot_title(lot)
        year = V.year_of(title, lot.get("year_of_car"))
        for v in variants:
            if V.matches(v, lot.get("manufacturer"), title, year):
                out.append((v, lot))
                break
    return out


def _num(x):
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return x if x == x else None


def suspects(matched):
    """ids of lots sold under SUSPECT_SHARE of their car's median price."""
    prices = {}
    for v, lot in matched:
        p = _num(lot.get("sold_price_usd"))
        if lot.get("sold") and p:
            prices.setdefault(v["id"], []).append(p)
    out = set()
    for v, lot in matched:
        ps = prices.get(v["id"], [])
        p = _num(lot.get("sold_price_usd"))
        if len(ps) >= 3 and lot.get("sold") and p and p < V.SUSPECT_SHARE * statistics.median(ps):
            out.add(id(lot))
    return out


def rows(matched, ratings_lookup, highlight_counts, total_rating):
    odd = suspects(matched)
    out = []
    for v, lot in matched:
        key = (lot.get("event"), lot.get("event_date"))
        highlight = bool(lot.get("is_apex"))
        n = highlight_counts.get(key, 0)
        share = (ratings_lookup.get(key, 0.0) / n / total_rating
                 if highlight and n and total_rating > 0 else 0.0)
        value = _num(lot.get("apex_value"))
        out.append({
            "variant_id": v["id"],
            "variant": v["variant"],
            "event": lot.get("event"),
            "event_date": lot.get("event_date"),
            "auction_house": lot.get("auction_house"),
            "manufacturer": lot.get("manufacturer"),
            "model": lot.get("model"),
            "year_of_car": "" if _num(lot.get("year_of_car")) is None else int(_num(lot.get("year_of_car"))),
            "sold": "true" if lot.get("sold") else "false",
            "sold_price_usd": "" if _num(lot.get("sold_price_usd")) is None else round(_num(lot.get("sold_price_usd"))),
            "high_estimate_usd": "" if _num(lot.get("high_estimate_usd")) is None else round(_num(lot.get("high_estimate_usd"))),
            "apex_value_usd": "" if value is None else round(value),
            "highlight": "true" if highlight else "false",
            "share": f"{share:.6g}",
            "suspect": "true" if id(lot) in odd else "false",
        })
    out.sort(key=lambda r: (r["variant_id"], str(r["event_date"]), str(r["event"])))
    return out


def write(lots, ratings_lookup, total_rating, path=OUTPUT_PATH):
    """lots: mai.py's DataFrame after add_apex_columns."""
    import csv
    records = lots.to_dict("records")
    highlight_counts = {}
    for r in records:
        if r.get("is_apex"):
            key = (r.get("event"), r.get("event_date"))
            highlight_counts[key] = highlight_counts.get(key, 0) + 1
    out = rows(match(records), ratings_lookup, highlight_counts, total_rating)
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
    import pandas as pd
    lots = read_lots(mai.LOTS_PATH, mai.ONLINE_PATH)
    lots["sold"] = lots["sold"].astype(str).str.strip().str.lower().isin(["true", "1", "yes"])
    add_apex_columns(lots)
    for v, lot in match(lots.to_dict("records")):
        flag = "highlight" if lot.get("is_apex") else ""
        print(f"{v['variant']:<28} {lot.get('event'):<40} {lot_title(lot):<60} {flag}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
