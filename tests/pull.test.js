import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pull from '../extension/shared/pull.js';

const { createPullTracker } = pull;

// Feed a series of deltaY values, 16ms apart from `t0`; returns the states.
function feed(tracker, deltas, { t0 = 1000, atTop = true } = {}) {
  return deltas.map((deltaY, i) => tracker.wheel({ deltaY, time: t0 + i * 16, atTop }).state);
}
// A steady, deliberate pull: n events of `step` px upward, with finger jitter.
const pullDeltas = (n, step = -12) => Array.from({ length: n }, (_, i) => step + (i % 3) - 1);

test('a deliberate pull at the top arms, and refreshes when the fingers lift (events stop)', () => {
  const t = createPullTracker();
  const states = feed(t, pullDeltas(16)); // 16 × ~12px = ~190px over 240ms
  assert.equal(states[0], 'pulling');
  assert.equal(states.at(-1), 'armed');
  assert.equal(t.end().state, 'trigger');
});

test('released before the threshold: no refresh', () => {
  const t = createPullTracker();
  assert.equal(feed(t, pullDeltas(6)).at(-1), 'pulling');
  assert.equal(t.end().state, 'idle');
});

test('armed, then momentum starts (the fingers lifted): refresh right away', () => {
  const t = createPullTracker();
  feed(t, pullDeltas(16));
  const momentum = [-20, -17, -14.5, -12.3, -10.5, -8.9];
  const states = momentum.map((d, i) => t.wheel({ deltaY: d, time: 1000 + (16 + i) * 16, atTop: true }).state);
  assert.ok(states.includes('trigger'), states.join());
});

test('a flick at the top (mostly momentum) never refreshes', () => {
  const t = createPullTracker();
  const flick = [-30, -45, -40, -34, -29, -24.6, -21, -17.8, -15.2, -12.9, -11, -9.3, -7.9, -6.7, -5.7, -4.9, -4.1, -3.5, -3, -2.5];
  const states = feed(t, flick);
  assert.ok(!states.includes('trigger'), states.join());
  assert.equal(t.end().state, 'idle');
});

test('a gesture that started below the top (scrolling up to it) never pulls', () => {
  const t = createPullTracker();
  feed(t, [-12, -12, -12], { atTop: false }); // still scrolling the page up
  const states = feed(t, pullDeltas(20), { t0: 1000 + 3 * 16 }); // reached the top, same gesture
  assert.ok(states.every((s) => s === 'idle'), states.join());
  assert.equal(t.end().state, 'idle');
});

test('mouse-wheel notches (big single jumps) don\'t pull', () => {
  const t = createPullTracker();
  const states = feed(t, [-100, -120, -100, -120, -100, -120, -100, -120, -100, -120]);
  assert.ok(states.every((s) => s === 'idle'), states.join());
  assert.equal(t.end().state, 'idle');
});

test('too short to be deliberate: big quick pull over few events doesn\'t arm', () => {
  const t = createPullTracker();
  const states = feed(t, [-60, -70, -60, -50]); // 240px but 4 events / 48ms
  assert.notEqual(states.at(-1), 'armed');
  assert.equal(t.end().state, 'idle');
});

test('pulling back up un-pulls; leaving the top cancels', () => {
  const t = createPullTracker();
  feed(t, pullDeltas(16));
  const back = feed(t, Array(16).fill(13), { t0: 1000 + 16 * 16 });
  assert.equal(back.at(-1), 'idle', 'pulled all the way back');
  const u = createPullTracker();
  feed(u, pullDeltas(16));
  assert.equal(u.wheel({ deltaY: -12, time: 1000 + 16 * 16, atTop: false }).state, 'idle');
  assert.equal(u.end().state, 'idle');
});

test('a new gesture after a pause starts fresh', () => {
  const t = createPullTracker();
  feed(t, pullDeltas(16));
  assert.equal(t.end().state, 'trigger');
  assert.equal(feed(t, pullDeltas(3), { t0: 1500 }).at(-1), 'pulling');
});

// ---- swipe back/forward (axis x) ---------------------------------------------

