#!/usr/bin/env python3
"""
Tests for the signal collectors.

Everything here runs offline: the upstream calls are stubbed, so this exercises
the parts that are easy to get quietly wrong — search-phrase cleanup, month
bucketing, the anchor rescaling that makes Google Trends batches comparable,
the budget rotation, and the weight renormalization in the social composite.

Run: python3 data/pipelines/test_pipelines.py
"""

import csv
import io
import os
import sys
import tempfile
import unittest
import unittest.mock
import urllib.error
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import signal_lib as lib
import apex
import google_trends
import youtube_signals
import social_signals
import export_live_lots

# mai.py needs pandas, which the stdlib-only signals workflow doesn't install;
# the Data Pipelines workflow does and runs the MAI tests before scoring.
try:
    import mai
    import auction_rating
except ModuleNotFoundError as e:
    if e.name != "pandas":
        raise
    mai = auction_rating = None


class SearchPhrase(unittest.TestCase):
    """A leaderboard label is not a search query."""

    def test_strips_year_ranges(self):
        self.assertEqual(lib.search_phrase("Ford", "F-Series 1992-1997"),
                         "Ford F-Series")

    def test_keeps_first_of_a_paired_nameplate(self):
        self.assertEqual(lib.search_phrase("Abarth", "Abarth 750 & 850"),
                         "Abarth 750")
        self.assertEqual(lib.search_phrase("Mercedes-Benz",
                                           "300SL Gullwing & Roadster"),
                         "Mercedes-Benz 300SL Gullwing")

    def test_does_not_repeat_the_manufacturer(self):
        self.assertEqual(lib.search_phrase("Porsche", "Porsche 911"), "Porsche 911")

    def test_plain_model_is_prefixed(self):
        self.assertEqual(lib.search_phrase("Porsche", "911"), "Porsche 911")

    def test_model_that_is_only_a_year_range_falls_back_to_make(self):
        self.assertEqual(lib.search_phrase("Ford", "1992-1997"), "Ford")

    def test_a_slash_is_part_of_the_name_not_a_separator(self):
        # 94 models carry a slash. Splitting on it turned "C/K" into "C",
        # which searched for the wrong thing entirely.
        self.assertEqual(lib.search_phrase("Chevrolet", "C/K"), "Chevrolet C/K")
        self.assertEqual(lib.search_phrase("Ferrari", "296 GTB/GTS"),
                         "Ferrari 296 GTB/GTS")
        self.assertEqual(lib.search_phrase("Alfa Romeo", "105/115 Spider Series 1"),
                         "Alfa Romeo 105/115 Spider Series 1")

    def test_a_leading_ampersand_does_not_empty_the_phrase(self):
        self.assertEqual(lib.search_phrase("Dodge", "& Plymouth Neon"),
                         "Dodge Plymouth Neon")

    def test_a_model_named_after_a_year_keeps_its_name(self):
        # The BMW 2002 is a car, not a year. Stripping it left "BMW", which
        # searched the whole brand and scored 27x the anchor.
        self.assertEqual(lib.search_phrase("Bmw", "2002"), "Bmw 2002")
        self.assertEqual(lib.search_phrase("Audi", "5000"), "Audi 5000")

    def test_a_trailing_year_is_still_dropped_when_it_qualifies_a_name(self):
        self.assertEqual(lib.search_phrase("Ford", "Mustang 1969"), "Ford Mustang")

    def test_an_ampersand_part_that_is_just_the_maker_is_skipped(self):
        # "AMC & Rambler Ambassador" is the Ambassador, not the whole of AMC.
        self.assertEqual(lib.search_phrase("Amc", "AMC & Rambler Ambassador"),
                         "Amc Rambler Ambassador")

    def test_a_curated_override_wins(self):
        original = lib._PHRASE_OVERRIDES
        try:
            lib._PHRASE_OVERRIDES = {("Ford", "A"): "Ford Model A"}
            self.assertEqual(lib.search_phrase("Ford", "A"), "Ford Model A")
        finally:
            lib._PHRASE_OVERRIDES = original


class Redaction(unittest.TestCase):
    """State files are committed, and collector errors quote the failing URL —
    which carries the API key."""

    def test_api_keys_are_stripped_from_messages(self):
        msg = "429 from https://x/search?q=a&key=AIzaSyEXAMPLEKEY123&type=video"
        self.assertEqual(
            lib.redact(msg),
            "429 from https://x/search?q=a&key=REDACTED&type=video")

    def test_serpapi_style_parameter_too(self):
        self.assertIn("api_key=REDACTED", lib.redact("...&api_key=deadbeef&x=1"))

    def test_a_state_note_never_carries_a_key(self):
        state = lib.State(os.path.join(tempfile.mkdtemp(), "state.csv"))
        state.mark("Chevrolet", "C/K", "error",
                   "429 from https://x/search?key=AIzaSyEXAMPLEKEY123")
        note = state.get("Chevrolet", "C/K")["note"]
        self.assertNotIn("AIzaSy", note)
        self.assertIn("key=REDACTED", note)


class Months(unittest.TestCase):

    def test_window_is_complete_months_only(self):
        months = lib.month_window(3, today=date(2026, 3, 17))
        self.assertEqual(months, ["2025-12", "2026-01", "2026-02"])

    def test_window_crosses_the_year(self):
        self.assertEqual(lib.month_window(2, today=date(2026, 1, 5)),
                         ["2025-11", "2025-12"])

    def test_bounds_are_half_open(self):
        self.assertEqual(lib.month_bounds("2025-12"),
                         (date(2025, 12, 1), date(2026, 1, 1)))

    def test_month_of_accepts_iso_and_epoch(self):
        self.assertEqual(lib.month_of("2025-11-04T09:00:00Z"), "2025-11")
        self.assertEqual(lib.month_of(1762000000), "2025-11")


