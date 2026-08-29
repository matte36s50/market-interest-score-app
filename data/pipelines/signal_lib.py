#!/usr/bin/env python3
"""
Shared helpers for the measured-signal collectors.

Every collector in this directory follows the same shape, because they all
face the same two constraints: a per-model universe of ~3,300 entries, and an
upstream API with a hard rate or quota limit that cannot cover that universe
in a single run.

  1. Read the model universe from the MII results CSV (manufacturer + model).
  2. Keep a per-model state file recording when each model was last measured.
  3. Spend a per-run budget on the models that need it most (never measured
     first, oldest measurement next), so repeated runs converge on full
     coverage and then keep it fresh on a rolling basis.
  4. Upsert results into a per-model x per-month CSV, so a partial run is
     never destructive and progress always persists.

Stdlib only.
"""

import bisect
import csv
import io
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone

MII_CSV_URL = "https://my-mii-reports.s3.us-east-2.amazonaws.com/mii_results_latest.csv"
DATA_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

USER_AGENT = (
    "MII-Signals-Pipeline/1.0 (market-interest-index; mlotterhand@gmail.com)"
)
DEFAULT_HEADERS = {"User-Agent": USER_AGENT}


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

class RateLimited(Exception):
    """The upstream asked us to back off and we ran out of retries."""


class QuotaExhausted(Exception):
    """The upstream's daily allowance is spent — stop, don't retry."""


# A 429 can mean two very different things: "you are going too fast, slow down"
# (worth retrying) or "your allowance for the day is gone" (retrying only
# wastes the run's remaining time). Google says which in the error body.
_DAILY_QUOTA_MARKERS = (
    "per day", "perday", "1/d/", "dailylimitexceeded", "quotaexceeded",
)


def is_daily_quota_error(body):
    low = (body or "").lower()
    return any(marker in low for marker in _DAILY_QUOTA_MARKERS)


