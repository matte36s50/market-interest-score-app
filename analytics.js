// Model Comparison — compare MII profiles across models.
// Loads the same mii_results_latest.csv as the main dashboard, builds a per-model
// profile from the normalized MII input columns, and lets the user benchmark a
// base model against auto-suggested comparables plus manual picks.
//
// The page ships HAGI light-theme tokens in its markup; mii-dark-theme.css (loaded
// in the HTML) maps those tokens to the navy + champagne-gold theme, so all chrome
// here uses classes that stylesheet recognises. Series accents use colours chosen
// to read well on the dark navy background.

const CSV_URL = "https://my-mii-reports.s3.us-east-2.amazonaws.com/mii_results_latest.csv";

// The dimensions of a model's MII profile. Weights are the actual MII formula
// (kept in sync with mii-normalize.js): price 20%, bids 20%, views 15%,
// comments 10%, Google Trends 15%, YouTube 10%, social 5%, age 5%. All eight
// inputs carry real weight, so each contributes to the similarity distance.
const PROFILE_DIMS = [
    { key: 'price_normalized', label: 'Price', weight: 0.20 },
    { key: 'bids_normalized', label: 'Bids', weight: 0.20 },
    { key: 'views_normalized', label: 'Views', weight: 0.15 },
    { key: 'comments_normalized', label: 'Comments', weight: 0.10 },
    { key: 'social_score_normalized', label: 'Social', weight: 0.05 },
    { key: 'age_normalized', label: 'Age', weight: 0.05 },
    { key: 'google_trends_interest_normalized', label: 'Google Trends', weight: 0.15 },
    { key: 'youtube_total_views_normalized', label: 'YouTube', weight: 0.10 },
];

const MAX_COMPARISONS = 5;   // additional models beyond the base
// Champagne-gold-forward palette tuned for the navy theme.
const SERIES_COLORS = ['#e0c878', '#6a9abf', '#6ab87a', '#c9a0d6', '#c47a7a', '#cda35c'];

// modelKey ("Manufacturer|Model") -> { manufacturer, model, rows, profile, count }
let models = {};
let modelKeys = [];   // sorted for search
let quarters = [];    // all distinct months, sorted

// Benchmarks computed across every valid row in the dataset, per month so they
// can be drawn as trend lines alongside each model.
let marketMIIByQuarter = {};        // quarter -> average MII across all rows
let manufacturerMIIByQuarter = {};  // manufacturer -> { quarter -> average MII }

let baseKey = null;
let comparisonKeys = [];

let radarChart = null;
let trendChart = null;
let benchmarkChart = null;
let jitterChart = null;

// ---- Data loading ----

async function loadCSV() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(CSV_URL, {
        mode: 'cors',
        signal: controller.signal,
        headers: { 'Accept': 'text/csv' }
    });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const csvText = await response.text();

    return new Promise((resolve, reject) => {
        Papa.parse(csvText, {
            header: true,
            skipEmptyLines: true,
            complete: (results) => {
                if (results.data.length === 0) {
                    reject(new Error('No data in CSV'));
                    return;
                }
                resolve(results.data);
            },
            error: (err) => reject(err)
        });
    });
}

