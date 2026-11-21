// The Arc features' data, as the extension's model (state/model.ts) and Margin.app's library (app/shared/library) keep
// it: what binds a Margin tab (customTitle, pinnedBy, favoriteId) through every way it goes, a binding that no longer
// holds once its tab changes space, splits by Margin tab ids (cleaned up as their tabs go), favorites' scope and what a
// favorite can be, a pin's search by address never taking another's tab, link rules removed and turned off.
// The background's side (the handlers, against a fake Safari) is in tests/arc-data-background.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../extension/state/model.ts';
import * as V from '../extension/shared/view.ts';
import * as L from '../app/shared/library/library.ts';
import { buildViewModel } from '../extension/ui/view-model.ts';
import { menuItems } from '../extension/ui/behaviors/menu-items.ts';
import { checkAction, contextFromState, requestFor } from '../extension/ui/actions.ts';
import { settingsFields, saveField, runField, fieldsIn } from '../extension/ui/settings-form.ts';
import type { State } from '../types/margin.d.ts';

const NOW = 1_000_000;
const tab = (id: number, windowId: number, url: string, extra: Partial<BrowserTab> = {}) => ({ id, windowId, url, title: `t${id}`, index: id, active: false, ...extra }) as BrowserTab;

function applyChanges(values: L.Values, changes: L.Change[]): L.Values {
  const next: L.Values = structuredClone(values);
  for (const c of changes) {
    next[c.collection] ??= {};
    if ('deleted' in c && c.deleted) delete next[c.collection][c.id];
    else next[c.collection][c.id] = (c as { value: any }).value;
  }
  return next;
}
// A library with spaces `a` (Safari's default profile) and `b` (profile "work"), window 1 showing `a`.
function library(extra: Partial<L.Values> = {}) {
  let values: L.Values = {
    spaces: { a: { name: 'A', order: 0, browser: 'safari', profile: null }, b: { name: 'B', order: 1, browser: 'safari', profile: 'work' } },
    pins: {}, favorites: {}, airTraffic: {}, splits: {}, folders: {}, tabs: {}, archive: {}, windows: { 1: { spaceId: 'a' } }, imports: {}, ...extra,
  };
  let n = 0;
  const act = (action: string, payload: any = {}, ok = true) => {
    const out = L.perform(values, action, payload, { now: NOW + n, ids: [`id${String(++n).padStart(4, '0')}`] });
    if (ok) assert.equal(out.ok, true, `${action}: ${out.error}`);
    if (out.ok) values = applyChanges(values, out.changes);
    return out;
  };
  return { act, get values() { return values; } };
}
function twoSpaces() {
  let s = M.defaultState();
  s = M.createSpace(s, { id: 'work', name: 'Work', emoji: '💼', color: '#0984e3' });
  return M.setActiveSpace(s, 1, 'personal');
}

// ---- 1. bindings through every way a Margin tab goes -----------------------------------------------------------

test('arc data: a renamed, pinned or favorite tab keeps customTitle, pinnedBy and favoriteId asleep and opened again (linkKept)', () => {
  let s = twoSpaces();
  s = M.addPin(s, { id: 'p1', spaceId: 'personal', url: 'https://gh.example/repo', title: 'Repo' });
  s = M.addFavorite(s, { id: 'f1', scope: 'global', url: 'https://mail.example/', title: 'Mail' });
  s = M.upsertTab(s, tab(10, 1, 'https://gh.example/repo/pull/1', { index: 0, active: true }), NOW);
  s = M.upsertTab(s, tab(11, 1, 'https://mail.example/inbox', { index: 1 }), NOW);
  s = M.moveTab(M.moveTab(s, 10, 'personal'), 11, 'personal');
  s = M.renameTab(M.bindTabToPin(s, 10, 'p1'), 10, 'My PR');
  s = M.renameTab(M.bindTabToFavorite(s, 11, 'f1'), 11, 'Inbox');
  const mids = [s.tabs[10].mid!, s.tabs[11].mid!];
  s = M.closedTab(s, 10, { by: { how: 'keep', why: 'sleep' }, now: NOW + 1, archiveId: 'x1' });
  s = M.closedTab(s, 11, { by: { how: 'keep', why: 'sleep' }, now: NOW + 1, archiveId: 'x2' });
  assert.deepEqual([s.keptTabs[mids[0]].customTitle, s.keptTabs[mids[0]].pinnedBy], ['My PR', 'p1'], 'kept with its bindings');
  // Opened again (a click on its row: background/tabs.ts openTab), each as its Margin tab.
  s = M.linkKept(M.upsertTab(s, tab(20, 1, 'https://gh.example/repo/pull/1', { index: 0 }), NOW + 2), 20, mids[0], NOW + 2);
  s = M.linkKept(M.upsertTab(s, tab(21, 1, 'https://mail.example/inbox', { index: 1 }), NOW + 2), 21, mids[1], NOW + 2);
  assert.deepEqual([s.tabs[20].mid, s.tabs[20].customTitle, s.tabs[20].pinnedBy], [mids[0], 'My PR', 'p1']);
  assert.deepEqual([s.tabs[21].mid, s.tabs[21].customTitle, s.tabs[21].favoriteId], [mids[1], 'Inbox', 'f1']);
  const sb = V.sidebar(s, 1, 20);
  assert.equal(sb.pins[0].tabId, 20, 'the pin finds its tab again');
  assert.equal(sb.favorites[0].tabId, 21, 'the favorite finds its tab again');
});

