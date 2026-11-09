// Trackpad pull/swipe gestures, the logic only (no DOM): Margin's
// replacements for Safari's pull-to-refresh and two-finger swipe back/forward,
// which stop with the page's bounce and the swipe guard (shared/gestures.ts).
// Fed the page's wheel events; content/core.ts acts on them and the theme
// draws the indicators.
//
// Web pages don't get the trackpad's gesture phases, which Safari uses to
// ignore momentum and to know when the fingers lift, so they're inferred:
//  - A gesture is a run of wheel events with no gap over GAP_MS. It counts
//    only if it started where the gesture applies (the top of the page for
//    a pull; nothing to scroll sideways for a swipe), like Safari's.
//  - Momentum (after the fingers lift) decays smoothly: once MOMENTUM_RUN
//    events in a row each shrink by a steady factor, the rest of the gesture
//    is momentum and doesn't count. If it was already past the threshold, the
//    fingers have lifted: trigger now.
//  - It must be sustained to arm: THRESHOLD px along the axis, over at least
//    MIN_EVENTS events and MIN_MS. Single jumps over MAX_STEP px (a mouse
//    wheel's notches) don't count. Erring towards not triggering.
//  - When the events stop (GAP_MS), an armed gesture triggers; anything else
//    is cancelled.
//
// Pull (axis 'y'): scrolling up at the top (deltaY < 0). Swipe (axis 'x'):
// the direction is set by the gesture's first sideways movement, -1 = back
// (deltaX < 0, fingers moving right with natural scrolling), 1 = forward.


const DEFAULTS = {
  THRESHOLD: 150,
  GAP_MS: 140,
  MIN_EVENTS: 8,
  MIN_MS: 160,
  MAX_STEP: 80,
  MOMENTUM_RUN: 5,
};
const SWIPE_DEFAULTS = { ...DEFAULTS, THRESHOLD: 110, MIN_EVENTS: 6, MIN_MS: 100 };

function createTracker(axis, options) {
  const o = options;
  let gesture = null; // { start, last, events, pull, direction, eligible, momentum, recent: [] }
  let lastTime = -Infinity;

  const idle = () => ({ state: 'idle', progress: 0, direction: 0 });
  const view = (g) => {
    const progress = Math.min(g.pull / o.THRESHOLD, 1.5);
    const armed = g.pull >= o.THRESHOLD && g.events >= o.MIN_EVENTS && g.last - g.start >= o.MIN_MS;
    return { state: armed ? 'armed' : g.pull > 0 ? 'pulling' : 'idle', progress, direction: g.direction };
  };

  // Smooth decay over the last MOMENTUM_RUN deltas: each 72–99% of the one before.
  const decaying = (recent) => {
    if (recent.length < o.MOMENTUM_RUN) return false;
    const run = recent.slice(-o.MOMENTUM_RUN);
    if (run[0] < 3) return false;
    for (let i = 1; i < run.length; i++) {
      const ratio = run[i] / run[i - 1];
      if (!(ratio >= 0.72 && ratio < 0.995)) return false;
    }
    return true;
  };

  return {
    // One wheel event. `eligible` (`atTop` for a pull): the gesture applies
    // here; or a function saying so, asked only while the answer matters (a
    // new gesture, or one still eligible), at most once per event: what it
    // looks at in the page can cost a layout. Returns { state: 'idle' |
    // 'pulling' | 'armed' | 'trigger', progress, direction }.
    wheel({ deltaY = 0, deltaX = 0, time, eligible, atTop }: { deltaY?: number, deltaX?: number, time: number, eligible?: boolean | (() => boolean), atTop?: boolean | (() => boolean) }) {
      const given = eligible ?? atTop;
      let answer = null;
      const ok = () => (answer ??= !!(typeof given === 'function' ? given() : given));
      const primary = axis === 'y' ? deltaY : deltaX;
      const cross = axis === 'y' ? deltaX : deltaY;
      const fresh = time - lastTime > o.GAP_MS;
      lastTime = time;
      if (fresh) {
        gesture = { start: time, last: time, events: 0, pull: 0, direction: axis === 'y' ? -1 : 0, eligible: ok(), momentum: false, recent: [] };
      }
      const g = gesture;
      if (!g?.eligible) return idle();
      g.last = time;
      if (!ok()) { // e.g. the page scrolled, or the pointer moved over something that scrolls
        g.eligible = false;
        return idle();
      }
      const along = Math.abs(primary) >= Math.abs(cross);
      g.recent.push(Math.abs(along ? primary : 0));
      if (g.recent.length > o.MOMENTUM_RUN) g.recent.shift();
      if (!g.momentum && decaying(g.recent)) {
        g.momentum = true;
        if (view(g).state === 'armed') {
          g.eligible = false;
          return { ...view(g), state: 'trigger' };
        }
      }
      if (g.momentum) return idle();
      if (!along || Math.abs(primary) > o.MAX_STEP) return view(g);
      if (!g.direction && Math.abs(primary) >= 1) g.direction = Math.sign(primary);
      if (!g.direction) return view(g);
      g.events += 1;
      g.pull = Math.max(0, g.pull + primary * g.direction);
      return view(g);
    },
    // No wheel events for GAP_MS: the gesture is over.
    end() {
      const g = gesture;
      gesture = null;
      lastTime = -Infinity; // the next event starts a new gesture
      if (!g?.eligible || g.momentum) return idle();
      return view(g).state === 'armed' ? { ...view(g), state: 'trigger' } : idle();
    },
    reset() {
      gesture = null;
      lastTime = -Infinity;
    },
  };
}

const createPullTracker = (options = {}) => createTracker('y', { ...DEFAULTS, ...options });
const createSwipeTracker = (options = {}) => createTracker('x', { ...SWIPE_DEFAULTS, ...options });

export { createPullTracker, createSwipeTracker, DEFAULTS, SWIPE_DEFAULTS };
