// Where Margin sits on the page, with its UI drawn by the UI runtime
// (ui/runtime.js, Margin 2): the theme decides the layout, and its page slot
// (`<m-page>`, measured by the runtime) is where the page's box goes
// (shared/page-box.js, content/page-link.js). This module links the two and
// does what only the page can: the pointer over the page (it reaches the
// page, not Margin's UI) handed to the runtime for the reveal edge; the
// pointer over the page's slot let through to the page; the show/hide key;
// a moment out after a space switch by key; a toggled sidebar closed by a
// click on the page; the first-paint placeholder's hand-over. Called by
// content/core.js.
import { mark } from '../shared/dom.js';
import * as V from '../shared/view.js';
import * as shortcuts from '../shared/shortcuts.js';

const PLACEHOLDER_RECHECK_MS = 5000;
// After ⌘⌥←/→: out this long, so the new space is seen (ui/behaviors/peek.js flash).
const PEEK_MS = 1200;

// `page`: see content/core.js (`page.runtime()`: the UI, once it's there).
// `loader`: content/loader.js.
export function startLayout(page, { loader }) {
  const { host } = page;
  const rt = () => page.runtime();
  // The reveal edge in the page's pixels (Margin's stay the same whatever
  // the page's zoom), for reaching for Margin while it's out of the way.
  const edgePx = () => V.revealZone({ outerWidth, outerHeight, screenWidth: screen.width, screenHeight: screen.height }) / (page.zoom?.() ?? 1);

  // ---- the page's box: the theme's page slot ----------------------------------
  /** @type {import('../ui/host.js').Geometry | null} */
  let layout = null;
  const resizing = () => !!rt()?.view.rootElement()?.classList.contains('m-resizing');
  // The slot's insets are in the page's pixels already (the runtime measures
  // boxes there). Nothing at any edge: the page as it is, no box.
  const boxOf = (g) => {
    const { left, top, right, bottom } = g.insets;
    if ([left, top, right, bottom].every((v) => Math.abs(v) < 0.5)) return null;
    return { left: Math.max(0, left), top: Math.max(0, top), right: Math.max(0, right), bottom: Math.max(0, bottom) };
  };
  // Out of the way (content/core.js active: Chrome outside full screen), no
  // box. A copy that stood back leaves the box to the one in charge.
  function place(geometry = layout) {
    if (geometry) layout = geometry;
    if (page.dormant()) return;
    const box = page.active() && layout ? boxOf(layout) : null;
    page.setBox(box, { live: resizing() });
    mark(host, 'box', box ? String(Math.round(box.left)) : 'off'); // test/debug hook
    const sidebar = rt()?.vm?.window.sidebar;
    if (sidebar) mark(host, 'open', String(sidebar !== 'hidden' && page.active())); // test/debug hook; reveals nothing private
    if (page.state()) syncPlaceholder();
  }

  // The first-paint placeholder (the theme's docked/w-<width>.css, registered
  // with the page's box) places the box and paints the frame until Margin runs.
  // Once it does, the page-world box above takes over (same frame, same width,
  // so nothing moves) and the placeholder is switched off on this page, so it
  // can't fight a resize or linger after "Keep open" is turned off. Only
  // touches <html> when the placeholder is present, or about to be.
  // Whether it is costs a style read, which on a page that changed works out
  // its styles first: asked once per <html>, not on every render. One can be
  // registered late (a relaunch's or a Margin update's registrations come
  // back after its pages have started), so it's asked again at the first
  // render after the page is hidden (a switch prepares it there), when it's
  // shown, and otherwise at most every PLACEHOLDER_RECHECK_MS (a render
  // within that, seen, asks once it's over). A change of the settings it's
  // registered from (background/registered.js) brings a new one: switched
  // off here without asking, before it arrives.
  let placeholderAsked = null; // { html, settings, at }
  let placeholderTimer = null;
  const pinnedOpen = () => !!page.state()?.settings?.sidebarPinnedOpen;
  function syncPlaceholder() {
    const html = document.documentElement;
    if (!page.link.can || html.dataset.marginDocked === 'off') return;
    const s = page.state()?.settings;
    const settings = JSON.stringify([s?.sidebarPinnedOpen, s?.frameWhenHidden, s?.fullscreenOnly, s?.theme, s?.themes, s?.sidebarWidth]);
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
    if (getComputedStyle(html, '::after').content !== 'none') {
      html.dataset.marginDocked = 'off';
      if (pinnedOpen()) loader.tookOverPlaceholder(); // hidden, its placeholder has no pill
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (placeholderAsked) placeholderAsked.at = -Infinity;
    if (!document.hidden && page.state()) syncPlaceholder();
  });

  // ---- the pointer ---------------------------------------------------------------
  // Over the page's slot the pointer goes to the page under it, past the
  // theme's root (its frame strips take it: they're Margin's); what the
  // theme draws over the page (a sidebar out over it, a menu) still takes it
  // (ui/render.js m-passthrough). Set as it crosses the slot's edge.
  let through = null;
  const inSlot = (x, y) => {
    if (!layout) return false;
    const { left, top, right, bottom } = layout.insets;
    return x >= left && y >= top && x <= innerWidth - right && y <= innerHeight - bottom;
  };
  function passThrough(x, y) {
    const root = rt()?.view.rootElement();
    if (!root) return;
    const on = inSlot(x, y);
    if (on === through && root.hasAttribute('m-passthrough') === on) return;
    through = on;
    root.toggleAttribute('m-passthrough', on);
  }
  // Over the page (Margin's own UI hears its own, retargeted to the host):
  // the runtime's reveal edge. Out of the way, reaching the edge offers full
  // screen instead (content/core.js).
  const onMove = (/** @type {MouseEvent} */ e) => {
    passThrough(e.clientX, e.clientY);
    if (e.target === host) return;
    if (!page.active()) {
      if (e.clientX <= edgePx()) page.offerFullscreen();
      return;
    }
    rt()?.pointer({ x: e.clientX, y: e.clientY });
  };
  document.addEventListener('mousemove', onMove, { capture: true, passive: true });
  document.addEventListener('mouseover', onMove, { capture: true, passive: true });
  // Cursor left the window.
  document.addEventListener('mouseout', (e) => {
    if (e.relatedTarget) return;
    rt()?.pointerLeft({ x: e.clientX, y: e.clientY });
  });
  // Clicking the page closes a toggled sidebar (clicks inside are retargeted
  // to the host).
  document.addEventListener('mousedown', (e) => {
    passThrough(e.clientX, e.clientY);
    if (rt()?.sidebar.reason() === 'toggle' && e.target !== host) rt()?.sidebar.hide();
  }, true);

  // ---- the show/hide key, and a peek after a space switch ---------------------
  // With "Keep open" on, the key switches back to auto-hide (ui/behaviors/
  // peek.js toggle). The shortcut's page listener and a `commands` key can
  // both fire for one press; collapse them.
  let lastToggle = 0;
  function toggle() {
    if (!page.active()) return page.offerFullscreen();
    const now = Date.now();
    if (now - lastToggle < 200) return;
    lastToggle = now;
    rt()?.sidebar.toggle();
  }
  // Show/hide shortcut (Settings; default Option+S), in the page itself: the
  // manifest's `commands` can't suggest it (Chrome allows four, taken by the
  // tab and space keys).
  addEventListener('keydown', (e) => {
    // Not a page's synthetic key press: with Keep open on, this changes a setting.
    if (!e.isTrusted || !shortcuts.matches(e, page.state()?.settings?.sidebarShortcut ?? 'Alt+KeyS')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    toggle();
  }, true);
  // Briefly out (after ⌘⌥←/→) so the new space is seen even in auto-hide
  // mode. Hovering or toggling during it keeps it out.
  function peek() {
    if (!page.active() || pinnedOpen()) return;
    rt()?.sidebar.flash(PEEK_MS);
  }

  // Before the UI is there, what it should open as when it comes.
  /** @type {'hover' | 'toggle' | null} */
  let wanted = null;
  function show(why) {
    if (!page.active()) return; // out of the way: nothing to open
    const r = rt();
    if (!r) return void (wanted = why === 'toggle' ? 'toggle' : 'hover');
    r.sidebar.show(why === 'toggle' ? 'toggle' : why === 'peek' ? 'flash' : 'hover');
  }
  function hide() {
    wanted = null;
    rt()?.sidebar.hide();
  }
  const reason = () => {
    const r = rt()?.sidebar.reason() ?? wanted;
    return r === 'flash' ? 'peek' : r;
  };

  return {
    show, hide, toggle, peek, reason,
    /** The runtime's report of the page's slot (ui/host.js reportLayout). */
    apply: (geometry) => place(geometry),
    // Out over the page (hovered or toggled, not docked): the user is reaching for it.
    out: () => !!rt()?.sidebar.out(),
    // The page's zoom changed: the slot is measured again (Margin's own
    // size didn't change, the page's pixels did).
    rezoom: () => { const g = rt()?.measure(); place(g ?? layout); },
    // After a render: the slot as drawn now (measured at once, so the box
    // moves with the same frame as the theme).
    settle: () => { const g = rt()?.measure(); place(g ?? layout); },
    // Once the UI is there: open if it was hovered or toggled before.
    reopen: () => {
      if (!wanted) return;
      const why = wanted;
      wanted = null;
      show(why);
    },
    // The page was left for another tab: a sidebar out over the page closes
    // here (the next page opens its own, content/core.js), so coming back
    // doesn't find it still open.
    leave: () => { if (reason()) hide(); },
  };
}