test('arc data: a window that comes back takes its tabs back with their names and bindings (reclaimTabs)', () => {
  let s = twoSpaces();
  s = M.addFavorite(s, { id: 'f1', scope: 'global', url: 'https://cal.example/', title: 'Cal' });
  s = M.upsertTab(s, tab(30, 5, 'https://cal.example/week', { index: 0, active: true }), NOW);
  s = M.moveTab(s, 30, 'personal');
  s = M.renameTab(M.bindTabToFavorite(s, 30, 'f1'), 30, 'This week');
  const mid = s.tabs[30].mid!;
  s = M.closedTab(s, 30, { windowClosing: true, now: NOW + 1, archiveId: 'x' });
  assert.ok(s.keptTabs[mid]?.from, 'lost with its window');
  s = M.upsertTab(s, tab(40, 6, 'https://cal.example/week', { index: 0, active: true }), NOW + 2);
  s = M.reclaimTabs(s, [40], NOW + 3);
  assert.equal(s.tabs[40].mid, mid, 'the same Margin tab');
  assert.deepEqual([s.tabs[40].customTitle, s.tabs[40].favoriteId], ['This week', 'f1']);
});

// ---- 5. a binding holds in its own space only ---------------------------------------------------------------------

test('arc data: a pin\'s tab moved to another space is no pin\'s (moveTab), open or kept; a deleted space\'s dropped pins free their tabs', () => {
  let s = twoSpaces();
  s = M.addPin(s, { id: 'p1', spaceId: 'personal', url: 'https://docs.example/', title: 'Docs' });
  s = M.addFavorite(s, { id: 'f1', scope: 'global', url: 'https://mail.example/', title: 'Mail' });
  s = M.upsertTab(s, tab(1, 1, 'https://docs.example/a', { index: 0, active: true }), NOW);
  s = M.bindTabToPin(M.moveTab(s, 1, 'personal'), 1, 'p1');
  s = M.moveTab(s, 1, 'work');
  assert.equal(s.tabs[1].pinnedBy, undefined, 'open: moved, unbound');
  assert.equal(V.sidebar(M.setActiveSpace(s, 1, 'work'), 1, 1).tabs.some((t) => t.id === 1), true, 'a Today row of its new space');
  // Kept: the same.
  s = M.upsertTab(s, tab(2, 1, 'https://docs.example/b', { index: 1 }), NOW);
  s = M.bindTabToFavorite(M.bindTabToPin(M.moveTab(s, 2, 'personal'), 2, 'p1'), 2, 'f1');
  const mid = s.tabs[2].mid!;
  s = M.closedTab(s, 2, { by: { how: 'keep', why: 'sleep' }, now: NOW, archiveId: 'x' });
  assert.equal(s.keptTabs[mid].pinnedBy, undefined, 'bindTabToFavorite took the pin\'s binding (one at a time)');
  s = M.bindTabToPin(s, mid, 'p1');
  s = M.moveTab(s, mid, 'work');
  assert.equal(s.keptTabs[mid].pinnedBy, undefined, 'kept: moved, unbound');
  // A space deleted: its pin with an address the first space has already is dropped; its tab is no pin's.
  let d = twoSpaces();
  d = M.addPin(d, { id: 'pp', spaceId: 'personal', url: 'https://x.example/', title: 'X' });
  d = M.addPin(d, { id: 'pw', spaceId: 'work', url: 'https://x.example/', title: 'X' });
  d = M.upsertTab(d, tab(5, 1, 'https://x.example/deep', { index: 0 }), NOW);
  d = M.bindTabToPin(M.moveTab(d, 5, 'work'), 5, 'pw');
  d = M.deleteSpace(d, 'work');
  assert.deepEqual(d.pins.map((p) => p.id), ['pp']);
  assert.equal(d.tabSpace[5], 'personal');
  assert.equal(d.tabs[5].pinnedBy, undefined, 'the dropped pin\'s tab is unbound');
});

