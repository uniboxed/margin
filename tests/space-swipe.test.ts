// shared/space-swipe.ts: the sidebar's swipe between spaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpaceSwipe, settle, rubberBand, settleArc, rubberBandArc, springArc, springKeyframes, ARC, FEELS } from '../extension/shared/space-swipe.ts';

type Swipe = ReturnType<typeof createSpaceSwipe>;

// A run of wheel events, 16ms apart from `start`.
function feed(swipe: Swipe, deltas: number[], { start = 1000, usable = true, deltaY = 0 } = {}) {
  return deltas.map((dx, i) => swipe.wheel({ deltaX: dx, deltaY, time: start + i * 16, usable }));
}
const both = () => true;

test('space swipe: follows the fingers (right = positive), releases when they stop', () => {
  const swipe = createSpaceSwipe();
  const out = feed(swipe, [-4, -8, -10, -10, -12]);
  assert.equal(out[0].phase, 'idle', 'axis not decided yet');
  assert.equal(out.at(-1)!.phase, 'tracking');
  assert.equal(out.at(-1)!.offset, 40, 'only the movement after the axis was decided… plus that event');
  assert.ok(swipe.swiping(1000 + 4 * 16 + 50));
  const end = swipe.end();
  assert.equal(end.phase, 'release');
  assert.equal(end.offset, 40);
  assert.ok(end.speed > 0);
  assert.equal(swipe.end().phase, 'idle', 'once');
});

test('space swipe: the fingers lifting (momentum) releases at once; the momentum is ignored', () => {
  const swipe = createSpaceSwipe();
  // A flick, then macOS-like momentum (each frame ~92% of the last).
  const momentum = Array.from({ length: 20 }, (_, i) => 20 * 0.92 ** (i + 1));
  const out = feed(swipe, [8, 14, 20, 20, ...momentum]);
  const at = out.findIndex((r) => r.phase === 'release');
  assert.ok(at > 0, 'released during the decay');
  assert.ok(out[at].offset < 0, 'fingers moved left: the next space');
  assert.ok(out.slice(at + 1).every((r) => r.phase === 'idle'));
  assert.ok(swipe.swiping(1000 + out.length * 16), 'its momentum is still kept from scrolling');
  assert.equal(swipe.end().phase, 'idle', 'already released');
});

test('space swipe: vertical scrolling, mouse wheels, pinches and unusable places never swipe', () => {
  const vertical = createSpaceSwipe();
  assert.ok(feed(vertical, [1, 1, 1, 1], { deltaY: 10 }).every((r) => r.phase === 'idle'));
  assert.ok(feed(vertical, [20, 20], { start: 1070 }).every((r) => r.phase === 'idle'), 'the same gesture turning sideways');
  assert.equal(vertical.end().phase, 'idle');
  const wheel = createSpaceSwipe();
  assert.ok([wheel.wheel({ deltaX: 40, deltaMode: 1, time: 0 })].every((r) => r.phase === 'idle'), 'line deltas');
  const pinch = createSpaceSwipe();
  assert.equal(pinch.wheel({ deltaX: 20, ctrlKey: true, time: 0 }).phase, 'idle');
  const notHere = createSpaceSwipe();
  assert.ok(feed(notHere, [-10, -10, -10], { usable: false }).every((r) => r.phase === 'idle'));
  assert.ok(!notHere.swiping(1050));
});

test('space swipe: a pause longer than the gap starts a new gesture', () => {
  const swipe = createSpaceSwipe();
  feed(swipe, [-10, -10, -10]);
  const next = feed(swipe, [10, 10], { start: 2000 });
  assert.equal(next.at(-1)!.offset, -20, 'counted from zero again');
});

test('settle: far enough or flicked switches; short, reversed or at the end goes back', () => {
  const width = 260;
  assert.equal(settle({ offset: 100, speed: 0, width, has: both }), -1, 'right past 30%: the previous space');
  assert.equal(settle({ offset: -100, speed: 0, width, has: both }), 1);
  assert.equal(settle({ offset: -50, speed: 0, width, has: both }), 0, 'short and slow');
  assert.equal(settle({ offset: -50, speed: -1, width, has: both }), 1, 'short but flicked');
  assert.equal(settle({ offset: -20, speed: -2, width, has: both }), 0, 'too short even for a flick');
  assert.equal(settle({ offset: -150, speed: 1, width, has: both }), 0, 'flicked back at the end');
  assert.equal(settle({ offset: -150, speed: 0, width, has: (d) => d === -1 }), 0, 'no next space');
  assert.equal(settle({ offset: 0, speed: 0, width, has: both }), 0);
});

