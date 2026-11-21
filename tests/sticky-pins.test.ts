import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../extension/state/model.ts';
import * as V from '../extension/shared/view.ts';
import { buildViewModel } from '../extension/ui/view-model.ts';
import { menuItems } from '../extension/ui/behaviors/menu-items.ts';
import { checkAction, contextFromState, requestFor } from '../extension/ui/actions.ts';
import * as L from '../app/shared/library/library.ts';
import { createHostedTabs, type HostedTabsApi } from '../extension/background/hosted.ts';

function applyChanges(values: L.Values, changes: L.Change[]): L.Values {
  const next: L.Values = structuredClone(values);
  for (const c of changes) {
    next[c.collection] ??= {};
    if ('deleted' in c && c.deleted) delete next[c.collection][c.id];
    else next[c.collection][c.id] = (c as { value: any }).value;
  }
  return next;
}

test('M2.2 sticky pins: bound tab stays attached on sub-navigation, marks drifted, and never appears in Today', () => {
  let s = M.defaultState();
  s = M.setActiveSpace(s, 1, 'personal');
  s = M.addPin(s, { id: 'p-gh', spaceId: 'personal', url: 'https://github.com/org/repo', title: 'Repo' });
  s = M.upsertTab(s, { id: 10, windowId: 1, index: 0, active: true, url: 'https://github.com/org/repo', title: 'Repo' } as BrowserTab, 100);
  s = M.moveTab(s, 10, 'personal');
  s = M.bindTabToPin(s, 10, 'p-gh');

  // Navigate the sticky-pinned tab to a completely different path and even domain.
  s = M.upsertTab(s, { id: 10, windowId: 1, index: 0, active: true, url: 'https://github.com/org/repo/pull/42', title: 'PR #42' } as BrowserTab, 200);
  assert.equal(s.tabs[10].pinnedBy, 'p-gh', 'pinnedBy survives tab updates');

  const sb = V.sidebar(s, 1);
  assert.equal(sb.tabs.length, 0, 'drifted sticky pin tab does not leak into Today');
  assert.equal(sb.pins.length, 1);
  assert.equal(sb.pins[0].tabId, 10);
  assert.equal(sb.pins[0].drifted, true);
  assert.equal(sb.pins[0].rootUrl, 'https://github.com/org/repo');
  assert.equal(sb.pins[0].url, 'https://github.com/org/repo/pull/42');

  const vm = buildViewModel({ state: s, ui: { windowId: 1, tabId: 10 } });
  const pinRow = vm.space.pins[0];
  assert.equal(pinRow.drifted, true);
  assert.equal(pinRow.rootUrl, 'https://github.com/org/repo');

  // Menu shows Reset to Pinned URL only when drifted.
  const menu = menuItems({ kind: 'pin', id: 'p-gh' }, { state: s, space: vm.space });
  assert.equal(menu[0].label, 'Reset to Pinned URL');
  assert.equal(menu[0].action, 'pin.reset');
  assert.equal(checkAction('pin.reset', 'p-gh', contextFromState(s)).ok, true);
  assert.deepEqual(requestFor('pin.reset', 'p-gh', { state: s, ui: { windowId: 1 } }), { kind: 'send', type: 'resetPin', payload: { pinId: 'p-gh', windowId: 1 } });

  // Unpinning releases the bound tab back into Today.
  const unpinned = M.removePin(s, 'p-gh');
  assert.equal(unpinned.tabs[10].pinnedBy, undefined);
  assert.equal(V.sidebar(unpinned, 1).tabs.map((t) => t.id).includes(10), true);
});

