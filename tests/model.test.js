import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../extension/state/model.js';
import '../extension/shared/view.js';

const { view, model: M } = globalThis.Margin;
const tab = (id, windowId, url, extra = {}) => ({ id, windowId, url, title: `t${id}`, index: id, active: false, ...extra });

test('default state has one Personal space and default settings', () => {
  const s = M.defaultState();
  assert.equal(s.spaces.length, 1);
  assert.equal(s.spaces[0].name, 'Personal');
  assert.deepEqual(s.settings, M.DEFAULT_SETTINGS);
});

test('normalizeState fills missing keys and keeps stored ones', () => {
  const s = M.normalizeState({ settings: { archiveAfterHours: 3 }, pins: [{ id: 'p' }] });
  assert.equal(s.settings.archiveAfterHours, 3);
  assert.equal(s.settings.paletteShortcut, 'Alt+KeyK');
  assert.equal(s.pins.length, 1);
  assert.equal(s.spaces.length, 1);
  assert.deepEqual(s.tabSpace, {});
});

test('normalizeUrl ignores fragment and bare trailing slash, and matches view.js', () => {
  const cases = ['https://a.com/', 'https://a.com', 'https://a.com/x#y', 'https://a.com/x?q=1', 'not a url', ''];
  assert.equal(M.normalizeUrl('https://a.com/'), M.normalizeUrl('https://a.com'));
  assert.equal(M.normalizeUrl('https://a.com/x#y'), 'https://a.com/x');
  for (const c of cases) assert.equal(view.normalizeUrl(c), M.normalizeUrl(c), c);
});

function twoSpaces() {
  let s = M.defaultState();
  s = M.createSpace(s, { id: 'work', name: 'Work', emoji: '💼', color: '#0984e3' });
  return s;
}

test('assign new tab: joins its window\'s active space', () => {
  let s = twoSpaces();
  s = M.setActiveSpace(s, 1, 'work');
  s = M.upsertTab(s, tab(10, 1, 'https://a.com'), 0);
  s = M.upsertTab(s, tab(11, 2, 'https://b.com'), 0);
  assert.equal(s.tabSpace[10], 'work');
  assert.equal(s.tabSpace[11], 'personal');
});

test('assign new tab: an existing assignment is kept on update', () => {
  let s = twoSpaces();
  s = M.upsertTab(s, tab(10, 1, 'https://a.com'), 0);
  s = M.moveTab(s, 10, 'work');
  s = M.upsertTab(s, tab(10, 1, 'https://a.com/next', { title: 'Next' }), 5);
  assert.equal(s.tabSpace[10], 'work');
  assert.equal(s.tabs[10].title, 'Next');
});

test('move tab: to a known space only, and only if the tab exists', () => {
  let s = twoSpaces();
  s = M.upsertTab(s, tab(10, 1, 'https://a.com'), 0);
  assert.equal(M.moveTab(s, 10, 'work').tabSpace[10], 'work');
  assert.equal(M.moveTab(s, 10, 'nope'), s);
  assert.equal(M.moveTab(s, 99, 'work'), s);
});

test('removeTab drops snapshot and assignment', () => {
  let s = M.upsertTab(M.defaultState(), tab(10, 1, 'https://a.com'), 0);
  s = M.removeTab(s, 10);
  assert.deepEqual(s.tabs, {});
  assert.deepEqual(s.tabSpace, {});
});

test('activateTab flips active within one window and stamps lastActive', () => {
  let s = M.defaultState();
  s = M.upsertTab(s, tab(1, 1, 'a', { active: true }), 0);
  s = M.upsertTab(s, tab(2, 1, 'b'), 0);
  s = M.upsertTab(s, tab(3, 2, 'c', { active: true }), 0);
  s = M.activateTab(s, 2, 1, 100);
  assert.equal(s.tabs[1].active, false);
  assert.equal(s.tabs[1].lastActive, 100);
  assert.equal(s.tabs[2].active, true);
  assert.equal(s.tabs[3].active, true);
});

