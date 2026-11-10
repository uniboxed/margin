// Margin's tabs (Margin 2, PLAN.md §6 "Margin's tabs"): each tab has an id of
// Margin's own and a place in the list; a tab with no browser tab stays, not
// open, in its space (state/model.ts keptTabs); the keep and archive rules
// when a browser tab closes (closedTab); matching after a relaunch; how the
// sidebar, the view model, the actions, the menus and the palette show and
// take tabs that aren't open. Pure: the background's side is in
// tests/kept-tabs.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../extension/state/model.ts';
import * as V from '../extension/shared/view.ts';
import { buildViewModel } from '../extension/ui/view-model.ts';
import { checkAction, contextFromState, requestFor } from '../extension/ui/actions.ts';
import { menuItems } from '../extension/ui/behaviors/menu-items.ts';
import { rankPalette } from '../extension/shared/search.ts';
import type { KeptTab, State } from '../types/margin.d.ts';

// Every tab the state records has its Margin id and place (upsertTab, syncTabs give them): `.mid!`, `.order!` below.
const tab = (id: number, windowId: number, url: string, extra: Partial<BrowserTab> = {}) => ({ id, windowId, url, title: `t${id}`, index: id, active: false, ...extra });
const NOW = 1_000_000;

function twoSpaces() {
  let s = M.defaultState();
  s = M.createSpace(s, { id: 'work', name: 'Work', emoji: '💼', color: '#0984e3' });
  return s;
}
// Window 1: a (0), b (1), c (2) in Work; window 2: d (0) in Personal.
function session() {
  let s = M.setActiveSpace(twoSpaces(), 1, 'work');
  s = M.upsertTab(s, tab(1, 1, 'https://a.test/', { index: 0, active: true }), NOW);
  s = M.upsertTab(s, tab(2, 1, 'https://b.test/', { index: 1 }), NOW);
  s = M.upsertTab(s, tab(3, 1, 'https://c.test/', { index: 2 }), NOW);
  s = M.setActiveSpace(s, 2, 'personal');
  s = M.upsertTab(s, tab(4, 2, 'https://d.test/', { index: 0, active: true }), NOW);
  return s;
}
const keptList = (s: State) => Object.values(s.keptTabs).sort((a, b) => a.order - b.order);

// ---- ids and places -------------------------------------------------------------

test('Margin tab ids: every tab gets one of Margin\'s own, kept through updates, activations and moves to another space', () => {
  let s = session();
  const ids = [1, 2, 3, 4].map((id) => s.tabs[id].mid);
  assert.ok(ids.every((id) => M.isTabId(id)), 't- and letters');
  assert.equal(new Set(ids).size, 4, 'all different');
  s = M.upsertTab(s, tab(2, 1, 'https://b.test/next', { index: 1, title: 'Next' }), NOW + 1);
  s = M.activateTab(s, 2, 1, NOW + 2);
  s = M.moveTab(s, 2, 'personal');
  assert.equal(s.tabs[2].mid, ids[1]);
});

test('places: a new tab at the end of its window is the newest of all (open or not); one opened between two takes a place between them', () => {
  let s = session();
  const [a, b, c] = [1, 2, 3].map((id) => s.tabs[id].order!);
  assert.ok(a < b && b < c, 'in the window\'s order');
  s = M.upsertTab(s, tab(5, 1, 'https://e.test/', { index: 1 }), NOW); // a link opened next to a
  assert.ok(s.tabs[5].order! > a && s.tabs[5].order! < s.tabs[2].order!, 'between a and b');
  s = M.keepTab(s, 3, { why: 'window', now: NOW });
  const top = Math.max(...Object.values(s.tabs).map((t) => t.order!), ...Object.values(s.keptTabs).map((k) => k.order));
  s = M.upsertTab(s, tab(6, 1, 'https://f.test/', { index: 9 }), NOW);
  assert.equal(s.tabs[6].order, top + 1, 'after every tab, the kept one too');
});

