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
// with one space (unless the theme has Arc's ends, below), while the sidebar
// is hidden or something is under way (renaming, a menu, a drag).
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
// resting mid-swipe keep it held, as in Arc. With Arc's or Dia's feel, fingers
// touching while it settles catch it where it's drawn (`catchSettle`, as both
// do), the space nearest that place the one swiped from.
//
// The space coming in changes the colour as far as it's drawn (Arc: docs/ARC-SIDEBAR.md "The space's colour in a
// switch"): while the fingers move, and frame by frame as it settles (where the moving part is drawn, so the colour
// keeps to the slide's own curve), the runtime's `blendSpace` (its background over this one's, its colour on the
// theme's root); gone as it lands, the space's own then. Its copy beside this one is drawn in its own colours (the
// custom properties its own theme root is drawn with).
//
// The ends, as Arc's (docs/ARC-SIDEBAR.md "The ends of the spaces"), for a theme that asks (`--m-swipe-ends: arc` on
// the swiping part): past the first space its Library comes in (a swipe toward it, or the box button's `slideLibrary`):
// nothing of the space moves with the fingers; Margin gives the theme's root `--m-library-progress` (0 to 1, how far
// it's come) and `m-library-swipe`, and the theme draws it (the Library sliding in, the space going, the sidebar as wide
// as the Library where the page can make room); let go, it settles on the swipe's spring and the Library is open (or
// not). A swipe toward the next space from the Library takes it back the same way. Past the last space, the rubber band
// as before, and Margin gives the swiping part `m-pull`, `--m-pull` (px drawn) and `--m-pull-progress` (0 to 1 of
// PULL_ARM), `m-pull-armed` past it (Arc's lit edge and "+" there, the theme's); let go armed, Create a Space opens
// (ui/behaviors/ends.ts); `m-pull-leaving` while the "+" goes. From Create a Space, a swipe toward the previous space
// (the space it was opened from, drawn beside it) cancels it.
import type { Rt } from '../runtime.ts';
import type { ViewModel } from '../view-model.ts';
import { canScrollX } from '../../../../extension/shared/gestures.ts';
import { createSpaceSwipe, settle, rubberBand, settleArc, rubberBandArc, rubberBandArcInverse, springArc, springKeyframes, switchEasing, ARC, FEELS, DEFAULTS as SWIPE } from '../../../../extension/shared/space-swipe.ts';
import { View } from '../render.ts';

export const SETTLE_MS = 220;
// Past the last space, how far the space is drawn (px, its rubber band) before letting go makes a space: Arc's, read
// from a recording (docs/ARC-SIDEBAR.md "The ends of the spaces": its "+" turns white 24–25 pt in).
export const PULL_ARM = 24;
// How long the "+" takes to go once let go (Arc: three frames out of the sidebar's edge).
const PULL_LEAVE_MS = 160;
// The ends' places among the neighbours: the Library (before the first space), back from it (the space it covers),
// back from Create a Space (the space it was opened from).
const LIBRARY = '\u0000library', LIBRARY_BACK = '\u0000library-back', BACK = '\u0000back';
const ends = (id: string | null | undefined) => id === LIBRARY || id === LIBRARY_BACK || id === BACK;
// The trackpad's phases known: a swipe whose fingers are down is let go anyway after this long with no event (its
// lift lost: never held for good).
const HELD_MAX_MS = 2000;

