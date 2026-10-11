#!/usr/bin/env python3
"""
Online auction results -> data/online_lots.csv

Online platforms don't hold sales: a listing closes every few minutes, all
month long. For MAI each platform's completed calendar month counts as one
sale ("Bring a Trailer – March 2026"), so auction_rating.py and mai.py treat
it like any live sale: its top 10% of lots (at most 25, see apex.py) are its
highlights, and the sale is weighted by what it took to be one of them.

Source: Bring a Trailer results from the car-scrapers pipeline (bat.csv in
the public my-mii-reports bucket, refreshed daily). The rows use the
auction_lots.csv schema, so the two files are read together.

- Only completed months: a month still running would move its own line.
- A month with far fewer listings than usual is left out (scraper outages:
  September 2025 and January 2026 hold about a third of a normal month).
  Missing lots would make the month's line read low.
- Sold price is BaT's hammer price, without its buyer's fee (5%, capped at
  $7,500): at the top of a month that is about 1% below an all-in price.
- A "high bid" listing did not sell; its high bid is never a price.
- No estimates: BaT doesn't publish them, so lots rank by sold price.
- EUR and GBP results convert at the ECB rate for the month's last day, one
  lookup per currency and month (EcbRates, as export_live_lots uses).
- Makes go through export_live_lots.make_name, then spellings that differ
  only in case, spaces or hyphens take the most common one (apex.unify_makes):
  'Mercedes Benz' becomes 'Mercedes-Benz', 'Harley Davidson' 'Harley-Davidson'.

With bat.csv unreachable the run warns and leaves online_lots.csv as it is.

Stdlib only.
"""

import argparse
import calendar
import csv
import io
import os
import re
import statistics
import sys
from datetime import date, datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import signal_lib as lib
from apex import unify_makes
from export_live_lots import FIELDNAMES, EcbRates, fmt_num, make_name

BAT_CSV_URL = "https://my-mii-reports.s3.us-east-2.amazonaws.com/bat.csv"
OUT_PATH = os.path.join(lib.DATA_DIR, "online_lots.csv")

PLATFORM = "Bring a Trailer"
PLATFORM_CODE = "BAT"
MIN_MONTH_SHARE = 0.6   # of the median month's listing count
EARLIEST = date(2000, 1, 1)  # "12/31/69" is a missing date, not a 1969 sale

SLUG_YEAR = re.compile(r"^((?:18|19|20)\d\d)-")
AMOUNT = re.compile(r"^\s*([A-Z]{3})?\s*[^\d]*([\d,]+(?:\.\d+)?)")
SLUG = re.compile(r"/listing/([^/?#]+)")


def parse_amount(text):
    """'USD $38,250' -> ('USD', 38250.0); unparseable -> (None, None)."""
    m = AMOUNT.match(str(text or ""))
    if not m:
        return None, None
    return (m.group(1) or "USD"), float(m.group(2).replace(",", ""))


