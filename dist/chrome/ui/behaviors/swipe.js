// Two fingers sideways over the sidebar switch space (Arc; themes/arcadia/
// sidebar.js "swipe between spaces", the gesture itself shared/
// space-swipe.js): `m-swipe="spaces"` marks the part that swipes. While the
// fingers move it has the class `m-swiping` and `--m-swipe-offset` (px, > 0
// toward the previous space; past the first or last space it resists), for
// the theme to move it with; let go past a third of its width, or with a
// flick, and the space that way is shown (as its chip pressed: at once,
// from the top of its list), else it goes back. Then `m-settling` for
// SETTLE_MS, with the offset at its end (a whole width that way, or 0).
// Not with a mouse wheel (or Shift), over something that scrolls sideways,
// with one space, while the sidebar is hidden or something is under way
// (renaming, a menu, a drag).
import { canScrollX } from '../../shared/gestures.js';
import { createSpaceSwipe, settle, rubberBand, DEFAULTS as SWIPE } from '../../shared/space-swipe.js';

export const SETTLE_MS = 220;

/** @param {any} rt */
export function installSwipe(rt) {
  const { view, doc, container } = rt;
  const tracker = createSpaceSwipe();
  /** @type {{ el: HTMLElement, neighbours: Record<string, string | undefined>, width: number, base: { offset: number, events: number }, settling: boolean, frame: number, offset: number } | null} */
  let swiping = null;
  let endTimer = null;

  // A mouse wheel, not a trackpad (sidebar.js mouseWheel): WebKit and
  // Chromium report a wheel's notches as multiples of 120 in the old
  // wheelDelta, a trackpad's as about 3× its pixel delta.
  const mouseWheel = (e) => {
    const legacy = /** @type {any} */ (e).wheelDeltaX ?? 0;
    return legacy !== 0 && legacy % 120 === 0 && Math.abs(Math.abs(legacy) - Math.abs(e.deltaX) * 3) > 3;
  };
  // Something between the pointer and the swipe's part scrolls sideways that way.
  const scrollsSideways = (e, stop) => {
    for (let n = /** @type {any} */ (e.target); n && n !== stop.parentNode; n = n.parentNode) {
      if (n.nodeType === 1 && canScrollX(n, e.deltaX, null)) return true;
      if (n === stop) break;
    }
    return false;
  };

  function place(offset) {
    const s = swiping;
    if (!s) return;
    const toward = offset > 0 ? -1 : 1;
    const shown = s.neighbours[toward] ? Math.max(-s.width, Math.min(s.width, offset)) : rubberBand(offset, s.width * 0.2);
    s.el.style.setProperty('--m-swipe-offset', `${Math.round(shown * 10) / 10}px`);
  }
  function begin(el) {
    const spaces = rt.vm?.spaces ?? [];
    const at = spaces.findIndex((s) => s.id === rt.vm?.space?.id);
    swiping = { el, neighbours: { [-1]: spaces[at - 1]?.id, [1]: spaces[at + 1]?.id }, width: el.getBoundingClientRect().width || 1, base: { offset: 0, events: 0 }, settling: false, frame: 0, offset: 0 };
    el.classList.add('m-swiping');
  }
  function finish() {
    const s = swiping;
    if (!s) return;
    swiping = null;
    cancelAnimationFrame(s.frame);
    s.el.classList.remove('m-swiping', 'm-settling');
    s.el.style.removeProperty('--m-swipe-offset');
  }
  function release({ offset, speed, events }) {
    const s = swiping;
    if (!s || s.settling) return;
    cancelAnimationFrame(s.frame);
    const dir = settle({ offset: offset - s.base.offset, speed, events: events - s.base.events, width: s.width, has: (d) => !!s.neighbours[d] });
    s.settling = true;
    s.el.classList.add('m-settling');
    s.el.style.setProperty('--m-swipe-offset', `${dir ? -dir * s.width : 0}px`);
    if (dir) rt.dispatch('space.switch', s.neighbours[dir], 'behavior');
    rt.later(() => { if (swiping === s) finish(); }, SETTLE_MS);
  }

  rt.listen(container, 'wheel', (/** @type {WheelEvent} */ e) => {
    const hit = view.behaviorAt(e.target, 'm-swipe', 'spaces');
    const el = /** @type {HTMLElement | null} */ (hit?.el ?? swiping?.el ?? null);
    if (!el) return;
    const vm = rt.vm;
    const usable = !!vm?.ready && vm.spaces.length > 1 && vm.window.sidebar !== 'hidden' && !rt.busy(api) && !!hit && !scrollsSideways(e, el);
    const result = tracker.wheel({ deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, mouse: mouseWheel(e), time: e.timeStamp, usable });
    if (tracker.swiping(e.timeStamp) && e.cancelable) e.preventDefault(); // not the list, not the browser's back/forward
    if (swiping?.settling) return; // its momentum is still that gesture
    if (result.phase === 'tracking') {
      clearTimeout(endTimer);
      if (!swiping) {
        begin(el);
        // Before this event (if it counted): 0 for a gesture that starts here.
        swiping.base = result.counted ? { offset: result.offset + e.deltaX, events: result.events - 1 } : { offset: result.offset, events: result.events };
      }
      swiping.offset = result.offset - swiping.base.offset;
      if (!swiping.frame) swiping.frame = requestAnimationFrame(() => { if (!swiping) return; swiping.frame = 0; place(swiping.offset); });
      endTimer = setTimeout(() => {
        const end = tracker.end();
        if (end.phase === 'release') release(end);
        else if (swiping && !swiping.settling) release({ offset: swiping.base.offset, speed: 0, events: swiping.base.events });
      }, SWIPE.GAP_MS + 20);
    } else if (result.phase === 'release') {
      clearTimeout(endTimer);
      release(result);
    }
  }, { passive: false });
  // The page hidden mid-swipe (another tab came to the front): put it back.
  rt.listen(doc, 'visibilitychange', () => {
    if (!doc.hidden || !swiping) return;
    clearTimeout(endTimer);
    tracker.reset();
    finish();
  });

  const api = {
    busy: () => swiping != null && !swiping.settling,
    /** Moving or settling. */
    active: () => swiping != null,
    destroy() { clearTimeout(endTimer); finish(); },
  };
  return api;
}
