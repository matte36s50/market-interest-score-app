#!/usr/bin/env python3
"""
Manufacturer Apex Index (MAI) — D-term proxy for the Networked Utility Dividend.

Apex lots are the highlights of each sale: its top 10% of lots by apex value,
at most 25 (see apex.py). Sales under 20 lots have none. Online platforms
count one completed month as one sale (online_lots.csv).

For each manufacturer × event:
  P (Presence)   = manufacturer's share of the sale's highlights
  R (Performance)= sell-through of the manufacturer's highlights
  Q (Quality)    = mean(sold_price / high_estimate) over its sold highlights
                   with a real high estimate (blank where none have one)

MAI per manufacturer = Σ(auction_rating_i × P_i) / Σ(auction_rating_j)

The numerator runs over the sales where the make had a highlight; the
denominator over every sale with highlights, so MAI is the make's share of
all highlight value, and a make that topped one small sale can't outrank one
that is among the highlights everywhere. auction_rating is what it takes to
be a highlight at that sale (auction_rating.py), so a highlight at Monterey
counts for more than one at Hershey.

Modern and classic scores (MAI_modern, MAI_classic): a highlight is modern
if the car was under CLASSIC_AGE (25) years old when it sold (sale year minus
model year), classic otherwise. A sale's highlights stay its overall top 10%;
each segment's score is a make's share of that segment's highlights, each
weighted by its sale's rating / the sale's highlight count, the weight it
carries in the combined score. Each segment's scores sum to 1. A highlight
with no model year counts only in the combined score.

R and Q are reported, not multiplied in. Most highlights have no estimate,
so Q is unknown for most makes; and an unsold lot with no estimate can't be
ranked, so R reads high wherever highlights are ranked by sold price
(apex_from_estimate / apex_from_sold_price say how many were).

Outputs mai_scores.csv sorted descending by MAI_score.
"""

import os
import sys
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from apex import BASIS_ESTIMATE, BASIS_SOLD_PRICE, add_apex_columns, read_lots

LOTS_PATH = os.path.join(os.path.dirname(__file__), "..", "auction_lots.csv")
ONLINE_PATH = os.path.join(os.path.dirname(__file__), "..", "online_lots.csv")
RATINGS_PATH = os.path.join(os.path.dirname(__file__), "..", "auction_ratings.csv")
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "mai_scores.csv")
# For the drill-down on mai.html: each make's contribution from each sale
# (they sum to its MAI_score), and the highlight lots themselves.
DETAIL_PATH = os.path.join(os.path.dirname(__file__), "..", "mai_detail.csv")
APEX_LOTS_PATH = os.path.join(os.path.dirname(__file__), "..", "apex_lots.csv")

CLASSIC_AGE = 25
SEGMENTS = ("modern", "classic")

DETAIL_COLS = [
    "manufacturer", "event", "event_date", "auction_house", "auction_rating",
    "sale_apex_lots", "apex_lots", "P", "Q", "R", "contribution",
    "apex_lots_modern", "apex_lots_classic", "contribution_modern", "contribution_classic",
]
APEX_LOT_COLS = [
    "event", "event_date", "auction_house", "rank", "manufacturer", "model", "year_of_car",
    "apex_value_usd", "apex_basis", "sold", "sold_price_usd", "high_estimate_usd",
    "age_at_sale", "segment",
]

EMPTY_COLS = [
    "manufacturer", "events_present", "total_apex_lots",
    "avg_P", "avg_Q", "avg_R", "MAI_score",
    "apex_from_estimate", "apex_from_sold_price",
]


