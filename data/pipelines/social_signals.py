#!/usr/bin/env python3
"""
Social Signals Pipeline — measured, per-model, per-month attention signals.

Implements the first two sub-signals of the composite specced in
docs/social-score-methodology.md, from a free, reliable, public source
(Wikimedia). Both are measured, time-varying, and computed at the same
manufacturer + model grain as the MII results, so they can never regress
into a static per-brand constant:

  attention  — monthly Wikipedia pageviews for the model's article
  SOV        — the model's share of pageviews within its manufacturer
               (the "share of voice within its segment" from the spec)

social_score = 100 x (0.6 x pctrank(attention) + 0.4 x pctrank(sov))

The 0.6 / 0.4 split is the methodology doc's mention-volume 0.30 and
share-of-voice 0.20 weights renormalized over the sub-signals available
(doc §5: drop missing sub-signals and renormalize — never impute).
Reddit mentions / engagement, YouTube upload counts, and sentiment slot in
as additional columns + weights when their collectors are added.

Model → article resolution uses the MediaWiki search API once per model and
is cached in data/wikipedia_slugs.csv (curate that file by hand to correct
or add mappings; delete a row to force re-resolution). Models that don't
resolve simply have no social signal — the front-end renormalizes around
missing values.

Outputs data/social_signals.csv:
  manufacturer,model,month,wiki_slug,wiki_pageviews,wiki_sov,social_score

Run in CI by .github/workflows/social-signals.yml (monthly). Stdlib only.

Usage:
  python data/pipelines/social_signals.py             # full run vs live S3 CSV
  python data/pipelines/social_signals.py --limit 25  # smoke test
  python data/pipelines/social_signals.py --csv path/to/mii_results.csv
"""

import argparse
import csv
import io
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

MII_CSV_URL = "https://my-mii-reports.s3.us-east-2.amazonaws.com/mii_results_latest.csv"
SLUGS_PATH = os.path.join(os.path.dirname(__file__), "..", "wikipedia_slugs.csv")
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "social_signals.csv")

SEARCH_API = "https://en.wikipedia.org/w/api.php"
PAGEVIEWS_API = "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article"
HEADERS = {
    "User-Agent": "MII-Social-Pipeline/1.0 (market-interest-index; mlotterhand@gmail.com)"
}

MONTHS_BACK = 24          # trailing window of complete months
W_ATTENTION, W_SOV = 0.6, 0.4


def http_get_json(url: str, retries: int = 3):
    """GET a JSON URL with retry/backoff. Returns None on 404."""
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            if exc.code == 429 and attempt < retries - 1:
                time.sleep(5 * (attempt + 1))
                continue
            if attempt == retries - 1:
                raise
            time.sleep(2 * (attempt + 1))
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(2 * (attempt + 1))
    return None


def load_universe(source: str) -> list[tuple[str, str]]:
    """Distinct (manufacturer, model) pairs from the MII results CSV."""
    if re.match(r"^https?://", source):
        req = urllib.request.Request(source, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=60) as resp:
            text = resp.read().decode("utf-8", errors="replace")
        reader = csv.DictReader(io.StringIO(text))
    else:
        reader = csv.DictReader(open(source, newline="", encoding="utf-8"))
    pairs = set()
    for row in reader:
        man = (row.get("manufacturer") or "").strip()
        mod = (row.get("model") or "").strip()
        if man and mod and man.lower() != "unknown":
            pairs.add((man, mod))
    return sorted(pairs)


def tokens(s: str) -> set[str]:
    return {t for t in re.split(r"[^a-z0-9]+", s.lower()) if len(t) > 1}


def resolve_slug(manufacturer: str, model: str) -> str | None:
    """Top Wikipedia search hit for 'manufacturer model', sanity-checked."""
    query = f"{manufacturer} {model}"
    url = (
        SEARCH_API
        + "?action=query&list=search&format=json&srlimit=1&srsearch="
        + urllib.parse.quote(query)
    )
    data = http_get_json(url)
    hits = (data or {}).get("query", {}).get("search", [])
    if not hits:
        return None
    title = hits[0]["title"]
    # The hit must share at least one token with the query, otherwise the
    # search fell back to something unrelated.
    if not (tokens(title) & (tokens(manufacturer) | tokens(model))):
        return None
    return title.replace(" ", "_")


def load_slug_cache() -> dict[tuple[str, str], dict]:
    if not os.path.exists(SLUGS_PATH):
        return {}
    with open(SLUGS_PATH, newline="", encoding="utf-8") as f:
        return {
            (r["manufacturer"], r["model"]): r
            for r in csv.DictReader(f)
        }


def save_slug_cache(cache: dict[tuple[str, str], dict]) -> None:
    with open(SLUGS_PATH, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["manufacturer", "model", "slug", "status"])
        w.writeheader()
        for (man, mod) in sorted(cache):
            row = cache[(man, mod)]
            w.writerow({
                "manufacturer": man,
                "model": mod,
                "slug": row.get("slug", ""),
                "status": row.get("status", ""),
            })


def month_window() -> tuple[list[str], str, str]:
    """Last MONTHS_BACK complete months as YYYY-MM, plus API start/end stamps."""
    today = date.today()
    first_of_this_month = date(today.year, today.month, 1)
    months = []
    y, m = first_of_this_month.year, first_of_this_month.month
    for _ in range(MONTHS_BACK):
        m -= 1
        if m == 0:
            y, m = y - 1, 12
        months.append(f"{y}-{m:02d}")
    months.reverse()
    start = months[0].replace("-", "") + "0100"
    end = first_of_this_month.strftime("%Y%m%d") + "00"
    return months, start, end


