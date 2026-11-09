// The copy remembering the windows Margin.app parked, across a Safari quit (background/parked-restore.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createParkedRestore } from '../extension/background/parked-restore.ts';

// A copy of storage.local that outlives one "Safari" (one restore instance) and is read by the next.
function storage() {
  const data = {};
  return {
    data,
    local: {
      async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; },
      async set(o) { Object.assign(data, structuredClone(o)); },
    },
  };
}
const tabs = (list) => ({ tabs: Object.fromEntries(list.map(([id, windowId, mid]) => [id, { id, windowId, mid }])) });
const tick = () => new Promise((r) => setTimeout(r, 0));

test('a parked window is remembered, known again after Safari restores it, and told once', async () => {
  const store = storage();
  let t = 1000;
  // Before the quit: window 10 parked (tabs a, b), window 11 in use.
  let state = tabs([[1, 10, 'a'], [2, 10, 'b'], [3, 11, 'c']]);
  const before = createParkedRestore({ api: { storage: store }, state: () => state, liveWindows: async () => [10, 11], onFound: () => {}, now: () => t });
  await tick();
  before.parked(10, true);
  await tick(); await tick();
  assert.deepEqual(store.data.parkedWindows?.['10']?.mids, ['a', 'b'], 'saved with its tabs\' Margin ids');
  before.parked(10, false, true); // a link going: not the app's word
  await tick();
  assert.ok(store.data.parkedWindows?.['10'], 'kept through a link going');

  // Safari quits and opens again: new ids; window 50 has a and b, window 51 has c.
  state = tabs([[100, 50, 'a'], [101, 50, 'b'], [102, 51, 'c']]);
  let found = 0;
  const after = createParkedRestore({ api: { storage: store }, state: () => state, liveWindows: async () => [50, 51], onFound: () => { found++; }, now: () => t });
  after.start();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(after.wasParked(50), true, 'the restored parked window known');
  assert.equal(after.wasParked(51), false, 'the window in use not');
  assert.equal(found, 1, 'told once');
  assert.equal(store.data.parkedWindows?.['10'], undefined, 'its record used up');
  after.gone(50);
  assert.equal(after.wasParked(50), false, 'closed: no longer told');
});

test('the app un-parking a window drops its record; a minute after start, records of windows gone are dropped', async () => {
  const store = storage();
  let t = 0;
  const state = tabs([[1, 10, 'a'], [2, 12, 'z']]);
  const r = createParkedRestore({ api: { storage: store }, state: () => state, liveWindows: async () => [10, 12], onFound: () => {}, now: () => t });
  await tick();
  r.parked(10, true);
  r.parked(12, true);
  await tick(); await tick();
  r.parked(10, false);
  await tick(); await tick();
  assert.deepEqual(Object.keys(store.data.parkedWindows), ['12'], 'shown again by the app: forgotten');

  // A later start with window 12 gone and nothing matching: after a minute its record goes.
  const later = createParkedRestore({ api: { storage: store }, state: () => tabs([[5, 60, 'q']]), liveWindows: async () => [60], onFound: () => {}, now: () => t });
  later.start();
  for (let i = 0; i < 5; i++) await tick();
  assert.ok(store.data.parkedWindows['12'], 'kept while still looking');
  t += 61_000;
  await later.parked(60, false); // (nothing: no record)
  // The interval's next look (called here directly through start's timer is slow: wait for one).
  await new Promise((resolve) => setTimeout(resolve, 1100));
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(store.data.parkedWindows['12'], undefined, 'dropped once the first minute is over');
  assert.equal(later.wasParked(60), false, 'never taken for one');
});
