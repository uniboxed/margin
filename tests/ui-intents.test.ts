// What a click draws before the state comes back (app/shared/ui/intents.ts): a row closed, a pin with no tab opened;
// each predicted, then confirmed by the state, corrected (its request failed, or the state says otherwise), or timed
// out; a second click while one is pending. With what the view model makes of them (shared/view.ts sidebar `pinning`,
// ui/view-model.ts `front`), which rows slide (ui/row-motion.ts rowsChanged) and app icons (Face.isApp).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntents, nextFront, OPEN_MS, CLOSE_MS, ANSWER_GRACE_MS } from '../app/shared/ui/intents.ts';
import { buildViewModel } from '../app/shared/ui/view-model.ts';
import type { UiState, ViewModelInput } from '../app/shared/ui/view-model.ts';
import { rowsChanged } from '../app/shared/ui/row-motion.ts';

const W = 1;
// Three open tabs (1 in front), a Margin tab not open, a pin with no tab, all in one space of window 1.
function state(): any {
  return {
    spaces: [{ id: 's1', name: 'One', emoji: '', color: '' }, { id: 's2', name: 'Two', emoji: '', color: '' }],
    activeSpaceByWindow: { [W]: 's1' },
    tabs: {
      1: { id: 1, windowId: W, index: 0, url: 'https://a.test/', title: 'A', active: true, lastActive: 5 },
      2: { id: 2, windowId: W, index: 1, url: 'https://b.test/', title: 'B', active: false, lastActive: 9 },
      3: { id: 3, windowId: W, index: 2, url: 'https://c.test/', title: 'C', active: false, lastActive: 3 },
    },
    tabSpace: { 1: 's1', 2: 's1', 3: 's1' },
    keptTabs: { 't-k': { id: 't-k', url: 'https://k.test/', title: 'K', spaceId: 's1', order: 9, lastActive: 7, keptAt: 7, why: 'app' } },
    pins: [{ id: 'p1', spaceId: 's1', url: 'https://pin.test/', title: 'Pin', pos: 0 }],
    folders: [], archive: [], favicons: {}, settings: {},
  };
}
const without = (s: any, id: number) => { const tabs = { ...s.tabs }; delete tabs[id]; const tabSpace = { ...s.tabSpace }; delete tabSpace[id]; return { ...s, tabs, tabSpace }; };
const front = (s: any, id: number) => ({ ...s, tabs: Object.fromEntries(Object.entries(s.tabs).map(([k, t]: [string, any]) => [k, { ...t, active: t.id === id }])) });
const clock = () => { let t = 1000; return { now: () => t, add: (ms: number) => { t += ms; } }; };
const tick = () => new Promise((r) => setImmediate(r));
// A request settled by the test.
function request() { let resolve!: (v: unknown) => void; let reject!: (e: unknown) => void; const p = new Promise((res, rej) => { resolve = res; reject = rej; }); p.catch(() => {}); return { p, resolve, reject }; }

test('nothing pending: the same state back, nothing in front, no deadline (no work per update)', () => {
  const intents = createIntents();
  const s = state();
  const out = intents.apply(s, s);
  assert.equal(out.state, s);
  assert.equal(out.front, null);
  assert.equal(intents.nextDeadline(), null);
});

test('a close: predicted (the row out at once), then confirmed by the state (the overlay goes)', () => {
  const c = clock();
  const intents = createIntents({ now: c.now });
  const s = state();
  intents.close(3, s, W, null);
  const out = intents.apply(s, s);
  assert.equal(out.state.tabs[3], undefined, 'gone from the drawn state');
  assert.equal(out.state.tabSpace[3], undefined);
  assert.ok(s.tabs[3], 'the state itself untouched');
  assert.equal(out.front, null, 'not the row in front: nothing else changes');
  const real = without(s, 3);
  assert.equal(intents.apply(real, real).state, real, 'the state agrees: drawn as it is');
  assert.equal(intents.size, 0);
});

test('a close of a Margin tab not open, and of an item open in Margin.app (by its item id)', () => {
  const intents = createIntents();
  const s = state();
  intents.close('t-k', s, W, null);
  assert.equal(intents.apply(s, s).state.keptTabs['t-k'], undefined);
  const hosted = { ...s, keptTabs: {}, tabs: { ...s.tabs, 7: { id: 7, windowId: W, url: 'app://com.example.Notes', mid: 't-n', lastActive: 1 } }, tabSpace: { ...s.tabSpace, 7: 's1' } };
  const two = createIntents();
  two.close('t-n', hosted, W, null);
  assert.equal(two.apply(hosted, hosted).state.tabs[7], undefined, 'its open row (mid) out too');
});

