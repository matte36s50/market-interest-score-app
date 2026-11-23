#!/usr/bin/env python3
"""
Canonical auction store -> data/room_heat.csv and data/lot_heat.csv

Bidding heat, read from the auction houses' own livestreams: every bid of a
lot, with its time in the video, is parsed from the stream's captions into the
store (auction.live_bids), checked against the published result, and scored
there by two views, auction.lot_heat and auction.room_heat. This copies their
anon-readable twins, public.auction_lot_heat and public.auction_room_heat, to
the two CSVs that mai.html's "Bidding heat" section reads.

Heat is shown beside the Apex score and never enters it: it covers only the
sales whose streams have been parsed, and it measures how hard the room fought
for a lot, not how high the lot sits in the market.

What the store computes
-----------------------
Lot heat (0 to 100) is the average percentile rank of three things: bids
placed at or above the low estimate, how fast they came (median seconds
between them), and the result as a multiple of the low estimate.
lot_heat_in_sale ranks a lot within its own session; lot_heat_across_sales
against every parsed lot. Each lot also gets a label:

  high competition  3+ bids past the low estimate, coming faster than the
                    session's median pace past the low
  coaxed            3+ bids past the low, at least one after the auctioneer
                    had started to close ("fair warning") and reopened
  steady            3+ bids past the low, neither of the above
  passed            not sold in the room
  quiet             sold with fewer than 3 bids past the low

Room heat (0 to 100) is the average percentile rank, across sessions, of
sell-through, the share sold above the high estimate, the median result as a
multiple of the low, the median bids past the low and the median pace past
the low. room_heat_market_only ranks only sessions without a flag in
auction.session_flags (a single-owner celebrity collection sold without
reserve, say), so such a sale can't set the bar for the market;
room_heat_all_sales ranks every session.

Normalisation
-------------
House, sale and make names go through export_live_lots.py's own tables, so a
sale here keys exactly as it does in auction_lots.csv and the ranking. Store
rows written before the rename still say "contested"; they are read as "high
competition". Lots in export_live_lots.EXCLUDED_LOTS stay out here too.

Environment
-----------
  CANONICAL_SUPABASE_URL       https://<project>.supabase.co
  CANONICAL_SUPABASE_ANON_KEY  the project's anon key

With either unset the run is skipped and both CSVs are left as they are. If
the views can't be read, the run fails without writing, and yesterday's files
stay published.

  --from-json PATH  build from a saved {"lots": [...], "rooms": [...]} export
                    of the two views instead of reading the store

Stdlib only.
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import signal_lib as lib
import export_live_lots as live

LOT_HEAT_PATH = os.path.join(lib.DATA_DIR, "lot_heat.csv")
ROOM_HEAT_PATH = os.path.join(lib.DATA_DIR, "room_heat.csv")
LOT_VIEW = "auction_lot_heat"
ROOM_VIEW = "auction_room_heat"
PAGE = 1000

LOT_FIELDNAMES = [
    "event", "event_date", "auction_house", "auction_house_code", "session", "session_date",
    "video_id", "session_flagged", "session_flags", "lot_number", "year_of_car", "manufacturer",
    "model", "currency", "low_estimate", "high_estimate", "result_in_room", "last_bid",
    "multiple_of_low", "bids", "bids_past_low", "sec_per_bid_past_low", "sec_per_bid_before_low",
    "closing_calls_revived", "heat_in_sale", "heat_across_sales", "heat_label", "lot_url",
    "listing_id",
]

ROOM_FIELDNAMES = [
    "event", "event_date", "auction_house", "auction_house_code", "session", "session_date",
    "video_id", "flagged", "flags", "lots_offered", "lots_sold", "sell_through",
    "share_sold_above_high", "median_multiple_of_low", "median_bids_past_low",
    "median_sec_per_bid_past_low", "median_sec_per_bid_before_low",
    "passed_median_high_bid_vs_low", "high_competition_lots", "coaxed_lots",
    "room_heat_all_sales", "room_heat_market_only",
]

# Labels the store used before a rename, read as the current one.
LABELS = {"contested": "high competition"}
KNOWN_LABELS = {"high competition", "coaxed", "steady", "passed", "quiet"}


def _bool(value):
    return "true" if value is True or str(value).lower() == "true" else "false"


def _house(value):
    """(display name, code) for a store house value; raises UnknownAuctionHouse."""
    code = live.house_code(value)
    if not code:
        raise live.UnknownAuctionHouse({str(value)})
    return live.HOUSES[code], code


def _event(value):
    name = " ".join(str(value or "").split())
    return live.EVENT_NAMES.get(name, name)


def _session(r):
    return " ".join(str(r.get("session_label") or "").split())


def to_lot_row(r):
    """A public.auction_lot_heat row -> (csv row, None) or (None, reason)."""
    listing_id = r.get("source_listing_id") or ""
    if listing_id in live.EXCLUDED_LOTS:
        return None, "excluded by hand"
    if not r.get("event"):
        return None, "no event"
    label = LABELS.get(r.get("heat_label"), r.get("heat_label"))
    if label not in KNOWN_LABELS:
        return None, f"unknown heat label {r.get('heat_label')!r}"
    house, code = _house(r.get("auction_house"))
    return {
        "event": _event(r["event"]),
        "event_date": str(r.get("event_date") or "")[:10],
        "auction_house": house,
        "auction_house_code": code,
        "session": _session(r),
        "session_date": str(r.get("session_on") or "")[:10],
        "video_id": r.get("video_id") or "",
        "session_flagged": _bool(r.get("session_flagged")),
        "session_flags": r.get("session_flags") or "",
        "lot_number": str(r.get("lot") or ""),
        "year_of_car": "" if r.get("year") is None else str(r["year"]),
        "manufacturer": live.make_name(r.get("make")),
        "model": " ".join(str(r.get("model") or "").split()),
        "currency": (r.get("currency") or "USD").upper(),
        "low_estimate": live.fmt_num(r.get("estimate_low")),
        "high_estimate": live.fmt_num(r.get("estimate_high")),
        "result_in_room": "sold" if r.get("result_in_room") == "SOLD" else "not sold",
        "last_bid": live.fmt_num(r.get("last_bid")),
        "multiple_of_low": live.fmt_num(r.get("multiple_of_low")),
        "bids": live.fmt_num(r.get("n_bids")),
        "bids_past_low": live.fmt_num(r.get("bids_past_low")),
        "sec_per_bid_past_low": live.fmt_num(r.get("sec_per_bid_past_low")),
        "sec_per_bid_before_low": live.fmt_num(r.get("sec_per_bid_before_low")),
        "closing_calls_revived": live.fmt_num(r.get("closing_calls_revived")),
        "heat_in_sale": live.fmt_num(r.get("lot_heat_in_sale")),
        "heat_across_sales": live.fmt_num(r.get("lot_heat_across_sales")),
        "heat_label": label,
        "lot_url": live.lot_url(r.get("url")),
        "listing_id": listing_id,
    }, None


def to_room_row(r):
    """A public.auction_room_heat row -> csv row (raises UnknownAuctionHouse)."""
    house, code = _house(r.get("auction_house"))
    high = r.get("high_competition_lots", r.get("contested_lots"))
    return {
        "event": _event(r.get("event")),
        "event_date": str(r.get("event_date") or "")[:10],
        "auction_house": house,
        "auction_house_code": code,
        "session": _session(r),
        "session_date": str(r.get("session_on") or "")[:10],
        "video_id": r.get("video_id") or "",
        "flagged": _bool(r.get("flagged")),
        "flags": " ".join(str(r.get("flags") or "").split()),
        "lots_offered": live.fmt_num(r.get("lots_offered")),
        "lots_sold": live.fmt_num(r.get("lots_sold")),
        "sell_through": live.fmt_num(r.get("sell_through")),
        "share_sold_above_high": live.fmt_num(r.get("share_sold_above_high")),
        "median_multiple_of_low": live.fmt_num(r.get("median_multiple_of_low")),
        "median_bids_past_low": live.fmt_num(r.get("median_bids_past_low")),
        "median_sec_per_bid_past_low": live.fmt_num(r.get("median_sec_per_bid_past_low")),
        "median_sec_per_bid_before_low": live.fmt_num(r.get("median_sec_per_bid_before_low")),
        "passed_median_high_bid_vs_low": live.fmt_num(r.get("passed_lots_median_high_bid_vs_low")),
        "high_competition_lots": live.fmt_num(high),
        "coaxed_lots": live.fmt_num(r.get("coaxed_lots")),
        "room_heat_all_sales": live.fmt_num(r.get("room_heat_all_sales")),
        "room_heat_market_only": live.fmt_num(r.get("room_heat_market_only")),
    }


def _lot_sort(row):
    m = re.match(r"\d+", row["lot_number"])
    return (row["event_date"], row["event"], row["session_date"], row["session"],
            int(m.group()) if m else 10**9, row["lot_number"])


def _room_sort(row):
    return (row["event_date"], row["event"], row["session_date"], row["session"], row["video_id"])


def build(lot_rows, room_rows):
    """View rows -> (lot csv rows, room csv rows, skip reasons).

    Raises UnknownAuctionHouse naming every house value that resolves to none.
    """
    lots, rooms, skipped, unknown = [], [], {}, set()
    for r in lot_rows:
        try:
            row, reason = to_lot_row(r)
        except live.UnknownAuctionHouse as exc:
            unknown.update(exc.values)
            continue
        if row is None:
            skipped[reason] = skipped.get(reason, 0) + 1
        else:
            lots.append(row)
    for r in room_rows:
        try:
            rooms.append(to_room_row(r))
        except live.UnknownAuctionHouse as exc:
            unknown.update(exc.values)
    if unknown:
        raise live.UnknownAuctionHouse(unknown)
    lots.sort(key=_lot_sort)
    rooms.sort(key=_room_sort)
    return lots, rooms, skipped


def fetch_view(base_url, key, view, order, get_json=lib.http_get_json):
    """Page through a view. Raises SystemExit(str) if it can't be read."""
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    rows, offset = [], 0
    while True:
        query = urllib.parse.urlencode({"select": "*", "order": order, "limit": PAGE, "offset": offset})
        try:
            page = get_json(f"{base_url.rstrip('/')}/rest/v1/{view}?{query}", headers=headers)
        except urllib.error.HTTPError as exc:
            message = str(live.store_error(exc).code).replace(live.VIEW, view)
            raise SystemExit(message) from None
        if page is None:
            raise SystemExit(f"::error::{view} not found in the store. Apply the heat views "
                             "(auction_heat_high_competition_and_public_views) first.")
        rows.extend(page)
        if len(page) < PAGE:
            return rows
        offset += PAGE