test('places: after a move in the tab strip only the moved tab gets a new place, between its new neighbours', () => {
  let s = session();
  const before = Object.fromEntries([1, 2, 3].map((id) => [id, s.tabs[id].order]));
  // c dragged to the front of the window (Safari's tab bar): tabs.query's indexes.
  s = M.syncTabs(s, [tab(1, 1, 'https://a.test/', { index: 1, active: true }), tab(2, 1, 'https://b.test/', { index: 2 }), tab(3, 1, 'https://c.test/', { index: 0 }), tab(4, 2, 'https://d.test/', { index: 0, active: true })], { now: NOW });
  assert.equal(s.tabs[1].order, before[1]);
  assert.equal(s.tabs[2].order, before[2]);
  assert.ok(s.tabs[3].order! < s.tabs[1].order!, 'before a now');
  const shown = V.sidebar(s, 1, 1).tabs.map((t) => t.id);
  assert.deepEqual(shown, [2, 1, 3], 'newest first: the strip reversed');
});

test('places that get too close are renumbered, the order kept', () => {
  let s = session();
  // a and b a hair apart (many tabs opened between them before).
  s = { ...s, tabs: { ...s.tabs, 2: { ...s.tabs[2], order: s.tabs[1].order! + 1e-7 } } };
  s = M.closedTab(s, 4, { windowClosing: true, now: NOW, archiveId: 'x' });
  s = M.upsertTab(s, tab(9, 1, 'https://n.test/', { index: 1 }), NOW); // opened right after a
  const all = [...Object.values(s.tabs), ...Object.values(s.keptTabs)].sort((x, y) => x.order! - y.order!);
  assert.deepEqual(all.map((t) => t.order), [0, 1, 2, 3, 4], 'renumbered, open and not');
  assert.deepEqual(all.map((t) => t.url), ['https://a.test/', 'https://n.test/', 'https://b.test/', 'https://c.test/', 'https://d.test/'], 'in the same order');
});

// ---- what's stored from before ------------------------------------------------------

test('migration: open tabs from before Margin\'s ids get one and a place (their index); an earlier build\'s lost tabs become kept tabs in their spaces, still taken back by a window that comes back', () => {
  const raw = {
    spaces: [{ id: 'personal', name: 'Personal', emoji: '🏠', color: '#6c5ce7' }, { id: 'work', name: 'Work', emoji: '💼', color: '#0984e3' }],
    tabs: { 7: { id: 7, windowId: 1, index: 3, url: 'https://x.test/', title: 'X', lastActive: 5, active: true } },
    tabSpace: { 7: 'work' },
    lostTabs: { windows: [{ key: '50:9', at: NOW - 1000, size: 2, tabs: [{ url: 'https://l1.test/', spaceId: 'work', lastActive: 40, windowId: 9, index: 0 }, { url: 'https://l2.test/', spaceId: 'personal', lastActive: 41, windowId: 9, index: 1 }] }] },
  };
  const s = M.normalizeState(raw);
  assert.ok(M.isTabId(s.tabs[7].mid));
  assert.equal(s.tabs[7].order, 3);
  assert.equal(s.lostTabs, null, 'moved: never read again');
  assert.deepEqual(keptList(s).map((k) => [k.url, k.spaceId, k.from!.key, k.from!.size]), // lost with a window: its `from`
    [['https://l1.test/', 'work', '50:9', 2], ['https://l2.test/', 'personal', '50:9', 2]]);
  assert.equal(M.tabIdsAdded(raw, s), true, 'written, so the ids last');
  const again = M.normalizeState({ ...raw, tabs: s.tabs, keptTabs: s.keptTabs, lostTabs: null });
  assert.equal(again.tabs[7], s.tabs[7], 'kept as stored');
  assert.deepEqual(again.keptTabs, s.keptTabs);
  assert.equal(M.tabIdsAdded({ ...raw, tabs: s.tabs, keptTabs: s.keptTabs, lostTabs: null }, again), false, 'nothing new to write');
  // The window comes back (History › Reopen…): its tabs take them back.
  let next = M.upsertTab(again, tab(30, 4, 'https://l1.test/', { index: 0 }), NOW);
  next = M.upsertTab(next, tab(31, 4, 'https://l2.test/', { index: 1, active: true }), NOW);
  next = M.reclaimTabs(next, [30, 31], NOW);
  assert.deepEqual([next.tabSpace[30], next.tabSpace[31]], ['work', 'personal']);
  assert.deepEqual(next.keptTabs, {});
});

// ---- the keep and archive rules (closedTab) ------------------------------------------

