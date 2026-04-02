// ============================================================
// MII DATA ANALYSIS PAGE
// Explores raw S3 auction data: component breakdown,
// trends, outlier detection, and correlation explorer.
// ============================================================

const CSV_URL = "https://my-mii-reports.s3.us-east-2.amazonaws.com/mii_results_latest.csv";

// MII component weights
const COMPONENTS = [
    { key: 'price_normalized',                  label: 'Sale Price',     weight: 0.30, color: '#f59e0b' },
    { key: 'bids_normalized',                   label: 'Bid Activity',   weight: 0.30, color: '#3b82f6' },
    { key: 'views_normalized',                  label: 'View Count',     weight: 0.20, color: '#10b981' },
    { key: 'comments_normalized',               label: 'Comments',       weight: 0.12, color: '#8b5cf6' },
    { key: 'social_score_normalized',           label: 'Social',         weight: 0.05, color: '#ec4899' },
    { key: 'age_normalized',                    label: 'Vehicle Age',    weight: 0.03, color: '#6b7280' },
];

const METRIC_LABELS = {
    mii_score:              'MII Score',
    price:                  'Sale Price ($)',
    views:                  'Views',
    bids:                   'Bids',
    comments:               'Comments',
    social_score:           'Social Score',
    google_trends_interest: 'Google Trends Interest',
    youtube_total_views:    'YouTube Total Views',
    age:                    'Vehicle Age (yrs)',
    sold_rate:              'Sell-Through Rate (%)',
    volume:                 'Auction Volume',
};

// Manufacturer colour palette (deterministic based on name)
const MFR_PALETTE = [
    '#f59e0b','#3b82f6','#10b981','#8b5cf6','#ec4899','#ef4444',
    '#14b8a6','#f97316','#06b6d4','#84cc16','#a855f7','#0ea5e9',
    '#d946ef','#22c55e','#fb923c','#6366f1','#e11d48','#0891b2',
];

// ---- State ----
let rawData = [];
let quarters = [];
let manufacturers = [];
let mfrColorMap = {};

// Chart instances — tracked for destroy/recreate
const charts = {};

// ---- Utilities ----
// Format "2025-05" → "May 2025" for chart labels
function fmtPeriod(p) {
    const m = p && p.match(/^(\d{4})-(\d{2})$/);
    if (m) {
        const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, 1);
        return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    }
    return p;
}

function fmtNum(v, decimals = 1) {
    if (v == null || isNaN(v)) return '—';
    if (Math.abs(v) >= 1_000_000) return '$' + (v / 1_000_000).toFixed(1) + 'M';
    if (Math.abs(v) >= 1_000)    return (v / 1_000).toFixed(1) + 'k';
    return v.toFixed(decimals);
}

function fmtPrice(v) {
    if (v == null || isNaN(v)) return '—';
    return '$' + Math.round(v).toLocaleString();
}

function avg(arr) {
    if (!arr.length) return 0;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr) {
    if (arr.length < 2) return 0;
    const m = avg(arr);
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

function pearson(xs, ys) {
    if (xs.length < 2) return null;
    const mx = avg(xs), my = avg(ys);
    let num = 0, dx2 = 0, dy2 = 0;
    for (let i = 0; i < xs.length; i++) {
        num += (xs[i] - mx) * (ys[i] - my);
        dx2 += (xs[i] - mx) ** 2;
        dy2 += (ys[i] - my) ** 2;
    }
    const denom = Math.sqrt(dx2 * dy2);
    return denom === 0 ? 0 : num / denom;
}

function getRowValue(row, metric) {
    const v = parseFloat(row[metric]);
    return isNaN(v) ? null : v;
}

function destroyChart(key) {
    if (charts[key]) {
        charts[key].destroy();
        charts[key] = null;
    }
}

function getMfrColor(name) {
    if (!mfrColorMap[name]) {
        const idx = Object.keys(mfrColorMap).length % MFR_PALETTE.length;
        mfrColorMap[name] = MFR_PALETTE[idx];
    }
    return mfrColorMap[name];
}

function hexToRGBA(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

// Common Chart.js defaults
const CHART_DEFAULTS = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
        legend: { display: false },
    },
    scales: {
        x: { grid: { color: '#27272a' }, ticks: { color: '#71717a' } },
        y: { grid: { color: '#27272a' }, ticks: { color: '#71717a' } },
    },
};

// ---- Data Loading ----
async function loadData() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
        const res = await fetch(CSV_URL, {
            mode: 'cors',
            signal: controller.signal,
            headers: { 'Accept': 'text/csv' }
        });
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();

        return new Promise((resolve, reject) => {
            Papa.parse(text, {
                header: true,
                skipEmptyLines: true,
                complete: r => r.data.length ? resolve(r.data) : reject(new Error('Empty CSV')),
                error: err => reject(err),
            });
        });
    } catch (e) {
        clearTimeout(timeout);
        throw e;
    }
}

// ---- Init ----
async function init() {
    try {
        rawData = await loadData();

        const rawCount = rawData.length;

        // Filter invalid rows
        rawData = rawData.filter(r =>
            r.quarter && r.quarter !== 'IAF' &&
            r.manufacturer && r.model &&
            !isNaN(parseFloat(r.mii_score))
        );

        quarters = [...new Set(rawData.map(r => r.quarter))].sort();
        manufacturers = [...new Set(rawData.map(r => r.manufacturer))].sort();

        // Assign colours deterministically
        manufacturers.forEach(m => getMfrColor(m));

        // Summary stats
        document.getElementById('statTotalRecords').textContent = rawData.length.toLocaleString();
        const excluded = rawCount - rawData.length;
        if (excluded > 0) {
            const note = document.getElementById('statFilteredNote');
            note.textContent = `${excluded.toLocaleString()} rows excluded (${rawCount.toLocaleString()} raw)`;
            note.classList.remove('hidden');
        }
        document.getElementById('statQuarters').textContent = quarters.length;
        document.getElementById('statQuarterRange').textContent = quarters[0] + ' – ' + quarters[quarters.length - 1];
        document.getElementById('statMakes').textContent = manufacturers.length;
        const models = new Set(rawData.map(r => r.manufacturer + '|' + r.model));
        document.getElementById('statModels').textContent = models.size;
        document.getElementById('statAvgMII').textContent = avg(rawData.map(r => parseFloat(r.mii_score))).toFixed(1);

        // Last updated
        const now = new Date();
        document.getElementById('lastUpdated').textContent = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

        // Populate selects
        populateSelects();

        // Render initial views
        renderComponents();
        renderTrends();
        renderOutliers();
        renderCorrelations();
        renderModelRankings();

        // Hide loading
        document.getElementById('loadingIndicator').classList.add('hidden');

    } catch (err) {
        document.getElementById('loadingIndicator').classList.add('hidden');
        document.getElementById('errorState').classList.remove('hidden');
        document.getElementById('errorMessage').textContent = err.message || String(err);
    }
}

