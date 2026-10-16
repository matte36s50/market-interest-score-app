#!/usr/bin/env node
// Tests for hagi-indexes.js: each index is the size HAGI publishes, and every
// model group a constituent maps to is a name in our model list, so a typo
// cannot silently drop a car from its basket.
//
// Run: node scripts/test-hagi-indexes.js

const fs = require('fs');
const path = require('path');
const { HAGI_INDEXES } = require('../hagi-indexes.js');

let failures = 0;
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures++;
    console.log(ok ? `  ok   ${name}` : `  FAIL ${name}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`);
}

console.log('index sizes');
const size = id => HAGI_INDEXES.byId(id).size;
check('BMW CI has 16 cars', size('bmw-ci'), 16);
check('MBCI has 23 cars', size('mbci'), 23);
check('MBCI Emerging Classics has 6 cars', size('mbci-emerging'), 6);

console.log('model groups');
const csv = fs.readFileSync(path.join(__dirname, '..', 'data', 'models.csv'), 'utf8').trim().split('\n');
const header = csv[0].split(',');
const known = new Set();
csv.slice(1).forEach(line => {
    // manufacturer,source_model,model,... with quoted fields where needed
    const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map(c => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
    const row = Object.fromEntries(header.map((h, i) => [h, cells[i]]));
    known.add(`${row.manufacturer}|${row.model}`.toLowerCase());
});
const missing = [];
// A constituent with a note (the 507: too rare to score) is mapped ahead of
// its first sale, so it may not be in the list yet.
HAGI_INDEXES.INDEXES.forEach(idx => idx.constituents.filter(c => !c.note).forEach(c => c.models.forEach(m => {
    if (!known.has(`${idx.make}|${m}`.toLowerCase())) missing.push(`${idx.short}: ${m}`);
})));
// The 300CE-24 also lists Bring a Trailer's own spelling, which only some
// exports carry.
check('every mapped group is in data/models.csv', missing.filter(m => m !== 'MBCI Emerging: 300CE CABRIOLET'), []);

console.log('lookup');
check('a group finds its constituent', HAGI_INDEXES.constituentFor('Mercedes-Benz', 'W113 SL').id, 'w113');
check('and knows its index', HAGI_INDEXES.constituentFor('Mercedes-Benz', 'w113 sl').index.short, 'MBCI');
check('the make must match', HAGI_INDEXES.constituentFor('BMW', 'W113 SL'), null);
check('an Emerging car', HAGI_INDEXES.constituentFor('Mercedes-Benz', '500E & E500').index.id, 'mbci-emerging');

console.log(failures ? `\n${failures} test(s) failed` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
