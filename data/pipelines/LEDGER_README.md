# Weekly Auction Results Ledger ingest

Reads the weekly **Auction Results Ledger** Google Sheets, builds one deduplicated dataset,
validates it, and feeds the **Apex Ledger** tab (`mai-ledger.html`).

This runs separately from the MII pipeline and from the store-fed MAI
(`export_live_lots.py` → `auction_rating.py` → `mai.py`). Neither of those is read or changed.

```
ledger_source.py   where ledgers come from: Sheets (live), a CSV directory, or the local cache
ledger_ingest.py   discover → read by header → normalize → dedupe → validate → write
ledger_mai.py      status filter, manufacturer grouping, apex classification, coverage counts, MAI (formula pending)
ledger_manufacturer_groups.csv   make → manufacturer roll-ups (edit by hand)
test_ledger.py     offline tests over fixtures/ledgers
```

Outputs, all in `data/ledger/`:

| File | What |
|---|---|
| `ledger_results.csv` | The dataset: one row per lot key, at its latest ledger |
| `ledger_rows_all.csv` | Every row read, with `is_current`. Use it to trace a figure's history |
| `review_queue.csv` | Rows whose notes read like an outlier caveat, for a human to triage |
| `validation_report.json` | Counts, errors and warnings. Written on every run, including failed ones |
| `mai_ledger.json` | What the Apex Ledger tab renders |
| `.cache/` | Raw pulls (gitignored) |

---

## 1. Credentials (one time)

1. In Google Cloud console, pick or create a project and **enable** the *Google Drive API*
   and the *Google Sheets API*.
2. *IAM & Admin → Service accounts → Create*. It needs no project roles.
3. On the service account, open *Keys → Add key → JSON* and download it. **Keep it out of the
   repo.** `.gitignore` already ignores `.env` and `*service-account*.json`, but store it
   elsewhere anyway.
4. In Drive, share the ledger folder (`1UXQTkUXMd6yJR-AlmSQGRr2ss1cqbE5y`) with the service
   account's email (`…@….iam.gserviceaccount.com`) as **Viewer**.