function populateSelects() {
    // Manufacturer dropdowns
    const mfrSelects = ['radarMfrSelect', 'trendMfrSelect', 'corrMfrFilter', 'modelsRankMfr'];
    mfrSelects.forEach(id => {
        const sel = document.getElementById(id);
        // Keep first option (All / Market Average)
        const firstOpt = sel.querySelector('option');
        sel.innerHTML = '';
        if (firstOpt) sel.appendChild(firstOpt);
        manufacturers.forEach(m => {
            const o = document.createElement('option');
            o.value = m;
            o.textContent = m;
            sel.appendChild(o);
        });
    });

    // Compare select (trends)
    const compareEl = document.getElementById('trendCompare');
    compareEl.innerHTML = '<option value="none">None</option>';
    manufacturers.forEach(m => {
        const o = document.createElement('option');
        o.value = m;
        o.textContent = m;
        compareEl.appendChild(o);
    });

    // Quarter selects
    // modelsRankQuarter intentionally omitted here — it should default to "All Months"
    // so the Auctions count shows total auctions across all time, not just one quarter.
    const qSelects = ['componentQuarterSelect', 'outlierQuarter', 'corrQuarter'];
    qSelects.forEach(id => {
        const sel = document.getElementById(id);
        const allOpt = sel.querySelector('option[value="__all__"]');
        sel.innerHTML = '';
        if (allOpt) sel.appendChild(allOpt.cloneNode(true));
        else {
            const o = document.createElement('option');
            o.value = '__all__';
            o.textContent = 'All Months';
            sel.appendChild(o);
        }
        quarters.forEach(q => {
            const o = document.createElement('option');
            o.value = q;
            o.textContent = q;
            sel.appendChild(o);
        });
        // Default to latest quarter
        sel.value = quarters[quarters.length - 1];
    });

    // Model Rankings quarter select — populated separately, stays at "All Months"
    const modelsQSel = document.getElementById('modelsRankQuarter');
    if (modelsQSel) {
        quarters.forEach(q => {
            const o = document.createElement('option');
            o.value = q;
            o.textContent = q;
            modelsQSel.appendChild(o);
        });
        // stays at __all__ (first option, already in HTML)
    }

    // Model datalists — initial population (all models)
    ['radarModelList', 'trendModelList', 'outlierModelList', 'corrModelList'].forEach(id => {
        populateModelDatalist(id, '__all__');
    });
}

// ============================================================
// SECTION 5: Model Rankings
// ============================================================

const RANK_METRIC_LABELS = {
    mii_score: 'MII Score',
    price: 'Avg Sale Price',
    views: 'Avg Views',
    bids: 'Avg Bids',
    sold_rate: 'Sell-Through Rate (%)',
    volume: 'Auction Volume',
};

function formatRankMetric(metric, val) {
    if (val == null) return '—';
    if (metric === 'price') return fmtPrice(val);
    if (metric === 'sold_rate') return val.toFixed(1) + '%';
    if (metric === 'volume') return Math.round(val).toLocaleString() + ' auctions';
    if (metric === 'views' || metric === 'bids') return Math.round(val).toLocaleString();
    return val.toFixed(2);
}

