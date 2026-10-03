#!/usr/bin/env node
// Tests for the attention-share signal in mii-share.js.
//
// Run: node scripts/test-mii-share.js

const { MIIShare } = require('../mii-share.js');

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
    const ok = actual != null && Math.abs(actual - expected) <= (tol === undefined ? 1e-9 : tol);
    if (!ok) {
        failures++;
        console.log(`  FAIL ${name}\n       expected ~${expected}\n       actual    ${actual}`);
    } else {
        console.log(`  ok   ${name}`);
    }
}

console.log('tracker');
const t = MIIShare.createTracker();
check('empty tracker has no data', t.hasData(), false);
t.add('Porsche', 'porsche|911', '2026-08', 600);
t.add('Porsche', 'porsche|944', '2026-08', 200);
t.add('Ford', 'ford|bronco', '2026-08', 200);
t.add('Porsche', 'porsche|911', '2026-09', 300);
t.add('Ford', 'ford|bronco', '2026-09', 700);
t.add('Ford', 'ford|bronco', '2026-09', null);      // blank watchers: skipped, not zero
t.add('Citroen', 'citroen|ds', '2026-09', 0);
near('make share within one month', t.makeShare('Porsche', ['2026-08']), 0.8);
near('make share sums across months', t.makeShare('Porsche', ['2026-08', '2026-09']), 0.55);
near('make key ignores case', t.makeShare('PORSCHE', ['2026-08']), 0.8);
near('make key ignores accents', t.makeShare('Citroën', ['2026-09']), 0);
check('no data in the period is null, not zero', t.makeShare('Porsche', ['2025-01']), null);
near('model share is of its make', t.modelShareOfMake('Porsche', 'porsche|911', ['2026-08']), 0.75);
check('make with no watchers gives null model share', t.modelShareOfMake('Citroen', 'citroen|ds', ['2026-09']), null);

console.log('attach');
const quarterData = {
    '2026-08': { manufacturers: [{ make: 'Porsche', models: [{ model: '911' }, { model: '944' }] }] },
    '2026-09-MTD': { manufacturers: [{ make: 'Porsche', models: [{ model: '911' }] }] },
};
MIIShare.attach(quarterData, t, {
    monthsFor: k => [k.replace('-MTD', '')],
    previous: k => (k === '2026-09-MTD' ? '2026-08' : null),
    modelKey: (make, model) => `${make}|${model}`,
});
const aug = quarterData['2026-08'].manufacturers[0];
const sep = quarterData['2026-09-MTD'].manufacturers[0];
near('August share', aug.share, 0.8);
check('first period has no change', aug.shareChange, null);
near('September share', sep.share, 0.3);
near('change is in percentage points', sep.shareChange, -50);
near('model share of make attached', aug.models[1].shareOfMake, 0.25);

console.log('format');
check('large share one decimal', MIIShare.format(0.1742), '17.4%');
check('small share two decimals', MIIShare.format(0.0042), '0.42%');
check('tiny share', MIIShare.format(0.00001), '<0.01%');
check('unknown share', MIIShare.format(null), '—');
check('positive change', MIIShare.formatChange(1.24), '+1.2 pts');
check('small negative change', MIIShare.formatChange(-0.042), '−0.04 pts');
check('change that rounds to zero is blank', MIIShare.formatChange(0.001), '');

if (failures) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
}
console.log('\nall passed');
