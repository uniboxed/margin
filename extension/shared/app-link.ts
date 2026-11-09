// What pages know of Margin.app's link (app/PROTOCOL.md), from storage.local
// `appLink`, which the background's link client (background/link.ts) writes:
// { state, epoch, at, layouts, why? }.
//
// - `state`: 'linked' (the app draws Margin's UI around this copy's
//   windows, and pages have their box from its layout), 'reconnecting' (the
//   link dropped a moment ago and is being tried again: the app keeps the
//   last picture dimmed meanwhile, and pages keep their box), 'off' (no app:
//   pages are left as they are, with no box). No page draws Margin's UI in
//   any state (Margin 2 Phase 2 step 5). Either of the first two, a window
//   the app said it draws nothing over (`drawn`) has no box.
// - `why` (only while 'off'): 'no-link' when Margin.app is running but sent
//   no link (the new-tab page says it isn't answering); 'sockets-off' when
//   the copy's socket guard turned its link off (background/link.ts), with
//   `offAt` and, for a 24 h off, `offUntil` (the new-tab page says so, with
//   Try again); absent otherwise.
// - `layouts`: each window's page slot as the app's overlay measured it
//   (setLayout): { [windowId]: { insets, radius, radii, container, mode,
//   seq, epoch } }, insets in points from the window's edges.
// - `drawn`: whether the app draws over each window (`drawn` messages, this
//   link's epoch only): { [windowId]: boolean }. False: Margin.app draws
//   nothing over that window (not in full screen, or not found among the
//   window server's yet), so its pages get no box, and Margin's keys there
//   go the unlinked way (the app's hot keys aren't on there). Missing: not said (yet, or an older app): as drawn.
//
// A page gives its own box from its window's layout, less where its viewport
// sits in the window (boxFromLayout). Pure: content scripts, the new-tab page
// and the background use it.

export const APP_LINK_KEY = 'appLink';

/** Whether the app draws Margin around the window (or will again in a moment): pages have their box. */
export const appDraws = (link: any) => link?.state === 'linked' || link?.state === 'reconnecting';

/** Whether the app said it draws nothing over the window (`drawn` false). */
export const undrawn = (link: any, windowId: number | null | undefined) => windowId != null && link?.drawn?.[windowId] === false;
/**
 * Whether the app draws Margin around this window: it draws (appDraws) and
 * hasn't said it draws nothing over the window. The keys a page or the
 * background hears there are left to the app only then.
 * */
export const drawsWindow = (link: any, windowId: number | null | undefined) => appDraws(link) && !undrawn(link, windowId);

const finite = (v) => (Number.isFinite(v) ? v : 0);

// A window the app draws nothing over: a layout with nothing at any edge (no box).
export const NOT_DRAWN = Object.freeze({ insets: Object.freeze({ left: 0, top: 0, right: 0, bottom: 0 }), radius: 0, radii: null, drawn: false });

/**
 * The layout for a window: NOT_DRAWN where the app said it draws nothing
 * over it; its own; for a known window with none of its own yet, null (not
 * measured yet: the page keeps the box it has); while the page doesn't know
 * its window yet, the one every drawn window has (one window, or several of
 * one size and mode), else null.
 * */
export function layoutFor(link: any, windowId: number | null | undefined) {
  const layouts = link?.layouts && typeof link.layouts === 'object' ? link.layouts : {};
  if (undrawn(link, windowId)) return NOT_DRAWN;
  if (windowId != null) return layouts[windowId] ?? null;
  const all = Object.entries(layouts).filter(([id]) => link?.drawn?.[id] !== false).map(([, l]) => l);
  if (!all.length) return null;
  const key = (l) => JSON.stringify([l?.insets, l?.container, l?.mode]);
  return all.every((l) => key(l) === key(all[0])) ? all[0] : null;
}

/**
 * The page's area in CSS pixels as it is before any pinch (a pinch magnifies the page; it doesn't change its area).
 * WebKit gives innerWidth and innerHeight divided by the pinch's scale (measured 2026-11-07: a 1512 × 949 page
 * pinched 3× reads 504 × 316, visualViewport 504 × 316.33 at scale 3), which read as Safari taking most of the
 * window: Margin drew its sidebar into a corner, and the page lost its box. Unpinched, innerWidth and innerHeight
 * as they are. Pinched, scaled back, from the larger of the inner and visual viewport sizes (the inner size is
 * rounded down to whole pixels; the visual one leaves out a classic scrollbar).
 * */
export function unpinchedSize({ innerWidth, innerHeight, visualViewport = null }: { innerWidth: number, innerHeight: number, visualViewport?: { width: number, height: number, scale: number } | null }): { width: number, height: number } {
  const s = visualViewport?.scale;
  if (!(Number.isFinite(s) && (s as number) > 1.001)) return { width: innerWidth, height: innerHeight };
  const k = (s as number);
  return {
    width: Math.max(innerWidth, finite(visualViewport?.width)) * k,
    height: Math.max(innerHeight, finite(visualViewport?.height)) * k,
  };
}

/**
 * The page's box from its window's layout: the insets are from the window's
 * edges in points; the box's are from the page's viewport in its (zoomed)
 * pixels. Where the viewport sits in the window comes from the page's own
 * outer and inner sizes: the width the window has beyond the viewport is
 * taken to be on the left (Safari's sidebar), the height on top (its
 * toolbar or tab bar, shown in full screen too when the pointer reaches the
 * top), unless the page says where it sits (`x`, `y`: its corner from the
 * window's, in points: content/core.ts viewportNow, the Web Inspector docked
 * at the bottom or right leaving the rest there). Null: no box (nothing at
 * any edge).
 */
export function boxFromLayout(layout: any, { outerWidth, outerHeight, innerWidth, innerHeight, zoom = 1, x, y }: { outerWidth: number, outerHeight: number, innerWidth: number, innerHeight: number, zoom?: number, x?: number, y?: number }): { left: number, top: number, right: number, bottom: number } | null {
  const insets = layout?.insets;
  if (!insets) return null;
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const w = finite(innerWidth) * z;
  const h = finite(innerHeight) * z;
  const offX = Math.max(0, finite(outerWidth) - w);
  const offY = Math.max(0, finite(outerHeight) - h);
  const left = Number.isFinite(x) ? Math.min(offX, Math.max(0, (x as number))) : offX;
  const top = Number.isFinite(y) ? Math.min(offY, Math.max(0, (y as number))) : offY;
  const half = (v) => Math.round(v * 2) / 2;
  const box = {
    left: half(Math.max(0, finite(insets.left) - left) / z),
    top: half(Math.max(0, finite(insets.top) - top) / z),
    right: half(Math.max(0, finite(insets.right) - (offX - left)) / z),
    bottom: half(Math.max(0, finite(insets.bottom) - (offY - top)) / z),
  };
  return Object.values(box).every((v) => v < 0.5) ? null : box;
}