function renderModelRankings() {
    const mfr = document.getElementById('modelsRankMfr').value;
    const quarter = document.getElementById('modelsRankQuarter').value;
    const rankMetric = document.getElementById('modelsRankMetric').value;
    const n = parseInt(document.getElementById('modelsRankN').value, 10);

    let data = filterByQuarter(rawData, quarter);
    if (mfr !== '__all__') data = data.filter(r => r.manufacturer === mfr);

    // Aggregate by manufacturer + model
    const modelMap = {};
    data.forEach(r => {
        const key = r.manufacturer + '|||' + r.model;
        if (!modelMap[key]) {
            modelMap[key] = {
                manufacturer: r.manufacturer,
                model: r.model,
                count: 0,
                mii_vals: [], price_vals: [], views_vals: [], bids_vals: [], sold_vals: [],
            };
        }
        const m = modelMap[key];
        m.count += (parseFloat(r.auction_count) || 1);
        const mii = parseFloat(r.mii_score);   if (!isNaN(mii))             m.mii_vals.push(mii);
        const price = parseFloat(r.price);     if (!isNaN(price) && price > 0) m.price_vals.push(price);
        const views = parseFloat(r.views);     if (!isNaN(views))            m.views_vals.push(views);
        const bids  = parseFloat(r.bids);      if (!isNaN(bids))             m.bids_vals.push(bids);
        const sold  = parseFloat(r.sold_rate); if (!isNaN(sold))             m.sold_vals.push(sold);
    });

    const rows = Object.values(modelMap).map(m => ({
        manufacturer: m.manufacturer,
        model: m.model,
        count: m.count,
        mii_score: m.mii_vals.length  ? avg(m.mii_vals)   : null,
        price:     m.price_vals.length ? avg(m.price_vals) : null,
        views:     m.views_vals.length ? avg(m.views_vals) : null,
        bids:      m.bids_vals.length  ? avg(m.bids_vals)  : null,
        sold_rate: m.sold_vals.length  ? avg(m.sold_vals)  : null,
        volume:    m.count,
    }));

    rows.sort((a, b) => (b[rankMetric] ?? -Infinity) - (a[rankMetric] ?? -Infinity));
    const topRows = rows.slice(0, n);

    // Titles
    const rankLabel = RANK_METRIC_LABELS[rankMetric] || rankMetric;
    document.getElementById('modelsRankChartTitle').textContent =
        `Top ${topRows.length} Models by ${rankLabel}`;
    document.getElementById('modelsRankChartSubtitle').textContent =
        (mfr === '__all__' ? 'All manufacturers' : mfr) + ' — ' +
        (quarter === '__all__' ? 'all months' : quarter);
    document.getElementById('modelsRankTableTitle').textContent =
        `Model Leaderboard — ${rankLabel}`;
    document.getElementById('modelsRankTableCount').textContent =
        `${rows.length} unique models`;

    // Horizontal bar chart
    destroyChart('modelsRank');
    const ctx = document.getElementById('modelsRankChart').getContext('2d');
    const chartLabels = topRows.map(r => r.model.length > 30 ? r.model.slice(0, 28) + '…' : r.model);
    const chartData   = topRows.map(r => r[rankMetric]);
    const chartColors = topRows.map(r => getMfrColor(r.manufacturer));

    charts.modelsRank = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: chartLabels,
            datasets: [{
                label: rankLabel,
                data: chartData,
                backgroundColor: chartColors.map(c => hexToRGBA(c, 0.8)),
                borderColor: chartColors,
                borderWidth: 1,
                borderRadius: 4,
            }]
        },
        options: {
            ...CHART_DEFAULTS,
            indexAxis: 'y',
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: items => topRows[items[0].dataIndex].manufacturer + ' — ' + topRows[items[0].dataIndex].model,
                        label: item => `${rankLabel}: ${formatRankMetric(rankMetric, item.raw)}`,
                    }
                }
            },
            scales: {
                x: { grid: { color: '#27272a' }, ticks: { color: '#71717a' } },
                y: { grid: { color: '#27272a' }, ticks: { color: '#a1a1aa', font: { size: 11 } } },
            }
        }
    });

    // Table
    const tbody = document.getElementById('modelsRankTable');
    tbody.innerHTML = '';
    const podiumColors = ['text-amber-400', 'text-zinc-300', 'text-amber-600'];
    topRows.forEach((r, i) => {
        const rankCls = i < 3 ? podiumColors[i] : 'text-zinc-500';
        const hl = col => col === rankMetric ? 'text-amber-400 font-medium' : 'text-zinc-300';
        const tr = document.createElement('tr');
        tr.className = 'border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors';
        tr.innerHTML = `
            <td class="px-4 py-2.5 font-bold ${rankCls}">#${i + 1}</td>
            <td class="px-4 py-2.5 text-zinc-400 whitespace-nowrap">${r.manufacturer}</td>
            <td class="px-4 py-2.5 font-medium">${r.model}</td>
            <td class="px-4 py-2.5 text-right ${hl('volume')}">${r.count.toLocaleString()}</td>
            <td class="px-4 py-2.5 text-right ${hl('mii_score')}">${r.mii_score != null ? r.mii_score.toFixed(2) : '—'}</td>
            <td class="px-4 py-2.5 text-right ${hl('price')}">${r.price != null ? fmtPrice(r.price) : '—'}</td>
            <td class="px-4 py-2.5 text-right ${hl('views')}">${r.views != null ? Math.round(r.views).toLocaleString() : '—'}</td>
            <td class="px-4 py-2.5 text-right ${hl('bids')}">${r.bids != null ? r.bids.toFixed(1) : '—'}</td>
            <td class="px-4 py-2.5 text-right ${hl('sold_rate')}">${r.sold_rate != null ? r.sold_rate.toFixed(1) + '%' : '—'}</td>
        `;
        tbody.appendChild(tr);
    });
}

// ---- Model Search Utilities ----

function populateModelDatalist(datalistId, mfr) {
    const dl = document.getElementById(datalistId);
    if (!dl) return;
    const source = (mfr && mfr !== '__all__')
        ? rawData.filter(r => r.manufacturer === mfr)
        : rawData;
    const models = [...new Set(source.map(r => r.model))].sort();
    dl.innerHTML = models.map(m => `<option value="${m.replace(/"/g, '&quot;')}">`).join('');
}

function getModelFilter(inputId) {
    const input = document.getElementById(inputId);
    return input ? input.value.trim() || null : null;
}

function filterByModel(data, model) {
    if (!model) return data;
    const lower = model.toLowerCase();
    return data.filter(r => r.model.toLowerCase().includes(lower));
}

// Wire up a model search input: updates datalist when manufacturer changes,
// triggers re-render on input (debounced), and handles the clear button.
function wireModelSearch(inputId, clearBtnId, datalistId, mfrSelectId, onChangeCallback) {
    const input = document.getElementById(inputId);
    const clearBtn = document.getElementById(clearBtnId);
    const mfrSel = mfrSelectId ? document.getElementById(mfrSelectId) : null;
    if (!input || !clearBtn) return;

    function updateClearBtn() {
        clearBtn.classList.toggle('visible', input.value.trim().length > 0);
    }

    clearBtn.addEventListener('click', () => {
        input.value = '';
        updateClearBtn();
        onChangeCallback();
    });

    let debTimer;
    input.addEventListener('input', () => {
        updateClearBtn();
        clearTimeout(debTimer);
        debTimer = setTimeout(onChangeCallback, 250);
    });

    if (mfrSel) {
        mfrSel.addEventListener('change', () => {
            input.value = '';
            updateClearBtn();
            populateModelDatalist(datalistId, mfrSel.value);
        });
    }
}