function buildModels(rawData) {
    // Replace the upstream min-max normalization with percentile ranks and
    // recompute mii_score before profiles/benchmarks are built (mii-normalize.js).
    if (window.MII) MII.recompute(rawData);

    // String() guards: model names like "959" or "2002" must never be treated
    // as numbers anywhere downstream (sorting, .toLowerCase searches, keys).
    const valid = rawData.filter(row =>
        row.quarter &&
        /^\d{4}-\d{2}$/.test(String(row.quarter).trim()) &&
        row.manufacturer &&
        row.model !== null && row.model !== undefined && String(row.model).trim() !== '' &&
        row.mii_score !== null && row.mii_score !== undefined &&
        !isNaN(parseFloat(row.mii_score))
    );

    models = {};
    valid.forEach(row => {
        const manufacturer = String(row.manufacturer).trim();
        const model = String(row.model).trim();
        const key = `${manufacturer}|${model}`;
        if (!models[key]) {
            models[key] = { manufacturer, model, rows: [] };
        }
        models[key].rows.push(row);
    });

    quarters = [...new Set(valid.map(r => String(r.quarter).trim()))].sort();

    // Average each normalized dimension across the model's rows.
    Object.values(models).forEach(m => {
        m.count = m.rows.length;
        m.profile = PROFILE_DIMS.map(dim => {
            const vals = m.rows
                .map(r => parseFloat(r[dim.key]))
                .filter(v => !isNaN(v));
            const avg = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
            // The pipeline occasionally emits slightly out-of-range normalized
            // values (e.g. negative age for very new builds); keep radar in [0,1].
            return Math.min(1, Math.max(0, avg));
        });
        m.avgMII = m.rows.reduce((s, r) => s + parseFloat(r.mii_score), 0) / m.rows.length;
    });

    modelKeys = Object.keys(models).sort((a, b) => a.localeCompare(b));

    // Market and per-manufacturer benchmarks, averaged per month so they can be
    // plotted as trend lines. Each month is the mean MII of every row in that
    // month (market) or every row of that manufacturer in that month.
    const marketSums = {};                 // quarter -> { sum, n }
    const mfrSums = {};                     // manufacturer -> quarter -> { sum, n }
    valid.forEach(row => {
        const mii = parseFloat(row.mii_score);
        const q = String(row.quarter).trim();
        const mfr = String(row.manufacturer).trim();
        (marketSums[q] = marketSums[q] || { sum: 0, n: 0 });
        marketSums[q].sum += mii;
        marketSums[q].n += 1;
        (mfrSums[mfr] = mfrSums[mfr] || {});
        (mfrSums[mfr][q] = mfrSums[mfr][q] || { sum: 0, n: 0 });
        mfrSums[mfr][q].sum += mii;
        mfrSums[mfr][q].n += 1;
    });
    marketMIIByQuarter = {};
    Object.entries(marketSums).forEach(([q, { sum, n }]) => {
        marketMIIByQuarter[q] = n ? sum / n : null;
    });
    manufacturerMIIByQuarter = {};
    Object.entries(mfrSums).forEach(([mfr, byQ]) => {
        manufacturerMIIByQuarter[mfr] = {};
        Object.entries(byQ).forEach(([q, { sum, n }]) => {
            manufacturerMIIByQuarter[mfr][q] = n ? sum / n : null;
        });
    });
}

// ---- Similarity ----

// Weighted Euclidean distance between two profiles. Normalized inputs live in
// [0,1] and similarity weights sum to 1, so the distance is also in [0,1].
function profileDistance(a, b) {
    let sum = 0;
    PROFILE_DIMS.forEach((dim, i) => {
        if (dim.weight === 0) return;
        const d = a[i] - b[i];
        sum += dim.weight * d * d;
    });
    return Math.sqrt(sum);
}