test('arc data: library: an item moved to another space closes into the archive (closeTab checks the pin of its own space)', () => {
  const lib = library();
  const item = lib.act('newTab', { windowId: 1, url: 'https://linear.example/inbox', title: 'Inbox' }).result.tabId;
  const pin = lib.act('pinTab', { tabId: item }).result;
  const live = lib.act('addItem', { spaceId: 'a', windowId: 1, url: 'https://linear.example/issue/1', title: 'Issue', front: true, pinnedBy: pin }).result.tabId;
  assert.equal(lib.values.tabs[live].pinnedBy, pin);
  lib.act('moveTabToSpace', { tabId: live, spaceId: 'b' });
  assert.equal(lib.values.tabs[live].pinnedBy, undefined, 'moved: unbound');
  lib.act('closeTab', { tabId: live });
  assert.deepEqual(Object.values(lib.values.archive).map((a: any) => a.url), ['https://linear.example/issue/1'], 'archived as any item');
  assert.ok(lib.values.pins[pin], 'the pin stays');
});

// ---- 11. a sticky pin's item closed: the pin stays, not open ------------------------------------------------------

test('arc data: library: closing a sticky pin\'s item keeps the pin, not open, nothing archived; the pin opens fresh again', () => {
  const lib = library();
  const item = lib.act('newTab', { windowId: 1, url: 'https://linear.example/inbox', title: 'Inbox' }).result.tabId;
  const pin = lib.act('pinTab', { tabId: item }).result;
  const live = item; // (the item pinned stays, the pin's tab, here navigated away from the pin's address)
  lib.act('updateItem', { tabId: live, url: 'https://linear.example/issue/9', title: 'Issue' });
  const closed = lib.act('closeTab', { tabId: live });
  assert.deepEqual(closed.requests.map((r) => [r.type, r.item]), [['closeTab', live]], 'the hosting closes its page');
  assert.ok(lib.values.pins[pin], 'the pin record stays');
  assert.equal(lib.values.tabs[live], undefined, 'its item goes (an item is a pin\'s open tab, in the library)');
  assert.equal(Object.keys(lib.values.archive).length, 0, 'not archived');
  // As the UI draws it (the snapshot): the pin, not open; no Today row.
  const snap = L.snapshot(lib.values) as any;
  const state = M.normalizeState({ ...snap, tabs: {}, tabSpace: {}, keptTabs: snap.openTabs.keptTabs, activeSpaceByWindow: snap.openTabs.activeSpaceByWindow });
  const sb = V.sidebar(state, 1, null);
  assert.deepEqual(sb.pins.map((p) => [p.id, p.tabId, p.active]), [[pin, null, false]], 'shown as not open');
  assert.equal(sb.tabs.length, 0);
  const opened = lib.act('openPin', { pinId: pin, windowId: 1 });
  assert.deepEqual([opened.requests[0].type, opened.requests[0].item, opened.requests[0].url], ['openPin', null, 'https://linear.example/inbox'], 'opened again at its own address');
});

// ---- 12. an item pinned stays, the pin's tab (sticky pins in Margin.app's library) --------------------------------

// What the UI draws in Margin.app: the library's snapshot with the open items as tabs (HostedSession.live/liveTab).
function drawn(values: L.Values, open: string[], front: string | null) {
  const snap = L.snapshot(values) as any;
  const kept = { ...snap.openTabs.keptTabs };
  const tabs: Record<number, any> = {}, tabSpace: Record<number, string> = {};
  open.forEach((item, i) => {
    const k = kept[item];
    if (!k) return;
    const n = i + 1;
    tabs[n] = { id: n, windowId: 1, index: i, title: k.title, url: k.url, favIconUrl: '', active: item === front, lastActive: k.lastActive, mid: item, order: k.order,
      ...(k.pinnedBy ? { pinnedBy: k.pinnedBy } : {}), ...(k.favoriteId ? { favoriteId: k.favoriteId } : {}) };
    tabSpace[n] = k.spaceId;
    delete kept[item];
  });
  return M.normalizeState({ ...snap, tabs, tabSpace, keptTabs: kept, activeSpaceByWindow: snap.openTabs.activeSpaceByWindow });
}

