#!/usr/bin/env python3
"""
Auction Rating Pipeline
Reads auction_lots.csv and outputs a per-event Auction Rating score.

Apex lot = low_estimate_usd >= 500000
Sub-scores are min-max normalized 0-100 across all events in the dataset.
Rating = 0.3*Concentration + 0.4*Volume + 0.3*Sell-Through
"""

import os
import pandas as pd

LOTS_PATH = os.path.join(os.path.dirname(__file__), "..", "auction_lots.csv")
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "auction_ratings.csv")
APEX_THRESHOLD = 500_000


def minmax(series: pd.Series) -> pd.Series:
    lo, hi = series.min(), series.max()
    if hi == lo:
        return pd.Series([100.0 if lo > 0 else 0.0] * len(series), index=series.index)
    return (series - lo) / (hi - lo) * 100


def main():
    df = pd.read_csv(LOTS_PATH)

    if df.empty:
        print("auction_lots.csv is empty — writing empty auction_ratings.csv")
        pd.DataFrame(columns=[
            "event", "event_date", "auction_house", "apex_lots", "total_lots",
            "apex_concentration", "apex_volume", "apex_sell_through", "auction_rating",
        ]).to_csv(OUTPUT_PATH, index=False)
        return

    # Normalise the sold column to boolean
    df["sold"] = df["sold"].astype(str).str.strip().str.lower().isin(["true", "1", "yes"])
    df["low_estimate_usd"] = pd.to_numeric(df["low_estimate_usd"], errors="coerce").fillna(0)
    df["sold_price_usd"] = pd.to_numeric(df["sold_price_usd"], errors="coerce").fillna(0)

    apex = df[df["low_estimate_usd"] >= APEX_THRESHOLD].copy()

    events = df.groupby(["event", "event_date", "auction_house"])

    rows = []
    for (event, event_date, auction_house), group in events:
        total_lots = len(group)
        apex_group = apex[
            (apex["event"] == event) & (apex["event_date"] == event_date)
        ]
        apex_lot_count = len(apex_group)
        apex_sold = apex_group[apex_group["sold"]]

        concentration_raw = apex_lot_count / total_lots if total_lots > 0 else 0.0
        volume_raw = apex_sold["sold_price_usd"].sum()
        sell_through_raw = (
            len(apex_sold) / apex_lot_count if apex_lot_count > 0 else 0.0
        )

        rows.append({
            "event": event,
            "event_date": event_date,
            "auction_house": auction_house,
            "apex_lots": apex_lot_count,
            "total_lots": total_lots,
            "_concentration_raw": concentration_raw,
            "_volume_raw": volume_raw,
            "_sell_through_raw": sell_through_raw,
        })

    result = pd.DataFrame(rows)

    result["apex_concentration"] = minmax(result["_concentration_raw"])
    result["apex_volume"] = minmax(result["_volume_raw"])
    result["apex_sell_through"] = minmax(result["_sell_through_raw"])

    result["auction_rating"] = (
        0.3 * result["apex_concentration"]
        + 0.4 * result["apex_volume"]
        + 0.3 * result["apex_sell_through"]
    )

    out = result[[
        "event", "event_date", "auction_house", "apex_lots", "total_lots",
        "apex_concentration", "apex_volume", "apex_sell_through", "auction_rating",
    ]]

    out.to_csv(OUTPUT_PATH, index=False, float_format="%.4f")
    print(f"Wrote {len(out)} event ratings to {os.path.abspath(OUTPUT_PATH)}")


if __name__ == "__main__":
    main()
