// Two copies of Margin sharing one storage.local (Safari keeps an old copy
// running beside a newer one after an update or a rebuild): only the newest
// writes the state (background/store.js, shared/owner.js), and copies don't
// hear each other's writes (as in WebKit: no storage.onChanged across them).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const local = new Map(); // shared by both copies
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function fakeApi(origin) {
  const session = new Map();
  const area = (map) => ({
    get: async (keys) => {
      const list = keys == null ? [...map.keys()] : [].concat(keys);
      return Object.fromEntries(list.filter((k) => map.has(k)).map((k) => [k, structuredClone(map.get(k))]));
    },
    set: async (values) => { for (const [k, v] of Object.entries(values)) map.set(k, structuredClone(v)); },
    remove: async (keys) => { for (const k of [].concat(keys)) map.delete(k); },
  });
  return { runtime: { getURL: (path) => `${origin}${path}` }, storage: { local: area(local), session: area(session), onChanged: { addListener() {} } } };
}
// A copy of the background's store, started now.
async function startCopy(origin) {
  globalThis.chrome = /** @type {any} */ (fakeApi(origin));
  const store = await import(`../extension/background/store.js?copy=${encodeURIComponent(origin)}`);
  await store.decided();
  return store;
}
const storedTabs = () => local.get('openTabs');

test('copies: the newest owns the state; the older one stops writing as soon as it next writes', async () => {
  const older = await startCopy('safari-web-extension://OLD/');
  assert.equal(older.isOwner(), true);
  await older.mutate((s) => ({ ...s, tabs: { 1: { id: 1, windowId: 9, url: 'https://a.test/', index: 0 } }, tabSpace: { 1: 'personal' } }));
  await older.markSynced();
  assert.equal(storedTabs().origin, 'safari-web-extension://OLD/');
  assert.equal(storedTabs().synced, true);

  await sleep(5); // started later
  const newer = await startCopy('safari-web-extension://NEW/');
  assert.equal(newer.isOwner(), true);
  assert.equal(storedTabs().synced, false, 'its claim marks the stored tabs unmatched at once');

  // The older copy, still running, sees a tab event under its own ids.
  await assert.rejects(older.mutate((s) => ({ ...s, tabs: { 7: { id: 7, windowId: 9, url: 'https://old-ids.test/', index: 0 } } })), older.StaleError, 'the change fails (it wasn\'t written)');
  assert.equal(older.isOwner(), false, 'it found out at its write');
  assert.deepEqual(Object.keys(storedTabs().tabs), ['1'], 'and wrote nothing');

  await newer.mutate((s) => ({ ...s, tabs: { 42: { id: 42, windowId: 41, url: 'https://a.test/', index: 0 } }, tabSpace: { 42: 'personal' } }));
  await newer.markSynced();
  assert.equal(storedTabs().origin, 'safari-web-extension://NEW/');
  assert.equal(storedTabs().synced, true);
  assert.deepEqual(Object.keys(storedTabs().tabs), ['42']);
  // And it never claims back (a stale copy's changes aren't even made).
  await older.mutate((s) => ({ ...s, tabs: {} }));
  assert.equal(storedTabs().origin, 'safari-web-extension://NEW/');
  assert.equal((await older.recheck()), 'stale');
});

test('copies: a copy\'s background starting again keeps what it owns, matched', async () => {
  local.clear();
  const copy = await startCopy('safari-web-extension://SAME/');
  await copy.mutate((s) => ({ ...s, tabs: { 3: { id: 3, windowId: 1, url: 'https://c.test/', index: 0 } } }));
  await copy.markSynced();
  const writes = JSON.stringify(storedTabs());
  // The same copy (same address, same storage.session) after its worker was unloaded:
  // a new module instance, the session kept.
  const session = new Map([['since', (await chrome.storage.session.get('since')).since]]);
  globalThis.chrome = /** @type {any} */ ({ ...fakeApi('safari-web-extension://SAME/'), storage: { ...fakeApi('safari-web-extension://SAME/').storage, session: { get: async (k) => ({ since: session.get('since') }), set: async () => {} } } });
  const again = await import('../extension/background/store.js?copy=same-again');
  await again.decided();
  assert.equal(again.isOwner(), true);
  assert.equal(again.isSynced(), true, 'its tabs are still its own and matched: nothing to wait for');
  await again.load();
  const set = chrome.storage.local.set;
  let sets = 0;
  chrome.storage.local.set = async (values) => { sets++; return set(values); };
  await again.markSynced();
  chrome.storage.local.set = set;
  assert.equal(sets, 0, 'no rewrite');
  assert.equal(JSON.stringify(storedTabs()), writes, 'pages keep trusting them');
});

test('copies: a storage error while deciding who owns the state isn\'t kept: it\'s tried again', async () => {
  local.clear();
  globalThis.chrome = /** @type {any} */ (fakeApi('safari-web-extension://FLAKY/'));
  const get = chrome.storage.local.get;
  let failures = 1;
  chrome.storage.local.get = async (keys) => {
    if (failures-- > 0) throw new Error('SQLite error 5');
    return get(keys);
  };
  const store = await import('../extension/background/store.js?copy=flaky');
  await store.decided();
  assert.equal(store.isOwner(), true);
});

test('copies: a storage error that outlasts deciding leaves the copy unknown, not stale; the next caller tries again', async () => {
  local.clear();
  globalThis.chrome = /** @type {any} */ (fakeApi('safari-web-extension://DOWN/'));
  const get = chrome.storage.local.get;
  let failures = 4; // all of decide()'s tries
  chrome.storage.local.get = async (keys) => {
    if (failures-- > 0) throw new Error('SQLite error 5');
    return get(keys);
  };
  const store = await import('../extension/background/store.js?copy=down');
  await assert.rejects(store.decided());
  assert.equal(store.isOwner(), false);
  assert.equal(store.isStale(), false, 'its pages aren\'t told to stand down');
  await store.decided();
  assert.equal(store.isOwner(), true);
});

test('copies: an older copy claiming over a newer one is claimed back, with the newer one\'s tabs written again at once', async () => {
  local.clear();
  const newer = await startCopy('safari-web-extension://NEWER/');
  await newer.mutate((s) => ({ ...s, tabs: { 5: { id: 5, windowId: 1, url: 'https://n.test/', index: 0 } } }));
  await newer.markSynced();
  // An older copy's record over it (they started together; it read before the newer one wrote).
  local.set('owner', { origin: 'safari-web-extension://OLDER/', since: 1 });
  local.set('openTabs', { ...storedTabs(), origin: 'safari-web-extension://OLDER/', since: 1, tabs: { 99: { id: 99 } } });
  assert.equal(await newer.recheck(), 'owner');
  assert.equal(newer.isSynced(), true);
  await sleep(20);
  assert.equal(storedTabs().origin, 'safari-web-extension://NEWER/');
  assert.equal(storedTabs().synced, true);
  assert.deepEqual(Object.keys(storedTabs().tabs), ['5']);
});
