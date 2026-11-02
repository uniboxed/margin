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

test('store: a change with nothing new isn\'t written; a real one is, with the tabs\' whole value; a failed write is still retried', async () => {
  local.clear();
  const copy = await startCopy('safari-web-extension://NOOP/');
  await copy.mutate((s) => ({ ...s, tabs: { 5: { id: 5, windowId: 1, url: 'https://e.test/', index: 0, title: 'E' } }, tabSpace: { 5: 'personal' } }));
  const set = chrome.storage.local.set;
  const written = [];
  chrome.storage.local.set = async (values) => { written.push(Object.keys(values)); return set(values); };
  // Rebuilt as a tab event does, nothing new in it.
  await copy.mutate((s) => ({ ...s, tabs: { ...s.tabs, 5: { ...s.tabs[5] } }, tabSpace: { ...s.tabSpace } }));
  await copy.mutate((s) => s);
  assert.deepEqual(written, [], 'not written');
  await copy.mutate((s) => ({ ...s, tabs: { ...s.tabs, 5: { ...s.tabs[5], title: 'E2' } } }));
  assert.deepEqual(written, [['openTabs', 'stateRev']], 'a new title: written (with the write\'s stamp: shared/stored.js STATE_REV)');
  assert.equal(storedTabs().tabs[5].title, 'E2');
  assert.deepEqual(storedTabs().tabSpace, { 5: 'personal' }, 'with the tabs\' spaces');

  let fail = true;
  chrome.storage.local.set = async (values) => {
    if (fail) { fail = false; throw new Error('busy'); }
    written.push(Object.keys(values));
    return set(values);
  };
  written.length = 0;
  await copy.mutate((s) => ({ ...s, settings: { ...s.settings, sidebarWidth: 301 } }));
  await copy.mutate((s) => ({ ...s, settings: { ...s.settings } })); // nothing new: the failed write still goes
  assert.deepEqual(written, [['settings', 'stateRev']]);
  assert.equal(local.get('settings').sidebarWidth, 301);
  chrome.storage.local.set = set;
});

// Each write of the state is stamped (shared/stored.js STATE_REV) in the same
// set() as the state's keys: a page prepared for a show draws without reading
// storage if it saw the last one (content/core.js prepareForShow).
test('store: each write of the state carries its stamp in the same set(), following the one before; stateRev() is the last that went through, none after a failed one; a background starting again follows the stored one', async () => {
  local.clear();
  const copy = await startCopy('safari-web-extension://REV/');
  await copy.load();
  const set = chrome.storage.local.set;
  const sets = [];
  chrome.storage.local.set = async (values) => { sets.push(structuredClone(values)); return set(values); };
  await copy.mutate((s) => ({ ...s, settings: { ...s.settings, sidebarWidth: 280 } }));
  const first = local.get('stateRev');
  assert.deepEqual(Object.keys(sets.at(-1)).sort(), ['settings', 'stateRev'], 'in the same set() as the state');
  assert.equal(typeof first.id, 'string');
  assert.equal(copy.stateRev(), first.id);
  await copy.mutate((s) => ({ ...s, tabs: { 5: { id: 5, windowId: 1, url: 'https://e.test/', index: 0 } }, tabSpace: { 5: 'personal' } }));
  const second = local.get('stateRev');
  assert.deepEqual(Object.keys(sets.at(-1)).sort(), ['openTabs', 'stateRev']);
  assert.equal(second.after, first.id, 'follows the one before');
  assert.notEqual(second.id, first.id);
  assert.equal(copy.stateRev(), second.id);
  // A write that fails: not known which keys went through.
  let fail = true;
  chrome.storage.local.set = async (values) => {
    sets.push(structuredClone(values));
    if (fail) { fail = false; throw new Error('busy'); }
    return set(values);
  };
  await copy.mutate((s) => ({ ...s, settings: { ...s.settings, sidebarWidth: 290 } }));
  const failed = sets.at(-1).stateRev;
  assert.equal(copy.stateRev(), null, 'none known while a write failed');
  await copy.mutate((s) => ({ ...s, pins: [{ id: 'p', url: 'https://p.test/', title: 'P' }] }));
  const after = local.get('stateRev');
  assert.equal(after.after, failed.id, 'the next follows the failed one (a page that saw it knows the next; one that didn\'t reads)');
  assert.equal(copy.stateRev(), after.id);
  chrome.storage.local.set = set;
  // Its background started again (same copy): the stored write is the last one known.
  const session = new Map([['since', (await chrome.storage.session.get('since')).since]]);
  globalThis.chrome = /** @type {any} */ ({ ...fakeApi('safari-web-extension://REV/'), storage: { ...fakeApi('safari-web-extension://REV/').storage, session: { get: async () => ({ since: session.get('since') }), set: async () => {} } } });
  const again = await import('../extension/background/store.js?copy=rev-again');
  await again.decided();
  assert.equal(again.stateRev(), after.id, 'before any write of its own');
  const own = [];
  const setAgain = chrome.storage.local.set;
  chrome.storage.local.set = async (values) => { if (values.stateRev) own.push(values.stateRev); return setAgain(values); };
  await again.load();
  await again.mutate((s) => ({ ...s, pins: [] }));
  assert.ok(own.length > 0);
  assert.equal(own[0].after, after.id, 'its first write follows it');
  chrome.storage.local.set = setAgain;
  // A newer copy's claim marks the stored tabs unmatched: stamped too, a chain
  // of its own (pages read once more: another copy's writes never reached them).
  await again.markSynced();
  const before = local.get('stateRev').id;
  await sleep(5);
  const newer = await startCopy('safari-web-extension://REV-NEWER/');
  assert.equal(local.get('openTabs').synced, false);
  assert.notEqual(local.get('stateRev').id, before);
  assert.equal(local.get('stateRev').after, null);
  assert.equal(newer.stateRev(), local.get('stateRev').id);
});