def main():
    lots = read_lots(LOTS_PATH, ONLINE_PATH)
    ratings = pd.read_csv(RATINGS_PATH)

    if lots.empty or ratings.empty:
        print("Input data is empty — writing empty mai_scores.csv")
        pd.DataFrame(columns=EMPTY_COLS).to_csv(OUTPUT_PATH, index=False)
        return

    lots["sold"] = lots["sold"].astype(str).str.strip().str.lower().isin(["true", "1", "yes"])
    lots["sold_price_usd"] = pd.to_numeric(lots["sold_price_usd"], errors="coerce")
    lots["high_estimate_usd"] = pd.to_numeric(lots["high_estimate_usd"], errors="coerce")
    lots["manufacturer"] = lots["manufacturer"].astype(str).str.strip()
    add_apex_columns(lots)

    apex = lots[lots["is_apex"]].copy()

    if apex.empty:
        print("No apex lots found — writing empty mai_scores.csv")
        pd.DataFrame(columns=EMPTY_COLS).to_csv(OUTPUT_PATH, index=False)
        return

    # Build a lookup: (event, event_date) → auction_rating
    ratings_lookup = ratings.set_index(["event", "event_date"])["auction_rating"].to_dict()

    records = []
    total_rating = 0.0
    for (event, event_date), event_apex in apex.groupby(["event", "event_date"]):
        rating = ratings_lookup.get((event, event_date), 0.0)
        total_rating += rating
        total_apex_at_event = len(event_apex)
        house = event_apex["auction_house"].iloc[0]

        for manufacturer, mfr_apex in event_apex.groupby("manufacturer"):
            mfr_sold = mfr_apex[mfr_apex["sold"]]

            P = len(mfr_apex) / total_apex_at_event if total_apex_at_event > 0 else 0.0
            R = len(mfr_sold) / len(mfr_apex) if len(mfr_apex) > 0 else 0.0

            # Q is only known where the manufacturer sold a highlight that had
            # a published high estimate; the sold price never stands in.
            priced = mfr_sold[mfr_sold["high_estimate_usd"] > 0]
            q_known = (
                (priced["sold_price_usd"] / priced["high_estimate_usd"]).mean()
                if len(priced) else float("nan")
            )

            records.append({
                "manufacturer": manufacturer,
                "event": event,
                "event_date": event_date,
                "apex_lots": len(mfr_apex),
                "apex_from_estimate": int((mfr_apex["apex_basis"] == BASIS_ESTIMATE).sum()),
                "apex_from_sold_price": int((mfr_apex["apex_basis"] == BASIS_SOLD_PRICE).sum()),
                "P": P,
                "Q_known": q_known,
                "R": R,
                "auction_rating": rating,
                "auction_house": house,
                "sale_apex_lots": total_apex_at_event,
            })

    if not records:
        pd.DataFrame(columns=EMPTY_COLS).to_csv(OUTPUT_PATH, index=False)
        return

    detail = pd.DataFrame(records)

    # Aggregate per manufacturer
    agg_rows = []
    for manufacturer, grp in detail.groupby("manufacturer"):
        mai_score = (
            (grp["auction_rating"] * grp["P"]).sum() / total_rating
            if total_rating > 0 else 0.0
        )
        agg_rows.append({
            "manufacturer": manufacturer,
            "events_present": len(grp),
            "total_apex_lots": int(grp["apex_lots"].sum()),
            "avg_P": round(grp["P"].mean(), 6),
            # Mean over the events where Q is known; blank if there are none.
            "avg_Q": round(grp["Q_known"].mean(), 6),
            "avg_R": round(grp["R"].mean(), 6),
            "MAI_score": round(mai_score, 6),
            "apex_from_estimate": int(grp["apex_from_estimate"].sum()),
            "apex_from_sold_price": int(grp["apex_from_sold_price"].sum()),
        })

    out = (
        pd.DataFrame(agg_rows)
        .sort_values("MAI_score", ascending=False)
        .reset_index(drop=True)
    )
    detail, out = add_segments(apex, detail, out, ratings_lookup)
    out.to_csv(OUTPUT_PATH, index=False)
    print(f"Wrote {len(out)} manufacturer scores to {os.path.abspath(OUTPUT_PATH)}")
    write_drilldown(detail, apex, total_rating)
    print(f"Apex lots: {len(apex)} across {detail[['event', 'event_date']].drop_duplicates().shape[0]} "
          f"sales ({int(out['apex_from_estimate'].sum())} ranked by high estimate, "
          f"{int(out['apex_from_sold_price'].sum())} by sold price; R reads high where sold "
          "prices are used)")


