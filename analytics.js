// Model Analytics — compare MII profiles across models.
// Loads the same mii_results_latest.csv as the main dashboard, builds a per-model
// profile from the normalized MII input columns, and lets the user benchmark a
// base model against auto-suggested comparables plus manual picks.

const CSV_URL = "https://my-mii-reports.s3.us-east-2.amazonaws.com/mii_results_latest.csv";

// The dimensions of a model's MII profile. Weights mirror the published MII
// formula (price 30%, bids 30%, views 20%, comments 12%, social 5%, age 3%);
// Google Trends and YouTube feed the social score, so they carry no extra
// weight in the similarity distance but are still shown on the radar.
const PROFILE_DIMS = [
    { key: 'price_normalized', label: 'Price', weight: 0.30 },
    { key: 'bids_normalized', label: 'Bids', weight: 0.30 },
    { key: 'views_normalized', label: 'Views', weight: 0.20 },
    { key: 'comments_normalized', label: 'Comments', weight: 0.12 },
    { key: 'social_score_normalized', label: 'Social', weight: 0.05 },
    { key: 'age_normalized', label: 'Age', weight: 0.03 },
    { key: 'google_trends_interest_normalized', label: 'Google Trends', weight: 0 },
    { key: 'youtube_total_views_normalized', label: 'YouTube', weight: 0 },
];

const MAX_COMPARISONS = 5;   // additional models beyond the base
const SERIES_COLORS = ['#f59e0b', '#38bdf8', '#34d399', '#a78bfa', '#fb7185', '#a3e635'];

// modelKey ("Manufacturer|Model") -> { manufacturer, model, rows, profile, count }
let models = {};
let modelKeys = [];   // sorted for search
let quarters = [];    // all distinct months, sorted

let baseKey = null;
let comparisonKeys = [];

let radarChart = null;
let trendChart = null;

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
            return `<button data-key="${escapeHtml(k)}" class="search-item w-full text-left px-4 py-2 text-sm hover:bg-zinc-700 transition-colors flex items-center justify-between gap-2">
                <span><span class="text-zinc-400">${escapeHtml(m.manufacturer)}</span> <span class="font-medium">${escapeHtml(m.model)}</span></span>
                <span class="text-xs text-zinc-500 whitespace-nowrap">${m.count} mo · MII ${m.avgMII.toFixed(1)}</span>
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
        baseEl.innerHTML = `<div class="flex items-center justify-between bg-zinc-800 border border-amber-500/40 rounded-lg px-4 py-3">
            <div>
                <div class="text-xs text-zinc-500">${escapeHtml(m.manufacturer)}</div>
                <div class="font-semibold text-amber-500">${escapeHtml(m.model)}</div>
            </div>
            <div class="text-right text-xs text-zinc-500">${m.count} months<br>avg MII ${m.avgMII.toFixed(1)}</div>
        </div>`;
    } else {
        baseEl.innerHTML = '';
    }

    document.getElementById('selectionCount').textContent = `(${comparisonKeys.length}/${MAX_COMPARISONS})`;

    const listEl = document.getElementById('selectionList');
    if (!comparisonKeys.length) {
        listEl.innerHTML = '<p class="text-sm text-zinc-600">No comparison models added yet</p>';
    } else {
        listEl.innerHTML = comparisonKeys.map((k, i) => {
            const color = SERIES_COLORS[(i + 1) % SERIES_COLORS.length];
            return `<div class="flex items-center justify-between bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2">
                <div class="flex items-center gap-2 min-w-0">
                    <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${color}"></span>
                    <span class="text-sm truncate">${escapeHtml(modelLabel(k))}</span>
                </div>
                <button data-key="${escapeHtml(k)}" class="remove-btn text-zinc-500 hover:text-red-400 text-lg leading-none px-1" aria-label="Remove">&times;</button>
            </div>`;
        }).join('');
    }
}

function renderSuggestions() {
    const el = document.getElementById('suggestionsList');
    if (!baseKey) {
        el.innerHTML = '<p class="text-sm text-zinc-600">Pick a base model to see suggestions</p>';
        return;
    }
    const suggestions = suggestSimilar(baseKey);
    if (!suggestions.length) {
        el.innerHTML = '<p class="text-sm text-zinc-600">No similar models found</p>';
        return;
    }
    const full = comparisonKeys.length >= MAX_COMPARISONS;
    el.innerHTML = suggestions.map(s => {
        const m = models[s.key];
        const pct = similarityPct(s.distance);
        return `<div class="flex items-center justify-between bg-zinc-800/60 border border-zinc-700/50 rounded-lg px-3 py-2 gap-2">
            <div class="min-w-0">
                <div class="text-sm truncate"><span class="text-zinc-400">${escapeHtml(m.manufacturer)}</span> <span class="font-medium">${escapeHtml(m.model)}</span></div>
                <div class="text-xs text-zinc-500">${pct.toFixed(0)}% profile match · avg MII ${m.avgMII.toFixed(1)}</div>
            </div>
            <button data-key="${escapeHtml(s.key)}" ${full ? 'disabled' : ''} class="suggest-add flex-shrink-0 px-2.5 py-1 rounded-md text-xs font-medium ${full ? 'bg-zinc-800 text-zinc-600 cursor-not-allowed' : 'bg-amber-600/20 text-amber-500 border border-amber-600/40 hover:bg-amber-600/40'} transition-colors">+ Add</button>
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
                    backgroundColor: color + '22',
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
                    grid: { color: 'rgba(255,255,255,0.08)' },
                    angleLines: { color: 'rgba(255,255,255,0.08)' },
                    pointLabels: { color: '#a1a1aa', font: { size: 11 } }
                }
            },
            plugins: {
                legend: { labels: { color: '#d4d4d8', boxWidth: 12, font: { size: 11 } } }
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
                    grid: { color: 'rgba(255,255,255,0.04)' },
                    ticks: { color: '#71717a', font: { size: 10 } }
                },
                y: {
                    grid: { color: 'rgba(255,255,255,0.06)' },
                    ticks: { color: '#71717a', font: { size: 11 } },
                    title: { display: true, text: 'MII Score', color: '#71717a', font: { size: 11 } }
                }
            },
            plugins: {
                legend: { labels: { color: '#d4d4d8', boxWidth: 12, font: { size: 11 } } }
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

    head.innerHTML = `<tr>
        <th class="px-5 py-3 font-medium">Metric</th>
        ${keys.map((k, i) => `<th class="px-5 py-3 font-medium" style="color:${SERIES_COLORS[i % SERIES_COLORS.length]}">${escapeHtml(modelLabel(k))}${i === 0 ? ' <span class="text-zinc-600 normal-case">(base)</span>' : ''}</th>`).join('')}
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
        return `<tr class="hover:bg-zinc-800/30">
            <td class="px-5 py-3 text-zinc-400">${metric.label}</td>
            ${vals.map(v => {
                const isBest = best !== null && v !== null && v === best && keys.length > 1;
                return `<td class="px-5 py-3 ${isBest ? 'text-amber-400 font-semibold' : 'text-zinc-200'}">${metric.fmt(v)}</td>`;
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
            <div class="text-4xl mb-4">⚠️</div>
            <div class="text-xl font-semibold text-zinc-100">Failed to Load Data</div>
            <div class="text-sm text-zinc-500 mt-2">${escapeHtml(error.message)}</div>
        </div>`;
    }
}

init();
