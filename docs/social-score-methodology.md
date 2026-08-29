# Social Score — Diagnosis & Redesign Methodology

> Status: **implemented in this repository.** Upstream
> (`matte36s50/car-scrapers`) never shipped the composite — as of the 2026-08
> pull of `mii_results_latest.csv` it emits the sub-signal columns but leaves
> them blank on 14,801 of 14,807 rows. The collectors in `data/pipelines/`
> therefore measure the sub-signals here and `mii-normalize.js` joins the
> result into the Social input in the browser. §3 below remains the spec; §5
> records what is built and what is still open.

## 1. The problem

The MII has eight inputs. Five are real, time-varying, and percentile-ranked
across the field (Price, Bids, Views, Comments, Age). **Social** (0.05) is not —
it is the subject of this document. Google Trends (0.15) and YouTube (0.10)
turned out to be empty rather than static, and are collected by the sibling
pipelines described in `data/pipelines/README.md`.

Evidence from `mii_results_latest.csv` as of 2026-07 (13,700 rows / 3,295
models). The column has since gone from static to blank — as of the 2026-08
pull it is populated on 6 of 14,807 rows — which is the same failure in a
different costume: an input that carries no information about any car.

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

## 5. Implementation status

Built, in `data/pipelines/`, at the `manufacturer + model + month` grain:

| Sub-signal | Weight | Collector | Column |
|------------|--------|-----------|--------|
| Mention volume | 0.30 | `social_signals.py` (Wikipedia), `reddit_signals.py` | `wiki_pageviews`, `reddit_posts` |
| Engagement rate | 0.25 | `reddit_signals.py` | `reddit_engagement` |
| Share of voice | 0.20 | `social_signals.py` | `wiki_sov` |
| Social video | 0.15 | `youtube_signals.py` | `yt_videos` |
| Sentiment | 0.10 | — | not collected |

Mention volume is measured twice — Wikipedia lookups and Reddit posts are two
readings of "how much is this car being talked about" — so it is scored as the
**mean of the ranks of whichever sources a row has**, rather than split into
two weights. That keeps a Wikipedia-only row on the original 0.30/0.20 → 0.6/0.4
attention/SOV split, so adding Reddit did not silently reweight the rows that
came before it.

Still open:

1. **Sentiment (0.10).** Needs an NLP pass over the collected Reddit titles.
   Its weight renormalizes away until then.
2. **Instagram / TikTok.** Both now require business-tier API access for
   hashtag search; neither has a free path comparable to the others.
3. **Coverage.** Reddit and YouTube fill in on a rolling budget (see
   `data/pipelines/README.md`), so at any moment some models are scored on
   Wikipedia alone. This is correct behaviour under the drop-and-renormalize
   rule, not a gap to be papered over with a default.

Raw sub-signal columns are persisted alongside the score in
`data/social_signals.csv`, so the composite is reproducible and auditable and
can be re-ranked downstream.

## 6. Output schema / backward compatibility

- The output column stays `social_score` (0–100). `mii-normalize.js` joins it
  onto each row before ranking, filling gaps only: if upstream ever ships its
  own measured composite, that value wins and this one steps back.
- Recommended: also emit the raw sub-signal columns (e.g.
  `social_mentions`, `social_engagement_rate`, `social_sov`,
  `social_video_uploads`, `social_sentiment`) for transparency and debugging.

## 7. Validation / QA

The current run reports **9,075 distinct scores across 62,872 rows, with
2,637 of 2,638 models varying over time** — the artifact is gone. Re-check
after any change to the composite:

- `social_score` should have **hundreds+** of distinct values, not 19.
- It should **vary across quarters** for the same model.
- It should **differ between generations** of the same nameplate (e.g. E30 vs.
  E36 vs. E46 M3 should no longer be identical).
- Spot-check against intuition: cars with active enthusiast communities should
  rank above obscure models that currently share the `44.14` default.
