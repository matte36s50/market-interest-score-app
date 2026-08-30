// Shared MII normalization + scoring.  Methodology v2.
//
// WHAT CHANGED IN v2, AND WHY
//
// v1 blended eight inputs into one 0-100 number using percentile ranks taken
// over the whole pooled panel. Measured against the live data that construct
// had five defects:
//
//   * Stated weights were not real weights. The four auction statistics were
//     given 65% of the formula and carried 92.7% of the variance; Google
//     Trends was given 15% and carried 5.9%; YouTube 10% and 0.0%.
//   * Ranking over the pooled panel meant every car's score rose when the site
//     got busier. Monthly mean score tracked monthly median views at r = +0.93.
//   * Views and comments (correlated 0.69) each got their own weight, so
//     on-site attention was counted roughly twice.
//   * A missing input was dropped and the remaining weights rescaled, which
//     moved a row by up to +/-15 points depending on nothing but which axis
//     happened to be absent.
//   * Half the panel rests on a single auction and nothing discounted it.
//
// v2 answers those directly:
//
//   1. TWO INDICES.  mii_score measures INTEREST and excludes price entirely.
//      mvi_score reports VALUE (price standing) on its own. Wanting a car and
//      paying a lot for it are different things, and one number could not say
//      both. Vehicle age is still normalized for charting but scores nothing:
//      it had an effective weight of -0.2% and no theory behind it.
//   2. PILLARS.  Inputs are grouped before weighting, so correlated members
//      share one budget instead of two, and a dropped input redistributes
//      inside its own pillar rather than leaking weight to price or bids.
//   3. WITHIN-PERIOD NORMALIZATION.  Every input is standardized against the
//      other cars in the SAME period, so site-wide traffic swings cancel and
//      a month-over-month move means something.
//   4. MAGNITUDE IS PRESERVED.  Count-like inputs are log-transformed, then
//      z-scored and mapped through the normal CDF. A car searched ten times
//      more than another now gains more than one searched 1% more; a plain
//      rank gave them the same step.
//   5. IMPUTATION, NOT RENORMALIZATION.  A missing value is imputed at its
//      manufacturer's median for that period (falling back to the period
//      median) and the row is flagged. An input too sparse to be fair to
//      anyone is dropped for EVERY row, so all cars are scored on one formula.
//   6. SHRINKAGE.  A row's score is pulled toward a prior in proportion to how
//      few auctions back it, with the strength estimated from the data. This
//      is what stops a one-car model owning the leaderboard.
//   7. STATED METHODOLOGY.  Version, base period and a provisional window are
//      published on MII.METHODOLOGY so a score can be reproduced and a
//      revision explained.
//
// It also joins the measured signal files collected by data/pipelines/ --
// social, Google Trends and YouTube -- onto the raw columns before scoring,
// because upstream ships those three inputs empty.
//
// Every page calls MII.recompute(rows) right after parsing the CSV, so the
// classic and HAGI pages always agree on a car's score.

