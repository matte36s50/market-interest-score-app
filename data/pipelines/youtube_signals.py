#!/usr/bin/env python3
"""
YouTube Signals Pipeline — measured video attention per model, per month.

Feeds two different things, from one pass over the YouTube Data API:

  youtube_total_views   the MII's YouTube input (weight 0.10), which is
                        currently empty upstream (youtube_source = "missing"
                        on every row), so the input is dropped from the blend
  yt_videos / engagement  sub-signals of the *social* composite, per
                        docs/social-score-methodology.md: "social video" is
                        the count of NEW videos about a model, and engagement
                        is interactions per view. Deliberately different
                        facets from the view total, so the social score and
                        the YouTube input never double-count each other.

Method, per model: one search for the model's phrase over the trailing window
ordered by view count, then one statistics lookup on the results. The videos
are bucketed by the month they were published, giving a per-month series in
two API calls instead of one call per month.

QUOTA. Two separate limits apply and the tighter one is easy to miss. The
YouTube Data API allows 10,000 units/day (search.list costs 100, videos.list
costs 1, so one model costs 101 units and ~89 models fit). A default Google
Cloud project ALSO caps search.list at **100 calls per day** (the quota
`defaultSearchListPerDayPerProject`), and one model is one search — so ~90-100
models/day is the real ceiling either way. Exceeding the search cap returns
HTTP 429 with "Quota exceeded ... per day", not the 403 a units overrun gives,
which is why a 429 here is checked for a daily-allowance message before it is
treated as ordinary throttling.
The full universe is ~3,300 models, so a single run cannot cover it.
This script therefore spends a per-run budget on the staleest models (never
measured first, highest auction volume first within that) and upserts the
results, so daily runs converge on full coverage in ~5 weeks and then keep it
refreshed on a rolling basis. Raise --budget if you have been granted a larger
quota.

Usage:
  export YOUTUBE_API_KEY=...
  python data/pipelines/youtube_signals.py                  # spend the daily budget
  python data/pipelines/youtube_signals.py --limit 3        # smoke test
  python data/pipelines/youtube_signals.py --budget 50000   # raised quota
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import signal_lib as lib  # noqa: E402

API = "https://www.googleapis.com/youtube/v3"
OUTPUT_PATH = os.path.join(lib.DATA_DIR, "youtube_signals.csv")
STATE_PATH = os.path.join(lib.DATA_DIR, "youtube_state.csv")

FIELDS = [
    "manufacturer", "model", "month",
    "yt_videos", "yt_views", "yt_likes", "yt_comments",
    "yt_engagement_rate", "measured_at",
]

SEARCH_COST = 100
VIDEOS_COST = 1
COST_PER_MODEL = SEARCH_COST + VIDEOS_COST


class Quota:
    """Tracks units spent so a run stops before the API starts refusing."""

    def __init__(self, budget):
        self.budget = budget
        self.spent = 0

    def can_afford(self, units):
        return self.spent + units <= self.budget

    def charge(self, units):
        self.spent += units


def yt_get(path, params, api_key):
    """One YouTube Data API call. Raises QuotaExhausted on a quota refusal."""
    params = dict(params)
    params["key"] = api_key
    url = f"{API}/{path}?" + urllib.parse.urlencode(params)
    try:
        return lib.http_get_json(url, retries=3, timeout=30)
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        if "quotaExceeded" in body or "dailyLimitExceeded" in body:
            raise lib.QuotaExhausted(
                "YouTube daily quota exhausted — rerun tomorrow to continue")
        if exc.code in (400, 403):
            reason = body[:300] or str(exc)
            raise RuntimeError(lib.redact(f"YouTube API {exc.code}: {reason}"))
        raise


def search_videos(phrase, published_after, api_key, max_results=50):
    """Most-viewed videos matching the phrase, published since the cutoff."""
    data = yt_get("search", {
        "part": "snippet",
        "q": f'"{phrase}"',
        "type": "video",
        "order": "viewCount",
        "maxResults": max_results,
        "publishedAfter": published_after,
        "relevanceLanguage": "en",
    }, api_key)
    items = (data or {}).get("items", [])
    ids = [i["id"]["videoId"] for i in items if i.get("id", {}).get("videoId")]
    total = (data or {}).get("pageInfo", {}).get("totalResults", 0)
    titles = {i["id"]["videoId"]: i.get("snippet", {})
              for i in items if i.get("id", {}).get("videoId")}
    return ids, titles, total


def video_stats(video_ids, api_key):
    """publishedAt + statistics for up to 50 video ids, in one call."""
    if not video_ids:
        return []
    data = yt_get("videos", {
        "part": "snippet,statistics",
        "id": ",".join(video_ids[:50]),
        "maxResults": 50,
    }, api_key)
    return (data or {}).get("items", [])


def is_relevant(snippet, manufacturer, model):
    """Guard against a quoted-phrase search drifting to unrelated videos.

    Requires the manufacturer (or a distinctive model token) to appear in the
    title or description. Deliberately loose — a model's own name is often
    written differently by uploaders ("560SL" for an R107 SL) — but it does
    catch a search that fell through to something else entirely.
    """
    hay = lib.tokens((snippet.get("title") or "") + " " +
                     (snippet.get("description") or ""))
    wanted = lib.tokens(manufacturer) | {t for t in lib.tokens(model) if len(t) > 2}
    return bool(hay & wanted) if wanted else True


def collect_model(rec, months, published_after, api_key, quota):
    """Per-month rows for one model. Charges the quota for the calls made."""
    man, mod = rec["manufacturer"], rec["model"]
    phrase = lib.search_phrase(man, mod)

    # Charge before the call: a request that fails has still been made, and a
    # budget that only counts successes can overrun the real quota.
    quota.charge(SEARCH_COST)
    ids, snippets, total_results = search_videos(phrase, published_after, api_key)
    if not ids:
        return [], 0, total_results

    quota.charge(VIDEOS_COST)
    items = video_stats(ids, api_key)

    month_set = set(months)
    buckets = {}
    kept = 0
    for item in items:
        snip = item.get("snippet", {})
        if not is_relevant(snip, man, mod):
            continue
        published = snip.get("publishedAt")
        if not published:
            continue
        try:
            month = lib.month_of(published)
        except ValueError:
            continue
        if month not in month_set:
            continue
        stats = item.get("statistics", {})

        def num(key):
            try:
                return int(stats.get(key, 0) or 0)
            except (TypeError, ValueError):
                return 0

        b = buckets.setdefault(month, {"videos": 0, "views": 0,
                                       "likes": 0, "comments": 0})
        b["videos"] += 1
        b["views"] += num("viewCount")
        b["likes"] += num("likeCount")
        b["comments"] += num("commentCount")
        kept += 1

    now = lib.utcnow_iso()
    rows = []
    for month in months:
        b = buckets.get(month)
        if not b:
            continue
        engagement = ((b["likes"] + b["comments"]) / b["views"]) if b["views"] else 0.0
        rows.append({
            "manufacturer": man, "model": mod, "month": month,
            "yt_videos": b["videos"], "yt_views": b["views"],
            "yt_likes": b["likes"], "yt_comments": b["comments"],
            "yt_engagement_rate": round(engagement, 6),
            "measured_at": now,
        })
    return rows, kept, total_results


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    lib.add_common_args(ap)
    ap.add_argument("--budget", type=int, default=9000,
                    help="API units to spend this run (daily quota is 10,000)")
    ap.add_argument("--max-searches", type=int, default=95,
                    help="search.list calls this run; a default Google Cloud "
                         "project is capped at 100/day, separately from units")
    ap.add_argument("--months", type=int, default=12,
                    help="trailing complete months to measure")
    ap.add_argument("--max-throttles", type=int, default=5,
                    help="stop the run after this many 429s in a row")
    ap.add_argument("--api-key", default=os.environ.get("YOUTUBE_API_KEY", ""))
    args = ap.parse_args()

    if not args.api_key:
        print("YOUTUBE_API_KEY is not set — skipping YouTube collection.")
        print("Create a key at https://console.cloud.google.com/apis/credentials "
              "with the YouTube Data API v3 enabled.")
        return 0

    months = lib.month_window(args.months)
    published_after = lib.month_bounds(months[0])[0].strftime("%Y-%m-%dT00:00:00Z")

    universe = lib.load_universe(args.csv, min_auctions=args.min_auctions)
    state = lib.State(STATE_PATH)
    quota = Quota(args.budget)

    # Whichever ceiling bites first: the unit budget or the per-day search cap.
    affordable = min(max(0, args.budget // COST_PER_MODEL), args.max_searches)
    todo = state.select(universe, args.limit or affordable)
    print(f"Universe {len(universe)} models; budget {args.budget} units "
          f"({affordable} models); processing {len(todo)}")

    collected, empty, failed, throttled = [], 0, 0, 0
    for i, rec in enumerate(todo, 1):
        if not quota.can_afford(COST_PER_MODEL):
            print("Budget spent — stopping.")
            break
        man, mod = rec["manufacturer"], rec["model"]
        try:
            rows, kept, total = collect_model(rec, months, published_after,
                                              args.api_key, quota)
        except lib.QuotaExhausted as exc:
            print("  Daily YouTube allowance is spent — stopping and keeping "
                  "progress; the next run resumes from here.")
            print(f"  {exc}")
            break
        except lib.RateLimited:
            # Not a quota refusal — YouTube is asking us to slow down. Leave
            # the model unmarked so the next run picks it up again.
            throttled += 1
            print(f"  throttled on {man} {mod} "
                  f"({throttled}/{args.max_throttles}) — backing off")
            if throttled >= args.max_throttles:
                print("  YouTube is throttling us — stopping and keeping progress.")
                break
            time.sleep(args.sleep * 20)
            continue
        except Exception as exc:  # noqa: BLE001 — one bad model must not end the run
            print(f"  [ERROR] {man} {mod}: {lib.redact(exc)}")
            state.mark(man, mod, "error", exc)
            failed += 1
            continue

        throttled = 0
        if rows:
            collected.extend(rows)
            state.mark(man, mod, "ok", f"{kept} videos, ~{total} matches")
        else:
            empty += 1
            state.mark(man, mod, "empty", "no videos in window")

        if i % 25 == 0:
            print(f"  {i}/{len(todo)} — {quota.spent} units spent")
            # Checkpoint: upsert is keyed and idempotent, so re-writing the
            # same rows at the end of the run is harmless.
            lib.upsert(OUTPUT_PATH, FIELDS, collected)
            state.save()
        time.sleep(args.sleep)

    all_rows = lib.upsert(OUTPUT_PATH, FIELDS, collected)
    state.save()

    covered = len({(r["manufacturer"], r["model"]) for r in all_rows})
    print(f"Spent {quota.spent}/{args.budget} units. "
          f"{len(collected)} rows written this run "
          f"({empty} models with no videos, {failed} errors).")
    print(f"{OUTPUT_PATH}: {len(all_rows)} rows covering {covered}/{len(universe)} models")
    return 0


if __name__ == "__main__":
    sys.exit(main())
