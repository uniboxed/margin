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
  // Chrome, where Margin works only in full screen: not in a window that shows
  // the toolbar (Margin full screen has none). innerHeight is in the page's zoomed pixels.
  if (start?.fullscreenOnly && outerHeight - innerHeight * (outerWidth / innerWidth || 1) > 40) return;
  Object.defineProperty(window, RAN, { value: true });

  const box = startBox(start?.left);
  startViewport(box);
  startCoords(box);
  startInView(box);
  startTopLayer(box);
  startMedia(box);
  startSheets(box);
  // Injected late, after the page's sheets: said so, and the isolated side
  // sends what the box should be (content/page-link.js).
  document.dispatchEvent(new CustomEvent('margin:box-ready'));
})();
