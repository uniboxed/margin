// Two-finger swipe between spaces over the sidebar (Arc), the logic only (no
// DOM): fed the sidebar's wheel events, it says how far the space has been
// dragged and when the fingers lift; the theme moves the list with it and
// decides (`settle`) whether that switches space. As in shared/pull.ts, web
// pages don't get the trackpad's phases, so they're inferred:
//  - A gesture is a run of wheel events with no gap over GAP_MS. Its first
//    AXIS_PX of movement decide its axis: sideways is a swipe, anything else
//    is left alone (the list scrolls) until the gesture ends.
//  - The space follows the fingers: `offset` > 0 when they move right (with
//    natural scrolling, deltaX < 0), which brings the previous space in.
//  - The fingers have lifted when the events start decaying smoothly
//    (momentum: MOMENTUM_RUN events in a row, each a steady fraction of the
//    one before), or when they stop (end(), after GAP_MS). Either way the
//    gesture releases once; the momentum after it is ignored. What can't be
//    momentum (a delta growing again, turning back, or vertical: the fingers
//    are down again) starts a new gesture at once.
//  - A gesture that starts somewhere else (the drag stops without a gap and
//    a new one starts) releases the old one first, so it never hangs.
//  - Mouse wheels (line/page deltas, steps over MAX_STEP px, wheels the
//    sidebar recognises as such, Shift+wheel) and pinches never swipe, and
//    a swipe needs MIN_EVENTS events to switch (a notch or two never does).

// Arc's own feel (reverse-engineered from Arc 1.174.0's sidebar paging, ARCUI.PageSwipeController inside
// Arc.WindowLayoutController, 2026-11-20; DECISIONS.md "The space swipe as Arc's"), for a theme that asks for it
// (`--m-swipe-feel: arc`, ui/behaviors/swipe.ts): the sidebar moves half the fingers' scroll distance; their speed is
// read over the last 100 ms (ARCUI.VelocityTracker); at the lift, moving at 5 px/s or more its direction decides, slower
// the nearest space; past the first or last space Motion's rubber band (coefficient 0.15 over 255 pt); the settle a
// critically damped spring (response 0.4 s, damping ratio 1) from the lift's speed when that heads the same way.
// Dia 1.58.0 (The Browser Company's next browser, the same ARCUI.PageSwipeController, 2026-11-20) differs in two
// things only, both set by its sidebar and its tab strip (TabSidebar.PagingContainerViewController,
// TabStrip.TabStripSpacePagingController): the detent haptic on (`performsPageDetentHaptics`: Arc never turns it on), and
// a settling handler, so the spring's response is 0.25 s and it's played as keyframes sampled at 240 Hz by Core
// Animation (Arc's sidebar has none: 0.4 s, moved frame by frame). A theme names the one it wants (`--m-swipe-feel`).
const FEELS: Record<string, { response: number, haptics: boolean }> = {
  arc: { response: 0.4, haptics: false },
  dia: { response: 0.25, haptics: true },
};

const ARC = {
  SCALE: 0.5,
  VELOCITY_MS: 100,
  COMMIT_SPEED: 5, // px/s of the sidebar
  RUBBER_COEFFICIENT: 0.15,
  RUBBER_DIMENSION: 255,
  RESPONSE: 0.4, // s
  DAMPING: 1,
  REST_PX: 0.5, // the settle is over within half a pixel…
  REST_SPEED: 10, // …moving under 10 px/s
  SETTLE_MAX_S: 1.5,
};

const DEFAULTS = {
  GAP_MS: 140,
  AXIS_PX: 6,
  MAX_STEP: 120,
  MOMENTUM_RUN: 5,
  MIN_EVENTS: 4,
  COMMIT_FRACTION: 0.3, // of the sidebar's width
  FLICK_PX: 40, // a shorter swipe still switches if it's fast…
  FLICK_SPEED: 0.6, // …in px/ms over its last few events, the same way
};

