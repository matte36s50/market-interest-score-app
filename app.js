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

// Manufacturer branding (colors and abbreviations for better visual identity)
const MANUFACTURER_BRANDING = {
    'Porsche': { abbr: 'POR', color: '#d5001c', bg: '#1a0003' },
    'BMW': { abbr: 'BMW', color: '#1c69d4', bg: '#001a33' },
    'Mercedes-Benz': { abbr: 'MB', color: '#00adef', bg: '#001a24' },
    'Ferrari': { abbr: 'FER', color: '#dc0000', bg: '#1f0000' },
    'Nissan': { abbr: 'NIS', color: '#c3002f', bg: '#1a0006' },
    'Toyota': { abbr: 'TOY', color: '#eb0a1e', bg: '#1f0103' },
    'Audi': { abbr: 'AUD', color: '#bb0a30', bg: '#1a0105' },
    'Chevrolet': { abbr: 'CHV', color: '#ffc72c', bg: '#262109' },
    'Ford': { abbr: 'FOR', color: '#003478', bg: '#000a14' },
    'Lamborghini': { abbr: 'LAM', color: '#ffd700', bg: '#262209' },
    'Jaguar': { abbr: 'JAG', color: '#006633', bg: '#00140a' },
    'Land Rover': { abbr: 'LRV', color: '#005a2b', bg: '#001108' },
    'Lexus': { abbr: 'LEX', color: '#0061aa', bg: '#001220' },
    'Honda': { abbr: 'HON', color: '#cc0000', bg: '#1a0000' },
    'Acura': { abbr: 'ACU', color: '#700000', bg: '#120000' },
    'Mazda': { abbr: 'MAZ', color: '#c1272d', bg: '#1a0405' },
    'Subaru': { abbr: 'SUB', color: '#0052a5', bg: '#001019' },
    'Volkswagen': { abbr: 'VW', color: '#001e50', bg: '#00060f' },
    'Mercedes-AMG': { abbr: 'AMG', color: '#00adef', bg: '#001a24' },
    'Dodge': { abbr: 'DOD', color: '#cc162c', bg: '#1a0304' },
    'Plymouth': { abbr: 'PLY', color: '#ff6600', bg: '#1f1100' },
    'Pontiac': { abbr: 'PON', color: '#ee3124', bg: '#1f0605' },
    'Oldsmobile': { abbr: 'OLD', color: '#003da5', bg: '#000c19' }
};