class PercentileRank(unittest.TestCase):
    """Must match percentileRanker in mii-normalize.js exactly."""

    def test_mid_rank(self):
        rank = lib.pct_ranker([1, 2, 3, 4])
        self.assertAlmostEqual(rank(1), 0.125)
        self.assertAlmostEqual(rank(4), 0.875)

    def test_ties_share_a_rank(self):
        self.assertAlmostEqual(lib.pct_ranker([5, 5, 5, 5])(5), 0.5)

    def test_empty_is_zero(self):
        self.assertEqual(lib.pct_ranker([])(1), 0.0)


class Upsert(unittest.TestCase):
    """A budget-limited run must never destroy the rows it did not touch."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "out.csv")
        self.fields = ["manufacturer", "model", "month", "value"]

    def test_merges_without_dropping_untouched_rows(self):
        lib.upsert(self.path, self.fields, [
            {"manufacturer": "Porsche", "model": "911", "month": "2026-01", "value": 1},
            {"manufacturer": "BMW", "model": "M3", "month": "2026-01", "value": 2},
        ])
        rows = lib.upsert(self.path, self.fields, [
            {"manufacturer": "Porsche", "model": "911", "month": "2026-01", "value": 9},
        ])
        by_key = {(r["manufacturer"], r["month"]): r["value"] for r in rows}
        self.assertEqual(by_key[("Porsche", "2026-01")], "9")   # replaced
        self.assertEqual(by_key[("BMW", "2026-01")], "2")       # untouched
        self.assertEqual(len(rows), 2)


class BudgetRotation(unittest.TestCase):
    """Which models a quota-limited run should spend its allowance on."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.state = lib.State(os.path.join(self.dir, "state.csv"))
        self.universe = [
            {"manufacturer": "Porsche", "model": "911", "auction_count": 300},
            {"manufacturer": "BMW", "model": "M3", "auction_count": 200},
            {"manufacturer": "Nissan", "model": "300ZX", "auction_count": 100},
        ]

    def test_never_measured_models_come_first(self):
        self.state.mark("Porsche", "911", "ok")
        picked = self.state.select(self.universe, limit=2)
        self.assertEqual([r["model"] for r in picked], ["M3", "300ZX"])

    def test_budget_is_respected(self):
        self.assertEqual(len(self.state.select(self.universe, limit=1)), 1)

    def test_models_with_no_data_are_not_retried_every_run(self):
        for rec in self.universe:
            self.state.mark(rec["manufacturer"], rec["model"], "ok")
        self.state.mark("Nissan", "300ZX", "empty")
        picked = self.state.select(self.universe, limit=10)
        self.assertNotIn("300ZX", [r["model"] for r in picked])

    def test_an_empty_model_is_retried_once_it_is_stale_enough(self):
        for rec in self.universe:
            self.state.mark(rec["manufacturer"], rec["model"], "ok")
        self.state.mark("Nissan", "300ZX", "empty")
        picked = self.state.select(self.universe, limit=10, retry_empty_after_days=0)
        self.assertIn("300ZX", [r["model"] for r in picked])


# The real body YouTube returns once a default project's 100 search.list
# calls for the day are gone. Note the reason is "rateLimitExceeded", not
# "quotaExceeded" — classifying on the reason alone gets this wrong.
YOUTUBE_DAILY_QUOTA_BODY = """{"error":{"code":429,
 "message":"Quota exceeded for quota metric 'Search Queries' and limit
 'Search Queries per day' of service 'youtube.googleapis.com'",
 "errors":[{"reason":"rateLimitExceeded"}],"status":"RESOURCE_EXHAUSTED"}}"""

YOUTUBE_THROTTLE_BODY = """{"error":{"code":429,
 "message":"Too many requests","errors":[{"reason":"rateLimitExceeded"}]}}"""


class QuotaClassification(unittest.TestCase):
    """A 429 means either 'slow down' or 'come back tomorrow'. Retrying the
    second one just burns the run's clock."""

    def _opener_raising(self, body):
        class Opener:
            def open(self, req, timeout=None):
                raise urllib.error.HTTPError(
                    "https://api/x?key=SECRET", 429, "Too Many Requests", {},
                    io.BytesIO(body.encode()))
        return Opener()

    def test_daily_allowance_is_recognised(self):
        self.assertTrue(lib.is_daily_quota_error(YOUTUBE_DAILY_QUOTA_BODY))

    def test_plain_throttling_is_not_mistaken_for_it(self):
        self.assertFalse(lib.is_daily_quota_error(YOUTUBE_THROTTLE_BODY))

    def test_daily_allowance_stops_the_run_without_retrying(self):
        with self.assertRaises(lib.QuotaExhausted):
            lib.http_get("https://api/x", opener=self._opener_raising(
                YOUTUBE_DAILY_QUOTA_BODY), retries=3, backoff=0)

    def test_plain_throttling_raises_rate_limited(self):
        with self.assertRaises(lib.RateLimited):
            lib.http_get("https://api/x", opener=self._opener_raising(
                YOUTUBE_THROTTLE_BODY), retries=2, backoff=0)

    def test_the_key_never_reaches_the_exception_message(self):
        try:
            lib.http_get("https://api/x?q=a&key=SECRET",
                         opener=self._opener_raising(YOUTUBE_THROTTLE_BODY),
                         retries=1, backoff=0)
        except lib.RateLimited as exc:
            self.assertNotIn("SECRET", str(exc))
            self.assertIn("key=REDACTED", str(exc))
        else:
            self.fail("expected RateLimited")