test('arc data: library: pinTab keeps the item as the new pin\'s tab (pinnedBy): not in Today, the pin open and active, its address shown', () => {
  const lib = library();
  const item = lib.act('newTab', { windowId: 1, url: 'https://linear.example/inbox', title: 'Inbox' }).result.tabId;
  lib.act('renameTab', { tabId: item, title: 'My Inbox' });
  const out = lib.act('pinTab', { tabId: item });
  const pin = out.result;
  assert.ok(lib.values.pins[pin], 'pinned');
  assert.equal(lib.values.tabs[item]?.pinnedBy, pin, 'the item stays, bound to its new pin');
  assert.equal(lib.values.pins[pin].customTitle, 'My Inbox', 'the name given to the tab goes with it to the pin');
  assert.deepEqual(out.requests, [], 'nothing asked of the hosting: the page stays shown');
  const state = drawn(lib.values, [item], item);
  const sb = V.sidebar(state, 1, 1);
  assert.deepEqual(sb.pins.map((p) => [p.id, p.tabId, p.active]), [[pin, 1, true]], 'the pin is open and active (its row highlighted)');
  assert.equal(sb.tabs.length, 0, 'not in Today: it\'s the pin\'s tab');
  const vm = buildViewModel({ state, ui: { windowId: 1, tabId: 1 } });
  assert.equal(vm.tab?.url, 'https://linear.example/inbox', 'the address field has its page');
  // Asleep (not open), it's still hidden from Today, and openPin shows that same item.
  const asleep = V.sidebar(drawn(lib.values, [], null), 1, null);
  assert.deepEqual([asleep.tabs.length, asleep.pins[0].tabId], [0, null]);
  const opened = lib.act('openPin', { pinId: pin, windowId: 1 });
  assert.deepEqual([opened.requests[0].type, opened.requests[0].item], ['openPin', item], 'openPin shows its own item');
  // Pinned into a new folder: the same.
  const other = lib.act('newTab', { windowId: 1, url: 'https://docs.example/', title: 'Docs' }).result.tabId;
  const folder = lib.act('createFolder', { windowId: 1, tabId: other }).result;
  const folderPin = Object.entries(lib.values.pins).find(([, p]: any) => p.folderId === folder)?.[0];
  assert.ok(folderPin);
  assert.equal(lib.values.tabs[other]?.pinnedBy, folderPin, 'createFolder with a tab: the item stays, its pin\'s');
});

test('arc data: library: a pinned item\'s close isn\'t archived (the pin stays, not open); unpinned, the item is Today\'s again', () => {
  const lib = library();
  const item = lib.act('newTab', { windowId: 1, url: 'https://linear.example/inbox', title: 'Inbox' }).result.tabId;
  const pin = lib.act('pinTab', { tabId: item }).result;
  const unpinned = lib.act('unpin', { pinId: pin });
  assert.equal(unpinned.requests[0].type, 'unpin');
  assert.equal(lib.values.pins[pin], undefined);
  assert.equal(lib.values.tabs[item]?.pinnedBy, undefined, 'unbound');
  const sb = V.sidebar(drawn(lib.values, [item], item), 1, 1);
  assert.deepEqual(sb.tabs.map((t: any) => t.mid ?? t.id), [item], 'back in Today, still open');
  const again = lib.act('pinTab', { tabId: item }).result;
  const closed = lib.act('closeTab', { tabId: item });
  assert.deepEqual(closed.requests.map((r) => [r.type, r.item]), [['closeTab', item]]);
  assert.equal(lib.values.tabs[item], undefined, 'its item goes');
  assert.equal(Object.keys(lib.values.archive).length, 0, 'not archived');
  assert.ok(lib.values.pins[again], 'the pin stays');
});

// ---- 8. a pin's search by address never takes another's tab -------------------------------------------------------

