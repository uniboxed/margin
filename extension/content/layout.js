// Where Margin sits on the page: shown on hover, toggled, peeking, or docked
// with "Keep open" (the page pushed right, or its card placed beside the
// sidebar in the fitted layout), the first-paint placeholder's hand-over, and
// the show/hide shortcut. The theme draws it (view.setLayout, setWidth).
// Called by content/core.js.
import * as V from '../shared/view.js';
import * as shortcuts from '../shared/shortcuts.js';
import { platform } from '../shared/platform.js';

// Reveal zone: 10px, or 24px in a full-screen window, where Safari's own
// sidebar opens if the cursor rests at the very edge (see view.revealZone).
const edgePx = () =>
  V.revealZone({ outerWidth, outerHeight, screenWidth: screen.width, screenHeight: screen.height });
const HIDE_DELAY_MS = 300;
// How long the pointer rests on the narrow rail before the full sidebar
// opens over the page (a pass on the way to an icon doesn't).
const RAIL_EXPAND_MS = 350;

// `page`: see content/core.js. `loader`: content/loader.js.
export function startLayout(page, { loader }) {
  const { host, send, onCard } = page;
  // The theme's frame around the page card (px): the push and the hover hit
  // area end there.
  const inset = () => page.theme()?.geometry?.inset ?? 0;
  // While resizing: move the frame edge and, with "Keep open", the pushed
  // page along with it (at most once per animation frame).
  let liveWidth = null;
  let widthFrame = null;
  const onWidth = (width, { done }) => {
    liveWidth = width;
    if (done) return applyLiveWidth();
    widthFrame ??= requestAnimationFrame(applyLiveWidth);
  };
  function applyLiveWidth() {
    widthFrame = null;
    page.view()?.setWidth(liveWidth);
    if (pushed && !railWidth()) setPushed(true, liveWidth); // with the rail, the page stays at the rail
    globalThis.Margin?.shell?.setLayout({ width: liveWidth });
  }

  let reason = null; // 'hover' | 'toggle' | null
  let hideTimer = null;

  const pinnedOpen = () => !!page.state()?.settings?.sidebarPinnedOpen;
  // A page that isn't fitted (content/shell.js skipped it, or fitting is off)
  // is pushed. With the rail available (platform.compactRail, off for now)
  // and compactWhenPushed (on by default) only by the theme's
  // narrow icon rail (geometry.rail), which expands over the page when the
  // pointer rests on it: pushing by the full sidebar puts more of such a
  // page under it or off the right edge. Null: the full sidebar.
  const railWidth = () => {
    const rail = page.theme()?.geometry?.rail;
    return rail && platform?.compactRail && !globalThis.Margin?.shell && page.state()?.settings?.compactWhenPushed !== false ? rail : null;
  };
  // The rail's width while it shows folded (docked, not hovered or toggled).
  const onRail = () => (reason == null && pinnedOpen() && page.active() ? railWidth() : null);
  // Hover: floating over the page. Keep open: docked, with the page pushed
  // right (or, in the fitted layout, its card placed beside the sidebar).
  let isOpen = false;
  function setOpen(open) {
    const view = page.view();
    if (!view) return;
    if (!page.active()) open = false; // out of the way (content/core.js): no sidebar, no push
    const docked = open && pinnedOpen();
    const width = view.width();
    const rail = docked ? railWidth() : null;
    isOpen = open;
    // Hovered or toggled over the rail: the full sidebar, over the page.
    view.setLayout({ open, docked, width, rail: rail && { width: rail, expanded: reason != null } });
    host.dataset.open = String(open); // test/debug hook; reveals nothing private
    host.dataset.rail = rail ? (reason != null ? 'expanded' : 'rail') : 'off';
    setPushed(docked, rail ?? width);
    globalThis.Margin?.shell?.setLayout({ docked, width, inset: inset(), radius: page.theme().geometry?.radius });
    if (page.state()) syncPlaceholder();
  }


  // ---- push (only while "Keep open" is on) ---------------------------------
  // Shifts the page right so it starts where the sidebar ends. A separate
  // adopted stylesheet (never the page's own markup or inline styles), screen
  // media only, removed as soon as "Keep open" is off. Known trade-offs are in
  // DECISIONS.md: position:fixed elements don't move, 100vw elements are
  // clipped on the right.
  const pushCss = (width) => `@media screen {
    html {
      margin-left: ${width}px !important;
      margin-right: ${inset()}px !important;
      width: auto !important;
      overflow-x: hidden !important;
    }
  }`;
  const canPush = document.documentElement instanceof HTMLHtmlElement;
  let pushed = false;
  let pushedWidth = null;
  let pushSheet = null;
  let pushStyle = null;
  function setPushed(on, width) {
    if (!canPush || globalThis.Margin?.shell || (on === pushed && (!on || width === pushedWidth))) return; // the fitted layout needs no push
    pushed = on;
    pushedWidth = on ? width : null;
    if ('adoptedStyleSheets' in document && typeof CSSStyleSheet.prototype.replaceSync === 'function') {
      pushSheet ??= new CSSStyleSheet();
      pushSheet.replaceSync(pushCss(width));
      const others = document.adoptedStyleSheets.filter((s) => s !== pushSheet);
      document.adoptedStyleSheets = on ? [...others, pushSheet] : others;
    } else if (on) {
      pushStyle ??= document.createElement('style');
      pushStyle.textContent = pushCss(width);
      if (!pushStyle.isConnected) document.documentElement.appendChild(pushStyle);
    } else {
      pushStyle?.remove();
    }
    host.dataset.pushed = String(on);
  }

  // The first-paint placeholder (content/docked/w-<width>.css, registered
  // while "Keep open" is on) pushes and paints until Margin runs. Once it does,
  // the live push above takes over (same frame, same width, so nothing moves)
  // and the placeholder is switched off on this page, so it can't fight a
  // resize or linger after "Keep open" is turned off. Only touches <html>
  // when the placeholder is present.
  function syncPlaceholder() {
    const html = document.documentElement;
    if (!canPush || html.dataset.marginDocked === 'off') return;
    if (getComputedStyle(html, '::after').content !== 'none') {
      html.dataset.marginDocked = 'off';
      loader.tookOverPlaceholder();
    }
  }

  // Resting on the rail: where the pointer stopped, and the pending expand.
  let railTimer = null;
  let railRest = null;
  const cancelRail = () => {
    clearTimeout(railTimer);
    railTimer = null;
    railRest = null;
  };
  function show(why) {
    if (!page.active()) return; // out of the way (Chrome, not in full screen): nothing to open
    clearTimeout(hideTimer);
    hideTimer = null;
    cancelRail();
    if (!reason || reason === 'peek' || why === 'toggle') reason = why;
    setOpen(true);
  }
  function hide() {
    clearTimeout(hideTimer);
    hideTimer = null;
    cancelRail();
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
    cancelRail();
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
  onCard(watchToggleKey);

  // `target`: this document, or the card's window in the fitted layout,
  // whose coordinates start `offsetX` px into the window.
  function watchPointer(target, offsetX = () => 0) {
    target.addEventListener(
      'mousemove',
      (e) => {
        const x = e.clientX + offsetX();
        // On the narrow rail (Keep open, a pushed page): its icons work at
        // once; resting on it opens the full sidebar over the page.
        const rail = onRail();
        if (rail != null) {
          if (x > rail) return cancelRail();
          // Restarted whenever the pointer moves on (a few px of a resting
          // hand don't count), so only a rest expands it.
          if (railRest && Math.hypot(x - railRest.x, e.clientY - railRest.y) <= 4) return;
          clearTimeout(railTimer);
          railRest = { x, y: e.clientY };
          railTimer = setTimeout(() => {
            railTimer = null;
            railRest = null;
            if (onRail() != null) show('hover'); // still on the rail, still docked, nothing else open
          }, RAIL_EXPAND_MS);
          return;
        }
        if (x <= edgePx()) return page.active() ? show('hover') : page.offerFullscreen();
        else if (!page.view()) return;
        else if (x > page.view().width() + inset()) scheduleHide();
        else if (hideTimer && isOpen) {
          clearTimeout(hideTimer);
          hideTimer = null;
        }
      },
      { capture: true, passive: true },
    );
    // Cursor left the window: keep open if it left through the left edge.
    target.addEventListener('mouseout', (e) => {
      if (e.relatedTarget) return;
      cancelRail(); // left the window
      if (e.clientX + offsetX() > edgePx()) scheduleHide();
    });
    target.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape' && reason === 'toggle') hide();
      },
      true,
    );
    // Clicking the page closes a toggled sidebar (clicks inside are retargeted
    // to the host). A click (on the rail's icons too) means no rest.
    target.addEventListener('mousedown', (e) => {
      cancelRail();
      if (reason === 'toggle' && e.target !== host) hide();
    }, true);
  }
  // Another tab now: nothing pending here.
  document.addEventListener('visibilitychange', () => document.hidden && cancelRail());
  watchPointer(document);
  onCard((win) => watchPointer(win, () => globalThis.Margin?.shell?.cardLeft() ?? 0));

  return {
    show, hide, toggle, peek, onWidth,
    // After a render: back to the resting layout, unless hovered or toggled.
    settle: () => { if (!reason) setOpen(pinnedOpen()); },
    // Once the theme is mounted: open if it was hovered or toggled before.
    reopen: () => { if (reason) setOpen(true); },
    // The page was left for another tab: an open-over-the-page sidebar
    // closes here (the next page opens its own, content/core.js), so coming
    // back doesn't find it still open.
    leave: () => { cancelRail(); if (reason) hide(); },
    // How it's open right now ('hover' | 'toggle' | 'peek' | null).
    reason: () => reason,
  };
}
