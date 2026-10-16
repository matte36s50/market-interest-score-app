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
    'manufacturer,model,month,yt_views,yt_view_share',
    'Porsche,911,2026-04,1000,1.5',
    'Porsche,911,2026-05,2000,2.25',
    'BMW,M3,2026-04,300,0',
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
near('youtube filled where source was "missing"', rows[0].youtube_total_views, 1.5);
near('a measured zero is kept as zero', rows[1].youtube_total_views, 0);

// Upstream measurements must win; upstream placeholders must not.
rows = [
    upstreamRow({ social_score: 61, google_trends_interest: 30, google_trends_source: 'estimate' }),
    upstreamRow({ youtube_total_views: 42, youtube_source: 'measured_quarter' }),
];
MII.recompute(rows);
near('upstream social composite is not overwritten', rows[0].social_score, 61);
near('hand-set trends estimate IS overwritten', rows[0].google_trends_interest, 55.5);
// Upstream's raw view count is in different units from the share.
near('upstream raw youtube views are replaced by the share', rows[1].youtube_total_views, 1.5);

// Quarterly rows: a score averages its months, a view count adds them.
rows = [upstreamRow({ quarter: '2026Q2' })];
MII.recompute(rows);
near('score averages over the quarter', rows[0].social_score, 85);
near('shares sum over the quarter', rows[0].youtube_total_views, 3.75);

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

console.log('non-vehicle lot filter');
// BAT files wheels/seats/engines under the car's own make and model. The test
// is BAT's own category, so replicas and year-less slugs stay counted as cars.
check('a car is a vehicle', MII.isVehicleLot({ category: 'Convertibles' }), true);
check('a blank category is a vehicle', MII.isVehicleLot({ category: '' }), true);
check('a missing category is a vehicle', MII.isVehicleLot({}), true);
check('Parts is not a vehicle', MII.isVehicleLot({ category: 'Parts' }), false);
check('Wheels is not a vehicle', MII.isVehicleLot({ category: 'Wheels' }), false);
check('category match ignores case and padding',
    MII.isVehicleLot({ category: '  parts ' }), false);
check('a replica with no year in its slug is still a vehicle',
    MII.isVehicleLot({ category: '', auction_url: 'https://bringatrailer.com/listing/superformance-mkiii-50/' }), true);
check('a null row is not a vehicle', MII.isVehicleLot(null), false);
const lot = (slug, extra) => ({ category: '', make: 'Porsche', auction_url: `https://bringatrailer.com/listing/${slug}/`, ...extra });
check('memorabilia under Parts and Automobilia is not a vehicle, whatever its category',
    MII.isVehicleLot(lot('gmc-trucks-double-sided-porcelain-sign', { make: 'Parts and Automobilia', category: 'Truck & 4x4' })), false);
check('a loose engine filed under a model is not a vehicle', MII.isVehicleLot(lot('engine-355')), false);
check('nor a set of seats', MII.isVehicleLot(lot('seats-198')), false);
check('nor a sign with a model in its name', MII.isVehicleLot(lot('chevrolet-tailgate-neon-sign')), false);
check('nor wheels for a car', MII.isVehicleLot(lot('18x8-5-and-18x10-5-bbs-wheels-for-ferrari-550-maranello-2')), false);
check('a hardtop body style with no leading year is still a car',
    MII.isVehicleLot(lot('427-powered-1965-pontiac-tempest-lemans-hardtop')), true);
check('a dated title is a car even if it names a part',
    MII.isVehicleLot(lot('1971-porsche-911t-with-spare-engine')), true);

console.log('methodology version + effective weights');
check('a version is published', typeof MII.VERSION === 'string' && /^\d{4}\.\d{2}$/.test(MII.VERSION), true);
rows = [upstreamRow(), upstreamRow({ manufacturer: 'BMW', model: 'M3', price: 50000 })];
MII.recompute(rows);
const ew = MII.effectiveWeights;
check('one entry per input', ew.length, MII.COMPONENTS.length);
// Renormalization moves weight between inputs but never creates or destroys it.
near('effective weights sum to 1', ew.reduce((s, w) => s + w.effective, 0), 1, 1e-9);
check('an input on every row keeps at least its nominal weight',
    ew.filter(w => w.coverage === 1).every(w => w.effective >= w.nominal - 1e-9), true);