(function (global) {
    'use strict';

    var METHODOLOGY = {
        version: '2.0.0',
        normalization: 'within-period log z-score mapped through the normal CDF',
        aggregation: 'weighted pillars, linear within and between',
        // Rows in the most recent N periods are marked provisional: late
        // auction data and the signal collectors both still land there.
        provisionalPeriods: 2,
        // An input present on fewer than this share of rows is excluded for
        // everyone rather than imputed for most of them.
        minCoverage: 0.20,
        // Filled in by recompute() from the data actually scored.
        basePeriod: null,
        latestPeriod: null,
        shrinkageK: null,
    };

    // ---- Inputs -------------------------------------------------------------
    // Every raw column that gets a normalized twin. `scale:'log'` marks a
    // count-like, right-skewed quantity that is log-transformed before
    // standardizing. `smooth` averages the value over that many trailing
    // periods for the model before scoring -- bid count is close to noise at
    // the monthly grain (month-to-month rank correlation 0.21), and smoothing
    // is what makes it usable at a meaningful weight.
    var INPUTS = [
        { raw: 'price',                  norm: 'price_normalized',                  label: 'Sale Price',    scale: 'log' },
        { raw: 'bids',                   norm: 'bids_normalized',                   label: 'Bid Activity',  scale: 'log', smooth: 3 },
        { raw: 'views',                  norm: 'views_normalized',                  label: 'View Count',    scale: 'log' },
        { raw: 'comments',               norm: 'comments_normalized',               label: 'Comments',      scale: 'log' },
        { raw: 'sell_through',           norm: 'sell_through_normalized',           label: 'Sell-Through',  scale: 'linear', derived: true },
        { raw: 'social_score',           norm: 'social_score_normalized',           label: 'Social',        scale: 'linear' },
        { raw: 'google_trends_interest', norm: 'google_trends_interest_normalized', label: 'Google Trends', scale: 'log' },
        { raw: 'youtube_total_views',    norm: 'youtube_total_views_normalized',    label: 'YouTube',       scale: 'log' },
        // Normalized for charting only -- deliberately scores nothing.
        { raw: 'age',                    norm: 'age_normalized',                    label: 'Vehicle Age',   scale: 'linear', unscored: true },
    ];

    // ---- The two indices ----------------------------------------------------
    // INTEREST: how much collective attention a model drew, price excluded.
    // Pillar weights are the judgement call; they are stated here rather than
    // emerging from whichever input happens to have the widest spread.
    var INTEREST_PILLARS = [
        {
            id: 'bidding', label: 'Bidding intensity', weight: 0.25,
            members: [
                { raw: 'bids',         weight: 0.65 },
                { raw: 'sell_through', weight: 0.35 },
            ],
        },
        {
            id: 'audience', label: 'On-site audience', weight: 0.35,
            // Views and comments are 0.69 correlated. Sharing one pillar budget
            // is the standard remedy: together they buy 35%, not 25% + 10%.
            members: [
                { raw: 'views',    weight: 0.60 },
                { raw: 'comments', weight: 0.40 },
            ],
        },
        {
            id: 'demand', label: 'Off-platform demand', weight: 0.40,
            // The only evidence of interest that does not come from one auction
            // site, and so the heaviest pillar. It is also the thinnest today:
            // until the collectors fill in, this pillar leans on whichever of
            // its members has coverage.
            members: [
                { raw: 'google_trends_interest', weight: 0.50 },
                { raw: 'social_score',           weight: 0.30 },
                { raw: 'youtube_total_views',    weight: 0.20 },
            ],
        },
    ];

    // VALUE: where a model's money sits versus the field, reported separately
    // so "expensive" can never be mistaken for "wanted".
    var VALUE_PILLARS = [
        { id: 'value', label: 'Price standing', weight: 1.00, members: [{ raw: 'price', weight: 1.00 }] },
    ];

    // Back-compatible flat view of the interest formula: the shape the pages
    // already iterate ({ raw, norm, weight, label }), with each weight the
    // product of its pillar's and its own.
    var COMPONENTS = [];
    INTEREST_PILLARS.forEach(function (p) {
        p.members.forEach(function (m) {
            var input = inputByRaw(m.raw);
            COMPONENTS.push({
                raw: m.raw, norm: input.norm, label: input.label,
                weight: +(p.weight * m.weight).toFixed(4),
                pillar: p.id, pillarLabel: p.label,
            });
        });
    });

    function inputByRaw(raw) {
        for (var i = 0; i < INPUTS.length; i++) if (INPUTS[i].raw === raw) return INPUTS[i];
        throw new Error('unknown input: ' + raw);
    }

    // ---- Small numeric helpers ---------------------------------------------

    // Abramowitz & Stegun 7.1.26. Plenty accurate for mapping a z-score onto
    // 0..1; the index is reported to one decimal.
    function erf(x) {
        var s = x < 0 ? -1 : 1;
        x = Math.abs(x);
        var t = 1 / (1 + 0.3275911 * x);
        var y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
                    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
        return s * y;
    }
    function normalCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }

    function median(sorted) {
        if (!sorted.length) return NaN;
        var m = sorted.length >> 1;
        return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
    }
    function mean(a) {
        if (!a.length) return NaN;
        var s = 0; for (var i = 0; i < a.length; i++) s += a[i];
        return s / a.length;
    }
    function variance(a) {
        if (a.length < 2) return NaN;
        var m = mean(a), s = 0;
        for (var i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
        return s / (a.length - 1);
    }
    function num(v) {
        if (v === null || v === undefined || v === '') return NaN;
        var n = parseFloat(v);
        return isFinite(n) ? n : NaN;
    }

    // Kept for callers and tests that still want a plain rank. Not used by the
    // v2 scoring path.
    function percentileRanker(values) {
        var sorted = values.slice().sort(function (a, b) { return a - b; });
        var n = sorted.length;
        return function (x) {
            if (!n) return 0;
            var lo = 0, hi = n, mid;
            while (lo < hi) { mid = (lo + hi) >> 1; if (sorted[mid] < x) lo = mid + 1; else hi = mid; }
            var below = lo;
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
    // onto each row's raw column before scoring, so these axes carry real,
    // time-varying values. When a file is absent the coverage rule below drops
    // that input for every row -- nothing is invented.
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

    // Months covered by a period label: monthly "2025-05" -> itself,
    // quarterly "2025Q2" -> its three months.
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
        // Copied, not aliased -- a page's own config object stays untouched.
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

    // ---- Data-quality assessment of the most recent recompute ---------------
    // Keyed by raw column name; status is one of:
    //   'ok'     -- populated with a healthy spread of values
    //   'empty'  -- no usable values anywhere
    //   'sparse' -- present on too few rows to score fairly, so excluded for
    //               every row rather than imputed for most of them
    //   'static' -- populated but with so few distinct values it behaves like a
    //               lookup table, not a measurement (e.g. a per-brand constant)
    // 'empty' and 'sparse' are both excluded from scoring; their pillar's
    // remaining members absorb the weight.
    var dataQuality = {};
    var STATIC_DISTINCT_THRESHOLD = 50;

    function isScorable(raw) {
        var dq = dataQuality[raw];
        return !!dq && dq.status !== 'empty' && dq.status !== 'sparse';
    }

    // ---- Scoring ------------------------------------------------------------

    function periodKey(r) { return String(r.quarter || '').trim(); }
    function modelKey(r) {
        return String(r.manufacturer || '').trim() + '|' + String(r.model || '').trim();
    }
    // Sortable form of a period label, so monthly and quarterly grains order
    // the same way ('2025Q2' sorts with '2025-04').
    function periodSortKey(p) {
        var months = periodMonths(p);
        return months.length ? months[0] : p;
    }

    // sold is a per-period sum of sold counts, not a flag. Derived here rather
    // than upstream so the interest index can see whether cars actually met
    // reserve, which is a demand signal the auction stats alone do not carry.
    function deriveSellThrough(rows) {
        rows.forEach(function (r) {
            var n = num(r.auction_count), s = num(r.sold);
            r.sell_through = (isFinite(n) && n > 0 && isFinite(s))
                ? Math.max(0, Math.min(1, s / n))
                : '';
        });
    }

    // Trailing mean of a model's own values over the last `k` periods, written
    // to a shadow column so the raw data stays untouched and recompute() stays
    // idempotent.
    function smoothInputs(rows) {
        INPUTS.forEach(function (input) {
            if (!input.smooth) return;
            var byModel = {};
            rows.forEach(function (r) {
                (byModel[modelKey(r)] = byModel[modelKey(r)] || []).push(r);
            });
            Object.keys(byModel).forEach(function (k) {
                var series = byModel[k].slice().sort(function (a, b) {
                    var pa = periodSortKey(periodKey(a)), pb = periodSortKey(periodKey(b));
                    return pa < pb ? -1 : pa > pb ? 1 : 0;
                });
                series.forEach(function (r, i) {
                    var vals = [];
                    for (var j = Math.max(0, i - input.smooth + 1); j <= i; j++) {
                        var v = num(series[j][input.raw]);
                        if (isFinite(v)) vals.push(v);
                    }
                    r['__smooth_' + input.raw] = vals.length ? mean(vals) : NaN;
                });
            });
        });
    }

    // The value actually scored for an input: the smoothed series where one
    // exists, the raw column otherwise.
    function scoredValue(r, input) {
        var v = input.smooth ? r['__smooth_' + input.raw] : num(r[input.raw]);
        return isFinite(v) ? v : NaN;
    }

    function assessQuality(rows) {
        dataQuality = {};
        INPUTS.forEach(function (input) {
            var vals = [], distinct = {}, distinctCount = 0;
            rows.forEach(function (r) {
                var v = scoredValue(r, input);
                if (isFinite(v)) {
                    vals.push(v);
                    if (!distinct[v]) { distinct[v] = 1; distinctCount++; }
                }
            });
            var coverage = rows.length ? vals.length / rows.length : 0;
            dataQuality[input.raw] = {
                label: input.label,
                coverage: coverage,
                distinct: distinctCount,
                // Order matters for what gets REPORTED, not for what gets
                // scored -- 'empty' and 'sparse' are both excluded. An input
                // measured on a handful of rows is described as sparse rather
                // than empty, because the distinction tells you whether the
                // collector is broken or just behind.
                //
                // The constant case is last and is the subtle one: an input can
                // have perfect coverage and still be dead, because a column
                // with one distinct value cannot separate any two cars. Today
                // that is sell_through -- upstream copies `sold` from
                // `auction_count` on all 14,819 rows, so the panel holds no
                // unsold lots. It stays declared in its pillar so it activates
                // by itself if real reserve-met data ever arrives.
                status: !vals.length ? 'empty'
                    : coverage < METHODOLOGY.minCoverage ? 'sparse'
                    : distinctCount <= 1 ? 'empty'
                    : distinctCount < STATIC_DISTINCT_THRESHOLD ? 'static'
                    : 'ok',
            };
        });
    }

    // Standardize one input within one period: log-transform when the quantity
    // is count-like, z-score against that period's other cars, winsorize the
    // tails so a single outlier cannot flatten everyone else, then map through
    // the normal CDF onto 0..1. Magnitude survives this; a plain rank loses it.
    var WINSOR_Z = 3;
    function normalizePeriod(periodRows, input) {
        var vals = [];
        periodRows.forEach(function (r) {
            var v = scoredValue(r, input);
            if (isFinite(v)) vals.push(input.scale === 'log' ? Math.log1p(Math.max(0, v)) : v);
        });
        if (!vals.length) return null;
        var mu = mean(vals);
        var sd = Math.sqrt(variance(vals));
        // One car in the period, or every car identical: no spread to measure,
        // so everyone sits at the middle rather than at an arbitrary extreme.
        if (!isFinite(sd) || sd === 0) return function () { return 0.5; };
        return function (v) {
            var x = input.scale === 'log' ? Math.log1p(Math.max(0, v)) : v;
            var z = Math.max(-WINSOR_Z, Math.min(WINSOR_Z, (x - mu) / sd));
            return normalCdf(z);
        };
    }

    // Impute a missing normalized value at the manufacturer's median for the
    // period, falling back to the period median. Stated and auditable, unlike
    // v1's silent reweighting -- and identical for every row missing the same
    // axis, so it cannot hand one car a windfall and another a penalty.
    function imputeMissing(periodRows, input) {
        var byMfr = {}, all = [];
        periodRows.forEach(function (r) {
            var v = r[input.norm];
            if (r['__has_' + input.raw] && isFinite(v)) {
                all.push(v);
                var m = String(r.manufacturer || '').trim();
                (byMfr[m] = byMfr[m] || []).push(v);
            }
        });
        Object.keys(byMfr).forEach(function (m) {
            byMfr[m].sort(function (a, b) { return a - b; });
        });
        all.sort(function (a, b) { return a - b; });
        var periodMedian = all.length ? median(all) : 0.5;
        periodRows.forEach(function (r) {
            if (r['__has_' + input.raw]) return;
            var m = String(r.manufacturer || '').trim();
            var pool = byMfr[m];
            r[input.norm] = pool && pool.length ? median(pool) : periodMedian;
            r.mii_imputed = (r.mii_imputed || 0) + 1;
        });
    }

    // Weighted blend of a pillar's scorable members. Returns null when the
    // pillar has nothing to say, so the caller can redistribute its weight.
    function pillarScore(r, pillar) {
        var s = 0, w = 0;
        pillar.members.forEach(function (m) {
            if (!isScorable(m.raw)) return;
            var v = r[inputByRaw(m.raw).norm];
            if (!isFinite(v)) return;
            s += m.weight * v;
            w += m.weight;
        });
        return w > 0 ? s / w : null;
    }

    function composite(r, pillars, detailKey) {
        var s = 0, w = 0, detail = {};
        pillars.forEach(function (p) {
            var v = pillarScore(r, p);
            if (v === null) return;
            detail[p.id] = +(v * 100).toFixed(2);
            s += p.weight * v;
            w += p.weight;
        });
        if (detailKey) r[detailKey] = detail;
        return w > 0 ? s / w * 100 : null;
    }

    // How hard to pull a thin row toward its prior. A row's score carries
    // sampling noise of roughly sigma^2/n on top of the model's own tau^2, so
    // the classic shrinkage weight is n/(n+K) with K = sigma^2/tau^2. Both
    // variances are estimated from the panel: compare the spread of rows built
    // on one auction against the spread of rows built on many, and the excess
    // is the sampling noise. Clamped, and defaulted, because a small or odd
    // panel can produce a degenerate estimate.
    var DEFAULT_K = 4;
    function estimateK(rows, scores) {
        var byModel = {};
        rows.forEach(function (r, i) {
            if (scores[i] === null) return;
            (byModel[modelKey(r)] = byModel[modelKey(r)] || []).push({ n: num(r.auction_count), s: scores[i] });
        });
        var thin = [], thick = [];
        Object.keys(byModel).forEach(function (k) {
            var g = byModel[k];
            if (g.length < 2) return;
            var m = mean(g.map(function (x) { return x.s; }));
            g.forEach(function (x) {
                var d = (x.s - m) * (x.s - m);
                if (x.n <= 1) thin.push(d);
                else if (x.n >= 8) thick.push(d);
            });
        });
        if (thin.length < 30 || thick.length < 30) return DEFAULT_K;
        var vThin = mean(thin), vThick = mean(thick);
        var sigma2 = vThin - vThick;   // noise contributed by having only one sale
        var tau2 = vThick;             // irreducible model-level variation
        if (!(sigma2 > 0) || !(tau2 > 0)) return DEFAULT_K;
        return Math.max(0.5, Math.min(25, sigma2 / tau2));
    }

    // The prior a row is pulled toward: its manufacturer's average IN THE SAME
    // PERIOD, else the model's own other periods, else the period average. Every
    // candidate is leave-one-out, so a row is never shrunk toward itself.
    //
    // The group mean is deliberately preferred over the model's own history.
    // Shrinking toward a model's past is a smoother, not empirical Bayes: it
    // makes consecutive months share most of their value, which manufactures
    // persistence. Trying it that way pushed month-to-month correlation on
    // single-auction rows from 0.59 to 0.95 and collapsed within-model movement
    // to 2.6 points -- the index looked reliable precisely because it had
    // stopped responding to the month. A period-varying group prior pulls thin
    // rows toward a sensible reference while leaving real movement intact.
    function buildPriors(rows, scores) {
        var model = {}, mfrPeriod = {}, period = {};
        rows.forEach(function (r, i) {
            var s = scores[i];
            if (s === null) return;
            var mk = modelKey(r), pk = periodKey(r), fk = String(r.manufacturer || '').trim() + '|' + pk;
            (model[mk] = model[mk] || { sum: 0, n: 0 });      model[mk].sum += s; model[mk].n++;
            (mfrPeriod[fk] = mfrPeriod[fk] || { sum: 0, n: 0 }); mfrPeriod[fk].sum += s; mfrPeriod[fk].n++;
            (period[pk] = period[pk] || { sum: 0, n: 0 });     period[pk].sum += s; period[pk].n++;
        });
        return function (r, i) {
            var s = scores[i];
            var mk = modelKey(r), pk = periodKey(r), fk = String(r.manufacturer || '').trim() + '|' + pk;
            var f = mfrPeriod[fk];
            if (f && f.n > 1) return (f.sum - s) / (f.n - 1);
            var g = model[mk];
            if (g && g.n > 1) return (g.sum - s) / (g.n - 1);
            var p = period[pk];
            if (p && p.n > 1) return (p.sum - s) / (p.n - 1);
            return s;
        };
    }

    // Overwrite each *_normalized column and recompute both indices. Reads only
    // raw columns, so it is safe to call more than once on the same rows.
    // Mutates rows in place and returns them.
    function recompute(rows) {
        if (!Array.isArray(rows) || !rows.length) return rows;

        joinSignals(rows);
        deriveSellThrough(rows);
        smoothInputs(rows);
        assessQuality(rows);

        // Group by period -- every standardization below is within-period.
        var periods = {}, order = [];
        rows.forEach(function (r) {
            var k = periodKey(r);
            if (!periods[k]) { periods[k] = []; order.push(k); }
            periods[k].push(r);
        });
        order.sort(function (a, b) {
            var pa = periodSortKey(a), pb = periodSortKey(b);
            return pa < pb ? -1 : pa > pb ? 1 : 0;
        });
        METHODOLOGY.basePeriod = order[0] || null;
        METHODOLOGY.latestPeriod = order[order.length - 1] || null;

        rows.forEach(function (r) { r.mii_imputed = 0; });

        INPUTS.forEach(function (input) {
            order.forEach(function (pk) {
                var pr = periods[pk];
                var f = normalizePeriod(pr, input);
                pr.forEach(function (r) {
                    var v = scoredValue(r, input);
                    var has = isFinite(v) && f !== null;
                    r['__has_' + input.raw] = has;
                    r[input.norm] = has ? +f(v).toFixed(6) : NaN;
                });
                // Only inputs that actually score get imputed; a sparse or dead
                // input is excluded for everyone instead.
                if (isScorable(input.raw) && !input.unscored) imputeMissing(pr, input);
                // Charting reads these columns directly, so leave a number
                // rather than NaN where an input was never measured.
                pr.forEach(function (r) {
                    if (!isFinite(r[input.norm])) r[input.norm] = 0;
                });
            });
        });

        // Raw (pre-shrinkage) composites.
        var rawInterest = rows.map(function (r) { return composite(r, INTEREST_PILLARS, 'mii_pillars'); });
        var rawValue = rows.map(function (r) { return composite(r, VALUE_PILLARS, null); });

        var K = estimateK(rows, rawInterest);
        METHODOLOGY.shrinkageK = +K.toFixed(2);
        var interestPrior = buildPriors(rows, rawInterest);
        var valuePrior = buildPriors(rows, rawValue);

        var provisionalFrom = order.length > METHODOLOGY.provisionalPeriods
            ? order[order.length - METHODOLOGY.provisionalPeriods]
            : order[0];

        rows.forEach(function (r, i) {
            var n = num(r.auction_count);
            if (!isFinite(n) || n < 0) n = 0;

            r.mii_raw = rawInterest[i] === null ? 0 : +rawInterest[i].toFixed(2);
            if (rawInterest[i] === null) {
                r.mii_score = 0;
            } else {
                var prior = interestPrior(r, i);
                r.mii_score = +(((n * rawInterest[i]) + (K * prior)) / (n + K)).toFixed(2);
            }

            if (rawValue[i] === null) {
                r.mvi_score = 0;
            } else {
                var vprior = valuePrior(r, i);
                r.mvi_score = +(((n * rawValue[i]) + (K * vprior)) / (n + K)).toFixed(2);
            }

            // How much of this row is its own evidence rather than its prior.
            r.mii_confidence = +(n / (n + K)).toFixed(3);
            r.mii_provisional = periodSortKey(periodKey(r)) >= periodSortKey(provisionalFrom);
        });

        return rows;
    }

    global.MII = {
        METHODOLOGY: METHODOLOGY,
        INPUTS: INPUTS,
        INTEREST_PILLARS: INTEREST_PILLARS,
        VALUE_PILLARS: VALUE_PILLARS,
        // Flat { raw, norm, weight, label, pillar } view of the interest
        // formula, for pages that iterate components rather than pillars.
        COMPONENTS: COMPONENTS,
        recompute: recompute,
        percentileRanker: percentileRanker,
        // Months covered by a period label ('2025-05' -> itself, '2025Q2' -> its
        // three months). Shared by pages that join monthly bat.csv data onto
        // MII rows of either grain.
        periodMonths: periodMonths,
        // Resolves once the signal fetches settle (or time out).
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