def fetch_monthly_views(slug: str, start: str, end: str) -> dict[str, int]:
    url = f"{PAGEVIEWS_API}/en.wikipedia/all-access/all-agents/{urllib.parse.quote(slug)}/monthly/{start}/{end}"
    data = http_get_json(url)
    out: dict[str, int] = {}
    for item in (data or {}).get("items", []):
        ts = item["timestamp"]  # YYYYMMDDHH
        out[f"{ts[:4]}-{ts[4:6]}"] = item["views"]
    return out


def pct_ranker(values: list[float]):
    """Mid-rank percentile in [0,1] — same construction as mii-normalize.js."""
    ordered = sorted(values)
    n = len(ordered)

    def rank(x: float) -> float:
        if not n:
            return 0.0
        import bisect
        below = bisect.bisect_left(ordered, x)
        upto = bisect.bisect_right(ordered, x)
        return (below + (upto - below) / 2) / n

    return rank


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default=MII_CSV_URL,
                    help="MII results CSV (URL or path) that defines the model universe")
    ap.add_argument("--limit", type=int, default=0,
                    help="only process the first N models (smoke test)")
    ap.add_argument("--sleep", type=float, default=0.15,
                    help="pause between API calls, seconds")
    args = ap.parse_args()

    universe = load_universe(args.csv)
    if args.limit:
        universe = universe[: args.limit]
    print(f"Model universe: {len(universe)} models")

    months, start, end = month_window()

    # 1. Resolve models to Wikipedia articles (cached).
    cache = load_slug_cache()
    unresolved_new = 0
    for i, (man, mod) in enumerate(universe):
        if (man, mod) in cache:
            continue
        slug = None
        try:
            slug = resolve_slug(man, mod)
        except Exception as exc:
            print(f"  [ERROR] resolving {man} {mod}: {exc}")
        cache[(man, mod)] = {
            "slug": slug or "",
            "status": "resolved" if slug else "unresolved",
        }
        if not slug:
            unresolved_new += 1
        if i % 100 == 0:
            print(f"  resolution {i}/{len(universe)}")
            save_slug_cache(cache)
        time.sleep(args.sleep)
    save_slug_cache(cache)
    resolved = {
        (man, mod): cache[(man, mod)]["slug"]
        for (man, mod) in universe
        if cache.get((man, mod), {}).get("slug")
    }
    print(f"Resolved {len(resolved)}/{len(universe)} models "
          f"({unresolved_new} newly unresolved)")

    # 2. Fetch monthly pageviews once per distinct article.
    slugs = sorted(set(resolved.values()))
    views_by_slug: dict[str, dict[str, int]] = {}
    for i, slug in enumerate(slugs):
        try:
            views_by_slug[slug] = fetch_monthly_views(slug, start, end)
        except Exception as exc:
            print(f"  [ERROR] pageviews {slug}: {exc}")
            views_by_slug[slug] = {}
        if i % 100 == 0:
            print(f"  pageviews {i}/{len(slugs)}")
        time.sleep(args.sleep)

    # 3. Build model x month rows.
    rows = []
    for (man, mod), slug in resolved.items():
        by_month = views_by_slug.get(slug, {})
        for month in months:
            views = by_month.get(month)
            if views is not None:
                rows.append({
                    "manufacturer": man, "model": mod, "month": month,
                    "wiki_slug": slug, "wiki_pageviews": views,
                })
    print(f"Signal rows: {len(rows)}")

    # 4. Share of voice within the manufacturer, per month.
    totals: dict[tuple[str, str], int] = {}
    for r in rows:
        key = (r["manufacturer"], r["month"])
        totals[key] = totals.get(key, 0) + r["wiki_pageviews"]
    for r in rows:
        total = totals[(r["manufacturer"], r["month"])]
        r["wiki_sov"] = round(r["wiki_pageviews"] / total, 6) if total else 0.0

    # 5. Composite: percentile-rank each sub-signal across all rows, blend.
    if rows:
        rank_views = pct_ranker([r["wiki_pageviews"] for r in rows])
        rank_sov = pct_ranker([r["wiki_sov"] for r in rows])
        for r in rows:
            score = 100 * (W_ATTENTION * rank_views(r["wiki_pageviews"])
                           + W_SOV * rank_sov(r["wiki_sov"]))
            r["social_score"] = round(score, 2)

    rows.sort(key=lambda r: (r["manufacturer"], r["model"], r["month"]))
    with open(OUTPUT_PATH, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=[
            "manufacturer", "model", "month",
            "wiki_slug", "wiki_pageviews", "wiki_sov", "social_score",
        ])
        w.writeheader()
        w.writerows(rows)
    print(f"Wrote {len(rows)} rows to {os.path.abspath(OUTPUT_PATH)}")

    # QA per docs/social-score-methodology.md §7.
    distinct_scores = len({r["social_score"] for r in rows})
    by_model: dict[tuple[str, str], set] = {}
    for r in rows:
        by_model.setdefault((r["manufacturer"], r["model"]), set()).add(r["social_score"])
    varying = sum(1 for v in by_model.values() if len(v) > 1)
    print(f"QA: {distinct_scores} distinct scores; "
          f"{varying}/{len(by_model)} models vary over time")


if __name__ == "__main__":
    main()
