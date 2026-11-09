// A hidden sidebar, brought out over the page (content/layout.ts before
// Margin 2): `m-peek="left|right|top|bottom"` marks the theme's hover zone at
// that edge of the window. The pointer in it brings the sidebar out
// (`window.sidebar` 'peek'); the pointer over the page again (or over the
// theme's bare background, its root) hides it HIDE_DELAY_MS later, unless it
// comes back first, and not while something is under way in the sidebar
// (renaming, a drag, a menu: rt.busy). Leaving the window hides it too,
// unless it left through the reveal edge. The zone's size is today's reveal
// zone (shared/view.ts revealZone: 10 px, 24 px in a full-screen window,
// where Safari's own sidebar opens at the very edge), given to the theme as
// `--m-reveal-zone` on the zone.
//
// The host can bring it out too (runtime.sidebar): the show/hide key
// ('toggle': it stays until the key again, Escape, or a click on the page,
// which the host reports with hide()), and a moment after a space switch by
// key ('flash').
//
// Where the page gets the pointer's events rather than the UI (a page under
// the in-page host's shadow root; the browser's page area under the app's
// window), the host hands its positions in (runtime.pointer, pointerLeft).
import type { Rt } from '../runtime.ts';
import type { ViewModel } from '../view-model.ts';
import * as V from '../../shared/view.ts';

export const HIDE_DELAY_MS = 300;
export const FLASH_MS = 1200;

