#!/usr/bin/env node
/**
 * build-bat-lots.js
 *
 * Turns the scraped bat.csv, which stays private, into the two files the
 * dashboard publishes:
 *
 *   data/bat_lots.csv     one row per lot with only what the pages show of it:
 *                         its link, make, model, year, category, sale date,
 *                         amount and outcome. No views, watchers, comments,
 *                         bids, location or seller.
 *   data/market_mii.json  the Market MII (see MII.marketScore) for each class
 *                         and month, and the year to date. It ranks every
 *                         listing's views, watchers, comments and bids, so it
 *                         is computed here, where those are still at hand.
 *
 * The Market MII follows what app.js did in the browser when it read bat.csv
 * itself: the same lot filter, model keys, class of each lot and months, all
 * through mii-normalize.js.
 *
 * Usage:
 *   node scripts/build-bat-lots.js [--bat <path|url>] [--mii <path|url>] [--out-dir <dir>]
 *
 * --bat defaults to $BAT_CSV, then to the bucket URL (which answers only while
 * the object is public). --mii defaults to the published MII results.
 */

const fs = require('fs');
const path = require('path');
const { MII } = require('../mii-normalize.js');

const BAT_CSV_URL = 'https://my-mii-reports.s3.us-east-2.amazonaws.com/bat.csv';
const MII_CSV_URL = 'https://my-mii-reports.s3.us-east-2.amazonaws.com/mii_results_latest.csv';
const ROOT = path.join(__dirname, '..');

// The lot columns the pages read; everything else in bat.csv stays private.
const PUBLIC_COLUMNS = ['auction_url', 'make', 'model', 'year', 'category', 'sale_date', 'sale_amount', 'sale_type'];
// The classes the dashboard offers (index.html #classSeg).
const CLASSES = ['all', 'car', 'motorcycle'];

const args = process.argv.slice(2);
const getArg = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