test('rubberBand: resists more the further it goes, never past the limit', () => {
  assert.equal(rubberBand(0, 50), 0);
  assert.ok(rubberBand(20, 50) < 20 && rubberBand(20, 50) > 0);
  assert.ok(rubberBand(-500, 50) > -50);
  assert.ok(rubberBand(200, 50) - rubberBand(100, 50) < rubberBand(100, 50) - rubberBand(0, 50));
});

test('space swipe: the momentum after a release, however long, never starts another swipe', () => {
  const swipe = createSpaceSwipe();
  const momentum = Array.from({ length: 80 }, (_, i) => 40 * 0.96 ** (i + 1)); // ~1.3s of it
  const out = feed(swipe, [6, 14, 22, 28, 30, 40, ...momentum]);
  assert.equal(out.filter((r) => r.phase === 'release').length, 1);
  assert.ok(out.every((r) => r.phase !== 'tracking' || out.indexOf(r) < out.findIndex((x) => x.phase === 'release')));
});

test('space swipe: a drag never let go (a new gesture starts) is released first', () => {
  const swipe = createSpaceSwipe();
  feed(swipe, [-10, -10, -10, -10]);
  const next = swipe.wheel({ deltaY: 30, time: 1000 + 4 * 16 + 150 });
  assert.equal(next.phase, 'release');
  assert.equal(next.offset, 40);
});

test('space swipe: mouse wheels (recognised, Shift, a notch or two) never switch', () => {
  const recognised = createSpaceSwipe();
  assert.equal(recognised.wheel({ deltaX: 40, mouse: true, time: 0 }).phase, 'idle');
  const shift = createSpaceSwipe();
  assert.equal(shift.wheel({ deltaX: 30, shiftKey: true, time: 0 }).phase, 'idle');
  assert.equal(shift.wheel({ deltaX: 30, time: 16 }).phase, 'idle', 'the rest of that gesture too');
  const notch = createSpaceSwipe();
  notch.wheel({ deltaX: 100, time: 0 });
  const release = notch.end();
  assert.equal(release.phase, 'release');
  assert.equal(settle({ ...release, width: 260, has: both }), 0, 'one 100px notch');
  const two = createSpaceSwipe();
  two.wheel({ deltaX: 40, time: 0 });
  two.wheel({ deltaX: 40, time: 60 });
  assert.equal(settle({ ...two.end(), width: 260, has: both }), 0, 'two 40px notches');
});

test('space swipe: where it can\'t apply is checked until the axis is decided', () => {
  const swipe = createSpaceSwipe();
  swipe.wheel({ deltaX: 0, deltaY: 2, time: 0, usable: true }); // nothing yet
  const out = feed(swipe, [10, 10, 10], { start: 16, usable: false }); // then over the spaces bar
  assert.ok(out.every((r) => r.phase === 'idle'));
});

test('space swipe: after a release, fingers down again (growing, turning back or vertical) start a new gesture at once', () => {
  const momentum = Array.from({ length: 6 }, (_, i) => 20 * 0.92 ** (i + 1));
  const flick = (swipe: Swipe) => feed(swipe, [8, 14, 20, 20, ...momentum]);
  const regrow = createSpaceSwipe();
  const out = flick(regrow);
  assert.ok(out.some((r) => r.phase === 'release'));
  const t = 1000 + out.length * 16;
  const again = [4, 10, 20, 30].map((dx, i) => regrow.wheel({ deltaX: dx, time: t + i * 16 }));
  assert.equal(again.at(-1)!.phase, 'tracking', 'a second flick right after');
  const vertical = createSpaceSwipe();
  const out2 = flick(vertical);
  const t2 = 1000 + out2.length * 16;
  vertical.wheel({ deltaY: 12, time: t2 });
  assert.ok(!vertical.swiping(t2 + 1), 'a scroll right after isn\'t held');
  const back = createSpaceSwipe();
  const out3 = flick(back);
  const r = back.wheel({ deltaX: -8, time: 1000 + out3.length * 16 });
  assert.notEqual(r.phase, 'release');
  assert.equal(back.wheel({ deltaX: -8, time: 1000 + out3.length * 16 + 16 }).phase, 'tracking', 'turning back');
});