def segment_of(age):
    """'modern' under CLASSIC_AGE years at sale, 'classic' from it, '' unknown."""
    if age is None or pd.isna(age):
        return ""
    return "modern" if age < CLASSIC_AGE else "classic"


def add_segments(apex, detail, out, ratings_lookup):
    """Modern and classic scores, from the same highlights as MAI_score.

    Each highlight weighs rating / (its sale's highlight count), so a make's
    combined score is the sum of its highlights' weights over all weights.
    A segment's score is the same sum over that segment's highlights only.
    Adds age_at_sale and segment to `apex` in place.
    """
    sale_year = pd.to_datetime(apex["event_date"], errors="coerce").dt.year
    year = pd.to_numeric(apex["year_of_car"], errors="coerce")
    apex["age_at_sale"] = sale_year - year
    apex["segment"] = apex["age_at_sale"].map(segment_of)
    keys = list(zip(apex["event"], apex["event_date"]))
    per_sale = pd.Series(keys).value_counts()
    apex["weight"] = [ratings_lookup.get(k, 0.0) / per_sale[k] for k in keys]

    by_make, by_cell = {}, {}
    for seg in SEGMENTS:
        part = apex[apex["segment"] == seg]
        total = part["weight"].sum()
        by_make[seg] = (part.groupby("manufacturer")["weight"].sum() / total) if total > 0 else pd.Series(dtype=float)
        cell = part.groupby(["manufacturer", "event", "event_date"])["weight"].agg(["sum", "size"])
        cell["sum"] = cell["sum"] / total if total > 0 else 0.0
        by_cell[seg] = cell
        print(f"  {seg}: {len(part)} highlights, {total / apex['weight'].sum():.0%} of highlight weight")
    missing = int((apex["segment"] == "").sum())
    if missing:
        print(f"  no model year: {missing} highlight(s), combined score only")

    for seg in SEGMENTS:
        out[f"MAI_{seg}"] = out["manufacturer"].map(by_make[seg]).fillna(0.0).round(6)
        counts = apex[apex["segment"] == seg].groupby("manufacturer").size()
        out[f"apex_lots_{seg}"] = out["manufacturer"].map(counts).fillna(0).astype(int)
        idx = list(zip(detail["manufacturer"], detail["event"], detail["event_date"]))
        cell = by_cell[seg]
        detail[f"contribution_{seg}"] = [cell["sum"].get(i, 0.0) for i in idx]
        detail[f"apex_lots_{seg}"] = [int(cell["size"].get(i, 0)) for i in idx]
    return detail, out


def write_drilldown(detail, apex, total_rating):
    """mai_detail.csv and apex_lots.csv, read by mai.html's drill-down."""
    d = detail.copy()
    d["contribution"] = d["auction_rating"] * d["P"] / total_rating if total_rating > 0 else 0.0
    d["Q"] = d["Q_known"]
    d = d.sort_values(["manufacturer", "contribution"], ascending=[True, False])
    d[DETAIL_COLS].to_csv(DETAIL_PATH, index=False, float_format="%.6g")

    lots = apex.sort_values(["event_date", "event", "apex_value"], ascending=[True, True, False]).copy()
    lots["rank"] = lots.groupby(["event", "event_date"]).cumcount() + 1
    lots["apex_value_usd"] = lots["apex_value"].round(0)
    lots["sold"] = lots["sold"].map({True: "true", False: "false"})
    lots["age_at_sale"] = lots["age_at_sale"].astype("Int64")
    for col in APEX_LOT_COLS:
        if col not in lots:
            lots[col] = ""
    lots[APEX_LOT_COLS].to_csv(APEX_LOTS_PATH, index=False, float_format="%.0f")
    print(f"Wrote {len(d)} make-by-sale rows to {os.path.basename(DETAIL_PATH)} "
          f"and {len(lots)} highlight lots to {os.path.basename(APEX_LOTS_PATH)}")


if __name__ == "__main__":
    main()
