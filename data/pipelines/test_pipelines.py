#!/usr/bin/env python3
"""
Tests for the signal collectors.

Everything here runs offline: the upstream calls are stubbed, so this exercises
the parts that are easy to get quietly wrong — search-phrase cleanup, month
bucketing, the anchor rescaling that makes Google Trends batches comparable,
the budget rotation, and the weight renormalization in the social composite.

Run: python3 data/pipelines/test_pipelines.py
"""

import io
import os
import sys
import tempfile
import unittest
import urllib.error
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import signal_lib as lib
import google_trends
import youtube_signals
import social_signals


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

    def test_a_dead_anchor_invalidates_the_batch(self):
        out, mean = google_trends.rescale_batch(
            {"anchor": {"2025-01": 0.0}, "X": {"2025-01": 50.0}},
            "anchor", {"X": {"manufacturer": "X", "model": "X"}}, ["2025-01"])
        self.assertEqual((out, mean), ({}, 0.0))


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


if __name__ == "__main__":
    unittest.main(verbosity=2)
