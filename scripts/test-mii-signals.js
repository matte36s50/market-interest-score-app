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

console.log(failures ? `\n${failures} test(s) failed` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
