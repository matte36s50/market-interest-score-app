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
from datetime import date, datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import signal_lib as lib
import apex
import google_trends
import youtube_signals
import social_signals
import check_coverage
import model_list
import variants
import hagi_top
import export_live_lots
import export_online_sales

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


UNIVERSE = [{"manufacturer": m, "model": n} for m, n in [
    ("BMW", "E46 M3"), ("BMW", "E36 M3"), ("BMW", "2002"),
    ("Chevrolet", "CORVETTE"), ("Chevrolet", "CORVETTE Z06"), ("Chevrolet", "C/K"),
    ("Ford", "MUSTANG"), ("Ford", "Mustang 1967-1968"), ("Ford", "Fox-Body Mustang"),
    ("Ford", "A"), ("Ford", "T"), ("Ford", "F-Series 1973-1979"), ("Ford", "Expedition"),
    ("Acura", "Legend"), ("Porsche", "986 Boxster"), ("Porsche", "996 911 Carrera"),
    ("Porsche", "911 Carrera 3.2"), ("Alfa Romeo", "GTV & Spider (Type 916)"),
    ("Fiat", "124 Spider"), ("Mazda", "Mazda NA MX-5 Miata"),
    ("BMW", "E90/E92/E93 M3"), ("GMC", "GMC Sierra (T1XX 2019+)"),
]]


class YouTubeTitleMatching(unittest.TestCase):
    """The rules in youtube_signals' docstring, one by one."""

    @classmethod
    def setUpClass(cls):
        cls.m = youtube_signals.Matcher(
            UNIVERSE,
            aliases={("Ford", "T"): ["Model T"],
                     ("Ford", "F-Series 1973-1979"): ["F-250"],
                     ("Mazda", "Mazda NA MX-5 Miata"): ["NA Miata"]},
            phrases={("Ford", "A"): "Ford Model A"})

    def names(self, title):
        return [model for _, model in self.m.match(title)]

    def test_words_in_any_order_with_or_without_the_make(self):
        self.assertEqual(self.names("The E46 M3 Is the Best M3"), ["E46 M3"])
        self.assertEqual(self.names("BMW M3 CSL (E46) Review"), ["E46 M3"])

    def test_hyphens_and_spacing_are_forgiven(self):
        self.assertEqual(self.names("Fox Body Mustang GT"), ["Fox-Body Mustang"])
        self.assertEqual(self.names("Foxbody Mustang drag race"), ["Fox-Body Mustang"])

    def test_most_specific_model_of_a_make_wins(self):
        self.assertEqual(self.names("The Corvette Z06 at the track"), ["CORVETTE Z06"])
        self.assertEqual(self.names("1967 Mustang Restoration"), ["Mustang 1967-1968"])
        self.assertEqual(self.names("1965 Mustang Restoration"), ["MUSTANG"])

    def test_different_cars_in_one_title_each_count(self):
        self.assertEqual(self.names("Porsche 986 Boxster vs 996 911 Carrera"),
                         ["986 Boxster", "996 911 Carrera"])

    def test_a_year_range_needs_a_year_in_the_title(self):
        self.assertEqual(self.names("1977 Ford F-250 Highboy"), ["F-Series 1973-1979"])
        self.assertEqual(self.names("Ford F-250 Highboy"), [])
        self.assertEqual(self.names("2021 GMC Sierra AT4"), ["GMC Sierra (T1XX 2019+)"])
        self.assertEqual(self.names("1985 GMC Sierra"), [])

    def test_numbers_and_ordinary_words_need_the_make(self):
        self.assertEqual(self.names("The 5.0 Legend"), [])
        self.assertEqual(self.names("Acura Legend Coupe"), ["Legend"])
        self.assertEqual(self.names("Defender 110 Expedition"), [])
        self.assertEqual(self.names("Driving a 2002 to work"), [])
        self.assertEqual(self.names("BMW 2002 tii"), ["2002"])

    def test_a_famous_nameplate_or_a_code_stands_alone(self):
        self.assertEqual(self.names("Corvette vs 911"), ["CORVETTE"])
        self.assertEqual(self.names("E92 M3 V8 sound"), ["E90/E92/E93 M3"])

    def test_single_letters_match_only_as_a_phrase(self):
        self.assertEqual(self.names("I Bought a 1930 Ford Model A"), ["A"])
        self.assertEqual(self.names("A Ford Model T Drive"), ["T"])
        self.assertEqual(self.names("Ford T-Bird road trip"), [])

    def test_a_code_on_one_side_of_an_ampersand_applies_to_both(self):
        m = youtube_signals.Matcher(
            [{"manufacturer": "Cadillac", "model": "Cadillac Escalade & EXT GMT800"},
             {"manufacturer": "Alfa Romeo", "model": "750/101 Series Giulietta & Giulia"},
             {"manufacturer": "Mercedes-Benz", "model": "300SL Gullwing & Roadster"},
             {"manufacturer": "Cadillac", "model": "Cadillac CT5 & CT5-V"}],
            aliases={}, phrases={})
        self.assertEqual(m.match("The 2025 Cadillac Escalade IQ"), [])
        self.assertEqual(m.match("Cadillac Escalade GMT800 buyer's guide"),
                         [("Cadillac", "Cadillac Escalade & EXT GMT800")])
        self.assertEqual(m.match("I Bought an Alfa Romeo Giulia Quadrifoglio"), [])
        self.assertEqual(m.match("Mercedes 300SL Roadster at Pebble Beach"),
                         [("Mercedes-Benz", "300SL Gullwing & Roadster")])
        self.assertEqual(m.match("Cadillac CT5 commute"), [("Cadillac", "Cadillac CT5 & CT5-V")])

    def test_a_shared_word_after_an_ampersand_names_nothing_alone(self):
        self.assertEqual(self.names("The Alfa Romeo Spider Is Pure Joy"), [])
        self.assertEqual(self.names("Alfa Romeo GTV review"), ["GTV & Spider (Type 916)"])

    def test_aliases_follow_the_same_rules(self):
        self.assertEqual(self.names("Mazda Miata NA review"), ["Mazda NA MX-5 Miata"])
        self.assertEqual(self.names("Chevy C/K square body"), ["C/K"])

    def test_unrelated_titles_match_nothing(self):
        self.assertEqual(self.names("Spider-Man Car Reaction"), [])
        self.assertEqual(self.names("Top 10 Cars of 2025"), [])