class TrendsShaping(unittest.TestCase):

    def test_weekly_points_average_into_months(self):
        # Two weeks in January (10, 20) and one in February (60).
        timeline = [
            {"time": "1735689600", "value": [10, 1]},   # 2025-01-01
            {"time": "1736294400", "value": [20, 3]},   # 2025-01-08
            {"time": "1738368000", "value": [60, 5]},   # 2025-02-01
        ]
        monthly = google_trends.weekly_to_monthly(timeline, ["anchor", "model"])
        self.assertAlmostEqual(monthly["anchor"]["2025-01"], 15.0)
        self.assertAlmostEqual(monthly["anchor"]["2025-02"], 60.0)
        self.assertAlmostEqual(monthly["model"]["2025-01"], 2.0)

    def test_partial_weeks_are_dropped(self):
        timeline = [
            {"time": "1735689600", "value": [10]},
            {"time": "1736294400", "value": [90], "isPartial": True},
        ]
        monthly = google_trends.weekly_to_monthly(timeline, ["anchor"])
        self.assertAlmostEqual(monthly["anchor"]["2025-01"], 10.0)

    def test_serpapi_payload_shape(self):
        timeline = [{"timestamp": "1735689600",
                     "values": [{"query": "anchor", "extracted_value": 40},
                                {"query": "model", "extracted_value": 10}]}]
        monthly = google_trends.weekly_to_monthly(timeline, ["anchor", "model"],
                                                  serpapi=True)
        self.assertAlmostEqual(monthly["model"]["2025-01"], 10.0)

    def test_anchor_makes_batches_comparable(self):
        """The same car must score the same in two differently-scaled batches."""
        months = ["2025-01"]
        model = {"Ferrari F40": {"manufacturer": "Ferrari", "model": "F40"}}

        # Batch A: the anchor tops out at 100, the model sits at 25.
        a, mean_a = google_trends.rescale_batch(
            {"anchor": {"2025-01": 100.0}, "Ferrari F40": {"2025-01": 25.0}},
            "anchor", model, months)
        # Batch B: a hugely-searched batch-mate pushed both down 4x, but the
        # model is still a quarter of the anchor.
        b, mean_b = google_trends.rescale_batch(
            {"anchor": {"2025-01": 25.0}, "Ferrari F40": {"2025-01": 6.25}},
            "anchor", model, months)

        self.assertEqual(a[("Ferrari", "F40")], b[("Ferrari", "F40")])
        self.assertAlmostEqual(a[("Ferrari", "F40")]["2025-01"], 25.0)
        self.assertEqual((mean_a, mean_b), (100.0, 25.0))

    def test_a_lower_tier_lands_on_the_primary_scale(self):
        """A model measured against a smaller anchor must not be inflated."""
        months = ["2025-01"]
        model = {"Lancia Fulvia": {"manufacturer": "Lancia", "model": "Fulvia"}}
        # Tier 1's anchor is a tenth of the primary's true volume. Within its
        # own batch it reads 50 against an anchor of 100 — but on the shared
        # scale that is half of a tenth, i.e. 5, not 50.
        out, _ = google_trends.rescale_batch(
            {"Datsun 240Z": {"2025-01": 100.0}, "Lancia Fulvia": {"2025-01": 50.0}},
            "Datsun 240Z", model, months, relative_level=0.1)
        self.assertAlmostEqual(out[("Lancia", "Fulvia")]["2025-01"], 5.0)

    def test_the_ladder_chains_each_rung_to_the_one_above(self):
        anchors = ["Top", "Mid", "Low"]

        class Backend:
            # Mid reads half of Top; Low reads a fifth of Mid. So Low should
            # come out at 0.5 x 0.2 = 0.1 of Top.
            pairs = {("Top", "Mid"): (100.0, 50.0), ("Mid", "Low"): (100.0, 20.0)}

            def fetch(self, keywords, time_range):
                upper, lower = keywords
                u, l = self.pairs[(upper, lower)]
                return {upper: {"2025-01": u}, lower: {"2025-01": l}}

        levels = google_trends.calibrate_ladder(
            Backend(), anchors, ["2025-01"], "range", sleep=0)
        self.assertAlmostEqual(levels["Top"], 1.0)
        self.assertAlmostEqual(levels["Mid"], 0.5)
        self.assertAlmostEqual(levels["Low"], 0.1)

    def test_a_broken_rung_truncates_the_ladder(self):
        """Better to disable the tiers below than scale them by a bogus factor."""
        class Backend:
            def fetch(self, keywords, time_range):
                upper, lower = keywords
                if lower == "Low":
                    return {upper: {"2025-01": 100.0}, lower: {"2025-01": 0.0}}
                return {upper: {"2025-01": 100.0}, lower: {"2025-01": 50.0}}

        levels = google_trends.calibrate_ladder(
            Backend(), ["Top", "Mid", "Low"], ["2025-01"], "range", sleep=0)
        self.assertEqual(set(levels), {"Top", "Mid"})

    def test_a_dead_anchor_invalidates_the_batch(self):
        out, mean = google_trends.rescale_batch(
            {"anchor": {"2025-01": 0.0}, "X": {"2025-01": 50.0}},
            "anchor", {"X": {"manufacturer": "X", "model": "X"}}, ["2025-01"])
        self.assertEqual((out, mean), ({}, 0.0))


class TrendsTiering(unittest.TestCase):
    """A model quantized to zero against too large an anchor must be retried
    lower down, not recorded as a genuine zero."""

    def setUp(self):
        self.state = lib.State(os.path.join(tempfile.mkdtemp(), "state.csv"))

    def test_an_unmeasured_model_starts_at_the_top(self):
        self.assertEqual(google_trends.tier_of(self.state, "A", "1"), 0)

    def test_a_measured_model_stays_at_its_tier(self):
        self.state.mark("A", "1", "ok", "tier=2 anchor 40.0")
        self.assertEqual(google_trends.tier_of(self.state, "A", "1"), 2)

    def test_a_zeroed_model_is_demoted_one_rung(self):
        self.state.mark("A", "1", "zero", "tier=0 rounded to zero")
        self.assertEqual(google_trends.tier_of(self.state, "A", "1"), 1)

    def test_a_demoted_model_is_retried_rather_than_held_back(self):
        universe = [{"manufacturer": "A", "model": "1", "auction_count": 5}]
        self.state.mark("A", "1", "zero", "tier=0 rounded to zero")
        self.assertEqual(len(self.state.select(universe, limit=10)), 1)

    def test_no_volume_at_the_bottom_is_held_back_like_any_empty(self):
        universe = [{"manufacturer": "A", "model": "1", "auction_count": 5}]
        self.state.mark("A", "1", "empty", "tier=2 no search volume")
        self.assertEqual(self.state.select(universe, limit=10), [])