function suggestSimilar(key, limit = 5) {
    const baseProfile = models[key].profile;
    return modelKeys
        .filter(k => k !== key && !comparisonKeys.includes(k) && models[k].count >= 2)
        .map(k => ({ key: k, distance: profileDistance(baseProfile, models[k].profile) }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, limit);
}

function similarityPct(distance) {
    return Math.max(0, Math.min(100, (1 - distance) * 100));
}

// ---- Search dropdowns ----

function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function searchModels(term) {
    const t = term.trim().toLowerCase();
    if (!t) return [];
    return modelKeys
        .filter(k => k.toLowerCase().replace('|', ' ').includes(t))
        .slice(0, 30);
}

function setupSearch(inputId, resultsId, onPick) {
    const input = document.getElementById(inputId);
    const results = document.getElementById(resultsId);

    function render() {
        const matches = searchModels(input.value);
        if (!matches.length) {
            results.classList.add('hidden');
            results.innerHTML = '';
            return;
        }
        results.innerHTML = matches.map(k => {
            const m = models[k];
            return `<button data-key="${escapeHtml(k)}" class="search-item table-row w-full text-left px-4 py-2.5 flex items-center justify-between gap-2" style="border-bottom:1px solid #152236">
                <span class="text-[12.5px]"><span class="text-[#a8a29e]">${escapeHtml(m.manufacturer)}</span> <span class="font-medium text-[#1c1917]">${escapeHtml(m.model)}</span></span>
                <span class="text-[11px] text-[#a8a29e] whitespace-nowrap">${m.count} mo · MII ${m.avgMII.toFixed(1)}</span>
            </button>`;
        }).join('');
        results.classList.remove('hidden');
    }

    input.addEventListener('input', render);
    input.addEventListener('focus', render);
    input.addEventListener('blur', () => setTimeout(() => results.classList.add('hidden'), 150));
    results.addEventListener('mousedown', (e) => {
        const btn = e.target.closest('.search-item');
        if (!btn) return;
        e.preventDefault();
        input.value = '';
        results.classList.add('hidden');
        onPick(btn.dataset.key);
    });
}

// ---- Selection state ----

function setBase(key) {
    baseKey = key;
    comparisonKeys = comparisonKeys.filter(k => k !== key);
    renderAll();
}

function addComparison(key) {
    if (!baseKey) {
        setBase(key);
        return;
    }
    if (key === baseKey || comparisonKeys.includes(key)) return;
    if (comparisonKeys.length >= MAX_COMPARISONS) return;
    comparisonKeys.push(key);
    renderAll();
}

function removeComparison(key) {
    comparisonKeys = comparisonKeys.filter(k => k !== key);
    renderAll();
}

function selectedKeys() {
    return baseKey ? [baseKey, ...comparisonKeys] : [];
}

// ---- Rendering ----

function modelLabel(key) {
    const m = models[key];
    return `${m.manufacturer} ${m.model}`;
}

function renderSelection() {
    const baseEl = document.getElementById('baseSelected');
    if (baseKey) {
        const m = models[baseKey];
        baseEl.innerHTML = `<div class="flex items-center justify-between rounded-lg px-4 py-3" style="background:rgba(201,168,76,0.1);border:1px solid rgba(201,168,76,0.5)">
            <div class="min-w-0">
                <div class="text-[11px] text-[#a8a29e]">${escapeHtml(m.manufacturer)}</div>
                <div class="font-semibold text-[15px] text-[#8B1A1A] truncate">${escapeHtml(m.model)}</div>
            </div>
            <div class="text-right text-[11px] text-[#a8a29e] leading-tight whitespace-nowrap ml-3">${m.count} months<br>avg MII ${m.avgMII.toFixed(1)}</div>
        </div>`;
    } else {
        baseEl.innerHTML = '';
    }

    document.getElementById('selectionCount').textContent = `(${comparisonKeys.length}/${MAX_COMPARISONS})`;

    const listEl = document.getElementById('selectionList');
    if (!comparisonKeys.length) {
        listEl.innerHTML = '<p class="text-[12px] text-[#a8a29e]">No comparison models added yet</p>';
    } else {
        listEl.innerHTML = comparisonKeys.map((k, i) => {
            const color = SERIES_COLORS[(i + 1) % SERIES_COLORS.length];
            return `<div class="flex items-center justify-between rounded-lg px-3 py-2" style="background:#0d1828;border:1px solid #1e3350">
                <div class="flex items-center gap-2 min-w-0">
                    <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${color}"></span>
                    <span class="text-[12.5px] text-[#1c1917] truncate">${escapeHtml(modelLabel(k))}</span>
                </div>
                <button data-key="${escapeHtml(k)}" class="remove-btn text-[#a8a29e] text-lg leading-none px-1" title="Remove" aria-label="Remove">&times;</button>
            </div>`;
        }).join('');
    }
}

function renderSuggestions() {
    const el = document.getElementById('suggestionsList');
    if (!baseKey) {
        el.innerHTML = '<p class="text-[12px] text-[#a8a29e]">Pick a base model to see suggestions</p>';
        return;
    }
    const suggestions = suggestSimilar(baseKey);
    if (!suggestions.length) {
        el.innerHTML = '<p class="text-[12px] text-[#a8a29e]">No similar models found</p>';
        return;
    }
    const full = comparisonKeys.length >= MAX_COMPARISONS;
    el.innerHTML = suggestions.map(s => {
        const m = models[s.key];
        const pct = similarityPct(s.distance);
        const addBtn = full
            ? `<button data-key="${escapeHtml(s.key)}" disabled class="suggest-add flex-shrink-0 px-2.5 py-1 rounded-md text-[11px] font-semibold cursor-not-allowed" style="background:#c9a84c;color:#080e1a;opacity:.4">+ Add</button>`
            : `<button data-key="${escapeHtml(s.key)}" class="suggest-add flex-shrink-0 px-2.5 py-1 rounded-md text-[11px] font-semibold hover:opacity-90 transition-opacity" style="background:#c9a84c;color:#080e1a">+ Add</button>`;
        return `<div class="flex items-center justify-between rounded-lg px-3 py-2 gap-2 table-row" style="background:#0d1828;border:1px solid #1e3350">
            <div class="min-w-0">
                <div class="text-[12.5px] truncate"><span class="text-[#a8a29e]">${escapeHtml(m.manufacturer)}</span> <span class="font-medium text-[#1c1917]">${escapeHtml(m.model)}</span></div>
                <div class="text-[11px] text-[#a8a29e]">${pct.toFixed(0)}% profile match · avg MII ${m.avgMII.toFixed(1)}</div>
            </div>
            ${addBtn}
        </div>`;
    }).join('');
}

function renderRadar(keys) {
    const ctx = document.getElementById('radarChart').getContext('2d');
    if (radarChart) radarChart.destroy();
    radarChart = new Chart(ctx, {
        type: 'radar',
        data: {
            labels: PROFILE_DIMS.map(d => d.label),
            datasets: keys.map((k, i) => {
                const color = SERIES_COLORS[i % SERIES_COLORS.length];
                return {
                    label: modelLabel(k),
                    data: models[k].profile,
                    borderColor: color,
                    backgroundColor: color + '26',
                    pointBackgroundColor: color,
                    pointRadius: 3,
                    borderWidth: 2,
                };
            })
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                r: {
                    min: 0,
                    max: 1,
                    ticks: { display: false },
                    grid: { color: 'rgba(255,255,255,0.06)' },
                    angleLines: { color: 'rgba(255,255,255,0.06)' },
                    pointLabels: { color: '#7a8898', font: { size: 11 } }
                }
            },
            plugins: {
                legend: { labels: { color: '#7a8898', boxWidth: 12, usePointStyle: true, font: { size: 11 } } }
            }
        }
    });
}

