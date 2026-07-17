// Shared MII normalization + scoring.
//
// The upstream pipeline that produces mii_results_latest.csv normalizes each
// MII input with MIN-MAX scaling (value / dataset-max). On the heavily
// right-skewed auction data that crushes almost every car toward 0 — the typical
// car's normalized price is ~0.01 — so scores pile up in the 20s/30s and the
// published 0-100 scale is never realised.
//
// This module replaces that with PERCENTILE-RANK normalization, computed in the
// browser from the raw columns. A car's value on each input becomes its rank
// within the whole dataset (0 = lowest, 1 = highest, ~0.5 = median), so models
// spread across the full 0-100 range and the score answers "how does this car
// rank versus the field" rather than "what fraction of the single priciest car".
//
// Every page calls MII.recompute(rows) right after parsing the CSV, so the
// classic and HAGI pages always agree on a car's score.

(function (global) {
    'use strict';

    // Canonical MII formula: raw source column, the normalized column it writes,
    // the weight in the composite, and a display label. Weights sum to 1.0, so
    // mii_score = 100 * Σ(weight × percentileRank) lands in [0, 100].
    var COMPONENTS = [
        { raw: 'price',                  norm: 'price_normalized',                  weight: 0.20, label: 'Sale Price' },
        { raw: 'bids',                   norm: 'bids_normalized',                   weight: 0.20, label: 'Bid Activity' },
        { raw: 'views',                  norm: 'views_normalized',                  weight: 0.15, label: 'View Count' },
        { raw: 'comments',               norm: 'comments_normalized',               weight: 0.10, label: 'Comments' },
        { raw: 'social_score',           norm: 'social_score_normalized',           weight: 0.05, label: 'Social' },
        { raw: 'age',                    norm: 'age_normalized',                    weight: 0.05, label: 'Vehicle Age' },
        { raw: 'google_trends_interest', norm: 'google_trends_interest_normalized', weight: 0.15, label: 'Google Trends' },
        { raw: 'youtube_total_views',    norm: 'youtube_total_views_normalized',    weight: 0.10, label: 'YouTube' },
    ];

    // Build a percentile-rank lookup over a list of numbers. The returned
    // function maps a value to its mid-rank percentile in [0,1]:
    //   (countBelow + countEqual/2) / N
    // Mid-rank keeps ties fair (every car at the same price gets the same rank)
    // and puts the median at ~0.5.
    function percentileRanker(values) {
        var sorted = values.slice().sort(function (a, b) { return a - b; });
        var n = sorted.length;
        return function (x) {
            if (!n) return 0;
            // first index with sorted[i] >= x  → count strictly below
            var lo = 0, hi = n, mid;
            while (lo < hi) { mid = (lo + hi) >> 1; if (sorted[mid] < x) lo = mid + 1; else hi = mid; }
            var below = lo;
            // first index with sorted[i] > x   → count <= x
            lo = 0; hi = n;
            while (lo < hi) { mid = (lo + hi) >> 1; if (sorted[mid] <= x) lo = mid + 1; else hi = mid; }
            var equal = lo - below;
            return (below + equal / 2) / n;
        };
    }

    // Data-quality assessment of the most recent recompute(). Keyed by the raw
    // column name; status is one of:
    //   'ok'     — populated with a healthy spread of values
    //   'empty'  — no usable values anywhere (weight is redistributed)
    //   'static' — populated but with so few distinct values it behaves like a
    //              lookup table, not a measurement (e.g. a per-brand constant)
    var dataQuality = {};
    var STATIC_DISTINCT_THRESHOLD = 50;

    // Overwrite each *_normalized column with a percentile rank and recompute
    // mii_score. Reads only the raw columns, so it is safe to call more than once
    // on the same rows. Mutates rows in place and returns them.
    //
    // Inputs with no data anywhere are dropped and the remaining weights are
    // renormalized (per docs/social-score-methodology.md §5) — a uniform,
    // rank-preserving rescale that keeps the score on a true 0-100 scale instead
    // of capping at (1 - deadWeight) × 100.
    function recompute(rows) {
        if (!Array.isArray(rows) || !rows.length) return rows;

        dataQuality = {};
        var liveWeight = 0;

        COMPONENTS.forEach(function (c) {
            var vals = [];
            var distinct = {};
            var distinctCount = 0;
            for (var i = 0; i < rows.length; i++) {
                var v = parseFloat(rows[i][c.raw]);
                if (!isNaN(v)) {
                    vals.push(v);
                    if (!distinct[v]) { distinct[v] = 1; distinctCount++; }
                }
            }
            dataQuality[c.raw] = {
                label: c.label,
                coverage: vals.length / rows.length,
                distinct: distinctCount,
                status: !vals.length ? 'empty'
                    : distinctCount < STATIC_DISTINCT_THRESHOLD ? 'static'
                    : 'ok',
            };
            if (!vals.length) {
                rows.forEach(function (r) { r[c.norm] = 0; });
                return;
            }
            liveWeight += c.weight;
            var rank = percentileRanker(vals);
            rows.forEach(function (r) {
                var v = parseFloat(r[c.raw]);
                r[c.norm] = isNaN(v) ? 0 : +rank(v).toFixed(6);
            });
        });

        rows.forEach(function (r) {
            var s = 0;
            COMPONENTS.forEach(function (c) {
                if (dataQuality[c.raw].status === 'empty') return;
                var v = parseFloat(r[c.norm]);
                if (!isNaN(v)) s += c.weight * v;
            });
            r.mii_score = liveWeight > 0 ? +(s / liveWeight * 100).toFixed(2) : 0;
        });

        return rows;
    }

    global.MII = {
        COMPONENTS: COMPONENTS,
        recompute: recompute,
        percentileRanker: percentileRanker,
        // Live view of the last recompute's per-input health.
        get dataQuality() { return dataQuality; },
    };
})(typeof window !== 'undefined' ? window : this);