function createSpaceSwipe(options: Partial<typeof DEFAULTS> = {}) {
  const o = { ...DEFAULTS, ...options };
  // A swipe under way: its axis once it's known, how far each way, its offset and events, whether it's let go,
  // its last delta, and its recent deltas with their times.
  // `samples`: the offset after each counted event, with its time (the velocity's, ARC.VELOCITY_MS).
  type Gesture = { axis: 'x' | 'y' | null, dx: number, dy: number, offset: number, events: number, released: boolean, last: number, recent: { d: number, t: number }[], samples: { o: number, t: number }[] };
  let gesture: Gesture | null = null;
  let lastTime = -Infinity;

  // `counted`: this event moved the drag (an oversized step doesn't).
  const idle = () => ({ phase: 'idle', offset: 0, speed: 0, events: 0, counted: false });
  // Average speed (px/ms) of the last few finger movements, signed like `offset`.
  const speed = (g: Gesture) => {
    const run = g.recent.slice(-4);
    if (run.length < 2) return 0;
    const span = run[run.length - 1].t - run[0].t;
    return span > 0 ? run.slice(1).reduce((sum, r) => sum + r.d, 0) / span : 0;
  };
  // Momentum: a smooth decay over the last MOMENTUM_RUN deltas, each 80–99%
  // of the one before, from a real speed (fingers easing off while still
  // down rarely decay that steadily).
  const decaying = (g: Gesture) => {
    const run = g.recent.slice(-o.MOMENTUM_RUN).map((r) => Math.abs(r.d));
    if (run.length < o.MOMENTUM_RUN || run[0] < 4) return false;
    for (let i = 1; i < run.length; i++) {
      const ratio = run[i] / run[i - 1];
      if (!(ratio >= 0.8 && ratio < 0.99)) return false;
    }
    return true;
  };
  // `time`: when it was let go. `overrun`: by momentum (`decaying`), the offset its run added after its first event, and
  // `lifted` that first event's time (the fingers lifted about then: Arc's feel takes the run back out).
  const release = (g: Gesture, time: number, run = false) => {
    g.released = true;
    g.last = -(g.recent.at(-1)?.d ?? 0); // the last delta, as deltaX
    const tail = run ? g.recent.slice(-(o.MOMENTUM_RUN - 1)) : [];
    const overrun = tail.reduce((sum, r) => sum + r.d, 0);
    const lifted = run ? g.recent.at(-o.MOMENTUM_RUN)?.t ?? time : time;
    return { phase: 'release', offset: g.offset, speed: speed(g), events: g.events, counted: false, time, overrun, lifted };
  };

  // One event of gesture `g`; `ok`: this input, here, may swipe.
  function track(g: Gesture | null, { deltaX, deltaY, time, ok, decay }: { deltaX: number; deltaY: number; time: number; ok: boolean; decay: boolean }) {
    if (!g || g.axis === 'y' || g.released) return idle();
    if (g.axis == null) {
      if (!ok) {
        g.axis = 'y'; // not here, not this input: left alone until it ends
        return idle();
      }
      g.dx += Math.abs(deltaX);
      g.dy += Math.abs(deltaY);
      if (Math.max(g.dx, g.dy) < o.AXIS_PX) return idle();
      g.axis = g.dx > g.dy * 1.2 ? 'x' : 'y';
      if (g.axis === 'y') return idle();
    }
    if (Math.abs(deltaX) > o.MAX_STEP) return { phase: 'tracking', offset: g.offset, speed: 0, events: g.events, counted: false };
    g.offset -= deltaX;
    g.events += 1;
    g.recent.push({ d: -deltaX, t: time });
    if (g.recent.length > 8) g.recent.shift();
    g.samples.push({ o: g.offset, t: time });
    if (g.samples.length > 64) g.samples.shift();
    if (decay && decaying(g)) return release(g, time, true);
    return { phase: 'tracking', offset: g.offset, speed: speed(g), events: g.events, counted: true };
  }

  return {
    // One wheel event. Returns { phase: 'idle' | 'tracking' | 'release',
    // offset (px), speed (px/ms), events }. `usable`: false where the
    // gesture doesn't apply (something under the pointer scrolls sideways, a
    // field is being edited); `mouse`: the sidebar recognised a mouse wheel.
    // Checked until the gesture's axis is decided.
    // `fresh` (the trackpad's phases known, Margin.app): true, a new gesture whatever the gap (the fingers touched
    // again); false, the same one (they're still down, however long they rested). Unsaid, the gap decides. `decay`:
    // false, never let go by momentum (the phases say when the fingers lift).
    wheel({ deltaX = 0, deltaY = 0, deltaMode = 0, ctrlKey = false, shiftKey = false, mouse = false, time, usable = true, fresh: told, decay = true }: { deltaX?: number, deltaY?: number, deltaMode?: number, ctrlKey?: boolean, shiftKey?: boolean, mouse?: boolean, time: number, usable?: boolean, fresh?: boolean, decay?: boolean }) {
      let fresh = told ?? time - lastTime > o.GAP_MS;
      lastTime = time;
      // After a release, only momentum continues the gesture: steady or
      // shrinking, the same way, sideways.
      const g0 = gesture;
      if (!fresh && g0?.released && told === undefined) {
        const momentum = Math.abs(deltaX) >= Math.abs(deltaY) && Math.sign(deltaX) !== -Math.sign(g0.last) && Math.abs(deltaX) <= Math.abs(g0.last) * 1.2 + 1;
        if (momentum) g0.last = deltaX;
        else fresh = true;
      }
      // A drag still being tracked when a new gesture starts: let it go now.
      const unreleased = fresh && gesture?.axis === 'x' && !gesture.released ? release(gesture, time) : null;
      if (fresh) gesture = { axis: null, dx: 0, dy: 0, offset: 0, events: 0, released: false, last: 0, recent: [], samples: [] };
      const result = track(gesture, { deltaX, deltaY, time, ok: usable && !ctrlKey && !shiftKey && !mouse && deltaMode === 0, decay });
      return unreleased ?? result;
    },
    // Would a wheel event at `time` belong to the swipe being tracked? (The
    // sidebar keeps those from scrolling anything.)
    swiping(time: number) {
      return !!gesture && gesture.axis === 'x' && time - lastTime <= o.GAP_MS;
    },
    // No wheel events for GAP_MS: the fingers stopped or lifted.
    end(time = lastTime) {
      const g = gesture;
      gesture = null;
      lastTime = -Infinity;
      if (!g || g.axis !== 'x' || g.released) return idle();
      return release(g, time);
    },
    // The fingers lifted (the trackpad's phases, Margin.app): the swipe being tracked let go now. It stays the gesture
    // (released): its momentum continues it and is ignored.
    lift(time: number) {
      const g = gesture;
      if (!g || g.axis !== 'x' || g.released) return idle();
      return release(g, time);
    },
    // A swipe tracked and not let go, its last event within the gap of `time`.
    tracking(time: number) {
      return !!gesture && gesture.axis === 'x' && !gesture.released && time - lastTime <= o.GAP_MS;
    },
    // The gesture (tracked or let go) is a sideways swipe.
    isSwipe() {
      return gesture?.axis === 'x';
    },
    // Arc's velocity (px/ms, signed like the offset): the first and last of the samples within `window` ms before
    // `time`, the newest at or before it; 0 with fewer than two.
    velocity(time: number, window: number) {
      const run = (gesture?.samples ?? []).filter((x) => x.t <= time && x.t >= time - window);
      if (run.length < 2) return 0;
      const first = run[0], last = run[run.length - 1];
      return last.t > first.t ? (last.o - first.o) / (last.t - first.t) : 0;
    },
    reset() {
      gesture = null;
      lastTime = -Infinity;
    },
  };
}