test('space swipe: the WebKit scenario\'s flick is released by its momentum, before the fingers\' gap', () => {
  const swipe = createSpaceSwipe();
  const out = feed(swipe, [6, 14, 22, 19, 17, 15, 13, 11.5, 10, 9, 8, 7, 6, 5.2, 4.5, 3.9, 3.4]);
  assert.ok(out.some((r) => r.phase === 'release'));
});

test('space swipe: an oversized step is reported as not counted (the sidebar starts the drag after it)', () => {
  const swipe = createSpaceSwipe();
  const first = swipe.wheel({ deltaX: -150, time: 0 });
  assert.equal(first.phase, 'tracking');
  assert.equal(first.counted, false);
  assert.equal(first.offset, 0);
  const next = swipe.wheel({ deltaX: -20, time: 16 });
  assert.equal(next.counted, true);
  assert.equal(next.offset, 20);
});

// ---- Arc's own feel (from Arc 1.174.0's ARCUI.PageSwipeController, 2026-11-20) ----

test('arc: its numbers, as read from Arc: half the distance, 100 ms of speed, 5 px/s, rubber band 0.15 over 255, spring 0.4 s critically damped', () => {
  assert.deepEqual([ARC.SCALE, ARC.VELOCITY_MS, ARC.COMMIT_SPEED, ARC.RUBBER_COEFFICIENT, ARC.RUBBER_DIMENSION, ARC.RESPONSE, ARC.DAMPING], [0.5, 100, 5, 0.15, 255, 0.4, 1]);
});

test('arc settle: moving at the lift, its direction decides (toward the neighbour it\'s over, or back); slower than 5 px/s, the nearest; one space, only toward one there is', () => {
  const w = 260;
  const go = (offset: number, velocity: number, has: (dir: -1 | 1) => boolean = both) => settleArc({ offset, velocity, width: w, has });
  // offset < 0: dragged toward the next space (1); velocity signed like the offset.
  assert.equal(go(-20, -6), 1, 'a short drag still moving toward the next: the next');
  assert.equal(go(-200, 6), 0, 'far toward the next but moving back at the lift: back');
  assert.equal(go(40, 30), -1, 'toward the previous, moving that way: the previous');
  assert.equal(go(40, -30), 0, 'toward the previous, moving back: back');
  assert.equal(go(-140, -4), 1, 'barely moving: the nearest, past half the width: the next');
  assert.equal(go(-120, 4.9), 0, 'barely moving, short of half: back');
  assert.equal(go(-20, -6, (d: -1 | 1) => d === -1), 0, 'no next space: back');
  assert.equal(settleArc({ offset: -200, velocity: -100, width: w, has: both, cancelled: true }), 0, 'cancelled by the trackpad: back');
  assert.equal(settleArc({ offset: -200, velocity: -100, width: w, has: both, events: 2 }), 0, 'a notch or two never switches');
});

test('arc rubber band: Motion\'s, coefficient 0.15 over 255 pt: small at first, never 255', () => {
  assert.equal(rubberBandArc(0), 0);
  assert.ok(Math.abs(rubberBandArc(100) - 255 * (1 - 1 / (100 * 0.15 / 255 + 1))) < 1e-9);
  assert.ok(Math.abs(rubberBandArc(-100) + rubberBandArc(100)) < 1e-9, 'both ways alike');
  assert.ok(rubberBandArc(100) < 15 && rubberBandArc(10000) < 255 && rubberBandArc(10000) > rubberBandArc(1000));
});

test('arc spring: critically damped from where it\'s drawn: at rest at the target, no overshoot from rest, the lift\'s speed carried', () => {
  const still = springArc(-120, 0, -260);
  assert.equal(still.at(0).x, -120);
  assert.ok(Math.abs(still.at(still.duration).x + 260) < ARC.REST_PX, 'at rest at the target');
  const xs = Array.from({ length: 200 }, (_, i) => still.at(i / 240).x);
  assert.ok(xs.every((x, i) => i === 0 || x <= xs[i - 1] + 1e-9) && xs.every((x) => x >= -260 - 1e-9), 'from rest: straight there, never past it');
  assert.ok(still.duration > 0.3 && still.duration < 0.8, `about half a second for 140 px (${still.duration})`);
  const fast = springArc(-120, -2000, -260);
  assert.ok(Math.abs(fast.at(0).v + 2000) < 1e-6, 'starts at the lift\'s speed');
  assert.ok(fast.at(1 / 60).x < still.at(1 / 60).x, 'a flick carries it on faster at first');
  assert.ok(springArc(0, 0, 0).duration === 0, 'nothing to do: at rest at once');
});

