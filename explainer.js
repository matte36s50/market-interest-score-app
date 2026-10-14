// The two-minute MII and Apex explainer video. Any [data-explainer] element
// opens it in a dialog; data-start (seconds) jumps to a chapter, e.g. 70 for
// Part 2, the Apex Index. It starts muted (the volume control turns the music
// on), nothing is downloaded until someone asks for it, and each link's href
// points at the file itself, so it still works without scripts.
(function () {
    'use strict';

    var SRC = 'media/mii-explainer.mp4?v=2';
    var POSTER = 'media/mii-explainer-poster.jpg';
    var dialog, video;

    function build() {
        dialog = document.createElement('dialog');
        dialog.className = 'explainer';
        dialog.setAttribute('aria-label', 'Market Interest Index explainer video');
        dialog.innerHTML =
            '<button type="button" class="explainer-close" aria-label="Close video">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>' +
            '</button>' +
            '<video controls playsinline muted preload="none" poster="' + POSTER + '">' +
            '<source src="' + SRC + '" type="video/mp4"></video>';
        document.body.appendChild(dialog);
        video = dialog.querySelector('video');
        // Muted by default; a viewer who turns the sound on keeps it on for
        // the rest of the visit.
        video.muted = true;
        video.defaultMuted = true;
        dialog.querySelector('.explainer-close').addEventListener('click', function () { dialog.close(); });
        // A click on the backdrop lands on the dialog itself.
        dialog.addEventListener('click', function (e) { if (e.target === dialog) dialog.close(); });
        dialog.addEventListener('close', function () { video.pause(); });
    }

    function open(start) {
        if (!dialog) build();
        dialog.showModal();
        if (start) {
            if (video.readyState >= 1) video.currentTime = start;
            else video.addEventListener('loadedmetadata', function () { video.currentTime = start; }, { once: true });
        } else if (video.ended) {
            video.currentTime = 0;
        }
        var playing = video.play();
        if (playing && playing.catch) playing.catch(function () {});
    }

    document.addEventListener('click', function (e) {
        var trigger = e.target.closest && e.target.closest('[data-explainer]');
        if (!trigger || typeof HTMLDialogElement === 'undefined') return;
        e.preventDefault();
        open(parseFloat(trigger.getAttribute('data-start')) || 0);
    });
})();