test('a close of the row in front: the row in front next drawn at once (the space\'s most recent other row), until the state has one', () => {
  const intents = createIntents();
  const s = state();
  assert.equal(nextFront(s, 1, W), 2, 'tab 2: used last (9), before the Margin tab (7)');
  assert.equal(nextFront(s, 3, W), null, 'not in front: none');
  intents.close(1, s, W, null);
  assert.deepEqual(intents.apply(s, s).front, { tab: 2, pin: null });
  // The state lost the row but has nothing in front yet (Margin.app's queue busy): still drawn.
  const gone = without(s, 1);
  assert.deepEqual(intents.apply(gone, gone).front, { tab: 2, pin: null });
  // The state's own front (another than predicted): it's the state's from now on.
  const real = front(gone, 3);
  assert.equal(intents.apply(real, real).front, null);
  assert.equal(intents.size, 0);
  // The view model draws the predicted one in front.
  const two = createIntents();
  two.close(1, s, W, null);
  const p = two.apply(s, s);
  const vm = buildViewModel({ state: p.state as ViewModelInput['state'], ui: { windowId: W, front: p.front } });
  assert.deepEqual(vm.space.today.filter((t) => t.active).map((t) => t.id), [2]);
});

test('a close corrected: its request failed, or answered and the state still has the row a while later', async () => {
  const c = clock();
  let changes = 0;
  const intents = createIntents({ now: c.now, onChange: () => changes++ });
  const s = state();
  const r1 = request();
  intents.close(3, s, W, r1.p);
  r1.reject(new Error('no link'));
  await tick();
  assert.equal(intents.size, 0, 'failed: gone at once');
  assert.equal(changes, 1, 'drawn again');
  assert.ok(intents.apply(s, s).state.tabs[3], 'the row back');
  const r2 = request();
  intents.close(3, s, W, r2.p);
  r2.resolve(null);
  await tick();
  assert.equal(intents.apply(s, s).state.tabs[3], undefined, 'answered: the state has a moment to agree');
  c.add(ANSWER_GRACE_MS + 1);
  assert.ok(intents.apply(s, s).state.tabs[3], 'it didn\'t: back to the state');
  assert.equal(intents.size, 0);
});

test('a close timed out: back to the state after CLOSE_MS', () => {
  const c = clock();
  const intents = createIntents({ now: c.now });
  const s = state();
  intents.close(2, s, W, null);
  assert.equal(intents.nextDeadline(), 1000 + CLOSE_MS + 1);
  c.add(CLOSE_MS - 1);
  assert.equal(intents.apply(s, s).state.tabs[2], undefined);
  c.add(2);
  assert.ok(intents.apply(s, s).state.tabs[2]);
  assert.equal(intents.size, 0);
});

test('a pin with no tab opened: in front at once, alone; confirmed once the state has its page in front', () => {
  const intents = createIntents();
  const s = state();
  intents.open(s.pins[0], W, null);
  const p = intents.apply(s, s);
  assert.deepEqual(p.front, { tab: null, pin: 'p1' });
  const vm = buildViewModel({ state: p.state as ViewModelInput['state'], ui: { windowId: W, front: p.front } });
  assert.deepEqual(vm.space.pins.filter((x) => x.active).map((x) => x.id), ['p1'], 'the pin lit');
  assert.deepEqual(vm.space.today.filter((t) => t.active).map((t) => t.id), [], 'the tab in front plain');
  assert.equal(vm.space.newTab.active, false);
  // Its tab opened and in front: confirmed (the pin is lit by the state now).
  const real = { ...front(s, 0), tabs: { ...front(s, 0).tabs, 8: { id: 8, windowId: W, url: 'https://pin.test/', title: 'Pin', active: true, lastActive: 99 } }, tabSpace: { ...s.tabSpace, 8: 's1' } };
  assert.equal(intents.apply(real, real).front, null);
  assert.equal(intents.size, 0);
  const vm2 = buildViewModel({ state: real as ViewModelInput['state'], ui: { windowId: W } });
  assert.deepEqual(vm2.space.pins.filter((x) => x.active).map((x) => x.id), ['p1']);
});