// ---- Event Listeners ----
document.addEventListener('DOMContentLoaded', () => {
    // Tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => {
                b.classList.remove('active');
                b.classList.add('text-zinc-400');
            });
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

            btn.classList.add('active');
            btn.classList.remove('text-zinc-400');
            document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
        });
    });

    // Component tab controls
    document.getElementById('radarMfrSelect').addEventListener('change', renderComponents);
    document.getElementById('componentQuarterSelect').addEventListener('change', renderComponentStacked);

    // Trend tab controls
    ['trendMetric', 'trendMfrSelect', 'trendCompare'].forEach(id => {
        document.getElementById(id).addEventListener('change', renderTrends);
    });

    // Outlier tab controls
    ['outlierMetric', 'outlierQuarter', 'outlierN'].forEach(id => {
        document.getElementById(id).addEventListener('change', renderOutliers);
    });
    document.getElementById('btnHighViewsLowBids').addEventListener('click', () => renderSpecialOutlier('hvlb'));
    document.getElementById('btnHighPriceLowMII').addEventListener('click', () => renderSpecialOutlier('hplm'));
    document.getElementById('btnLowPriceHighMII').addEventListener('click', () => renderSpecialOutlier('lphm'));

    // Correlation tab controls
    ['corrX', 'corrY', 'corrQuarter', 'corrColorBy', 'corrMfrFilter'].forEach(id => {
        document.getElementById(id).addEventListener('change', renderCorrelations);
    });

    // Model Rankings tab controls
    ['modelsRankMfr', 'modelsRankQuarter', 'modelsRankMetric', 'modelsRankN'].forEach(id => {
        document.getElementById(id).addEventListener('change', renderModelRankings);
    });

    // Model search wiring (sets up datalist refresh + debounced re-render)
    wireModelSearch('radarModelSearch',   'radarModelClear',   'radarModelList',   'radarMfrSelect', renderComponents);
    wireModelSearch('trendModelSearch',   'trendModelClear',   'trendModelList',   'trendMfrSelect', renderTrends);
    wireModelSearch('outlierModelSearch', 'outlierModelClear', 'outlierModelList', null,             renderOutliers);
    wireModelSearch('corrModelSearch',    'corrModelClear',    'corrModelList',    'corrMfrFilter',  renderCorrelations);

    init();
});

// ============================================================
// SECTION 1: Component Breakdown
// ============================================================

function filterByQuarter(data, quarter) {
    if (quarter === '__all__') return data;
    return data.filter(r => r.quarter === quarter);
}

function getComponentAverages(data) {
    const result = {};
    COMPONENTS.forEach(c => {
        const vals = data.map(r => parseFloat(r[c.key])).filter(v => !isNaN(v));
        result[c.key] = vals.length ? avg(vals) : 0;
    });
    return result;
}

function renderComponents() {
    const mfr = document.getElementById('radarMfrSelect').value;
    const model = getModelFilter('radarModelSearch');

    let data = mfr === '__all__' ? rawData : rawData.filter(r => r.manufacturer === mfr);
    data = filterByModel(data, model);
    const marketData = rawData;

    const selected = getComponentAverages(data);
    const market = getComponentAverages(marketData);

    renderRadarChart(selected, market, mfr);
    renderComponentBar(selected, market, mfr);
    renderComponentStacked();
}

function renderRadarChart(selected, market, mfrLabel) {
    destroyChart('radar');
    const ctx = document.getElementById('radarChart').getContext('2d');
    const labels = COMPONENTS.map(c => c.label);

    charts.radar = new Chart(ctx, {
        type: 'radar',
        data: {
            labels,
            datasets: [
                {
                    label: mfrLabel === '__all__' ? 'Market Average' : mfrLabel,
                    data: COMPONENTS.map(c => selected[c.key]),
                    borderColor: '#f59e0b',
                    backgroundColor: 'rgba(245,158,11,0.15)',
                    borderWidth: 2,
                    pointBackgroundColor: '#f59e0b',
                    pointRadius: 4,
                },
                ...(mfrLabel !== '__all__' ? [{
                    label: 'Market Average',
                    data: COMPONENTS.map(c => market[c.key]),
                    borderColor: '#52525b',
                    backgroundColor: 'rgba(82,82,91,0.1)',
                    borderWidth: 1.5,
                    pointBackgroundColor: '#52525b',
                    pointRadius: 3,
                    borderDash: [4, 4],
                }] : []),
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    labels: { color: '#a1a1aa', font: { size: 11 } },
                },
                tooltip: {
                    callbacks: {
                        label: ctx => `${ctx.dataset.label}: ${ctx.raw.toFixed(3)}`,
                    }
                }
            },
            scales: {
                r: {
                    min: 0,
                    max: 1,
                    grid: { color: '#27272a' },
                    angleLines: { color: '#27272a' },
                    ticks: {
                        display: true,
                        color: '#52525b',
                        font: { size: 9 },
                        stepSize: 0.25,
                        backdropColor: 'transparent',
                    },
                    pointLabels: {
                        color: '#a1a1aa',
                        font: { size: 11 },
                    },
                }
            }
        }
    });
}

function renderComponentBar(selected, market, mfrLabel) {
    destroyChart('componentBar');
    const ctx = document.getElementById('componentBarChart').getContext('2d');
    const labels = COMPONENTS.map(c => c.label);

    charts.componentBar = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label: mfrLabel === '__all__' ? 'Market Average' : mfrLabel,
                    data: COMPONENTS.map(c => selected[c.key]),
                    backgroundColor: COMPONENTS.map(c => hexToRGBA(c.color, 0.8)),
                    borderColor: COMPONENTS.map(c => c.color),
                    borderWidth: 1,
                    borderRadius: 4,
                },
                ...(mfrLabel !== '__all__' ? [{
                    label: 'Market Average',
                    data: COMPONENTS.map(c => market[c.key]),
                    backgroundColor: 'rgba(82,82,91,0.3)',
                    borderColor: '#52525b',
                    borderWidth: 1,
                    borderRadius: 4,
                }] : []),
            ]
        },
        options: {
            ...CHART_DEFAULTS,
            plugins: {
                legend: {
                    display: mfrLabel !== '__all__',
                    labels: { color: '#a1a1aa', font: { size: 11 } },
                },
                tooltip: {
                    callbacks: {
                        label: ctx => `${ctx.dataset.label}: ${ctx.raw.toFixed(3)}`,
                    }
                }
            },
            scales: {
                x: { grid: { color: '#27272a' }, ticks: { color: '#a1a1aa', font: { size: 11 } } },
                y: {
                    grid: { color: '#27272a' },
                    ticks: { color: '#71717a' },
                    min: 0,
                    max: 1,
                    title: { display: true, text: 'Normalized Score (0–1)', color: '#52525b', font: { size: 10 } }
                },
            }
        }
    });
}

