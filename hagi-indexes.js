// HAGI index constituents: the BMW Classic Index (BMW CI), the MBCI
// (collectors' Mercedes-Benz) and the MBCI Emerging Classics.
//
// Sources: the BMW CI is the "Constituents analysis BMW CI" launch list
// (unchanged since 2022 per D. Hatlapa, March 2026) plus the E46 M3, added by
// the index committee in 2026. The MBCI and MBCI Emerging lists are HAGI's
// published tables (HAGI MBCI Index 2012). data/variants.csv names the same
// cars one listing at a time for the pipelines.
//
// Each constituent maps to the Bring a Trailer model group(s) the MII data
// files it under. BaT groups by chassis, not by trim, so some constituents
// can only be matched to a wider group. We match one to a wider group only
// when at least a third of that group's listings are the constituent (by
// data/variants.csv); those carry an `approx` note, and the dashboard says so
// wherever it shows them. Below a third, the group's attention would be
// mostly other cars', so the constituent is shown as not measured separately.
//
// `count` is how many rows of HAGI's table a card stands for, where BaT files
// several (the 230SL, 250SL and 280SL are one W113 SL group). Counts add up
// to the size of the published index.
//
// To change an index, edit this list; every index view on the overview page
// reads from it.
(function (global) {
    'use strict';

    var NOT_OFFERED = 'Not offered on Bring a Trailer in the data window';

    var INDEXES = [
        {
            id: 'bmw-ci',
            name: 'HAGI BMW Classic Index',
            short: 'BMW CI',
            make: 'BMW',
            source: 'Constituents per the HAGI BMW CI committee list (launch list, plus the E46 M3 added in 2026).',
            constituents: [
                { id: '328',    name: '328',                     years: '1936–40', models: [],
                  note: 'Pre-war; no Bring a Trailer sales in the data window' },
                { id: '507',    name: '507',                     years: '1956–59', models: ['507'],
                  note: 'Too rare on Bring a Trailer to score' },
                { id: '503',    name: '503 Coupé & Cabriolet',   years: '1956–59', models: ['503'] },
                { id: '2002',   name: '2002 ti, tii & Turbo',    years: '1968–75', models: ['2002ti', '2002tii', '2002 Turbo'] },
                { id: 'e9',     name: 'E9 CS, CSi & CSL',        years: '1968–75', models: ['E9 Coupe'] },
                { id: 'm1',     name: 'M1',                      years: '1978–81', models: ['M1'] },
                { id: 'e24',    name: 'E24 635CSi & M635CSi',    years: '1978–89', models: ['E24 6-Series', 'E24 M6 & M635CSi'],
                  approx: 'BaT files the 635CSi with the other E24 6-Series trims' },
                { id: '323i',   name: '323i (E21, E30)',         years: '1978–86', models: ['E21 3-Series'],
                  approx: 'Matched to the E21 3-Series group; BaT does not separate the 323i' },
                { id: 'e30m3',  name: 'E30 M3',                  years: '1986–91', models: ['E30 M3'] },
                { id: 'z1',     name: 'Z1',                      years: '1989–91', models: ['Z1'] },
                { id: 'e28m5',  name: 'E28 M5',                  years: '1985–88', models: ['E28 M5'] },
                { id: 'e31',    name: '8 Series V12 (E31)',      years: '1990–99', models: ['E31 8-Series'],
                  approx: 'The E31 group also includes the V8 840Ci' },
                { id: 'z3m',    name: 'Z3 M Roadster & Coupé',   years: '1998–02', models: ['Z3 M Roadster', 'Z3 M Coupe'] },
                { id: 'z8',     name: 'Z8',                      years: '2000–03', models: ['Z8'] },
                { id: 'e46m3',  name: 'E46 M3',                  years: '2000–06', models: ['E46 M3'], added: '2026' },
                { id: 'z4m',    name: 'Z4 M Coupé (E86)',        years: '2006–08', models: ['Z4 M Coupe'] },
            ],
        },
        {
            id: 'mbci',
            name: 'HAGI MBCI',
            short: 'MBCI',
            make: 'Mercedes-Benz',
            source: "Constituents per HAGI's MBCI table (collectors' Mercedes-Benz, 23 cars).",
            constituents: [
                { id: 's-ssk',     name: 'S, SS & SSK (W06)',                   years: '1926–32', models: [], note: NOT_OFFERED },
                { id: '320',       name: '290 & 320 Cabriolet A, Roadster',     years: '1933–38', models: ['320 CABRIOLET A'] },
                { id: '500k',      name: '500K & 540K (W29)',                   years: '1934–39', models: [], count: 3,
                  note: 'Cabriolet A, B and C, Roadster and Special Roadster. ' + NOT_OFFERED },
                { id: '170v',      name: '170V Roadster, Cabriolet A & Tourer', years: '1936–42', models: [], note: NOT_OFFERED },
                { id: '220-cab-a', name: '220 Cabriolet A (W187)',              years: '1951–55', models: ['W187 220'],
                  approx: 'Matched to the W187 220 group, which is mostly Cabriolet As' },
                { id: '300-open',  name: '300 & 300d Cabriolet D, 300S & 300Sc', years: '1951–62', models: ['W186, W188, & W189 Adenauer'], count: 4,
                  approx: 'Matched to the Adenauer group; about half its listings are these cars, the rest saloons' },
                { id: '190sl',     name: '190SL (W121)',                        years: '1955–63', models: ['190SL'] },
                { id: 'ponton-cab', name: '220S & 220SE Cabriolet',             years: '1956–60', models: [], count: 2,
                  note: 'Bring a Trailer files them with the Ponton saloons, so they are not measured separately' },
                { id: '300sl',     name: '300SL Coupé, Alloy Coupé & Roadster', years: '1954–63', models: ['300SL Gullwing & Roadster'], count: 3 },
                { id: 'w113',      name: '230SL, 250SL & 280SL (W113)',         years: '1963–71', models: ['W113 SL'], count: 3 },
                { id: '600',       name: '600 & Pullman (W100)',                years: '1963–81', models: ['600'] },
                { id: '280se35',   name: '280SE 3.5 Cabriolet & Coupé (W111)',  years: '1969–71', models: ['W111 Coupe & Cabriolet'], count: 2,
                  approx: 'Matched to the W111 coupé and cabriolet group, about a third of which is 3.5s' },
            ],
        },
        {
            id: 'mbci-emerging',
            name: 'HAGI MBCI Emerging Classics',
            short: 'MBCI Emerging',
            make: 'Mercedes-Benz',
            source: "Constituents per HAGI's MBCI Emerging Classics table (6 cars).",
            constituents: [
                { id: '300sel63', name: '300SEL 6.3 (W109)',          years: '1968–72', models: [],
                  note: 'Filed with the W108 and W109 saloons, so it is not measured separately' },
                { id: '450sel69', name: '450SEL 6.9 (W116)',          years: '1975–80', models: ['450SEL 6.9'] },
                { id: '500sl',    name: '500SL (R107)',               years: '1980–89', models: [],
                  note: 'Filed with the other R107 SLs, almost all US 380, 450 and 560SLs, so it is not measured separately' },
                { id: 'evo2',     name: '190E 2.5-16 Evolution II',   years: '1990',    models: [],
                  note: 'Filed with the 190E 2.3-16 and 2.5-16, so it is not measured separately' },
                { id: 'e500',     name: '500E & E500 (W124)',         years: '1991–95', models: ['500E & E500'] },
                { id: '300ce24',  name: '300CE-24 Cabriolet (A124)',  years: '1992–93', models: ['A124 300CE Cabriolet', '300CE CABRIOLET'] },
            ],
        },
    ];

    var byId = {};
    var byModel = {};
    INDEXES.forEach(function (index) {
        byId[index.id] = index;
        index.size = 0;
        index.constituents.forEach(function (c) {
            c.index = index;
            c.count = c.count || 1;
            index.size += c.count;
            c.models.forEach(function (m) {
                var key = index.make.toLowerCase() + '|' + m.toLowerCase();
                if (!byModel[key]) byModel[key] = c;
            });
        });
    });

    // The constituent a make/model row belongs to (its `index` says which), or null.
    function constituentFor(make, model) {
        return byModel[String(make || '').toLowerCase() + '|' + String(model || '').toLowerCase()] || null;
    }

    global.HAGI_INDEXES = {
        INDEXES: INDEXES,
        byId: function (id) { return byId[id] || null; },
        constituentFor: constituentFor,
    };
})(typeof window !== 'undefined' ? window : this);