// A page prepared for a show reads storage unless the background knows the
// last write is through (background/store.js stateRev): its read then comes
// behind a write still waiting or under way, and gets it.
test('store: no write is known while one waits for the owner check, while its set() is under way, or while the icons\' mark after it is', async () => {
  local.clear();
  const copy = await startCopy('safari-web-extension://INFLIGHT/');
  await copy.load();
  await copy.mutate((s) => ({ ...s, settings: { ...s.settings, sidebarWidth: 280 } }));
  assert.equal(copy.stateRev(), local.get('stateRev').id);
  const { get, set } = chrome.storage.local;
  const gate = () => {
    let open;
    const shut = new Promise((resolve) => { open = resolve; });
    return { shut, open: () => open() };
  };
  // The keys changed, the owner check before the set() not answered yet.
  const check = gate();
  let holdCheck = true;
  chrome.storage.local.get = async (keys) => {
    if (holdCheck && [].concat(keys).includes('owner')) {
      holdCheck = false;
      await check.shut;
    }
    return get(keys);
  };
  const sent = gate();
  let holdSet = true;
  chrome.storage.local.set = async (values) => {
    if (holdSet && values.stateRev) {
      holdSet = false;
      await sent.shut;
    }
    return set(values);
  };
  const writing = copy.mutate((s) => ({ ...s, settings: { ...s.settings, sidebarWidth: 290 } }));
  await sleep(5);
  assert.equal(copy.stateRev(), null, 'waiting');
  check.open();
  await sleep(5);
  assert.equal(local.get('settings').sidebarWidth, 280, 'the set() is under way');
  assert.equal(copy.stateRev(), null, 'under way');
  sent.open();
  await writing;
  assert.equal(copy.stateRev(), local.get('stateRev').id, 'through');
  // An icon learned: the icons, then their mark in a set() of its own.
  const marked = gate();
  let holdMark = true;
  chrome.storage.local.set = async (values) => {
    if (holdMark && 'faviconsMark' in values) {
      holdMark = false;
      await marked.shut;
    }
    return set(values);
  };
  const icons = copy.mutate((s) => ({ ...s, favicons: { ...s.favicons, 'https://new.test': { data: 'data:image/png;base64,AAAA', href: 'https://new.test/f.png', at: 1 } } }));
  await sleep(5);
  assert.ok(local.get('favicons')['https://new.test'], 'the icons are stored');
  assert.equal(copy.stateRev(), null, 'their mark isn\'t yet');
  marked.open();
  await icons;
  assert.equal(copy.stateRev(), local.get('stateRev').id);
  chrome.storage.local.get = get;
  chrome.storage.local.set = set;
});

test('store: a copy that claims the state knows no write until its own first stamped one is through, at its start or claiming back', async () => {
  local.clear();
  const first = await startCopy('safari-web-extension://CLAIM-A/');
  await first.load();
  await first.mutate((s) => ({ ...s, settings: { ...s.settings, sidebarWidth: 280 } }));
  assert.notEqual(storedTabs()?.synced, true, 'the stored tabs not matched: the claim writes nothing stamped');
  const theirs = local.get('stateRev').id;
  await sleep(5);
  const second = await startCopy('safari-web-extension://CLAIM-B/');
  assert.equal(second.isOwner(), true);
  assert.equal(second.stateRev(), null, 'not the other copy\'s last write: its pages never heard this one\'s');
  const stamps = [];
  const setOwn = chrome.storage.local.set;
  chrome.storage.local.set = async (values) => { if (values.stateRev) stamps.push(values.stateRev); return setOwn(values); };
  await second.load();
  await second.mutate((s) => ({ ...s, settings: { ...s.settings, sidebarWidth: 300 } }));
  chrome.storage.local.set = setOwn;
  assert.equal(stamps[0]?.after, null, 'a chain of its own');
  assert.ok(stamps.every((rev) => rev.after !== theirs));
  assert.equal(second.stateRev(), local.get('stateRev').id);
  // An older copy claimed over it (they started together) and wrote: claimed
  // back, with its tabs written again (queued: not waited for).
  await second.mutate((s) => ({ ...s, tabs: { 5: { id: 5, windowId: 1, url: 'https://n.test/', index: 0 } } }));
  await second.markSynced();
  const mine = second.stateRev();
  local.set('owner', { origin: 'safari-web-extension://CLAIM-OLDER/', since: 1 });
  local.set('openTabs', { ...storedTabs(), origin: 'safari-web-extension://CLAIM-OLDER/', since: 1, tabs: { 99: { id: 99 } } });
  local.set('stateRev', { id: 'older', after: null });
  const { set } = chrome.storage.local;
  const sets = [];
  chrome.storage.local.set = async (values) => { sets.push(Object.keys(values)); return set(values); };
  assert.equal(await second.recheck(), 'owner');
  assert.equal(second.stateRev(), null, `not ${mine}: its pages know that one, and not what the older copy wrote`);
  await sleep(20);
  chrome.storage.local.set = set;
  assert.ok(sets.some((keys) => keys.includes('openTabs') && keys.includes('stateRev')), 'its tabs written again, stamped');
  assert.equal(local.get('stateRev').after, null);
  assert.equal(second.stateRev(), local.get('stateRev').id);
});
