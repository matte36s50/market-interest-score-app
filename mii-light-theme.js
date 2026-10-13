// Shared Tailwind config and chart palette for the pages built with Tailwind
// (Apex Index, Model comparison, Data analysis, Admin). Load after the
// Tailwind CDN script and before any markup renders.
//
// Every colour resolves to a token in site.css, so these pages follow the same
// light and dark themes as the overview. The *-rgb channels let Tailwind's
// opacity modifiers (bg-canvas/95, ring-amber-500/50) work in both themes.
(function () {
    'use strict';

    // Apply a saved theme before first paint.
    try { var saved = localStorage.getItem('mii-theme'); if (saved) document.documentElement.dataset.theme = saved; } catch (e) {}

    var v = function (name) { return 'rgb(var(--' + name + '-rgb) / <alpha-value>)'; };
    var fixed = function (name, a) { return 'rgb(var(--' + name + '-rgb) / ' + a + ')'; };

    tailwind.config = {
        theme: {
            extend: {
                colors: {
                    canvas: v('page'),
                    white: v('surface'),
                    line: v('line'),
                    hair: v('hair'),
                    ink: v('ink'),
                    mute: v('muted'),
                    faint: v('faint'),
                    up: v('up'),
                    down: v('down'),
                    amber: { 50: fixed('accent', 0.08), 100: fixed('accent', 0.14), 200: fixed('accent', 0.3), 500: v('accent'), 600: v('accent'), 700: v('accent-ink') },
                    red: { 50: fixed('down', 0.08), 200: fixed('down', 0.35), 500: v('down'), 700: v('down') },
                    green: { 50: fixed('up', 0.08), 200: fixed('up', 0.35), 500: v('up'), 700: v('up') },
                    blue: { 700: v('ci-ink') }
                },
                fontFamily: {
                    sans: ['"Hanken Grotesk"', 'system-ui', 'sans-serif'],
                    mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace']
                }
            }
        }
    };

    // Chart palette, resolved from the tokens of the theme in force when the
    // page loads (canvas cannot read CSS variables). Switching theme reloads
    // pages that draw charts, so these never go stale.
    function token(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
    function isDark() {
        var set = document.documentElement.dataset.theme;
        return set ? set === 'dark' : window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
    }
    function hexToRgba(hex, a) {
        var h = String(hex).replace('#', '');
        if (h.length !== 6) return hex;
        return 'rgba(' + parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ',' + parseInt(h.slice(4, 6), 16) + ',' + a + ')';
    }
    // Validated categorical palette (dataviz reference, both modes). Assign in
    // order, never cycled past eight.
    var SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
    var SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

    function build() {
        var dark = isDark();
        var t = {
            dark: dark,
            ink: token('--ink') || '#111216',
            ink2: token('--ink-2') || '#474a52',
            muted: token('--muted') || '#6a6d74',
            grid: token('--grid') || '#ecebe5',
            line: token('--line') || '#d6d5ce',
            surface: token('--surface') || '#ffffff',
            accent: token('--accent') || '#eb6834',
            accentInk: token('--accent-ink') || '#b5461b',
            up: token('--up') || '#157a3c',
            down: token('--down') || '#c03030',
            neutral: dark ? '#6b6e75' : '#a3a5aa',
            series: dark ? SERIES_DARK : SERIES_LIGHT,
            alpha: hexToRgba
        };
        // Older names some scripts still read.
        t.amber = t.accent; t.amberText = t.accentInk; t.faint = t.muted; t.mute = t.ink2;
        t.tooltip = { backgroundColor: '#111216', titleColor: '#f4f3ef', bodyColor: '#d6d5ce', borderWidth: 0, padding: 10, cornerRadius: 8, displayColors: false };
        return t;
    }

    // Built on every read: cheap, and never stale if read before site.css applies.
    Object.defineProperty(window, 'SITE_THEME', { get: build });
    Object.defineProperty(window, 'MII_THEME', { get: function () { return window.SITE_THEME; } });

    if (window.Chart) {
        Chart.defaults.font.family = '"Hanken Grotesk", system-ui, sans-serif';
        document.addEventListener('DOMContentLoaded', function () { Chart.defaults.color = window.SITE_THEME.muted; });
    }
})();
