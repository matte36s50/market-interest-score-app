#!/usr/bin/env node
/**
 * backfill-checker.js
 *
 * Fetches bat.csv from S3, then for a given date range reports which
 * specific dates have NO auction records — i.e. days the scraper likely missed.
 *
 * Usage:
 *   node scripts/backfill-checker.js <start-date> <end-date>
 *   node scripts/backfill-checker.js 2025-01-01 2025-01-31
 *   node scripts/backfill-checker.js 2025-01-01 2025-01-31 --csv /path/to/local/bat.csv
 *
 * Output:
 *   Prints each missing date, one per line, so the output can be piped
 *   directly to your scraper's backfill command:
 *     node scripts/backfill-checker.js 2025-01-01 2025-01-31 | xargs -I{} scraper --date {}
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const BAT_CSV_URL = 'https://my-mii-reports.s3.us-east-2.amazonaws.com/bat.csv';

// ---------- CLI args ----------
const args = process.argv.slice(2);
const startArg = args[0];
const endArg   = args[1];

if (!startArg || !endArg) {
    console.error('Usage: node scripts/backfill-checker.js <start-date> <end-date>');
    console.error('  Example: node scripts/backfill-checker.js 2025-01-01 2025-01-31');
    process.exit(1);
}

const localCsv = (() => {
    const i = args.indexOf('--csv');
    return i !== -1 ? args[i + 1] : null;
})();

// Validate dates
const startDate = new Date(startArg);
const endDate   = new Date(endArg);
if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    console.error(`Invalid date(s): "${startArg}" / "${endArg}". Use YYYY-MM-DD format.`);
    process.exit(1);
}
if (startDate > endDate) {
    console.error('Start date must be <= end date.');
    process.exit(1);
}

// ---------- Fetch helpers ----------
function fetchText(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        }).on('error', reject);
    });
}

// ---------- CSV parser (no dependencies) ----------
function parseCSV(text) {
    const lines = text.split('\n');
    if (!lines.length) return [];
    const headers = splitCSVLine(lines[0]);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const values = splitCSVLine(line);
        const row = {};
        headers.forEach((h, idx) => { row[h.trim()] = (values[idx] || '').trim(); });
        rows.push(row);
    }
    return rows;
}

function splitCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            inQuotes = !inQuotes;
        } else if (ch === ',' && !inQuotes) {
            result.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    result.push(current);
    return result;
}

// ---------- Date helpers ----------
function toYMD(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function parseSaleDate(saleDate) {
    const parts = saleDate.split('/');
    if (parts.length !== 3) return null;
    const monthNum = parseInt(parts[0], 10);
    const dayNum   = parseInt(parts[1], 10);
    const yearPart = parts[2].trim();
    const year = yearPart.length === 2 ? '20' + yearPart : yearPart;
    if (isNaN(monthNum) || isNaN(dayNum) || isNaN(parseInt(year, 10))) return null;
    const month = String(monthNum).padStart(2, '0');
    const day   = String(dayNum).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Build set of all dates in range [start, end] inclusive
function buildDateRange(start, end) {
    const dates = [];
    const cur = new Date(start);
    while (cur <= end) {
        dates.push(toYMD(cur));
        cur.setDate(cur.getDate() + 1);
    }
    return dates;
}

// ---------- Analysis ----------
function findMissingDates(rows, start, end) {
    const presentDays = new Set();
    rows.forEach(row => {
        const saleDate = (row.sale_date || '').trim();
        if (!saleDate) return;
        const dayKey = parseSaleDate(saleDate);
        if (dayKey) presentDays.add(dayKey);
    });

    const allDates = buildDateRange(start, end);
    return allDates.filter(d => !presentDays.has(d));
}

// ---------- Main ----------
async function main() {
    let text;
    if (localCsv) {
        process.stderr.write(`Reading local CSV: ${localCsv}\n`);
        text = fs.readFileSync(path.resolve(localCsv), 'utf8');
    } else {
        process.stderr.write(`Fetching ${BAT_CSV_URL} …\n`);
        text = await fetchText(BAT_CSV_URL);
    }

    const rows = parseCSV(text);
    process.stderr.write(`Parsed ${rows.length} rows.\n`);

    const missingDates = findMissingDates(rows, startDate, endDate);

    // Human-readable summary to stderr
    process.stderr.write(`\nRange   : ${toYMD(startDate)} → ${toYMD(endDate)}\n`);
    process.stderr.write(`Total   : ${buildDateRange(startDate, endDate).length} days in range\n`);
    process.stderr.write(`Missing : ${missingDates.length} days with no auction records\n`);
    process.stderr.write(`Present : ${buildDateRange(startDate, endDate).length - missingDates.length} days with data\n\n`);

    if (missingDates.length === 0) {
        process.stderr.write('No missing dates found in this range.\n');
        return;
    }

    process.stderr.write('Missing dates (output below — pipe to your backfill tool):\n');
    process.stderr.write('---\n');

    // Machine-readable list to stdout (one date per line, pipeable)
    missingDates.forEach(d => console.log(d));
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