function renderComponentStacked() {
    const quarter = document.getElementById('componentQuarterSelect').value;
    const data = filterByQuarter(rawData, quarter);

    // Get top 15 manufacturers by avg MII
    const mfrMII = {};
    manufacturers.forEach(m => {
        const rows = data.filter(r => r.manufacturer === m);
        if (rows.length) mfrMII[m] = avg(rows.map(r => parseFloat(r.mii_score)));
    });
    const top15 = Object.entries(mfrMII)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([m]) => m);

    const labels = top15;
    const datasets = COMPONENTS.map(c => ({
        label: c.label,
        data: top15.map(m => {
            const rows = data.filter(r => r.manufacturer === m);
            const avg_norm = rows.length ? avg(rows.map(r => parseFloat(r[c.key])).filter(v => !isNaN(v))) : 0;
            return +(avg_norm * c.weight * 100).toFixed(2);
        }),
        backgroundColor: hexToRGBA(c.color, 0.85),
        borderColor: c.color,
        borderWidth: 0,
    }));

    destroyChart('componentStacked');
    const ctx = document.getElementById('componentStackedChart').getContext('2d');
    charts.componentStacked = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets },
        options: {
            ...CHART_DEFAULTS,
            plugins: {
                legend: {
                    display: true,
                    position: 'bottom',
                    labels: { color: '#a1a1aa', font: { size: 10 }, boxWidth: 12, padding: 12 },
                },
                tooltip: {
                    mode: 'index',
                    callbacks: {
                        footer: items => {
                            const total = items.reduce((s, i) => s + i.raw, 0);
                            return `Total contribution: ${total.toFixed(1)}`;
                        }
                    }
                },
            },
            scales: {
                x: {
                    stacked: true,
                    grid: { color: '#1f1f1f' },
                    ticks: { color: '#a1a1aa', font: { size: 10 } },
                },
                y: {
                    stacked: true,
                    grid: { color: '#27272a' },
                    ticks: { color: '#71717a' },
                    title: { display: true, text: 'Weighted Score Contribution', color: '#52525b', font: { size: 10 } },
                },
            },
        }
    });
}

// ============================================================
// SECTION 2: Trends
// ============================================================

function getQuarterlyMetric(data, metric) {
    return quarters.map(q => {
        const rows = data.filter(r => r.quarter === q);
        if (!rows.length) return null;
        const totalAuctions = rows.reduce((s, r) => s + (parseFloat(r.auction_count) || 1), 0);
        if (metric === 'volume') return totalAuctions;
        if (metric === 'sold_rate') {
            const sold = rows.reduce((s, r) => s + (parseFloat(r.sold) || 0), 0);
            return totalAuctions ? (sold / totalAuctions) * 100 : null;
        }
        const vals = rows.map(r => parseFloat(r[metric])).filter(v => !isNaN(v));
        return vals.length ? avg(vals) : null;
    });
}

function formatTrendValue(v, metric) {
    if (v == null) return '—';
    if (metric === 'price') return fmtPrice(v);
    if (metric === 'sold_rate') return v.toFixed(1) + '%';
    if (metric === 'volume') return Math.round(v).toLocaleString();
    return v.toFixed(1);
}

function renderTrends() {
    const metric = document.getElementById('trendMetric').value;
    const mfr = document.getElementById('trendMfrSelect').value;
    const compare = document.getElementById('trendCompare').value;
    const model = getModelFilter('trendModelSearch');

    const label = METRIC_LABELS[metric] || metric;

    // Primary dataset
    let primaryData = mfr === '__all__' ? rawData : rawData.filter(r => r.manufacturer === mfr);
    primaryData = filterByModel(primaryData, model);
    const primaryLabel = mfr === '__all__' ? 'Market' : mfr;
    const primaryValues = getQuarterlyMetric(primaryData, metric);

    // Compare dataset
    const compareValues = (compare !== 'none')
        ? getQuarterlyMetric(rawData.filter(r => r.manufacturer === compare), metric)
        : null;

    // Chart title
    document.getElementById('trendChartTitle').textContent = `${label} — Month over Month`;
    const subtitleBase = mfr === '__all__' ? 'Market-wide average per month' : `${mfr} per month`;
    document.getElementById('trendChartSubtitle').textContent =
        model ? `${subtitleBase} — ${model}` : subtitleBase;

    destroyChart('trend');
    const ctx = document.getElementById('trendChart').getContext('2d');
    charts.trend = new Chart(ctx, {
        type: 'line',
        data: {
            labels: quarters.map(fmtPeriod),
            datasets: [
                {
                    label: primaryLabel,
                    data: primaryValues,
                    borderColor: '#f59e0b',
                    backgroundColor: 'rgba(245,158,11,0.1)',
                    borderWidth: 2.5,
                    pointBackgroundColor: '#f59e0b',
                    pointRadius: 5,
                    pointHoverRadius: 7,
                    tension: 0.3,
                    fill: true,
                    spanGaps: true,
                },
                ...(compareValues ? [{
                    label: compare,
                    data: compareValues,
                    borderColor: getMfrColor(compare),
                    backgroundColor: hexToRGBA(getMfrColor(compare), 0.05),
                    borderWidth: 2,
                    pointBackgroundColor: getMfrColor(compare),
                    pointRadius: 5,
                    pointHoverRadius: 7,
                    tension: 0.3,
                    fill: false,
                    spanGaps: true,
                }] : []),
            ]
        },
        options: {
            ...CHART_DEFAULTS,
            plugins: {
                legend: {
                    display: compareValues != null,
                    labels: { color: '#a1a1aa', font: { size: 11 } },
                },
                tooltip: {
                    callbacks: {
                        label: ctx => `${ctx.dataset.label}: ${formatTrendValue(ctx.raw, metric)}`,
                    }
                }
            },
            scales: {
                x: { grid: { color: '#27272a' }, ticks: { color: '#a1a1aa' } },
                y: {
                    grid: { color: '#27272a' },
                    ticks: {
                        color: '#71717a',
                        callback: v => formatTrendValue(v, metric),
                    },
                },
            },
        }
    });

    // Legend update
    const legendEl = document.getElementById('trendLegend');
    legendEl.innerHTML = '';
    if (compareValues) {
        legendEl.innerHTML = `
            <span style="color:#f59e0b">● ${primaryLabel}</span>
            <span style="color:${getMfrColor(compare)}">● ${compare}</span>
        `;
    }

    // Mini charts
    renderMiniCharts(mfr);
}