class YouTubeChannelCollection(unittest.TestCase):

    def setUp(self):
        self.calls = []
        self.pages = {
            None: {"items": [
                self._item("v1", "BMW E46 M3 review", "2026-03-04T10:00:00Z"),
                self._item("v2", "Short: E46 M3 exhaust", "2026-03-02T10:00:00Z"),
                self._item("vx", "Private video", None),
            ], "nextPageToken": "p2"},
            "p2": {"items": [
                self._item("v3", "Corvette Z06 drive", "2026-02-10T10:00:00Z"),
                self._item("v4", "An old upload", "2025-12-20T10:00:00Z"),
            ], "nextPageToken": "p3"},
        }
        self.details = {
            "v1": {"id": "v1", "contentDetails": {"duration": "PT14M2S"},
                   "statistics": {"viewCount": "9000", "likeCount": "300", "commentCount": "60"}},
            "v2": {"id": "v2", "contentDetails": {"duration": "PT45S"},
                   "statistics": {"viewCount": "5000000"}},
            "v3": {"id": "v3", "contentDetails": {"duration": "PT1H2M"},
                   "statistics": {"viewCount": "1000", "likeCount": "10"}},
        }

        def fake_get(path, params, api_key):
            self.calls.append((path, params))
            if path == "channels":
                return {"items": [{"id": "UC1", "snippet": {"title": "Doug DeMuro"},
                                   "contentDetails": {"relatedPlaylists": {"uploads": "UU1"}},
                                   "statistics": {"subscriberCount": "4900000"}}]}
            if path == "playlistItems":
                return self.pages[params.get("pageToken")]
            return {"items": [self.details[i] for i in params["id"].split(",")
                              if i in self.details]}

        self._real = youtube_signals.yt_get
        youtube_signals.yt_get = fake_get

    def tearDown(self):
        youtube_signals.yt_get = self._real

    @staticmethod
    def _item(vid, title, published):
        details = {"videoId": vid}
        if published:
            details["videoPublishedAt"] = published
        return {"snippet": {"title": title}, "contentDetails": details}

    def test_paging_stops_once_it_reaches_back_past_the_window(self):
        quota = youtube_signals.Quota(1000)
        uploads, complete = youtube_signals.list_uploads("UU1", "2026-01-01", "K", quota)
        self.assertTrue(complete)
        self.assertEqual([u[0] for u in uploads], ["v1", "v2", "v3"])
        self.assertNotIn("p3", [c[1].get("pageToken") for c in self.calls])
        self.assertEqual(quota.spent, 2)       # one unit per page

    def test_a_channel_read_drops_shorts_and_vanished_videos(self):
        quota = youtube_signals.Quota(1000)
        ch = {"handle": "@DougDeMuro", "name": "Doug DeMuro"}
        videos, row = youtube_signals.read_channel(ch, "2026-01-01", "K", quota)
        self.assertEqual(row["status"], "ok")
        self.assertEqual([v["id"] for v in videos], ["v1", "v3"])
        self.assertEqual(videos[0]["month"], "2026-03")
        self.assertEqual(videos[1]["likes"], 10)
        self.assertEqual(quota.spent, 1 + 2 + 1)   # handle, two pages, one stats call

    def test_channel_names_ignore_spacing_and_punctuation(self):
        self.assertTrue(youtube_signals.name_matches("The Smoking Tire", "TheSmokingTire"))
        self.assertTrue(youtube_signals.name_matches("Hoovie's Garage", "Hoovies Garage"))
        self.assertTrue(youtube_signals.name_matches("Road & Track", "RoadandTrack"))
        self.assertTrue(youtube_signals.name_matches("MotorTrend", "MotorTrend Channel"))
        self.assertFalse(youtube_signals.name_matches("Hagerty", "Doug DeMuro"))

    def test_a_handle_that_names_another_channel_is_skipped(self):
        quota = youtube_signals.Quota(1000)
        ch = {"handle": "@DougDeMuro", "name": "Hagerty"}
        videos, row = youtube_signals.read_channel(ch, "2026-01-01", "K", quota)
        self.assertEqual(videos, [])
        self.assertEqual(row["status"], "name_mismatch")
        self.assertEqual([c[0] for c in self.calls], ["channels"])

    def test_the_budget_stops_a_run_before_the_call_that_would_overrun_it(self):
        quota = youtube_signals.Quota(2)
        with self.assertRaises(youtube_signals.BudgetSpent):
            youtube_signals.read_channel({"handle": "@DougDeMuro", "name": "Doug DeMuro"},
                                         "2026-01-01", "K", quota)
        self.assertEqual(quota.spent, 2)

    def test_durations(self):
        self.assertEqual(youtube_signals.duration_seconds("PT1H2M3S"), 3723)
        self.assertEqual(youtube_signals.duration_seconds("PT45S"), 45)
        self.assertEqual(youtube_signals.duration_seconds("P0D"), 0)
        self.assertEqual(youtube_signals.duration_seconds(""), 0)


class YouTubeShares(unittest.TestCase):

    def test_share_of_the_trailing_twelve_months_and_zeros_for_the_rest(self):
        videos = [
            {"title": "x", "month": "2026-01", "views": 600, "likes": 30, "comments": 10,
             "keys": [("BMW", "E46 M3")]},
            {"title": "y", "month": "2026-01", "views": 400, "likes": 0, "comments": 0,
             "keys": []},
            {"title": "z", "month": "2026-02", "views": 1000, "likes": 0, "comments": 0,
             "keys": [("BMW", "E46 M3"), ("Chevrolet", "CORVETTE")]},
        ]
        months = ["2026-01", "2026-02"]
        per, totals, examples = youtube_signals.aggregate(
            videos, youtube_signals.fetch_months(months))
        self.assertEqual(totals["2026-01"], 1000)
        periods = {("BMW", "E46 M3"): {"2026-01", "2026-02"},
                   ("Porsche", "986 Boxster"): {"2026-02"},
                   ("Ford", "MUSTANG"): {"2025-06"}}      # outside the output months
        rows = youtube_signals.build_rows(per, totals, periods, months, "T")
        got = {(r["model"], r["month"]): r for r in rows}
        jan, feb = got[("E46 M3", "2026-01")], got[("E46 M3", "2026-02")]
        self.assertEqual(jan["yt_view_share"], 60.0)
        # February's window holds both months: (600 + 1000) of 2,000 views.
        self.assertEqual(feb["yt_views_12m"], 1600)
        self.assertEqual(feb["yt_view_share"], 80.0)
        # The monthly columns stay monthly.
        self.assertEqual((feb["yt_videos"], feb["yt_views"]), (1, 1000))
        self.assertAlmostEqual(jan["yt_engagement_rate"], 40 / 600, places=6)
        self.assertEqual(got[("CORVETTE", "2026-02")]["yt_view_share"], 50.0)
        self.assertNotIn(("CORVETTE", "2026-01"), got)          # nothing before its video
        self.assertEqual(got[("986 Boxster", "2026-02")]["yt_view_share"], 0.0)   # a measured zero
        self.assertNotIn(("MUSTANG", "2025-06"), got)
        self.assertEqual(examples[("BMW", "E46 M3")], (1000, "z"))

    def test_a_video_counts_for_twelve_months_and_then_stops(self):
        videos = [{"title": "x", "month": "2025-03", "views": 100, "likes": 0, "comments": 0,
                   "keys": [("BMW", "E46 M3")]},
                  {"title": "y", "month": "2025-03", "views": 100, "likes": 0, "comments": 0,
                   "keys": []},
                  {"title": "w", "month": "2026-03", "views": 100, "likes": 0, "comments": 0,
                   "keys": []}]
        months = ["2026-02", "2026-03"]
        per, totals, _ = youtube_signals.aggregate(videos, youtube_signals.fetch_months(months))
        rows = youtube_signals.build_rows(per, totals, {}, months, "T")
        got = {r["month"]: r["yt_view_share"] for r in rows if r["model"] == "E46 M3"}
        self.assertEqual(got, {"2026-02": 50.0})                 # 2025-03 is still in Feb's window

    def test_fetch_reaches_back_eleven_months(self):
        self.assertEqual(youtube_signals.fetch_months(["2026-01", "2026-02"])[0], "2025-02")
        self.assertEqual(youtube_signals.shift_month("2026-01", -1), "2025-12")
        self.assertEqual(youtube_signals.shift_month("2025-12", 1), "2026-01")
        self.assertEqual(len(youtube_signals.trailing("2026-03")), 12)

    def test_only_cars_are_scored(self):
        universe = [{"manufacturer": "BMW", "model": "E46 M3", "vehicle_class": "car"},
                    {"manufacturer": "Ducati", "model": "916", "vehicle_class": "motorcycle"},
                    {"manufacturer": "Riva", "model": "Aquarama", "vehicle_class": "boat"},
                    {"manufacturer": "Ford", "model": "A", "vehicle_class": ""}]
        periods = {("BMW", "E46 M3"): {"2026-01"}, ("Ducati", "916"): {"2026-01"},
                   ("Riva", "Aquarama"): {"2026-01"}, ("Ford", "A"): {"2026-01"}}
        cars, car_periods = youtube_signals.cars_only(universe, periods)
        self.assertEqual([r["model"] for r in cars], ["E46 M3", "A"])
        self.assertEqual(set(car_periods), {("BMW", "E46 M3"), ("Ford", "A")})
        rows = youtube_signals.build_rows({}, {"2026-01": 100}, car_periods, ["2026-01"], "T")
        self.assertNotIn("916", {r["model"] for r in rows})   # no zero for a bike

    def test_window_runs_from_the_first_mii_month_to_now(self):
        months = youtube_signals.window_months({("a", "b"): {"2025-11", "2026-01"}},
                                               today=date(2026, 2, 14))
        self.assertEqual(months, ["2025-11", "2025-12", "2026-01", "2026-02"])

    def test_period_months_expand_quarters(self):
        self.assertEqual(lib.period_months("2025Q2"), ["2025-04", "2025-05", "2025-06"])
        self.assertEqual(lib.period_months("2025-07"), ["2025-07"])
        self.assertEqual(lib.period_months(""), [])


