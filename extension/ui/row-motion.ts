// Rows that come and go, smoothly (Margin's own motion, the same in every theme): when a sidebar row leaves (a tab
// closed, a folder folded) it's gone at once and the rows after it slide up into its place; when one comes (a new tab,
// a folder opened) the rows after it slide down to make its room and it fades in. FLIP: every sidebar row's box is
// read before the view draws the change and again after (two layouts, all reads before any write), and each row that
// moved is animated from where it was to where it is with a transform; a new row with its opacity. Only transform and
// opacity, through the Web Animations API (on the compositor, removed when done: nothing left in the theme's styles).
//
// Not on the first drawing, not when the space changes (its list is drawn whole), not for a pure reorder (a drag's
// drop: the rows are where the person put them), not while a row is dragged, and never with reduced motion (the change
// is drawn at once). Nothing is read or done for a drawing whose rows are the same: the view model's lists are the
// same objects then (ui/view-model.ts structural sharing), and comparing them is all it costs.
import type { View } from './render.ts';
import type { ViewModel } from './view-model.ts';

/** How long the rows take to slide: not too slow, not too fast (Tirth). */
export const MOTION_MS = 200;
/** A standard ease-out: quick to start, settling into place. */
export const MOTION_EASING = 'cubic-bezier(0.2, 0, 0, 1)';

// The sidebar's rows by kind and id, in a set: today's tabs, the pinned area's folders and pins (a folder's shown ones),
// the launcher's pins.
function rowKeys(vm: ViewModel) {
  const keys = new Set<string>();
  for (const t of vm.space.today) keys.add(`t:${t.id}`);
  for (const g of vm.space.pinned) {
    if (g.isFolder) { keys.add(`f:${g.id}`); for (const p of g.shown) keys.add(`p:${p.id}`); } else keys.add(`p:${g.id}`);
  }
  for (const p of vm.launcher?.pins ?? []) keys.add(`l:${p.id}`);
  return keys;
}

/**
 * Whether going from `prev` to `next` adds or removes rows in the same space (what slides): false for the first
 * drawing, a space switched, the same lists, or the same rows in another order.
 * */
export function rowsChanged(prev: ViewModel | null, next: ViewModel | null) {
  if (!prev?.ready || !next?.ready || prev.space.id !== next.space.id) return false;
  if (prev.space.today === next.space.today && prev.space.pinned === next.space.pinned && (prev.launcher?.pins ?? null) === (next.launcher?.pins ?? null)) return false;
  const a = rowKeys(prev);
  const b = rowKeys(next);
  if (a.size !== b.size) return true;
  for (const k of a) if (!b.has(k)) return true;
  return false;
}

type Box = { left: number, top: number, bottom: number };

/**
 * @param skip  true: nothing slides this time (a row being dragged)
 */
export function createRowMotion(view: View, win: Window & typeof globalThis, { skip = () => false, duration = MOTION_MS }: { skip?: () => boolean, duration?: number } = {}) {
  const reduced = win.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
  let before: Map<Element, Box> | null = null;
  const running = new Set<Animation>();
  // The boxes on screen before the last change, until its first frame is drawn: a change again before then (a
  // switch that failed at once puts back what its highlight took away) starts from them, as nothing else was shown;
  // a slide just started isn't on screen yet, and reading the rows then would start the next slide from a place
  // they never were.
  let unpainted: Map<Element, Box> | null = null;
  let frame = 0;
  const boxOf = (el: Element): Box => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, bottom: r.bottom }; };
  const play = (el: Element, from: Keyframe) => {
    let a: Animation;
    // One keyframe: from there to the row's own value (a theme's transform or opacity), whatever it is.
    try { a = el.animate([from], { duration, easing: MOTION_EASING }); } catch { return; }
    running.add(a);
    a.onfinish = a.oncancel = () => running.delete(a);
  };
  return {
    /** Called with the model on screen and the one about to be drawn: true when the rows' boxes were read (call after()). */
    before(prev: ViewModel | null, next: ViewModel | null) {
      before = null;
      if (!rowsChanged(prev, next) || reduced?.matches || view.doc.hidden || skip()) return false;
      before = new Map();
      if (unpainted) {
        // (A row drawn by the last change only, never on screen: new here too.)
        for (const el of view.rowElements()) { const b = unpainted.get(el); if (b) before.set(el, b); }
        return true;
      }
      // (As they're seen now: a row still sliding from the last change, where it is this frame.)
      for (const el of view.rowElements()) before.set(el, boxOf(el));
      return true;
    },
    /** After the view drew the change: the rows that moved slide from where they were, the new ones fade in. */
    after() {
      const old = before;
      before = null;
      if (!old) return;
      // A slide still running: stopped, so the new boxes are the rows' own places.
      for (const a of [...running]) a.cancel();
      const height = win.innerHeight;
      const away = (b: Box) => b.bottom < 0 || b.top > height;
      const gone = [...old].filter(([el]) => !el.isConnected).map(([, b]) => b);
      const moves: [Element, number, number][] = [];
      const fresh: Element[] = [];
      for (const el of view.rowElements()) {
        const now = boxOf(el);
        const was = old.get(el);
        if (!was) {
          // A row drawn again in a row's place (a Margin tab opened: its row's id changes) isn't a new row.
          if (!away(now) && !gone.some((b) => Math.abs(b.top - now.top) < 1 && Math.abs(b.left - now.left) < 1)) fresh.push(el);
          continue;
        }
        const dx = was.left - now.left;
        const dy = was.top - now.top;
        if ((Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) || (away(was) && away(now)) || Math.abs(dy) > height) continue;
        moves.push([el, dx, dy]);
      }
      // (All the reads above, the writes here.)
      for (const [el, dx, dy] of moves) play(el, { transform: `translate(${Math.round(dx * 100) / 100}px, ${Math.round(dy * 100) / 100}px)` });
      for (const el of fresh) play(el, { opacity: 0 });
      unpainted = old;
      if (!frame) frame = win.requestAnimationFrame(() => { frame = 0; unpainted = null; });
    },
    /** Slides running now (the tests read it). */
    get running() { return running.size; },
    destroy() { for (const a of [...running]) a.cancel(); before = null; unpainted = null; if (frame) win.cancelAnimationFrame(frame); frame = 0; },
  };
}
