#!/usr/bin/env python3
"""
Weekly Auction Results Ledger ingest.

Reads every "Auction Results Ledger – <Month DD, YYYY>" sheet in the ledger
folder, normalizes the rows, keeps only the latest statement of each lot's
result, validates the lot, and writes:

    data/ledger/ledger_results.csv     the deduplicated dataset (one row per lot key)
    data/ledger/ledger_rows_all.csv    every row read, with is_current, for audit
    data/ledger/review_queue.csv       rows whose notes read like an outlier caveat
    data/ledger/validation_report.json counts, errors, warnings (written even on failure)

Deduplication: record_id is "<lot key>@<ledger date>". Rows are grouped by lot
key and only the row from the latest ledger is kept, because corrections
arrive as new rows in later ledgers. `supersedes` is carried through as the
audit trail; nothing depends on it. make + model is never a join key.

Missing stays missing: a blank cell is written blank, never 0. Recorded
figures (price_usd, fx_rate, high_estimate_usd) are passed through as
recorded and never re-converted.

Run:
    python data/pipelines/ledger_ingest.py              # live, through the cache
    python data/pipelines/ledger_ingest.py --offline    # cache only
    python data/pipelines/ledger_ingest.py --source-dir path/to/csvs

Exit status is 1 on any hard error, and the dataset files are left untouched.
"""

import argparse
import csv
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime
from decimal import Decimal, InvalidOperation

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ledger_source

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
DEFAULT_OUT_DIR = os.path.join(ROOT, "ledger")
DEFAULT_CACHE_DIR = os.path.join(ROOT, "ledger", ".cache")

# ── Discovery ─────────────────────────────────────────────────────────────────

EN_DASH = "–"
TITLE_RE = re.compile(
    r"^Auction Results Ledger " + EN_DASH + r" (?P<date>[A-Z][a-z]+ \d{1,2}, \d{4})(?P<rev> \(rev record_id\))?$"
)
# Same shape with a hyphen or em dash: almost certainly a ledger typed with the
# wrong dash. Not ingested, but reported so it does not vanish silently.
LOOKALIKE_RE = re.compile(r"^Auction Results Ledger\s*[-—‒]\s*")

# ── Schema ────────────────────────────────────────────────────────────────────

CURRENT_HEADER = [
    "record_id", "supersedes", "event_date", "auction_house", "event", "lot_number",
    "year", "make", "model", "outcome", "price", "currency", "premium_included",
    "price_usd", "fx_rate", "estimate_low", "estimate_high", "estimate_currency",
    "high_estimate_usd", "status", "source_url", "first_reported", "notes",
]
# Columns the two pre-record_id ledgers lack.
LEGACY_MISSING = {"record_id", "supersedes", "high_estimate_usd"}

OUTCOMES = {"sold", "not_sold", "withdrawn"}
PREMIUM_VALUES = {"yes", "no", "unknown"}
STATUSES = {"CONFIRMED", "REPORTED", "UNVERIFIED"}
NUMERIC_COLUMNS = ["price", "price_usd", "fx_rate", "estimate_low", "estimate_high", "high_estimate_usd"]

RECORD_ID_RE = re.compile(r"^(?P<lot_key>[^@\s]+)@(?P<ledger>\d{8})$")
NUMBER_RE = re.compile(r"^-?\d+(\.\d+)?$")

DATASET_COLUMNS = [
    "record_id", "lot_key", "ledger_date", "supersedes",
    "event_date", "auction_house", "event", "lot_number", "year", "make", "model",
    "outcome", "result_state",
    "price", "currency", "premium_included", "price_usd", "fx_rate", "fx_date",
    "estimate_low", "estimate_high", "estimate_currency", "high_estimate_usd",
    "status", "source_url", "first_reported", "notes",
    "source_file_title", "source_file_id",
]

