#!/usr/bin/env node
/**
 * clean-bat-data.js
 *
 * Fetches bat.csv (from S3 or a local --csv path) and removes rows whose
 * sale_date is corrupt — i.e. it does not parse to a plausible recent year.
 *
 * The most common offender is the Unix-epoch sentinel "12/31/69" (and "1/1/70"),
 * which appears when the source sale_date was null and defaulted to the epoch.
 * Those rows carry a real make/model/price but an unusable date, so they get
 * silently dropped everywhere downstream — which both hides the sale and
 * creates a phantom "2069-12" month in the gap report. This script makes the
 * cleanup explicit: it writes a cleaned CSV and prints exactly which rows were
 * removed so they can be re-scraped with a correct date.
 *
 * Usage:
 *   node scripts/clean-bat-data.js                       # fetch S3, write bat.cleaned.csv
 *   node scripts/clean-bat-data.js --csv /path/bat.csv   # use a local file
 *   node scripts/clean-bat-data.js --out /path/out.csv   # choose output path
 *   node scripts/clean-bat-data.js --dry-run             # report only, write nothing
 *
 * Note: this writes a local cleaned CSV. Re-uploading it to S3 (and re-scraping
 * the reported rows) requires your own pipeline credentials.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const BAT_CSV_URL = 'https://my-mii-reports.s3.us-east-2.amazonaws.com/bat.csv';

// ---------- CLI args ----------
const args = process.argv.slice(2);
const getArg = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const localCsv = getArg('--csv');
const outPath = getArg('--out');
const dryRun = args.includes('--dry-run');

// ---------- Fetch helper ----------
function fetchText(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        }).on('error', reject);
    });
}

// ---------- CSV line split (handles quoted commas) ----------
function splitCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') inQuotes = !inQuotes;
        else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
        else current += ch;
    }
    result.push(current);
    return result;
}

// Classify a sale_date into one of three states:
//   'valid'   — parses to a plausible recent year
//   'corrupt' — a date IS present but is nonsense (epoch sentinel "12/31/69",
//               implausible year, impossible month/day). These get removed.
//   'undated' — blank/empty. Usually a still-running or unsold listing that
//               legitimately has no sale date yet. These are kept and reported,
//               never deleted.
function classifySaleDate(saleDate) {
    const s = (saleDate || '').trim();
    if (!s) return 'undated';
    const parts = s.split('/');
    if (parts.length !== 3) return 'corrupt';
    const monthNum = parseInt(parts[0], 10);
    const dayNum = parseInt(parts[1], 10);
    const yearPart = parts[2].trim();
    const year = parseInt(yearPart.length === 2 ? '20' + yearPart : yearPart, 10);
    if (isNaN(monthNum) || isNaN(dayNum) || isNaN(year)) return 'corrupt';
    if (monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > 31) return 'corrupt';
    if (year < 2020 || year > new Date().getFullYear() + 1) return 'corrupt';
    return 'valid';
}

async function main() {
    let text;
    if (localCsv) {
        process.stderr.write(`Reading local CSV: ${localCsv}\n`);
        text = fs.readFileSync(path.resolve(localCsv), 'utf8');
    } else {
        process.stderr.write(`Fetching ${BAT_CSV_URL} …\n`);
        text = await fetchText(BAT_CSV_URL);
    }

    const lines = text.split('\n');
    const header = lines[0];
    const headerCols = splitCSVLine(header).map(h => h.trim());
    const dateIdx = headerCols.indexOf('sale_date');
    const makeIdx = headerCols.indexOf('make');
    const modelIdx = headerCols.indexOf('model');
    const amtIdx = headerCols.indexOf('sale_amount');
    const urlIdx = headerCols.indexOf('auction_url');
    if (dateIdx === -1) {
        console.error('Could not find "sale_date" column in header.');
        process.exit(1);
    }

    const keptLines = [header];
    const removed = [];   // present-but-corrupt dates → dropped
    let undatedCount = 0; // blank dates → kept, reported as a count
    const summarize = (values) => ({
        sale_date: (values[dateIdx] || '').trim() || '(empty)',
        make: (values[makeIdx] || '').trim(),
        model: (values[modelIdx] || '').trim(),
        amount: (values[amtIdx] || '').trim(),
        url: (values[urlIdx] || '').trim()
    });
    for (let i = 1; i < lines.length; i++) {
        const raw = lines[i];
        if (!raw.trim()) continue;
        const values = splitCSVLine(raw);
        const state = classifySaleDate(values[dateIdx]);
        if (state === 'corrupt') {
            removed.push(summarize(values));
        } else {
            if (state === 'undated') undatedCount++;
            keptLines.push(raw);
        }
    }

    // ---------- Report ----------
    process.stderr.write('\n========================================\n');
    process.stderr.write('  bat.csv corrupt-date cleanup\n');
    process.stderr.write('========================================\n');
    process.stderr.write(`  Total data rows  : ${keptLines.length - 1 + removed.length}\n`);
    process.stderr.write(`  Kept             : ${keptLines.length - 1}\n`);
    process.stderr.write(`  Removed (corrupt): ${removed.length}\n`);
    process.stderr.write(`  Undated (kept)   : ${undatedCount}  (blank sale_date — usually live/unsold listings)\n\n`);

    if (removed.length) {
        process.stderr.write('--- Removed rows (corrupt date present; re-scrape with a correct sale_date) ---\n');
        removed.forEach(r => {
            process.stderr.write(`  date="${r.sale_date}"  ${r.make} ${r.model}  ${r.amount}\n`);
            if (r.url) process.stderr.write(`     ${r.url}\n`);
        });
        process.stderr.write('\n');
    } else {
        process.stderr.write('No corrupt-date rows found — nothing to remove.\n\n');
    }

    if (dryRun) {
        process.stderr.write('Dry run — no file written.\n');
        return;
    }

    const resolvedOut = outPath
        ? path.resolve(outPath)
        : (localCsv ? path.join(path.dirname(path.resolve(localCsv)), 'bat.cleaned.csv')
                    : path.resolve(process.cwd(), 'bat.cleaned.csv'));
    fs.writeFileSync(resolvedOut, keptLines.join('\n'));
    process.stderr.write(`Wrote cleaned CSV (${keptLines.length - 1} rows) to:\n  ${resolvedOut}\n`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
