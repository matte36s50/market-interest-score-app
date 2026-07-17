# MII & MAI — Full Review (2026-07-17)

> Scope: audit of the live `mii_results_latest.csv` (S3, fetched 2026-07-17),
> the front-end scoring (`mii-normalize.js` + report pages), the Manufacturer
> Apex Index pipeline (`auction_rating.py`, `mai.py`, `data/*.csv`), a
> literature check against current (2025–26) influence-measurement practice,
> and an assessment of using the MII as the collective-nostalgia term in the
> Networked Utility Dividend. Written ahead of the BMW presentation.

## Verdict in one paragraph

The MII report is *not* wrong in its math — `mii-normalize.js` is sound — but
**three of its eight inputs are dead or fake in the live data**, so the score
the report shows is really a four-signal auction index (price, bids, views,
comments = 65% of weight) plus a **static brand badge disguised as "Google
Trends"** (15%) plus 15% of weight that contributes zero to every car (Social
5% + YouTube 10%, both entirely empty). Separately, the **MAI is empty end to
end**: all 240 imported lots have blank estimates, so zero lots qualify as
"apex" and `mai_scores.csv` has no rows. The underlying *designs* (the social
composite spec, the MAI v2 prestige-network plan) hold up well against current
research — the gap is between the design documents and what the pipelines
actually produce. Fixable, and worth continuing — but not presentable to BMW
in its current data state.

---

## 1. Live data audit — `mii_results_latest.csv`

7,941 rows · 3,089 models · quarters 2025Q2–2026Q3.

| Input (weight) | Live status |
|---|---|
| `price` (0.20) | ✅ Real. 100% populated, 4,645 distinct values. |
| `bids` (0.20) | ✅ Real. 100% populated. |
| `views` (0.15) | ✅ Real. 100% populated. |
| `comments` (0.10) | ✅ Real. 100% populated. |
| `google_trends_interest` (0.15) | ⚠️ **Fake.** `google_trends_source = "estimate"` on **all 7,941 rows**. Only **15 distinct values** exist; 247 of 262 manufacturers are pinned to the default `30`; **zero models vary across quarters**. This is a hand-set brand lookup, not Trends data. |
| `youtube_total_views` (0.10) | ❌ **Empty.** 100% blank; `youtube_source = "missing"` on every row. |
| `social_score` (0.05) | ❌ **Empty.** 100% blank. The redesigned sub-signal columns (`social_mentions`, `social_engagement_rate`, `social_sov`, `social_video_views`, `social_video_uploads`, `social_sentiment`) now exist in the schema but **none is populated on any row**. |
| `age` (0.05) | ✅ Real. |

### What this does to the score

- Social and YouTube contribute **exactly 0 to every car** (`mii-normalize.js`
  sets the normalized value to 0 when a column has no data), so the **maximum
  achievable MII is 85, not 100**, and 15% of the advertised formula is inert.
  The "Social" and "YouTube" axes on the Model Comparison radar are flat zero
  for every model — this is the visible artifact behind "the report is not
  working correctly based on the social scores."
- The Google Trends estimate column, after percentile ranking, is worth
  **3.5 points** (default brands at 30) up to **14.8 points** (Porsche at 90)
  — an **~11-point permanent brand bonus** identical for every model of a
  brand and every quarter. BMW models carry either 65 (→13.1 pts) or 80
  (→14.5 pts). It never moves, so it adds brand-prestige prior, not market
  interest.
- Note vs. the 2026-07-10 diagnosis: the dataset shrank from ~13,700 rows /
  3,295 models to 7,941 rows / 3,089 models, and history now starts at 2025Q2.
  The old 19-static-value `social_score` was **removed rather than replaced**
  — the degenerate value is gone, but nothing measured took its place.
  Upstream (`car-scrapers`) changed its output without the publish-gate
  validation from the implementation plan (A3); that gate was specced
  precisely to catch a change like this, and the front-end degeneracy badge
  from the same plan was also never implemented.

## 2. Front-end code review

`mii-normalize.js` — the mid-rank percentile ranker is correctly implemented
(ties handled fairly, median ≈ 0.5, safe to re-run, binary-search lookups).
Weights sum to 1.0 and match the README and both report pages. Two design
gaps, both invisible until an input dies:

1. **No weight renormalization.** When an input has no data anywhere, its
   weight is silently forfeited instead of being redistributed over the live
   inputs — hence the 85-point ceiling. The methodology doc (§5) already
   prescribes the right behavior ("drop it and renormalize the remaining
   weights — never impute"); the front-end just doesn't do it.
2. **No data-quality surfacing.** A cheap distinct-count check
   (`MII.dataQuality`) would have flagged both the old static social column
   and today's empty one, and would flag the "estimate"-sourced Trends column.
   Planned in the implementation plan (A3 phase 1), never built.

Minor: rows missing a value on an otherwise-populated input get rank 0 (a
penalty) rather than being excluded from that input's weighted sum; and the
Model Comparison similarity distance includes the two dead dimensions
(harmless today — every model ties at 0 — but it dilutes the distance).

## 3. MAI review

### 3.1 Why it's empty (bug, root cause found)

`data/auction_lots.csv` has 240 lots across three events (RM Woodcote Park,
Gooding Amelia Island 2026, Broad Arrow Villa d'Este) — and **all 240 rows
have blank `low_estimate_usd` and `high_estimate_usd`**. The lots came in
through the Claude results importer, which reads *results* pages/PDFs; results
publications lead with hammer prices, and the importer never populated the
estimate fields. Since apex is defined as `low_estimate_usd ≥ $500K`, zero
lots qualify, `auction_ratings.csv` is all zeros, and `mai_scores.csv` is
header-only — even though the data plainly contains apex-grade sales (e.g. a
1990 BMW M3 Sport Evolution at $513K, and Villa d'Este/Amelia lots well above
that). Fixes, in order of preference:

1. Make the importer extract estimates when the source shows them (RM/Gooding
   results pages usually do), and flag lots missing estimates for review.
2. Add a fallback apex definition when estimates are absent:
   `sold_price_usd ≥ $500K` (with unsold+no-estimate lots excluded rather
   than silently non-apex).
3. Backfill estimates for the three events already imported.

### 3.2 Methodology critique of MAI v1 (P×Q×R)

The framing — manufacturer standing measured by presence and performance at
apex events, as the D (network-density) term — is genuinely well grounded in
Fraiberger et al., *Quantifying reputation and success in art* (Science, 2018):
prestige is a network position certified by *where* you are shown. But v1 has
four issues to fix before leaning on the numbers:

1. **P penalizes the wrong thing.** P = share of apex lots *at that event*, so
   2-of-40 apex lots at Monterey scores far below 1-of-2 at a minor sale —
   the opposite of the prestige logic. The event-tier multiplier in the v2
   plan is the right correction; until then P mostly measures event size, not
   manufacturer standing.
2. **Multiplicative P×Q×R is brutal at small N.** One unsold apex lot ⇒ R=0 ⇒
   the entire event contribution is 0, indistinguishable from not showing up.
   With single-lot manufacturers this makes the index an on/off switch.
   Consider `P × (α·Q + (1−α)·R)` or shrinkage toward the field mean until a
   manufacturer has, say, 5+ apex lots — and show a confidence tier like the
   MII already does.
3. **Min-max event ratings zero out the weakest event.** `auction_rating.py`
   min-max scales across events, so the lowest-rated event gets rating 0 —
   and since MAI weights events *by* rating, that event is **entirely erased**
   from every manufacturer's score. With only a handful of events this is a
   large distortion. Use the raw composite (or add a floor) instead of
   min-max.
4. **Q is house-endogenous and unbounded.** Sold/high-estimate is a good
   realization signal, but houses set estimates strategically (and "estimate
   on request" lots would break it); winsorize Q (e.g. cap at 2.0) and note
   the caveat.

### 3.3 Is this "the best way to measure brand influence, period"?

No single index is, and it's better to claim less: MAI measures **standing in
the collector-market prestige network**, which is one pillar of brand
influence. That claim is defensible and literature-backed. The v2 plan
(ApexAuction 0.50 + RacingPedigree 0.25 + Concours 0.15 + Attention 0.10)
matches how the art-market literature decomposes reputation (venue prestige +
certification events + retrospectives + attention) and is the version worth
presenting. Current marketing-science practice adds one idea worth borrowing:
**Excess Share of Voice** (share of conversation minus share of market) as the
standard leading indicator of future share growth — a natural "Attention"
refinement once the social pipeline is real, and a compelling story for an
OEM audience (heritage attention as a leading indicator).

## 4. Research check — is the social approach current best practice?

Yes — the *spec* in `docs/social-score-methodology.md` (measured, time-varying
composite: mention volume, engagement rate normalized by reach, share of voice
vs. the competitive set, new-content supply, sentiment weighting) is exactly
how 2025–26 practice defines a credible social signal (Sprout Social,
Brandwatch, Brand24 2026 guides), and its percentile-rank blend matches the
rest of the MII. Two refinements from the current literature:

- **Quality over volume**: weight mentions by source authority/engagement
  rather than counting them flat (AMEC/Barcelona-Principles direction —
  outcomes over outputs).
- **Report SOV and Excess SOV explicitly** rather than only folding them into
  the composite — ESOV is the number strategy audiences recognize.

The problem is purely that **none of it has been implemented**: the schema
landed upstream, the collectors did not.

## 5. MII as the collective-nostalgia substitute in the Utility equation

Target: `U = (Fun × Exp) + Nostalgia + (CulturalSalience × N^α × D) × (1/Survivorship)`,
with MAI as the D proxy and MII proposed as the Nostalgia term.

- **Supported in principle.** Hedonic-price research on classic cars (e.g.
  *The structure of automotive nostalgia*, J. Economic & Administrative
  Sciences, 2021) treats collector-market outcomes as measurable expressions
  of automotive nostalgia, and collective-nostalgia research consistently
  links nostalgia to willingness to pay. An auction-attention index is a
  legitimate operationalization — likely the best continuously-measurable one
  available.
- **One circularity to avoid.** The MII is 20% sale price. If U (or R&D
  demand derived from it) is meant to *explain or predict* value, feeding
  price back in as the nostalgia input makes the model partly self-proving —
  the first objection a quant-literate BMW audience will raise. Recommended:
  define a **nostalgia-facing MII variant** for the U equation that uses only
  the demand-side attention signals (bids, views, comments, real Trends,
  YouTube, social) and excludes price. Same ranker, one different component
  list — a ~10-line variant in `mii-normalize.js`. The full MII stays as the
  headline market-interest score; the price-free variant feeds U.
- **Age is an asset here.** The classic nostalgia finding is a ~25–35-year
  cohort effect (people collect the cars of their adolescence). The MII
  already carries `age`/`decade`; a cohort-curve term (peak weight at ~30
  years) would make the nostalgia claim sharper and is cheap to add.

## 6. Can this be presented to BMW? — go/no-go list

Not yet, in this data state: the radar shows Social = 0 for every car, 15% of
the score is inert, "Google Trends" is hand-set estimates, and the MAI chart
is empty. None of these are design flaws — they are pipeline gaps — but any
diligent audience will find them in minutes. Priority order to get
presentation-ready:

1. **This repo (quick, unblocks the demo):**
   a. Renormalize MII weights over inputs that actually have data (removes
      the 85-point ceiling and the dead-axis artifact);
   b. hide or badge axes whose input is empty/degenerate (`MII.dataQuality`);
   c. label the Trends axis "Brand interest (estimate)" until real Trends data
      exists — or drop it from the composite via the same renormalization.
2. **MAI (small fixes, big payoff):** importer estimate extraction + sold-price
   apex fallback + backfill three events; drop min-max in `auction_rating.py`;
   soften P×Q×R per §3.2. The chart then populates from data already in the
   repo.
3. **Upstream `car-scrapers`:** implement the social collectors (the schema is
   already waiting), fix/ship the YouTube collector, wire real Google Trends,
   and add the write-then-promote publish gate so a half-empty CSV can never
   silently replace a good one again (this review is the proof that A3 was
   needed).
4. **For the deck:** present MII today as a *live auction-demand index* (the
   four real signals are genuinely strong: 100% coverage, thousands of
   distinct values, true model×quarter grain), present the social/Trends/
   YouTube axes and MAI v2 as the roadmap, and use the price-free variant for
   the Utility-equation story.

## Sources

- Fraiberger, Sinatra, Resch, Riedl, Barabási — *Quantifying reputation and
  success in art*, Science 362(6416), 2018.
  https://www.science.org/doi/10.1126/science.aau7224
- *The structure of automotive nostalgia: a hedonic price analysis of classic
  car model value formation*, Journal of Economic and Administrative Sciences
  39(1), 2021. https://www.emerald.com/jeas/article/39/1/134/203548
- Research on drivers of collective nostalgia and brand consciousness (2022).
  https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9779318/
- Brandwatch — *What Is Share of Voice? (2026)*.
  https://www.brandwatch.com/blog/share-of-voice/
- Brand24 — *Share of Voice: Definition, Calculation, Tools (2026)*.
  https://brand24.com/blog/how-to-measure-the-share-of-voice/
- Sprout Social — *Share of Voice*. https://sproutsocial.com/insights/share-of-voice/
- Earned-media / PR measurement benchmarks incl. AMEC Barcelona Principles
  adoption. https://www.shno.co/marketing-statistics/media-coverage-impact-statistics
- Prior internal docs: `docs/social-score-methodology.md`,
  `docs/implementation-plan-social-cnb-admin-mai.md`
