// Sleeping tabs (background/sleep.js, shared/sleep.js, state/model.js
// sleepyTabs and seenTab), against a fake of Safari's API: which tabs sleep,
// how, and what Margin keeps of them. Margin's switch to a sleeping tab is in
// tests/wake.test.js (its fakes); Chrome's tabs.discard in
// tests/sleep-chrome.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BASE = 'safari-web-extension://test/';

// tabs: id → { id, url, active, windowId, status, audible, title }. `page(tabId)`:
// what sleepInPage answers there (null: no page, its script fails; 'never':
// no answer at all).
const fake = {
  tabs: new Map(),
  updates: [],
  scripts: [],
  local: {},
  session: {},
  page: () => ({ ok: true, judged: 'margin' }),
  denied: new Set(),
};
globalThis.chrome = {
  runtime: { id: 'test', getURL: (path) => `${BASE}${path}`, getManifest: () => ({ version: '0' }), sendMessage: async () => undefined },
  permissions: { contains: async ({ origins: [o] }) => ![...fake.denied].some((d) => o.includes(d)) },
  tabs: {
    get: async (id) => {
      const tab = fake.tabs.get(id);
      if (!tab) throw new Error('no tab');
      return { ...tab };
    },
    update: async (id, change) => {
      fake.updates.push({ id, change });
      const tab = fake.tabs.get(id);
      if (!tab) throw new Error('no tab');
      if (change.url) Object.assign(tab, { url: change.url, status: 'complete' });
      return { ...tab };
    },
    query: async () => [...fake.tabs.values()].map((t) => ({ ...t })),
    sendMessage: async () => undefined,
    reload: async () => {},
  },
  scripting: {
    executeScript: async ({ target, func, args }) => {
      fake.scripts.push({ tabId: target.tabId, func: func?.name ?? 'files', args });
      if (func?.name !== 'sleepInPage') return [{ result: true }];
      const answer = fake.page(target.tabId, args);
      if (answer === 'never') return new Promise(() => {});
      if (answer == null) throw new Error('Could not execute script on this tab');
      return [{ result: answer }];
    },
  },
  storage: {
    local: {
      get: async (keys) => (keys == null ? { ...fake.local } : Object.fromEntries([].concat(keys).filter((k) => k in fake.local).map((k) => [k, structuredClone(fake.local[k])]))),
      set: async (items) => { Object.assign(fake.local, structuredClone(items)); },
    },
    session: {
      get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in fake.session).map((k) => [k, structuredClone(fake.session[k])])),
      set: async (items) => { Object.assign(fake.session, structuredClone(items)); },
    },
  },
};

const S = await import('../extension/shared/sleep.js');
const M = await import('../extension/state/model.js');
const { oldOwnPageAddress } = await import('../extension/background/cut-off.js');
const { sleepIdle, sleepInPage, setSleepTiming, wakeAll } = await import('../extension/background/sleep.js');
const { decided, mutate, load } = await import('../extension/background/store.js');
const { tapLog } = await import('../extension/background/diagnostics.js');
setSleepTiming({ gapMs: 5, askMs: 150, wakeGapMs: 1 });

// ---- the sleep page's address (shared/sleep.js) ------------------------------------

test('sleep page: its address carries the page\'s, any copy\'s sleep page is one, and only a web page\'s address is gone back to', () => {
  const at = S.sleepAddress(BASE, { url: 'https://mail.example.com/inbox?q=a b&x=1#top', title: 'Inbox (3)', key: 'k1' });
  assert.ok(at.startsWith(`${BASE}sleep/sleep.html?`));
  assert.deepEqual(S.readSleepAddress(at), { url: 'https://mail.example.com/inbox?q=a%20b&x=1#top', raw: 'https://mail.example.com/inbox?q=a b&x=1#top', title: 'Inbox (3)', key: 'k1' });
  assert.equal(S.isSleepPage(at), true);
  assert.equal(S.isSleepPage(at.replace('://test/', '://another-copy/')), true, 'an earlier copy\'s address');
  assert.equal(S.isSleepPage('chrome-extension://abc/sleep/sleep.html?u=x'), true);
  for (const not of ['https://example.com/sleep/sleep.html', `${BASE}newtab/newtab.html`, `${BASE}sleep/other.html`, 'about:blank', '', null, undefined, 'not a url']) assert.equal(S.isSleepPage(not), false, String(not));
  assert.equal(S.readSleepAddress('https://example.com/?u=https://a.test/'), null);
  assert.equal(S.sleepAddress(BASE, { url: 'https://a.test/', title: 'x'.repeat(1000), key: 'k' }).length < 450, true, 'a long title is cut');
});

