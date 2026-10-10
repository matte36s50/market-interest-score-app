#!/usr/bin/env python3
"""
Manufacturer Apex Index (MAI) — D-term proxy for the Networked Utility Dividend.

Apex lots follow apex.py: high estimate >= $500K, else sold price >= $500K
for a lot that sold. The sold-price fallback only reaches sold lots, so R is
biased upward for makes whose apex lots came in that way; apex_from_estimate
and apex_from_sold_price say how many did.

For each manufacturer × event:
  P (Presence)   = manufacturer's share of apex lots at that event
  Q (Quality)    = mean(sold_price / high_estimate) for sold apex lots
                   with a real high estimate. Lots without one are skipped;
                   the sold price never stands in for the estimate. Where no
                   lot has one, Q is unknown and left out of the event's term
                   (P × R instead of P × Q × R) and out of avg_Q.
  R (Performance)= apex lot sell-through rate

MAI per manufacturer = Σ(auction_rating_i × term_i) / Σ(auction_rating_i)
                       summed over all events where the manufacturer appears in apex lots.

Outputs mai_scores.csv sorted descending by MAI_score.
"""

import os
import sys
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from apex import BASIS_ESTIMATE, BASIS_SOLD_PRICE, add_apex_columns

LOTS_PATH = os.path.join(os.path.dirname(__file__), "..", "auction_lots.csv")
RATINGS_PATH = os.path.join(os.path.dirname(__file__), "..", "auction_ratings.csv")
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "mai_scores.csv")

EMPTY_COLS = [
    "manufacturer", "events_present", "total_apex_lots",
    "avg_P", "avg_Q", "avg_R", "MAI_score",
    "apex_from_estimate", "apex_from_sold_price",
]


def main():
    lots = pd.read_csv(LOTS_PATH)
    ratings = pd.read_csv(RATINGS_PATH)

    if lots.empty or ratings.empty:
        print("Input data is empty — writing empty mai_scores.csv")
        pd.DataFrame(columns=EMPTY_COLS).to_csv(OUTPUT_PATH, index=False)
        return

    lots["sold"] = lots["sold"].astype(str).str.strip().str.lower().isin(["true", "1", "yes"])
    lots["sold_price_usd"] = pd.to_numeric(lots["sold_price_usd"], errors="coerce")
    lots["high_estimate_usd"] = pd.to_numeric(lots["high_estimate_usd"], errors="coerce")
    add_apex_columns(lots)

    apex = lots[lots["is_apex"]].copy()

    if apex.empty:
        print("No apex lots found — writing empty mai_scores.csv")
        pd.DataFrame(columns=EMPTY_COLS).to_csv(OUTPUT_PATH, index=False)
        return

    # Build a lookup: (event, event_date) → auction_rating
    ratings_lookup = ratings.set_index(["event", "event_date"])["auction_rating"].to_dict()

    records = []
    for (event, event_date), event_apex in apex.groupby(["event", "event_date"]):
        rating = ratings_lookup.get((event, event_date), 0.0)
        total_apex_at_event = len(event_apex)

        for manufacturer, mfr_apex in event_apex.groupby("manufacturer"):
            mfr_sold = mfr_apex[mfr_apex["sold"]]

            P = len(mfr_apex) / total_apex_at_event if total_apex_at_event > 0 else 0.0
            R = len(mfr_sold) / len(mfr_apex) if len(mfr_apex) > 0 else 0.0

            # Q is only known where the manufacturer sold an apex lot that had
            # a published high estimate. Elsewhere it is left out: the term is
            # P×R rather than zeroing the event, and avg_Q skips it, so "no
            # estimate" never reads as poor price realisation.
            priced = mfr_sold[mfr_sold["high_estimate_usd"] > 0]
            q_known = (
                (priced["sold_price_usd"] / priced["high_estimate_usd"]).mean()
                if len(priced) else float("nan")
            )
            term = P * R * (q_known if pd.notna(q_known) else 1.0)

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
                "term": term,
            })

    if not records:
        pd.DataFrame(columns=EMPTY_COLS).to_csv(OUTPUT_PATH, index=False)
        return

    detail = pd.DataFrame(records)

    # Aggregate per manufacturer
    agg_rows = []
    for manufacturer, grp in detail.groupby("manufacturer"):
        total_rating = grp["auction_rating"].sum()
        mai_score = (
            (grp["auction_rating"] * grp["term"]).sum() / total_rating
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
    out.to_csv(OUTPUT_PATH, index=False)
    print(f"Wrote {len(out)} manufacturer scores to {os.path.abspath(OUTPUT_PATH)}")
    print(f"Apex lots: {len(apex)} ({int(out['apex_from_estimate'].sum())} by high estimate, "
          f"{int(out['apex_from_sold_price'].sum())} by sold price; R is biased upward "
          "where the sold-price fallback applies). "
          f"Q unknown, left out of the term: {int(detail['Q_known'].isna().sum())} "
          f"of {len(detail)} manufacturer-event cells")


if __name__ == "__main__":
    main()
