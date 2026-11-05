// shared/owner.js: which copy of Margin is in charge of its storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newer, ownership } from '../extension/shared/owner.js';
import { fromStorage, openTabsCurrent, storedName, toStorage, withChanges } from '../extension/shared/stored.js';

const old = { origin: 'safari-web-extension://AAA/', since: 1000 };
const fresh = { origin: 'safari-web-extension://BBB/', since: 2000 };

test('owner: the first copy claims an empty or broken record', () => {
  assert.equal(ownership(undefined, old), 'claim');
  assert.equal(ownership(null, old), 'claim');
  assert.equal(ownership(/** @type {any} */ ({ origin: 'x' }), old), 'claim');
});

test('owner: a copy keeps what it owns, across its background restarts', () => {
  assert.equal(ownership({ ...old, synced: true }, old), 'own');
});

test('owner: a newer copy takes over; the older one is then stale, whichever starts its background first', () => {
  assert.equal(ownership(old, fresh), 'claim');
  assert.equal(ownership(fresh, old), 'stale');
});

test('owner: after a relaunch the new copy claims the last launch\'s record', () => {
  const lastLaunch = { origin: 'safari-web-extension://OLD/', since: 5000, synced: true };
  assert.equal(ownership(lastLaunch, { origin: 'safari-web-extension://NEW/', since: 9000 }), 'claim');
});

test('owner: the same address started again (Chrome restarts, extension reloaded) claims again, unsynced', () => {
  assert.equal(ownership({ ...old, synced: true }, { ...old, since: 3000 }), 'claim');
});

test('owner: a record from a clock that was ahead is claimed by a copy starting, not by one running (no claiming in turn)', () => {
  const now = 100_000;
  const ahead = { origin: 'safari-web-extension://AHEAD/', since: now + 3_600_000 };
  const older = { origin: 'safari-web-extension://OLDER/', since: now - 5000 };
  assert.equal(ownership(ahead, older, now), 'claim', 'starting');
  assert.equal(ownership(ahead, older), 'stale', 'running: as it is');
  assert.equal(ownership(older, ahead), 'claim', 'the one ahead claims over an older record');
  assert.equal(ownership(ahead, ahead, now), 'own', 'its own record is never claimed');
});

test('owner: two copies started together never both claim', () => {
  const a = { origin: 'safari-web-extension://AAA/', since: 7000 };
  const b = { origin: 'safari-web-extension://BBB/', since: 7000 };
  assert.notEqual(newer(a, b), newer(b, a));
  assert.equal([ownership(a, b), ownership(b, a)].filter((d) => d === 'claim').length, 1);
});

test('stored: the open tabs, their spaces and the windows\' spaces go in one value that says whose they are', () => {
  const state = { tabs: { 5: { id: 5 } }, tabSpace: { 5: 'work' }, activeSpaceByWindow: { 1: 'work' }, keptTabs: { 't-k1': { id: 't-k1', url: 'https://k.test/', spaceId: 'work' } }, spaces: [{ id: 'work' }], lostTabs: null };
  const written = toStorage(state, ['tabSpace', 'spaces'], { origin: fresh.origin, since: fresh.since, synced: true });
  assert.deepEqual(Object.keys(written).sort(), ['openTabs', 'spaces']);
  assert.deepEqual(written.openTabs, { origin: fresh.origin, since: fresh.since, synced: true, tabs: state.tabs, tabSpace: state.tabSpace, activeSpaceByWindow: state.activeSpaceByWindow, keptTabs: state.keptTabs });
  const read = fromStorage({ ...written, tabs: { 9: { id: 9 } } });
  assert.deepEqual(read.tabs, state.tabs, 'not the old name another copy writes');
  assert.deepEqual(read.openTabsBy, { origin: fresh.origin, since: fresh.since, synced: true });
  assert.equal(storedName('lostTabs'), 'lostTabs2');
  assert.equal(storedName('settings'), 'settings');
});

test('stored: before Margin first wrote them, the open tabs come from the old names', () => {
  const read = fromStorage({ tabs: { 9: { id: 9 } }, tabSpace: { 9: 'personal' }, activeSpaceByWindow: {}, lostTabs: { windows: [] } });
  assert.deepEqual(read.tabs, { 9: { id: 9 } });
  assert.deepEqual(read.lostTabs, { windows: [] });
  assert.equal(read.openTabsBy, null);
});

test('owner: a record from a clock that was ahead is claimed (it would keep every copy out)', () => {
  assert.equal(ownership({ origin: 'safari-web-extension://FUTURE/', since: 10_000_000 }, fresh, 2000), 'claim');
  assert.equal(ownership({ origin: 'safari-web-extension://SOON/', since: 2500 }, fresh, 2000), 'stale', 'within a minute: an ordinary newer copy');
});

test('stored: Chrome keeps its address across restarts: the stored tabs are this copy\'s only if its start matches too', () => {
  assert.equal(openTabsCurrent({ origin: fresh.origin, since: 1, synced: true }, fresh.origin, 2), false);
  assert.equal(openTabsCurrent({ origin: fresh.origin, since: 2, synced: true }, fresh.origin, 2), true);
  assert.equal(openTabsCurrent({ origin: fresh.origin, since: 1, synced: true }, fresh.origin), true, 'before hello says');
});

test('stored: pages trust the stored tabs only once their own copy has matched them', () => {
  assert.equal(openTabsCurrent({ origin: fresh.origin, synced: false }, fresh.origin), false);
  assert.equal(openTabsCurrent({ origin: fresh.origin, synced: true }, fresh.origin), true);
  assert.equal(openTabsCurrent({ origin: old.origin, synced: true }, fresh.origin), false);
  assert.equal(openTabsCurrent(null, fresh.origin), false);
});