test('sleep page: strictly http: and https: (never javascript:, data:, file:, another extension\'s page, or a broken address)', () => {
  assert.equal(S.wakeTarget('https://a.test/x?y#z'), 'https://a.test/x?y#z');
  assert.equal(S.wakeTarget('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080/');
  assert.equal(S.wakeTarget('HTTPS://A.TEST'), 'https://a.test/', 'as the URL parser reads it');
  for (const bad of ['javascript:alert(1)', ' javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'blob:https://a.test/x', 'safari-web-extension://test/sleep/sleep.html?u=https://a.test/', 'chrome://settings', 'about:blank', 'ftp://a.test/', '//a.test/', '/relative', 'https://', '', null, undefined, 42, {}]) {
    assert.equal(S.wakeTarget(bad), null, String(bad));
  }
  const nested = S.sleepAddress(BASE, { url: S.sleepAddress(BASE, { url: 'https://a.test/', key: 'a' }), key: 'b' });
  assert.equal(S.readSleepAddress(nested).url, null, 'a sleep page inside a sleep page: never gone to (no loop)');
  assert.equal(S.readSleepAddress(`${BASE}sleep/sleep.html`).url, null, 'no address at all');
  assert.equal(S.readSleepAddress(`${BASE}sleep/sleep.html?u=javascript%3Aalert(1)`).raw, 'javascript:alert(1)', 'shown as it was');
});

// A sleep page in a fake document: its window, document and API.
function sleepPage(url, { visible = false, length = 1, kept = {}, tabs = true, icons = {} } = {}) {
  const listeners = { doc: {}, win: {} };
  const calls = [];
  const nodes = {};
  const element = (id) => (nodes[id] ??= { id, textContent: '', hidden: true, dataset: {}, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } });
  const storage = { ...kept };
  const page = {
    calls,
    nodes,
    storage,
    win: {
      location: { href: url, replace: (to) => calls.push(['replace', to]) },
      history: { length, back: () => calls.push(['back']) },
      sessionStorage: { getItem: (k) => storage[k] ?? null, setItem: (k, v) => { storage[k] = String(v); } },
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 20)),
      addEventListener: (type, fn) => { listeners.win[type] = fn; },
    },
    doc: {
      title: '',
      visibilityState: visible ? 'visible' : 'hidden',
      documentElement: { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
      head: { appended: [], append(n) { this.appended.push(n); } },
      getElementById: element,
      createElement: () => ({}),
      addEventListener: (type, fn) => { listeners.doc[type] = fn; },
    },
    api: {
      tabs: tabs ? { getCurrent: async () => ({ id: 7 }), update: async (id, change) => { calls.push(['update', id, change.url]); } } : undefined,
      storage: { local: { get: async () => ({ favicons: icons }) } },
    },
    show() {
      page.doc.visibilityState = 'visible';
      listeners.doc.visibilitychange?.();
    },
    hide() {
      page.doc.visibilityState = 'hidden';
      listeners.doc.visibilitychange?.();
    },
    pageshow(persisted) { listeners.win.pageshow?.({ persisted }); },
  };
  page.started = S.startSleepPage(page);
  return page;
}
const asleepAt = (url, title = 'Page') => S.sleepAddress(BASE, { url, title, key: 'k9' });

