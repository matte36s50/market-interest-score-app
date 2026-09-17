#!/usr/bin/env node
// Fail the signals run when a collector is producing nothing.
//
// The Reddit collector has written zero rows for its entire life and the
// pipeline reported success every time, because a collector with no
// credentials exits 0 by design:
//
//   $ python data/pipelines/reddit_signals.py
//   REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET are not set — skipping Reddit collection.
//   exit 0, 0.07s
//
// That is the right behaviour for the script — a missing optional input should
// not break the run — but it means an unset secret looks exactly like a healthy
// collector from the outside. Reddit is 30% of the social composite's mention
// volume and 25% of its engagement rate; it has contributed neither, silently,
// for months.
//
// So the severity is split:
//   not configured        -> WARNING, naming the secret to set. Expected if you
//                            have deliberately not enabled that collector.
//   configured but empty  -> ERROR. Credentials exist and nothing came back,
//                            which is a real failure.
//   stale                 -> ERROR. It collected once and has since stopped.
//
// Usage: node scripts/check-signal-coverage.js [--max-age-days 45]

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');

// file, the env vars it needs, and how much of the universe it should reach.
const SIGNALS = [
    { name: 'Google Trends', file: 'google_trends.csv', envAny: ['SERPAPI_API_KEY'],
      optionalEnv: true, minModels: 500 },
    { name: 'YouTube', file: 'youtube_signals.csv', envAll: ['YOUTUBE_API_KEY'],
      minModels: 50 },
    { name: 'Reddit', file: 'reddit_signals.csv',
      envAll: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'], minModels: 50 },
    { name: 'Social composite', file: 'social_signals.csv', minModels: 500 },
];

const argv = process.argv.slice(2);
const maxAgeDays = Number((argv[argv.indexOf('--max-age-days') + 1]) || 45);

function parseLine(line) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
        else if (ch === '"') q = true;
        else if (ch === ',') { out.push(cur); cur = ''; }
        else cur += ch;
    }
    out.push(cur); return out;
}

function readSignal(file) {
    const p = path.join(DATA, file);
    if (!fs.existsSync(p)) return { exists: false, rows: 0, models: 0, latest: null };
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return { exists: true, rows: 0, models: 0, latest: null };
    const hdr = parseLine(lines[0]);
    const iMan = hdr.indexOf('manufacturer'), iMod = hdr.indexOf('model'), iMonth = hdr.indexOf('month');
    const models = new Set();
    let latest = null;
    for (let i = 1; i < lines.length; i++) {
        const c = parseLine(lines[i]);
        if (iMan >= 0 && iMod >= 0) models.add(`${(c[iMan] || '').trim()}|${(c[iMod] || '').trim()}`);
        if (iMonth >= 0) { const m = (c[iMonth] || '').trim(); if (m && (!latest || m > latest)) latest = m; }
    }
    return { exists: true, rows: lines.length - 1, models: models.size, latest };
}

// Months between a YYYY-MM label and today, so "stale" does not depend on the
// day of the month a monthly collector happens to run.
function monthsOld(label) {
    const m = /^(\d{4})-(\d{2})$/.exec(label || '');
    if (!m) return null;
    const now = new Date();
    return (now.getFullYear() - +m[1]) * 12 + (now.getMonth() + 1 - +m[2]);
}

const annotate = (level, msg) => {
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`::${level} ::${msg}`);
    console.log(msg);
};

let failed = 0, warned = 0;
console.log('Signal collector coverage\n');

for (const s of SIGNALS) {
    const info = readSignal(s.file);
    const need = s.envAll || s.envAny || [];
    const haveAll = (s.envAll || []).every(v => (process.env[v] || '').trim());
    const haveAny = (s.envAny || []).some(v => (process.env[v] || '').trim());
    const configured = need.length === 0 || (s.envAll ? haveAll : haveAny);

    const summary = `${s.name}: ${info.rows.toLocaleString()} rows, ${info.models.toLocaleString()} models`
        + (info.latest ? `, latest ${info.latest}` : ', no dated rows');

    if (!configured && !s.optionalEnv) {
        warned++;
        annotate('warning', `${summary} — NOT CONFIGURED. Set ${need.join(' and ')} `
            + `in Settings → Secrets and variables → Actions. Until then this collector `
            + `exits immediately and its share of the composite is renormalized away.`);
        continue;
    }

    if (info.models < s.minModels) {
        failed++;
        annotate('error', `${summary} — reached fewer than ${s.minModels} models`
            + (configured && need.length
                ? `, although ${need.join(' and ')} ${need.length > 1 ? 'are' : 'is'} set. `
                  + `Credentials exist and nothing is coming back.`
                : '.'));
        continue;
    }

    const age = monthsOld(info.latest);
    if (age !== null && age > Math.ceil(maxAgeDays / 30)) {
        failed++;
        annotate('error', `${summary} — newest month is ${age} months old; this collector has stopped.`);
        continue;
    }
    console.log(`✓ ${summary}`);
}

console.log(`\n${failed} failing, ${warned} unconfigured`);
process.exit(failed ? 1 : 0);
