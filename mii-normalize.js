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

    // ---- Measured social signals (data/social_signals.csv) -----------------
    // Produced by data/pipelines/social_signals.py: per-model, per-month
    // Wikipedia attention + share of voice, blended into a 0-100 composite.
    // When the file is present, recompute() joins it into each row's raw
    // social_score before ranking, so the Social axis carries real,
    // time-varying values. When absent, the weight renormalization below
    // keeps the score correct without it.
    var socialSignals = null; // "manufacturer|model" -> { "YYYY-MM": score }

    function parseCsvLine(line) {
        var out = [], cur = '', inQ = false;
        for (var i = 0; i < line.length; i++) {
            var ch = line[i];
            if (inQ) {
                if (ch === '"') {
                    if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
                } else cur += ch;
            } else if (ch === '"') inQ = true;
            else if (ch === ',') { out.push(cur); cur = ''; }
            else cur += ch;
        }
        out.push(cur);
        return out;
    }

    function indexSignals(text) {
        var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
        if (lines.length < 2) return null;
        var hdr = parseCsvLine(lines[0]);
        var iMan = hdr.indexOf('manufacturer'), iMod = hdr.indexOf('model'),
            iMonth = hdr.indexOf('month'), iScore = hdr.indexOf('social_score');
        if (iMan < 0 || iMod < 0 || iMonth < 0 || iScore < 0) return null;
        var out = {};
        for (var i = 1; i < lines.length; i++) {
            var c = parseCsvLine(lines[i]);
            var score = parseFloat(c[iScore]);
            if (isNaN(score)) continue;
            var key = (c[iMan] || '').trim() + '|' + (c[iMod] || '').trim();
            (out[key] = out[key] || {})[(c[iMonth] || '').trim()] = score;
        }
        return out;
    }

    // Months covered by a period label: monthly "2025-05" → itself,
    // quarterly "2025Q2" → its three months.
    function periodMonths(p) {
        if (/^\d{4}-\d{2}$/.test(p)) return [p];
        var q = /^(\d{4})Q([1-4])$/.exec(p);
        if (!q) return [];
        var first = (parseInt(q[2], 10) - 1) * 3 + 1;
        return [0, 1, 2].map(function (k) {
            var mm = first + k;
            return q[1] + '-' + (mm < 10 ? '0' + mm : mm);
        });
    }

    // Fill each row's raw social_score from the signals table (average of the
    // months the row's period covers). Idempotent.
    function joinSocial(rows) {
        if (!socialSignals) return;
        rows.forEach(function (r) {
            var key = (r.manufacturer || '').trim() + '|' + (r.model || '').trim();
            var byMonth = socialSignals[key];
            if (!byMonth) return;
            var sum = 0, n = 0;
            periodMonths(String(r.quarter || '').trim()).forEach(function (mo) {
                if (byMonth[mo] != null) { sum += byMonth[mo]; n++; }
            });
            if (n) r.social_score = sum / n;
        });
    }

    // Kick off the signals fetch at script load; pages should `await MII.ready`
    // before recompute() so the join lands on first render. The timeout means a
    // missing/slow file can never block a page.
    var readyResolve;
    var ready = new Promise(function (res) { readyResolve = res; });
    if (typeof fetch === 'function' && typeof window !== 'undefined') {
        var guard = setTimeout(readyResolve, 4000);
        fetch(global.MII_SOCIAL_SIGNALS_URL || 'data/social_signals.csv')
            .then(function (r) { return r.ok ? r.text() : null; })
            .then(function (t) { if (t) socialSignals = indexSignals(t); })
            .catch(function () {})
            .then(function () { clearTimeout(guard); readyResolve(); });
    } else {
        readyResolve();
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
    // Inputs a row has no value for are dropped from that row's blend and the
    // remaining weights renormalized (docs/social-score-methodology.md §5) — so
    // a dataset-wide dead column no longer caps every score below 100, and a
    // model missing one input (e.g. no social signal yet) isn't ranked as if it
    // scored zero on it. The *_normalized column still reads 0 for display.
    function recompute(rows) {
        if (!Array.isArray(rows) || !rows.length) return rows;

        joinSocial(rows);

        dataQuality = {};

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
            var rank = percentileRanker(vals);
            rows.forEach(function (r) {
                var v = parseFloat(r[c.raw]);
                r[c.norm] = isNaN(v) ? 0 : +rank(v).toFixed(6);
            });
        });

        rows.forEach(function (r) {
            var s = 0, w = 0;
            COMPONENTS.forEach(function (c) {
                if (dataQuality[c.raw].status === 'empty') return;
                if (isNaN(parseFloat(r[c.raw]))) return; // row lacks this input
                var v = parseFloat(r[c.norm]);
                if (isNaN(v)) return;
                s += c.weight * v;
                w += c.weight;
            });
            r.mii_score = w > 0 ? +(s / w * 100).toFixed(2) : 0;
        });

        return rows;
    }

    global.MII = {
        COMPONENTS: COMPONENTS,
        recompute: recompute,
        percentileRanker: percentileRanker,
        // Resolves once the social-signals fetch settles (or times out).
        ready: ready,
        // Inject a signals CSV directly (tests / non-browser use).
        setSocialSignals: function (text) { socialSignals = indexSignals(text); },
        // Live view of the last recompute's per-input health.
        get dataQuality() { return dataQuality; },
    };
})(typeof window !== 'undefined' ? window : this);
