// ============================================================
// MII TERMINAL - Manufacturer Dashboard
// Bloomberg terminal-style candlestick + volume charts
// ============================================================

const CSV_URL = "https://my-mii-reports.s3.us-east-2.amazonaws.com/mii_results_latest.csv";

// ---- Manufacturer Branding ----
const MANUFACTURER_BRANDING = {
    'Porsche': { abbr: 'POR', color: '#d5001c' },
    'BMW': { abbr: 'BMW', color: '#1c69d4' },
    'Mercedes-Benz': { abbr: 'MB', color: '#00adef' },
    'Ferrari': { abbr: 'FER', color: '#dc0000' },
    'Nissan': { abbr: 'NIS', color: '#c3002f' },
    'Toyota': { abbr: 'TOY', color: '#eb0a1e' },
    'Audi': { abbr: 'AUD', color: '#bb0a30' },
    'Chevrolet': { abbr: 'CHV', color: '#ffc72c' },
    'Ford': { abbr: 'FOR', color: '#003478' },
    'Lamborghini': { abbr: 'LAM', color: '#ffd700' },
    'Jaguar': { abbr: 'JAG', color: '#006633' },
    'Land Rover': { abbr: 'LRV', color: '#005a2b' },
    'Lexus': { abbr: 'LEX', color: '#0061aa' },
    'Honda': { abbr: 'HON', color: '#cc0000' },
    'Acura': { abbr: 'ACU', color: '#700000' },
    'Mazda': { abbr: 'MAZ', color: '#c1272d' },
    'Subaru': { abbr: 'SUB', color: '#0052a5' },
    'Volkswagen': { abbr: 'VW', color: '#001e50' },
    'Mercedes-AMG': { abbr: 'AMG', color: '#00adef' },
    'Dodge': { abbr: 'DOD', color: '#cc162c' },
    'Plymouth': { abbr: 'PLY', color: '#ff6600' },
    'Pontiac': { abbr: 'PON', color: '#ee3124' },
    'Oldsmobile': { abbr: 'OLD', color: '#003da5' }
};

function getBranding(name) {
    return MANUFACTURER_BRANDING[name] || {
        abbr: name.substring(0, 3).toUpperCase(),
        color: '#888'
    };
}

// ---- Colors ----
const C = {
    bg: '#0a0a0a',
    panel: '#111111',
    border: '#1c1c1c',
    grid: '#1a1a1a',
    gridLight: '#222222',
    text: '#cccccc',
    muted: '#555555',
    dim: '#333333',
    green: '#00c853',
    greenDim: 'rgba(0,200,83,0.25)',
    red: '#ff1744',
    redDim: 'rgba(255,23,68,0.25)',
    amber: '#ff9800',
    blue: '#2196f3',
    blueDim: 'rgba(33,150,243,0.3)',
    white: '#e0e0e0',
};

// ---- State ----
let rawCSVData = [];
let processedData = null;
let state = {
    selectedQuarter: null,
    minVolume: 10,
    sortBy: 'mii',
    searchTerm: '',
    expandedMfr: null,
};