test('stored: a hidden page keeps its state current from the change events, ignoring the old names', () => {
  const before = fromStorage({ openTabs: { origin: fresh.origin, synced: true, tabs: { 1: { id: 1 } }, tabSpace: { 1: 'personal' }, activeSpaceByWindow: {} }, spaces: [{ id: 'personal' }] });
  const after = withChanges(before, {
    openTabs: { newValue: { origin: fresh.origin, synced: true, tabs: { 2: { id: 2 } }, tabSpace: { 2: 'work' }, activeSpaceByWindow: { 1: 'work' } } },
    spaces: { newValue: [{ id: 'personal' }, { id: 'work' }] },
    tabs: { newValue: { 9: { id: 9 } } }, // an old copy's write
    lostTabs2: { newValue: { windows: [] } },
  });
  assert.deepEqual(Object.keys(after.tabs), ['2']);
  assert.equal(after.tabSpace[2], 'work');
  assert.equal(after.spaces.length, 2);
  assert.deepEqual(after.lostTabs, { windows: [] });
  assert.deepEqual(before.tabs, { 1: { id: 1 } }, 'not changed in place');
});

// A page already drawn takes what changed from the change events (content/core.js,
// the new-tab page): after any run of writes, what it has is what reading all of
// storage again would give.
test('stored: the changes taken from the events give the state a full read would, after any run of writes', async () => {
  const { sameStored, takesChanges } = await import('../extension/shared/stored.js');
  let seed = 11;
  const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const by = { origin: 'safari-web-extension://A/', since: 5, synced: true };
  const value = (key) => {
    switch (key) {
      case 'tabs': return Object.fromEntries(Array.from({ length: 1 + Math.floor(random() * 4) }, (_, i) => [i, { id: i, windowId: 1, url: `https://${i}.test/`, title: String(random()) }]));
      case 'tabSpace': return { 0: pick(['a', 'b']) };
      case 'activeSpaceByWindow': return { 1: pick(['a', 'b']) };
      case 'spaces': return [{ id: 'a', name: String(random()) }, { id: 'b', name: 'B' }];
      case 'lostTabs': return [{ url: String(random()) }];
      default: return { n: random() };
    }
  };
  const KEYS = ['tabs', 'tabSpace', 'activeSpaceByWindow', 'spaces', 'pins', 'folders', 'settings', 'favicons', 'owner', 'showing', 'pageZoom', 'lostTabs'];
  for (let run = 0; run < 200; run++) {
    const full = { tabs: value('tabs'), tabSpace: value('tabSpace'), activeSpaceByWindow: value('activeSpaceByWindow'), spaces: value('spaces') };
    let stored = toStorage(full, Object.keys(full), by);
    let page = fromStorage(stored);
    for (let write = 0; write < 12; write++) {
      const keys = [...new Set(Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(KEYS)))];
      for (const key of keys) full[key] = value(key);
      const out = toStorage(full, keys, by);
      // As storage.onChanged reports a set(): only what's new by value.
      const changes = Object.fromEntries(Object.entries(out).filter(([k, v]) => !sameStored(v, stored[k])).map(([k, v]) => [k, { oldValue: stored[k], newValue: v }]));
      if (random() < 0.2) changes.tabs = { newValue: { 99: { id: 99 } } }; // another copy's write, under the old name
      stored = { ...stored, ...out };
      assert.equal(takesChanges(changes, { reading: 0, openTabsBy: page.openTabsBy }), true);
      page = withChanges(page, changes);
      const read = fromStorage(stored);
      delete read.lostTabs2; // a full read also keeps the stored name (under its state key too)
      const { lostTabs2: _, ...taken } = page;
      assert.deepEqual(taken, read, `run ${run}, write ${write}`);
    }
  }
});

test('stored: a page reads all of storage again for a change it can\'t take: during a read, a removal, or the tabs still under their old names', async () => {
  const { takesChanges } = await import('../extension/shared/stored.js');
  const by = { origin: 'x', synced: true };
  assert.equal(takesChanges({ settings: { newValue: {} } }, { reading: 0, openTabsBy: by }), true);
  assert.equal(takesChanges({ settings: { newValue: {} } }, { reading: 1, openTabsBy: by }), false, 'a full read under way');
  assert.equal(takesChanges({ settings: { oldValue: {} } }, { reading: 0, openTabsBy: by }), false, 'removed (storage cleared)');
  assert.equal(takesChanges({ settings: { newValue: {} }, spaces: { oldValue: [] } }, { reading: 0, openTabsBy: by }), false);
  assert.equal(takesChanges({ settings: { newValue: {} } }, { reading: 0, openTabsBy: null }), false, 'the tabs under the old names');
});

test('stored: values are the same when stored the same, as Safari tells a change', async () => {
  const { sameStored } = await import('../extension/shared/stored.js');
  const a = { 1: { id: 1, title: 'A' } };
  assert.equal(sameStored(a, a), true);
  assert.equal(sameStored(a, { 1: { id: 1, title: 'A' } }), true, 'rebuilt, nothing new');
  assert.equal(sameStored(a, { 1: { id: 1, title: 'B' } }), false);
  assert.equal(sameStored([], {}), false, 'an array isn\'t an object');
  assert.equal(sameStored({ a: 1 }, { a: 1, b: undefined }), true, 'undefined isn\'t stored');
  assert.equal(sameStored({ a: 1 }, { a: '1' }), false);
  assert.equal(sameStored(undefined, undefined), true);
  assert.equal(sameStored(undefined, null), false);
});
