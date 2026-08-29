#!/usr/bin/env python3
"""
Social Signals Pipeline — the measured social composite for the MII.

Builds data/social_signals.csv: one row per manufacturer x model x month, with
a 0-100 `social_score` that the front-end joins into the MII's Social input.
It replaced a static per-brand constant (19 distinct values, 93% of brands
pinned to one default) with something measured and time-varying.

This script does two jobs:

  1. COLLECT the Wikipedia sub-signals itself — monthly article pageviews and
     the model's share of pageviews within its manufacturer.
  2. BLEND every available sub-signal into the composite, reading the other
     collectors' outputs (reddit_signals.csv, youtube_signals.csv) as they
     land. Those collectors run independently and on their own budgets, so
     this step is written to work with whatever subset exists today.

WEIGHTS follow docs/social-score-methodology.md §3:

  mention volume  0.30   mean of the ranks of Wikipedia pageviews and Reddit
                         post count — two readings of the same underlying
                         "how much is this car being looked up / talked about"
  engagement rate 0.25   Reddit interactions per post
  share of voice  0.20   the model's share of its manufacturer's attention
  social video    0.15   count of new YouTube videos about the model
  sentiment       0.10   not collected yet

A sub-signal a row has no value for is dropped from that row's blend and the
remaining weights are renormalized (never impute a default). So a row with
Wikipedia data only still scores on attention 0.30 / SOV 0.20 -> 0.6 / 0.4,
exactly as it did before the other collectors existed, and gains precision as
they fill in.

Model -> article resolution uses the MediaWiki search API once per model and is
cached in data/wikipedia_slugs.csv (hand-curate that file to fix a mapping;
delete a row to force re-resolution).

Usage:
  python data/pipelines/social_signals.py              # refresh wiki if stale, blend
  python data/pipelines/social_signals.py --reuse-wiki # blend only, no API calls
  python data/pipelines/social_signals.py --limit 25   # smoke test
"""

import argparse
import os
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import signal_lib as lib  # noqa: E402

SLUGS_PATH = os.path.join(lib.DATA_DIR, "wikipedia_slugs.csv")
OUTPUT_PATH = os.path.join(lib.DATA_DIR, "social_signals.csv")
YOUTUBE_PATH = os.path.join(lib.DATA_DIR, "youtube_signals.csv")
REDDIT_PATH = os.path.join(lib.DATA_DIR, "reddit_signals.csv")

SEARCH_API = "https://en.wikipedia.org/w/api.php"
PAGEVIEWS_API = "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article"

MONTHS_BACK = 24

FIELDS = [
    "manufacturer", "model", "month", "wiki_slug",
    "wiki_pageviews", "wiki_sov",
    "reddit_posts", "reddit_engagement", "yt_videos",
    "social_score",
]

# (weight, [columns that can supply it]) — several columns for one sub-signal
# means "average the ranks of whichever are present".
SUB_SIGNALS = [
    ("mention",    0.30, ["wiki_pageviews", "reddit_posts"]),
    ("engagement", 0.25, ["reddit_engagement"]),
    ("sov",        0.20, ["wiki_sov"]),
    ("video",      0.15, ["yt_videos"]),
    # sentiment 0.10 — no collector yet; its weight renormalizes away.
]


# --------------------------------------------------------------------------
# Wikipedia collection
# --------------------------------------------------------------------------

def resolve_slug(manufacturer, model):
    """Top Wikipedia search hit for 'manufacturer model', sanity-checked."""
    query = f"{manufacturer} {model}"
    url = (SEARCH_API
           + "?action=query&list=search&format=json&srlimit=1&srsearch="
           + urllib.parse.quote(query))
    data = lib.http_get_json(url)
    hits = (data or {}).get("query", {}).get("search", [])
    if not hits:
        return None
    title = hits[0]["title"]
    # The hit must share a token with the query, otherwise the search fell
    # through to something unrelated.
    if not (lib.tokens(title) & (lib.tokens(manufacturer) | lib.tokens(model))):
        return None
    return title.replace(" ", "_")


def load_slug_cache():
    return {(r["manufacturer"], r["model"]): r for r in lib.read_rows(SLUGS_PATH)}


def save_slug_cache(cache):
    lib.write_rows(SLUGS_PATH, ["manufacturer", "model", "slug", "status"], [
        {"manufacturer": man, "model": mod,
         "slug": cache[(man, mod)].get("slug", ""),
         "status": cache[(man, mod)].get("status", "")}
        for (man, mod) in sorted(cache)
    ])


