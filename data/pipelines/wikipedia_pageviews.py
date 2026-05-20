#!/usr/bin/env python3
"""
Wikipedia Pageview Pipeline — MII-N module
Fetches daily pageviews for seed classic car models from the Wikimedia REST API.
Idempotent: re-running appends only dates not already in the output CSV.
"""

import csv
import os
import time
import requests
from datetime import date, timedelta

ARTICLE_SLUGS = [
    "Porsche_911",
    "BMW_M3",
    "Lamborghini_Countach",
    "Ferrari_Testarossa",
    "Honda_NSX",
    "Nissan_Fairlady_Z",
    "Shelby_Mustang",
    "Toyota_FJ40",
    "Land_Rover_Defender",
    "Mazda_MX-5_Miata",
]

OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "wikipedia_pageviews.csv")
API_BASE = "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article"
HEADERS = {
    "User-Agent": "MII-Wikipedia-Pipeline/1.0 (market-interest-index; mlotterhand@gmail.com)"
}


def fetch_pageviews(slug: str, start: str, end: str) -> list[dict]:
    """Fetch daily pageviews for one article. start/end are YYYYMMDD strings."""
    url = f"{API_BASE}/en.wikipedia/all-access/all-agents/{slug}/daily/{start}00/{end}00"
    resp = requests.get(url, headers=HEADERS, timeout=30)
    if resp.status_code == 404:
        print(f"  [SKIP] {slug} — 404 not found")
        return []
    resp.raise_for_status()
    return [
        {"model": slug, "date": item["timestamp"][:8], "pageviews": item["views"]}
        for item in resp.json().get("items", [])
    ]


def load_existing(path: str) -> set[tuple]:
    """Return set of (model, date) tuples already present in the output CSV."""
    if not os.path.exists(path):
        return set()
    with open(path, newline="", encoding="utf-8") as f:
        return {(r["model"], r["date"]) for r in csv.DictReader(f)}


def main():
    today = date.today()
    start_str = (today - timedelta(days=365)).strftime("%Y%m%d")
    end_str = today.strftime("%Y%m%d")

    existing = load_existing(OUTPUT_PATH)
    new_rows: list[dict] = []

    for slug in ARTICLE_SLUGS:
        print(f"Fetching {slug} …")
        try:
            rows = fetch_pageviews(slug, start_str, end_str)
        except requests.RequestException as exc:
            print(f"  [ERROR] {slug}: {exc}")
            continue

        added = 0
        for row in rows:
            key = (row["model"], row["date"])
            if key not in existing:
                new_rows.append(row)
                existing.add(key)
                added += 1
        print(f"  → {added} new rows")
        time.sleep(0.5)  # polite rate limiting

    if not new_rows:
        print("No new data to append.")
        return

    write_header = not os.path.exists(OUTPUT_PATH)
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["model", "date", "pageviews"])
        if write_header:
            writer.writeheader()
        writer.writerows(new_rows)

    print(f"\nAppended {len(new_rows)} rows to {os.path.abspath(OUTPUT_PATH)}")


if __name__ == "__main__":
    main()