test('a tab closed on its own (Margin\'s ×, ⌘W, the tab bar) goes to the archive; a page that isn\'t a web page is just gone', () => {
  let s = session();
  s = M.closedTab(s, 2, { now: NOW, archiveId: 'a1' });
  assert.equal(s.tabs[2], undefined);
  assert.deepEqual(s.keptTabs, {}, 'not kept');
  assert.deepEqual(s.archive.map((a) => [a.id, a.url, a.spaceId]), [['a1', 'https://b.test/', 'work']]);
  s = M.upsertTab(s, tab(9, 1, 'safari-web-extension://x/newtab/newtab.html', { index: 5 }), NOW);
  s = M.closedTab(s, 9, { now: NOW, archiveId: 'a2' });
  assert.equal(s.archive.length, 1, 'a new-tab page isn\'t archived');
});

test('tabs lost with their window stay, not open, in their spaces, the same Margin tabs, with their places; the window\'s tabs go together', () => {
  let s = session();
  const mids = [1, 2, 3].map((id) => s.tabs[id].mid);
  const orders = [1, 2, 3].map((id) => s.tabs[id].order);
  for (const id of [1, 2, 3]) s = M.closedTab(s, id, { windowClosing: true, now: NOW + id, archiveId: `x${id}` });
  assert.deepEqual(s.archive, [], 'nothing archived');
  const kept = keptList(s);
  assert.deepEqual(kept.map((k) => k.id), mids);
  assert.deepEqual(kept.map((k) => k.order), orders);
  assert.deepEqual(kept.map((k) => [k.url, k.spaceId, k.why]), [['https://a.test/', 'work', 'window'], ['https://b.test/', 'work', 'window'], ['https://c.test/', 'work', 'window']]);
  assert.equal(new Set(kept.map((k) => k.from!.key)).size, 1, 'lost with one window'); // so each has its `from`
  assert.equal(kept[0].from!.size, 3, 'which had three pages');
  // Shown in every window showing Work: window 2, once it shows Work.
  const w2 = M.setActiveSpace(s, 2, 'work');
  assert.deepEqual(V.sidebar(w2, 2, 4).tabs.map((t) => [t.id, !!t.kept]), [[mids[2], true], [mids[1], true], [mids[0], true]]);
});

test('Margin\'s own closes: put to sleep (kept), done (archived already, or a ⌘T tab handed off: nothing more)', () => {
  let s = session();
  s = M.closedTab(s, 2, { by: { how: 'keep', why: 'sleep' }, now: NOW, archiveId: 'a' });
  assert.equal(Object.values(s.keptTabs)[0].why, 'sleep');
  s = M.closedTab(s, 3, { by: { how: 'done' }, now: NOW, archiveId: 'b' });
  assert.equal(s.tabs[3], undefined);
  assert.equal(Object.keys(s.keptTabs).length, 1);
  assert.deepEqual(s.archive, []);
});

test('a pinned tab isn\'t kept as it closes with its window (its pin opens it again)', () => {
  let s = M.addPin(session(), { id: 'p', spaceId: 'work', url: 'https://a.test/', title: 'A' });
  s = M.closedTab(s, 1, { windowClosing: true, now: NOW, archiveId: 'x' });
  assert.deepEqual(s.keptTabs, {});
});

test('a close heard after a sync already found the tab gone: closed on its own, the kept tab goes to the archive; with its window, it stays', () => {
  let s = session();
  // The sync (tabs 2 and 3 gone, their closes not heard yet).
  s = M.syncTabs(s, [tab(1, 1, 'https://a.test/', { index: 0, active: true }), tab(4, 2, 'https://d.test/', { index: 0, active: true })], { now: NOW });
  assert.deepEqual(keptList(s).map((k) => [k.wasTab, k.why]), [[2, 'gone'], [3, 'gone']]);
  s = M.closedTab(s, 2, { now: NOW, archiveId: 'a2' });
  assert.deepEqual(s.archive.map((a) => a.url), ['https://b.test/']);
  s = M.closedTab(s, 3, { windowClosing: true, now: NOW, archiveId: 'a3' });
  assert.deepEqual(keptList(s).map((k) => [k.url, k.wasTab]), [['https://c.test/', undefined]]);
  // The tab there after all (a list Safari gave once without it): the same Margin tab.
  const t = M.syncTabs(M.syncTabs(session(), [tab(1, 1, 'https://a.test/', { index: 0, active: true })], { now: NOW }), [tab(1, 1, 'https://a.test/', { index: 0, active: true }), tab(2, 1, 'https://b.test/', { index: 1 })], { now: NOW });
  assert.equal(t.tabSpace[2], 'work');
  assert.equal(Object.values(t.keptTabs).some((k) => k.url === 'https://b.test/'), false);
});