test('sleep page: never by itself while hidden; shown, its tab is sent back to its page, once (no loop); its title and icon are the page\'s', async () => {
  const page = sleepPage(asleepAt('https://a.test/doc', 'A doc'), { icons: { 'https://a.test': { data: 'data:image/png;base64,AAA' } } });
  await sleep(5);
  assert.equal(page.doc.title, 'A doc');
  assert.equal(page.nodes.address.textContent, 'https://a.test/doc');
  assert.deepEqual(page.calls, [], 'hidden: nothing');
  assert.equal(page.doc.head.appended[0]?.href, 'data:image/png;base64,AAA', 'the site\'s icon');
  page.hide();
  assert.deepEqual(page.calls, []);
  page.show();
  await sleep(5);
  assert.deepEqual(page.calls, [['update', 7, 'https://a.test/doc']], 'its own tab, to its page\'s address');
  page.hide();
  page.show();
  page.pageshow(false);
  await sleep(5);
  assert.equal(page.calls.length, 1, 'once');
  const front = sleepPage(asleepAt('https://b.test/'), { visible: true });
  await sleep(5);
  assert.deepEqual(front.calls, [['update', 7, 'https://b.test/']], 'visible as it loads (Safari showing it): at once');
});

test('sleep page: an address that isn\'t a web page\'s is shown, never gone to', async () => {
  for (const raw of ['javascript:alert(1)', 'data:text/html,x', '']) {
    const page = sleepPage(`${BASE}sleep/sleep.html?u=${encodeURIComponent(raw)}&t=&k=x`, { visible: true });
    page.show();
    await sleep(30);
    assert.deepEqual(page.calls, [], raw);
    assert.equal(page.nodes.address.textContent, raw);
    assert.ok('data-broken' in page.doc.documentElement.attrs);
    assert.match(page.nodes.note.textContent, /asleep/);
  }
});

test('sleep page: reached again through its tab\'s history (a browser that keeps it across the change), it isn\'t woken again: it goes back to the page it slept from, and offers that page\'s link if it can\'t; restored as the tab\'s last page (a relaunch), it wakes', async () => {
  // As it first loaded: the tab's history was 3 long.
  const first = sleepPage(asleepAt('https://a.test/'), { length: 3 });
  assert.equal(first.storage['margin-sleep:k9'], '3');
  // Back from the page it woke to: 4 entries now, the same sessionStorage.
  const again = sleepPage(asleepAt('https://a.test/'), { length: 4, kept: first.storage });
  again.show();
  await sleep(40);
  assert.deepEqual(again.calls, [['back']], 'back to the page it slept from, never forward again');
  assert.equal(again.nodes.go.hidden, false, 'still here a moment later: its link offered');
  again.nodes.go.listeners.click();
  await sleep(5);
  assert.deepEqual(again.calls.at(-1), ['update', 7, 'https://a.test/'], 'the link sends the tab there');
  // A relaunch restoring it (its sessionStorage back, the same history): woken.
  const restored = sleepPage(asleepAt('https://a.test/'), { length: 3, kept: first.storage, visible: true });
  await sleep(5);
  assert.deepEqual(restored.calls, [['update', 7, 'https://a.test/']]);
  // No API (Margin gone): the page's own way, then the link.
  const orphan = sleepPage(asleepAt('https://c.test/'), { visible: true, tabs: false });
  await sleep(40);
  assert.deepEqual(orphan.calls, [['replace', 'https://c.test/']]);
  assert.equal(orphan.nodes.go.hidden, false);
});

// ---- sites that never sleep -------------------------------------------------------

