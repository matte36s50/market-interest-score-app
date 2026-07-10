# Implementation Plan — Social Signal Reliability, Cars & Bids Scraper, Live-Auction Admin Tab, and Manufacturer Apex Index v2

> Status: **plan, approved scope pending.** Written 2026-07-10.
> Guiding constraint for every workstream: **do not break the live dashboard.**
> All changes are additive (new files, new columns, new pages) or gated behind
> validation so a bad data run can never clobber what already works.

---

## 0. Current architecture (what must keep working)

| Piece | Where | Notes |
|---|---|---|
| Front-end | This repo, static HTML/JS, deployed to **GitHub Pages** on push to `main` (`.github/workflows/deploy.yml`) | No build step, no server. |
| MII data | `mii_results_latest.csv` + `bat.csv` in public S3 bucket `my-mii-reports` (us-east-2) | Produced by the upstream repo **`matte36s50/car-scrapers`**, refreshed ~6 AM / 6 PM UTC. |
| Scoring | `mii-normalize.js` recomputes percentile-rank MII in the browser on every page load | 8 inputs; `social_score` carries weight 0.05. |
| Apex pipelines | `data/pipelines/{sync_from_garage_draft,auction_rating,mai}.py` | Run manually; read/write `data/*.csv` in this repo. |
| MAI display | `index.html` already renders a MAI bar chart from `data/mai_scores.csv` | Currently shows the empty state because `data/auction_lots.csv` has no rows. |
| Manual lot entry | Garage Draft Supabase → `sync_from_garage_draft.py` | Existing path for lots you've already entered elsewhere. |

Two repos are involved. Scraper/pipeline work (Workstreams A and B) lands in
`car-scrapers`; everything else lands here. (A Claude session working on
`car-scrapers` needs that repo added to the session explicitly.)

---

## Workstream A — Reliable social data in the MII reports & dashboard

### A1. The problem (already diagnosed)

`docs/social-score-methodology.md` documents it: `social_score` in
`mii_results_latest.csv` is a **static per-brand constant** — 19 distinct values
across 13,700 rows, 93 % of manufacturers pinned to the default `44.14`, zero
variation across quarters or model generations. The "Social" axis on the radar
and in the composite is a brand badge, not a measurement.

### A2. Upstream fix (in `car-scrapers`) — the real solution

Implement the measured composite already specced in
`docs/social-score-methodology.md` §3–§6:

1. Find where `social_score` is written (likely a hardcoded brand→score table) and replace it.
2. Collect per **model × quarter**: Reddit/forum mention volume, engagement
   rate, share of voice, new-video upload counts, sentiment.
3. `social_score = 100 × Σ(wᵢ × percentileRankᵢ)` — same ranker pattern as
   `mii-normalize.js`.
4. Keep the output column named `social_score` (0–100) → **zero front-end
   changes required**; also emit the raw sub-signal columns
   (`social_mentions`, `social_engagement_rate`, `social_sov`,
   `social_video_uploads`, `social_sentiment`) for auditability.
5. Where a sub-signal is missing for a (model, quarter), drop it and
   renormalize the remaining weights — never impute the brand default.

### A3. Reliability layer (both repos) — so bad data can't reach the dashboard silently

**Publish gate in `car-scrapers` (before S3 upload):**
- Write each run to `mii_results_YYYYMMDD_HHMM.csv` first; promote to
  `mii_results_latest.csv` only after validation passes ("write-then-promote",
  so a crashed run leaves the old `_latest` intact).
- Validation checks: required columns present; row count within ±30 % of the
  previous run; `social_score` has ≥ 100 distinct values **and** varies across
  quarters for at least 50 % of models (this is the exact regression test for
  the current bug); no column entirely NaN.
- On failure: skip the promote, keep serving yesterday's file, alert (GitHub
  Action failure email is enough to start).

**Data-quality surfacing in this repo (front-end, additive):**
- In `mii-normalize.js`, after loading, run a cheap degeneracy check on
  `social_score` (distinct-value count < 50 ⇒ degenerate). Expose it as
  `MII.dataQuality.socialDegenerate`.
