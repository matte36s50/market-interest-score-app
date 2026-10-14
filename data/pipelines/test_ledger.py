#!/usr/bin/env python3
"""
Tests for the weekly ledger ingest and the ledger MAI layer.

Offline: ledgers come from fixtures/ledgers through CsvDirLedgerSource, the
same interface the Sheets client implements. The fixtures copy the shape of
the real 28 September / 5 October ledgers. Their record_ids and
high_estimate_usd values are made up for the tests.

Run: python3 data/pipelines/test_ledger.py
"""

import csv
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ledger_ingest as ingest
import ledger_mai
import ledger_source

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "ledgers")
T = "Auction Results Ledger – "


def build_fixtures():
    report, current, all_rows, queue = ingest.build(ledger_source.CsvDirLedgerSource(FIXTURES))
    return report, current, all_rows, queue


def by_lot(rows):
    return {r["lot_key"]: r for r in rows}


class FixtureDir:
    """A temp copy of the fixtures that a test can add to or edit."""

    def __enter__(self):
        self.path = tempfile.mkdtemp()
        for name in os.listdir(FIXTURES):
            shutil.copy(os.path.join(FIXTURES, name), self.path)
        return self

    def __exit__(self, *exc):
        shutil.rmtree(self.path)

    def rows(self, title):
        with open(os.path.join(self.path, title + ".csv"), newline="", encoding="utf-8") as fh:
            r = csv.DictReader(fh)
            return r.fieldnames, list(r)

    def write(self, title, header, rows):
        with open(os.path.join(self.path, title + ".csv"), "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=header, lineterminator="\n")
            w.writeheader()
            w.writerows(rows)

    def build(self):
        return ingest.build(ledger_source.CsvDirLedgerSource(self.path))


class Discovery(unittest.TestCase):
    def test_en_dash_title_parses(self):
        d, rev = ingest.parse_title(T + "October 05, 2026")
        self.assertEqual(d.isoformat(), "2026-10-05")
        self.assertFalse(rev)
        d, rev = ingest.parse_title(T + "September 28, 2026 (rev record_id)")
        self.assertEqual(d.isoformat(), "2026-09-28")
        self.assertTrue(rev)

    def test_hyphen_title_is_not_a_ledger_and_is_reported(self):
        self.assertIsNone(ingest.parse_title("Auction Results Ledger - October 05, 2026"))
        report = ingest.Report()
        f = ledger_source.LedgerFile("x", "Auction Results Ledger - October 05, 2026", "m")
        self.assertEqual(ingest.discover([f], report), [])
        self.assertTrue(any("en dash" in w for w in report.warnings))

    def test_rev_file_replaces_plain_file_for_same_date(self):
        report, current, _, _ = build_fixtures()
        self.assertEqual(report.errors, [])
        used = [f["title"] for f in report.files]
        self.assertIn(T + "September 28, 2026 (rev record_id)", used)
        self.assertNotIn(T + "September 28, 2026", used)
        ignored = [f["title"] for f in report.ignored]
        self.assertIn(T + "September 28, 2026", ignored)

    def test_legacy_sheet_without_rev_fails_loudly_naming_the_file(self):
        with FixtureDir() as fx:
            os.remove(os.path.join(fx.path, T + "September 28, 2026 (rev record_id).csv"))
            report, current, _, _ = fx.build()
        self.assertIsNone(current)
        self.assertTrue(any(T + "September 28, 2026" in e and "record_id" in e for e in report.errors),
                        report.errors)

    def test_two_rev_files_for_one_date_is_an_error(self):
        report = ingest.Report()
        files = [ledger_source.LedgerFile(i, T + "October 05, 2026 (rev record_id)", "m") for i in ("a", "b")]
        ingest.discover(files, report)
        self.assertTrue(report.errors)


class Dedupe(unittest.TestCase):
    def setUp(self):
        self.report, self.current, self.all_rows, self.queue = build_fixtures()
        self.assertEqual(self.report.errors, [])

    def test_restated_lot_is_counted_once_at_its_latest_value(self):
        """The Zurich lots were restated in CHF on 5 October. A naive union
        counts lot 111 twice, once in EUR and once in CHF; dedupe must not."""
        keys = [r["lot_key"] for r in self.current]
        self.assertEqual(len(keys), len(set(keys)))
        lot = by_lot(self.current)["20260926-RMS-L111"]
        self.assertEqual((lot["price"], lot["currency"], lot["ledger_date"]), ("263750", "CHF", "2026-10-05"))
        zurich_111 = [r for r in self.all_rows if r["lot_key"] == "20260926-RMS-L111"]
        self.assertEqual(sorted(r["currency"] for r in zurich_111), ["CHF", "EUR"])
        self.assertEqual([r["currency"] for r in zurich_111 if r["is_current"] == "true"], ["CHF"])

    def test_counts_match_the_union_minus_restatements(self):
        self.assertEqual(len(self.all_rows), 16)
        self.assertEqual(len(self.current), 11)
        self.assertEqual(sum(r["is_current"] == "false" for r in self.all_rows), 5)
        # Total sold USD would double-count the restated lots if dedupe slipped.
        f40 = [r for r in self.current if r["model"] == "F40"]
        self.assertEqual(len(f40), 1)

    def test_model_rename_does_not_split_the_lot(self):
        """Lot 122 is '365 GTB/4 Daytona' on 28 Sept and '365 GTB/4 Daytona
        Berlinetta' on 5 Oct. The lot key joins them; make+model would not."""
        daytona = [r for r in self.current if r["lot_key"] == "20260926-RMS-L122"]
        self.assertEqual(len(daytona), 1)
        self.assertEqual(daytona[0]["model"], "365 GTB/4 Daytona Berlinetta")
        self.assertFalse(any(r["model"] == "365 GTB/4 Daytona" for r in self.current))

    def test_unrestated_rows_survive(self):
        self.assertIn("20260919-BON-GWR01", by_lot(self.current))
        self.assertEqual(by_lot(self.current)["20260919-BON-GWR01"]["ledger_date"], "2026-09-28")

    def test_supersedes_is_carried_through(self):
        lot = by_lot(self.current)["20260926-RMS-L111"]
        self.assertEqual(lot["supersedes"], "20260926-RMS-L111@20260928")

    def test_dedupe_ignores_supersedes(self):
        """Blank out every supersedes: the result must not change."""
        with FixtureDir() as fx:
            title = T + "October 05, 2026 (rev record_id)"
            header, rows = fx.rows(title)
            for r in rows:
                r["supersedes"] = ""
            fx.write(title, header, rows)
            report, current, _, _ = fx.build()
        self.assertEqual(report.errors, [])
        self.assertEqual({r["record_id"] for r in current}, {r["record_id"] for r in self.current})

    def test_duplicate_record_id_is_an_error(self):
        with FixtureDir() as fx:
            title = T + "October 05, 2026 (rev record_id)"
            header, rows = fx.rows(title)
            fx.write(title, header, rows + [rows[0]])
            report, current, _, _ = fx.build()
        self.assertIsNone(current)
        self.assertTrue(any("duplicate record_id" in e for e in report.errors))


class Normalization(unittest.TestCase):
    def setUp(self):
        report, current, _, _ = build_fixtures()
        self.lots = by_lot(current)

    def test_sold_without_price_stays_blank(self):
        gt2 = self.lots["20260922-TMB-GT2CS"]
        self.assertEqual(gt2["outcome"], "sold")
        self.assertEqual(gt2["result_state"], "sold_without_price")
        self.assertEqual((gt2["price"], gt2["price_usd"], gt2["fx_rate"], gt2["fx_date"]), ("", "", "", ""))

    def test_not_sold_row(self):
        one = self.lots["20260926-RMS-L116"]
        self.assertEqual(one["result_state"], "not_sold")
        self.assertEqual(one["price"], "")

    def test_sold_with_price(self):
        self.assertEqual(self.lots["20260926-RMS-L106"]["result_state"], "sold_with_price")

    def test_blank_high_estimate_usd_stays_blank(self):
        mecum = self.lots["20260926-MEC-S261"]
        self.assertEqual(mecum["high_estimate_usd"], "")
        self.assertEqual(mecum["estimate_high"], "")

    def test_estimate_currency_differs_from_price_currency(self):
        """Lot 122 sold in CHF against an EUR estimate. The recorded USD
        figures are kept as recorded; the price fx_rate is not applied to the
        estimate."""
        d = self.lots["20260926-RMS-L122"]
        self.assertEqual((d["currency"], d["estimate_currency"]), ("CHF", "EUR"))
        self.assertEqual(d["estimate_high"], "750000")
        self.assertEqual(d["high_estimate_usd"], "855225")
        self.assertNotEqual(d["high_estimate_usd"], str(round(750000 * float(d["fx_rate"]))))

    def test_fx_is_kept_as_recorded_with_its_ledger_date(self):
        """One file holds two rates (CHF at 1.2097, EUR carried at 1.1403)."""
        self.assertEqual((self.lots["20260926-RMS-L106"]["fx_rate"], self.lots["20260926-RMS-L106"]["fx_date"]),
                         ("1.2097", "2026-10-05"))
        dor = self.lots["20260909-DOR-L30"]
        self.assertEqual((dor["fx_rate"], dor["price_usd"], dor["fx_date"]), ("1.1403", "17675", "2026-10-05"))
        self.assertEqual(dor["premium_included"], "no")

    def test_review_queue_lists_outlier_language_without_flagging_the_dataset(self):
        _, current, _, queue = build_fixtures()
        ids = {q["record_id"] for q in queue}
        self.assertIn("20260919-BON-GWR02@20260928", ids)  # works DTM car
        self.assertIn("20261001-TMB-C55@20261005", ids)  # charity proceeds
        self.assertNotIn("20260926-RMS-L106@20261005", ids)
        self.assertNotIn("matched", ingest.DATASET_COLUMNS)


class HardErrors(unittest.TestCase):
    def mutate(self, **changes):
        with FixtureDir() as fx:
            title = T + "October 05, 2026 (rev record_id)"
            header, rows = fx.rows(title)
            rows[0].update(changes)
            fx.write(title, header, rows)
            return fx.build()

    def assertFails(self, needle, **changes):
        report, current, _, _ = self.mutate(**changes)
        self.assertIsNone(current)
        self.assertTrue(any(needle in e for e in report.errors), report.errors)

    def test_unparseable_record_id(self):
        self.assertFails("unparseable record_id", record_id="20260926-RMS-L111")

    def test_record_id_ledger_date_must_match_file(self):
        self.assertFails("names ledger", record_id="20260926-RMS-L111@20261012")

    def test_supersedes_unknown_lot_key(self):
        self.assertFails("does not exist", supersedes="20990101-XXX-L1@20260928")

    def test_supersedes_another_lot_key(self):
        self.assertFails("different lot key", supersedes="20260926-RMS-L106@20260928")

    def test_bad_outcome(self):
        self.assertFails("outcome", outcome="Sold")

    def test_negative_price(self):
        self.assertFails("negative", price="-5")

    def test_non_numeric_price(self):
        self.assertFails("non-numeric", price="263,750")

    def test_zero_high_estimate_usd(self):
        self.assertFails("high_estimate_usd is 0", high_estimate_usd="0")


class Cache(unittest.TestCase):
    def test_offline_build_from_cache_is_identical(self):
        cache = tempfile.mkdtemp()
        try:
            online = ledger_source.CachedLedgerSource(cache, upstream=ledger_source.CsvDirLedgerSource(FIXTURES))
            _, first, _, _ = ingest.build(online)
            self.assertEqual(online.misses, 2)
            _, second, _, _ = ingest.build(online)
            self.assertEqual(online.hits, 2)
            _, offline, _, _ = ingest.build(ledger_source.CachedLedgerSource(cache, offline=True))
            self.assertEqual(first, second)
            self.assertEqual(first, offline)
        finally:
            shutil.rmtree(cache)

    def test_offline_without_cache_fails(self):
        cache = tempfile.mkdtemp()
        try:
            report, current, _, _ = ingest.build(ledger_source.CachedLedgerSource(cache, offline=True))
            self.assertIsNone(current)
            self.assertTrue(report.errors)
        finally:
            shutil.rmtree(cache)

    def test_cli_writes_reproducible_outputs(self):
        outs = []
        for _ in range(2):
            out = tempfile.mkdtemp()
            try:
                self.assertEqual(ingest.main(["--source-dir", FIXTURES, "--out-dir", out]), 0)
                outs.append({n: open(os.path.join(out, n), encoding="utf-8").read() for n in sorted(os.listdir(out))})
            finally:
                shutil.rmtree(out)
        self.assertEqual(outs[0], outs[1])
        report = json.loads(outs[0]["validation_report.json"])
        self.assertEqual(report["counts"]["rows_after_dedupe"], 11)
        self.assertEqual(report["counts"]["rows_superseded"], 5)


class LedgerMai(unittest.TestCase):
    def setUp(self):
        _, current, _, _ = build_fixtures()
        self.rows = current
        self.out = ledger_mai.build(current)

    def test_blank_high_estimate_is_apex_unknown_not_non_apex(self):
        mecum = by_lot(self.rows)["20260926-MEC-S261"]
        self.assertEqual(ledger_mai.apex_class(mecum), "apex_unknown")
        ferrari = next(m for m in self.out["segments"]["all"]["manufacturers"] if m["manufacturer"] == "Ferrari")
        # F40, Daytona, Dino are apex; Mecum 812 and Goodwood 365 GT are unknown.
        self.assertEqual((ferrari["apex"], ferrari["apex_unknown"], ferrari["non_apex"]), (2, 2, 1))

    def test_default_status_filter_excludes_unverified_and_says_so(self):
        sf = self.out["status_filter"]
        self.assertEqual(sf["included"], ["CONFIRMED", "REPORTED"])
        self.assertEqual(sf["rows_excluded_by_status"], {"UNVERIFIED": 1})
        self.assertNotIn("Porsche", [m["manufacturer"] for m in self.out["segments"]["all"]["manufacturers"]])
        everything = ledger_mai.build(self.rows, ledger_mai.ALL_STATUSES)
        self.assertEqual(everything["status_filter"]["rows_excluded"], 0)

    def test_segments_split_by_premium_included(self):
        segs = self.out["segments"]
        total = segs["all"]["totals"]["lots"]
        parts = sum(segs[s]["totals"]["lots"] for s in ("premium_yes", "premium_no", "premium_unknown"))
        self.assertEqual(total, parts)
        self.assertEqual(sum(self.out["premium_mix"].values()), total)

    def test_mercedes_sub_brands_roll_up_and_raw_make_is_kept(self):
        makers = {m["manufacturer"]: m for m in self.out["segments"]["all"]["manufacturers"]}
        self.assertNotIn("Mercedes-AMG", makers)
        mb = makers["Mercedes-Benz"]
        self.assertEqual(mb["makes"], {"Mercedes-AMG": 2, "Mercedes-Benz": 3})
        self.assertEqual(mb["lots"], 5)
        self.assertEqual(self.out["manufacturer_groups"], {"Mercedes-AMG": "Mercedes-Benz"})
        # The dataset itself still carries the make as recorded.
        self.assertEqual(by_lot(self.rows)["20260926-RMS-L111"]["make"], "Mercedes-AMG")

    def test_grouping_is_explicit_not_by_name_pattern(self):
        groups = ledger_mai.load_groups()
        self.assertEqual(groups["Maybach"], "Mercedes-Benz")
        self.assertEqual(groups["Mercedes-Maybach"], "Mercedes-Benz")
        self.assertNotIn("Frazer Nash-BMW", groups)  # licence-built, not a BMW

    def test_make_listed_twice_in_groups_is_an_error(self):
        with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False) as fh:
            fh.write("make,manufacturer,note\nMaybach,Mercedes-Benz,\nMaybach,Maybach,\n")
        try:
            with self.assertRaises(ValueError):
                ledger_mai.load_groups(fh.name)
        finally:
            os.remove(fh.name)

    def test_fixture_mai_by_hand(self):
        """Zurich is the only event with apex lots (CONFIRMED + REPORTED):
        Ferrari F40 and Daytona sold, the Mercedes-AMG ONE did not.
          Ferrari  P = 2/3, R = 1,
                   Q = mean(3,323,750 / 3,500,000 CHF native,
                            822,610 / 855,225 USD, since CHF price vs EUR estimate)
          Mercedes-Benz  P = 1/3, R = 0 -> term 0 (a real zero, not a filled-in Q)"""
        makers = {m["manufacturer"]: m for m in self.out["segments"]["all"]["manufacturers"]}
        q = (3323750 / 3500000 + 822610 / 855225) / 2
        self.assertAlmostEqual(makers["Ferrari"]["mai"], 2 / 3 * q * 1, places=6)
        self.assertEqual(makers["Ferrari"]["q_basis"], {"native": 1, "usd": 1})
        self.assertEqual(makers["Mercedes-Benz"]["mai"], 0.0)
        self.assertIsNone(makers["Mercedes-Benz"]["avg_Q"])
        self.assertEqual(self.out["segments"]["all"]["manufacturers"][0]["manufacturer"], "Ferrari")

    def test_no_apex_lots_means_no_score_not_zero(self):
        # A manufacturer whose lots are all non-apex or apex_unknown has no MAI.
        no_apex = [m for seg in self.out["segments"].values() for m in seg["manufacturers"] if m["apex"] == 0]
        self.assertTrue(no_apex)
        for m in no_apex:
            self.assertIsNone(m["mai"])
            self.assertEqual(m["events_scored"], 0)