test('M2.2 sticky pins: library closeTab unloads without archiving, openPin focuses drifted URL, resetPin navigates back to root', () => {
  let values: L.Values = { spaces: { a: { name: 'A', order: 0 } }, pins: {}, folders: {}, tabs: {}, archive: {}, windows: { '1': { spaceId: 'a' } }, imports: {} };
  const act = (action: string, payload: any, ids: string[] = ['1111', '2222', '3333']) => {
    const out = L.perform(values, action, payload, { now: 1000, ids });
    assert.equal(out.ok, true, `${action}: ${out.error}`);
    values = applyChanges(values, out.changes);
    return out;
  };

  const tabId = act('newTab', { windowId: 1, url: 'https://linear.app/inbox', title: 'Inbox' }, ['t001']).result.tabId;
  const pinId = act('pinTab', { tabId }, ['p001']).result;
  // The item pinned stays, the pin's tab (its page stays shown).
  const liveId = tabId;
  assert.equal(values.tabs[liveId].pinnedBy, pinId);

  // Navigate to subpage.
  act('updateItem', { tabId: liveId, url: 'https://linear.app/issue/ENG-99', title: 'ENG-99' });
  assert.equal(values.tabs[liveId].url, 'https://linear.app/issue/ENG-99');
  assert.equal(values.tabs[liveId].pinnedBy, pinId);

  // Clicking the pin focuses the live drifted item instead of opening a duplicate.
  const opened = act('openPin', { pinId, windowId: 1 });
  assert.equal(opened.requests[0].item, liveId);
  assert.equal(opened.requests[0].url, 'https://linear.app/issue/ENG-99');

  // Resetting the pin restores root URL and emits resetPin request.
  const reset = act('resetPin', { pinId, windowId: 1 });
  assert.equal(reset.requests[0].type, 'resetPin');
  assert.equal(reset.requests[0].url, 'https://linear.app/inbox');
  assert.equal(values.tabs[liveId].url, 'https://linear.app/inbox');

  // Closing a sticky pin's live tab forgets it WITHOUT archiving.
  act('closeTab', { tabId: liveId });
  assert.equal(values.tabs[liveId], undefined);
  assert.equal(Object.keys(values.archive).length, 0, 'closing a sticky pin must not archive it');
  assert.ok(values.pins[pinId], 'pin remains intact');
});

test('M2.2 inline rename: customTitle overrides page title on tabs and pins, clearing resets to original title', () => {
  let s = M.defaultState();
  s = M.setActiveSpace(s, 1, 'personal');
  s = M.addPin(s, { id: 'p1', spaceId: 'personal', url: 'https://docs.example/', title: 'Original Pin' });
  s = M.upsertTab(s, { id: 5, windowId: 1, index: 0, active: true, url: 'https://app.example/', title: 'Original Tab' } as BrowserTab, 100);
  s = M.moveTab(s, 5, 'personal');

  s = M.renamePin(s, 'p1', 'My Docs');
  s = M.renameTab(s, 5, 'Daily Standup');
  assert.equal(s.pins[0].customTitle, 'My Docs');
  assert.equal(s.tabs[5].customTitle, 'Daily Standup');

  // Page title update preserves customTitle.
  s = M.upsertTab(s, { id: 5, windowId: 1, index: 0, active: true, url: 'https://app.example/2', title: 'Changed By Site' } as BrowserTab, 200);
  const vm = buildViewModel({ state: s, ui: { windowId: 1, tabId: 5 } });
  assert.equal(vm.space.pins[0].title, 'My Docs');
  assert.equal(vm.space.pins[0].hasCustomTitle, true);
  assert.equal(vm.space.today[0].title, 'Daily Standup');
  assert.equal(vm.space.today[0].hasCustomTitle, true);

  // Clearing customTitle falls back to site title.
  s = M.renameTab(s, 5, '');
  s = M.renamePin(s, 'p1', '   ');
  const vm2 = buildViewModel({ state: s, ui: { windowId: 1, tabId: 5 } });
  assert.equal(vm2.space.today[0].title, 'Changed By Site');
  assert.equal(vm2.space.today[0].hasCustomTitle, false);
  assert.equal(vm2.space.pins[0].title, 'Original Pin');
  assert.equal(vm2.space.pins[0].hasCustomTitle, false);
});

test('M2.2 hostedTabs.navigate navigates a tagged Safari tab back to root URL', async () => {
  const updates: Array<{ id: number, props: any }> = [];
  const fakeTabs: HostedTabsApi = {
    async get(id) { return { id, windowId: 1, url: 'https://linear.app/issue/1', active: true }; },
    async query() { return [{ id: 77, windowId: 1, url: 'https://linear.app/issue/1', active: true }]; },
    async create({ url }) { return { id: 77, windowId: 1, url, active: true }; },
    async update(id, props) { updates.push({ id, props }); return { id, windowId: 1, url: props.url, active: true }; },
    async remove() {},
  };
  const hosted = createHostedTabs(() => fakeTabs);
  await hosted.show({ windowId: 1, itemId: 't-pin1', url: 'https://linear.app/issue/1' });
  const nav = await hosted.navigate({ itemId: 't-pin1', url: 'https://linear.app/inbox' });
  assert.equal(nav.ok, true);
  assert.deepEqual(updates.at(-1), { id: 77, props: { url: 'https://linear.app/inbox', active: true } });
});