export function installSwipe(rt: Rt) {
  const { view, doc, container } = rt;
  const tracker = createSpaceSwipe();
  // `arc`: the theme's feel is Arc's or Dia's (`scale` its distance, `response` its spring's, `haptics` Dia's tick);
  // `shown`: the offset drawn now; `detent`: the space nearest it (-1, 0, 1), its change a haptic tick.
  // `anchor`: the space drawn (the swipe's own); `origin`: the offset the gesture started from (where a settle was
  // caught; else 0), `rebase` its next event its base; `caught`: a caught settle, its gesture not started or let go
  // yet; `requested`: the space asked of the copy for it (at the lift, before the slide is in), `asked` that request
  // (its own switch as it lands takes it, never asking again: ui/runtime.ts switchSpace); `spring` and
  // `settledAt`: the settle under way (its curve, when it began, its `token`: a caught one's end never comes).
  let swiping: { el: HTMLElement, neighbours: Record<string, string | undefined>, width: number, base: { offset: number, events: number }, settling: boolean, frame: number, offset: number, panes: HTMLElement[], bases: { left: number, top: number, width: number, height: number }[], ghosts: Record<string, HTMLElement[] | null>, position: string, overflow: string, target: string | null, dispatched: boolean, arc: boolean, scale: number, response: number, haptics: boolean, shown: number, detent: number,
    anchor: string | null, origin: number, rebase: boolean, caught: boolean, requested: string | null, asked: Promise<unknown> | null, spring: ReturnType<typeof springArc> | null, settledAt: number, token: number, blendFrame: number,
    /** The ends (Arc's): `endsArc` the theme asks for them, `libOpen` swiped from the Library, `creating` from Create a Space; `armed` the pull past PULL_ARM; `libFrame` the Library's settle; `resizing` the host told the sidebar's width is changing (the Library moving the page area: `setLibrary`). */
    endsArc: boolean, libOpen: boolean, creating: boolean, armed: boolean, peeked: boolean, libFrame: number, resizing: boolean } | null = null;
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
    // (The Library is the theme's own, never a copy; back from Create a Space, the space it was opened from.)
    const id = s.neighbours[dir] === BACK ? s.anchor : s.neighbours[dir];
    if (!id || ends(id) || !s.panes.length) return;
    const model = rt.spaceView?.(id);
    if (!model) return;
    let sources: HTMLElement[] = [];
    let props: [string, string][] = [];
    try {
      const holder = doc.createElement('div');
      const root = holder.attachShadow({ mode: 'open' });
      const v = new View(root, rt.theme.template, {});
      v.update(model);
      // (Its theme root's custom properties as drawn for that space, its colour among them: the copy carries them.)
      const top = v.rootElement() as HTMLElement | null;
      props = top ? [...top.style].filter((name) => name.startsWith('--')).map((name) => [name, top.style.getPropertyValue(name)] as [string, string]) : [];
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
      for (const [name, value] of props) copy.style.setProperty(name, value);
      const b = s.bases[i];
      Object.assign(copy.style, { position: 'absolute', top: `${b.top}px`, left: `${b.left + Number(dir) * s.width}px`, width: `${b.width}px`, height: `${b.height}px`, margin: '0', pointerEvents: 'none' });
      s.el.append(copy);
      copies.push(copy);
    });
    s.ghosts[dir] = copies;
  }
  let endTimer: Timer | null = null;
  // The swipe's own switches (a settle's end, back to the space swiped from, a caught settle's): never taken as another
  // switch coming while it settles (`cancelSettle`).
  let own = false;
  function switchOwn(spaceId: string) {
    own = true;
    try { rt.dispatch('space.switch', spaceId, 'behavior'); } finally { own = false; }
  }

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

  // `blend`: the colour follows it now (false for a settle's end, which the colour reaches with the slide: followBlend).
  function draw(s: NonNullable<typeof swiping>, shown: number, blend = true) {
    s.shown = shown;
    // The Library coming in (or going): the theme draws it from its progress; nothing of the space moves with it.
    const lib = libraryProgress(s, shown);
    s.el.style.setProperty('--m-swipe-offset', `${lib === null ? Math.round(shown * 10) / 10 : 0}px`);
    // How far toward the neighbour (0 to 1).
    s.el.style.setProperty('--m-swipe-progress', `${Math.round(Math.min(1, Math.abs(shown) / s.width) * 1000) / 1000}`);
    setLibrary(s, lib);
    // Past the last space (none that way, nor from the Library or Create a Space): the pull, armed past PULL_ARM.
    setPull(s, s.endsArc && !s.libOpen && !s.creating && !s.neighbours[1] && shown < 0 ? -shown : 0);
    if (blend && lib === null) blendAt(s, shown);
  }
  // The Library's progress drawn at `shown` (null: it isn't involved): 0 to 1 toward it before the first space, 1 to 0
  // back from it.
  function libraryProgress(s: NonNullable<typeof swiping>, shown: number) {
    if (s.libOpen) return 1 - Math.min(1, Math.max(0, -shown) / s.width);
    if (s.neighbours[-1] === LIBRARY && shown > 0) return Math.min(1, shown / s.width);
    return null;
  }
  function setLibrary(s: NonNullable<typeof swiping>, p: number | null) {
    const root = view.rootElement() as HTMLElement | null;
    if (!root) return;
    if (p === null) {
      if (root.hasAttribute('m-library-swipe')) { root.removeAttribute('m-library-swipe'); root.style.removeProperty('--m-library-progress'); }
      return;
    }
    // (Its rows drawn while it can be seen: `peek`.)
    if (!s.peeked) { s.peeked = true; rt.behaviors.ends?.peek(true); }
    // (The sidebar as wide as the Library moves the page area each frame, as a drag of its edge does: the host told it's
    // under way, once, so Margin.app's hosted window follows it live, not placed again frame by frame; over in `finish`.)
    if (!s.resizing) { s.resizing = true; rt.host.perform?.('sidebar.resizing', { on: true }); }
    if (!root.hasAttribute('m-library-swipe')) root.setAttribute('m-library-swipe', '');
    root.style.setProperty('--m-library-progress', String(Math.round(Math.max(0, Math.min(1, p)) * 1000) / 1000));
  }
  function setPull(s: NonNullable<typeof swiping>, px: number) {
    const el = s.el;
    if (el.hasAttribute('m-pull-leaving')) return;
    if (px <= 0) {
      s.armed = false;
      if (el.hasAttribute('m-pull')) { el.removeAttribute('m-pull'); el.removeAttribute('m-pull-armed'); el.style.removeProperty('--m-pull'); el.style.removeProperty('--m-pull-progress'); }
      return;
    }
    s.armed = px >= PULL_ARM;
    if (!el.hasAttribute('m-pull')) el.setAttribute('m-pull', '');
    el.toggleAttribute('m-pull-armed', s.armed);
    el.style.setProperty('--m-pull', `${Math.round(px * 10) / 10}px`);
    el.style.setProperty('--m-pull-progress', String(Math.round(Math.min(1, px / PULL_ARM) * 1000) / 1000));
  }
  // The "+" going out of the sidebar's edge (Arc's, once let go, armed or not; and back from Create a Space, Arc's flash
  // of it): `m-pull-leaving` for PULL_LEAVE_MS, then nothing of the pull left. `full`: drawn all the way in first.
  function pullLeave(el: HTMLElement, full = false) {
    if (full) {
      el.setAttribute('m-pull', '');
      el.setAttribute('m-pull-armed', '');
      el.style.setProperty('--m-pull', `${PULL_ARM}px`);
      el.style.setProperty('--m-pull-progress', '1');
    }
    if (!el.hasAttribute('m-pull')) return;
    el.setAttribute('m-pull-leaving', '');
    rt.later(() => {
      el.removeAttribute('m-pull-leaving');
      if (swiping?.el === el) return; // (a new pull already: its own)
      el.removeAttribute('m-pull'); el.removeAttribute('m-pull-armed'); el.style.removeProperty('--m-pull'); el.style.removeProperty('--m-pull-progress');
    }, PULL_LEAVE_MS);
  }
  // The space that way coming in, as far as it's drawn at `x` (none past the first or last space).
  function blendAt(s: NonNullable<typeof swiping>, x: number) {
    if (!rt.blendsSpaces?.()) return;
    const toward = x > 0 ? -1 : x < 0 ? 1 : 0;
    // (Back from Create a Space: toward the space it was opened from; the Library: no space's colour.)
    const next = toward ? s.neighbours[toward] : undefined;
    const to = next === BACK ? s.anchor : ends(next) ? undefined : next;
    rt.blendSpace(to ?? null, to ? Math.abs(x) / s.width : 0);
  }
  // As it settles: the colour where the moving part is drawn, each frame, till it lands or is caught.
  function followBlend(s: NonNullable<typeof swiping>, token: number) {
    cancelAnimationFrame(s.blendFrame);
    s.blendFrame = 0;
    if (!rt.blendsSpaces?.()) return;
    const step = () => {
      s.blendFrame = 0;
      if (swiping !== s || s.token !== token || !s.settling) return;
      blendAt(s, drawnNow(s));
      s.blendFrame = requestAnimationFrame(step);
    };
    step();
  }
  // Where the offset is drawn: as far as the neighbour that way, past the first or last space the rubber band.
  function shownFor(s: NonNullable<typeof swiping>, offset: number) {
    const toward = offset > 0 ? -1 : 1;
    return s.neighbours[toward] ? Math.max(-s.width, Math.min(s.width, offset)) : s.arc ? rubberBandArc(offset) : rubberBand(offset, s.width * 0.2);
  }
  function place(offset: number) {
    const s = swiping;
    if (!s) return;
    const toward = offset > 0 ? -1 : 1;
    if (s.neighbours[toward]) ghost(s, String(toward));
    draw(s, shownFor(s, offset));
  }
  // Dia's detent, checked at each of the trackpad's events as Dia does (not a frame later): the space nearest where it's
  // drawn changed (past half its width, either way; its rounding Dia's `frinta`, the same for these places): the
  // trackpad's alignment tick. Never past the first or last space, nor at a swipe's start or a catch (`detent` is the
  // space nearest then: Dia sets its last detent at the start of each gesture).
  function detentTick(s: NonNullable<typeof swiping>, offset: number) {
    if (!s.haptics) return;
    const near = Math.round(-shownFor(s, offset) / s.width);
    const detent = near && s.neighbours[near > 0 ? 1 : -1] ? Math.sign(near) : 0;
    if (detent === s.detent) return;
    s.detent = detent;
    rt.host.perform?.('haptic.alignment');
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
    const endsArc = arc && getComputedStyle(el).getPropertyValue('--m-swipe-ends').trim() === 'arc';
    const libOpen = endsArc && !!rt.ui.library?.open;
    const creating = endsArc && !libOpen && !!rt.ui.newSpace;
    swiping = { el, neighbours: { [-1]: spaces[at - 1]?.id, [1]: spaces[at + 1]?.id }, width: er.width || 1, base: { offset: 0, events: 0 }, settling: false, frame: 0, offset: 0,
      panes, bases, ghosts: {}, overflow: el.style.overflow, position, target: null, dispatched: false, arc, scale: arc ? ARC.SCALE : 1, response: feel?.response ?? ARC.RESPONSE, haptics: feel?.haptics ?? false, shown: 0, detent: 0,
      anchor: typeof rt.vm?.space?.id === 'string' ? rt.vm.space.id : null, origin: 0, rebase: false, caught: false, requested: null, asked: null, spring: null, settledAt: 0, token: 0, blendFrame: 0,
      endsArc, libOpen, creating, armed: false, peeked: false, libFrame: 0, resizing: false };
    // (The ends: from the Library, the space it covers the way back; from Create a Space, the space it was opened from;
    // else before the first space the Library.)
    if (libOpen) swiping.neighbours = { [-1]: undefined, [1]: LIBRARY_BACK };
    else if (creating) swiping.neighbours = { [-1]: BACK, [1]: undefined };
    else if (endsArc && !swiping.neighbours[-1]) swiping.neighbours[-1] = LIBRARY;
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
    cancelAnimationFrame(s.blendFrame);
    cancelAnimationFrame(s.libFrame);
    rt.blendSpace?.(null, 0);
    setLibrary(s, null);
    if (s.peeked && !rt.ui.library?.open) rt.behaviors.ends?.peek(false);
    if (!s.el.hasAttribute('m-pull-leaving')) setPull(s, 0);
    s.el.classList.remove('m-swiping', 'm-settling');
    s.el.style.removeProperty('--m-swipe-offset');
    s.el.style.removeProperty('--m-swipe-progress');
    s.el.style.removeProperty('--m-swipe-transition');
    s.el.style.overflow = s.overflow;
    s.el.style.position = s.position;
    for (const list of Object.values(s.ghosts)) for (const g of list ?? []) g.remove();
    // (The Library's change of the sidebar's width over: told after the page's place at its last width is measured and
    // reported, now, so what the host does then is done once, for that place: behaviors/resize.ts's order.)
    if (s.resizing) { view.flushLayout?.(); rt.host.perform?.('sidebar.resizing', { on: false }); }
  }
  // `time`: when it was let go (a lift's, from the trackpad's phases or by its momentum's first event: `lifted`), for
  // Arc's speed; `overrun`: the offset momentum added before it was told apart (Arc's feel takes it back out);
  // `cancelled`: the trackpad cancelled the gesture.
  function release({ offset, speed, events, time, lifted, overrun = 0, cancelled = false }: { offset: number, speed: number, events: number, time?: number, lifted?: number, overrun?: number, cancelled?: boolean }) {
    const s = swiping;
    if (!s || s.settling) return;
    cancelAnimationFrame(s.frame);
    if (s.arc) {
      const at = lifted ?? time ?? performance.now();
      const raw = s.origin + (offset - overrun - s.base.offset) * s.scale;
      const velocity = tracker.velocity(at, ARC.VELOCITY_MS) * 1000 * s.scale; // px/s of the sidebar
      // (A caught settle's gesture: no notch rule, it was a swipe already.)
      return settleTo(s, settleArc({ offset: raw, velocity, width: s.width, events: s.caught ? Infinity : events - s.base.events, cancelled, has: (d) => !!s.neighbours[d] }) as -1 | 0 | 1, velocity);
    }
    settleTo(s, settle({ offset: offset - s.base.offset, speed, events: events - s.base.events, width: s.width, has: (d) => !!s.neighbours[d] }) as -1 | 0 | 1, 0);
  }

  // The settle toward the space `dir` that way (0: back), at `velocity` (px/s) for Arc's and Dia's spring; `curve`, a
  // fixed easing instead (a click's or a key's switch: Arc's own, `slideTo`).
  function settleTo(s: NonNullable<typeof swiping>, dir: -1 | 0 | 1, velocity: number, curve: { duration: number, points: number[] } | null = null) {
    let duration = SETTLE_MS;
    s.caught = false;
    // The Library (toward it, or back from it): its own settle.
    if (s.arc && (s.libOpen || (s.neighbours[-1] === LIBRARY && (dir === -1 || s.shown > 0)))) return settleLibrary(s, dir, velocity, curve);
    // Past the last space, let go armed: Create a Space, at once, as Arc's; the "+" goes either way.
    if (s.endsArc && !s.libOpen && !s.creating && !s.neighbours[1] && s.shown < 0 && dir === 0) {
      const armed = s.armed;
      pullLeave(s.el);
      if (armed) { s.token++; finish(); rt.behaviors.ends?.openNewSpace(); return; }
    }
    s.token++;
    const token = s.token;
    if (s.arc && curve) {
      duration = curve.duration;
      s.spring = null;
      s.settledAt = performance.now();
      s.el.style.setProperty('--m-swipe-transition', `transform ${duration}ms linear(${curve.points.join(', ')})`);
      s.settling = true;
      s.el.classList.add('m-settling');
      draw(s, dir ? -dir * s.width : 0, false);
      s.el.style.setProperty('--m-swipe-progress', dir ? '1' : '0');
    } else if (s.arc) {
      // From where it's drawn (rubber band and all), at the lift's speed only when that heads where it goes (Arc).
      const to = dir ? -dir * s.width : 0;
      const v0 = Math.sign(velocity) === Math.sign(to - s.shown) ? velocity : 0;
      const reduced = !!doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const spring = springArc(s.shown, v0, to, s.response);
      const points = reduced ? null : springKeyframes(spring, s.shown, to);
      duration = points ? Math.round(spring.duration * 1000) : 0;
      s.spring = points ? spring : null;
      s.settledAt = performance.now();
      // As Dia plays it (keyframes Core Animation moves, not the app each frame): one transition of the moving part, its
      // easing the spring's positions every 1/240 s, from where it's drawn to where it goes; the browser runs it.
      if (points) s.el.style.setProperty('--m-swipe-transition', `transform ${duration}ms linear(${points.join(', ')})`);
      s.settling = true;
      s.el.classList.add('m-settling');
      draw(s, to, false);
      s.el.style.setProperty('--m-swipe-progress', dir ? '1' : '0');
    } else {
      s.settling = true;
      s.el.classList.add('m-settling');
      s.el.style.setProperty('--m-swipe-offset', `${dir ? -dir * s.width : 0}px`);
      s.el.style.setProperty('--m-swipe-progress', dir ? '1' : '0');
    }
    s.target = dir ? s.neighbours[dir] ?? null : null;
    followBlend(s, token);
    // Asked for as it settles, not once the slide is in (reported 2026-11-07: "it takes a while for me to see that space
    // is switching"): its tab asked of the copy now, Safari bringing it while the slide comes in; drawn here as before,
    // in the frame the slide ends (the space left kept shown till then, holdSpace), so nothing jumps. One asked for
    // already (a settle caught, then on to the same one): not asked again. Back to the space swiped from after another
    // was asked for: that one asked back at once.
    if (s.target && s.anchor && !ends(s.target)) {
      rt.holdSpace(s.anchor, duration + 100);
      if (s.requested !== s.target) {
        s.requested = s.target;
        s.asked = Promise.resolve(rt.send('setSpace', { windowId: rt.windowId(), spaceId: s.target }));
        s.asked.catch(() => {});
      }
    } else if (!s.target && s.requested && s.anchor) {
      s.requested = null;
      s.asked = null;
      switchOwn(s.anchor);
    }
    // The neighbour slides fully in first; then the space is switched to, and the copy goes in the same frame the
    // real sidebar shows it (afterRender), so nothing jumps.
    rt.later(() => {
      if (swiping !== s || s.token !== token) return;
      if (!s.target) return finish();
      // Back from Create a Space: cancelled, nothing made (and Arc's "+" going out of the edge).
      if (s.target === BACK) { const el = s.el; finish(); rt.behaviors.ends?.cancelNewSpace(); pullLeave(el, true); return; }
      s.dispatched = true;
      switchOwn(s.target);
      if (swiping === s && rt.vm?.space?.id === s.target) finish();
      rt.later(() => { if (swiping === s && s.token === token) finish(); }, 1500);
    }, duration);
  }

  // The Library's settle: toward it (open), back from it (closed), or back where it was, on the swipe's spring from
  // where it's drawn (`curve`: a fixed easing instead, the box button's and the back arrow's: Arc's switch); its
  // progress each frame (the theme draws it), then the Library open or closed (ui/behaviors/ends.ts) and the swipe done.
  function settleLibrary(s: NonNullable<typeof swiping>, dir: -1 | 0 | 1, velocity: number, curve: { duration: number, points: number[] } | null) {
    s.token++;
    const token = s.token;
    const target = dir ? s.neighbours[dir] ?? null : null;
    const open = s.libOpen ? target !== LIBRARY_BACK : target === LIBRARY;
    const to = s.libOpen ? (open ? 0 : -s.width) : (open ? s.width : 0);
    const from = s.shown;
    const reduced = !!doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const v0 = Math.sign(velocity) === Math.sign(to - from) ? velocity : 0;
    const spring = curve || reduced ? null : springArc(from, v0, to, s.response);
    const duration = reduced ? 0 : curve ? curve.duration : Math.round(spring!.duration * 1000);
    s.spring = null;
    s.target = null;
    s.settling = true;
    s.settledAt = performance.now();
    s.el.classList.add('m-settling');
    const done = () => {
      if (swiping !== s || s.token !== token) return;
      draw(s, to, false);
      if (open && !s.libOpen) rt.behaviors.ends?.openLibrary();
      else if (!open && s.libOpen) rt.behaviors.ends?.closeLibrary();
      finish();
    };
    if (!duration) return done();
    const step = () => {
      s.libFrame = 0;
      if (swiping !== s || s.token !== token) return;
      const t = performance.now() - s.settledAt;
      if (t >= duration) return done();
      const x = curve ? from + (to - from) * easeAt(curve.points, t / duration) : spring!.at(t / 1000).x;
      draw(s, x, false);
      s.libFrame = requestAnimationFrame(step);
    };
    step();
  }
  // A `linear()` easing's value at `t` (0 to 1): its points evenly spaced in time.
  function easeAt(points: number[], t: number) {
    if (!points.length) return t;
    const at = Math.max(0, Math.min(1, t)) * (points.length - 1);
    const i = Math.floor(at), f = at - i;
    return i >= points.length - 1 ? points[points.length - 1] : points[i] + (points[i + 1] - points[i]) * f;
  }

  // Where the moving part is drawn now, mid-settle: its transform as the browser has it this instant; unread, the
  // spring's own position at this time.
  function drawnNow(s: NonNullable<typeof swiping>) {
    // (The Library's settle: where it's drawn is the swipe's own, each frame.)
    if (s.libFrame || libraryProgress(s, s.shown) !== null) return s.shown;
    const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(s.panes[0] ?? s.el).transform);
    const x = m ? parseFloat(m[1].split(',')[4]) : NaN;
    if (Number.isFinite(x)) return x;
    if (!s.spring) return s.shown;
    return s.spring.at(Math.min(s.spring.duration, (performance.now() - s.settledAt) / 1000)).x;
  }

  // Fingers on the trackpad while Arc's or Dia's settle is under way (as both do: Arc's PageSwipeController adopts the
  // presentation's position at `mayBegin`): held where it's drawn, the space nearest there the one swiped from. Still
  // nearest the space it set out from: that one, from there (the space asked for, if it ends back here, asked back).
  // Nearer the one it headed for (or past it): that one is shown now, in the same frame, the swipe on from there.
  function catchSettle() {
    const s = swiping;
    if (!s || !s.settling || !s.arc) return;
    const x = drawnNow(s);
    s.token++; // (its end never comes)
    s.settling = false;
    // (Stopped where it's drawn: its transition taken away with the offset there, and the style worked out at once, so
    // the transition is cancelled before anything else changes. Without that step WebKit kept it running to its end.)
    s.el.style.setProperty('--m-swipe-transition', 'none');
    draw(s, x);
    void getComputedStyle(s.panes[0] ?? s.el).transform;
    s.el.style.removeProperty('--m-swipe-transition');
    s.el.classList.remove('m-settling');
    const near = Math.round(-x / s.width);
    const dir = near > 0 ? 1 : near < 0 ? -1 : 0;
    const to = dir ? s.neighbours[dir] : undefined;
    // (An end's place, the Library's or back from it or from Create a Space: on from where it's held.)
    if (to && !ends(to)) {
      const asked = s.requested === to ? s.asked : null;
      switchOwn(to);
      if (rt.vm?.space?.id === to) {
        const el = s.el;
        finish();
        begin(el);
        const n = swiping!;
        n.origin = x + dir * s.width;
        n.requested = to;
        n.asked = asked;
        n.caught = true;
        n.rebase = true;
        n.offset = n.origin;
        place(n.origin);
        holdWhileCaught(n);
        return;
      }
    }
    // (Nearest where it set out from, or that switch not drawn: from here, as it is. Past the first or last space, drawn
    // with the rubber band: the offset it stands for, so the band isn't applied twice.)
    const raw = s.neighbours[x > 0 ? -1 : 1] ? x : rubberBandArcInverse(x);
    s.origin = raw;
    s.offset = raw;
    s.caught = true;
    s.rebase = true;
    s.target = null;
    s.detent = 0;
    draw(s, x);
    holdWhileCaught(s);
  }
  // A caught settle's space kept drawn while the fingers decide (another asked of the copy meanwhile), and settled again
  // from where it's held if no swipe comes of the touch (a lift, a vertical scroll, nothing for HELD_MAX_MS).
  function holdWhileCaught(s: NonNullable<typeof swiping>) {
    if (s.requested && s.anchor && s.requested !== s.anchor) rt.holdSpace(s.anchor, HELD_MAX_MS + 500);
    clearTimeout(endTimer);
    endTimer = setTimeout(() => { if (swiping === s && s.caught && !s.settling) settleAgain(s); }, HELD_MAX_MS);
  }
  function settleAgain(s: NonNullable<typeof swiping>) {
    settleTo(s, settleArc({ offset: s.shown, velocity: 0, width: s.width, has: (d) => !!s.neighbours[d] }) as -1 | 0 | 1, 0);
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
      if (swiping?.settling && swiping.arc) catchSettle();
    } else if (phase === 'momentum') {
      phases.momentum = true;
    } else if (phase === 'momentumEnd') {
      phases.momentum = false;
    } else if (phase === 'ended' || phase === 'cancelled') {
      phases.fingers = false;
      const at = performance.now();
      // (The lift can be told before the last of its moves is drawn here: let go a frame later, as of the lift.)
      requestAnimationFrame(() => {
        const s = swiping;
        if (!s || s.settling) return;
        const r = tracker.lift(at);
        if (r.phase !== 'release') {
          // (A caught settle and no swipe of it: settled again from where it's held.)
          if (s.caught) { clearTimeout(endTimer); settleAgain(s); }
          return;
        }
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
    // (One space: nothing to swipe to, unless the theme has Arc's ends: its Library and Create a Space are still there.)
    const ends = vm?.spaces.length === 1 && getComputedStyle(el).getPropertyValue('--m-swipe-ends').trim() === 'arc';
    const usable = !!vm?.ready && (vm.spaces.length > 1 || ends) && vm.window.sidebar !== 'hidden' && !rt.busy(api) && !!hit && !scrollsSideways(e, el);
    // (Phases known: a touch starts a new gesture, fingers still down continue it however long they rested.)
    const fresh = phases.known ? (phases.touched ? true : phases.fingers ? false : undefined) : undefined;
    phases.touched = false;
    const result = tracker.wheel({ deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, mouse: mouseWheel(e), time: e.timeStamp, usable, fresh, decay: !phases.known });
    if (tracker.swiping(e.timeStamp) && e.cancelable) e.preventDefault(); // not the list, not the browser's back/forward
    if (swiping?.settling) return; // its momentum is still that gesture
    if (result.phase === 'tracking') {
      clearTimeout(endTimer);
      if (!swiping || swiping.rebase) {
        if (!swiping) begin(el);
        // Before this event (if it counted): 0 for a gesture that starts here, or where a caught settle was held.
        swiping!.base = result.counted ? { offset: result.offset + e.deltaX, events: result.events - 1 } : { offset: result.offset, events: result.events };
        swiping!.rebase = false;
      }
      swiping!.offset = swiping!.origin + (result.offset - swiping!.base.offset) * swiping!.scale;
      detentTick(swiping!, swiping!.offset);
      if (!swiping!.frame) swiping!.frame = requestAnimationFrame(() => { if (!swiping) return; swiping.frame = 0; place(swiping.offset); });
      // No events for the gap: the fingers stopped (let go now: no speed at the lift). Phases known, only a lift lets
      // go (fingers resting mid-swipe keep it held, as in Arc); a lift never told, after HELD_MAX_MS.
      endTimer = setTimeout(() => {
        const end = tracker.end(performance.now());
        if (end.phase === 'release') release(end);
        else if (swiping && !swiping.settling) { if (swiping.caught) settleAgain(swiping); else release({ offset: swiping.base.offset, speed: 0, events: swiping.base.events }); }
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

  // A space switched to by a click or a key, slid in as Arc does (M2.10, docs/ARC-SIDEBAR.md "Motion", measured: its page
  // beside this one, on the side it lies in the list, both sliding together on Arc's switch spring, about 251 ms;
  // its tab asked for at once and the space drawn as it lands, as a swipe's settle does): for a theme that moves its
  // space with a feel (`--m-swipe-feel`: Arcadia), the sidebar docked, nothing under way, motion allowed. False:
  // nothing slid (the caller switches at once, as before).
  function slideTo(target: string) {
    // A switch while the Library or Create a Space is open (a key's: their chips can't be clicked then): they go, and
    // the space is drawn at once (false: the caller switches as without a slide), never taken for one of their settles.
    if (rt.ui.library?.open || rt.ui.newSpace) {
      rt.behaviors.ends?.closeLibrary();
      rt.behaviors.ends?.cancelNewSpace();
      return false;
    }
    const vm = rt.vm;
    const from = vm?.space?.id;
    if (swiping || !vm?.ready || !from || target === from || vm.window.sidebar !== 'open' || rt.busy(api)) return false;
    const el = view.marked('m-swipe', 'spaces')[0] as HTMLElement | undefined;
    if (!el || !FEELS[getComputedStyle(el).getPropertyValue('--m-swipe-feel').trim()]) return false;
    if (doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
    const ids = vm.spaces.map((sp) => sp.id);
    const a = ids.indexOf(from), b = ids.indexOf(target);
    if (a < 0 || b < 0) return false;
    const dir = b > a ? 1 : -1;
    begin(el);
    const s = swiping!;
    s.neighbours[dir] = target; // (Arc: the space it goes to beside this one, however far it is in the list)
    ghost(s, String(dir));
    if (!s.ghosts[String(dir)]) { finish(); return false; }
    settleTo(s, dir, 0, switchEasing());
    return true;
  }

  // The Library opened or closed by a click (the sidebar's box button, its back arrow), slid as a swipe's would be on
  // Arc's switch spring, from any space; for a theme with Arc's ends, the sidebar docked, nothing under way, motion
  // allowed. False: nothing slid (the caller opens or closes it at once).
  function slideLibrary(open: boolean) {
    const vm = rt.vm;
    if (swiping || !vm?.ready || vm.window.sidebar !== 'open' || rt.busy(api) || !!rt.ui.library?.open === open) return false;
    const el = view.marked('m-swipe', 'spaces')[0] as HTMLElement | undefined;
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (!FEELS[cs.getPropertyValue('--m-swipe-feel').trim()] || cs.getPropertyValue('--m-swipe-ends').trim() !== 'arc') return false;
    if (doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
    begin(el);
    const s = swiping!;
    if (open) { s.creating = false; s.neighbours[-1] = LIBRARY; }
    settleLibrary(s, open ? -1 : 1, 0, switchEasing());
    return true;
  }

  const api = {
    slideTo,
    slideLibrary,
    /** The request its own switch (`switchOwn`) to `spaceId` is: the one its settle already sent (that space asked of
     *  the copy as it slid in, Margin.app showing its item), which the switch takes rather than asking again (each ask
     *  shows the item again: a second Safari show of the same tab a slide later). Null for any other switch. */
    askedFor(spaceId: string) {
      const s = swiping;
      return own && s && s.requested === spaceId ? s.asked : null;
    },
    /** Another switch while a settle (a swipe's or a slide's) is still coming in: its own switch at the end dropped
     *  and the copy beside it gone (the new switch is drawn at once). Its own end's switch is never dropped. */
    cancelSettle() {
      const s = swiping;
      if (own || !s || !s.settling || s.dispatched) return false;
      s.token++;
      finish();
      return true;
    },
    busy: () => swiping != null && !swiping.settling,
    /** Moving or settling (or just switched space by a swipe). */
    active: () => swiping != null || Date.now() < holdUntil,
    destroy() { clearTimeout(endTimer); finish(); },
    /** The space switched to after a settle is drawn: the copy beside it goes, the offset with it. */
    afterRender(vm: ViewModel) { if (swiping?.dispatched && vm?.space?.id === swiping.target) finish(); },
  };
  return api;
}
