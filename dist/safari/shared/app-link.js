// What pages know of Margin.app's link (app/PROTOCOL.md), from storage.local
// `appLink`, which the background's link client (background/link.js) writes:
// { state, epoch, at, layouts }.
//
// - `state`: 'linked' (the app draws Margin's UI around this copy's
//   windows, and pages have their box from its layout), 'reconnecting' (the
//   link dropped a moment ago and is being tried again: the app keeps the
//   last picture dimmed meanwhile, and pages keep their box), 'off' (no app:
//   pages are left as they are, with no box). No page draws Margin's UI in
//   any state (Margin 2 Phase 2 step 5).
// - `layouts`: each window's page slot as the app's overlay measured it
//   (setLayout): { [windowId]: { insets, radius, radii, container, mode,
//   seq, epoch } }, insets in points from the window's edges.
//
// A page gives its own box from its window's layout, less where its viewport
// sits in the window (boxFromLayout). Pure: content scripts, the new-tab page
// and the background use it.

export const APP_LINK_KEY = 'appLink';

/** Whether the app draws Margin around the window (or will again in a moment): pages have their box. @param {any} link */
export const appDraws = (link) => link?.state === 'linked' || link?.state === 'reconnecting';

const finite = (v) => (Number.isFinite(v) ? v : 0);

/**
 * The layout for a window: its own, else, while the page doesn't know its
 * window yet, the one every window has (one window, or several of one size
 * and mode), else null.
 * @param {any} link @param {number | null | undefined} windowId
 */
export function layoutFor(link, windowId) {
  const layouts = link?.layouts && typeof link.layouts === 'object' ? link.layouts : {};
  if (windowId != null && layouts[windowId]) return layouts[windowId];
  if (windowId != null && Object.keys(layouts).length > 1) return null;
  const all = Object.values(layouts);
  if (!all.length) return null;
  const key = (l) => JSON.stringify([l?.insets, l?.container, l?.mode]);
  return all.every((l) => key(l) === key(all[0])) ? all[0] : null;
}

/**
 * The page's box from its window's layout: the insets are from the window's
 * edges in points; the box's are from the page's viewport in its (zoomed)
 * pixels. Where the viewport sits in the window comes from the page's own
 * outer and inner sizes: the width the window has beyond the viewport is
 * taken to be on the left (Safari's sidebar), the height on top (its
 * toolbar or tab bar, shown in full screen too when the pointer reaches the
 * top), unless the page says where it sits (`x`, `y`: its corner from the
 * window's, in points: content/core.js viewportNow, the Web Inspector docked
 * at the bottom or right leaving the rest there). Null: no box (nothing at
 * any edge).
 * @param {any} layout
 * @param {{ outerWidth: number, outerHeight: number, innerWidth: number, innerHeight: number, zoom?: number, x?: number, y?: number }} view
 * @returns {{ left: number, top: number, right: number, bottom: number } | null}
 */
export function boxFromLayout(layout, { outerWidth, outerHeight, innerWidth, innerHeight, zoom = 1, x, y }) {
  const insets = layout?.insets;
  if (!insets) return null;
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const w = finite(innerWidth) * z;
  const h = finite(innerHeight) * z;
  const offX = Math.max(0, finite(outerWidth) - w);
  const offY = Math.max(0, finite(outerHeight) - h);
  const left = Number.isFinite(x) ? Math.min(offX, Math.max(0, /** @type {number} */ (x))) : offX;
  const top = Number.isFinite(y) ? Math.min(offY, Math.max(0, /** @type {number} */ (y))) : offY;
  const half = (v) => Math.round(v * 2) / 2;
  const box = {
    left: half(Math.max(0, finite(insets.left) - left) / z),
    top: half(Math.max(0, finite(insets.top) - top) / z),
    right: half(Math.max(0, finite(insets.right) - (offX - left)) / z),
    bottom: half(Math.max(0, finite(insets.bottom) - (offY - top)) / z),
  };
  return Object.values(box).every((v) => v < 0.5) ? null : box;
}
