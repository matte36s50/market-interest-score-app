// Sample data structure
const sampleData = {
    lastUpdated: "2025-11-26T18:00:00Z",
    quarters: ["2025Q2", "2025Q3"],
    manufacturers: [
        {
            make: "Porsche",
            logo: "🔵",
            auctions: 245,
            avgPrice: 89500,
            miiScore: 87.4,
            confidence: "High",
            trend: 4.2,
            sellThrough: 78,
            history: [86.8, 87.4],
            models: [
                { model: "911 Turbo", auctions: 67, mii: 92.3, avgPrice: 185000, trend: 5.1, confidence: "High" },
                { model: "911 Carrera", auctions: 54, mii: 88.7, avgPrice: 95000, trend: 3.2, confidence: "High" },
                { model: "Boxster S", auctions: 38, mii: 79.4, avgPrice: 42000, trend: -1.3, confidence: "Medium-High" },
                { model: "Cayman GT4", auctions: 28, mii: 91.1, avgPrice: 125000, trend: 6.8, confidence: "Medium-High" },
                { model: "944 Turbo", auctions: 22, mii: 76.8, avgPrice: 38000, trend: 2.1, confidence: "Medium" },
                { model: "928 GTS", auctions: 18, mii: 74.2, avgPrice: 65000, trend: 1.8, confidence: "Medium" },
                { model: "Taycan", auctions: 18, mii: 68.5, avgPrice: 72000, trend: -3.4, confidence: "Medium" }
            ]
        },
        {
            make: "BMW",
            logo: "⚪",
            auctions: 312,
            avgPrice: 52300,
            miiScore: 84.2,
            confidence: "High",
            trend: 2.8,
            sellThrough: 72,
            history: [83.1, 84.2],
            models: [
                { model: "E46 M3", auctions: 54, mii: 89.7, avgPrice: 48500, trend: 4.5, confidence: "High" },
                { model: "E30 M3", auctions: 28, mii: 94.2, avgPrice: 125000, trend: 8.2, confidence: "Medium-High" },
                { model: "E39 M5", auctions: 42, mii: 85.3, avgPrice: 38000, trend: 2.1, confidence: "High" },
                { model: "E92 M3", auctions: 48, mii: 82.6, avgPrice: 42000, trend: 1.8, confidence: "High" },
                { model: "Z3 M Coupe", auctions: 22, mii: 88.1, avgPrice: 58000, trend: 5.4, confidence: "Medium" },
                { model: "E28 M5", auctions: 15, mii: 79.4, avgPrice: 45000, trend: 3.2, confidence: "Medium" },
                { model: "Z8", auctions: 12, mii: 91.8, avgPrice: 235000, trend: 4.1, confidence: "Medium" },
                { model: "2002tii", auctions: 18, mii: 77.5, avgPrice: 42000, trend: 1.2, confidence: "Medium" }
            ]
        },
        {
            make: "Mercedes-Benz",
            logo: "⭐",
            auctions: 198,
            avgPrice: 67800,
            miiScore: 81.5,
            confidence: "High",
            trend: 1.4,
            sellThrough: 68,
            history: [80.6, 81.5],
            models: [
                { model: "190E 2.5-16 Evo II", auctions: 8, mii: 96.2, avgPrice: 385000, trend: 12.1, confidence: "Low" },
                { model: "SL 500 (R129)", auctions: 32, mii: 78.4, avgPrice: 28000, trend: 0.8, confidence: "High" },
                { model: "W124 500E", auctions: 24, mii: 84.2, avgPrice: 52000, trend: 3.5, confidence: "Medium-High" },
                { model: "C63 AMG (W204)", auctions: 38, mii: 79.8, avgPrice: 38000, trend: -0.5, confidence: "High" },
                { model: "SLS AMG", auctions: 18, mii: 88.5, avgPrice: 195000, trend: 2.8, confidence: "Medium" },
                { model: "300SL Gullwing", auctions: 6, mii: 98.1, avgPrice: 1450000, trend: 5.2, confidence: "Low" }
            ]
        },
        {
            make: "Ferrari",
            logo: "🔴",
            auctions: 89,
            avgPrice: 285000,
            miiScore: 91.2,
            confidence: "High",
            trend: 3.8,
            sellThrough: 82,
            history: [90.2, 91.2],
            models: [
                { model: "F430", auctions: 22, mii: 89.4, avgPrice: 185000, trend: 2.4, confidence: "Medium" },
                { model: "458 Italia", auctions: 18, mii: 92.1, avgPrice: 225000, trend: 4.2, confidence: "Medium" },
                { model: "360 Modena", auctions: 28, mii: 84.7, avgPrice: 95000, trend: 1.8, confidence: "Medium-High" },
                { model: "F355", auctions: 12, mii: 87.3, avgPrice: 125000, trend: 3.1, confidence: "Medium" },
                { model: "Testarossa", auctions: 9, mii: 85.9, avgPrice: 175000, trend: 2.8, confidence: "Low" }
            ]
        },
        {
            make: "Nissan",
            logo: "🟡",
            auctions: 156,
            avgPrice: 48200,
            miiScore: 78.6,
            confidence: "High",
            trend: 5.2,
            sellThrough: 74,
            history: [77.2, 78.6],
            models: [
                { model: "Skyline GT-R (R34)", auctions: 18, mii: 94.8, avgPrice: 185000, trend: 8.5, confidence: "Medium" },
                { model: "Skyline GT-R (R32)", auctions: 24, mii: 88.2, avgPrice: 85000, trend: 6.2, confidence: "Medium-High" },
                { model: "300ZX Twin Turbo", auctions: 32, mii: 79.4, avgPrice: 38000, trend: 4.1, confidence: "High" },
                { model: "240SX", auctions: 42, mii: 72.5, avgPrice: 22000, trend: 3.8, confidence: "High" },
                { model: "Fairlady Z (S30)", auctions: 18, mii: 81.2, avgPrice: 52000, trend: 2.4, confidence: "Medium" }
            ]
        },
        {
            make: "Toyota",
            logo: "🔘",
            auctions: 178,
            avgPrice: 42500,
            miiScore: 76.8,
            confidence: "High",
            trend: 3.1,
            sellThrough: 76,
            history: [75.8, 76.8],
            models: [
                { model: "Supra (A80)", auctions: 28, mii: 91.4, avgPrice: 95000, trend: 5.8, confidence: "Medium-High" },
                { model: "Land Cruiser (FJ40)", auctions: 35, mii: 82.6, avgPrice: 65000, trend: 3.2, confidence: "High" },
                { model: "MR2 Turbo", auctions: 24, mii: 74.8, avgPrice: 28000, trend: 2.4, confidence: "Medium-High" },
                { model: "AE86", auctions: 18, mii: 78.5, avgPrice: 35000, trend: 4.1, confidence: "Medium" },
                { model: "4Runner (1st Gen)", auctions: 32, mii: 71.2, avgPrice: 24000, trend: 1.8, confidence: "High" }
            ]
        },
        {
            make: "Audi",
            logo: "⚫",
            auctions: 142,
            avgPrice: 48900,
            miiScore: 74.2,
            confidence: "High",
            trend: 0.8,
            sellThrough: 65,
            history: [73.9, 74.2],
            models: [
                { model: "RS4 (B7)", auctions: 28, mii: 81.4, avgPrice: 48000, trend: 2.1, confidence: "Medium-High" },
                { model: "RS6 Avant (C6)", auctions: 18, mii: 84.2, avgPrice: 68000, trend: 3.8, confidence: "Medium" },
                { model: "Ur-Quattro", auctions: 15, mii: 86.5, avgPrice: 85000, trend: 4.2, confidence: "Medium" },
                { model: "R8 V10", auctions: 32, mii: 77.8, avgPrice: 125000, trend: -1.2, confidence: "High" },
                { model: "TT RS", auctions: 24, mii: 72.4, avgPrice: 42000, trend: 0.5, confidence: "Medium-High" }
            ]
        },
        {
            make: "Chevrolet",
            logo: "🟠",
            auctions: 285,
            avgPrice: 58200,
            miiScore: 72.4,
            confidence: "High",
            trend: 1.2,
            sellThrough: 71,
            history: [71.9, 72.4],
            models: [
                { model: "Corvette C2 Stingray", auctions: 32, mii: 85.2, avgPrice: 95000, trend: 2.8, confidence: "High" },
                { model: "Corvette C3", auctions: 48, mii: 74.6, avgPrice: 42000, trend: 0.8, confidence: "High" },
                { model: "Camaro Z/28 (1st Gen)", auctions: 24, mii: 82.4, avgPrice: 78000, trend: 3.1, confidence: "Medium-High" },
                { model: "Chevelle SS 454", auctions: 18, mii: 79.8, avgPrice: 68000, trend: 1.4, confidence: "Medium" },
                { model: "C8 Corvette", auctions: 52, mii: 68.5, avgPrice: 85000, trend: -2.1, confidence: "High" }
            ]
        },
        {
            make: "Ford",
            logo: "🔷",
            auctions: 298,
            avgPrice: 52800,
            miiScore: 71.8,
            confidence: "High",
            trend: 0.6,
            sellThrough: 69,
            history: [71.5, 71.8],
            models: [
                { model: "GT40", auctions: 5, mii: 97.8, avgPrice: 2850000, trend: 4.5, confidence: "Low" },
                { model: "Mustang Shelby GT350", auctions: 28, mii: 84.2, avgPrice: 125000, trend: 2.8, confidence: "Medium-High" },
                { model: "Bronco (1st Gen)", auctions: 42, mii: 78.5, avgPrice: 58000, trend: 1.2, confidence: "High" },
                { model: "F-150 Raptor", auctions: 38, mii: 72.4, avgPrice: 52000, trend: -0.8, confidence: "High" },
                { model: "Focus RS", auctions: 32, mii: 74.8, avgPrice: 38000, trend: 1.5, confidence: "High" }
            ]
        },
        {
            make: "Lamborghini",
            logo: "🟡",
            auctions: 52,
            avgPrice: 285000,
            miiScore: 88.4,
            confidence: "High",
            trend: 2.4,
            sellThrough: 79,
            history: [87.6, 88.4],
            models: [
                { model: "Gallardo", auctions: 22, mii: 84.2, avgPrice: 145000, trend: 1.8, confidence: "Medium" },
                { model: "Murcielago", auctions: 12, mii: 89.5, avgPrice: 285000, trend: 3.2, confidence: "Medium" },
                { model: "Countach", auctions: 8, mii: 94.8, avgPrice: 650000, trend: 4.8, confidence: "Low" },
                { model: "Huracan", auctions: 10, mii: 82.4, avgPrice: 225000, trend: 0.5, confidence: "Medium" }
            ]
        },
        {
            make: "Jaguar",
            logo: "🟢",
            auctions: 86,
            avgPrice: 68500,
            miiScore: 73.8,
            confidence: "High",
            trend: -0.4,
            sellThrough: 62,
            history: [74.0, 73.8],
            models: [
                { model: "E-Type Series I", auctions: 18, mii: 88.4, avgPrice: 165000, trend: 1.2, confidence: "Medium" },
                { model: "XJ220", auctions: 5, mii: 91.2, avgPrice: 485000, trend: 2.8, confidence: "Low" },
                { model: "F-Type R", auctions: 28, mii: 72.5, avgPrice: 58000, trend: -1.5, confidence: "Medium-High" },
                { model: "XKR", auctions: 22, mii: 68.4, avgPrice: 32000, trend: -2.1, confidence: "Medium" }
            ]
        },
        {
            make: "Land Rover",
            logo: "🟤",
            auctions: 124,
            avgPrice: 52400,
            miiScore: 74.5,
            confidence: "High",
            trend: 2.1,
            sellThrough: 71,
            history: [73.9, 74.5],
            models: [
                { model: "Defender 90", auctions: 42, mii: 79.8, avgPrice: 68000, trend: 3.5, confidence: "High" },
                { model: "Defender 110", auctions: 35, mii: 76.4, avgPrice: 52000, trend: 2.8, confidence: "High" },
                { model: "Range Rover Classic", auctions: 28, mii: 74.2, avgPrice: 42000, trend: 1.8, confidence: "Medium-High" },
                { model: "Discovery Series I", auctions: 19, mii: 68.5, avgPrice: 18000, trend: 0.5, confidence: "Medium" }
            ]
        }
    ]
};

