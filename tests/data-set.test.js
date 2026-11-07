// Margin's lasting data set (DATA.md): the merge (shared/data-merge.js) on
// the JSON vectors Margin.app's Swift store runs too (tests/fixtures/
// data-merge), the data set from the state and back (shared/data-set.js), the
// converter from today's extension storage, and the queue of changes made
// while the app isn't linked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_FORMAT, changesFrom, isChange, mergeData, pruneTombstones } from '../extension/shared/data-merge.js';
import { COLLECTIONS, SOURCES, TOMBSTONE_CAP, TOMBSTONE_MS, collectionFrom, dataSetFrom, dataSetFromStorage, fingerprint, itemsFrom, metaKey, pendingChanges, stateFromDataSet, track } from '../extension/shared/data-set.js';
import * as M from '../extension/state/model.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const VECTORS = path.join(here, 'fixtures', 'data-merge');

// ---- the merge, on the shared vectors ----------------------------------------------

const vectors = fs.readdirSync(VECTORS).filter((f) => f.endsWith('.json')).sort();
test('the merge vectors are there (the Swift store runs the same files)', () => {
  assert.ok(vectors.length >= 8, vectors.join(', '));
});
for (const file of vectors) {
  const v = JSON.parse(fs.readFileSync(path.join(VECTORS, file), 'utf8'));
  test(`merge vector ${file}: ${v.description}`, () => {
    const before = JSON.stringify(v);
    assert.deepEqual(mergeData(v.base, v.changes), v.expected);
    assert.equal(JSON.stringify(v), before, 'its inputs untouched');
  });
}

test('merge: one whole set into another is the merge of its items as changes; tombstones older than a time can be pruned', () => {
  const a = { format: 1, items: { spaces: { s1: { updatedAt: 5, value: { name: 'A' } } }, pins: { p1: { updatedAt: 1, deleted: true } } } };
  const b = { format: 1, items: { spaces: { s1: { updatedAt: 9, value: { name: 'B' } }, s2: { updatedAt: 2, value: { name: 'C' } } } } };
  assert.deepEqual(changesFrom(b).map((c) => [c.collection, c.id]), [['spaces', 's1'], ['spaces', 's2']]);
  const merged = mergeData(a, changesFrom(b));
  assert.deepEqual(merged.items.spaces, b.items.spaces);
  assert.deepEqual(merged.items.pins, a.items.pins);
  assert.deepEqual(pruneTombstones(merged, 2).items.pins, {}, 'older than 2: gone');
  assert.deepEqual(pruneTombstones(merged, 1).items.pins, a.items.pins);
  assert.equal(merged.format, DATA_FORMAT);
  assert.equal(isChange({ collection: 'x', id: 'y', updatedAt: 1, value: null }), true, 'a null value is a value');
});

// ---- the data set from the state ------------------------------------------------------

function sampleState() {
  let s = M.defaultState();
  s = M.createSpace(s, { id: 'work', name: 'Work', emoji: '💼', color: '#0984e3' });
  s = M.upsertTab(M.setActiveSpace(s, 1, 'work'), { id: 1, windowId: 1, index: 0, url: 'https://a.test/', title: 'A', active: true }, 100);
  s = M.upsertTab(s, { id: 2, windowId: 1, index: 1, url: 'https://b.test/', title: 'B' }, 100);
  s = M.upsertTab(s, { id: 3, windowId: 1, index: 2, url: 'safari-web-extension://x/newtab/newtab.html', title: 'New Tab' }, 100);
  s = M.closedTab(s, 2, { windowClosing: true, now: 200, archiveId: 'x' });
  s = M.addPin(s, { id: 'p1', spaceId: 'work', url: 'https://pin.test/', title: 'Pin' });
  s = M.createFolder(s, { id: 'f1', spaceId: 'work', name: 'Read', pinIds: ['p1'] });
  s = M.archiveTab(s, { id: 'a1', url: 'https://old.test/', title: 'Old', spaceId: 'work', favIconUrl: '', closedAt: 50 });
  s = M.rememberFavicon(s, 'https://a.test', { data: 'data:image/png;base64,AAAA', href: 'https://a.test/favicon.ico', at: 60 });
  s = { ...s, settings: { ...s.settings, archiveAfterHours: 24, themes: { ...s.settings.themes, arcadia: { sidebarWidth: 300 } } } };
  return s;
}

