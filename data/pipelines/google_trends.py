#!/usr/bin/env python3
"""
Google Trends Pipeline — measured search interest per model, per month.

Fills the MII's `google_trends_interest` input (weight 0.15), which is
currently empty for all 14,807 upstream rows (`google_trends_source =
"missing"`), so the input is dropped from every car's blend.

THE COMPARABILITY PROBLEM. Google Trends never returns absolute search
volume. It returns values scaled 0-100 *within a single request*, so "Porsche
911 = 100" in one request and "Datsun 240Z = 100" in another say nothing about
each other. A request takes at most 5 keywords, and the MII universe is ~3,300
models, so the results have to be stitched together.

The fix is an ANCHOR: every batch asks for the same reference keyword plus 4
models. Because the anchor's true search volume is constant across batches,
the ratio (model / anchor) is comparable everywhere, and multiplying it by a
fixed reference level puts every model on one scale:

    trends_interest = 100 x (model's monthly value / anchor's window mean)

THE RESOLUTION PROBLEM, and why there is more than one anchor. Trends reports
integers, with the batch maximum pinned to 100. Anchor a batch on a heavily
searched term and everything much smaller than it rounds to 0 — the first
full production run, anchored on "Porsche 911" alone, returned every month as
zero for 814 of 1,574 models (52%). Those models are not tied in reality;
they were quantized into a tie.

So anchors form a LADDER of descending popularity, chained to each other:

    Porsche 911  --calibrate-->  Datsun 240Z  --calibrate-->  Lancia Fulvia
        tier 0                      tier 1                       tier 2

Each adjacent pair is measured together in one calibration request, giving
that anchor's level relative to the one above it (and so, by chaining, to the
primary). Pairs are measured rather than all anchors at once for exactly the
reason the ladder exists: the bottom anchor would round to 0 against the top.

A model is measured against its tier's anchor and multiplied by that anchor's
relative level, which keeps every tier on the primary's scale. A model whose
months all come back zero is demoted one tier and retried on the next run,
where a smaller anchor gives it room to register. A model that is still zero
at the bottom of the ladder genuinely has no measurable search volume.

BACKENDS.
  trends  (default) the public trends.google.com endpoints, no key needed.
          Google rate-limits these aggressively, especially from cloud IPs;
          the run backs off, then stops and keeps its progress. Repeated runs
          converge because each one resumes from the staleest models.
  serpapi opt-in, set SERPAPI_API_KEY. A paid proxy for the same data that
          does not rate-limit, for when the free path is being blocked.

Usage:
  python data/pipelines/google_trends.py                 # spend the run budget
  python data/pipelines/google_trends.py --limit 8       # smoke test
  python data/pipelines/google_trends.py --anchors "A,B,C"  # custom ladder
  SERPAPI_API_KEY=... python data/pipelines/google_trends.py --backend serpapi
"""

import argparse
import http.cookiejar
import re
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import signal_lib as lib  # noqa: E402

OUTPUT_PATH = os.path.join(lib.DATA_DIR, "google_trends.csv")
STATE_PATH = os.path.join(lib.DATA_DIR, "google_trends_state.csv")

FIELDS = ["manufacturer", "model", "month",
          "trends_interest", "trends_source", "measured_at"]

EXPLORE_URL = "https://trends.google.com/trends/api/explore"
MULTILINE_URL = "https://trends.google.com/trends/api/widgetdata/multiline"
SERPAPI_URL = "https://serpapi.com/search.json"

BATCH_KEYWORDS = 5          # Google Trends' hard limit per request

# Descending search popularity. Each rung must be close enough to the one
# above it that both register in a single request, or the chain breaks.
DEFAULT_ANCHORS = ["Porsche 911", "Datsun 240Z", "Lancia Fulvia"]
BROWSER_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def strip_xssi(text):
    """Trends prefixes its JSON with an anti-hijacking guard: )]}',\\n"""
    idx = text.find("{")
    return text[idx:] if idx > 0 else text


