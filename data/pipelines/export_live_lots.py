#!/usr/bin/env python3
"""
Canonical auction store -> data/auction_lots.csv

Live-auction lots (RM Sotheby's, Gooding, Broad Arrow, Bonhams, ...) are
entered in the canonical auction store, through the /store panel in
garage-draft's admin app. This rebuilds data/auction_lots.csv from the
store's public.auction_live_lots view, so auction_rating.py and mai.py run
unchanged on whatever the store holds.

Only ended lots are exported: a lot still at the estimate stage has no
outcome, and counting it as unsold would drag every sell-through figure
down. Withdrawn lots are dropped for the same reason. Prices are the
fee-inclusive price_all_in where the store has one, else the hammer price.

Currency: Live Entry converts to USD as it writes, but lots that reached the
store another way (the game mirror's European sales) keep their own currency.
Those are converted here, price and estimates alike, at the ECB reference
rate for the sale date, from the same source Live Entry uses
(frankfurter.dev). A currency with no published rate skips the lot and says
so; a failed rate lookup fails the run, so a network blip can't quietly drop
every European sale from MAI.

Environment
-----------
  CANONICAL_SUPABASE_URL       https://<project>.supabase.co
  CANONICAL_SUPABASE_ANON_KEY  the project's anon key (the view is anon-readable)

With either unset the run is skipped and the CSV left as it is.

Safety
------
The lots already in the CSV were entered by hand before the store existed.
If an event in the current CSV is missing from the store, the export stops
without writing, rather than silently dropping those lots from MAI. Import
the event through /store (Live Entry), or pass --allow-drop-events once
it's there under a different name.

Stdlib only.
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import signal_lib as lib

LOTS_PATH = os.path.join(lib.DATA_DIR, "auction_lots.csv")
VIEW = "auction_live_lots"
PAGE = 1000

FIELDNAMES = [
    "event", "event_date", "auction_house", "lot_number", "manufacturer",
    "model", "year_of_car", "low_estimate_usd", "high_estimate_usd",
    "sold_price_usd", "sold", "notes",
]

SELECT = ",".join([
    "event", "auction_house", "event_date", "source_listing_id", "year",
    "make", "model", "trim", "status", "outcome", "price", "price_all_in",
    "currency", "estimate_low", "estimate_high", "needs_review",
])

LOT_ID = re.compile(r"-lot-([^/]+)$")
FX_URL = "https://api.frankfurter.dev/v1/{day}?base={cur}&symbols=USD"
ISO_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")


class EcbRates:
    """USD per 1 unit of a currency on a sale date (ECB reference rates).

    A weekend or holiday resolves to the last business day, and a future or
    missing date uses the latest rate — the same conventions as the admin
    app's lib/fx.js. Cached per (currency, day). Returns None when the source
    has no rate for the currency (HTTP 404); any other failure raises.
    """

    def __init__(self, get_json=lib.http_get_json, today=None):
        self.get_json = get_json
        self.today = today or date.today().isoformat()
        self.cache = {}

    def __call__(self, currency, day):
        cur = str(currency or "USD").upper()
        if cur == "USD":
            return 1.0
        d = str(day or "")[:10]
        if not ISO_DAY.fullmatch(d) or d > self.today:
            d = "latest"
        key = (cur, d)
        if key not in self.cache:
            data = self.get_json(FX_URL.format(day=d, cur=urllib.parse.quote(cur)))
            rate = ((data or {}).get("rates") or {}).get("USD")
            self.cache[key] = float(rate) if isinstance(rate, (int, float)) and rate > 0 else None
        return self.cache[key]


def fmt_num(value):
    """600000.0 -> '600000', 123.456 -> '123.46', None -> ''."""
    if value is None or value == "":
        return ""
    n = float(value)
    return str(int(n)) if n.is_integer() else f"{n:.2f}"


def to_csv_row(r, fx=None):
    """Map one auction_live_lots row to the auction_lots.csv schema.

    `fx(currency, day)` gives USD per unit for a non-USD lot (EcbRates in
    production). Returns (row, None) or (None, reason) when the lot can't be
    exported.
    """
    if r.get("status") != "ended":
        return None, "not ended"
    outcome = r.get("outcome")
    if outcome == "withdrawn":
        return None, "withdrawn"
    if not r.get("event"):
        return None, "no event"
    if not r.get("event_date"):
        return None, "no date"

    currency = (r.get("currency") or "USD").upper()
    rate = 1.0
    if currency != "USD":
        rate = fx(currency, r["event_date"]) if fx else None
        if rate is None:
            return None, f"no USD rate for {currency}"

    def usd(value):
        return None if value is None else round(float(value) * rate, 2)

    sold = outcome == "sold"
    price = r.get("price_all_in")
    if price is None:
        price = r.get("price")

    listing_id = r.get("source_listing_id") or ""
    m = LOT_ID.search(listing_id)
    model = " ".join(p for p in (r.get("model"), r.get("trim")) if p)
    notes = f"store:{listing_id}" + ("; needs review" if r.get("needs_review") else "")
    if currency != "USD":
        notes += f"; {currency} at {rate:.4f} USD"

    return {
        "event": r["event"],
        "event_date": str(r["event_date"])[:10],
        "auction_house": r.get("auction_house") or "",
        "lot_number": m.group(1) if m else "",
        "manufacturer": r.get("make") or "",
        "model": model,
        "year_of_car": fmt_num(r.get("year")),
        "low_estimate_usd": fmt_num(usd(r.get("estimate_low"))),
        "high_estimate_usd": fmt_num(usd(r.get("estimate_high"))),
        "sold_price_usd": fmt_num(usd(price)) if sold else "",
        "sold": "true" if sold else "false",
        "notes": notes,
    }, None


def sort_key(row):
    lot = row["lot_number"]
    return (row["event_date"], row["event"],
            (0, int(lot), "") if lot.isdigit() else (1, 0, lot))


def store_error(exc):
    """A readable failure from a store HTTP error, with PostgREST's own message.

    PostgREST answers a cancelled statement (Supabase's short anon
    statement_timeout) with a bare 500; its JSON body is the only place that
    says so, and urllib's exception text doesn't include it.
    """
    detail = ""
    try:
        body = exc.read().decode("utf-8", errors="replace")
        parsed = json.loads(body) if body else {}
        detail = " ".join(str(parsed.get(k)) for k in ("code", "message", "hint") if parsed.get(k))
        detail = detail or body[:300]
    except Exception:  # noqa: BLE001 — a missing or odd body must not hide the status
        pass
    message = f"Store returned HTTP {exc.code} reading {VIEW}: {lib.redact(detail) or exc.reason}"
    if "57014" in detail or "statement timeout" in detail.lower():
        message += (". The anon role's statement timeout cancelled the query: re-run "
                    "auction-store/schema.sql so the view reads through idx_listings_event.")
    return SystemExit(f"::error::{message}")


def fetch_live_lots(base_url, key, get_json=lib.http_get_json):
    """Page through the view. Raises if the view isn't deployed."""
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    rows, offset = [], 0
    while True:
        query = urllib.parse.urlencode({
            "select": SELECT,
            "order": "event_date.asc,event.asc,source_listing_id.asc",
            "limit": PAGE,
            "offset": offset,
        })
        try:
            page = get_json(f"{base_url.rstrip('/')}/rest/v1/{VIEW}?{query}", headers=headers)
        except urllib.error.HTTPError as exc:
            raise store_error(exc) from None
        if page is None:
            raise SystemExit(
                f"{VIEW} not found. Re-run auction-store/schema.sql from "
                "cc-market-survey in the store's Supabase SQL editor.")
        rows.extend(page)
        if len(page) < PAGE:
            return rows
        offset += PAGE