export function installPeek(rt: Rt) {
  const { view, win, container } = rt;
  // Why it's out: the pointer at the edge ('hover': it goes once the pointer
  // is over the page again), the show/hide key ('toggle'), a moment after a
  // space switch by key ('flash'). Null: not out.
  let reason: 'hover' | 'toggle' | 'flash' | null = null;
  let hideTimer: number | null = null;
  let flashTimer: number | null = null;
  let drawnZone = '';

  // The zone's size in Margin's pixels; positions come in the page's (rt.scale).
  const zonePx = () => V.revealZone({ outerWidth: win.outerWidth, outerHeight: win.outerHeight, screenWidth: win.screen?.width ?? 0, screenHeight: win.screen?.height ?? 0 });
  const hidden = () => rt.vm?.window.sidebar === 'hidden';
  const edges = () => view.marked('m-peek').map((el) => view.behaviorOf(el)!.attrs['m-peek']); // (marked: each has its behaviors)
  const size = () => {
    if (container.nodeType === 9) return { width: win.innerWidth, height: win.innerHeight };
    const r = (container as ShadowRoot).host.getBoundingClientRect();
    return { width: r.width, height: r.height, left: r.left, top: r.top };
  };
  // Whether a point (the container's coordinates) is in the reveal zone of one of the theme's edges.
  const atEdge = (x: number, y: number) => {
    const px = zonePx() / (rt.scale?.() || 1);
    const { width, height } = size();
    return edges().some((edge) => (edge === 'left' ? x <= px : edge === 'right' ? x >= width - px : edge === 'top' ? y <= px : y >= height - px));
  };
  const stopFlash = () => { clearTimeout(flashTimer); flashTimer = null; };

  /** whether it's out */
  function showFor(why: 'hover' | 'toggle' | 'flash'): boolean {
    if (!hidden() && reason == null) return false; // docked (Keep open): nothing to bring out
    clearTimeout(hideTimer);
    hideTimer = null;
    // Toggled out, it stays toggled; hovered or flashed, a toggle takes it over.
    if (reason !== 'toggle' || why === 'toggle') reason = why;
    if (why !== 'flash') stopFlash();
    if (rt.vm?.window.sidebar !== 'peek') rt.setUi({ sidebar: 'peek' });
    return true;
  }
  const show = () => showFor('hover');
  function hide() {
    clearTimeout(hideTimer);
    hideTimer = null;
    stopFlash();
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
  rt.listen(container, 'pointermove', (e: PointerEvent) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    const target = (e.target as Element);
    if (view.behaviorAt(target, 'm-peek')) return void show();
    const inside = view.owns(target) && target !== view.rootElement() && target !== view.pageEl;
    // Flashed out, the pointer on it keeps it, as a hover.
    if (reason === 'flash' && inside) { reason = 'hover'; stopFlash(); }
    if (reason !== 'hover') return;
    if (inside) stay();
    else scheduleHide();
  }, { passive: true });
  // The pointer left the window: kept out only if it left through the reveal edge.
  rt.listen(rt.doc, 'mouseout', (e: MouseEvent) => {
    if (e.relatedTarget || reason !== 'hover') return;
    const box = size();
    if (!atEdge(e.clientX - (box.left ?? 0), e.clientY - (box.top ?? 0))) scheduleHide();
  });
  // Toggled out: Escape takes it back (not one a menu, the palette or an edit takes).
  rt.listen(rt.doc, 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && reason === 'toggle' && !rt.ui.palette?.open && !rt.ui.menu && !rt.busy()) hide();
  }, true);

  return {
    afterRender(vm: ViewModel) {
      // Keep open turned on while it's out: it docks.
      if (vm.window.pinnedOpen && rt.ui.sidebar === 'peek') { reason = null; clearTimeout(hideTimer); hideTimer = null; stopFlash(); rt.setUi({ sidebar: null }); return; }
      const px = `${zonePx()}px`;
      const zones = view.marked('m-peek');
      const key = `${px}:${zones.length}`;
      if (key !== drawnZone || zones.some((z) => z.style.getPropertyValue('--m-reveal-zone') !== px)) {
        drawnZone = key;
        for (const z of zones) z.style.setProperty('--m-reveal-zone', px);
      }
    },
    /**
     * A position the host hands in: over the page (whose events the UI doesn't
     * get), or, from Margin.app, anywhere over its overlay: the app is never
     * the active app, so its web view may not hear the pointer moving at all
     * (only clicks), and the positions it hands in are all peek has. Over the
     * theme's own UI then, the same rules as its pointermove.
     */
    pagePointer({ x, y }: { x: number, y: number }) {
      if (atEdge(x, y)) return void show();
      const target = container.nodeType === 9 ? (container as Document).elementFromPoint(x, y) : null;
      if (target && view.behaviorAt(target, 'm-peek')) return void show();
      const inside = !!target && view.owns(target) && target !== view.rootElement() && target !== view.pageEl;
      if (reason === 'flash' && inside) { reason = 'hover'; stopFlash(); }
      if (reason !== 'hover') return;
      if (inside) stay();
      else scheduleHide();
    },
    pageLeft({ x, y }: { x: number, y: number }) {
      if (reason === 'hover' && !atEdge(x, y)) scheduleHide();
    },
    showFor,
    hide,
    /**
     * The show/hide key: with Keep open on, it turns it off (the sidebar
     * goes); out over the page, it goes back; else it comes out until the
     * key again, Escape or a click on the page.
     */
    toggle() {
      if (rt.vm?.window.pinnedOpen) return rt.dispatch('sidebar.toggle', undefined, 'behavior');
      if (reason) return void hide();
      showFor('toggle');
    },
    /** Out for `ms` (after a space switch by key), unless hovered or toggled meanwhile. */
    flash(ms = FLASH_MS) {
      if (reason && reason !== 'flash') return;
      if (!showFor('flash')) return;
      stopFlash();
      flashTimer = setTimeout(() => { flashTimer = null; if (reason === 'flash') hide(); }, ms);
    },
    /** Out of peek without a delay (Keep open turned on or off). */
    reset() { clearTimeout(hideTimer); hideTimer = null; stopFlash(); reason = null; },
    reason: () => reason,
    busy: () => false,
    destroy() { clearTimeout(hideTimer); stopFlash(); },
  };
}
