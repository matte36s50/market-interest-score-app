# MII — Index Defensibility Review (2026-09-17)

> Scope: is the Market Interest Index defensible as a published index — something
> a third party could reasonably follow, cite and continue to invest in? Written
> against the live `mii_results_latest.csv` (15,714 rows, 3,398 models, 2025-06 →
> 2026-09, fetched 2026-09-17), the collected signal files in `data/`, and the
> front-end scoring in `mii-normalize.js`.
>
> Successor to [`mii-mai-review-2026-07.md`](mii-mai-review-2026-07.md), which
> audited *whether the inputs were alive*. Most of what that review flagged has
> since been fixed: weight renormalization, `MII.dataQuality`, a real Trends
> collector, a measured social composite, and a return to monthly grain. This
> review asks the next question — *given the inputs are alive, is the index any
> good?* — and answers it with tests rather than assertion.

## Verdict

**Defensible, and worth continuing, as a measure of relative collector attention
within Bring a Trailer.** Four independent tests support that, and they are the
answer to most of the challenges an index like this attracts.

**Not defensible as a leading indicator of price.** The data does not support it,
and the claim should not be made.

Three structural issues sit between "a good internal tool" and "an index others
can rely on." None is fatal; all are fixable; they are listed in §3 in priority
order.

---

## 1. The evidence that it works

### 1.1 It separates cars the way a knowledgeable person would — without being told to

Grouping models by a category assigned *by hand, not by the index*:

| Group | Mean MII | Models |
|---|---|---|
| Halo / homologation | **75.8** | E30 M3 80, Z8 73, M1 63, F40 87 |
| Enthusiast core | **67.1** | E46 M3 67, E36 M3 62, 911 Carrera 3.2 76, E39 M5 68, 190E 16V 62 |
| Ordinary used | **41.0** | E46 330i 42, E90 330i 35, X5 53, 1-Series 34, F30 40 |

A ~35-point separation between halo cars and ordinary used cars, with the
enthusiast tier landing cleanly between them. This is construct validity: the
index reproduces an ordering that domain experts already agree on, which is the
first thing a sceptic will test it against.

### 1.2 It measures something stable, not month-to-month noise

Autocorrelation of a model's MII with its own later values (models with ≥4 lots
in both months):

| Lag | r | n |
|---|---|---|
| +1 month | **0.805** | 1,854 |
| +2 months | 0.782 | 1,548 |
| +3 months | 0.764 | 1,433 |
| +6 months | **0.735** | 919 |

A score that still explains 54% of the variance in its own value six months later
is measuring a durable property of the car. A noise generator would decay to zero.

### 1.3 The weights are not load-bearing

The standard attack on any composite index is "you chose those weights to get the
answer you wanted." Re-scoring the entire dataset under alternative weightings and
comparing the resulting **rankings** (Spearman ρ against the published score):

| Alternative weighting | ρ | mean abs. change |
|---|---|---|
| Equal weights (all 1/8) | **0.953** | 4.6 pts |
| Auction inputs only (price/bids/views/comments) | 0.964 | 5.6 pts |
| Drop Google Trends entirely | 0.973 | 3.3 pts |
| Double Trends (0.15 → 0.30) | 0.979 | 2.4 pts |
| Halve Price (0.20 → 0.10) | 0.989 | 2.1 pts |
| Drop Age | 0.996 | 1.8 pts |

Every perturbation leaves the ranking ≥0.95 correlated with the published one.
The ordering is a property of the data, not of the weight choices. **This is the
single strongest defensibility result in this review** and it should be quoted
whenever the weights are challenged.

The same result read the other way is a caveat, stated honestly in §2.2: because
the ranking barely moves, the newer signals are not yet doing much work.

### 1.4 Published history does not silently rewrite itself

Percentile ranks are computed across the whole dataset on every page load, so a
score could in principle change as unrelated cars are added. Re-scoring the
dataset as it stood at four past cutoffs and comparing those same model-months
to today's values:

| Scored as of | Rows then | Median abs. revision | Max | Share moving >2 pts |
|---|---|---|---|---|
| 2025-12 | 6,271 | 0.32 pt | 1.84 | 0.0% |
| 2026-03 | 8,926 | 1.11 pt | 2.13 | 0.2% |
| 2026-06 | 12,435 | 0.36 pt | 0.76 | 0.0% |
| 2026-08 | 14,843 | 0.04 pt | 0.18 | 0.0% |

