#!/usr/bin/env node
// Tests for the measured-signal join in mii-normalize.js.
//
// The join is the seam where this repo's collected CSVs meet the upstream MII
// results, and it has to get three things right: fill a missing input, replace
// an upstream placeholder without clobbering a real upstream measurement, and
// aggregate months into a period the right way (average a score, add a count).
//
// Run: node scripts/test-mii-signals.js

const { MII } = require('../mii-normalize.js');

let failures = 0;

function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) {
        failures++;
        console.log(`  FAIL ${name}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`);
    } else {
        console.log(`  ok   ${name}`);
    }
}

function near(name, actual, expected, tol) {
    const ok = Math.abs(actual - expected) <= (tol === undefined ? 1e-6 : tol);
    if (!ok) {
        failures++;
        console.log(`  FAIL ${name}\n       expected ~${expected}\n       actual    ${actual}`);
    } else {
        console.log(`  ok   ${name}`);
    }
}

console.log('periodMonths');
check('monthly period is itself', MII.periodMonths('2026-04'), ['2026-04']);
check('quarterly period expands', MII.periodMonths('2025Q2'), ['2025-04', '2025-05', '2025-06']);
check('garbage period is empty', MII.periodMonths('nonsense'), []);

console.log('percentileRanker');
const rank = MII.percentileRanker([1, 2, 3, 4]);
near('lowest value', rank(1), 0.125);
near('highest value', rank(4), 0.875);
const tied = MII.percentileRanker([5, 5, 5, 5]);
near('ties share a mid-rank', tied(5), 0.5);

console.log('signal join');
MII.setSignal('social', [
    'manufacturer,model,month,social_score',
    'Porsche,911,2026-04,80',
    'Porsche,911,2026-05,90',
    'BMW,M3,2026-04,40',
].join('\n'));
MII.setSignal('trends', [
    'manufacturer,model,month,trends_interest',
    'Porsche,911,2026-04,55.5',
    'BMW,M3,2026-04,12.25',
].join('\n'));
MII.setSignal('youtube', [
    'manufacturer,model,month,yt_views',
    'Porsche,911,2026-04,1000',
    'Porsche,911,2026-05,2000',
    'BMW,M3,2026-04,300',
].join('\n'));

// A row shaped like the live upstream CSV: trends and youtube empty, sources
// flagged "missing" — the exact state of all 14,807 rows today.
function upstreamRow(extra) {
    return Object.assign({
        manufacturer: 'Porsche', model: '911', quarter: '2026-04',
        price: 100000, bids: 40, views: 50000, comments: 200, age: 30,
        social_score: '', google_trends_interest: '', google_trends_source: 'missing',
        youtube_total_views: '', youtube_source: 'missing',
    }, extra || {});
}

let rows = [upstreamRow(), upstreamRow({ manufacturer: 'BMW', model: 'M3', price: 50000 })];
MII.recompute(rows);
near('social filled from signal file', rows[0].social_score, 80);
near('trends filled where source was "missing"', rows[0].google_trends_interest, 55.5);
near('youtube filled where source was "missing"', rows[0].youtube_total_views, 1000);

// Upstream measurements must win; upstream placeholders must not.
rows = [
    upstreamRow({ social_score: 61, google_trends_interest: 30, google_trends_source: 'estimate' }),
    upstreamRow({ youtube_total_views: 42, youtube_source: 'measured_quarter' }),
];
MII.recompute(rows);
near('upstream social composite is not overwritten', rows[0].social_score, 61);
near('hand-set trends estimate IS overwritten', rows[0].google_trends_interest, 55.5);
near('real upstream youtube measurement is kept', rows[1].youtube_total_views, 42);

// Quarterly rows: a score averages its months, a view count adds them.
rows = [upstreamRow({ quarter: '2026Q2' })];
MII.recompute(rows);
near('score averages over the quarter', rows[0].social_score, 85);
near('views sum over the quarter', rows[0].youtube_total_views, 3000);

console.log('join is idempotent');
rows = [upstreamRow(), upstreamRow({ manufacturer: 'BMW', model: 'M3', price: 50000 })];
MII.recompute(rows);
const first = rows.map(r => r.mii_score);
MII.recompute(rows);
check('recompute twice gives the same scores', rows.map(r => r.mii_score), first);

