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
  let gesture: { axis: 'x' | 'y' | null, dx: number, dy: number, offset: number, events: number, released: boolean, last: number, recent: { d: number, t: number }[] } | null = null;
  let lastTime = -Infinity;

  // `counted`: this event moved the drag (an oversized step doesn't).
  const idle = () => ({ phase: 'idle', offset: 0, speed: 0, events: 0, counted: false });
  // Average speed (px/ms) of the last few finger movements, signed like `offset`.
  const speed = (g) => {
    const run = g.recent.slice(-4);
    if (run.length < 2) return 0;
    const span = run[run.length - 1].t - run[0].t;
    return span > 0 ? run.slice(1).reduce((sum, r) => sum + r.d, 0) / span : 0;
  };
  // Momentum: a smooth decay over the last MOMENTUM_RUN deltas, each 80–99%
  // of the one before, from a real speed (fingers easing off while still
  // down rarely decay that steadily).
  const decaying = (g) => {
    const run = g.recent.slice(-o.MOMENTUM_RUN).map((r) => Math.abs(r.d));
    if (run.length < o.MOMENTUM_RUN || run[0] < 4) return false;
    for (let i = 1; i < run.length; i++) {
      const ratio = run[i] / run[i - 1];
      if (!(ratio >= 0.8 && ratio < 0.99)) return false;
    }
    return true;
  };
  const release = (g) => {
    g.released = true;
    g.last = -(g.recent.at(-1)?.d ?? 0); // the last delta, as deltaX
    return { phase: 'release', offset: g.offset, speed: speed(g), events: g.events, counted: false };
  };

  // One event of gesture `g`; `ok`: this input, here, may swipe.
  function track(g, { deltaX, deltaY, time, ok }) {
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
    if (decaying(g)) return release(g);
    return { phase: 'tracking', offset: g.offset, speed: speed(g), events: g.events, counted: true };
  }

  return {
    // One wheel event. Returns { phase: 'idle' | 'tracking' | 'release',
    // offset (px), speed (px/ms), events }. `usable`: false where the
    // gesture doesn't apply (something under the pointer scrolls sideways, a
    // field is being edited); `mouse`: the sidebar recognised a mouse wheel.
    // Checked until the gesture's axis is decided.
    wheel({ deltaX = 0, deltaY = 0, deltaMode = 0, ctrlKey = false, shiftKey = false, mouse = false, time, usable = true }: { deltaX?: number, deltaY?: number, deltaMode?: number, ctrlKey?: boolean, shiftKey?: boolean, mouse?: boolean, time: number, usable?: boolean }) {
      let fresh = time - lastTime > o.GAP_MS;
      lastTime = time;
      // After a release, only momentum continues the gesture: steady or
      // shrinking, the same way, sideways.
      const g0 = gesture;
      if (!fresh && g0?.released) {
        const momentum = Math.abs(deltaX) >= Math.abs(deltaY) && Math.sign(deltaX) !== -Math.sign(g0.last) && Math.abs(deltaX) <= Math.abs(g0.last) * 1.2 + 1;
        if (momentum) g0.last = deltaX;
        else fresh = true;
      }
      // A drag still being tracked when a new gesture starts: let it go now.
      const unreleased = fresh && gesture?.axis === 'x' && !gesture.released ? release(gesture) : null;
      if (fresh) gesture = { axis: null, dx: 0, dy: 0, offset: 0, events: 0, released: false, last: 0, recent: [] };
      const result = track(gesture, { deltaX, deltaY, time, ok: usable && !ctrlKey && !shiftKey && !mouse && deltaMode === 0 });
      return unreleased ?? result;
    },
    // Would a wheel event at `time` belong to the swipe being tracked? (The
    // sidebar keeps those from scrolling anything.)
    swiping(time: number) {
      return !!gesture && gesture.axis === 'x' && time - lastTime <= o.GAP_MS;
    },
    // No wheel events for GAP_MS: the fingers stopped or lifted.
    end() {
      const g = gesture;
      gesture = null;
      lastTime = -Infinity;
      if (!g || g.axis !== 'x' || g.released) return idle();
      return release(g);
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

export { createSpaceSwipe, settle, rubberBand, DEFAULTS };