async function readSource(src) {
    if (/^https?:\/\//.test(src)) {
        const res = await fetch(src);
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${src}`);
        return res.text();
    }
    return fs.readFileSync(path.resolve(src), 'utf8');
}

// RFC 4180 CSV: quoted fields may hold commas, doubled quotes and newlines.
function parseCsv(text) {
    const rows = [];
    let row = [], cur = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQ) {
            if (ch === '"') {
                if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
            } else cur += ch;
        } else if (ch === '"') inQ = true;
        else if (ch === ',') { row.push(cur); cur = ''; }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            row.push(cur); rows.push(row); row = []; cur = '';
        } else cur += ch;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    const header = (rows.shift() || []).map(h => h.trim());
    return rows
        .filter(r => r.some(c => c.trim() !== ''))
        .map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Same parsing as app.js, so the lots land in the same months.
function parseBatNumber(raw) {
    const m = (raw || '').toString().match(/([\d,]+(?:\.\d+)?)/);
    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
}
function parseSaleDate(saleDate) {
    const parts = (saleDate || '').trim().split('/');
    if (parts.length !== 3) return null;
    const monthNum = parseInt(parts[0], 10);
    const dayNum = parseInt(parts[1], 10);
    const yearPart = parts[2].trim();
    const year = parseInt(yearPart.length === 2 ? '20' + yearPart : yearPart, 10);
    if (isNaN(monthNum) || isNaN(dayNum) || isNaN(year)) return null;
    if (year < 2020 || year > new Date().getFullYear() + 1) return null;
    return { period: `${year}-${String(monthNum).padStart(2, '0')}` };
}
const modelJoinKey = (make, model) => MII.modelKey(make, MII.canonicalModel(make, model));

// The class a lot belongs to: its model's, from the MII rows, or for a model
// that never sold (so has no row), Bring a Trailer's own category.
function classOfLot(keyClass, key, lot) {
    return keyClass.get(key) || (lot.category === 'Motorcycles' ? 'motorcycle' : 'car');
}

// One class's Market MII for each of its months and the year to date: every
// vehicle listing in the class, sold or not, ranked against every listing of
// the reference year. When the data does not reach back to most of the
// reference year, the first twelve complete months stand in for it.
function marketLevels(lots, rawMonths) {
    const out = { ref: null, ytd_year: null, levels: {} };
    if (!rawMonths.length) return out;
    const byMonth = new Map(rawMonths.map(m => [m, []]));
    lots.forEach(l => byMonth.get(l.period)?.push(l));
    const latest = rawMonths[rawMonths.length - 1];
    const { from, to } = MII.MARKET_REFERENCE;
    let refMonths = rawMonths.filter(m => m >= from && m <= to && m !== latest);
    if (refMonths.length < 6) refMonths = rawMonths.filter(m => m !== latest).slice(0, 12);
    const refLots = refMonths.flatMap(m => byMonth.get(m));
    if (!refLots.length) return out;
    const ref = MII.marketReference(refLots);
    const round = s => Object.fromEntries(Object.entries(s).map(([k, v]) =>
        [k, typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v]));
    rawMonths.forEach(m => { out.levels[m] = round(MII.marketScore(byMonth.get(m), ref)); });
    const year = latest.slice(0, 4);
    const ytd = rawMonths.filter(m => m.startsWith(year));
    out.levels.YTD = round(MII.marketScore(ytd.flatMap(m => byMonth.get(m)), ref));
    out.ytd_year = year;
    out.ref = { from: refMonths[0], to: refMonths[refMonths.length - 1] };
    return out;
}

async function main() {
    const batSrc = getArg('--bat') || process.env.BAT_CSV || BAT_CSV_URL;
    const miiSrc = getArg('--mii') || MII_CSV_URL;
    const outDir = path.resolve(getArg('--out-dir') || path.join(ROOT, 'data'));

    MII.setModels(fs.readFileSync(path.join(ROOT, 'data', 'models.csv'), 'utf8'));
    const [batRows, miiRows] = await Promise.all([readSource(batSrc).then(parseCsv), readSource(miiSrc).then(parseCsv)]);
    if (!batRows.length || !('auction_url' in batRows[0])) throw new Error(`no bat.csv rows read from ${batSrc}`);
    if (!miiRows.length) throw new Error(`no MII rows read from ${miiSrc}`);

    // The lot list.
    const lines = [PUBLIC_COLUMNS.join(',')];
    batRows.forEach(r => {
        const cells = PUBLIC_COLUMNS.map(c => (r[c] || '').trim());
        if (cells.some(Boolean)) lines.push(cells.map(csvCell).join(','));
    });
    fs.writeFileSync(path.join(outDir, 'bat_lots.csv'), lines.join('\n') + '\n');

    // The MII rows as app.js holds them, for each model's class and each
    // class's months.
    MII.canonicalize(miiRows);
    const keyClass = new Map();
    miiRows.forEach(r => {
        const c = (r.vehicle_class || '').trim();
        if (c) keyClass.set(modelJoinKey(r.manufacturer, r.model), c);
    });
    const valid = miiRows.filter(r => /^\d{4}(-\d{2}|Q[1-4])$/.test(String(r.quarter || '').trim())
        && r.manufacturer && r.model && isFinite(parseFloat(r.mii_score)));

    const lots = [];
    batRows.forEach(row => {
        const make = (row.make || '').trim();
        const rawModel = (row.model || '').trim();
        // Memorabilia and hard parts are filed under the car's own
        // make/model; they are not auctions of the car.
        if (!MII.isVehicleLot(row)) return;
        if (!make || !rawModel) return;
        const parsed = parseSaleDate(row.sale_date);
        if (!parsed) return;
        const key = modelJoinKey(make, rawModel);
        const lot = {
            period: parsed.period,
            views: parseBatNumber(row.views),
            watchers: parseBatNumber(row.watchers),
            bids: parseBatNumber(row.bids),
            comments: parseBatNumber(row.comments),
            category: (row.category || '').trim(),
        };
        lot.vclass = classOfLot(keyClass, key, lot);
        lots.push(lot);
    });

    const classes = {};
    CLASSES.forEach(vclass => {
        const rows = vclass === 'all' ? valid : valid.filter(r => (r.vehicle_class || '').trim() === vclass);
        const rawMonths = [...new Set(rows.map(r => r.quarter))].sort();
        classes[vclass] = marketLevels(vclass === 'all' ? lots : lots.filter(l => l.vclass === vclass), rawMonths);
    });
    const market = {
        about: 'Market MII by vehicle class and month: the typical listing\'s views, watchers, comments and bids, '
            + 'ranked against the reference year (MII.marketScore). Built by scripts/build-bat-lots.js.',
        version: MII.VERSION,
        classes,
    };
    fs.writeFileSync(path.join(outDir, 'market_mii.json'), JSON.stringify(market, null, 1) + '\n');

    process.stderr.write(`bat_lots.csv: ${lines.length - 1} lots; market_mii.json: `
        + CLASSES.map(c => `${c} ${Object.keys(classes[c].levels).length - (classes[c].levels.YTD ? 1 : 0)} months`).join(', ') + '\n');
}

main().catch(err => {
    console.error(`build-bat-lots: ${err.message}`);
    process.exit(1);
});