// Where a released swipe goes: -1 (the previous space), 1 (the next) or 0
// (back to where it was). `has(-1 | 1)`: is there a space that way?
function settle({ offset, speed, events = Infinity, width, has }: { offset: number, speed: number, events?: number, width: number, has: (dir: -1 | 1) => boolean }, o = DEFAULTS) {
  const dir = offset > 0 ? -1 : 1; // fingers right: the previous space
  if (!offset || events < o.MIN_EVENTS || !has(dir)) return 0;
  const far = Math.abs(offset) >= width * o.COMMIT_FRACTION;
  const flick = Math.abs(offset) >= o.FLICK_PX && Math.sign(speed) === Math.sign(offset) && Math.abs(speed) >= o.FLICK_SPEED;
  // Flicked back the other way at the end: cancelled, however far it went.
  const reversed = Math.sign(speed) === -Math.sign(offset) && Math.abs(speed) >= o.FLICK_SPEED;
  return (far || flick) && !reversed ? dir : 0;
}

// Past the first or last space the list resists (a rubber band): the drag
// is shown at a fraction that shrinks the further it goes, never past `max`.
function rubberBand(offset: number, max: number) {
  const d = Math.abs(offset);
  return Math.sign(offset) * max * (1 - 1 / (d / max + 1));
}

// Arc's: where a released swipe goes (-1, 1 or 0, as `settle`). `offset`: the sidebar's (> 0 toward the previous
// space); `velocity`: its speed at the lift (px/s, signed alike). At ARC.COMMIT_SPEED or more, its direction: toward a
// neighbour it's over, that one; away from it, back. Slower, the nearest: past half the width, that neighbour. One
// space at most, and only toward one there is. `cancelled` (the trackpad cancelled the gesture): back.
function settleArc({ offset, velocity, width, has, events = Infinity, cancelled = false }: { offset: number, velocity: number, width: number, has: (dir: -1 | 1) => boolean, events?: number, cancelled?: boolean }, o = DEFAULTS) {
  if (cancelled || events < o.MIN_EVENTS) return 0;
  const p = -offset, v = -velocity; // Arc's position and velocity: > 0 toward the next space
  let dir: -1 | 0 | 1;
  if (Math.abs(v) >= ARC.COMMIT_SPEED) dir = p > 0 ? (v > 0 ? 1 : 0) : p < 0 ? (v > 0 ? 0 : -1) : (v > 0 ? 1 : -1);
  else dir = Math.abs(p) >= width / 2 ? (p > 0 ? 1 : -1) : 0;
  return dir && has(dir) ? dir : 0;
}

