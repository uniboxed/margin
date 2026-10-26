import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../extension/state/model.js';
import { PROFILES } from '../extension/shared/platform.js';
import * as shortcuts from '../extension/shared/shortcuts.js';
import * as view from '../extension/shared/view.js';

const M = model;
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
  s = M.upsertTab(s, tab(9, 2, 'https://first.com'), 0); // window 2 already open
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

test('view.guessWindow: picks the window before the background answers', () => {
  let s = M.defaultState();
  assert.equal(view.guessWindow(s, 'https://a.com/'), null);
  s = M.upsertTab(s, tab(1, 5, 'https://a.com/'), 0);
  s = M.upsertTab(s, tab(2, 5, 'https://b.com/'), 0);
  assert.equal(view.guessWindow(s, 'https://zzz.com/'), 5, 'single window');
  s = M.upsertTab(s, tab(3, 9, 'https://b.com/', { active: true }), 10);
  s = M.upsertTab(s, tab(4, 7, 'https://c.com/', { active: true }), 20);
  assert.equal(view.guessWindow(s, 'https://b.com/'), 9, 'URL match, active wins');
  assert.equal(view.guessWindow(s, 'https://nowhere.com/'), 7, 'most recently active window');
});

const activeIn = (s, windowId) => Object.values(s.tabs).filter((t) => t.windowId === windowId && t.active).map((t) => t.id);

test('active tab: a late update for a tab you left does not re-highlight it', () => {
  let s = M.defaultState();
  s = M.upsertTab(s, tab(1, 1, 'https://a.com', { active: true }), 0);
  s = M.upsertTab(s, tab(2, 1, 'https://b.com'), 0);
  s = M.activateTab(s, 2, 1, 10);
  // Safari: tab 1 finishes loading after the switch, update still says active.
  s = M.upsertTab(s, tab(1, 1, 'https://a.com', { active: true, title: 'A loaded' }), 11);
  assert.deepEqual(activeIn(s, 1), [2]);
  assert.equal(s.tabs[1].title, 'A loaded', 'the rest of the update still applies');
});

test('active tab: a new focused tab takes over even without onActivated', () => {
  let s = M.defaultState();
  s = M.upsertTab(s, tab(1, 1, 'https://a.com', { active: true }), 0);
  s = M.upsertTab(s, tab(9, 2, 'https://other-window.com', { active: true }), 0);
  s = M.upsertTab(s, tab(2, 1, '', { active: true }), 5); // e.g. ⌘T
  assert.deepEqual(activeIn(s, 1), [2]);
  assert.deepEqual(activeIn(s, 2), [9], 'other windows untouched');
  // A new background tab doesn't steal it.
  s = M.upsertTab(s, tab(3, 1, 'https://c.com', { active: false }), 6);
  assert.deepEqual(activeIn(s, 1), [2]);
});

test('active tab: activation without a windowId uses the tab\'s window; at most one per window', () => {
  let s = M.defaultState();
  for (const id of [1, 2, 3]) s = M.upsertTab(s, tab(id, 1, `https://${id}.com`, { active: id === 1 }), 0);
  s = M.activateTab(s, 3, undefined, 5);
  assert.deepEqual(activeIn(s, 1), [3]);
  assert.equal(M.activateTab(s, 99, undefined, 6), s, 'unknown tab, unknown window: no change');
  // Activated before it was created: the create event then highlights it alone.
  s = M.activateTab(s, 4, 1, 7);
  s = M.upsertTab(s, tab(4, 1, 'https://4.com', { active: true }), 7);
  assert.deepEqual(activeIn(s, 1), [4]);
});

test('view.sidebar: the tab the sidebar is drawn in is the highlighted one', () => {
  let s = M.defaultState();
  s = M.upsertTab(s, tab(1, 1, 'https://a.com', { active: true }), 0);
  s = M.upsertTab(s, tab(2, 1, 'https://b.com'), 0);
  // Stale snapshot: background still thinks 1 is active, but we're on 2.
  const active = (v) => v.tabs.filter((t) => t.active).map((t) => t.id);
  assert.deepEqual(active(view.sidebar(s, 1, 2)), [2]);
  assert.deepEqual(active(view.sidebar(s, 1)), [1], 'without a current tab, the snapshot decides');
  assert.deepEqual(active(view.sidebar(s, 1, 99)), [1], 'unknown current tab: snapshot decides');
});

test('view.isFullscreenWindow: the window covers the whole screen (a maximized one leaves the menu bar)', () => {
  const screen = { screenWidth: 1512, screenHeight: 982 };
  assert.equal(view.isFullscreenWindow({ outerWidth: 1512, outerHeight: 982, ...screen }), true);
  assert.equal(view.isFullscreenWindow({ outerWidth: 1512, outerHeight: 949, ...screen }), false, 'Window → Fill / maximized');
  assert.equal(view.isFullscreenWindow({ outerWidth: 1200, outerHeight: 800, ...screen }), false);
});