test('after a relaunch the ids kept tabs had mean other tabs: a close of a new tab with that id never archives one', () => {
  let s = M.syncTabs(session(), [tab(1, 1, 'https://a.test/', { index: 0, active: true }), tab(4, 2, 'https://d.test/', { index: 0, active: true })], { now: NOW });
  assert.ok(Object.values(s.keptTabs).some((k) => k.wasTab === 2));
  s = M.syncTabs(s, [tab(2, 7, 'https://other.test/', { index: 0, active: true })], { fresh: true, now: NOW + 10 });
  assert.ok(Object.values(s.keptTabs).every((k) => k.wasTab === undefined));
  const before = Object.keys(s.keptTabs).length;
  s = M.closedTab(s, 2, { now: NOW + 20, archiveId: 'z' });
  assert.equal(Object.keys(s.keptTabs).length, before, 'the kept ones stay');
  assert.deepEqual(s.archive.map((a) => a.url), ['https://other.test/'], 'only the tab that closed');
});

// ---- after a relaunch ---------------------------------------------------------------

test('relaunch: restored tabs are matched by address and order, keeping their Margin tabs; what Safari didn\'t restore stays not open, in its space', () => {
  const s = session();
  const reopened = [tab(70, 8, 'https://a.test/', { index: 0, active: true }), tab(71, 8, 'https://c.test/', { index: 1 })];
  const next = M.syncTabs(s, reopened, { fresh: true, now: NOW + 3600_000 });
  assert.deepEqual([next.tabs[70].mid, next.tabs[71].mid], [s.tabs[1].mid, s.tabs[3].mid], 'the same Margin tabs');
  assert.deepEqual([next.tabSpace[70], next.tabSpace[71]], ['work', 'work']);
  assert.deepEqual(keptList(next).map((k) => [k.id, k.url, k.spaceId, k.why]), [[s.tabs[2].mid, 'https://b.test/', 'work', 'not restored'], [s.tabs[4].mid, 'https://d.test/', 'personal', 'not restored']]);
  assert.ok(next.tabs[70].order! < next.tabs[71].order!);
  const b = keptList(next)[0];
  assert.ok(b.order > next.tabs[70].order! && b.order < next.tabs[71].order!, 'b keeps its place between a and c');
  assert.equal(b.lastActive, NOW + 3600_000, 'the time Safari was closed doesn\'t count');
});

test('relaunch: windows kept as they closed (a quit that closed them first) are matched back by the first sync, the same Margin tabs', () => {
  let s = session();
  for (const id of [1, 2, 3]) s = M.closedTab(s, id, { windowClosing: true, now: NOW, archiveId: 'x' });
  for (const id of [4]) s = M.closedTab(s, id, { windowClosing: true, now: NOW + 5, archiveId: 'x' });
  assert.deepEqual(s.tabs, {});
  const mids = keptList(s).map((k) => k.id);
  const later = NOW + 8 * 3600_000;
  const next = M.syncTabs(s, [tab(80, 5, 'https://a.test/', { index: 0 }), tab(81, 5, 'https://b.test/', { index: 1, active: true }), tab(82, 5, 'https://c.test/', { index: 2 })], { fresh: true, now: later });
  assert.deepEqual([80, 81, 82].map((id) => next.tabs[id].mid), mids.slice(0, 3));
  assert.deepEqual([80, 81, 82].map((id) => next.tabSpace[id]), ['work', 'work', 'work']);
  assert.equal(next.activeSpaceByWindow[5], 'work');
  assert.deepEqual(Object.values(next.keptTabs).map((k) => k.url), ['https://d.test/'], 'd\'s window didn\'t come back');
  assert.equal(Object.values(next.keptTabs)[0].lastActive, NOW + (later - (NOW + 5)), 'its last use moved past the time Safari was closed');
});

test('auto-archive: a tab unused for archiveAfterHours goes to the archive, open or not; pinned ones never', () => {
  let s = session();
  s = M.closedTab(s, 2, { windowClosing: true, now: NOW, archiveId: 'x' });
  s = M.closedTab(s, 3, { windowClosing: true, now: NOW, archiveId: 'x' });
  s = M.addPin(s, { id: 'p', spaceId: 'work', url: 'https://c.test/', title: 'C' });
  const later = NOW + 13 * 3600_000;
  assert.deepEqual(M.staleKept(s, later).map((k) => k.url), ['https://b.test/']);
  assert.deepEqual(M.staleKept(s, NOW + 3600_000), [], 'not yet');
  assert.deepEqual(M.staleKept({ ...s, settings: { ...s.settings, archiveAfterHours: 0 } }, later), [], 'off');
  const archived = M.archiveKept(s, M.staleKept(s, later)[0].id, { id: 'z', closedAt: later });
  assert.deepEqual(archived.archive.map((a) => [a.id, a.url, a.spaceId]), [['z', 'https://b.test/', 'work']]);
  assert.equal(Object.values(archived.keptTabs).length, 1);
});

