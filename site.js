// Header actions for the pages other than the overview (which wires its own in
// app.js): theme toggle, share link, print to PDF.
(function () {
    'use strict';

    function effectiveTheme() {
        var set = document.documentElement.dataset.theme;
        if (set) return set;
        return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    function toast(message) {
        var el = document.getElementById('toast');
        if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
        el.textContent = message;
        el.classList.add('show');
        clearTimeout(toast.timer);
        toast.timer = setTimeout(function () { el.classList.remove('show'); }, 2200);
    }

    document.addEventListener('DOMContentLoaded', function () {
        var theme = document.getElementById('themeToggle');
        if (theme) theme.addEventListener('click', function () {
            var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
            document.documentElement.dataset.theme = next;
            try { localStorage.setItem('mii-theme', next); } catch (e) {}
            // Charts take their colours when drawn; a page with any redraws itself.
            if (document.querySelector('canvas')) location.reload();
        });

        var share = document.getElementById('shareBtn');
        if (share) share.addEventListener('click', function () {
            var url = location.href;
            if (navigator.share && window.matchMedia && matchMedia('(pointer: coarse)').matches) {
                navigator.share({ title: document.title, url: url }).catch(function () {});
                return;
            }
            if (navigator.clipboard) {
                navigator.clipboard.writeText(url).then(function () { toast('Link copied'); }, function () { window.prompt('Copy this link', url); });
            } else {
                window.prompt('Copy this link', url);
            }
        });

        var print = document.getElementById('printBtn');
        if (print) print.addEventListener('click', function () { window.print(); });
    });
})();