- Phase 1 (safe): pages that show the Social axis (Model Comparison radar,
  component percentile plots) render a small "Social: static upstream data"
  warning badge when degenerate. **Scores do not change**, so nothing breaks.
- Phase 2 (optional, after upstream fix ships): a flag to exclude a degenerate
  input from the composite and renormalize the remaining weights. Ship it OFF
  by default; it becomes moot once A2 lands.

### A4. Validation
- QA checklist from `social-score-methodology.md` §7 (distinct values,
  quarter-over-quarter variation, generation-level differences, face validity).
- Confirm the warning badge disappears on its own the first time the fixed CSV
  is published.

---

## Workstream B — Cars & Bids scraper (in `car-scrapers`)

The dashboard's README already promises "Bring a Trailer **and Cars & Bids**"
data; only BaT exists today. Volume is manageable: C&B runs roughly 300–400
auctions/month, so a full backfill is tens of thousands of listings, and the
daily incremental is small.

### B1. Design
- **New output file `cnb.csv` in the same S3 bucket. Do not touch `bat.csv`.**
  Same schema as `bat.csv` (url, title, make, model, year, sale_date,
  sold_price, sold/reserve status, bids, comments, views where available) plus
  a `source` column (`cnb`).
- Cars & Bids is a JS-rendered site; its past-auctions listing is fed by JSON
  endpoints. Approach: headless Chromium (Playwright) or the JSON endpoints
  directly, ~1 request/sec, respectful of robots.txt/ToS, public data only.
  Incremental mode: scrape auctions ended since the last run; one-time backfill
  script for history.
- Reuse the existing model-name normalization from the BaT pipeline so
  `manufacturer + model` keys line up (critical — otherwise C&B rows fork new
  phantom models).
- The MII aggregation step unions `bat.csv + cnb.csv` (tagged by `source`)
  before computing `mii_results_latest.csv`. **Output schema unchanged** →
  front-end untouched.

### B2. Non-breaking rollout
1. Ship scraper; publish `cnb.csv` to S3; **do not merge into MII yet.**
   Sanity-check the file for 1–2 weeks of runs.
2. Merge into the MII aggregation behind the same publish gate as A3 (row-count
   and distinct-value checks catch a malformed merge).
3. Later, optional front-end nicety in this repo: a BaT/C&B source filter and a
   `source` column in the lot drill-down modal (additive UI).

### B3. Sequencing note
Weight-sensitive: adding C&B listings shifts every percentile rank slightly
(more rows in the field). That is expected and correct, but do it as its own
release, not bundled with the social change, so score movements are attributable.

---

## Workstream C — Admin tab for live-auction results (this repo)

