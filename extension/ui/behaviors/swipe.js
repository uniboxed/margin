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
import { View } from '../render.js';

export const SETTLE_MS = 220;

/** @param {any} rt */
export function installSwipe(rt) {
  const { view, doc, container } = rt;
  const tracker = createSpaceSwipe();
  /** @type {{ el: HTMLElement, neighbours: Record<string, string | undefined>, width: number, base: { offset: number, events: number }, settling: boolean, frame: number, offset: number, panes: HTMLElement[], bases: { left: number, top: number, width: number, height: number }[], ghosts: Record<string, HTMLElement[] | null>, position: string, overflow: string, target: string | null, dispatched: boolean } | null} */
  let swiping = null;

  // The neighbouring spaces drawn beside the one shown, as Arc does (Tirth, 2026-11-07): the theme's own sidebar
  // rendered off screen with that space shown (rt.spaceView), its moving part (`data-swipe-pane`, else
  // `.space-pane` or `.swipes`) copied, inert, beside the real one, so the theme's own swipe rule moves both.
  // (A theme may move several parts: Neo-brutalism and Pixel move the space's head and its list, each `.swipes`.)
  const panesOf = (root) => /** @type {HTMLElement[]} */ ([...root.querySelectorAll('[data-swipe-pane]')].length
    ? [...root.querySelectorAll('[data-swipe-pane]')] : [...root.querySelectorAll('.space-pane, .swipes')]);
  function ghost(s, dir) {
    if (s.ghosts[dir] !== undefined) return;
    s.ghosts[dir] = null;
    const id = s.neighbours[dir];
    if (!id || !s.panes.length) return;
    const model = rt.spaceView?.(id);
    if (!model) return;
    /** @type {HTMLElement[]} */
    let sources = [];
    try {
      const holder = doc.createElement('div');
      const root = holder.attachShadow({ mode: 'open' });
      const v = new View(root, rt.theme.template, {});
      v.update(model);
      sources = panesOf(root).map((n) => /** @type {HTMLElement} */ (n.cloneNode(true)));
      v.destroy?.();
    } catch { sources = []; }
    if (sources.length !== s.panes.length) return;
    const copies = [];
    s.panes.forEach((p, i) => {
      const copy = sources[i];
      if (!p.parentNode) return;
      copy.removeAttribute('id');
      copy.setAttribute('aria-hidden', 'true');
      copy.setAttribute('inert', '');
      copy.classList.add('m-swipe-ghost');
      const b = s.bases[i];
      Object.assign(copy.style, { position: 'absolute', top: `${b.top}px`, left: `${b.left + Number(dir) * s.width}px`, width: `${b.width}px`, height: `${b.height}px`, margin: '0', pointerEvents: 'none' });
      s.el.append(copy);
      copies.push(copy);
    });
    s.ghosts[dir] = copies;
  }
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
    if (s.neighbours[toward]) ghost(s, String(toward));
    s.el.style.setProperty('--m-swipe-offset', `${Math.round(shown * 10) / 10}px`);
    // How far toward the neighbour (0 to 1), for a theme that blends the two spaces' colours.
    s.el.style.setProperty('--m-swipe-progress', `${Math.round(Math.min(1, Math.abs(shown) / s.width) * 1000) / 1000}`);
  }
  function begin(el) {
    const spaces = rt.vm?.spaces ?? [];
    const at = spaces.findIndex((s) => s.id === rt.vm?.space?.id);
    // The copies are placed in the swiping part itself, which clips them until they slide in: it's made their
    // containing block for the swipe (a positioned element), and each moving part's place in it is read at rest.
    const position = el.style.position;
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    const er = el.getBoundingClientRect();
    const panes = panesOf(el);
    const bases = panes.map((p) => {
      const r = p.getBoundingClientRect();
      return { left: r.left - er.left - el.clientLeft + el.scrollLeft, top: r.top - er.top - el.clientTop + el.scrollTop, width: p.offsetWidth, height: p.offsetHeight };
    });
    swiping = { el, neighbours: { [-1]: spaces[at - 1]?.id, [1]: spaces[at + 1]?.id }, width: er.width || 1, base: { offset: 0, events: 0 }, settling: false, frame: 0, offset: 0,
      panes, bases, ghosts: {}, overflow: el.style.overflow, position, target: null, dispatched: false };
    el.style.overflow = 'clip'; // the neighbours sit outside it until they slide in
    el.classList.add('m-swiping');
  }
  // Still "active" this long after a switch it sent (the runtime keeps the space it asked for shown meanwhile:
  // runtime.js viewState), as it was when the switch went at the settle's start.
  let holdUntil = 0;
  function finish() {
    const s = swiping;
    if (!s) return;
    swiping = null;
    if (s.dispatched) holdUntil = Date.now() + SETTLE_MS;
    cancelAnimationFrame(s.frame);
    s.el.classList.remove('m-swiping', 'm-settling');
    s.el.style.removeProperty('--m-swipe-offset');
    s.el.style.removeProperty('--m-swipe-progress');
    s.el.style.overflow = s.overflow;
    s.el.style.position = s.position;
    for (const list of Object.values(s.ghosts)) for (const g of list ?? []) g.remove();
  }
  function release({ offset, speed, events }) {
    const s = swiping;
    if (!s || s.settling) return;
    cancelAnimationFrame(s.frame);
    const dir = settle({ offset: offset - s.base.offset, speed, events: events - s.base.events, width: s.width, has: (d) => !!s.neighbours[d] });
    s.settling = true;
    s.el.classList.add('m-settling');
    s.el.style.setProperty('--m-swipe-offset', `${dir ? -dir * s.width : 0}px`);
    s.el.style.setProperty('--m-swipe-progress', dir ? '1' : '0');
    s.target = dir ? s.neighbours[dir] ?? null : null;
    // The neighbour slides fully in first; then the space is switched to, and the copy goes in the same frame the
    // real sidebar shows it (afterRender), so nothing jumps. Another profile's: the copy stays until the switch's
    // view of it is drawn here (ui/view-model.js foreignSpace), or 1.5 s.
    rt.later(() => {
      if (swiping !== s) return;
      if (!s.target) return finish();
      s.dispatched = true;
      rt.dispatch('space.switch', s.target, 'behavior');
      if (swiping === s && rt.vm?.space?.id === s.target) finish();
      rt.later(() => { if (swiping === s) finish(); }, 1500);
    }, SETTLE_MS);
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
    /** Moving or settling (or just switched space by a swipe). */
    active: () => swiping != null || Date.now() < holdUntil,
    destroy() { clearTimeout(endTimer); finish(); },
    /** The space switched to after a settle is drawn: the copy beside it goes, the offset with it. */
    afterRender(vm) { if (swiping?.dispatched && vm?.space?.id === swiping.target) finish(); },
  };
  return api;
}