function renderTrend(keys) {
    const ctx = document.getElementById('trendChart').getContext('2d');
    if (trendChart) trendChart.destroy();

    trendChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: quarters,
            datasets: keys.map((k, i) => {
                const color = SERIES_COLORS[i % SERIES_COLORS.length];
                // Average MII per month (a model can have multiple rows per month
                // if it appears under several data sources).
                const byQuarter = {};
                models[k].rows.forEach(r => {
                    const q = String(r.quarter).trim();
                    (byQuarter[q] = byQuarter[q] || []).push(parseFloat(r.mii_score));
                });
                return {
                    label: modelLabel(k),
                    data: quarters.map(q => {
                        const vals = byQuarter[q];
                        return vals ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
                    }),
                    borderColor: color,
                    backgroundColor: color,
                    pointBackgroundColor: color,
                    spanGaps: true,
                    tension: 0.3,
                    pointRadius: 3,
                    borderWidth: 2,
                };
            })
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: '#7a8898', font: { size: 10 } }
                },
                y: {
                    grid: { color: 'rgba(255,255,255,0.06)' },
                    ticks: { color: '#7a8898', font: { size: 11 } },
                    title: { display: true, text: 'MII Score', color: '#7a8898', font: { size: 11 } }
                }
            },
            plugins: {
                legend: { labels: { color: '#7a8898', boxWidth: 12, usePointStyle: true, font: { size: 11 } } }
            }
        }
    });
}

// Average a profile dimension across a set of model keys.
function avgProfileDim(modelKeyList, dimIndex) {
    let s = 0, n = 0;
    modelKeyList.forEach(k => { s += models[k].profile[dimIndex]; n++; });
    return n ? s / n : 0;
}