Purpose: enter lots from live events (RM Sotheby's, Gooding, Bonhams, Mecum…)
directly, feeding `data/auction_lots.csv` → `auction_rating.py` → `mai.py` →
the MAI chart that `index.html` already renders.

The site is static (GitHub Pages), so "save" needs a backend. Two viable
options; **recommendation: Option 1** (zero new infrastructure, closes the loop
end-to-end automatically).

### Option 1 (recommended): GitHub-backed `admin.html`
- New page `admin.html` + `admin.js`, linked from the header nav.
- Form UX: enter event metadata once (event name, date, auction house), then
  quick-add lot rows (lot #, manufacturer, model, year, low/high estimate, sold
  price, sold toggle, notes). Live "apex" indicator when low estimate ≥ $500K.
  Duplicate warning using the same key as `sync_from_garage_draft.py`
  (event + manufacturer + model + year).
- "Save" appends the rows to `data/auction_lots.csv` via the **GitHub Contents
  API**, authenticated with a **fine-grained PAT** scoped to this single repo,
  `contents: read/write` only, pasted once and kept in `localStorage`. (The
  page is public but useless without a token; the token never enters the repo.)
- New workflow `.github/workflows/data-pipelines.yml`: on push touching
  `data/auction_lots.csv`, run `auction_rating.py` + `mai.py` (pandas), commit
  `data/auction_ratings.csv` + `data/mai_scores.csv`. Pages redeploys and the
  MAI chart populates — no manual pipeline runs ever again.
- Fallback button: "Download CSV" (merged file) for offline entry / manual
  commit if the API is unreachable from the venue.

### Option 2: Supabase-backed form (reuse Garage Draft)
- Same form writing to the Garage Draft Supabase (`auctions` table with an
  `auction_reference`), then the existing `sync_from_garage_draft.py` merges to
  CSV. Better multi-user auth story; but adds a second system, still needs the
  sync + pipeline runs automated, and keeps double-representation of the data.
  Keep as the fallback if you'd rather not hold a PAT on a phone.

### Non-breaking guarantees
- `admin.html`/`admin.js` are new files; the workflow only writes the two
  derived CSVs; `mai.py` already tolerates an empty input, and the MAI panel
  already handles the no-data state. Nothing existing changes behavior.

---

## Workstream D — Manufacturer Apex Index v2 (the "prestige network" upgrade)

### D1. What we already built (v1, recovered from the repo)
- `mai.py`: per manufacturer × event, apex lots only (low estimate ≥ $500K):
  **P** presence share, **Q** price realisation (sold/high-estimate), **R**
  sell-through; `MAI = Σ(auction_rating × P×Q×R) / Σ(auction_rating)`.
- `auction_rating.py`: event-level rating from apex concentration, volume,
  sell-through.
- `index.html`: MAI bar chart + P/Q/R explainer, framed as the **D (network
  density)** term of the Networked Utility Dividend:
  `U = (Fun × Exp) + Nostalgia + (CulturalSalience × N^α × D) × (1/Survivorship)`.
- Blocked only on data — Workstream C unblocks it.

### D2. The scholarly grounding
**Fraiberger, Sinatra, Resch, Riedl & Barabási, "Quantifying reputation and
success in art," *Science* 362(6416), 2018** (Resch lectures at Yale SOM — this
is the paper you remembered). From the exhibition histories of ~500K artists
they built the co-exhibition network of galleries/museums and found:
- Institutional prestige is a **network position**, not just size: a tightly
  connected high-prestige core (MoMA, Guggenheim, Gagosian…) dominates.
- **Early access to the prestige core produces lock-in**: artists who start in
  core institutions get lifelong access to top venues, far lower dropout, and
  systematically higher auction prices. Value is certified by *where* the work
  is shown, largely independent of the work itself.

Related supporting literature (for the write-up, not extra machinery):
provenance/certification premiums in art auctions and Goetzmann's work on art
returns say the same thing — pedigree and institutional endorsement carry
pricing power.

**Mapping to cars.** A manufacturer's "prestige institutions" are:
1. **Apex auction events** (Monterey week, Amelia Island, Scottsdale flagship
   sales, Rétromobile, Villa d'Este) — the galleries. Repeated consignment of a
   marque at these events *is* exhibition in the core.
2. **Racing institutions** (Le Mans overall/class wins, F1 constructors'
   titles, Mille Miglia/Targa Florio) — the biennales. Victory is the
   certification event; the paper's "early access → lock-in" is exactly the
   Ferrari/Porsche/Jaguar story.
3. **Concours & museums** (Pebble Beach Best of Show, Villa d'Este Coppa
   d'Oro, cars in permanent museum collections — MoMA's Cisitalia 202 and
   Jaguar E-Type) — the retrospectives.

### D3. MAI v2 formula

```
MAI_v2 = 0.50 × ApexAuction + 0.25 × RacingPedigree + 0.15 × Concours + 0.10 × Attention
```
Each term percentile-ranked across manufacturers (the same ranker as
`mii-normalize.js`) so terms are commensurable. Weights are a starting point.

| Term | Definition | Data |
|---|---|---|
| **ApexAuction** | v1's rating-weighted P×Q×R, upgraded with an explicit **event-tier multiplier** (the "prestige core"): Tier 1 ×1.0 (Monterey, Amelia, Rétromobile, Villa d'Este, Scottsdale flagships), Tier 2 ×0.6 (majors), Tier 3 ×0.3 (regional) | new `data/event_tiers.csv` (curated, ~30 rows); lots from Workstream C |
| **RacingPedigree** | weighted count: Le Mans overall wins ×3, Le Mans class wins ×1, F1 constructors' titles ×2, Mille Miglia/Targa Florio wins ×1 | new `data/heritage_racing.csv` (curated once, updated annually — it's public record) |
| **Concours** | Pebble Beach Best of Show wins by marque, Villa d'Este Coppa d'Oro, museum permanent collections | new `data/heritage_concours.csv` (curated) |
| **Attention** | trailing-12-month Wikipedia pageviews per marque | existing `wikipedia_pageviews.py` (extend slugs from 10 seed models to marque pages) |

