// What pages know of Margin.app's link (app/PROTOCOL.md), from storage.local
// `appLink`, which the background's link client (background/link.js) writes:
// { state, epoch, at, layouts }.
//
// - `state`: 'linked' (the app draws Margin's UI around this copy's windows:
//   pages draw none), 'reconnecting' (the link dropped a moment ago and is
//   being tried again: the app keeps the last picture dimmed meanwhile, and
//   pages still draw none), 'off' (no app: pages draw the in-page
//   development host, as before Margin 2's app).
// - `layouts`: each window's page slot as the app's overlay measured it
//   (setLayout): { [windowId]: { insets, radius, radii, container, mode,
//   seq, epoch } }, insets in points from the window's edges.
//
// A page gives its own box from its window's layout, less where its viewport
// sits in the window (boxFromLayout). Pure: content scripts, the new-tab page
// and the background use it.

export const APP_LINK_KEY = 'appLink';

/** Whether pages should draw no Margin UI (the app draws it, or will again in a moment). @param {any} link */
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
 * top). Null: no box (nothing at any edge).
 * @param {any} layout
 * @param {{ outerWidth: number, outerHeight: number, innerWidth: number, innerHeight: number, zoom?: number }} view
 * @returns {{ left: number, top: number, right: number, bottom: number } | null}
 */
export function boxFromLayout(layout, { outerWidth, outerHeight, innerWidth, innerHeight, zoom = 1 }) {
  const insets = layout?.insets;
  if (!insets) return null;
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const offX = Math.max(0, finite(outerWidth) - finite(innerWidth) * z);
  const offY = Math.max(0, finite(outerHeight) - finite(innerHeight) * z);
  const half = (v) => Math.round(v * 2) / 2;
  const box = {
    left: half(Math.max(0, finite(insets.left) - offX) / z),
    top: half(Math.max(0, finite(insets.top) - offY) / z),
    right: half(Math.max(0, finite(insets.right)) / z),
    bottom: half(Math.max(0, finite(insets.bottom)) / z),
  };
  return Object.values(box).every((v) => v < 0.5) ? null : box;
}