test('pins: dedupe per space by URL, remove by id', () => {
  let s = twoSpaces();
  s = M.addPin(s, { id: 'p1', spaceId: 'work', url: 'https://a.com/', title: 'A' });
  s = M.addPin(s, { id: 'p2', spaceId: 'work', url: 'https://a.com#x', title: 'A' });
  s = M.addPin(s, { id: 'p3', spaceId: 'personal', url: 'https://a.com', title: 'A' });
  assert.deepEqual(s.pins.map((p) => p.id), ['p1', 'p3']);
  s = M.removePin(s, 'p1');
  assert.deepEqual(s.pins.map((p) => p.id), ['p3']);
});

test('rebuild after restart: tabs matching a pin go to its space, others to the active space', () => {
  let s = twoSpaces();
  s = M.addPin(s, { id: 'p1', spaceId: 'work', url: 'https://mail.example.com/', title: 'Mail' });
  // Stale ids from the previous session.
  s = M.upsertTab(s, tab(1, 1, 'https://old.example.com'), 0);
  s = M.moveTab(s, 1, 'work');
  s = M.setActiveSpace(s, 1, 'work');
  const reopened = [tab(1, 7, 'https://news.example.com'), tab(2, 7, 'https://mail.example.com')];
  const next = M.syncTabs(s, reopened, { fresh: true, now: 50 });
  assert.equal(next.tabSpace[1], 'personal', 'reused id 1 must not inherit the old assignment');
  assert.equal(next.tabSpace[2], 'work');
  assert.deepEqual(next.activeSpaceByWindow, {});
  assert.deepEqual(Object.keys(next.tabs).sort(), ['1', '2']);
});

test('sync on wake (not fresh): keeps assignments, drops closed tabs and windows, adds new tabs', () => {
  let s = twoSpaces();
  s = M.setActiveSpace(s, 1, 'work');
  s = M.setActiveSpace(s, 9, 'work');
  s = M.upsertTab(s, tab(1, 1, 'https://a.com'), 0);
  s = M.upsertTab(s, tab(2, 1, 'https://b.com'), 0);
  s = M.moveTab(s, 2, 'personal');
  const next = M.syncTabs(s, [tab(2, 1, 'https://b.com'), tab(3, 1, 'https://c.com')], { now: 1 });
  assert.deepEqual(next.tabSpace, { 2: 'personal', 3: 'work' });
  assert.deepEqual(next.activeSpaceByWindow, { 1: 'work' });
});

test('spaces: create and update (rename / emoji / recolor), blanks ignored', () => {
  let s = twoSpaces();
  assert.equal(s.spaces[1].name, 'Work');
  s = M.updateSpace(s, 'work', { name: ' Job ', color: '#ff0000', emoji: '' });
  assert.deepEqual(s.spaces[1], { id: 'work', name: 'Job', emoji: '💼', color: '#ff0000' });
  assert.equal(M.createSpace(s, { id: 'x', name: '  ' }).spaces[2].name, 'New space');
});

test('view.sidebar: shows the window\'s active space, pins separately, ordered by index', () => {
  let s = twoSpaces();
  s = M.addPin(s, { id: 'p1', spaceId: 'personal', url: 'https://mail.com', title: 'Mail' });
  s = M.upsertTab(s, tab(3, 1, 'https://c.com', { index: 2 }), 0);
  s = M.upsertTab(s, tab(1, 1, 'https://mail.com/', { index: 0, active: true }), 0);
  s = M.upsertTab(s, tab(2, 1, 'https://b.com', { index: 1 }), 0);
  s = M.upsertTab(s, tab(4, 2, 'https://d.com'), 0);
  s = M.moveTab(s, 2, 'work');
  const v = view.sidebar(s, 1);
  assert.equal(v.spaceId, 'personal');
  assert.deepEqual(v.tabs.map((t) => t.id), [3]);
  assert.equal(v.pins[0].tabId, 1);
  assert.equal(v.pins[0].active, true);
  assert.deepEqual(view.sidebar(M.setActiveSpace(s, 1, 'work'), 1).tabs.map((t) => t.id), [2]);
});

