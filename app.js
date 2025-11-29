// S3 CSV URL
const CSV_URL = "https://my-mii-reports.s3.us-east-2.amazonaws.com/mii_results_latest.csv";

// Manufacturer emoji mapping
const MANUFACTURER_LOGOS = {
    'Porsche': '🔵',
    'BMW': '⚪',
    'Mercedes-Benz': '⚪',
    'Ferrari': '🔴',
    'Nissan': '🟡',
    'Toyota': '🔘',
    'Audi': '⚫',
    'Chevrolet': '🟠',
    'Ford': '🔷',
    'Lamborghini': '🟡',
    'Jaguar': '🟢',
    'Land Rover': '🟤',
    'Lexus': '🔘',
    'Honda': '🔴',
    'Acura': '⚫',
    'Mazda': '🔴',
    'Subaru': '🔵',
    'Volkswagen': '🔵',
    'Mercedes-AMG': '⚪',
    'Dodge': '🔴',
    'Plymouth': '🟠',
    'Pontiac': '🔵',
    'Oldsmobile': '⚪'
};

// Global data object (will be populated from CSV)
let sampleData = {
    lastUpdated: new Date().toISOString(),
    quarters: [],
    quarterMIITrends: {},
    quarterData: {},
    manufacturers: []
};

// Load and parse CSV from S3
async function loadCSVData() {
    try {
        console.log('Fetching CSV from:', CSV_URL);

        // Create abort controller for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout

        const response = await fetch(CSV_URL, {
            mode: 'cors',
            signal: controller.signal,
            headers: {
                'Accept': 'text/csv'
            }
        });

        clearTimeout(timeoutId);

        console.log('Fetch response status:', response.status, response.statusText);

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
        console.log('CSV text length:', csvText.length, 'characters');

        return new Promise((resolve, reject) => {
            Papa.parse(csvText, {
                header: true,
                skipEmptyLines: true,
                complete: (results) => {
                    console.log('CSV parsing complete');
                    console.log('- Data rows:', results.data.length);
                    console.log('- Errors:', results.errors.length);

                    if (results.errors.length > 0) {
                        console.warn('CSV parsing errors:', results.errors);
                        // Only reject if there are critical errors and no data
                        if (results.data.length === 0) {
                            reject(new Error('CSV parsing failed: ' + results.errors[0].message));
                            return;
                        }
                    }

                    resolve(results.data);
                },
                error: (error) => {
                    console.error('Papa Parse error:', error);
                    reject(new Error('CSV parsing error: ' + error.message));
                }
            });
        });
    } catch (error) {
        console.error('Error loading CSV:', error);

        // Provide more specific error messages
        if (error.name === 'AbortError') {
            throw new Error('Request timeout - S3 server did not respond within 15 seconds');
        } else if (error.message.includes('Failed to fetch')) {
            throw new Error('Network error - Unable to reach S3. Check your internet connection or S3 CORS settings.');
        }

        throw error;
    }
}