// Linear-interpolated quantile of a sorted numeric array.
function quantileSorted(sorted, q) {
    if (!sorted.length) return 0;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Component spread plot: a box-and-whisker per MII input summarising where the
// whole field of models sits (10/25/50/75/90 percentile), with each selected
// model drawn as a line across the columns (like the benchmark chart), plus its
// manufacturer average and the overall market average as dashed reference lines.
function renderJitter(keys) {
    const ctx = document.getElementById('jitterChart').getContext('2d');
    if (jitterChart) jitterChart.destroy();

    const labels = PROFILE_DIMS.map(d => d.label);
    const fieldKeys = modelKeys.filter(k => models[k].count >= 2);

    // Box stats per component, computed across the whole field.
    const boxStats = PROFILE_DIMS.map((_, i) => {
        const vals = fieldKeys.map(k => models[k].profile[i]).sort((a, b) => a - b);
        return {
            p10: quantileSorted(vals, 0.10), p25: quantileSorted(vals, 0.25),
            p50: quantileSorted(vals, 0.50), p75: quantileSorted(vals, 0.75),
            p90: quantileSorted(vals, 0.90),
        };
    });

    // Draw the boxes behind the line series with a small inline plugin.
    const boxPlugin = {
        id: 'componentBoxes',
        beforeDatasetsDraw(chart) {
            const { ctx, chartArea, scales: { x, y } } = chart;
            if (!x || !y || !chartArea) return;
            const halfW = Math.min(34, (chartArea.width / boxStats.length) * 0.26);
            const capW = halfW * 0.55;
            const yp = v => y.getPixelForValue(v);
            ctx.save();
            boxStats.forEach((s, i) => {
                const cx = x.getPixelForValue(i);
                // whiskers p10–p25 and p75–p90, with end caps
                ctx.strokeStyle = 'rgba(160,174,192,0.55)';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(cx, yp(s.p90)); ctx.lineTo(cx, yp(s.p75));
                ctx.moveTo(cx, yp(s.p25)); ctx.lineTo(cx, yp(s.p10));
                ctx.moveTo(cx - capW, yp(s.p90)); ctx.lineTo(cx + capW, yp(s.p90));
                ctx.moveTo(cx - capW, yp(s.p10)); ctx.lineTo(cx + capW, yp(s.p10));
                ctx.stroke();
                // interquartile box p25–p75
                const top = yp(s.p75), h = yp(s.p25) - yp(s.p75);
                ctx.fillStyle = 'rgba(122,136,152,0.18)';
                ctx.strokeStyle = 'rgba(160,174,192,0.6)';
                ctx.fillRect(cx - halfW, top, halfW * 2, h);
                ctx.strokeRect(cx - halfW, top, halfW * 2, h);
                // median
                ctx.strokeStyle = 'rgba(207,200,188,0.85)';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(cx - halfW, yp(s.p50)); ctx.lineTo(cx + halfW, yp(s.p50));
                ctx.stroke();
            });
            ctx.restore();
        },
    };

    const datasets = [];
    const seenMfr = new Set();
    keys.forEach((k, ki) => {
        const color = SERIES_COLORS[ki % SERIES_COLORS.length];
        // The model itself: solid line + large points across the columns.
        datasets.push({
            label: modelLabel(k),
            data: models[k].profile.slice(),
            borderColor: color,
            backgroundColor: color,
            pointBackgroundColor: color,
            pointBorderColor: '#08111f',
            pointBorderWidth: 1.5,
            pointRadius: 6,
            pointHoverRadius: 7,
            borderWidth: 2,
            tension: 0,
            fill: false,
            order: ki,
        });
        // Manufacturer average (dashed), de-duplicated across selected models.
        const mfr = models[k].manufacturer;
        if (!seenMfr.has(mfr)) {
            seenMfr.add(mfr);
            const mfrKeys = fieldKeys.filter(fk => models[fk].manufacturer === mfr);
            if (mfrKeys.length) {
                datasets.push({
                    label: `${mfr} (mfr avg)`,
                    data: PROFILE_DIMS.map((_, i) => avgProfileDim(mfrKeys, i)),
                    borderColor: color,
                    backgroundColor: color,
                    borderDash: [6, 4],
                    pointRadius: 0,
                    borderWidth: 1.5,
                    tension: 0,
                    fill: false,
                    order: 50,
                });
            }
        }
    });

    // Overall market average across the field (dashed neutral reference).
    datasets.push({
        label: 'Market avg',
        data: PROFILE_DIMS.map((_, i) => avgProfileDim(fieldKeys, i)),
        borderColor: '#cfc8bc',
        backgroundColor: '#cfc8bc',
        borderDash: [2, 3],
        pointRadius: 0,
        borderWidth: 2,
        tension: 0,
        fill: false,
        order: 60,
    });

    jitterChart = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        plugins: [boxPlugin],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: 'nearest', intersect: true },
            layout: { padding: { top: 8 } },
            scales: {
                x: {
                    offset: true,
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    ticks: { color: '#7a8898', font: { size: 11 } },
                },
                y: {
                    min: 0,
                    max: 1,
                    grid: { color: 'rgba(255,255,255,0.06)' },
                    ticks: { color: '#7a8898', font: { size: 11 } },
                    title: { display: true, text: 'Percentile (0 = lowest, 1 = highest)', color: '#7a8898', font: { size: 11 } },
                },
            },
            plugins: {
                legend: { labels: { color: '#7a8898', boxWidth: 12, usePointStyle: true, font: { size: 11 } } },
                tooltip: {
                    callbacks: {
                        label: (c) => `${c.dataset.label} · ${c.label}: ${Number(c.parsed.y).toFixed(2)}`,
                    },
                },
            },
        },
    });
}

