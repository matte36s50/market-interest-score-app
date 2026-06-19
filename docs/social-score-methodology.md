# Social Score — Diagnosis & Redesign Methodology

> Status: **proposed.** The composite described here must be implemented in the
> upstream pipeline (`matte36s50/car-scrapers`), which generates
> `mii_results_latest.csv`. This document is the implementation spec; the
> front-end (`market-interest-score-app`) only consumes the resulting column.

## 1. The problem

The MII has eight inputs, seven of which are real, time-varying, and
percentile-ranked across the field (Price, Bids, Views, Comments, Google Trends,
YouTube, Age). The eighth — **Social** (weight 0.05) — is not.

Evidence from the live `mii_results_latest.csv` (13,700 rows / 3,295 models):

- **Only 19 distinct `social_score` values exist** in the entire dataset.
- `social_score` is **constant per model** — every model has exactly one value
  that **never changes over time** (identical every quarter).
- It is effectively a **per-brand constant.** Every BMW M3 generation
  (E30/E36/E46/E90/F80/G80) gets the identical `80.94`; every Porsche 911 variant
  gets `86.94`; every Boxster/Cayman gets `77.18`.
- **256 of 275 manufacturers (93%) are pinned to a single default of `44.14`.**
  Only 19 brands ever receive a non-default value.

Consequence: the "Social" radar axis is a static brand badge. It cannot
distinguish an E30 M3 from an E46 M3, and it carries no temporal signal — which
is exactly the artifact observed in the Model Comparison view.

## 2. What the literature says

Current best practice (Sprout Social, Talkwalker, Brand24, YouScan) treats a
credible social signal as a **composite of measured, time-varying engagement**,
not a static label. The standard building blocks:

- **Engagement rate** — interactions (likes/comments/shares/saves) normalized by
  reach or audience, rather than raw counts.
- **Share of Voice (SOV)** — an entity's share of conversation *relative to its
  competitive set*. This is structurally the same "rank vs. the field" question
  the MII's percentile-rank normalization already answers.
- **Reach / amplification** — distinct from passive views.
- **Sentiment weighting** — positive/neutral vs. negative, so raw volume is not
  rewarded blindly.

The recommended construction is a **weighted, normalized blend** of these
sub-signals — the same percentile-rank composite pattern already used for the
other seven MII inputs in `mii-normalize.js`.

Sources:
- Sprout Social — Social Media Metrics to Track: https://sproutsocial.com/insights/social-media-metrics/
- Sprout Social — Share of Voice: https://sproutsocial.com/insights/share-of-voice/
- Talkwalker — Social Media Metrics: https://www.talkwalker.com/blog/social-media-metrics
- Brand24 — Social Media Metrics: https://brand24.com/blog/6-social-media-metrics-you-should-track/
- YouScan — How to Measure Social Media Engagement: https://youscan.io/blog/how-to-measure-social-media-engagement/

## 3. Proposed composite

Compute a `social_score` **per model × per quarter** as a weighted blend of
percentile-ranked sub-signals:

```
social_score = 100 × Σ_i ( w_i × percentileRank_i(signal_i) )
```

where `percentileRank_i` is the mid-rank percentile of the sub-signal across all
(model × quarter) observations in the dataset — identical to the ranker already
in `mii-normalize.js` so the Social axis behaves like every other input.

### Sub-signals

| Sub-signal       | Definition                                                        | Source(s)                     | Suggested weight |
|------------------|-------------------------------------------------------------------|-------------------------------|------------------|
| Mention volume   | Count of posts/threads referencing the model in the quarter       | Reddit + enthusiast forums    | 0.30 |
| Engagement rate  | Interactions ÷ reach (or ÷ author count) on those mentions        | Reddit + IG/TikTok            | 0.25 |
| Share of Voice   | Model mentions ÷ total mentions within its segment that quarter   | derived from mention volume   | 0.20 |
| Social video     | Count of *new* videos uploaded about the model in the quarter     | YouTube uploads + TikTok      | 0.15 |
| Sentiment        | Share of positive+neutral mentions (NLP pass)                     | NLP over collected mentions   | 0.10 |

Weights are a starting point; tune against face validity once real values land.

### Avoiding double-counting

The MII already counts **YouTube *view* totals**, **BaT *comments***, and
**Google Trends** as separate inputs. The Social composite must therefore use
*distinct* facets:

- Use YouTube **upload count** (supply of new content), **not** view totals.
- Use Reddit/forum/IG mentions, **not** the on-listing BaT comment count.
- SOV and sentiment are net-new dimensions not represented anywhere else.

## 4. Data sources (confirmed in scope)

- **Reddit / enthusiast forums** (r/cars, model-specific subs, Rennlist,
  BimmerForums, etc.) — primary mention-volume and engagement signal.
- **Instagram / TikTok** — hashtag/post counts and engagement (buzz).
- **YouTube uploads** — count of new videos per model per quarter.
- **Sentiment analysis** — NLP pass over collected mentions so volume is
  quality-weighted.

## 5. Implementation plan (`car-scrapers`)

1. Locate where `social_score` is currently written into the MII results
   (likely a hardcoded brand→score lookup table).
2. Add collectors for each sub-signal, keyed on the same
   `manufacturer + model + quarter` grain as the rest of the pipeline. Reuse the
   existing model-name normalization so keys line up with `mii_results`.
3. Persist raw per-quarter sub-signal counts (so the score is reproducible and
   auditable, and so `mii-normalize.js`-style re-ranking can happen downstream).
4. Compute `social_score` per the formula above and write it into
   `mii_results_latest.csv`, replacing the static value.
5. Backfill historical quarters where source data permits; where a sub-signal is
   unavailable for a (model, quarter), drop it from that row's weighted sum and
   renormalize the remaining weights (do **not** impute the brand default).

## 6. Output schema / backward compatibility

- The output column stays `social_score` (0–100), so the front-end and
  `mii-normalize.js` need **no changes** — `recompute()` will percentile-rank the
  new, varying values automatically.
- Recommended: also emit the raw sub-signal columns (e.g.
  `social_mentions`, `social_engagement_rate`, `social_sov`,
  `social_video_uploads`, `social_sentiment`) for transparency and debugging.

## 7. Validation / QA

After implementation, confirm the artifact is gone:

- `social_score` should have **hundreds+** of distinct values, not 19.
- It should **vary across quarters** for the same model.
- It should **differ between generations** of the same nameplate (e.g. E30 vs.
  E36 vs. E46 M3 should no longer be identical).
- Spot-check against intuition: cars with active enthusiast communities should
  rank above obscure models that currently share the `44.14` default.
