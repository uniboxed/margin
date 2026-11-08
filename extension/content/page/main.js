// Margin in the page's own world: the page's box (shared/page-box.js), with no
// iframe. <html> is the box beside the sidebar, <body> scrolls inside it, and
// what a page asks about its window (its size, scrolling, pointer positions,
// media queries) is answered for the box. What it promises, as rules, and
// every page pattern it handles: tests/box/README.md.
//
// Registered by the background (background/registered.js) only while
// Margin.app draws Margin, in the top frame only, with the first paint's CSS:
// its variables say the theme and the box's insets (shared/page-box.js
// readFirstPaint), and this script marks the page for that theme's
// first-paint file and starts its box there, so the page is in its box from
// its first frame. A page that missed the registration gets this from the
// content script (content/page-link.js, background injectPage), which says
// where the box goes. Margin's isolated world moves the box with
// `margin:box` events (box.js).
import { startBox } from './box.js';
import { startViewport } from './viewport.js';
import { startInView } from './in-view.js';
import { startTopLayer } from './top-layer.js';
import { startTimelines } from './timelines.js';
import { startCoords } from './coords.js';
import { startMedia } from './media.js';
import { startSheets } from './sheets.js';
import { FIRST_PAINT_MARK, readFirstPaint } from '../../shared/page-box.js';

(() => {
  // Written right before this script: by the background's injection
  // (handlers.js injectPage: where the box starts), or by
  // content/page/fullscreen-only.js (Chrome).
  const START = Symbol.for('margin.page.start');
  const start = /** @type {any} */ (window)[START];
  delete (/** @type {any} */ (window))[START];
  // Registering again runs this again in open pages (WebKit).
  const RAN = Symbol.for('margin.page');
  if (window !== top || /** @type {any} */ (window)[RAN]) return;
  const root = document.documentElement;
  if (!(root instanceof HTMLHtmlElement)) return; // an XML or SVG document: no box
  // Chrome, where Margin works only in full screen: not in a window that shows
  // the toolbar (Margin full screen has none). innerHeight is in the page's zoomed pixels.
  if (start?.fullscreenOnly && outerHeight - innerHeight * (outerWidth / innerWidth || 1) > 40) return;
  const computed = window.getComputedStyle;
  const firstPaint = () => readFirstPaint(computed(root));

  /** @type {any} */
  let box = null;
  const run = (/** @type {any} */ from) => {
    Object.defineProperty(window, RAN, { value: true });
    box = startBox(from);
    startViewport(box);
    startCoords(box);
    startInView(box);
    startTopLayer(box);
    startTimelines(box);
    startMedia(box);
    startSheets(box);
    // Said so, and the isolated side sends what the box should be
    // (content/page-link.js).
    document.dispatchEvent(new CustomEvent('margin:box-ready'));
  };
  // Injected (the content script asked for it: it says where the box goes),
  // or registered on a page already open (WebKit runs a script registered
  // now in open pages): started as it is, with no first paint to draw.
  if (start?.left != null || document.readyState !== 'loading') return void run(start?.left != null ? { left: start.left } : {});

  // Registered, on a page starting: what the first paint's CSS says. WebKit
  // applies registered CSS after this script starts (Spike 4: 22 of 128 pages
  // had it here), and a window with a layout of its own gets it as the page
  // commits (background/registered.js fixUp): looked at again as <head> and
  // <body> arrive (before the page's own scripts run) and at the first
  // rendering updates (before each is drawn). A theme: the page is marked for
  // its first-paint file, and its box starts at the layout, moved if the
  // variables change, until Margin's content script says where the box goes
  // (its first `margin:box`: the mark comes off, the box is this world's
  // own). `off`: Margin.app doesn't draw (a registration left over says
  // otherwise), or draws nothing over this window: nothing here, and a box
  // an earlier look started from the registered CSS goes. Nothing at all by the last look: no first
  // paint (the build before Phase 3's registration, before the background
  // replaces it): nothing here either; the content script brings this in if
  // a box is wanted.
  let told = false;
  const at = (/** @type {any} */ layout) => ({ left: layout.left, top: layout.top, right: layout.right, bottom: layout.bottom });
  const same = (a, b) => a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
  const look = () => {
    if (told) return false;
    if (!box && /** @type {any} */ (window)[RAN]) return false; // injected meanwhile: that copy has the box
    const fp = firstPaint();
    if (!fp) return true; // not yet
    const { theme, layout } = fp;
    if (!theme || !layout) {
      // `off` put in as the page committed (its window's own: Margin.app draws nothing over that
      // window, or its layout has no box: background/registered.js fixUp), after an earlier look
      // started the registered box: the box goes before it's drawn. (Not one the content script
      // has spoken for: `told`, above.)
      if (box && root.hasAttribute(FIRST_PAINT_MARK)) {
        root.removeAttribute(FIRST_PAINT_MARK);
        box.set('off');
      }
      return !!box;
    }
    const noBox = ['left', 'top', 'right', 'bottom'].every((side) => layout[side] < 0.5);
    if (!box) {
      if (noBox) return false;
      root.setAttribute(FIRST_PAINT_MARK, theme);
      run(at(layout));
      document.addEventListener('margin:box', () => {
        told = true;
        root.removeAttribute(FIRST_PAINT_MARK);
      }, { once: true });
      return true;
    }
    if (root.getAttribute(FIRST_PAINT_MARK) !== theme) root.setAttribute(FIRST_PAINT_MARK, theme);
    if (!noBox && !same(at(layout), box)) box.set(JSON.stringify(at(layout)));
    return true;
  };
  if (!look()) return;
  const arriving = new MutationObserver(() => {
    if (!look() || document.body) arriving.disconnect();
  });
  arriving.observe(root, { childList: true });
  let looks = 3;
  const onFrame = () => {
    if (look() && --looks > 0) requestAnimationFrame(onFrame);
    else arriving.disconnect();
  };
  requestAnimationFrame(onFrame);
})();