test('the data set\'s items: spaces in order, pins by address, folders, Margin\'s tabs open or not (web pages only, by their own ids), the archive, settings, theme settings, site icons; nothing of the browser\'s ids', () => {
  const s = sampleState();
  const items = itemsFrom(s);
  assert.deepEqual(Object.keys(items), Object.keys(SOURCES));
  assert.deepEqual(items.spaces, { personal: { name: 'Personal', emoji: '🏠', color: '#6c5ce7', order: 0 }, work: { name: 'Work', emoji: '💼', color: '#0984e3', order: 1 } });
  assert.deepEqual(items.pins, { p1: { spaceId: 'work', url: 'https://pin.test/', title: 'Pin', folderId: 'f1', pos: 0 } });
  assert.deepEqual(items.folders, { f1: { spaceId: 'work', name: 'Read', open: true, pos: 0 } });
  const a = s.tabs[1];
  const b = Object.values(s.keptTabs)[0];
  assert.deepEqual(items.tabs, {
    [a.mid]: { url: 'https://a.test/', title: 'A', icon: '', spaceId: 'work', order: a.order, lastUsed: a.lastActive },
    [b.id]: { url: 'https://b.test/', title: 'B', icon: '', spaceId: 'work', order: b.order, lastUsed: b.lastActive },
  }, 'the new-tab page isn\'t a Margin tab worth keeping');
  assert.deepEqual(items.archive, { a1: { url: 'https://old.test/', title: 'Old', spaceId: 'work', icon: '', closedAt: 50 } });
  assert.equal(items.settings.archiveAfterHours, 24);
  assert.equal('themes' in items.settings, false, 'theme settings are their own collection');
  assert.deepEqual(items.themeSettings.arcadia, { sidebarWidth: 300 });
  assert.deepEqual(items.siteIcons, { 'https://a.test': { data: 'data:image/png;base64,AAAA', href: 'https://a.test/favicon.ico', at: 60 } });
  const text = JSON.stringify(items);
  assert.equal(text.includes('"windowId"'), false);
  assert.equal(/"tabId"|"wasTab"|activeSpaceByWindow/.test(text), false);
  assert.deepEqual(COLLECTIONS, [...Object.keys(SOURCES), 'userThemes']);
});

test('the converter (first link): today\'s extension storage as a data set, user themes too, times from the queue\'s meta where it has them', () => {
  const s = sampleState();
  const raw = {
    spaces: s.spaces, pins: s.pins, folders: s.folders, archive: s.archive, settings: s.settings, favicons: s.favicons,
    openTabs: { origin: 'safari-web-extension://x/', synced: true, tabs: s.tabs, tabSpace: s.tabSpace, activeSpaceByWindow: s.activeSpaceByWindow, keptTabs: s.keptTabs },
    'userTheme:mine': { format: 2, id: 'mine', version: '1.0.0', manifest: {}, html: '', css: '', files: {} },
    userThemes: [{ id: 'mine' }],
    [metaKey('spaces')]: { items: { personal: [0, 'x'], work: [777, 'y'] }, gone: { old: 700 } },
    owner: { origin: 'x', since: 1 },
  };
  const set = dataSetFromStorage(raw, { now: 5000 });
  assert.equal(set.format, 1);
  assert.deepEqual(Object.keys(set.items).sort(), [...COLLECTIONS].sort());
  assert.deepEqual(set.items.spaces.work, { updatedAt: 777, value: { name: 'Work', emoji: '💼', color: '#0984e3', order: 1 } });
  assert.equal(set.items.spaces.personal.updatedAt, 0, 'from before: 0');
  assert.deepEqual(set.items.spaces.old, { updatedAt: 700, deleted: true }, 'a tombstone');
  assert.equal(set.items.pins.p1.updatedAt, 5000, 'no meta: now');
  assert.deepEqual(Object.keys(set.items.tabs).sort(), Object.keys(itemsFrom(s).tabs).sort());
  assert.deepEqual(set.items.userThemes.mine.value.id, 'mine');
  assert.deepEqual(set.items.siteIcons['https://a.test'].value.at, 60);
  // An earlier build's storage (lost tabs, records without ids) converts too.
  const old = dataSetFromStorage({ spaces: s.spaces, tabs: { 9: { id: 9, windowId: 1, index: 0, url: 'https://x.test/', title: 'X' } }, tabSpace: { 9: 'work' }, lostTabs2: { windows: [{ key: 'k', at: 1, size: 1, tabs: [{ url: 'https://l.test/', spaceId: 'work', lastActive: 1, windowId: 3, index: 0 }] }] } }, { now: 9 });
  assert.deepEqual(Object.values(old.items.tabs).map((t) => t.value.url).sort(), ['https://l.test/', 'https://x.test/']);
});

