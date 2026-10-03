// Attention share: a make's (or model's) slice of all Bring a Trailer watchers.
//
// MII answers "how hot is each listing" — its views, bids and comments inputs
// are per-listing averages, so a make with one blockbuster lot can outscore a
// make with forty solid ones. Nothing in MII says how much of the market a
// make occupies. Attention share does:
//
//     share(make, period) = watchers on the make's lots / watchers on all lots
//
// summed over the months the period covers. It is DISPLAYED next to MII, not
// blended into it, on purpose:
//
//   - It is mostly supply. Across BaT, a make's watcher share is ~95% rank-
//     correlated with how many of its cars were listed, so blending it in
//     would mostly re-add listing count and tilt MII toward volume brands.
//   - share of watchers = listing share × (watchers per lot / market average),
//     and that second factor is what MII's per-listing inputs already rank.
//     Shown side by side, the two read cleanly as depth vs intensity.
//
// Watchers rather than views: the two are ~0.97 correlated at every grain, and
// watching is a deliberate act, closer to purchase intent.
//
// Model share is reported as a share of its MAKE, not of the market: BaT files
// one family under many labels ("MUSTANG", "Mustang Fastback", "Mustang GT"),
// so a single label's market share is a tiny, understated number. Within a
// make it reads as "how much of Porsche's attention is this label", which is
// honest at the label grain until a model-family mapping exists.

(function (global) {
    'use strict';

    // Case- and accent-folded key, so "Citroën" in the MII file meets
    // "Citroen" in bat.csv and "DeTomaso" meets "Detomaso".
    function fold(s) {
        var out = String(s == null ? '' : s).trim().toLowerCase();
        return out.normalize ? out.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : out;
    }

    // Accumulates watchers per month at three grains. Feed it every vehicle lot
    // while parsing bat.csv; the market total is every lot fed, so the
    // denominator never depends on which makes the MII file happens to cover.
    function createTracker() {
        var market = {};   // month -> watchers
        var makes = {};    // makeKey -> month -> watchers
        var models = {};   // modelKey -> month -> watchers

        function bump(table, key, month, w) {
            var byMonth = table[key] || (table[key] = {});
            byMonth[month] = (byMonth[month] || 0) + w;
        }

        function sum(byMonth, months) {
            if (!byMonth) return 0;
            var s = 0;
            for (var i = 0; i < months.length; i++) s += byMonth[months[i]] || 0;
            return s;
        }

        return {
            // make: raw make name; modelKey: the page's own model join key;
            // month: 'YYYY-MM'; watchers: number (lots without one are skipped,
            // so a blank field never counts as zero interest).
            add: function (make, modelKey, month, watchers) {
                var w = parseFloat(watchers);
                if (!month || isNaN(w) || w < 0) return;
                bump(market, '', month, w);
                bump(makes, fold(make), month, w);
                if (modelKey != null) bump(models, fold(modelKey), month, w);
            },
            marketWatchers: function (months) { return sum(market[''], months); },
            makeWatchers: function (make, months) { return sum(makes[fold(make)], months); },
            modelWatchers: function (modelKey, months) { return sum(models[fold(modelKey)], months); },
            // Fraction in [0,1], or null when the period has no watcher data.
            makeShare: function (make, months) {
                var total = sum(market[''], months);
                return total > 0 ? sum(makes[fold(make)], months) / total : null;
            },
            modelShareOfMake: function (make, modelKey, months) {
                var total = sum(makes[fold(make)], months);
                return total > 0 ? sum(models[fold(modelKey)], months) / total : null;
            },
            hasData: function () { return Object.keys(market).length > 0; },
        };
    }

    // Write share fields onto a page's aggregated period data, in place:
    //   mfr.share        fraction of market watchers (null if unknown)
    //   mfr.shareChange  change in percentage points vs the previous period
    //                    (null when there is no previous period)
    //   model.shareOfMake fraction of the make's watchers
    //
    // opts.monthsFor(periodKey)   -> ['YYYY-MM', ...]
    // opts.previous(periodKey)    -> previous period key or null
    // opts.modelKey(make, model)  -> the same model key used in tracker.add
    function attach(quarterData, tracker, opts) {
        if (!quarterData || !tracker || !tracker.hasData()) return;
        Object.keys(quarterData).forEach(function (periodKey) {
            var months = opts.monthsFor(periodKey);
            var prevKey = opts.previous(periodKey);
            var prevMonths = prevKey ? opts.monthsFor(prevKey) : null;
            (quarterData[periodKey].manufacturers || []).forEach(function (mfr) {
                mfr.share = tracker.makeShare(mfr.make, months);
                var prev = prevMonths ? tracker.makeShare(mfr.make, prevMonths) : null;
                mfr.shareChange = (mfr.share != null && prev != null)
                    ? (mfr.share - prev) * 100 : null;
                (mfr.models || []).forEach(function (model) {
                    model.shareOfMake = tracker.modelShareOfMake(
                        mfr.make, opts.modelKey(mfr.make, model.model), months);
                });
            });
        });
    }

    // "17.4%", "3.2%", "0.42%", "<0.01%", "—". Small shares keep a second
    // decimal so the long tail of makes doesn't all read "0.0%".
    function format(fraction) {
        if (fraction == null || !isFinite(fraction)) return '—';
        var pct = fraction * 100;
        if (pct > 0 && pct < 0.01) return '<0.01%';
        return pct.toFixed(pct < 1 ? 2 : 1) + '%';
    }

    // "+0.4 pts", "−1.2 pts", "" when unknown or rounds to zero.
    function formatChange(points) {
        if (points == null || !isFinite(points)) return '';
        var digits = Math.abs(points) < 1 ? 2 : 1;
        if (Math.abs(points) < Math.pow(10, -digits) / 2) return '';
        return (points > 0 ? '+' : '−') + Math.abs(points).toFixed(digits) + ' pts';
    }

    global.MIIShare = {
        createTracker: createTracker,
        attach: attach,
        format: format,
        formatChange: formatChange,
    };
})(typeof window !== 'undefined' ? window : this);
