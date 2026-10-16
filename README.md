# Market Interest Index (MII) Dashboard

A comprehensive, interactive dashboard for tracking collector car market interest across manufacturers and models, based on auction data from Bring a Trailer.

> **Cars & Bids is not in the index.** Every row of the live
> `mii_results_latest.csv` carries `data_source = BAT`, and all 63,358 lots in
> `bat.csv` are bringatrailer.com listings. A C&B scraper exists in
> `car-scrapers` and `cnb.csv` sits in the same S3 bucket, but the loader's
> `USE_CNB_DATA` flag is off: that file stopped collecting in October 2025, so
> enabling it would add ~4,000 lots to five historical months and none to the
> eleven since — a step change in the universe partway through the series.
> This README previously promised both sources; it now describes what the
> index actually contains.

## Features

### 🎯 Overview page (`index.html`)
- **Headline and narrative**: the Market MII for the period (the market's
  level on the MII's 0 to 100 scale; see Normalization), its change in points,
  and a generated one-paragraph read of the month (or year to date)
- **What stands out**: insight cards built from the data (leading make,
  biggest real mover, most-watched model, interest outrunning price, most
  bidding, the selected HAGI index vs the market). Moves inside sampling noise
  are never reported.
- **HAGI index spotlight**: switch between the BMW Classic Index (16 cars: the
  committee's launch list plus the E46 M3, added in 2026), the MBCI (23
  collectors' Mercedes-Benz) and the MBCI Emerging Classics (6), all defined in
  `hagi-indexes.js`. Each shows its constituents' MII, rank against every
  model, trend and attention, and the index vs all of its make vs the market.
  Bring a Trailer files some constituents inside a wider group; one is matched
  to that group ("≈ group match") only when at least a third of the group's
  listings are the constituent, and otherwise shown as not measured
  separately. Constituents of every index are badged in the models table, and
  the value map highlights the selected index.
- **Value map**: every ranked model's MII against its average price (log
  scale), with the interest its price predicts, so cars drawing more attention
  than their price explains stand out
- **Manufacturers**: sortable leaderboard or make × month heatmap, with a
  detail drawer (history vs market, what drives the score, models)
- **Models, movers and eras**: most-watched models, biggest real movers, and
  interest by decade of manufacture
- **Explainer video**: a two-minute walkthrough of MII and Apex
  (`media/mii-explainer.mp4`) opens from the hero's Watch button and the footer;
  the Apex page's "Watch how Apex works" starts it at Part 2. `explainer.js`
  plays it in a dialog and downloads nothing until it is opened.
- **Sharing**: every view (period, vehicle class, open make) lives in the URL,
  the Share button copies it, and PDF prints a clean report. Light and dark themes.

### 📊 Key Metrics
- **MII Score**: Composite market interest index (0-100)
- **Auction Volume**: Number of auctions per manufacturer/model
- **Average Sale Price**: Mean transaction price
- **Sell-Through Rate**: Percentage of auctions that successfully sold
- **Trend**: Quarter-over-quarter percentage change
- **Confidence Level**: Data reliability indicator based on sample size

## MII Formula

The Market Interest Index is a weighted blend of eight inputs:

- **Sale Price**: 20%
- **Bid Activity**: 20%
- **View Count**: 15%
- **Google Trends Interest**: 15%
- **Comments**: 10%
- **YouTube Views** (share of views on leading enthusiast channels): 10%
- **Social Engagement**: 5%
- **Vehicle Age**: 5%

The weights sum to 1.0, so `MII = 100 × Σ(weight × normalized input)`.

### Nominal vs effective weights — quote the effective column

Those weights are **nominal**. Because an input a row has no value for is dropped
and the remaining weights renormalized (never imputed), the weight an input
actually carries depends on how widely it is measured. On the live dataset:

| Input | Nominal | **Effective** | Coverage |
|-------|---------|---------------|----------|
| Sale Price | 20% | **23.9%** | 100% |
| Bid Activity | 20% | **23.9%** | 100% |
| View Count | 15% | **17.9%** | 100% |
| Comments | 10% | **12.0%** | 100% |
| Google Trends | 15% | **11.2%** | 67.0% |
| YouTube | 10% | **0.1%** | 0.5% |
| Social | 5% | 5.1% | 87.0% |
| Vehicle Age | 5% | 6.0% | 100% |

The live index is **~78% a Bring a Trailer auction-behaviour measure**, not the
65% the nominal formula suggests. The table predates the October 2026 rebuild of
the YouTube collector, when YouTube reached 0.5% of rows: it now reads every
upload of a curated list of enthusiast channels on each run, so every car
model-month the MII scores gets a YouTube value (zero when the channels didn't
cover it) and the input carries close to its nominal 10%. Motorcycles and other
non-car classes are left out of it, since the channels don't cover them. `MII.effectiveWeights` recomputes
this after every `recompute()`, and the **How This Score Is Built** panel on the
Data Coverage tab of `analyze.html` renders it from live data — so the published
description can never drift from what the dashboard is doing.

### Methodology version

`MII.VERSION` (currently **2026.10**) stamps the scoring rules in force. Scoring
has changed materially over this index's life — min-max scaling gave way to
percentile rank, weight renormalization was added, the model and manufacturer
confidence scales were unified, and 2026.10 moved ranking from the whole file to
each month — so a score is only reproducible
against a stated version. Cite it with any figure taken from the dashboard, and
bump it whenever a change moves published scores.

## Reading a change: the noise floor

A model's monthly MII moves even when nothing about the market has, because a
different set of cars happened to cross the block. Measured across every
consecutive month-pair in the dataset, bucketed by the smaller of the two
months' auction counts:

| Auctions/month | Median swing | 90th percentile |
|----------------|--------------|-----------------|
| 1 | **10.5 pts** | 27.0 |
| 2 | 8.2 | 21.4 |
| 3–4 | 7.1 | 18.9 |
| 5–7 | 5.7 | 15.9 |
| 8–14 | 5.3 | 13.2 |
| 15+ | **4.0** | 8.8 |

**At one auction a month the median swing is 10.5 points**, and most models in
this dataset trade at that volume — so most month-to-month movement on screen is
sampling, not market. Practical rule: below ~8 lots in a month read the level and
never the change; a move becomes interpretable at ~15+ lots once it clears ~9
points.

`MII.moveStrength(points, auctions)` classifies a move as `noise` (under the
median), `weak` (median to 90th percentile) or `signal` (above). The dashboard
draws a within-noise trend greyed with a dotted underline instead of a confident
coloured arrow, with the reason in its tooltip.

### Attention: every model, every month

MII exists only in a month a car sells on Bring a Trailer, so a car that
trades twice a year has two readings, and a basket of cars (an index's
constituents) changes with whatever happened to sell. **Attention** fills
that gap: the three inputs measured for every model every month (Google
Trends, YouTube share of the tracked channels' views, and social), in the
same 15 : 10 : 5 proportions they carry inside MII, each ranked among all
models that month. 50 is the median model. A month is scored only when all
three inputs were broadly measured (at least half as many models as that
input's best month), so the month in progress and the months before Google
Trends collection began are left blank rather than scored on a different
mix. `MII.attentionFor(make, model, month)` returns it; the HAGI index section
shows the basket's attention (all constituents, traded or not), each
constituent's attention, and the attention line on its chart.

### Seeing interest rise in absolute terms

Because MII ranks each car within its month, a car's MII shows whether it is
gaining on other cars, not whether interest in it is growing. A car's absolute
interest is its relative position times the market's level: if the market is up
10% and a car's MII is flat, interest in the car is up about 10% too. The
overview's headline shows the market's level (the Market MII); the Model
comparison page's **Absolute Interest** chart shows each selected car's views
per sale beside the market's typical sale, on a log scale where equal slopes
mean equal growth.

### Our model list (`data/models.csv`) and variants (`data/variants.csv`)

The upstream file names models the way its sources did, which is not one name
per car: case and brand prefix ("Volkswagen Tiguan", "VOLKSWAGEN TIGUAN",
"TIGUAN"), Bring a Trailer's listing counters carried into untagged titles
("MUSTANG 903"), word order ("AMG G63", "G63 AMG"), and groups Bring a Trailer
renamed mid-stream ("996 Turbo", "996 911 Turbo"). Each duplicate was its own
row every month and was credited with the same lots.

`data/pipelines/model_list.py` (run first in the daily signals workflow) maps
every source name to one model in `data/models.csv`, with the rule that joined
them and a flag where a name is not a single car (`replica`, or `catch-all` for
a bare nameplate such as "MUSTANG" that mixes generations). Judgment calls go in
`data/model_overrides.csv`, which wins over the rules. The browser merges a
month's duplicate rows before scoring (lots add up, per-lot averages are
weighted by lots), every join to Bring a Trailer lots goes through the same
names, and the collectors measure each model once.

Index constituents are named one level finer, in the levels CLASSIC.COM uses
(make → model → generation → variant): the 911 Carrera RS 2.7 Lightweight, not
just the 1973 Carrera RS. `data/variants.csv` lists every constituent of the
HAGI Top, F (Ferrari), P (Porsche), MBCI and BMW CI indexes with the years it
was built and how to recognise it in a Bring a Trailer title; replicas,
recreations, continuations and conversions never count.
`python3 data/pipelines/variants.py` reports what each variant finds and flags
sales far below the variant's median for a look.

### Normalization (percentile rank)

Each input is converted to a **percentile rank** among the cars of the same
month before weighting: 0 = lowest, 1 = highest, ~0.5 = that month's median car.
Ranking within the month (since methodology 2026.10; before, the whole file was
ranked at once) keeps three things out of a car's score that have nothing to do
with the car: new months re-ranking old ones, Bring a Trailer's traffic growth
lifting later months, and the rolling window shifting every score as old months
drop out. An input measured on fewer than 30 cars in a month is ranked against
the whole field for that month instead.

Because every month is ranked on its own, the market's average MII sits near 50
by design. The overview's headline therefore shows the market's level a
different way: the **Market MII**, the attention the typical listing draws, on
the MII's own 0 to 100 scale. Each vehicle listing, sold or not, gets the
percentile of its views, watchers, comments and bids among every listing of a
fixed reference year, June 2025 to May 2026, averaged with equal weight
(`MII.listingScore`); a month's Market MII is its median listing's score
(`MII.marketScore`). So 50 is as much attention as the typical listing of the
reference year, and like any MII it cannot pass 100. The year starts in June
2025 because capture began on 16 May 2025, and it never moves, so a published
month stays put as new months arrive. Price is left out: it measures value, not
attention, and has its own figure. Ranking is done in the
browser by `mii-normalize.js`, which every page calls right after loading the
CSV, so every page agrees on a car's score.

Inputs a row has no value for are dropped from its blend and the remaining
weights renormalized, so a missing input never counts as "scored zero" and a
dataset-wide dead column can't cap every score below 100. `MII.dataQuality`
reports each input's health (`ok` / `empty` / `static`) after every recompute,
and the Model Comparison radar labels flag degraded axes.

### Measured signals collected in this repo

Three of the eight MII inputs are **not supplied by the upstream pipeline**.
In the live `mii_results_latest.csv` (14,807 rows), `google_trends_interest` is
empty on every row (`google_trends_source = "missing"`), `youtube_total_views`
is populated on 6, and `social_score` on 6. Because a missing input is dropped
from a row's blend and the remaining weights renormalized, 30% of the MII —
Trends 15% + YouTube 10% + Social 5% — was contributing nothing to any car, and
those three radar axes read flat.

`data/pipelines/` collects them here instead, per model and per **month**:

| Input | Pipeline | Output | Source |
|-------|----------|--------|--------|
| Google Trends (0.15) | `google_trends.py` | `data/google_trends.csv` | Google Trends, normalized against a chained anchor ladder |
| YouTube (0.10) | `youtube_signals.py` | `data/youtube_signals.csv` | YouTube Data API v3: every upload of the channels in `data/youtube_channels.csv` |
| Social (0.05) | `social_signals.py` | `data/social_signals.csv` | Wikipedia + Reddit + YouTube uploads |
| — (social sub-signal) | `reddit_signals.py` | `data/reddit_signals.csv` | Reddit search |

`mii-normalize.js` fetches all three signal files on every page load and joins
them onto the raw columns before ranking, so the axes carry real, time-varying
values. The join **fills gaps** and additionally **replaces upstream
placeholders** — a `google_trends_source` of `missing` or `estimate` is
overwritten by a measured value, while a genuine upstream measurement always
wins. When a file is absent the weight renormalization keeps every score
correct without it; nothing is ever imputed.

`.github/workflows/signals.yml` runs the collectors daily and commits the
results. See [`data/pipelines/README.md`](data/pipelines/README.md) for the API
keys each one needs and why the schedule is daily rather than monthly.

#### The social composite

`social_score` was once a static per-brand constant — 19 distinct values, 93%
of manufacturers pinned to one default, identical for every generation of a
nameplate and unchanging over time. It is now a weighted blend of measured,
percentile-ranked sub-signals following
[`docs/social-score-methodology.md`](docs/social-score-methodology.md):

| Sub-signal | Weight | Measured as |
|------------|--------|-------------|
| Mention volume | 0.30 | Wikipedia article pageviews and Reddit post count |
| Engagement rate | 0.25 | Reddit interactions per post |
| Share of voice | 0.20 | the model's share of its manufacturer's attention |
| Social video | 0.15 | new YouTube videos about the model that month |
| Sentiment | 0.10 | not collected yet |

Sub-signals a row lacks are dropped and the rest renormalized, so a model with
Wikipedia data alone still scores, and gains precision as the other collectors
reach it. These facets are deliberately distinct from the MII's own inputs —
YouTube **upload count** here versus **view totals** as an input, off-platform
Reddit mentions versus on-listing Bring a Trailer comments — so the social
score and the other seven inputs never double-count each other.

Model → Wikipedia article mappings are cached in `data/wikipedia_slugs.csv` and
can be hand-curated.

Percentile ranking replaces the older min-max scaling (value ÷ dataset-max).
Auction prices, views, and comments are extremely right-skewed — a handful of
seven-figure cars and a long tail of affordable ones — so min-max scaling pushed
the typical car's normalized value toward zero and crushed nearly every score
into the 20s–30s. Percentile rank spreads models across the full 0–100 range and
makes the score answer "how does this car rank against that month's field" rather than
"what fraction of the single priciest car's value did it reach".

## Confidence Levels

Confidence is read off the auction count behind a figure, and the thresholds
depend on the **grain** of the period selected — a single month is held to a
lower bar than a YTD/quarterly aggregate covering many times the window.

| Badge | Monthly period | YTD / quarterly |
|-------|----------------|-----------------|
| **High** (●)        | 15+ auctions | 50+ auctions |
| **Medium-High** (◐) | 8–14         | 20–49        |
| **Medium** (◐)      | 4–7          | 10–19        |
| **Low** (○)         | under 4      | under 10     |

`MII.confidenceFor(auctions, grain)` in `mii-normalize.js` is the single
definition, used for both manufacturer rows and model rows. They previously
disagreed: model rows ran their own far looser scale (5 auctions read as
"High" at monthly grain, where the manufacturer scale called the same sample
"Medium"), so a thinly-traded model could carry a High badge on a handful of
sales. Treat any badge below High as a sample-size caveat, not a market signal.

## Usage

### Running Locally

1. **Simple HTTP Server** (Python):
   ```bash
   python3 -m http.server 8080
   ```
   Then open http://localhost:8080/index.html

2. **Using Node.js** (http-server):
   ```bash
   npx http-server -p 8080
   ```
   Then open http://localhost:8080/index.html

3. **Direct File Access**:
   Simply open `index.html` in any modern web browser

### Controls & Navigation

- **Period**: any month, or the year to date. Select a point on the market
  chart to jump to that month.
- **Vehicle type**: All, Cars or Motorcycles. Scores are ranked against every
  car of the month either way, so a car's MII does not change between views.
- **Manufacturers**: search, minimum auctions (5/10/20/50), sort by any column,
  or switch to the heatmap to compare makes month by month. Select a make for
  its drawer.
- **Models**: search any model, or filter to HAGI index constituents. Select a
  model (anywhere on the page) for its individual Bring a Trailer sales.
- **Share / PDF**: the URL always reflects the current view
  (`#period=2026-09&class=car&make=BMW&index=mbci`), so a copied link reopens it exactly.

## Technology Stack

- **HTML5**: Semantic markup
- **CSS**: one shared stylesheet, `site.css`, with design tokens for light and dark themes. The Tailwind-built pages (Apex Index, Model comparison, Data analysis, Admin) map their colours onto the same tokens through `mii-light-theme.js` / `.css`, so every page follows the same theme toggle
- **Vanilla JavaScript**: Zero dependencies for core logic
- **Chart.js**: Interactive, responsive charts
- **No Build Process**: Works directly in browser

## Data Structure

The dashboard currently uses sample data with the following manufacturers:
- Porsche
- BMW
- Mercedes-Benz
- Ferrari
- Nissan
- Toyota
- Audi
- Chevrolet
- Ford
- Lamborghini
- Jaguar
- Land Rover

### Extending with Live Data

To integrate real auction data:

1. Replace the `sampleData` object in `app.js` with an API call
2. Ensure data follows this structure:
```javascript
{
  lastUpdated: "ISO 8601 timestamp",
  quarters: ["2024Q3", "2024Q4", ...],
  manufacturers: [
    {
      make: "Manufacturer Name",
      logo: "Emoji or URL",
      auctions: 245,
      avgPrice: 89500,
      miiScore: 87.4,
      confidence: "High",
      trend: 4.2,
      sellThrough: 78,
      history: [82.1, 83.5, 85.2, 86.8, 87.4],
      models: [...]
    }
  ]
}
```

## Files

- `index.html` - Main dashboard HTML structure
- `app.js` - Application logic, data management, and rendering
- `app.py` - Legacy Streamlit Python scraper (deprecated)
- `requirements.txt` - Python dependencies for legacy app

## Lot-Level Drill-Down

The monthly figures shown for each model (e.g. "$28K avg") are the **mean of the
individual auction sales** in that period — a single high or low sale never shows
up as its own point on the headline charts. To see the sales behind a number,
click any model row in a manufacturer's **Model Rankings** panel. A modal opens
with:

- A scatter plot of every individual sale price over time (sold vs. unsold).
- A table of each lot: sale date, model year, price, status, bid/comment activity,
  and a link to the original Bring a Trailer listing.

This makes outlier sales (e.g. a $56K E46 M3 in a month that averaged $28K) visible
and traceable. Non-USD sales are listed in the table but omitted from the price axis.

### Parts and memorabilia are excluded

Bring a Trailer files hard parts and memorabilia under the donor car's own make
and model — wheels, seats, engines, manuals, illuminated signs — so counting
rows treats a $300 steering wheel as an auction of the car. The skew is uneven
enough to distort comparisons between models: **23% of BMW E30 M3 rows and 15%
of Porsche 911 Carrera 3.2 rows are parts, against 1% for the E46 M3 and 0% for
the Mercedes 190E 16V**. Removing them *raises* the E30 M3's median sale from
$60,005 to $69,000.

`MII.isVehicleLot(row)` drops any lot whose bat.csv `category` is `Parts` or
`Wheels`, and every page applies it when it reads bat.csv, so auction counts,
confidence badges, price averages, the drill-down scatter and the lot-level
correlations all see cars only.

The test is BAT's own category rather than the listing slug. A slug rule — "a
real car's URL starts with a model year" — flags exactly the same lots on every
model checked, but also drops ~900 genuine vehicles whose slug leads with
something else: Superformance, Backdraft, Factory Five, Kirkham and Meyers Manx
replicas, and listings such as `supercharged-2008-bmw-m3-convertible`. A feed
with no `category` column filters nothing, so older exports keep working.

## Live-Auction Lots (Manufacturer Apex Index)

Results from live auction events (RM Sotheby's, Gooding, Broad Arrow, Bonhams,
Mecum…) are entered in the **canonical auction store**, the one table that
also holds Bring a Trailer and Cars & Bids listings. Enter them in the
**Live Entry** tab of the store panel (`/store` in garage-draft's admin app):
catalogue estimates before the sale, results after it. Its Claude importer
reads a pasted results page, URL or PDF into an editable staging table, and
nothing is written until you import. Schema and setup live in
`cc-market-survey/auction-store`.

`data/pipelines/export_live_lots.py` copies every **ended** lot from the
store's `public.auction_live_lots` view into `data/auction_lots.csv`: event,
house, lot, estimates, fee-inclusive price and outcome, converted to USD at
the sale-date ECB rate when a lot is stored in another currency. Lots still at
the estimate stage and withdrawn lots are left out, so they never count as
unsold.
The `data-pipelines.yml` workflow runs it daily at 07:41 UTC, reruns
`auction_rating.py` and `mai.py`, commits the three CSVs and re-triggers the
Pages deploy, so a sale entered in the store reaches the Manufacturer Apex
Index chart the next morning. It needs two repository secrets,
`CANONICAL_SUPABASE_URL` and `CANONICAL_SUPABASE_ANON_KEY`. Without them the
export is skipped and the existing CSV is used.

The export refuses to drop a hand-entered event (one typed into
`auction_lots.csv` before the store existed) that is missing from the store,
and names it in the run's warnings, so those lots can't vanish silently.
Import those sales through Live Entry, or run the workflow manually with
**allow_drop_events** once they're in under a different name. Events the
export wrote itself aren't held back: a sale merged or renamed in Sale
Cleanup just replaces its old name the next morning.

Lots of a sale **still to come** (catalogue estimates entered, no results
yet) are written to `data/upcoming_lots.csv` on the same run, with estimates
converted at the latest ECB rate. `mai.html` shows them in **Upcoming apex
consignments**: each make's apex lot count and share across the upcoming
sales (the top 10% of each sale of 20+ lots by high estimate), the sum of
their high estimates and the make's current MAI rank. They are kept out of
the MAI score: with no results there is no sell-through, and counting the
lots as unsold would sink every make consigned to the sale. Once results are entered, the lots move into
`auction_lots.csv` and the ranking the next morning. A lot whose sale date
has passed without results appears in neither file until it's updated.

**HAGI Top Index at the summit** (`mai.html#hagi-top`) breaks out the 24
cars of HAGI's Top Index (2010, Porsche and Ferrari excluded; the
`data/variants.csv` rows tagged `hagi-top`). `data/pipelines/hagi_top.py`, run
by `mai.py`, matches every lot of every sale to the car it is, from the Bring
a Trailer listing slug where there is one and "year make model" otherwise,
replicas and recreations excluded, and writes `data/hagi_top_lots.csv`. Each
highlight carries the weight `mai.py` gives it (its sale's rating over the
sale's highlight count, over all sales' ratings), so the cars' shares add up
to the Apex score the index would have as one make, and the panel shows where
that would rank. A sold price under 40% of the car's median (with three or
more results) is set aside as most likely not the car.

MAI's apex lots are the **top 10% of each sale** (20 lots or more), ranked
by high estimate, or by sold price for a lot with no estimate. Lots entered
from results pages only (and Mecum and Barrett-Jackson, which generally don't
publish estimates) still rank once sold; an unsold lot with no estimate can't
be ranked. Each sale is weighted by what it took to be a top-10% lot there.
See `data/pipelines/README.md`.

`admin.html`, which used to commit lots straight to the CSV with a GitHub
token, now just points to the store. It removes the token and API key the old
page kept in the browser, and offers any unsaved lots as a CSV download.

## Data Maintenance Scripts

Run from the repo root (`node scripts/<name>.js`). All three read `bat.csv` from
S3 by default, or a local copy via `--csv /path/to/bat.csv`.

- `scripts/diagnose-data-gaps.js` — month/day coverage report; flags months with
  suspiciously low auction counts (< 50% of median).
- `scripts/backfill-checker.js <start> <end>` — lists every date in a range with
  zero auction records, ready to pipe into a re-scrape.
- `scripts/clean-bat-data.js` — removes rows with a **corrupt** `sale_date` (e.g.
  the Unix-epoch sentinel `12/31/69`, which otherwise creates a phantom "2069-12"
  month). Rows with a blank date (usually live/unsold listings) are kept and only
  reported. Writes `bat.cleaned.csv`; use `--dry-run` to report without writing.

`data/backfill-needed.txt` holds the current list of missing dates in flagged
months, regenerated from the diagnostics.

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- All modern browsers with ES6+ support

## Future Enhancements

- [ ] Real-time data integration via API
- [ ] Export functionality (CSV, PDF)
- [ ] User preferences persistence (localStorage)
- [ ] Mobile-responsive optimizations
- [ ] Additional chart types (scatter, heat maps)
- [ ] Bookmark/favorite manufacturers
- [ ] Price range filtering
- [ ] Time period customization

## License

© 2025 Market Interest Index

## Contributing

To contribute or report issues, please contact the repository maintainer.
