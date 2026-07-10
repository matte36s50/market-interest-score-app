// MII Admin — live auction results entry.
//
// Appends lot rows to data/auction_lots.csv via the GitHub Contents API using a
// fine-grained PAT held only in this browser's localStorage. Pending (unsaved)
// lots are also persisted to localStorage so an interrupted session at a live
// auction loses nothing. "Download CSV" is the no-network fallback: it exports
// existing + pending rows as a merged file for a manual commit.
//
// Deliberately zero external dependencies (no CDN scripts beyond Tailwind
// styling): data entry must keep working on flaky venue wifi, so CSV
// parsing/serialization is implemented inline.

(function () {
    'use strict';

    var CSV_PATH = 'data/auction_lots.csv';
    var CSV_HEADER = ['event', 'event_date', 'auction_house', 'lot_number',
        'manufacturer', 'model', 'year_of_car', 'low_estimate_usd',
        'high_estimate_usd', 'sold_price_usd', 'sold', 'notes'];
    var APEX_THRESHOLD = 500000; // must match auction_rating.py / mai.py
    var LS_CONFIG = 'mii_admin_config';
    var LS_TOKEN = 'mii_admin_token';
    var LS_PENDING = 'mii_admin_pending';
    var LS_ANTHROPIC = 'mii_admin_anthropic_key';

    var CLAUDE_MODEL = 'claude-opus-4-8';

    // Structured-output schema for the results importer. Guarantees the
    // response parses into rows matching the auction_lots.csv columns.
    var EXTRACT_SCHEMA = {
        type: 'object',
        properties: {
            event: {
                type: 'object',
                properties: {
                    event_name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                    event_date: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'YYYY-MM-DD' },
                    auction_house: { anyOf: [{ type: 'string' }, { type: 'null' }] }
                },
                required: ['event_name', 'event_date', 'auction_house'],
                additionalProperties: false
            },
            lots: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        lot_number: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                        manufacturer: { type: 'string' },
                        model: { type: 'string' },
                        year_of_car: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
                        low_estimate_usd: { anyOf: [{ type: 'number' }, { type: 'null' }] },
                        high_estimate_usd: { anyOf: [{ type: 'number' }, { type: 'null' }] },
                        sold_price_usd: { anyOf: [{ type: 'number' }, { type: 'null' }] },
                        sold: { type: 'boolean' },
                        notes: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                        needs_review: { type: 'boolean' },
                        review_reason: { anyOf: [{ type: 'string' }, { type: 'null' }] }
                    },
                    required: ['lot_number', 'manufacturer', 'model', 'year_of_car',
                        'low_estimate_usd', 'high_estimate_usd', 'sold_price_usd',
                        'sold', 'notes', 'needs_review', 'review_reason'],
                    additionalProperties: false
                }
            }
        },
        required: ['event', 'lots'],
        additionalProperties: false
    };

    var EXTRACT_SYSTEM = [
        'You extract collector-car auction results from pasted web pages, PDFs, or press releases',
        'into structured rows for a market-analytics dataset. Rules:',
        '- Include only motor cars. Skip motorcycles, automobilia, memorabilia, watches, and non-vehicle lots.',
        '- Extract the event name, date (YYYY-MM-DD; if the sale spans several days use the final day), and auction house if present.',
        '- manufacturer is the marque only (e.g. "Ferrari"); model is the rest of the car name without the year',
        '  (e.g. "250 GT/L Berlinetta Lusso by Scaglietti" -> model "250 GT Lusso"). Keep models concise but unambiguous.',
        '- All monetary values in USD. If prices are in another currency, convert at a recent typical rate,',
        '  set needs_review=true and note the original amount and currency in review_reason.',
        '- Use the price as published by the house (usually including buyer\'s premium). If both hammer and',
        '  premium-inclusive prices are shown, use the premium-inclusive one. If it is ambiguous which is shown,',
        '  set needs_review=true and say so in review_reason.',
        '- sold=false for unsold / not-sold / reserve-not-met / withdrawn lots, with sold_price_usd=null.',
        '  Note a stated high bid or "withdrawn" in notes.',
        '- If estimates are unavailable ("Estimate upon request"), leave them null and flag needs_review.',
        '- Set needs_review=true whenever you are unsure about any value in a row; review_reason must say why.',
        '- Do not invent values. A field you cannot find is null.'
    ].join('\n');

    var config = loadJSON(LS_CONFIG) || { owner: 'matte36s50', repo: 'market-interest-score-app', branch: 'main' };
    var pending = loadJSON(LS_PENDING) || [];
    var importPdfFile = null;  // PDF attached to the results importer, if any
    var existingRows = null;   // parsed rows currently in the repo's CSV
    var existingSha = null;    // blob sha needed for the PUT

    // ---------- small helpers ----------

    function $(id) { return document.getElementById(id); }

    function loadJSON(key) {
        try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
    }

    function saveJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

    function token() { return localStorage.getItem(LS_TOKEN) || ''; }

    function anthropicKey() { return localStorage.getItem(LS_ANTHROPIC) || ''; }

    function fmtUSD(v) {
        var n = parseFloat(v);
        if (isNaN(n) || n <= 0) return '—';
        return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }

    // Duplicate key — must mirror sync_from_garage_draft.py:
    // event + manufacturer + model + year, case/whitespace-insensitive.
    function dupKey(r) {
        return [r.event, r.manufacturer, r.model, r.year_of_car].map(function (v) {
            return String(v == null ? '' : v).trim().toLowerCase();
        }).join('||');
    }

    function flash(el, text, kind) {
        el.textContent = text;
        el.classList.remove('hidden', 'text-emerald-400', 'text-red-400', 'text-zinc-500', 'text-amber-400');
        el.classList.add(kind === 'ok' ? 'text-emerald-400' : kind === 'err' ? 'text-red-400' : kind === 'warn' ? 'text-amber-400' : 'text-zinc-500');
    }

    // UTF-8 safe base64 for the Contents API.
    function b64encode(str) {
        var bytes = new TextEncoder().encode(str);
        var bin = '';
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    }

    function b64decode(b64) {
        var bin = atob(b64.replace(/\n/g, ''));
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder().decode(bytes);
    }

    // ---------- GitHub API ----------

    function apiUrl(path) {
        return 'https://api.github.com/repos/' + config.owner + '/' + config.repo + path;
    }

    function gh(path, options) {
        options = options || {};
        options.headers = Object.assign({
            'Accept': 'application/vnd.github+json',
            'Authorization': 'Bearer ' + token(),
            'X-GitHub-Api-Version': '2022-11-28'
        }, options.headers || {});
        return fetch(apiUrl(path), options);
    }

    // Fetch current CSV + sha. Falls back to the site-relative file (read-only)
    // when no token is configured, so the "existing data" panel still works on
    // the deployed site.
    function fetchExisting() {
        if (token()) {
            return gh('/contents/' + CSV_PATH + '?ref=' + encodeURIComponent(config.branch))
                .then(function (res) {
                    if (res.status === 404) return { content: null, sha: null };
                    if (!res.ok) throw new Error('GitHub API ' + res.status);
                    return res.json().then(function (j) {
                        return { content: b64decode(j.content), sha: j.sha };
                    });
                });
        }
        return fetch(CSV_PATH, { cache: 'no-store' }).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.text().then(function (t) { return { content: t, sha: null }; });
        });
    }

    // Minimal RFC-4180 CSV parser: quoted fields, escaped quotes, CRLF.
    function parseCsv(text) {
        if (!text) return [];
        var rows = [], row = [], field = '', inQ = false;
        for (var i = 0; i < text.length; i++) {
            var ch = text[i];
            if (inQ) {
                if (ch === '"') {
                    if (text[i + 1] === '"') { field += '"'; i++; }
                    else inQ = false;
                } else field += ch;
            } else if (ch === '"') {
                inQ = true;
            } else if (ch === ',') {
                row.push(field); field = '';
            } else if (ch === '\n' || ch === '\r') {
                if (ch === '\r' && text[i + 1] === '\n') i++;
                row.push(field); field = '';
                rows.push(row); row = [];
            } else {
                field += ch;
            }
        }
        if (field !== '' || row.length) { row.push(field); rows.push(row); }
        rows = rows.filter(function (r) {
            return r.some(function (c) { return String(c).trim() !== ''; });
        });
        if (rows.length < 2) return [];
        var header = rows[0].map(function (h) { return h.trim(); });
        return rows.slice(1).map(function (r) {
            var obj = {};
            header.forEach(function (h, idx) { obj[h] = r[idx] != null ? r[idx] : ''; });
            return obj;
        });
    }

    // ---------- existing-data panel ----------

    function refreshExisting() {
        $('existingSummary').textContent = 'Loading…';
        fetchExisting().then(function (r) {
            existingRows = parseCsv(r.content);
            existingSha = r.sha;
            renderExisting();
            renderPending(); // re-run duplicate highlighting
        }).catch(function (e) {
            existingRows = null;
            $('existingSummary').textContent = 'Could not load current CSV (' + e.message + ').';
        });
    }

    function renderExisting() {
        var el = $('existingSummary');
        if (!existingRows) { el.textContent = 'Not loaded.'; return; }
        if (!existingRows.length) {
            el.textContent = 'The file is empty — the lots you save here will be its first rows.';
            return;
        }
        var events = {};
        var apexCount = 0;
        existingRows.forEach(function (r) {
            events[r.event] = (events[r.event] || 0) + 1;
            if (parseFloat(r.low_estimate_usd) >= APEX_THRESHOLD) apexCount++;
        });
        var names = Object.keys(events);
        var recent = names.slice(-5).map(function (n) { return esc(n) + ' (' + events[n] + ' lots)'; }).join(' · ');
        el.innerHTML = '<span class="text-zinc-300 font-semibold">' + existingRows.length + ' lots</span> across ' +
            '<span class="text-zinc-300 font-semibold">' + names.length + ' events</span>, ' +
            '<span class="text-amber-400 font-semibold">' + apexCount + ' apex</span> (&ge;$500K low estimate).' +
            '<div class="mt-1 text-xs text-zinc-600">Latest events: ' + recent + '</div>';

        // Offer known event names for quick re-entry (resuming a multi-day sale).
        $('eventSuggestions').innerHTML = names.map(function (n) {
            return '<option value="' + esc(n) + '"></option>';
        }).join('');
    }

    // ---------- pending lots ----------

    function isDuplicate(row) {
        var key = dupKey(row);
        var inExisting = (existingRows || []).some(function (r) { return dupKey(r) === key; });
        var inPending = pending.filter(function (r) { return dupKey(r) === key; }).length > 1
            || (pending.indexOf(row) === -1 && pending.some(function (r) { return dupKey(r) === key; }));
        return inExisting || inPending;
    }

    function renderPending() {
        var body = $('pendingBody');
        $('pendingCount').textContent = '(' + pending.length + ')';
        $('pendingEmpty').classList.toggle('hidden', pending.length > 0);
        body.innerHTML = pending.map(function (r, i) {
            var isApex = parseFloat(r.low_estimate_usd) >= APEX_THRESHOLD;
            var dup = isDuplicate(r);
            var sold = String(r.sold) === 'true';
            return '<tr class="' + (dup ? 'bg-red-500/5' : '') + '">' +
                '<td class="px-4 py-2 text-zinc-400 text-xs">' + esc(r.event) + '<div class="text-zinc-600">' + esc(r.event_date) + '</div></td>' +
                '<td class="px-4 py-2 text-zinc-500">' + esc(r.lot_number || '—') + '</td>' +
                '<td class="px-4 py-2"><span class="text-zinc-200">' + esc(r.year_of_car) + ' ' + esc(r.manufacturer) + ' ' + esc(r.model) + '</span>' +
                    (dup ? '<div class="text-[10px] text-red-400 font-semibold uppercase mt-0.5">possible duplicate</div>' : '') +
                    (r._review ? '<div class="text-[10px] text-amber-400 mt-0.5" title="' + esc(r._reviewReason || '') + '">&#9888; review: ' + esc(r._reviewReason || 'check values') + '</div>' : '') + '</td>' +
                '<td class="px-4 py-2 text-right text-zinc-400">' + fmtUSD(r.low_estimate_usd) + '</td>' +
                '<td class="px-4 py-2 text-right text-zinc-400">' + fmtUSD(r.high_estimate_usd) + '</td>' +
                '<td class="px-4 py-2 text-right ' + (sold ? 'text-emerald-400' : 'text-zinc-600') + '">' + fmtUSD(r.sold_price_usd) + '</td>' +
                '<td class="px-4 py-2">' + (sold
                    ? '<span class="text-xs text-emerald-400">Sold</span>'
                    : '<span class="text-xs text-zinc-500">Not sold</span>') + '</td>' +
                '<td class="px-4 py-2">' + (isApex
                    ? '<span class="text-[10px] font-bold text-amber-400 border border-amber-500/40 bg-amber-500/10 rounded px-1.5 py-0.5">APEX</span>'
                    : '<span class="text-zinc-700 text-xs">—</span>') + '</td>' +
                '<td class="px-4 py-2 text-right"><button data-remove="' + i + '" class="text-zinc-600 hover:text-red-400 text-lg leading-none px-1" title="Remove">&times;</button></td>' +
                '</tr>';
        }).join('');
        saveJSON(LS_PENDING, pending);
    }

    function addLot() {
        var msg = $('lotMsg');
        var row = {
            event: $('evName').value.trim(),
            event_date: $('evDate').value,
            auction_house: $('evHouse').value.trim(),
            lot_number: $('lotNumber').value.trim(),
            manufacturer: $('lotMake').value.trim(),
            model: $('lotModel').value.trim(),
            year_of_car: $('lotYear').value.trim(),
            low_estimate_usd: $('lotLow').value.trim(),
            high_estimate_usd: $('lotHigh').value.trim(),
            sold_price_usd: $('lotSold').checked ? $('lotPrice').value.trim() : '',
            sold: $('lotSold').checked ? 'true' : 'false',
            notes: $('lotNotes').value.trim()
        };

        if (!row.event || !row.event_date || !row.auction_house) {
            flash(msg, 'Fill in the event name, date and auction house first (section 1).', 'err');
            return;
        }
        if (!row.manufacturer || !row.model || !row.year_of_car) {
            flash(msg, 'Manufacturer, model and year are required.', 'err');
            return;
        }
        if (row.sold === 'true' && !row.sold_price_usd) {
            flash(msg, 'Marked as sold but no sold price entered.', 'err');
            return;
        }

        pending.push(row);
        renderPending();

        if (isDuplicate(row)) {
            flash(msg, 'Added, but flagged as a possible duplicate (same event + car + year already exists).', 'warn');
        } else {
            flash(msg, 'Added: ' + row.year_of_car + ' ' + row.manufacturer + ' ' + row.model, 'ok');
        }

        // Clear the per-lot fields; event fields persist for the next lot.
        ['lotNumber', 'lotMake', 'lotModel', 'lotYear', 'lotLow', 'lotHigh', 'lotPrice', 'lotNotes'].forEach(function (id) {
            $(id).value = '';
        });
        $('lotSold').checked = true;
        updateApexBadge();
        $('lotMake').focus();
    }

    function updateApexBadge() {
        var low = parseFloat($('lotLow').value);
        $('apexBadge').classList.toggle('hidden', !(low >= APEX_THRESHOLD));
    }

    // ---------- CSV output ----------

    function csvField(v) {
        var s = String(v == null ? '' : v);
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    function rowsToCsvLines(rows) {
        return rows.map(function (r) {
            return CSV_HEADER.map(function (c) { return csvField(r[c]); }).join(',');
        }).join('\n');
    }

    function mergedCsv(existingText) {
        var base = (existingText || CSV_HEADER.join(',')).replace(/\s+$/, '');
        return base + '\n' + rowsToCsvLines(pending) + '\n';
    }

    function downloadCsv() {
        var doDownload = function (existingText) {
            var blob = new Blob([mergedCsv(existingText)], { type: 'text/csv' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'auction_lots.csv';
            a.click();
            URL.revokeObjectURL(a.href);
        };
        if (!pending.length) { flash($('saveMsg'), 'No pending lots to export.', 'err'); return; }
        fetchExisting().then(function (r) { doDownload(r.content); })
            .catch(function () { doDownload(null); });
    }

    // ---------- save to GitHub ----------

    function saveToGitHub(isRetry) {
        var msg = $('saveMsg');
        if (!pending.length) { flash(msg, 'No pending lots to save.', 'err'); return; }
        if (!token()) {
            flash(msg, 'No GitHub token configured — open "GitHub Connection" above, or use Download CSV.', 'err');
            $('settingsBody').classList.remove('hidden');
            return;
        }

        flash(msg, 'Saving ' + pending.length + ' lots to ' + config.owner + '/' + config.repo + '@' + config.branch + '…');
        $('btnSave').disabled = true;

        // Always re-fetch immediately before the PUT so the sha is fresh.
        fetchExisting().then(function (r) {
            existingRows = parseCsv(r.content);
            existingSha = r.sha;

            var events = {};
            pending.forEach(function (p) { events[p.event] = true; });
            var body = {
                message: 'data: add ' + pending.length + ' auction lots (' + Object.keys(events).join(', ') + ') via admin tab',
                content: b64encode(mergedCsv(r.content)),
                branch: config.branch
            };
            if (existingSha) body.sha = existingSha;

            return gh('/contents/' + CSV_PATH, { method: 'PUT', body: JSON.stringify(body) });
        }).then(function (res) {
            if (res.status === 409 && !isRetry) {
                // sha went stale between GET and PUT (e.g. the pipelines action
                // committed) — refetch once and retry.
                flash($('saveMsg'), 'File changed upstream, retrying…');
                $('btnSave').disabled = false;
                return saveToGitHub(true);
            }
            if (!res.ok) {
                return res.json().catch(function () { return {}; }).then(function (j) {
                    throw new Error('GitHub API ' + res.status + (j.message ? ': ' + j.message : ''));
                });
            }
            return res.json().then(function (j) {
                var saved = pending.length;
                pending = [];
                renderPending();
                refreshExisting();
                flash($('saveMsg'), 'Saved ' + saved + ' lots (commit ' + j.commit.sha.slice(0, 7) +
                    '). The MAI pipelines will run automatically; the dashboard chart updates after the next deploy.', 'ok');
            });
        }).catch(function (e) {
            flash($('saveMsg'), 'Save failed: ' + e.message + ' — your lots are still pending locally. You can retry or use Download CSV.', 'err');
        }).finally(function () {
            $('btnSave').disabled = false;
        });
    }

    // ---------- results importer (Claude API, direct from the browser) ----------

    // Streams POST /v1/messages and resolves with the accumulated text of the
    // response. Streaming keeps long extractions (150-lot sales) from hitting
    // request timeouts and lets us show a live lot counter.
    function streamClaude(body, onProgress) {
        return fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': anthropicKey(),
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true'
            },
            body: JSON.stringify(body)
        }).then(function (res) {
            if (!res.ok) {
                return res.json().catch(function () { return {}; }).then(function (j) {
                    var m = (j.error && j.error.message) || ('HTTP ' + res.status);
                    if (res.status === 401) m = 'Invalid Anthropic API key — check the connection panel.';
                    if (res.status === 429) m = 'Rate limited by the Claude API — wait a minute and retry.';
                    if (res.status === 529) m = 'Claude API is temporarily overloaded — retry shortly.';
                    throw new Error(m);
                });
            }
            var reader = res.body.getReader();
            var decoder = new TextDecoder();
            var buf = '', text = '', stopReason = null, apiError = null;

            function handleLine(line) {
                if (line.indexOf('data: ') !== 0) return;
                var data;
                try { data = JSON.parse(line.slice(6)); } catch (e) { return; }
                if (data.type === 'content_block_delta' && data.delta && data.delta.type === 'text_delta') {
                    text += data.delta.text;
                    if (onProgress) onProgress(text);
                } else if (data.type === 'message_delta' && data.delta && data.delta.stop_reason) {
                    stopReason = data.delta.stop_reason;
                } else if (data.type === 'error') {
                    apiError = (data.error && data.error.message) || 'stream error';
                }
            }

            function pump() {
                return reader.read().then(function (r) {
                    if (r.done) {
                        if (apiError) throw new Error(apiError);
                        if (stopReason === 'refusal') throw new Error('Claude declined to process this content.');
                        if (stopReason === 'max_tokens') throw new Error('Output truncated — paste a smaller portion of the results and import in parts.');
                        return text;
                    }
                    buf += decoder.decode(r.value, { stream: true });
                    var lines = buf.split('\n');
                    buf = lines.pop();
                    lines.forEach(handleLine);
                    return pump();
                });
            }
            return pump();
        });
    }

    function setPdf(file) {
        importPdfFile = file || null;
        $('pdfName').classList.toggle('hidden', !importPdfFile);
        $('pdfNameText').textContent = importPdfFile
            ? importPdfFile.name + ' (' + (importPdfFile.size / 1024 / 1024).toFixed(1) + ' MB)'
            : '';
    }

    // Read a File as bare base64 (no data: prefix) for the API's document block.
    function readFileB64(file) {
        return new Promise(function (resolve, reject) {
            var r = new FileReader();
            r.onload = function () { resolve(String(r.result).split(',')[1]); };
            r.onerror = function () { reject(new Error('Could not read the PDF file.')); };
            r.readAsDataURL(file);
        });
    }

    // Builds the user-turn content: pasted text, an attached PDF (sent as a
    // native document block, so scanned pages are read visually), or both.
    function buildImportContent(pasted) {
        if (!importPdfFile) {
            return Promise.resolve('Extract the auction results from this pasted page:\n\n' + pasted);
        }
        if (importPdfFile.size > 30 * 1024 * 1024) {
            return Promise.reject(new Error('PDF is larger than 30 MB — split it or paste the text instead.'));
        }
        return readFileB64(importPdfFile).then(function (b64) {
            return [
                { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
                {
                    type: 'text',
                    text: 'Extract the auction results from the attached PDF.' +
                        (pasted ? ' Additional pasted context/results follow:\n\n' + pasted : '')
                }
            ];
        });
    }

    function importResults() {
        var msg = $('importMsg');
        var pasted = $('importText').value.trim();
        if (!pasted && !importPdfFile) { flash(msg, 'Paste the copied results page or attach a PDF first.', 'err'); return; }
        if (!anthropicKey()) {
            flash(msg, 'No Anthropic API key configured — add one in the GitHub Connection panel above.', 'err');
            $('settingsBody').classList.remove('hidden');
            return;
        }

        $('btnImport').disabled = true;
        flash(msg, importPdfFile ? 'Reading PDF…' : 'Extracting…');

        buildImportContent(pasted).then(function (content) {
            return streamClaude({
                model: CLAUDE_MODEL,
                max_tokens: 64000,
                stream: true,
                thinking: { type: 'adaptive' },
                system: EXTRACT_SYSTEM,
                output_config: { format: { type: 'json_schema', schema: EXTRACT_SCHEMA } },
                messages: [{ role: 'user', content: content }]
            }, function (partial) {
                var n = (partial.match(/"manufacturer"/g) || []).length;
                flash(msg, 'Extracting… ' + n + ' lots so far');
            });
        }).then(function (text) {
            var parsed = JSON.parse(text);
            var ev = parsed.event || {};

            // Section-1 values win; blanks are prefilled from the extraction.
            if (!$('evName').value.trim() && ev.event_name) $('evName').value = ev.event_name;
            if (!$('evDate').value && ev.event_date) $('evDate').value = ev.event_date;
            if (!$('evHouse').value.trim() && ev.auction_house) $('evHouse').value = ev.auction_house;

            var evName = $('evName').value.trim();
            var evDate = $('evDate').value;
            var evHouse = $('evHouse').value.trim();
            if (!evName || !evDate || !evHouse) {
                flash(msg, 'Extracted ' + (parsed.lots || []).length + ' lots, but the event name/date/house could not be determined — fill in section 1 and press Extract again.', 'err');
                return;
            }

            var flagged = 0;
            (parsed.lots || []).forEach(function (l) {
                if (l.needs_review) flagged++;
                pending.push({
                    event: evName,
                    event_date: evDate,
                    auction_house: evHouse,
                    lot_number: l.lot_number || '',
                    manufacturer: l.manufacturer || '',
                    model: l.model || '',
                    year_of_car: l.year_of_car != null ? String(l.year_of_car) : '',
                    low_estimate_usd: l.low_estimate_usd != null ? String(Math.round(l.low_estimate_usd)) : '',
                    high_estimate_usd: l.high_estimate_usd != null ? String(Math.round(l.high_estimate_usd)) : '',
                    sold_price_usd: l.sold_price_usd != null ? String(Math.round(l.sold_price_usd)) : '',
                    sold: l.sold ? 'true' : 'false',
                    notes: l.notes || '',
                    _review: !!l.needs_review,
                    _reviewReason: l.review_reason || ''
                });
            });
            renderPending();
            $('importText').value = '';
            $('importPdf').value = '';
            setPdf(null);
            flash(msg, 'Imported ' + (parsed.lots || []).length + ' lots' +
                (flagged ? ' — ' + flagged + ' flagged for review (amber rows below)' : '') +
                '. Review the pending table, then Save to GitHub.', flagged ? 'warn' : 'ok');
        }).catch(function (e) {
            flash(msg, 'Import failed: ' + e.message, 'err');
        }).finally(function () {
            $('btnImport').disabled = false;
        });
    }

    // ---------- connection settings ----------

    function setConnStatus(text, ok) {
        var el = $('connStatus');
        el.textContent = text;
        el.className = 'text-xs px-3 py-1.5 rounded-lg border ' + (ok
            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
            : 'border-zinc-700 bg-zinc-800 text-zinc-500');
    }

    function testConnection() {
        var msg = $('settingsMsg');
        config.owner = $('cfgOwner').value.trim() || config.owner;
        config.repo = $('cfgRepo').value.trim() || config.repo;
        config.branch = $('cfgBranch').value.trim() || config.branch;
        saveJSON(LS_CONFIG, config);
        var t = $('cfgToken').value.trim();
        if (t) localStorage.setItem(LS_TOKEN, t);
        var ak = $('cfgAnthropicKey').value.trim();
        if (ak) localStorage.setItem(LS_ANTHROPIC, ak);

        if (!token()) { flash(msg, 'Enter a token first.', 'err'); return; }
        flash(msg, 'Testing…');
        gh('/contents/' + CSV_PATH + '?ref=' + encodeURIComponent(config.branch))
            .then(function (res) {
                if (res.ok || res.status === 404) {
                    flash(msg, 'Connected. Token can read ' + config.owner + '/' + config.repo + '@' + config.branch + '.', 'ok');
                    setConnStatus('Connected: ' + config.owner + '/' + config.repo + '@' + config.branch, true);
                    refreshExisting();
                } else {
                    throw new Error('GitHub API ' + res.status);
                }
            })
            .catch(function (e) {
                flash(msg, 'Connection failed: ' + e.message, 'err');
                setConnStatus('Not connected', false);
            });
    }

    function forgetToken() {
        localStorage.removeItem(LS_TOKEN);
        localStorage.removeItem(LS_ANTHROPIC);
        $('cfgToken').value = '';
        $('cfgAnthropicKey').value = '';
        setConnStatus('Not connected', false);
        flash($('settingsMsg'), 'GitHub token and Anthropic API key removed from this browser.', 'ok');
    }

    // ---------- wire-up ----------

    $('cfgOwner').value = config.owner;
    $('cfgRepo').value = config.repo;
    $('cfgBranch').value = config.branch;

    $('settingsToggle').addEventListener('click', function () {
        var body = $('settingsBody');
        body.classList.toggle('hidden');
        $('settingsChevron').innerHTML = body.classList.contains('hidden') ? '&#9662;' : '&#9652;';
    });
    $('btnConnect').addEventListener('click', testConnection);
    $('btnForget').addEventListener('click', forgetToken);
    $('btnImport').addEventListener('click', importResults);
    $('importPdf').addEventListener('change', function () { setPdf(this.files[0]); });
    $('pdfClear').addEventListener('click', function () { $('importPdf').value = ''; setPdf(null); });
    $('btnAddLot').addEventListener('click', addLot);
    $('btnSave').addEventListener('click', function () { saveToGitHub(false); });
    $('btnDownload').addEventListener('click', downloadCsv);
    $('btnRefreshExisting').addEventListener('click', refreshExisting);
    $('lotLow').addEventListener('input', updateApexBadge);
    $('pendingBody').addEventListener('click', function (e) {
        var idx = e.target.getAttribute && e.target.getAttribute('data-remove');
        if (idx != null) { pending.splice(+idx, 1); renderPending(); }
    });

    // Enter anywhere in the lot fields adds the lot.
    ['lotNumber', 'lotMake', 'lotModel', 'lotYear', 'lotLow', 'lotHigh', 'lotPrice', 'lotNotes'].forEach(function (id) {
        $(id).addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addLot(); } });
    });

    // Initial state
    renderPending();
    if (token()) {
        setConnStatus('Connected: ' + config.owner + '/' + config.repo + '@' + config.branch, true);
        refreshExisting();
    } else {
        $('settingsBody').classList.remove('hidden');
        $('settingsChevron').innerHTML = '&#9652;';
        refreshExisting(); // still try read-only via the site-relative file
    }
})();
