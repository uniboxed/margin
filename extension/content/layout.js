// The page's box (Margin 2): while Margin.app is linked, the app's layout for
// the page's window (content/core.js appGeometry), as the page's box
// (shared/page-box.js, content/page-link.js); not linked, none: the page as
// it is. And the first-paint placeholder's hand-over. Pages draw none of
// Margin's UI (PLAN.md §7). Called by content/core.js.
import { mark } from '../shared/dom.js';

const PLACEHOLDER_RECHECK_MS = 5000;

/**
 * Where the page goes, in the page's (zoomed) pixels from the viewport's edges.
 * @typedef {{ insets: { left: number, top: number, right: number, bottom: number }, radius?: number, radii?: number[] }} Geometry
 */

// `page`: see content/core.js.
export function startLayout(page) {
  const { marks } = page;
  /** @type {(() => Geometry | null) | null} */
  let source = null; // the app's layout for the window, while it's linked
  // Nothing at any edge: the page as it is, no box.
  const boxOf = (/** @type {Geometry} */ g) => {
    const { left, top, right, bottom } = g.insets;
    if ([left, top, right, bottom].every((v) => Math.abs(v) < 0.5)) return null;
    return { left: Math.max(0, left), top: Math.max(0, top), right: Math.max(0, right), bottom: Math.max(0, bottom) };
  };
  // Linked with no layout for the window yet: the box stays as it is (the
  // first-paint one, registered while the app is linked:
  // background/registered.js). Not linked, out of the way (content/core.js
  // active: Chrome outside full screen), no box. A copy that stood back
  // leaves the box to the one in charge.
  function settle() {
    if (page.dormant()) return;
    const geometry = source ? source() : null;
    if (source && !geometry) return;
    const box = page.active() && geometry ? boxOf(geometry) : null;
    page.setBox(box);
    mark(marks, 'box', box ? String(Math.round(box.left)) : 'off'); // test/debug hook
    if (page.state()) syncPlaceholder();
  }

  // The first-paint placeholder (the theme's docked/w-<width>.css, registered
  // while the app is linked, with the page's box) places the box and paints
  // the frame until Margin runs. Once it does, the page-world box above takes
  // over (from the app's layout, or none) and the placeholder is switched off
  // on this page, so it can't fight a resize or linger after the link goes
  // or "Keep open" is turned off. Only touches <html> when the placeholder is
  // present, or about to be.
  // Whether it is costs a style read, which on a page that changed works out
  // its styles first: asked once per <html>, not on every render. One can be
  // registered late (a relaunch's or a Margin update's registrations come
  // back after its pages have started), so it's asked again at the first
  // render after the page is hidden, when it's shown, and otherwise at most
  // every PLACEHOLDER_RECHECK_MS (a render within that, seen, asks once it's
  // over). A change of what it's registered from (the settings, the link:
  // background/registered.js) brings a new one, or none: switched off here
  // without asking, before it arrives.
  let placeholderAsked = null; // { html, settings, at }
  let placeholderTimer = null;
  function syncPlaceholder() {
    const html = document.documentElement;
    if (!page.link.can || html.dataset.marginDocked === 'off') return;
    const s = page.state()?.settings;
    const settings = JSON.stringify([s?.sidebarPinnedOpen, s?.frameWhenHidden, s?.fullscreenOnly, s?.theme, s?.themes, s?.sidebarWidth, !!source]);
    const asked = placeholderAsked?.html === html ? placeholderAsked : null;
    const at = performance.now();
    if (asked && asked.settings !== settings) return void (html.dataset.marginDocked = 'off');
    if (asked && at - asked.at < PLACEHOLDER_RECHECK_MS) {
      if (document.hidden) return; // its show asks
      placeholderTimer ??= setTimeout(() => {
        placeholderTimer = null;
        if (!document.hidden && page.state()) syncPlaceholder();
      }, asked.at + PLACEHOLDER_RECHECK_MS - at);
      return;
    }
    placeholderAsked = { html, settings, at };
    if (getComputedStyle(html, '::after').content !== 'none') html.dataset.marginDocked = 'off';
  }
  document.addEventListener('visibilitychange', () => {
    if (placeholderAsked) placeholderAsked.at = -Infinity;
    if (!document.hidden && page.state()) syncPlaceholder();
  });

  return {
    // After the state, the link or the window changed: the box as it should be now.
    settle,
    // The page's zoom changed: the layout is in the page's pixels again.
    rezoom: settle,
    // Where the box comes from while Margin.app is linked (content/core.js:
    // the window's layout from the app); null: not linked, no box.
    /** @param {(() => Geometry | null) | null} fn */
    setSource: (fn) => { source = fn; },
  };
}