test('the data set back into the state (the cache refilled): spaces, pins, folders, the archive, settings, icons; open tabs keep their browser tabs and take their space and place; the rest are kept tabs', () => {
  const s = sampleState();
  const set = dataSetFrom(s, { now: 1 });
  const wiped = M.defaultState();
  const refilled = stateFromDataSet({ ...wiped, tabs: { 1: s.tabs[1] }, tabSpace: { 1: 'personal' } }, set);
  assert.deepEqual(refilled.spaces, s.spaces);
  assert.deepEqual(refilled.pins.map((p) => [p.id, p.folderId]), [['p1', 'f1']]);
  assert.deepEqual(refilled.folders, [{ id: 'f1', spaceId: 'work', name: 'Read', open: true, pos: 0 }]);
  assert.deepEqual(refilled.archive, s.archive);
  assert.equal(refilled.settings.archiveAfterHours, 24);
  assert.deepEqual(refilled.settings.themes.arcadia, { sidebarWidth: 300 });
  assert.deepEqual(refilled.favicons, s.favicons);
  assert.equal(refilled.tabSpace[1], 'work', 'its Margin tab\'s space');
  assert.deepEqual(Object.keys(refilled.keptTabs), Object.keys(s.keptTabs), 'b, not open');
  assert.deepEqual(itemsFrom(refilled), itemsFrom(s), 'the same data set');
  // A deleted item isn't brought back.
  const without = mergeData(set, [{ collection: 'pins', id: 'p1', updatedAt: 2, deleted: true }]);
  assert.deepEqual(stateFromDataSet(s, without).pins, []);
});

test('the data set\'s spaces in place of the copy\'s: a tab in a space the set took away joins its window\'s space, or the first', () => {
  const wiped = M.defaultState();
  const set = { format: 1, items: { spaces: {
    home: { updatedAt: 1, value: { name: 'Home', emoji: '', color: '#000', order: 0 } },
    work: { updatedAt: 1, value: { name: 'Work', emoji: '', color: '#111', order: 1 } },
  } } };
  const early = { ...wiped, tabs: { 5: { id: 5, windowId: 1, url: 'https://a.test/' }, 6: { id: 6, windowId: 2, url: 'https://b.test/' } }, tabSpace: { 5: 'personal', 6: 'personal' }, activeSpaceByWindow: { 2: 'work' } };
  const next = stateFromDataSet(early, set);
  assert.deepEqual(next.spaces.map((x) => x.id), ['home', 'work']);
  assert.equal(next.tabSpace[5], 'home', 'its window has no space of the set\'s: the first');
  assert.equal(next.tabSpace[6], 'work', 'its window\'s space');
  assert.equal(stateFromDataSet(next, { items: { pins: {} } }).tabSpace, next.tabSpace, 'spaces untouched: tabs untouched');
});

// ---- the queue -------------------------------------------------------------------------

