#!/usr/bin/env python3
"""
Garage Draft → Auction Lots Sync
Pulls manually-entered auction lots from the garage-draft Supabase database
and merges them into data/auction_lots.csv.

Field derivations
-----------------
  price_at_48h  = 0.75 × low_estimate  →  low_estimate  = price_at_48h / 0.75
  high_estimate = low_estimate (conservative proxy; update manually if available)
  sold          = final_price is not null and not reserve_not_met
  auction_house = leading tokens of auction_reference before the year segment

Required environment variables
-------------------------------
  GARAGE_DRAFT_SUPABASE_URL   e.g. https://abcdefgh.supabase.co
  GARAGE_DRAFT_SUPABASE_KEY   Supabase anon key (or service key for private tables)
"""

import csv
import os
import re
import requests
from datetime import datetime, timezone

LOTS_PATH = os.path.join(os.path.dirname(__file__), "..", "auction_lots.csv")

SUPABASE_URL = os.environ.get("GARAGE_DRAFT_SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("GARAGE_DRAFT_SUPABASE_KEY", "")

# price_at_48h is set to 75% of the low pre-sale estimate
BUY_PRICE_FACTOR = 0.75

FIELDNAMES = [
    "event", "event_date", "auction_house", "lot_number", "manufacturer",
    "model", "year_of_car", "low_estimate_usd", "high_estimate_usd",
    "sold_price_usd", "sold", "notes",
]

# Deduplication key — identifies a unique lot across syncs
LOT_KEY = ("event", "manufacturer", "model", "year_of_car")


# ---------------------------------------------------------------------------
# Supabase fetch
# ---------------------------------------------------------------------------

def fetch_auctions() -> list[dict]:
    """
    Pull all auctions that have auction_reference set (i.e. belong to a
    named event — these are the manually-entered top-auction lots).
    Paginates automatically.
    """
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise SystemExit(
            "\nMissing env vars.\n"
            "  export GARAGE_DRAFT_SUPABASE_URL=https://<project>.supabase.co\n"
            "  export GARAGE_DRAFT_SUPABASE_KEY=<anon-or-service-key>\n"
        )

    base_headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Accept": "application/json",
    }
    params = {
        "select": (
            "auction_id,title,make,model,year,"
            "price_at_48h,final_price,timestamp_end,"
            "auction_reference,reserve_not_met"
        ),
        "auction_reference": "not.is.null",
        "order": "timestamp_end.asc",
    }

    all_rows: list[dict] = []
    page = 1000  # Supabase default page size

    while True:
        offset = len(all_rows)
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/auctions",
            headers={
                **base_headers,
                "Range-Unit": "items",
                "Range": f"{offset}-{offset + page - 1}",
                "Prefer": "count=none",
            },
            params=params,
            timeout=30,
        )
        resp.raise_for_status()
        batch = resp.json()
        all_rows.extend(batch)
        if len(batch) < page:
            break

    return all_rows


# ---------------------------------------------------------------------------
# Field mapping
# ---------------------------------------------------------------------------

def parse_auction_house(ref: str) -> str:
    """
    Extract the auction house name from auction_reference.

    Expected formats (examples):
      RM_Sothebys_Amelia_2025    → "RM Sothebys"
      Gooding_Pebble_2025        → "Gooding"
      Bonhams-Scottsdale-2025    → "Bonhams"
      RMSothebys_Geneva_2024     → "RMSothebys"

    Tokens after a 4-digit year (or a city-like token if no year) are dropped.
    Edit this function if your naming convention differs.
    """
    tokens = re.split(r"[_\-\s]+", ref)
    house_tokens = []
    for token in tokens:
        if re.match(r"^\d{4}$", token):
            break
        house_tokens.append(token)
    # Drop the last token if it looks like a city/location (heuristic: it's
    # the token just before the year). Keep everything if only one token.
    if len(house_tokens) > 1:
        house_tokens = house_tokens[:-1]
    return " ".join(house_tokens) if house_tokens else ref


def map_row(raw: dict) -> dict:
    """Map one garage-draft auctions row to the auction_lots.csv schema."""
    ts = raw.get("timestamp_end")
    event_date = (
        datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%d")
        if ts else ""
    )

    ref = raw.get("auction_reference") or ""

    price_at_48h = raw.get("price_at_48h") or 0
    final_price = raw.get("final_price")
    reserve_not_met = bool(raw.get("reserve_not_met"))

    # Derive pre-sale estimates from draft buy price
    low_est = round(price_at_48h / BUY_PRICE_FACTOR) if price_at_48h else ""
    # High estimate not stored in garage-draft; set equal to low as a
    # conservative proxy. Update manually if you have the actual range.
    high_est = low_est

    sold = (
        final_price is not None
        and float(final_price) > 0
        and not reserve_not_met
    )

    return {
        "event": ref,
        "event_date": event_date,
        "auction_house": parse_auction_house(ref),
        "lot_number": "",
        "manufacturer": raw.get("make", ""),
        "model": raw.get("model", ""),
        "year_of_car": raw.get("year", ""),
        "low_estimate_usd": low_est,
        "high_estimate_usd": high_est,
        "sold_price_usd": final_price if sold else "",
        "sold": "true" if sold else "false",
        "notes": raw.get("title", ""),
    }


# ---------------------------------------------------------------------------
# CSV merge
# ---------------------------------------------------------------------------

def load_existing(path: str) -> tuple[list[dict], set[tuple]]:
    """Return (rows, key_set) from the existing CSV. Skips the header row."""
    rows: list[dict] = []
    keys: set[tuple] = set()
    if not os.path.exists(path):
        return rows, keys
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if any(row.values()):  # skip blank rows
                rows.append(row)
                keys.add(tuple(row[k] for k in LOT_KEY))
    return rows, keys


def write_lots(path: str, rows: list[dict]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print("Fetching auction lots from garage-draft …")
    raw_auctions = fetch_auctions()
    print(f"  → {len(raw_auctions)} lots with auction_reference set")

    existing_rows, existing_keys = load_existing(LOTS_PATH)
    new_rows: list[dict] = []

    for raw in raw_auctions:
        mapped = map_row(raw)
        key = tuple(str(mapped[k]) for k in LOT_KEY)
        if key not in existing_keys:
            new_rows.append(mapped)
            existing_keys.add(key)

    if not new_rows:
        print("No new lots to append — auction_lots.csv is already up to date.")
        return

    write_lots(LOTS_PATH, existing_rows + new_rows)
    print(f"Added {len(new_rows)} new lots → {os.path.abspath(LOTS_PATH)}")
    print(f"Total lots now: {len(existing_rows) + len(new_rows)}")
    print()
    print("Note: high_estimate_usd is set equal to low_estimate_usd (derived from")
    print("price_at_48h). Update manually if you have the actual high estimate range.")
    print()
    print("Next:")
    print("  python data/pipelines/auction_rating.py")
    print("  python data/pipelines/mai.py")


if __name__ == "__main__":
    main()
