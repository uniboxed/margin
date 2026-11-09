// shared/space-swipe.ts: the sidebar's swipe between spaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpaceSwipe, settle, rubberBand } from '../extension/shared/space-swipe.ts';

// A run of wheel events, 16ms apart from `start`.
function feed(swipe, deltas, { start = 1000, usable = true, deltaY = 0 } = {}) {
  return deltas.map((dx, i) => swipe.wheel({ deltaX: dx, deltaY, time: start + i * 16, usable }));
}
const both = () => true;

test('space swipe: follows the fingers (right = positive), releases when they stop', () => {
  const swipe = createSpaceSwipe();
  const out = feed(swipe, [-4, -8, -10, -10, -12]);
  assert.equal(out[0].phase, 'idle', 'axis not decided yet');
  assert.equal(out.at(-1).phase, 'tracking');
  assert.equal(out.at(-1).offset, 40, 'only the movement after the axis was decided… plus that event');
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
  assert.equal(next.at(-1).offset, -20, 'counted from zero again');
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
  const flick = (swipe) => feed(swipe, [8, 14, 20, 20, ...momentum]);
  const regrow = createSpaceSwipe();
  const out = flick(regrow);
  assert.ok(out.some((r) => r.phase === 'release'));
  const t = 1000 + out.length * 16;
  const again = [4, 10, 20, 30].map((dx, i) => regrow.wheel({ deltaX: dx, time: t + i * 16 }));
  assert.equal(again.at(-1).phase, 'tracking', 'a second flick right after');
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
