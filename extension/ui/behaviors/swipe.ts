// Two fingers sideways over the sidebar switch space (Arc; themes/arcadia/
// sidebar.js "swipe between spaces", the gesture itself shared/
// space-swipe.ts): `m-swipe="spaces"` marks the part that swipes. While the
// fingers move it has the class `m-swiping` and `--m-swipe-offset` (px, > 0
// toward the previous space; past the first or last space it resists), for
// the theme to move it with; let go past a third of its width, or with a
// flick, and the space that way is shown (as its chip pressed: at once,
// from the top of its list), else it goes back. Then `m-settling` for
// SETTLE_MS, with the offset at its end (a whole width that way, or 0).
// Not with a mouse wheel (or Shift), over something that scrolls sideways,
// with one space, while the sidebar is hidden or something is under way
// (renaming, a menu, a drag).
//
// A theme may ask for Arc's or Dia's own feel (`--m-swipe-feel: arc | dia` on
// the swiping part; shared/space-swipe.ts ARC and FEELS, from their code): the
// sidebar at half the fingers' distance, their choice at the lift (the speed
// over the last 100 ms, else the nearest space), their rubber band, the settle
// their spring (Arc 0.4 s, Dia 0.25 s) played as one transition sampled at
// 240 Hz (`--m-swipe-transition`, a `linear()` easing, under `m-settling`: the
// theme's moving part takes it), and with Dia's a haptic tick in Margin.app as
// the nearer space changes. In Margin.app the trackpad's own phases say when
// the fingers touch and lift (`m-wheel-phase`, app/shared/host/overlay.ts):
// let go at the lift, the momentum after it never moves the space, and fingers
// resting mid-swipe keep it held, as in Arc.
import type { Rt } from '../runtime.ts';
import type { ViewModel } from '../view-model.ts';
import { canScrollX } from '../../shared/gestures.ts';
import { createSpaceSwipe, settle, rubberBand, settleArc, rubberBandArc, springArc, springKeyframes, ARC, FEELS, DEFAULTS as SWIPE } from '../../shared/space-swipe.ts';
import { View } from '../render.ts';

export const SETTLE_MS = 220;
// The trackpad's phases known: a swipe whose fingers are down is let go anyway after this long with no event (its
// lift lost: never held for good).
const HELD_MAX_MS = 2000;

