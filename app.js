// S3 CSV URLs
const CSV_URL = "https://my-mii-reports.s3.us-east-2.amazonaws.com/mii_results_latest.csv";
const BAT_CSV_URL = "https://my-mii-reports.s3.us-east-2.amazonaws.com/bat.csv";

// Lot-level index from bat.csv: "make|normalizedModel" -> array of individual auction records.
// Lets the dashboard drill down from a monthly model average to the individual sales behind it.
let batLots = {};

// Some manufacturers appear under more than one brand name across the two data
// sources: MII files Datsun-era cars under "Nissan" (keeping "Datsun" in the
// model name), while bat.csv files them under make "Datsun". MAKE_ALIASES maps
// every such brand to a single canonical make so the two datasets join up.
const MAKE_ALIASES = {
    'Datsun': 'Nissan',
};

// Canonical make for a raw make/manufacturer value (alias -> canonical).
function canonicalMake(make) {
    return MAKE_ALIASES[make] || make;
}

// Every brand name a canonical make can appear under (itself + its aliases),
// used to strip a leading brand word from model names on both sides.
const MAKE_PREFIXES = (() => {
    const map = {};
    Object.entries(MAKE_ALIASES).forEach(([alias, canon]) => {
        if (!map[canon]) map[canon] = [canon];
        map[canon].push(alias);
    });
    return map;
})();

// Normalize a model name so MII and bat.csv keys line up: canonicalize the make,
// strip any leading brand word it may carry (e.g. "Datsun 240Z" -> "240Z",
// "Porsche LWB 911T" -> "LWB 911T"), and drop year-range suffixes (e.g.
// "(1969-1973)"). Applied identically to both datasets, so case differences and
// alias brands resolve to the same key.
function normalizeModelKey(make, rawModel) {
    const canon = canonicalMake(make);
    let model = rawModel || '';
    const prefixes = MAKE_PREFIXES[canon] || [canon];
    for (const prefix of prefixes) {
        if (model.toLowerCase().startsWith(prefix.toLowerCase() + ' ')) {
            model = model.slice(prefix.length + 1);
            break;
        }
    }
    return model.replace(/\s*\(\d{4}-\d{4}\)$/, '').trim();
}

// The join key for a make/model pair. Case-folded on BOTH halves: the MII
// pipeline title-cases its manufacturer column ("Detomaso", "Amc", "Bsa")
// while bat.csv keeps the source spelling ("DeTomaso", "AMC", "BSA"), and
// bat.csv itself carries the same model under several casings
// ("DeTomaso Vallelunga" and "DETOMASO VALLELUNGA"). Keying on the raw
// strings split those apart, so ~100 models showed "no auction records"
// while their lots sat in a differently-cased bucket. Display names always
// come from the row itself, never from this key.
function modelJoinKey(make, model) {
    return `${canonicalMake(make).toLowerCase()}|${normalizeModelKey(make, model).toLowerCase()}`;
}

// Parse a bat.csv sale_amount string like "USD $56,000" or "EUR €75,000".
// Returns { amount: Number|null, currency: String }.
function parseSaleAmount(raw) {
    const s = (raw || '').trim();
    const currencyMatch = s.match(/^([A-Z]{3})/);
    const currency = currencyMatch ? currencyMatch[1] : (s.includes('€') ? 'EUR' : (s.includes('£') ? 'GBP' : 'USD'));
    const numMatch = s.match(/([\d,]+(?:\.\d+)?)/);
    const amount = numMatch ? parseFloat(numMatch[1].replace(/,/g, '')) : null;
    return { amount: (amount && amount > 0) ? amount : null, currency };
}

// Parse a bat.csv "views"/"watchers"/numeric field like "6,856 views" -> 6856.
function parseBatNumber(raw) {
    const m = (raw || '').toString().match(/([\d,]+(?:\.\d+)?)/);
    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
}

// A sale_date is valid only if it parses to a plausible recent year. This silently
// drops the epoch-sentinel "12/31/69" rows (null source dates) and other corrupt dates
// so they never pollute counts or charts. parseSaleDate returns null for those.
function parseSaleDate(saleDate) {
    const parts = (saleDate || '').trim().split('/');
    if (parts.length !== 3) return null;
    const monthNum = parseInt(parts[0], 10);
    const dayNum = parseInt(parts[1], 10);
    const yearPart = parts[2].trim();
    const year = parseInt(yearPart.length === 2 ? '20' + yearPart : yearPart, 10);
    if (isNaN(monthNum) || isNaN(dayNum) || isNaN(year)) return null;
    if (year < 2020 || year > new Date().getFullYear() + 1) return null;
    const month = String(monthNum).padStart(2, '0');
    const day = String(dayNum).padStart(2, '0');
    return { year: String(year), month, day, period: `${year}-${month}`, dayKey: `${year}-${month}-${day}` };
}

// Build the auction-count map AND the lot-level index from bat.csv in a single pass.
// Returns the counts map ("make|normalizedModel|YYYY-MM" -> count); the lot index is
// stored on the module-global `batLots`.
async function loadBatAuctionCounts() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        const response = await fetch(BAT_CSV_URL, { mode: 'cors', signal: controller.signal, headers: { 'Accept': 'text/csv' } });
        clearTimeout(timeoutId);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();

        return new Promise(resolve => {
            Papa.parse(text, {
                header: true,
                skipEmptyLines: true,
                complete: results => {
                    const counts = {};
                    const lots = {};
                    results.data.forEach(row => {
                        const make = (row.make || '').trim();
                        const rawModel = (row.model || '').trim();
                        // Memorabilia and hard parts are filed under the car's own
                        // make/model; they are not auctions of the car.
                        if (window.MII && !MII.isVehicleLot(row)) return;
                        if (!make || !rawModel) return;

                        const parsed = parseSaleDate(row.sale_date);
                        if (!parsed) return; // drops corrupt/sentinel dates

                        const key = modelJoinKey(make, rawModel);
                        const period = parsed.period;

                        const countKey = `${key}|${period}`;
                        counts[countKey] = (counts[countKey] || 0) + 1;

                        const { amount, currency } = parseSaleAmount(row.sale_amount);
                        const saleType = (row.sale_type || '').trim().toLowerCase();
                        const lotKey = key;
                        (lots[lotKey] = lots[lotKey] || []).push({
                            date: parsed.dayKey,
                            period,
                            amount,
                            currency,
                            sold: saleType === 'sold',
                            saleType: (row.sale_type || '').trim() || 'unknown',
                            url: (row.auction_url || '').trim(),
                            year: parseBatNumber(row.year),
                            views: parseBatNumber(row.views),
                            bids: parseBatNumber(row.bids),
                            comments: parseBatNumber(row.comments)
                        });
                    });
                    // Sort each model's lots chronologically for the scatter/table.
                    Object.values(lots).forEach(arr => arr.sort((a, b) => a.date.localeCompare(b.date)));
                    batLots = lots;
                    resolve(counts);
                },
                error: () => resolve({})
            });
        });
    } catch (e) {
        console.warn('Could not load bat.csv auction counts:', e.message);
        return {};
    }
}

// Inject auction_count into MII rows from bat.csv counts map. The map is
// keyed by month, so sum the months the row's period covers — works for both
// monthly ('2025-05') and quarterly ('2025Q2') MII files. When bat.csv has no
// match, keep the pipeline's own auction_count instead of zeroing the row
// (a key-format mismatch here once blanked the whole leaderboard).
function injectAuctionCounts(rows, batCounts) {
    rows.forEach(row => {
        const prefix = `${modelJoinKey(row.manufacturer, row.model)}|`;
        const period = String(row.quarter || '').trim();
        const months = (window.MII && MII.periodMonths) ? MII.periodMonths(period) : [period];
        let sum = 0, found = false;
        months.forEach(m => {
            const c = batCounts[prefix + m];
            if (c != null) { sum += c; found = true; }
        });
        if (found) row.auction_count = String(sum);
    });
}

// Load and parse the MII results CSV from S3.
async function loadCSVData() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        const response = await fetch(CSV_URL, { mode: 'cors', signal: controller.signal, headers: { 'Accept': 'text/csv' } });
        clearTimeout(timeoutId);

        if (!response.ok) {
            let errorMessage = `HTTP error! status: ${response.status}`;
            if (response.status === 403) {
                errorMessage += ' - Access Denied. Check S3 bucket permissions and CORS configuration.';
            } else if (response.status === 404) {
                errorMessage += ' - File not found. Verify the CSV file exists at the specified URL.';
            }
            throw new Error(errorMessage);
        }

        const csvText = await response.text();
        return new Promise((resolve, reject) => {
            Papa.parse(csvText, {
                header: true,
                skipEmptyLines: true,
                complete: (results) => {
                    if (results.errors.length > 0) {
                        console.warn('CSV parsing errors:', results.errors);
                        if (results.data.length === 0) {
                            reject(new Error('CSV parsing failed: ' + results.errors[0].message));
                            return;
                        }
                    }
                    resolve(results.data);
                },
                error: (error) => reject(new Error('CSV parsing error: ' + error.message))
            });
        });
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error('Request timeout - S3 server did not respond within 15 seconds');
        } else if (error.message.includes('Failed to fetch')) {
            throw new Error('Network error - Unable to reach S3. Check your internet connection or S3 CORS settings.');
        }
        throw error;
    }
}

// ---------------------------------------------------------------------------
// Dataset: MII rows aggregated per month (and year to date) into makes and
// models. One dataset is built per vehicle class, from rows already scored
// against every car of their month (all classes), so a car's MII is the same
// in every view.
// ---------------------------------------------------------------------------

function groupBy(list, keyFn) {
    const map = new Map();
    list.forEach(item => {
        const k = keyFn(item);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(item);
    });
    return map;
}