// State management
let state = {
    selectedMake: null,
    minAuctions: 10,
    sortBy: 'miiScore',
    sortOrder: 'desc',
    searchTerm: '',
    viewMode: 'leaderboard',
    compareList: [],
    selectedQuarter: '2025Q2'
};

let charts = {
    trend: null,
    compare: null
};

// Helper functions
function getConfidenceBadge(level) {
    const styles = {
        High: { bg: 'bg-emerald-900/30', text: 'text-emerald-400', icon: '●' },
        'Medium-High': { bg: 'bg-teal-900/30', text: 'text-teal-400', icon: '◐' },
        Medium: { bg: 'bg-amber-900/30', text: 'text-amber-400', icon: '◐' },
        Low: { bg: 'bg-red-900/30', text: 'text-red-400', icon: '○' }
    };
    const style = styles[level] || styles.Medium;

    return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${style.bg} ${style.text}">
        <span>${style.icon}</span>
        <span>${level}</span>
    </span>`;
}

function getTrendIndicator(value, size = 'normal') {
    const isPositive = value > 0;
    const isNeutral = Math.abs(value) < 0.5;
    const textSize = size === 'large' ? 'text-lg' : 'text-sm';

    if (isNeutral) {
        return `<span class="${textSize} text-zinc-500 font-medium">→ ${Math.abs(value).toFixed(1)}%</span>`;
    }

    const color = isPositive ? 'text-emerald-400' : 'text-rose-400';
    const arrow = isPositive ? '↑' : '↓';
    return `<span class="${textSize} font-semibold ${color}">${arrow} ${Math.abs(value).toFixed(1)}%</span>`;
}

function createSparkline(data, color = '#10b981') {
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const height = 24;
    const width = 80;

    const points = data.map((val, i) => {
        const x = (i / (data.length - 1)) * width;
        const y = height - ((val - min) / range) * height;
        return `${x},${y}`;
    }).join(' ');

    return `<svg width="${width}" height="${height}" class="inline-block">
        <polyline
            points="${points}"
            fill="none"
            stroke="${color}"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
        />
    </svg>`;
}

function getFilteredManufacturers() {
    return sampleData.manufacturers
        .filter(m => m.auctions >= state.minAuctions)
        .filter(m => m.make.toLowerCase().includes(state.searchTerm.toLowerCase()))
        .sort((a, b) => {
            const multiplier = state.sortOrder === 'desc' ? -1 : 1;
            return (a[state.sortBy] - b[state.sortBy]) * multiplier;
        });
}

function calculateMarketStats() {
    const filtered = sampleData.manufacturers.filter(m => m.auctions >= state.minAuctions);
    return {
        totalManufacturers: filtered.length,
        totalAuctions: filtered.reduce((sum, m) => sum + m.auctions, 0),
        avgMII: filtered.reduce((sum, m) => sum + m.miiScore, 0) / filtered.length,
        avgPrice: filtered.reduce((sum, m) => sum + m.avgPrice, 0) / filtered.length
    };
}

// Render functions
function renderMarketStats() {
    const stats = calculateMarketStats();
    document.getElementById('qualifyingMakes').textContent = stats.totalManufacturers;
    document.getElementById('totalMakes').textContent = `of ${sampleData.manufacturers.length} total`;
    document.getElementById('totalAuctions').textContent = stats.totalAuctions.toLocaleString();
    document.getElementById('marketMII').textContent = stats.avgMII.toFixed(1);
    document.getElementById('avgPrice').textContent = `$${(stats.avgPrice / 1000).toFixed(0)}K`;
}

function renderLeaderboard() {
    const filtered = getFilteredManufacturers();
    const container = document.getElementById('leaderboardContainer');

    document.getElementById('leaderboardSubtitle').textContent =
        `Showing ${filtered.length} manufacturers with ${state.minAuctions}+ auctions`;

    container.innerHTML = filtered.map((mfr, idx) => {
        const sparklineColor = mfr.trend > 0 ? '#10b981' : mfr.trend < 0 ? '#f43f5e' : '#71717a';
        const isSelected = state.selectedMake === mfr.make;
        const isComparing = state.compareList.includes(mfr.make);

        return `
            <div class="px-5 py-4 cursor-pointer transition-all hover:bg-zinc-800/50 ${isSelected ? 'bg-amber-900/20 border-l-2 border-amber-500' : ''}"
                 data-make="${mfr.make}">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-4">
                        <div class="w-8 text-center font-bold text-zinc-500">
                            ${idx + 1}
                        </div>
                        <div class="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center text-xl">
                            ${mfr.logo}
                        </div>
                        <div>
                            <div class="font-semibold text-zinc-100">${mfr.make}</div>
                            <div class="text-xs text-zinc-500">
                                ${mfr.auctions} auctions • $${(mfr.avgPrice / 1000).toFixed(0)}K avg
                            </div>
                        </div>
                    </div>

                    <div class="flex items-center gap-6">
                        <div class="hidden md:block">
                            ${createSparkline(mfr.history, sparklineColor)}
                        </div>
                        <div class="text-right">
                            <div class="text-2xl font-bold text-amber-500">${mfr.miiScore.toFixed(1)}</div>
                            ${getTrendIndicator(mfr.trend)}
                        </div>
                        ${getConfidenceBadge(mfr.confidence)}
                        <button class="compare-btn w-8 h-8 rounded-lg flex items-center justify-center transition-all ${isComparing ? 'bg-amber-600 text-white' : 'bg-zinc-800 text-zinc-500 hover:bg-zinc-700'}"
                                data-make="${mfr.make}">
                            ${isComparing ? '✓' : '+'}
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    // Add event listeners
    container.querySelectorAll('[data-make]').forEach(el => {
        if (el.classList.contains('compare-btn')) {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleCompare(el.dataset.make);
            });
        } else {
            el.addEventListener('click', () => {
                selectManufacturer(el.dataset.make === state.selectedMake ? null : el.dataset.make);
            });
        }
    });
}