A number published last quarter is still within ~1 point today. The percentile
base is large enough that new data cannot meaningfully restate history. (This
tests adding *time*. It does **not** cover a change to the *universe* — see §3.1.)

### 1.5 The inputs are not eight names for one thing

Pearson r between normalized inputs, on rows where both are present:

|  | Price | Bids | Views | Comments | Social | Age | Trends |
|---|---|---|---|---|---|---|---|
| **Price** | – | 0.45 | 0.61 | 0.47 | 0.04 | −0.23 | −0.09 |
| **Bids** | | – | 0.36 | 0.37 | 0.06 | −0.10 | −0.00 |
| **Views** | | | – | **0.69** | 0.05 | 0.10 | −0.04 |
| **Comments** | | | | – | 0.01 | 0.09 | −0.02 |
| **Social** | | | | | – | −0.14 | 0.27 |
| **Age** | | | | | | – | −0.16 |

Three clusters, not one factor: on-platform auction behaviour (price/bids/views/
comments, r ≈ 0.36–0.69), off-platform attention (Trends/Social/YouTube, r ≈
0.27–0.54), and vehicle age, which is near-orthogonal to everything.

**Google Trends is essentially uncorrelated with every auction input (−0.09 to
0.00).** It is contributing genuinely independent information rather than
re-stating the auction result — which is the justification for collecting it.

The one real redundancy is **views ↔ comments at 0.69**. Both measure attention
to a listing, and they hold 25% of nominal weight between them.

### 1.6 Every number is auditable to the individual lot

The lot-level drill-down resolves any monthly figure to the specific Bring a
Trailer listings behind it, with URLs, dates, bid and comment counts. An index
whose every point can be traced to source records is a materially different
proposition from one that publishes a number and asks to be believed.

---

## 2. The limits — state these before someone else finds them

### 2.1 It does not lead price, and must not be sold as if it does

The obvious commercial claim — "attention today predicts prices tomorrow" — does
not survive testing. Regressing next months' price change on this month's
*engagement only* (bids, views, comments, search; price deliberately excluded):

| Requirement | Lag | Raw r | Partial r, controlling for today's price |
|---|---|---|---|
| ≥4 lots both months | +1 | −0.261 | **+0.016** |
| ≥4 lots both months | +3 | −0.289 | **−0.011** |
| ≥8 lots both months | +1 | −0.317 | **−0.037** |
| ≥15 lots both months | +1 | −0.158 | **+0.025** |
| ≥15 lots both months | +3 | −0.360 | **−0.041** |

The raw correlation looks strongly negative, but that is an artifact: a month's
mean price mean-reverts hard (r = −0.69 between price level and next month's
change, because one expensive car lifts a month and the next falls back), and
attention correlates with price at ~0.39, so it inherits the reversion. Once
today's price is partialled out, **the correlation is indistinguishable from zero
at every lag and every sample threshold.**

The correct framing: the MII measures attention *concurrently*. It is a
description of the present, not a forecast. That is still a useful thing — it is
what most sentiment and attention indices actually are — but the predictive claim
is unsupported and would not survive scrutiny.

#### Re-tested at weekly resolution, and it still holds

The obvious objection to the above is grain. Da, Engelberg and Gao (*In Search
of Attention*, Journal of Finance 2011) — the paper that established search
volume as a direct attention measure and the citation that justifies the Trends
input — find attention leads price over roughly **two weeks**, with reversal
inside a year. A monthly series cannot see a two-week effect.

So the test was rebuilt from lot-level `bat.csv` at weekly grain: 59,122 lots,
4,254 models, 65 weeks, engagement composited from bids, views and comments with
price again excluded.

| Lag | ≥3 lots/wk, partial r | ≥5 lots/wk, partial r |
|-----|----------------------|----------------------|
| +1 week | +0.011 | −0.014 |
| +2 weeks | +0.013 | −0.012 |
| +3 weeks | +0.000 | +0.020 |
| +4 weeks | +0.011 | +0.035 |
| +6 weeks | −0.001 | −0.077 |
| +8 weeks | +0.010 | −0.069 |

Every raw correlation is around −0.2, and every partial correlation, controlling
for today's price, sits within ±0.08 of zero — most within ±0.02. **The null
result is not an artifact of monthly grain.** Testing the specific horizon the
literature points to and still finding nothing is a stronger statement than the
monthly test alone, and it is the version to give anyone who raises the paper.