function renderMiniChart(canvasId, data, color) {
    const key = 'mini_' + canvasId;
    destroyChart(key);
    const ctx = document.getElementById(canvasId).getContext('2d');
    charts[key] = new Chart(ctx, {
        type: 'line',
        data: {
            labels: quarters.map(fmtPeriod),
            datasets: [{
                data,
                borderColor: color,
                backgroundColor: hexToRGBA(color, 0.15),
                borderWidth: 1.5,
                pointRadius: 2,
                tension: 0.3,
                fill: true,
                spanGaps: true,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: {
                x: { display: false },
                y: { display: false },
            },
            animation: { duration: 400 },
        }
    });
}

function renderMiniCharts(mfr) {
    const baseData = mfr === '__all__' ? rawData : rawData.filter(r => r.manufacturer === mfr);

    const miiVals = getQuarterlyMetric(baseData, 'mii_score');
    const priceVals = getQuarterlyMetric(baseData, 'price');
    const bidsVals = getQuarterlyMetric(baseData, 'bids');
    const volVals = getQuarterlyMetric(baseData, 'volume');

    const latestMII = miiVals.filter(v => v != null).slice(-1)[0];
    const latestPrice = priceVals.filter(v => v != null).slice(-1)[0];
    const latestBids = bidsVals.filter(v => v != null).slice(-1)[0];
    const latestVol = volVals.filter(v => v != null).slice(-1)[0];

    document.getElementById('miniMIIValue').textContent = latestMII != null ? latestMII.toFixed(1) : '—';
    document.getElementById('miniPriceValue').textContent = latestPrice != null ? fmtPrice(latestPrice) : '—';
    document.getElementById('miniBidsValue').textContent = latestBids != null ? latestBids.toFixed(1) : '—';
    document.getElementById('miniVolValue').textContent = latestVol != null ? Math.round(latestVol).toLocaleString() : '—';

    renderMiniChart('miniMIIChart', miiVals, '#f59e0b');
    renderMiniChart('miniPriceChart', priceVals, '#10b981');
    renderMiniChart('miniBidsChart', bidsVals, '#3b82f6');
    renderMiniChart('miniVolChart', volVals, '#a855f7');
}

// ============================================================
// SECTION 3: Outlier Detection
// ============================================================

function renderOutliers() {
    const metric = document.getElementById('outlierMetric').value;
    const quarter = document.getElementById('outlierQuarter').value;
    const n = parseInt(document.getElementById('outlierN').value, 10);
    const model = getModelFilter('outlierModelSearch');
    const label = METRIC_LABELS[metric] || metric;

    let data = filterByQuarter(rawData, quarter);
    data = filterByModel(data, model);
    data = data.filter(r => !isNaN(parseFloat(r[metric])));

    const sorted = [...data].sort((a, b) => parseFloat(b[metric]) - parseFloat(a[metric]));
    const top = sorted.slice(0, n);
    const bottom = sorted.slice(-n).reverse();

    // Update titles
    document.getElementById('outlierDistTitle').textContent = `${label} Distribution`;
    document.getElementById('outlierTopTitle').textContent = `Top ${n} by ${label}`;
    document.getElementById('outlierBottomTitle').textContent = `Bottom ${n} by ${label}`;
    document.getElementById('outlierTopColHeader').textContent = label;
    document.getElementById('outlierBottomColHeader').textContent = label;

    renderOutlierTable('outlierTopTable', top, metric, 'top');
    renderOutlierTable('outlierBottomTable', bottom, metric, 'bottom');
    renderOutlierDist(data, metric, label);
}

function formatMetricValue(v, metric) {
    if (v == null || isNaN(v)) return '—';
    if (metric === 'price') return fmtPrice(v);
    if (metric === 'sold_rate') return v.toFixed(1) + '%';
    return v.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function renderOutlierTable(tableId, rows, metric, type) {
    const tbody = document.getElementById(tableId);
    tbody.innerHTML = '';
    rows.forEach((row, i) => {
        const val = parseFloat(row[metric]);
        const color = type === 'top' ? 'text-emerald-400' : 'text-red-400';
        const tr = document.createElement('tr');
        tr.className = 'table-row border-b border-zinc-800/50 text-xs';
        tr.innerHTML = `
            <td class="px-4 py-2">
                <div class="font-medium text-zinc-200">${row.manufacturer}</div>
                <div class="text-zinc-500">${row.model}</div>
            </td>
            <td class="px-4 py-2 text-zinc-400">${row.quarter}</td>
            <td class="px-4 py-2 text-right font-semibold ${color}">${formatMetricValue(val, metric)}</td>
        `;
        tbody.appendChild(tr);
    });
}

function renderOutlierDist(data, metric, label) {
    const values = data.map(r => parseFloat(r[metric])).filter(v => !isNaN(v));
    if (!values.length) return;

    const min = Math.min(...values);
    const max = Math.max(...values);
    const bins = 20;
    const step = (max - min) / bins;

    const buckets = Array.from({ length: bins }, (_, i) => ({
        low: min + i * step,
        high: min + (i + 1) * step,
        count: 0,
    }));

    values.forEach(v => {
        const idx = Math.min(Math.floor((v - min) / step), bins - 1);
        buckets[idx].count++;
    });

    const labels = buckets.map(b => {
        if (metric === 'price') return '$' + (b.low / 1000).toFixed(0) + 'k';
        return b.low.toFixed(1);
    });

    destroyChart('outlierDist');
    const ctx = document.getElementById('outlierDistChart').getContext('2d');
    charts.outlierDist = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: label,
                data: buckets.map(b => b.count),
                backgroundColor: 'rgba(245,158,11,0.6)',
                borderColor: '#f59e0b',
                borderWidth: 1,
                borderRadius: 2,
            }]
        },
        options: {
            ...CHART_DEFAULTS,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: items => {
                            const b = buckets[items[0].dataIndex];
                            if (metric === 'price') return `$${(b.low/1000).toFixed(0)}k – $${(b.high/1000).toFixed(0)}k`;
                            return `${b.low.toFixed(1)} – ${b.high.toFixed(1)}`;
                        },
                        label: items => `Count: ${items.raw}`,
                    }
                }
            },
            scales: {
                x: { grid: { display: false }, ticks: { color: '#71717a', font: { size: 9 }, maxRotation: 45 } },
                y: { grid: { color: '#27272a' }, ticks: { color: '#71717a' } },
            }
        }
    });
}