function mean(values) {
    const v = values.filter(x => x != null && isFinite(x));
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

function median(values) {
    const v = values.filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Median of [value, weight] pairs: the value at which half the weight lies
// on either side. Rows are model-month averages, so weighting each by its lot
// count gives the typical lot rather than the typical model.
function weightedMedian(pairs) {
    const v = pairs.filter(([x, w]) => x != null && isFinite(x) && w > 0).sort((a, b) => a[0] - b[0]);
    const total = v.reduce((s, [, w]) => s + w, 0);
    if (!total) return null;
    let acc = 0;
    for (const [x, w] of v) {
        acc += w;
        if (acc >= total / 2) return x;
    }
    return v[v.length - 1][0];
}

const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };

// Makes and models for one period's rows. Trends are applied afterwards,
// once the period they compare against has been built.
function summarizePeriod(rows, grain) {
    const manufacturers = [...groupBy(rows, r => r.manufacturer)].map(([make, mRows]) => {
        const auctions = mRows.reduce((s, r) => s + (num(r.auction_count) || 0), 0);
        const sold = mRows.reduce((s, r) => s + (num(r.sold) || 0), 0);
        const prices = mRows.map(r => num(r.price)).filter(p => p > 0);

        const models = [...groupBy(mRows, r => r.model)].map(([model, rs]) => {
            const mAuctions = rs.reduce((s, r) => s + (num(r.auction_count) || 0), 0);
            const mSold = rs.reduce((s, r) => s + (num(r.sold) || 0), 0);
            const mPrices = rs.map(r => num(r.price)).filter(p => p > 0);
            return {
                make, model,
                months: rs.length,
                auctions: mAuctions,
                sold: mSold,
                // mii_score is already a per-model-month figure, so the period
                // average divides by months, never by the auction count.
                mii: mean(rs.map(r => num(r.mii_score))) || 0,
                avgPrice: mean(mPrices) || 0,
                sellThrough: mAuctions > 0 ? Math.round((mSold / mAuctions) * 100) : 0,
                avgBids: mean(rs.map(r => num(r.bids))),
                avgViews: mean(rs.map(r => num(r.views))),
                avgComments: mean(rs.map(r => num(r.comments))),
                decade: num(rs.find(r => num(r.decade) != null)?.decade),
                confidence: MII.confidenceFor(mAuctions, grain),
                ci: window.BMW_CI ? BMW_CI.constituentFor(make, model) : null,
                trend: null, trendPoints: null, trendAuctions: null
            };
        }).sort((a, b) => b.mii - a.mii);

        return {
            make,
            auctions,
            sold,
            miiScore: mean(mRows.map(r => num(r.mii_score))) || 0,
            avgPrice: mean(prices) || 0,
            sellThrough: auctions > 0 ? Math.round((sold / auctions) * 100) : 0,
            confidence: MII.confidenceFor(auctions, grain),
            models,
            modelMap: new Map(models.map(m => [m.model, m])),
            rows: mRows,
            trend: null, trendPoints: null, trendAuctions: null
        };
    }).sort((a, b) => b.miiScore - a.miiScore);

    return { manufacturers, makeMap: new Map(manufacturers.map(m => [m.make, m])), rows };
}

// Change from `fromP` to `toP`, written onto `target`'s makes and models.
// The sample a move is judged on is the thinner of the two months, so a jump
// from one lucky sale is tested against the noise floor of one sale.
function applyTrends(target, fromP, toP) {
    if (!fromP || !toP) return;
    const setTrend = (obj, a, b, score) => {
        if (!a || !b || !(a[score] > 0)) return;
        obj.trendPoints = b[score] - a[score];
        obj.trend = (obj.trendPoints / a[score]) * 100;
        obj.trendAuctions = Math.min(a.auctions, b.auctions);
    };
    target.manufacturers.forEach(m => {
        const a = fromP.makeMap.get(m.make);
        const b = toP.makeMap.get(m.make);
        setTrend(m, a, b, 'miiScore');
        m.models.forEach(md => setTrend(md, a?.modelMap.get(md.model), b?.modelMap.get(md.model), 'mii'));
    });
}

function buildDataset(rows) {
    // Only well-formed periods: some upstream rows carry a model name (R60, K100)
    // in the quarter column, which would otherwise become a bogus month.
    const valid = rows.filter(r => /^\d{4}(-\d{2}|Q[1-4])$/.test(String(r.quarter || '').trim()) && r.manufacturer && r.model && isFinite(parseFloat(r.mii_score)));
    const rawMonths = [...new Set(valid.map(r => r.quarter))].sort();
    if (!rawMonths.length) return null;

    // The newest month is always partial: it is labelled month to date.
    const latest = rawMonths[rawMonths.length - 1];
    const keyOf = m => (m === latest ? `${m}-MTD` : m);
    const byMonth = groupBy(valid, r => r.quarter);

    const ds = { months: rawMonths.map(keyOf), quarterData: {}, cache: {} };

    // Months the upstream capture largely missed: under half the typical
    // month's lots (January 2026 has about a third). Each car's MII still
    // ranks fairly within such a month, but the market-level figures rest on
    // a fraction of the market, so none is ever used as a comparison point.
    const lots = rawMonths.map(m => byMonth.get(m).reduce((s, r) => s + (num(r.auction_count) || 0), 0));
    const typical = median(lots.filter((_, i) => rawMonths[i] !== latest));
    ds.thin = new Set(rawMonths.filter((m, i) => m !== latest && typical > 0 && lots[i] < typical / 2).map(keyOf));
    rawMonths.forEach((m, i) => {
        const key = keyOf(m);
        ds.quarterData[key] = summarizePeriod(byMonth.get(m), 'monthly');
        if (i > 0) applyTrends(ds.quarterData[key], ds.quarterData[keyOf(rawMonths[i - 1])], ds.quarterData[key]);
    });

    // Year to date: every month of the latest year, with change measured from
    // January to the last complete month (the partial month would make it
    // noise), skipping an incomplete month at either end.
    const year = latest.slice(0, 4);
    const ytdRaw = rawMonths.filter(m => m.startsWith(year));
    if (ytdRaw.length) {
        ds.quarterData.YTD = summarizePeriod(ytdRaw.flatMap(m => byMonth.get(m)), 'quarterly');
        ds.ytdMonths = ytdRaw.map(keyOf);
        const full = ds.ytdMonths.filter(k => !k.endsWith('-MTD') && !ds.thin.has(k));
        if (full.length >= 2) {
            ds.ytdFrom = full[0];
            ds.ytdTo = full[full.length - 1];
            applyTrends(ds.quarterData.YTD, ds.quarterData[ds.ytdFrom], ds.quarterData[ds.ytdTo]);
        }
    }
    ds.periods = ds.quarterData.YTD ? [...ds.months, 'YTD'] : [...ds.months];
    return ds;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const STATE = {
    period: null,
    vclass: 'all',
    minAuctions: 10,
    sortBy: 'miiScore',
    sortOrder: 'desc',
    makeSearch: '',
    modelSearch: '',
    ciOnly: false,
    makeView: 'table',
    mapMode: 'ci',
    showAllMakes: false,
    make: null
};

let RAW_ROWS = [];
const DATASETS = {};
let DS = null;
const charts = {};

const LEADERBOARD_ROWS = 20;
// A model needs this many auctions in the period to rank; below it single
// lucky sales crowd out everything else. Search and the BMW CI view ignore it.
const MIN_MODEL_AUCTIONS = 3;
const HEATMAP_ROWS = 16;
const PRICE_TICKS = [1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6, 2e6, 5e6];

function datasetFor(vclass) {
    if (!DATASETS[vclass]) {
        const rows = vclass === 'all' ? RAW_ROWS : RAW_ROWS.filter(r => (r.vehicle_class || '').trim() === vclass);
        DATASETS[vclass] = buildDataset(rows);
    }
    return DATASETS[vclass];
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Display names. The MII pipeline title-cases makes ("Detomaso", "Amc"),
// and a few BaT model groups arrive in capitals ("MUSTANG"). These only change
// what is shown; every join and lookup keeps the raw value.
const MAKE_LABELS = {
    'Ac': 'AC', 'Ajs': 'AJS', 'Am General': 'AM General', 'Amc': 'AMC', 'American Lafrance': 'American LaFrance',
    'Bac': 'BAC', 'Bsa': 'BSA', 'Cz': 'CZ', 'Desoto': 'DeSoto', 'Detomaso': 'De Tomaso', 'Dkw': 'DKW', 'Ebr': 'EBR',
    'Gaz': 'GAZ', 'Ineos': 'INEOS', 'Ktm': 'KTM', 'Lasalle': 'LaSalle', 'Lti': 'LTI', 'Mccormick': 'McCormick',
    'Mv Agusta': 'MV Agusta', 'Nsu': 'NSU', 'Osca': 'OSCA', 'Reo': 'REO', 'Ruf': 'RUF', 'Speed Utv': 'Speed UTV'
};
const mk = make => MAKE_LABELS[make] || make;
// All-capital model names get words of four or more letters title-cased;
// short tokens (AMG, GT, SS) and anything with a digit are left alone.
const md = model => (/[a-z]/.test(model) || !/[A-Z]{4}/.test(model)) ? model
    : model.replace(/\b[A-Z]{4,}\b/g, w => w[0] + w.slice(1).toLowerCase());

// "Make Model" for titles, without doubling a make the model name already
// starts with ("Volkswagen Bay-Window Bus", "DeTomaso Pantera").
function fullName(make, model) {
    const squash = t => t.toLowerCase().replace(/[^a-z0-9]/g, '');
    const label = md(model);
    return squash(label).startsWith(squash(mk(make))) || squash(label).startsWith(squash(make)) ? label : `${mk(make)} ${label}`;
}

// "$171K" under a million, "$1.66M" above.
function formatPrice(amount) {
    if (amount == null || !isFinite(amount) || amount <= 0) return '—';
    if (amount >= 1e6) return `$${(amount / 1e6).toFixed(2)}M`;
    return `$${(amount / 1000).toFixed(0)}K`;
}

function formatCurrency(amount, currency) {
    if (amount == null) return '—';
    const symbol = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '$';
    const prefix = (currency && currency !== 'USD') ? `${currency} ${symbol}` : symbol;
    return `${prefix}${Math.round(amount).toLocaleString()}`;
}

const fmt1 = v => (v == null || !isFinite(v) ? '—' : v.toFixed(1));
const fmtInt = v => (v == null || !isFinite(v) ? '—' : Math.round(v).toLocaleString());
const signed = (v, d = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`;

function monthDate(key) {
    const m = String(key).replace('-MTD', '').match(/^(\d{4})-(\d{2})$/);
    return m ? new Date(+m[1], +m[2] - 1, 1) : null;
}

// "Sep 2026", "Oct 2026 (MTD)", "YTD".
function shortPeriod(key) {
    if (key === 'YTD') return 'YTD';
    const d = monthDate(key);
    if (!d) return key;
    const label = d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    return key.endsWith('-MTD') ? `${label} (MTD)` : label;
}

// "September 2026", "October 2026, to date", "2026 to date".
function longPeriod(key) {
    if (key === 'YTD') return `${DS?.ytdMonths?.[0]?.slice(0, 4) || ''} to date`.trim();
    const d = monthDate(key);
    if (!d) return key;
    const label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    return key.endsWith('-MTD') ? `${label}, to date` : label;
}

const monthName = key => monthDate(key)?.toLocaleDateString('en-US', { month: 'long' }) || key;
const axisMonth = key => `${monthDate(key)?.toLocaleDateString('en-US', { month: 'short' })} ’${key.slice(2, 4)}`;

// The period a selected period's changes are measured from, and how to say it.
function baselineKey(key) {
    if (key === 'YTD') return DS.ytdFrom || null;
    const i = DS.months.indexOf(key);
    return i > 0 ? DS.months[i - 1] : null;
}
// The month a market-level figure compares against: the previous month, or
// the one before it when that month's capture was incomplete.
function solidBaseline(key) {
    let b = baselineKey(key);
    while (b && key !== 'YTD' && DS.thin?.has(b)) b = baselineKey(b);
    return b;
}
function baselinePhrase(key) {
    if (key === 'YTD') return DS.ytdFrom ? `${monthName(DS.ytdFrom)} to ${monthName(DS.ytdTo)}` : '';
    const b = baselineKey(key);
    return b ? `vs ${shortPeriod(b)}` : '';
}

// A change in MII points, coloured only when it clears the noise floor for
// the sample behind it. Below the floor it is greyed with a dotted underline:
// at one auction a month the median swing is 10.5 points, so small moves are
// usually which cars crossed the block, not the market moving.
function deltaHTML(points, auctions, opts = {}) {
    if (points == null || !isFinite(points)) return `<span class="muted">—</span>`;
    const label = `${signed(points)}${opts.unit || ''}`;
    if (Math.abs(points) < 0.05) return `<span class="muted">${label}</span>`;
    if (auctions != null && MII.moveStrength(points, auctions) === 'noise') {
        const floor = MII.noiseFloor(auctions);
        return `<span class="noise" title="${Math.abs(points).toFixed(1)} points on ${auctions} auction(s): under the ${floor.median}-point median swing at this sample size, so within normal sampling noise">${label}</span>`;
    }
    const arrow = points > 0 ? '▲' : '▼';
    return `<span class="${points > 0 ? 'up' : 'down'}" title="MII points ${esc(baselinePhrase(STATE.period))}"><span aria-hidden="true" style="font-size:.72em;margin-right:3px">${arrow}</span>${label}</span>`;
}

// Three-step signal meter plus the level's name; filled steps carry it, so
// it reads the same without colour.
function confidenceHTML(level) {
    const filled = { High: 3, 'Medium-High': 2, Medium: 1, Low: 0 }[level] ?? 1;
    const bars = [0, 1, 2].map(i =>
        `<span style="display:block;width:4px;border-radius:1px;height:${6 + i * 3}px;background:${i < filled ? 'var(--ink)' : 'var(--line)'}"></span>`
    ).join('');
    return `<span style="display:inline-flex;align-items:center;gap:8px" title="${esc(level)} confidence">
        <span style="display:inline-flex;align-items:flex-end;gap:2px;height:12px" aria-hidden="true">${bars}</span>
        <span class="muted" style="font-size:13px">${esc(level)}</span></span>`;
}

function sparkline(values, opts = {}) {
    const w = opts.w || 84, h = opts.h || 24, pad = 3;
    const pts = values.map((v, i) => ({ v, i })).filter(p => p.v != null && isFinite(p.v));
    if (pts.length < 2) return `<span class="muted">—</span>`;
    const min = Math.min(...pts.map(p => p.v)), max = Math.max(...pts.map(p => p.v));
    const range = max - min || 1;
    const x = i => pad + (i / Math.max(1, values.length - 1)) * (w - pad * 2);
    const y = v => pad + (1 - (v - min) / range) * (h - pad * 2);
    const d = pts.map((p, j) => `${j ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
    const last = pts[pts.length - 1];
    const stroke = opts.stroke || 'var(--dot)';
    const dot = opts.dot || 'var(--accent)';
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true" style="display:block;overflow:visible">
        <path d="${d}" fill="none" style="stroke:${stroke}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="${x(last.i).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="2.6" style="fill:${dot}"/></svg>`;
}

// ---------------------------------------------------------------------------
// Derived figures
// ---------------------------------------------------------------------------

function period(key = STATE.period) { return DS?.quarterData[key] || null; }

// A move worth reporting: it clears the 90th-percentile noise floor for its
// sample, and both ends of the comparison rest on at least three auctions.
function isRealMove(x) {
    return x.trendPoints != null && x.trendAuctions >= MIN_MODEL_AUCTIONS
        && MII.moveStrength(x.trendPoints, x.trendAuctions) === 'signal';
}

function marketStats(key) {
    const cacheKey = `ms|${STATE.minAuctions}|${key}`;
    if (DS.cache[cacheKey] !== undefined) return DS.cache[cacheKey];
    const p = period(key);
    let out = null;
    if (p) {
        const q = p.manufacturers.filter(m => m.auctions >= STATE.minAuctions);
        const models = q.flatMap(m => m.models).filter(m => m.auctions > 0);
        const tradedModels = p.manufacturers.reduce((s, m) => s + m.models.filter(x => x.auctions > 0).length, 0);
        const auctions = q.reduce((s, m) => s + m.auctions, 0);
        const sold = q.reduce((s, m) => s + m.sold, 0);
        // The market's level. MII ranks each car against its own month, so
        // the market's average MII sits near 50 by design and cannot show
        // whether the market as a whole is drawing more attention. Views per
        // listing can: the typical (lot-weighted median) listing across every
        // make in view, qualifying or not.
        const viewed = p.manufacturers.flatMap(m => m.models).filter(m => m.auctions > 0 && m.avgViews > 0);
        out = {
            makes: q.length,
            allMakes: p.manufacturers.length,
            mii: q.length ? mean(q.map(m => m.miiScore)) : null,
            views: weightedMedian(viewed.map(m => [m.avgViews, m.auctions])),
            auctions,
            sellThrough: auctions > 0 ? (sold / auctions) * 100 : null,
            medianPrice: median(models.map(m => m.avgPrice).filter(v => v > 0)),
            models: tradedModels
        };
    }
    DS.cache[cacheKey] = out;
    return out;
}

function allModels(key = STATE.period) {
    const p = period(key);
    return p ? p.manufacturers.flatMap(m => m.models) : [];
}

// "Unknown" is BaT's bucket for lots it could not attribute to a make. It
// stays in the tables but is never ranked or reported as a finding.
const isNamedMake = make => make !== 'Unknown';

function rankedModels(key = STATE.period) {
    return allModels(key).filter(m => m.auctions >= MIN_MODEL_AUCTIONS && isNamedMake(m.make));
}

// Months to draw for a series ending at the selected period.
function seriesMonths(count = 12) {
    const end = STATE.period === 'YTD' ? DS.months.length - 1 : DS.months.indexOf(STATE.period);
    return DS.months.slice(Math.max(0, end - count + 1), end + 1);
}

function makeSeries(make, months = DS.months) {
    return months.map(k => DS.quarterData[k]?.makeMap.get(make)?.miiScore ?? null);
}

// Ordinary least squares of MII on log10(price) across ranked models: the
// interest a model's price alone predicts. A model's residual is how far its
// attention runs above (or below) that.
function priceFit(models) {
    const pts = models.filter(m => m.avgPrice > 0).map(m => ({ m, x: Math.log10(m.avgPrice), y: m.mii }));
    if (pts.length < 8) return null;
    const mx = mean(pts.map(p => p.x)), my = mean(pts.map(p => p.y));
    let sxy = 0, sxx = 0;
    pts.forEach(p => { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; });
    const b = sxx ? sxy / sxx : 0;
    const a = my - b * mx;
    pts.forEach(p => { p.m.residual = p.y - (a + b * p.x); });
    return { a, b, predict: price => a + b * Math.log10(price) };
}

// --- BMW CI ---------------------------------------------------------------

// One constituent's figures for a period: its matched model groups combined,
// MII weighted by auctions so a one-sale variant cannot swamp the main one.
function ciConstituentStats(c, key) {
    const bmw = period(key)?.makeMap.get('BMW');
    if (!bmw || !c.models.length) return null;
    const wanted = new Set(c.models.map(m => m.toLowerCase()));
    const models = bmw.models.filter(m => wanted.has(m.model.toLowerCase()));
    if (!models.length) return null;
    const auctions = models.reduce((s, m) => s + m.auctions, 0);
    const weights = models.map(m => (auctions > 0 ? m.auctions : 1));
    const wsum = weights.reduce((s, w) => s + w, 0);
    const mii = models.reduce((s, m, i) => s + m.mii * weights[i], 0) / wsum;
    const priced = models.filter(m => m.avgPrice > 0);
    const pw = priced.reduce((s, m) => s + Math.max(1, m.auctions), 0);
    const sold = models.reduce((s, m) => s + m.sold, 0);
    return {
        mii, auctions, models,
        avgPrice: pw ? priced.reduce((s, m) => s + m.avgPrice * Math.max(1, m.auctions), 0) / pw : 0,
        sellThrough: auctions > 0 ? Math.round((sold / auctions) * 100) : null
    };
}

function ciPeriod(key) {
    const cacheKey = `ci|${key}`;
    if (DS.cache[cacheKey]) return DS.cache[cacheKey];
    const items = BMW_CI.CONSTITUENTS.map(c => ({ c, s: ciConstituentStats(c, key) }));
    const present = items.filter(i => i.s);
    const out = {
        items,
        present: present.length,
        basket: present.length ? mean(present.map(i => i.s.mii)) : null,
        auctions: present.reduce((s, i) => s + i.s.auctions, 0)
    };
    DS.cache[cacheKey] = out;
    return out;
}

// "Top 4%": the share of all models in the period scoring at or above this.
function topShare(mii, key = STATE.period) {
    const all = allModels(key).filter(m => m.auctions > 0);
    if (!all.length) return null;
    const above = all.filter(m => m.mii > mii).length;
    return Math.max(1, Math.ceil(((above + 1) / all.length) * 100));
}

// ---------------------------------------------------------------------------
// Chart plumbing
// ---------------------------------------------------------------------------

function token(name, el = document.documentElement) {
    return getComputedStyle(el).getPropertyValue(name).trim();
}

function palette(el) {
    return {
        ink: token('--ink', el), ink2: token('--ink-2', el), muted: token('--muted', el),
        grid: token('--grid', el), axis: token('--axis', el), surface: token('--surface', el),
        accent: token('--accent', el), market: token('--market', el), ci: token('--ci', el),
        bmw: token('--bmw', el), dot: token('--dot', el), page: token('--page', el)
    };
}

function withAlpha(hex, a) {
    const h = hex.replace('#', '');
    if (h.length !== 6) return hex;
    return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
}

function tooltipStyle() {
    return {
        backgroundColor: '#111216', titleColor: '#f4f3ef', bodyColor: '#d6d5ce', borderWidth: 0,
        padding: 10, cornerRadius: 8, displayColors: false, titleFont: { weight: '600' },
        footerColor: '#a9abb1', footerFont: { weight: '400', size: 11 }
    };
}

function axis(p, extra = {}) {
    return {
        grid: { color: p.grid, drawTicks: false },
        border: { display: false },
        ...extra,
        ticks: { color: p.muted, font: { size: 11 }, padding: 8, ...(extra.ticks || {}) }
    };
}

// Vertical hairline at the hovered index on line charts.
const crosshairPlugin = {
    id: 'crosshair',
    afterDatasetsDraw(chart, _args, opts) {
        if (!opts || !opts.color) return;
        const active = chart.tooltip?.getActiveElements?.() || [];
        if (!active.length) return;
        const x = active[0].element.x;
        const { top, bottom } = chart.chartArea;
        const ctx = chart.ctx;
        ctx.save();
        ctx.strokeStyle = opts.color;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
        ctx.restore();
    }
};

// Series names at the end of their lines, nudged apart so they never collide.
// The text stays in ink; the dot beside it carries the series colour.
const endLabelPlugin = {
    id: 'endLabels',
    afterDatasetsDraw(chart, _args, opts) {
        if (!opts || !opts.color) return;
        const ctx = chart.ctx;
        const labels = [];
        chart.data.datasets.forEach((ds, i) => {
            if (!ds.endLabel || chart.getDatasetMeta(i).hidden) return;
            const meta = chart.getDatasetMeta(i);
            for (let j = ds.data.length - 1; j >= 0; j--) {
                if (ds.data[j] == null) continue;
                labels.push({ text: ds.endLabel, x: meta.data[j].x, y: meta.data[j].y, color: ds.borderColor });
                break;
            }
        });
        labels.sort((a, b) => a.y - b.y);
        for (let i = 1; i < labels.length; i++) {
            if (labels[i].y - labels[i - 1].y < 15) labels[i].y = labels[i - 1].y + 15;
        }
        ctx.save();
        ctx.font = '600 12px "Hanken Grotesk", system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        labels.forEach(l => {
            ctx.fillStyle = l.color;
            ctx.beginPath(); ctx.arc(l.x + 10, l.y, 3.5, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = opts.color;
            ctx.fillText(l.text, l.x + 18, l.y);
        });
        ctx.restore();
    }
};

// Labels on a few chosen scatter points, skipping any that would overlap.
const pointLabelPlugin = {
    id: 'pointLabels',
    afterDatasetsDraw(chart, _args, opts) {
        if (!opts || !opts.color) return;
        const ctx = chart.ctx;
        const placed = [];
        const { left, right, top, bottom } = chart.chartArea;
        ctx.save();
        ctx.font = '600 11.5px "Hanken Grotesk", system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        chart.data.datasets.forEach((ds, i) => {
            const meta = chart.getDatasetMeta(i);
            ds.data.forEach((pt, j) => {
                if (!pt || !pt.label) return;
                const el = meta.data[j];
                const w = ctx.measureText(pt.label).width;
                const r = (el.options?.radius || 4) + 4;
                let x = el.x + r, align = 'left';
                if (x + w > right) { x = el.x - r; align = 'right'; }
                const box = { x0: align === 'left' ? x : x - w, x1: align === 'left' ? x + w : x, y0: el.y - 8, y1: el.y + 8 };
                if (box.y0 < top || box.y1 > bottom || box.x0 < left) return;
                if (placed.some(b => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) return;
                placed.push(box);
                ctx.textAlign = align;
                ctx.lineWidth = 3;
                ctx.strokeStyle = opts.halo;
                ctx.strokeText(pt.label, x, el.y);
                ctx.fillStyle = opts.color;
                ctx.fillText(pt.label, x, el.y);
            });
        });
        ctx.restore();
    }
};

function makeChart(id, config) {
    if (charts[id]) charts[id].destroy();
    const canvas = document.getElementById(id);
    if (!canvas) return null;
    charts[id] = new Chart(canvas.getContext('2d'), config);
    return charts[id];
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

function renderHero() {
    const key = STATE.period;
    const ms = marketStats(key);
    const base = solidBaseline(key);
    const isYTD = key === 'YTD';
    const thin = DS.thin?.has(key);

    document.getElementById('periodTitle').textContent = isYTD ? `· ${longPeriod(key)}` : `· ${longPeriod(key)}`;
    document.getElementById('marketLevel').textContent = ms?.views != null ? fmtInt(ms.views) : '–';

    // Headline change, in percent. Month view: vs the month before (skipping
    // an incomplete one). YTD: the year's first complete month to its last,
    // on monthly figures so both ends are like for like.
    const deltaEl = document.getElementById('marketDelta');
    let diff = null;
    if (isYTD && DS.ytdFrom) {
        const a = marketStats(DS.ytdFrom)?.views, b = marketStats(DS.ytdTo)?.views;
        if (a && b != null) diff = (b / a - 1) * 100;
    } else if (base && !thin) {
        const a = marketStats(base)?.views;
        if (a && ms?.views != null) diff = (ms.views / a - 1) * 100;
    }
    if (thin) {
        deltaEl.style.display = '';
        deltaEl.innerHTML = `<span class="muted">Incomplete month: only ${fmtInt(ms?.auctions)} auctions captured</span>`;
    } else if (diff == null) {
        deltaEl.style.display = 'none';
    } else {
        deltaEl.style.display = '';
        const cls = Math.abs(diff) < 0.5 ? 'muted' : diff > 0 ? 'up' : 'down';
        deltaEl.innerHTML = `<span class="${cls}">${diff > 0 ? '▲' : diff < 0 ? '▼' : ''} ${signed(diff)}%</span><span class="muted">${esc(isYTD ? baselinePhrase(key) : `vs ${shortPeriod(base)}`)}</span>`;
    }

    renderLede(ms, diff);
    renderKPIs(ms);
    renderMarketChart();
}

function renderLede(ms, diff) {
    const key = STATE.period;
    const lede = document.getElementById('lede');
    if (!ms || !ms.makes) {
        lede.textContent = `No make reached ${STATE.minAuctions} auctions in this period yet.`;
        return;
    }
    const p = period(key);
    const leader = p.manufacturers.filter(m => m.auctions >= STATE.minAuctions && isNamedMake(m.make))[0];
    // `diff` is the percent change in views per listing (see renderHero).
    const parts = [];
    const views = ms.views != null ? `<strong>${fmtInt(ms.views)}</strong> views` : 'an unknown number of views';
    if (key === 'YTD') {
        parts.push(`So far this year the typical listing has drawn ${views}, across <strong>${fmtInt(ms.auctions)}</strong> auctions`);
        if (diff != null) parts[0] += `, ${Math.abs(diff) < 0.5 ? 'flat' : `${diff > 0 ? 'up' : 'down'} ${Math.abs(diff).toFixed(0)}%`} from ${monthName(DS.ytdFrom)} to ${monthName(DS.ytdTo)}`;
    } else {
        parts.push(`The typical listing ${key.endsWith('-MTD') ? 'is drawing' : 'drew'} ${views}, across <strong>${fmtInt(ms.auctions)}</strong> auctions`);
        const b = solidBaseline(key);
        if (DS.thin?.has(key)) parts[0] += ', in a month the source data only partly captured';
        else if (diff != null && b) parts[0] += `, ${Math.abs(diff) < 0.5 ? 'flat on' : `${diff > 0 ? 'up' : 'down'} ${Math.abs(diff).toFixed(0)}% on`} ${monthName(b)}`;
    }
    parts[0] += '.';
    if (leader) parts.push(`<strong>${esc(mk(leader.make))}</strong> leads ${ms.makes} qualifying makes.`);
    if (STATE.vclass !== 'motorcycle') {
        const ci = ciPeriod(key);
        if (ci.basket != null && ms.mii != null) {
            const gap = ci.basket - ms.mii;
            parts.push(`The <span class="ci-word">BMW CI</span> cars are running ${Math.abs(gap).toFixed(1)} points ${gap >= 0 ? 'above' : 'below'} the market.`);
        }
    }
    lede.innerHTML = parts.join(' ');
}

function renderKPIs(ms) {
    const months = seriesMonths(12);
    const series = f => months.map(k => { const s = marketStats(k); return s ? f(s) : null; });
    const tiles = [
        { label: 'Auctions', value: fmtInt(ms?.auctions), sub: `from ${ms?.makes ?? 0} makes with ${STATE.minAuctions}+`, spark: series(s => s.auctions) },
        { label: 'Sell-through', value: ms?.sellThrough != null ? `${ms.sellThrough.toFixed(0)}%` : '—', sub: 'lots that met reserve', spark: series(s => s.sellThrough) },
        { label: 'Median model price', value: formatPrice(ms?.medianPrice), sub: 'middle of the model averages', spark: series(s => s.medianPrice) },
        { label: 'Models traded', value: fmtInt(ms?.models), sub: `across all ${ms?.allMakes ?? 0} makes`, spark: series(s => s.models) }
    ];
    document.getElementById('kpis').innerHTML = tiles.map(t => `
        <div class="kpi">
            <span class="k-label">${t.label}</span>
            <div class="k-row">
                <span class="k-value">${t.value}</span>
                ${sparkline(t.spark, { w: 76, h: 26, stroke: 'rgba(255,255,255,.32)', dot: 'var(--accent)' })}
            </div>
            <span class="k-sub">${esc(t.sub)}</span>
        </div>`).join('');
}

function renderMarketChart() {
    const hero = document.querySelector('.hero');
    const p = palette(hero);
    const months = DS.months;
    const values = months.map(k => marketStats(k)?.views ?? null);
    const selIdx = STATE.period === 'YTD' ? -1 : months.indexOf(STATE.period);
    const last = months.length - 1;
    const partial = months[last]?.endsWith('-MTD');
    const anyThin = months.some(k => DS.thin?.has(k));
    document.getElementById('marketChartNote').textContent = `${partial ? 'Dashed: month in progress. ' : ''}${anyThin ? 'Hollow: month only partly captured. ' : ''}Select a month to open it`;

    const chart = makeChart('marketChart', {
        type: 'line',
        data: {
            labels: months.map(axisMonth),
            datasets: [{
                data: values,
                borderColor: p.market,
                borderWidth: 2.25,
                tension: 0.35,
                fill: true,
                backgroundColor: ctx => {
                    const { chartArea, ctx: c } = ctx.chart;
                    if (!chartArea) return 'transparent';
                    const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
                    g.addColorStop(0, withAlpha(p.market, 0.28));
                    g.addColorStop(1, withAlpha(p.market, 0));
                    return g;
                },
                pointRadius: months.map((k, i) => (i === selIdx ? 5.5 : DS.thin?.has(k) ? 3.5 : 0)),
                pointHoverRadius: 5.5,
                pointBackgroundColor: months.map(k => (DS.thin?.has(k) ? '#0d0e10' : p.market)),
                pointBorderColor: months.map(k => (DS.thin?.has(k) ? p.market : '#0d0e10')),
                pointBorderWidth: 2,
                spanGaps: true,
                // Dashed into the month in progress, and on either side of an
                // incomplete month so a capture gap does not read as a move.
                segment: { borderDash: c => ((partial && c.p1DataIndex === last) || DS.thin?.has(months[c.p0DataIndex]) || DS.thin?.has(months[c.p1DataIndex]) ? [5, 5] : undefined) }
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            layout: { padding: { top: 6, right: 4 } },
            onClick: (evt) => {
                const hit = chart.getElementsAtEventForMode(evt, 'index', { intersect: false }, false);
                if (hit.length) setPeriod(months[hit[0].index]);
            },
            onHover: (evt, els) => { evt.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
            plugins: {
                legend: { display: false },
                crosshair: { color: 'rgba(255,255,255,.25)' },
                tooltip: {
                    ...tooltipStyle(),
                    callbacks: {
                        title: items => longPeriod(months[items[0].dataIndex]),
                        label: ctx => `${fmtInt(ctx.parsed.y)} views per listing`,
                        footer: items => {
                            const k = months[items[0].dataIndex], s = marketStats(k);
                            if (!s) return '';
                            return `${fmtInt(s.auctions)} auctions · ${s.makes} makes` + (DS.thin?.has(k) ? '\nIncomplete month: most auctions were not captured' : '');
                        }
                    }
                }
            },
            scales: {
                x: axis(p, { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 9 } }),
                y: axis(p, { grace: '12%', ticks: { maxTicksLimit: 4, callback: v => `${(Number(v) / 1000).toFixed(1)}k` } })
            }
        },
        plugins: [crosshairPlugin]
    });
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

const ICONS = {
    crown: '<path d="M3 7l4.5 4L12 4l4.5 7L21 7l-2 12H5L3 7Z"/>',
    rise: '<path d="M3 17l6-6 4 4 8-8M14 7h7v7"/>',
    fall: '<path d="M3 7l6 6 4-4 8 8M14 17h7v-7"/>',
    flame: '<path d="M12 22c4 0 7-3 7-7 0-4-3-6-4-9-1 2-2 3-4 3 0-2 0-4-2-6-1 4-6 7-6 12 0 4 3 7 7 7Z"/>',
    tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
    gavel: '<path d="m14 13-7.5 7.5a2.1 2.1 0 0 1-3-3L11 10M16 16l6-6M8 8l6-6M9 7l8 8M21 11l-8-8"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    pause: '<path d="M8 5v14M16 5v14"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

function buildInsights() {
    const key = STATE.period;
    const p = period(key);
    if (!p) return [];
    const ms = marketStats(key);
    const qualifying = p.manufacturers.filter(m => m.auctions >= STATE.minAuctions && isNamedMake(m.make));
    const models = rankedModels(key);
    const phrase = baselinePhrase(key);
    const cards = [];

    const leader = qualifying[0];
    if (leader) {
        cards.push({
            kicker: 'Highest-interest make', icon: 'crown', subject: esc(mk(leader.make)),
            body: `Tops ${ms.makes} qualifying makes, ${(leader.miiScore - ms.mii).toFixed(1)} points above the market average, on ${fmtInt(leader.auctions)} auctions with ${leader.sellThrough}% sold.`,
            stat: fmt1(leader.miiScore), foot: 'MII', action: { type: 'make', make: leader.make }
        });
    }

    // Biggest real move among qualifying makes; if nothing clears the noise
    // floor, say so rather than promote a random wobble.
    const moves = qualifying.filter(isRealMove);
    const riser = moves.filter(m => m.trendPoints > 0).sort((a, b) => b.trendPoints - a.trendPoints)[0];
    const faller = moves.filter(m => m.trendPoints < 0).sort((a, b) => a.trendPoints - b.trendPoints)[0];
    if (riser) {
        cards.push({
            kicker: 'Biggest riser', icon: 'rise', subject: esc(mk(riser.make)),
            body: `Gained ${riser.trendPoints.toFixed(1)} MII points ${esc(phrase)}, well beyond what sampling noise explains on ${fmtInt(riser.trendAuctions)}+ auctions a month.`,
            stat: `<span class="up">${signed(riser.trendPoints)}</span>`, foot: 'points', action: { type: 'make', make: riser.make }
        });
    } else if (faller) {
        cards.push({
            kicker: 'Biggest faller', icon: 'fall', subject: esc(mk(faller.make)),
            body: `Lost ${Math.abs(faller.trendPoints).toFixed(1)} MII points ${esc(phrase)}, beyond normal sampling noise.`,
            stat: `<span class="down">${signed(faller.trendPoints)}</span>`, foot: 'points', action: { type: 'make', make: faller.make }
        });
    } else if (phrase) {
        cards.push({
            kicker: 'Steady market', icon: 'pause', subject: 'No real movers',
            body: `No qualifying make moved ${esc(phrase)} by more than its sample size makes normal. Treat small changes in the table as noise.`,
            stat: '', foot: ''
        });
    }

    const hottest = models[0];
    if (hottest) {
        cards.push({
            kicker: 'Most-watched model', icon: 'flame', ci: !!hottest.ci,
            subject: `${esc(md(hottest.model))} <span class="make">${esc(mk(hottest.make))}</span>`,
            body: `The highest MII of any model with ${MIN_MODEL_AUCTIONS}+ auctions: ${fmtInt(hottest.auctions)} sold through ${hottest.sellThrough}% at an average ${formatPrice(hottest.avgPrice)}.`,
            stat: fmt1(hottest.mii), foot: 'MII', action: { type: 'lots', make: hottest.make, models: [hottest.model], title: fullName(hottest.make, hottest.model) }
        });
    }

    const fit = priceFit(models);
    const value = fit ? models.filter(m => m.residual != null).sort((a, b) => b.residual - a.residual)[0] : null;
    if (value) {
        cards.push({
            kicker: 'Interest outruns price', icon: 'tag', ci: !!value.ci,
            subject: `${esc(md(value.model))} <span class="make">${esc(mk(value.make))}</span>`,
            body: `Draws ${value.residual.toFixed(1)} points more attention than a car at ${formatPrice(value.avgPrice)} usually gets. The strongest interest for the money in this period.`,
            stat: `+${value.residual.toFixed(1)}`, foot: 'pts above price line', action: { type: 'lots', make: value.make, models: [value.model], title: fullName(value.make, value.model) }
        });
    }

    const contested = models.filter(m => m.avgBids != null).sort((a, b) => b.avgBids - a.avgBids)[0];
    if (contested) {
        cards.push({
            kicker: 'Most fought-over', icon: 'gavel', ci: !!contested.ci,
            subject: `${esc(md(contested.model))} <span class="make">${esc(mk(contested.make))}</span>`,
            body: `Averages ${Math.round(contested.avgBids)} bids${contested.avgComments != null ? ` and ${Math.round(contested.avgComments)} comments` : ''} a listing across ${fmtInt(contested.auctions)} auctions, the most bidding of any ranked model.`,
            stat: Math.round(contested.avgBids), foot: 'bids per auction', action: { type: 'lots', make: contested.make, models: [contested.model], title: fullName(contested.make, contested.model) }
        });
    }

    if (STATE.vclass !== 'motorcycle') {
        const ci = ciPeriod(key);
        if (ci.basket != null && ms?.mii != null) {
            const gap = ci.basket - ms.mii;
            cards.push({
                kicker: 'BMW Classic Index', icon: 'target', ci: true,
                subject: `BMW CI ${gap >= 0 ? 'outdraws' : 'trails'} the market`,
                body: `${ci.present} of ${BMW_CI.CONSTITUENTS.length} constituents traded, averaging MII ${fmt1(ci.basket)} against ${fmt1(ms.mii)} for the market.`,
                stat: `${signed(gap)}`, foot: 'points vs market', action: { type: 'scroll', target: 'ciTitle' }
            });
        }
    }
    return cards.slice(0, 6);
}

function renderInsights() {
    const cards = buildInsights();
    document.getElementById('insightsSub').textContent =
        `Generated from the data for ${longPeriod(STATE.period)}. Moves smaller than normal sampling noise are never called out.`;
    const el = document.getElementById('insights');
    el.innerHTML = cards.map((c, i) => {
        const tag = c.action ? 'button' : 'div';
        return `<${tag} class="card insight ${c.ci ? 'is-ci' : ''}" data-i="${i}">
            <span class="i-kicker"><span class="i-icon">${icon(c.icon)}</span>${esc(c.kicker)}${c.ci && c.kicker !== 'BMW Classic Index' ? ' <span class="ci-badge">BMW CI</span>' : ''}</span>
            <span class="i-subject">${c.subject}</span>
            <span class="i-body">${c.body}</span>
            <span class="i-foot"><span class="i-stat">${c.stat}</span><span>${esc(c.foot)}</span></span>
        </${tag}>`;
    }).join('');
    el.querySelectorAll('button.insight').forEach(btn => {
        btn.addEventListener('click', () => runAction(cards[+btn.dataset.i].action, btn));
    });
}

function runAction(action, opener) {
    if (!action) return;
    if (action.type === 'make') openDrawer(action.make, opener);
    if (action.type === 'lots') showLots(action.make, action.models, action.title, opener);
    if (action.type === 'scroll') document.getElementById(action.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------------------
// BMW CI spotlight
// ---------------------------------------------------------------------------

function renderCI() {
    const band = document.querySelector('.ci-band');
    const key = STATE.period;
    const grid = document.getElementById('ciGrid');
    const stats = document.getElementById('ciStats');

    if (STATE.vclass === 'motorcycle') {
        stats.innerHTML = `<div class="ci-stat"><span class="s-label">The BMW CI is an index of cars. Switch the view to All or Cars to see it.</span></div>`;
        grid.innerHTML = '';
        document.getElementById('ciFootnote').textContent = '';
        if (charts.ciChart) { charts.ciChart.destroy(); delete charts.ciChart; }
        document.getElementById('ciLegend').innerHTML = '';
        return;
    }
    band.hidden = false;

    const ci = ciPeriod(key);
    const ms = marketStats(key);
    const bmw = period(key)?.makeMap.get('BMW');
    const priced = ci.items.filter(i => i.s && i.s.avgPrice > 0);
    const gapMarket = ci.basket != null && ms?.mii != null ? ci.basket - ms.mii : null;
    const gapBMW = ci.basket != null && bmw ? ci.basket - bmw.miiScore : null;
    const gapCls = g => (g == null ? 'muted' : g >= 0 ? 'up' : 'down');

    stats.innerHTML = `
        <div class="ci-stat"><div><div class="s-label">BMW CI interest</div><div class="s-note" style="text-align:left">average MII of traded constituents</div></div><span class="s-value big">${fmt1(ci.basket)}</span></div>
        <div class="ci-stat"><span class="s-label">vs the market</span><span class="s-value ${gapCls(gapMarket)}">${gapMarket == null ? '—' : signed(gapMarket)}</span></div>
        <div class="ci-stat"><span class="s-label">vs all BMW</span><span class="s-value ${gapCls(gapBMW)}">${gapBMW == null ? '—' : signed(gapBMW)}</span></div>
        <div class="ci-stat"><span class="s-label">Constituents traded</span><span class="s-value">${ci.present}<span class="muted" style="font-size:15px;font-weight:500"> / ${BMW_CI.CONSTITUENTS.length}</span></span></div>
        <div class="ci-stat"><span class="s-label">Auctions</span><span class="s-value">${fmtInt(ci.auctions)}</span></div>
        <div class="ci-stat"><span class="s-label">Median constituent price</span><span class="s-value">${formatPrice(median(priced.map(i => i.s.avgPrice)))}</span></div>`;

    // Constituent cards, strongest first; ones with no sales this period last.
    const base = baselineKey(key);
    const baseTo = key === 'YTD' ? DS.ytdTo : key;
    const items = ci.items.slice().sort((a, b) => (b.s?.mii ?? -1) - (a.s?.mii ?? -1));
    grid.innerHTML = items.map(({ c, s }) => {
        const tags = [
            c.added ? `<span class="tag new">Added ${esc(c.added)}</span>` : '',
            c.approx ? `<span class="tag" title="${esc(c.approx)}">≈ group match</span>` : ''
        ].join('');
        if (!s) {
            const lotsAvailable = c.models.some(m => (batLots[modelJoinKey('BMW', m)] || []).length);
            const tagName = lotsAvailable ? 'button' : 'div';
            return `<${tagName} class="card ci-card is-empty" data-ci="${esc(c.id)}">
                <div class="c-head"><div><div class="c-name">${esc(c.name)}</div><div class="c-years">${esc(c.years)}</div></div></div>
                <div class="c-mii">${esc(c.note || 'No Bring a Trailer sales this period')}</div>
                <div class="c-tags">${tags}</div>
                <div class="c-foot"><span>${lotsAvailable ? 'See its listings' : 'Not scored'}</span></div>
            </${tagName}>`;
        }
        let dPts = null, dAuc = null;
        if (base) {
            const a = ciConstituentStats(c, base), b = ciConstituentStats(c, baseTo);
            if (a && b) { dPts = b.mii - a.mii; dAuc = Math.min(a.auctions, b.auctions); }
        }
        const series = DS.months.map(k => ciConstituentStats(c, k)?.mii ?? null);
        const top = topShare(s.mii, key);
        return `<button class="card ci-card" data-ci="${esc(c.id)}" title="Open the individual sales">
            <div class="c-head">
                <div><div class="c-name">${esc(c.name)}</div><div class="c-years">${esc(c.years)}</div></div>
                ${top != null ? `<span class="c-rank" title="Share of all models scoring at or above this">Top ${top}%</span>` : ''}
            </div>
            <div class="c-mid">
                <div><div class="c-mii">${fmt1(s.mii)}</div><div class="c-delta">${deltaHTML(dPts, dAuc)}</div></div>
                ${sparkline(series, { w: 92, h: 32, stroke: 'var(--ci-line)', dot: 'var(--ci)' })}
            </div>
            ${tags ? `<div class="c-tags">${tags}</div>` : ''}
            <div class="c-foot"><span>${fmtInt(s.auctions)} auction${s.auctions === 1 ? '' : 's'}</span><span>${formatPrice(s.avgPrice)}</span></div>
        </button>`;
    }).join('');
    grid.querySelectorAll('button[data-ci]').forEach(btn => {
        btn.addEventListener('click', () => {
            const c = BMW_CI.CONSTITUENTS.find(x => x.id === btn.dataset.ci);
            showLots('BMW', c.models, `BMW ${c.name}`, btn, 'BMW CI constituent');
        });
    });

    document.getElementById('ciFootnote').textContent =
        `Constituents per the HAGI BMW CI committee list (launch list, plus the E46 M3 added in 2026). Bring a Trailer groups some trims with their chassis family; those are marked "≈ group match". ` +
        `Rank chips compare each car with every model sold in the period. Changes are ${baselinePhrase(key) || 'not available for the first month'}.`;

    renderCIChart();
}

function renderCIChart() {
    const p = palette();
    const months = DS.months;
    const basket = months.map(k => ciPeriod(k).basket);
    const bmw = makeSeries('BMW', months);
    const market = months.map(k => marketStats(k)?.mii ?? null);
    const selIdx = STATE.period === 'YTD' ? -1 : months.indexOf(STATE.period);
    const series = [
        { label: 'BMW CI', data: basket, color: p.ci, width: 2.75 },
        { label: 'All BMW', data: bmw, color: p.bmw, width: 2 },
        { label: 'Market', data: market, color: p.market, width: 2 }
    ];
    document.getElementById('ciLegend').innerHTML = series.map(s => `<span><i style="color:${s.color}"></i>${s.label}</span>`).join('');

    makeChart('ciChart', {
        type: 'line',
        data: {
            labels: months.map(axisMonth),
            datasets: series.map(s => ({
                label: s.label, endLabel: s.label, data: s.data, borderColor: s.color, backgroundColor: s.color,
                borderWidth: s.width, tension: 0.35, spanGaps: true,
                pointRadius: months.map((_, i) => (i === selIdx ? 4.5 : 0)), pointHoverRadius: 4.5,
                pointBorderColor: p.surface, pointBorderWidth: 2
            }))
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            layout: { padding: { right: 78, top: 8 } },
            plugins: {
                legend: { display: false },
                crosshair: { color: p.axis },
                endLabels: { color: p.ink2 },
                tooltip: {
                    ...tooltipStyle(), displayColors: true, boxWidth: 8, boxHeight: 8, usePointStyle: true,
                    callbacks: {
                        title: items => longPeriod(months[items[0].dataIndex]),
                        label: ctx => ` ${ctx.dataset.label}  ${fmt1(ctx.parsed.y)}`,
                        footer: items => `${ciPeriod(months[items[0].dataIndex]).present} constituents traded`
                    }
                }
            },
            scales: {
                x: axis(p, { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 9 } }),
                y: axis(p, { grace: '8%', ticks: { maxTicksLimit: 5, callback: v => Number(v).toFixed(0) } })
            }
        },
        plugins: [crosshairPlugin, endLabelPlugin]
    });
}

// ---------------------------------------------------------------------------
// Value map (interest vs price)
// ---------------------------------------------------------------------------

function renderMap() {
    const p = palette();
    const models = rankedModels().filter(m => m.avgPrice > 0);
    const fit = priceFit(models);
    const ciMode = STATE.mapMode === 'ci' && STATE.vclass !== 'motorcycle';
    const maxAuc = Math.max(1, ...models.map(m => m.auctions));
    const radius = m => 3 + 9 * Math.sqrt(m.auctions / maxAuc);
    const top = models.filter(m => m.residual != null).sort((a, b) => b.residual - a.residual);
    const labelled = new Set(top.slice(0, 5));
    const toPoint = m => ({
        x: m.avgPrice, y: m.mii, m, r: radius(m),
        label: ciMode ? (m.ci ? m.model : null) : (labelled.has(m) ? m.model : null)
    });

    const ci = models.filter(m => m.ci);
    const rest = ciMode ? models.filter(m => !m.ci) : models;
    const datasets = [];
    if (fit) {
        const xs = models.map(m => m.avgPrice);
        const lo = Math.min(...xs), hi = Math.max(...xs);
        datasets.push({
            type: 'line', label: 'Price line', data: [{ x: lo, y: fit.predict(lo) }, { x: hi, y: fit.predict(hi) }],
            borderColor: p.muted, borderWidth: 1.5, borderDash: [6, 5], pointRadius: 0, pointHoverRadius: 0, order: 3
        });
    }
    datasets.push({
        label: ciMode ? 'Other models' : 'Models', data: rest.map(toPoint),
        backgroundColor: ciMode ? withAlpha(p.dot, 0.55) : withAlpha(p.accent, 0.5),
        borderColor: p.surface, borderWidth: 1, pointRadius: c => c.raw?.r || 4, pointHoverRadius: c => (c.raw?.r || 4) + 2, order: 2
    });
    if (ciMode) {
        datasets.push({
            label: 'BMW CI', data: ci.map(toPoint), backgroundColor: p.ci, borderColor: p.surface, borderWidth: 2,
            pointRadius: c => Math.max(5, c.raw?.r || 5), pointHoverRadius: c => Math.max(5, c.raw?.r || 5) + 2, order: 1
        });
    }

    const chart = makeChart('mapChart', {
        type: 'scatter',
        data: { datasets },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'nearest', intersect: false, axis: 'xy' },
            onClick: (evt) => {
                const hit = chart.getElementsAtEventForMode(evt, 'nearest', { intersect: false, axis: 'xy' }, false)
                    .filter(e => chart.data.datasets[e.datasetIndex].type !== 'line');
                if (!hit.length) return;
                const m = chart.data.datasets[hit[0].datasetIndex].data[hit[0].index].m;
                showLots(m.make, [m.model], fullName(m.make, m.model), null);
            },
            onHover: (evt, els) => { evt.native.target.style.cursor = els.some(e => chart.data.datasets[e.datasetIndex].type !== 'line') ? 'pointer' : 'default'; },
            plugins: {
                legend: { display: false },
                pointLabels: { color: p.ink, halo: p.surface },
                tooltip: {
                    ...tooltipStyle(),
                    filter: item => item.dataset.type !== 'line',
                    callbacks: {
                        title: items => { const m = items[0].raw.m; return `${fullName(m.make, m.model)}${m.ci ? '  ·  BMW CI' : ''}`; },
                        label: item => { const m = item.raw.m; return [`MII ${fmt1(m.mii)}   ·   ${formatPrice(m.avgPrice)} average`, `${fmtInt(m.auctions)} auctions, ${m.sellThrough}% sold`]; },
                        footer: items => { const r = items[0].raw.m.residual; return r == null ? '' : `${signed(r)} points vs what its price predicts`; }
                    }
                }
            },
            scales: {
                x: axis(p, {
                    type: 'logarithmic',
                    grid: { color: c => (PRICE_TICKS.includes(c.tick?.value) ? p.grid : 'transparent'), drawTicks: false },
                    title: { display: true, text: 'Average sale price (log scale)', color: p.muted, font: { size: 11.5 } },
                    ticks: {
                        maxRotation: 0, autoSkip: false,
                        callback: v => (PRICE_TICKS.includes(v) ? formatPrice(v) : '')
                    }
                }),
                y: axis(p, { title: { display: true, text: 'MII', color: p.muted, font: { size: 11.5 } }, ticks: { maxTicksLimit: 6 } })
            }
        },
        plugins: [pointLabelPlugin]
    });

    const list = document.getElementById('valueList');
    list.innerHTML = top.slice(0, 7).map((m, i) => `
        <li><button data-i="${i}">
            <span style="min-width:0">
                <span class="rl-name" style="display:block">${esc(md(m.model))} ${m.ci ? '<span class="ci-badge">CI</span>' : ''}</span>
                <span class="rl-sub">${esc(mk(m.make))} · ${formatPrice(m.avgPrice)}</span>
            </span>
            <span class="rl-val up">+${m.residual.toFixed(1)}</span>
        </button></li>`).join('') || `<li class="empty-note">Not enough ranked models in this period.</li>`;
    list.querySelectorAll('button').forEach(btn => {
        const m = top[+btn.dataset.i];
        btn.addEventListener('click', () => showLots(m.make, [m.model], fullName(m.make, m.model), btn));
    });
}

// ---------------------------------------------------------------------------
// Manufacturers: table and heatmap
// ---------------------------------------------------------------------------

function filteredMakes() {
    const p = period();
    if (!p) return [];
    const dir = STATE.sortOrder === 'desc' ? -1 : 1;
    const q = STATE.makeSearch.trim().toLowerCase();
    return p.manufacturers
        .filter(m => m.auctions >= STATE.minAuctions)
        .filter(m => !q || m.make.toLowerCase().includes(q))
        .sort((a, b) => {
            const av = a[STATE.sortBy], bv = b[STATE.sortBy];
            if (typeof av === 'string' || typeof bv === 'string') return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
            const am = av == null || !isFinite(av), bm = bv == null || !isFinite(bv);
            if (am || bm) return am === bm ? 0 : am ? 1 : -1;
            return (av - bv) * dir;
        });
}

function renderMakes() {
    const makes = filteredMakes();
    const p = period();
    document.getElementById('makesSub').textContent =
        `${makes.length} of ${p?.manufacturers.length ?? 0} makes had ${STATE.minAuctions}+ auctions in ${longPeriod(STATE.period)}. Select one for its models, signals and history.`;
    updateSortHeaders();
    renderMakeTable(makes);
    renderHeatmap(makes);
}

function renderMakeTable(makes) {
    const body = document.getElementById('makeRows');
    if (!makes.length) {
        body.innerHTML = `<tr><td colspan="9" class="muted" style="text-align:center;padding:40px">No makes match these filters</td></tr>`;
        return;
    }
    const max = Math.max(1, ...makes.map(m => m.miiScore));
    const months = seriesMonths(12);
    const visible = STATE.showAllMakes ? makes : makes.slice(0, LEADERBOARD_ROWS);
    body.innerHTML = visible.map((m, i) => `
        <tr class="clickable" data-make="${esc(m.make)}" tabindex="0">
            <td class="rank">${String(i + 1).padStart(2, '0')}</td>
            <td><span class="make-name">${esc(mk(m.make))}</span></td>
            <td><div class="mii-cell"><span class="v">${fmt1(m.miiScore)}</span><span class="bar"><span style="width:${Math.max(2, (m.miiScore / max) * 100).toFixed(0)}%"></span></span></div></td>
            <td class="r">${deltaHTML(m.trendPoints, m.trendAuctions)}</td>
            <td>${sparkline(makeSeries(m.make, months))}</td>
            <td class="r">${fmtInt(m.auctions)}</td>
            <td class="r">${formatPrice(m.avgPrice)}</td>
            <td class="r">${m.sellThrough}%</td>
            <td>${confidenceHTML(m.confidence)}</td>
        </tr>`).join('') + (makes.length > LEADERBOARD_ROWS ? `
        <tr class="more-row"><td colspan="9"><button class="link-btn" id="toggleAllMakes">${STATE.showAllMakes ? `Show the top ${LEADERBOARD_ROWS}` : `Show all ${makes.length} makes`}</button></td></tr>` : '');

    document.getElementById('toggleAllMakes')?.addEventListener('click', () => {
        STATE.showAllMakes = !STATE.showAllMakes;
        renderMakes();
    });
    body.querySelectorAll('tr[data-make]').forEach(tr => {
        tr.addEventListener('click', () => openDrawer(tr.dataset.make, tr));
        tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(tr.dataset.make, tr); } });
    });
}

function updateSortHeaders() {
    document.querySelectorAll('.sort-btn').forEach(btn => {
        const th = btn.closest('th');
        btn.querySelector('.sort-arrow')?.remove();
        if (btn.dataset.sort === STATE.sortBy) {
            th.setAttribute('aria-sort', STATE.sortOrder === 'desc' ? 'descending' : 'ascending');
            btn.insertAdjacentHTML('beforeend', `<span class="sort-arrow" aria-hidden="true">${STATE.sortOrder === 'desc' ? '↓' : '↑'}</span>`);
        } else {
            th.removeAttribute('aria-sort');
        }
    });
}

// Make × month grid in the table's own order, so the search and sort above
// it scope both views. Colour is a single-hue ramp binned over the cells shown.
function renderHeatmap(makes) {
    const grid = document.getElementById('heatGrid');
    const months = DS.months;
    const rows = makes.slice(0, HEATMAP_ROWS);
    const values = rows.flatMap(m => makeSeries(m.make, months)).filter(v => v != null);
    if (!rows.length || !values.length) {
        grid.innerHTML = `<p class="muted">No makes match these filters.</p>`;
        document.getElementById('heatLegend').innerHTML = '';
        return;
    }
    const lo = Math.floor(Math.min(...values)), hi = Math.ceil(Math.max(...values));
    const bins = 8;
    const bin = v => Math.min(bins - 1, Math.floor(((v - lo) / Math.max(1, hi - lo)) * bins));
    const sel = STATE.period;
    grid.style.gridTemplateColumns = `minmax(110px, 160px) repeat(${months.length}, minmax(30px, 1fr))`;
    const isSel = k => sel === k || (sel === 'YTD' && DS.ytdMonths?.includes(k));
    grid.innerHTML = `<span></span>` + months.map(k => `<span class="hm-col ${isSel(k) ? 'is-sel' : ''}">${esc(axisMonth(k))}</span>`).join('') +
        rows.map(m => {
            const series = makeSeries(m.make, months);
            return `<button class="hm-label" data-make="${esc(m.make)}" title="Open ${esc(mk(m.make))}">${esc(mk(m.make))}</button>` +
                series.map((v, i) => {
                    const k = months[i];
                    if (v == null) return `<span class="hm-cell empty" data-tip="${esc(mk(m.make))}|${esc(longPeriod(k))}|no data"></span>`;
                    const a = DS.quarterData[k].makeMap.get(m.make).auctions;
                    return `<span class="hm-cell" tabindex="0" style="background:var(--heat-${bin(v)})"
                        data-tip="${esc(mk(m.make))}|${esc(longPeriod(k))}|MII ${v.toFixed(1)} · ${fmtInt(a)} auction${a === 1 ? '' : 's'}" aria-label="${esc(mk(m.make))}, ${esc(longPeriod(k))}: MII ${v.toFixed(1)}"></span>`;
                }).join('');
        }).join('');
    grid.querySelectorAll('.hm-label').forEach(b => b.addEventListener('click', () => openDrawer(b.dataset.make, b)));
    bindTips(grid);
    document.getElementById('heatLegend').innerHTML =
        `<span>MII ${lo}</span><span class="ramp">${Array.from({ length: bins }, (_, i) => `<span style="background:var(--heat-${i})"></span>`).join('')}</span><span>${hi}</span>
         <span style="margin-left:12px">Bold month: selected period · Hatched: no auctions</span>`;
}

function bindTips(root) {
    const tip = document.getElementById('tip');
    const show = el => {
        const [a, b, c] = el.dataset.tip.split('|');
        tip.innerHTML = `<b>${a}</b><br><span class="t-sub">${b}</span><br>${c}`;
        const r = el.getBoundingClientRect();
        tip.classList.add('show');
        const tw = tip.offsetWidth, th = tip.offsetHeight;
        tip.style.left = `${Math.min(window.innerWidth - tw - 8, Math.max(8, r.left + r.width / 2 - tw / 2))}px`;
        tip.style.top = `${r.top - th - 8 < 8 ? r.bottom + 8 : r.top - th - 8}px`;
    };
    const hide = () => tip.classList.remove('show');
    root.querySelectorAll('[data-tip]').forEach(el => {
        el.addEventListener('mouseenter', () => show(el));
        el.addEventListener('focus', () => show(el));
        el.addEventListener('mouseleave', hide);
        el.addEventListener('blur', hide);
    });
}

// ---------------------------------------------------------------------------
// Models table
// ---------------------------------------------------------------------------

function renderModels() {
    const q = STATE.modelSearch.trim().toLowerCase();
    const sub = document.getElementById('modelsSub');
    let list;
    if (STATE.ciOnly) {
        list = allModels().filter(m => m.ci && (!q || m.model.toLowerCase().includes(q))).sort((a, b) => b.mii - a.mii);
        sub.textContent = `Every BMW CI constituent that traded in ${longPeriod(STATE.period)}, with no minimum auction count.`;
    } else if (q) {
        list = allModels().filter(m => m.model.toLowerCase().includes(q) || m.make.toLowerCase().includes(q)).sort((a, b) => b.mii - a.mii).slice(0, 60);
        sub.textContent = `${list.length} model${list.length === 1 ? '' : 's'} matching "${STATE.modelSearch.trim()}".`;
    } else {
        list = rankedModels().sort((a, b) => b.mii - a.mii).slice(0, 25);
        sub.textContent = `Top 25 models with ${MIN_MODEL_AUCTIONS}+ auctions in ${longPeriod(STATE.period)}. BMW CI constituents are marked in blue.`;
    }
    const body = document.getElementById('modelRows');
    if (!list.length) {
        body.innerHTML = `<tr><td colspan="8" class="muted" style="text-align:center;padding:40px">No models match</td></tr>`;
        return;
    }
    const max = Math.max(1, ...list.map(m => m.mii));
    body.innerHTML = list.map((m, i) => `
        <tr class="clickable ${m.ci ? 'is-ci' : ''}" data-i="${i}" tabindex="0">
            <td class="rank">${String(i + 1).padStart(2, '0')}</td>
            <td><span class="make-name">${esc(md(m.model))}</span> <span class="muted">${esc(mk(m.make))}</span> ${m.ci ? '<span class="ci-badge" title="HAGI BMW Classic Index constituent">BMW CI</span>' : ''}</td>
            <td><div class="mii-cell"><span class="v">${fmt1(m.mii)}</span><span class="bar ${m.ci ? 'ci' : ''}"><span style="width:${Math.max(2, (m.mii / max) * 100).toFixed(0)}%"></span></span></div></td>
            <td class="r">${deltaHTML(m.trendPoints, m.trendAuctions)}</td>
            <td class="r">${fmtInt(m.auctions)}</td>
            <td class="r">${formatPrice(m.avgPrice)}</td>
            <td class="r">${m.sellThrough}%</td>
            <td>${confidenceHTML(m.confidence)}</td>
        </tr>`).join('');
    body.querySelectorAll('tr[data-i]').forEach(tr => {
        const m = list[+tr.dataset.i];
        const open = () => showLots(m.make, [m.model], fullName(m.make, m.model), tr, m.ci ? 'BMW CI constituent' : undefined);
        tr.addEventListener('click', open);
        tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
}

// ---------------------------------------------------------------------------
// Movers and eras
// ---------------------------------------------------------------------------

function renderMovers() {
    const phrase = baselinePhrase(STATE.period);
    document.getElementById('moversSub').textContent = phrase
        ? `Models whose MII moved ${phrase} by more than sampling noise allows, on ${MIN_MODEL_AUCTIONS}+ auctions at each end`
        : 'Changes start from the second month of data';
    const real = rankedModels().filter(isRealMove);
    const up = real.filter(m => m.trendPoints > 0).sort((a, b) => b.trendPoints - a.trendPoints).slice(0, 5);
    const down = real.filter(m => m.trendPoints < 0).sort((a, b) => a.trendPoints - b.trendPoints).slice(0, 5);
    const col = (title, list, dir) => `<div><h3><span class="${dir}" aria-hidden="true">${dir === 'up' ? '▲' : '▼'}</span>${title}</h3>
        ${list.length ? list.map(m => `<button class="mover" data-make="${esc(m.make)}" data-model="${esc(m.model)}">
            <span class="m-name" title="${esc(md(m.model))}">${esc(md(m.model))} ${m.ci ? '<span class="ci-badge">CI</span>' : ''}</span>
            <span class="m-val ${dir}">${signed(m.trendPoints)}</span>
            <span class="m-sub">${esc(mk(m.make))} · MII ${fmt1(m.mii)}</span>
        </button>`).join('') : `<p class="empty-note">Nothing beyond normal noise.</p>`}</div>`;
    const el = document.getElementById('movers');
    el.innerHTML = col('Rising', up, 'up') + col('Cooling', down, 'down');
    el.querySelectorAll('.mover').forEach(b => b.addEventListener('click', () =>
        showLots(b.dataset.make, [b.dataset.model], fullName(b.dataset.make, b.dataset.model), b)));
}

function renderEra() {
    const rows = period()?.rows || [];
    const byDecade = [...groupBy(rows.filter(r => num(r.decade) != null), r => num(r.decade))]
        .map(([d, rs]) => ({ d, mii: mean(rs.map(r => num(r.mii_score))), n: rs.reduce((s, r) => s + (num(r.auction_count) || 0), 0), rows: rs.length }))
        .filter(e => e.n >= 50 && e.d >= 1900)
        .sort((a, b) => a.d - b.d);
    const el = document.getElementById('eraList');
    if (!byDecade.length) { el.innerHTML = `<li class="empty-note">No data for this period.</li>`; return; }
    const max = Math.max(...byDecade.map(e => e.mii));
    const topD = byDecade.reduce((a, b) => (b.mii > a.mii ? b : a)).d;
    el.innerHTML = byDecade.map(e => `
        <li class="era-row ${e.d === topD ? 'is-top' : ''}">
            <span class="e-label">${e.d}s</span>
            <span class="e-track"><span class="e-fill" style="width:${((e.mii / max) * 78).toFixed(1)}%"></span>
                <span class="e-n" style="left:${((e.mii / max) * 78).toFixed(1)}%">${fmtInt(e.n)} auctions</span></span>
            <span class="e-val">${fmt1(e.mii)}</span>
        </li>`).join('');
}

// ---------------------------------------------------------------------------
// Make drawer
// ---------------------------------------------------------------------------

let drawerOpener = null;

function openDrawer(make, opener) {
    STATE.make = make;
    drawerOpener = opener || document.activeElement;
    renderDrawer();
    document.getElementById('scrim').classList.add('open');
    const d = document.getElementById('drawer');
    d.classList.add('open');
    d.setAttribute('aria-hidden', 'false');
    setTimeout(() => document.getElementById('drawerClose').focus(), 50);
    syncURL();
}

function closeDrawer() {
    if (!STATE.make) return;
    STATE.make = null;
    document.getElementById('scrim').classList.remove('open');
    const d = document.getElementById('drawer');
    d.classList.remove('open');
    d.setAttribute('aria-hidden', 'true');
    if (drawerOpener && document.contains(drawerOpener)) drawerOpener.focus();
    syncURL();
}

function renderDrawer() {
    const make = STATE.make;
    if (!make) return;
    const m = period()?.makeMap.get(make);
    document.getElementById('drawerTitle').textContent = mk(make);
    document.getElementById('drawerKicker').textContent = `Manufacturer · ${longPeriod(STATE.period)}`;
    const body = document.getElementById('drawerBody');
    if (!m) {
        body.innerHTML = `<p class="muted">${esc(mk(make))} has no auctions in ${esc(longPeriod(STATE.period))}.</p>`;
        return;
    }
    const ms = marketStats(STATE.period);

    // Signal mix: the make's average percentile on each MII input. 50 is the
    // median car; inputs with no measurement for this make are listed as such.
    // An input measured on only a sliver of the make's rows says little about
    // the make, so it is flagged and sorted after the well-measured ones.
    const signals = MII.COMPONENTS.map(c => {
        const rs = m.rows.filter(r => isFinite(parseFloat(r[c.raw])));
        const coverage = m.rows.length ? rs.length / m.rows.length : 0;
        return { label: c.label, coverage, thin: coverage < 0.25, v: rs.length ? mean(rs.map(r => num(r[c.norm]))) * 100 : null };
    }).sort((a, b) => (a.thin - b.thin) || ((b.v ?? -1) - (a.v ?? -1)));

    const ciCount = m.models.filter(x => x.ci).length;
    body.innerHTML = `
        <div class="stat-row">
            <div class="s"><div class="s-l">MII</div><div class="s-v">${fmt1(m.miiScore)}</div><div class="s-d">${deltaHTML(m.trendPoints, m.trendAuctions)} <span class="muted">${esc(baselinePhrase(STATE.period))}</span></div></div>
            <div class="s"><div class="s-l">Auctions</div><div class="s-v">${fmtInt(m.auctions)}</div><div class="s-d muted">${m.sellThrough}% sold</div></div>
            <div class="s"><div class="s-l">Avg price</div><div class="s-v">${formatPrice(m.avgPrice)}</div><div class="s-d muted">${ms?.mii != null ? `${signed(m.miiScore - ms.mii)} vs market` : ''}</div></div>
        </div>
        <div>
            <div class="block-title">MII by month <span class="legend" style="font-size:12px"><span><i style="color:var(--bmw)"></i>${esc(mk(make))}</span><span><i style="color:var(--market)"></i>Market</span></span></div>
            <div class="drawer-chart"><canvas id="drawerChart" role="img" aria-label="${esc(mk(make))} MII by month against the market"></canvas></div>
        </div>
        <div>
            <div class="block-title">What drives the score <span class="muted">percentile vs every car · line = median</span></div>
            <div class="signal-list">${signals.map(s => `
                <div class="signal ${s.v == null || s.thin ? 'is-missing' : ''}" title="Measured on ${Math.round(s.coverage * 100)}% of this make's model-months">
                    <span>${esc(s.label)}${s.thin && s.v != null ? ' <span style="font-size:11px">· limited data</span>' : ''}</span>
                    <span class="sg-track">${s.v != null ? `<span class="sg-fill" style="width:${s.v.toFixed(0)}%;${s.thin ? 'opacity:.35' : ''}"></span>` : ''}</span>
                    <span class="sg-v">${s.v != null ? s.v.toFixed(0) : '<span class="muted" style="font-weight:400;font-size:12px">n/a</span>'}</span>
                </div>`).join('')}
            </div>
        </div>
        <div>
            <div class="block-title">Models <span class="muted">${m.models.length}${ciCount ? ` · ${ciCount} BMW CI model groups` : ''} · select for sales</span></div>
            <ul class="model-list">${m.models.map((x, i) => `
                <li><button data-i="${i}">
                    <span style="min-width:0"><span class="ml-name">${esc(md(x.model))}</span> ${x.ci ? '<span class="ci-badge">BMW CI</span>' : ''}
                        <span class="ml-sub" style="display:block">${x.auctions === 1 ? '1 auction' : `${fmtInt(x.auctions)} auctions`} · ${formatPrice(x.avgPrice)} · ${x.sellThrough}% sold</span></span>
                    <span class="ml-right"><span class="ml-mii">${fmt1(x.mii)}</span><span class="ml-d">${deltaHTML(x.trendPoints, x.trendAuctions)}</span></span>
                </button></li>`).join('')}
            </ul>
        </div>`;
    body.querySelectorAll('.model-list button').forEach(b => {
        const x = m.models[+b.dataset.i];
        b.addEventListener('click', () => showLots(make, [x.model], fullName(make, x.model), b, x.ci ? 'BMW CI constituent' : undefined));
    });

    const p = palette();
    const months = DS.months;
    makeChart('drawerChart', {
        type: 'line',
        data: {
            labels: months.map(axisMonth),
            datasets: [
                { label: mk(make), endLabel: mk(make).length > 12 ? 'Make' : mk(make), data: makeSeries(make, months), borderColor: p.bmw, backgroundColor: p.bmw, borderWidth: 2.5, tension: 0.35, pointRadius: 0, pointHoverRadius: 4, spanGaps: true },
                { label: 'Market', endLabel: 'Market', data: months.map(k => marketStats(k)?.mii ?? null), borderColor: p.market, backgroundColor: p.market, borderWidth: 2, tension: 0.35, pointRadius: 0, pointHoverRadius: 4, spanGaps: true }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            layout: { padding: { right: 70, top: 6 } },
            plugins: {
                legend: { display: false },
                crosshair: { color: p.axis },
                endLabels: { color: p.ink2 },
                tooltip: { ...tooltipStyle(), displayColors: true, boxWidth: 8, boxHeight: 8, usePointStyle: true,
                    callbacks: { title: items => longPeriod(months[items[0].dataIndex]), label: ctx => ` ${ctx.dataset.label}  ${fmt1(ctx.parsed.y)}` } }
            },
            scales: {
                x: axis(p, { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 6 } }),
                y: axis(p, { grace: '10%', ticks: { maxTicksLimit: 4, callback: v => Number(v).toFixed(0) } })
            }
        },
        plugins: [crosshairPlugin, endLabelPlugin]
    });
}

// ---------------------------------------------------------------------------
// Lot modal: the individual sales behind a model's average
// ---------------------------------------------------------------------------

let lotOpener = null;

function showLots(make, models, title, opener, kicker) {
    lotOpener = opener || document.activeElement;
    const lots = models.flatMap(model => (batLots[modelJoinKey(make, model)] || []).map(l => ({ ...l, model })))
        .sort((a, b) => b.date.localeCompare(a.date));
    document.getElementById('lotTitle').textContent = title;
    document.getElementById('lotKicker').innerHTML = kicker
        ? `<span class="ci-badge">BMW CI</span> <span>${esc(kicker === 'BMW CI constituent' ? 'Constituent · individual sales' : kicker)}</span>`
        : 'Individual sales';

    const usdSold = lots.filter(l => l.sold && l.currency === 'USD' && l.amount != null);
    const soldCount = lots.filter(l => l.sold).length;
    const avg = usdSold.length ? mean(usdSold.map(l => l.amount)) : null;
    document.getElementById('lotStats').innerHTML = `
        <div class="s"><div class="s-l">Listings</div><div class="s-v">${fmtInt(lots.length)}</div></div>
        <div class="s"><div class="s-l">Sold</div><div class="s-v">${fmtInt(soldCount)}</div><div class="s-d muted">${lots.length ? Math.round((soldCount / lots.length) * 100) : 0}% sell-through</div></div>
        <div class="s"><div class="s-l">Average sold</div><div class="s-v">${avg != null ? formatPrice(avg) : '—'}</div><div class="s-d muted">USD sales</div></div>
        <div class="s"><div class="s-l">Range</div><div class="s-v" style="font-size:18px">${usdSold.length ? `${formatPrice(Math.min(...usdSold.map(l => l.amount)))}–${formatPrice(Math.max(...usdSold.map(l => l.amount)))}` : '—'}</div></div>`;

    const multi = models.length > 1;
    document.getElementById('lotRows').innerHTML = lots.length ? lots.map(l => `
        <tr>
            <td class="mono" style="font-size:13px">${esc(l.date)}</td>
            <td>${multi ? esc(l.model) : `<span class="muted">${esc(md(l.model))}</span>`}</td>
            <td class="r">${l.year ? Math.round(l.year) : '—'}</td>
            <td class="r" style="font-weight:600">${formatCurrency(l.amount, l.currency)}</td>
            <td class="${l.sold ? 'status-sold' : 'muted'}">${l.sold ? 'Sold' : esc(l.saleType || 'Unsold')}</td>
            <td class="r">${l.bids ?? '—'}</td>
            <td class="r">${l.comments ?? '—'}</td>
            <td>${l.url ? `<a href="${esc(l.url)}" target="_blank" rel="noopener" class="link-btn">View</a>` : '—'}</td>
        </tr>`).join('') : `<tr><td colspan="8" class="muted" style="text-align:center;padding:28px">No individual auction records found for this model.</td></tr>`;

    const modal = document.getElementById('lotModal');
    modal.classList.add('open');
    document.getElementById('lotClose').focus();
    setTimeout(() => renderLotChart(lots), 0);
}

function hideLots() {
    const modal = document.getElementById('lotModal');
    if (!modal.classList.contains('open')) return false;
    modal.classList.remove('open');
    if (charts.lotChart) { charts.lotChart.destroy(); delete charts.lotChart; }
    if (lotOpener && document.contains(lotOpener)) lotOpener.focus();
    return true;
}

function renderLotChart(lots) {
    const p = palette();
    const usd = lots.filter(l => l.currency === 'USD' && l.amount != null && !isNaN(Date.parse(l.date)))
        .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    const toPoint = l => ({ x: Date.parse(l.date), y: l.amount, url: l.url, date: l.date, model: l.model, year: l.year });
    const DAY = 864e5;
    const xs = usd.map(l => Date.parse(l.date));
    const span = xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
    const padX = Math.max(30 * DAY, span * 0.05);
    const xRange = xs.length ? { min: Math.min(...xs) - padX, max: Math.max(...xs) + padX } : {};
    const chart = makeChart('lotChart', {
        type: 'scatter',
        data: {
            datasets: [
                { label: 'Sold', data: usd.filter(l => l.sold).map(toPoint), backgroundColor: p.accent, borderColor: p.surface, borderWidth: 2, pointRadius: 5.5, pointHoverRadius: 7.5 },
                { label: 'Not sold (high bid)', data: usd.filter(l => !l.sold).map(toPoint), backgroundColor: p.surface, borderColor: p.muted, borderWidth: 1.5, pointRadius: 4.5, pointHoverRadius: 6.5 }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'nearest', intersect: false },
            onClick: (evt) => {
                const hit = chart.getElementsAtEventForMode(evt, 'nearest', { intersect: false }, false);
                if (!hit.length) return;
                const pt = chart.data.datasets[hit[0].datasetIndex].data[hit[0].index];
                if (pt?.url) window.open(pt.url, '_blank', 'noopener');
            },
            plugins: {
                legend: { position: 'top', align: 'end', labels: { color: p.ink2, usePointStyle: true, boxWidth: 8, boxHeight: 8, font: { size: 12 } } },
                tooltip: { ...tooltipStyle(), callbacks: {
                    title: items => items[0].raw.date,
                    label: item => `${item.dataset.label}: $${Math.round(item.parsed.y).toLocaleString()}`,
                    footer: items => [items[0].raw.year ? `${Math.round(items[0].raw.year)} ${items[0].raw.model}` : items[0].raw.model, 'Select to open the listing'] } }
            },
            scales: {
                x: axis(p, { type: 'linear', ...xRange, grid: { display: false }, ticks: { maxRotation: 0, maxTicksLimit: 8, callback: v => (span < 120 * DAY
                    ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                    : `${new Date(v).toLocaleDateString('en-US', { month: 'short' })} ’${String(new Date(v).getFullYear()).slice(2)}`) } }),
                y: axis(p, { ticks: { maxTicksLimit: 5, callback: v => formatPrice(v) } })
            }
        }
    });
}

// ---------------------------------------------------------------------------
// URL state, sharing, theme
// ---------------------------------------------------------------------------

function syncURL() {
    const params = new URLSearchParams();
    const latest = DS.periods[DS.periods.length - 1];
    if (STATE.period !== latest) params.set('period', STATE.period.replace('-MTD', ''));
    if (STATE.vclass !== 'all') params.set('class', STATE.vclass);
    if (STATE.minAuctions !== 10) params.set('min', STATE.minAuctions);
    if (STATE.make) params.set('make', STATE.make);
    const hash = params.toString();
    history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
}

function readURL() {
    const params = new URLSearchParams(location.hash.slice(1));
    const cls = params.get('class');
    if (['all', 'car', 'motorcycle'].includes(cls)) STATE.vclass = cls;
    const min = parseInt(params.get('min'), 10);
    if ([5, 10, 20, 50].includes(min)) STATE.minAuctions = min;
    return { period: params.get('period'), make: params.get('make') };
}

function resolvePeriod(wanted) {
    if (!wanted) return DS.periods[DS.periods.length - 1];
    return DS.periods.find(k => k === wanted || k.replace('-MTD', '') === wanted) || DS.periods[DS.periods.length - 1];
}

function toast(message) {
    const t = document.getElementById('toast');
    t.textContent = message;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}

async function share() {
    syncURL();
    const url = location.href;
    const text = document.getElementById('lede').textContent;
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
        try { await navigator.share({ title: document.title, text, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    try {
        await navigator.clipboard.writeText(url);
        toast('Link to this view copied');
    } catch (e) {
        window.prompt('Copy this link', url);
    }
}

function effectiveTheme() {
    const set = document.documentElement.dataset.theme;
    if (set) return set;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function toggleTheme() {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('mii-theme', next); } catch (e) {}
    renderCharts();
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function populatePeriods() {
    const sel = document.getElementById('periodSelect');
    sel.innerHTML = DS.periods.slice().reverse().map(k =>
        `<option value="${esc(k)}" ${k === STATE.period ? 'selected' : ''}>${esc(k === 'YTD' ? `${longPeriod(k)} (YTD)` : longPeriod(k))}</option>`).join('');
}

function setPeriod(key) {
    if (!DS.quarterData[key]) return;
    STATE.period = key;
    document.getElementById('periodSelect').value = key;
    renderAll();
}

function setClass(vclass) {
    const prev = STATE.period;
    STATE.vclass = vclass;
    DS = datasetFor(vclass);
    STATE.period = resolvePeriod(prev?.replace('-MTD', ''));
    document.querySelectorAll('#classSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.class === vclass)));
    populatePeriods();
    renderAll();
}

// Charts read their colours from CSS tokens, so a theme switch redraws them.
function renderCharts() {
    renderMarketChart();
    if (STATE.vclass !== 'motorcycle') renderCIChart();
    renderMap();
    if (STATE.make) renderDrawer();
}

function renderAll() {
    renderHero();
    renderInsights();
    renderCI();
    renderMap();
    renderMakes();
    renderModels();
    renderMovers();
    renderEra();
    if (STATE.make) renderDrawer();
    syncURL();
}

function bindControls() {
    document.getElementById('periodSelect').addEventListener('change', e => setPeriod(e.target.value));
    document.querySelectorAll('#classSeg button').forEach(b => b.addEventListener('click', () => setClass(b.dataset.class)));
    document.getElementById('minAuctions').addEventListener('change', e => {
        STATE.minAuctions = Number(e.target.value);
        renderAll();
    });
    document.getElementById('makeSearch').addEventListener('input', e => { STATE.makeSearch = e.target.value; renderMakes(); });
    document.getElementById('modelSearch').addEventListener('input', e => { STATE.modelSearch = e.target.value; renderModels(); });
    document.getElementById('ciOnly').addEventListener('click', e => {
        STATE.ciOnly = !STATE.ciOnly;
        e.currentTarget.setAttribute('aria-pressed', String(STATE.ciOnly));
        renderModels();
    });
    document.querySelectorAll('#makeViewSeg button').forEach(b => b.addEventListener('click', () => {
        STATE.makeView = b.dataset.view;
        document.querySelectorAll('#makeViewSeg button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
        document.getElementById('makeTableView').hidden = STATE.makeView !== 'table';
        document.getElementById('makeHeatView').hidden = STATE.makeView !== 'heat';
    }));
    document.querySelectorAll('#mapSeg button').forEach(b => b.addEventListener('click', () => {
        STATE.mapMode = b.dataset.map;
        document.querySelectorAll('#mapSeg button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
        renderMap();
    }));
    document.querySelectorAll('.sort-btn').forEach(btn => btn.addEventListener('click', () => {
        const key = btn.dataset.sort;
        if (STATE.sortBy === key) STATE.sortOrder = STATE.sortOrder === 'desc' ? 'asc' : 'desc';
        else { STATE.sortBy = key; STATE.sortOrder = key === 'make' ? 'asc' : 'desc'; }
        renderMakes();
    }));

    document.getElementById('drawerClose').addEventListener('click', closeDrawer);
    document.getElementById('scrim').addEventListener('click', closeDrawer);
    document.getElementById('lotClose').addEventListener('click', hideLots);
    document.getElementById('lotModal').addEventListener('click', e => { if (e.target.id === 'lotModal') hideLots(); });
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        if (!hideLots()) closeDrawer();
    });

    document.getElementById('shareBtn').addEventListener('click', share);
    document.getElementById('printBtn').addEventListener('click', () => window.print());
    document.getElementById('themeToggle').addEventListener('click', toggleTheme);
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
        if (!document.documentElement.dataset.theme) renderCharts();
    });
}

async function initializeApp() {
    const loading = document.getElementById('loading');
    try {
        Chart.defaults.font.family = '"Hanken Grotesk", system-ui, sans-serif';
        Chart.defaults.animation.duration = 450;

        const [rawData, batCounts] = await Promise.all([loadCSVData(), loadBatAuctionCounts(), MII.ready]);
        injectAuctionCounts(rawData, batCounts);
        // Percentile ranks are taken once, over every car of each month in
        // every class, so a car's score does not change when the view is
        // narrowed to one class.
        MII.recompute(rawData);
        RAW_ROWS = rawData;

        const wanted = readURL();
        DS = datasetFor(STATE.vclass) || datasetFor('all');
        if (!DS) throw new Error('No valid data found in CSV. Check data format.');
        STATE.period = resolvePeriod(wanted.period);

        document.querySelectorAll('#classSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.class === STATE.vclass)));
        document.getElementById('minAuctions').value = String(STATE.minAuctions);
        const loadedAt = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        document.getElementById('loadedAt').textContent = loadedAt;
        document.getElementById('eyebrowText').textContent = `Bring a Trailer · ${fmtInt(RAW_ROWS.length)} model-months scored · loaded ${loadedAt}`;
        document.getElementById('methodVersion').textContent = `MII methodology ${MII.VERSION}`;

        populatePeriods();
        bindControls();
        renderAll();
        loading.remove();

        if (wanted.make && period()?.makeMap.has(wanted.make)) openDrawer(wanted.make);
    } catch (error) {
        console.error('Failed to load data:', error);
        loading.innerHTML = `
            <div class="error-card">
                <h2>Could not load the MII data</h2>
                <p>${esc(error.message)}</p>
                <p style="font-size:12.5px;color:#9a9ca3">Check the browser console, the S3 bucket's public read and CORS settings, and your connection. Source: ${esc(CSV_URL)}</p>
                <button onclick="location.reload()" class="btn">Try again</button>
            </div>`;
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}