test('view.revealZone: wider in a full-screen window, where Safari reveals its own sidebar at the edge', () => {
  const screen = { screenWidth: 1512, screenHeight: 982 };
  assert.equal(view.revealZone({ outerWidth: 1512, outerHeight: 982, ...screen }), 24, 'full screen');
  assert.equal(view.revealZone({ outerWidth: 1512, outerHeight: 949, ...screen }), 10, 'Window → Fill (menu bar visible)');
  assert.equal(view.revealZone({ outerWidth: 1200, outerHeight: 800, ...screen }), 10, 'normal window');
});

test('view.cycleTab: sidebar order (open pins, then tabs), wrapping', () => {
  let s = M.defaultState();
  s = M.createSpace(s, { id: 'work', name: 'Work' });
  s = M.addPin(s, { id: 'p', spaceId: 'personal', url: 'https://pin.com', title: 'Pin' });
  s = M.addPin(s, { id: 'closed', spaceId: 'personal', url: 'https://closed.com', title: 'Closed pin' });
  s = M.upsertTab(s, tab(1, 1, 'https://a.com', { index: 1 }), 0);
  s = M.upsertTab(s, tab(2, 1, 'https://pin.com', { index: 2 }), 0);
  s = M.upsertTab(s, tab(3, 1, 'https://c.com', { index: 3 }), 0);
  s = M.upsertTab(s, tab(4, 1, 'https://work.com', { index: 0 }), 0);
  s = M.moveTab(s, 4, 'work');
  // Order: pin tab 2, then tabs 1, 3 (tab 4 is in another space).
  assert.equal(view.cycleTab(s, 1, 2, 1), 1);
  assert.equal(view.cycleTab(s, 1, 1, 1), 3);
  assert.equal(view.cycleTab(s, 1, 3, 1), 2, 'wraps to the top');
  assert.equal(view.cycleTab(s, 1, 2, -1), 3, 'wraps to the bottom');
  assert.equal(view.cycleTab(s, 1, 4, 1), 2, 'from outside the list: first');
  assert.equal(view.cycleTab(s, 1, 4, -1), 3, 'from outside the list: last');
  const lone = M.removeTab(M.removeTab(s, 1), 3);
  assert.equal(view.cycleTab(lone, 1, 2, 1), null, 'only one tab: stay');
});

test('view.cycleSpace: next/previous space per window, wrapping', () => {
  let s = M.defaultState();
  assert.equal(view.cycleSpace(s, 1, 1), null, 'one space');
  s = M.createSpace(s, { id: 'work', name: 'Work' });
  s = M.createSpace(s, { id: 'fun', name: 'Fun' });
  assert.equal(view.cycleSpace(s, 1, 1), 'work');
  assert.equal(view.cycleSpace(s, 1, -1), 'fun', 'wraps');
  s = M.setActiveSpace(s, 1, 'fun');
  assert.equal(view.cycleSpace(s, 1, 1), 'personal', 'wraps');
  assert.equal(view.cycleSpace(s, 2, 1), 'work', 'other window keeps its own space');
});

test('favicons: pick the best icon link, else /favicon.ico', () => {
  const page = 'https://example.com/a/b';
  const L = (rel, href, extra = {}) => ({ rel, href, ...extra });
  assert.equal(view.pickIconHref([], page), 'https://example.com/favicon.ico');
  assert.equal(view.pickIconHref([], 'about:blank'), null, 'non-web page');
  assert.equal(view.pickIconHref([
    L('apple-touch-icon', 'https://example.com/apple.png'),
    L('icon', 'https://example.com/big.png', { sizes: '192x192' }),
    L('icon', 'https://example.com/32.png', { sizes: '32x32' }),
  ], page), 'https://example.com/32.png');
  assert.equal(view.pickIconHref([
    L('icon', 'https://example.com/32.png', { sizes: '32x32' }),
    L('icon', 'https://cdn.example.com/i.svg', { type: 'image/svg+xml' }),
  ], page), 'https://cdn.example.com/i.svg', 'scalable wins');
  assert.equal(view.pickIconHref([L('shortcut icon', 'https://example.com/f.ico')], page), 'https://example.com/f.ico');
  assert.equal(view.pickIconHref([L('apple-touch-icon', 'https://example.com/apple.png')], page), 'https://example.com/apple.png');
  assert.equal(view.pickIconHref([L('icon', 'javascript:alert(1)'), L('stylesheet', 'https://example.com/s.css')], page), 'https://example.com/favicon.ico');
  assert.equal(view.pickIconHref([L('icon', 'data:image/png;base64,AAAA')], page), 'data:image/png;base64,AAAA');
});