test('the queue: the first look starts every item at 0 (not queued); changes, new items and deletions get their times; the same values again change nothing', () => {
  const s = sampleState();
  const base = track(null, collectionFrom(s, 'pins'), 1000);
  assert.deepEqual(base.items.p1, [0, fingerprint(collectionFrom(s, 'pins').p1)]);
  assert.deepEqual(base.gone, {});
  assert.equal(track(base, collectionFrom(s, 'pins'), 2000), base, 'nothing changed: the same object (nothing written)');
  let next = M.addPin(s, { id: 'p2', spaceId: 'personal', url: 'https://two.test/', title: 'Two' });
  next = { ...next, pins: next.pins.map((p) => (p.id === 'p1' ? { ...p, title: 'Pin!' } : p)) };
  const changed = track(base, collectionFrom(next, 'pins'), 3000);
  assert.equal(changed.items.p1[0], 3000);
  assert.equal(changed.items.p2[0], 3000);
  const deleted = track(changed, collectionFrom(M.removePin(next, 'p1'), 'pins'), 4000);
  assert.deepEqual(deleted.gone, { p1: 4000 });
  assert.equal(deleted.items.p1, undefined);
  const back = track(deleted, collectionFrom(next, 'pins'), 5000);
  assert.deepEqual(back.gone, {}, 'made again: no longer a tombstone');
  assert.equal(back.items.p1[0], 5000);
  const metas = { pins: deleted };
  const items = { pins: collectionFrom(M.removePin(next, 'p1'), 'pins') };
  assert.deepEqual(pendingChanges(metas, items, 0), [
    { collection: 'pins', id: 'p2', updatedAt: 3000, value: items.pins.p2 },
    { collection: 'pins', id: 'p1', updatedAt: 4000, deleted: true },
  ], 'oldest first, the values as they are now');
  assert.deepEqual(pendingChanges(metas, items, 3000).map((c) => c.id), ['p1'], 'since the last change the app took');
});

test('the queue: a change in the same millisecond as the item\'s last time (or after a time ahead of this clock) still gets a newer one', () => {
  const s = sampleState();
  const base = track(null, collectionFrom(s, 'pins'), 1000);
  const renamed = (title) => collectionFrom({ ...s, pins: s.pins.map((p) => (p.id === 'p1' ? { ...p, title } : p)) }, 'pins');
  const first = track(base, renamed('One'), 3000);
  assert.equal(first.items.p1[0], 3000);
  assert.equal(track(first, renamed('Two'), 3000).items.p1[0], 3001, 'the same millisecond: just after');
  const ahead = { items: { ...first.items, p1: [9000, first.items.p1[1]] }, gone: {} };
  assert.equal(track(ahead, renamed('Three'), 3000).items.p1[0], 9001, 'after a time ahead of now');
  assert.equal(track(ahead, collectionFrom(M.removePin(s, 'p1'), 'pins'), 3000).gone.p1, 9001, 'a deletion too');
});

test('the queue\'s tombstones are kept TOMBSTONE_MS, at most TOMBSTONE_CAP per collection', () => {
  const gone = {};
  for (let i = 0; i < TOMBSTONE_CAP + 5; i++) gone[`x${i}`] = 10_000 + i;
  const meta = track({ items: {}, gone }, {}, 20_000);
  assert.equal(Object.keys(meta.gone).length, TOMBSTONE_CAP);
  assert.equal('x0' in meta.gone, false, 'the oldest go first');
  const later = track(meta, {}, 10_000 + TOMBSTONE_MS + 2003);
  assert.deepEqual(Object.keys(later.gone).sort(), ['x2003', 'x2004'].sort(), 'older than TOMBSTONE_MS: gone');
});

test('a wiped cache merged with the app\'s data: the app\'s data stays, the changes made since are taken (no defaults over the user\'s spaces)', () => {
  const app = { format: 1, items: { spaces: { personal: { updatedAt: 1_700_000_000_000, value: { name: 'Me', emoji: '🙂', color: '#e84393', order: 0 } } } } };
  const fresh = M.defaultState();
  const metas = Object.fromEntries(Object.keys(SOURCES).map((c) => [c, track(null, collectionFrom(fresh, c), 1)]));
  const queue = pendingChanges(metas, itemsFrom(fresh), 0);
  assert.deepEqual(queue, [], 'its defaults aren\'t changes');
  const merged = mergeData(app, queue);
  assert.equal(stateFromDataSet(fresh, merged).spaces[0].name, 'Me');
});
