#!/usr/bin/env python3
"""
Auction Rating Pipeline
Reads auction_lots.csv and outputs a per-event Auction Rating score.

Apex lots are the highlights of each sale: its top 10% of lots by apex value
(see apex.py). The rating says how much a highlight at that sale is worth:

  highlight_line_usd = the apex value of the sale's lowest-ranked highlight,
                       i.e. what it took to be a top-10% lot there
  auction_rating     = 100 × highlight_line_usd / the largest line of any sale

The scale is linear, so a highlight at a sale whose line is $5M counts 25
times one at a sale whose line is $200K. That is the point: being a top lot at
Monterey says more than being a top lot at Hershey. Total sales would rank a
high-volume, low-price sale (Mecum Indianapolis) far too high.

A sale under 20 lots has no highlights and a rating of 0, so it carries no
weight in MAI.

apex_sell_through, total_sold_usd and median_sold_usd are reported for
reading the table; they don't enter the rating. apex_from_estimate /
apex_from_sold_price count the highlights ranked each way. An unsold lot with
no estimate can't be ranked, so apex_sell_through reads high at sales that
lean on sold prices.
"""

import os
import sys
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from apex import BASIS_ESTIMATE, BASIS_SOLD_PRICE, add_apex_columns

LOTS_PATH = os.path.join(os.path.dirname(__file__), "..", "auction_lots.csv")
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "auction_ratings.csv")
OUTPUT_COLS = [
    "event", "event_date", "auction_house", "apex_lots", "total_lots",
    "highlight_line_usd", "auction_rating", "apex_sell_through",
    "total_sold_usd", "median_sold_usd", "apex_from_estimate", "apex_from_sold_price",
]


def main():
    df = pd.read_csv(LOTS_PATH)

    if df.empty:
        print("auction_lots.csv is empty — writing empty auction_ratings.csv")
        pd.DataFrame(columns=OUTPUT_COLS).to_csv(OUTPUT_PATH, index=False)
        return

    # Normalise the sold column to boolean
    df["sold"] = df["sold"].astype(str).str.strip().str.lower().isin(["true", "1", "yes"])
    df["high_estimate_usd"] = pd.to_numeric(df["high_estimate_usd"], errors="coerce")
    df["sold_price_usd"] = pd.to_numeric(df["sold_price_usd"], errors="coerce")
    add_apex_columns(df)

    rows = []
    for (event, event_date, auction_house), group in df.groupby(["event", "event_date", "auction_house"]):
        apex = group[group["is_apex"]]
        sold_prices = group.loc[group["sold"], "sold_price_usd"].dropna()
        rows.append({
            "event": event,
            "event_date": event_date,
            "auction_house": auction_house,
            "apex_lots": len(apex),
            "total_lots": len(group),
            "highlight_line_usd": apex["apex_value"].min() if len(apex) else 0.0,
            "apex_sell_through": apex["sold"].mean() if len(apex) else 0.0,
            "total_sold_usd": sold_prices.sum(),
            "median_sold_usd": sold_prices.median() if len(sold_prices) else 0.0,
            "apex_from_estimate": int((apex["apex_basis"] == BASIS_ESTIMATE).sum()),
            "apex_from_sold_price": int((apex["apex_basis"] == BASIS_SOLD_PRICE).sum()),
        })

    out = pd.DataFrame(rows)
    top_line = out["highlight_line_usd"].max()
    out["auction_rating"] = out["highlight_line_usd"] / top_line * 100 if top_line > 0 else 0.0
    out = out[OUTPUT_COLS]

    out.to_csv(OUTPUT_PATH, index=False, float_format="%.4f")
    rated = out[out["apex_lots"] > 0]
    print(f"Wrote {len(out)} event ratings to {os.path.abspath(OUTPUT_PATH)} "
          f"({len(rated)} with highlights; {len(out) - len(rated)} under 20 lots carry no weight)")
    print(f"Apex lots: {int(rated['apex_lots'].sum())} ({int(out['apex_from_estimate'].sum())} "
          f"ranked by high estimate, {int(out['apex_from_sold_price'].sum())} by sold price; "
          "sell-through reads high where sold prices are used)")


if __name__ == "__main__":
    main()
