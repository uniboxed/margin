import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../extension/state/model.js';
import '../extension/shared/view.js';

const { view } = globalThis.Margin;
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