class YouTubeChannelState(unittest.TestCase):

    def test_a_handle_taken_off_the_list_drops_out_of_the_state_file(self):
        path = os.path.join(tempfile.mkdtemp(), "channels_state.csv")
        lib.write_rows(path, youtube_signals.CHANNEL_FIELDS, [
            {"handle": "@hemmings", "status": "not_found"},
            {"handle": "@Hagerty", "status": "ok", "measured_at": "2026-10-01T00:00:00Z"},
        ])
        youtube_signals.save_channel_state(
            [{"handle": "@hemmingsmotornews", "status": "ok"}],
            [{"handle": "@Hagerty"}, {"handle": "@hemmingsmotornews"}], path)
        rows = {r["handle"]: r for r in lib.read_rows(path)}
        self.assertEqual(set(rows), {"@Hagerty", "@hemmingsmotornews"})
        self.assertEqual(rows["@Hagerty"]["measured_at"], "2026-10-01T00:00:00Z")


class ModelList(unittest.TestCase):
    """model_list.py: one name per car, and nothing renamed that is not a
    duplicate."""

    def build(self, names, overrides=None):
        uni = [{"manufacturer": m, "model": n, "auction_count": a} for m, n, a in names]
        return {(r["manufacturer"], r["source_model"]): r for r in model_list.build(uni, overrides)}

    def test_case_and_brand_prefix_are_one_model_named_by_its_group(self):
        rows = self.build([("Volkswagen", "Volkswagen Tiguan", 5), ("Volkswagen", "TIGUAN", 9),
                           ("Volkswagen", "VOLKSWAGEN TIGUAN", 2)])
        self.assertEqual({r["model"] for r in rows.values()}, {"Volkswagen Tiguan"})
        self.assertEqual(rows[("Volkswagen", "TIGUAN")]["rule"], "case or prefix")

    def test_a_listing_counter_is_dropped_only_from_a_title_onto_a_known_model(self):
        rows = self.build([("Ford", "MUSTANG", 40), ("Ford", "MUSTANG 903", 1),
                           ("Ford", "MUSTANG GT500CR 900S 5", 1),
                           ("Porsche", "991 911 Carrera", 30), ("Porsche", "991 911 Carrera 4", 9),
                           ("BMW", "2002", 3)])
        self.assertEqual(rows[("Ford", "MUSTANG 903")]["model"], "MUSTANG")
        self.assertEqual(rows[("Ford", "MUSTANG 903")]["rule"], "listing counter")
        # Nothing to fall back to: the number stays.
        self.assertEqual(rows[("Ford", "MUSTANG GT500CR 900S 5")]["model"], "MUSTANG GT500CR 900S 5")
        # A Bring a Trailer group's own number is a trim, never a counter.
        self.assertEqual(rows[("Porsche", "991 911 Carrera 4")]["model"], "991 911 Carrera 4")
        self.assertEqual(rows[("BMW", "2002")]["model"], "2002")

    def test_word_order_and_overrides(self):
        rows = self.build([("Mercedes-Benz", "AMG G63", 18), ("Mercedes-Benz", "G63 AMG", 25),
                           ("Porsche", "996 Turbo", 40), ("Porsche", "996 911 Turbo", 77)],
                          {model_list.model_key("Porsche", "996 Turbo"): {"model": "996 911 Turbo", "flag": ""}})
        self.assertEqual(rows[("Mercedes-Benz", "AMG G63")]["model"], "G63 AMG")
        self.assertEqual(rows[("Porsche", "996 Turbo")]["model"], "996 911 Turbo")
        self.assertEqual(rows[("Porsche", "996 Turbo")]["rule"], "override")

    def test_short_codes_are_group_names_not_titles(self):
        self.assertFalse(model_list.is_upper("R8"))
        self.assertFalse(model_list.is_upper("300E"))
        self.assertTrue(model_list.is_upper("SL55 AMG"))
        self.assertTrue(model_list.is_upper("MUSTANG 903"))

    def test_flags(self):
        rows = self.build([("Ford", "MUSTANG", 40), ("Ford", "Mustang 1964.5-1966", 50),
                           ("Ford", "Fox-Body Mustang", 60), ("Shelby", "Shelby Cobra Replica", 9),
                           ("Audi", "R8", 20), ("Audi", "R8 V10", 5)])
        self.assertEqual(rows[("Ford", "MUSTANG")]["flag"], "catch-all")
        self.assertEqual(rows[("Shelby", "Shelby Cobra Replica")]["flag"], "replica")
        self.assertEqual(rows[("Audi", "R8")]["flag"], "")

    def test_load_universe_measures_each_model_once(self):
        d = tempfile.mkdtemp()
        mii = os.path.join(d, "mii.csv")
        lib.write_rows(mii, ["manufacturer", "model", "quarter", "auction_count"], [
            {"manufacturer": "Volkswagen", "model": "Volkswagen Tiguan", "quarter": "2026-01", "auction_count": "2"},
            {"manufacturer": "Volkswagen", "model": "TIGUAN", "quarter": "2026-02", "auction_count": "3"},
        ])
        models = os.path.join(d, "models.csv")
        lib.write_rows(models, model_list.FIELDS, model_list.build(lib.load_universe(mii, raw=True)))
        with unittest.mock.patch.object(lib, "MODELS_PATH", models):
            periods = {}
            uni = lib.load_universe(mii, periods=periods)
        self.assertEqual([(r["model"], r["auction_count"]) for r in uni], [("Volkswagen Tiguan", 5)])
        self.assertEqual(periods[("Volkswagen", "Volkswagen Tiguan")], {"2026-01", "2026-02"})