function renderManufacturerDetail() {
    const container = document.getElementById('manufacturerDetail');
    const mfr = sampleData.manufacturers.find(m => m.make === state.selectedMake);

    if (!mfr) {
        container.innerHTML = `
            <div class="bg-zinc-900 border border-zinc-800 rounded-xl p-8 text-center">
                <div class="text-4xl mb-4">👈</div>
                <h3 class="font-semibold text-zinc-300">Select a Manufacturer</h3>
                <p class="text-sm text-zinc-500 mt-2">
                    Click on any manufacturer in the leaderboard to view detailed model breakdowns and trends
                </p>
            </div>
        `;
        return;
    }

    container.innerHTML = `
        <!-- Manufacturer Header -->
        <div class="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
            <div class="flex items-center gap-4 mb-4">
                <div class="w-14 h-14 rounded-full bg-zinc-800 flex items-center justify-center text-3xl">
                    ${mfr.logo}
                </div>
                <div>
                    <h3 class="text-xl font-bold">${mfr.make}</h3>
                    <div class="text-sm text-zinc-500">
                        ${mfr.auctions} auctions this quarter
                    </div>
                </div>
            </div>

            <div class="grid grid-cols-2 gap-4">
                <div class="bg-zinc-800/50 rounded-lg p-3">
                    <div class="text-xs text-zinc-500">MII Score</div>
                    <div class="text-2xl font-bold text-amber-500">
                        ${mfr.miiScore.toFixed(1)}
                    </div>
                    ${getTrendIndicator(mfr.trend)}
                </div>
                <div class="bg-zinc-800/50 rounded-lg p-3">
                    <div class="text-xs text-zinc-500">Sell-Through</div>
                    <div class="text-2xl font-bold text-emerald-400">
                        ${mfr.sellThrough}%
                    </div>
                    <div class="text-xs text-zinc-500">of auctions sold</div>
                </div>
            </div>
        </div>

        <!-- MII Trend Chart -->
        <div class="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
            <h4 class="font-semibold mb-4">MII Trend (2 Quarters)</h4>
            <canvas id="trendChart" style="max-height: 160px;"></canvas>
        </div>

        <!-- Model Rankings -->
        <div class="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <div class="border-b border-zinc-800 px-5 py-4">
                <h4 class="font-semibold">Model Rankings</h4>
                <p class="text-xs text-zinc-500 mt-1">
                    ${mfr.models.length} models tracked
                </p>
            </div>
            <div class="divide-y divide-zinc-800/50 max-h-96 overflow-y-auto scrollbar-thin">
                ${mfr.models
                    .sort((a, b) => b.mii - a.mii)
                    .map((model, idx) => `
                        <div class="px-5 py-3 hover:bg-zinc-800/30 transition-colors">
                            <div class="flex items-center justify-between">
                                <div class="flex items-center gap-3">
                                    <span class="w-6 text-center text-sm font-medium text-zinc-500">
                                        ${idx + 1}
                                    </span>
                                    <div>
                                        <div class="font-medium text-sm">${model.model}</div>
                                        <div class="text-xs text-zinc-500">
                                            ${model.auctions} auctions • $${(model.avgPrice / 1000).toFixed(0)}K
                                        </div>
                                    </div>
                                </div>
                                <div class="text-right">
                                    <div class="font-bold text-amber-500">${model.mii.toFixed(1)}</div>
                                    <div class="flex items-center gap-2">
                                        ${getTrendIndicator(model.trend)}
                                        ${getConfidenceBadge(model.confidence)}
                                    </div>
                                </div>
                            </div>
                        </div>
                    `).join('')}
            </div>
        </div>
    `;

    // Render trend chart
    setTimeout(() => renderTrendChart(mfr), 0);
}