test('arc data: openPin by address skips a tab or item another pin or a favorite has (model, view, library)', () => {
  let s = twoSpaces();
  s = M.addPin(s, { id: 'p1', spaceId: 'personal', url: 'https://app.example/', title: 'App' });
  s = M.addPin(s, { id: 'p2', spaceId: 'personal', url: 'https://app.example/other', title: 'Other' });
  s = M.addFavorite(s, { id: 'f1', scope: 'global', url: 'https://mail.example/', title: 'Mail' });
  s = M.upsertTab(s, tab(1, 1, 'https://app.example/', { index: 0 }), NOW);
  s = M.bindTabToPin(M.moveTab(s, 1, 'personal'), 1, 'p2'); // p2's tab, navigated to p1's address
  assert.equal(V.pinTabId(s, 'p1', 1), null, 'the view\'s guess: not p2\'s tab');
  s = M.upsertTab(s, tab(2, 1, 'https://app.example/', { index: 1 }), NOW);
  s = M.bindTabToFavorite(M.moveTab(s, 2, 'personal'), 2, 'f1');
  assert.equal(V.pinTabId(s, 'p1', 1), null, 'nor the favorite\'s');
  assert.equal(M.boundElsewhere(s, s.tabs[1], 'personal', { pinId: 'p1' }), true);
  assert.equal(M.boundElsewhere(s, s.tabs[1], 'personal', { pinId: 'p2' }), false, 'its own pin');
  // Library: an item at the pin's address that's a favorite's is never taken.
  const lib = library();
  const t1 = lib.act('newTab', { windowId: 1, url: 'https://cal.example/', title: 'Cal' }).result.tabId;
  const fav = lib.act('addFavorite', { tabId: t1, windowId: 1 }).result;
  assert.equal(lib.values.tabs[t1].favoriteId, fav);
  const t2 = lib.act('newTab', { windowId: 1, url: 'https://cal.example/', title: 'Cal' }).result.tabId;
  const pin = lib.act('pinTab', { tabId: t2 }).result;
  assert.equal(lib.values.tabs[t2].pinnedBy, pin, 'the item pinned is the pin\'s');
  lib.act('closeTab', { tabId: t2 }); // (its own item gone: the pin searches by its address)
  const opened = lib.act('openPin', { pinId: pin, windowId: 1 });
  assert.equal(opened.requests[0].item, null, 'the favorite\'s item isn\'t the pin\'s');
  assert.equal(lib.values.tabs[t1].favoriteId, fav, 'still the favorite\'s');
  assert.equal(lib.values.tabs[t1].pinnedBy, undefined);
  const reset = lib.act('resetPin', { pinId: pin, windowId: 1 });
  assert.equal(reset.requests[0].item, null, 'resetPin neither');
});

// ---- 4, 9. favorites: their scope, and what one can be --------------------------------------------------------------

test('arc data: library addFavorite takes its scope from the app\'s favoritesScope and the window\'s space profile, never the page\'s scope; 12 per scope', () => {
  const lib = library();
  const item = lib.act('newTab', { windowId: 1, url: 'https://one.example/', title: 'One' }).result.tabId;
  const f1 = lib.act('addFavorite', { tabId: item, windowId: 1, scope: 'profile:evil' }).result;
  assert.equal(lib.values.favorites[f1].scope, 'global', 'global by default, whatever the page said');
  const f2 = lib.act('addFavorite', { url: 'https://two.example/', windowId: 1, favoritesScope: 'profile', scope: 'global' }).result;
  assert.equal(lib.values.favorites[f2].scope, 'profile:default', 'space a: Safari\'s default profile');
  lib.act('setSpace', { windowId: 1, spaceId: 'b' });
  const f3 = lib.act('addFavorite', { url: 'https://three.example/', windowId: 1, favoritesScope: 'profile' }).result;
  assert.equal(lib.values.favorites[f3].scope, 'profile:work', 'space b: its profile');
  // As the sidebar shows them (favoriteScopeOf with the profile's settings): the window's profile's.
  const snap = L.snapshot(lib.values) as any;
  const state = M.normalizeState({ ...snap, settings: { favoritesScope: 'profile' }, tabs: {}, tabSpace: {}, keptTabs: snap.openTabs.keptTabs, activeSpaceByWindow: snap.openTabs.activeSpaceByWindow });
  assert.deepEqual(V.sidebar(state, 1, null).favorites.map((f) => f.id), [f3]);
  // The cap holds per scope.
  for (let i = 0; i < 12; i++) lib.act('addFavorite', { url: `https://w${i}.example/`, windowId: 1, favoritesScope: 'profile' });
  assert.equal(Object.values(lib.values.favorites).filter((f: any) => f.scope === 'profile:work').length, 12);
  lib.act('setSpace', { windowId: 1, spaceId: 'a' });
  assert.ok(lib.act('addFavorite', { url: 'https://a-side.example/', windowId: 1, favoritesScope: 'profile' }).result, 'another profile\'s scope has room');
});