// Helper function to generate manufacturer logo HTML
function getManufacturerLogo(manufacturer) {
    const branding = MANUFACTURER_BRANDING[manufacturer] || { abbr: manufacturer.substring(0, 3).toUpperCase(), color: '#888', bg: '#1a1a1a' };
    return `<div class="flex items-center justify-center w-10 h-10 rounded-lg font-bold text-xs" style="background: ${branding.bg}; color: ${branding.color}; border: 1px solid ${branding.color}40;">${branding.abbr}</div>`;
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

            // Calculate average price
            const avgPrice = mfrData.reduce((sum, row) => sum + parseFloat(row.price || 0), 0) / mfrData.length;

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
                mii: parseFloat(row.mii_score),
                avgPrice: parseFloat(row.price || 0),
                trend: 0,
                confidence: 'Medium',
                googleTrends: parseFloat(row.google_trends_interest) || 0,
                youtubeTotalViews: parseFloat(row.youtube_total_views) || 0,
                instagramMentions: (row.instagram_mentions !== undefined && row.instagram_mentions !== '')
                    ? (parseFloat(row.instagram_mentions) || 0) : null,
                socialScore: parseFloat(row.social_score) || 0
            }));

            // Group models by name and aggregate
            const modelGroups = {};
            models.forEach(model => {
                if (!modelGroups[model.model]) {
                    modelGroups[model.model] = {
                        model: model.model,
                        auctions: 0,
                        totalMII: 0,
                        totalPrice: 0,
                        totalGoogleTrends: 0,
                        totalYoutubeTotalViews: 0,
                        totalInstagramMentions: 0,
                        hasInstagramData: false,
                        totalSocialScore: 0,
                        rowCount: 0
                    };
                }
                modelGroups[model.model].auctions += model.auctions;
                modelGroups[model.model].totalMII += model.mii;
                modelGroups[model.model].totalPrice += model.avgPrice;
                modelGroups[model.model].totalGoogleTrends += model.googleTrends;
                modelGroups[model.model].totalYoutubeTotalViews += model.youtubeTotalViews;
                if (model.instagramMentions !== null) {
                    modelGroups[model.model].totalInstagramMentions += model.instagramMentions;
                    modelGroups[model.model].hasInstagramData = true;
                }
                modelGroups[model.model].totalSocialScore += model.socialScore;
                modelGroups[model.model].rowCount++;
            });

            const aggregatedModels = Object.values(modelGroups).map(mg => {
                const currentMII = mg.totalMII / mg.auctions;
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
                    avgPrice: mg.totalPrice / mg.auctions,
                    trend: parseFloat(modelTrend.toFixed(1)),
                    confidence: mg.auctions >= 5 ? 'High' : mg.auctions >= 3 ? 'Medium' : 'Low',
                    googleTrends: mg.rowCount > 0 ? parseFloat((mg.totalGoogleTrends / mg.rowCount).toFixed(1)) : 0,
                    youtubeTotalViews: mg.totalYoutubeTotalViews,
                    instagramMentions: mg.hasInstagramData ? mg.totalInstagramMentions : null,
                    socialScore: mg.rowCount > 0 ? parseFloat((mg.totalSocialScore / mg.rowCount).toFixed(2)) : 0
                };
            });

            // Aggregate digital signals at manufacturer level
            const mfrAvgGoogleTrends = mfrData.length > 0
                ? mfrData.reduce((sum, row) => sum + (parseFloat(row.google_trends_interest) || 0), 0) / mfrData.length : 0;
            const mfrTotalYoutubeViews = mfrData.reduce((sum, row) => sum + (parseFloat(row.youtube_total_views) || 0), 0);
            const mfrInstagramRows = mfrData.filter(row => row.instagram_mentions !== undefined && row.instagram_mentions !== '');
            const mfrTotalInstagram = mfrInstagramRows.length > 0
                ? mfrInstagramRows.reduce((sum, row) => sum + (parseFloat(row.instagram_mentions) || 0), 0) : null;
            const mfrAvgSocialScore = mfrData.length > 0
                ? mfrData.reduce((sum, row) => sum + (parseFloat(row.social_score) || 0), 0) / mfrData.length : 0;

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
                models: aggregatedModels.sort((a, b) => b.mii - a.mii),
                googleTrends: parseFloat(mfrAvgGoogleTrends.toFixed(1)),
                youtubeTotalViews: mfrTotalYoutubeViews,
                instagramMentions: mfrTotalInstagram,
                socialScore: parseFloat(mfrAvgSocialScore.toFixed(2))
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
            const avgPrice = mfrData.reduce((sum, row) => sum + parseFloat(row.price || 0), 0) / mfrData.length;

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
                mii: parseFloat(row.mii_score),
                avgPrice: parseFloat(row.price || 0),
                trend: 0,
                confidence: 'Medium',
                googleTrends: parseFloat(row.google_trends_interest) || 0,
                youtubeTotalViews: parseFloat(row.youtube_total_views) || 0,
                instagramMentions: (row.instagram_mentions !== undefined && row.instagram_mentions !== '')
                    ? (parseFloat(row.instagram_mentions) || 0) : null,
                socialScore: parseFloat(row.social_score) || 0
            }));

            // Group models by name and aggregate
            const modelGroups = {};
            models.forEach(model => {
                if (!modelGroups[model.model]) {
                    modelGroups[model.model] = {
                        model: model.model,
                        auctions: 0,
                        totalMII: 0,
                        totalPrice: 0,
                        totalGoogleTrends: 0,
                        totalYoutubeTotalViews: 0,
                        totalInstagramMentions: 0,
                        hasInstagramData: false,
                        totalSocialScore: 0,
                        rowCount: 0
                    };
                }
                modelGroups[model.model].auctions += model.auctions;
                modelGroups[model.model].totalMII += model.mii;
                modelGroups[model.model].totalPrice += model.avgPrice;
                modelGroups[model.model].totalGoogleTrends += model.googleTrends;
                modelGroups[model.model].totalYoutubeTotalViews += model.youtubeTotalViews;
                if (model.instagramMentions !== null) {
                    modelGroups[model.model].totalInstagramMentions += model.instagramMentions;
                    modelGroups[model.model].hasInstagramData = true;
                }
                modelGroups[model.model].totalSocialScore += model.socialScore;
                modelGroups[model.model].rowCount++;
            });

            const aggregatedModels = Object.values(modelGroups).map(mg => {
                const currentMII = mg.totalMII / mg.auctions;
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
                    avgPrice: mg.totalPrice / mg.auctions,
                    trend: parseFloat(modelTrend.toFixed(1)),
                    confidence: mg.auctions >= 10 ? 'High' : mg.auctions >= 5 ? 'Medium' : 'Low',
                    googleTrends: mg.rowCount > 0 ? parseFloat((mg.totalGoogleTrends / mg.rowCount).toFixed(1)) : 0,
                    youtubeTotalViews: mg.totalYoutubeTotalViews,
                    instagramMentions: mg.hasInstagramData ? mg.totalInstagramMentions : null,
                    socialScore: mg.rowCount > 0 ? parseFloat((mg.totalSocialScore / mg.rowCount).toFixed(2)) : 0
                };
            });

            // Aggregate digital signals at manufacturer level
            const mfrAvgGoogleTrends = mfrData.length > 0
                ? mfrData.reduce((sum, row) => sum + (parseFloat(row.google_trends_interest) || 0), 0) / mfrData.length : 0;
            const mfrTotalYoutubeViews = mfrData.reduce((sum, row) => sum + (parseFloat(row.youtube_total_views) || 0), 0);
            const mfrInstagramRows = mfrData.filter(row => row.instagram_mentions !== undefined && row.instagram_mentions !== '');
            const mfrTotalInstagram = mfrInstagramRows.length > 0
                ? mfrInstagramRows.reduce((sum, row) => sum + (parseFloat(row.instagram_mentions) || 0), 0) : null;
            const mfrAvgSocialScore = mfrData.length > 0
                ? mfrData.reduce((sum, row) => sum + (parseFloat(row.social_score) || 0), 0) / mfrData.length : 0;

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
                models: aggregatedModels.sort((a, b) => b.mii - a.mii),
                googleTrends: parseFloat(mfrAvgGoogleTrends.toFixed(1)),
                youtubeTotalViews: mfrTotalYoutubeViews,
                instagramMentions: mfrTotalInstagram,
                socialScore: parseFloat(mfrAvgSocialScore.toFixed(2))
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
            <div class="bg-zinc-800/50 rounded-lg p-4 hover:bg-zinc-800 transition-colors">
                <div class="flex items-start justify-between mb-2">
                    <div class="flex items-center gap-2">
                        ${getManufacturerLogo(model.make)}
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
                        ${auctionText} • $${(model.avgPrice / 1000).toFixed(0)}K
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
                        ${getManufacturerLogo(mfr.make)}
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