function renderTrendChart(mfr) {
    const canvas = document.getElementById('trendChart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    if (charts.trend) {
        charts.trend.destroy();
    }

    charts.trend = new Chart(ctx, {
        type: 'line',
        data: {
            labels: sampleData.quarters,
            datasets: [{
                label: 'MII Score',
                data: mfr.history,
                borderColor: '#f59e0b',
                backgroundColor: 'rgba(245, 158, 11, 0.1)',
                fill: true,
                tension: 0.4,
                pointRadius: 4,
                pointBackgroundColor: '#f59e0b'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: '#18181b',
                    titleColor: '#f4f4f5',
                    bodyColor: '#f4f4f5',
                    borderColor: '#27272a',
                    borderWidth: 1,
                    padding: 12,
                    displayColors: false
                }
            },
            scales: {
                x: {
                    grid: {
                        color: '#27272a',
                        drawBorder: false
                    },
                    ticks: {
                        color: '#71717a',
                        font: {
                            size: 11
                        }
                    }
                },
                y: {
                    grid: {
                        color: '#27272a',
                        drawBorder: false
                    },
                    ticks: {
                        color: '#71717a',
                        font: {
                            size: 11
                        }
                    }
                }
            }
        }
    });
}

function renderComparePanel() {
    const panel = document.getElementById('comparePanel');
    const listContainer = document.getElementById('compareList');

    if (state.compareList.length === 0) {
        panel.classList.add('hidden');
        return;
    }

    panel.classList.remove('hidden');
    document.getElementById('compareCount').textContent = `Compare (${state.compareList.length}/4)`;

    listContainer.innerHTML = state.compareList.map(make => {
        const mfr = sampleData.manufacturers.find(m => m.make === make);
        return `
            <span class="inline-flex items-center gap-2 bg-zinc-800 rounded-full px-3 py-1 text-sm">
                ${mfr?.logo} ${make}
                <button class="remove-compare text-zinc-500 hover:text-zinc-300" data-make="${make}">
                    ×
                </button>
            </span>
        `;
    }).join('');

    // Add event listeners
    listContainer.querySelectorAll('.remove-compare').forEach(btn => {
        btn.addEventListener('click', () => toggleCompare(btn.dataset.make));
    });

    renderCompareChart();
}