def fetch_monthly_views(slug, start, end):
    url = (f"{PAGEVIEWS_API}/en.wikipedia/all-access/all-agents/"
           f"{urllib.parse.quote(slug)}/monthly/{start}/{end}")
    data = lib.http_get_json(url)
    out = {}
    for item in (data or {}).get("items", []):
        ts = item["timestamp"]  # YYYYMMDDHH
        out[f"{ts[:4]}-{ts[4:6]}"] = item["views"]
    return out


def collect_wikipedia(universe, months, sleep):
    """Wikipedia rows: [{manufacturer, model, month, wiki_slug, wiki_pageviews}]."""
    start = months[0].replace("-", "") + "0100"
    end = lib.month_bounds(months[-1])[1].strftime("%Y%m%d") + "00"

    cache = load_slug_cache()
    newly_unresolved = 0
    for i, rec in enumerate(universe):
        key = (rec["manufacturer"], rec["model"])
        if key in cache:
            continue
        slug = None
        try:
            slug = resolve_slug(*key)
        except Exception as exc:  # noqa: BLE001
            print(f"  [ERROR] resolving {key[0]} {key[1]}: {exc}")
        cache[key] = {"slug": slug or "",
                      "status": "resolved" if slug else "unresolved"}
        if not slug:
            newly_unresolved += 1
        if i % 100 == 0:
            print(f"  resolution {i}/{len(universe)}")
            save_slug_cache(cache)
        time.sleep(sleep)
    save_slug_cache(cache)

    resolved = {(r["manufacturer"], r["model"]): cache[(r["manufacturer"], r["model"])]["slug"]
                for r in universe
                if cache.get((r["manufacturer"], r["model"]), {}).get("slug")}
    print(f"Resolved {len(resolved)}/{len(universe)} models "
          f"({newly_unresolved} newly unresolved)")

    views_by_slug = {}
    slugs = sorted(set(resolved.values()))
    for i, slug in enumerate(slugs):
        try:
            views_by_slug[slug] = fetch_monthly_views(slug, start, end)
        except Exception as exc:  # noqa: BLE001
            print(f"  [ERROR] pageviews {slug}: {exc}")
            views_by_slug[slug] = {}
        if i % 100 == 0:
            print(f"  pageviews {i}/{len(slugs)}")
        time.sleep(sleep)

    rows = []
    for (man, mod), slug in resolved.items():
        by_month = views_by_slug.get(slug, {})
        for month in months:
            views = by_month.get(month)
            if views is not None:
                rows.append({"manufacturer": man, "model": mod, "month": month,
                             "wiki_slug": slug, "wiki_pageviews": views})
    return rows


def wiki_rows_from_existing(months):
    """Reuse the Wikipedia columns already in the output CSV — no API calls."""
    keep = set(months)
    rows = []
    for r in lib.read_rows(OUTPUT_PATH):
        if r.get("month") not in keep:
            continue
        views = (r.get("wiki_pageviews") or "").strip()
        if not views:
            continue
        rows.append({"manufacturer": r["manufacturer"], "model": r["model"],
                     "month": r["month"], "wiki_slug": r.get("wiki_slug", ""),
                     "wiki_pageviews": int(float(views))})
    return rows


def wiki_is_stale(months):
    """True when the output CSV is missing the most recent complete month."""
    existing = lib.read_rows(OUTPUT_PATH)
    if not existing:
        return True
    newest = max((r.get("month") or "") for r in existing)
    return newest < months[-1]


# --------------------------------------------------------------------------
# Composite
# --------------------------------------------------------------------------

def index_by_key(path, columns):
    """{(manufacturer, model, month): {col: float}} from a collector's CSV."""
    out = {}
    for r in lib.read_rows(path):
        key = (r.get("manufacturer", "").strip(), r.get("model", "").strip(),
               r.get("month", "").strip())
        vals = {}
        for col in columns:
            raw = (r.get(col) or "").strip()
            if raw:
                try:
                    vals[col] = float(raw)
                except ValueError:
                    pass
        if vals:
            out[key] = vals
    return out


