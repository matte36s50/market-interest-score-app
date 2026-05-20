# MII Data Pipelines

Three independent scripts that feed the MII analytical platform.
Each script can be run in isolation; no orchestration layer is required.

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