const { createSwipeTracker } = pull;
function feedX(tracker, deltas, { t0 = 1000, eligible = true } = {}) {
  return deltas.map((deltaX, i) => tracker.wheel({ deltaX, deltaY: 0.5, time: t0 + i * 16, eligible }));
}

test('swipe: a deliberate sideways swipe arms in its direction and triggers on release', () => {
  const back = createSwipeTracker();
  const states = feedX(back, Array.from({ length: 12 }, (_, i) => -12 + (i % 3) - 1));
  assert.equal(states.at(-1).state, 'armed');
  assert.equal(states.at(-1).direction, -1, 'deltaX < 0: back');
  assert.deepEqual([back.end().state, back.end().state], ['trigger', 'idle']);

  const forward = createSwipeTracker();
  feedX(forward, Array(12).fill(12));
  const end = forward.end();
  assert.equal(end.state, 'trigger');
  assert.equal(end.direction, 1, 'deltaX > 0: forward');
});

test('swipe: reversing un-swipes; a vertical scroll, a flick, notches or an ineligible start never trigger', () => {
  const t = createSwipeTracker();
  feedX(t, Array(10).fill(-12));
  assert.equal(feedX(t, Array(12).fill(12), { t0: 1000 + 160 }).at(-1).state, 'idle', 'swiped back the other way');
  assert.equal(t.end().state, 'idle');

  const vertical = createSwipeTracker();
  for (let i = 0; i < 20; i++) vertical.wheel({ deltaX: 2, deltaY: 30, time: 1000 + i * 16, eligible: true });
  assert.equal(vertical.end().state, 'idle');

  const flick = createSwipeTracker();
  const states = feedX(flick, [-30, -45, -40, -34, -29, -24.6, -21, -17.8, -15.2, -12.9, -11]);
  assert.ok(!states.some((s) => s.state === 'trigger'));
  assert.equal(flick.end().state, 'idle');

  const notches = createSwipeTracker();
  feedX(notches, [-100, -120, -100, -120, -100, -120, -100]);
  assert.equal(notches.end().state, 'idle');

  const blocked = createSwipeTracker(); // something under the pointer scrolls sideways
  feedX(blocked, Array(12).fill(-12), { eligible: false });
  assert.equal(blocked.end().state, 'idle');
});

// Where the gesture applies, asked lazily (content/trackpad.js passes a
// function: answering walks the page and can cost a layout).
test('eligibility as a function: the same results as a boolean, asked at most once per event, and not while a gesture is already out', () => {
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let asked = 0;
  let events = 0;
  for (const make of ['createPullTracker', 'createSwipeTracker']) {
    for (let run = 0; run < 300; run++) {
      const plain = pull[make]();
      const lazy = pull[make]();
      let time = 0;
      for (let i = 0; i < 100; i++) {
        time += random() < 0.08 ? 150 + random() * 300 : 8 + random() * 12;
        const ok = random() < 0.85;
        const e = { deltaX: Math.round((random() - 0.5) * 60), deltaY: Math.round((random() - 0.5) * 60), time };
        if (random() < 0.3) e[make === 'createPullTracker' ? 'deltaX' : 'deltaY'] = 0;
        let now = 0;
        events++;
        const expected = plain.wheel({ ...e, eligible: ok });
        assert.deepEqual(lazy.wheel({ ...e, eligible: () => { now++; asked++; return ok; } }), expected, `${make} run ${run} event ${i}`);
        assert.ok(now <= 1, 'asked at most once for one event');
        if (random() < 0.03) assert.deepEqual(lazy.end(), plain.end());
      }
      assert.deepEqual(lazy.end(), plain.end());
    }
  }
  assert.ok(asked < events, 'not asked for every event');

  const t = createPullTracker();
  let calls = 0;
  const notHere = () => { calls++; return false; };
  for (let i = 0; i < 5; i++) t.wheel({ deltaY: -12, time: 1000 + i * 16, atTop: notHere });
  assert.equal(calls, 1, 'a gesture that started where it doesn\'t apply isn\'t asked again');
  t.wheel({ deltaY: -12, time: 1000 + 5 * 16 + 200, atTop: notHere });
  assert.equal(calls, 2, 'the next gesture is');
});
