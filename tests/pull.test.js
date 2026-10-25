import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../extension/shared/pull.js';

const { createPullTracker } = globalThis.Margin.pull;

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
  assert.equal(t.end().state, 'refresh');
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
  assert.ok(states.includes('refresh'), states.join());
});

test('a flick at the top (mostly momentum) never refreshes', () => {
  const t = createPullTracker();
  const flick = [-30, -45, -40, -34, -29, -24.6, -21, -17.8, -15.2, -12.9, -11, -9.3, -7.9, -6.7, -5.7, -4.9, -4.1, -3.5, -3, -2.5];
  const states = feed(t, flick);
  assert.ok(!states.includes('refresh'), states.join());
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
  assert.equal(t.end().state, 'refresh');
  assert.equal(feed(t, pullDeltas(3), { t0: 1500 }).at(-1), 'pulling');
});