def parse_day(text):
    """BaT's sale_date, '5/19/25' or '10/10/2026' -> date, else None."""
    for fmt in ("%m/%d/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(str(text or "").strip(), fmt).date()
        except ValueError:
            continue
    return None


def clean_model(make, model):
    """BaT repeats the make in the model ('Porsche 918 Spyder'); drop it."""
    model = " ".join(str(model or "").split())
    for prefix in {str(make or "").strip(), make_name(make)}:
        if prefix and model.lower().startswith(prefix.lower() + " "):
            return model[len(prefix) + 1:]
    return model


def car_year(row, slug):
    """bat.csv's year column is mostly empty; the listing slug starts with it."""
    raw = (row.get("year") or "").strip()
    if raw:
        return fmt_num(raw)
    m = SLUG_YEAR.match(slug or "")
    return m.group(1) if m else ""


def month_end(year, month):
    return date(year, month, calendar.monthrange(year, month)[1])


def event_name(year, month):
    return f"{PLATFORM} – {calendar.month_name[month]} {year}"


def build(bat_rows, today, fx):
    """bat.csv rows -> (online_lots rows, report dict).

    `fx(currency, day)` gives USD per unit (EcbRates in production).
    """
    listings, seen = {}, set()
    bad = {"no date": 0, "future date": 0, "no make": 0, "duplicate": 0, "no price": 0}
    for r in bat_rows:
        url = r.get("auction_url") or ""
        if url in seen:
            bad["duplicate"] += 1
            continue
        seen.add(url)
        day = parse_day(r.get("sale_date"))
        if day is None or day < EARLIEST:
            bad["no date"] += 1
            continue
        if day > today:
            bad["future date"] += 1
            continue
        if not (r.get("make") or "").strip():
            bad["no make"] += 1
            continue
        listings.setdefault((day.year, day.month), []).append((day, r))

    this_month = (today.year, today.month)
    completed = {k: v for k, v in listings.items() if k < this_month}
    typical = statistics.median(len(v) for v in completed.values()) if completed else 0
    kept = sorted(k for k, v in completed.items() if len(v) >= MIN_MONTH_SHARE * typical)
    skipped = sorted(k for k in completed if k not in kept)

    out, no_rate = [], {}
    for year, month in kept:
        end = month_end(year, month)
        for day, r in listings[(year, month)]:
            sold = (r.get("sale_type") or "").strip().lower() == "sold"
            currency, amount = parse_amount(r.get("sale_amount"))
            price, note = "", ""
            if sold:
                if amount is None:
                    bad["no price"] += 1
                    continue
                rate = 1.0 if currency == "USD" else fx(currency, end.isoformat())
                if rate is None:
                    no_rate[currency] = no_rate.get(currency, 0) + 1
                    continue
                price = fmt_num(round(amount * rate, 2))
                if currency != "USD":
                    note = f"; {currency} at {rate:.4f} USD"
            m = SLUG.search(r.get("auction_url") or "")
            slug = m.group(1) if m else ""
            out.append({
                "event": event_name(year, month),
                "event_date": end.isoformat(),
                "auction_house": PLATFORM,
                "auction_house_code": PLATFORM_CODE,
                "lot_number": "",
                "manufacturer": make_name(r.get("make")),
                "model": clean_model(r.get("make"), r.get("model")),
                "year_of_car": car_year(r, slug),
                "low_estimate_usd": "",
                "high_estimate_usd": "",
                "sold_price_usd": price,
                "sold": "true" if sold else "false",
                "notes": f"bat:{slug or r.get('auction_url') or ''}{note}",
            })
    spelling = unify_makes(r["manufacturer"] for r in out)   # 'Mercedes Benz' -> 'Mercedes-Benz'
    for r in out:
        r["manufacturer"] = spelling.get(r["manufacturer"], r["manufacturer"])
    out.sort(key=lambda row: (row["event_date"], row["notes"]))
    report = {
        "months": [f"{y}-{m:02d}" for y, m in kept],
        "skipped_months": {f"{y}-{m:02d}": len(completed[(y, m)]) for y, m in skipped},
        "typical_month": typical,
        "bad": {k: v for k, v in bad.items() if v},
        "no_rate": no_rate,
    }
    return out, report


def main(argv=None, fetch=None, fx=None, today=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", default=OUT_PATH)
    ap.add_argument("--dry-run", action="store_true", help="report only; don't write")
    args = ap.parse_args(argv)

    try:
        text = (fetch or (lambda: lib.http_get(BAT_CSV_URL, timeout=180)))()
    except Exception as exc:  # noqa: BLE001 — any fetch failure keeps the last file
        text, err = None, exc
    else:
        err = None
    if not text:
        print(f"::warning::Could not read bat.csv ({lib.redact(str(err)) if err else 'not found'}); "
              f"{os.path.basename(args.out)} left as it is.")
        return 0

    try:
        rows, report = build(csv.DictReader(io.StringIO(text)), today or date.today(), fx or EcbRates())
    except Exception as exc:  # noqa: BLE001 — e.g. an exchange-rate lookup failing
        print(f"::warning::Could not build online lots: {lib.redact(str(exc))}; "
              f"{os.path.basename(args.out)} left as it is.")
        return 0

    print(f"{PLATFORM}: {len(rows)} listings across {len(report['months'])} completed months "
          f"({report['months'][0] if report['months'] else '-'} .. {report['months'][-1] if report['months'] else '-'}); "
          f"typical month {report['typical_month']:.0f} listings")
    for month, n in report["skipped_months"].items():
        print(f"  left out {month}: {n} listings, under {MIN_MONTH_SHARE:.0%} of a typical month (incomplete scrape?)")
    for reason, n in report["bad"].items():
        print(f"  skipped {n}: {reason}")
    for cur, n in report["no_rate"].items():
        print(f"  skipped {n}: no USD rate for {cur}")
    if args.dry_run:
        print("Dry run — nothing written.")
        return 0
    lib.write_rows(args.out, FIELDNAMES, rows)
    print(f"Wrote {len(rows)} lots to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