class TrendsBackend:
    """Reads the public trends.google.com endpoints directly."""

    name = "google_trends"

    def __init__(self, geo="", hl="en-US", tz=0, sleep=3.0):
        self.geo, self.hl, self.tz, self.sleep = geo, hl, tz, sleep
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar))
        self.headers = {"User-Agent": BROWSER_UA,
                        "Accept-Language": "en-US,en;q=0.9"}
        self._primed = False

    def _prime(self):
        """Trends rejects API calls without the consent/NID cookies."""
        if self._primed:
            return
        try:
            lib.http_get("https://trends.google.com/trends/?geo=US",
                         headers=self.headers, opener=self.opener, retries=2)
        except Exception as exc:  # noqa: BLE001 — the API call reports the real failure
            print(f"  [warn] could not prime Trends cookies: {exc}")
        self._primed = True

    def fetch(self, keywords, time_range):
        """Monthly series per keyword: {keyword: {'YYYY-MM': float}}."""
        self._prime()
        req = {
            "comparisonItem": [
                {"keyword": k, "geo": self.geo, "time": time_range}
                for k in keywords
            ],
            "category": 0,
            "property": "",
        }
        url = (f"{EXPLORE_URL}?hl={self.hl}&tz={self.tz}&req="
               + urllib.parse.quote(json.dumps(req, separators=(",", ":"))))
        text = lib.http_get(url, headers=self.headers, opener=self.opener,
                            retries=3, backoff=self.sleep)
        if not text:
            return {}
        widgets = json.loads(strip_xssi(text)).get("widgets", [])
        widget = next((w for w in widgets if w.get("id") == "TIMESERIES"), None)
        if not widget:
            return {}

        time.sleep(self.sleep)
        url = (f"{MULTILINE_URL}?hl={self.hl}&tz={self.tz}&req="
               + urllib.parse.quote(json.dumps(widget["request"],
                                               separators=(",", ":")))
               + "&token=" + urllib.parse.quote(widget["token"]))
        text = lib.http_get(url, headers=self.headers, opener=self.opener,
                            retries=3, backoff=self.sleep)
        if not text:
            return {}
        timeline = json.loads(strip_xssi(text)).get("default", {}).get(
            "timelineData", [])
        return weekly_to_monthly(timeline, keywords)


class SerpApiBackend:
    """Same data through SerpAPI, for when Google blocks the direct path."""

    name = "serpapi"

    def __init__(self, api_key, geo="", sleep=1.0):
        self.api_key, self.geo, self.sleep = api_key, geo, sleep

    def fetch(self, keywords, time_range):
        params = {
            "engine": "google_trends",
            "q": ",".join(keywords),
            "data_type": "TIMESERIES",
            "date": time_range,
            "api_key": self.api_key,
        }
        if self.geo:
            params["geo"] = self.geo
        data = lib.http_get_json(SERPAPI_URL + "?" + urllib.parse.urlencode(params),
                                 retries=3, timeout=60)
        timeline = ((data or {}).get("interest_over_time", {})
                    .get("timeline_data", []))
        return weekly_to_monthly(timeline, keywords, serpapi=True)


def weekly_to_monthly(timeline, keywords, serpapi=False):
    """Average a weekly Trends series into calendar months.

    Trends returns weekly points for a multi-month range. A week is credited
    to the month its start date falls in, and the month's value is the mean of
    its weeks, so a 4-week and a 5-week month are on the same footing.
    """
    sums = {k: {} for k in keywords}
    counts = {k: {} for k in keywords}
    for point in timeline:
        if point.get("isPartial"):
            continue
        try:
            month = lib.month_of(int(point["timestamp"] if serpapi else point["time"]))
        except (KeyError, ValueError, TypeError):
            continue
        # SerpAPI returns "values" (objects); Trends itself returns "value"
        # (a bare list, one entry per keyword in request order).
        values = (point.get("values") if serpapi else point.get("value")) or []
        for i, keyword in enumerate(keywords):
            if i >= len(values):
                break
            raw = values[i]
            if serpapi:
                val = raw.get("extracted_value", raw.get("value"))
            else:
                val = raw
            try:
                val = float(val)
            except (TypeError, ValueError):
                continue
            sums[keyword][month] = sums[keyword].get(month, 0.0) + val
            counts[keyword][month] = counts[keyword].get(month, 0) + 1
    return {
        k: {m: sums[k][m] / counts[k][m] for m in sums[k]}
        for k in keywords
    }


def series_mean(series, keyword, months):
    present = [series[keyword][m] for m in months if m in series.get(keyword, {})]
    return sum(present) / len(present) if present else 0.0


def rescale_batch(series, anchor, models, months, relative_level=1.0,
                  anchor_level=100.0):
    """Put a batch's models onto the shared, primary-anchor scale.

    `relative_level` is this tier's anchor expressed as a fraction of the
    primary anchor (1.0 for the primary itself), so a model measured three
    rungs down the ladder still lands on the same scale as one at the top.

    Returns (rows_by_model, anchor_mean). An anchor mean of 0 means the batch
    is unusable — every value in it was normalized against something that
    registered no search volume of its own.
    """
    anchor_mean = series_mean(series, anchor, months)
    if anchor_mean <= 0:
        return {}, 0.0

    scale = anchor_level * relative_level / anchor_mean
    out = {}
    for phrase, rec in models.items():
        model_series = series.get(phrase, {})
        values = {m: round(model_series[m] * scale, 4)
                  for m in months if m in model_series}
        if values:
            out[(rec["manufacturer"], rec["model"])] = values
    return out, anchor_mean