def fetch_heat(base_url, key, get_json=lib.http_get_json):
    lots = fetch_view(base_url, key, LOT_VIEW, "event_date.asc,event.asc,source_listing_id.asc", get_json)
    rooms = fetch_view(base_url, key, ROOM_VIEW, "event_date.asc,event.asc,video_id.asc", get_json)
    return lots, rooms


def main(argv=None, fetch=fetch_heat):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--lots-out", default=LOT_HEAT_PATH)
    ap.add_argument("--rooms-out", default=ROOM_HEAT_PATH)
    ap.add_argument("--from-json", help="build from a saved export of the two views")
    ap.add_argument("--dry-run", action="store_true", help="report only; don't write")
    args = ap.parse_args(argv)

    if args.from_json:
        with open(args.from_json, encoding="utf-8") as f:
            saved = json.load(f)
        lot_rows, room_rows = saved.get("lots") or [], saved.get("rooms") or []
    else:
        url = os.environ.get("CANONICAL_SUPABASE_URL", "").strip()
        key = os.environ.get("CANONICAL_SUPABASE_ANON_KEY", "").strip()
        if not url or not key:
            print("CANONICAL_SUPABASE_URL / CANONICAL_SUPABASE_ANON_KEY not set — "
                  "skipping the heat export; lot_heat.csv and room_heat.csv left as they are.")
            return 0
        try:
            lot_rows, room_rows = fetch(url, key)
        except SystemExit as exc:
            if not isinstance(exc.code, str):
                raise
            print(exc.code)  # stdout: where Actions reads ::error:: annotations
            return 1
        except (urllib.error.URLError, OSError, ValueError, lib.RateLimited) as exc:
            print(f"::error::Could not read the heat views: {lib.redact(str(exc))}. Nothing written.")
            return 1

    try:
        lots, rooms, skipped = build(lot_rows, room_rows)
    except live.UnknownAuctionHouse as exc:
        print(f"::error::{exc} Nothing written.")
        return 1
    if not rooms:
        print("::warning::The heat views returned no sessions. Nothing written.")
        return 0

    labels = {}
    for r in lots:
        labels[r["heat_label"]] = labels.get(r["heat_label"], 0) + 1
    print(f"Heat: {len(rooms)} sessions across {len({r['event'] for r in rooms})} sales, "
          f"{len(lots)} lots (" + ", ".join(f"{n} {k}" for k, n in sorted(labels.items())) + ")")
    for reason, n in sorted(skipped.items()):
        print(f"  skipped {n}: {reason}")
    if not args.dry_run:
        lib.write_rows(args.lots_out, LOT_FIELDNAMES, lots)
        lib.write_rows(args.rooms_out, ROOM_FIELDNAMES, rooms)
        print(f"Wrote {args.lots_out} and {args.rooms_out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