# ── Review queue ──────────────────────────────────────────────────────────────
# Outlier caveats live in free-text notes. These patterns only nominate rows
# for a human to look at; they are deliberately broad and never become a flag
# in the dataset.
REVIEW_PATTERNS = [
    ("outlier", r"\boutlier"),
    ("comparability", r"\bcomparab"),
    ("treat with care", r"\btreat with care|\bcaution\b"),
    ("charity", r"\bcharit|\bproceeds\b|\bhospice\b|\bRNLI\b|\bfoundation\b|\bbenefit(ing)?\b"),
    ("one-off / coachbuilt", r"\bone[- ]off\b|\bcoachbuil|\bbespoke\b|\bcommission(ed)?\b|\bunique\b|\bspecial[- ]bod"),
    ("works / competition", r"\bworks\b|\bcompetition\b|\brace car\b|\bracing\b|\btest and development\b|\bprototype\b|\bDTM\b"),
    ("specification premium", r"\bspecification premium\b|\btailor made\b|\blivery\b"),
    ("licence-built / not factory", r"\blicen[cs]e[- ]built\b|\bnot a [\w-]+-built\b"),
    ("provenance / celebrity", r"\bprovenance\b|\bcelebrity\b|\bex-[A-Z]"),
]
REVIEW_RES = [(label, re.compile(rx, re.IGNORECASE)) for label, rx in REVIEW_PATTERNS]

SCHEMA_GAPS = [
    "Outlier status (charity lots, one-off coachbuilt commissions, works competition cars, "
    "specification-premium cars) exists only as free text in `notes`. It is not machine-readable; "
    "review_queue.csv lists candidate rows for a human to triage. A structured column is needed.",
]


class LedgerError(Exception):
    pass


def parse_title(title):
    """(ledger date, is_rev) for a ledger title, or None if it is not one."""
    m = TITLE_RE.match(title.strip())
    if not m:
        return None
    try:
        d = datetime.strptime(m.group("date"), "%B %d, %Y").date()
    except ValueError:
        return None
    return d, bool(m.group("rev"))


def discover(files, report):
    """Pick the file to ingest for each ledger date.

    Where a date has both a plain file and a "(rev record_id)" file, the rev
    file wins and the plain one is ignored. Two candidates of the same kind
    for one date is ambiguous and a hard error.
    """
    by_date = defaultdict(lambda: {"rev": [], "plain": []})
    for f in files:
        parsed = parse_title(f.title)
        if parsed is None:
            if LOOKALIKE_RE.match(f.title):
                report.warn(f"'{f.title}' looks like a ledger but does not use an en dash (U+2013); not ingested.")
            report.ignored.append({"title": f.title, "file_id": f.file_id, "reason": "not a ledger title"})
            continue
        d, is_rev = parsed
        by_date[d]["rev" if is_rev else "plain"].append(f)

    selected = []
    for d in sorted(by_date):
        group = by_date[d]
        for kind in ("rev", "plain"):
            if len(group[kind]) > 1:
                names = ", ".join(f"'{f.title}' ({f.file_id})" for f in group[kind])
                report.error(f"{d.isoformat()}: {len(group[kind])} {kind} ledgers for one date: {names}")
        if group["rev"]:
            selected.append((d, group["rev"][0], True))
            for f in group["plain"]:
                report.ignored.append({
                    "title": f.title, "file_id": f.file_id,
                    "reason": f"replaced by '{group['rev'][0].title}'",
                })
        elif group["plain"]:
            selected.append((d, group["plain"][0], False))
    return selected


# ── Row parsing ───────────────────────────────────────────────────────────────

def _cell(v):
    return "" if v is None else str(v).strip()


def parse_number(raw):
    """Decimal for a numeric cell, None for a blank one; raises on anything else."""
    if raw == "":
        return None
    if not NUMBER_RE.match(raw):
        raise ValueError(raw)
    try:
        return Decimal(raw)
    except InvalidOperation:
        raise ValueError(raw)


def fmt_number(d):
    if d is None:
        return ""
    s = format(d, "f")
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s


def result_state(outcome, price):
    if outcome == "sold":
        return "sold_with_price" if price is not None else "sold_without_price"
    return outcome  # not_sold / withdrawn