check('an input on no row carries no weight',
    ew.filter(w => w.coverage === 0).every(w => w.effective === 0), true);

console.log('noise floor');
// Bigger samples must never be allowed a larger noise allowance than smaller ones.
const bands = MII.NOISE_FLOOR.slice().sort((a, b) => a.minLots - b.minLots);
check('median swing falls as sample size rises',
    bands.every((b, i) => i === 0 || b.median <= bands[i - 1].median), true);
check('p90 is always above the median', bands.every(b => b.p90 > b.median), true);
check('one lot a month is the noisiest band', MII.noiseFloor(1).median, 10.5);
check('fifteen lots is the quietest band', MII.noiseFloor(21).median, 4);
check('a 3-point move on one lot is noise', MII.moveStrength(3, 1), 'noise');
check('a 12-point move on 21 lots is signal', MII.moveStrength(12, 21), 'signal');
check('sign is ignored — a fall is judged like a rise',
    MII.moveStrength(-12, 21), MII.moveStrength(12, 21));
check('a move between median and p90 reads as weak', MII.moveStrength(6, 21), 'weak');

console.log('ranked within the month');
// Two months of 40 cars each. October's market is busier (every car drew ten
// times the views), but each car holds the same place in its own month, so it
// must get the same views rank in both.
function monthRows(month, scale) {
    return Array.from({ length: 40 }, (_, i) => ({
        manufacturer: 'Make', model: `Model ${i}`, quarter: month,
        price: String(10000 + i * 1000), views: String((i + 1) * 100 * scale),
        bids: '10', comments: '5', age: '30',
    }));
}
rows = [...monthRows('2026-09', 1), ...monthRows('2026-10', 10)];
MII.recompute(rows);
const sep = rows.filter(r => r.quarter === '2026-09'), oct = rows.filter(r => r.quarter === '2026-10');
check('the same place in a busier month gets the same rank',
    sep.map(r => r.views_normalized), oct.map(r => r.views_normalized));
near('the median car of each month ranks about 0.5',
    sep.reduce((s, r) => s + r.views_normalized, 0) / sep.length, 0.5, 1e-9);
check('a busier month does not lift its scores',
    sep.map(r => r.mii_score), oct.map(r => r.mii_score));
// A month with too few measurements of an input falls back to the whole field
// rather than ranking a handful of cars against each other.
rows = [...monthRows('2026-09', 1), { manufacturer: 'Make', model: 'Lone', quarter: '2026-10',
    price: '10000', views: '100', bids: '10', comments: '5', age: '30' }];
MII.recompute(rows);
const field = MII.percentileRanker(rows.map(r => +r.views));
near('a thin month is ranked against the whole field',
    rows[rows.length - 1].views_normalized, field(100), 1e-6);
near('a full month is still ranked within itself',
    rows[0].views_normalized, MII.percentileRanker(sep.map(r => +r.views))(100), 1e-6);

console.log('model list');
// The same key as model_key in model_list.py, on the cases that matter.
check('case and brand prefix fold together',
    MII.modelKey('Volkswagen', 'VOLKSWAGEN TIGUAN'), MII.modelKey('volkswagen', 'Tiguan'));
check('a year range suffix is dropped',
    MII.modelKey('Ford', 'Ford F-Series (1967-1972)'), 'ford|f-series');