class Variants(unittest.TestCase):
    """variants.py: an index constituent recognised from a listing title."""

    @classmethod
    def setUpClass(cls):
        cls.v = {v["id"]: v for v in variants.load_variants()}

    def hit(self, vid, make, url):
        t = variants.title_of(url)
        return variants.matches(self.v[vid], make, t, variants.year_of(t))

    def test_title_and_year_come_from_the_url(self):
        t = variants.title_of("https://bringatrailer.com/listing/1973-porsche-911-carrera-rs-2-7-lightweight/")
        self.assertEqual(t, "1973 porsche 911 carrera rs 2 7 lightweight")
        self.assertEqual(variants.year_of(t), 1973)

    def test_the_finer_variant_wins_its_own_row(self):
        url = "https://bringatrailer.com/listing/1973-porsche-911-carrera-rs-2-7-lightweight/"
        self.assertTrue(self.hit("porsche-911-rs-lightweight", "Porsche", url))
        self.assertFalse(self.hit("porsche-911-rs-touring", "Porsche", url))
        self.assertTrue(self.hit("porsche-911-rs-touring", "Porsche",
                                 "https://bringatrailer.com/listing/1973-porsche-911-carrera-rs-2-7-2/"))

    def test_years_bound_a_name_reused_later(self):
        self.assertTrue(self.hit("mb-280sl", "Mercedes-Benz", "https://bringatrailer.com/listing/1970-mercedes-benz-280sl-150/"))
        self.assertFalse(self.hit("mb-280sl", "Mercedes-Benz", "https://bringatrailer.com/listing/1982-mercedes-benz-280sl/"))

    def test_replicas_and_conversions_are_not_the_car(self):
        self.assertFalse(self.hit("porsche-550", "Porsche", "https://bringatrailer.com/listing/1955-beck-550-spyder-8/"))
        self.assertFalse(self.hit("ford-gt40", "Ford", "https://bringatrailer.com/listing/1968-ford-mustang-gt-40/"))
        self.assertFalse(self.hit("ferrari-365-daytona-spider", "Ferrari",
                                  "https://bringatrailer.com/listing/1969-ferrari-365-gts-4-spider-conversion/"))
        self.assertTrue(self.hit("ferrari-365-daytona", "Ferrari",
                                 "https://bringatrailer.com/listing/1973-ferrari-365-gtb-4-daytona-3/"))

    def test_every_row_compiles_and_names_an_index(self):
        for v in self.v.values():
            self.assertTrue(v["index_list"], v["id"])
            self.assertTrue(v["from"] and v["to"] and v["from"] <= v["to"], v["id"])


class HagiTop(unittest.TestCase):
    """hagi_top.py: the HAGI Top cars among the Apex lots."""

    def lot(self, **kw):
        base = {"event": "Sale", "event_date": "2026-08-15", "auction_house": "House",
                "sold": True, "sold_price_usd": None, "high_estimate_usd": None,
                "is_apex": False, "apex_value": None, "notes": ""}
        base.update(kw)
        return base

    def test_a_bring_a_trailer_lot_is_read_from_its_slug(self):
        lot = self.lot(manufacturer="Mercedes-Benz", model="300SL Gullwing & Roadster", year_of_car=None,
                       notes="bat:1960-mercedes-benz-300sl-roadster-8")
        self.assertEqual(hagi_top.lot_title(lot), "1960 mercedes benz 300sl roadster 8")
        self.assertEqual([v["id"] for v, _ in hagi_top.match([lot])], ["mb-300sl-roadster"])

    def test_a_live_lot_is_read_from_year_make_and_model(self):
        lot = self.lot(manufacturer="Lamborghini", model="Miura P400 SV", year_of_car=1971.0)
        self.assertEqual(hagi_top.lot_title(lot), "1971 lamborghini miura p400 sv")
        self.assertEqual([v["id"] for v, _ in hagi_top.match([lot])], ["lamborghini-miura-sv"])

    def test_other_cars_and_replicas_do_not_match(self):
        lots = [self.lot(manufacturer="Lamborghini", model="Miura P400 S", year_of_car=1969),
                self.lot(manufacturer="Porsche", model="911 Carrera RS 2.7", year_of_car=1973),
                self.lot(manufacturer="Ford", model="GT40 Replica by Superformance", year_of_car=1966)]
        self.assertEqual(hagi_top.match(lots), [])

    def test_a_price_far_below_the_cars_others_is_set_aside(self):
        lots = [self.lot(manufacturer="Mercedes-Benz", model="300 SL Gullwing", year_of_car=1955, sold_price_usd=p)
                for p in (1_800_000, 1_900_000, 2_000_000, 325_000)]
        rows = hagi_top.rows(hagi_top.match(lots), {}, {}, 0)
        self.assertEqual([r["suspect"] for r in rows].count("true"), 1)
        self.assertEqual([r["sold_price_usd"] for r in rows if r["suspect"] == "true"], [325000])

    def test_shares_are_the_mai_weight_of_each_highlight(self):
        # Sale A (rating 30, 3 highlights) and sale B (rating 10, 2): a HAGI
        # Top highlight at each weighs 30/3 and 10/2 of the 40 total.
        a = self.lot(event="A", manufacturer="Toyota", model="2000GT", year_of_car=1967, is_apex=True, apex_value=1e6)
        b = self.lot(event="B", manufacturer="Jaguar", model="XJ220", year_of_car=1993, is_apex=True, apex_value=5e5)
        c = self.lot(event="B", manufacturer="BMW", model="M1", year_of_car=1980, is_apex=False)
        ratings = {("A", "2026-08-15"): 30.0, ("B", "2026-08-15"): 10.0}
        counts = {("A", "2026-08-15"): 3, ("B", "2026-08-15"): 2}
        rows = {r["variant_id"]: r for r in hagi_top.rows(hagi_top.match([a, b, c]), ratings, counts, 40.0)}
        self.assertAlmostEqual(float(rows["toyota-2000gt"]["share"]), 0.25)
        self.assertAlmostEqual(float(rows["jaguar-xj220"]["share"]), 0.125)
        self.assertEqual(rows["bmw-m1"]["share"], "0")
        self.assertEqual(rows["bmw-m1"]["highlight"], "false")