test('favicons: browser icon first, else the fetched one for that site; cache is capped', () => {
  let s = M.defaultState();
  s = M.rememberFavicon(s, 'https://a.com', { data: 'data:image/png;base64,AA', href: 'https://a.com/favicon.ico', at: 1 });
  assert.equal(view.iconFor(s, { url: 'https://a.com/page', favIconUrl: '' }), 'data:image/png;base64,AA', 'Safari: empty favIconUrl');
  assert.equal(view.iconFor(s, { url: 'https://a.com/page', favIconUrl: 'https://a.com/x.png' }), 'https://a.com/x.png', 'browser icon wins');
  assert.equal(view.iconFor(s, { url: 'https://b.com/', favIconUrl: '' }), '', 'unknown site: letter avatar');
  assert.equal(view.iconFor(s, { url: 'chrome://settings' }), '');
  for (let i = 0; i < 10; i++) s = M.rememberFavicon(s, `https://s${i}.com`, { data: 'd', href: 'h', at: 10 + i }, 5);
  assert.deepEqual(Object.keys(s.favicons).sort(), ['https://s5.com', 'https://s6.com', 'https://s7.com', 'https://s8.com', 'https://s9.com']);
  assert.equal(M.rememberFavicon(s, null, { data: 'd', at: 1 }), s);
});

test('new window (⌘N) starts in the space of the most recently used window', () => {
  let s = M.defaultState();
  s = M.createSpace(s, { id: 'work', name: 'Work' });
  s = M.upsertTab(s, tab(1, 1, 'https://a.com', { active: true }), 10);
  s = M.upsertTab(s, tab(2, 2, 'https://b.com', { active: true }), 5); // another window, Personal
  s = M.setActiveSpace(s, 1, 'work');
  s = M.activateTab(s, 1, 1, 20); // window 1 used last
  s = M.upsertTab(s, tab(3, 3, '', { active: true }), 30); // ⌘N
  assert.equal(s.activeSpaceByWindow[3], 'work');
  assert.equal(s.tabSpace[3], 'work', 'its first tab joins that space');
  // A new tab in an existing window doesn't change that window's space.
  s = M.upsertTab(s, tab(4, 2, '', { active: true }), 40);
  assert.equal(M.activeSpaceId(s, 2), 'personal');
  assert.equal(s.tabSpace[4], 'personal');
});

test('navigation shortcut defaults match shared/shortcuts.js; stored values merge with defaults', async () => {
  await import('../extension/shared/shortcuts.js');
  assert.deepEqual(M.DEFAULT_SETTINGS.shortcuts, shortcuts.NAVIGATION);
  const s = M.normalizeState({ settings: { shortcuts: { nextSpace: 'Alt+Shift+KeyL' } } });
  assert.equal(s.settings.shortcuts.nextSpace, 'Alt+Shift+KeyL');
  assert.equal(s.settings.shortcuts.nextTab, 'Ctrl+Meta+ArrowDown');
  const d = M.defaultState();
  d.settings.shortcuts.nextTab = 'x';
  assert.equal(M.DEFAULT_SETTINGS.shortcuts.nextTab, 'Ctrl+Meta+ArrowDown', 'defaults are not shared/mutated');
});

test('saved default shortcuts follow the build; customized ones stay', () => {
  const P = PROFILES;
  const safari = { shortcuts: { ...P.safari.navigation }, shortcutDefaults: 'safari' };
  // Saved by a version before per-browser builds (no marker): all ⌃⌘ defaults, one customized.
  const legacy = { shortcuts: { nextTab: 'Ctrl+Meta+ArrowDown', prevTab: 'Ctrl+Meta+ArrowUp', nextSpace: 'Alt+Shift+KeyL', prevSpace: 'Ctrl+Meta+ArrowLeft' } };
  assert.deepEqual(M.normalizeShortcuts(legacy, safari), {
    nextTab: 'Alt+Meta+ArrowDown', prevTab: 'Alt+Meta+ArrowUp', nextSpace: 'Alt+Shift+KeyL', prevSpace: 'Ctrl+Meta+ArrowLeft',
  });
  // Already on Safari's defaults: a deliberate ⌃⌘↓ is kept.
  const chosen = { shortcuts: { ...P.safari.navigation, nextTab: 'Ctrl+Meta+ArrowDown' }, shortcutDefaults: 'safari' };
  assert.equal(M.normalizeShortcuts(chosen, safari).nextTab, 'Ctrl+Meta+ArrowDown');
  // Safari's defaults loaded into the Chrome build: back to ⌃⌘.
  const chrome = { shortcuts: { ...P.chrome.navigation }, shortcutDefaults: 'chrome' };
  assert.deepEqual(M.normalizeShortcuts({ shortcuts: { ...P.safari.navigation }, shortcutDefaults: 'safari' }, chrome), P.chrome.navigation);
  // normalizeState records which defaults apply now.
  const s = M.normalizeState({ settings: legacy });
  assert.equal(s.settings.shortcutDefaults, 'chrome');
  assert.equal(s.settings.shortcuts.nextSpace, 'Alt+Shift+KeyL');
});
