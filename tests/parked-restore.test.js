// Parked windows restored by Safari after a relaunch, known by their tabs' Margin ids (shared/parked-restore.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { midsOf, restoredParked } from '../extension/shared/parked-restore.js';

const state = (tabs) => ({ tabs: Object.fromEntries(tabs.map(([id, windowId, mid]) => [id, { id, windowId, mid }])) });

test('a parked window recorded by its tabs\' Margin ids', () => {
  const s = state([[1, 10, 'b'], [2, 10, 'a'], [3, 11, 'c'], [4, 10, undefined]]);
  assert.deepEqual(midsOf(s, 10), ['a', 'b'], 'its tabs with a Margin id, sorted');
  assert.deepEqual(midsOf(s, 12), [], 'none');
  assert.deepEqual(midsOf(null, 10), []);
});

test('after a relaunch: the restored window holding a parked window\'s tabs is known, and only it', () => {
  // Before: window 10 parked with a, b, c; window 11 the one in use. After: new ids 50 (a, b, c) and 51 (d).
  const records = { 10: { mids: ['a', 'b', 'c'] } };
  const after = state([[100, 50, 'a'], [101, 50, 'b'], [102, 50, 'c'], [103, 51, 'd']]);
  assert.deepEqual([...restoredParked(records, after, [50, 51])], [[50, 10]]);
});

test('not a parked window: one of its tabs isn\'t the record\'s, too few of them are back, or two windows could be it', () => {
  const records = { 10: { mids: ['a', 'b', 'c', 'd'] } };
  assert.equal(restoredParked(records, state([[1, 50, 'a'], [2, 50, 'x']]), [50]).size, 0, 'a tab of another window in it: the person\'s own');
  assert.equal(restoredParked(records, state([[1, 50, 'a']]), [50]).size, 0, 'one of four back: not enough to say');
  assert.deepEqual([...restoredParked(records, state([[1, 50, 'a'], [2, 50, 'b']]), [50])], [[50, 10]], 'half back: it');
  assert.equal(restoredParked(records, state([[1, 50, 'a'], [2, 50, 'b'], [3, 51, 'c'], [4, 51, 'd']]), [50, 51]).size, 0, 'two windows fit: neither is taken for it');
  assert.equal(restoredParked(records, state([]), [50]).size, 0, 'a window with no Margin tabs yet (not matched yet): nothing');
});

test('a record whose window is still open is left alone (still parked, or Margin updated without a relaunch)', () => {
  const records = { 10: { mids: ['a', 'b'] } };
  assert.equal(restoredParked(records, state([[1, 10, 'a'], [2, 10, 'b']]), [10]).size, 0);
});

test('two parked windows: each found, never the same window twice', () => {
  const records = { 10: { mids: ['a', 'b'] }, 12: { mids: ['c'] } };
  const found = restoredParked(records, state([[1, 50, 'a'], [2, 50, 'b'], [3, 52, 'c'], [4, 53, 'z']]), [50, 52, 53]);
  assert.deepEqual([...found].sort(), [[50, 10], [52, 12]]);
});
