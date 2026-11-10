// What a page reads of storage.local (shared/stored.ts readForPage, from
// content/core.ts refresh): what a page draws from and the site icons once
// (never the theme's package, Margin.app's: Margin 2 Phase 2 step 7), then
// all but the icons unless their mark changed, and never a state other than
// a full read's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faviconsMark, firstReadKeys, fromStorage, readForPage, sameStored, toStorage, withChanges } from '../extension/shared/stored.ts';

const by = { origin: 'safari-web-extension://A/', since: 5, synced: true };
const icon = (i, at) => ({ data: `data:image/png;base64,${'iVBORw0KGgo'.repeat(220)}${i}`, href: `https://site${i}.test/f.png`, at });
const icons = (n, at = 1000) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`https://site${i}.test`, icon(i, at + i)]));
// storage.local over a Map, counting what each get returns.
function fakeStorage(values) {
  const map = new Map(Object.entries(values));
  const gets = [];
  const get = async (keys) => {
    const list = keys == null ? [...map.keys()] : [].concat(keys);
    const out = Object.fromEntries(list.filter((k) => map.has(k)).map((k) => [k, structuredClone(map.get(k))]));
    gets.push({ keys, bytes: JSON.stringify(out).length });
    return out;
  };
  return { map, gets, get, set: (out) => { for (const [k, v] of Object.entries(out)) map.set(k, structuredClone(v)); } };
}
const STATE = {
  tabs: { 1: { id: 1, windowId: 9, url: 'https://site1.test/', title: 'One' } },
  tabSpace: { 1: 'personal' },
  activeSpaceByWindow: { 9: 'personal' },
  spaces: [{ id: 'personal', name: 'Personal' }],
  pins: [],
  folders: [],
  archive: [],
  settings: { sidebarPinnedOpen: false },
  favicons: icons(120),
  lostTabs: { windows: [{ tabs: [{ url: 'https://lost.test/' }] }] },
};
const stored = () => ({ ...toStorage(STATE, Object.keys(STATE), by), owner: { origin: by.origin, since: 5 } });

test('page reads: the icons get a mark, and a new one whenever one is learned or fetched again', () => {
  const out = toStorage(STATE, ['favicons', 'tabs', 'spaces'], by);
  assert.equal(out.faviconsMark, faviconsMark(STATE.favicons));
  assert.equal('faviconsMark' in toStorage(STATE, ['tabs', 'settings'], by), false, 'only with the icons');
  const learned = { ...STATE.favicons, 'https://new.test': icon(999, 5000) };
  assert.notEqual(faviconsMark(learned), faviconsMark(STATE.favicons));
  const again = { ...STATE.favicons, 'https://site3.test': icon(3, 6000) };
  assert.notEqual(faviconsMark(again), faviconsMark(STATE.favicons), 'fetched again: same count, a new time');
  const { 'https://site0.test': _, ...capped } = learned;
  assert.notEqual(faviconsMark(capped), faviconsMark(STATE.favicons), 'one dropped for a newer one');
  assert.equal(faviconsMark(undefined), faviconsMark({}));
});

test('page reads: what pages use and the icons once, then all but the icons and what only the background reads, a small part of it', async () => {
  const storage = fakeStorage(stored());
  let state = null;
  const seen = new Set();
  const refresh = async () => {
    const raw = await readForPage(storage.get, () => state, seen);
    for (const key of Object.keys(raw)) seen.add(key);
    state = fromStorage(raw);
  };
  await refresh();
  assert.deepEqual(storage.gets[0].keys, firstReadKeys(), 'the first read: the page\'s keys, the icons, the link');
  for (const key of ['favicons', 'appLink', 'openTabs', 'settings']) assert.ok(storage.gets[0].keys.includes(key), key);
  const full = storage.gets[0].bytes;
  await refresh();
  const second = storage.gets[1];
  assert.equal(storage.gets.length, 2, 'one get');
  for (const key of ['favicons', 'lostTabs2', 'tabs', 'tabSpace', 'activeSpaceByWindow']) assert.equal(second.keys.includes(key), false, key);
  for (const key of ['openTabs', 'spaces', 'pins', 'folders', 'archive', 'settings', 'owner', 'showing', 'pageZoom', 'faviconsMark']) assert.equal(second.keys.includes(key), true, key);
  assert.ok(second.bytes < full / 20, `${second.bytes} bytes against ${full}`);
  const { lostTabs: _a, lostTabs2: _b, ...drawn } = fromStorage(storage.map.size ? Object.fromEntries(storage.map) : {});
  const { lostTabs: _c, lostTabs2: _d, ...page } = state;
  assert.deepEqual(page, drawn, 'what a full read gives a page, the icons too');
});