def calibrate_ladder(backend, anchors, months, time_range, sleep):
    """Each anchor's search level as a fraction of the primary anchor's.

    Measured pairwise and chained: rung 1 against rung 0, rung 2 against rung
    1, and so on. Measuring all of them in one request would defeat the
    purpose — the bottom rung would round to 0 against the top, which is the
    very quantization the ladder exists to avoid.

    Returns {anchor: relative_level}, truncated at the first rung that fails
    to register, so a broken chain silently disables the tiers below it
    instead of scaling them by a bogus factor.
    """
    levels = {anchors[0]: 1.0}
    for upper, lower in zip(anchors, anchors[1:]):
        try:
            series = backend.fetch([upper, lower], time_range)
        except Exception as exc:  # noqa: BLE001
            print(f"  [warn] could not calibrate {lower!r} against {upper!r}: "
                  f"{lib.redact(exc)}")
            break
        upper_mean = series_mean(series, upper, months)
        lower_mean = series_mean(series, lower, months)
        if upper_mean <= 0 or lower_mean <= 0:
            print(f"  [warn] {lower!r} does not register against {upper!r} — "
                  "the ladder stops here")
            break
        levels[lower] = levels[upper] * (lower_mean / upper_mean)
        print(f"  calibrated {lower!r} = {levels[lower]:.4f} x {anchors[0]!r}")
        time.sleep(sleep)
    return levels


_TIER_NOTE = re.compile(r"tier=(\d+)")