// Arc's rubber band (Motion's `rubberband`, coefficient 0.15 over 255 pt): `overflow` px past the last space shown as.
function rubberBandArc(overflow: number) {
  const x = Math.abs(overflow) * ARC.RUBBER_COEFFICIENT / ARC.RUBBER_DIMENSION + 1;
  return Math.sign(overflow) * (1 - 1 / x) * ARC.RUBBER_DIMENSION;
}

// Its inverse (Arc's, as it takes over a settle at its presentation's position): the overflow `shown` (px past the last
// space, drawn) stands for. Never past the band's own limit.
function rubberBandArcInverse(shown: number) {
  const d = Math.min(Math.abs(shown), ARC.RUBBER_DIMENSION - 1e-6);
  return Math.sign(shown) * (d * ARC.RUBBER_DIMENSION) / ((ARC.RUBBER_DIMENSION - d) * ARC.RUBBER_COEFFICIENT);
}

// Arc's settle: a critically damped spring (damping ratio 1; Motion's SpringFunction: stiffness (2π/response)²) from
// `from` at `velocity` (px/s) to `to`. `at(t)` (seconds): where it is and how fast; `duration`: when it's at rest
// (within REST_PX, under REST_SPEED; at most SETTLE_MAX_S), found by stepping 1/240 s as Arc samples it.
function springArc(from: number, velocity: number, to: number, response = ARC.RESPONSE) {
  const w = (2 * Math.PI) / response;
  const a = from - to, b = velocity + w * a;
  const at = (t: number) => {
    const e = Math.exp(-w * t);
    return { x: to + (a + b * t) * e, v: (b - w * (a + b * t)) * e };
  };
  let duration = 0;
  for (let t = 0; t <= ARC.SETTLE_MAX_S; t += 1 / 240) {
    const { x, v } = at(t);
    duration = t;
    if (Math.abs(x - to) < ARC.REST_PX && Math.abs(v) < ARC.REST_SPEED) break;
  }
  return { at, duration };
}

// The spring as Dia plays it: its position sampled every 1/240 s to its rest (its `positions` and `keyTimes`), as the
// progress from `from` to `to` (0 to 1, past 1 where it overshoots), for a CSS `linear()` easing over `duration` (the
// browser then moves it, as Core Animation does Dia's). Nothing to move: none.
function springKeyframes(spring: ReturnType<typeof springArc>, from: number, to: number) {
  if (from === to || spring.duration <= 0) return null;
  const n = Math.round(spring.duration * 240);
  const points: number[] = [];
  for (let i = 0; i <= n; i++) points.push(Math.round(((spring.at(i / 240).x - from) / (to - from)) * 10000) / 10000);
  points[0] = 0;
  points[n] = 1;
  return points;
}

// Arc's switch to a space by a click or a key, no fingers (M2.10, docs/ARC-SIDEBAR.md "Motion": measured in Arc 1.174.2
// frame by frame, the incoming page's place at 60 Hz): the pages side by side sliding together on an overdamped spring
// (response 130 ms, damping ratio 1.35) that starts at 72 widths a second, which fits every frame within 2.5 pt (RMS)
// over a 259 pt sidebar; done to within 0.2% in about 251 ms (the last 0.2% a jump nobody sees).
const ARC_SWITCH = Object.freeze({ response: 0.13, damping: 1.35, velocity: 72, rest: 0.002, steps: 60 });

/** Arc's switch's easing: the spring's progress (0 to 1) at `steps` even times, and how long it takes (ms). */
function switchEasing({ response, damping, velocity, rest, steps } = ARC_SWITCH) {
  const w = (2 * Math.PI) / response;
  const s = Math.sqrt(damping * damping - 1);
  const r1 = -w * (damping - s), r2 = -w * (damping + s);
  // (The distance left, from 1 at the start, falling at `velocity` widths a second.)
  const c2 = (-velocity - r1) / (r2 - r1), c1 = 1 - c2;
  const left = (t: number) => c1 * Math.exp(r1 * t) + c2 * Math.exp(r2 * t);
  let t = 0;
  while (left(t) > rest && t < 2) t += 0.001;
  const duration = Math.round(t * 1000);
  const points = Array.from({ length: steps + 1 }, (_, i) => (i === 0 ? 0 : i === steps ? 1 : Math.round((1 - left((t * i) / steps)) * 10000) / 10000));
  return { duration, points };
}

export { createSpaceSwipe, settle, rubberBand, settleArc, rubberBandArc, rubberBandArcInverse, springArc, springKeyframes, switchEasing, ARC, ARC_SWITCH, FEELS, DEFAULTS };