test('kept tabs: at most KEPT_CAP, the least recently used beyond it archived', () => {
  let s = twoSpaces();
  const keptTabs: Record<string, KeptTab> = {};
  for (let i = 0; i < M.KEPT_CAP + 3; i++) keptTabs[`t-k${i}`] = { id: `t-k${i}`, url: `https://k${i}.test/`, title: '', favIconUrl: '', spaceId: 'work', order: i, lastActive: i, keptAt: 0, why: 'window' };
  s = { ...s, keptTabs };
  s = M.upsertTab(s, tab(1, 1, 'https://new.test/', { index: 0 }), NOW);
  s = M.closedTab(s, 1, { windowClosing: true, now: NOW, archiveId: 'x' });
  assert.equal(Object.keys(s.keptTabs).length, M.KEPT_CAP);
  assert.deepEqual(s.archive.map((a) => a.url).sort(), ['https://k0.test/', 'https://k1.test/', 'https://k2.test/', 'https://k3.test/']);
});

// ---- opening, moving, placing ---------------------------------------------------------

test('opening a kept tab: where in the tab strip (before the first open tab placed after it), and the new browser tab becomes that Margin tab', () => {
  let s = session();
  const b = s.tabs[2];
  s = M.closedTab(s, 2, { windowClosing: true, now: NOW, archiveId: 'x' });
  assert.equal(M.stripIndexFor(s, 1, b.order!), 2, 'before c (index 2)');
  assert.equal(M.stripIndexFor(s, 2, b.order!), 0, 'window 2: before d, placed after it');
  assert.equal(M.stripIndexFor(s, 2, s.tabs[4].order! + 1), undefined, 'nothing placed after it: the end');
  s = M.upsertTab(s, tab(50, 1, 'https://b.test/', { index: 2, active: true }), NOW + 10);
  s = M.linkKept(s, 50, b.mid!, NOW + 10);
  assert.equal(s.tabs[50].mid, b.mid);
  assert.equal(s.tabs[50].order, b.order);
  assert.equal(s.tabSpace[50], 'work');
  assert.equal(s.tabs[50].lastActive, NOW + 10);
  assert.deepEqual(s.keptTabs, {}, 'open now');
  assert.ok(s.tabs[50].placed, 'never taken for a tab coming back');
});

test('a kept tab moves to another space, and dragged in the list takes a place next to another', () => {
  let s = session();
  s = M.closedTab(s, 2, { windowClosing: true, now: NOW, archiveId: 'x' });
  const id = Object.keys(s.keptTabs)[0];
  assert.equal(M.moveTab(s, id, 'personal').keptTabs[id].spaceId, 'personal');
  assert.equal(M.moveTab(s, id, 'nope'), s);
  // Above a (the list is newest first: 'before' is above, a later place).
  const above = M.placeKept(s, id, 1, 'before', 'work');
  const shown = V.sidebar(above, 1, 1).tabs.map((t) => t.id);
  assert.deepEqual(shown, [3, id, 1]);
  const top = M.placeKept(s, id, 3, 'before', 'work');
  assert.deepEqual(V.sidebar(top, 1, 1).tabs.map((t) => t.id), [id, 3, 1]);
});

test('a space deleted: its kept tabs go to the first space with its other tabs', () => {
  let s = session();
  s = M.closedTab(s, 2, { windowClosing: true, now: NOW, archiveId: 'x' });
  s = M.deleteSpace(s, 'work');
  assert.ok(Object.values(s.keptTabs).every((k) => k.spaceId === 'personal'));
});

// ---- what pages draw ---------------------------------------------------------------

