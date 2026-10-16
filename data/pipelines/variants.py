#!/usr/bin/env python3
"""
Variants — index constituents, matched one listing at a time.

data/models.csv names models the way Bring a Trailer groups them, which is
roughly a generation ("W113 SL", "993 911 Turbo", "250 GT"). An index like
HAGI's names cars one level finer: the 911 Carrera RS 2.7 Lightweight, the
250 GT SWB California Spider, the 280SE 3.5 Cabriolet. data/variants.csv
holds those, in the levels CLASSIC.COM uses — make, model (family),
generation, variant — and says how to recognise each in a listing title:

  makes    the listing's make (any of a ;-separated list)
  years    the model years the variant was built
  match    a regex on the title, as Bring a Trailer's URL spells it
           ("1973 porsche 911 carrera rs 2 7 lightweight")
  exclude  a regex that rules a title out

Replicas, recreations, tributes and continuation cars are ruled out for every
variant.

Run: python3 data/pipelines/variants.py [--bat PATH] [--index hagi-p]
prints, for each variant, the listings it finds and their prices.
"""

import argparse
import csv
import os
import re
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import signal_lib as lib  # noqa: E402

VARIANTS_PATH = os.path.join(lib.DATA_DIR, "variants.csv")
BAT_CSV_URL = "https://my-mii-reports.s3.us-east-2.amazonaws.com/bat.csv"

# Replicas and the firms best known for building them, whatever the title
# calls the car ("1955 beck 550 spyder").
NOT_THE_CAR = re.compile(
    r"\b(replica|recreation|tribute|continuation|clone|evocation|homage|kit|reimagined|"
    r"re ?creation|re ?body|rebodied|conver(sion|ted) to|"
    r"beck|intermeccanica|superformance|factory five|backdraft|kirkham|chamonix|apal|"
    r"vintage speedsters?|thoroughbred motorsports|everett morrison|shell valley|"
    r"contemporary classics?|special edition speedster|cmc)\b")

# A sold price under this share of the variant's median is flagged for a
# look: a title that does not admit to being a replica, a project, a shell.
SUSPECT_SHARE = 0.4


def load_variants(path=VARIANTS_PATH):
    out = []
    for r in lib.read_rows(path):
        vid = (r.get("id") or "").strip()
        if not vid or vid.startswith("#"):
            continue
        lo, _, hi = (r.get("years") or "").partition("-")
        out.append({
            **r,
            "makes": {m.strip().lower() for m in (r.get("makes") or "").split(";") if m.strip()},
            "from": int(lo) if lo.strip().isdigit() else None,
            "to": int(hi) if hi.strip().isdigit() else None,
            "match_re": re.compile(r["match"]),
            "exclude_re": re.compile(r["exclude"]) if (r.get("exclude") or "").strip() else None,
            "index_list": [i for i in (r.get("indexes") or "").split(";") if i],
        })
    return out


def title_of(url):
    """'https://bringatrailer.com/listing/1973-porsche-911-carrera-rs-2-7/' ->
    '1973 porsche 911 carrera rs 2 7'."""
    slug = (url or "").rstrip("/").rsplit("/", 1)[-1]
    return slug.replace("-", " ").lower()


def year_of(title, fallback=None):
    m = re.match(r"(19|20)\d{2}\b", title)
    if m:
        return int(m.group(0))
    try:
        return int(float(fallback))
    except (TypeError, ValueError):
        return None


def matches(variant, make, title, year):
    if variant["makes"] and (make or "").strip().lower() not in variant["makes"]:
        return False
    if year is None or (variant["from"] and year < variant["from"]) or (variant["to"] and year > variant["to"]):
        return False
    if NOT_THE_CAR.search(title):
        return False
    if variant["exclude_re"] and variant["exclude_re"].search(title):
        return False
    return bool(variant["match_re"].search(title))


def _amount(text):
    m = re.search(r"([\d,]+(?:\.\d+)?)", text or "")
    return float(m.group(1).replace(",", "")) if m else None


def report(rows, variants, index=None):
    """Per variant: listings found, sold, median sold price (USD), latest sale."""
    found = {v["id"]: [] for v in variants}
    for row in rows:
        if (row.get("category") or "").strip().lower() in ("parts", "wheels"):
            continue
        title = title_of(row.get("auction_url"))
        year = year_of(title, row.get("year"))
        for v in variants:
            if matches(v, row.get("make"), title, year):
                found[v["id"]].append(row)
    out = []
    for v in variants:
        if index and index not in v["index_list"]:
            continue
        lots = found[v["id"]]
        sold = [r for r in lots if (r.get("sale_type") or "").strip().lower() == "sold"]
        usd = [_amount(r.get("sale_amount")) for r in sold if "USD" in (r.get("sale_amount") or "")]
        usd = [a for a in usd if a]
        med = statistics.median(usd) if usd else None
        suspect = [title_of(r.get("auction_url")) for r in sold
                   if med and "USD" in (r.get("sale_amount") or "")
                   and (_amount(r.get("sale_amount")) or 0) < SUSPECT_SHARE * med]
        out.append({
            "id": v["id"], "variant": v["variant"], "indexes": v["indexes"],
            "listings": len(lots), "sold": len(sold), "suspect": suspect,
            "median_usd": med,
            "latest": max((r.get("sale_date") or "" for r in lots), default=""),
            "examples": [title_of(r.get("auction_url")) for r in lots[:3]],
        })
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bat", default=BAT_CSV_URL, help="bat.csv (URL or path)")
    ap.add_argument("--index", help="only this index (hagi-top, hagi-f, hagi-p, mbci, mbci-emerging, bmw-ci)")
    args = ap.parse_args()
    csv.field_size_limit(10 ** 9)
    if re.match(r"^https?://", args.bat):
        import io
        rows = list(csv.DictReader(io.StringIO(lib.http_get(args.bat, timeout=180))))
    else:
        rows = list(csv.DictReader(open(args.bat, newline="", encoding="utf-8")))
    out = report(rows, load_variants(), args.index)
    for r in out:
        price = f"${r['median_usd']:,.0f}" if r["median_usd"] else "-"
        print(f"{r['listings']:4d} listings {r['sold']:3d} sold  {price:>12}  {r['variant']}  [{r['indexes']}]")
        for t in r["suspect"]:
            print(f"{'':32}check: {t}")
    have = sum(1 for r in out if r["listings"])
    print(f"\n{have} of {len(out)} variants have at least one listing in {len(rows):,} Bring a Trailer listings")
    return 0


if __name__ == "__main__":
    sys.exit(main())