def tier_of(state, manufacturer, model, default=0):
    """Which rung of the anchor ladder this model was last measured against."""
    record = state.get(manufacturer, model)
    if not record:
        return default
    found = _TIER_NOTE.search(record.get("note", "") or "")
    tier = int(found.group(1)) if found else default
    # A model that registered nothing at its tier gets one rung more headroom.
    if record.get("status") == "zero":
        tier += 1
    return tier


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    lib.add_common_args(ap)
    ap.set_defaults(sleep=3.0)
    ap.add_argument("--backend", choices=["auto", "trends", "serpapi"], default="auto",
                    help="auto uses serpapi when SERPAPI_API_KEY is set")
    ap.add_argument("--anchors", default=",".join(DEFAULT_ANCHORS),
                    help="comma-separated anchor ladder, most searched first")
    ap.add_argument("--budget", type=int, default=400,
                    help="batches to request this run (4 models each)")
    ap.add_argument("--months", type=int, default=12,
                    help="trailing complete months to measure")
    ap.add_argument("--geo", default="", help="country code, blank = worldwide")
    ap.add_argument("--max-consecutive-failures", type=int, default=8,
                    help="stop the run after this many failed batches in a row")
    args = ap.parse_args()

    serp_key = os.environ.get("SERPAPI_API_KEY", "")
    backend_name = args.backend
    if backend_name == "auto":
        backend_name = "serpapi" if serp_key else "trends"
    if backend_name == "serpapi":
        if not serp_key:
            print("SERPAPI_API_KEY is not set — cannot use the serpapi backend.")
            return 1
        backend = SerpApiBackend(serp_key, geo=args.geo, sleep=args.sleep)
    else:
        backend = TrendsBackend(geo=args.geo, sleep=args.sleep)

    months = lib.month_window(args.months)
    start = lib.month_bounds(months[0])[0]
    # Trends takes an inclusive end date; month_bounds gives the exclusive one.
    end = lib.month_bounds(months[-1])[1] - timedelta(days=1)
    time_range = f"{start.isoformat()} {end.isoformat()}"

    anchors = [a.strip() for a in args.anchors.split(",") if a.strip()]
    universe = lib.load_universe(args.csv, min_auctions=args.min_auctions)
    state = lib.State(STATE_PATH)

    per_batch = BATCH_KEYWORDS - 1
    capacity = args.budget * per_batch
    todo = state.select(universe, args.limit or capacity)
    print(f"Backend {backend.name}; range {time_range}")
    print(f"Anchor ladder: {' > '.join(anchors)}")

    levels = calibrate_ladder(backend, anchors, months, time_range, args.sleep)
    usable = [a for a in anchors if a in levels]

    # Group by rung: a model demoted for registering nothing needs a smaller
    # anchor, and every batch can carry only one.
    #
    # Brand-level rows (the upstream "unspecified model" buckets, where the
    # model name is the manufacturer's own) are grouped apart from real models.
    # A bare brand term is searched orders of magnitude more than any single
    # car, so sharing a batch with one would quantize its batch-mates to zero —
    # the same failure the anchor ladder exists to prevent. Kept together they
    # are comparable to each other.
    groups = {}
    for rec in todo:
        tier = min(tier_of(state, rec["manufacturer"], rec["model"]),
                   len(usable) - 1)
        is_brand = (lib.search_phrase(rec["manufacturer"], rec["model"]).lower()
                    == rec["manufacturer"].strip().lower())
        groups.setdefault((tier, is_brand), []).append(rec)

    batches = []
    for (tier, _), group in sorted(groups.items()):
        batches.extend(
            (tier, group[i:i + per_batch])
            for i in range(0, len(group), per_batch))
    by_tier = {}
    for (tier, _), group in groups.items():
        by_tier[tier] = by_tier.get(tier, 0) + len(group)
    print(f"Universe {len(universe)} models; processing {len(todo)} "
          f"in {len(batches)} batches "
          f"({', '.join(f'tier {t}: {n}' for t, n in sorted(by_tier.items()))})")

    collected = []
    consecutive_failures = 0
    now = lib.utcnow_iso()

    for bi, (tier, batch) in enumerate(batches, 1):
        anchor = usable[tier]
        # Two different models can reduce to the same search phrase; Trends
        # rejects duplicate keywords in one request, so keep the first.
        by_phrase = {}
        for rec in batch:
            phrase = lib.search_phrase(rec["manufacturer"], rec["model"])
            if phrase != anchor:
                by_phrase.setdefault(phrase, rec)
        if not by_phrase:
            continue
        keywords = [anchor] + list(by_phrase)

        try:
            series = backend.fetch(keywords, time_range)
        except lib.RateLimited:
            consecutive_failures += 1
            print(f"  batch {bi}: rate limited "
                  f"({consecutive_failures}/{args.max_consecutive_failures})")
            if consecutive_failures >= args.max_consecutive_failures:
                print("  Google is refusing requests — stopping and keeping progress.")
                break
            time.sleep(args.sleep * 10)
            continue
        except Exception as exc:  # noqa: BLE001 — one bad batch must not end the run
            consecutive_failures += 1
            print(f"  [ERROR] batch {bi}: {exc}")
            if consecutive_failures >= args.max_consecutive_failures:
                print("  Too many consecutive failures — stopping.")
                break
            time.sleep(args.sleep * 2)
            continue

        consecutive_failures = 0
        values_by_model, anchor_mean = rescale_batch(
            series, anchor, by_phrase, months, relative_level=levels[anchor])
        if anchor_mean <= 0:
            print(f"  batch {bi}: anchor registered no volume — batch discarded")
            for rec in by_phrase.values():
                state.mark(rec["manufacturer"], rec["model"], "error",
                           f"tier={tier} anchor zero")
            continue
        if anchor_mean < 5:
            print(f"  batch {bi}: anchor level {anchor_mean:.1f} is low — "
                  "results are coarse (a batch-mate is far more searched)")

        bottom_rung = tier >= len(usable) - 1
        for rec in by_phrase.values():
            key = (rec["manufacturer"], rec["model"])
            values = values_by_model.get(key)
            if values and max(values.values()) > 0:
                state.mark(key[0], key[1], "ok",
                           f"tier={tier} anchor {anchor_mean:.1f}")
                for month, value in values.items():
                    collected.append({
                        "manufacturer": key[0], "model": key[1], "month": month,
                        "trends_interest": value, "trends_source": backend.name,
                        "measured_at": now,
                    })
            elif bottom_rung:
                # Nothing registered even against the smallest anchor, so this
                # model really has no measurable search volume. Recording no
                # value is right: the front-end renormalizes around a missing
                # input rather than ranking the model as a genuine zero.
                state.mark(key[0], key[1], "empty",
                           f"tier={tier} no search volume")
            else:
                # Quantized to zero by too large an anchor — try a rung lower
                # on the next run rather than recording a false zero.
                state.mark(key[0], key[1], "zero", f"tier={tier} rounded to zero")

        if bi % 20 == 0:
            print(f"  batch {bi}/{len(batches)} — {len(collected)} rows so far")
            lib.upsert(OUTPUT_PATH, FIELDS, collected)
            state.save()
        time.sleep(args.sleep)

    all_rows = lib.upsert(OUTPUT_PATH, FIELDS, collected)
    state.save()
    covered = len({(r["manufacturer"], r["model"]) for r in all_rows})
    print(f"Collected {len(collected)} rows this run.")
    print(f"{OUTPUT_PATH}: {len(all_rows)} rows covering {covered}/{len(universe)} models")
    return 0


if __name__ == "__main__":
    sys.exit(main())