test('arc tracking: the speed over the last 100 ms, from the lift; none once the fingers rested', () => {
  const swipe = createSpaceSwipe();
  feed(swipe, [-10, -10, -10, -10, -10, -10, -10, -10]); // 16 ms apart from 1000: 10 px a step, right to left
  const last = 1000 + 7 * 16;
  assert.ok(Math.abs(swipe.velocity(last, 100) - 10 / 16) < 1e-9, 'offset px per ms over the window');
  assert.equal(swipe.velocity(last + 300, 100), 0, 'lifted 300 ms after the last move: no speed');
  const lift = swipe.lift(last + 5);
  assert.equal(lift.phase, 'release');
  assert.equal((lift as { time?: number }).time, last + 5);
  assert.equal(swipe.lift(last + 6).phase, 'idle', 'once');
  assert.ok(swipe.isSwipe(), 'the gesture let go is still the swipe (its momentum)');
});

test('arc tracking, the trackpad\'s phases known: fingers resting mid-swipe keep the gesture; a touch starts a new one; never let go by momentum', () => {
  const swipe = createSpaceSwipe();
  const step = (dx: number, time: number, fresh?: boolean) => swipe.wheel({ deltaX: dx, time, fresh, decay: false });
  step(-10, 1000, true);
  for (let i = 1; i < 6; i++) step(-10, 1000 + i * 16, false);
  const rested = step(-10, 1000 + 6 * 16 + 400, false); // 400 ms still, fingers down
  assert.equal(rested.phase, 'tracking', 'the same gesture after a rest');
  assert.ok(rested.offset > 40, 'its offset carried on');
  const decaying = Array.from({ length: 10 }, (_, i) => step(-20 * 0.9 ** i, 1500 + i * 16, false));
  assert.ok(decaying.every((r) => r.phase === 'tracking'), 'a steady decay with the fingers down is still the fingers');
  const fresh = step(-10, 1700, true);
  assert.equal(fresh.phase, 'release', 'a touch while one was tracked: that one let go first');
});

test('arc tracking without phases: momentum told by its decay gives back what it added, and the lift\'s time', () => {
  const swipe = createSpaceSwipe();
  const momentum = Array.from({ length: 12 }, (_, i) => -20 * 0.92 ** (i + 1));
  const out = feed(swipe, [-8, -14, -20, -20, ...momentum]);
  const r = out.find((x) => x.phase === 'release') as any;
  assert.ok(r, 'released by the decay');
  assert.ok(Math.sign(r.overrun) === Math.sign(r.offset) && Math.abs(r.overrun) < Math.abs(r.offset), `the run's own offset, the same way (${r.overrun} of ${r.offset})`);
  assert.ok(r.lifted < r.time, 'the lift: the run\'s first event, before its last');
});

// ---- Dia's (1.58.0, the same controller, 2026-11-20): its haptic on, its settle 0.25 s as 240 Hz keyframes ----

test('feels: Arc\'s 0.4 s and no haptic (it never turns it on); Dia\'s 0.25 s and the detent tick', () => {
  assert.deepEqual(FEELS.arc, { response: 0.4, haptics: false });
  assert.deepEqual(FEELS.dia, { response: 0.25, haptics: true });
  assert.ok(springArc(-120, 0, -260, FEELS.dia.response).duration < springArc(-120, 0, -260, FEELS.arc.response).duration, 'Dia\'s settles sooner');
});

test('keyframes: the spring every 1/240 s as progress from where it\'s drawn (0) to where it goes (1); nothing to move, none', () => {
  const spring = springArc(-120, 0, -260, 0.25);
  const k = springKeyframes(spring, -120, -260)!;
  assert.equal(k.length, Math.round(spring.duration * 240) + 1, 'one per 1/240 s, both ends');
  assert.deepEqual([k[0], k.at(-1)], [0, 1]);
  assert.ok(k.every((p, i) => i === 0 || p >= k[i - 1]), 'from rest: always onward');
  assert.ok(Math.abs(k[24] - (spring.at(0.1).x + 120) / -140) < 1e-4, 'the spring\'s own position at 0.1 s');
  const flick = springKeyframes(springArc(-120, -3000, -260, 0.25), -120, -260)!;
  assert.ok(flick[6] > k[6], 'a flick: further at first');
  assert.equal(springKeyframes(springArc(0, 0, 0), 0, 0), null);
});
