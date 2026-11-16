// What pages know of Margin.app's link (docs/PROTOCOL.md), from storage.local
// `appLink`, which the background's link client (background/link.ts) writes:
// { state, epoch, at, drawn, why? }.
//
// - `state`: 'linked' (the app draws Margin's UI around this copy's
//   windows), 'reconnecting' (the link dropped a moment ago and is being
//   tried again: the app keeps the last picture dimmed meanwhile), 'off' (no
//   app). No page draws Margin's UI in any state (Margin 2 Phase 2 step 5),
//   and no page has a box (removed 2026-11-16: DECISIONS.md "Hosted only").
// - `why` (only while 'off'): 'no-link' when Margin.app is running but sent
//   no link (the new-tab page says it isn't answering); 'sockets-off' when
//   the copy's socket guard turned its link off (background/link.ts), with
//   `offAt` and, for a 24 h off, `offUntil` (the new-tab page says so, with
//   Try again); absent otherwise.
// - `drawn`: whether the app draws over each window (`drawn` messages, this
//   link's epoch only): { [windowId]: boolean }. False: Margin.app draws
//   nothing over that window (not in full screen, or not found among the
//   window server's yet), so Margin's keys there go the unlinked way (the app's hot keys aren't on there). Missing: not said (yet, or an older app): as drawn.
//
// Pure: content scripts, the new-tab page and the background use it.

export const APP_LINK_KEY = 'appLink';

/** Whether the app draws Margin around the window (or will again in a moment). */
export const appDraws = (link: any) => link?.state === 'linked' || link?.state === 'reconnecting';

/** Whether the app said it draws nothing over the window (`drawn` false). */
export const undrawn = (link: any, windowId: number | null | undefined) => windowId != null && link?.drawn?.[windowId] === false;
/**
 * Whether the app draws Margin around this window: it draws (appDraws) and
 * hasn't said it draws nothing over the window. The keys a page or the
 * background hears there are left to the app only then.
 * */
export const drawsWindow = (link: any, windowId: number | null | undefined) => appDraws(link) && !undrawn(link, windowId);

const finite = (v: unknown): number => (Number.isFinite(v) ? v as number : 0);

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
