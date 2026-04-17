// S3 CSV URLs
const CSV_URL = "https://my-mii-reports.s3.us-east-2.amazonaws.com/mii_results_latest.csv";
const BAT_CSV_URL = "https://my-mii-reports.s3.us-east-2.amazonaws.com/bat.csv";

// Build auction count map from bat.csv: "make|normalizedModel|YYYY-MM" -> count
// Normalizes bat.csv model names to match MII model names by stripping the
// manufacturer prefix (e.g. "Porsche LWB 911T") and year-range suffixes (e.g. "(1969-1973)").
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
                    results.data.forEach(row => {
                        const make = (row.make || '').trim();
                        const rawModel = (row.model || '').trim();
                        const saleDate = (row.sale_date || '').trim();
                        if (!make || !rawModel || !saleDate) return;

                        // Parse sale_date "M/D/YY" or "M/D/YYYY" -> "YYYY-MM"
                        const parts = saleDate.split('/');
                        if (parts.length !== 3) return;
                        const month = parts[0].padStart(2, '0');
                        const yearPart = parts[2].trim();
                        const year = yearPart.length === 2 ? '20' + yearPart : yearPart;
                        const period = `${year}-${month}`;

                        // Normalize model: strip leading "Make " prefix, strip trailing "(YYYY-YYYY)"
                        let model = rawModel;
                        if (model.startsWith(make + ' ')) model = model.slice(make.length + 1);
                        model = model.replace(/\s*\(\d{4}-\d{4}\)$/, '').trim();

                        const key = `${make}|${model}|${period}`;
                        counts[key] = (counts[key] || 0) + 1;
                    });
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

// Inject auction_count into MII rows from bat.csv counts map
function injectAuctionCounts(rows, batCounts) {
    rows.forEach(row => {
        const key = `${row.manufacturer}|${row.model}|${row.quarter}`;
        row.auction_count = String(batCounts[key] || 0);
    });
}

