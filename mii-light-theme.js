// Shared Tailwind config for the light MII pages (index.html, mai.html).
// Load after the Tailwind CDN script and before any markup renders.
tailwind.config = {
    theme: {
        extend: {
            colors: {
                canvas: '#F6F6F3',
                line: '#E4E4DF',
                hair: '#ECECE7',
                ink: '#16181D',
                mute: '#5E6168',
                faint: '#6B6E75',
                up: '#1F7A45',
                down: '#B42318',
            },
            fontFamily: {
                sans: ['"Hanken Grotesk"', 'system-ui', 'sans-serif'],
                mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
            },
        },
    },
};

// Chart.js palette shared by every chart on the light pages.
window.MII_THEME = {
    amber: '#F59E0B',
    amberText: '#B45309',
    ink: '#16181D',
    mute: '#5E6168',
    faint: '#6B6E75',
    grid: '#ECECE7',
    line: '#E4E4DF',
    neutral: '#C9CAC4',
    up: '#1F7A45',
    down: '#B42318',
    series: ['#F59E0B', '#16181D', '#2563EB', '#0F766E'],
    tooltip: {
        backgroundColor: '#16181D',
        titleColor: '#FFFFFF',
        bodyColor: '#E4E4DF',
        borderWidth: 0,
        padding: 10,
        cornerRadius: 6,
        displayColors: false,
    },
};
if (window.Chart) {
    Chart.defaults.font.family = '"Hanken Grotesk", system-ui, sans-serif';
    Chart.defaults.color = '#6B6E75';
}