check('Datsun files under Nissan', MII.modelKey('Datsun', 'Datsun 240Z'), 'nissan|240z');
MII.setModels([
    'manufacturer,source_model,model,rule,flag,auctions',
    'Volkswagen,Volkswagen Tiguan,Volkswagen Tiguan,same,,5',
    'Volkswagen,TIGUAN,Volkswagen Tiguan,case or prefix,,9',
    'Porsche,996 Turbo,996 911 Turbo,override,,40',
    'Porsche,996 911 Turbo,996 911 Turbo,same,,77',
    'Ford,MUSTANG,MUSTANG,same,catch-all,40',
].join('\n'));
check('a duplicate name maps to ours', MII.canonicalModel('Porsche', '996 Turbo'), '996 911 Turbo');
check('a Bring a Trailer spelling maps too', MII.canonicalModel('Volkswagen', 'VOLKSWAGEN TIGUAN'), 'Volkswagen Tiguan');
check('an unknown name passes through', MII.canonicalModel('Porsche', '959'), '959');
check('flags are carried', MII.modelFlag('Ford', 'MUSTANG'), 'catch-all');
rows = [
    { manufacturer: 'Volkswagen', model: 'Volkswagen Tiguan', quarter: '2026-09', auction_count: '1', sold: '1', price: '20000', views: '3000', bids: '10' },
    { manufacturer: 'Volkswagen', model: 'TIGUAN', quarter: '2026-09', auction_count: '3', sold: '2', price: '24000', views: '5000', bids: '14' },
    { manufacturer: 'Volkswagen', model: 'TIGUAN', quarter: '2026-10', auction_count: '2', sold: '2', price: '22000', views: '4000', bids: '12' },
];
MII.canonicalize(rows);
check('a month\'s duplicates become one row', rows.map(r => `${r.model}|${r.quarter}`),
    ['Volkswagen Tiguan|2026-09', 'Volkswagen Tiguan|2026-10']);
check('lots and sales add up', [rows[0].auction_count, rows[0].sold], [4, 3]);
near('averages are weighted by lots', rows[0].price, (20000 * 1 + 24000 * 3) / 4);
check('the source name is kept', rows[1].source_model, 'TIGUAN');
const again = rows.map(r => ({ ...r }));
MII.canonicalize(again);
check('merging twice changes nothing', again, rows);
// A signal written under a duplicate's name still reaches the row.
MII.setSignal('trends', 'manufacturer,model,month,trends_interest\nPorsche,996 Turbo,2026-09,40\nPorsche,996 911 Turbo,2026-09,60');
rows = [{ manufacturer: 'Porsche', model: '996 Turbo', quarter: '2026-09', price: '90000', views: '9000', bids: '30', comments: '50', age: '25' }];
MII.recompute(rows);
check('the row is renamed before the join', rows[0].model, '996 911 Turbo');
near('both names\' values are averaged', rows[0].google_trends_interest, 50);
MII.setModels(null);

console.log('attention');
// 40 models, two months. Model i ranks i-th on every input, except that
// model 0 has no YouTube row (a measured zero) and August has search
// interest for only 10 models (under half its best month), so August is not
// scored at all.
const header = { trends: 'trends_interest', youtube: 'yt_view_share', social: 'social_score' };
const signalCsv = (name, rowsFor) => [`manufacturer,model,month,${header[name]}`, ...rowsFor].join('\n');
const ids = Array.from({ length: 40 }, (_, i) => i);
MII.setSignal('trends', signalCsv('trends', [
    ...ids.map(i => `Make,M${i},2026-09,${i + 1}`),
    ...ids.slice(0, 10).map(i => `Make,M${i},2026-08,${i + 1}`)]));
MII.setSignal('youtube', signalCsv('youtube', ids.filter(i => i > 0).flatMap(i => [`Make,M${i},2026-09,${i}`, `Make,M${i},2026-08,${i}`])));
MII.setSignal('social', signalCsv('social', ids.flatMap(i => [`Make,M${i},2026-09,${i + 1}`, `Make,M${i},2026-08,${i + 1}`])));
near('the top model on every input scores near 100', MII.attentionFor('Make', 'M39', '2026-09'), 100 * (1 - 0.5 / 40), 0.02);
near('a missing YouTube row is a measured zero', MII.attentionFor('Make', 'M0', '2026-09'), 100 * (0.5 / 40), 0.02);
check('a month with an input half-collected is not scored', MII.attentionFor('Make', 'M39', '2026-08'), null);
check('the month in progress suffix is ignored', MII.attentionFor('Make', 'M39', '2026-09-MTD'), MII.attentionFor('Make', 'M39', '2026-09'));
check('an unmeasured model has no reading', MII.attentionFor('Make', 'Nope', '2026-09'), null);

console.log(failures ? `\n${failures} test(s) failed` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