def read_ledger(ledger_file, ledger_date, values, report):
    """Rows of one ledger as dicts keyed by header name, or [] after reporting
    why the file cannot be used."""
    label = f"'{ledger_file.title}'"
    if not values:
        report.error(f"{label} is empty.")
        return []
    header = [_cell(h) for h in values[0]]
    dupes = [h for h, n in Counter(header).items() if h and n > 1]
    if dupes:
        report.error(f"{label}: duplicate header column(s) {dupes}.")
        return []
    if "record_id" not in header:
        report.error(
            f"{label} has no record_id column (pre-record_id ledger) and no "
            f"'(rev record_id)' replacement exists for {ledger_date.isoformat()}. "
            "Add the replacement sheet; a record_id is never guessed."
        )
        return []
    missing = [c for c in CURRENT_HEADER if c not in header]
    if missing:
        report.error(f"{label}: missing column(s) {missing}.")
        return []
    extra = [h for h in header if h and h not in CURRENT_HEADER]
    if extra:
        report.warn(f"{label}: ignoring unknown column(s) {extra}.")

    index = {h: i for i, h in enumerate(header) if h}
    rows = []
    for n, raw in enumerate(values[1:], start=2):
        cells = {c: _cell(raw[index[c]]) if index[c] < len(raw) else "" for c in CURRENT_HEADER}
        if not any(cells.values()):
            continue
        cells["_file"] = ledger_file
        cells["_row"] = n
        cells["_ledger_date"] = ledger_date
        rows.append(cells)
    return rows


def normalize_row(cells, report):
    """Validate one row and return its normalized form, or None if it has a
    hard error (already reported)."""
    f, n = cells["_file"], cells["_row"]
    where = f"'{f.title}' row {n}"
    ok = True

    m = RECORD_ID_RE.match(cells["record_id"])
    ledger_part = None
    if m:
        try:
            ledger_part = datetime.strptime(m.group("ledger"), "%Y%m%d").date()
        except ValueError:
            pass
    if not m or ledger_part is None:
        report.error(f"{where}: unparseable record_id {cells['record_id']!r} (expected <lot key>@YYYYMMDD).")
        return None
    if ledger_part != cells["_ledger_date"]:
        report.error(
            f"{where}: record_id {cells['record_id']} names ledger {ledger_part.isoformat()} but sits in the "
            f"{cells['_ledger_date'].isoformat()} ledger. Dedupe orders rows by that date, so it must match."
        )
        ok = False

    outcome = cells["outcome"]
    if outcome not in OUTCOMES:
        report.error(f"{where} ({cells['record_id']}): outcome {outcome!r} not in {sorted(OUTCOMES)}.")
        ok = False
    if cells["premium_included"] not in PREMIUM_VALUES:
        report.error(f"{where} ({cells['record_id']}): premium_included {cells['premium_included']!r} "
                     f"not in {sorted(PREMIUM_VALUES)}.")
        ok = False
    if cells["status"] not in STATUSES:
        report.error(f"{where} ({cells['record_id']}): status {cells['status']!r} not in {sorted(STATUSES)}.")
        ok = False

    nums = {}
    for col in NUMERIC_COLUMNS:
        try:
            nums[col] = parse_number(cells[col])
        except ValueError:
            report.error(f"{where} ({cells['record_id']}): {col} is non-numeric: {cells[col]!r}.")
            ok = False
            continue
        if nums[col] is not None and nums[col] < 0:
            report.error(f"{where} ({cells['record_id']}): {col} is negative: {cells[col]}.")
            ok = False
    if nums.get("high_estimate_usd") is not None and nums["high_estimate_usd"] == 0:
        report.error(f"{where} ({cells['record_id']}): high_estimate_usd is 0. A missing estimate must be blank.")
        ok = False
    if not ok:
        return None

    price = nums["price"]
    if outcome != "sold" and price is not None:
        report.warn(f"{where} ({cells['record_id']}): {outcome} row carries a price ({cells['price']}); kept as recorded.")
    if price is not None and nums["price_usd"] is None:
        report.warn(f"{where} ({cells['record_id']}): price without price_usd; left blank, not converted.")

    ledger_iso = cells["_ledger_date"].isoformat()
    out = {c: cells[c] for c in CURRENT_HEADER}
    for col in NUMERIC_COLUMNS:
        out[col] = fmt_number(nums[col])
    out.update({
        "lot_key": m.group("lot_key"),
        "ledger_date": ledger_iso,
        "result_state": result_state(outcome, price),
        # price_usd was converted at the rate of the week the row was written.
        "fx_date": ledger_iso if out["fx_rate"] else "",
        "source_file_title": f.title,
        "source_file_id": f.file_id,
    })
    return out


def supersede_targets(value):
    return [t for t in re.split(r"[;,\s]+", value) if t]


