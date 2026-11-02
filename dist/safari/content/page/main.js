// Margin in the page's own world: the page's box (shared/page-box.js), with no
// iframe. <html> is the box beside the sidebar, <body> scrolls inside it, and
// what a page asks about its window (its size, scrolling, pointer positions,
// media queries) is answered for the box.
//
// Registered by the background (background/registered.js) only while pages
// have a box, in the top frame only, so a page Margin leaves alone loads none
// of this. A page that missed the registration gets it from the content script
// (content/page-link.js, background injectPage). Margin's isolated world
// moves the box with `margin:box` events (box.js).
import { startBox } from './box.js';
import { startViewport } from './viewport.js';
import { startInView } from './in-view.js';
import { startTopLayer } from './top-layer.js';
import { startCoords } from './coords.js';
import { startMedia } from './media.js';
import { startSheets } from './sheets.js';

(() => {
  // Written by content/page/at-<L>.js, right before this script.
  const START = Symbol.for('margin.page.start');
  const start = /** @type {any} */ (window)[START];
  delete (/** @type {any} */ (window))[START];
  // Registering again runs this again in open pages (WebKit, every sidebar width).
  const RAN = Symbol.for('margin.page');
  if (window !== top || /** @type {any} */ (window)[RAN]) return;
  const root = document.documentElement;
  if (!(root instanceof HTMLHtmlElement)) return; // an XML or SVG document: no box
  // WebKit runs a newly registered script in open pages. One an old copy laid
  // out (the fitted iframe, the frameless test build) stays as it is until it
  // reloads: nothing here would ever take a box off it (content/page-link.js).
  if (root.hasAttribute('data-margin-shell') || root.hasAttribute('data-margin-frameless')) return;
  // Chrome, where Margin works only in full screen: not in a window that shows
  // the toolbar (Margin full screen has none). innerHeight is in the page's zoomed pixels.
  if (start?.fullscreenOnly && outerHeight - innerHeight * (outerWidth / innerWidth || 1) > 40) return;
  Object.defineProperty(window, RAN, { value: true });

  // Blink can switch the private fit sheet cheaply; WebKit cannot, so its
  // measured fast path uses a transient attribute on <head>. The at-<L>
  // bootstrap is generated per build, which keeps this choice out of UA
  // sniffing and makes the Safari-profile Chromium tests exercise Safari's
  // path too. An older bootstrap has no profile and safely takes that path.
  const box = startBox(start?.left, { privateReads: start?.profile === 'chrome' });
  startViewport(box);
  startCoords(box);
  startInView(box);
  startTopLayer(box);
  startMedia(box);
  const sheets = startSheets(box);
  // Safari's hidden destination is prepared before activation. Reconcile
  // styles first, then consume the one resulting body measurement, all in the
  // same task so no partially updated geometry can be painted.
  document.addEventListener('margin:box-prepare', (event) => {
    sheets.flush();
    if (box.prepare(sheets.flush)) event.preventDefault();
  });
  document.addEventListener('margin:box-cover', (event) => {
    const covered = /** @type {CustomEvent} */ (event).detail;
    if (covered !== 'on' && covered !== 'off') return;
    box.setCovered(covered === 'on');
    event.preventDefault();
  });
  // Injected late, after the page's sheets: said so, and the isolated side
  // sends what the box should be (content/page-link.js).
  document.dispatchEvent(new CustomEvent('margin:box-ready'));
})();