// Process CSV data into dashboard format
function processCSVData(rawData) {
    console.log('Processing CSV data...');
    console.log('Total raw data rows:', rawData.length);

    // Filter out invalid quarters and rows
    const validData = rawData.filter(row =>
        row.quarter &&
        row.quarter !== 'IAF' &&
        row.manufacturer &&
        row.model &&
        row.mii_score &&
        !isNaN(parseFloat(row.mii_score))
    );

    console.log('Valid data rows:', validData.length);
    console.log('Filtered out:', rawData.length - validData.length, 'rows');

    if (validData.length === 0) {
        console.error('ERROR: No valid data rows found!');
        console.log('Sample of raw data (first 3 rows):', rawData.slice(0, 3));
        throw new Error('No valid data found in CSV. Check data format.');
    }

    // Get unique quarters and sort them
    const quarters = [...new Set(validData.map(row => row.quarter))].sort();
    sampleData.quarters = quarters;

    // Determine latest quarter (for QTD marking)
    const latestQuarter = quarters[quarters.length - 1];
    const qtdQuarter = latestQuarter + '-QTD';

    // Update quarters array to mark latest as QTD
    sampleData.quarters = quarters.slice(0, -1).concat([qtdQuarter]);

    // Group data by quarter
    const dataByQuarter = {};
    quarters.forEach(q => {
        dataByQuarter[q] = validData.filter(row => row.quarter === q);
    });

    // Process each quarter
    sampleData.quarterData = {};

    quarters.forEach((quarter, qIndex) => {
        const quarterKey = (qIndex === quarters.length - 1) ? qtdQuarter : quarter;
        const quarterRows = dataByQuarter[quarter];

        // Group by manufacturer
        const mfrGroups = {};
        quarterRows.forEach(row => {
            const mfr = row.manufacturer;
            if (!mfrGroups[mfr]) {
                mfrGroups[mfr] = [];
            }
            mfrGroups[mfr].push(row);
        });

        // Calculate manufacturer-level statistics
        const manufacturers = Object.keys(mfrGroups).map(mfrName => {
            const mfrData = mfrGroups[mfrName];
            const auctions = mfrData.length;

            // Calculate average MII score for manufacturer
            const avgMII = mfrData.reduce((sum, row) => sum + parseFloat(row.mii_score), 0) / auctions;

            // Calculate average price
            const avgPrice = mfrData.reduce((sum, row) => sum + parseFloat(row.price || 0), 0) / auctions;

            // Calculate trend (difference from previous quarter)
            let trend = 0;
            if (qIndex > 0) {
                const prevQuarter = quarters[qIndex - 1];
                const prevQuarterKey = prevQuarter;
                if (sampleData.quarterData[prevQuarterKey]) {
                    const prevMfr = sampleData.quarterData[prevQuarterKey].manufacturers.find(m => m.make === mfrName);
                    if (prevMfr) {
                        trend = ((avgMII - prevMfr.miiScore) / prevMfr.miiScore) * 100;
                    }
                }
            }

            // Build history array (last 3 quarters)
            const history = [];
            for (let i = Math.max(0, qIndex - 2); i <= qIndex; i++) {
                const hQuarter = quarters[i];
                const hQuarterKey = i === quarters.length - 1 ? qtdQuarter : hQuarter;
                if (sampleData.quarterData[hQuarterKey]) {
                    const hMfr = sampleData.quarterData[hQuarterKey].manufacturers.find(m => m.make === mfrName);
                    if (hMfr) {
                        history.push(hMfr.miiScore);
                    }
                } else if (i === qIndex) {
                    history.push(avgMII);
                }
            }

            // Get confidence level based on auction count
            let confidence = 'Low';
            if (auctions >= 50) confidence = 'High';
            else if (auctions >= 20) confidence = 'Medium-High';
            else if (auctions >= 10) confidence = 'Medium';

            // Calculate sell-through (assume all sold for now, or could add logic)
            const sellThrough = 75; // Placeholder

            // Process models
            const models = mfrData.map(row => ({
                model: row.model,
                auctions: 1, // Each row is one auction
                mii: parseFloat(row.mii_score),
                avgPrice: parseFloat(row.price || 0),
                trend: 0, // Could calculate model-specific trend
                confidence: 'Medium'
            }));

            // Group models by name and aggregate
            const modelGroups = {};
            models.forEach(model => {
                if (!modelGroups[model.model]) {
                    modelGroups[model.model] = {
                        model: model.model,
                        auctions: 0,
                        totalMII: 0,
                        totalPrice: 0
                    };
                }
                modelGroups[model.model].auctions += 1;
                modelGroups[model.model].totalMII += model.mii;
                modelGroups[model.model].totalPrice += model.avgPrice;
            });

            const aggregatedModels = Object.values(modelGroups).map(mg => ({
                model: mg.model,
                auctions: mg.auctions,
                mii: mg.totalMII / mg.auctions,
                avgPrice: mg.totalPrice / mg.auctions,
                trend: 0,
                confidence: mg.auctions >= 5 ? 'High' : mg.auctions >= 3 ? 'Medium' : 'Low'
            }));

            return {
                make: mfrName,
                logo: MANUFACTURER_LOGOS[mfrName] || '🚗',
                auctions: auctions,
                avgPrice: Math.round(avgPrice),
                miiScore: parseFloat(avgMII.toFixed(1)),
                confidence: confidence,
                trend: parseFloat(trend.toFixed(1)),
                sellThrough: sellThrough,
                history: history,
                models: aggregatedModels.sort((a, b) => b.mii - a.mii)
            };
        });

        sampleData.quarterData[quarterKey] = {
            manufacturers: manufacturers.sort((a, b) => b.miiScore - a.miiScore)
        };
    });

    // Process YTD (Year-to-Date) - aggregate all quarters from current year
    console.log('Processing YTD data...');
    const currentYear = new Date().getFullYear();
    const ytdQuarters = quarters.filter(q => q.startsWith(currentYear.toString()));

    if (ytdQuarters.length > 0) {
        console.log('YTD quarters:', ytdQuarters);

        // Combine all YTD quarter data
        const ytdRows = ytdQuarters.flatMap(q => dataByQuarter[q]);

        // Group by manufacturer
        const ytdMfrGroups = {};
        ytdRows.forEach(row => {
            const mfr = row.manufacturer;
            if (!ytdMfrGroups[mfr]) {
                ytdMfrGroups[mfr] = [];
            }
            ytdMfrGroups[mfr].push(row);
        });

        // Calculate YTD manufacturer statistics
        const ytdManufacturers = Object.keys(ytdMfrGroups).map(mfrName => {
            const mfrData = ytdMfrGroups[mfrName];
            const auctions = mfrData.length;

            const avgMII = mfrData.reduce((sum, row) => sum + parseFloat(row.mii_score), 0) / auctions;
            const avgPrice = mfrData.reduce((sum, row) => sum + parseFloat(row.price || 0), 0) / auctions;

            // For YTD, trend is based on first vs last quarter
            let trend = 0;
            if (ytdQuarters.length > 1) {
                const firstQ = ytdQuarters[0];
                const lastQ = ytdQuarters[ytdQuarters.length - 1];
                const firstQKey = firstQ;
                const lastQKey = lastQ === latestQuarter ? qtdQuarter : lastQ;

                const firstMfr = sampleData.quarterData[firstQKey]?.manufacturers.find(m => m.make === mfrName);
                const lastMfr = sampleData.quarterData[lastQKey]?.manufacturers.find(m => m.make === mfrName);

                if (firstMfr && lastMfr) {
                    trend = ((lastMfr.miiScore - firstMfr.miiScore) / firstMfr.miiScore) * 100;
                }
            }

            // Build history from all YTD quarters
            const history = ytdQuarters.map((q, i) => {
                const qKey = i === ytdQuarters.length - 1 && q === latestQuarter ? qtdQuarter : q;
                const mfr = sampleData.quarterData[qKey]?.manufacturers.find(m => m.make === mfrName);
                return mfr ? mfr.miiScore : null;
            }).filter(v => v !== null);

            // Confidence based on total YTD auctions
            let confidence = 'Low';
            if (auctions >= 150) confidence = 'High';
            else if (auctions >= 60) confidence = 'Medium-High';
            else if (auctions >= 30) confidence = 'Medium';

            const sellThrough = 75;

            // Process models for YTD
            const models = mfrData.map(row => ({
                model: row.model,
                auctions: 1,
                mii: parseFloat(row.mii_score),
                avgPrice: parseFloat(row.price || 0),
                trend: 0,
                confidence: 'Medium'
            }));

            // Group models by name and aggregate
            const modelGroups = {};
            models.forEach(model => {
                if (!modelGroups[model.model]) {
                    modelGroups[model.model] = {
                        model: model.model,
                        auctions: 0,
                        totalMII: 0,
                        totalPrice: 0
                    };
                }
                modelGroups[model.model].auctions += 1;
                modelGroups[model.model].totalMII += model.mii;
                modelGroups[model.model].totalPrice += model.avgPrice;
            });

            const aggregatedModels = Object.values(modelGroups).map(mg => ({
                model: mg.model,
                auctions: mg.auctions,
                mii: mg.totalMII / mg.auctions,
                avgPrice: mg.totalPrice / mg.auctions,
                trend: 0,
                confidence: mg.auctions >= 10 ? 'High' : mg.auctions >= 5 ? 'Medium' : 'Low'
            }));

            return {
                make: mfrName,
                logo: MANUFACTURER_LOGOS[mfrName] || '🚗',
                auctions: auctions,
                avgPrice: Math.round(avgPrice),
                miiScore: parseFloat(avgMII.toFixed(1)),
                confidence: confidence,
                trend: parseFloat(trend.toFixed(1)),
                sellThrough: sellThrough,
                history: history,
                models: aggregatedModels.sort((a, b) => b.mii - a.mii)
            };
        });

        sampleData.quarterData['YTD'] = {
            manufacturers: ytdManufacturers.sort((a, b) => b.miiScore - a.miiScore)
        };

        // Add YTD to quarters list at the beginning
        sampleData.quarters = ['YTD'].concat(sampleData.quarters);

        console.log('YTD processing complete:', ytdManufacturers.length, 'manufacturers');
    }

    // Set manufacturers to YTD data by default
    if (sampleData.quarterData['YTD']) {
        sampleData.manufacturers = sampleData.quarterData['YTD'].manufacturers;
    } else {
        // Fallback to latest quarter if no YTD data
        const latestQuarterKey = quarters.length > 0 ?
            (sampleData.quarters[sampleData.quarters.length - 1]) : null;
        if (latestQuarterKey && sampleData.quarterData[latestQuarterKey]) {
            sampleData.manufacturers = sampleData.quarterData[latestQuarterKey].manufacturers;
        }
    }

    // Build quarterMIITrends (aggregate MII by quarter)
    sampleData.quarterMIITrends = {};
    quarters.forEach((quarter, qIndex) => {
        const quarterKey = qIndex === quarters.length - 1 ? qtdQuarter : quarter;
        if (sampleData.quarterData[quarterKey]) {
            const manufacturers = sampleData.quarterData[quarterKey].manufacturers;
            const avgMII = manufacturers.reduce((sum, m) => sum + m.miiScore, 0) / manufacturers.length;

            // Create placeholder trend data (would need actual time-series data for real trends)
            sampleData.quarterMIITrends[quarterKey] = {
                labels: ['Start', 'Mid', 'End'],
                data: [avgMII - 1, avgMII, avgMII + 0.5]
            };
        }
    });

    console.log('Processed data:', sampleData);
    return sampleData;
}