// Manufacturer branding (colors, abbreviations, and logo URLs)
const MANUFACTURER_BRANDING = {
    'Porsche':       { abbr: 'POR', color: '#d5001c', bg: '#1a0003', logoUrl: 'https://upload.wikimedia.org/wikipedia/de/thumb/8/8c/Porsche_logo.svg/80px-Porsche_logo.svg.png' },
    'BMW':           { abbr: 'BMW', color: '#1c69d4', bg: '#001a33', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/44/BMW.svg/80px-BMW.svg.png' },
    'Mercedes-Benz': { abbr: 'MB',  color: '#00adef', bg: '#001a24', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/90/Mercedes-Logo.svg/80px-Mercedes-Logo.svg.png' },
    'Ferrari':       { abbr: 'FER', color: '#dc0000', bg: '#1f0000', logoUrl: 'https://upload.wikimedia.org/wikipedia/en/thumb/d/d1/Ferrari-Logo.svg/80px-Ferrari-Logo.svg.png' },
    'Nissan':        { abbr: 'NIS', color: '#c3002f', bg: '#1a0006', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8c/Nissan_logo.svg/80px-Nissan_logo.svg.png' },
    'Toyota':        { abbr: 'TOY', color: '#eb0a1e', bg: '#1f0103', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ee/Toyota_logo_%28Red%29.svg/80px-Toyota_logo_%28Red%29.svg.png' },
    'Audi':          { abbr: 'AUD', color: '#bb0a30', bg: '#1a0105', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/92/Audi-Logo_2016.svg/80px-Audi-Logo_2016.svg.png' },
    'Chevrolet':     { abbr: 'CHV', color: '#c8a84b', bg: '#262109', logoUrl: 'https://upload.wikimedia.org/wikipedia/en/thumb/3/37/Chevrolet_logo.svg/80px-Chevrolet_logo.svg.png' },
    'Ford':          { abbr: 'FOR', color: '#003478', bg: '#000a14', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3e/Ford_logo_flat.svg/80px-Ford_logo_flat.svg.png' },
    'Lamborghini':   { abbr: 'LAM', color: '#c8a84b', bg: '#262209', logoUrl: 'https://upload.wikimedia.org/wikipedia/en/thumb/d/df/Lamborghini_Logo.svg/80px-Lamborghini_Logo.svg.png' },
    'Jaguar':        { abbr: 'JAG', color: '#006633', bg: '#00140a', logoUrl: 'https://upload.wikimedia.org/wikipedia/en/thumb/f/f2/Jaguar_logo_%282012%29.svg/80px-Jaguar_logo_%282012%29.svg.png' },
    'Land Rover':    { abbr: 'LRV', color: '#005a2b', bg: '#001108', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/45/Land_Rover_logo.svg/80px-Land_Rover_logo.svg.png' },
    'Lexus':         { abbr: 'LEX', color: '#0061aa', bg: '#001220', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c8/Lexus_division_emblem.svg/80px-Lexus_division_emblem.svg.png' },
    'Honda':         { abbr: 'HON', color: '#cc0000', bg: '#1a0000', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7b/Honda_Logo.svg/80px-Honda_Logo.svg.png' },
    'Acura':         { abbr: 'ACU', color: '#700000', bg: '#120000', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c2/Acura_logo.svg/80px-Acura_logo.svg.png' },
    'Mazda':         { abbr: 'MAZ', color: '#c1272d', bg: '#1a0405', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/56/Mazda_logo.svg/80px-Mazda_logo.svg.png' },
    'Subaru':        { abbr: 'SUB', color: '#0052a5', bg: '#001019', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2e/Subaru_logo.svg/80px-Subaru_logo.svg.png' },
    'Volkswagen':    { abbr: 'VW',  color: '#001e50', bg: '#00060f', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6d/Volkswagen_logo_2019.svg/80px-Volkswagen_logo_2019.svg.png' },
    'Mercedes-AMG':  { abbr: 'AMG', color: '#00adef', bg: '#001a24', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5d/AMG_logo.svg/80px-AMG_logo.svg.png' },
    'Dodge':         { abbr: 'DOD', color: '#cc162c', bg: '#1a0304', logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6c/Dodge_logo.svg/80px-Dodge_logo.svg.png' },
    'Plymouth':      { abbr: 'PLY', color: '#ff6600', bg: '#1f1100' },
    'Pontiac':       { abbr: 'PON', color: '#ee3124', bg: '#1f0605', logoUrl: 'https://upload.wikimedia.org/wikipedia/en/thumb/c/c8/Pontiac_logo.svg/80px-Pontiac_logo.svg.png' },
    'Oldsmobile':    { abbr: 'OLD', color: '#003da5', bg: '#000c19' }
};

// Fallback handler for broken logo images — replaces wrapper with letter-box
window._mfrLogoErr = function(img) {
    const make = img.alt;
    const b = MANUFACTURER_BRANDING[make] || {};
    const color = b.color || '#555';
    const abbr = b.abbr || make.substring(0, 3).toUpperCase();
    img.closest('.mfr-logo-wrap').outerHTML =
        `<div class="flex-shrink-0 flex items-center justify-center w-10 h-10 rounded-lg font-bold text-xs" style="background:#f5f5f5;color:${color};border:2px solid ${color}60;">${abbr}</div>`;
};

// Helper function to generate manufacturer logo HTML (light-theme variant)
function getManufacturerLogo(manufacturer) {
    const branding = MANUFACTURER_BRANDING[manufacturer] || { abbr: manufacturer.substring(0, 3).toUpperCase(), color: '#555' };
    const color = branding.color || '#555';
    const abbr = branding.abbr || manufacturer.substring(0, 3).toUpperCase();
    if (branding.logoUrl) {
        return `<div class="mfr-logo-wrap flex-shrink-0 flex items-center justify-center w-10 h-10 rounded-lg overflow-hidden bg-white" style="border:1px solid #e5e7eb;">
            <img src="${branding.logoUrl}" alt="${manufacturer}" style="width:30px;height:30px;object-fit:contain;" onerror="_mfrLogoErr(this)">
        </div>`;
    }
    return `<div class="flex-shrink-0 flex items-center justify-center w-10 h-10 rounded-lg font-bold text-xs" style="background:#f5f5f5;color:${color};border:2px solid ${color}60;">${abbr}</div>`;
}

// Populate the ticker strip with manufacturer data after load
function populateTicker(manufacturers) {
    const tickerEl = document.getElementById('tickerContent');
    if (!tickerEl || !manufacturers || manufacturers.length === 0) return;

    const items = manufacturers.map(m => {
        const trend = m.trend;
        const arrow = trend > 0.5 ? ' \u25b2' : trend < -0.5 ? ' \u25bc' : ' \u2192';
        const pct = Math.abs(trend).toFixed(1) + '%';
        return `${m.make.toUpperCase()}  ${m.miiScore.toFixed(1)}${arrow}${pct}`;
    });

    // Duplicate content so seamless loop works
    const text = items.join('   \u2502   ');
    const full = text + '   \u2502   ' + text + '   \u2502   ';
    tickerEl.textContent = full;
    tickerEl.classList.add('ticker-animate');
}

// Global data object (will be populated from CSV)
let dashboardData = {
    lastUpdated: new Date().toISOString(),
    quarters: [],
    quarterMIITrends: {},
    quarterData: {},
    manufacturers: []
};

// Load and parse CSV from S3
async function loadCSVData() {
    try {
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
                        // Only reject if there are critical errors and no data
                        if (results.data.length === 0) {
                            reject(new Error('CSV parsing failed: ' + results.errors[0].message));
                            return;
                        }
                    }

                    resolve(results.data);
                },
                error: (error) => {
                    reject(new Error('CSV parsing error: ' + error.message));
                }
            });
        });
    } catch (error) {

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
    // Filter out invalid quarters and rows
    const validData = rawData.filter(row =>
        row.quarter &&
        row.quarter !== 'IAF' &&
        row.manufacturer &&
        row.model &&
        row.mii_score &&
        !isNaN(parseFloat(row.mii_score))
    );

    if (validData.length === 0) {
        throw new Error('No valid data found in CSV. Check data format.');
    }

    // Get unique quarters and sort them
    const quarters = [...new Set(validData.map(row => row.quarter))].sort();
    dashboardData.quarters = quarters;

    // Determine latest period (for MTD marking)
    const latestQuarter = quarters[quarters.length - 1];
    const qtdQuarter = latestQuarter + '-MTD';

    // Update quarters array to mark latest as MTD
    dashboardData.quarters = quarters.slice(0, -1).concat([qtdQuarter]);

    // Group data by quarter
    const dataByQuarter = {};
    quarters.forEach(q => {
        dataByQuarter[q] = validData.filter(row => row.quarter === q);
    });

    // Process each quarter
    dashboardData.quarterData = {};

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
            // auction_count is stored per row by pipeline (sum of raw auctions per make/model/month)
            const auctions = mfrData.reduce((sum, row) => sum + (parseFloat(row.auction_count) || 0), 0);

            // Calculate average MII score for manufacturer
            const avgMII = mfrData.reduce((sum, row) => sum + parseFloat(row.mii_score), 0) / mfrData.length;

            // Calculate average price (sold only)
            const pricedMfrRows = mfrData.filter(row => parseFloat(row.price) > 0);
            const avgPrice = pricedMfrRows.length > 0 ? pricedMfrRows.reduce((sum, row) => sum + parseFloat(row.price), 0) / pricedMfrRows.length : 0;

            // Calculate trend (difference from previous quarter)
            let trend = 0;
            if (qIndex > 0) {
                const prevQuarter = quarters[qIndex - 1];
                const prevQuarterKey = prevQuarter;
                if (dashboardData.quarterData[prevQuarterKey]) {
                    const prevMfr = dashboardData.quarterData[prevQuarterKey].manufacturers.find(m => m.make === mfrName);
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
                if (dashboardData.quarterData[hQuarterKey]) {
                    const hMfr = dashboardData.quarterData[hQuarterKey].manufacturers.find(m => m.make === mfrName);
                    if (hMfr) {
                        history.push(hMfr.miiScore);
                    }
                } else if (i === qIndex) {
                    history.push(avgMII);
                }
            }

            // Get confidence level based on auction count (monthly thresholds)
            let confidence = 'Low';
            if (auctions >= 15) confidence = 'High';
            else if (auctions >= 8) confidence = 'Medium-High';
            else if (auctions >= 4) confidence = 'Medium';

            // sold column is a sum (pipeline aggregates sold counts), not binary
            const soldCount = mfrData.reduce((sum, row) => sum + (parseFloat(row.sold) || 0), 0);
            const sellThrough = auctions > 0 ? Math.round((soldCount / auctions) * 100) : 0;

            // Process models
            const models = mfrData.map(row => ({
                model: row.model,
                auctions: parseFloat(row.auction_count) || 0,
                sold: parseFloat(row.sold) || 0,
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
                        totalSold: 0,
                        rowCount: 0,
                        totalMII: 0,
                        totalPrice: 0,
                        priceCount: 0
                    };
                }
                modelGroups[model.model].auctions += model.auctions;
                modelGroups[model.model].totalSold += model.sold;
                modelGroups[model.model].rowCount++;
                modelGroups[model.model].totalMII += model.mii;
                if (model.avgPrice > 0) {
                    modelGroups[model.model].totalPrice += model.avgPrice;
                    modelGroups[model.model].priceCount++;
                }
            });

            const aggregatedModels = Object.values(modelGroups).map(mg => {
                // Use auction count as divisor when available, fall back to row count
                const divisor = mg.auctions > 0 ? mg.auctions : mg.rowCount;
                const currentMII = mg.totalMII / divisor;
                let modelTrend = 0;

                // Calculate trend by comparing to previous quarter
                if (qIndex > 0) {
                    const prevQuarter = quarters[qIndex - 1];
                    const prevQuarterKey = prevQuarter;

                    if (dashboardData.quarterData[prevQuarterKey]) {
                        const prevMfr = dashboardData.quarterData[prevQuarterKey].manufacturers.find(m => m.make === mfrName);
                        if (prevMfr && prevMfr.models) {
                            const prevModel = prevMfr.models.find(m => m.model === mg.model);
                            if (prevModel && prevModel.mii > 0) {
                                modelTrend = ((currentMII - prevModel.mii) / prevModel.mii) * 100;
                            }
                        }
                    }
                }

                return {
                    model: mg.model,
                    auctions: mg.auctions,
                    mii: currentMII,
                    avgPrice: mg.priceCount > 0 ? mg.totalPrice / mg.priceCount : 0,
                    sellThrough: mg.auctions > 0 ? Math.round((mg.totalSold / mg.auctions) * 100) : 0,
                    trend: parseFloat(modelTrend.toFixed(1)),
                    confidence: mg.auctions >= 5 ? 'High' : mg.auctions >= 3 ? 'Medium' : 'Low'
                };
            });

            return {
                make: mfrName,
                logo: mfrName,
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

        dashboardData.quarterData[quarterKey] = {
            manufacturers: manufacturers.sort((a, b) => b.miiScore - a.miiScore)
        };
    });

    // Process YTD (Year-to-Date) - aggregate all quarters from the most recent year in data
    const latestYear = latestQuarter.substring(0, 4);
    const ytdQuarters = quarters.filter(q => q.startsWith(latestYear));

    if (ytdQuarters.length > 0) {
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
            const auctions = mfrData.reduce((sum, row) => sum + (parseFloat(row.auction_count) || 0), 0);

            const avgMII = mfrData.reduce((sum, row) => sum + parseFloat(row.mii_score), 0) / mfrData.length;
            const pricedYtdRows = mfrData.filter(row => parseFloat(row.price) > 0);
            const avgPrice = pricedYtdRows.length > 0 ? pricedYtdRows.reduce((sum, row) => sum + parseFloat(row.price), 0) / pricedYtdRows.length : 0;

            // For YTD, trend is based on first vs last quarter
            let trend = 0;
            if (ytdQuarters.length > 1) {
                const firstQ = ytdQuarters[0];
                const lastQ = ytdQuarters[ytdQuarters.length - 1];
                const firstQKey = firstQ;
                const lastQKey = lastQ === latestQuarter ? qtdQuarter : lastQ;

                const firstMfr = dashboardData.quarterData[firstQKey]?.manufacturers.find(m => m.make === mfrName);
                const lastMfr = dashboardData.quarterData[lastQKey]?.manufacturers.find(m => m.make === mfrName);

                if (firstMfr && lastMfr) {
                    trend = ((lastMfr.miiScore - firstMfr.miiScore) / firstMfr.miiScore) * 100;
                }
            }

            // Build history from all YTD quarters
            const history = ytdQuarters.map((q, i) => {
                const qKey = i === ytdQuarters.length - 1 && q === latestQuarter ? qtdQuarter : q;
                const mfr = dashboardData.quarterData[qKey]?.manufacturers.find(m => m.make === mfrName);
                return mfr ? mfr.miiScore : null;
            }).filter(v => v !== null);

            // Confidence based on total YTD auctions (monthly data)
            let confidence = 'Low';
            if (auctions >= 50) confidence = 'High';
            else if (auctions >= 20) confidence = 'Medium-High';
            else if (auctions >= 10) confidence = 'Medium';

            // sold column is a sum (pipeline aggregates sold counts), not binary
            const soldCount = mfrData.reduce((sum, row) => sum + (parseFloat(row.sold) || 0), 0);
            const sellThrough = auctions > 0 ? Math.round((soldCount / auctions) * 100) : 0;

            // Process models for YTD
            const models = mfrData.map(row => ({
                model: row.model,
                auctions: parseFloat(row.auction_count) || 0,
                sold: parseFloat(row.sold) || 0,
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
                        totalSold: 0,
                        rowCount: 0,
                        totalMII: 0,
                        totalPrice: 0,
                        priceCount: 0
                    };
                }
                modelGroups[model.model].auctions += model.auctions;
                modelGroups[model.model].totalSold += model.sold;
                modelGroups[model.model].rowCount++;
                modelGroups[model.model].totalMII += model.mii;
                if (model.avgPrice > 0) {
                    modelGroups[model.model].totalPrice += model.avgPrice;
                    modelGroups[model.model].priceCount++;
                }
            });

            const aggregatedModels = Object.values(modelGroups).map(mg => {
                // Use auction count as divisor when available, fall back to row count
                const divisor = mg.auctions > 0 ? mg.auctions : mg.rowCount;
                const currentMII = mg.totalMII / divisor;
                let modelTrend = 0;

                // Calculate YTD trend by comparing to first quarter
                if (ytdQuarters.length > 1) {
                    const firstQ = ytdQuarters[0];
                    const firstQKey = firstQ;

                    if (dashboardData.quarterData[firstQKey]) {
                        const firstMfr = dashboardData.quarterData[firstQKey].manufacturers.find(m => m.make === mfrName);
                        if (firstMfr && firstMfr.models) {
                            const firstModel = firstMfr.models.find(m => m.model === mg.model);
                            if (firstModel && firstModel.mii > 0) {
                                modelTrend = ((currentMII - firstModel.mii) / firstModel.mii) * 100;
                            }
                        }
                    }
                }

                return {
                    model: mg.model,
                    auctions: mg.auctions,
                    mii: currentMII,
                    avgPrice: mg.priceCount > 0 ? mg.totalPrice / mg.priceCount : 0,
                    sellThrough: mg.auctions > 0 ? Math.round((mg.totalSold / mg.auctions) * 100) : 0,
                    trend: parseFloat(modelTrend.toFixed(1)),
                    confidence: mg.auctions >= 10 ? 'High' : mg.auctions >= 5 ? 'Medium' : 'Low'
                };
            });

            return {
                make: mfrName,
                logo: mfrName, // Store manufacturer name for dynamic logo generation
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

        dashboardData.quarterData['YTD'] = {
            manufacturers: ytdManufacturers.sort((a, b) => b.miiScore - a.miiScore)
        };

        // Add YTD to quarters list at the end
        dashboardData.quarters = dashboardData.quarters.concat(['YTD']);
    }

    // Set manufacturers to YTD data by default
    if (dashboardData.quarterData['YTD']) {
        dashboardData.manufacturers = dashboardData.quarterData['YTD'].manufacturers;
    } else {
        // Fallback to latest quarter if no YTD data
        const latestQuarterKey = quarters.length > 0 ?
            (dashboardData.quarters[dashboardData.quarters.length - 1]) : null;
        if (latestQuarterKey && dashboardData.quarterData[latestQuarterKey]) {
            dashboardData.manufacturers = dashboardData.quarterData[latestQuarterKey].manufacturers;
        }
    }

    // Build real market MII trend — actual average MII per period across all manufacturers
    dashboardData.quarterMIITrends = {};
    const allPeriodKeys = dashboardData.quarters.filter(q => q !== 'YTD');
    const trendLabels = allPeriodKeys.map(q => formatQuarterDisplay(q));
    const trendValues = allPeriodKeys.map(q => {
        const periodData = dashboardData.quarterData[q];
        if (!periodData || !periodData.manufacturers.length) return null;
        const mfrs = periodData.manufacturers;
        return parseFloat((mfrs.reduce((sum, m) => sum + m.miiScore, 0) / mfrs.length).toFixed(1));
    });

    // Store a single market-wide trend object used by the main trend chart
    dashboardData.quarterMIITrends['__market__'] = {
        labels: trendLabels,
        data: trendValues
    };

    // Also store per-period entry (for compatibility) pointing at real market data
    allPeriodKeys.forEach(q => {
        dashboardData.quarterMIITrends[q] = dashboardData.quarterMIITrends['__market__'];
    });

    return dashboardData;
}

// Initialize app with CSV data
async function initializeApp() {
    const loadingIndicator = document.getElementById('loadingIndicator');

    try {
        loadingIndicator.style.display = 'flex';

        // Load MII results and bat.csv auction counts in parallel
        const [rawData, batCounts] = await Promise.all([loadCSVData(), loadBatAuctionCounts()]);
        injectAuctionCounts(rawData, batCounts);
        processCSVData(rawData);

        // Update last updated time
        dashboardData.lastUpdated = new Date().toISOString();

        // Set default selected quarter to latest
        if (dashboardData.quarters.length > 0) {
            state.selectedQuarter = dashboardData.quarters[dashboardData.quarters.length - 1];
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
                <div class="text-xl font-semibold text-[#8B1A1A] mb-2">Failed to Load Data</div>
                <div class="text-sm text-gray-500 mt-2 mb-4">${error.message}</div>
                <button
                    onclick="location.reload()"
                    class="px-4 py-2 bg-[#8B1A1A] hover:bg-[#6B1414] text-white rounded-lg transition-colors mb-6">
                    Retry
                </button>
                <details class="text-left bg-gray-50 border border-gray-200 p-4 rounded-lg">
                    <summary class="cursor-pointer text-sm text-gray-600 mb-2">Troubleshooting Steps</summary>
                    <ol class="text-xs text-gray-500 space-y-1 list-decimal list-inside">
                        ${troubleshootingSteps.map(step => `<li>${step}</li>`).join('')}
                    </ol>
                    <div class="mt-3 text-xs text-gray-400">
                        <strong>S3 URL:</strong> <span class="text-gray-500">${CSV_URL}</span>
                    </div>
                </details>
            </div>
        `;
    }
}

// Manufacturers populated from CSV data on load
dashboardData.manufacturers = [];

// State management
let state = {
    selectedMake: null,
    minAuctions: 10,
    sortBy: 'miiScore',
    sortOrder: 'desc',
    searchTerm: '',
    modelSearchTerm: '',
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
    if (quarterStr === 'YTD') return 'YTD';
    const isMTD = quarterStr.endsWith('-MTD');
    const base = isMTD ? quarterStr.replace('-MTD', '') : quarterStr;
    // Format "2025-05" → "May 2025"
    const monthMatch = base.match(/^(\d{4})-(\d{2})$/);
    if (monthMatch) {
        const date = new Date(parseInt(monthMatch[1]), parseInt(monthMatch[2]) - 1, 1);
        const label = date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
        return isMTD ? `${label} (MTD)` : label;
    }
    // Fallback for legacy quarterly format
    return isMTD ? `${base} (MTD)` : base;
}

function getConfidenceBadge(level) {
    const styles = {
        High: { bg: 'bg-green-100', text: 'text-green-700', icon: '●' },
        'Medium-High': { bg: 'bg-teal-100', text: 'text-teal-700', icon: '◐' },
        Medium: { bg: 'bg-amber-100', text: 'text-amber-700', icon: '◐' },
        Low: { bg: 'bg-red-100', text: 'text-red-600', icon: '○' }
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
        return `<span class="${textSize} text-gray-400 font-medium">→ ${Math.abs(value).toFixed(1)}%</span>`;
    }

    const color = isPositive ? 'text-green-600' : 'text-red-600';
    const arrow = isPositive ? '▲' : '▼';
    return `<span class="${textSize} font-semibold ${color}">${arrow} ${Math.abs(value).toFixed(1)}%</span>`;
}

function createSparkline(data, color = '#8B1A1A') {
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
    const manufacturers = (dashboardData.quarterData[quarterKey]?.manufacturers) || dashboardData.manufacturers || [];

    return manufacturers
        .filter(m => m.auctions >= state.minAuctions)
        .filter(m => m.make.toLowerCase().includes(state.searchTerm.toLowerCase()))
        .sort((a, b) => {
            const multiplier = state.sortOrder === 'desc' ? -1 : 1;
            return (a[state.sortBy] - b[state.sortBy]) * multiplier;
        });
}

function getTopModels(minAuctions = 0, limit = 20) {
    const allModels = [];

    // Get manufacturers for the selected quarter
    const quarterKey = state.selectedQuarter;
    const manufacturers = (dashboardData.quarterData[quarterKey]?.manufacturers) || dashboardData.manufacturers || [];

    // No minimum auctions - show all models including single auctions
    const effectiveMinAuctions = minAuctions;

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

    return allModels
        .sort((a, b) => b.mii - a.mii)
        .slice(0, limit);
}

function searchAllModels(searchTerm, limit = 50) {
    const allModels = [];

    // Get manufacturers for the selected quarter
    const quarterKey = state.selectedQuarter;
    const manufacturers = (dashboardData.quarterData[quarterKey]?.manufacturers) || dashboardData.manufacturers || [];

    manufacturers.forEach(mfr => {
        if (!mfr.models || mfr.models.length === 0) return;

        mfr.models.forEach(model => {
            // Search by model name (case insensitive)
            if (model.model.toLowerCase().includes(searchTerm.toLowerCase())) {
                allModels.push({
                    ...model,
                    make: mfr.make,
                    makeLogo: mfr.logo
                });
            }
        });
    });

    return allModels
        .sort((a, b) => b.mii - a.mii)
        .slice(0, limit);
}

function calculateMarketStats() {
    // Get manufacturers for the selected quarter
    const quarterKey = state.selectedQuarter;
    const manufacturers = (dashboardData.quarterData[quarterKey]?.manufacturers) || dashboardData.manufacturers || [];
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
    const manufacturers = (dashboardData.quarterData[quarterKey]?.manufacturers) || dashboardData.manufacturers || [];

    document.getElementById('qualifyingMakes').textContent = stats.totalManufacturers;
    document.getElementById('totalMakes').textContent = `of ${manufacturers.length} total`;
    document.getElementById('totalAuctions').textContent = stats.totalAuctions.toLocaleString();
    document.getElementById('marketMII').textContent = stats.avgMII.toFixed(1);
    document.getElementById('avgPrice').textContent = `$${(stats.avgPrice / 1000).toFixed(0)}K`;
}

function renderTopModels() {
    const container = document.getElementById('topModelsContainer');
    const subtitle = document.getElementById('topModelsSubtitle');
    const isYTD = state.selectedQuarter === 'YTD';

    // Use search results if searching, otherwise show top models
    let topModels;
    let isSearching = state.modelSearchTerm && state.modelSearchTerm.length > 0;

    if (isSearching) {
        topModels = searchAllModels(state.modelSearchTerm, 50);
        if (subtitle) {
            subtitle.textContent = `Search results for "${state.modelSearchTerm}" (${topModels.length} found)`;
        }
    } else {
        topModels = getTopModels(0, 20);
        // Update subtitle based on selected quarter
        if (subtitle) {
            subtitle.textContent = isYTD
                ? 'Top 20 models across all manufacturers for the year'
                : 'Top 20 models with highest market interest this month';
        }
    }

    if (topModels.length === 0) {
        if (isSearching) {
            container.innerHTML = `<div class="col-span-full text-center text-zinc-500 py-8">No models found matching "${state.modelSearchTerm}"</div>`;
        } else {
            container.innerHTML = `<div class="col-span-full text-center text-zinc-500 py-8">No models found in this ${isYTD ? 'period' : 'quarter'}</div>`;
        }
        return;
    }

    container.innerHTML = topModels.map((model, idx) => {
        const auctionText = model.auctions === 1 ? '1 auction' : `${model.auctions} auctions`;
        return `
            <div class="bg-white border border-gray-200 rounded-lg p-4 hover:shadow-md hover:border-gray-300 transition-all">
                <div class="flex items-start justify-between mb-2">
                    <div class="flex items-center gap-2">
                        ${getManufacturerLogo(model.make)}
                        <div>
                            <div class="font-semibold text-sm text-gray-900">${model.model}</div>
                            <div class="text-xs text-gray-500">${model.make}</div>
                        </div>
                    </div>
                    <div class="text-right">
                        <div class="text-xl font-bold text-[#8B1A1A]">${model.mii.toFixed(1)}</div>
                        <div class="text-xs text-gray-400">#${idx + 1}</div>
                    </div>
                </div>
                <div class="flex items-center justify-between text-xs">
                    <div class="text-gray-500">
                        ${auctionText} • $${(model.avgPrice / 1000).toFixed(0)}K avg • ${model.sellThrough}% sold
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
        const sparklineColor = mfr.trend > 0 ? '#16a34a' : mfr.trend < 0 ? '#dc2626' : '#9ca3af';
        const isSelected = state.selectedMake === mfr.make;
        const isComparing = state.compareList.includes(mfr.make);
        const isFirst = idx === 0;
        const borderColor = isFirst ? 'border-l-4 border-[#C5A028]' : 'border-l-4 border-[#8B1A1A]';
        const selectedBg = isSelected ? 'bg-red-50' : 'bg-white hover:bg-gray-50';

        // Rank badge style
        let rankBadge;
        if (idx === 0) {
            rankBadge = `<div class="w-7 h-7 rounded-full bg-[#C5A028] flex items-center justify-center font-bold text-white text-xs">1</div>`;
        } else if (idx === 1) {
            rankBadge = `<div class="w-7 h-7 rounded-full bg-gray-400 flex items-center justify-center font-bold text-white text-xs">2</div>`;
        } else if (idx === 2) {
            rankBadge = `<div class="w-7 h-7 rounded-full bg-amber-700 flex items-center justify-center font-bold text-white text-xs">3</div>`;
        } else {
            rankBadge = `<div class="w-7 h-7 text-center font-semibold text-gray-400 text-sm flex items-center justify-center">${idx + 1}</div>`;
        }

        return `
            <div class="px-5 py-4 cursor-pointer transition-all ${selectedBg} ${borderColor}"
                 data-make="${mfr.make}">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-4">
                        ${rankBadge}
                        ${getManufacturerLogo(mfr.make)}
                        <div>
                            <div class="font-semibold text-gray-900">${mfr.make}</div>
                            <div class="text-xs text-gray-500">
                                ${mfr.auctions} auctions • $${(mfr.avgPrice / 1000).toFixed(0)}K avg • ${mfr.sellThrough}% sold
                            </div>
                        </div>
                    </div>

                    <div class="flex items-center gap-6">
                        <div class="hidden md:block">
                            ${createSparkline(mfr.history, sparklineColor)}
                        </div>
                        <div class="text-right">
                            <div class="text-2xl font-bold text-[#8B1A1A]">${mfr.miiScore.toFixed(1)}</div>
                            ${getTrendIndicator(mfr.trend)}
                        </div>
                        ${getConfidenceBadge(mfr.confidence)}
                        <button class="compare-btn w-8 h-8 rounded-lg flex items-center justify-center transition-all ${isComparing ? 'bg-[#8B1A1A] text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}"
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
    const quarterKey = state.selectedQuarter;
    const periodManufacturers = (dashboardData.quarterData[quarterKey]?.manufacturers) || dashboardData.manufacturers || [];
    const mfr = periodManufacturers.find(m => m.make === state.selectedMake);

    if (!mfr) {
        container.innerHTML = `
            <div class="bg-white border border-gray-200 rounded-xl p-8 text-center shadow-sm">
                <div class="text-4xl mb-4">👈</div>
                <h3 class="font-semibold text-gray-700">Select a Manufacturer</h3>
                <p class="text-sm text-gray-400 mt-2">
                    Click on any manufacturer in the leaderboard to view detailed model breakdowns and trends
                </p>
            </div>
        `;
        return;
    }

    container.innerHTML = `
        <!-- Manufacturer Header -->
        <div class="bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
            <div class="flex items-center gap-4 mb-4">
                ${getManufacturerLogo(mfr.make)}
                <div>
                    <h3 class="text-xl font-bold text-gray-900">${mfr.make}</h3>
                    <div class="text-sm text-gray-500">
                        ${mfr.auctions} auctions this month
                    </div>
                </div>
            </div>

            <div class="grid grid-cols-2 gap-4">
                <div class="bg-gray-50 border border-gray-100 rounded-lg p-3">
                    <div class="text-xs text-gray-500 uppercase tracking-wider">MII Score</div>
                    <div class="text-2xl font-bold text-[#8B1A1A]">
                        ${mfr.miiScore.toFixed(1)}
                    </div>
                    ${getTrendIndicator(mfr.trend)}
                </div>
                <div class="bg-gray-50 border border-gray-100 rounded-lg p-3">
                    <div class="text-xs text-gray-500 uppercase tracking-wider">Sell-Through</div>
                    <div class="text-2xl font-bold text-green-700">
                        ${mfr.sellThrough}%
                    </div>
                    <div class="text-xs text-gray-400">of auctions sold</div>
                </div>
            </div>
        </div>

        <!-- MII Trend Chart -->
        <div class="bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
            <h4 class="font-semibold mb-4 text-gray-800">MII Trend</h4>
            <canvas id="trendChart" style="max-height: 160px;"></canvas>
        </div>

        <!-- Model Rankings -->
        <div class="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm">
            <div class="border-b border-gray-100 px-5 py-4">
                <h4 class="font-semibold text-gray-800">Model Rankings</h4>
                <p class="text-xs text-gray-400 mt-1">
                    ${mfr.models.length} models tracked
                </p>
            </div>
            <div class="divide-y divide-gray-100 max-h-96 overflow-y-auto scrollbar-thin">
                ${mfr.models
                    .sort((a, b) => b.mii - a.mii)
                    .map((model, idx) => `
                        <div class="px-5 py-3 hover:bg-gray-50 transition-colors">
                            <div class="flex items-center justify-between">
                                <div class="flex items-center gap-3">
                                    <span class="w-6 text-center text-sm font-medium text-gray-400">
                                        ${idx + 1}
                                    </span>
                                    <div>
                                        <div class="font-medium text-sm text-gray-900">${model.model}</div>
                                        <div class="text-xs text-gray-500">
                                            ${model.auctions} auctions • $${(model.avgPrice / 1000).toFixed(0)}K avg • ${model.sellThrough}% sold
                                        </div>
                                    </div>
                                </div>
                                <div class="text-right">
                                    <div class="font-bold text-[#8B1A1A]">${model.mii.toFixed(1)}</div>
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
            labels: dashboardData.quarters,
            datasets: [{
                label: 'MII Score',
                data: mfr.history,
                borderColor: '#8B1A1A',
                backgroundColor: 'rgba(139, 26, 26, 0.08)',
                fill: true,
                tension: 0.4,
                pointRadius: 4,
                pointBackgroundColor: '#8B1A1A'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#ffffff',
                    titleColor: '#111827',
                    bodyColor: '#374151',
                    borderColor: '#e5e7eb',
                    borderWidth: 1,
                    padding: 12,
                    displayColors: false
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(0,0,0,0.06)', drawBorder: false },
                    ticks: { color: '#9ca3af', font: { size: 11 } }
                },
                y: {
                    grid: { color: 'rgba(0,0,0,0.06)', drawBorder: false },
                    ticks: { color: '#9ca3af', font: { size: 11 } }
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
        const mfr = dashboardData.manufacturers.find(m => m.make === make);
        return `
            <span class="inline-flex items-center gap-2 bg-gray-100 border border-gray-200 rounded-full px-3 py-1 text-sm">
                ${getManufacturerLogo(make)}
                <span class="ml-1 text-gray-800">${make}</span>
                <button class="remove-compare text-gray-400 hover:text-gray-600" data-make="${make}">
                    &times;
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
        const mfr = dashboardData.manufacturers.find(m => m.make === make);
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
            labels: dashboardData.quarters,
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#ffffff',
                    titleColor: '#111827',
                    bodyColor: '#374151',
                    borderColor: '#e5e7eb',
                    borderWidth: 1,
                    padding: 8,
                    titleFont: { size: 11 },
                    bodyFont: { size: 11 }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(0,0,0,0.06)', drawBorder: false },
                    ticks: { color: '#9ca3af', font: { size: 10 } }
                },
                y: {
                    grid: { color: 'rgba(0,0,0,0.06)', drawBorder: false },
                    ticks: { color: '#9ca3af', font: { size: 10 } }
                }
            }
        }
    });
}

function renderQuarterMIIChart() {
    const container = document.getElementById('quarterProgressContainer');
    if (!container) return;

    const trendData = dashboardData.quarterMIITrends['__market__'];
    if (!trendData || !trendData.data.some(v => v !== null)) {
        container.classList.add('hidden');
        return;
    }

    const isMTD = state.selectedQuarter.endsWith('-MTD');
    const validData = trendData.data.filter(v => v !== null);
    const currentValue = validData[validData.length - 1];
    const startValue = validData[0];
    const change = currentValue - startValue;
    const changePercent = startValue > 0 ? ((change / startValue) * 100).toFixed(1) : '0.0';
    const changeColor = change >= 0 ? '#10b981' : '#f43f5e';
    const changeSign = change >= 0 ? '+' : '';

    const changeColorLight = change >= 0 ? '#16a34a' : '#dc2626';
    container.classList.remove('hidden');
    container.innerHTML = `
        <div class="bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
            <div class="flex items-center justify-between mb-4">
                <div class="flex items-center gap-2">
                    <h3 class="font-semibold text-gray-900">Market Interest Index — Month over Month</h3>
                    ${isMTD ? '<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-700 border border-amber-200"><span class="inline-block w-1.5 h-1.5 bg-amber-500 rounded-full animate-pulse"></span>Live</span>' : ''}
                </div>
                <div class="text-xs font-semibold" style="color:${changeColorLight}">${changeSign}${changePercent}% overall</div>
            </div>
            <div style="height: 200px;">
                <canvas id="quarterMIIChart"></canvas>
            </div>
        </div>
    `;

    setTimeout(() => {
        const canvas = document.getElementById('quarterMIIChart');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (charts.quarterMII) charts.quarterMII.destroy();

        // Highlight the currently selected period
        const selectedLabel = formatQuarterDisplay(state.selectedQuarter);
        const pointColors = trendData.labels.map(l =>
            l === selectedLabel ? '#ffffff' : '#f59e0b'
        );
        const pointRadii = trendData.labels.map(l =>
            l === selectedLabel ? 6 : 3
        );

        // Remap selected point colors for light theme
        const pointColorsLight = trendData.labels.map(l =>
            l === selectedLabel ? '#8B1A1A' : '#C5A028'
        );

        charts.quarterMII = new Chart(ctx, {
            type: 'line',
            data: {
                labels: trendData.labels,
                datasets: [{
                    label: 'Market Avg MII',
                    data: trendData.data,
                    borderColor: '#8B1A1A',
                    backgroundColor: 'rgba(139, 26, 26, 0.08)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: pointRadii,
                    pointBackgroundColor: pointColorsLight,
                    pointBorderColor: '#ffffff',
                    pointBorderWidth: 2,
                    pointHoverRadius: 6,
                    spanGaps: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: '#ffffff',
                        titleColor: '#111827',
                        bodyColor: '#374151',
                        borderColor: '#e5e7eb',
                        borderWidth: 1,
                        padding: 12,
                        displayColors: false,
                        callbacks: {
                            label: ctx => 'Avg MII: ' + (ctx.parsed.y !== null ? ctx.parsed.y.toFixed(1) : '—')
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { color: 'rgba(0,0,0,0.06)', drawBorder: false },
                        ticks: { color: '#9ca3af', font: { size: 10 }, maxRotation: 45 }
                    },
                    y: {
                        grid: { color: 'rgba(0,0,0,0.06)', drawBorder: false },
                        ticks: {
                            color: '#9ca3af',
                            font: { size: 11 },
                            callback: v => v.toFixed(1)
                        },
                        min: Math.min(...validData) - 2,
                        max: Math.max(...validData) + 2
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
    const date = new Date(dashboardData.lastUpdated);
    document.getElementById('lastUpdated').textContent = date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

    // Populate quarter select
    const quarterSelect = document.getElementById('quarterSelect');
    quarterSelect.innerHTML = dashboardData.quarters.map(q =>
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
                b.classList.remove('bg-[#8B1A1A]', 'text-white');
                b.classList.add('text-gray-500');
            });
            btn.classList.add('bg-[#8B1A1A]', 'text-white');
            btn.classList.remove('text-gray-500');
            state.viewMode = btn.dataset.mode;
        });
    });

    document.getElementById('clearCompare').addEventListener('click', () => {
        state.compareList = [];
        renderLeaderboard();
        renderComparePanel();
    });

    // Model search functionality
    const modelSearchInput = document.getElementById('modelSearch');
    const modelSearchClear = document.getElementById('modelSearchClear');

    modelSearchInput.addEventListener('input', (e) => {
        state.modelSearchTerm = e.target.value;

        // Show/hide clear button
        if (state.modelSearchTerm.length > 0) {
            modelSearchClear.classList.remove('hidden');
        } else {
            modelSearchClear.classList.add('hidden');
        }

        renderTopModels();
    });

    modelSearchClear.addEventListener('click', () => {
        state.modelSearchTerm = '';
        modelSearchInput.value = '';
        modelSearchClear.classList.add('hidden');
        renderTopModels();
    });

    // Initial render
    renderQuarterMIIChart();
    renderMarketStats();
    renderTopModels();
    renderLeaderboard();
    renderManufacturerDetail();
    renderComparePanel();

    // Populate ticker with manufacturer data
    const tickerMfrs = dashboardData.manufacturers || [];
    populateTicker(tickerMfrs);
}

// Start the app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}