function renderSpecialOutlier(type) {
    const quarter = document.getElementById('outlierQuarter').value;
    let data = filterByQuarter(rawData, quarter);

    let rows, title, cols;
    if (type === 'hvlb') {
        // High views, low bids — sort by views/bids ratio
        data = data.filter(r => parseFloat(r.bids) > 0 && parseFloat(r.views) > 0);
        rows = [...data].sort((a, b) =>
            (parseFloat(b.views) / parseFloat(b.bids)) - (parseFloat(a.views) / parseFloat(a.bids))
        ).slice(0, 20);
        title = 'High Views / Low Bids (Most "Watched but Not Bought")';
        cols = ['Views', 'Bids', 'View/Bid Ratio'];
        renderSpecialTable(rows, title, r => {
            const views = parseFloat(r.views);
            const bids = parseFloat(r.bids);
            return [views.toLocaleString(), bids.toFixed(1), (views / bids).toFixed(0)];
        });
    } else if (type === 'hplm') {
        data = data.filter(r => !isNaN(parseFloat(r.price)) && !isNaN(parseFloat(r.mii_score)));
        // Normalise both, find where price rank high but mii rank low
        const priceAvg = avg(data.map(r => parseFloat(r.price)));
        const miiAvg = avg(data.map(r => parseFloat(r.mii_score)));
        rows = [...data]
            .map(r => ({ ...r, _score: parseFloat(r.price) / priceAvg - parseFloat(r.mii_score) / miiAvg }))
            .sort((a, b) => b._score - a._score)
            .slice(0, 20);
        title = 'High Price, Low MII (Expensive but Low Market Interest)';
        renderSpecialTable(rows, title, r => [
            fmtPrice(parseFloat(r.price)),
            parseFloat(r.mii_score).toFixed(1),
            (parseFloat(r.price) / 1000).toFixed(0) + 'k / ' + parseFloat(r.mii_score).toFixed(0),
        ], ['Price', 'MII', 'Price/MII']);
    } else if (type === 'lphm') {
        data = data.filter(r => !isNaN(parseFloat(r.price)) && !isNaN(parseFloat(r.mii_score)));
        const priceAvg = avg(data.map(r => parseFloat(r.price)));
        const miiAvg = avg(data.map(r => parseFloat(r.mii_score)));
        rows = [...data]
            .map(r => ({ ...r, _score: parseFloat(r.mii_score) / miiAvg - parseFloat(r.price) / priceAvg }))
            .sort((a, b) => b._score - a._score)
            .slice(0, 20);
        title = 'Low Price, High MII (High Interest, Relatively Affordable)';
        renderSpecialTable(rows, title, r => [
            fmtPrice(parseFloat(r.price)),
            parseFloat(r.mii_score).toFixed(1),
            parseFloat(r.mii_score).toFixed(0) + ' / $' + (parseFloat(r.price) / 1000).toFixed(0) + 'k',
        ], ['Price', 'MII', 'MII/Price']);
    }
}

function renderSpecialTable(rows, title, valueFn, colHeaders = []) {
    // Show results in the top table and update the title
    document.getElementById('outlierTopTitle').textContent = title;
    const tbody = document.getElementById('outlierTopTable');
    tbody.innerHTML = '';
    rows.forEach(row => {
        const vals = valueFn(row);
        const tr = document.createElement('tr');
        tr.className = 'table-row border-b border-zinc-800/50 text-xs';
        tr.innerHTML = `
            <td class="px-4 py-2">
                <div class="font-medium text-zinc-200">${row.manufacturer}</div>
                <div class="text-zinc-500">${row.model}</div>
            </td>
            <td class="px-4 py-2 text-zinc-400">${row.quarter}</td>
            <td class="px-4 py-2 text-right font-semibold text-amber-400">${vals[0]}</td>
            <td class="px-4 py-2 text-right text-zinc-300">${vals[1] || ''}</td>
            <td class="px-4 py-2 text-right text-zinc-400">${vals[2] || ''}</td>
        `;
        tbody.appendChild(tr);
    });
}

// ============================================================
// SECTION 4: Correlation Explorer
// ============================================================

const QUARTER_COLORS = ['#f59e0b', '#3b82f6', '#10b981', '#8b5cf6', '#ec4899', '#ef4444'];