export function installSwipe(rt: Rt) {
  const { view, doc, container } = rt;
  const tracker = createSpaceSwipe();
  // `arc`: the theme's feel is Arc's or Dia's (`scale` its distance, `response` its spring's, `haptics` Dia's tick);
  // `shown`: the offset drawn now; `detent`: the space nearest it (-1, 0, 1), its change a haptic tick.
  let swiping: { el: HTMLElement, neighbours: Record<string, string | undefined>, width: number, base: { offset: number, events: number }, settling: boolean, frame: number, offset: number, panes: HTMLElement[], bases: { left: number, top: number, width: number, height: number }[], ghosts: Record<string, HTMLElement[] | null>, position: string, overflow: string, target: string | null, dispatched: boolean, arc: boolean, scale: number, response: number, haptics: boolean, shown: number, detent: number } | null = null;
  // The trackpad's phases (Margin.app tells them: `m-wheel-phase`): known at all, the fingers down, the momentum after a
  // lift under way, and a touch since the last wheel event (the next one starts a new gesture).
  const phases = { known: false, fingers: false, momentum: false, touched: false };

  // The neighbouring spaces drawn beside the one shown, as Arc does (requested 2026-11-07): the theme's own sidebar
  // rendered off screen with that space shown (rt.spaceView), its moving part (`data-swipe-pane`, else
  // `.space-pane` or `.swipes`) copied, inert, beside the real one, so the theme's own swipe rule moves both.
  // (A theme may move several parts: Neubrutalism and Pixel move the space's head and its list, each `.swipes`.)
  const panesOf = (root: ShadowRoot | HTMLElement) => (([...root.querySelectorAll('[data-swipe-pane]')].length
    ? [...root.querySelectorAll('[data-swipe-pane]')] : [...root.querySelectorAll('.space-pane, .swipes')]) as HTMLElement[]);
  function ghost(s: NonNullable<typeof swiping>, dir: string) {
    if (s.ghosts[dir] !== undefined) return;
    s.ghosts[dir] = null;
    const id = s.neighbours[dir];
    if (!id || !s.panes.length) return;
    const model = rt.spaceView?.(id);
    if (!model) return;
    let sources: HTMLElement[] = [];
    try {
      const holder = doc.createElement('div');
      const root = holder.attachShadow({ mode: 'open' });
      const v = new View(root, rt.theme.template, {});
      v.update(model);
      sources = panesOf(root).map((n) => (n.cloneNode(true) as HTMLElement));
      v.destroy?.();
    } catch { sources = []; }
    if (sources.length !== s.panes.length) return;
    const copies: HTMLElement[] = [];
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
  let endTimer: Timer | null = null;

  // A mouse wheel, not a trackpad (sidebar.js mouseWheel): WebKit and
  // Chromium report a wheel's notches as multiples of 120 in the old
  // wheelDelta, a trackpad's as about 3× its pixel delta.
  const mouseWheel = (e: WheelEvent) => {
    const legacy = (e as any).wheelDeltaX ?? 0;
    return legacy !== 0 && legacy % 120 === 0 && Math.abs(Math.abs(legacy) - Math.abs(e.deltaX) * 3) > 3;
  };
  // Something between the pointer and the swipe's part scrolls sideways that way.
  const scrollsSideways = (e: WheelEvent, stop: HTMLElement) => {
    for (let n = (e.target as any); n && n !== stop.parentNode; n = n.parentNode) {
      if (n.nodeType === 1 && canScrollX(n, e.deltaX, null)) return true;
      if (n === stop) break;
    }
    return false;
  };

  function draw(s: NonNullable<typeof swiping>, shown: number) {
    s.shown = shown;
    s.el.style.setProperty('--m-swipe-offset', `${Math.round(shown * 10) / 10}px`);
    // How far toward the neighbour (0 to 1), for a theme that blends the two spaces' colours.
    s.el.style.setProperty('--m-swipe-progress', `${Math.round(Math.min(1, Math.abs(shown) / s.width) * 1000) / 1000}`);
  }
  function place(offset: number) {
    const s = swiping;
    if (!s) return;
    const toward = offset > 0 ? -1 : 1;
    const shown = s.neighbours[toward] ? Math.max(-s.width, Math.min(s.width, offset)) : s.arc ? rubberBandArc(offset) : rubberBand(offset, s.width * 0.2);
    if (s.neighbours[toward]) ghost(s, String(toward));
    draw(s, shown);
    // Dia's detent: the space nearest the offset changed (past half its width): the trackpad's alignment tick.
    if (s.haptics) {
      const near = Math.round(-shown / s.width);
      const detent = near && s.neighbours[near > 0 ? 1 : -1] ? Math.sign(near) : 0;
      if (detent !== s.detent) {
        s.detent = detent;
        rt.host.perform?.('haptic.alignment');
      }
    }
  }
  function begin(el: HTMLElement) {
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
    const feel = FEELS[getComputedStyle(el).getPropertyValue('--m-swipe-feel').trim()] ?? null;
    const arc = !!feel;
    swiping = { el, neighbours: { [-1]: spaces[at - 1]?.id, [1]: spaces[at + 1]?.id }, width: er.width || 1, base: { offset: 0, events: 0 }, settling: false, frame: 0, offset: 0,
      panes, bases, ghosts: {}, overflow: el.style.overflow, position, target: null, dispatched: false, arc, scale: arc ? ARC.SCALE : 1, response: feel?.response ?? ARC.RESPONSE, haptics: feel?.haptics ?? false, shown: 0, detent: 0 };
    el.style.overflow = 'clip'; // the neighbours sit outside it until they slide in
    el.classList.add('m-swiping');
  }
  // Still "active" this long after a switch it sent (the runtime keeps the space it asked for shown meanwhile:
  // runtime.ts viewState), as it was when the switch went at the settle's start.
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
    s.el.style.removeProperty('--m-swipe-transition');
    s.el.style.overflow = s.overflow;
    s.el.style.position = s.position;
    for (const list of Object.values(s.ghosts)) for (const g of list ?? []) g.remove();
  }
  // `time`: when it was let go (a lift's, from the trackpad's phases or by its momentum's first event: `lifted`), for
  // Arc's speed; `overrun`: the offset momentum added before it was told apart (Arc's feel takes it back out);
  // `cancelled`: the trackpad cancelled the gesture.
  function release({ offset, speed, events, time, lifted, overrun = 0, cancelled = false }: { offset: number, speed: number, events: number, time?: number, lifted?: number, overrun?: number, cancelled?: boolean }) {
    const s = swiping;
    if (!s || s.settling) return;
    cancelAnimationFrame(s.frame);
    let dir: -1 | 0 | 1;
    let duration = SETTLE_MS;
    if (s.arc) {
      const at = lifted ?? time ?? performance.now();
      const raw = (offset - overrun - s.base.offset) * s.scale;
      const velocity = tracker.velocity(at, ARC.VELOCITY_MS) * 1000 * s.scale; // px/s of the sidebar
      dir = settleArc({ offset: raw, velocity, width: s.width, events: events - s.base.events, cancelled, has: (d) => !!s.neighbours[d] }) as -1 | 0 | 1;
      // From where it's drawn (rubber band and all), at the lift's speed only when that heads where it goes (Arc).
      const to = dir ? -dir * s.width : 0;
      const v0 = Math.sign(velocity) === Math.sign(to - s.shown) ? velocity : 0;
      const reduced = !!doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const spring = springArc(s.shown, v0, to, s.response);
      const points = reduced ? null : springKeyframes(spring, s.shown, to);
      duration = points ? Math.round(spring.duration * 1000) : 0;
      // As Dia plays it (keyframes Core Animation moves, not the app each frame): one transition of the moving part, its
      // easing the spring's positions every 1/240 s, from where it's drawn to where it goes; the browser runs it.
      if (points) s.el.style.setProperty('--m-swipe-transition', `transform ${duration}ms linear(${points.join(', ')})`);
      s.settling = true;
      s.el.classList.add('m-settling');
      draw(s, to);
      s.el.style.setProperty('--m-swipe-progress', dir ? '1' : '0');
    } else {
      dir = settle({ offset: offset - s.base.offset, speed, events: events - s.base.events, width: s.width, has: (d) => !!s.neighbours[d] }) as -1 | 0 | 1;
      s.settling = true;
      s.el.classList.add('m-settling');
      s.el.style.setProperty('--m-swipe-offset', `${dir ? -dir * s.width : 0}px`);
      s.el.style.setProperty('--m-swipe-progress', dir ? '1' : '0');
    }
    s.target = dir ? s.neighbours[dir] ?? null : null;
    // Asked for as it settles, not once the slide is in (reported 2026-11-07: "it takes a while for me to see that space
    // is switching"): its tab asked of the copy now, Safari bringing it while the slide comes in; drawn here as before,
    // in the frame the slide ends (the space left kept shown till then, holdSpace), so nothing jumps.
    if (s.target && typeof rt.vm?.space?.id === 'string') {
      rt.holdSpace(rt.vm.space.id, duration + 100);
      void Promise.resolve(rt.send('setSpace', { windowId: rt.windowId(), spaceId: s.target })).catch(() => {});
    }
    // The neighbour slides fully in first; then the space is switched to, and the copy goes in the same frame the
    // real sidebar shows it (afterRender), so nothing jumps.
    rt.later(() => {
      if (swiping !== s) return;
      if (!s.target) return finish();
      s.dispatched = true;
      rt.dispatch('space.switch', s.target, 'behavior');
      if (swiping === s && rt.vm?.space?.id === s.target) finish();
      rt.later(() => { if (swiping === s) finish(); }, 1500);
    }, duration);
  }

  // The trackpad's phases, from Margin.app (app/shared/host/overlay.ts): the fingers touched (`mayBegin`, `began`),
  // lifted (`ended`) or the gesture was cancelled; its momentum began or ended.
  rt.listen(doc, 'm-wheel-phase', (e: CustomEvent) => {
    const phase = e.detail?.phase;
    phases.known = true;
    if (phase === 'mayBegin' || phase === 'began') {
      phases.fingers = true;
      phases.momentum = false;
      // (A touch that comes after the gesture's first events, which were already tracked: the same gesture.)
      phases.touched = !tracker.tracking(performance.now());
    } else if (phase === 'momentum') {
      phases.momentum = true;
    } else if (phase === 'momentumEnd') {
      phases.momentum = false;
    } else if (phase === 'ended' || phase === 'cancelled') {
      phases.fingers = false;
      const at = performance.now();
      // (The lift can be told before the last of its moves is drawn here: let go a frame later, as of the lift.)
      requestAnimationFrame(() => {
        if (!swiping || swiping.settling) return;
        const r = tracker.lift(at);
        if (r.phase !== 'release') return;
        clearTimeout(endTimer);
        release({ ...r, cancelled: phase === 'cancelled' });
      });
    }
  });

  rt.listen(container, 'wheel', (e: WheelEvent) => {
    const hit = view.behaviorAt(e.target, 'm-swipe', 'spaces');
    const el = ((hit?.el ?? swiping?.el ?? null) as HTMLElement | null);
    if (!el) return;
    const vm = rt.vm;
    // The momentum after a lift (the trackpad's phases): never a swipe's input; a swipe's keeps the list still.
    if (phases.known && phases.momentum && !phases.fingers) {
      if (tracker.isSwipe() && e.cancelable) e.preventDefault(); // (its whole momentum: it isn't fed to the tracker)
      return;
    }
    const usable = !!vm?.ready && vm.spaces.length > 1 && vm.window.sidebar !== 'hidden' && !rt.busy(api) && !!hit && !scrollsSideways(e, el);
    // (Phases known: a touch starts a new gesture, fingers still down continue it however long they rested.)
    const fresh = phases.known ? (phases.touched ? true : phases.fingers ? false : undefined) : undefined;
    phases.touched = false;
    const result = tracker.wheel({ deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, mouse: mouseWheel(e), time: e.timeStamp, usable, fresh, decay: !phases.known });
    if (tracker.swiping(e.timeStamp) && e.cancelable) e.preventDefault(); // not the list, not the browser's back/forward
    if (swiping?.settling) return; // its momentum is still that gesture
    if (result.phase === 'tracking') {
      clearTimeout(endTimer);
      if (!swiping) {
        begin(el);
        // Before this event (if it counted): 0 for a gesture that starts here.
        // (begin set it.)
        swiping!.base = result.counted ? { offset: result.offset + e.deltaX, events: result.events - 1 } : { offset: result.offset, events: result.events };
      }
      swiping!.offset = (result.offset - swiping!.base.offset) * swiping!.scale;
      if (!swiping!.frame) swiping!.frame = requestAnimationFrame(() => { if (!swiping) return; swiping.frame = 0; place(swiping.offset); });
      // No events for the gap: the fingers stopped (let go now: no speed at the lift). Phases known, only a lift lets
      // go (fingers resting mid-swipe keep it held, as in Arc); a lift never told, after HELD_MAX_MS.
      endTimer = setTimeout(() => {
        const end = tracker.end(performance.now());
        if (end.phase === 'release') release(end);
        else if (swiping && !swiping.settling) release({ offset: swiping.base.offset, speed: 0, events: swiping.base.events });
      }, phases.known ? HELD_MAX_MS : SWIPE.GAP_MS + 20);
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
    afterRender(vm: ViewModel) { if (swiping?.dispatched && vm?.space?.id === swiping.target) finish(); },
  };
  return api;
}
