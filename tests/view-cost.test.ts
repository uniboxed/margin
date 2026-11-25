// The sidebar's build (shared/view.ts sidebar) parses each address once, not once per favorite or pin it's matched
// against (2026-11-21 review: 12 favorites on the 200-tab fixture took buildViewModel from 2.58 to 3.27 ms), and a
// split's panes named by Margin tab id are found without a search of every tab each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildViewModel } from '../app/shared/ui/view-model.ts';
import { bigState, WINDOW } from './theme/view-model.ts';

function counted<T>(run: () => T): { value: T, parses: number } {
  const Real = globalThis.URL;
  let parses = 0;
  // (Every `new URL` the build makes, counted.)
  globalThis.URL = new Proxy(Real, { construct(target, args) { parses++; return Reflect.construct(target, args); } });
  try { return { value: run(), parses }; } finally { globalThis.URL = Real; }
}

// The state with its addresses made new (no build has seen them: the cache of earlier builds can't hide the count),
// and `favorites` favorites.
function unseen(favorites: number) {
  const state: any = bigState();
  const tag = `cost-${Math.random().toString(36).slice(2)}`;
  const mark = (url: string) => `${url}${url.includes('?') ? '&' : '?'}${tag}`;
  state.tabs = Object.fromEntries(Object.entries(state.tabs).map(([id, t]: [string, any]) => [id, { ...t, url: mark(t.url) }]));
  state.pins = state.pins.map((p: any) => ({ ...p, url: mark(p.url) }));
  state.favorites = Array.from({ length: favorites }, (_, i) => ({ id: `fv${i}`, url: mark(`https://fav${i}.example/`), title: `F${i}`, scope: 'global', pos: i }));
  return state;
}
const build = (state: any) => buildViewModel({ state, ui: { windowId: WINDOW }, platform: { browser: 'safari', os: 'mac' } });

test('12 favorites on 200 tabs cost a few parses each, not one per tab', () => {
  const without = counted(() => build(unseen(0))).parses;
  const { value: vm, parses } = counted(() => build(unseen(12)));
  assert.equal(vm.favorites.items.length, 12);
  // (Each favorite's own address, icon and face: a handful. Matched against every tab: 200 each.)
  assert.ok(parses - without <= 12 * 6, `${parses - without} more parses with 12 favorites (${without} without)`);
  // Built again: its addresses known, fewer parses.
  const state = unseen(12);
  const first = counted(() => build(state)).parses;
  const again = counted(() => build(state)).parses;
  assert.ok(again < first, `${again} parses built again, ${first} the first time`);
});

test('a split\'s panes named by Margin tab id: found in one index (not a search of every tab each), the first tab with the id', () => {
  const reads = (split: boolean) => {
    const state: any = bigState();
    const ids = Object.keys(state.tabs).filter((id) => state.tabSpace[id] === 'personal').slice(0, 3);
    state.tabs = { ...state.tabs, [ids[0]]: { ...state.tabs[ids[0]], mid: 'm-a' }, [ids[1]]: { ...state.tabs[ids[1]], mid: 'm-b' }, [ids[2]]: { ...state.tabs[ids[2]], mid: 'm-c' } };
    if (split) state.splits = [{ id: 's1', spaceId: 'personal', axis: 'horizontal', panes: ['m-a', 'm-b', 'm-c'], ratios: [0.3, 0.3, 0.4] }];
    let n = 0;
    const tabs = state.tabs;
    // (Object.values over the tabs, counted.)
    const values = Object.values;
    Object.values = ((o: any) => { if (o === tabs) n++; return values(o); }) as typeof Object.values;
    let vm;
    try { vm = build(state); } finally { Object.values = values; }
    if (split) assert.deepEqual(vm.space.splits[0].panes.map((p) => p.tabId), ids.map(Number));
    return n;
  };
  const more = reads(true) - reads(false);
  assert.ok(more <= 1, `three panes read the tabs ${more} more times`);
});