class YouTubeShaping(unittest.TestCase):

    def setUp(self):
        self.calls = []
        self.search_payload = {
            "items": [{"id": {"videoId": "v1"}, "snippet": {"title": "Porsche 911 review"}},
                      {"id": {"videoId": "v2"}, "snippet": {"title": "Porsche 911 drive"}},
                      {"id": {"videoId": "v3"}, "snippet": {"title": "Bread recipe"}}],
            "pageInfo": {"totalResults": 4210},
        }
        self.videos_payload = {"items": [
            {"snippet": {"title": "Porsche 911 review", "publishedAt": "2026-01-10T00:00:00Z"},
             "statistics": {"viewCount": "1000", "likeCount": "100", "commentCount": "50"}},
            {"snippet": {"title": "Porsche 911 drive", "publishedAt": "2026-01-20T00:00:00Z"},
             "statistics": {"viewCount": "3000", "likeCount": "200", "commentCount": "10"}},
            # Unrelated video the quoted search dragged in — must be dropped.
            {"snippet": {"title": "Bread recipe", "publishedAt": "2026-01-05T00:00:00Z"},
             "statistics": {"viewCount": "9999999", "likeCount": "1", "commentCount": "1"}},
        ]}

        def fake_get(path, params, api_key):
            self.calls.append((path, params))
            return self.search_payload if path == "search" else self.videos_payload

        self._real = youtube_signals.yt_get
        youtube_signals.yt_get = fake_get

    def tearDown(self):
        youtube_signals.yt_get = self._real

    def test_videos_bucket_into_their_publish_month(self):
        quota = youtube_signals.Quota(1000)
        rows, kept, total = youtube_signals.collect_model(
            {"manufacturer": "Porsche", "model": "911"},
            ["2025-12", "2026-01"], "2025-12-01T00:00:00Z", "KEY", quota)

        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["month"], "2026-01")
        self.assertEqual(row["yt_videos"], 2)       # the bread video is gone
        self.assertEqual(row["yt_views"], 4000)
        self.assertEqual(row["yt_likes"], 300)
        self.assertAlmostEqual(row["yt_engagement_rate"], 360 / 4000)
        self.assertEqual(kept, 2)
        self.assertEqual(total, 4210)

    def test_one_model_costs_one_search_plus_one_lookup(self):
        quota = youtube_signals.Quota(1000)
        youtube_signals.collect_model(
            {"manufacturer": "Porsche", "model": "911"},
            ["2026-01"], "2025-12-01T00:00:00Z", "KEY", quota)
        self.assertEqual(quota.spent, youtube_signals.COST_PER_MODEL)
        self.assertEqual([c[0] for c in self.calls], ["search", "videos"])

    def test_a_model_with_no_videos_costs_only_the_search(self):
        self.search_payload = {"items": [], "pageInfo": {"totalResults": 0}}
        quota = youtube_signals.Quota(1000)
        rows, _, _ = youtube_signals.collect_model(
            {"manufacturer": "Porsche", "model": "911"},
            ["2026-01"], "2025-12-01T00:00:00Z", "KEY", quota)
        self.assertEqual(rows, [])
        self.assertEqual(quota.spent, youtube_signals.SEARCH_COST)


class SocialComposite(unittest.TestCase):
    """docs/social-score-methodology.md: drop a missing sub-signal and
    renormalize the rest — never impute a default."""

    def test_wikipedia_only_rows_keep_the_original_60_40_split(self):
        rows = [
            {"manufacturer": "A", "model": "1", "month": "2026-01",
             "wiki_pageviews": 100.0, "wiki_sov": 0.9},
            {"manufacturer": "A", "model": "2", "month": "2026-01",
             "wiki_pageviews": 10.0, "wiki_sov": 0.1},
        ]
        social_signals.score_rows(rows)
        # Ranks: pageviews 0.75/0.25, sov 0.75/0.25 → 0.6*.75 + 0.4*.75 = .75
        self.assertAlmostEqual(rows[0]["social_score"], 75.0)
        self.assertAlmostEqual(rows[1]["social_score"], 25.0)

    def test_all_sub_signals_present_uses_the_full_weight_set(self):
        rows = [
            {"manufacturer": "A", "model": "1", "month": "2026-01",
             "wiki_pageviews": 100.0, "reddit_posts": 20.0,
             "reddit_engagement": 50.0, "wiki_sov": 0.9, "yt_videos": 8.0},
            {"manufacturer": "A", "model": "2", "month": "2026-01",
             "wiki_pageviews": 10.0, "reddit_posts": 2.0,
             "reddit_engagement": 5.0, "wiki_sov": 0.1, "yt_videos": 1.0},
        ]
        social_signals.score_rows(rows)
        # Every sub-signal ranks the first row top (0.75) → score 75 regardless
        # of the weights, which is the point: the blend is scale-free.
        self.assertAlmostEqual(rows[0]["social_score"], 75.0)

    def test_mention_volume_averages_wikipedia_and_reddit(self):
        rows = [
            # Top on Wikipedia, bottom on Reddit → mention rank is the mean.
            {"manufacturer": "A", "model": "1", "month": "2026-01",
             "wiki_pageviews": 100.0, "reddit_posts": 1.0},
            {"manufacturer": "A", "model": "2", "month": "2026-01",
             "wiki_pageviews": 1.0, "reddit_posts": 100.0},
        ]
        social_signals.score_rows(rows)
        # mention is the only sub-signal present, so it carries the whole score.
        self.assertAlmostEqual(rows[0]["social_score"], 50.0)
        self.assertAlmostEqual(rows[1]["social_score"], 50.0)

    def test_a_row_with_nothing_gets_no_score_rather_than_a_zero(self):
        rows = [{"manufacturer": "A", "model": "1", "month": "2026-01"}]
        social_signals.score_rows(rows)
        self.assertEqual(rows[0]["social_score"], "")

    def test_share_of_voice_is_within_the_manufacturer(self):
        rows = [
            {"manufacturer": "Porsche", "model": "911", "month": "2026-01",
             "wiki_pageviews": 75.0},
            {"manufacturer": "Porsche", "model": "944", "month": "2026-01",
             "wiki_pageviews": 25.0},
            {"manufacturer": "BMW", "model": "M3", "month": "2026-01",
             "wiki_pageviews": 1000.0},
        ]
        social_signals.add_share_of_voice(rows)
        self.assertAlmostEqual(rows[0]["wiki_sov"], 0.75)
        self.assertAlmostEqual(rows[1]["wiki_sov"], 0.25)
        self.assertAlmostEqual(rows[2]["wiki_sov"], 1.0)


