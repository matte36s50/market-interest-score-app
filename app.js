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
    // Replace the upstream min-max normalization with percentile ranks and
    // recompute mii_score before anything reads it (see mii-normalize.js).
    if (window.MII) MII.recompute(rawData);

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
            let trendPoints = 0;
            if (qIndex > 0) {
                const prevQuarter = quarters[qIndex - 1];
                const prevQuarterKey = prevQuarter;
                if (dashboardData.quarterData[prevQuarterKey]) {
                    const prevMfr = dashboardData.quarterData[prevQuarterKey].manufacturers.find(m => m.make === mfrName);
                    if (prevMfr) {
                        trend = ((avgMII - prevMfr.miiScore) / prevMfr.miiScore) * 100;
                        trendPoints = avgMII - prevMfr.miiScore;
                    }
                }
            }

            // Build history array (last 3 quarters)
            const history = [];
            const historyLabels = [];
            for (let i = Math.max(0, qIndex - 2); i <= qIndex; i++) {
                const hQuarter = quarters[i];
                const hQuarterKey = i === quarters.length - 1 ? qtdQuarter : hQuarter;
                if (dashboardData.quarterData[hQuarterKey]) {
                    const hMfr = dashboardData.quarterData[hQuarterKey].manufacturers.find(m => m.make === mfrName);
                    if (hMfr) {
                        history.push(hMfr.miiScore);
                        historyLabels.push(formatQuarterDisplay(hQuarterKey));
                    }
                } else if (i === qIndex) {
                    history.push(avgMII);
                    historyLabels.push(formatQuarterDisplay(hQuarterKey));
                }
            }

            // Confidence from auction count, monthly grain (mii-normalize.js owns
            // the thresholds so model rows below use the identical scale).
            const confidence = window.MII
                ? MII.confidenceFor(auctions, 'monthly')
                : (auctions >= 15 ? 'High' : auctions >= 8 ? 'Medium-High' : auctions >= 4 ? 'Medium' : 'Low');

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
                        // How many monthly rows this model contributed. The MII
                        // average has to divide by this, not by the auction
                        // count — see the aggregation below.
                        months: 0,
                        totalSold: 0,
                        totalMII: 0,
                        totalPrice: 0,
                        priceCount: 0
                    };
                }
                modelGroups[model.model].months += 1;
                modelGroups[model.model].auctions += model.auctions;
                modelGroups[model.model].totalSold += model.sold;
                modelGroups[model.model].totalMII += model.mii;
                if (model.avgPrice > 0) {
                    modelGroups[model.model].totalPrice += model.avgPrice;
                    modelGroups[model.model].priceCount++;
                }
            });

            const aggregatedModels = Object.values(modelGroups).map(mg => {
                // mii_score is already a per-model-month figure, so averaging
                // it means dividing by the number of months. Dividing by the
                // auction count instead scaled every liquid model toward zero:
                // a model with two months and seven sales had its average cut
                // to two sevenths, while a one-sale model was left untouched.
                const currentMII = mg.months > 0 ? mg.totalMII / mg.months : 0;
                let modelTrend = 0;
                let modelTrendPoints = 0;

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
                                modelTrendPoints = currentMII - prevModel.mii;
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
                    // raw MII-point change, so the UI can test it against the noise floor
                    trendPoints: parseFloat(modelTrendPoints.toFixed(2)),
                    // Same scale as the manufacturer row above — a model row must not
                    // claim High on a sample the manufacturer scale calls Low.
                    confidence: window.MII ? MII.confidenceFor(mg.auctions, 'monthly')
                        : (mg.auctions >= 15 ? 'High' : mg.auctions >= 8 ? 'Medium-High' : mg.auctions >= 4 ? 'Medium' : 'Low')
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
                trendPoints: parseFloat(trendPoints.toFixed(2)),
                sellThrough: sellThrough,
                history: history,
                historyLabels: historyLabels,
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
            let trendPoints = 0;
            if (ytdQuarters.length > 1) {
                const firstQ = ytdQuarters[0];
                const lastQ = ytdQuarters[ytdQuarters.length - 1];
                const firstQKey = firstQ;
                const lastQKey = lastQ === latestQuarter ? qtdQuarter : lastQ;

                const firstMfr = dashboardData.quarterData[firstQKey]?.manufacturers.find(m => m.make === mfrName);
                const lastMfr = dashboardData.quarterData[lastQKey]?.manufacturers.find(m => m.make === mfrName);

                if (firstMfr && lastMfr) {
                    trend = ((lastMfr.miiScore - firstMfr.miiScore) / firstMfr.miiScore) * 100;
                    trendPoints = lastMfr.miiScore - firstMfr.miiScore;
                }
            }

            // Build history from all YTD quarters
            const ytdHistoryData = ytdQuarters.map((q, i) => {
                const qKey = i === ytdQuarters.length - 1 && q === latestQuarter ? qtdQuarter : q;
                const mfr = dashboardData.quarterData[qKey]?.manufacturers.find(m => m.make === mfrName);
                return mfr ? { score: mfr.miiScore, label: formatQuarterDisplay(qKey) } : null;
            }).filter(v => v !== null);
            const history = ytdHistoryData.map(d => d.score);
            const historyLabels = ytdHistoryData.map(d => d.label);

            // Confidence based on total YTD auctions (monthly data)
            const confidence = window.MII
                ? MII.confidenceFor(auctions, 'quarterly')
                : (auctions >= 50 ? 'High' : auctions >= 20 ? 'Medium-High' : auctions >= 10 ? 'Medium' : 'Low');

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
                        // How many monthly rows this model contributed. The MII
                        // average has to divide by this, not by the auction
                        // count — see the aggregation below.
                        months: 0,
                        totalSold: 0,
                        totalMII: 0,
                        totalPrice: 0,
                        priceCount: 0
                    };
                }
                modelGroups[model.model].months += 1;
                modelGroups[model.model].auctions += model.auctions;
                modelGroups[model.model].totalSold += model.sold;
                modelGroups[model.model].totalMII += model.mii;
                if (model.avgPrice > 0) {
                    modelGroups[model.model].totalPrice += model.avgPrice;
                    modelGroups[model.model].priceCount++;
                }
            });

            const aggregatedModels = Object.values(modelGroups).map(mg => {
                // mii_score is already a per-model-month figure, so averaging
                // it means dividing by the number of months. Dividing by the
                // auction count instead scaled every liquid model toward zero:
                // a model with two months and seven sales had its average cut
                // to two sevenths, while a one-sale model was left untouched.
                const currentMII = mg.months > 0 ? mg.totalMII / mg.months : 0;
                let modelTrend = 0;
                let modelTrendPoints = 0;

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
                                modelTrendPoints = currentMII - firstModel.mii;
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
                    // raw MII-point change, so the UI can test it against the noise floor
                    trendPoints: parseFloat(modelTrendPoints.toFixed(2)),
                    confidence: window.MII ? MII.confidenceFor(mg.auctions, 'quarterly')
                        : (mg.auctions >= 50 ? 'High' : mg.auctions >= 20 ? 'Medium-High' : mg.auctions >= 10 ? 'Medium' : 'Low')
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
                trendPoints: parseFloat(trendPoints.toFixed(2)),
                sellThrough: sellThrough,
                history: history,
                historyLabels: historyLabels,
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

        // Load MII results, bat.csv auction counts, and social signals in parallel
        const [rawData, batCounts] = await Promise.all([
            loadCSVData(), loadBatAuctionCounts(), window.MII ? MII.ready : null,
        ]);
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
            <div class="max-w-xl mx-auto panel p-8 text-left">
                <h2 class="m-0 text-lg font-semibold text-down">Could not load the MII data</h2>
                <p class="m-0 mt-2 text-sm text-mute">${esc(error.message)}</p>
                <button onclick="location.reload()" class="btn mt-5">Try again</button>
                <details class="mt-6 text-sm">
                    <summary class="cursor-pointer text-mute">Troubleshooting steps</summary>
                    <ol class="mt-2 pl-5 list-decimal text-[13px] text-mute space-y-1">
                        ${troubleshootingSteps.map(step => `<li>${step}</li>`).join('')}
                    </ol>
                    <p class="mt-3 text-xs text-faint break-all">S3 URL: ${CSV_URL}</p>
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
    showAllMakes: false,
    selectedQuarter: 'YTD'
};

// Leaderboard rows shown before "Show all".
const LEADERBOARD_ROWS = 20;
// A model needs this many auctions in the period to make the Top models list;
// below it, single lucky sales crowd out everything else. Search ignores it.
const TOP_MODELS_MIN_AUCTIONS = 3;

let charts = {
    trend: null,
    compare: null,
    quarterMII: null,
    lots: null
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

// Escape text from the CSVs before it goes into innerHTML.
function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// "$171K" under a million, "$1.66M" above.
function formatPrice(amount) {
    if (amount == null || !isFinite(amount) || amount <= 0) return '—';
    if (amount >= 1e6) return `$${(amount / 1e6).toFixed(2)}M`;
    return `$${(amount / 1000).toFixed(0)}K`;
}

// Three-step signal meter plus the level's name; filled steps are the only
// colour, so it reads the same for colour-blind viewers.
function getConfidenceBadge(level, opts = {}) {
    const filled = { High: 3, 'Medium-High': 2, Medium: 1, Low: 0 }[level] ?? 1;
    const bars = [0, 1, 2].map(i =>
        `<span class="block w-1 rounded-[1px]" style="height:${6 + i * 3}px;background:${i < filled ? '#16181D' : '#D9D9D3'}"></span>`
    ).join('');
    return `<span class="inline-flex items-center gap-2" title="${esc(level)} confidence">
        <span class="inline-flex items-end gap-0.5 h-3" aria-hidden="true">${bars}</span>
        <span class="${opts.compact ? 'sr-only' : 'text-[13px] text-mute'}">${esc(level)}</span>
    </span>`;
}

// `points` is the raw MII change behind the percentage, and `auctions` the
// sample it rests on. With `points` the change is shown in MII points (a thin
// prior month turns small point moves into huge percentages), with the
// percentage in the tooltip. A move smaller than the measured noise floor for
// that sample size is drawn greyed with a dotted underline rather than as a
// confident move: at one auction a month the median swing is 10.5 MII points,
// so most small movements are which cars happened to cross the block, not the
// market moving. Called without them, the percentage is shown.
function getTrendIndicator(value, size = 'normal', opts = {}) {
    const textSize = size === 'large' ? 'text-base' : 'text-[13px]';
    const hasPoints = opts.points != null && isFinite(opts.points);
    const shown = hasPoints ? opts.points : value;
    if (shown == null || !isFinite(shown)) {
        return `<span class="font-mono ${textSize} text-faint">—</span>`;
    }

    const sign = shown > 0 ? '+' : shown < 0 ? '−' : '';
    const label = `${sign}${Math.abs(shown).toFixed(1)}${hasPoints ? '' : '%'}`;
    const pctNote = hasPoints && value != null && isFinite(value) ? ` (${value > 0 ? '+' : ''}${value.toFixed(1)}%)` : '';
    const isNeutral = hasPoints ? Math.abs(shown) < 0.05 : Math.abs(value) < 0.5;
    if (isNeutral) {
        return `<span class="font-mono ${textSize} text-faint">${label}</span>`;
    }

    if (window.MII && hasPoints && opts.auctions != null
        && MII.moveStrength(opts.points, opts.auctions) === 'noise') {
        const floor = MII.noiseFloor(opts.auctions);
        return `<span class="font-mono ${textSize} text-faint decoration-dotted underline underline-offset-2"
                      title="${Math.abs(opts.points).toFixed(1)} MII points${pctNote} on ${opts.auctions} auction(s), under the ${floor.median} point median swing at this sample size, so it is within normal sampling noise">${label}</span>`;
    }

    const color = shown > 0 ? 'text-up' : 'text-down';
    const title = hasPoints ? `MII points vs the previous period${pctNote}` : 'vs the previous period';
    return `<span class="font-mono ${textSize} ${color}" title="${title}">${label}</span>`;
}

function createSparkline(data) {
    const values = (data || []).filter(v => v != null && isFinite(v));
    if (values.length < 2) return '<span class="text-faint">—</span>';

    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const width = 72;
    const height = 20;
    const pad = 2.5;

    const coords = values.map((val, i) => ({
        x: pad + (i / (values.length - 1)) * (width - pad * 2),
        y: pad + (1 - (val - min) / range) * (height - pad * 2)
    }));
    const last = coords[coords.length - 1];

    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="block" aria-hidden="true">
        <polyline points="${coords.map(c => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')}"
            fill="none" stroke="#B9BAB4" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="2.5" fill="#F59E0B" />
    </svg>`;
}

function getFilteredManufacturers() {
    // Get manufacturers for the selected quarter
    const quarterKey = state.selectedQuarter;
    const manufacturers = (dashboardData.quarterData[quarterKey]?.manufacturers) || dashboardData.manufacturers || [];
    const direction = state.sortOrder === 'desc' ? -1 : 1;

    return manufacturers
        .filter(m => m.auctions >= state.minAuctions)
        .filter(m => m.make.toLowerCase().includes(state.searchTerm.toLowerCase()))
        .sort((a, b) => {
            const av = a[state.sortBy];
            const bv = b[state.sortBy];
            if (typeof av === 'string' || typeof bv === 'string') {
                return String(av ?? '').localeCompare(String(bv ?? '')) * direction;
            }
            // Missing values (no prior period to compare) sort last either way.
            const aMissing = av == null || !isFinite(av);
            const bMissing = bv == null || !isFinite(bv);
            if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
            return (av - bv) * direction;
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

function calculateMarketStats(periodKey = state.selectedQuarter) {
    const manufacturers = (dashboardData.quarterData[periodKey]?.manufacturers) || dashboardData.manufacturers || [];
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

// "August 2026", "September 2026, to date", "Year to date".
function formatPeriodLong(periodKey) {
    if (periodKey === 'YTD') return 'Year to date';
    const isMTD = periodKey.endsWith('-MTD');
    const base = isMTD ? periodKey.replace('-MTD', '') : periodKey;
    const monthMatch = base.match(/^(\d{4})-(\d{2})$/);
    if (!monthMatch) return formatQuarterDisplay(periodKey);
    const date = new Date(parseInt(monthMatch[1]), parseInt(monthMatch[2]) - 1, 1);
    const label = date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    return isMTD ? `${label}, to date` : label;
}

// The month before `periodKey`, or null for the first month and for YTD.
function previousPeriodKey(periodKey) {
    const months = dashboardData.quarters.filter(q => q !== 'YTD');
    const idx = months.indexOf(periodKey);
    return idx > 0 ? months[idx - 1] : null;
}

function renderMarketStats() {
    const stats = calculateMarketStats();
    const quarterKey = state.selectedQuarter;
    const manufacturers = (dashboardData.quarterData[quarterKey]?.manufacturers) || dashboardData.manufacturers || [];

    document.getElementById('periodTitle').textContent = formatPeriodLong(quarterKey);
    document.getElementById('qualifyingMakes').textContent = stats.totalManufacturers;
    document.getElementById('totalMakes').textContent = `of ${manufacturers.length}`;
    document.getElementById('qualifyingRule').textContent = `with ${state.minAuctions} or more auctions`;
    document.getElementById('totalAuctions').textContent = stats.totalAuctions.toLocaleString();
    document.getElementById('marketMII').textContent = stats.avgMII.toFixed(1);
    document.getElementById('avgPrice').textContent = formatPrice(stats.avgPrice);

    // Market change vs the month before, on the same qualifying rule.
    const changeEl = document.getElementById('marketChange');
    const prevKey = previousPeriodKey(quarterKey);
    const prevStats = prevKey ? calculateMarketStats(prevKey) : null;
    if (!prevStats || !prevStats.totalManufacturers || !stats.totalManufacturers) {
        changeEl.textContent = '';
        return;
    }
    const diff = stats.avgMII - prevStats.avgMII;
    const sign = diff > 0 ? '+' : diff < 0 ? '−' : '';
    changeEl.textContent = `${sign}${Math.abs(diff).toFixed(1)} pts vs ${formatQuarterDisplay(prevKey)}`;
    changeEl.className = `font-mono text-sm ${Math.abs(diff) < 0.05 ? 'text-faint' : diff > 0 ? 'text-up' : 'text-down'}`;
}

function renderTopModels() {
    const container = document.getElementById('topModelsContainer');
    const subtitle = document.getElementById('topModelsSubtitle');
    const isYTD = state.selectedQuarter === 'YTD';

    // Use search results if searching, otherwise show top models
    const isSearching = state.modelSearchTerm && state.modelSearchTerm.length > 0;
    let topModels;

    if (isSearching) {
        topModels = searchAllModels(state.modelSearchTerm, 50);
        subtitle.textContent = `${topModels.length} results for "${state.modelSearchTerm}"`;
    } else {
        topModels = getTopModels(TOP_MODELS_MIN_AUCTIONS, 20);
        subtitle.textContent = `Top 20 models with ${TOP_MODELS_MIN_AUCTIONS}+ auctions ${isYTD ? 'this year' : 'in this period'}. Select one for its individual sales.`;
    }

    if (topModels.length === 0) {
        const message = isSearching
            ? `No models match "${esc(state.modelSearchTerm)}"`
            : `No models in this ${isYTD ? 'period' : 'month'}`;
        container.innerHTML = `<tr><td colspan="8" class="px-6 py-10 text-center text-mute">${message}</td></tr>`;
        return;
    }

    container.innerHTML = topModels.map((model, idx) => `
        <tr class="is-clickable model-row" data-make="${esc(model.make)}" data-model="${esc(model.model)}"
            title="View individual auction sales for ${esc(model.make)} ${esc(model.model)}">
            <td class="pl-6 font-mono text-[13px] text-faint">${String(idx + 1).padStart(2, '0')}</td>
            <td><span class="font-semibold">${esc(model.model)}</span> <span class="text-mute">${esc(model.make)}</span></td>
            <td class="num">${model.auctions.toLocaleString()}</td>
            <td class="num">${formatPrice(model.avgPrice)}</td>
            <td class="num">${model.sellThrough}%</td>
            <td class="num">${getTrendIndicator(model.trend, 'normal', { points: model.trendPoints, auctions: model.auctions })}</td>
            <td>${getConfidenceBadge(model.confidence)}</td>
            <td class="num pr-6 !text-sm font-medium">${model.mii.toFixed(1)}</td>
        </tr>
    `).join('');

    container.querySelectorAll('.model-row').forEach(row => {
        row.addEventListener('click', () => showLotDetail(row.dataset.make, row.dataset.model));
    });
}

function renderLeaderboard() {
    const filtered = getFilteredManufacturers();
    const container = document.getElementById('leaderboardContainer');

    document.getElementById('leaderboardSubtitle').textContent =
        `${filtered.length} makes with ${state.minAuctions}+ auctions. Select one for its models.`;
    updateSortHeaders();

    if (filtered.length === 0) {
        container.innerHTML = `<tr><td colspan="10" class="px-6 py-10 text-center text-mute">No makes match these filters</td></tr>`;
        return;
    }

    const maxScore = Math.max(...filtered.map(m => m.miiScore), 1);
    const visible = state.showAllMakes ? filtered : filtered.slice(0, LEADERBOARD_ROWS);

    container.innerHTML = visible.map((mfr, idx) => {
        const isSelected = state.selectedMake === mfr.make;
        const isComparing = state.compareList.includes(mfr.make);
        const barWidth = Math.max(2, (mfr.miiScore / maxScore) * 100).toFixed(0);

        return `
            <tr class="is-clickable ${isSelected ? 'is-selected' : ''}" data-make="${esc(mfr.make)}">
                <td class="pl-6 font-mono text-[13px] text-faint">${String(idx + 1).padStart(2, '0')}</td>
                <td><button class="font-semibold text-[15px] text-left hover:text-amber-700" aria-pressed="${isSelected}">${esc(mfr.make)}</button></td>
                <td class="w-40">
                    <div class="flex items-center gap-3">
                        <span class="font-mono text-[15px] font-medium w-10 text-right">${mfr.miiScore.toFixed(1)}</span>
                        <span class="score-bar"><span style="width:${barWidth}%"></span></span>
                    </div>
                </td>
                <td class="num">${getTrendIndicator(mfr.trend, 'normal', { points: mfr.trendPoints, auctions: mfr.auctions })}</td>
                <td>${createSparkline(mfr.history)}</td>
                <td class="num">${mfr.auctions.toLocaleString()}</td>
                <td class="num">${formatPrice(mfr.avgPrice)}</td>
                <td class="num">${mfr.sellThrough}%</td>
                <td>${getConfidenceBadge(mfr.confidence, { compact: true })}</td>
                <td class="pr-6 text-right">
                    <button class="compare-btn icon-btn ${isComparing ? 'is-on' : ''}" data-make="${esc(mfr.make)}"
                            aria-pressed="${isComparing}"
                            aria-label="${isComparing ? 'Remove' : 'Add'} ${esc(mfr.make)} ${isComparing ? 'from' : 'to'} comparison"
                            ${!isComparing && state.compareList.length >= 4 ? 'disabled title="Compare holds up to 4 makes"' : ''}>
                        ${isComparing ? '&#10003;' : '+'}
                    </button>
                </td>
            </tr>
        `;
    }).join('') + (filtered.length > LEADERBOARD_ROWS ? `
        <tr>
            <td colspan="10" class="px-6 py-3.5">
                <button id="toggleAllMakes" class="text-sm font-medium hover:text-amber-700">
                    ${state.showAllMakes ? `Show top ${LEADERBOARD_ROWS} only` : `Show all ${filtered.length} makes`}
                </button>
            </td>
        </tr>` : '');

    const toggleAll = document.getElementById('toggleAllMakes');
    if (toggleAll) {
        toggleAll.addEventListener('click', () => {
            state.showAllMakes = !state.showAllMakes;
            renderLeaderboard();
        });
    }

    container.querySelectorAll('.compare-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleCompare(btn.dataset.make);
        });
    });
    container.querySelectorAll('tr[data-make]').forEach(row => {
        row.addEventListener('click', () => {
            selectManufacturer(row.dataset.make === state.selectedMake ? null : row.dataset.make);
        });
    });
}

// Mark the active sort column on the leaderboard's header buttons.
function updateSortHeaders() {
    document.querySelectorAll('.sort-btn').forEach(btn => {
        const th = btn.closest('th');
        const active = btn.dataset.sort === state.sortBy;
        const arrow = btn.querySelector('.sort-arrow');
        if (arrow) arrow.remove();
        if (active) {
            th.setAttribute('aria-sort', state.sortOrder === 'desc' ? 'descending' : 'ascending');
            btn.insertAdjacentHTML('beforeend',
                `<span class="sort-arrow" aria-hidden="true">${state.sortOrder === 'desc' ? '&#8595;' : '&#8593;'}</span>`);
        } else {
            th.removeAttribute('aria-sort');
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
            <div class="panel p-6 flex flex-col gap-1.5">
                <h3 class="m-0 text-base font-semibold">No make selected</h3>
                <p class="m-0 text-sm text-mute">Select a make in the table to see its MII history and model rankings.</p>
            </div>
        `;
        return;
    }

    const models = mfr.models.slice().sort((a, b) => b.mii - a.mii);

    container.innerHTML = `
        <div class="panel p-6 flex flex-col gap-6">
            <div class="flex justify-between items-start gap-3">
                <div class="flex flex-col gap-0.5">
                    <span class="text-[13px] text-mute">Selected make</span>
                    <h2 class="m-0 text-2xl font-semibold tracking-tight">${esc(mfr.make)}</h2>
                </div>
                <button id="closeDetail" class="icon-btn" aria-label="Close ${esc(mfr.make)} detail">&times;</button>
            </div>

            <div class="grid grid-cols-3 gap-4">
                <div class="flex flex-col gap-0.5">
                    <span class="text-xs text-mute">MII</span>
                    <span class="text-2xl font-semibold">${mfr.miiScore.toFixed(1)}</span>
                    ${getTrendIndicator(mfr.trend, 'normal', { points: mfr.trendPoints, auctions: mfr.auctions })}
                </div>
                <div class="flex flex-col gap-0.5">
                    <span class="text-xs text-mute">Auctions</span>
                    <span class="text-2xl font-semibold">${mfr.auctions.toLocaleString()}</span>
                    <span class="text-xs text-mute">${mfr.sellThrough}% sold</span>
                </div>
                <div class="flex flex-col gap-0.5">
                    <span class="text-xs text-mute">Avg price</span>
                    <span class="text-2xl font-semibold">${formatPrice(mfr.avgPrice)}</span>
                    <span class="text-xs text-mute">sold lots</span>
                </div>
            </div>

            <div class="flex flex-col gap-2">
                <span class="text-[13px] font-medium">MII over time</span>
                <div style="height: 150px;"><canvas id="trendChart"></canvas></div>
            </div>

            <div class="flex flex-col">
                <div class="flex justify-between items-baseline gap-3 pb-2">
                    <span class="text-[13px] font-medium">Models <span class="text-mute font-normal">${models.length}</span></span>
                    <span class="text-xs text-faint">Select one for individual sales</span>
                </div>
                <ul class="m-0 p-0 list-none max-h-96 overflow-y-auto">
                    ${models.map(model => `
                        <li class="border-t border-hair">
                            <button class="model-row w-full flex items-center justify-between gap-3 py-3 text-left hover:bg-[#FAFAF8]"
                                    data-make="${esc(mfr.make)}" data-model="${esc(model.model)}">
                                <span class="flex flex-col gap-0.5 min-w-0">
                                    <span class="text-sm font-medium">${esc(model.model)}</span>
                                    <span class="text-xs text-faint">${model.auctions === 1 ? '1 auction' : `${model.auctions} auctions`} · ${formatPrice(model.avgPrice)} · ${model.sellThrough}% sold</span>
                                </span>
                                <span class="flex flex-col items-end gap-0.5 shrink-0">
                                    <span class="font-mono text-sm font-medium">${model.mii.toFixed(1)}</span>
                                    ${getTrendIndicator(model.trend, 'normal', { points: model.trendPoints, auctions: model.auctions })}
                                </span>
                            </button>
                        </li>
                    `).join('')}
                </ul>
            </div>
        </div>
    `;

    document.getElementById('closeDetail').addEventListener('click', () => selectManufacturer(null));

    // Lot-level drill-down: clicking a model row opens its individual sales.
    container.querySelectorAll('.model-row').forEach(row => {
        row.addEventListener('click', () => showLotDetail(row.dataset.make, row.dataset.model));
    });

    // Render trend chart
    setTimeout(() => renderTrendChart(mfr), 0);
}

// ---------------------------------------------------------------------------
// Lot-level drill-down: shows the individual auction sales behind a model's
// monthly average (so high/low outliers like a $56K E46 M3 are visible).
// ---------------------------------------------------------------------------
function formatCurrency(amount, currency) {
    if (amount == null) return '—';
    const symbol = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '$';
    const prefix = (currency && currency !== 'USD') ? `${currency} ${symbol}` : symbol;
    return `${prefix}${Math.round(amount).toLocaleString()}`;
}

function showLotDetail(make, model) {
    const modal = document.getElementById('lotModal');
    const titleEl = document.getElementById('lotModalTitle');
    const subtitleEl = document.getElementById('lotModalSubtitle');
    const tableBody = document.getElementById('lotTableBody');
    if (!modal) return;

    const lots = (batLots[modelJoinKey(make, model)] || []).slice().sort((a, b) => b.date.localeCompare(a.date));

    titleEl.textContent = `${make} ${model}`;

    const usdSold = lots.filter(l => l.sold && l.currency === 'USD' && l.amount != null);
    const soldCount = lots.filter(l => l.sold).length;
    const avg = usdSold.length ? usdSold.reduce((s, l) => s + l.amount, 0) / usdSold.length : null;
    const high = usdSold.length ? Math.max(...usdSold.map(l => l.amount)) : null;
    const low = usdSold.length ? Math.min(...usdSold.map(l => l.amount)) : null;
    subtitleEl.textContent = lots.length
        ? `${lots.length} listings · ${soldCount} sold · USD average ${formatCurrency(avg, 'USD')} · range ${formatCurrency(low, 'USD')} to ${formatCurrency(high, 'USD')}`
        : 'No individual auction records found for this model in bat.csv.';

    // Build the table (most recent first), linking each lot back to its BAT listing.
    if (!lots.length) {
        tableBody.innerHTML = `<tr><td colspan="6" class="px-4 py-6 text-center text-mute">No lot-level data available.</td></tr>`;
    } else {
        tableBody.innerHTML = lots.map(l => {
            const statusLabel = l.sold ? 'Sold' : (l.saleType || 'unsold');
            const link = l.url
                ? `<a href="${esc(l.url)}" target="_blank" rel="noopener" class="text-amber-700 hover:text-ink underline underline-offset-2">View</a>`
                : '—';
            return `
                <tr>
                    <td class="pl-4 font-mono text-[13px]">${esc(l.date)}</td>
                    <td class="text-mute">${l.year ? Math.round(l.year) : '—'}</td>
                    <td class="font-mono text-[13px] font-medium">${formatCurrency(l.amount, l.currency)}</td>
                    <td class="${l.sold ? 'text-up' : 'text-mute'}">${esc(statusLabel)}</td>
                    <td class="text-mute">${l.bids != null ? l.bids : '—'} bids · ${l.comments != null ? l.comments : '—'} comments</td>
                    <td class="pr-4">${link}</td>
                </tr>`;
        }).join('');
    }

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.getElementById('lotModalClose').focus();
    setTimeout(() => renderLotScatter(lots), 0);
}

function hideLotDetail() {
    const modal = document.getElementById('lotModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    if (charts.lots) { charts.lots.destroy(); charts.lots = null; }
}

// Shared axis styling for the light charts.
function lightScale(extra = {}) {
    const t = window.MII_THEME;
    return {
        grid: { color: t.grid },
        border: { display: false },
        ...extra,
        ticks: { color: t.faint, font: { size: 11 }, ...(extra.ticks || {}) }
    };
}

function renderLotScatter(lots) {
    const canvas = document.getElementById('lotScatterChart');
    if (!canvas) return;
    if (charts.lots) charts.lots.destroy();
    const t = window.MII_THEME;

    // Plot USD lots only (mixed currencies would distort the axis); split sold vs unsold.
    // x is a timestamp on a linear axis so sold and unsold lots share one chronological scale
    // (a category axis appends the unsold dataset's dates after the sold ones).
    const usdLots = lots
        .filter(l => l.currency === 'USD' && l.amount != null && !isNaN(Date.parse(l.date)))
        .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    const toPoint = l => ({ x: Date.parse(l.date), y: l.amount, url: l.url, saleType: l.saleType, date: l.date });
    const soldPoints = usdLots.filter(l => l.sold).map(toPoint);
    const unsoldPoints = usdLots.filter(l => !l.sold).map(toPoint);

    charts.lots = new Chart(canvas.getContext('2d'), {
        type: 'scatter',
        data: {
            datasets: [
                { label: 'Sold', data: soldPoints, backgroundColor: t.amber, borderColor: t.amberText, borderWidth: 1, pointRadius: 5, pointHoverRadius: 7 },
                { label: 'Unsold / bid to', data: unsoldPoints, backgroundColor: '#FFFFFF', borderColor: t.faint, borderWidth: 1.5, pointRadius: 4, pointHoverRadius: 6 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: lightScale({
                    type: 'linear',
                    ticks: { maxRotation: 45, maxTicksLimit: 10, callback: v => new Date(v).toISOString().slice(0, 7) }
                }),
                y: lightScale({
                    ticks: { callback: v => '$' + (v / 1000) + 'K' },
                    title: { display: true, text: 'Sale price (USD)', color: t.faint }
                })
            },
            plugins: {
                legend: { labels: { color: t.mute, usePointStyle: true, boxWidth: 8 } },
                tooltip: {
                    ...t.tooltip,
                    callbacks: {
                        label: ctx => `${ctx.dataset.label}: $${Math.round(ctx.parsed.y).toLocaleString()} (${ctx.raw.date || ctx.parsed.x})`
                    }
                }
            },
            onClick: (evt, elements) => {
                if (elements.length) {
                    const pt = charts.lots.data.datasets[elements[0].datasetIndex].data[elements[0].index];
                    if (pt && pt.url) window.open(pt.url, '_blank', 'noopener');
                }
            }
        }
    });
}

function renderTrendChart(mfr) {
    const canvas = document.getElementById('trendChart');
    if (!canvas) return;
    const t = window.MII_THEME;

    if (charts.trend) {
        charts.trend.destroy();
    }

    // Build full historical trend across all available months for this manufacturer
    const allPeriods = dashboardData.quarters.filter(q => q !== 'YTD');
    const trendLabels = [];
    const trendData = [];
    allPeriods.forEach(period => {
        const periodMfr = dashboardData.quarterData[period]?.manufacturers.find(m => m.make === mfr.make);
        if (periodMfr) {
            trendLabels.push(formatQuarterDisplay(period));
            trendData.push(periodMfr.miiScore);
        }
    });

    charts.trend = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: trendLabels,
            datasets: [{
                label: 'MII',
                data: trendData,
                borderColor: t.amber,
                borderWidth: 2,
                tension: 0.3,
                pointRadius: 0,
                pointHoverRadius: 4,
                pointBackgroundColor: t.amber
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: { ...t.tooltip, callbacks: { label: ctx => `MII ${ctx.parsed.y.toFixed(1)}` } }
            },
            scales: {
                x: lightScale({ grid: { display: false }, ticks: { maxTicksLimit: 4, maxRotation: 0 } }),
                y: lightScale({ ticks: { maxTicksLimit: 4 } })
            }
        }
    });
}

function renderComparePanel() {
    const panel = document.getElementById('comparePanel');
    const listContainer = document.getElementById('compareList');
    const colors = window.MII_THEME.series;

    if (state.compareList.length === 0) {
        panel.classList.add('hidden');
        return;
    }

    panel.classList.remove('hidden');
    document.getElementById('compareCount').textContent = `Compare (${state.compareList.length}/4)`;

    listContainer.innerHTML = state.compareList.map((make, i) => `
        <span class="inline-flex items-center gap-2 border border-line rounded-full pl-3 pr-1 h-8 text-[13px]">
            <span class="w-2 h-2 rounded-full" style="background: ${colors[i]}" aria-hidden="true"></span>
            ${esc(make)}
            <button class="remove-compare w-6 h-6 rounded-full text-mute hover:text-ink hover:bg-canvas" data-make="${esc(make)}" aria-label="Remove ${esc(make)} from comparison">&times;</button>
        </span>
    `).join('');

    listContainer.querySelectorAll('.remove-compare').forEach(btn => {
        btn.addEventListener('click', () => toggleCompare(btn.dataset.make));
    });

    renderCompareChart();
}

function renderCompareChart() {
    const canvas = document.getElementById('compareChart');
    if (!canvas) return;
    const t = window.MII_THEME;

    if (charts.compare) {
        charts.compare.destroy();
    }

    const datasets = state.compareList.map((make, i) => {
        const mfr = dashboardData.manufacturers.find(m => m.make === make);
        return {
            label: make,
            data: mfr ? mfr.history : [],
            borderColor: t.series[i],
            backgroundColor: t.series[i],
            tension: 0.3,
            pointRadius: 0,
            pointHoverRadius: 3,
            borderWidth: 2
        };
    });

    charts.compare = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: dashboardData.quarters.map(formatQuarterDisplay),
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: { ...t.tooltip, displayColors: true, boxWidth: 8, boxHeight: 8 }
            },
            scales: {
                x: lightScale({ grid: { display: false }, ticks: { maxTicksLimit: 5, maxRotation: 0, font: { size: 10 } } }),
                y: lightScale({ ticks: { maxTicksLimit: 4, font: { size: 10 } } })
            }
        }
    });
}

