# MII Data Pipelines

Two families of scripts feed the MII platform.

**Measured signal collectors** fill the three MII inputs the upstream pipeline
ships empty — Google Trends, YouTube and Social — writing per-model,
per-month CSVs that `mii-normalize.js` joins onto the results in the browser.
They run from `.github/workflows/signals.yml`.

```
google_trends.py     search interest      → data/google_trends.csv
youtube_signals.py   video attention      → data/youtube_signals.csv
reddit_signals.py    enthusiast chatter   → data/reddit_signals.csv
social_signals.py    the social composite → data/social_signals.csv   (run LAST)
```

`social_signals.py` runs last because it blends the other collectors' outputs
into `social_score`. The other three are independent of each other.

**Auction pipelines** score live-auction events and manufacturers. They run
from `.github/workflows/data-pipelines.yml`.

```
sync_from_garage_draft.py   ← populate auction_lots.csv from Garage Draft
auction_rating.py           ← score each event
mai.py                      ← compute per-manufacturer MAI scores
wikipedia_pageviews.py      ← can run anytime (independent)
```

Everything is stdlib-only except `auction_rating.py` / `mai.py`, which need
pandas.

```bash
python data/pipelines/test_pipelines.py   # offline tests for the collectors
node scripts/test-mii-signals.js          # tests for the browser-side join
```

---

## Setup — API credentials

Add these under **Settings → Secrets and variables → Actions**. Every collector
exits cleanly when its credentials are absent, and the front-end renormalizes
around whatever is missing, so you can add them one at a time.

