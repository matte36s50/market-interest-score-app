#!/usr/bin/env python3
"""
Manufacturer Apex Index (MAI) — D-term proxy for the Networked Utility Dividend.

For each manufacturer × event:
  P (Presence)   = manufacturer's share of apex lots at that event
  Q (Quality)    = mean(sold_price / high_estimate) for sold apex lots
                   with a high estimate (0 in the score where there are none;
                   left out of avg_Q there)
  R (Performance)= apex lot sell-through rate

MAI per manufacturer = Σ(auction_rating_i × P_i × Q_i × R_i) / Σ(auction_rating_i)
                       summed over all events where the manufacturer appears in apex lots.

Outputs mai_scores.csv sorted descending by MAI_score.
"""

import os
import pandas as pd

LOTS_PATH = os.path.join(os.path.dirname(__file__), "..", "auction_lots.csv")
RATINGS_PATH = os.path.join(os.path.dirname(__file__), "..", "auction_ratings.csv")
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "mai_scores.csv")
APEX_THRESHOLD = 500_000

EMPTY_COLS = [
    "manufacturer", "events_present", "total_apex_lots",
    "avg_P", "avg_Q", "avg_R", "MAI_score",
]


def main():
    lots = pd.read_csv(LOTS_PATH)
    ratings = pd.read_csv(RATINGS_PATH)

    if lots.empty or ratings.empty:
        print("Input data is empty — writing empty mai_scores.csv")
        pd.DataFrame(columns=EMPTY_COLS).to_csv(OUTPUT_PATH, index=False)
        return

    lots["sold"] = lots["sold"].astype(str).str.strip().str.lower().isin(["true", "1", "yes"])
    lots["low_estimate_usd"] = pd.to_numeric(lots["low_estimate_usd"], errors="coerce").fillna(0)
    lots["sold_price_usd"] = pd.to_numeric(lots["sold_price_usd"], errors="coerce").fillna(0)
    lots["high_estimate_usd"] = pd.to_numeric(lots["high_estimate_usd"], errors="coerce")

    apex = lots[lots["low_estimate_usd"] >= APEX_THRESHOLD].copy()

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
            # a published high estimate. Elsewhere it counts as 0 in P×Q×R
            # (where nothing sold, R is 0 anyway) but stays out of avg_Q, which
            # would otherwise report "sold nothing" as poor price realisation.
            priced = mfr_sold[mfr_sold["high_estimate_usd"] > 0]
            q_known = (
                (priced["sold_price_usd"] / priced["high_estimate_usd"]).mean()
                if len(priced) else float("nan")
            )
            Q = q_known if pd.notna(q_known) else 0.0

            records.append({
                "manufacturer": manufacturer,
                "event": event,
                "event_date": event_date,
                "apex_lots": len(mfr_apex),
                "P": P,
                "Q": Q,
                "Q_known": q_known,
                "R": R,
                "auction_rating": rating,
                "pqr": P * Q * R,
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
            (grp["auction_rating"] * grp["pqr"]).sum() / total_rating
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
        })

    out = (
        pd.DataFrame(agg_rows)
        .sort_values("MAI_score", ascending=False)
        .reset_index(drop=True)
    )
    out.to_csv(OUTPUT_PATH, index=False)
    print(f"Wrote {len(out)} manufacturer scores to {os.path.abspath(OUTPUT_PATH)}")


if __name__ == "__main__":
    main()