test('never-sleep list: what\'s typed is read generously, and a host matches itself and its subdomains, never a name that only ends the same', () => {
  assert.deepEqual(S.siteList('Mail.Google.com\nhttps://www.youtube.com/watch?v=1, *.slack.com  example.org:8080\n\nnot_a_host!\nexample.org'), ['mail.google.com', 'youtube.com', 'slack.com', 'example.org']);
  assert.deepEqual(S.siteList(['a.test', 'A.TEST', null, '', 'http://[::1]:8080/']), ['a.test', '[::1]']);
  const sites = S.siteList('youtube.com mail.google.com');
  assert.equal(S.neverSleeps('https://youtube.com/', sites), true);
  assert.equal(S.neverSleeps('https://www.youtube.com/watch', sites), true);
  assert.equal(S.neverSleeps('https://m.youtube.com./', sites), true);
  assert.equal(S.neverSleeps('https://notyoutube.com/', sites), false);
  assert.equal(S.neverSleeps('https://youtube.com.evil.test/', sites), false);
  assert.equal(S.neverSleeps('https://mail.google.com/mail/u/0', sites), true);
  assert.equal(S.neverSleeps('https://docs.google.com/', sites), false, 'only the subdomain given');
  assert.equal(S.neverSleeps('https://a.test/', []), false);
  assert.equal(S.neverSleeps('garbage', sites), false);
  assert.deepEqual(M.normalizeState({ settings: { neverSleepSites: ' A.test\n' } }).settings.neverSleepSites, ['a.test'], 'stored text read as a list');
  assert.deepEqual(M.normalizeState({}).settings.neverSleepSites, []);
  assert.equal(M.normalizeState({}).settings.sleepAfterHours, 4, 'four hours by default');
});

// ---- which tabs (state/model.js sleepyTabs) ----------------------------------------

const HOUR = 3600_000;
const NOW = 1_800_000_000_000;
const rec = (id, url, hoursAgo, extra = {}) => ({ id, windowId: 1, index: id, title: `t${id}`, url, favIconUrl: '', active: false, lastActive: NOW - hoursAgo * HOUR, ...extra });
const withTabs = (records, settings = {}) => {
  const s = M.defaultState();
  return { ...s, tabs: Object.fromEntries(records.map((r) => [r.id, r])), tabSpace: Object.fromEntries(records.map((r) => [r.id, 'personal'])), settings: { ...s.settings, ...settings } };
};

test('which tabs: web pages unused for the setting\'s hours, the longest unused first; not the tab in front, one asleep, Margin\'s own pages, a site on the never list, one woken lately; pinned tabs too; 0 = never', () => {
  const s = withTabs([
    rec(1, 'https://front.test/', 9, { active: true }),
    rec(2, 'https://old.test/', 9),
    rec(3, 'https://older.test/', 30),
    rec(4, 'https://recent.test/', 3.9),
    rec(5, `${BASE}newtab/newtab.html`, 50),
    rec(6, 'about:blank', 50),
    rec(7, 'https://asleep.test/', 50, { sleeping: { at: NOW - HOUR, how: 'page' } }),
    rec(8, 'https://mail.kept.test/inbox', 50),
    rec(9, 'https://woke.test/', 50, { wokeAt: NOW - HOUR }),
    rec(10, 'https://pinned.test/', 5),
    rec(11, 'file:///Users/x/a.html', 50),
  ], { neverSleepSites: ['kept.test'] });
  const pinned = M.addPin(s, { id: 'p', spaceId: 'personal', url: 'https://pinned.test/', title: 'Pinned' });
  assert.deepEqual(M.sleepyTabs(pinned, NOW).map((t) => t.id), [3, 2, 10]);
  assert.deepEqual(M.sleepyTabs({ ...pinned, settings: { ...pinned.settings, sleepAfterHours: 0 } }, NOW), [], 'never');
  assert.deepEqual(M.sleepyTabs({ ...pinned, settings: { ...pinned.settings, sleepAfterHours: 'x' } }, NOW), []);
  assert.deepEqual(M.sleepyTabs({ ...pinned, settings: { ...pinned.settings, sleepAfterHours: 0.5 } }, NOW).map((t) => t.id), [3, 2, 10, 4, 9], 'half an hour (9 woke an hour ago)');
  assert.deepEqual(M.sleepyTabs({ ...pinned, settings: { ...pinned.settings, sleepAfterHours: 0 } }, NOW, { afterMs: 1 }).map((t) => t.id), [3, 2, 10, 4, 9], 'a pass asked for by hand: its own time');
});

