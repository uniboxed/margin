// The next/previous-tab pick Margin.app's overlay makes at the key press (shared/switching.ts pickNavTab), with the
// copy's own rule (shared/view.ts cycleTab): highlighted at once, then asked of the copy (overlay.ts navTab).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAV_CHAIN_MS, pickNavTab } from '../extension/shared/switching.ts';
import { cycleTab } from '../extension/shared/view.ts';
import * as M from '../extension/state/model.ts';

function state() {
  let s = M.defaultState();
  for (const [id, active] of [[1, true], [2, false], [3, false], [9, false]] as [number, boolean][]) s = M.upsertTab(s, { id, windowId: id === 9 ? 2 : 1, url: `https://t${id}.example/`, active, index: id }, 0);
  return s;
}

test('from the tab in front, the copy\'s order, wrapping both ways', () => {
  const s = state();
  assert.equal(pickNavTab(s, 1, null, 1, cycleTab, 1000), cycleTab(s, 1, 1, 1));
  assert.equal(pickNavTab(s, 1, null, -1, cycleTab, 1000), cycleTab(s, 1, 1, -1));
  const seen = new Set();
  for (let at = 1, i = 0; i < 4; i++) seen.add(at = (pickNavTab(s, 1, null, 1, (st, w, t, d) => cycleTab(st, w, at, d), 1000) as number));
  assert.ok(seen.has(9), 'the list is the space\'s: window 2\'s tab is in it, brought here when chosen (docs/BROWSER-WINDOWS.md §9)');
});

test('fast presses go on from the last one\'s target, for as long as the chain lasts', () => {
  const s = state();
  const first = (pickNavTab(s, 1, null, 1, cycleTab, 1000) as number);
  const second = pickNavTab(s, 1, { tabId: first, at: 1000 }, 1, cycleTab, 1000 + NAV_CHAIN_MS - 1);
  assert.equal(second, cycleTab(s, 1, first, 1), 'from the last target, not the tab in front (Safari not there yet)');
  assert.equal(pickNavTab(s, 1, { tabId: first, at: 1000 }, 1, cycleTab, 1000 + NAV_CHAIN_MS + 1), first, 'the chain over: from the tab in front again');
  assert.equal(pickNavTab(s, 1, { tabId: 77, at: 1000 }, 1, cycleTab, 1001), first, 'a target since closed: from the tab in front');
});

test('nothing known yet: undefined (the copy works it out); nowhere to go: null', () => {
  assert.equal(pickNavTab(null, 1, null, 1, cycleTab), undefined);
  assert.equal(pickNavTab({ tabs: {} }, 1, null, 1, cycleTab), undefined);
  let one = M.defaultState();
  one = M.upsertTab(one, { id: 1, windowId: 1, url: 'https://only.example/', active: true, index: 0 }, 0);
  assert.equal(pickNavTab(one, 1, null, 1, cycleTab), null);
});