function renderBenchmark(keys) {
    const ctx = document.getElementById('benchmarkChart').getContext('2d');
    if (benchmarkChart) benchmarkChart.destroy();

    const datasets = [];

    // One solid line per selected model (matching its series colour), plus a
    // dashed line for that model's manufacturer average. Manufacturers are
    // de-duplicated so two models from the same make share one mfr line.
    const seenMfr = new Set();
    keys.forEach((k, i) => {
        const color = SERIES_COLORS[i % SERIES_COLORS.length];
        const m = models[k];
        const byQuarter = {};
        m.rows.forEach(r => {
            const q = String(r.quarter).trim();
            (byQuarter[q] = byQuarter[q] || []).push(parseFloat(r.mii_score));
        });
        datasets.push({
            label: modelLabel(k),
            data: quarters.map(q => {
                const vals = byQuarter[q];
                return vals ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
            }),
            borderColor: color,
            backgroundColor: color,
            pointBackgroundColor: color,
            spanGaps: true,
            tension: 0.3,
            pointRadius: 3,
            borderWidth: 2,
        });

        const mfr = m.manufacturer;
        if (!seenMfr.has(mfr)) {
            seenMfr.add(mfr);
            const byQ = manufacturerMIIByQuarter[mfr] || {};
            datasets.push({
                label: `${mfr} (mfr avg)`,
                data: quarters.map(q => byQ[q] ?? null),
                borderColor: color,
                backgroundColor: color,
                borderDash: [6, 4],
                spanGaps: true,
                tension: 0.3,
                pointRadius: 0,
                borderWidth: 1.5,
            });
        }
    });

    // Overall market average — a single neutral reference line over all months.
    datasets.push({
        label: 'Market avg',
        data: quarters.map(q => marketMIIByQuarter[q] ?? null),
        borderColor: '#cfc8bc',
        backgroundColor: '#cfc8bc',
        borderDash: [2, 3],
        spanGaps: true,
        tension: 0.3,
        pointRadius: 0,
        borderWidth: 2,
    });

    benchmarkChart = new Chart(ctx, {
        type: 'line',
        data: { labels: quarters, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: '#7a8898', font: { size: 10 } }
                },
                y: {
                    grid: { color: 'rgba(255,255,255,0.06)' },
                    ticks: { color: '#7a8898', font: { size: 11 } },
                    title: { display: true, text: 'MII Score', color: '#7a8898', font: { size: 11 } }
                }
            },
            plugins: {
                legend: { labels: { color: '#7a8898', boxWidth: 12, usePointStyle: true, font: { size: 11 } } }
            }
        }
    });
}

function fmtMoney(v) {
    if (!v) return '—';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
    return '$' + v.toFixed(0);
}

function fmtNum(v) {
    if (v === null || isNaN(v)) return '—';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return v.toFixed(0);
}

function avgOf(rows, key, predicate) {
    const vals = rows
        .filter(r => !predicate || predicate(r))
        .map(r => parseFloat(r[key]))
        .filter(v => !isNaN(v) && v > 0);
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
}