5. Copy `.env.example` to `.env`, or export the variables directly:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/key.json
export LEDGER_FOLDER_ID=1UXQTkUXMd6yJR-AlmSQGRr2ss1cqbE5y   # the default
pip install -r data/pipelines/requirements-ledger.txt
```

Scopes are read-only: `drive.metadata.readonly` lists the folder, because the Sheets API
can't list a folder, and `spreadsheets.readonly` reads the cells.

## 2. Run

```bash
python data/pipelines/ledger_ingest.py            # live, through the cache
python data/pipelines/ledger_mai.py               # CONFIRMED + REPORTED (default)
python data/pipelines/ledger_mai.py --status CONFIRMED
```

Other ways to build:

```bash
python data/pipelines/ledger_ingest.py --offline                 # from .cache only, no network
python data/pipelines/ledger_ingest.py --source-dir some/dir      # <title>.csv files
python data/pipelines/test_ledger.py                             # tests, offline
```

**Cache and reproducibility.** Each pull is stored as `.cache/raw/<file id>__<modified time>.json`.
A file whose Drive modified time hasn't changed is read from disk. `--offline` uses the last
folder listing and the cached pulls, and fails if anything is missing. Outputs contain no
wall-clock timestamps and rows are sorted deterministically, so the same cache always produces
byte-identical outputs (`test_cli_writes_reproducible_outputs` checks this).

Exit status is **1** on any hard error. The dataset files are then left as they were, and
`validation_report.json` records why.

## 3. Discovery rules

- Titles must match `Auction Results Ledger – <Month DD, YYYY>`, where the dash is an
  **en dash (U+2013)**. A title with a hyphen or em dash is not ingested; the run reports it as
  a warning so it isn't dropped silently.
- When a date has both a plain file and `… (rev record_id)`, the rev file is used and the plain
  one is listed under `ignored_files`.
- A sheet without a `record_id` column, with no rev replacement, is a **hard error naming the
  file**. A record_id is never guessed.
- Each spreadsheet must have exactly one tab.

> **Current state of the folder (5 Oct 2026):** both ledgers there (28 Sep, 5 Oct) predate
> `record_id`, and neither has a `(rev record_id)` replacement. A live run therefore fails
> today, by design, until those two replacement sheets exist.

## 4. Dedupe

`record_id = <lot key>@<YYYYMMDD ledger date>`. Rows are grouped by lot key and **only the row
from the latest ledger is kept**. Corrections arrive as new rows in later ledgers. In the
5 October ledger, 16 of 23 rows restate 28 September rows, so a plain union would count the
Zurich lots twice, once in EUR and once in CHF.

- `supersedes` is carried through as the audit trail. Dedupe never reads it; a test blanks it
  and checks the result doesn't change.
- `make` + `model` is never a join key. Model names change between weeks (lot 122:
  "365 GTB/4 Daytona" → "365 GTB/4 Daytona Berlinetta").
- The record_id's ledger date must match the date in the file's title, because dedupe orders
  rows by it.

## 5. Dataset schema — `ledger_results.csv`

Every ledger column is passed through as recorded, read **by header name**. Blank cells stay
blank and are never written as 0. Numbers are checked to be plain decimals and written without
reformatting.

| Column | Meaning |
|---|---|
| `record_id` | `<lot key>@<ledger date>` as recorded |
| `lot_key` | Left side of record_id: the lot's stable identity |
| `ledger_date` | Right side of record_id, ISO |
| `supersedes` | As recorded (audit trail only) |
| `event_date`, `auction_house`, `event`, `lot_number`, `year`, `make`, `model` | As recorded |
| `outcome` | `sold` / `not_sold` / `withdrawn` |
| `result_state` | Derived: `sold_with_price` / `sold_without_price` / `not_sold` / `withdrawn`. A sale is not assumed to have a price |
| `price`, `currency` | As published by the house: the source of truth |
| `premium_included` | `yes` / `no` / `unknown`. Hammer-only and premium-inclusive prices aren't comparable; MAI output is segmented by this |
| `price_usd`, `fx_rate` | As recorded. Never re-converted |
| `fx_date` | Derived: the ledger date, i.e. the week whose rate `fx_rate` is. Blank when `fx_rate` is blank. Makes future re-basing possible |
| `estimate_low`, `estimate_high`, `estimate_currency` | As published. `estimate_currency` may differ from `currency`; the price's `fx_rate` is never applied to the estimate |
| `high_estimate_usd` | As recorded. **Blank = unknown**, never 0 |
| `status` | `CONFIRMED` / `REPORTED` / `UNVERIFIED` |
| `source_url`, `first_reported`, `notes` | As recorded |
| `source_file_title`, `source_file_id` | The sheet this row came from |

`ledger_rows_all.csv` has the same columns plus `is_current`.

## 6. Reading `validation_report.json`

| Key | |
|---|---|
| `ok` | `false` if there were any hard errors |
| `files` | Each ledger read: date, whether it was the rev replacement, rows read |
| `ignored_files` | Files skipped and why (replaced by rev, not a ledger title) |
| `counts.rows_read` / `rows_after_dedupe` / `rows_superseded` | |
| `counts.rows_by_house`, `rows_by_status`, `rows_by_premium_included`, `rows_by_result_state` | Over the deduplicated rows |
| `counts.rows_missing_high_estimate_usd` | Lots that can't be classed apex or non-apex |
| `counts.rows_missing_published_estimate` | Blank `estimate_high` |
| `counts.rows_missing_price` (+ `_by_outcome`) | Blank price, split into not-sold and sold-but-withheld |
| `counts.rows_with_estimate_currency_unlike_price_currency` | |
| `review_queue` | See below |
| `errors`, `warnings` | |
| `schema_gaps` | Known gaps in the ledger schema |

**Hard errors:** unparseable `record_id`; record_id ledger date ≠ file date; duplicate
`record_id`; `supersedes` naming a lot key that doesn't exist, or a *different* lot key (both
would stay current and be double-counted); `outcome` outside {sold, not_sold, withdrawn};
`premium_included` outside {yes, no, unknown}; `status` outside the three values; a price or
other numeric column that is negative or non-numeric (`"263,750"` counts as non-numeric);
`high_estimate_usd` = 0; missing columns; a legacy sheet without its rev replacement.

**Warnings:** a not-sold row carrying a price, a price with no `price_usd`, unknown extra
columns, ledger-like titles with the wrong dash, and `supersedes` naming a record_id that isn't
in any ingested ledger.

**Review queue (known schema gap).** Outlier caveats (charity lots, one-off coachbuilt
commissions, works competition cars, specification-premium cars) exist only as free text in
`notes`. The ingest does **not** turn them into a flag. It lists rows whose notes match broad
outlier wording in `review_queue.csv`, with the matched categories, for a human to triage. The
lasting fix is a structured column in the ledger.

## 7. MAI

`ledger_mai.py` implements:

- **Status filter** (`--status`). The default includes CONFIRMED and REPORTED and excludes
  UNVERIFIED. The excluded count is written next to the figures and shown on the tab.
- **Manufacturer grouping:** `ledger_manufacturer_groups.csv` maps sub-brands onto their manufacturer
  (Mercedes-AMG, Mercedes-Maybach and Maybach → Mercedes-Benz). The dataset keeps `make` as recorded; the
  grouping is applied here, and the tab lists the makes rolled into each manufacturer. Makes not in the file are
  their own manufacturer. To add a group, add a row; a make listed twice is an error. The mapping is explicit,
  not a name pattern, because a pattern would fold "Frazer Nash-BMW" (licence-built, not a BMW) into BMW.
  It works on the make only, so a pre-war Maybach would also land under Mercedes-Benz.
- **Apex rule:** `high_estimate_usd ≥ 500,000`. A blank `high_estimate_usd` is
  **`apex_unknown`**, counted separately and shown next to every manufacturer figure.
  It never counts as non-apex.
- **Coverage per manufacturer and per event**, for `all` and each `premium_included`
  segment: apex / non-apex / apex_unknown, with apex lots split into sold-with-price,
  sold-without-price, not sold and withdrawn.

**Formula** (`compute_mai()` in `ledger_mai.py`): the P × Q × R core of the repo's MAI v1, adapted so
nothing is imputed. Per manufacturer × event, over that event's apex lots:

| Term | Definition |
|---|---|
| P | Manufacturer's apex lots ÷ all apex lots at the event. apex_unknown lots are in neither count |
| Q | Mean of price ÷ high estimate over apex lots **sold with a price**. Uses the house's currency (`price / estimate_high`) when price and estimate share a currency, so no FX enters; otherwise `price_usd / high_estimate_usd` as recorded. `q_basis` counts which was used |
| R | Sold (with or without a published price) ÷ (sold + not sold) |

```
MAI = mean over events of (P × Q × R)        # events unweighted
```

- **Withdrawn** lots are left out of P and R, matching `export_live_lots.py`.
- **Nothing sold** → R = 0 → the term is 0. That's the product's real value, not a filled-in Q.
- **Sold but no usable price** (for example, the GT2 Clubsport) → Q unknown → the term is unknown. It
  is left out of the mean and counted in `events_unscored`; it is never counted as 0.
- **No known term** → `mai` is null, shown as "n/a".
- **Unweighted events.** v1 weights events by an auction rating built on each sale's total lot count,
  which a curated weekly ledger doesn't have. Weighting by apex sold USD would hit withheld prices.
- Scores are computed separately for each `premium_included` segment and for `all`.

Each manufacturer row in `mai_ledger.json` carries `mai`, `avg_P`, `avg_Q`, `avg_R`, `events_scored`,
`events_unscored`, `q_basis`, the makes grouped into it, and the apex / non_apex / apex_unknown counts.