class SignalCoverage(unittest.TestCase):
    """check_coverage.py: an unset secret warns; configured-but-empty or
    stale fails; zero rows are not coverage."""

    NOW = datetime(2026, 10, 14, 12, tzinfo=timezone.utc)
    SIGNALS = [
        {"name": "YouTube", "file": "yt.csv", "value": "yt_view_share",
         "env": ("YOUTUBE_API_KEY",), "min_models": 2, "max_age_days": 3},
        {"name": "Reddit", "file": "reddit.csv", "value": "reddit_posts",
         "env": ("REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"), "min_models": 1,
         "max_age_days": 7},
        {"name": "Social composite", "file": "social.csv", "value": "social_score",
         "env": (), "min_models": 1, "max_age_months": 2},
    ]
    YT_ENV = {"HAVE_YOUTUBE_API_KEY": "true"}

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.yt([("A", "1", "2026-10", "0.5"), ("B", "2", "2026-10", "0.1")])
        self.write("social.csv", ["manufacturer", "model", "month", "social_score"],
                   [("A", "1", "2026-09", "70")])
        self.write("reddit.csv", ["manufacturer", "model", "month", "reddit_posts",
                                  "measured_at"], [])
        self.write("youtube_channels.csv", ["handle", "name", "focus"],
                   [("@Hagerty", "Hagerty", ""), ("@hemmings", "Hemmings", "")])
        self.write("youtube_channels_state.csv", youtube_signals.CHANNEL_FIELDS, [
            {"handle": "@Hagerty", "status": "ok"},
            {"handle": "@hemmings", "status": "not_found", "note": "no channel has this handle"},
            {"handle": "@donutmedia", "status": "not_found"},
        ])

    def write(self, name, fields, rows):
        rows = [r if isinstance(r, dict) else dict(zip(fields, r)) for r in rows]
        lib.write_rows(os.path.join(self.dir, name), fields, rows)

    def yt(self, rows, measured_at="2026-10-14T06:30:00Z"):
        self.write("yt.csv", ["manufacturer", "model", "month", "yt_view_share", "measured_at"],
                   [r + (measured_at,) for r in rows])

    def run_check(self, env):
        return check_coverage.check(self.dir, env, self.NOW, self.SIGNALS)

    def levels(self, results, name):
        return [level for level, msg in results if msg.startswith(name)]

    def test_healthy_data_passes_and_unset_reddit_only_warns(self):
        results = self.run_check(self.YT_ENV)
        self.assertEqual(self.levels(results, "YouTube:"), ["ok"])
        self.assertEqual(self.levels(results, "Social composite"), ["ok"])
        [(level, msg)] = [r for r in results if r[1].startswith("Reddit")]
        self.assertEqual(level, "warning")
        self.assertIn("REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET", msg)

    def test_configured_but_empty_fails(self):
        env = dict(self.YT_ENV, REDDIT_CLIENT_ID="id", REDDIT_CLIENT_SECRET="secret")
        self.assertEqual(self.levels(self.run_check(env), "Reddit"), ["error"])

    def test_zero_rows_are_not_coverage(self):
        self.yt([("A", "1", "2026-10", "0.0"), ("B", "2", "2026-10", "0.0"),
                 ("C", "3", "2026-10", "0.2")])
        self.assertEqual(self.levels(self.run_check(self.YT_ENV), "YouTube:"), ["error"])

    def test_a_collector_that_stopped_writing_fails(self):
        self.yt([("A", "1", "2026-10", "0.5"), ("B", "2", "2026-10", "0.1")],
                measured_at="2026-10-09T06:30:00Z")
        self.assertEqual(self.levels(self.run_check(self.YT_ENV), "YouTube:"), ["error"])
        self.write("social.csv", ["manufacturer", "model", "month", "social_score"],
                   [("A", "1", "2026-06", "70")])
        self.assertEqual(self.levels(self.run_check(self.YT_ENV), "Social composite"),
                         ["error"])

    def test_listed_channels_that_fail_warn_and_unlisted_ones_are_ignored(self):
        msgs = [m for level, m in self.run_check(self.YT_ENV)
                if m.startswith("YouTube channel")]
        self.assertEqual(len(msgs), 1)
        self.assertIn("@hemmings", msgs[0])
        self.assertIn("youtube_channels.csv", msgs[0])

    def test_unset_youtube_key_warns_and_skips_the_channel_check(self):
        results = self.run_check({})
        self.assertEqual(self.levels(results, "YouTube"), ["warning"])


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

    def test_house_names_and_sale_names_resolve_to_the_digest_codes(self):
        for raw, code in [("RM Sothebys", "RMS"), ("RM Sotheby's", "RMS"),
                          ("RM Miami 2026", "RMS"), ("Gooding", "GCH"),
                          ("Gooding Amelia Island 2026", "GCH"),
                          ("Broad Arrow Villa d'Este 2026", "BAA"), ("Air/Water", "BAA"),
                          ("Bonhams", "BON"), ("Bonhams|Cars Online", "BCO"),
                          ("duPont REGISTRY Live", "DPR"), ("duPont Registry", "DPR"),
                          ("duPont Registry Live Week 47", "DPR")]:
            row, _ = export_live_lots.to_csv_row(_store_lot(auction_house=raw))
            self.assertEqual(row["auction_house_code"], code, raw)
            self.assertEqual(row["auction_house"], export_live_lots.HOUSES[code], raw)

    def test_manufacturer_names_are_trimmed_and_corrected(self):
        for raw, fixed in [("Mercedez-Benz", "Mercedes-Benz"), ("Mclaren", "McLaren"),
                           ("Ferrari ", "Ferrari"), (" Osca ", "OSCA"), ("Rools  Royce", "Rolls-Royce"),
                           ("Mercedes", "Mercedes-Benz"), ("Lola-Ford", "Lola-Ford"), ("Zagato", "Zagato")]:
            row, _ = export_live_lots.to_csv_row(_store_lot(make=raw))
            self.assertEqual(row["manufacturer"], fixed, raw)

    def test_committed_csvs_carry_only_corrected_manufacturer_names(self):
        for path in (export_live_lots.LOTS_PATH, export_live_lots.UPCOMING_PATH):
            makes = {r["manufacturer"] for r in lib.read_rows(path)}
            bad = {m for m in makes if export_live_lots.make_name(m) != m}
            self.assertEqual(bad, set(), os.path.basename(path))

    def test_excluded_lots_stay_out_and_say_why(self):
        lot = _store_lot(source_listing_id="rm-monterey-auction-2026-lot-345", make="Ferrari",
                         model="Luce", trim="Tailor Made", price_all_in=44000000.0)
        row, why = export_live_lots.to_csv_row(lot)
        self.assertIsNone(row)
        self.assertTrue(why.startswith("excluded: one-off commission"))
        row, why = export_live_lots.to_upcoming_row(dict(lot, status="upcoming", event_date="2099-01-01"))
        self.assertIsNone(row)
        self.assertTrue(why.startswith("excluded:"))

    def test_committed_csvs_hold_no_excluded_lot(self):
        for path in (export_live_lots.LOTS_PATH, export_live_lots.UPCOMING_PATH):
            ids = {(r.get("notes") or "").split(";")[0].removeprefix("store:") for r in lib.read_rows(path)}
            self.assertEqual(ids & set(export_live_lots.EXCLUDED_LOTS), set(), os.path.basename(path))

    def test_misspelt_sale_names_are_corrected(self):
        for raw, fixed in [("Bonhams Leguna Seca", "Bonhams Laguna Seca"),
                           ("THE TEGERNSEE AUCTION", "The Tegernsee Auction")]:
            row, _ = export_live_lots.to_csv_row(_store_lot(event=raw))
            self.assertEqual(row["event"], fixed)

    def test_unknown_houses_fail_the_run_naming_each_and_write_nothing(self):
        out = os.path.join(tempfile.mkdtemp(), "lots.csv")
        store = [_store_lot(), _store_lot(auction_house="Christie's"),
                 _store_lot(auction_house="Osenat"), _store_lot(auction_house="Osenat")]
        env = {"CANONICAL_SUPABASE_URL": "https://x.supabase.co", "CANONICAL_SUPABASE_ANON_KEY": "anon"}
        with unittest.mock.patch.dict(os.environ, env), \
             unittest.mock.patch("sys.stdout", new=io.StringIO()) as log:
            code = export_live_lots.main(["--out", out, "--upcoming-out", out + ".up"],
                                         fetch=lambda url, key: store, fx=lambda c, d: 1.0)
        self.assertEqual(code, 1)
        self.assertIn("::error::Unknown auction house value(s) in the store: \"Christie's\"; 'Osenat'",
                      log.getvalue())
        self.assertFalse(os.path.exists(out))
        self.assertFalse(os.path.exists(out + ".up"))

    def test_every_house_in_the_committed_csvs_is_in_houses(self):
        for path in (export_live_lots.LOTS_PATH, export_live_lots.UPCOMING_PATH,
                     export_online_sales.OUT_PATH):
            if path == export_online_sales.OUT_PATH and not os.path.exists(path):
                continue  # written by the workflow's first run with online sales
            rows = lib.read_rows(path)
            self.assertTrue(rows, path)
            bad = {(r.get("auction_house"), r.get("auction_house_code")) for r in rows
                   if export_live_lots.HOUSES.get(r.get("auction_house_code")) != r.get("auction_house")}
            self.assertEqual(bad, set(), os.path.basename(path))


