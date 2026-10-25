// Pull-to-refresh, the logic only (no DOM): Margin's replacement for
// Safari's, which stops with the page's bounce (shared/gestures.js). Fed the
// page's wheel events; content/sidebar.js draws the indicator and reloads.
// Classic script; attaches to globalThis.Margin.pull.
//
// Web pages don't get the trackpad's gesture phases, which Safari uses to
// ignore momentum and to know when the fingers lift, so they're inferred:
//  - A gesture is a run of wheel events with no gap over GAP_MS. It counts
//    only if it started at the top of the page (like Safari's).
//  - Momentum (after the fingers lift) decays smoothly: once MOMENTUM_RUN
//    events in a row each shrink by a steady factor, the rest of the gesture
//    is momentum and doesn't pull. If the pull was already past the
//    threshold, the fingers have lifted: refresh now.
//  - A pull must be sustained to arm: THRESHOLD px of upward scrolling, over
//    at least MIN_EVENTS events and MIN_MS. Single jumps over MAX_STEP px
//    (a mouse wheel's notches) don't pull at all. Erring towards not
//    reloading.
//  - When the events stop (GAP_MS), an armed pull refreshes; anything else
//    is cancelled.

(() => {
  const Margin = (globalThis.Margin ??= {});

  const DEFAULTS = {
    THRESHOLD: 150,
    GAP_MS: 140,
    MIN_EVENTS: 8,
    MIN_MS: 160,
    MAX_STEP: 80,
    MOMENTUM_RUN: 5,
  };

  function createPullTracker(options = {}) {
    const o = { ...DEFAULTS, ...options };
    let gesture = null; // { start, last, events, pull, eligible, momentum, recent: [] }
    let lastTime = -Infinity;

    const idle = (progress = 0) => ({ state: 'idle', progress });
    const view = (g) => {
      const progress = Math.min(g.pull / o.THRESHOLD, 1.5);
      const armed = g.pull >= o.THRESHOLD && g.events >= o.MIN_EVENTS && g.last - g.start >= o.MIN_MS;
      return { state: armed ? 'armed' : g.pull > 0 ? 'pulling' : 'idle', progress };
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
      // One wheel event. `atTop`: the page is at its top and nothing under
      // the pointer scrolls vertically (shared/gestures.js atPageTop).
      // Returns { state: 'idle' | 'pulling' | 'armed' | 'refresh', progress }.
      wheel({ deltaY, deltaX = 0, time, atTop }) {
        const fresh = time - lastTime > o.GAP_MS;
        lastTime = time;
        if (fresh) gesture = { start: time, last: time, events: 0, pull: 0, eligible: atTop, momentum: false, recent: [] };
        const g = gesture;
        if (!g?.eligible) return idle();
        g.last = time;
        if (!atTop) { // the page scrolled down (or the pointer moved over a list)
          g.eligible = false;
          return idle();
        }
        const vertical = Math.abs(deltaY) >= Math.abs(deltaX);
        g.recent.push(Math.abs(vertical ? deltaY : 0));
        if (g.recent.length > o.MOMENTUM_RUN) g.recent.shift();
        if (!g.momentum && decaying(g.recent)) {
          g.momentum = true;
          if (view(g).state === 'armed') {
            g.eligible = false;
            return { state: 'refresh', progress: view(g).progress };
          }
        }
        if (g.momentum || !vertical || Math.abs(deltaY) > o.MAX_STEP) return g.momentum ? idle() : view(g);
        g.events += 1;
        g.pull = Math.max(0, g.pull - deltaY); // scrolling up (deltaY < 0) pulls down
        return view(g);
      },
      // No wheel events for GAP_MS: the gesture is over.
      end() {
        const g = gesture;
        gesture = null;
        lastTime = -Infinity; // the next event starts a new gesture
        if (!g?.eligible || g.momentum) return idle();
        return view(g).state === 'armed' ? { state: 'refresh', progress: view(g).progress } : idle();
      },
      reset() {
        gesture = null;
        lastTime = -Infinity;
      },
    };
  }

  Margin.pull = { createPullTracker, DEFAULTS };
})();
