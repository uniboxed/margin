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
 * new rows come out from under the row above them (clipped at its edge as they slide down with the rest), not faded in;
 * a tab or a pin closed stays where it was a moment, fading under the rows closing up over it (a folder's rows folding
 * go at once: in Arc they're covered, not faded).
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
  // Arc's: the rows closed (a tab's, a pin's), copied as they were drawn, to fade where they were (`ghosts`).
  let leaving: { copy: Element, parent: Element, left: number, top: number, width: number, height: number }[] = [];
  const keyOf = (el: Element) => {
    const v = view.subjectOf?.(el) as { kind?: string, id?: unknown, isFolder?: boolean } | null;
    if (!v || v.id == null) return null;
    return v.isFolder ? `f:${v.id}` : v.kind === 'tab' ? `t:${v.id}` : v.kind === 'pin' ? `p:${v.id}` : null;
  };
  function copyLeaving(prev: ViewModel, next: ViewModel) {
    leaving = [];
    const after = rowKeys(next);
    const gone = [...rowKeys(prev)].filter((k) => !after.has(k));
    // (Only rows closed: a tab's or one pin's; a folder folding takes its rows, none of them copied.)
    if (!gone.length || gone.some((k) => k.startsWith('f:') || k.startsWith('l:')) || gone.filter((k) => k.startsWith('p:')).length > 1) return;
    const keys = new Set(gone);
    for (const el of view.rowElements()) {
      if (!keys.has(keyOf(el) ?? '')) continue;
      const parent = (el as HTMLElement).offsetParent;
      if (!parent) continue;
      const r = el.getBoundingClientRect(), pr = parent.getBoundingClientRect();
      leaving.push({ copy: el.cloneNode(true) as Element, parent, left: r.left - pr.left - parent.clientLeft + parent.scrollLeft, top: r.top - pr.top - parent.clientTop + parent.scrollTop, width: r.width, height: r.height });
    }
  }
  function ghosts(timing: { duration: number, easing: string }) {
    for (const g of leaving) {
      if (!g.parent.isConnected) continue;
      const copy = g.copy as HTMLElement;
      copy.classList.add('m-row-ghost');
      copy.setAttribute('aria-hidden', 'true');
      copy.setAttribute('inert', '');
      copy.removeAttribute('id');
      Object.assign(copy.style, { position: 'absolute', left: `${g.left}px`, top: `${g.top}px`, width: `${g.width}px`, height: `${g.height}px`, margin: '0', zIndex: '-1', pointerEvents: 'none' });
      g.parent.append(copy);
      let a: Animation;
      try { a = copy.animate([{ opacity: 1 }, { opacity: 0 }], { ...timing, fill: 'forwards' }); } catch { copy.remove(); continue; }
      running.add(a);
      a.onfinish = a.oncancel = () => { running.delete(a); copy.remove(); };
    }
    leaving = [];
  }
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
      leaving = [];
      if (!rowsChanged(prev, next)) return false;
      // (Rows changed with no slide this time (reduced motion, a hidden page, a drag): a slide still running from the
      // last change stopped at once, so the rows are at their own places, never sliding on toward old ones.)
      if (reduced() || view.doc.hidden || skip()) { for (const a of [...running]) a.cancel(); unpainted = null; return false; }
      before = new Map();
      if (arcRows() && prev && next) copyLeaving(prev, next);
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
      if (arc && leaving.length) ghosts(timing);
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
    destroy() { for (const a of [...running]) a.cancel(); before = null; unpainted = null; leaving = []; if (frame) win.cancelAnimationFrame(frame); frame = 0; },
  };
}
