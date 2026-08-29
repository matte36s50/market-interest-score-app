#!/usr/bin/env python3
"""
Reddit Signals Pipeline — measured enthusiast conversation per model, month.

This is the sub-signal docs/social-score-methodology.md weights most heavily
and the one the social composite has been missing: **mention volume** (0.30)
and **engagement rate** (0.25) from the places enthusiasts actually talk.

  reddit_posts       posts naming the model in that month
  reddit_score       net upvotes on those posts
  reddit_comments    comments on those posts
  reddit_engagement  (score + comments) / posts — interactions per mention,
                     which is the doc's engagement rate normalized by
                     conversation size rather than by raw reach

Deliberately NOT the same thing as the MII's own `comments` input: that
counts comments on the Bring a Trailer listing itself. These are off-platform
mentions, so the two never double-count (methodology doc, §3 "Avoiding
double-counting").

CREDENTIALS. Reddit requires OAuth even for search. Create a free "script"
app at https://www.reddit.com/prefs/apps and set REDDIT_CLIENT_ID and
REDDIT_CLIENT_SECRET. Without them this script exits cleanly and the social
composite simply renormalizes around the missing sub-signals.

RATE LIMIT. OAuth clients get 100 requests/minute, which covers the whole
~3,300-model universe in well under an hour, so unlike the YouTube and Trends
collectors this one usually completes a full pass per run. It still honours
the budget/state rotation so a truncated run resumes where it left off.

Usage:
  export REDDIT_CLIENT_ID=... REDDIT_CLIENT_SECRET=...
  python data/pipelines/reddit_signals.py
  python data/pipelines/reddit_signals.py --limit 5      # smoke test
"""

import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import signal_lib as lib  # noqa: E402

OUTPUT_PATH = os.path.join(lib.DATA_DIR, "reddit_signals.csv")
STATE_PATH = os.path.join(lib.DATA_DIR, "reddit_state.csv")

FIELDS = ["manufacturer", "model", "month",
          "reddit_posts", "reddit_score", "reddit_comments",
          "reddit_engagement", "measured_at"]

TOKEN_URL = "https://www.reddit.com/api/v1/access_token"
SEARCH_URL = "https://oauth.reddit.com/search"
PAGE_SIZE = 100


class RedditClient:
    """Minimal application-only OAuth client for Reddit search."""

    def __init__(self, client_id, client_secret, sleep=0.7):
        self.client_id = client_id
        self.client_secret = client_secret
        self.sleep = sleep
        self.token = None
        self.token_expires = 0.0
        self.requests_made = 0

    def _authenticate(self):
        body = urllib.parse.urlencode({"grant_type": "client_credentials"}).encode()
        basic = base64.b64encode(
            f"{self.client_id}:{self.client_secret}".encode()).decode()
        req = urllib.request.Request(TOKEN_URL, data=body, headers={
            "Authorization": f"Basic {basic}",
            "User-Agent": lib.USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded",
        })
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.load(resp)
        self.token = data["access_token"]
        # Renew a minute early rather than discovering expiry as a 401.
        self.token_expires = time.time() + float(data.get("expires_in", 3600)) - 60

    def _ensure_token(self):
        if not self.token or time.time() >= self.token_expires:
            self._authenticate()

    def search(self, query, after=None, limit=PAGE_SIZE, timespan="year"):
        """One page of link results, plus the cursor for the next page."""
        self._ensure_token()
        params = {
            "q": query, "sort": "new", "limit": limit, "t": timespan,
            "type": "link", "raw_json": 1,
        }
        if after:
            params["after"] = after
        url = SEARCH_URL + "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={
            "Authorization": f"bearer {self.token}",
            "User-Agent": lib.USER_AGENT,
        })
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload = json.load(resp)
                self._respect_rate_limit(resp.headers)
        except urllib.error.HTTPError as exc:
            if exc.code == 401:            # token revoked mid-run
                self.token = None
                self._ensure_token()
                return self.search(query, after=after, limit=limit,
                                   timespan=timespan)
            if exc.code == 429:
                raise lib.RateLimited("Reddit returned 429")
            raise
        self.requests_made += 1
        data = payload.get("data", {})
        children = [c.get("data", {}) for c in data.get("children", [])]
        return children, data.get("after")

    def _respect_rate_limit(self, headers):
        """Sleep out the window when Reddit says we are nearly out of calls."""
        try:
            remaining = float(headers.get("x-ratelimit-remaining", "100"))
            reset = float(headers.get("x-ratelimit-reset", "0"))
        except (TypeError, ValueError):
            return
        if remaining <= 2 and reset > 0:
            print(f"  rate limit nearly spent — sleeping {reset:.0f}s")
            time.sleep(reset + 1)