def http_get(url, headers=None, retries=3, timeout=30, opener=None, backoff=2.0):
    """GET a URL, returning decoded text. None on 404.

    Retries on transient errors with linear backoff. Raises RateLimited when
    429s outlive the retry budget, so callers can stop the run and keep the
    progress they already have rather than hammering a limiter.
    """
    hdrs = dict(DEFAULT_HEADERS)
    hdrs.update(headers or {})
    last_429 = False
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=hdrs)
            fetch = opener.open if opener else urllib.request.urlopen
            with fetch(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            if exc.code == 429:
                # Read the body before deciding: a daily-allowance refusal will
                # still be refused in eight seconds, so retrying it just burns
                # the run's clock.
                body = ""
                try:
                    body = exc.read().decode("utf-8", errors="replace")
                except Exception:  # noqa: BLE001
                    pass
                if is_daily_quota_error(body):
                    raise QuotaExhausted(redact(body[:400] or url))
                last_429 = True
                if attempt < retries - 1:
                    time.sleep(backoff * (2 ** attempt) * 2)
                    continue
                raise RateLimited(redact(f"429 from {url}"))
            if attempt == retries - 1:
                raise
            time.sleep(backoff * (attempt + 1))
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(backoff * (attempt + 1))
    if last_429:
        raise RateLimited(redact(f"429 from {url}"))
    return None


def http_get_json(url, headers=None, **kw):
    text = http_get(url, headers=headers, **kw)
    return None if text is None else json.loads(text)


# --------------------------------------------------------------------------
# Model universe
# --------------------------------------------------------------------------

def load_universe(source=MII_CSV_URL, min_auctions=0):
    """Distinct models from the MII results CSV.

    Returns a list of dicts sorted by descending auction_count, so a
    budget-limited run spends its allowance on the models that carry the most
    auction volume — the ones a user is most likely to look at — before the
    long tail.
    """
    if re.match(r"^https?://", source):
        text = http_get(source, timeout=120)
        reader = csv.DictReader(io.StringIO(text))
    else:
        reader = csv.DictReader(open(source, newline="", encoding="utf-8"))

    agg = {}
    for row in reader:
        man = (row.get("manufacturer") or "").strip()
        mod = (row.get("model") or "").strip()
        if not man or not mod or man.lower() == "unknown":
            continue
        rec = agg.setdefault((man, mod), {"manufacturer": man, "model": mod,
                                          "auction_count": 0})
        try:
            rec["auction_count"] += int(float(row.get("auction_count") or 0))
        except ValueError:
            pass

    out = [r for r in agg.values() if r["auction_count"] >= min_auctions]
    out.sort(key=lambda r: (-r["auction_count"], r["manufacturer"], r["model"]))
    return out


# Generation/year qualifiers that help a human read a leaderboard but wreck a
# keyword search ("Ford F-Series 1992-1997" returns nothing on YouTube).
_YEAR_RANGE = re.compile(r"\b(19|20)\d{2}\s*[-–—/]\s*((19|20)?\d{2})\b")
_TRAILING_YEAR = re.compile(r"\s*\b(19|20)\d{2}\b\s*$")


def search_phrase(manufacturer, model):
    """The keyword phrase to search an outside platform for this model.

    Shared by every collector so YouTube, Reddit and Trends all ask about the
    same thing and their sub-signals stay comparable.
    """
    mod = model.strip()
    mod = _YEAR_RANGE.sub("", mod)
    # "Abarth 750 & 850" and "300SL Gullwing & Roadster" are one nameplate with
    # two body styles; search the first, which is the one people name. Only "&"
    # joins two names like that — a slash is usually part of one name
    # ("C/K", "296 GTB/GTS", "105/115 Spider"), so it is left alone.
    parts = [p.strip(" ,;-") for p in mod.split("&")]
    mod = next((p for p in parts if p), "")
    mod = _TRAILING_YEAR.sub("", mod)
    mod = re.sub(r"\s+", " ", mod).strip()

    man = manufacturer.strip()
    if not mod:
        return man
    # Don't say "Porsche Porsche 911".
    if mod.lower().startswith(man.lower()):
        return mod
    return f"{man} {mod}"


_SECRET_PARAM = re.compile(r"(?i)\b((?:api_)?key)=[^&\s]+")


def redact(text):
    """Strip credentials out of anything headed for a log or a state file.

    Collector errors quote the URL that failed, and those URLs carry the API
    key as a query parameter. State files are committed to the repository, so
    an unredacted message would publish the key.
    """
    return _SECRET_PARAM.sub(r"\1=REDACTED", str(text))


def tokens(s):
    return {t for t in re.split(r"[^a-z0-9]+", (s or "").lower()) if len(t) > 1}


# --------------------------------------------------------------------------
# Months
# --------------------------------------------------------------------------

def month_window(months_back=12, today=None):
    """The last `months_back` COMPLETE months, oldest first, as YYYY-MM."""
    today = today or date.today()
    y, m = today.year, today.month
    months = []
    for _ in range(months_back):
        m -= 1
        if m == 0:
            y, m = y - 1, 12
        months.append(f"{y}-{m:02d}")
    months.reverse()
    return months


def month_bounds(month):
    """(first day, first day of next month) for 'YYYY-MM', as date objects."""
    y, m = (int(p) for p in month.split("-"))
    start = date(y, m, 1)
    end = date(y + 1, 1, 1) if m == 12 else date(y, m + 1, 1)
    return start, end


def month_of(iso_timestamp):
    """'2025-11' from an ISO-8601 timestamp or a unix epoch seconds value."""
    if isinstance(iso_timestamp, (int, float)):
        dt = datetime.fromtimestamp(iso_timestamp, tz=timezone.utc)
    else:
        s = str(iso_timestamp).replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
    return f"{dt.year}-{dt.month:02d}"


def utcnow_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------
# Percentile rank (mirrors percentileRanker in mii-normalize.js)
# --------------------------------------------------------------------------

def pct_ranker(values):
    """Mid-rank percentile in [0,1]: (countBelow + countEqual/2) / N."""
    ordered = sorted(values)
    n = len(ordered)

    def rank(x):
        if not n:
            return 0.0
        below = bisect.bisect_left(ordered, x)
        upto = bisect.bisect_right(ordered, x)
        return (below + (upto - below) / 2) / n

    return rank


# --------------------------------------------------------------------------
# CSV upsert
# --------------------------------------------------------------------------

def read_rows(path):
    if not os.path.exists(path):
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write_rows(path, fieldnames, rows):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def upsert(path, fieldnames, new_rows, key=("manufacturer", "model", "month")):
    """Merge new_rows into the CSV at `path`, replacing rows with the same key.

    Returns the full merged row list. A collector that only measured 90 models
    this run therefore leaves the other 3,200 models' rows untouched.
    """
    merged = {}
    for row in read_rows(path) + list(new_rows):
        merged[tuple((row.get(k) or "").strip() for k in key)] = row
    out = sorted(merged.values(),
                 key=lambda r: tuple((r.get(k) or "") for k in key))
    write_rows(path, fieldnames, out)
    # Re-read so the return value is the canonical on-disk state (all strings)
    # rather than a mix of parsed rows and freshly-built ones.
    return read_rows(path)


# --------------------------------------------------------------------------
# Per-model run state (which models are stale, which are hopeless)
# --------------------------------------------------------------------------

STATE_FIELDS = ["manufacturer", "model", "measured_at", "status", "note"]


class State:
    """Per-model record of the last collection attempt.

    Kept in its own CSV rather than inferred from the output rows, because a
    model that legitimately has no data (no videos, no Reddit posts) produces
    no output rows — without this it would look permanently stale and starve
    every other model of the budget.
    """

    def __init__(self, path):
        self.path = path
        self.rows = {}
        for r in read_rows(path):
            self.rows[(r["manufacturer"], r["model"])] = r

    def get(self, man, mod):
        return self.rows.get((man, mod))

    def mark(self, man, mod, status, note=""):
        self.rows[(man, mod)] = {
            "manufacturer": man, "model": mod,
            "measured_at": utcnow_iso(), "status": status,
            "note": redact(note)[:200],
        }

    def save(self):
        write_rows(self.path, STATE_FIELDS,
                   sorted(self.rows.values(),
                          key=lambda r: (r["manufacturer"], r["model"])))

    def select(self, universe, limit, retry_empty_after_days=30):
        """The `limit` models most in need of measurement.

        Never-measured models come first (in the universe's own priority
        order, i.e. highest auction volume first), then the models measured
        longest ago. Models whose last attempt found nothing are held back for
        `retry_empty_after_days` so they don't consume the budget every run.
        """
        never, aged = [], []
        now = datetime.now(timezone.utc)
        for rec in universe:
            st = self.get(rec["manufacturer"], rec["model"])
            if st is None:
                never.append(rec)
                continue
            try:
                when = datetime.strptime(st.get("measured_at", ""),
                                         "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            except ValueError:
                never.append(rec)
                continue
            age_days = (now - when).total_seconds() / 86400
            if st.get("status") == "empty" and age_days < retry_empty_after_days:
                continue
            aged.append((when, rec))
        aged.sort(key=lambda t: t[0])
        return (never + [rec for _, rec in aged])[:limit]


# --------------------------------------------------------------------------
# CLI plumbing shared by the collectors
# --------------------------------------------------------------------------

def add_common_args(ap):
    ap.add_argument("--csv", default=MII_CSV_URL,
                    help="MII results CSV (URL or path) defining the model universe")
    ap.add_argument("--limit", type=int, default=0,
                    help="hard cap on models processed this run (smoke test)")
    ap.add_argument("--min-auctions", type=int, default=0,
                    help="skip models with fewer than this many auctions")
    ap.add_argument("--sleep", type=float, default=0.2,
                    help="pause between upstream calls, seconds")
    return ap