test('page reads: a key the page saw in an event is read again, one it never saw isn\'t; the icons are read again once their mark changed', async () => {
  const storage = fakeStorage({ ...stored(), later: { a: 1 } });
  let state = null;
  const seen = new Set();
  const refresh = async () => {
    const raw = await readForPage(storage.get, () => state, seen);
    for (const key of Object.keys(raw)) seen.add(key);
    state = fromStorage(raw);
  };
  await refresh();
  assert.equal(state.later, undefined, 'not a page\'s key: not read');
  seen.add('fromAnEvent');
  storage.set({ fromAnEvent: 7 });
  await refresh();
  assert.equal(state.fromAnEvent, 7);
  // An icon learned while the page missed the event (suspended).
  const learned = { ...STATE, favicons: { ...STATE.favicons, 'https://new.test': icon(999, 9000) } };
  storage.set(toStorage(learned, ['favicons'], by));
  const before = storage.gets.length;
  await refresh();
  assert.equal(storage.gets.length, before + 2, 'the rest, then the icons');
  assert.deepEqual(storage.gets.at(-1).keys, ['favicons']);
  assert.equal(state.favicons['https://new.test'].at, 9000);
  await refresh();
  assert.equal(storage.gets.length, before + 3, 'and then not again');
});

test('page reads: the theme\'s package (Margin.app\'s) is never read, however big; the first read costs what the state does', async () => {
  // Neubrutalism's package is about 330 KB stored; a user theme can be 3 MB (themes/README.md).
  const uiTheme = { id: 'big', version: '1', pkg: { id: 'big', manifest: '{}', html: '<div></div>', css: '', files: { 'fonts/a.woff2': 'A'.repeat(3_000_000) } } };
  const storage = fakeStorage({ ...stored(), uiTheme, 'dataMeta:link': { profile: 'p-x', acked: 3 } });
  let state = null;
  const seen = new Set();
  for (let i = 0; i < 3; i++) {
    const raw = await readForPage(storage.get, () => state, seen);
    for (const key of Object.keys(raw)) seen.add(key);
    state = fromStorage(raw);
    assert.equal('uiTheme' in raw, false, `read ${i + 1}: no theme package`);
    assert.equal('dataMeta:link' in raw, false, `read ${i + 1}: nor the link's data meta`);
  }
  const everything = JSON.stringify(Object.fromEntries(storage.map)).length;
  assert.ok(storage.gets[0].bytes < everything - 3_000_000, `${storage.gets[0].bytes} bytes against ${everything} for all of storage`);
  assert.equal(state.spaces[0].name, 'Personal');
});

test('page reads: the open tabs still under their old names (just updated): read with them', async () => {
  const { openTabs, ...rest } = stored();
  const storage = fakeStorage({ ...rest, tabs: openTabs.tabs, tabSpace: openTabs.tabSpace, activeSpaceByWindow: openTabs.activeSpaceByWindow });
  let state = null;
  for (let i = 0; i < 2; i++) state = fromStorage(await readForPage(storage.get, () => state));
  assert.equal(storage.gets.length, 4, 'each read, then the old names with the icons');
  for (const i of [1, 3]) assert.ok(storage.gets[i].keys.includes('tabs') && storage.gets[i].keys.includes('favicons'), `read ${i}: the old names`);
  assert.equal(state.tabs[1].title, 'One');
});

test('page reads: an icon learned after storage answered, its event taken before the read is back: the page keeps the newer icons', async () => {
  const storage = fakeStorage(stored());
  let state = null;
  state = fromStorage(await readForPage(storage.get, () => state));
  const learned = { ...STATE, favicons: { ...STATE.favicons, 'https://new.test': icon(999, 9000) } };
  const get = async (keys) => {
    const got = await storage.get(keys);
    const out = toStorage(learned, ['favicons'], by);
    storage.set(out);
    state = withChanges(state, Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { newValue: v }])));
    return got;
  };
  state = fromStorage(await readForPage(get, () => state));
  assert.equal(state.favicons['https://new.test']?.at, 9000, 'not the icons from before the event');
  assert.equal(state.faviconsMark, storage.map.get('faviconsMark'), 'with their own mark');
});