// ---- Data Loading ----
async function loadCSVData() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(CSV_URL, {
        mode: 'cors',
        signal: controller.signal,
        headers: { 'Accept': 'text/csv' }
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

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

// ---- OHLC Data Processing ----
function avg(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function processOHLCData(rawData) {
    const validData = rawData.filter(row =>
        row.quarter &&
        row.quarter !== 'IAF' &&
        row.manufacturer &&
        row.mii_score &&
        !isNaN(parseFloat(row.mii_score))
    );

    const quarters = [...new Set(validData.map(r => r.quarter))].sort();

    // Group data by quarter
    const dataByQuarter = {};
    quarters.forEach(q => {
        dataByQuarter[q] = validData.filter(r => r.quarter === q);
    });

    // Build market-wide OHLC
    const marketOHLC = [];
    quarters.forEach((quarter, idx) => {
        const rows = dataByQuarter[quarter];
        const scores = rows.map(r => parseFloat(r.mii_score));
        const prices = rows.map(r => parseFloat(r.price || 0));
        const prevClose = idx > 0 ? marketOHLC[idx - 1].close : avg(scores);

        marketOHLC.push({
            label: quarter,
            open: prevClose,
            high: Math.max(...scores),
            low: Math.min(...scores),
            close: avg(scores),
            volume: scores.length,
            avgPrice: avg(prices),
        });
    });

    // Build per-manufacturer OHLC
    const manufacturerOHLC = {};
    const manufacturerSummary = {};

    quarters.forEach((quarter, qIdx) => {
        const rows = dataByQuarter[quarter];

        // Group by manufacturer
        const mfrGroups = {};
        rows.forEach(row => {
            const mfr = row.manufacturer;
            if (!mfrGroups[mfr]) mfrGroups[mfr] = [];
            mfrGroups[mfr].push(row);
        });

        Object.entries(mfrGroups).forEach(([mfr, mfrRows]) => {
            const scores = mfrRows.map(r => parseFloat(r.mii_score));
            const prices = mfrRows.map(r => parseFloat(r.price || 0));

            if (!manufacturerOHLC[mfr]) manufacturerOHLC[mfr] = [];

            const prevClose = manufacturerOHLC[mfr].length > 0
                ? manufacturerOHLC[mfr][manufacturerOHLC[mfr].length - 1].close
                : avg(scores);

            manufacturerOHLC[mfr].push({
                label: quarter,
                open: prevClose,
                high: Math.max(...scores),
                low: Math.min(...scores),
                close: avg(scores),
                volume: scores.length,
                avgPrice: avg(prices),
            });

            // Update summary for latest quarter
            if (!manufacturerSummary[mfr] || qIdx >= quarters.indexOf(manufacturerSummary[mfr]._lastQuarter)) {
                const prevQ = qIdx > 0 ? quarters[qIdx - 1] : null;
                let change = 0;
                if (manufacturerOHLC[mfr].length >= 2) {
                    const prev = manufacturerOHLC[mfr][manufacturerOHLC[mfr].length - 2].close;
                    const curr = avg(scores);
                    change = prev > 0 ? ((curr - prev) / prev) * 100 : 0;
                }

                manufacturerSummary[mfr] = {
                    name: mfr,
                    mii: avg(scores),
                    volume: scores.length,
                    avgPrice: avg(prices),
                    high: Math.max(...scores),
                    low: Math.min(...scores),
                    change: change,
                    totalVolume: (manufacturerOHLC[mfr] || []).reduce((s, d) => s + d.volume, 0),
                    _lastQuarter: quarter,
                };
            }
        });
    });

    return {
        quarters,
        marketOHLC,
        manufacturerOHLC,
        manufacturerSummary,
        dataByQuarter,
    };
}

// ============================================================
// CANDLESTICK CHART RENDERER
// ============================================================

function drawCandlestickChart(canvas, ohlcData, options = {}) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const W = rect.width;
    const H = rect.height;

    if (!ohlcData || ohlcData.length === 0) {
        ctx.fillStyle = C.muted;
        ctx.font = '11px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('NO DATA', W / 2, H / 2);
        return;
    }

    const {
        showVolume = true,
        showLabels = true,
        showGrid = true,
        showYAxis = true,
        showXAxis = true,
        compact = false,
        volumeColor = null,
    } = options;

    // Layout
    const leftMargin = showYAxis ? (compact ? 35 : 50) : 8;
    const rightMargin = compact ? 8 : 15;
    const topMargin = compact ? 6 : 12;
    const bottomMargin = showXAxis ? (compact ? 16 : 22) : 6;
    const volumeRatio = showVolume ? 0.22 : 0;
    const gapRatio = showVolume ? 0.04 : 0;

    const chartW = W - leftMargin - rightMargin;
    const chartH = H - topMargin - bottomMargin;
    const candleAreaH = chartH * (1 - volumeRatio - gapRatio);
    const volumeAreaH = chartH * volumeRatio;
    const gapH = chartH * gapRatio;

    // Price scale
    const allPrices = ohlcData.flatMap(d => [d.high, d.low, d.open, d.close]);
    const minPrice = Math.min(...allPrices);
    const maxPrice = Math.max(...allPrices);
    const priceRange = maxPrice - minPrice || 1;
    const pricePad = priceRange * 0.12;
    const scaleMinP = minPrice - pricePad;
    const scaleMaxP = maxPrice + pricePad;
    const scalePRange = scaleMaxP - scaleMinP;

    const scaleY = (price) => {
        return topMargin + ((scaleMaxP - price) / scalePRange) * candleAreaH;
    };

    // Volume scale
    const maxVol = Math.max(...ohlcData.map(d => d.volume), 1);
    const volumeTop = topMargin + candleAreaH + gapH;

    const scaleVolY = (vol) => {
        return volumeTop + volumeAreaH - (vol / maxVol) * volumeAreaH;
    };

    // Candle layout
    const n = ohlcData.length;
    const candleSlotW = chartW / n;
    const bodyW = Math.max(Math.min(candleSlotW * 0.55, compact ? 14 : 28), 3);

    const candleX = (i) => leftMargin + i * candleSlotW + candleSlotW / 2;

    // ---- Draw grid ----
    if (showGrid) {
        ctx.strokeStyle = C.grid;
        ctx.lineWidth = 0.5;

        // Horizontal grid lines (price area)
        const gridCount = compact ? 3 : 5;
        for (let i = 0; i <= gridCount; i++) {
            const y = topMargin + (i / gridCount) * candleAreaH;
            ctx.beginPath();
            ctx.moveTo(leftMargin, y);
            ctx.lineTo(W - rightMargin, y);
            ctx.stroke();

            if (showYAxis) {
                const price = scaleMaxP - (i / gridCount) * scalePRange;
                ctx.fillStyle = C.dim;
                ctx.font = `${compact ? 8 : 10}px monospace`;
                ctx.textAlign = 'right';
                ctx.fillText(price.toFixed(1), leftMargin - 4, y + 3);
            }
        }

        // Separator between candle area and volume
        if (showVolume) {
            ctx.strokeStyle = C.border;
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(leftMargin, volumeTop - gapH / 2);
            ctx.lineTo(W - rightMargin, volumeTop - gapH / 2);
            ctx.stroke();
        }
    }

    // ---- Draw candles ----
    ohlcData.forEach((d, i) => {
        const x = candleX(i);
        const isUp = d.close >= d.open;
        const bodyColor = isUp ? C.green : C.red;
        const wickColor = isUp ? C.green : C.red;

        const openY = scaleY(d.open);
        const closeY = scaleY(d.close);
        const highY = scaleY(d.high);
        const lowY = scaleY(d.low);

        // Wick
        ctx.strokeStyle = wickColor;
        ctx.lineWidth = compact ? 0.8 : 1.2;
        ctx.beginPath();
        ctx.moveTo(x, highY);
        ctx.lineTo(x, lowY);
        ctx.stroke();

        // Body
        const bodyTop = Math.min(openY, closeY);
        const bodyHeight = Math.max(Math.abs(closeY - openY), 1);
        ctx.fillStyle = bodyColor;
        ctx.fillRect(x - bodyW / 2, bodyTop, bodyW, bodyHeight);

        // Body border for visibility
        if (!compact) {
            ctx.strokeStyle = bodyColor;
            ctx.lineWidth = 0.5;
            ctx.strokeRect(x - bodyW / 2, bodyTop, bodyW, bodyHeight);
        }

        // Volume bar
        if (showVolume) {
            const volH = (d.volume / maxVol) * volumeAreaH;
            const volY = volumeTop + volumeAreaH - volH;
            const vColor = volumeColor || (isUp ? C.greenDim : C.redDim);
            ctx.fillStyle = vColor;
            ctx.fillRect(x - bodyW / 2, volY, bodyW, volH);
        }

        // X axis labels
        if (showXAxis) {
            ctx.fillStyle = C.dim;
            ctx.font = `${compact ? 7 : 9}px monospace`;
            ctx.textAlign = 'center';
            const label = compact ? d.label.replace('20', "'") : d.label;
            ctx.fillText(label, x, H - (compact ? 2 : 4));
        }
    });

    // Volume Y axis label
    if (showVolume && showYAxis && !compact) {
        ctx.fillStyle = C.dim;
        ctx.font = '8px monospace';
        ctx.textAlign = 'right';
        ctx.fillText(maxVol.toLocaleString(), leftMargin - 4, volumeTop + 8);
        ctx.fillText('0', leftMargin - 4, volumeTop + volumeAreaH);
    }

    // Store layout info on canvas for tooltip hit testing
    canvas._chartLayout = {
        ohlcData, candleX, bodyW, leftMargin, rightMargin, topMargin,
        candleSlotW, candleAreaH, volumeTop, volumeAreaH, scaleY, scaleVolY,
        scaleMaxP, scalePRange, maxVol, n, W, H
    };
}

// ---- Tooltip handler for candlestick charts ----
function setupChartTooltip(canvas, tooltipEl) {
    canvas.addEventListener('mousemove', (e) => {
        const layout = canvas._chartLayout;
        if (!layout) return;

        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Find which candle we're over
        let found = -1;
        for (let i = 0; i < layout.n; i++) {
            const cx = layout.candleX(i);
            if (Math.abs(mouseX - cx) < layout.candleSlotW / 2) {
                found = i;
                break;
            }
        }

        if (found >= 0 && mouseX >= layout.leftMargin && mouseX <= layout.W - layout.rightMargin) {
            const d = layout.ohlcData[found];
            const isUp = d.close >= d.open;
            const changeColor = isUp ? C.green : C.red;
            const changeSign = isUp ? '+' : '';
            const change = d.open > 0 ? ((d.close - d.open) / d.open * 100).toFixed(1) : '0.0';

            tooltipEl.innerHTML = `
                <div style="color:${C.amber};font-weight:600;margin-bottom:2px;">${d.label}</div>
                <div>O: <span style="color:${C.white}">${d.open.toFixed(1)}</span></div>
                <div>H: <span style="color:${C.green}">${d.high.toFixed(1)}</span></div>
                <div>L: <span style="color:${C.red}">${d.low.toFixed(1)}</span></div>
                <div>C: <span style="color:${changeColor}">${d.close.toFixed(1)}</span> <span style="color:${changeColor}">${changeSign}${change}%</span></div>
                <div style="margin-top:2px;color:${C.muted}">Vol: ${d.volume.toLocaleString()}</div>
            `;
            tooltipEl.classList.remove('hidden');

            // Position tooltip
            const ttRect = tooltipEl.getBoundingClientRect();
            let left = e.clientX - rect.left + 12;
            if (left + ttRect.width > layout.W) {
                left = e.clientX - rect.left - ttRect.width - 12;
            }
            let top = e.clientY - rect.top - ttRect.height / 2;
            top = Math.max(0, Math.min(top, layout.H - ttRect.height));

            tooltipEl.style.left = left + 'px';
            tooltipEl.style.top = top + 'px';
        } else {
            tooltipEl.classList.add('hidden');
        }
    });

    canvas.addEventListener('mouseleave', () => {
        tooltipEl.classList.add('hidden');
    });
}

// ============================================================
// RENDERING
// ============================================================

function renderStatsTicker() {
    if (!processedData) return;

    const market = processedData.marketOHLC;
    const latest = market[market.length - 1];
    const prev = market.length >= 2 ? market[market.length - 2] : null;

    const miiChange = prev ? ((latest.close - prev.close) / prev.close * 100) : 0;
    const isUp = miiChange >= 0;

    document.getElementById('statMII').textContent = latest.close.toFixed(1);
    const changeEl = document.getElementById('statMIIChange');
    changeEl.textContent = `${isUp ? '+' : ''}${miiChange.toFixed(1)}%`;
    changeEl.style.color = isUp ? C.green : C.red;

    document.getElementById('statVol').textContent = latest.volume.toLocaleString();
    document.getElementById('statAvgPx').textContent = `$${(latest.avgPrice / 1000).toFixed(0)}K`;

    const mfrCount = Object.keys(processedData.manufacturerSummary).length;
    document.getElementById('statMakes').textContent = mfrCount;
    document.getElementById('statHigh').textContent = latest.high.toFixed(1);
    document.getElementById('statLow').textContent = latest.low.toFixed(1);
}

function renderMarketChart() {
    if (!processedData) return;

    const canvas = document.getElementById('marketChart');
    const tooltip = document.getElementById('marketTooltip');

    drawCandlestickChart(canvas, processedData.marketOHLC, {
        showVolume: true,
        showLabels: true,
        showGrid: true,
        showYAxis: true,
        showXAxis: true,
        compact: false,
    });

    setupChartTooltip(canvas, tooltip);
}

function getFilteredManufacturers() {
    if (!processedData) return [];

    const summaries = Object.values(processedData.manufacturerSummary);

    return summaries
        .filter(m => m.volume >= state.minVolume)
        .filter(m => m.name.toLowerCase().includes(state.searchTerm.toLowerCase()))
        .sort((a, b) => {
            switch (state.sortBy) {
                case 'mii': return b.mii - a.mii;
                case 'volume': return b.volume - a.volume;
                case 'change': return b.change - a.change;
                case 'name': return a.name.localeCompare(b.name);
                default: return b.mii - a.mii;
            }
        });
}

function renderManufacturerGrid() {
    if (!processedData) return;

    const grid = document.getElementById('mfrGrid');
    const filtered = getFilteredManufacturers();

    document.getElementById('mfrCount').textContent = `${filtered.length} MANUFACTURERS`;

    grid.innerHTML = filtered.map((mfr) => {
        const branding = getBranding(mfr.name);
        const isUp = mfr.change >= 0;
        const changeColor = isUp ? C.green : C.red;
        const changeSign = isUp ? '+' : '';
        const isExpanded = state.expandedMfr === mfr.name;

        return `
            <div class="mfr-card rounded cursor-pointer ${isExpanded ? 'selected' : ''}"
                 data-mfr="${mfr.name}"
                 style="background:#111111; border:1px solid #2a2a2a; overflow:hidden;">
                <!-- Card Header -->
                <div class="px-3 py-2 border-b border-[#2a2a2a] flex items-center justify-between" style="background:#0f0f0f;">
                    <div class="flex items-center gap-2">
                        <span class="inline-flex items-center justify-center w-6 h-6 rounded text-[9px] font-bold"
                              style="background:${branding.color}20; color:${branding.color}; border:1px solid ${branding.color}40;">
                            ${branding.abbr}
                        </span>
                        <span class="text-[11px] font-semibold text-[#e0e0e0]">${mfr.name}</span>
                    </div>
                    <div class="text-right">
                        <span class="text-[13px] font-bold text-[#ff9800]">${mfr.mii.toFixed(1)}</span>
                        <span class="text-[10px] font-medium ml-1" style="color:${changeColor}">
                            ${changeSign}${mfr.change.toFixed(1)}%
                        </span>
                    </div>
                </div>

                <!-- Mini Candlestick Chart -->
                <div class="px-2 py-1 relative" style="height: 130px; overflow:hidden;">
                    <canvas class="mfr-chart" data-mfr="${mfr.name}"></canvas>
                    <div class="chart-tooltip hidden mfr-tooltip" data-mfr="${mfr.name}"></div>
                </div>

                <!-- Stats Footer -->
                <div class="px-3 py-2 border-t border-[#2a2a2a] flex items-center justify-between text-[9px]" style="background:#0f0f0f;">
                    <div>
                        <span class="text-[#555]">VOL</span>
                        <span class="text-[#ccc] ml-1">${mfr.volume}</span>
                    </div>
                    <div>
                        <span class="text-[#555]">AVG</span>
                        <span class="text-[#ccc] ml-1">$${(mfr.avgPrice / 1000).toFixed(0)}K</span>
                    </div>
                    <div>
                        <span class="text-[#555]">H</span>
                        <span class="text-[#00c853] ml-1">${mfr.high.toFixed(1)}</span>
                    </div>
                    <div>
                        <span class="text-[#555]">L</span>
                        <span class="text-[#ff1744] ml-1">${mfr.low.toFixed(1)}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    // Draw mini charts
    requestAnimationFrame(() => {
        grid.querySelectorAll('.mfr-chart').forEach(canvas => {
            const mfrName = canvas.dataset.mfr;
            const ohlcData = processedData.manufacturerOHLC[mfrName];
            if (ohlcData) {
                drawCandlestickChart(canvas, ohlcData, {
                    showVolume: true,
                    showGrid: true,
                    showYAxis: true,
                    showXAxis: true,
                    compact: true,
                });

                // Setup tooltip
                const tooltip = canvas.parentElement.querySelector('.mfr-tooltip');
                if (tooltip) {
                    setupChartTooltip(canvas, tooltip);
                }
            }
        });
    });

    // Click handlers for expansion
    grid.querySelectorAll('.mfr-card').forEach(card => {
        card.addEventListener('click', () => {
            const mfrName = card.dataset.mfr;
            if (state.expandedMfr === mfrName) {
                state.expandedMfr = null;
                document.getElementById('mfrDetail').classList.add('hidden');
            } else {
                state.expandedMfr = mfrName;
                renderExpandedDetail(mfrName);
            }
            // Update selected state visually
            grid.querySelectorAll('.mfr-card').forEach(c => c.classList.remove('selected'));
            if (state.expandedMfr) {
                card.classList.add('selected');
            }
        });
    });
}

function renderExpandedDetail(mfrName) {
    const detail = document.getElementById('mfrDetail');
    const ohlcData = processedData.manufacturerOHLC[mfrName];
    const summary = processedData.manufacturerSummary[mfrName];
    const branding = getBranding(mfrName);

    if (!ohlcData || !summary) {
        detail.classList.add('hidden');
        return;
    }

    detail.classList.remove('hidden');

    // Get model data for the latest quarter
    const latestQ = processedData.quarters[processedData.quarters.length - 1];
    const latestRows = processedData.dataByQuarter[latestQ] || [];
    const mfrRows = latestRows.filter(r => r.manufacturer === mfrName);

    // Aggregate models
    const modelGroups = {};
    mfrRows.forEach(row => {
        const model = row.model;
        if (!modelGroups[model]) {
            modelGroups[model] = { model, scores: [], prices: [] };
        }
        modelGroups[model].scores.push(parseFloat(row.mii_score));
        modelGroups[model].prices.push(parseFloat(row.price || 0));
    });

    const models = Object.values(modelGroups).map(mg => ({
        model: mg.model,
        mii: avg(mg.scores),
        auctions: mg.scores.length,
        avgPrice: avg(mg.prices),
        high: Math.max(...mg.scores),
        low: Math.min(...mg.scores),
    })).sort((a, b) => b.mii - a.mii);

    const isUp = summary.change >= 0;
    const changeColor = isUp ? '#00c853' : '#ff1744';
    const changeSign = isUp ? '+' : '';

    detail.innerHTML = `
        <div class="terminal-panel rounded">
            <!-- Header -->
            <div class="px-4 py-3 border-b border-[#1c1c1c] flex items-center justify-between">
                <div class="flex items-center gap-3">
                    <span class="inline-flex items-center justify-center w-8 h-8 rounded text-[11px] font-bold"
                          style="background:${branding.color}20; color:${branding.color}; border:1px solid ${branding.color}40;">
                        ${branding.abbr}
                    </span>
                    <div>
                        <span class="text-sm font-semibold text-[#e0e0e0]">${mfrName}</span>
                        <span class="text-[10px] text-[#555] ml-2">DETAILED VIEW</span>
                    </div>
                </div>
                <button id="closeDetail" class="text-[#555] hover:text-[#ff9800] text-lg transition-colors">&times;</button>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-3 gap-0">
                <!-- Large Chart -->
                <div class="lg:col-span-2 p-4 border-r border-[#1c1c1c]">
                    <div class="flex items-center justify-between mb-2">
                        <span class="text-[10px] text-[#555] uppercase tracking-wider">MII OHLC BY QUARTER</span>
                        <div class="flex items-center gap-3 text-[10px]">
                            <span class="text-[#ff9800] font-semibold">${summary.mii.toFixed(1)}</span>
                            <span style="color:${changeColor}">${changeSign}${summary.change.toFixed(1)}%</span>
                        </div>
                    </div>
                    <div class="relative" style="height: 240px;">
                        <canvas id="detailChart"></canvas>
                        <div id="detailTooltip" class="chart-tooltip hidden"></div>
                    </div>
                    <!-- OHLC Data Table -->
                    <div class="mt-3 overflow-x-auto">
                        <table class="w-full text-[9px]">
                            <thead>
                                <tr class="text-[#555] border-b border-[#1c1c1c]">
                                    <th class="text-left py-1 px-2">QTR</th>
                                    <th class="text-right py-1 px-2">OPEN</th>
                                    <th class="text-right py-1 px-2">HIGH</th>
                                    <th class="text-right py-1 px-2">LOW</th>
                                    <th class="text-right py-1 px-2">CLOSE</th>
                                    <th class="text-right py-1 px-2">CHG%</th>
                                    <th class="text-right py-1 px-2">VOL</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${ohlcData.map(d => {
                                    const chg = d.open > 0 ? ((d.close - d.open) / d.open * 100) : 0;
                                    const up = chg >= 0;
                                    return `
                                        <tr class="border-b border-[#111] hover:bg-[#151515]">
                                            <td class="py-1 px-2 text-[#ff9800]">${d.label}</td>
                                            <td class="py-1 px-2 text-right text-[#ccc]">${d.open.toFixed(1)}</td>
                                            <td class="py-1 px-2 text-right text-[#00c853]">${d.high.toFixed(1)}</td>
                                            <td class="py-1 px-2 text-right text-[#ff1744]">${d.low.toFixed(1)}</td>
                                            <td class="py-1 px-2 text-right" style="color:${up ? '#00c853' : '#ff1744'}">${d.close.toFixed(1)}</td>
                                            <td class="py-1 px-2 text-right" style="color:${up ? '#00c853' : '#ff1744'}">${up ? '+' : ''}${chg.toFixed(1)}%</td>
                                            <td class="py-1 px-2 text-right text-[#ccc]">${d.volume}</td>
                                        </tr>
                                    `;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- Model Rankings -->
                <div class="p-4">
                    <div class="flex items-center justify-between mb-2">
                        <span class="text-[10px] text-[#555] uppercase tracking-wider">MODEL RANKINGS</span>
                        <span class="text-[10px] text-[#555]">${models.length} MODELS</span>
                    </div>

                    <!-- Summary stats -->
                    <div class="grid grid-cols-2 gap-2 mb-3">
                        <div class="bg-[#0a0a0a] rounded p-2">
                            <div class="text-[8px] text-[#555] uppercase">Total Vol</div>
                            <div class="text-[13px] font-bold text-[#ccc]">${summary.totalVolume}</div>
                        </div>
                        <div class="bg-[#0a0a0a] rounded p-2">
                            <div class="text-[8px] text-[#555] uppercase">Avg Price</div>
                            <div class="text-[13px] font-bold text-[#ccc]">$${(summary.avgPrice / 1000).toFixed(0)}K</div>
                        </div>
                    </div>

                    <!-- Model list -->
                    <div class="max-h-72 overflow-y-auto scrollbar-thin space-y-0.5">
                        ${models.map((m, idx) => `
                            <div class="flex items-center justify-between py-1.5 px-2 rounded hover:bg-[#151515] transition-colors text-[10px]">
                                <div class="flex items-center gap-2">
                                    <span class="text-[#555] w-4 text-right">${idx + 1}</span>
                                    <div>
                                        <div class="text-[#e0e0e0] font-medium">${m.model}</div>
                                        <div class="text-[#555]">${m.auctions} auc &middot; $${(m.avgPrice / 1000).toFixed(0)}K</div>
                                    </div>
                                </div>
                                <div class="text-right">
                                    <div class="text-[#ff9800] font-semibold">${m.mii.toFixed(1)}</div>
                                    <div class="text-[8px]">
                                        <span class="text-[#00c853]">${m.high.toFixed(0)}</span>
                                        <span class="text-[#555]">/</span>
                                        <span class="text-[#ff1744]">${m.low.toFixed(0)}</span>
                                    </div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>
        </div>
    `;

    // Draw expanded chart
    requestAnimationFrame(() => {
        const canvas = document.getElementById('detailChart');
        const tooltip = document.getElementById('detailTooltip');
        if (canvas) {
            drawCandlestickChart(canvas, ohlcData, {
                showVolume: true,
                showGrid: true,
                showYAxis: true,
                showXAxis: true,
                compact: false,
            });
            setupChartTooltip(canvas, tooltip);
        }
    });

    // Close button
    document.getElementById('closeDetail').addEventListener('click', (e) => {
        e.stopPropagation();
        state.expandedMfr = null;
        detail.classList.add('hidden');
        document.querySelectorAll('.mfr-card').forEach(c => c.classList.remove('selected'));
    });

    // Scroll into view
    detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function populateQuarterSelect() {
    if (!processedData) return;

    const select = document.getElementById('quarterSelect');
    // Add "ALL" option plus individual quarters
    select.innerHTML = `<option value="ALL">ALL QUARTERS</option>` +
        processedData.quarters.map(q =>
            `<option value="${q}" ${q === processedData.quarters[processedData.quarters.length - 1] ? '' : ''}>${q}</option>`
        ).join('');

    select.value = 'ALL';
}

// ============================================================
// EVENT HANDLERS
// ============================================================

function setupEventListeners() {
    // Quarter select
    document.getElementById('quarterSelect').addEventListener('change', (e) => {
        state.selectedQuarter = e.target.value;
        // Re-render with filtered data
        renderMarketChart();
        renderManufacturerGrid();
        renderStatsTicker();
    });

    // Min volume filter
    document.getElementById('minVolume').addEventListener('change', (e) => {
        state.minVolume = parseInt(e.target.value);
        renderManufacturerGrid();
    });

    // Sort
    document.getElementById('sortBy').addEventListener('change', (e) => {
        state.sortBy = e.target.value;
        renderManufacturerGrid();
    });

    // Search
    document.getElementById('mfrSearch').addEventListener('input', (e) => {
        state.searchTerm = e.target.value;
        renderManufacturerGrid();
    });

    // Window resize
    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            renderMarketChart();
            renderManufacturerGrid();
        }, 200);
    });
}

// ============================================================
// INITIALIZATION
// ============================================================

async function initializeApp() {
    const loadingIndicator = document.getElementById('loadingIndicator');

    try {
        loadingIndicator.style.display = 'flex';

        rawCSVData = await loadCSVData();
        processedData = processOHLCData(rawCSVData);

        // Set last updated
        const now = new Date();
        document.getElementById('lastUpdated').textContent =
            now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
            now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

        loadingIndicator.style.display = 'none';

        populateQuarterSelect();
        setupEventListeners();
        renderStatsTicker();
        renderMarketChart();
        renderManufacturerGrid();

    } catch (error) {
        console.error('Failed to load data:', error);
        loadingIndicator.innerHTML = `
            <div class="text-center">
                <div class="text-4xl mb-3">&#9888;</div>
                <div class="text-sm text-[#ff1744] font-medium mb-2">DATA LOAD FAILED</div>
                <div class="text-[10px] text-[#555] mb-4">${error.message}</div>
                <button onclick="location.reload()"
                    class="px-4 py-2 bg-[#ff9800] text-[#0a0a0a] rounded text-[11px] font-semibold hover:bg-[#ffb74d] transition-colors">
                    RETRY
                </button>
            </div>
        `;
    }
}

// Start
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}