def _store_lot(**over):
    lot = {
        "event": "RM Monterey 2026", "auction_house": "RM Sotheby's",
        "event_date": "2026-08-14", "source_listing_id": "rm-monterey-2026-lot-112",
        "year": 1957, "make": "Mercedes-Benz", "model": "300 SL", "trim": "Roadster",
        "status": "ended", "outcome": "sold", "price": 1500000.0,
        "price_all_in": 1650000.0, "currency": "USD",
        "estimate_low": 1400000.0, "estimate_high": 1700000.0, "needs_review": False,
    }
    lot.update(over)
    return lot


class LiveLotsExport(unittest.TestCase):
    """The store replaces hand-entry as the source of auction_lots.csv, so
    the mapping decides what MAI sees: estimates must survive (the apex rule
    reads them), and unfinished lots must not count as unsold."""

    def test_sold_lot_maps_to_the_csv_schema(self):
        row, reason = export_live_lots.to_csv_row(_store_lot())
        self.assertIsNone(reason)
        self.assertEqual(row["lot_number"], "112")
        self.assertEqual(row["model"], "300 SL Roadster")
        self.assertEqual(row["low_estimate_usd"], "1400000")
        self.assertEqual(row["sold_price_usd"], "1650000")  # fee-inclusive wins
        self.assertEqual(row["sold"], "true")
        self.assertEqual(row["notes"], "store:rm-monterey-2026-lot-112")

    def test_hammer_price_when_no_all_in(self):
        row, _ = export_live_lots.to_csv_row(_store_lot(price_all_in=None))
        self.assertEqual(row["sold_price_usd"], "1500000")

    def test_unsold_lot_keeps_estimates_but_no_price(self):
        row, _ = export_live_lots.to_csv_row(
            _store_lot(outcome="reserve_not_met", price=None, price_all_in=None))
        self.assertEqual(row["sold"], "false")
        self.assertEqual(row["sold_price_usd"], "")
        self.assertEqual(row["high_estimate_usd"], "1700000")

    def test_lots_that_would_distort_sell_through_are_skipped(self):
        for over, reason in [
            ({"status": "upcoming", "outcome": None}, "not ended"),
            ({"outcome": "withdrawn"}, "withdrawn"),
            ({"event": None}, "no event"),
            ({"event_date": None}, "no date"),
        ]:
            row, why = export_live_lots.to_csv_row(_store_lot(**over))
            self.assertIsNone(row, over)
            self.assertEqual(why, reason)

    def test_non_usd_lots_convert_at_the_sale_date_rate(self):
        """European sales from the game mirror keep their currency in the
        store; MAI needs them in USD, price and estimates alike."""
        seen = []

        def fx(cur, day):
            seen.append((cur, day))
            return 1.1

        row, why = export_live_lots.to_csv_row(_store_lot(
            currency="EUR", price_all_in=1000000.0, estimate_low=900000.0,
            estimate_high=1200000.0), fx)
        self.assertIsNone(why)
        self.assertEqual(row["sold_price_usd"], "1100000")
        self.assertEqual(row["low_estimate_usd"], "990000")
        self.assertEqual(row["high_estimate_usd"], "1320000")
        self.assertTrue(row["notes"].endswith("; EUR at 1.1000 USD"))
        self.assertEqual(seen, [("EUR", "2026-08-14")])

    def test_a_currency_without_a_rate_is_skipped_and_named(self):
        row, why = export_live_lots.to_csv_row(_store_lot(currency="XYZ"), lambda c, d: None)
        self.assertIsNone(row)
        self.assertEqual(why, "no USD rate for XYZ")
        self.assertEqual(export_live_lots.to_csv_row(_store_lot(currency="EUR"))[1],
                         "no USD rate for EUR")  # no fx given at all

    def test_ecb_rates_resolve_dates_and_cache(self):
        calls = []

        def fake_get(url, headers=None):
            calls.append(url)
            return None if "base=XYZ" in url else {"rates": {"USD": 1.1}}

        fx = export_live_lots.EcbRates(get_json=fake_get, today="2026-09-28")
        self.assertEqual(fx("usd", "2026-05-18"), 1.0)
        self.assertEqual(calls, [])                      # USD needs no lookup
        self.assertEqual(fx("EUR", "2026-05-18"), 1.1)
        self.assertEqual(fx("EUR", "2026-05-18"), 1.1)
        self.assertEqual(len(calls), 1)                  # cached
        self.assertIn("/v1/2026-05-18?base=EUR&symbols=USD", calls[0])
        fx("EUR", "2026-12-01")                          # future sale -> latest
        self.assertIn("/v1/latest?base=EUR", calls[-1])
        self.assertIsNone(fx("XYZ", "2026-05-18"))       # 404: no published rate

    def test_a_failed_rate_lookup_fails_the_run(self):
        def broken_fx(cur, day):
            raise urllib.error.URLError("network unreachable")

        env = {"CANONICAL_SUPABASE_URL": "https://x.supabase.co", "CANONICAL_SUPABASE_ANON_KEY": "anon"}
        out = os.path.join(tempfile.mkdtemp(), "auction_lots.csv")
        with unittest.mock.patch.dict(os.environ, env), \
             unittest.mock.patch("sys.stdout", new=io.StringIO()) as log:
            code = export_live_lots.main(["--out", out], fetch=lambda u, k: [_store_lot(currency="GBP")],
                                         fx=broken_fx)
        self.assertEqual(code, 1)
        self.assertIn("::error::Could not fetch the exchange rates", log.getvalue())
        self.assertFalse(os.path.exists(out))

    def test_lots_sort_numerically_within_a_sale(self):
        rows, _ = export_live_lots.build([
            _store_lot(source_listing_id="x-lot-110"),
            _store_lot(source_listing_id="x-lot-9"),
        ])
        self.assertEqual([r["lot_number"] for r in rows], ["9", "110"])

    def _run(self, existing, store_rows, *flags):
        d = tempfile.mkdtemp()
        out = os.path.join(d, "auction_lots.csv")
        self.upcoming_out = os.path.join(d, "upcoming_lots.csv")
        if existing is not None:
            lib.write_rows(out, export_live_lots.FIELDNAMES, existing)
        env = {"CANONICAL_SUPABASE_URL": "https://x.supabase.co",
               "CANONICAL_SUPABASE_ANON_KEY": "anon"}
        old = {k: os.environ.get(k) for k in env}
        os.environ.update(env)
        try:
            with unittest.mock.patch("sys.stdout", new=io.StringIO()) as log:
                export_live_lots.main(["--out", out, "--upcoming-out", self.upcoming_out, *flags],
                                      fetch=lambda url, key: store_rows, fx=lambda c, d: 1.25)
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        return lib.read_rows(out), log.getvalue()

    def test_refuses_to_drop_hand_entered_events(self):
        legacy = [{"event": "Gooding Amelia Island 2026", "event_date": "2026-03-05",
                   "manufacturer": "BMW", "model": "M1", "sold": "true"}]
        rows, log = self._run(legacy, [_store_lot()])
        self.assertEqual([r["event"] for r in rows], ["Gooding Amelia Island 2026"])
        self.assertIn("::warning::", log)
        self.assertIn("Gooding Amelia Island 2026", log)

    def test_writes_once_the_events_are_in_the_store(self):
        legacy = [{"event": "RM Monterey 2026", "manufacturer": "BMW"}]
        rows, _ = self._run(legacy, [_store_lot()])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["low_estimate_usd"], "1400000")

    def test_exported_events_may_be_renamed_in_the_store(self):
        """A Sale Cleanup merge or rename removes the old name from the store;
        that must not stop the daily run the way a hand-entered sale does."""
        exported = [{"event": "RM Monterey (mirror)", "manufacturer": "BMW",
                     "notes": "store:rm-monterey-2026-lot-12"}]
        rows, log = self._run(exported, [_store_lot()])
        self.assertEqual([r["event"] for r in rows], ["RM Monterey 2026"])
        self.assertNotIn("::warning::", log)

    def test_override_flag_drops_them(self):
        legacy = [{"event": "Old Name 2026", "manufacturer": "BMW"}]
        rows, _ = self._run(legacy, [_store_lot()], "--allow-drop-events")
        self.assertEqual([r["event"] for r in rows], ["RM Monterey 2026"])

    def test_upcoming_lot_keeps_its_estimates_for_the_pre_sale_view(self):
        row, why = export_live_lots.to_upcoming_row(
            _store_lot(status="upcoming", outcome=None, price=None, price_all_in=None,
                       event="RM London 2026", event_date="2026-11-01", currency="GBP",
                       estimate_low=800000.0, estimate_high=1000000.0),
            lambda c, d: 1.25, today="2026-10-09")
        self.assertIsNone(why)
        self.assertEqual(row["event"], "RM London 2026")
        self.assertEqual(row["low_estimate_usd"], "1000000")
        self.assertEqual(row["high_estimate_usd"], "1250000")
        self.assertNotIn("sold", row)
        self.assertTrue(row["notes"].endswith("; GBP at 1.2500 USD"))

    def test_upcoming_view_leaves_out_what_is_not_still_to_come(self):
        for over, reason in [
            ({}, "ended"),
            ({"status": "upcoming", "outcome": "withdrawn"}, "withdrawn"),
            ({"status": "upcoming", "outcome": None}, "sale date passed, no results yet"),
        ]:
            row, why = export_live_lots.to_upcoming_row(_store_lot(**over), today="2026-10-09")
            self.assertIsNone(row, over)
            self.assertEqual(why, reason)

    def test_upcoming_lots_go_to_their_own_csv_not_into_mai(self):
        future = _store_lot(status="upcoming", outcome=None, price=None, price_all_in=None,
                            event="Gooding Retromobile 2027", event_date="2099-02-04",
                            source_listing_id="gooding-retro-2027-lot-7")
        rows, log = self._run(None, [_store_lot(), future])
        self.assertEqual([r["event"] for r in rows], ["RM Monterey 2026"])
        upcoming = lib.read_rows(self.upcoming_out)
        self.assertEqual([(r["event"], r["lot_number"]) for r in upcoming],
                         [("Gooding Retromobile 2027", "7")])
        self.assertIn("Upcoming: 1 lots across 1 sales: Gooding Retromobile 2027", log)

    def test_upcoming_csv_is_written_even_when_the_guard_holds_lots_back(self):
        legacy = [{"event": "Gooding Amelia Island 2026", "manufacturer": "BMW"}]
        future = _store_lot(status="upcoming", outcome=None, event_date="2099-01-01")
        self._run(legacy, [future])
        self.assertEqual(len(lib.read_rows(self.upcoming_out)), 1)

    def test_skips_cleanly_without_credentials(self):
        with unittest.mock.patch.dict(os.environ, {"CANONICAL_SUPABASE_URL": ""}), \
             unittest.mock.patch("sys.stdout", new=io.StringIO()) as log:
            self.assertEqual(export_live_lots.main(
                ["--out", "/nonexistent/x.csv"],
                fetch=lambda *a: self.fail("must not fetch")), 0)
        self.assertIn("skipping", log.getvalue())

    def test_pages_until_a_short_page(self):
        calls = []

        def fake_get(url, headers=None):
            calls.append(url)
            n = export_live_lots.PAGE if len(calls) == 1 else 3
            return [_store_lot()] * n

        rows = export_live_lots.fetch_live_lots("https://x.supabase.co/", "k", get_json=fake_get)
        self.assertEqual(len(rows), export_live_lots.PAGE + 3)
        self.assertIn("offset=1000", calls[1])
        self.assertTrue(calls[0].startswith("https://x.supabase.co/rest/v1/auction_live_lots?"))

    def test_store_errors_carry_postgrests_message(self):
        """The first production run died on a bare 'HTTP Error 500'; the
        cause (a statement timeout) was only in the response body."""
        body = b'{"code":"57014","details":null,"hint":null,"message":"canceling statement due to statement timeout"}'

        def fake_get(url, headers=None):
            raise urllib.error.HTTPError(url, 500, "Internal Server Error", {}, io.BytesIO(body))

        with self.assertRaises(SystemExit) as ctx:
            export_live_lots.fetch_live_lots("https://x", "k", get_json=fake_get)
        msg = str(ctx.exception)
        self.assertTrue(msg.startswith("::error::"))
        self.assertIn("HTTP 500", msg)
        self.assertIn("canceling statement due to statement timeout", msg)
        self.assertIn("idx_listings_event", msg)

    def test_a_store_failure_fails_the_run_with_the_message_on_stdout(self):
        def failing_fetch(url, key):
            raise SystemExit("::error::Store returned HTTP 500 reading auction_live_lots: boom")

        env = {"CANONICAL_SUPABASE_URL": "https://x.supabase.co", "CANONICAL_SUPABASE_ANON_KEY": "anon"}
        with unittest.mock.patch.dict(os.environ, env), \
             unittest.mock.patch("sys.stdout", new=io.StringIO()) as log:
            code = export_live_lots.main(["--out", "/nonexistent/x.csv"], fetch=failing_fetch)
        self.assertEqual(code, 1)
        self.assertIn("::error::Store returned HTTP 500", log.getvalue())

    def test_store_errors_without_a_body_still_name_the_status(self):
        def fake_get(url, headers=None):
            raise urllib.error.HTTPError(url, 401, "Unauthorized", {}, io.BytesIO(b""))

        with self.assertRaises(SystemExit) as ctx:
            export_live_lots.fetch_live_lots("https://x", "k", get_json=fake_get)
        self.assertIn("HTTP 401", str(ctx.exception))
        self.assertIn("Unauthorized", str(ctx.exception))

    def test_missing_view_says_how_to_fix_it(self):
        with self.assertRaises(SystemExit) as ctx:
            export_live_lots.fetch_live_lots("https://x", "k", get_json=lambda *a, **k: None)
        self.assertIn("schema.sql", str(ctx.exception))