test('arc data: a favorite is a web page or a Mac app only (no extension page, about:, new-tab or Margin page)', () => {
  let s = twoSpaces();
  for (const url of ['about:blank', 'safari-web-extension://x/newtab.html', 'chrome://newtab/', 'file:///Users/x/a.html', 'javascript:alert(1)', 'margin://settings', '']) {
    assert.equal(M.addFavorite(s, { id: 'f', scope: 'global', url, title: 'x' }), s, url);
  }
  assert.equal(M.addFavorite(s, { id: 'f', scope: 'global', url: 'margin://settings', title: 'Settings', target: { kind: 'margin', page: 'settings' } }), s, 'a Margin page');
  assert.equal(M.addFavorite(s, { id: 'f', scope: 'global', url: 'app://com.apple.Notes', title: 'Notes' }), s, 'an app address with no app target');
  s = M.addFavorite(s, { id: 'f1', scope: 'global', url: 'https://ok.example/', title: 'OK' });
  s = M.addFavorite(s, { id: 'f2', scope: 'global', url: 'app://com.apple.Notes', title: 'Notes', target: { kind: 'app', bundleId: 'com.apple.Notes', name: 'Notes' } });
  assert.deepEqual(s.favorites!.map((f) => f.id), ['f1', 'f2']);
  // Library: Settings' item can't be a favorite; an app item can.
  const lib = library();
  const settings = lib.act('openMarginPage', { windowId: 1, page: 'settings' }).result.tabId;
  assert.equal(lib.act('addFavorite', { tabId: settings, windowId: 1 }).result, null);
  const app = lib.act('addItem', { spaceId: 'a', target: { kind: 'app', bundleId: 'com.apple.Music', name: 'Music' } }).result.tabId;
  assert.ok(lib.act('addFavorite', { tabId: app, windowId: 1 }).result);
  assert.equal(Object.keys(lib.values.favorites).length, 1);
});

test('arc data: settleFavorite: a favorite\'s extra kept tabs (left by the old open-a-new-tab-each-time) go to the archive, its own one stays', () => {
  let s = twoSpaces();
  s = M.addFavorite(s, { id: 'f1', scope: 'global', url: 'https://mail.example/', title: 'Mail' });
  const kept = (id: string, at: number) => ({ id, url: 'https://mail.example/', title: 'Mail', favIconUrl: '', spaceId: 'personal', order: at, lastActive: at, keptAt: at, why: 'sleep', favoriteId: 'f1' });
  s = { ...s, keptTabs: { 't-a': kept('t-a', 1), 't-b': kept('t-b', 3), 't-c': kept('t-c', 2) } } as State;
  assert.deepEqual(M.keptOfFavorite(s, 'f1').map((k) => k.id), ['t-b', 't-c', 't-a'], 'the one used last first');
  s = M.settleFavorite(s, 'f1', 't-b');
  assert.deepEqual(Object.keys(s.keptTabs), ['t-b']);
  assert.equal(s.archive.length, 1, 'archived once per address (archive keeps one entry per URL)');
});

// ---- 6. splits by Margin tab ids, cleaned up as their tabs go ------------------------------------------------------

function splitSession() {
  let s = twoSpaces();
  for (const [id, url] of [[1, 'https://a.example/'], [2, 'https://b.example/'], [3, 'https://c.example/']] as const) {
    s = M.moveTab(M.upsertTab(s, tab(id, 1, url, { index: id - 1, active: id === 1 }), NOW), id, 'personal');
  }
  return M.createSplit(s, { id: 'sp', spaceId: 'personal', panes: [1, 2, 3], ratios: [0.5, 0.3, 0.2] });
}

test('arc data: a split keeps its panes by Margin tab ids, through a sleep and a restart\'s renumbering', () => {
  let s = splitSession();
  const mids = [1, 2, 3].map((id) => s.tabs[id].mid!);
  assert.deepEqual(s.splits![0].panes, mids, 'Margin tab ids, not the browser\'s');
  assert.deepEqual(s.splits![0].ratios, [0.5, 0.3, 0.2]);
  assert.equal(M.splitForItem(s, 2)?.id, 'sp', 'found by the browser id too');
  // Tab 3 asleep: kept, the same Margin tab: still a pane.
  s = M.settleSplits(M.closedTab(s, 3, { by: { how: 'keep', why: 'sleep' }, now: NOW, archiveId: 'x' }));
  assert.deepEqual(s.splits![0].panes, mids);
  // Safari restarts: every tab a new id; the split follows its Margin tabs.
  s = M.settleSplits(M.syncTabs(s, [tab(71, 9, 'https://a.example/', { index: 0, active: true }), tab(72, 9, 'https://b.example/', { index: 1 })], { fresh: true, now: NOW + 10 }));
  assert.deepEqual([s.tabs[71].mid, s.tabs[72].mid], mids.slice(0, 2));
  assert.deepEqual(s.splits![0].panes, mids, 'every pane still there (two open, one kept)');
  const vm = buildViewModel({ state: s, ui: { windowId: 9, tabId: 71 } });
  assert.deepEqual(vm.space.splits[0].panes.map((p) => p.tabId), [71, 72, mids[2]], 'the view finds them by their new ids');
});