def dedupe(rows, report):
    """Keep the latest-ledger row per lot key. Returns (current, all rows with
    is_current set)."""
    seen = {}
    for r in rows:
        if r["record_id"] in seen:
            other = seen[r["record_id"]]
            report.error(f"duplicate record_id {r['record_id']} in '{other['source_file_title']}' "
                         f"and '{r['source_file_title']}'.")
        else:
            seen[r["record_id"]] = r

    by_lot = defaultdict(list)
    for r in seen.values():
        by_lot[r["lot_key"]].append(r)

    current = {}
    for lot_key, group in by_lot.items():
        group.sort(key=lambda r: r["ledger_date"])
        current[lot_key] = group[-1]

    for r in seen.values():
        for target in supersede_targets(r["supersedes"]):
            target_lot = target.split("@", 1)[0]
            if target_lot not in by_lot:
                report.error(f"{r['record_id']}: supersedes {target!r}, but lot key {target_lot!r} does not exist.")
            elif target_lot != r["lot_key"]:
                # Dedupe works per lot key, so the superseded lot would stay
                # current and be counted alongside this one.
                report.error(f"{r['record_id']}: supersedes {target!r}, a different lot key. Both would stay "
                             "current and be double-counted; restate under one lot key.")
            elif "@" in target and target not in seen:
                report.warn(f"{r['record_id']}: supersedes {target}, which is not a record_id in any ingested ledger.")

    all_rows = []
    for r in sorted(seen.values(), key=lambda r: (r["lot_key"], r["ledger_date"])):
        all_rows.append(dict(r, is_current="true" if current[r["lot_key"]] is r else "false"))
    current_rows = sorted(current.values(),
                          key=lambda r: (r["event_date"], r["auction_house"], r["event"], r["lot_key"]))
    return current_rows, all_rows


def review_queue(rows):
    out = []
    for r in rows:
        hits = [label for label, rx in REVIEW_RES if rx.search(r["notes"])]
        if hits:
            out.append({
                "record_id": r["record_id"], "auction_house": r["auction_house"], "event": r["event"],
                "year": r["year"], "make": r["make"], "model": r["model"], "status": r["status"],
                "matched": "; ".join(hits), "notes": r["notes"],
            })
    return out


# ── Report ────────────────────────────────────────────────────────────────────

class Report:
    def __init__(self):
        self.errors, self.warnings, self.ignored, self.files = [], [], [], []

    def error(self, msg):
        self.errors.append(msg)

    def warn(self, msg):
        self.warnings.append(msg)


def counts(current, all_rows):
    def tally(key):
        return dict(sorted(Counter(r[key] for r in current).items()))
    return {
        "rows_read": len(all_rows),
        "rows_after_dedupe": len(current),
        "rows_superseded": sum(1 for r in all_rows if r["is_current"] == "false"),
        "rows_by_house": tally("auction_house"),
        "rows_missing_high_estimate_usd": sum(1 for r in current if not r["high_estimate_usd"]),
        "rows_missing_published_estimate": sum(1 for r in current if not r["estimate_high"]),
        "rows_missing_price": sum(1 for r in current if not r["price"]),
        "rows_missing_price_by_outcome": dict(sorted(Counter(r["outcome"] for r in current if not r["price"]).items())),
        "rows_by_status": tally("status"),
        "rows_by_premium_included": tally("premium_included"),
        "rows_by_result_state": tally("result_state"),
        "rows_with_estimate_currency_unlike_price_currency": sum(
            1 for r in current if r["estimate_currency"] and r["estimate_currency"] != r["currency"]),
    }


def build(source, report=None):
    """Run discovery → read → normalize → dedupe. Returns (report, current,
    all_rows, queue); current/all_rows are None when there were hard errors."""
    report = report or Report()
    try:
        files = source.list_files()
    except ledger_source.LedgerSourceError as e:
        report.error(str(e))
        return report, None, None, None

    selected = discover(files, report)
    if not selected:
        report.error("No ledgers found. Titles must read 'Auction Results Ledger – <Month DD, YYYY>' (en dash).")

    raw_rows = []
    for ledger_date, f, is_rev in selected:
        try:
            values = source.read_values(f)
        except ledger_source.LedgerSourceError as e:
            report.error(str(e))
            continue
        rows = read_ledger(f, ledger_date, values, report)
        report.files.append({
            "title": f.title, "file_id": f.file_id, "modified_time": f.modified_time,
            "ledger_date": ledger_date.isoformat(), "rev_replacement": is_rev, "rows_read": len(rows),
        })
        raw_rows += rows

    normalized = [n for n in (normalize_row(r, report) for r in raw_rows) if n is not None]
    current, all_rows = dedupe(normalized, report)
    if report.errors:
        return report, None, None, None
    return report, current, all_rows, review_queue(current)


