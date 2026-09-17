# Market Interest Index (MII) Dashboard

A comprehensive, interactive dashboard for tracking collector car market interest across manufacturers and models, based on auction data from Bring a Trailer and Cars & Bids.

## Features

### 🎯 Core Functionality
- **Real-time Market Overview**: Track key metrics across manufacturers
- **Interactive Leaderboard**: Sort and filter manufacturers by various criteria
- **Detailed Model Breakdowns**: Dive deep into individual manufacturer performance
- **Trend Visualization**: View historical MII scores over 5 quarters
- **Comparison Tool**: Compare up to 4 manufacturers side-by-side
- **Advanced Filtering**: Search, filter by auction volume, and customize views

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
- **YouTube Views**: 10%
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
65% the nominal formula suggests, and YouTube's 10% is a rounding error until
that collector reaches more than seven models. `MII.effectiveWeights` recomputes
this after every `recompute()`, and the **How This Score Is Built** panel on the
Data Coverage tab of `analyze.html` renders it from live data — so the published
description can never drift from what the dashboard is doing.

### Methodology version

`MII.VERSION` (currently **2026.09**) stamps the scoring rules in force. Scoring
has changed materially over this index's life — min-max scaling gave way to
percentile rank, weight renormalization was added, and the model and
manufacturer confidence scales were unified — so a score is only reproducible
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

### Normalization (percentile rank)

Each input is converted to a **percentile rank** across the whole dataset before
weighting: 0 = lowest, 1 = highest, ~0.5 = the median car. This is done in the
browser by `mii-normalize.js`, which every page calls right after loading the
CSV, so the classic and HAGI pages always agree on a car's score.

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
| YouTube (0.10) | `youtube_signals.py` | `data/youtube_signals.csv` | YouTube Data API v3 |
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
makes the score answer "how does this car rank versus the field" rather than
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

#### Search & Filter
- **Search Box**: Type to filter manufacturers by name
- **Min Auctions**: Set minimum auction threshold (5, 10, 20, or 50)
- **Sort By**: Choose metric to sort by (MII Score, Volume, Price, Trend, Sell-Through)
- **Sort Order**: Toggle ascending/descending order

#### Manufacturer Selection
- **Click any row** in the leaderboard to view detailed breakdown
- **Model Rankings**: See all tracked models sorted by MII score
- **Trend Chart**: Visualize 5-quarter performance history

#### Comparison Mode
- **+ Button**: Add up to 4 manufacturers to comparison
- **✓ Button**: Manufacturer is selected for comparison
- **Clear All**: Remove all from comparison
- **Chart**: View overlaid trend lines for selected manufacturers

### View Modes
1. **Leaderboard**: Main ranked list view (default)
2. **Compare**: Focus on multi-manufacturer comparison
3. **Trends**: Historical trend analysis

## Technology Stack

- **HTML5**: Semantic markup
- **Tailwind CSS**: Modern, utility-first styling via CDN
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

## Live-Auction Admin Tab

`admin.html` (linked as **Admin** in the dashboard header) is a data-entry page
for results from live auction events (RM Sotheby's, Gooding, Bonhams, Mecum…).
Enter the event once, quick-add lots (an **APEX** badge lights up at a ≥$500K
low estimate), then **Save to GitHub** — the page commits the rows to
`data/auction_lots.csv` via the GitHub Contents API using a fine-grained
personal access token (scoped to this repo, Contents read/write only) that is
stored solely in your browser's localStorage.

On each commit touching `data/auction_lots.csv`, the
`data-pipelines.yml` workflow reruns `auction_rating.py` and `mai.py`, commits
the regenerated `data/auction_ratings.csv` / `data/mai_scores.csv`, and
re-triggers the Pages deploy — so the Manufacturer Apex Index chart on the
dashboard updates within a few minutes of saving.

Offline/no-token fallback: **Download CSV** exports existing + pending rows as
a merged `auction_lots.csv` for a manual commit. Pending lots persist in
localStorage, so closing the tab mid-event loses nothing. Duplicates are
flagged using the same key as `sync_from_garage_draft.py`
(event + manufacturer + model + year).

### Claude-powered results importer

Section 2 of the admin page bulk-imports published results: copy any auction
house's results page (or press release), paste it in — or **attach the PDF
directly** (sent to the API as a native document, so scanned catalogs are read
visually; up to 30 MB / ~100 pages per import) — and press **Extract lots**. The page calls the Claude API directly from the browser
(model `claude-opus-4-8`, streaming, structured outputs constrained to the
`auction_lots.csv` schema) and drops the extracted rows into the pending table.
Rows the model was unsure about (currency conversions, buyer's-premium
ambiguity, missing estimates) are flagged amber for review — nothing is
committed until you press Save. Requires an Anthropic API key (from
platform.claude.com) entered in the connection panel; like the GitHub token it
lives only in the browser's localStorage. A full results page costs a few
cents to extract.

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
