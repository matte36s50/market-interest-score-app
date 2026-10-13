// HAGI BMW Classic Index (BMW CI) constituents.
//
// Source: "Constituents analysis BMW CI" (the launch list, unchanged since
// 2022 per D. Hatlapa, March 2026) plus the E46 M3, added by the index
// committee in 2026. Each constituent maps to the Bring a Trailer model
// group(s) the MII data files it under. BaT groups by chassis, not by trim,
// so a few constituents can only be matched to a wider group: those carry an
// `approx` note, and the dashboard says so wherever it shows them.
//
// To change the index, edit this list; every BMW CI view on the overview
// page reads from it.
(function (global) {
    'use strict';

    var CONSTITUENTS = [
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
    ];

    var MAKE = 'bmw';
    var byModel = {};
    CONSTITUENTS.forEach(function (c) {
        c.models.forEach(function (m) { byModel[m.toLowerCase()] = c; });
    });

    // The constituent a make/model row belongs to, or null.
    function constituentFor(make, model) {
        if (String(make || '').toLowerCase() !== MAKE) return null;
        return byModel[String(model || '').toLowerCase()] || null;
    }

    global.BMW_CI = {
        NAME: 'HAGI BMW Classic Index',
        SHORT: 'BMW CI',
        CONSTITUENTS: CONSTITUENTS,
        constituentFor: constituentFor,
        isConstituent: function (make, model) { return !!constituentFor(make, model); },
    };
})(typeof window !== 'undefined' ? window : this);