test('arc data: a split\'s pane whose tab closes leaves (ratios kept relative), and the split goes below 2 panes', () => {
  let s = splitSession();
  const mids = [1, 2, 3].map((id) => s.tabs[id].mid!);
  // Closed on its own (⌘W, Safari's tab bar): archived, its Margin tab gone.
  s = M.settleSplits(M.closedTab(s, 2, { now: NOW, archiveId: 'x' }));
  assert.deepEqual(s.splits![0].panes, [mids[0], mids[2]]);
  assert.deepEqual(s.splits![0].ratios, [0.7143, 0.2857], 'the others\' ratios, renormalized');
  s = M.settleSplits(M.closedTab(s, 3, { now: NOW, archiveId: 'y' }));
  assert.deepEqual(s.splits, [], 'one pane left: no split');
  // removeFromSplit keeps the others' ratios too.
  let r = splitSession();
  r = M.removeFromSplit(r, 'sp', 1);
  assert.deepEqual(r.splits![0].ratios, [0.6, 0.4]);
  // A pane saved by a browser id (this branch's first build): its open tab's Margin id; one of no tab: gone.
  let old = splitSession();
  old = { ...old, splits: [{ id: 'old', spaceId: 'personal', axis: 'horizontal', panes: ['1', '2', '99'], ratios: [0.2, 0.2] }] };
  old = M.settleSplits(old);
  assert.deepEqual(old.splits![0].panes, [old.tabs[1].mid, old.tabs[2].mid]);
  assert.deepEqual(old.splits![0].ratios, [0.5, 0.5], 'ratios that didn\'t match the panes: equal');
});

test('arc data: library splits: ratios read to match the panes, panes of items gone leave as any action is done', () => {
  const lib = library();
  const ids = ['https://a.example/', 'https://b.example/', 'https://c.example/'].map((url) => lib.act('newTab', { windowId: 1, url, title: url }).result.tabId);
  const sp = lib.act('createSplit', { panes: ids, windowId: 1, ratios: [0.5, 0.25, 0.25] }).result.splitId;
  assert.deepEqual(lib.values.splits[sp].ratios, [0.5, 0.25, 0.25]);
  // Closed outside Margin (the app quit, Safari's own tab bar): archived, and out of its split.
  lib.act('itemClosed', { tabId: ids[1] });
  assert.deepEqual(lib.values.splits[sp].panes, [ids[0], ids[2]]);
  assert.deepEqual(lib.values.splits[sp].ratios, [0.6667, 0.3333]);
  lib.act('removeItem', { tabId: ids[2] });
  assert.equal(lib.values.splits[sp], undefined, 'one pane left: the split is gone');
  // As read: panes that aren't ids dropped with their ratios, ratios one per pane, normalized.
  const state = L.stateOf({ spaces: { a: { name: 'A' } }, splits: { g: { spaceId: 'a', panes: ['t-1', 5, 't-2', 't-1'], ratios: [2, 9, 1, 3] } } });
  assert.deepEqual(state.splits![0].panes, ['t-1', 't-2']);
  assert.deepEqual(state.splits![0].ratios, [0.6667, 0.3333]);
  assert.deepEqual(L.stateOf({ spaces: { a: { name: 'A' } }, splits: { g: { spaceId: 'a', panes: ['t-1', 7], ratios: [1, 1] } } }).splits, [], 'fewer than 2 ids: none');
});

// ---- 7. Link Rules: removing and turning off rules -------------------------------------------------------------