def report_json(report, current, all_rows, queue):
    out = {
        "ok": not report.errors,
        "as_of": max((f["ledger_date"] for f in report.files), default=None),
        "files": report.files,
        "ignored_files": report.ignored,
        "errors": report.errors,
        "warnings": report.warnings,
        "schema_gaps": SCHEMA_GAPS,
    }
    if current is not None:
        out["counts"] = counts(current, all_rows)
        out["review_queue_count"] = len(queue)
        out["review_queue"] = queue
    return out


def print_report(rep):
    print(f"Ledger ingest — as of {rep['as_of']}  [{'OK' if rep['ok'] else 'FAILED'}]")
    for f in rep["files"]:
        tag = " (rev record_id)" if f["rev_replacement"] else ""
        print(f"  read  {f['ledger_date']}{tag}: {f['rows_read']} rows  — {f['title']}")
    for f in rep["ignored_files"]:
        print(f"  skip  {f['title']}: {f['reason']}")
    c = rep.get("counts")
    if c:
        print(f"  rows read {c['rows_read']}, after dedupe {c['rows_after_dedupe']}, superseded {c['rows_superseded']}")
        print(f"  missing high_estimate_usd {c['rows_missing_high_estimate_usd']}, missing price "
              f"{c['rows_missing_price']} {c['rows_missing_price_by_outcome']}")
        print(f"  by status {c['rows_by_status']}")
        print(f"  by premium_included {c['rows_by_premium_included']}")
        print(f"  by house {c['rows_by_house']}")
        print(f"  review queue: {rep['review_queue_count']} rows (see review_queue.csv)")
    print(f"  schema gap: {rep['schema_gaps'][0]}")
    for w in rep["warnings"]:
        print(f"  WARNING {w}")
    for e in rep["errors"]:
        print(f"  ERROR {e}")


def write_csv(path, columns, rows):
    tmp = path + ".tmp"
    with open(tmp, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=columns, extrasaction="ignore", lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    os.replace(tmp, path)


def write_outputs(out_dir, rep, current, all_rows, queue):
    os.makedirs(out_dir, exist_ok=True)
    if current is not None:
        write_csv(os.path.join(out_dir, "ledger_results.csv"), DATASET_COLUMNS, current)
        write_csv(os.path.join(out_dir, "ledger_rows_all.csv"), DATASET_COLUMNS + ["is_current"], all_rows)
        write_csv(os.path.join(out_dir, "review_queue.csv"),
                  ["record_id", "auction_house", "event", "year", "make", "model", "status", "matched", "notes"],
                  queue)
    with open(os.path.join(out_dir, "validation_report.json"), "w", encoding="utf-8") as fh:
        json.dump(rep, fh, indent=2, ensure_ascii=False)
        fh.write("\n")


def make_source(args):
    if args.source_dir:
        return ledger_source.CsvDirLedgerSource(args.source_dir)
    if args.offline:
        return ledger_source.CachedLedgerSource(args.cache_dir, offline=True)
    return ledger_source.CachedLedgerSource(
        args.cache_dir, upstream=ledger_source.SheetsLedgerSource(folder_id=args.folder_id))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--offline", action="store_true", help="build from the local cache only")
    p.add_argument("--source-dir", help="read <title>.csv ledgers from this directory instead of Drive")
    p.add_argument("--folder-id", default=os.environ.get("LEDGER_FOLDER_ID", ledger_source.LEDGER_FOLDER_ID))
    p.add_argument("--cache-dir", default=DEFAULT_CACHE_DIR)
    p.add_argument("--out-dir", default=DEFAULT_OUT_DIR)
    args = p.parse_args(argv)

    report = Report()
    current = all_rows = queue = None
    try:
        source = make_source(args)
    except ledger_source.LedgerSourceError as e:
        report.error(str(e))
    else:
        report, current, all_rows, queue = build(source, report)
        if isinstance(source, ledger_source.CachedLedgerSource) and not source.offline:
            print(f"cache: {source.hits} hit(s), {source.misses} pulled")
    rep = report_json(report, current, all_rows, queue)
    # The report is always written; the dataset only when there were no errors.
    write_outputs(args.out_dir, rep, current, all_rows, queue)
    print_report(rep)
    return 0 if rep["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
