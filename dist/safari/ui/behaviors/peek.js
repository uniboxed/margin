// A hidden sidebar, brought out over the page by the pointer (content/
// layout.js, "Hover"): `m-peek="left|right|top|bottom"` marks the theme's
// hover zone at that edge of the window. The pointer in it brings the
// sidebar out (`window.sidebar` 'peek'); the pointer over the page again
// (or over the theme's bare background, its root) hides it HIDE_DELAY_MS
// later, unless it comes back first, and not while something is under way
// in the sidebar (renaming, a drag, a menu: rt.busy). Leaving the window
// hides it too, unless it left through the reveal edge. The zone's size is
// today's reveal zone (shared/view.js revealZone: 10 px, 24 px in a
// full-screen window, where Safari's own sidebar opens at the very edge),
// given to the theme as `--m-reveal-zone` on the zone.
//
// Where the page gets the pointer's events rather than the UI (a page under
// the in-page host's shadow root; the browser's page area under the app's
// window), the host hands its positions in (runtime.pointer, pointerLeft).
import * as V from '../../shared/view.js';

export const HIDE_DELAY_MS = 300;

/** @param {any} rt */
export function installPeek(rt) {
  const { view, win, container } = rt;
  /** @type {'hover' | null} */
  let reason = null;
  let hideTimer = null;
  let drawnZone = '';

  const zonePx = () => V.revealZone({ outerWidth: win.outerWidth, outerHeight: win.outerHeight, screenWidth: win.screen?.width ?? 0, screenHeight: win.screen?.height ?? 0 });
  const hidden = () => rt.vm?.window.sidebar === 'hidden';
  const edges = () => view.marked('m-peek').map((el) => view.behaviorOf(el).attrs['m-peek']);
  const size = () => {
    if (container.nodeType === 9) return { width: win.innerWidth, height: win.innerHeight };
    const r = /** @type {ShadowRoot} */ (container).host.getBoundingClientRect();
    return { width: r.width, height: r.height, left: r.left, top: r.top };
  };
  // Whether a point (the container's coordinates) is in the reveal zone of one of the theme's edges.
  const atEdge = (x, y) => {
    const px = zonePx();
    const { width, height } = size();
    return edges().some((edge) => (edge === 'left' ? x <= px : edge === 'right' ? x >= width - px : edge === 'top' ? y <= px : y >= height - px));
  };

  function show() {
    if (!hidden() && reason == null) return;
    clearTimeout(hideTimer);
    hideTimer = null;
    if (rt.vm?.window.sidebar === 'peek') return;
    reason = 'hover';
    rt.setUi({ sidebar: 'peek' });
  }
  function hide() {
    clearTimeout(hideTimer);
    hideTimer = null;
    reason = null;
    if (rt.ui.sidebar === 'peek') rt.setUi({ sidebar: null });
  }
  // Waits while the sidebar is busy, and hides once that's done if the
  // pointer is still away (show cancels).
  function scheduleHide() {
    if (reason !== 'hover' || hideTimer) return;
    hideTimer = setTimeout(function tryHide() {
      if (rt.destroyed) return;
      if (rt.busy()) { hideTimer = setTimeout(tryHide, HIDE_DELAY_MS); return; }
      hideTimer = null;
      hide();
    }, HIDE_DELAY_MS);
  }
  const stay = () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } };

  // Over the theme: in a zone brings it out; over the sidebar keeps it; over
  // the page (`<m-page>` takes no pointer: the theme's root under it) or the
  // root's bare background hides it.
  rt.listen(container, 'pointermove', (/** @type {PointerEvent} */ e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    const target = /** @type {Element} */ (e.target);
    if (view.behaviorAt(target, 'm-peek')) return show();
    if (reason !== 'hover') return;
    const inside = view.owns(target) && target !== view.rootElement() && target !== view.pageEl;
    if (inside) stay();
    else scheduleHide();
  }, { passive: true });
  // The pointer left the window: kept out only if it left through the reveal edge.
  rt.listen(rt.doc, 'mouseout', (/** @type {MouseEvent} */ e) => {
    if (e.relatedTarget || reason !== 'hover') return;
    const box = size();
    if (!atEdge(e.clientX - (box.left ?? 0), e.clientY - (box.top ?? 0))) scheduleHide();
  });

  return {
    afterRender(vm) {
      // Keep open turned on while it's out: it docks (content/layout.js settle).
      if (vm.window.pinnedOpen && rt.ui.sidebar === 'peek') { reason = null; clearTimeout(hideTimer); hideTimer = null; rt.setUi({ sidebar: null }); return; }
      const px = `${zonePx()}px`;
      const zones = view.marked('m-peek');
      const key = `${px}:${zones.length}`;
      if (key !== drawnZone || zones.some((z) => z.style.getPropertyValue('--m-reveal-zone') !== px)) {
        drawnZone = key;
        for (const z of zones) z.style.setProperty('--m-reveal-zone', px);
      }
    },
    /** A position over the page (the host's). */
    pagePointer({ x, y }) {
      if (atEdge(x, y)) return show();
      if (reason === 'hover') scheduleHide();
    },
    pageLeft({ x, y }) {
      if (reason === 'hover' && !atEdge(x, y)) scheduleHide();
    },
    /** Out of peek without a delay (Keep open turned on or off). */
    reset() { clearTimeout(hideTimer); hideTimer = null; reason = null; },
    reason: () => reason,
    busy: () => false,
    destroy() { clearTimeout(hideTimer); },
  };
}