// Initialize app with CSV data
async function initializeApp() {
    const loadingIndicator = document.getElementById('loadingIndicator');

    try {
        loadingIndicator.style.display = 'flex';

        // Load and process CSV data
        const rawData = await loadCSVData();
        processCSVData(rawData);

        // Update last updated time
        sampleData.lastUpdated = new Date().toISOString();

        // Set default selected quarter to latest
        if (sampleData.quarters.length > 0) {
            state.selectedQuarter = sampleData.quarters[sampleData.quarters.length - 1];
        }

        // Hide loading indicator
        loadingIndicator.style.display = 'none';

        // Initialize the dashboard
        init();

    } catch (error) {
        console.error('Failed to load data:', error);

        // Provide helpful troubleshooting information
        const troubleshootingSteps = [
            'Open browser DevTools (F12) and check the Console tab for detailed errors',
            'Verify the S3 bucket has public read access enabled',
            'Check that CORS is configured on the S3 bucket',
            'Ensure the file mii_results_latest.csv exists in the bucket',
            'Check your internet connection'
        ];

        loadingIndicator.innerHTML = `
            <div class="text-center max-w-2xl mx-auto">
                <div class="text-6xl mb-4">⚠️</div>
                <div class="text-xl font-semibold text-red-400 mb-2">Failed to Load Data</div>
                <div class="text-sm text-zinc-400 mt-2 mb-4">${error.message}</div>
                <button
                    onclick="location.reload()"
                    class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors mb-6">
                    Retry
                </button>
                <details class="text-left bg-zinc-900 p-4 rounded-lg">
                    <summary class="cursor-pointer text-sm text-zinc-400 mb-2">Troubleshooting Steps</summary>
                    <ol class="text-xs text-zinc-500 space-y-1 list-decimal list-inside">
                        ${troubleshootingSteps.map(step => `<li>${step}</li>`).join('')}
                    </ol>
                    <div class="mt-3 text-xs text-zinc-600">
                        <strong>S3 URL:</strong> <span class="text-zinc-500">${CSV_URL}</span>
                    </div>
                </details>
            </div>
        `;
    }
}