test('arc data: linkRules.remove and linkRules.toggle: checked, sent, done by the library; the tab menu removes the rule routing it', () => {
  let s = twoSpaces();
  s = M.addAirTrafficRule(s, { id: 'r1', pattern: '*.figma.example', spaceId: 'work' });
  s = M.upsertTab(s, tab(9, 1, 'https://www.figma.example/file/1', { index: 0, active: true }), NOW);
  s = M.moveTab(s, 9, 'personal');
  const ctx = contextFromState(s);
  assert.equal(checkAction('linkRules.remove', 'r1', ctx).ok, true);
  assert.equal(checkAction('linkRules.toggle', 'r1', ctx).ok, true);
  assert.equal(checkAction('linkRules.remove', 'nope', ctx).ok, false, 'a rule that isn\'t there');
  assert.equal(checkAction('linkRules.toggle', 9, ctx).ok, false);
  assert.deepEqual(requestFor('linkRules.remove', 'r1', { state: s, ui: { windowId: 1 } }), { kind: 'send', type: 'removeAirTrafficRule', payload: { ruleId: 'r1' } });
  assert.deepEqual(requestFor('linkRules.toggle', 'r1', { state: s, ui: { windowId: 1 } }), { kind: 'send', type: 'toggleAirTrafficRule', payload: { ruleId: 'r1' } });
  const vm = buildViewModel({ state: s, ui: { windowId: 1, tabId: 9 } });
  const items = menuItems({ kind: 'tab', id: 9 }, { state: s, space: vm.space });
  const remove = items.find((i) => i.action === 'linkRules.remove');
  assert.deepEqual([remove?.label, remove?.arg], ['Remove Rule for *.figma.example', 'r1']);
  assert.equal(checkAction(remove!.action!, remove!.arg, ctx).ok, true);
  // Turned off: it routes nothing, so the menu has nothing to remove.
  const off = M.toggleAirTrafficRule(s, 'r1');
  assert.equal(off.airTraffic![0].enabled, false);
  assert.equal(menuItems({ kind: 'tab', id: 9 }, { state: off, space: vm.space }).some((i) => i.action === 'linkRules.remove'), false);
  // The library does both.
  const lib = library();
  const rule = lib.act('addAirTrafficRule', { pattern: 'linear.example', spaceId: 'b' }).result;
  lib.act('toggleAirTrafficRule', { ruleId: rule });
  assert.equal(lib.values.airTraffic[rule].enabled, false);
  assert.equal(lib.act('newTab', { windowId: 1, url: 'https://linear.example/x' }).requests[0].spaceId, 'a', 'off: not routed');
  lib.act('toggleAirTrafficRule', { ruleId: rule });
  assert.equal(lib.act('newTab', { windowId: 1, url: 'https://linear.example/y' }).requests[0].spaceId, 'b', 'on again: routed');
  lib.act('removeAirTrafficRule', { ruleId: rule });
  assert.equal(lib.values.airTraffic[rule], undefined);
});

test('arc data: Settings › Browsing lists every link rule: a toggle and Remove each; they send the rule\'s own requests', () => {
  const rules = [{ id: 'r2', pattern: 'b.example', spaceId: 'gone', enabled: false, order: 1 }, { id: 'r1', pattern: '*.a.example', spaceId: 'work', order: 0 }];
  const spaces = [{ id: 'work', name: 'Work', emoji: '💼' }];
  const fields = fieldsIn(settingsFields({}, {}, { airTraffic: { rules, spaces } }), 'browsing');
  const ours = fields.filter((f) => /linkRule|LinkRule/.test(f.id));
  assert.deepEqual(ours.map((f) => [f.kind, f.label, f.checked]), [
    ['group', 'Link Rules', false],
    ['toggle', 'Open *.a.example in 💼 Work', true],
    ['button', 'Remove rule for *.a.example', false],
    ['toggle', 'Open b.example in a space that’s gone', false],
    ['button', 'Remove rule for b.example', false],
  ]);
  assert.deepEqual(saveField(ours[3], true, {}), { type: 'toggleAirTrafficRule', payload: { ruleId: 'r2', enabled: true } });
  assert.equal(saveField(ours[3], 'yes', {}), null, 'a toggle\'s value only');
  assert.deepEqual(runField(ours[2]), { type: 'removeAirTrafficRule', payload: { ruleId: 'r1' } });
  const none = fieldsIn(settingsFields({}, {}, { airTraffic: { rules: [], spaces } }), 'browsing').filter((f) => /linkRule/.test(f.id));
  assert.deepEqual(none.map((f) => f.kind), ['group', 'info'], 'none yet: where they\'re made');
  // From the state (the view model passes them).
  let s = twoSpaces();
  s = M.addAirTrafficRule(s, { id: 'r9', pattern: 'c.example', spaceId: 'work' });
  const vm = buildViewModel({ state: s, ui: { windowId: 1, launcherPage: true, settingsOpen: true }, platform: { browser: 'safari', os: 'mac', features: {} } as any });
  assert.ok(vm.settingsForm?.fields.some((f) => f.id === 'linkRule:r9'), 'drawn in Settings');
});

test('arc data: addAirTrafficRule at the cap of 100: a rule for a pattern already there is replaced; a new one is refused', () => {
  let s = twoSpaces();
  for (let i = 0; i < M.AIR_TRAFFIC_CAP; i++) s = M.addAirTrafficRule(s, { id: `r${i}`, pattern: `s${i}.example`, spaceId: 'personal' });
  assert.equal(s.airTraffic!.length, 100);
  const replaced = M.addAirTrafficRule(s, { id: 'new', pattern: 's5.example', spaceId: 'work' });
  assert.equal(replaced.airTraffic!.length, 100);
  assert.equal(replaced.airTraffic!.find((r) => r.pattern === 's5.example')?.spaceId, 'work', 'replaced at the cap');
  assert.equal(M.addAirTrafficRule(s, { id: 'more', pattern: 'other.example', spaceId: 'work' }), s, 'a 101st refused');
});