test('which tabs: the time Safari was closed doesn\'t count (a relaunch moves every last use forward)', () => {
  // Used 1 and 3 hours before Safari quit; Safari opened again 10 hours later.
  const quitAt = NOW - 10 * HOUR;
  const before = withTabs([rec(1, 'https://a.test/', 0, { lastActive: quitAt - HOUR }), rec(2, 'https://b.test/', 0, { lastActive: quitAt - 3 * HOUR })]);
  const open = [{ id: 21, windowId: 5, index: 0, url: 'https://a.test/', title: 'a', active: true }, { id: 22, windowId: 5, index: 1, url: 'https://b.test/', title: 'b', active: false }];
  const after = M.syncTabs(before, open, { fresh: true, now: NOW });
  assert.equal(after.tabs[22].lastActive, NOW - 2 * HOUR, 'two hours before the last tab used, as before the quit');
  assert.deepEqual(M.sleepyTabs(after, NOW).map((t) => t.id), [], 'not four hours yet');
  assert.deepEqual(M.sleepyTabs(after, NOW + 2.5 * HOUR).map((t) => t.id), [22]);
});

// ---- what Margin keeps of a sleeping tab (state/model.js seenTab) --------------------

test('a sleeping tab keeps its page\'s address, title and icon through its updates, is marked asleep, and is awake again once it has another address', () => {
  let s = withTabs([rec(3, 'https://docs.test/a', 6, { title: 'Doc A', favIconUrl: 'data:image/png;base64,X' })]);
  const asleep = S.sleepAddress(BASE, { url: 'https://docs.test/a', title: 'Doc A', key: 'k' });
  // Safari's onUpdated: the sleep page's address, loading, then its title (the page's), complete.
  s = M.upsertTab(s, { id: 3, windowId: 1, index: 3, url: asleep, status: 'loading', title: asleep, active: false }, NOW);
  s = M.upsertTab(s, { id: 3, windowId: 1, index: 3, url: asleep, status: 'complete', title: 'Doc A', active: false }, NOW + 5);
  assert.equal(s.tabs[3].url, 'https://docs.test/a');
  assert.equal(s.tabs[3].title, 'Doc A');
  assert.equal(s.tabs[3].favIconUrl, 'data:image/png;base64,X');
  assert.equal(s.tabs[3].lastActive, NOW - 6 * HOUR, 'its last use stays');
  assert.deepEqual(s.tabs[3].sleeping, { at: NOW, how: 'page' });
  // Its pin, its row and the palette go by the page's address.
  const pinned = M.addPin(s, { id: 'p', spaceId: 'personal', url: 'https://docs.test/a', title: 'Doc' });
  assert.equal(M.pinForUrl(pinned, s.tabs[3].url, 'personal')?.id, 'p');
  // Woken: its page's address again.
  s = M.upsertTab(s, { id: 3, windowId: 1, index: 3, url: 'https://docs.test/a', status: 'loading', title: 'Doc A', active: false }, NOW + 9);
  assert.equal(s.tabs[3].sleeping, undefined);
  assert.equal(s.tabs[3].wokeAt, NOW + 9);
  assert.deepEqual(M.sleepyTabs(s, NOW + HOUR).map((t) => t.id), [], 'not put to sleep again for its hours');
  // A sleep page with no web address isn't taken for its page.
  const broken = M.upsertTab(s, { id: 3, windowId: 1, index: 3, url: `${BASE}sleep/sleep.html?u=javascript%3Ax`, title: 'x' }, NOW);
  assert.match(broken.tabs[3].url, /^safari-web-extension:/);
  assert.equal(broken.tabs[3].sleeping, undefined);
});