function renderQuarterMIIChart() {
    const container = document.getElementById('quarterProgressContainer');
    if (!container) return;
    const t = window.MII_THEME;

    const trendData = dashboardData.quarterMIITrends['__market__'];
    if (!trendData || !trendData.data.some(v => v !== null)) {
        container.classList.add('hidden');
        return;
    }

    // The newest month is always the partial, month-to-date one.
    const lastIndex = trendData.data.length - 1;
    const latestIsPartial = dashboardData.quarters.some(q => q.endsWith('-MTD'));

    container.classList.remove('hidden');
    container.innerHTML = `
        <div class="flex flex-col gap-2">
            <div style="height: 190px;">
                <canvas id="quarterMIIChart" aria-label="Market MII by month"></canvas>
            </div>
            <span class="text-xs text-faint">Market MII by month${latestIsPartial ? '. The dashed segment is the current month, still in progress.' : '.'}</span>
        </div>
    `;

    setTimeout(() => {
        const canvas = document.getElementById('quarterMIIChart');
        if (!canvas) return;
        if (charts.quarterMII) charts.quarterMII.destroy();

        // Highlight the currently selected period
        const selectedLabel = formatQuarterDisplay(state.selectedQuarter);
        const pointRadii = trendData.labels.map(l => l === selectedLabel ? 5 : 0);

        charts.quarterMII = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                labels: trendData.labels,
                datasets: [{
                    label: 'Market MII',
                    data: trendData.data,
                    borderColor: t.amber,
                    borderWidth: 2.25,
                    tension: 0.3,
                    pointRadius: pointRadii,
                    pointBackgroundColor: t.amber,
                    pointBorderColor: '#FFFFFF',
                    pointBorderWidth: 2,
                    pointHoverRadius: 5,
                    spanGaps: true,
                    segment: {
                        borderDash: ctx => (latestIsPartial && ctx.p1DataIndex === lastIndex ? [4, 4] : undefined)
                    }
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        ...t.tooltip,
                        callbacks: {
                            label: ctx => 'Market MII ' + (ctx.parsed.y !== null ? ctx.parsed.y.toFixed(1) : '—')
                        }
                    }
                },
                scales: {
                    x: lightScale({ grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 13 } }),
                    y: lightScale({
                        ticks: { maxTicksLimit: 5, callback: v => v.toFixed(0) },
                        grace: '10%'
                    })
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

function init() {
    // This is when the page fetched the data, not when the pipeline last ran.
    const date = new Date(dashboardData.lastUpdated);
    document.getElementById('lastUpdated').textContent = date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

    // Populate quarter select
    const quarterSelect = document.getElementById('quarterSelect');
    quarterSelect.innerHTML = dashboardData.quarters.slice().reverse().map(q =>
        `<option value="${q}" ${q === state.selectedQuarter ? 'selected' : ''}>${formatPeriodLong(q)}</option>`
    ).join('');

    quarterSelect.addEventListener('change', (e) => {
        state.selectedQuarter = e.target.value;
        updateFilters();
        renderManufacturerDetail();
        renderQuarterMIIChart();
    });

    // Lot-level drill-down modal close handlers
    const lotModal = document.getElementById('lotModal');
    document.getElementById('lotModalClose').addEventListener('click', hideLotDetail);
    lotModal.addEventListener('click', (e) => { if (e.target === lotModal) hideLotDetail(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideLotDetail(); });

    document.getElementById('searchInput').addEventListener('input', (e) => {
        state.searchTerm = e.target.value;
        updateFilters();
    });

    document.getElementById('minAuctions').addEventListener('change', (e) => {
        state.minAuctions = Number(e.target.value);
        updateFilters();
    });

    // Column headers sort the leaderboard; a second click flips the order.
    document.querySelectorAll('.sort-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.sort;
            if (state.sortBy === key) {
                state.sortOrder = state.sortOrder === 'desc' ? 'asc' : 'desc';
            } else {
                state.sortBy = key;
                state.sortOrder = key === 'make' ? 'asc' : 'desc';
            }
            renderLeaderboard();
        });
    });

    document.getElementById('clearCompare').addEventListener('click', () => {
        state.compareList = [];
        renderLeaderboard();
        renderComparePanel();
    });

    // Model search
    const modelSearchInput = document.getElementById('modelSearch');
    const modelSearchClear = document.getElementById('modelSearchClear');

    modelSearchInput.addEventListener('input', (e) => {
        state.modelSearchTerm = e.target.value;
        modelSearchClear.classList.toggle('hidden', state.modelSearchTerm.length === 0);
        renderTopModels();
    });

    modelSearchClear.addEventListener('click', () => {
        state.modelSearchTerm = '';
        modelSearchInput.value = '';
        modelSearchClear.classList.add('hidden');
        renderTopModels();
        modelSearchInput.focus();
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