One boundary worth stating precisely. What was tested is **on-platform
engagement** — bids, views and comments on the Bring a Trailer listing itself.
Da, Engelberg and Gao measure **search** volume, which is off-platform and
arguably prior to it. The MII's own analogue is the Google Trends input, and it
could not be included here because `data/google_trends.csv` stores monthly
values. So the accurate claim is: *on-platform engagement does not lead price at
any horizon between one week and two months.* Whether **search** attention leads
price in this market is still untested at the grain the literature uses, and
collecting Trends weekly for a tracked subset of models is what would settle
it — a concrete, bounded experiment rather than an open question.

### 2.2 The published weights are not the weights in effect

Because a missing input is dropped and the rest renormalized, the *effective*
weight differs from the published one:

| Input | Published | Mean effective | Coverage |
|---|---|---|---|
| Sale Price | 20% | **23.9%** | 100% |
| Bid Activity | 20% | **23.9%** | 100% |
| View Count | 15% | **17.9%** | 100% |
| Comments | 10% | **12.0%** | 100% |
| Google Trends | 15% | **11.2%** | 67.0% |
| YouTube | 10% | **0.1%** | 0.5% |
| Social | 5% | 5.1% | 87.0% |
| Vehicle Age | 5% | 6.0% | 100% |

The live index is **77.7% a Bring a Trailer auction-behaviour index**, not the
65% the formula advertises. YouTube's 10% is a rounding error in practice. Any
published description of the MII should carry the effective column, not just the
nominal one.

### 2.3 Not every row is scored on the same basis

Six distinct input-subsets are in use across the dataset:

| Share | Inputs present |
|---|---|
| 64.2% | 7 inputs (all but YouTube) |
| 22.2% | 6 inputs (no Trends, no YouTube) |
| 10.7% | 5 inputs (no Social, Trends or YouTube) |
| 2.3% | 6 inputs (no Social) |
| 0.5% | all 8 |

Renormalization is the right behaviour — imputing would be worse — but it means
**more than a third of rows are scored on a different input set than the
majority, and all of them are placed on the same 0–100 scale and ranked against
each other.** A car with no Trends coverage is not strictly comparable to one
with it. This is the most serious *conceptual* issue in the index today.

### 2.4 There is a noise floor, and at low volume it is large

Median absolute month-over-month change in MII, bucketed by the smaller of the
two months' auction counts:

| Lots/month | Pairs | Median abs. change | 90th pct |
|---|---|---|---|
| 1 | 7,202 | **10.5 pts** | 27.0 |
| 2 | 2,213 | 8.2 | 21.4 |
| 3–4 | 1,602 | 7.1 | 18.9 |
| 5–7 | 749 | 5.7 | 15.9 |
| 8–14 | 422 | 5.3 | 13.2 |
| 15–29 | 119 | **4.0** | 8.8 |

**A single-lot month moves 10.5 points for no reason at all.** Any narrative
built on a month-to-month move needs to clear this floor. Practical rule: below
~8 lots in a month, read the level, never the change; a move is interpretable
at ~15+ lots when it exceeds ~9 points (the 90th percentile of pure noise).

This belongs in the UI next to every sparkline, not just in a document.

### 2.5 Two of the four collectors produce nothing

| Collector | Rows | Models | Coverage of the 3,398 models in the MII |
|---|---|---|---|
| Google Trends | 30,349 | 2,439 | **71.8%** |
| Social (Wikipedia-led) | 65,816 | 2,760 | **81.2%** |
| YouTube | 78 | 7 | **0.2%** |
| Reddit | 0 | 0 | **0.0%** |

Trends and Social have converged to good coverage. **YouTube has reached seven
models in the entire universe, and Reddit has produced not a single row.** Both
are wired into the formula and documented as live inputs. Until they work, the
honest description of the index has six inputs, not eight.

The social composite is also, in practice, a Wikipedia pageview index: its
Reddit and YouTube-upload sub-signals are empty on every row, so mention volume
and share-of-voice carry the whole score.

### 2.6 Social cannot distinguish generations of the same nameplate

`data/wikipedia_slugs.csv` maps E30 M3, E36 M3, E90/E92/E93 M3, F80 M3 and G80 M3
all to the single `BMW_M3` article, so **their social scores are byte-identical**
(80.98 / 80.12 / 79.62 across Jun–Aug 2026). The E46 M3 is the lone exception,
mapped to `BMW_3_Series_(E46)` — the non-M car — which is why it reads ~9 points
lower. `E36/5 ti Compact` is also mapped to `BMW_M3`, which is simply wrong.

