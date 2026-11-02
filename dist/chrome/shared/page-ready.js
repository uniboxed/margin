// When a page loading is worth showing: once it has painted something of its
// own, not once it has loaded. Safari's log of restored tabs (2026-11-02): a
// page's first visually non-empty layout came a median 0.55 s after it was
// first selected, its load event a median 4.2 s after; waiting for the load
// held back a median 2.3 s of page that was already painted, and most pages
// were shown still loading anyway, at the time limit. Plain Safari, in the
// same log, showed such tabs at their first layout (281–1331 ms, median 600).
//
// 'painted': the document is parsed (readyState past 'loading', so the page
// isn't a few lines of its head), the browser has a first contentful paint
// for it, and something of the page's own is drawn in view: text, a loaded
// image, an svg, a canvas, a video or a field inside <body>, laid out, in the
// window and not hidden by its styles. The paint alone isn't enough: Margin's
// own UI is in the page's document (its sidebar, drawn in a page loading
// hidden when it's kept open; the switch cover's spinner), outside <body>, and
// counts for the browser's first contentful paint too. In the WebKit host, an
// app's page whose body stays empty until its script fills it 0.7 s later had
// its first contentful paint at 54 ms, Margin's, and was shown then, empty
// (the host's `shelllate`, `shellcover`, `shellbehind`). 'loaded': its load
// event. 'timeout': neither within `ms`. 'blank': the empty document a tab
// starts with, or one Margin's script reached before the real one committed
// (asked again: background/tabs.js untilPainted).
//
// WebKit records the first contentful paint of a page loading hidden (behind
// the page, in the WebKit host: 'first-contentful-paint' about 180 ms after
// its load started, while hidden); Chrome paints nothing for a hidden page and
// records none, so the background asks only in Safari (platform.hiddenPaints).
// The page's content is looked at as it changes, at most every LOOK_MS (a look
// lays the page out if it has changed since it last was, as its next
// rendering update would).
//
// Self-contained: scripting.executeScript sends only its source (run in
// Margin's isolated world, which sees the page's document and timeline; no
// element is added to the page). content/core.js calls it directly too.
/** @param {number} ms @returns {Promise<'painted' | 'loaded' | 'timeout' | 'blank'>} */
export function readyInPage(ms) {
  return new Promise((resolve) => {
    if (/^about:/.test(location.href)) return resolve('blank');
    const LOOK_MS = 50;
    const NODES_MAX = 4000; // a page with that much in it has something to show
    const SKIP = new Set(['script', 'style', 'noscript', 'template']);
    const DRAWN = new Set(['img', 'svg', 'canvas', 'video', 'input', 'textarea', 'select']);
    /** @type {(() => void)[]} */
    const undo = [];
    let over = false;
    const done = (/** @type {'painted' | 'loaded' | 'timeout'} */ how) => {
      if (over) return;
      over = true;
      for (const step of undo) try { step(); } catch {}
      resolve(how);
    };
    const painted = () => {
      try {
        return performance.getEntriesByType('paint').some((entry) => entry.name === 'first-contentful-paint');
      } catch {
        return false;
      }
    };
    const inView = (/** @type {Element | null} */ el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth)) return false;
      try {
        // Not faded out or hidden by its styles (an app that shows its content once it's ready).
        return /** @type {any} */ (el).checkVisibility?.({ opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true }) ?? true;
      } catch {
        return true;
      }
    };
    const ownContent = () => {
      const body = document.body;
      if (!body) return false;
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (SKIP.has(/** @type {Element} */ (node).localName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      let seen = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (++seen > NODES_MAX) return true;
        if (node.nodeType === Node.TEXT_NODE) {
          if (/\S/.test(/** @type {Text} */ (node).data) && inView(node.parentElement)) return true;
          continue;
        }
        const el = /** @type {Element} */ (node);
        if (!DRAWN.has(el.localName)) continue;
        if (el.localName === 'img' && !(/** @type {HTMLImageElement} */ (el).complete && /** @type {HTMLImageElement} */ (el).naturalWidth > 0)) continue;
        if (inView(el)) return true;
      }
      return false;
    };
    let lastLook = -Infinity;
    const look = () => {
      if (over) return;
      if (document.readyState === 'complete') return done('loaded');
      if (document.readyState === 'loading' || !painted()) return;
      lastLook = performance.now();
      if (ownContent()) done('painted');
    };
    /** @type {any} */
    let later = null;
    const soon = () => {
      if (over || later != null) return;
      const wait = lastLook + LOOK_MS - performance.now();
      if (wait <= 0) return look();
      later = setTimeout(() => { later = null; look(); }, wait);
    };
    undo.push(() => clearTimeout(later));
    const timer = setTimeout(() => done('timeout'), ms);
    undo.push(() => clearTimeout(timer));
    document.addEventListener('readystatechange', look);
    undo.push(() => document.removeEventListener('readystatechange', look));
    addEventListener('load', look);
    undo.push(() => removeEventListener('load', look));
    // An image or a sheet arriving (their load events reach the document only on the way down).
    document.addEventListener('load', soon, true);
    undo.push(() => document.removeEventListener('load', soon, true));
    try {
      const observer = new PerformanceObserver(look);
      observer.observe({ type: 'paint' });
      undo.push(() => observer.disconnect());
    } catch {}
    try {
      const changes = new MutationObserver(soon);
      changes.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      undo.push(() => changes.disconnect());
    } catch {}
    // What changes no element (a font, a style's transition): looked at now and then too.
    const every = setInterval(soon, 4 * LOOK_MS);
    undo.push(() => clearInterval(every));
    look();
  });
}