def lot(manufacturer, state, price="", currency="USD", estimate_high="", estimate_currency="USD",
        price_usd="", high_estimate_usd="1000000", event="E", event_date="2026-01-01"):
    return {"manufacturer": manufacturer, "make": manufacturer, "result_state": state, "price": price,
            "currency": currency, "estimate_high": estimate_high, "estimate_currency": estimate_currency,
            "price_usd": price_usd, "high_estimate_usd": high_estimate_usd,
            "event": event, "event_date": event_date}


class MaiFormula(unittest.TestCase):
    def test_sold_with_price_withheld_counts_in_r_but_not_q(self):
        rows = [lot("A", "sold_with_price", "900000", estimate_high="1000000"),
                lot("A", "sold_without_price")]
        a = ledger_mai.compute_mai(rows, rows)["A"]
        self.assertEqual((a["avg_R"], a["avg_Q"], a["avg_P"]), (1.0, 0.9, 1.0))
        self.assertAlmostEqual(a["mai"], 0.9)

    def test_only_unpriced_sales_leave_the_event_unscored(self):
        rows = [lot("A", "sold_without_price"), lot("B", "sold_with_price", "1000000", estimate_high="1000000")]
        out = ledger_mai.compute_mai(rows, rows)
        self.assertIsNone(out["A"]["mai"])
        self.assertEqual((out["A"]["events_scored"], out["A"]["events_unscored"]), (0, 1))
        self.assertAlmostEqual(out["B"]["mai"], 0.5)  # P = 1/2, Q = 1, R = 1

    def test_unscored_event_is_left_out_of_the_mean_not_counted_as_zero(self):
        rows = [lot("A", "sold_with_price", "1000000", estimate_high="1000000", event="E1"),
                lot("A", "sold_without_price", event="E2")]
        a = ledger_mai.compute_mai(rows, rows)["A"]
        self.assertEqual((a["mai"], a["events_scored"], a["events_unscored"]), (1.0, 1, 1))

    def test_withdrawn_is_neither_presence_nor_no_sale(self):
        rows = [lot("A", "sold_with_price", "1000000", estimate_high="1000000"), lot("A", "withdrawn"),
                lot("B", "withdrawn")]
        out = ledger_mai.compute_mai(rows, rows)
        self.assertEqual((out["A"]["avg_P"], out["A"]["avg_R"]), (1.0, 1.0))
        self.assertNotIn("B", out)

    def test_unsold_make_scores_zero_and_dilutes_its_mean(self):
        rows = [lot("A", "sold_with_price", "1000000", estimate_high="1000000", event="E1"),
                lot("A", "not_sold", event="E2")]
        self.assertAlmostEqual(ledger_mai.compute_mai(rows, rows)["A"]["mai"], 0.5)

    def test_q_uses_house_currency_when_price_and_estimate_match(self):
        # CHF price and CHF estimate: ratio in CHF, whatever the recorded USD says.
        rows = [lot("A", "sold_with_price", "900000", currency="CHF", estimate_high="1000000",
                    estimate_currency="CHF", price_usd="1", high_estimate_usd="1000000")]
        a = ledger_mai.compute_mai(rows, rows)["A"]
        self.assertAlmostEqual(a["avg_Q"], 0.9)
        self.assertEqual(a["q_basis"], {"native": 1})

    def test_q_falls_back_to_recorded_usd_across_currencies(self):
        rows = [lot("A", "sold_with_price", "900000", currency="CHF", estimate_high="800000",
                    estimate_currency="EUR", price_usd="1080000", high_estimate_usd="1200000")]
        self.assertAlmostEqual(ledger_mai.compute_mai(rows, rows)["A"]["avg_Q"], 0.9)


if __name__ == "__main__":
    unittest.main(verbosity=2)