// Temporary placeholder manufacturers array (will be replaced by CSV data)
sampleData.manufacturers = [];

// State management
let state = {
    selectedMake: null,
    minAuctions: 10,
    sortBy: 'miiScore',
    sortOrder: 'desc',
    searchTerm: '',
    viewMode: 'leaderboard',
    compareList: [],
    selectedQuarter: 'YTD'
};

let charts = {
    trend: null,
    compare: null,
    quarterMII: null
};

// Helper functions
function formatQuarterDisplay(quarterStr) {
    if (quarterStr.endsWith('-QTD')) {
        const base = quarterStr.replace('-QTD', '');
        return `${base} (QTD)`;
    }
    return quarterStr;
}

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
    // Get manufacturers for the selected quarter
    const quarterKey = state.selectedQuarter;
    const manufacturers = (sampleData.quarterData[quarterKey]?.manufacturers) || sampleData.manufacturers || [];

    return manufacturers
        .filter(m => m.auctions >= state.minAuctions)
        .filter(m => m.make.toLowerCase().includes(state.searchTerm.toLowerCase()))
        .sort((a, b) => {
            const multiplier = state.sortOrder === 'desc' ? -1 : 1;
            return (a[state.sortBy] - b[state.sortBy]) * multiplier;
        });
}

function getTopModels(minAuctions = 3, limit = 15) {
    const allModels = [];

    // Get manufacturers for the selected quarter
    const quarterKey = state.selectedQuarter;
    const manufacturers = (sampleData.quarterData[quarterKey]?.manufacturers) || sampleData.manufacturers || [];

    // For YTD, use no minimum auctions; for quarters, use the specified minimum
    const effectiveMinAuctions = quarterKey === 'YTD' ? 0 : minAuctions;

    console.log('getTopModels: Quarter:', quarterKey, '| Manufacturers:', manufacturers.length, '| Min auctions:', effectiveMinAuctions);

    manufacturers.forEach(mfr => {
        if (!mfr.models || mfr.models.length === 0) {
            console.warn('Manufacturer', mfr.make, 'has no models');
            return;
        }

        mfr.models.forEach(model => {
            if (model.auctions >= effectiveMinAuctions) {
                allModels.push({
                    ...model,
                    make: mfr.make,
                    makeLogo: mfr.logo
                });
            }
        });
    });

    console.log('getTopModels: Found', allModels.length, 'models with', effectiveMinAuctions, '+ auctions');

    return allModels
        .sort((a, b) => b.mii - a.mii)
        .slice(0, limit);
}