function renderCompareChart() {
    const canvas = document.getElementById('compareChart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    if (charts.compare) {
        charts.compare.destroy();
    }

    const colors = ['#f59e0b', '#10b981', '#3b82f6', '#8b5cf6'];

    const datasets = state.compareList.map((make, i) => {
        const mfr = sampleData.manufacturers.find(m => m.make === make);
        return {
            label: make,
            data: mfr.history,
            borderColor: colors[i],
            backgroundColor: 'transparent',
            tension: 0.4,
            pointRadius: 0,
            borderWidth: 2
        };
    });

    charts.compare = new Chart(ctx, {
        type: 'line',
        data: {
            labels: sampleData.quarters,
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: '#18181b',
                    titleColor: '#f4f4f5',
                    bodyColor: '#f4f4f5',
                    borderColor: '#27272a',
                    borderWidth: 1,
                    padding: 8,
                    titleFont: {
                        size: 11
                    },
                    bodyFont: {
                        size: 11
                    }
                }
            },
            scales: {
                x: {
                    grid: {
                        color: '#27272a',
                        drawBorder: false
                    },
                    ticks: {
                        color: '#71717a',
                        font: {
                            size: 10
                        }
                    }
                },
                y: {
                    grid: {
                        color: '#27272a',
                        drawBorder: false
                    },
                    ticks: {
                        color: '#71717a',
                        font: {
                            size: 10
                        }
                    }
                }
            }
        }
    });
}