// ---- Digital Signal Helpers ----

// Format large numbers for YouTube views (e.g. 1234567 -> "1.2M")
function fmtViews(n) {
    if (!n || isNaN(n)) return '—';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(Math.round(n));
}

// Format Instagram mentions
function fmtMentions(n) {
    if (n === null || n === undefined || isNaN(n)) return null;
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(Math.round(n));
}

// Render a compact Google Trends bar (score 0-100)
function renderTrendsBar(score) {
    const pct = Math.min(100, Math.max(0, score || 0));
    const color = pct >= 70 ? '#10b981' : pct >= 40 ? '#f59e0b' : '#71717a';
    const label = pct >= 70 ? 'High' : pct >= 40 ? 'Moderate' : 'Low';
    return `
        <div class="flex items-center gap-2">
            <div class="flex-1 bg-zinc-700 rounded-full h-1.5 overflow-hidden">
                <div class="h-full rounded-full transition-all" style="width:${pct}%; background:${color};"></div>
            </div>
            <span class="text-xs font-medium" style="color:${color}; min-width:2.5rem;">${pct.toFixed(0)}/100</span>
            <span class="text-xs text-zinc-500">${label}</span>
        </div>`;
}

// Build the Digital Signals panel HTML for manufacturer or model level
function renderDigitalSignalsPanel(googleTrends, youtubeTotalViews, instagramMentions, socialScore, compact) {
    const viewsFmt = fmtViews(youtubeTotalViews);
    const igFmt = fmtMentions(instagramMentions);
    const hasYT = youtubeTotalViews > 0;
    const hasIG = igFmt !== null;
    const hasSocial = socialScore > 0;

    if (compact) {
        // Inline badges for model list rows
        return `
            <div class="flex items-center gap-3 mt-1.5 flex-wrap">
                <span class="inline-flex items-center gap-1 text-xs text-zinc-400" title="Google Trends Search Interest (0-100)">
                    <svg class="w-3 h-3 text-blue-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
                    <span class="text-blue-400 font-medium">${(googleTrends||0).toFixed(0)}</span>
                    <span class="text-zinc-600">trends</span>
                </span>
                ${hasYT ? `<span class="inline-flex items-center gap-1 text-xs text-zinc-400" title="YouTube Total Views">
                    <svg class="w-3 h-3 text-red-400 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M23.5 6.19a3 3 0 00-2.12-2.12C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.38.57A3 3 0 00.5 6.19C0 8.07 0 12 0 12s0 3.93.5 5.81a3 3 0 002.12 2.12C4.5 20.5 12 20.5 12 20.5s7.5 0 9.38-.57a3 3 0 002.12-2.12C24 15.93 24 12 24 12s0-3.93-.5-5.81zM9.75 15.5v-7l6.5 3.5-6.5 3.5z"/></svg>
                    <span class="text-red-400 font-medium">${viewsFmt}</span>
                    <span class="text-zinc-600">views</span>
                </span>` : ''}
                ${hasIG ? `<span class="inline-flex items-center gap-1 text-xs text-zinc-400" title="Instagram Mentions">
                    <svg class="w-3 h-3 text-pink-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1112.63 8 4 4 0 0116 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>
                    <span class="text-pink-400 font-medium">${igFmt}</span>
                    <span class="text-zinc-600">mentions</span>
                </span>` : ''}
            </div>`;
    }

    // Full panel for manufacturer header
    return `
        <div class="grid grid-cols-1 gap-3">
            <!-- Google Trends -->
            <div class="bg-zinc-800/50 rounded-lg p-3">
                <div class="flex items-center gap-2 mb-2">
                    <svg class="w-4 h-4 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                    <span class="text-xs font-semibold text-zinc-300 uppercase tracking-wide">Google Trends</span>
                    <span class="ml-auto text-xs text-zinc-500" title="Search interest index from Google Trends (0=low, 100=peak interest)">Search Interest Index</span>
                </div>
                ${renderTrendsBar(googleTrends)}
                <div class="mt-1.5 text-xs text-zinc-500">Relative search volume over the period — higher means more public curiosity driving market heat.</div>
            </div>

            <!-- YouTube Views -->
            <div class="bg-zinc-800/50 rounded-lg p-3">
                <div class="flex items-center gap-2 mb-1">
                    <svg class="w-4 h-4 text-red-400" viewBox="0 0 24 24" fill="currentColor"><path d="M23.5 6.19a3 3 0 00-2.12-2.12C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.38.57A3 3 0 00.5 6.19C0 8.07 0 12 0 12s0 3.93.5 5.81a3 3 0 002.12 2.12C4.5 20.5 12 20.5 12 20.5s7.5 0 9.38-.57a3 3 0 002.12-2.12C24 15.93 24 12 24 12s0-3.93-.5-5.81zM9.75 15.5v-7l6.5 3.5-6.5 3.5z"/></svg>
                    <span class="text-xs font-semibold text-zinc-300 uppercase tracking-wide">YouTube Views</span>
                </div>
                <div class="flex items-baseline gap-2">
                    <span class="text-xl font-bold text-red-400">${hasYT ? viewsFmt : '—'}</span>
                    ${hasYT ? '<span class="text-xs text-zinc-500">total video views this period</span>' : '<span class="text-xs text-zinc-600">no data available</span>'}
                </div>
                <div class="mt-1 text-xs text-zinc-500">Aggregate YouTube view count across brand/model content — reflects enthusiast and media engagement.</div>
            </div>

            <!-- Instagram Mentions -->
            <div class="bg-zinc-800/50 rounded-lg p-3">
                <div class="flex items-center gap-2 mb-1">
                    <svg class="w-4 h-4 text-pink-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1112.63 8 4 4 0 0116 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>
                    <span class="text-xs font-semibold text-zinc-300 uppercase tracking-wide">Instagram Mentions</span>
                </div>
                ${hasIG
                    ? `<div class="flex items-baseline gap-2">
                        <span class="text-xl font-bold text-pink-400">${igFmt}</span>
                        <span class="text-xs text-zinc-500">post mentions this period</span>
                       </div>
                       <div class="mt-1 text-xs text-zinc-500">Public Instagram posts mentioning this brand — signals lifestyle and collector community buzz.</div>`
                    : `<div class="flex items-center gap-2 mt-1">
                        <span class="text-sm text-zinc-500">Pending pipeline integration</span>
                       </div>
                       <div class="mt-1 text-xs text-zinc-600">Instagram mention tracking will be available once connected to the data pipeline.</div>`
                }
            </div>

            ${hasSocial ? `<!-- Social Engagement Score -->
            <div class="bg-zinc-800/50 rounded-lg p-3">
                <div class="flex items-center gap-2 mb-1">
                    <svg class="w-4 h-4 text-pink-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
                    <span class="text-xs font-semibold text-zinc-300 uppercase tracking-wide">Social Engagement</span>
                    <span class="ml-auto text-xs bg-pink-900/40 text-pink-400 rounded px-1.5 py-0.5">5% of MII</span>
                </div>
                <div class="flex items-baseline gap-2">
                    <span class="text-xl font-bold text-pink-500">${socialScore.toFixed(2)}</span>
                    <span class="text-xs text-zinc-500">composite score (incl. Instagram, forums, social media)</span>
                </div>
                <div class="mt-1 text-xs text-zinc-500">Normalized engagement from platforms including Instagram, Reddit, and automotive forums — feeds directly into the MII formula.</div>
            </div>` : ''}
        </div>`;
}