class ApexRule(unittest.TestCase):
    """High estimate first (the weekly digest's rule), sold price only for a
    lot that sold, and nothing for an unsold lot with no estimate."""

    def test_no_estimate_but_sold_at_600k_is_apex_by_sold_price(self):
        lot = {"high_estimate_usd": "", "sold_price_usd": "600000", "sold": "true"}
        self.assertEqual(apex.apex_value(lot), 600000)
        self.assertEqual(apex.apex_basis(lot), "sold_price")
        self.assertTrue(apex.is_apex(lot))

    def test_the_high_estimate_counts_not_the_low_one(self):
        lot = {"low_estimate_usd": "450000", "high_estimate_usd": "600000",
               "sold_price_usd": "", "sold": "false"}
        self.assertEqual(apex.apex_basis(lot), "estimate")
        self.assertTrue(apex.is_apex(lot))

    def test_no_estimate_and_not_sold_is_not_apex(self):
        lot = {"high_estimate_usd": float("nan"), "sold_price_usd": float("nan"), "sold": False}
        self.assertIsNone(apex.apex_value(lot))
        self.assertEqual(apex.apex_basis(lot), "none")
        self.assertFalse(apex.is_apex(lot))

    def test_an_estimate_wins_over_the_sold_price(self):
        lot = {"high_estimate_usd": "400000", "sold_price_usd": "700000", "sold": "true"}
        self.assertEqual(apex.apex_basis(lot), "estimate")
        self.assertFalse(apex.is_apex(lot))