class ApexRule(unittest.TestCase):
    """A lot's apex value is its high estimate, else its sold price if it
    sold; the highlights of a sale are its top 10% of lots by that value."""

    def test_no_estimate_but_sold_uses_the_sold_price(self):
        lot = {"high_estimate_usd": "", "sold_price_usd": "600000", "sold": "true"}
        self.assertEqual(apex.apex_value(lot), 600000)
        self.assertEqual(apex.apex_basis(lot), "sold_price")

    def test_the_high_estimate_counts_not_the_low_one(self):
        lot = {"low_estimate_usd": "450000", "high_estimate_usd": "600000",
               "sold_price_usd": "", "sold": "false"}
        self.assertEqual(apex.apex_value(lot), 600000)
        self.assertEqual(apex.apex_basis(lot), "estimate")

    def test_no_estimate_and_not_sold_has_no_value(self):
        lot = {"high_estimate_usd": float("nan"), "sold_price_usd": float("nan"), "sold": False}
        self.assertIsNone(apex.apex_value(lot))
        self.assertEqual(apex.apex_basis(lot), "none")

    def test_an_estimate_wins_over_the_sold_price(self):
        lot = {"high_estimate_usd": "400000", "sold_price_usd": "700000", "sold": "true"}
        self.assertEqual(apex.apex_value(lot), 400000)

    def test_highlights_are_the_top_ten_percent_rounded_up_from_twenty_lots(self):
        self.assertEqual([apex.highlight_count(n) for n in (4, 19, 20, 21, 30, 187)],
                         [0, 0, 2, 3, 3, 19])

    def test_spellings_of_one_make_unify_but_distinct_makes_stay_apart(self):
        names = ["Mercedes-Benz"] * 3 + ["Mercedes Benz", "MERCEDES-BENZ", "Mercedes", "Mercedes-AMG",
                                         "Harley-Davidson", "Harley Davidson", "Harley Davidson", "Ford"]
        self.assertEqual(apex.unify_makes(names), {
            "Mercedes-Benz": "Mercedes-Benz", "Mercedes Benz": "Mercedes-Benz", "MERCEDES-BENZ": "Mercedes-Benz",
            "Harley-Davidson": "Harley Davidson", "Harley Davidson": "Harley Davidson",
        })

    def test_no_sale_has_more_than_25_highlights(self):
        # Only an online month gets near it: Bring a Trailer sells 3,000-5,000 cars a month.
        self.assertEqual([apex.highlight_count(n) for n in (240, 250, 251, 5349)], [24, 25, 25, 25])

    @unittest.skipIf(mai is None, "pandas not installed")
    def test_top_lots_of_each_sale_are_marked(self):
        import pandas as pd
        lots = [{"event": "E", "event_date": "d", "high_estimate_usd": None,
                 "sold_price_usd": 1000 * (i + 1), "sold": "true"} for i in range(20)]
        lots[3] = {**lots[3], "sold_price_usd": None, "sold": "false"}   # unranked
        lots[5] = {**lots[5], "high_estimate_usd": 20000}                # ties lot 19
        df = apex.add_apex_columns(pd.DataFrame(lots))
        self.assertEqual(list(df.index[df["is_apex"]]), [5, 19])          # tie: listed first
        small = apex.add_apex_columns(pd.DataFrame(lots[:19]))
        self.assertFalse(small["is_apex"].any())


def _sale(event, date, top, filler_price=1000, n=20):
    """CSV rows for one sale of n lots: `top` rows (strings without the sale
    prefix) followed by cheap filler lots that never make its top 10%."""
    rows = [f"{event},{date},RM,{i},{t}" for i, t in enumerate(top, 1)]
    rows += [f"{event},{date},RM,{i},Filler,Car,1990,,,{filler_price},true,"
             for i in range(len(top) + 1, n + 1)]
    return rows


def _bat(day, make, amount, sold=True, slug=None, model="Model"):
    return {"auction_url": f"https://bringatrailer.com/listing/{slug or f'{make}-{day}-{amount}'}/",
            "sale_date": day, "make": make, "model": model, "year": "",
            "sale_amount": amount, "sale_type": "sold" if sold else "high bid"}


class OnlineSales(unittest.TestCase):
    """Bring a Trailer: each completed month is one sale, in the
    auction_lots.csv schema, so its top 25 are scored like any sale's."""

    TODAY = date(2026, 10, 11)

    def _build(self, rows, fx=lambda c, d: {"EUR": 1.25}.get(c)):
        return export_online_sales.build(rows, self.TODAY, fx)

    def test_a_month_is_a_sale_with_bat_prices_and_unsold_high_bids(self):
        rows, report = self._build([
            _bat("8/14/2026", "Porsche", "USD $725,000", slug="1973-porsche-911-carrera-rs"),
            _bat("8/20/26", "Mercedez-Benz", "USD $86,000", sold=False),
            _bat("8/30/2026", "Ferrari", "EUR €400,000"),
        ])
        self.assertEqual(report["months"], ["2026-08"])
        by_make = {r["manufacturer"]: r for r in rows}
        rs = by_make["Porsche"]
        self.assertEqual((rs["event"], rs["event_date"]), ("Bring a Trailer – August 2026", "2026-08-31"))
        self.assertEqual((rs["auction_house"], rs["auction_house_code"]), ("Bring a Trailer", "BAT"))
        self.assertEqual(rs["auction_house"], export_live_lots.HOUSES["BAT"])
        self.assertEqual((rs["sold_price_usd"], rs["sold"]), ("725000", "true"))
        self.assertEqual(rs["notes"], "bat:1973-porsche-911-carrera-rs")
        self.assertEqual(rs["high_estimate_usd"], "")
        self.assertEqual(rs["year_of_car"], "1973")                    # from the listing slug
        unsold = by_make["Mercedes-Benz"]            # make corrected, high bid never a price
        self.assertEqual((unsold["sold_price_usd"], unsold["sold"]), ("", "false"))
        self.assertEqual(by_make["Ferrari"]["sold_price_usd"], "500000")
        self.assertTrue(by_make["Ferrari"]["notes"].endswith("; EUR at 1.2500 USD"))

    def test_the_make_is_not_repeated_in_the_model(self):
        rows, _ = self._build([_bat("8/1/2026", "Porsche", "USD $1", model="Porsche 918 Spyder"),
                               _bat("8/4/2026", "Mercedes-Benz", "USD $1", model="190E"),
                               _bat("8/5/2026", "Mercedes Benz", "USD $1", model="320 Cabriolet A"),
                               _bat("8/2/2026", "Mercedez-Benz", "USD $1", model="Mercedez-Benz 300SL"),
                               _bat("8/3/2026", "Ford", "USD $1", model="GT")])
        self.assertEqual(sorted(r["model"] for r in rows), ["190E", "300SL", "320 Cabriolet A", "918 Spyder", "GT"])
        self.assertEqual({r["manufacturer"] for r in rows}, {"Porsche", "Mercedes-Benz", "Ford"})

    def test_only_completed_months_and_never_a_partial_scrape(self):
        rows = [_bat(f"{m}/{d}/2026", "Ford", "USD $50,000") for m in (6, 7, 8) for d in range(1, 21)]
        rows += [_bat(f"9/{d}/2026", "Ford", "USD $50,000") for d in range(1, 6)]     # a third of a month
        rows += [_bat("10/2/2026", "Ford", "USD $50,000")]                           # still running
        rows += [_bat("12/31/69", "Ford", "USD $50,000"), _bat("1/1/2027", "Ford", "USD $50,000")]
        out, report = self._build(rows)
        self.assertEqual(report["months"], ["2026-06", "2026-07", "2026-08"])
        self.assertEqual(report["skipped_months"], {"2026-09": 5})
        self.assertEqual(report["bad"], {"no date": 1, "future date": 1})
        self.assertEqual(len(out), 60)

    def test_a_currency_without_a_rate_is_skipped_and_counted(self):
        out, report = self._build([_bat("8/1/2026", "Ford", "USD $1,000"), _bat("8/2/2026", "Ford", "CHF 5,000")])
        self.assertEqual(len(out), 1)
        self.assertEqual(report["no_rate"], {"CHF": 1})

    def test_an_unreachable_bat_csv_leaves_the_file_alone(self):
        out = os.path.join(tempfile.mkdtemp(), "online.csv")
        with unittest.mock.patch("sys.stdout", new=io.StringIO()) as log:
            code = export_online_sales.main(["--out", out], fetch=lambda: None, today=self.TODAY)
        self.assertEqual(code, 0)
        self.assertIn("::warning::", log.getvalue())
        self.assertFalse(os.path.exists(out))

    def test_bat_csv_is_read_from_the_downloaded_copy(self):
        src = os.path.join(tempfile.mkdtemp(), "bat.csv")
        with open(src, "w", encoding="utf-8") as f:
            f.write("auction_url,make\nhttps://bringatrailer.com/listing/x/,Ford\n")
        with unittest.mock.patch.dict(os.environ, {"BAT_CSV": src}), \
                unittest.mock.patch.object(export_online_sales.lib, "http_get") as get:
            text = export_online_sales.read_bat_csv()
        self.assertIn("listing/x/,Ford", text)
        get.assert_not_called()