function calculateMarketStats() {
    // Get manufacturers for the selected quarter
    const quarterKey = state.selectedQuarter;
    const manufacturers = (sampleData.quarterData[quarterKey]?.manufacturers) || sampleData.manufacturers || [];
    const filtered = manufacturers.filter(m => m.auctions >= state.minAuctions);

    if (filtered.length === 0) {
        return {
            totalManufacturers: 0,
            totalAuctions: 0,
            avgMII: 0,
            avgPrice: 0
        };
    }

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
    const quarterKey = state.selectedQuarter;
    const manufacturers = (sampleData.quarterData[quarterKey]?.manufacturers) || sampleData.manufacturers || [];

    document.getElementById('qualifyingMakes').textContent = stats.totalManufacturers;
    document.getElementById('totalMakes').textContent = `of ${manufacturers.length} total`;
    document.getElementById('totalAuctions').textContent = stats.totalAuctions.toLocaleString();
    document.getElementById('marketMII').textContent = stats.avgMII.toFixed(1);
    document.getElementById('avgPrice').textContent = `$${(stats.avgPrice / 1000).toFixed(0)}K`;
}

function renderTopModels() {
    const topModels = getTopModels(3, 15);
    const container = document.getElementById('topModelsContainer');
    const subtitle = document.getElementById('topModelsSubtitle');

    // Update subtitle based on selected quarter
    const isYTD = state.selectedQuarter === 'YTD';
    if (subtitle) {
        subtitle.textContent = isYTD
            ? 'Top models across all manufacturers for the year'
            : 'Top models across all manufacturers with 3+ auctions';
    }

    console.log('Rendering top models:', topModels.length, 'models found');

    if (topModels.length === 0) {
        const minText = isYTD ? '' : 'with 3+ auctions ';
        console.warn('No models found', minText);
        container.innerHTML = `<div class="col-span-full text-center text-zinc-500 py-8">No models found ${minText}in this ${isYTD ? 'period' : 'quarter'}</div>`;
        return;
    }

    container.innerHTML = topModels.map((model, idx) => {
        return `
            <div class="bg-zinc-800/50 rounded-lg p-4 hover:bg-zinc-800 transition-colors">
                <div class="flex items-start justify-between mb-2">
                    <div class="flex items-center gap-2">
                        <span class="text-2xl">${model.makeLogo}</span>
                        <div>
                            <div class="font-semibold text-sm">${model.model}</div>
                            <div class="text-xs text-zinc-500">${model.make}</div>
                        </div>
                    </div>
                    <div class="text-right">
                        <div class="text-xl font-bold text-amber-500">${model.mii.toFixed(1)}</div>
                        <div class="text-xs text-zinc-500">#${idx + 1}</div>
                    </div>
                </div>
                <div class="flex items-center justify-between text-xs">
                    <div class="text-zinc-500">
                        ${model.auctions} auctions • $${(model.avgPrice / 1000).toFixed(0)}K
                    </div>
                    <div class="flex items-center gap-2">
                        ${getTrendIndicator(model.trend)}
                        ${getConfidenceBadge(model.confidence)}
                    </div>
                </div>
            </div>
        `;
    }).join('');
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

function renderQuarterMIIChart() {
    const container = document.getElementById('quarterProgressContainer');
    if (!container) return;

    const trendData = sampleData.quarterMIITrends[state.selectedQuarter];
    if (!trendData) {
        container.classList.add('hidden');
        return;
    }

    const isQTD = state.selectedQuarter.endsWith('-QTD');

    container.classList.remove('hidden');
    container.innerHTML = `
        <div class="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
            <div class="flex items-center justify-between mb-4">
                <div class="flex items-center gap-2">
                    <h3 class="font-semibold">Market Interest Index Trend</h3>
                    ${isQTD ? '<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-900/30 text-amber-400 border border-amber-800/50"><span class="inline-block w-1.5 h-1.5 bg-amber-500 rounded-full animate-pulse"></span>Live</span>' : ''}
                </div>
                <div class="text-xs text-zinc-500">${formatQuarterDisplay(state.selectedQuarter)}</div>
            </div>
            <div style="height: 200px;">
                <canvas id="quarterMIIChart"></canvas>
            </div>
        </div>
    `;

    // Render chart after DOM update
    setTimeout(() => {
        const canvas = document.getElementById('quarterMIIChart');
        if (!canvas) return;

        const ctx = canvas.getContext('2d');

        if (charts.quarterMII) {
            charts.quarterMII.destroy();
        }

        const currentValue = trendData.data[trendData.data.length - 1];
        const startValue = trendData.data[0];
        const change = currentValue - startValue;
        const changePercent = ((change / startValue) * 100).toFixed(1);

        charts.quarterMII = new Chart(ctx, {
            type: 'line',
            data: {
                labels: trendData.labels,
                datasets: [{
                    label: 'Average MII',
                    data: trendData.data,
                    borderColor: '#f59e0b',
                    backgroundColor: 'rgba(245, 158, 11, 0.1)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 4,
                    pointBackgroundColor: '#f59e0b',
                    pointBorderColor: '#18181b',
                    pointBorderWidth: 2,
                    pointHoverRadius: 6
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
                        displayColors: false,
                        callbacks: {
                            label: function(context) {
                                return 'MII: ' + context.parsed.y.toFixed(1);
                            }
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
                            },
                            callback: function(value) {
                                return value.toFixed(1);
                            }
                        },
                        min: Math.min(...trendData.data) - 2,
                        max: Math.max(...trendData.data) + 2
                    }
                }
            }
        });
    }, 0);
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
    renderTopModels();
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
        `<option value="${q}" ${q === state.selectedQuarter ? 'selected' : ''}>${formatQuarterDisplay(q)}</option>`
    ).join('');

    // Event listener for quarter select
    quarterSelect.addEventListener('change', (e) => {
        state.selectedQuarter = e.target.value;
        updateFilters();
        renderQuarterMIIChart();
    });

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
    renderQuarterMIIChart();
    renderMarketStats();
    renderTopModels();
    renderLeaderboard();
    renderManufacturerDetail();
    renderComparePanel();
}

// Start the app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}
