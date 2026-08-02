/* ============================================================================
   deck-nav.js — navigation + progress HUD for an aios-deck deck.
   Version: 1.0.0

   Pair with deck-base.css + one theme. Reference it once, at the end of <body>:

     <script src="deck-nav.js"></script>

   Zero dependencies, no globals, no build step. It is copied into every deck
   folder because a handover deck is opened from file:// and must be entirely
   self-contained (reference/gotchas.md #13).

   What it does
     - keeps #progress in sync with the slide actually on screen
     - arrow-key / PageUp / PageDown / Home / End navigation
     - remembers where you were, per deck, in sessionStorage
     - honours prefers-reduced-motion
     - ?print / #print starts at slide 1 (used by scripts/deck-pdf.mjs)

   What it deliberately does NOT do
     - CLICK-TO-ADVANCE. An earlier deck shipped it and it caused errant
       navigation: stray clicks on links, on screenshots, and the mouse-up that
       ends a text selection all fired a slide change mid-sentence. Arrow keys
       only. Do not "improve" this by adding a click handler.
     - Simulated key dispatch for programmatic moves. Synthetic key presses
       against a CSS scroll-snap container silently no-op roughly every other
       press (gotcha #8). Every move here goes through scrollIntoView().
   ========================================================================== */
(function () {
  'use strict';

  /* The browser restores the old scroll offset on reload, which lands you
     mid-snap between two slides. We own the restore instead (see below). */
  try {
    if (window.history && 'scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual';
    }
  } catch (err) { /* file:// in some browsers throws on history access */ }

  var deck = document.getElementById('deck');
  if (!deck) return;

  var slides = Array.prototype.slice.call(deck.querySelectorAll('.slide'));
  if (!slides.length) return;

  var progress = document.getElementById('progress') ||
    document.querySelector('.progress');

  var STORE_KEY = 'deck-nav:' + (deck.dataset && deck.dataset.deckId
    ? deck.dataset.deckId
    : window.location.pathname);

  /* ?print / #print — deck-pdf.mjs appends it so an export always begins at
     slide 1 regardless of where the last reader left off. */
  var PRINT_MODE = String(window.location.search).indexOf('print') !== -1 ||
    String(window.location.hash).indexOf('print') !== -1;

  /* Read the remembered slide ONCE, up front. Anything below that calls render()
     writes to the same key, so reading it later reads back today's 0. */
  var SAVED = (function () {
    try {
      var raw = window.sessionStorage.getItem(STORE_KEY);
      var n = raw === null ? NaN : parseInt(raw, 10);
      return isNaN(n) ? -1 : n;
    } catch (err) { return -1; }
  }());

  function reducedMotion() {
    return !!(window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* The slide closest to the container's origin. Summing the absolute top and
     left offsets makes this correct for a vertical deck AND for a horizontal
     one (.deck--horizontal), where only the left offset moves. */
  function currentIndex() {
    var best = 0;
    var bestDist = Infinity;
    for (var i = 0; i < slides.length; i++) {
      var r = slides[i].getBoundingClientRect();
      var d = Math.abs(r.top) + Math.abs(r.left);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  }

  function render() {
    var i = currentIndex();
    if (progress) progress.textContent = (i + 1) + ' / ' + slides.length;
    try { window.sessionStorage.setItem(STORE_KEY, String(i)); } catch (err) { /* private mode */ }
    return i;
  }

  function go(i, instant) {
    if (i < 0 || i >= slides.length) return;
    slides[i].scrollIntoView({
      behavior: (instant || reducedMotion()) ? 'auto' : 'smooth',
      block: 'start',
      inline: 'start'
    });
    /* Update immediately so the HUD never lags a smooth scroll. */
    if (progress) progress.textContent = (i + 1) + ' / ' + slides.length;
    try { window.sessionStorage.setItem(STORE_KEY, String(i)); } catch (err) { /* ignore */ }
  }

  /* ---------------------------------------------------------------- scroll */
  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(function () { ticking = false; render(); });
  }
  deck.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });

  /* ------------------------------------------------------------- keyboard */
  var NEXT = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, Right: 1, Down: 1 };
  var PREV = { ArrowLeft: 1, ArrowUp: 1, PageUp: 1, Left: 1, Up: 1 };

  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (t.isContentEditable ||
      /^(input|textarea|select)$/i.test(t.tagName || ''))) return;

    var i = currentIndex();
    if (NEXT[e.key]) { e.preventDefault(); go(i + 1); }
    else if (PREV[e.key]) { e.preventDefault(); go(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); go(0, true); }
    else if (e.key === 'End') { e.preventDefault(); go(slides.length - 1, true); }
  });

  /* --------------------------------------------------------------- restore */
  function restore() {
    if (!PRINT_MODE && SAVED > 0 && SAVED < slides.length) {
      go(SAVED, true);        /* instant — a smooth restore reads as a glitch */
    } else {
      go(0, true);
    }
    render();
  }

  if (document.readyState === 'complete') {
    window.requestAnimationFrame(restore);
  } else {
    window.addEventListener('load', function () {
      window.requestAnimationFrame(restore);
    });
  }
  render();
}());