test('a sleeping tab is archived by its page\'s address, title and icon, after the archive\'s hours, as any tab', () => {
  let s = withTabs([rec(4, 'https://news.test/story', 13, { title: 'Story', favIconUrl: 'data:image/png;base64,Y' })]);
  s = M.upsertTab(s, { id: 4, windowId: 1, index: 4, url: S.sleepAddress(BASE, { url: 'https://news.test/story', title: 'Story', key: 'k' }), title: 'Story', active: false }, NOW);
  const stale = M.staleTabs(s, NOW);
  assert.deepEqual(stale.map((t) => t.id), [4]);
  const entry = M.archiveEntryForTab(s, stale[0], { id: 'a1', closedAt: NOW });
  assert.deepEqual({ url: entry.url, title: entry.title, favIconUrl: entry.favIconUrl }, { url: 'https://news.test/story', title: 'Story', favIconUrl: 'data:image/png;base64,Y' });
});

test('after a relaunch or an update, a sleeping tab at an earlier copy\'s sleep page is matched to its record by its page\'s address (its space kept), still asleep', () => {
  const work = M.createSpace(withTabs([rec(1, 'https://a.test/', 1), rec(2, 'https://sleepy.test/x', 6, { sleeping: { at: NOW - HOUR, how: 'page' } })]), { id: 'work', name: 'Work' });
  const before = { ...work, tabSpace: { 1: 'personal', 2: 'work' } };
  const old = S.sleepAddress('safari-web-extension://old-copy/', { url: 'https://sleepy.test/x', title: 'Sleepy', key: 'k' });
  const open = [{ id: 31, windowId: 9, index: 0, url: 'https://a.test/', active: true }, { id: 32, windowId: 9, index: 1, url: old, title: 'Sleepy', active: false }];
  const after = M.syncTabs(before, open, { fresh: true, now: NOW });
  assert.equal(after.tabSpace[32], 'work');
  assert.equal(after.tabs[32].url, 'https://sleepy.test/x');
  assert.ok(after.tabs[32].sleeping);
  assert.equal(after.tabs[32].restored, true);
  // Margin updated (no relaunch): the same, by renumbering.
  const renumbered = M.syncTabs(before, open);
  assert.equal(renumbered.tabSpace[32], 'work');
});

test('an earlier copy\'s sleep page is sent to this copy\'s, its address after it kept (still asleep); this copy\'s and other pages aren\'t', () => {
  const old = S.sleepAddress('safari-web-extension://old-copy/', { url: 'https://a.test/?q=1', title: 'A', key: 'k' });
  const moved = oldOwnPageAddress(old, BASE);
  assert.equal(moved, old.replace('safari-web-extension://old-copy/', BASE));
  assert.equal(S.readSleepAddress(moved).url, 'https://a.test/?q=1');
  assert.equal(oldOwnPageAddress(moved, BASE), null, 'this copy\'s');
  assert.equal(oldOwnPageAddress('https://a.test/sleep/sleep.html', BASE), null);
  assert.equal(oldOwnPageAddress('safari-web-extension://old-copy/newtab/newtab.html', BASE), `${BASE}newtab/newtab.html?again`, 'the new-tab page as before');
});

// ---- the sleep pass (background/sleep.js) ------------------------------------------

/** @param {any[]} tabs @param {Record<string, any>} [settings] */
async function setUp(tabs, settings = {}) {
  fake.tabs = new Map(tabs.map((t) => [t.id, { windowId: 1, status: 'complete', active: false, audible: false, title: `T${t.id}`, ...t }]));
  fake.updates = [];
  fake.scripts = [];
  fake.page = () => ({ ok: true, judged: 'margin' });
  fake.denied = new Set();
  await decided();
  await mutate((s) => {
    let next = { ...s, tabs: {}, tabSpace: {}, settings: { ...s.settings, sleepAfterHours: 4, neverSleepSites: [], ...settings } };
    for (const t of fake.tabs.values()) {
      next = M.upsertTab(next, t, Date.now());
      next = { ...next, tabs: { ...next.tabs, [t.id]: { ...next.tabs[t.id], active: !!t.active, lastActive: Date.now() - (t.idleHours ?? 5) * HOUR } } };
    }
    return next;
  });
}
const slept = () => fake.updates.filter((u) => S.isSleepPage(u.change.url)).map((u) => u.id);