test('delete space: tabs, pins, archive and windows move to the first remaining space', () => {
  let s = twoSpaces();
  s = M.createSpace(s, { id: 'fun', name: 'Fun' });
  s = M.upsertTab(s, tab(1, 1, 'https://a.com'), 0);
  s = M.upsertTab(s, tab(2, 1, 'https://b.com'), 0);
  s = M.moveTab(s, 1, 'work');
  s = M.setActiveSpace(s, 1, 'work');
  s = M.addPin(s, { id: 'p1', spaceId: 'work', url: 'https://x.com', title: 'X' });
  s = M.addPin(s, { id: 'p2', spaceId: 'work', url: 'https://dup.com', title: 'Dup' });
  s = M.addPin(s, { id: 'p3', spaceId: 'personal', url: 'https://dup.com/', title: 'Dup' });
  s = M.archiveTab(s, { id: 'a1', url: 'https://old.com', spaceId: 'work', closedAt: 1 });
  const next = M.deleteSpace(s, 'work');
  assert.deepEqual(next.spaces.map((x) => x.id), ['personal', 'fun']);
  assert.deepEqual(next.tabSpace, { 1: 'personal', 2: 'personal' });
  assert.deepEqual(next.activeSpaceByWindow, { 1: 'personal' });
  assert.deepEqual(next.pins.map((p) => [p.id, p.spaceId]).sort(), [['p1', 'personal'], ['p3', 'personal']], 'duplicate pin collapses');
  assert.equal(next.archive[0].spaceId, 'personal');
});

test('delete space: deleting the first space moves things to the next; the last space stays', () => {
  let s = twoSpaces();
  s = M.upsertTab(s, tab(1, 1, 'https://a.com'), 0);
  const next = M.deleteSpace(s, 'personal');
  assert.deepEqual(next.spaces.map((x) => x.id), ['work']);
  assert.equal(next.tabSpace[1], 'work');
  assert.equal(M.deleteSpace(next, 'work'), next);
  assert.equal(M.deleteSpace(next, 'missing'), next);
});

test('archive: newest first, one entry per URL, capped at 200', () => {
  let s = M.defaultState();
  for (let i = 0; i < 250; i++) s = M.archiveTab(s, { id: `a${i}`, url: `https://x.com/${i}`, spaceId: 'personal', closedAt: i });
  assert.equal(s.archive.length, M.ARCHIVE_CAP);
  assert.equal(s.archive[0].id, 'a249');
  assert.equal(s.archive.at(-1).id, 'a50');
  s = M.archiveTab(s, { id: 'again', url: 'https://x.com/100#frag', closedAt: 999 });
  assert.equal(s.archive.length, M.ARCHIVE_CAP);
  assert.equal(s.archive.filter((a) => a.url.startsWith('https://x.com/100')).length, 1);
  assert.equal(s.archive[0].id, 'again');
  assert.equal(M.archiveTab(s, { id: 'x', url: '' }), s);
  assert.equal(M.removeArchived(s, 'again').archive.length, M.ARCHIVE_CAP - 1);
});

test('auto-archive: only inactive, unpinned web tabs past the threshold', () => {
  const H = 3600_000;
  let s = M.defaultState(); // archiveAfterHours: 12
  const add = (id, url, lastActive, extra = {}) => {
    s = M.upsertTab(s, { id, windowId: 1, index: id, url, title: `t${id}`, ...extra }, lastActive);
  };
  add(1, 'https://old.com', 0);
  add(2, 'https://recent.com', 11 * H);
  add(3, 'https://pinned.com', 0);
  add(4, 'chrome://settings', 0);
  add(5, 'https://active.com', 0, { active: true });
  s = { ...s, tabs: { ...s.tabs, 5: { ...s.tabs[5], lastActive: 0 } } }; // active wins even if old
  s = M.addPin(s, { id: 'p', spaceId: 'personal', url: 'https://pinned.com/', title: 'P' });
  const now = 13 * H;
  assert.deepEqual(M.staleTabs(s, now).map((t) => t.id), [1]);
  // Pinned in another space doesn't protect it.
  s = M.createSpace(s, { id: 'work', name: 'Work' });
  s = M.moveTab(s, 3, 'work');
  assert.deepEqual(M.staleTabs(s, now).map((t) => t.id).sort(), [1, 3]);
  // Disabled with 0.
  assert.deepEqual(M.staleTabs({ ...s, settings: { ...s.settings, archiveAfterHours: 0 } }, now), []);
  const entry = M.archiveEntryForTab(s, s.tabs[3], { id: 'x', closedAt: now });
  assert.deepEqual(entry, { id: 'x', url: 'https://pinned.com', title: 't3', favIconUrl: '', spaceId: 'work', closedAt: now });
});
