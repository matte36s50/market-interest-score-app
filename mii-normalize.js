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
// It also joins the measured signal files collected by data/pipelines/ —
// social, Google Trends and YouTube — onto the raw columns before ranking,
// because upstream ships those three inputs empty.
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

    // ---- Measured signal files ---------------------------------------------
    // Three MII inputs are collected in this repo rather than upstream,
    // because upstream ships them empty or hand-set:
    //
    //   Social        data/social_signals.csv   Wikipedia attention + share of
    //                                           voice + Reddit + YouTube uploads
    //   Google Trends data/google_trends.csv    anchor-normalized search interest
    //   YouTube       data/youtube_signals.csv  views of videos about the model
    //
    // Each file is per manufacturer x model x MONTH. recompute() joins them
    // onto each row's raw column before ranking, so these axes carry real,
    // time-varying values. When a file is absent the weight renormalization
    // below keeps every score correct without it — nothing is imputed.
    var SIGNALS = [
        {
            name: 'social',
            url: 'data/social_signals.csv',
            column: 'social_score',
            target: 'social_score',
            // A score, not a count: average the months a period covers.
            agg: 'mean',
            // Upstream's own multi-signal composite always wins; this is the
            // fallback for rows it could not measure.
            overrides: function () { return false; },
        },
        {
            name: 'trends',
            url: 'data/google_trends.csv',
            column: 'trends_interest',
            target: 'google_trends_interest',
            agg: 'mean',
            // Upstream sends either nothing (google_trends_source "missing",
            // its state today) or the old hand-set per-brand estimate. A
            // measured value beats both; a genuine upstream measurement wins.
            overrides: function (row) {
                var src = String(row.google_trends_source || '').trim().toLowerCase();
                return src === '' || src === 'missing' || src === 'estimate';
            },
        },
        {
            name: 'youtube',
            url: 'data/youtube_signals.csv',
            column: 'yt_views',
            target: 'youtube_total_views',
            // A flow: a quarter's views are its three months added up.
            agg: 'sum',
            overrides: function (row) {
                var src = String(row.youtube_source || '').trim().toLowerCase();
                return src === '' || src === 'missing';
            },
        },
    ];

    // name -> { "manufacturer|model": { "YYYY-MM": value } }
    var signalTables = {};

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

    // Index one signal CSV on "manufacturer|model" -> month -> numeric value.
    function indexSignal(text, column) {
        var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
        if (lines.length < 2) return null;
        var hdr = parseCsvLine(lines[0]);
        var iMan = hdr.indexOf('manufacturer'), iMod = hdr.indexOf('model'),
            iMonth = hdr.indexOf('month'), iVal = hdr.indexOf(column);
        if (iMan < 0 || iMod < 0 || iMonth < 0 || iVal < 0) return null;
        var out = {};
        for (var i = 1; i < lines.length; i++) {
            var c = parseCsvLine(lines[i]);
            var value = parseFloat(c[iVal]);
            if (isNaN(value)) continue;
            var key = (c[iMan] || '').trim() + '|' + (c[iMod] || '').trim();
            (out[key] = out[key] || {})[(c[iMonth] || '').trim()] = value;
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

    // Fill each row's raw input column from a signal table, aggregating over
    // the months the row's period covers. Fills gaps always; replaces an
    // existing value only when the signal's `overrides` test says upstream's
    // value is a placeholder rather than a measurement. Idempotent.
    function joinSignal(rows, signal) {
        var table = signalTables[signal.name];
        if (!table) return;
        rows.forEach(function (r) {
            var existing = parseFloat(r[signal.target]);
            if (!isNaN(existing) && !signal.overrides(r)) return;
            var byMonth = table[(r.manufacturer || '').trim() + '|' + (r.model || '').trim()];
            if (!byMonth) return;
            var sum = 0, n = 0;
            periodMonths(String(r.quarter || '').trim()).forEach(function (mo) {
                if (byMonth[mo] != null) { sum += byMonth[mo]; n++; }
            });
            if (!n) return;
            r[signal.target] = signal.agg === 'sum' ? sum : sum / n;
        });
    }

    function joinSignals(rows) {
        SIGNALS.forEach(function (signal) { joinSignal(rows, signal); });
    }

    // Kick off the signal fetches at script load; pages should `await MII.ready`
    // before recompute() so the joins land on first render. The timeout means a
    // missing or slow file can never block a page.
    var readyResolve;
    var ready = new Promise(function (res) { readyResolve = res; });
    if (typeof fetch === 'function' && typeof window !== 'undefined') {
        var guard = setTimeout(readyResolve, 4000);
        // Copied, not aliased — a page's own config object stays untouched.
        var overrides = {};
        var configured = global.MII_SIGNAL_URLS || {};
        Object.keys(configured).forEach(function (k) { overrides[k] = configured[k]; });
        // Legacy single-file override, kept working for pages that set it.
        if (global.MII_SOCIAL_SIGNALS_URL) overrides.social = global.MII_SOCIAL_SIGNALS_URL;
        Promise.all(SIGNALS.map(function (signal) {
            return fetch(overrides[signal.name] || signal.url)
                .then(function (r) { return r.ok ? r.text() : null; })
                .then(function (t) {
                    if (t) signalTables[signal.name] = indexSignal(t, signal.column);
                })
                .catch(function () {});
        })).then(function () { clearTimeout(guard); readyResolve(); });
    } else {
        readyResolve();
    }

    // Data-quality assessment of the most recent recompute(). Keyed by the raw
    // column name; status is one of:
    //   'ok'     — populated with a healthy spread of values
    //   'empty'  — no usable values anywhere (weight is redistributed)
    //   'static' — populated but with so few distinct values it behaves like a
    //              lookup table, not a measurement (e.g. a per-brand constant)
    //   'sparse' — well-spread values, but present on too few rows to rank the
    //              field against (every other row charts as a bare zero)
    var dataQuality = {};
    var STATIC_DISTINCT_THRESHOLD = 50;
    // An input present on only a sliver of the dataset is not a usable axis even
    // when the handful of values it does carry are well spread. Percentile-ranking
    // it ranks those few rows against each other rather than against the field,
    // and every other row charts at zero — which reads as "measured, and it's
    // nothing" rather than "not measured here". Flagged 'sparse' so labels can say
    // so; scoring already drops the input per-row via weight renormalization.
    var SPARSE_COVERAGE_THRESHOLD = 0.25;

    // Overwrite each *_normalized column with a percentile rank and recompute
    // mii_score. Reads only the raw columns, so it is safe to call more than once
    // on the same rows. Mutates rows in place and returns them.
    //
    // Inputs a row has no value for are dropped from that row's blend and the
    // remaining weights renormalized (docs/social-score-methodology.md) — so
    // a dataset-wide dead column no longer caps every score below 100, and a
    // model missing one input (e.g. no social signal yet) isn't ranked as if it
    // scored zero on it. The *_normalized column still reads 0 for display.
    function recompute(rows) {
        if (!Array.isArray(rows) || !rows.length) return rows;

        joinSignals(rows);

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
                    : (vals.length / rows.length) < SPARSE_COVERAGE_THRESHOLD ? 'sparse'
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

        computeEffectiveWeights(rows);

        return rows;
    }

    // Methodology version. Scoring has changed materially over this index's life
    // (min-max scaling -> percentile rank; weight renormalization added;
    // model and manufacturer confidence scales unified), and a score is only
    // reproducible if the reader knows which rules produced it. Bump this
    // whenever a change moves published scores, and cite it alongside any
    // figure taken from the dashboard.
    var VERSION = '2026.09';

    // Mean EFFECTIVE weight of each input over the rows last scored.
    //
    // The published weights are nominal. Because a row missing an input has
    // that input dropped and the remaining weights renormalized, the weight an
    // input actually carries depends on how widely it is measured — an input
    // present on 0.5% of rows contributes 0.5% of the weight its formula
    // advertises, spread over the rest. Reporting only the nominal column
    // overstates the sparse inputs and understates the dense ones, so the
    // methodology panel shows both.
    var effectiveWeights = [];
    function computeEffectiveWeights(rows) {
        var totals = {}, present = {};
        COMPONENTS.forEach(function (c) { totals[c.raw] = 0; present[c.raw] = 0; });
        rows.forEach(function (r) {
            var live = COMPONENTS.filter(function (c) {
                return dataQuality[c.raw] && dataQuality[c.raw].status !== 'empty'
                    && !isNaN(parseFloat(r[c.raw]));
            });
            var w = live.reduce(function (s, c) { return s + c.weight; }, 0);
            if (!w) return;
            live.forEach(function (c) { totals[c.raw] += c.weight / w; present[c.raw]++; });
        });
        var n = rows.length || 1;
        effectiveWeights = COMPONENTS.map(function (c) {
            return {
                raw: c.raw,
                label: c.label,
                nominal: c.weight,
                effective: totals[c.raw] / n,
                coverage: present[c.raw] / n,
                status: (dataQuality[c.raw] || {}).status || 'unknown',
            };
        });
        return effectiveWeights;
    }

    // Measured noise floor: how far a model's monthly MII moves for no reason
    // other than which cars happened to cross the block that month.
    //
    // Derived from every consecutive month-pair in the live dataset (15,714
    // rows), bucketed by the SMALLER of the two months' auction counts, then
    // taking the median and 90th percentile of the absolute change. A move
    // below the median for its sample size is what an unchanged market looks
    // like; clearing the 90th percentile is the bar for calling a move real.
    //
    // The headline number: at one auction a month the median swing is 10.5
    // points. Most models in this dataset trade at that volume, so most
    // month-to-month movement in the UI is sampling, not market.
    var NOISE_FLOOR = [
        { minLots: 15, median: 4.0, p90: 8.8 },
        { minLots: 8,  median: 5.3, p90: 13.2 },
        { minLots: 5,  median: 5.7, p90: 15.9 },
        { minLots: 3,  median: 7.1, p90: 18.9 },
        { minLots: 2,  median: 8.2, p90: 21.4 },
        { minLots: 0,  median: 10.5, p90: 27.0 },
    ];
    function noiseFloor(auctions) {
        var n = parseFloat(auctions) || 0;
        for (var i = 0; i < NOISE_FLOOR.length; i++) {
            if (n >= NOISE_FLOOR[i].minLots) return NOISE_FLOOR[i];
        }
        return NOISE_FLOOR[NOISE_FLOOR.length - 1];
    }
    // How to read a month-over-month move of `points` MII on `auctions` lots:
    //   'noise'    — below the median swing for this sample size
    //   'weak'     — above the median but short of the 90th percentile
    //   'signal'   — clears the 90th percentile of pure sampling variation
    function moveStrength(points, auctions) {
        var f = noiseFloor(auctions), d = Math.abs(parseFloat(points) || 0);
        return d < f.median ? 'noise' : d < f.p90 ? 'weak' : 'signal';
    }

    // Confidence from sample size. One definition for every page and for both
    // grains, so a manufacturer row and a model row in the same table always
    // read the same auction count the same way. Previously model rows used their
    // own far looser scale (5 auctions = "High" at monthly grain), which put a
    // High badge on samples the manufacturer scale called Low.
    var CONFIDENCE_THRESHOLDS = {
        monthly:   { High: 15, 'Medium-High': 8,  Medium: 4  },
        quarterly: { High: 50, 'Medium-High': 20, Medium: 10 },
    };
    function confidenceFor(auctions, grain) {
        var t = CONFIDENCE_THRESHOLDS[grain] || CONFIDENCE_THRESHOLDS.monthly;
        var n = parseFloat(auctions) || 0;
        if (n >= t.High) return 'High';
        if (n >= t['Medium-High']) return 'Medium-High';
        if (n >= t.Medium) return 'Medium';
        return 'Low';
    }

    // Suffix marking an input the last recompute found unfit to chart, given a
    // raw column name ('youtube_total_views'). Charts append it to the axis
    // label so a weight-renormalized-away input reads as unmeasured rather than
    // as a genuine zero.
    function qualitySuffix(rawColumn) {
        var dq = dataQuality[rawColumn];
        if (!dq) return '';
        if (dq.status === 'empty') return ' (no data)';
        if (dq.status === 'static') return ' (static)';
        if (dq.status === 'sparse') return ' (sparse: ' + Math.round(dq.coverage * 100) + '% of rows)';
        return '';
    }

    // Bring a Trailer files memorabilia and hard parts under the car's own
    // make and model — wheels, seats, engines, manuals, signs — so a naive row
    // count treats a $300 steering wheel as an auction of the car. It also
    // skews unevenly: 23% of E30 M3 rows and 15% of 911 Carrera 3.2 rows are
    // parts, against 1% for the E46 M3, which distorts any comparison between
    // them and drags their price averages down.
    //
    // The test is BAT's own `category`, not the listing slug. A slug rule
    // ("a real car's URL starts with a model year") looks tempting and is
    // wrong: it drops ~900 genuine vehicles whose slug leads with something
    // else — Superformance, Backdraft, Factory Five, Kirkham and Meyers Manx
    // replicas, and listings like "supercharged-2008-bmw-m3-convertible".
    // Across every model checked, the category test flags exactly the same
    // lots as the slug rule with none of those false positives.
    //
    // A feed with no `category` column filters nothing, which keeps older
    // exports working rather than silently emptying the dataset.
    var NON_VEHICLE_CATEGORIES = { 'parts': 1, 'wheels': 1 };
    function isVehicleLot(row) {
        if (!row) return false;
        var cat = String(row.category == null ? '' : row.category).trim().toLowerCase();
        return !NON_VEHICLE_CATEGORIES[cat];
    }

    global.MII = {
        COMPONENTS: COMPONENTS,
        VERSION: VERSION,
        NOISE_FLOOR: NOISE_FLOOR,
        noiseFloor: noiseFloor,
        moveStrength: moveStrength,
        get effectiveWeights() { return effectiveWeights; },
        NON_VEHICLE_CATEGORIES: NON_VEHICLE_CATEGORIES,
        isVehicleLot: isVehicleLot,
        CONFIDENCE_THRESHOLDS: CONFIDENCE_THRESHOLDS,
        qualitySuffix: qualitySuffix,
        confidenceFor: confidenceFor,
        recompute: recompute,
        percentileRanker: percentileRanker,
        // Months covered by a period label ('2025-05' → itself, '2025Q2' → its
        // three months). Shared by pages that join monthly bat.csv data onto
        // MII rows of either grain.
        periodMonths: periodMonths,
        // Resolves once the social-signals fetch settles (or times out).
        ready: ready,
        // The measured signal files and the raw columns they feed.
        SIGNALS: SIGNALS,
        // Inject a signal CSV directly (tests / non-browser use).
        setSignal: function (name, text) {
            var signal = SIGNALS.filter(function (s) { return s.name === name; })[0];
            if (!signal) throw new Error('unknown signal: ' + name);
            signalTables[name] = indexSignal(text, signal.column);
        },
        setSocialSignals: function (text) { this.setSignal('social', text); },
        // Live view of the last recompute's per-input health.
        get dataQuality() { return dataQuality; },
    };
})(typeof window !== 'undefined' ? window : this);