test('a pass: each tab long unused asked in its page, then sent to Margin\'s sleep page (its address and title in the sleep page\'s), at most a few per pass, one at a time; Margin keeps it as its page', async () => {
  await setUp([{ id: 1, url: 'https://front.test/', active: true }, ...[2, 3, 4, 5, 6, 7, 8].map((id) => ({ id, url: `https://s${id}.test/p`, idleHours: 4 + id }))]);
  const entries = [];
  tapLog((e) => entries.push(e));
  const pass = await sleepIdle();
  tapLog(null);
  assert.deepEqual(pass, { due: 7, slept: 5, skipped: { 'next pass': 2 }, stopped: null });
  assert.deepEqual(slept(), [8, 7, 6, 5, 4], 'the longest unused first');
  const asked = fake.scripts.filter((x) => x.func === 'sleepInPage');
  assert.deepEqual(asked.map((x) => x.tabId), [8, 7, 6, 5, 4]);
  assert.equal(asked[0].args[0], 'https://s8.test/p', 'asked whether it\'s still that page');
  assert.deepEqual(S.readSleepAddress(fake.updates[0].change.url), { url: 'https://s8.test/p', raw: 'https://s8.test/p', title: 'T8', key: S.readSleepAddress(fake.updates[0].change.url).key });
  assert.ok(fake.updates.every((u) => !('active' in u.change)), 'none brought to the front');
  assert.deepEqual(entries.filter((e) => e.kind === 'sleep').map((e) => e.step), ['slept', 'slept', 'slept', 'slept', 'slept', 'run']);
  assert.deepEqual(entries.find((e) => e.step === 'run').skipped, { 'next pass': 2 });
  // The state as onUpdated brings it in: still the page.
  await mutate((s) => [...fake.tabs.values()].reduce((st, t) => M.upsertTab(st, t, Date.now()), s));
  const s = await load();
  assert.equal(s.tabs[8].url, 'https://s8.test/p');
  assert.ok(s.tabs[8].sleeping);
  // The next pass: the two left (the five asleep aren't due).
  const next = await sleepIdle();
  assert.deepEqual(next, { due: 2, slept: 2, skipped: {}, stopped: null });
});

test('a pass leaves alone: a tab in front, playing sound, loading, already asleep, not a web page, on the never list, not reachable, with a draft, playing, or shown meanwhile; one whose page doesn\'t answer in time, or has none (Safari unloaded it), waits for the next pass', async () => {
  const tabs = [
    { id: 1, url: 'https://front.test/', active: true },
    { id: 2, url: 'https://sound.test/', audible: true },
    { id: 3, url: 'https://loading.test/', status: 'loading' },
    { id: 4, url: S.sleepAddress('safari-web-extension://old/', { url: 'https://zzz.test/', key: 'k' }) },
    { id: 5, url: 'https://kept.test/', idleHours: 9 },
    { id: 6, url: 'https://denied.test/' },
    { id: 7, url: 'https://draft.test/' },
    { id: 8, url: 'https://video.test/' },
    { id: 9, url: 'https://silent.test/' },
    { id: 10, url: 'https://unloaded.test/' },
    { id: 11, url: 'https://shown.test/' },
    { id: 12, url: 'https://sleepy.test/', idleHours: 3 },
  ];
  await setUp(tabs, { neverSleepSites: ['kept.test'] });
  // (The one in front, as Safari has it, though Margin's record says otherwise.)
  await mutate((s) => ({ ...s, tabs: { ...s.tabs, 1: { ...s.tabs[1], active: false } } }));
  fake.denied = new Set(['denied.test']);
  const answers = { 7: { ok: false, why: 'edited', judged: 'margin' }, 8: { ok: false, why: 'playing' }, 9: 'never', 10: null, 11: { ok: false, why: 'shown' } };
  fake.page = (tabId) => (tabId in answers ? answers[tabId] : { ok: true });
  const pass = await sleepIdle();
  assert.deepEqual(pass.skipped, { 'in front': 1, playing: 2, loading: 1, 'no access': 1, edited: 1, 'no answer': 1, 'no page': 1, shown: 1 });
  assert.equal(pass.due, 9, 'one asleep already, one on the never list and one used lately aren\'t due');
  assert.equal(pass.slept, 0);
  assert.deepEqual(fake.updates, [], 'none sent anywhere');
});