test('a pin\'s open corrected (its request answers nothing: it failed) or timed out', async () => {
  const c = clock();
  const intents = createIntents({ now: c.now });
  const s = state();
  const r = request();
  intents.open(s.pins[0], W, r.p);
  r.resolve(undefined);
  await tick();
  assert.equal(intents.apply(s, s).front, null, 'failed: the state\'s front again');
  intents.open(s.pins[0], W, null);
  c.add(OPEN_MS - 1);
  assert.ok(intents.apply(s, s).front, 'still waiting (a hosted app\'s show takes seconds)');
  c.add(2);
  assert.equal(intents.apply(s, s).front, null, 'timed out');
  // Answered, but the state hasn't shown it yet: kept (the hosting's show can take longer than its answer).
  const r2 = request();
  intents.open(s.pins[0], W, r2.p);
  r2.resolve({ pin: 'p1', item: null });
  await tick();
  c.add(ANSWER_GRACE_MS * 3);
  assert.ok(intents.apply(s, s).front);
  // The pin unpinned meanwhile: nothing to draw.
  const unpinned = { ...s, pins: [] };
  assert.equal(intents.apply(unpinned, unpinned).front, null);
});

test('a second click while one is pending: the newest wins', () => {
  const intents = createIntents();
  const s = { ...state(), pins: [...state().pins, { id: 'p2', spaceId: 's1', url: 'https://pin2.test/', title: 'Pin 2', pos: 1 }] };
  intents.open(s.pins[0], W, null);
  intents.open(s.pins[1], W, null);
  assert.deepEqual(intents.apply(s, s).front, { tab: null, pin: 'p2' }, 'another pin: that one');
  // A switch to a tab asked for since (ui/runtime.ts: the switch's highlight): the pin's open goes.
  assert.equal(intents.dropOpens(), true);
  assert.equal(intents.apply(s, s).front, null);
  assert.equal(intents.dropOpens(), false);
  // A close after a pin's open: the newest's front (the close's next) wins while both wait.
  intents.open(s.pins[0], W, null);
  intents.close(1, s, W, null);
  assert.deepEqual(intents.apply(s, s).front, { tab: 2, pin: null });
  // A switch under way comes first in the view model.
  const p = intents.apply(s, s);
  const ui: UiState = { windowId: W, front: p.front, switchingTo: 3 };
  const vm = buildViewModel({ state: p.state as ViewModelInput['state'], ui });
  assert.deepEqual(vm.space.today.filter((t) => t.active).map((t) => t.id), [3]);
  // The same row closed twice: one intent.
  const two = createIntents();
  two.close(3, s, W, null);
  two.close(3, s, W, null);
  assert.equal(two.size, 1);
});

test('rows that slide: rows added or removed in the same space; not the first drawing, a space switched, the same rows, a reorder', () => {
  const s = state();
  const build = (st: any, prev: any = null) => buildViewModel({ state: st, ui: { windowId: W } }, prev);
  const a = build(s);
  assert.equal(rowsChanged(null, a), false, 'first drawing');
  assert.equal(rowsChanged(a, build(s, a)), false, 'the same model');
  const closed = build(without(s, 3), a);
  assert.equal(rowsChanged(a, closed), true, 'a row gone');
  assert.equal(rowsChanged(closed, build(s, closed)), true, 'a row come');
  const reordered = build({ ...s, tabs: { ...s.tabs, 1: { ...s.tabs[1], index: 5 } } }, a);
  assert.notEqual(reordered.space.today, a.space.today);
  assert.equal(rowsChanged(a, reordered), false, 'the same rows in another order');
  const other = build({ ...s, activeSpaceByWindow: { [W]: 's2' } }, a);
  assert.equal(rowsChanged(a, other), false, 'another space: drawn whole');
});

test('app icons: isApp only for an app item whose app\'s icon is shown', () => {
  const s = state();
  const icon = 'data:image/png;base64,iVBORw0KGgo=';
  const withApps = {
    ...s, apps: [{ bundleId: 'com.example.Notes', name: 'Notes', icon }, { bundleId: 'com.example.Bare', name: 'Bare', icon: null }, { bundleId: 'com.example.Pinned', name: 'Pinned', icon }],
    tabs: { ...s.tabs, 2: { ...s.tabs[2], url: 'app://com.example.Notes', title: 'Notes' }, 3: { ...s.tabs[3], url: 'app://com.example.Bare', title: 'Bare' } },
    pins: [{ id: 'p1', spaceId: 's1', url: 'app://com.example.Pinned', title: 'Pinned', pos: 0, target: { kind: 'app', bundleId: 'com.example.Pinned', name: 'Pinned' } }],
  };
  const vm = buildViewModel({ state: withApps as ViewModelInput['state'], ui: { windowId: W } });
  const row = (id: number) => vm.space.today.find((t) => t.id === id)!;
  assert.equal(row(2).isApp, true, 'an app with its icon');
  assert.equal(row(2).icon, icon);
  assert.equal(row(3).isApp, false, 'an app with no icon: its letter');
  assert.equal(row(1).isApp, false, 'a site');
  assert.equal(vm.space.pins[0].isApp, true, 'a pinned app');
});