@unittest.skipIf(mai is None, "pandas not installed")
class MaiScores(unittest.TestCase):
    """MAI is a make's share of all highlight value: its share of each sale's
    top lots, weighted by what it takes to be a top lot there."""

    LOTS_HEADER = ("event,event_date,auction_house,lot_number,manufacturer,model,"
                   "year_of_car,low_estimate_usd,high_estimate_usd,sold_price_usd,sold,notes")

    def _score(self, lot_rows, ratings, online=None):
        d = tempfile.mkdtemp()
        paths = {k: os.path.join(d, f"{k}.csv") for k in ("lots", "ratings", "out")}
        if online:
            paths["online"] = online
        with open(paths["lots"], "w") as f:
            f.write("\n".join([self.LOTS_HEADER, *lot_rows]) + "\n")
        with open(paths["ratings"], "w") as f:
            f.write("event,event_date,auction_rating\n")
            f.writelines(f"{e},{day},{r}\n" for e, day, r in ratings)
        with unittest.mock.patch.object(mai, "LOTS_PATH", paths["lots"]), \
             unittest.mock.patch.object(mai, "ONLINE_PATH", paths.get("online", os.path.join(d, "none.csv"))), \
             unittest.mock.patch.object(mai, "RATINGS_PATH", paths["ratings"]), \
             unittest.mock.patch.object(mai, "OUTPUT_PATH", paths["out"]), \
             unittest.mock.patch.object(mai, "DETAIL_PATH", os.path.join(d, "detail.csv")), \
             unittest.mock.patch.object(mai, "APEX_LOTS_PATH", os.path.join(d, "apex_lots.csv")), \
             unittest.mock.patch.object(mai, "HAGI_TOP_PATH", os.path.join(d, "hagi_top_lots.csv")), \
             unittest.mock.patch("sys.stdout", new=io.StringIO()):
            mai.main()
        with open(paths["out"]) as f:
            return {r["manufacturer"]: r for r in csv.DictReader(f)}

    def test_score_is_rating_weighted_share_of_all_highlights(self):
        rows = self._score(
            _sale("E1", "2026-08-14", ["Ferrari,250 GT,1960,,,3000000,true,",
                                       "Porsche,550,1955,,,2000000,true,"])
            + _sale("E2", "2026-09-05", ["Ferrari,275,1966,,,900000,true,",
                                         "Ferrari,330,1966,,,800000,true,"]),
            [("E1", "2026-08-14", 100), ("E2", "2026-09-05", 25)])
        # Ferrari: half of E1 at 100 plus all of E2 at 25, over 125 of rating.
        self.assertAlmostEqual(float(rows["Ferrari"]["MAI_score"]), (100 * 0.5 + 25 * 1.0) / 125, places=6)
        self.assertAlmostEqual(float(rows["Porsche"]["MAI_score"]), 100 * 0.5 / 125, places=6)
        self.assertEqual(rows["Ferrari"]["events_present"], "2")
        self.assertNotIn("Filler", rows)

    def test_topping_one_small_sale_does_not_beat_being_a_highlight_everywhere(self):
        rows = self._score(
            _sale("Big", "2026-08-14", ["Ferrari,250 GT,1960,,,6000000,true,",
                                        "Ferrari,275,1966,,,5000000,true,"])
            + _sale("Small", "2026-01-28", ["Mercedes-Benz,300 SL,1957,,,1300000,true,",
                                            "Mercedes-Benz,190 SL,1957,,,1200000,true,"]),
            [("Big", "2026-08-14", 100), ("Small", "2026-01-28", 20)])
        self.assertGreater(float(rows["Ferrari"]["MAI_score"]),
                           float(rows["Mercedes-Benz"]["MAI_score"]))
        self.assertAlmostEqual(float(rows["Mercedes-Benz"]["MAI_score"]), 20 / 120, places=6)

    def test_sales_under_twenty_lots_have_no_highlights(self):
        rows = self._score(
            _sale("E1", "2026-08-14", ["Ferrari,250 GT,1960,,,3000000,true,"])
            + _sale("Tiny", "2026-01-28", ["Mercedes-Benz,300 SL,1957,,,9000000,true,"], n=4),
            [("E1", "2026-08-14", 100), ("Tiny", "2026-01-28", 0)])
        self.assertNotIn("Mercedes-Benz", rows)

    def test_an_unsold_highlight_still_counts_for_presence(self):
        rows = self._score(
            _sale("E1", "2026-08-14", ["Lola-Ford,T70,1967,1100000,1500000,,false,",
                                       "Ferrari,250 GT,1960,,,3000000,true,"]),
            [("E1", "2026-08-14", 100)])
        lola = rows["Lola-Ford"]
        self.assertAlmostEqual(float(lola["MAI_score"]), 0.5)   # R isn't multiplied in
        self.assertEqual(float(lola["avg_R"]), 0.0)
        self.assertEqual(lola["avg_Q"], "")
        self.assertEqual(lola["apex_from_estimate"], "1")

    def test_an_unsold_lot_without_an_estimate_is_never_a_highlight(self):
        rows = self._score(
            _sale("E1", "2026-08-14", ["BMW,507,1957,,,,false,",
                                       "Ferrari,250 GT,1960,,,3000000,true,"]),
            [("E1", "2026-08-14", 100)])
        self.assertNotIn("BMW", rows)
        self.assertEqual(float(rows["Filler"]["avg_P"]), 0.5)   # next-best lot moves up

    def test_q_uses_only_real_high_estimates(self):
        rows = self._score(
            _sale("E1", "2026-08-14", ["Ferrari,250 GT,1960,1000000,1200000,1320000,true,",
                                       "Ferrari,275 GTB,1966,,,2000000,true,"]),
            [("E1", "2026-08-14", 100)])
        self.assertAlmostEqual(float(rows["Ferrari"]["avg_Q"]), 1.1)
        self.assertEqual(rows["Ferrari"]["apex_from_sold_price"], "1")

    def test_online_months_are_read_alongside_live_sales(self):
        d = tempfile.mkdtemp()
        online = os.path.join(d, "online.csv")
        with open(online, "w") as f:
            f.write("\n".join([self.LOTS_HEADER.replace("auction_house,", "auction_house,auction_house_code,"),
                               *(f"Bring a Trailer – August 2026,2026-08-31,Bring a Trailer,BAT,,"
                                 f"{'Porsche' if i < 25 else 'Filler'},M,1990,,,{2000000 - i * 1000 if i < 25 else 1000},true,"
                                 for i in range(300))]) + "\n")
        rows = self._score(_sale("E1", "2026-08-14", ["Ferrari,250 GT,1960,,,3000000,true,"]),
                           [("E1", "2026-08-14", 100), ("Bring a Trailer – August 2026", "2026-08-31", 25)],
                           online=online)
        self.assertEqual(rows["Porsche"]["total_apex_lots"], "25")   # capped, all from the BaT month
        self.assertAlmostEqual(float(rows["Porsche"]["MAI_score"]), 25 * 1.0 / 125, places=6)

    def test_drilldown_contributions_sum_to_the_score_and_list_the_cars(self):
        d = tempfile.mkdtemp()
        with unittest.mock.patch("tempfile.mkdtemp", return_value=d):
            rows = self._score(
                _sale("E1", "2026-08-14", ["Ferrari,250 GT,1960,,,3000000,true,",
                                           "Porsche,550,1955,450000,2500000,,false,"])
                + _sale("E2", "2026-09-05", ["Ferrari,275,1966,,,900000,true,",
                                             "Ferrari,330,1966,,,800000,true,"]),
                [("E1", "2026-08-14", 100), ("E2", "2026-09-05", 25)])
        with open(os.path.join(d, "detail.csv")) as f:
            detail = list(csv.DictReader(f))
        ferrari = [r for r in detail if r["manufacturer"] == "Ferrari"]
        self.assertEqual([r["event"] for r in ferrari], ["E1", "E2"])          # biggest contribution first
        self.assertAlmostEqual(sum(float(r["contribution"]) for r in ferrari),
                               float(rows["Ferrari"]["MAI_score"]), places=5)
        self.assertEqual((ferrari[0]["apex_lots"], ferrari[0]["sale_apex_lots"]), ("1", "2"))
        with open(os.path.join(d, "apex_lots.csv")) as f:
            lots = list(csv.DictReader(f))
        e1 = [(r["rank"], r["manufacturer"], r["apex_value_usd"], r["apex_basis"], r["sold"]) for r in lots if r["event"] == "E1"]
        self.assertEqual(e1, [("1", "Ferrari", "3000000", "sold_price", "true"),
                              ("2", "Porsche", "2500000", "estimate", "false")])

    def test_a_make_spelled_two_ways_across_sources_scores_once(self):
        rows = self._score(
            _sale("E1", "2026-08-14", ["Mercedes-Benz,300 SL,1955,,,3000000,true,",
                                       "Mercedes Benz,320 Cabriolet A,1938,,,2000000,true,"]),
            [("E1", "2026-08-14", 100)])
        self.assertNotIn("Mercedes Benz", rows)
        self.assertEqual(rows["Mercedes-Benz"]["total_apex_lots"], "2")

    def test_modern_and_classic_split_the_same_highlights_by_age_at_sale(self):
        d = tempfile.mkdtemp()
        with unittest.mock.patch("tempfile.mkdtemp", return_value=d):
            rows = self._score(
                # E1 (2026): a 24-year-old car is modern, a 25-year-old classic.
                _sale("E1", "2026-08-14", ["Ford,GT,2002,,,3000000,true,",
                                           "Mercedes-Benz,SLR,2001,,,2500000,true,"])
                # E2 (2026): two classics and a lot with no year.
                + _sale("E2", "2026-09-05", ["Mercedes-Benz,300 SL,1955,,,900000,true,",
                                             "Ferrari,250 GT,1960,,,800000,true,",
                                             "Ferrari,Unknown,,,,850000,true,"], n=30),
                [("E1", "2026-08-14", 100), ("E2", "2026-09-05", 30)])
        self.assertEqual(float(rows["Ford"]["MAI_modern"]), 1.0)          # the only modern highlight
        self.assertEqual(float(rows["Ford"]["MAI_classic"]), 0.0)
        # Classic weights: SLR 100/2 = 50; E2's 300 SL and 250 GT 30/3 = 10 each.
        self.assertAlmostEqual(float(rows["Mercedes-Benz"]["MAI_classic"]), 60 / 70, places=5)
        self.assertAlmostEqual(float(rows["Ferrari"]["MAI_classic"]), 10 / 70, places=5)
        self.assertEqual(rows["Ferrari"]["apex_lots_classic"], "1")          # the yearless lot isn't split
        self.assertEqual(rows["Ferrari"]["total_apex_lots"], "2")
        total = sum(float(r["MAI_classic"]) for r in rows.values())
        self.assertAlmostEqual(total, 1.0, places=5)
        with open(os.path.join(d, "detail.csv")) as f:
            mb = [r for r in csv.DictReader(f) if r["manufacturer"] == "Mercedes-Benz"]
        self.assertAlmostEqual(sum(float(r["contribution_classic"]) for r in mb), 60 / 70, places=5)
        with open(os.path.join(d, "apex_lots.csv")) as f:
            seg = {(r["model"], r["age_at_sale"], r["segment"]) for r in csv.DictReader(f)}
        self.assertIn(("GT", "24", "modern"), seg)
        self.assertIn(("SLR", "25", "classic"), seg)
        self.assertIn(("Unknown", "", ""), seg)

    def test_trailing_spaces_do_not_split_a_make(self):
        rows = self._score(
            _sale("E1", "2026-08-14", ["Ferrari ,250 GT,1960,,,3000000,true,",
                                       "Ferrari,275,1966,,,2000000,true,"]),
            [("E1", "2026-08-14", 100)])
        self.assertEqual(rows["Ferrari"]["total_apex_lots"], "2")