test('sleepInPage: only a hidden page at the same address with nothing typed (Margin\'s watch, or a generous look at the page without it) and nothing playing', () => {
  const was = { document: globalThis.document, location: globalThis.location, navigator: globalThis.navigator, Margin: globalThis.Margin };
  try {
    const el = (props) => ({ value: '', textContent: '', paused: true, ended: false, isContentEditable: false, options: [], checked: false, defaultChecked: false, ...props });
    const page = ({ hidden = true, href = 'https://a.test/', fields = [], media = [], edits = undefined } = {}) => {
      globalThis.document = { visibilityState: hidden ? 'hidden' : 'visible', querySelectorAll: (sel) => (sel.startsWith('audio') ? media : sel.startsWith('textarea') ? fields : []), fullscreenElement: null };
      Object.defineProperty(globalThis, 'location', { value: { href }, configurable: true, writable: true });
      Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
      globalThis.Margin = edits === undefined ? undefined : { content: { edits: () => edits } };
    };
    const until = Date.now() + 1000;
    page();
    assert.deepEqual(sleepInPage('https://a.test/', until), { ok: true, judged: 'page' });
    page({ edits: false, fields: [el({ value: 'set by the page' })] });
    assert.deepEqual(sleepInPage('https://a.test/', until), { ok: true, judged: 'margin' }, 'Margin\'s watch: the page\'s own values aren\'t a draft');
    page({ edits: true });
    assert.equal(sleepInPage('https://a.test/', until).why, 'edited');
    page({ fields: [el({ value: 'typed' })] });
    assert.equal(sleepInPage('https://a.test/', until).why, 'edited', 'no watch (an earlier copy): any text counts');
    page({ hidden: false });
    assert.equal(sleepInPage('https://a.test/', until).why, 'shown');
    page({ href: 'https://a.test/elsewhere' });
    assert.equal(sleepInPage('https://a.test/', until).why, 'moved');
    page({ media: [el({ paused: false })] });
    assert.equal(sleepInPage('https://a.test/', until).why, 'playing');
    page();
    assert.equal(sleepInPage('https://a.test/', Date.now() - 1).why, 'late');
  } finally {
    globalThis.document = was.document;
    Object.defineProperty(globalThis, 'location', { value: was.location, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'navigator', { value: was.navigator, configurable: true, writable: true });
    globalThis.Margin = was.Margin;
  }
});

test('Wake all: every tab asleep (any copy\'s sleep page) sent back to its page\'s address, not the one in front; turning sleep off wakes none', async () => {
  await setUp([
    { id: 1, url: 'https://front.test/', active: true },
    { id: 2, url: S.sleepAddress(BASE, { url: 'https://two.test/', key: 'a' }) },
    { id: 3, url: S.sleepAddress('safari-web-extension://old/', { url: 'https://three.test/?x=1', key: 'b' }) },
    { id: 4, url: 'https://awake.test/' },
  ]);
  await mutate((s) => ({ ...s, settings: { ...s.settings, sleepAfterHours: 0 } }));
  assert.deepEqual(fake.updates, [], 'off: nothing woken');
  assert.equal(await wakeAll(), 2);
  assert.deepEqual(fake.updates.map((u) => [u.id, u.change.url]), [[2, 'https://two.test/'], [3, 'https://three.test/?x=1']]);
});