| Secret | Needed by | How to get it | Cost |
|--------|-----------|---------------|------|
| `YOUTUBE_API_KEY` | `youtube_signals.py` | [Google Cloud console](https://console.cloud.google.com/apis/credentials) → create an API key, then enable **YouTube Data API v3** for the project | free, 10,000 quota units/day |
| `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | `reddit_signals.py` | [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) → create an app of type **script**; the id is under the app name, the secret is the `secret` field | free, 100 requests/min |
| `SERPAPI_API_KEY` | `google_trends.py` (optional) | [serpapi.com](https://serpapi.com) | paid — only needed if Google blocks the free path |

No credential is needed for Wikipedia or for the default Google Trends path.

---

## Why the schedule is daily

Two collectors cannot cover the ~3,300-model universe in one run:

- **YouTube** allows 10,000 quota units/day. A `search.list` costs 100 units and
  a `videos.list` costs 1, so one model costs 101 and a day's quota buys ~89
  models — about 5 weeks for a full pass.
- **Google Trends** has no official API and rate-limits scraping aggressively.

So every collector keeps a per-model state file (`data/*_state.csv`) recording
when each model was last measured, spends a per-run `--budget` on the models
measured least recently (never-measured models first, highest auction volume
first within that), and **upserts** its results. A truncated run is never
destructive, and daily runs converge on full coverage and then keep it fresh on
a rolling basis. Models that legitimately have no data are held back for 30
days so they do not consume the budget every run.

Raise `--budget` if you get a YouTube quota increase, or dispatch the workflow
manually with a larger budget to backfill faster.

---

---

## sync_from_garage_draft.py

Pulls manually-entered auction lots from the **Garage Draft** Supabase database
and merges them into `data/auction_lots.csv`, eliminating double-entry.

### What it does
- Queries the `auctions` table for all rows where `auction_reference IS NOT NULL`
  (these are the lots you've grouped under a named auction event)
- Maps garage-draft fields to the MII `auction_lots.csv` schema
- Derives `low_estimate_usd = price_at_48h ÷ 0.75` (since buy price = 75% of low estimate)
- Sets `high_estimate_usd = low_estimate_usd` as a conservative proxy
- Derives `sold` from `final_price IS NOT NULL AND NOT reserve_not_met`
- Parses `auction_house` from the leading tokens of `auction_reference`
  (e.g. `RM_Sothebys_Amelia_2025` → `RM Sothebys`)
- Idempotent: re-running appends only new lots (deduplicates by event + manufacturer + model + year)

### How to run

```bash
export GARAGE_DRAFT_SUPABASE_URL=https://<your-project-ref>.supabase.co
export GARAGE_DRAFT_SUPABASE_KEY=<your-anon-or-service-key>

pip install requests
python data/pipelines/sync_from_garage_draft.py
```

Find your Supabase URL and anon key at:
`Supabase dashboard → Project Settings → API`

### Field mapping

| auction_lots.csv | Source in garage-draft |
|------------------|------------------------|
| event | `auction_reference` |
| event_date | `timestamp_end` (Unix → YYYY-MM-DD) |
| auction_house | parsed from `auction_reference` prefix |
| lot_number | — (blank; fill manually if needed) |
| manufacturer | `make` |
| model | `model` |
| year_of_car | `year` |
| low_estimate_usd | `price_at_48h ÷ 0.75` |
| high_estimate_usd | same as low_estimate (proxy) |
| sold_price_usd | `final_price` |
| sold | `final_price > 0 AND NOT reserve_not_met` |
| notes | `title` |

### Apex classification note
The MAI pipeline flags lots as "apex" when `low_estimate_usd >= $500,000`.
The synced `low_estimate_usd` value (derived from `price_at_48h ÷ 0.75`)
is the single estimate used for this threshold. `high_estimate_usd` is left
blank — it's in the schema for optional manual use but not required by any pipeline.

### Customising the auction_house parser
The `parse_auction_house()` function splits on `_` and `-` and drops the final
token before the year. If your `auction_reference` naming convention is
different (e.g. `RMSothebys2025Amelia`), edit that function directly.

---

---

## wikipedia_pageviews.py

Fetches daily Wikipedia pageviews for seed classic car models from the Wikimedia REST API.
This operationalises the **N (network size)** term of the Networked Utility Dividend.

### What it does
- Pulls daily pageview counts for 10 seed article slugs over the trailing 12 months
- Appends only new dates to the output CSV — safe to schedule and re-run daily
- Logs a warning and skips any article slug that returns a 404

### How to run
```bash
pip install requests
python data/pipelines/wikipedia_pageviews.py
```

### Output — `data/wikipedia_pageviews.csv`

| Column | Type | Description |
|--------|------|-------------|
| model | string | Wikipedia article slug, e.g. `Porsche_911` |
| date | string | YYYYMMDD |
| pageviews | integer | Daily pageview count |

### How to add new models
Edit the `ARTICLE_SLUGS` list at the top of the script. The slug is the
title portion of the Wikipedia URL — for
`https://en.wikipedia.org/wiki/Ferrari_Testarossa` the slug is
`Ferrari_Testarossa`. Re-run the script to backfill trailing 12 months
for the new entry.

---

## google_trends.py

Collects search interest per model per month into `data/google_trends.csv`,
filling the MII's `google_trends_interest` input (weight 0.15), which is empty
on all 14,807 upstream rows.

### The comparability problem

Google Trends never returns absolute search volume. It returns values scaled
0–100 *within a single request*, and a request takes at most 5 keywords. So
"Porsche 911 = 100" in one request and "Datsun 240Z = 100" in another say
nothing about each other, and the ~3,300 models have to be stitched together.

The fix is an **anchor**: every batch asks for the same reference keyword plus
4 models. The anchor's true search volume is constant across batches, so the
ratio model/anchor is comparable everywhere:

```
trends_interest = 100 × (model's monthly value ÷ anchor's window mean)
```

Choose the anchor (`--anchor`, default `Porsche 911`) for *middling*
popularity. Too popular and obscure models round to 0 against it; too obscure
and the anchor is itself noisy. The run prints a warning when a batch's anchor
level falls low enough to cost precision, which happens when a batch-mate is
far more searched than the anchor.

Weekly points are averaged into calendar months, so a 4-week and a 5-week month
are on the same footing.

### Backends

- `trends` (default) — the public `trends.google.com` endpoints, no key. Google
  rate-limits these hard, especially from cloud IPs. The run backs off, then
  stops after `--max-consecutive-failures` batches and keeps its progress;
  the next run resumes from the staleest models.
- `serpapi` — set `SERPAPI_API_KEY`. A paid proxy for the same data that does
  not rate-limit. Used automatically when the key is present.

### How to run

```bash
python data/pipelines/google_trends.py                  # spend the run budget
python data/pipelines/google_trends.py --limit 8        # smoke test
python data/pipelines/google_trends.py --geo US         # US-only interest
SERPAPI_API_KEY=... python data/pipelines/google_trends.py --backend serpapi
```

### Output — `data/google_trends.csv`

| Column | Description |
|--------|-------------|
| manufacturer, model, month | grain (month is `YYYY-MM`) |
| trends_interest | anchor-normalized search interest |
| trends_source | `google_trends` or `serpapi` |
| measured_at | when this row was collected |

---

## youtube_signals.py

Collects video attention per model per month into `data/youtube_signals.csv`,
in one pass that feeds two different things:

- `yt_views` → the MII's `youtube_total_views` input (weight 0.10)
- `yt_videos` and engagement → sub-signals of the **social** composite

Those are deliberately different facets — new-video supply and interactions
versus view totals — so the social score and the YouTube input never
double-count each other.

### Method

Per model: one search for the model's phrase over the trailing window ordered
by view count, then one statistics lookup on the results. The videos are then
bucketed by the month they were published, which gives a per-month series in
two API calls instead of one call per month. Videos whose title and description
mention neither the manufacturer nor a distinctive model token are dropped, so
a quoted-phrase search that drifted does not pollute the count.

Because a search caps at 50 results, a model's monthly view sum is the sum over
its **50 most-viewed** videos in the window. That is a ranking signal, not a
census, which is all percentile-rank normalization needs.

### How to run

```bash
export YOUTUBE_API_KEY=...
python data/pipelines/youtube_signals.py                 # spend the daily budget
python data/pipelines/youtube_signals.py --limit 3       # smoke test
python data/pipelines/youtube_signals.py --budget 50000  # raised quota
```

### Output — `data/youtube_signals.csv`

| Column | Description |
|--------|-------------|
| manufacturer, model, month | grain; month is the video's **publish** month |
| yt_videos | videos about the model published that month |
| yt_views | their combined view count |
| yt_likes, yt_comments | their combined interactions |
| yt_engagement_rate | (likes + comments) ÷ views |
| measured_at | when this row was collected |

View counts are cumulative to the moment of collection, so a month measured
today has had longer to accumulate views than the same month measured next
week. Percentile ranking across the field absorbs this; `measured_at` records
it.

---

## reddit_signals.py

Collects enthusiast conversation per model per month into
`data/reddit_signals.csv`. This is the sub-signal the methodology doc weights
most heavily and the social composite was missing: **mention volume** (0.30)
and **engagement rate** (0.25).

These are off-platform mentions, deliberately not the same thing as the MII's
own `comments` input, which counts comments on the Bring a Trailer listing
itself — so the two never double-count.

Reddit's search reaches back one year, so `--months` is capped at 12. A model's
posts are capped at `--max-pages` × 100, which saturates for the most-discussed
cars; raise it if you want more resolution at the top of the field.

### How to run

```bash
export REDDIT_CLIENT_ID=... REDDIT_CLIENT_SECRET=...
python data/pipelines/reddit_signals.py
python data/pipelines/reddit_signals.py --limit 5    # smoke test
```

At 100 requests/minute a full pass over the universe takes well under an hour,
so unlike the other two collectors this one usually completes in a single run.

### Output — `data/reddit_signals.csv`

| Column | Description |
|--------|-------------|
| manufacturer, model, month | grain |
| reddit_posts | posts naming the model that month |
| reddit_score | their combined net upvotes |
| reddit_comments | their combined comment counts |
| reddit_engagement | (score + comments) ÷ posts |
| measured_at | when this row was collected |

---

## social_signals.py

Builds `data/social_signals.csv`, the 0–100 `social_score` the front-end joins
into the MII's Social input. Run it **last**: it collects the Wikipedia
sub-signals itself, then blends in whatever the Reddit and YouTube collectors
have produced.

Weights follow `docs/social-score-methodology.md` §3 — mention volume 0.30,
engagement rate 0.25, share of voice 0.20, social video 0.15, sentiment 0.10
(not collected). A sub-signal a row lacks is dropped and the rest renormalized,
never imputed, so a row with Wikipedia data alone still scores on attention
0.30 / SOV 0.20 → 0.6 / 0.4, exactly as it did before the other collectors
existed.

Wikipedia is refreshed only when the month has turned over, so a daily run is
cheap.

### How to run

```bash
python data/pipelines/social_signals.py              # refresh wiki if stale, blend
python data/pipelines/social_signals.py --reuse-wiki # blend only, no API calls
python data/pipelines/social_signals.py --force-wiki # refresh regardless
```

### Output — `data/social_signals.csv`

| Column | Description |
|--------|-------------|
| manufacturer, model, month | grain |
| wiki_slug | resolved Wikipedia article (cached in `wikipedia_slugs.csv`) |
| wiki_pageviews | monthly article pageviews |
| wiki_sov | share of the manufacturer's pageviews that month |
| reddit_posts, reddit_engagement, yt_videos | joined from the other collectors |
| social_score | the 0–100 composite |

The run prints a QA summary — distinct score count, how many models vary over
time, and per-sub-signal coverage — matching the checks in
`docs/social-score-methodology.md` §7.


---

## auction_rating.py

Computes an Auction Rating for each event in `data/auction_lots.csv`.

### What it does
- Identifies "apex" lots: `high_estimate_usd >= $500,000`
- Computes three sub-scores per event, normalised 0–100 across all events:
  - **Apex Concentration** — apex lot count / total lot count
  - **Apex Volume** — total sold price of sold apex lots
  - **Apex Sell-Through** — sold apex lots / apex lots
- Composite rating: `0.3×Concentration + 0.4×Volume + 0.3×Sell-Through`

### How to run
```bash
pip install pandas
python data/pipelines/auction_rating.py
```

### Output — `data/auction_ratings.csv`

| Column | Description |
|--------|-------------|
| event | Event name |
| event_date | Date of the event |
| auction_house | Auction house |
| apex_lots | Count of apex lots |
| total_lots | Total lots |
| apex_concentration | Normalised concentration (0–100) |
| apex_volume | Normalised apex sold volume (0–100) |
| apex_sell_through | Normalised sell-through rate (0–100) |
| auction_rating | Composite score (0–100) |

---

## mai.py

Computes the **Manufacturer Apex Index (MAI)** — a ranked score for each
manufacturer's presence and performance at apex auction events. This
operationalises the **D (network density)** term of the Networked Utility Dividend.

### What it does
For each manufacturer × event combination (apex lots only):
- **P (Presence)** — manufacturer's share of apex lots at that event
- **Q (Quality)** — mean(sold price / high estimate) for sold apex lots
- **R (Performance)** — sell-through rate for manufacturer's apex lots

`MAI = Σ(auction_rating × P × Q × R) / Σ(auction_rating)` across all events

### How to run
```bash
# auction_rating.py must be run first
python data/pipelines/auction_rating.py
python data/pipelines/mai.py
```

### Output — `data/mai_scores.csv`

| Column | Description |
|--------|-------------|
| manufacturer | Manufacturer name |
| events_present | Number of events with apex lots |
| total_apex_lots | Total apex lots across all events |
| avg_P | Unweighted average Presence across events |
| avg_Q | Unweighted average Quality across events |
| avg_R | Unweighted average Performance across events |
| MAI_score | Rating-weighted P×Q×R (the headline score) |

Rows are sorted descending by `MAI_score`.
