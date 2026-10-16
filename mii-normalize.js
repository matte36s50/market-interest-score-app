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
// among the cars of the same month (0 = lowest, 1 = highest, ~0.5 = median),
// so models spread across the full 0-100 range and the score answers "how does
// this car rank against that month's field" rather than "what fraction of the
// single priciest car".
//
// It also joins the measured signal files collected by data/pipelines/ —
// social, Google Trends and YouTube — onto the raw columns before ranking,
// because upstream ships those three inputs empty.
//
// Every page calls MII.recompute(rows) right after parsing the CSV, so the
// pages always agree on a car's score.

(function (global) {
    'use strict';

    // Canonical MII formula: raw source column, the normalized column it writes,
    // the weight in the composite, and a display label. Weights sum to 1.0, so
    // mii_score = 100 * Σ(weight × percentileRank) lands in [0, 100]. This is
    // the one definition: every page reads its inputs and weights from here.
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
    //   YouTube       data/youtube_signals.csv  share of the trailing 12 months'
    //                                           views on tracked enthusiast channels
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
            // Percent of all views on the tracked channels' videos published
            // in the 12 months ending that month: raw views keep growing after
            // publication, so only a share of the same window compares.
            column: 'yt_view_share',
            target: 'youtube_total_views',
            // A quarter's share is its three months added up.
            agg: 'sum',
            // Always: upstream's occasional raw view count is in different
            // units and cannot be ranked alongside a share.
            overrides: function () { return true; },
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
        var table = canonicalSignal(signal.name);
        if (!table) return;
        rows.forEach(function (r) {
            var existing = parseFloat(r[signal.target]);
            if (!isNaN(existing) && !signal.overrides(r)) return;
            var byMonth = table[modelKey(r.manufacturer, r.model)];
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

    // ---- Attention: every model, every month -----------------------------------
    // MII exists only in a month a car sells on Bring a Trailer. Attention does
    // not wait for a sale: it blends the three inputs measured for every model
    // every month — search, YouTube and social — in the same proportions they
    // carry inside MII (15 : 10 : 5), each ranked among all models that month.
    // So a car that did not trade still has a reading, and a basket of cars
    // (an index's constituents) is the same cars every month.
    function miiWeight(raw) {
        return COMPONENTS.filter(function (c) { return c.raw === raw; })[0].weight;
    }
    var ATTENTION_INPUTS = [
        // A car the YouTube collector read but found no video for in a month's
        // trailing window has no row: that is a measured zero, not a gap.
        { signal: 'youtube', weight: miiWeight('youtube_total_views'), absentIsZero: true },
        { signal: 'trends', weight: miiWeight('google_trends_interest') },
        { signal: 'social', weight: miiWeight('social_score') },
    ];
    // A month is scored only when every input was broadly measured in it:
    // at least half as many models as that input's best month. A month with
    // one input missing or half-collected (the month in progress has YouTube
    // alone; Google Trends started part-way through August 2025) would score
    // on a different mix of inputs from its neighbours and jump for no reason.
    var ATTENTION_MIN_COVERAGE = 0.5;
    var attentionCache = null;
    function attentionTable() {
        var tables = ATTENTION_INPUTS.map(function (a) { return canonicalSignal(a.signal); });
        if (attentionCache && attentionCache.models === modelTable
            && attentionCache.tables.every(function (t, i) { return t === tables[i]; })) return attentionCache.out;
        // Models measured per month, per input. An input that records a zero
        // by omission (YouTube) counts as measured in any month it has rows.
        var monthsOf = tables.map(function (t, i) {
            var n = {};
            if (t) Object.keys(t).forEach(function (k) { Object.keys(t[k]).forEach(function (m) { n[m] = (n[m] || 0) + 1; }); });
            var best = Object.keys(n).reduce(function (b, m) { return Math.max(b, n[m]); }, 0);
            var set = {};
            Object.keys(n).forEach(function (m) {
                if (ATTENTION_INPUTS[i].absentIsZero || n[m] >= ATTENTION_MIN_COVERAGE * best) set[m] = 1;
            });
            return set;
        });
        var allMonths = {};
        monthsOf.forEach(function (s) { Object.keys(s).forEach(function (m) { allMonths[m] = (allMonths[m] || 0) + 1; }); });
        var out = {};   // modelKey -> month -> 0..100
        Object.keys(allMonths).sort().forEach(function (month) {
            if (allMonths[month] < ATTENTION_INPUTS.length) return;
            var ranks = ATTENTION_INPUTS.map(function (a, i) {
                var t = tables[i];
                if (!t || !monthsOf[i][month]) return null;
                var vals = {};
                Object.keys(t).forEach(function (k) {
                    var v = t[k][month];
                    if (v != null) vals[k] = v;
                    else if (a.absentIsZero) vals[k] = 0;
                });
                var list = Object.keys(vals).map(function (k) { return vals[k]; });
                if (list.length < MIN_PERIOD_SAMPLE) return null;
                var rank = percentileRanker(list);
                var r = {};
                Object.keys(vals).forEach(function (k) { r[k] = rank(vals[k]); });
                return r;
            });
            var keys = {};
            ranks.forEach(function (r) { if (r) Object.keys(r).forEach(function (k) { keys[k] = 1; }); });
            Object.keys(keys).forEach(function (k) {
                var s = 0, w = 0;
                ranks.forEach(function (r, i) {
                    if (r && r[k] != null) { s += ATTENTION_INPUTS[i].weight * r[k]; w += ATTENTION_INPUTS[i].weight; }
                });
                if (w) (out[k] = out[k] || {})[month] = +(100 * s / w).toFixed(2);
            });
        });
        attentionCache = { models: modelTable, tables: tables, out: out };
        return out;
    }
    // A model's attention in a month ("2026-09"; a "-MTD" suffix is ignored),
    // or null where it was not measured.
    function attentionFor(make, model, month) {
        var byMonth = attentionTable()[modelKey(make, canonicalModel(make, model))];
        var m = String(month == null ? '' : month).replace(/-MTD$/, '');
        return byMonth && byMonth[m] != null ? byMonth[m] : null;
    }

    // ---- Our model list ------------------------------------------------------
    // data/models.csv (data/pipelines/model_list.py) maps every name the
    // upstream file uses to one name per car: "TIGUAN", "VOLKSWAGEN TIGUAN" and
    // "Volkswagen Tiguan" are one model, "MUSTANG 903" (a listing counter) is
    // "MUSTANG", "996 Turbo" is "996 911 Turbo". Without it each duplicate is
    // its own row every month and credits itself with the same lots.
    var MAKE_ALIASES = { datsun: 'nissan' };
    // The comparison key for a make/model pair: case-folded, any leading brand
    // word and trailing "(1969-1973)" removed, spaces collapsed. Mirrors
    // model_key in model_list.py; every join on a model name goes through it.
    function modelKey(make, model) {
        var mk = String(make == null ? '' : make).trim().toLowerCase();
        mk = MAKE_ALIASES[mk] || mk;
        var prefixes = [mk].concat(Object.keys(MAKE_ALIASES).filter(function (a) { return MAKE_ALIASES[a] === mk; }));
        var m = String(model == null ? '' : model).trim().replace(/\s+/g, ' ');
        for (var i = 0; i < prefixes.length; i++) {
            if (m.toLowerCase().indexOf(prefixes[i] + ' ') === 0) { m = m.slice(prefixes[i].length + 1); break; }
        }
        return mk + '|' + m.replace(/\s*\(\d{4}-\d{4}\)$/, '').trim().toLowerCase();
    }

    var modelTable = null;   // modelKey -> { model, flag }
    function indexModels(text) {
        var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
        if (lines.length < 2) return null;
        var hdr = parseCsvLine(lines[0]);
        var iMan = hdr.indexOf('manufacturer'), iSrc = hdr.indexOf('source_model'),
            iMod = hdr.indexOf('model'), iFlag = hdr.indexOf('flag');
        if (iMan < 0 || iSrc < 0 || iMod < 0) return null;
        var out = {};
        for (var i = 1; i < lines.length; i++) {
            var c = parseCsvLine(lines[i]);
            var model = (c[iMod] || '').trim();
            if (!model) continue;
            out[modelKey(c[iMan], c[iSrc])] = { model: model, flag: iFlag < 0 ? '' : (c[iFlag] || '').trim() };
        }
        return out;
    }
    // Our name for an upstream (or Bring a Trailer) model name; a name the
    // list has not seen yet passes through unchanged.
    function canonicalModel(make, model) {
        var e = modelTable && modelTable[modelKey(make, model)];
        return e ? e.model : model;
    }
    function modelFlag(make, model) {
        var e = modelTable && modelTable[modelKey(make, model)];
        return e ? e.flag : '';
    }

    // Rename every row to our model name and merge a month's duplicates into
    // one row: lots and sales add up, the per-lot averages (price, views,
    // bids, comments, year, age) are weighted by each row's lots. Works in
    // place and is idempotent, so a page may call it before injecting
    // Bring a Trailer lot counts and recompute() calls it again harmlessly.
    var MERGE_MEANS = ['price', 'views', 'bids', 'comments', 'year', 'age'];
    var MERGE_SUMS = ['auction_count', 'sold'];
    function canonicalize(rows) {
        if (!Array.isArray(rows) || !modelTable) return rows;
        var out = [], at = {};
        rows.forEach(function (r) {
            if (!r._canonical) {
                var name = canonicalModel(r.manufacturer, r.model);
                if (name !== r.model) { r.source_model = r.model; r.model = name; }
                r.model_flag = modelFlag(r.manufacturer, r.model);
                r._canonical = true;
            }
            var k = modelKey(r.manufacturer, r.model) + '|' + String(r.quarter == null ? '' : r.quarter).trim();
            if (at[k] == null) { at[k] = out.length; out.push(r); return; }
            var a = out[at[k]];
            var wa = parseFloat(a.auction_count) || 1, wb = parseFloat(r.auction_count) || 1;
            MERGE_MEANS.forEach(function (col) {
                var x = parseFloat(a[col]), y = parseFloat(r[col]);
                if (isNaN(y)) return;
                a[col] = isNaN(x) ? y : (x * wa + y * wb) / (wa + wb);
            });
            MERGE_SUMS.forEach(function (col) {
                var x = parseFloat(a[col]), y = parseFloat(r[col]);
                if (!isNaN(y)) a[col] = (isNaN(x) ? 0 : x) + y;
            });
            // Anything else (a measured signal, the class) fills a gap only.
            Object.keys(r).forEach(function (col) {
                if ((a[col] == null || a[col] === '') && r[col] != null && r[col] !== '') a[col] = r[col];
            });
        });
        if (out.length !== rows.length) {
            rows.length = 0;
            for (var i = 0; i < out.length; i++) rows.push(out[i]);
        }
        return rows;
    }

    // A signal table re-keyed on our model names. The collectors write our
    // names from now on, but older rows (and any written under a duplicate's
    // name) are folded in: where two names hold the same month, the values
    // are averaged.
    var canonicalCache = {};
    function canonicalSignal(name) {
        var table = signalTables[name];
        if (!table) return null;
        var cached = canonicalCache[name];
        if (cached && cached.table === table && cached.models === modelTable) return cached.out;
        var acc = {};
        Object.keys(table).forEach(function (raw) {
            var cut = raw.indexOf('|');
            var make = raw.slice(0, cut), model = raw.slice(cut + 1);
            var key = modelKey(make, canonicalModel(make, model));
            var dst = acc[key] = acc[key] || {};
            Object.keys(table[raw]).forEach(function (mo) {
                var cell = dst[mo] = dst[mo] || [0, 0];
                cell[0] += table[raw][mo]; cell[1]++;
            });
        });
        var out = {};
        Object.keys(acc).forEach(function (key) {
            out[key] = {};
            Object.keys(acc[key]).forEach(function (mo) { out[key][mo] = acc[key][mo][0] / acc[key][mo][1]; });
        });
        canonicalCache[name] = { table: table, models: modelTable, out: out };
        return out;
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
        var models = fetch(global.MII_MODELS_URL || 'data/models.csv')
            .then(function (r) { return r.ok ? r.text() : null; })
            .then(function (t) { if (t) modelTable = indexModels(t); })
            .catch(function () {});
        Promise.all(SIGNALS.map(function (signal) {
            return fetch(overrides[signal.name] || signal.url)
                .then(function (r) { return r.ok ? r.text() : null; })
                .then(function (t) {
                    if (t) signalTables[signal.name] = indexSignal(t, signal.column);
                })
                .catch(function () {});
        }).concat([models])).then(function () { clearTimeout(guard); readyResolve(); });
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

    // Rank one raw column into its normalized column, each row against the
    // other cars of its own period. A period with too few measurements of
    // the column to rank within falls back to the whole field rather than
    // ranking a handful of cars against each other. Records the column's
    // data quality when given a label.
    function rankColumn(rows, raw, norm, label) {
        var vals = [], byPeriod = {}, distinct = {}, distinctCount = 0;
        for (var i = 0; i < rows.length; i++) {
            var v = parseFloat(rows[i][raw]);
            if (!isNaN(v)) {
                vals.push(v);
                (byPeriod[periodKey(rows[i])] = byPeriod[periodKey(rows[i])] || []).push(v);
                if (!distinct[v]) { distinct[v] = 1; distinctCount++; }
            }
        }
        if (label) {
            dataQuality[raw] = {
                label: label,
                coverage: vals.length / rows.length,
                distinct: distinctCount,
                status: !vals.length ? 'empty'
                    : distinctCount < STATIC_DISTINCT_THRESHOLD ? 'static'
                    : (vals.length / rows.length) < SPARSE_COVERAGE_THRESHOLD ? 'sparse'
                    : 'ok',
            };
        }
        if (!vals.length) {
            rows.forEach(function (r) { r[norm] = 0; });
            return;
        }
        var pooled = percentileRanker(vals);
        var rankers = {};
        Object.keys(byPeriod).forEach(function (p) {
            rankers[p] = byPeriod[p].length >= MIN_PERIOD_SAMPLE ? percentileRanker(byPeriod[p]) : pooled;
        });
        rows.forEach(function (r) {
            var v = parseFloat(r[raw]);
            r[norm] = isNaN(v) ? 0 : +rankers[periodKey(r)](v).toFixed(6);
        });
    }

    // Scores rank each car against the other cars of the SAME period (month,
    // or quarter for quarterly rows), not against the whole file. Ranking the
    // whole file at once let three things leak into a car's score that have
    // nothing to do with the car: every new month re-ranked all the old ones,
    // so history kept revising; Bring a Trailer's traffic growth pushed later
    // months' views and bids up the ranks; and the rolling window shifted
    // every score again as old months dropped out. Within a period, the
    // median car scores about 50 every month.
    function periodKey(row) { return String(row.quarter == null ? '' : row.quarter).trim(); }
    // Below this many measured values in a period, an input is ranked against
    // the whole field instead (a brand-new signal, or a near-empty month).
    var MIN_PERIOD_SAMPLE = 30;

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

        canonicalize(rows);
        joinSignals(rows);

        dataQuality = {};

        COMPONENTS.forEach(function (c) { rankColumn(rows, c.raw, c.norm, c.label); });

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
    // model and manufacturer confidence scales unified; 2026.10 ranks each car
    // within its own month instead of the whole file), and a score is only
    // reproducible if the reader knows which rules produced it. Bump this
    // whenever a change moves published scores, and cite it alongside any
    // figure taken from the dashboard.
    var VERSION = '2026.10';

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
    //
    // The category misses a few. Bring a Trailer files memorabilia under the
    // make "Parts and Automobilia" (signs, gas pumps, scale models, go-karts),
    // sometimes with a vehicle category; and a loose engine, a set of seats or
    // a sign can sit under a real model with no category at all ("engine 355"
    // under the E30 M3, "seats 198" under the 911SC). Those are caught by the
    // listing title, but only when it carries no model year: a real car's
    // title starts with one, and one that does not ("427-powered 1965 Pontiac
    // Tempest LeMans hardtop") is ruled out only by words that never describe
    // a car, or by a title that is nothing but a component and a counter.
    var NON_VEHICLE_MAKE = /^parts and automobilia\b/i;
    var NOT_A_CAR_WORDS = /\b(signs?|neon|gas pumps?|oil tanks?|parts|wheels|tires|seats|literature|memorabilia|automobilia|pinball|scale models?|pedal cars?)\b/;
    var BARE_COMPONENT = /^(engine|motor|transmission|gearbox|hardtop|seats?|tires?|wheels?|parts)( \d+)*$/;
    function listingTitle(row) {
        var slug = String(row.auction_url == null ? '' : row.auction_url).replace(/\/+$/, '').split('/').pop();
        return slug.replace(/-/g, ' ').toLowerCase();
    }
    function isVehicleLot(row) {
        if (!row) return false;
        var cat = String(row.category == null ? '' : row.category).trim().toLowerCase();
        if (NON_VEHICLE_CATEGORIES[cat]) return false;
        if (NON_VEHICLE_MAKE.test(String(row.make == null ? '' : row.make).trim())) return false;
        var title = listingTitle(row);
        if (title && !/^(19|20)\d{2}\b/.test(title)
            && (NOT_A_CAR_WORDS.test(title) || BARE_COMPONENT.test(title))) return false;
        return true;
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
        // Our model list (data/models.csv): the join key every page uses, our
        // name and flag for a source name, and the duplicate merge.
        modelKey: modelKey,
        canonicalModel: canonicalModel,
        modelFlag: modelFlag,
        canonicalize: canonicalize,
        setModels: function (text) { modelTable = text ? indexModels(text) : null; },
        // Attention: search, YouTube and social for every model every month.
        attentionFor: attentionFor,
        ATTENTION_INPUTS: ATTENTION_INPUTS,
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
