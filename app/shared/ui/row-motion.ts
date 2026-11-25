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
/**
 * Arc's rows, for a theme that asks for them (`--m-rows-feel: arc` on its root: Arcadia; M2.10, docs/ARC-SIDEBAR.md
 * "Motion", measured frame by frame in Arc 1.174.2 folding and unfolding a folder of three): rows making room for new
 * ones slide on its opening curve (each frame within 0.31 pt RMS), rows closing up on its closing curve (0.27 pt); the
 * new rows come out from under the row above them (clipped at its edge as they slide down with the rest), not faded in.
 */
export const ARC_ROWS = Object.freeze({
  open: Object.freeze({ duration: 210, easing: 'cubic-bezier(0.5, 0.8, 0.75, 1)' }),
  close: Object.freeze({ duration: 250, easing: 'cubic-bezier(0.25, 0, 0.25, 1)' }),
});

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
  // (Asked afresh at each change of the rows, never a list kept from the start: WebKit's kept MediaQueryList still said
  // no-preference for a moment after Reduce Motion came on, while a fresh one said reduce, and that change slid,
  // 2026-11-21. Rows change at a click, a close or an open: never per frame.)
  const reduced = () => win.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  let before: Map<Element, Box> | null = null;
  const running = new Set<Animation>();
  // The boxes on screen before the last change, until its first frame is drawn: a change again before then (a
  // switch that failed at once puts back what its highlight took away) starts from them, as nothing else was shown;
  // a slide just started isn't on screen yet, and reading the rows then would start the next slide from a place
  // they never were.
  let unpainted: Map<Element, Box> | null = null;
  let frame = 0;
  const boxOf = (el: Element): Box => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, bottom: r.bottom }; };
  const play = (el: Element, frames: Keyframe | Keyframe[], timing: { duration: number, easing: string } = { duration, easing: MOTION_EASING }) => {
    let a: Animation;
    // One keyframe: from there to the row's own value (a theme's transform or opacity), whatever it is; or a row's own
    // keyframes (Arc's new rows).
    try { a = el.animate(Array.isArray(frames) ? frames : [frames], timing); } catch { return; }
    running.add(a);
    a.onfinish = a.oncancel = () => running.delete(a);
  };
  // The theme's feel for its rows, asked at each change (`--m-rows-feel` on its root): Arc's, or Margin's own.
  const arcRows = () => {
    const root = view.rootElement?.();
    return !!root && win.getComputedStyle(root).getPropertyValue('--m-rows-feel').trim() === 'arc';
  };
  return {
    /** Called with the model on screen and the one about to be drawn: true when the rows' boxes were read (call after()). */
    before(prev: ViewModel | null, next: ViewModel | null) {
      before = null;
      if (!rowsChanged(prev, next)) return false;
      // (Rows changed with no slide this time (reduced motion, a hidden page, a drag): a slide still running from the
      // last change stopped at once, so the rows are at their own places, never sliding on toward old ones.)
      if (reduced() || view.doc.hidden || skip()) { for (const a of [...running]) a.cancel(); unpainted = null; return false; }
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
      const arc = arcRows();
      // (Arc's: new rows given room, its opening curve; only rows closing up, its closing curve. The new rows' own: where
      // they come out, under the edge of the block's room: how far the rows after them went down, else the block's
      // height and the gap after it.)
      const timing = arc ? (fresh.length ? ARC_ROWS.open : ARC_ROWS.close) : { duration, easing: MOTION_EASING };
      let reveal: { top: number, room: number, boxes: Map<Element, Box> } | null = null;
      if (arc && fresh.length) {
        const boxes = new Map(fresh.map((el): [Element, Box] => [el, boxOf(el)]));
        const top = Math.min(...[...boxes.values()].map((b) => b.top));
        const pushed = Math.max(0, ...moves.map(([, , dy]) => -dy));
        const room = pushed > 0.5 ? pushed : Math.max(...[...boxes.values()].map((b) => b.bottom)) - top + 5;
        reveal = { top, room, boxes };
      }
      // (All the reads above, the writes here.)
      for (const [el, dx, dy] of moves) play(el, { transform: `translate(${Math.round(dx * 100) / 100}px, ${Math.round(dy * 100) / 100}px)` }, timing);
      for (const el of fresh) {
        if (!reveal) { play(el, { opacity: 0 }, timing); continue; }
        // Out from under the block's edge: down the room with the rows after it, hidden above that edge (its clip
        // shrinking with it, to nothing once it's out: keyframes in the curve's progress, so it stays exact).
        const b = reveal.boxes.get(el)!;
        const below = Math.max(0, b.top - reveal.top);
        const out = Math.min(1, below / reveal.room);
        const r = (v: number) => Math.round(v * 100) / 100;
        const frames: Keyframe[] = [{ offset: 0, transform: `translateY(${r(-reveal.room)}px)`, clipPath: `inset(${r(Math.max(0, reveal.room - below))}px 0 0 0)` }];
        if (out > 0 && out < 1) frames.push({ offset: r(1 - out), transform: `translateY(${r(-below)}px)`, clipPath: 'inset(0px 0 0 0)' });
        frames.push({ offset: 1, transform: 'translateY(0px)', clipPath: 'inset(0px 0 0 0)' });
        play(el, frames, timing);
      }
      unpainted = old;
      if (!frame) frame = win.requestAnimationFrame(() => { frame = 0; unpainted = null; });
    },
    /** Slides running now (the tests read it). */
    get running() { return running.size; },
    destroy() { for (const a of [...running]) a.cancel(); before = null; unpainted = null; if (frame) win.cancelAnimationFrame(frame); frame = 0; },
  };
}
