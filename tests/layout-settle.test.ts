// The settle that layout changes go through (background/settle.ts, used by
// background/registered.ts layoutsChanged), on a fake clock: a lone change
// is followed at once, a burst (a sidebar dragged) has its first followed at
// once at most and its last once it's over, and a burst always ends with a
// settle after its last change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settler } from '../extension/background/settle.ts';
import { fakeClock } from './fake-clock.ts';

const MS = 2000;
const make = () => {
  const clock = fakeClock();
  const ran: number[] = [];
  const s = settler(MS, () => ran.push(clock.now()), () => clock);
  return { clock, ran, s };
};

test('a lone change: lone (follow it now), and settled once, MS after it', () => {
  const { clock, ran, s } = make();
  assert.equal(s.change(), true);
  assert.equal(s.pending(), true);
  clock.tick(MS - 1);
  assert.deepEqual(ran, []);
  clock.tick(1);
  assert.deepEqual(ran, [1_000_000 + MS]);
  assert.equal(s.pending(), false);
  clock.tick(10 * MS);
  assert.equal(ran.length, 1, 'once');
});

test('a burst (a drag: a change every 16 ms for 1 s): only its first lone, settled once, MS after its last, never during it', () => {
  const { clock, ran, s } = make();
  const lone = [];
  for (let i = 0; i < 63; i++) {
    lone.push(s.change());
    clock.tick(16);
  }
  assert.deepEqual(lone, [true, ...Array(62).fill(false)]);
  assert.deepEqual(ran, [], 'nothing settled during the burst');
  assert.equal(clock.pending(), 1, 'one wait, not one per change');
  const last = clock.now() - 16;
  clock.tick(MS);
  assert.deepEqual(ran, [last + MS], 'settled MS after the last change');
});

test('lone means none in the MS before it, not since the last lone one: changes MS - 1 apart are one burst however long it goes', () => {
  const { clock, ran, s } = make();
  const lone = [];
  for (let i = 0; i < 5; i++) {
    lone.push(s.change());
    clock.tick(MS - 1);
  }
  assert.deepEqual(lone, [true, false, false, false, false]);
  assert.deepEqual(ran, []);
  clock.tick(1);
  assert.equal(ran.length, 1);
});

test('MS with no change: the next one is lone again', () => {
  const { clock, ran, s } = make();
  assert.equal(s.change(), true);
  clock.tick(MS);
  assert.equal(s.change(), true, 'exactly MS after: lone');
  clock.tick(MS - 1);
  assert.equal(s.change(), false, 'MS - 1 after: part of a burst');
  clock.tick(MS);
  assert.equal(ran.length, 2, 'the first, then the burst of the other two');
  clock.tick(5000);
  assert.equal(s.change(), true);
});

test('the clock is read at each change: a wait started on one clock is cleared on it when the next change comes on another', () => {
  const a = fakeClock();
  const b = fakeClock(5_000_000);
  let clock = a;
  const ran: number[] = [];
  const s = settler(MS, () => ran.push(clock.now()), () => clock);
  s.change();
  clock = b;
  assert.equal(s.change(), true, 'a long while later on the new clock');
  assert.equal(a.pending(), 0, 'the old clock\'s wait cleared');
  a.tick(MS);
  assert.deepEqual(ran, []);
  b.tick(MS);
  assert.deepEqual(ran, [5_000_000 + MS]);
});