@unittest.skipIf(mai is None, "pandas not installed")
class MaiScores(unittest.TestCase):
    """avg_Q is read as price realisation, so a sale where a manufacturer sold
    nothing, or sold only lots without a high estimate, must not drag it down
    or zero the score; that belongs to avg_R."""

    LOTS_HEADER = ("event,event_date,auction_house,lot_number,manufacturer,model,"
                   "year_of_car,low_estimate_usd,high_estimate_usd,sold_price_usd,sold,notes")

    def _score(self, lot_rows, ratings):
        d = tempfile.mkdtemp()
        paths = {k: os.path.join(d, f"{k}.csv") for k in ("lots", "ratings", "out")}
        with open(paths["lots"], "w") as f:
            f.write("\n".join([self.LOTS_HEADER, *lot_rows]) + "\n")
        with open(paths["ratings"], "w") as f:
            f.write("event,event_date,auction_rating\n")
            f.writelines(f"{e},{day},{r}\n" for e, day, r in ratings)
        with unittest.mock.patch.object(mai, "LOTS_PATH", paths["lots"]), \
             unittest.mock.patch.object(mai, "RATINGS_PATH", paths["ratings"]), \
             unittest.mock.patch.object(mai, "OUTPUT_PATH", paths["out"]), \
             unittest.mock.patch("sys.stdout", new=io.StringIO()):
            mai.main()
        with open(paths["out"]) as f:
            return {r["manufacturer"]: r for r in csv.DictReader(f)}

    def test_a_sale_with_nothing_sold_stays_out_of_avg_q(self):
        rows = self._score([
            "E1,2026-08-14,RM,1,Ferrari,250 GT,1960,1000000,1200000,1320000,true,",
            "E1,2026-08-14,RM,2,BMW,507,1957,600000,800000,,false,",
            "E2,2026-09-05,RM,1,Ferrari,275 GTB,1966,1000000,1500000,,false,",
        ], [("E1", "2026-08-14", 100), ("E2", "2026-09-05", 50)])
        ferrari, bmw = rows["Ferrari"], rows["BMW"]
        self.assertAlmostEqual(float(ferrari["avg_Q"]), 1.1)   # was 0.55
        self.assertAlmostEqual(float(ferrari["avg_R"]), 0.5)
        # E1: P 0.5 × Q 1.1 × R 1 at rating 100; E2 adds rating 50 and nothing else.
        self.assertAlmostEqual(float(ferrari["MAI_score"]), 100 * 0.5 * 1.1 / 150, places=6)
        self.assertEqual(bmw["avg_Q"], "")
        self.assertEqual(float(bmw["MAI_score"]), 0.0)   # R is 0: nothing sold

    def test_no_estimate_but_sold_at_600k_is_apex_via_sold_price(self):
        rows = self._score([
            "E1,2026-08-14,RM,1,BMW,M1,1980,,,600000,true,",
            "E1,2026-08-14,RM,2,Ferrari,250 GT,1960,1000000,1200000,1320000,true,",
        ], [("E1", "2026-08-14", 100)])
        self.assertIn("BMW", rows)
        self.assertEqual(rows["BMW"]["apex_from_sold_price"], "1")
        self.assertEqual(rows["BMW"]["apex_from_estimate"], "0")
        self.assertEqual(rows["Ferrari"]["apex_from_estimate"], "1")

    def test_a_high_estimate_of_600k_with_a_low_of_450k_is_apex(self):
        rows = self._score([
            "E1,2026-08-14,RM,1,Porsche,550,1955,450000,600000,,false,",
        ], [("E1", "2026-08-14", 100)])
        self.assertEqual(rows["Porsche"]["total_apex_lots"], "1")
        self.assertEqual(rows["Porsche"]["apex_from_estimate"], "1")

    def test_no_estimate_and_not_sold_is_not_apex(self):
        rows = self._score([
            "E1,2026-08-14,RM,1,BMW,507,1957,,,,false,",
            "E1,2026-08-14,RM,2,Ferrari,250 GT,1960,1000000,1200000,1320000,true,",
        ], [("E1", "2026-08-14", 100)])
        self.assertNotIn("BMW", rows)
        self.assertEqual(float(rows["Ferrari"]["avg_P"]), 1.0)

    def test_unknown_q_is_left_out_of_the_score_not_zeroed(self):
        # Sold with only a low estimate: apex by sold price, Q unknown.
        rows = self._score([
            "E1,2026-08-14,RM,1,Shelby,Cobra,1965,900000,,1100000,true,",
        ], [("E1", "2026-08-14", 100)])
        self.assertEqual(rows["Shelby"]["avg_Q"], "")
        self.assertAlmostEqual(float(rows["Shelby"]["avg_R"]), 1.0)
        self.assertAlmostEqual(float(rows["Shelby"]["MAI_score"]), 1.0)  # P 1 × R 1

    def test_the_sold_price_never_stands_in_for_a_missing_high_estimate_in_q(self):
        rows = self._score([
            "E1,2026-08-14,RM,1,Ferrari,250 GT,1960,1000000,1200000,1320000,true,",
            "E1,2026-08-14,RM,2,Ferrari,275 GTB,1966,,,2000000,true,",
        ], [("E1", "2026-08-14", 100)])
        self.assertAlmostEqual(float(rows["Ferrari"]["avg_Q"]), 1.1)