// Any run of writes, events taken or missed (Safari suspends hidden tabs, and
// they miss events), reads at any point, an event arriving while a read is
// on its way: once read, the page has what a full read gives.
test('page reads: after any run of writes, events taken or missed, a read gives what a full read would', async () => {
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (list) => list[Math.floor(random() * list.length)];
  let at = 10_000;
  const value = (key, full) => {
    switch (key) {
      case 'tabs': return { [Math.floor(random() * 3)]: { id: 1, windowId: 9, url: `https://${Math.floor(random() * 5)}.test/` } };
      case 'favicons': {
        const next = { ...full.favicons, [`https://site${Math.floor(random() * 6)}.test`]: icon(1, at++) };
        return Object.fromEntries(Object.entries(next).slice(-4)); // a cap
      }
      default: return { n: random() };
    }
  };
  const KEYS = ['tabs', 'spaces', 'settings', 'favicons', 'favicons', 'pins', 'archive'];
  for (let run = 0; run < 150; run++) {
    const full = { tabs: {}, tabSpace: {}, activeSpaceByWindow: {}, spaces: [{ id: 'a' }], favicons: {}, settings: {} };
    const storage = fakeStorage(toStorage(full, Object.keys(full), by));
    let state = null;
    const seen = new Set();
    let pending = null; // an event on its way during a read
    const take = (changes) => {
      for (const key of Object.keys(changes)) seen.add(key);
      if (state) state = withChanges(state, changes);
    };
    const write = () => {
      const keys = [...new Set(Array.from({ length: 1 + Math.floor(random() * 2) }, () => pick(KEYS)))];
      for (const key of keys) full[key] = value(key, full);
      const out = toStorage(full, keys, by);
      const changes = Object.fromEntries(Object.entries(out).filter(([k, v]) => !sameStored(v, storage.map.get(k))).map(([k, v]) => [k, { newValue: v }]));
      storage.set(out);
      return changes;
    };
    for (let step = 0; step < 14; step++) {
      const changes = write();
      const fate = random();
      if (fate < 0.5) take(changes); // taken
      else if (fate < 0.7) pending = changes; // comes while the next read is on its way
      // else missed
      if (random() < 0.5) {
        let during = false;
        const get = async (keys) => {
          const got = await storage.get(keys);
          if (pending) {
            take(pending);
            pending = null;
            during = true;
          }
          // A write after storage answered, its event taken before the read is back.
          if (random() < 0.15) {
            take(write());
            during = true;
          }
          return got;
        };
        const raw = await readForPage(get, () => state, seen);
        for (const key of Object.keys(raw)) seen.add(key);
        state = fromStorage(raw);
        // An event taken during a read: core.ts reads again (staleRead), and
        // that read has to be right; otherwise this one.
        if (during) state = fromStorage(await readForPage(storage.get, () => state, seen));
        const { lostTabs: _a, ...page } = state;
        const { lostTabs: _b, ...drawn } = fromStorage(Object.fromEntries(storage.map));
        assert.deepEqual(page, drawn, `run ${run}, step ${step}`);
      }
    }
  }
});