console.log('data quality');
// Without the signal files these three inputs are dead and their 30% of the
// weight is renormalized away; with them they must report as live.
check('social is live after the join', MII.dataQuality.social_score.status !== 'empty', true);
check('trends is live after the join', MII.dataQuality.google_trends_interest.status !== 'empty', true);
check('youtube is live after the join', MII.dataQuality.youtube_total_views.status !== 'empty', true);

console.log('weights still renormalize when a file is absent');
MII.setSignal('trends', 'manufacturer,model,month,trends_interest\n');
rows = [upstreamRow(), upstreamRow({ manufacturer: 'BMW', model: 'M3', price: 50000 })];
MII.recompute(rows);
check('missing trends file leaves the input empty', MII.dataQuality.google_trends_interest.status, 'empty');
check('scores still land in range', rows.every(r => r.mii_score >= 0 && r.mii_score <= 100), true);

// ---------------------------------------------------------------------------
// v2 methodology
// ---------------------------------------------------------------------------

// A panel big enough for the within-period machinery to have something to
// standardize against: two periods, several makes, varied auction depth.
function panel() {
    const out = [];
    const makes = [
        ['Porsche', '911', 400000, 60, 90000, 300],
        ['Porsche', '944', 40000, 20, 20000, 60],
        ['BMW', 'M3', 70000, 30, 40000, 120],
        ['BMW', '2002', 30000, 15, 15000, 40],
        ['Ferrari', '355', 200000, 45, 70000, 220],
        ['Honda', 'Civic', 12000, 8, 9000, 25],
    ];
    ['2026-03', '2026-04'].forEach((q, qi) => {
        makes.forEach(([man, mod, price, bids, views, comments], i) => {
            const n = (i % 3) + 1;          // 1..3 auctions
            out.push({
                manufacturer: man, model: mod, quarter: q,
                auction_count: n, sold: n,
                // A site-wide traffic surge in the second period: every car's
                // raw counts double. A within-period index must ignore it.
                price: price, bids: bids * (qi + 1), views: views * (qi + 1),
                comments: comments * (qi + 1), age: 20 + i,
                social_score: 50 + i * 5, google_trends_interest: 10 + i * 3,
                google_trends_source: 'google_trends',
                // Measured on 2 of 12 rows: two distinct values, 16.7% coverage.
                // Under the coverage floor, so it must read 'sparse' — present
                // but too thin to score anyone on — rather than 'empty'.
                youtube_total_views: (qi === 0 && i < 2) ? 1000 * (i + 1) : '',
                youtube_source: (qi === 0 && i < 2) ? 'measured' : 'missing',
            });
        });
    });
    return out;
}

console.log('v2 — two indices');
MII.setSignal('trends', 'manufacturer,model,month,trends_interest\n');
MII.setSignal('social', 'manufacturer,model,month,social_score\n');
MII.setSignal('youtube', 'manufacturer,model,month,yt_views\n');
let p2 = panel();
MII.recompute(p2);
check('interest score is published', p2.every(r => typeof r.mii_score === 'number'), true);
check('value score is published', p2.every(r => typeof r.mvi_score === 'number'), true);
check('both indices stay in range',
    p2.every(r => r.mii_score >= 0 && r.mii_score <= 100 && r.mvi_score >= 0 && r.mvi_score <= 100), true);
check('price scores value, not interest',
    MII.COMPONENTS.some(c => c.raw === 'price'), false);
check('age scores neither', MII.COMPONENTS.some(c => c.raw === 'age'), false);
near('interest pillar weights sum to 1',
    MII.INTEREST_PILLARS.reduce((s, p) => s + p.weight, 0), 1, 1e-9);
check('every component names its pillar', MII.COMPONENTS.every(c => !!c.pillar), true);

console.log('v2 — within-period normalization');
// The second period doubled every count. If the index were pooled across
// periods that alone would lift every score; within-period it must not.
const byPeriod = {};
p2.forEach(r => { (byPeriod[r.quarter] = byPeriod[r.quarter] || []).push(r.mii_score); });
const meanOf = a => a.reduce((s, v) => s + v, 0) / a.length;
near('a site-wide traffic surge does not move the index',
    meanOf(byPeriod['2026-04']), meanOf(byPeriod['2026-03']), 1.5);