// Action functions
function selectManufacturer(make) {
    state.selectedMake = make;
    renderLeaderboard();
    renderManufacturerDetail();
}

function toggleCompare(make) {
    if (state.compareList.includes(make)) {
        state.compareList = state.compareList.filter(m => m !== make);
    } else if (state.compareList.length < 4) {
        state.compareList.push(make);
    }
    renderLeaderboard();
    renderComparePanel();
}

function updateFilters() {
    renderMarketStats();
    renderLeaderboard();
}

// Initialize
function init() {
    // Set last updated
    const date = new Date(sampleData.lastUpdated);
    document.getElementById('lastUpdated').textContent = date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

    // Populate quarter select
    const quarterSelect = document.getElementById('quarterSelect');
    quarterSelect.innerHTML = sampleData.quarters.map(q =>
        `<option value="${q}" ${q === state.selectedQuarter ? 'selected' : ''}>${q}</option>`
    ).join('');

    // Event listeners
    document.getElementById('searchInput').addEventListener('input', (e) => {
        state.searchTerm = e.target.value;
        updateFilters();
    });

    document.getElementById('minAuctions').addEventListener('change', (e) => {
        state.minAuctions = Number(e.target.value);
        updateFilters();
    });

    document.getElementById('sortBy').addEventListener('change', (e) => {
        state.sortBy = e.target.value;
        updateFilters();
    });

    document.getElementById('sortOrder').addEventListener('click', () => {
        state.sortOrder = state.sortOrder === 'desc' ? 'asc' : 'desc';
        document.getElementById('sortOrder').textContent = state.sortOrder === 'desc' ? '↓' : '↑';
        updateFilters();
    });

    document.querySelectorAll('.view-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.view-mode-btn').forEach(b => {
                b.classList.remove('bg-amber-600', 'text-white');
                b.classList.add('text-zinc-400');
            });
            btn.classList.add('bg-amber-600', 'text-white');
            btn.classList.remove('text-zinc-400');
            state.viewMode = btn.dataset.mode;
        });
    });

    document.getElementById('clearCompare').addEventListener('click', () => {
        state.compareList = [];
        renderLeaderboard();
        renderComparePanel();
    });

    // Initial render
    renderMarketStats();
    renderLeaderboard();
    renderManufacturerDetail();
    renderComparePanel();
}

// Start the app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