function renderCorrelations() {
    const xKey = document.getElementById('corrX').value;
    const yKey = document.getElementById('corrY').value;
    const quarter = document.getElementById('corrQuarter').value;
    const colorBy = document.getElementById('corrColorBy').value;
    const mfrFilter = document.getElementById('corrMfrFilter').value;
    const model = getModelFilter('corrModelSearch');

    let data = filterByQuarter(rawData, quarter);
    if (mfrFilter !== '__all__') data = data.filter(r => r.manufacturer === mfrFilter);
    data = filterByModel(data, model);

    data = data.filter(r => {
        const xv = parseFloat(r[xKey]);
        const yv = parseFloat(r[yKey]);
        return !isNaN(xv) && !isNaN(yv) && isFinite(xv) && isFinite(yv);
    });

    const xVals = data.map(r => parseFloat(r[xKey]));
    const yVals = data.map(r => parseFloat(r[yKey]));

    // Stats
    const r = pearson(xVals, yVals);
    const r2 = r != null ? r ** 2 : null;
    document.getElementById('corrCoefficient').textContent = r != null ? r.toFixed(3) : '—';
    document.getElementById('statCorrR').textContent = r != null ? r.toFixed(3) : '—';
    document.getElementById('statCorrR2').textContent = r2 != null ? r2.toFixed(3) : '—';
    document.getElementById('statCorrN').textContent = data.length.toLocaleString();
    document.getElementById('statCorrXMean').textContent = fmtNum(avg(xVals));
    document.getElementById('statCorrXStd').textContent = fmtNum(stddev(xVals));
    document.getElementById('statCorrYMean').textContent = fmtNum(avg(yVals));
    document.getElementById('statCorrYStd').textContent = fmtNum(stddev(yVals));

    // Interpretation
    const interp = interpretCorrelation(r, METRIC_LABELS[xKey] || xKey, METRIC_LABELS[yKey] || yKey);
    document.getElementById('corrInterpretation').textContent = interp;

    // Update chart title
    const xLabel = METRIC_LABELS[xKey] || xKey;
    const yLabel = METRIC_LABELS[yKey] || yKey;
    document.getElementById('corrChartTitle').textContent = `${xLabel} vs ${yLabel}`;

    // Group by color dimension
    let groups = {};
    if (colorBy === 'manufacturer') {
        data.forEach(r => {
            (groups[r.manufacturer] = groups[r.manufacturer] || []).push(r);
        });
    } else if (colorBy === 'quarter') {
        data.forEach(r => {
            (groups[r.quarter] = groups[r.quarter] || []).push(r);
        });
    } else {
        data.forEach(r => {
            const k = parseFloat(r.sold) === 1 ? 'Sold' : 'Unsold';
            (groups[k] = groups[k] || []).push(r);
        });
    }

    const groupKeys = Object.keys(groups).sort();
    const datasets = groupKeys.map((key, i) => {
        let color;
        if (colorBy === 'manufacturer') color = getMfrColor(key);
        else if (colorBy === 'quarter') color = QUARTER_COLORS[quarters.indexOf(key) % QUARTER_COLORS.length];
        else color = key === 'Sold' ? '#10b981' : '#ef4444';

        return {
            label: key,
            data: groups[key].map(r => ({
                x: parseFloat(r[xKey]),
                y: parseFloat(r[yKey]),
                _mfr: r.manufacturer,
                _model: r.model,
                _quarter: r.quarter,
            })),
            backgroundColor: hexToRGBA(color, 0.55),
            borderColor: color,
            borderWidth: 0,
            pointRadius: 4,
            pointHoverRadius: 7,
        };
    });

    // Add trend line
    if (r != null && data.length > 1) {
        const xm = avg(xVals), ym = avg(yVals);
        const slope = xVals.reduce((s, x, i) => s + (x - xm) * (yVals[i] - ym), 0) /
                      xVals.reduce((s, x) => s + (x - xm) ** 2, 0);
        const intercept = ym - slope * xm;
        const xMin = Math.min(...xVals);
        const xMax = Math.max(...xVals);
        datasets.push({
            label: 'Trend line',
            data: [
                { x: xMin, y: slope * xMin + intercept },
                { x: xMax, y: slope * xMax + intercept },
            ],
            type: 'line',
            borderColor: 'rgba(255,255,255,0.25)',
            borderWidth: 1.5,
            borderDash: [5, 5],
            pointRadius: 0,
            fill: false,
        });
    }

    destroyChart('corrScatter');
    const ctx = document.getElementById('corrScatterChart').getContext('2d');
    charts.corrScatter = new Chart(ctx, {
        type: 'scatter',
        data: { datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: ctx => {
                            const d = ctx.raw;
                            if (d._mfr) return `${d._mfr} ${d._model} (${d._quarter}): (${fmtNum(d.x, 0)}, ${fmtNum(d.y, 1)})`;
                            return `(${fmtNum(d.x, 0)}, ${fmtNum(d.y, 1)})`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: '#27272a' },
                    ticks: { color: '#71717a' },
                    title: { display: true, text: xLabel, color: '#71717a', font: { size: 11 } }
                },
                y: {
                    grid: { color: '#27272a' },
                    ticks: { color: '#71717a' },
                    title: { display: true, text: yLabel, color: '#71717a', font: { size: 11 } }
                },
            }
        }
    });

    // Legend
    const legendEl = document.getElementById('corrLegend');
    legendEl.innerHTML = '';
    groupKeys.slice(0, 30).forEach((key, i) => {
        let color;
        if (colorBy === 'manufacturer') color = getMfrColor(key);
        else if (colorBy === 'quarter') color = QUARTER_COLORS[quarters.indexOf(key) % QUARTER_COLORS.length];
        else color = key === 'Sold' ? '#10b981' : '#ef4444';
        const el = document.createElement('div');
        el.className = 'flex items-center gap-2';
        el.innerHTML = `<span style="width:10px;height:10px;border-radius:50%;background:${color};display:inline-block;flex-shrink:0"></span>${key}`;
        legendEl.appendChild(el);
    });
    if (groupKeys.length > 30) {
        const el = document.createElement('div');
        el.className = 'text-zinc-600';
        el.textContent = `+${groupKeys.length - 30} more`;
        legendEl.appendChild(el);
    }
}

function interpretCorrelation(r, xLabel, yLabel) {
    if (r == null) return 'Insufficient data to calculate correlation.';
    const abs = Math.abs(r);
    const dir = r > 0 ? 'positive' : 'negative';
    let strength;
    if (abs >= 0.7) strength = 'strong';
    else if (abs >= 0.4) strength = 'moderate';
    else if (abs >= 0.2) strength = 'weak';
    else strength = 'very weak or no';

    let explain = '';
    if (r > 0.4) explain = ` As ${xLabel} increases, ${yLabel} tends to increase as well.`;
    else if (r < -0.4) explain = ` As ${xLabel} increases, ${yLabel} tends to decrease.`;
    else explain = ` There is little predictive relationship between ${xLabel} and ${yLabel}.`;

    return `There is a ${strength} ${dir} correlation (r = ${r.toFixed(2)}) between ${xLabel} and ${yLabel}.${explain}`;
}
