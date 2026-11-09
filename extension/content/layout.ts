// The page's box (Margin 2): while Margin.app is linked, the app's layout for
// the page's window (content/core.ts appGeometry), as the page's box
// (shared/page-box.ts, content/page-link.ts); not linked, none: the page as
// it is. Pages draw none of Margin's UI (PLAN.md §7). Until this first says
// where the box goes, the page has the first paint's box (registered while
// the app is linked: background/registered.ts), which the page's world then
// hands over to its own (content/page/main.ts). Called by content/core.ts.
import { mark } from '../shared/dom.ts';

/**
 * Where the page goes, in the page's (zoomed) pixels from the viewport's edges.
 */
export type Geometry = { insets: { left: number, top: number, right: number, bottom: number }, radius?: number, radii?: number[] };

// `page`: see content/core.ts.
export function startLayout(page: any) {
  const { marks } = page;
  let source: (() => Geometry | null) | null = null; // the app's layout for the window, while it's linked
  // Nothing at any edge: the page as it is, no box.
  const boxOf = (g: Geometry) => {
    const { left, top, right, bottom } = g.insets;
    if ([left, top, right, bottom].every((v) => Math.abs(v) < 0.5)) return null;
    return { left: Math.max(0, left), top: Math.max(0, top), right: Math.max(0, right), bottom: Math.max(0, bottom) };
  };
  // Linked with no layout for the window yet: the box stays as it is (the
  // first paint's). Not linked, out of the way (content/core.ts active:
  // Chrome outside full screen), no box. A copy that stood back leaves the
  // box to the one in charge.
  function settle() {
    if (page.dormant()) return;
    const geometry = source ? source() : null;
    if (source && !geometry) return;
    const box = page.active() && geometry ? boxOf(geometry) : null;
    page.setBox(box);
    mark(marks, 'box', box ? String(Math.round(box.left)) : 'off'); // test/debug hook
  }

  return {
    // After the state, the link or the window changed: the box as it should be now.
    settle,
    // The page's zoom changed: the layout is in the page's pixels again.
    rezoom: settle,
    // Where the box comes from while Margin.app is linked (content/core.ts:
    // the window's layout from the app); null: not linked, no box.
    setSource: (fn: (() => Geometry | null) | null) => { source = fn; },
  };
}