function renderTable(keys) {
    const head = document.getElementById('h2hHead');
    const body = document.getElementById('h2hBody');

    // Inline !important is needed because mii-dark-theme.css forces a uniform
    // th colour/letter-spacing; this re-asserts the per-model series colour.
    const thStyle = c => `color:${c} !important;text-transform:none !important;letter-spacing:0.01em !important;font-size:11.5px !important;font-weight:600 !important`;
    head.innerHTML = `<tr>
        <th class="px-5 py-3">Metric</th>
        ${keys.map((k, i) => `<th class="px-5 py-3" style="${thStyle(SERIES_COLORS[i % SERIES_COLORS.length])}">${escapeHtml(modelLabel(k))}${i === 0 ? ' <span style="color:#7a8898 !important;font-weight:400 !important">(base)</span>' : ''}</th>`).join('')}
    </tr>`;

    const metrics = [
        { label: 'Latest MII', fmt: v => v === null ? '—' : v.toFixed(1), get: m => {
            const last = m.rows.reduce((a, b) => String(a.quarter) > String(b.quarter) ? a : b);
            return parseFloat(last.mii_score);
        }},
        { label: 'Avg MII', fmt: v => v === null ? '—' : v.toFixed(1), get: m => m.avgMII },
        { label: 'Peak MII', fmt: v => v === null ? '—' : v.toFixed(1), get: m => Math.max(...m.rows.map(r => parseFloat(r.mii_score))) },
        { label: 'Avg Sale Price', fmt: fmtMoney, get: m => avgOf(m.rows, 'price') },
        { label: 'Avg Views / Listing', fmt: fmtNum, get: m => avgOf(m.rows, 'views') },
        { label: 'Avg Bids / Listing', fmt: fmtNum, get: m => avgOf(m.rows, 'bids') },
        { label: 'Avg Comments / Listing', fmt: fmtNum, get: m => avgOf(m.rows, 'comments') },
        { label: 'Google Trends Interest', fmt: fmtNum, get: m => avgOf(m.rows, 'google_trends_interest') },
        { label: 'YouTube Views', fmt: fmtNum, get: m => avgOf(m.rows, 'youtube_total_views') },
        { label: 'Avg Model Year', fmt: v => v === null ? '—' : String(Math.round(v)), get: m => avgOf(m.rows, 'year'), noHighlight: true },
        { label: 'Months of Data', fmt: v => String(v), get: m => m.count },
    ];

    body.innerHTML = metrics.map(metric => {
        const vals = keys.map(k => metric.get(models[k]));
        const best = metric.noHighlight ? null : Math.max(...vals.filter(v => v !== null && !isNaN(v)));
        return `<tr>
            <td class="px-5 py-3" style="color:#7a8898 !important">${metric.label}</td>
            ${vals.map(v => {
                const isBest = best !== null && v !== null && v === best && keys.length > 1;
                const style = isBest ? ' style="color:#e0c878 !important;font-weight:600 !important"' : '';
                return `<td class="px-5 py-3"${style}>${metric.fmt(v)}</td>`;
            }).join('')}
        </tr>`;
    }).join('');
}

function renderAll() {
    renderSelection();
    renderSuggestions();

    const keys = selectedKeys();
    const charts = document.getElementById('chartsSection');
    const empty = document.getElementById('emptyState');
    if (!keys.length) {
        charts.classList.add('hidden');
        empty.classList.remove('hidden');
        return;
    }
    charts.classList.remove('hidden');
    empty.classList.add('hidden');
    renderRadar(keys);
    renderTrend(keys);
    renderJitter(keys);
    renderBenchmark(keys);
    renderTable(keys);
}

// ---- Init ----

async function init() {
    try {
        const rawData = await loadCSV();
        buildModels(rawData);

        document.getElementById('lastUpdated').textContent =
            new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

        setupSearch('baseSearch', 'baseResults', setBase);
        setupSearch('addSearch', 'addResults', addComparison);

        document.getElementById('suggestionsList').addEventListener('click', (e) => {
            const btn = e.target.closest('.suggest-add');
            if (btn && !btn.disabled) addComparison(btn.dataset.key);
        });
        document.getElementById('selectionList').addEventListener('click', (e) => {
            const btn = e.target.closest('.remove-btn');
            if (btn) removeComparison(btn.dataset.key);
        });

        document.getElementById('loadingIndicator').style.display = 'none';
    } catch (error) {
        const indicator = document.getElementById('loadingIndicator');
        indicator.innerHTML = `<div class="text-center max-w-md px-6">
            <div class="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4" style="background:rgba(201,168,76,0.1)">
                <svg class="w-6 h-6 text-[#8B1A1A]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
            </div>
            <div class="text-base font-semibold text-[#8B1A1A] mb-1">Failed to Load Data</div>
            <div class="text-xs text-[#a8a29e]">${escapeHtml(error.message)}</div>
        </div>`;
    }
}

init();