function renderManufacturerDetail() {
    const container = document.getElementById('manufacturerDetail');
    const quarterKey = state.selectedQuarter;
    const periodManufacturers = (dashboardData.quarterData[quarterKey]?.manufacturers) || dashboardData.manufacturers || [];
    const mfr = periodManufacturers.find(m => m.make === state.selectedMake);

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
                ${getManufacturerLogo(mfr.make)}
                <div>
                    <h3 class="text-xl font-bold">${mfr.make}</h3>
                    <div class="text-sm text-zinc-500">
                        ${mfr.auctions} auctions this month
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

        <!-- Digital Signals Panel -->
        <div class="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
            <div class="flex items-center gap-2 mb-4">
                <svg class="w-4 h-4 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                <h4 class="font-semibold">Digital Signals</h4>
                <span class="ml-auto text-xs text-zinc-600 italic">Informational — does not affect MII score</span>
            </div>
            ${renderDigitalSignalsPanel(mfr.googleTrends, mfr.youtubeTotalViews, mfr.instagramMentions, mfr.socialScore, false)}
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
                                    <div class="flex-1 min-w-0">
                                        <div class="font-medium text-sm">${model.model}</div>
                                        <div class="text-xs text-zinc-500">
                                            ${model.auctions} auctions • $${(model.avgPrice / 1000).toFixed(0)}K
                                        </div>
                                        ${renderDigitalSignalsPanel(model.googleTrends, model.youtubeTotalViews, model.instagramMentions, model.socialScore, true)}
                                    </div>
                                </div>
                                <div class="text-right flex-shrink-0 ml-3">
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
            labels: dashboardData.quarters,
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
        const mfr = dashboardData.manufacturers.find(m => m.make === make);
        return `
            <span class="inline-flex items-center gap-2 bg-zinc-800 rounded-full px-3 py-1 text-sm">
                ${getManufacturerLogo(make)}
                <span class="ml-1">${make}</span>
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

    container.classList.remove('hidden');
    container.innerHTML = `
        <div class="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
            <div class="flex items-center justify-between mb-4">
                <div class="flex items-center gap-2">
                    <h3 class="font-semibold">Market Interest Index — Month over Month</h3>
                    ${isMTD ? '<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-900/30 text-amber-400 border border-amber-800/50"><span class="inline-block w-1.5 h-1.5 bg-amber-500 rounded-full animate-pulse"></span>Live</span>' : ''}
                </div>
                <div class="text-xs font-medium" style="color:${changeColor}">${changeSign}${changePercent}% overall</div>
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

        charts.quarterMII = new Chart(ctx, {
            type: 'line',
            data: {
                labels: trendData.labels,
                datasets: [{
                    label: 'Market Avg MII',
                    data: trendData.data,
                    borderColor: '#f59e0b',
                    backgroundColor: 'rgba(245, 158, 11, 0.1)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: pointRadii,
                    pointBackgroundColor: pointColors,
                    pointBorderColor: '#18181b',
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
                        backgroundColor: '#18181b',
                        titleColor: '#f4f4f5',
                        bodyColor: '#f4f4f5',
                        borderColor: '#27272a',
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
                        grid: { color: '#27272a', drawBorder: false },
                        ticks: { color: '#71717a', font: { size: 10 }, maxRotation: 45 }
                    },
                    y: {
                        grid: { color: '#27272a', drawBorder: false },
                        ticks: {
                            color: '#71717a',
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
}

// Start the app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}