test('page reads: icons a build before the mark kept are written again with it once, by the copy that owns the state', async () => {
  const local = new Map(Object.entries({ spaces: [{ id: 'personal', name: 'Personal' }], favicons: icons(3) }));
  const area = (map) => ({
    get: async (keys) => Object.fromEntries((keys == null ? [...map.keys()] : [].concat(keys)).filter((k) => map.has(k)).map((k) => [k, structuredClone(map.get(k))])),
    set: async (values) => { for (const [k, v] of Object.entries(values)) map.set(k, structuredClone(v)); },
    remove: async (keys) => { for (const k of [].concat(keys)) map.delete(k); },
  });
  globalThis.chrome = ({ runtime: { getURL: (path) => `safari-web-extension://MARK/${path}` }, storage: { local: area(local), session: area(new Map()), onChanged: { addListener() {} } } } as any);
  const store = await import('../extension/background/store.ts?marks');
  await store.load();
  for (let i = 0; i < 20 && !local.has('faviconsMark'); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(local.get('faviconsMark'), faviconsMark(icons(3)));
  assert.deepEqual(local.get('favicons'), icons(3), 'the icons as they were');
});

// Safari writes one set()'s keys in no set order (a hash map's) and stops at
// the first that fails (SQLite busy while two copies write), firing events
// only for the keys written. Here: last key first, and the icons' row fails
// once. The stored mark is never one of icons not stored; a page that missed
// the events still gets the new icon once the write is through.
test('page reads: a new mark is stored only once its icons are, whatever order Safari writes a set() in', async () => {
  const local = new Map(Object.entries({ spaces: [{ id: 'personal', name: 'Personal' }], favicons: icons(3), faviconsMark: faviconsMark(icons(3)) }));
  const marks = new Set([faviconsMark(icons(3))]); // of every icons stored so far
  const calls = [];
  const ahead = []; // a stored mark of icons not stored
  let failIcons = false;
  const get = async (keys) => Object.fromEntries((keys == null ? [...local.keys()] : [].concat(keys)).filter((k) => local.has(k)).map((k) => [k, structuredClone(local.get(k))]));
  const area = (map, watched) => ({
    get: async (keys) => Object.fromEntries((keys == null ? [...map.keys()] : [].concat(keys)).filter((k) => map.has(k)).map((k) => [k, structuredClone(map.get(k))])),
    set: async (values) => {
      if (watched) calls.push(Object.keys(values));
      try {
        for (const key of Object.keys(values).reverse()) {
          if (watched && key === 'favicons' && failIcons) {
            failIcons = false;
            throw new Error('database is locked');
          }
          map.set(key, structuredClone(values[key]));
          if (watched && key === 'favicons') marks.add(faviconsMark(values[key]));
        }
      } finally {
        if (watched && map.has('faviconsMark') && !marks.has(map.get('faviconsMark'))) ahead.push(map.get('faviconsMark'));
      }
    },
    remove: async (keys) => { for (const k of [].concat(keys)) map.delete(k); },
  });
  globalThis.chrome = ({ runtime: { getURL: (path) => `safari-web-extension://ORDER/${path}` }, storage: { local: area(local, true), session: area(new Map(), false), onChanged: { addListener() {} } } } as any);
  const store = await import('../extension/background/store.ts?order');
  await store.load();
  // A page that has read everything once, then misses every event.
  let page = fromStorage(await readForPage(get, () => null));
  failIcons = true;
  const learned = icon(999, 9000);
  await store.mutate((state) => ({ ...state, favicons: { ...state.favicons, 'https://new.test': learned } }));
  page = fromStorage(await readForPage(get, () => page)); // during the retry's wait
  for (let i = 0; i < 100 && local.get('faviconsMark') !== faviconsMark({ ...icons(3), 'https://new.test': learned }); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(ahead, [], 'never a mark of icons not stored');
  assert.deepEqual(local.get('favicons')['https://new.test'], learned, 'written again');
  page = fromStorage(await readForPage(get, () => page));
  assert.deepEqual(page.favicons['https://new.test'], learned, 'the page has the new icon');
  const iconsAt = calls.findLastIndex((keys) => keys.includes('favicons'));
  assert.deepEqual(calls[iconsAt + 1], ['faviconsMark'], 'the mark in a set() of its own, after the icons');
  assert.ok(calls.every((keys) => !(keys.includes('favicons') && keys.includes('faviconsMark'))), 'never in the same one');
});

test('page reads: a page that took the icons\' mark from its event but read the icons before they were stored (between the background\'s two writes) still gets the new icons at its next read', async () => {
  const F0 = { 'https://a.test': { data: 'A', at: 1 } };
  const F1 = { ...F0, 'https://b.test': { data: 'B', at: 2 } };
  const storage = fakeStorage(toStorage({ ...STATE, favicons: F0 }, Object.keys(STATE), by));
  let state = fromStorage(await readForPage(storage.get, () => null));
  // The background's first write: the icons. The page can't take their event
  // (a read under way) and reads again; that read lands before the mark.
  const { faviconsMark: mark, ...values } = toStorage({ favicons: F1 }, ['favicons'], by);
  storage.set(values);
  state = fromStorage(await readForPage(storage.get, () => state));
  // The second write, the mark: its event taken straight into the page's state.
  storage.set({ faviconsMark: mark });
  state = withChanges(state, { faviconsMark: { newValue: mark } });
  state = fromStorage(await readForPage(storage.get, () => state));
  assert.deepEqual(Object.keys(state.favicons), ['https://a.test', 'https://b.test']);
});