@unittest.skipIf(auction_rating is None, "pandas not installed")
class AuctionRatings(unittest.TestCase):

    def test_apex_lots_are_counted_by_basis(self):
        d = tempfile.mkdtemp()
        lots, out = os.path.join(d, "lots.csv"), os.path.join(d, "out.csv")
        with open(lots, "w") as f:
            f.write(MaiScores.LOTS_HEADER + "\n" + "\n".join([
                "E1,2026-08-14,RM Sotheby's,1,BMW,M1,1980,,,600000,true,",
                "E1,2026-08-14,RM Sotheby's,2,Porsche,550,1955,450000,600000,,false,",
                "E1,2026-08-14,RM Sotheby's,3,BMW,507,1957,,,,false,",
                "E1,2026-08-14,RM Sotheby's,4,Fiat,500,1960,,,20000,true,",
            ]) + "\n")
        with unittest.mock.patch.object(auction_rating, "LOTS_PATH", lots), \
             unittest.mock.patch.object(auction_rating, "OUTPUT_PATH", out), \
             unittest.mock.patch("sys.stdout", new=io.StringIO()):
            auction_rating.main()
        with open(out) as f:
            row = next(csv.DictReader(f))
        self.assertEqual((row["apex_lots"], row["apex_from_estimate"], row["apex_from_sold_price"]),
                         ("2", "1", "1"))
        self.assertEqual(row["total_lots"], "4")


if __name__ == "__main__":
    unittest.main(verbosity=2)