test('the sidebar: a space\'s kept tabs among its open ones by place, not open; never a pin\'s tab, nor in ⌘⌥↓/↑\'s cycle', () => {
  let s = session();
  s = M.closedTab(s, 2, { windowClosing: true, now: NOW, archiveId: 'x' });
  const kept = Object.values(s.keptTabs)[0];
  const rows = V.sidebar(s, 1, 1).tabs;
  assert.deepEqual(rows.map((t) => t.id), [3, kept.id, 1]);
  assert.equal(rows[1].kept, true);
  assert.equal(rows[1].active, false);
  assert.equal(V.cycleTab(s, 1, 3, 1), 1, 'past the tab that isn\'t open');
  const pinned = M.addPin(s, { id: 'p', spaceId: 'work', url: 'https://b.test/', title: 'B' });
  const view = V.sidebar(pinned, 1, 1);
  assert.deepEqual(view.tabs.map((t) => t.id), [3, 1], 'its pin shows it');
  assert.equal(view.pins[0].tabId, null, 'the pin isn\'t open');
});

test('the view model: a kept tab\'s row says it isn\'t open (open false, notOpen true), its id Margin\'s; the space counts it', () => {
  let s = session();
  s = M.closedTab(s, 2, { windowClosing: true, now: NOW, archiveId: 'x' });
  const vm = buildViewModel({ state: s, ui: { windowId: 1, tabId: 1 } });
  const row = vm.space.today.find((t) => typeof t.id === 'string')!;
  assert.deepEqual([row.open, row.notOpen, row.active, row.asleep, row.loading, row.title], [false, true, false, false, false, 't2']);
  const open = vm.space.today.find((t) => t.id === 3)!;
  assert.deepEqual([open.open, open.notOpen], [true, false]);
  assert.equal(vm.space.tabCount, 3, 'a, c and the one not open');
});

test('actions: a kept tab\'s id is a tab\'s; activating it asks the background to open it in this window', () => {
  let s = session();
  s = M.closedTab(s, 2, { windowClosing: true, now: NOW, archiveId: 'x' });
  const id = Object.keys(s.keptTabs)[0];
  const ctx = contextFromState(s);
  for (const name of ['tab.activate', 'tab.close', 'tab.pin', 'folder.newWithTab']) assert.deepEqual(checkAction(name, id, ctx), { ok: true }, name);
  assert.equal(checkAction('tab.activate', 't-nope', ctx).ok, false);
  assert.deepEqual(checkAction('tab.moveToSpace', { tab: id, space: 'personal' }, ctx), { ok: true });
  assert.deepEqual(requestFor('tab.activate', id, { state: s, ui: { windowId: 1, sidebar: 'open' } }), { kind: 'send', type: 'activateTab', payload: { tabId: id, windowId: 1 } });
  assert.deepEqual(requestFor('tab.activate', 3, { state: s, ui: { windowId: 1, sidebar: 'open' } }), { kind: 'send', type: 'activateTab', payload: { tabId: 3 } }, 'an open one as before');
  assert.deepEqual((requestFor('tab.close', id, { state: s, ui: { windowId: 1 } }) as { payload?: unknown }).payload, { tabId: id }); // a send's
});

test('menus: a kept tab\'s menu is a tab\'s (pin, folders, move to a space, close)', () => {
  let s = session();
  s = M.closedTab(s, 2, { windowClosing: true, now: NOW, archiveId: 'x' });
  const id = Object.keys(s.keptTabs)[0];
  const vm = buildViewModel({ state: s, ui: { windowId: 1, tabId: 1 } });
  const items = menuItems({ kind: 'tab', id }, { state: s, space: vm.space });
  assert.deepEqual(items.filter((i) => !i.separator).map((i) => [i.label, i.action]), [['Pin Tab', 'tab.pin'], ['New Folder with Tab', 'folder.newWithTab'], ['Move to 🏠 Personal', 'tab.moveToSpace'], ['Close Tab', 'tab.close']]);
  assert.deepEqual(menuItems({ kind: 'tab', id: 't-gone' }, { state: s, space: vm.space }), []);
});

test('the palette finds a kept tab, and choosing it opens it in this window', () => {
  let s = session();
  s = M.closedTab(s, 2, { windowClosing: true, now: NOW, archiveId: 'x' });
  const id = Object.keys(s.keptTabs)[0];
  // The palette's context: what's left out is off.
  const row = rankPalette(s, 'b.test', { windowId: 1, tabId: 1 } as Parameters<typeof rankPalette>[2]).find((r) => r.id === `tab:${id}`);
  assert.ok(row, 'listed');
  assert.deepEqual(row.action, { type: 'activateTab', tabId: id, windowId: 1 });
});