def add_share_of_voice(rows):
    """Model's share of its manufacturer's Wikipedia pageviews that month."""
    totals = {}
    for r in rows:
        views = r.get("wiki_pageviews")
        if views is None:
            continue
        key = (r["manufacturer"], r["month"])
        totals[key] = totals.get(key, 0) + views
    for r in rows:
        views = r.get("wiki_pageviews")
        if views is None:
            continue
        total = totals.get((r["manufacturer"], r["month"]), 0)
        r["wiki_sov"] = round(views / total, 6) if total else 0.0


def score_rows(rows):
    """Write social_score onto each row from the sub-signals it has."""
    rankers = {}
    for _, _, columns in SUB_SIGNALS:
        for col in columns:
            values = [r[col] for r in rows if r.get(col) is not None]
            if values:
                rankers[col] = lib.pct_ranker(values)

    for r in rows:
        total, weight_used = 0.0, 0.0
        for _, weight, columns in SUB_SIGNALS:
            ranks = [rankers[c](r[c]) for c in columns
                     if c in rankers and r.get(c) is not None]
            if not ranks:
                continue
            total += weight * (sum(ranks) / len(ranks))
            weight_used += weight
        r["social_score"] = round(100 * total / weight_used, 2) if weight_used else ""


def report(rows):
    """QA against docs/social-score-methodology.md §7."""
    scored = [r for r in rows if r.get("social_score") != ""]
    distinct = len({r["social_score"] for r in scored})
    by_model = {}
    for r in scored:
        by_model.setdefault((r["manufacturer"], r["model"]), set()).add(r["social_score"])
    varying = sum(1 for v in by_model.values() if len(v) > 1)
    print(f"QA: {distinct} distinct scores across {len(scored)} rows; "
          f"{varying}/{len(by_model)} models vary over time")
    for name, weight, columns in SUB_SIGNALS:
        for col in columns:
            n = sum(1 for r in rows if r.get(col) is not None)
            print(f"  {name:<10} {col:<18} {n:>6} rows "
                  f"({100 * n / max(1, len(rows)):5.1f}% coverage, weight {weight})")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    lib.add_common_args(ap)
    ap.set_defaults(sleep=0.15)
    ap.add_argument("--months", type=int, default=MONTHS_BACK,
                    help="trailing complete months to cover")
    ap.add_argument("--reuse-wiki", action="store_true",
                    help="blend from the Wikipedia data already on disk, no API calls")
    ap.add_argument("--force-wiki", action="store_true",
                    help="always refresh Wikipedia, even when it is up to date")
    args = ap.parse_args()

    months = lib.month_window(args.months)

    if args.reuse_wiki:
        wiki = wiki_rows_from_existing(months)
        print(f"Reusing {len(wiki)} Wikipedia rows already on disk")
    elif not args.force_wiki and not wiki_is_stale(months):
        wiki = wiki_rows_from_existing(months)
        print(f"Wikipedia data already covers {months[-1]} — "
              f"reusing {len(wiki)} rows (use --force-wiki to refresh anyway)")
    else:
        universe = lib.load_universe(args.csv, min_auctions=args.min_auctions)
        if args.limit:
            universe = universe[:args.limit]
        print(f"Model universe: {len(universe)} models")
        wiki = collect_wikipedia(universe, months, args.sleep)
        print(f"Wikipedia rows: {len(wiki)}")

    # Union of every (model, month) any collector has something for, so a
    # model with Reddit or YouTube data but no Wikipedia article still scores.
    rows_by_key = {}
    for r in wiki:
        rows_by_key[(r["manufacturer"], r["model"], r["month"])] = dict(r)

    external = [
        (REDDIT_PATH, ["reddit_posts", "reddit_engagement"]),
        (YOUTUBE_PATH, ["yt_videos"]),
    ]
    for path, columns in external:
        table = index_by_key(path, columns)
        print(f"{os.path.basename(path)}: {len(table)} model-months")
        for key, vals in table.items():
            if key[2] not in months:
                continue
            row = rows_by_key.get(key)
            if row is None:
                row = {"manufacturer": key[0], "model": key[1], "month": key[2]}
                rows_by_key[key] = row
            row.update(vals)

    rows = list(rows_by_key.values())
    add_share_of_voice(rows)
    score_rows(rows)

    rows.sort(key=lambda r: (r["manufacturer"], r["model"], r["month"]))
    lib.write_rows(OUTPUT_PATH, FIELDS, rows)
    print(f"Wrote {len(rows)} rows to {OUTPUT_PATH}")
    report(rows)
    return 0


if __name__ == "__main__":
    sys.exit(main())