Wikipedia has no per-generation M3 articles, so this is not fixable by re-mapping.
Either the social axis is documented as nameplate-level rather than
generation-level, or generation-level social needs a different source.

### 2.7 The ranking universe is not "collector cars"

The percentile base is everything the upstream scraper emits:

| Class | Share of rows |
|---|---|
| Cars (all categories) | ~89.6% |
| Motorcycles | 9.4% |
| Boats, tractors, ATVs, go-karts, aircraft, RVs | ~1.0% |

Beyond that, the index contains a **manufacturer literally named "Parts And
Automobilia"** — 94 rows across 16 buckets including *Artwork*, *Bicycles*,
*Furniture*, *Gas Pumps & Oil Tanks*, *Kiddie Rides*, *Racing Simulators*,
*Signs* and *Trailers*, each carrying a price, bid count and MII score (17–20).

The numerical effect is small — these sit at the bottom of the distribution — but
"an E46 M3 is ranked against furniture and gas pumps" is not a sentence that
survives a due-diligence meeting. Note that PR #71's parts filter does **not**
fix this: it filters bat.csv-derived counts in the browser, while these rows are
aggregated upstream and arrive pre-built in `mii_results_latest.csv`.

### 2.8 Other standing limits

- **16 months of history** (2025-06 → 2026-09). Too short for seasonality; any
  year-over-year claim rests on a single prior observation.
- **The current month is always incomplete**, and the Trends and Social feeds run
  a month behind, so the newest month is scored on five of eight inputs. The
  `-MTD` label handles the first half of this; the input gap is unlabelled.
- **Known collection gaps** at 2025-09 and 2026-01 (~35% of a normal month each),
  logged in `data/backfill-needed.txt` and still unfilled.
- **No published methodology version.** Scoring has changed materially (min-max →
  percentile rank, renormalization added, confidence thresholds unified) with no
  version stamp on the output, so two people quoting "MII 72" may not mean the
  same thing.

---

## 3. What to fix, in order

1. **Publish an effective-weight table and a version stamp with every release.**
   Cheapest credibility win available. `MII.dataQuality` already computes the
   coverage numbers; nothing new needs measuring. A `methodology_version` column
   in the output makes any quoted score reproducible.
2. **Decide the universe and enforce it.** Exclude `Parts And Automobilia` and
   non-vehicle classes from the percentile base, or publish separate indices per
   class. This needs an upstream fix in the scraper, not a front-end filter.
3. **Surface the noise floor in the UI.** A model's sparkline should not imply
   precision the sample cannot support. The §2.4 table is the rule; the
   confidence badges already carry the sample size needed to apply it.
4. **Either make YouTube and Reddit work, or drop them from the formula.**
   0.2% and 0.0% coverage after months of daily runs suggests the quota budget
   cannot reach 3,398 models — 101 units per model against 10,000/day is a
   ~34-day cycle even at perfect efficiency. Consider scoping YouTube to a
   tracked subset of a few hundred models and documenting it as such.
5. **Address the mixed-input-set comparability problem (§2.3).** Options, in
   increasing order of rigour: flag rows scored on a reduced set; publish a
   "core six" index over inputs with near-full coverage, with the sparse ones as
   a separate overlay; or restrict the headline index to models with complete
   inputs and publish coverage alongside.
6. **Document the social axis as nameplate-level**, or source generation-level
   attention elsewhere.
7. **Backfill 2025-09 and 2026-01.**
8. **Collect Google Trends weekly for a tracked subset**, so the one open
   question in §2.1 — whether *search* attention leads price, as the literature
   finds elsewhere — can actually be tested rather than left unresolved.

---

## 4. The case for continuing

Strip out the fixable defects and what remains is an index that: separates
expert-recognised tiers by ~35 points without being trained to; holds r = 0.74
autocorrelation at six months; produces the same ranking under any reasonable
reweighting including equal weights; restates published history by less than a
point; draws on three genuinely independent signal families rather than one
dressed up as eight; and resolves every figure to named auction lots with URLs.

That is a sound foundation. The work ahead is not rebuilding it — it is
describing it accurately (§3.1), bounding what it covers (§3.2), being honest
about its resolution (§3.3), and finishing or retiring the two collectors that
have not delivered (§3.4).

The one claim to retire outright is prediction. This index describes attention as
it happens, and it does that well enough to be worth following.