def build(store_rows, fx=None):
    """Store rows -> (csv rows, Counter-like dict of skip reasons)."""
    out, skipped = [], {}
    for r in store_rows:
        row, reason = to_csv_row(r, fx)
        if row is None:
            skipped[reason] = skipped.get(reason, 0) + 1
        else:
            out.append(row)
    out.sort(key=sort_key)
    return out, skipped


def dropped_events(existing_rows, new_rows):
    """Events in the current CSV that the export would remove."""
    before = {r.get("event", "") for r in existing_rows if r.get("event")}
    after = {r["event"] for r in new_rows}
    return sorted(before - after)


def main(argv=None, fetch=fetch_live_lots, fx=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", default=LOTS_PATH)
    ap.add_argument("--allow-drop-events", action="store_true",
                    help="write even if events in the current CSV are missing from the store")
    ap.add_argument("--dry-run", action="store_true", help="report only; don't write")
    args = ap.parse_args(argv)

    url = os.environ.get("CANONICAL_SUPABASE_URL", "").strip()
    key = os.environ.get("CANONICAL_SUPABASE_ANON_KEY", "").strip()
    if not url or not key:
        print("CANONICAL_SUPABASE_URL / CANONICAL_SUPABASE_ANON_KEY not set — "
              "skipping the store export; auction_lots.csv left as it is.")
        return 0

    try:
        store_rows = fetch(url, key)
    except SystemExit as exc:
        if not isinstance(exc.code, str):
            raise
        print(exc.code)  # stdout: where Actions reads ::error:: annotations
        return 1
    try:
        rows, skipped = build(store_rows, fx or EcbRates())
    except (urllib.error.URLError, OSError, ValueError, lib.RateLimited, lib.QuotaExhausted) as exc:
        print(f"::error::Could not fetch the exchange rates needed for non-USD lots: "
              f"{lib.redact(str(exc))}. Nothing written; the next run retries.")
        return 1
    converted = sum(1 for r in rows if r["notes"].endswith(" USD"))
    events = sorted({r["event"] for r in rows})
    print(f"Store: {len(store_rows)} live lots -> {len(rows)} exported "
          f"across {len(events)} events ({converted} converted to USD)")
    for reason, n in sorted(skipped.items()):
        print(f"  skipped {n}: {reason}")

    existing = lib.read_rows(args.out)
    missing = dropped_events(existing, rows)
    if missing and not args.allow_drop_events:
        print(f"::warning::Not writing {os.path.basename(args.out)}: "
              f"{len(missing)} event(s) in it are not in the store yet: "
              + "; ".join(missing)
              + ". Import them through /store Live Entry, or rerun with "
              "--allow-drop-events once they're in under another name.")
        return 0

    if args.dry_run:
        print("Dry run — nothing written.")
        return 0
    lib.write_rows(args.out, FIELDNAMES, rows)
    print(f"Wrote {len(rows)} lots to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
