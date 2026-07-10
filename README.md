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

### Normalization (percentile rank)

Each input is converted to a **percentile rank** across the whole dataset before
weighting: 0 = lowest, 1 = highest, ~0.5 = the median car. This is done in the
browser by `mii-normalize.js`, which every page calls right after loading the
CSV, so the classic and HAGI pages always agree on a car's score.

Percentile ranking replaces the older min-max scaling (value ÷ dataset-max).
Auction prices, views, and comments are extremely right-skewed — a handful of
seven-figure cars and a long tail of affordable ones — so min-max scaling pushed
the typical car's normalized value toward zero and crushed nearly every score
into the 20s–30s. Percentile rank spreads models across the full 0–100 range and
makes the score answer "how does this car rank versus the field" rather than
"what fraction of the single priciest car's value did it reach".

## Confidence Levels

- **High** (●): 50+ auctions
- **Medium-High** (◐): 20-49 auctions
- **Medium** (◐): 10-19 auctions
- **Low** (○): 5-9 auctions

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
house's results page (or PDF / press release), paste it in, and press
**Extract lots**. The page calls the Claude API directly from the browser
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