@unittest.skipIf(auction_rating is None, "pandas not installed")
class AuctionRatings(unittest.TestCase):
    """The rating is what it takes to be a highlight at the sale, scaled so
    the sale with the highest line rates 100."""

    def _rate(self, lot_rows):
        d = tempfile.mkdtemp()
        lots, out = os.path.join(d, "lots.csv"), os.path.join(d, "out.csv")
        with open(lots, "w") as f:
            f.write(MaiScores.LOTS_HEADER + "\n" + "\n".join(lot_rows) + "\n")
        with unittest.mock.patch.object(auction_rating, "LOTS_PATH", lots), \
             unittest.mock.patch.object(auction_rating, "ONLINE_PATH", os.path.join(d, "none.csv")), \
             unittest.mock.patch.object(auction_rating, "OUTPUT_PATH", out), \
             unittest.mock.patch("sys.stdout", new=io.StringIO()):
            auction_rating.main()
        with open(out) as f:
            return {r["event"]: r for r in csv.DictReader(f)}

    def test_rating_is_the_highlight_line_relative_to_the_highest(self):
        rows = self._rate(
            _sale("Monterey", "2026-08-14", ["BMW,M1,1980,,,6000000,true,",
                                             "Porsche,550,1955,450000,5000000,,false,"])
            + _sale("Hershey", "2026-10-07", ["Cadillac,V16,1931,,,300000,true,",
                                              "Buick,8,1931,,,200000,true,"], filler_price=50000)
            + _sale("Tiny", "2026-01-28", ["Mercedes-Benz,300 SL,1957,,,9000000,true,"], n=4))
        mon, her, tiny = rows["Monterey"], rows["Hershey"], rows["Tiny"]
        self.assertEqual(float(mon["highlight_line_usd"]), 5000000)
        self.assertEqual(float(mon["auction_rating"]), 100)
        self.assertEqual(float(her["highlight_line_usd"]), 200000)
        self.assertAlmostEqual(float(her["auction_rating"]), 4.0)
        self.assertEqual((tiny["apex_lots"], float(tiny["auction_rating"])), ("0", 0.0))
        self.assertEqual((mon["apex_lots"], mon["apex_from_estimate"], mon["apex_from_sold_price"]),
                         ("2", "1", "1"))
        self.assertEqual(float(mon["apex_sell_through"]), 0.5)
        self.assertEqual(mon["total_lots"], "20")


if __name__ == "__main__":
    unittest.main(verbosity=2)
