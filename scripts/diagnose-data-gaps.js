#!/usr/bin/env node
/**
 * diagnose-data-gaps.js
 *
 * Fetches bat.csv from S3 and analyses date coverage to identify
 * months and specific days with missing or suspiciously low auction data.
 *
 * Usage:
 *   node scripts/diagnose-data-gaps.js
 *   node scripts/diagnose-data-gaps.js --year 2025
 *   node scripts/diagnose-data-gaps.js --csv /path/to/local/bat.csv
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const BAT_CSV_URL = 'https://my-mii-reports.s3.us-east-2.amazonaws.com/bat.csv';

// ---------- CLI args ----------
const args = process.argv.slice(2);
const yearFilter = (() => {
    const i = args.indexOf('--year');
    return i !== -1 ? args[i + 1] : null;
})();
const localCsv = (() => {
    const i = args.indexOf('--csv');
    return i !== -1 ? args[i + 1] : null;
})();

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

// ---------- Date parsing ----------
// Parses "M/D/YY" or "M/D/YYYY" → { year, month, day, period "YYYY-MM", dayKey "YYYY-MM-DD" }
function parseSaleDate(saleDate) {
    const parts = saleDate.split('/');
    if (parts.length !== 3) return null;
    const monthNum = parseInt(parts[0], 10);
    const dayNum   = parseInt(parts[1], 10);
    const yearPart = parts[2].trim();
    const year = yearPart.length === 2 ? '20' + yearPart : yearPart;
    if (isNaN(monthNum) || isNaN(dayNum) || isNaN(parseInt(year, 10))) return null;
    const month  = String(monthNum).padStart(2, '0');
    const day    = String(dayNum).padStart(2, '0');
    return {
        year,
        month,
        day,
        period: `${year}-${month}`,
        dayKey: `${year}-${month}-${day}`,
    };
}

// ---------- Analysis ----------
function analyse(rows) {
    const monthCounts = {};   // YYYY-MM  → auction count
    const dayCounts   = {};   // YYYY-MM-DD → auction count

    rows.forEach(row => {
        const saleDate = (row.sale_date || '').trim();
        if (!saleDate) return;
        const parsed = parseSaleDate(saleDate);
        if (!parsed) return;
        if (yearFilter && parsed.year !== yearFilter) return;

        monthCounts[parsed.period] = (monthCounts[parsed.period] || 0) + 1;
        dayCounts[parsed.dayKey]   = (dayCounts[parsed.dayKey]   || 0) + 1;
    });

    const sortedMonths = Object.keys(monthCounts).sort();
    if (!sortedMonths.length) {
        console.log('No data found (check --year filter or CSV content).');
        return;
    }

    // Median monthly count
    const countValues = sortedMonths.map(m => monthCounts[m]);
    const sortedCounts = [...countValues].sort((a, b) => a - b);
    const median = sortedCounts[Math.floor(sortedCounts.length / 2)];
    const mean   = countValues.reduce((s, v) => s + v, 0) / countValues.length;

    // Flag threshold: < 50% of median
    const LOW_THRESHOLD = 0.5;

    // Print header
    const firstDay = Object.keys(dayCounts).sort()[0];
    const lastDay  = Object.keys(dayCounts).sort().reverse()[0];
    console.log('\n========================================');
    console.log('  MII Auction Data Gap Report');
    console.log('========================================');
    console.log(`  Data range  : ${firstDay}  →  ${lastDay}`);
    console.log(`  Total months: ${sortedMonths.length}`);
    console.log(`  Total days  : ${Object.keys(dayCounts).length} with data`);
    console.log(`  Median/month: ${Math.round(median)} auctions`);
    console.log(`  Mean/month  : ${Math.round(mean)} auctions`);
    console.log('');

    // ---------- Monthly summary ----------
    console.log('--- Monthly Auction Counts ---');
    console.log(padR('Month', 10) + padL('Auctions', 10) + padL('% of Med', 10) + '  Status');
    console.log('-'.repeat(45));

    const lowMonths = [];
    sortedMonths.forEach(m => {
        const cnt = monthCounts[m];
        const pct = median > 0 ? Math.round((cnt / median) * 100) : 0;
        const isLow = cnt < median * LOW_THRESHOLD;
        if (isLow) lowMonths.push(m);
        const flag = isLow ? '  *** LOW ***' : '';
        console.log(padR(m, 10) + padL(String(cnt), 10) + padL(pct + '%', 10) + flag);
    });
    console.log('');

    // ---------- Missing days within each month ----------
    console.log('--- Missing Days Per Month (days with 0 auction records) ---');

    sortedMonths.forEach(m => {
        const [y, mo] = m.split('-').map(Number);
        const daysInMonth = new Date(y, mo, 0).getDate();
        const missingDays = [];
        for (let d = 1; d <= daysInMonth; d++) {
            const dayKey = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            if (!dayCounts[dayKey]) missingDays.push(dayKey);
        }
        const isLow = monthCounts[m] < median * LOW_THRESHOLD;
        const marker = isLow ? ' [LOW]' : '';
        console.log(`  ${m}${marker}: ${missingDays.length} missing days / ${daysInMonth} total`);
        if (missingDays.length > 0 && missingDays.length <= daysInMonth) {
            // Print in groups of 7 for readability
            for (let i = 0; i < missingDays.length; i += 7) {
                console.log('    ' + missingDays.slice(i, i + 7).join('  '));
            }
        }
    });
    console.log('');

    // ---------- Summary of flagged months ----------
    if (lowMonths.length === 0) {
        console.log('No months flagged as suspiciously low (all >= 50% of median).');
    } else {
        console.log(`--- Flagged Months (< 50% of median = < ${Math.round(median * LOW_THRESHOLD)} auctions) ---`);
        lowMonths.forEach(m => {
            console.log(`  ${m}: ${monthCounts[m]} auctions  (${Math.round((monthCounts[m] / median) * 100)}% of median)`);
        });
        console.log('');
        console.log('Recommendation: Run backfill-checker.js for each flagged month to get');
        console.log('a list of specific missing dates to re-scrape.');
        console.log('  Example: node scripts/backfill-checker.js 2025-01-01 2025-01-31');
    }
    console.log('========================================\n');
}

// ---------- Padding helpers ----------
function padR(s, n) { return String(s).padEnd(n); }
function padL(s, n) { return String(s).padStart(n); }

// ---------- Main ----------
async function main() {
    let text;
    if (localCsv) {
        console.log(`Reading local CSV: ${localCsv}`);
        text = fs.readFileSync(path.resolve(localCsv), 'utf8');
    } else {
        console.log(`Fetching ${BAT_CSV_URL} …`);
        text = await fetchText(BAT_CSV_URL);
    }

    const rows = parseCSV(text);
    console.log(`Parsed ${rows.length} rows.`);
    analyse(rows);
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