console.log('v2 — magnitude survives normalization');
// Two cars a hair apart and one an order of magnitude ahead. A plain rank puts
// them one step apart either way; the v2 scale must not.
let mag = ['2026-03'].flatMap(q => [
    { manufacturer: 'A', model: 'a', quarter: q, auction_count: 5, sold: 5, price: 1, bids: 100, views: 100, comments: 10, social_score: 1, google_trends_interest: 1 },
    { manufacturer: 'B', model: 'b', quarter: q, auction_count: 5, sold: 5, price: 1, bids: 101, views: 101, comments: 10, social_score: 1, google_trends_interest: 1 },
    { manufacturer: 'C', model: 'c', quarter: q, auction_count: 5, sold: 5, price: 1, bids: 1000, views: 1000, comments: 10, social_score: 1, google_trends_interest: 1 },
]);
MII.recompute(mag);
const gapAB = Math.abs(mag[1].views_normalized - mag[0].views_normalized);
const gapBC = Math.abs(mag[2].views_normalized - mag[1].views_normalized);
check('a 10x gap outranks a 1% gap', gapBC > gapAB * 5, true);

console.log('v2 — sparse and constant inputs are excluded, not imputed');
p2 = panel();
MII.recompute(p2);
check('youtube is sparse, not scored', MII.dataQuality.youtube_total_views.status, 'sparse');
check('a sparse input is excluded for everyone',
    MII.COMPONENTS.filter(c => c.raw === 'youtube_total_views').length === 1
    && p2.every(r => r.mii_score > 0), true);
check('sell_through is constant, so dead',
    MII.dataQuality.sell_through.status, 'empty');
// Every row is scored on the same formula, so no row can gain from an absence.
check('no row is scored on a private formula',
    p2.every(r => r.mii_score > 0 && r.mii_score < 100), true);

console.log('v2 — shrinkage');
// Same excellent numbers, one backed by a single sale and one by fifty. The
// thin row must be pulled further toward its prior.
let shrink = [];
for (let i = 0; i < 8; i++) {
    shrink.push({ manufacturer: 'Base', model: 'm' + i, quarter: '2026-03', auction_count: 5, sold: 5,
        price: 50000, bids: 20, views: 20000, comments: 50, social_score: 40, google_trends_interest: 10 });
}
shrink.push({ manufacturer: 'Base', model: 'thin', quarter: '2026-03', auction_count: 1, sold: 1,
    price: 90000, bids: 90, views: 90000, comments: 300, social_score: 90, google_trends_interest: 90 });
shrink.push({ manufacturer: 'Base', model: 'thick', quarter: '2026-03', auction_count: 50, sold: 50,
    price: 90000, bids: 90, views: 90000, comments: 300, social_score: 90, google_trends_interest: 90 });
MII.recompute(shrink);
const thin = shrink.find(r => r.model === 'thin'), thick = shrink.find(r => r.model === 'thick');
check('identical evidence, thin row scores lower', thin.mii_score < thick.mii_score, true);
check('thin row reports less of its own evidence', thin.mii_confidence < thick.mii_confidence, true);
check('confidence rises with sample size', thick.mii_confidence > 0.9, true);

console.log('v2 — stated methodology');
check('version is published', /^\d+\.\d+\.\d+$/.test(MII.METHODOLOGY.version), true);
check('base period is recorded', MII.METHODOLOGY.basePeriod, '2026-03');
check('shrinkage constant is published', typeof MII.METHODOLOGY.shrinkageK, 'number');
p2 = panel();
MII.recompute(p2);
check('latest periods are marked provisional',
    p2.filter(r => r.quarter === '2026-04').every(r => r.mii_provisional === true), true);

console.log('v2 — still idempotent');
p2 = panel();
MII.recompute(p2);
const before = p2.map(r => [r.mii_score, r.mvi_score]);
MII.recompute(p2);
check('recompute twice gives the same two indices', p2.map(r => [r.mii_score, r.mvi_score]), before);

console.log(failures ? `\n${failures} test(s) failed` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
