// When a page loading is worth showing: once it has painted something of its
// own, not once it has loaded. Safari's log of restored tabs (2026-11-02): a
// page's first visually non-empty layout came a median 0.55 s after it was
// first selected, its load event a median 4.2 s after; waiting for the load
// held back a median 2.3 s of page that was already painted, and most pages
// were shown still loading anyway, at the time limit. Plain Safari, in the
// same log, showed such tabs at their first layout (281–1331 ms, median 600).
//
// 'painted': the document is parsed (readyState past 'loading', so the page
// isn't a few lines of its head) or its first contentful paint is PARSED_MS
// old and more than a scrap of its own is drawn (a page whose parser waits on
// a script at the end of its body has drawn the rest long before: Safari
// shows it at its first visually non-empty layout, which takes as much), the
// browser has a first contentful paint for it, and something of the page's
// own is drawn in view (that, not the parse, is what tells an app's empty
// shell from its content: below): text, a loaded
// image, an svg, a canvas, a video or a field inside <body>, laid out, in the
// window and not hidden by its styles. The paint alone isn't enough: Margin's
// own UI is in the page's document (its sidebar, drawn in a page loading
// hidden when it's kept open; the switch cover's spinner), outside <body>, and
// counts for the browser's first contentful paint too. In the WebKit host, an
// app's page whose body stays empty until its script fills it 0.7 s later had
// its first contentful paint at 54 ms, Margin's, and was shown then, empty
// (the host's `shelllate`, `shellcover`, `shellbehind`). 'loaded': its load
// event. 'timeout': neither within `ms`. 'blank': the empty document a tab
// starts with, one Margin's script reached before the real one committed, or
// one that went away before it painted (a script redirect still loading, a
// link): asked again of the next (background/tabs.js untilPainted). Without
// that end its timer, in Margin's world, died with the page, and WebKit kept
// the tab's process awake for the script until a garbage collection
// (background/tabs.js keepAwake).
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
    const PARSED_MS = 150;
    const PARSING_CHARS = 200; // WebKit's visualCharacterThreshold
    const PARSING_AREA = 32 * 32; // and its visualPixelThreshold
    const NODES_MAX = 4000; // a page with that much in it has something to show
    const SKIP = new Set(['script', 'style', 'noscript', 'template']);
    const DRAWN = new Set(['img', 'svg', 'canvas', 'video', 'input', 'textarea', 'select']);
    /** @type {(() => void)[]} */
    const undo = [];
    let over = false;
    const done = (/** @type {'painted' | 'loaded' | 'timeout' | 'blank'} */ how) => {
      if (over) return;
      over = true;
      for (const step of undo) try { step(); } catch {}
      resolve(how);
    };
    // When the first contentful paint came (performance.now()'s clock), if it has.
    const paintedAt = () => {
      try {
        const entry = performance.getEntriesByType('paint').find((one) => one.name === 'first-contentful-paint');
        return entry ? (Number.isFinite(entry.startTime) ? entry.startTime : performance.now()) : null;
      } catch {
        return null;
      }
    };
    // Margin's own arrival cover, if it's what hides <body> (content/core.js
    // arriveCovered: opacity 0 on it while a tab shown for the first time
    // waits for its show), is looked past: a second switch to that tab
    // otherwise found nothing drawn. Each element's own opacity up to <body>
    // is then looked at instead (once per look).
    let pastCover = false;
    /** @type {Map<Element, boolean>} */
    const faded = new Map();
    const fadedOut = (/** @type {Element} */ el) => {
      for (let node = /** @type {Element | null} */ (el); node && node !== document.body; node = node.parentElement) {
        let zero = faded.get(node);
        if (zero === undefined) faded.set(node, (zero = getComputedStyle(node).opacity === '0'));
        if (zero) return true;
      }
      return false;
    };
    const inView = (/** @type {Element | null} */ el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth)) return false;
      try {
        // Not faded out or hidden by its styles (an app that shows its content once it's ready).
        if (pastCover) return (/** @type {any} */ (el).checkVisibility?.({ visibilityProperty: true, checkVisibilityCSS: true }) ?? true) && !fadedOut(el);
        return /** @type {any} */ (el).checkVisibility?.({ opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true }) ?? true;
      } catch {
        return true;
      }
    };
    // `parsing`: still parsing, it needs more than a scrap, as WebKit does
    // before its first visually non-empty layout while a document is still
    // parsing (LocalFrameView qualifiesAsVisuallyNonEmpty): over
    // PARSING_CHARS characters of text in view, or a drawn element over
    // PARSING_AREA px (a site's header alone, its parser held by a script,
    // isn't the page).
    const ownContent = (parsing = false) => {
      const body = document.body;
      if (!body) return false;
      let chars = 0;
      try {
        pastCover = /** @type {any} */ (globalThis).Margin?.content?.arrivalHides?.() === true && body.style.getPropertyValue('opacity') === '0';
      } catch {
        pastCover = false;
      }
      faded.clear();
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (SKIP.has(/** @type {Element} */ (node).localName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      let seen = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (++seen > NODES_MAX) return true;
        if (node.nodeType === Node.TEXT_NODE) {
          const data = /** @type {Text} */ (node).data;
          if (!/\S/.test(data) || !inView(node.parentElement)) continue;
          if (!parsing || (chars += data.replace(/\s+/g, '').length) > PARSING_CHARS) return true;
          continue;
        }
        const el = /** @type {Element} */ (node);
        if (!DRAWN.has(el.localName)) continue;
        if (el.localName === 'img' && !(/** @type {HTMLImageElement} */ (el).complete && /** @type {HTMLImageElement} */ (el).naturalWidth > 0)) continue;
        if (!inView(el)) continue;
        if (!parsing) return true;
        const r = el.getBoundingClientRect();
        if (r.width * r.height > PARSING_AREA) return true;
      }
      return false;
    };
    let lastLook = -Infinity;
    /** @type {any} */
    let aged = null; // a look once the first contentful paint is PARSED_MS old (still parsing then)
    const look = () => {
      if (over) return;
      if (document.readyState === 'complete') return done('loaded');
      const at = paintedAt();
      if (at == null) return;
      const parsing = document.readyState === 'loading';
      if (parsing) {
        const wait = at + PARSED_MS - performance.now();
        if (wait > 0) {
          if (aged == null) aged = setTimeout(() => { aged = null; look(); }, wait);
          return;
        }
      }
      lastLook = performance.now();
      if (ownContent(parsing)) done('painted');
    };
    undo.push(() => clearTimeout(aged));
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
    const gone = () => done('blank');
    for (const type of ['pagehide', 'pageswap']) {
      addEventListener(type, gone);
      undo.push(() => removeEventListener(type, gone));
    }
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
