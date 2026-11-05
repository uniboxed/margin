// Where Margin sits on the page: shown on hover, toggled, peeking, or docked
// with "Keep open", where the page's box goes (shared/page-box.js), the
// first-paint placeholder's hand-over, and the show/hide shortcut. The theme
// draws it (view.setLayout, setWidth). Called by content/core.js.
import { mark } from '../shared/dom.js';
import * as V from '../shared/view.js';
import * as shortcuts from '../shared/shortcuts.js';

// Reveal zone: 10px, or 24px in a full-screen window, where Safari's own
// sidebar opens if the cursor rests at the very edge (see view.revealZone).
const edgePx = () =>
  V.revealZone({ outerWidth, outerHeight, screenWidth: screen.width, screenHeight: screen.height });
const HIDE_DELAY_MS = 300;
const PLACEHOLDER_RECHECK_MS = 5000;

// `page`: see content/core.js. `loader`: content/loader.js.
export function startLayout(page, { loader }) {
  const { host, send } = page;
  // The theme's frame around the page card (px): the box and the hover hit
  // area end there.
  const inset = () => page.theme()?.geometry?.inset ?? 0;
  // Margin's sizes (the sidebar's width, the frame) stay the same on screen
  // whatever the page's zoom (shared/dom.js setPageZoom); in the page's own
  // (zoomed) pixels, which the box and the pointer use, they're this.
  const pagePx = (px) => px / (page.zoom?.() ?? 1);
  // The box for a left edge at `left` (Margin's pixels): inside the frame.
  const boxAt = (left) => {
    const frame = pagePx(inset());
    return { left: pagePx(left), top: frame, right: frame, bottom: frame };
  };
  // A window's layout (content/core.js windowLayout), in Margin's pixels.
  const ownBox = ({ left, top, right, bottom, radius }) => ({ left: pagePx(left), top: pagePx(top), right: pagePx(right), bottom: pagePx(bottom), radius: pagePx(radius) });
  // While resizing: move the frame edge and, with "Keep open", the page's box
  // along with it (at most once per animation frame). The page's own layout
  // follows when it rests (content/page/box.js).
  let liveWidth = null;
  let widthFrame = null;
  let widthDone = false;
  const onWidth = (width, { done }) => {
    liveWidth = width;
    widthDone = done;
    if (done) return applyLiveWidth();
    widthFrame ??= requestAnimationFrame(applyLiveWidth);
  };
  function applyLiveWidth() {
    widthFrame = null;
    page.view()?.setWidth(liveWidth);
    if (!wasDocked) return; // hidden, the page stays in the frame
    page.setBox(boxAt(liveWidth), { live: !widthDone });
  }

  let reason = null; // 'hover' | 'toggle' | null
  let hideTimer = null;

  const pinnedOpen = () => !!page.state()?.settings?.sidebarPinnedOpen;
  // Hover: floating over the page. Keep open: docked, the page's box beside it.
  let isOpen = false;
  let wasDocked = false;
  function setOpen(open) {
    const view = page.view();
    if (!view) return;
    if (!page.active()) open = false; // out of the way (content/core.js): no sidebar, no box
    const docked = open && pinnedOpen();
    const width = view.width();
    isOpen = open;
    const framed = !docked && page.active() && page.state()?.settings?.frameWhenHidden !== false;
    // Keep open turned off or on slides (the theme), only where it's seen
    // happening: not on a page hidden, just shown, or being drawn first.
    if (wasDocked !== docked && (document.hidden || page.justShown() || page.firstRender())) view.instantOnce?.();
    wasDocked = docked;
    // Hidden, the page sits inside the frame (the sidebar floats over it
    // when it's out, and moves nothing). No frame, or out of the way, it's the
    // page as it is, with no box. A copy that stood back leaves the box to the
    // one in charge.
    const place = () => {
      if (page.dormant()) return;
      // Margin 2: the window's layout, from the theme, places the page whatever the sidebar does.
      const own = page.active() ? page.windowLayout?.() : null;
      const box = own ? ownBox(own) : docked ? boxAt(width) : framed ? boxAt(inset()) : null;
      page.setBox(box);
      mark(host, 'box', box ? String(box.left) : 'off');
    };
    if (!view.setLayout({ open, docked, framed, width, place, why: open ? reason : null })) place();
    mark(host, 'open', String(open)); // test/debug hook; reveals nothing private
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

  function show(why) {
    if (!page.active()) return; // out of the way (Chrome, not in full screen): nothing to open
    clearTimeout(hideTimer);
    hideTimer = null;
    if (!reason || reason === 'peek' || why === 'toggle') reason = why;
    setOpen(true);
  }
  function hide() {
    clearTimeout(hideTimer);
    hideTimer = null;
    reason = null;
    setOpen(pinnedOpen());
  }
  // While Margin is busy there (renaming, dragging, a menu), it waits, and
  // hides once that's done if the pointer is still away (show() cancels).
  function scheduleHide() {
    if (reason !== 'hover' || hideTimer) return;
    hideTimer = setTimeout(function tryHide() {
      if (page.view()?.isBusy()) {
        hideTimer = setTimeout(tryHide, HIDE_DELAY_MS);
        return;
      }
      hideTimer = null;
      hide();
    }, HIDE_DELAY_MS);
  }
  // With "Keep open" on, the shortcut switches back to auto-hide (hide()
  // alone would leave it pinned open).
  // The shortcut's page listener and a `commands` key can both fire for one
  // press; collapse them.
  let lastToggle = 0;
  function toggle() {
    if (!page.active()) return page.offerFullscreen();
    const now = Date.now();
    if (now - lastToggle < 200) return;
    lastToggle = now;
    if (pinnedOpen()) {
      const state = page.state();
      page.setState({ ...state, settings: { ...state.settings, sidebarPinnedOpen: false } });
      send('updateSettings', { patch: { sidebarPinnedOpen: false } });
      return hide();
    }
    return reason ? hide() : show('toggle');
  }

  // Briefly show the sidebar (after ⌘⌥←/→) so the new space is visible even
  // in auto-hide mode. Hovering or toggling during the peek keeps it open.
  let peekTimer = null;
  function peek() {
    if (!page.active()) return;
    if (pinnedOpen() || (reason && reason !== 'peek')) return;
    show('peek');
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => reason === 'peek' && hide(), 1200);
  }


  // Show/hide shortcut (Settings; default Option+S), in the page itself: the
  // manifest's `commands` can't suggest it (Chrome allows four, taken by the
  // tab and space keys).
  const watchToggleKey = (win) => win.addEventListener('keydown', (e) => {
    // Not a page's synthetic key press: with Keep open on, this changes a setting.
    if (!e.isTrusted || !shortcuts.matches(e, page.state()?.settings?.sidebarShortcut ?? 'Alt+KeyS')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    toggle();
  }, true);
  watchToggleKey(window);

  document.addEventListener(
    'mousemove',
    (e) => {
      const x = e.clientX;
      if (x <= pagePx(edgePx())) return page.active() ? show('hover') : page.offerFullscreen();
      else if (!page.view()) return;
      else if (x > pagePx(page.view().width() + inset())) scheduleHide();
      else if (hideTimer && isOpen) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    },
    { capture: true, passive: true },
  );
  // Cursor left the window: keep open if it left through the left edge.
  document.addEventListener('mouseout', (e) => {
    if (e.relatedTarget) return;
    if (e.clientX > pagePx(edgePx())) scheduleHide();
  });
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && reason === 'toggle') hide();
    },
    true,
  );
  // Clicking the page closes a toggled sidebar (clicks inside are retargeted
  // to the host).
  document.addEventListener('mousedown', (e) => {
    if (reason === 'toggle' && e.target !== host) hide();
  }, true);

  return {
    show, hide, toggle, peek, onWidth,
    // Out over the page (hovered or toggled, not docked): the user is reaching for it.
    out: () => isOpen && !wasDocked,
    // The page's zoom changed: the box follows.
    rezoom: () => setOpen(isOpen),
    // After a render: back to the resting layout, unless hovered or toggled.
    // Keep open just turned on from the sidebar out over the page: it docks.
    settle: () => {
      if (reason && pinnedOpen() && !wasDocked) {
        clearTimeout(hideTimer);
        hideTimer = null;
        reason = null;
      }
      if (!reason) setOpen(pinnedOpen());
    },
    // Once the theme is mounted: open if it was hovered or toggled before.
    reopen: () => { if (reason) setOpen(true); },
    // The page was left for another tab: an open-over-the-page sidebar
    // closes here (the next page opens its own, content/core.js), so coming
    // back doesn't find it still open.
    leave: () => { if (reason) hide(); },
    // How it's open right now ('hover' | 'toggle' | 'peek' | null).
    reason: () => reason,
  };
}