Implementation: extend `mai.py` (keep the P/Q/R core intact); each heritage
file optional — a missing file just zeroes that term and renormalizes weights,
so v2 degrades gracefully to v1. Output `data/mai_scores.csv` gains columns
(`apex_term`, `racing_term`, `concours_term`, `attention_term`, `MAI_v2`);
existing columns keep their names so the current chart keeps working even
before the front-end is touched.

### D4. Dashboard integration (additive)
- Extend the MAI panel: bar = MAI_v2, tooltip shows the four terms; a small
  stacked/segment view of term contributions; explainer cards updated with a
  one-line citation of the Science paper.
- Optional later: MAI badge next to manufacturers in the main leaderboard
  (lookup by name, no change to MII scores).
- **MAI stays a separate index. It is not folded into `mii_score`** — that
  keeps every existing number stable. If we ever want it in MII, that's a
  deliberate, separately-tested weight change.

---

## Sequencing & rough effort

| Phase | What | Where | Effort | Unblocks |
|---|---|---|---|---|
| **1** | Admin tab + `data-pipelines.yml` automation (Workstream C, Option 1) | this repo | ~1 session | MAI chart goes live with real data; you can enter Monterey (Aug) results live |
| **2** | Publish gate / write-then-promote for S3 CSVs (A3 upstream half) + front-end social degeneracy badge (A3 local half) | `car-scrapers` + this repo | ~1 session | Protects everything that follows |
| **3** | Cars & Bids scraper → `cnb.csv` → observe → merge into MII (Workstream B) | `car-scrapers` | 1–2 sessions + observation window | Fulfills the README promise; more rows = better percentiles |
| **4** | Measured social composite (A2) | `car-scrapers` | 2–3 sessions (collectors are the bulk) | Social axis becomes real; badge auto-clears |
| **5** | MAI v2: heritage CSVs + `mai.py` extension + panel upgrade (Workstream D) | this repo | ~1–2 sessions | The Apex/prestige index |

Phase 1 first because it's entirely in this repo, needs no scraping, and turns
already-built-but-dormant machinery (pipelines + MAI chart) on. Phases 3 and 4
are deliberately separate releases so score movements stay attributable.

## Non-breaking checklist (applies to every phase)
- `mii_results_latest.csv` schema: column names/meanings unchanged; only new columns added.
- `bat.csv` never modified by new code paths.
- New pages/files only (`admin.html`, heritage CSVs, workflows); no edits to scoring in `mii-normalize.js` that change numbers by default.
- Publish gate ensures a failed pipeline run leaves the previous good data serving.
- Each phase verified against the live pages (index, HAGI, Model Comparison, Terminal, Data Analysis) before the next starts.

## Sources
- Fraiberger, Sinatra, Resch, Riedl, Barabási — *Quantifying reputation and success in art*, Science 362(6416), 2018: https://www.science.org/doi/10.1126/science.aau7224 (PDF: https://www.magnusresch.com/wp-content/uploads/2018/11/Quantifying-Reputation-and-Success-in-Art-Science-Paper-Magnus-Resch.pdf)
- Magnus Resch, Yale SOM faculty page: https://som.yale.edu/faculty-research/faculty-directory/magnus-resch
- Social composite spec & diagnosis: `docs/social-score-methodology.md` (this repo)
- MAI v1: `data/pipelines/mai.py`, `data/pipelines/auction_rating.py`, MAI panel in `index.html`