def is_relevant(post, manufacturer, model):
    """Keep posts whose title actually names the car.

    Reddit's phrase search matches the body too, so a thread that merely
    mentions a model in passing can outrank one about it. Requiring the title
    to carry a manufacturer or distinctive model token keeps the mention count
    closer to "posts about this car".
    """
    hay = lib.tokens(post.get("title", ""))
    wanted = lib.tokens(manufacturer) | {t for t in lib.tokens(model) if len(t) > 2}
    return bool(hay & wanted) if wanted else True


def collect_model(rec, months, client, max_pages):
    """Per-month rows for one model."""
    man, mod = rec["manufacturer"], rec["model"]
    phrase = lib.search_phrase(man, mod)
    month_set = set(months)

    buckets = {}
    after = None
    seen = 0
    for _ in range(max_pages):
        children, after = client.search(f'"{phrase}"', after=after)
        if not children:
            break
        for post in children:
            seen += 1
            if not is_relevant(post, man, mod):
                continue
            try:
                month = lib.month_of(float(post.get("created_utc", 0)))
            except (TypeError, ValueError):
                continue
            if month not in month_set:
                continue
            b = buckets.setdefault(month, {"posts": 0, "score": 0, "comments": 0})
            b["posts"] += 1
            b["score"] += int(post.get("score", 0) or 0)
            b["comments"] += int(post.get("num_comments", 0) or 0)
        if not after or len(children) < PAGE_SIZE:
            break
        time.sleep(client.sleep)

    now = lib.utcnow_iso()
    rows = []
    for month in months:
        b = buckets.get(month)
        if not b:
            continue
        rows.append({
            "manufacturer": man, "model": mod, "month": month,
            "reddit_posts": b["posts"], "reddit_score": b["score"],
            "reddit_comments": b["comments"],
            "reddit_engagement": round((b["score"] + b["comments"]) / b["posts"], 4),
            "measured_at": now,
        })
    return rows, seen


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    lib.add_common_args(ap)
    ap.set_defaults(sleep=0.7)
    ap.add_argument("--budget", type=int, default=4000,
                    help="upstream requests to spend this run")
    ap.add_argument("--months", type=int, default=12,
                    help="trailing complete months to measure")
    ap.add_argument("--max-pages", type=int, default=2,
                    help="result pages per model (100 posts each)")
    ap.add_argument("--client-id", default=os.environ.get("REDDIT_CLIENT_ID", ""))
    ap.add_argument("--client-secret",
                    default=os.environ.get("REDDIT_CLIENT_SECRET", ""))
    args = ap.parse_args()

    if not args.client_id or not args.client_secret:
        print("REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET are not set — "
              "skipping Reddit collection.")
        print("Create a free 'script' app at https://www.reddit.com/prefs/apps")
        return 0

    # Reddit's search only reaches back a year; asking for more months would
    # silently produce empty ones.
    months = lib.month_window(min(args.months, 12))
    universe = lib.load_universe(args.csv, min_auctions=args.min_auctions)
    state = lib.State(STATE_PATH)

    capacity = max(1, args.budget // args.max_pages)
    todo = state.select(universe, args.limit or capacity)
    print(f"Universe {len(universe)} models; processing {len(todo)}")

    client = RedditClient(args.client_id, args.client_secret, sleep=args.sleep)
    collected, empty, failed = [], 0, 0

    for i, rec in enumerate(todo, 1):
        if client.requests_made >= args.budget:
            print("Budget spent — stopping.")
            break
        man, mod = rec["manufacturer"], rec["model"]
        try:
            rows, seen = collect_model(rec, months, client, args.max_pages)
        except lib.RateLimited as exc:
            print(f"  {exc} — stopping and keeping progress.")
            break
        except Exception as exc:  # noqa: BLE001 — one bad model must not end the run
            print(f"  [ERROR] {man} {mod}: {exc}")
            state.mark(man, mod, "error", exc)
            failed += 1
            continue

        if rows:
            collected.extend(rows)
            state.mark(man, mod, "ok", f"{seen} posts scanned")
        else:
            empty += 1
            state.mark(man, mod, "empty", "no posts in window")

        if i % 100 == 0:
            print(f"  {i}/{len(todo)} — {client.requests_made} requests")
            lib.upsert(OUTPUT_PATH, FIELDS, collected)
            state.save()
        time.sleep(args.sleep)

    all_rows = lib.upsert(OUTPUT_PATH, FIELDS, collected)
    state.save()
    covered = len({(r["manufacturer"], r["model"]) for r in all_rows})
    print(f"Made {client.requests_made} requests; {len(collected)} rows this run "
          f"({empty} models with no posts, {failed} errors).")
    print(f"{OUTPUT_PATH}: {len(all_rows)} rows covering {covered}/{len(universe)} models")
    return 0


if __name__ == "__main__":
    sys.exit(main())
