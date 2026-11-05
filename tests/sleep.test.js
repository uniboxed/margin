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
  // The page's other frames' answers (executeScript's rows), when every frame is asked.
  frames: () => [],
  // Before a page answers (the ask under way).
  asking: async () => {},
  noAllFrames: false,
  denied: new Set(),
  // The app has no sleep page (its file isn't there), or Safari shows its
  // error page for it.
  noSleepPage: false,
  errorPage: false,
};
globalThis.fetch = async (url) => ({ ok: !fake.noSleepPage && String(url) === `${BASE}sleep/sleep.html` });
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
      if (change.url) Object.assign(tab, { url: fake.errorPage && change.url.startsWith(BASE) ? 'safari-resource:/ErrorPage.html' : change.url, status: 'complete' });
      return { ...tab };
    },
    query: async () => [...fake.tabs.values()].map((t) => ({ ...t })),
    sendMessage: async () => undefined,
    reload: async () => {},
  },
  scripting: {
    executeScript: async ({ target, func, args }) => {
      fake.scripts.push({ tabId: target.tabId, func: func?.name ?? 'files', args, allFrames: !!target.allFrames });
      if (func?.name !== 'sleepInPage') return [{ result: true }];
      if (target.allFrames && fake.noAllFrames) throw new Error('allFrames not supported');
      await fake.asking(target.tabId);
      const answer = fake.page(target.tabId, args);
      if (answer === 'never') return new Promise(() => {});
      if (answer == null) throw new Error('Could not execute script on this tab');
      const top = { frameId: 0, result: { top: true, ...answer } };
      return target.allFrames ? [top, ...fake.frames(target.tabId)] : [top];
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

// Safari closes sleeping tabs now and keeps them as not-open Margin tabs
// (Margin 2: tests/sleep-close.test.js). The sleep page these tests drive is
// still in the code until Phase 3 removes it (a tab an earlier build sent
// there still wakes): tested here as it was, as a build that used it.
const { platform } = await import('../extension/shared/platform.js');
platform.sleepTabs = 'page';
const S = await import('../extension/shared/sleep.js');
const M = await import('../extension/state/model.js');
const { oldOwnPageAddress } = await import('../extension/background/cut-off.js');
const { sleepChanged, sleepIdle, sleepInPage, setSleepTiming, wakeAll, wokeToAddress } = await import('../extension/background/sleep.js');
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

// A sleep page in a fake document: its window, document and API. `length`:
// the tab's history's; `state`: its entry's (history.state); `kept`: its
// sessionStorage (null: none, it throws); `woke`: storage.session (Margin's
// background's marks); `navigation`: the Navigation API's activation.
function sleepPage(url, { visible = false, length = 1, kept = {}, state = null, woke = null, navigation = undefined, tabs = true, icons = {} } = {}) {
  const listeners = { doc: {}, win: {} };
  const calls = [];
  const nodes = {};
  const element = (id) => (nodes[id] ??= { id, textContent: '', hidden: true, dataset: {}, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } });
  const storage = kept ? { ...kept } : null;
  const sessionStorage = storage
    ? { getItem: (k) => storage[k] ?? null, setItem: (k, v) => { storage[k] = String(v); } }
    : { getItem: () => { throw new Error('no storage'); }, setItem: () => { throw new Error('no storage'); } };
  const history = {
    length,
    state,
    back: () => calls.push(['back']),
    forward: () => calls.push(['forward']),
    replaceState: (next) => { history.state = structuredClone(next); calls.push(['mark']); },
  };
  const page = {
    calls,
    nodes,
    storage,
    history,
    win: {
      location: { href: url, replace: (to) => calls.push(['replace', to]) },
      history,
      sessionStorage,
      ...(navigation !== undefined ? { navigation: { activation: navigation } } : {}),
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
      storage: { local: { get: async () => ({ favicons: icons }) }, ...(woke ? { session: { get: async (key) => (key in woke ? { [key]: woke[key] } : {}) } } : {}) },
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
  assert.deepEqual(page.calls, [['mark'], ['update', 7, 'https://a.test/doc']], 'its own tab, to its page\'s address');
  page.hide();
  page.show();
  page.pageshow(false);
  await sleep(5);
  assert.equal(page.calls.length, 2, 'once');
  const front = sleepPage(asleepAt('https://b.test/'), { visible: true });
  await sleep(5);
  assert.deepEqual(front.calls, [['mark'], ['update', 7, 'https://b.test/']], 'visible as it loads (Safari showing it): at once');
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

test('sleep page: its entry is marked before it sends its tab back (history.state, and sessionStorage by its key)', async () => {
  const page = sleepPage(asleepAt('https://a.test/'), { visible: true, state: { other: 1 } });
  await sleep(5);
  assert.deepEqual(page.calls, [['mark'], ['update', 7, 'https://a.test/']]);
  assert.deepEqual(page.history.state, { other: 1, marginWoke: 'k9' }, 'the entry\'s own state kept');
  assert.equal(page.storage['margin-woke:k9'], '1');
});

test('sleep page: reached again through its tab\'s history (a browser that keeps it across the change), it never sends its tab forward again: Back goes back once more, Forward forward, and with the way not known it offers its page\'s link and does nothing by itself', async () => {
  // As it first woke: the tab's history at WebKit's cap (100), so it doesn't grow.
  const first = sleepPage(asleepAt('https://a.test/'), { length: 100, visible: true });
  await sleep(5);
  const entry = first.history.state;
  // Back from the page it woke to (another site's: the Navigation API can't say from where).
  const back = sleepPage(asleepAt('https://a.test/'), { length: 100, kept: first.storage, state: entry, visible: true, navigation: { navigationType: 'traverse', from: null, entry: { index: 0 } } });
  await sleep(40);
  assert.deepEqual(back.calls, [], 'not sent forward again (no Back trap), nor anywhere');
  assert.equal(back.nodes.go.hidden, false, 'its link offered');
  back.nodes.go.listeners.click();
  await sleep(5);
  assert.deepEqual(back.calls.at(-1), ['update', 7, 'https://a.test/'], 'the link sends the tab there');
  // No sessionStorage: its entry's state alone says so.
  const bare = sleepPage(asleepAt('https://a.test/'), { length: 100, kept: null, state: entry, visible: true });
  await sleep(40);
  assert.deepEqual(bare.calls, []);
  assert.equal(bare.nodes.go.hidden, false);
  // Nor its entry's state: sessionStorage alone.
  const lost = sleepPage(asleepAt('https://a.test/'), { length: 100, kept: first.storage, visible: true });
  await sleep(40);
  assert.deepEqual(lost.calls, []);
  // The Navigation API says it came back (from a later entry of Margin's): back once more.
  const backward = sleepPage(asleepAt('https://a.test/'), { length: 100, kept: first.storage, state: entry, visible: true, navigation: { navigationType: 'traverse', from: { index: 3 }, entry: { index: 2 } } });
  await sleep(40);
  assert.deepEqual(backward.calls, [['back']]);
  assert.equal(backward.nodes.go.hidden, false, 'still here a moment later: its link offered');
  // Forward, after Back went past it: forward to the page it woke to.
  const forward = sleepPage(asleepAt('https://a.test/'), { length: 100, kept: first.storage, state: entry, visible: true, navigation: { navigationType: 'traverse', from: { index: 1 }, entry: { index: 2 } } });
  await sleep(40);
  assert.deepEqual(forward.calls, [['forward']], 'never back');
  // Its history longer than as it first loaded (an entry after it), not marked: an old entry too.
  const longer = sleepPage(asleepAt('https://b.test/'), { length: 3 });
  const again = sleepPage(asleepAt('https://b.test/'), { length: 4, kept: longer.storage, visible: true });
  await sleep(40);
  assert.deepEqual(again.calls, []);
  assert.equal(again.nodes.go.hidden, false);
  // Back from the back/forward cache after it woke: not sent forward again.
  first.pageshow(true);
  await sleep(40);
  assert.deepEqual(first.calls, [['mark'], ['update', 7, 'https://a.test/']]);
});

test('sleep page: woken by Margin\'s background (its key in storage.session), reached again: not sent forward again; one never woken, restored as the tab\'s last page (a relaunch), wakes', async () => {
  const woken = sleepPage(asleepAt('https://a.test/'), { length: 100, visible: true, woke: { 'sleepWoke:k9': 1 } });
  await sleep(40);
  assert.deepEqual(woken.calls, []);
  assert.equal(woken.nodes.go.hidden, false);
  // A relaunch restoring one never woken (its sessionStorage back, the same history): woken.
  const first = sleepPage(asleepAt('https://a.test/'), { length: 3 });
  assert.equal(first.storage['margin-sleep:k9'], '3');
  const restored = sleepPage(asleepAt('https://a.test/'), { length: 3, kept: first.storage, visible: true, woke: {}, navigation: { navigationType: 'traverse', from: null, entry: { index: 0 } } });
  await sleep(5);
  assert.deepEqual(restored.calls, [['mark'], ['update', 7, 'https://a.test/']]);
  // No API (Margin gone): the page's own way, then the link.
  const orphan = sleepPage(asleepAt('https://c.test/'), { visible: true, tabs: false });
  await sleep(40);
  assert.deepEqual(orphan.calls, [['mark'], ['replace', 'https://c.test/']]);
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
  fake.frames = () => [];
  fake.asking = async () => {};
  fake.noAllFrames = false;
  fake.denied = new Set();
  delete fake.session.sleepRefused;
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

test('an app without its sleep page (its Xcode project made before the page was added) puts no tab to sleep; one sent there that lands on Safari\'s error page is sent straight back to its page, and the pass stops there', async () => {
  await setUp([{ id: 1, url: 'https://front.test/', active: true }, { id: 2, url: 'https://s2.test/p', idleHours: 6 }, { id: 3, url: 'https://s3.test/p', idleHours: 5 }]);
  fake.noSleepPage = true;
  try {
    const pass = await sleepIdle();
    assert.deepEqual(pass, { due: 2, slept: 0, skipped: {}, stopped: 'no sleep page' });
    assert.deepEqual(fake.updates, [], 'no tab sent anywhere');
    assert.deepEqual(fake.scripts.filter((x) => x.func === 'sleepInPage'), [], 'no page asked');
  } finally {
    fake.noSleepPage = false;
  }
  fake.errorPage = true;
  try {
    const pass = await sleepIdle();
    assert.deepEqual(pass, { due: 2, slept: 0, skipped: { 'sleep page failed': 1 }, stopped: 'sleep page failed' });
    assert.equal(fake.tabs.get(2).url, 'https://s2.test/p', 'back at its page');
    assert.deepEqual(fake.updates.map((u) => u.id), [2, 2], 'the next tab not sent there');
  } finally {
    fake.errorPage = false;
  }
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

test('a pass asks every frame of the page: text or media in another site\'s frame (a comment box, a form, a payment\'s), or a frame of another site that gave no answer, keeps the tab awake; the page\'s own checks are its top frame\'s', async () => {
  await setUp([2, 3, 4, 5, 6, 7, 8].map((id) => ({ id, url: `https://f${id}.test/` })));
  // A frame of another site (its parent can't look into it), and WebKit's error for a frame it has no access to.
  const other = (result) => ({ frameId: 9, result: { top: false, apart: true, foreign: 0, ...result } });
  const noAccess = { frameId: 10, result: null, error: 'Failed to execute script. Extension does not have access to this frame.' };
  const frames = {
    2: [other({ ok: false, why: 'edited', judged: 'frame' })],
    3: [noAccess], // (a data: frame: the top frame couldn't look into it)
    4: [other({ ok: true, judged: 'frame' })],
    5: [other({ ok: false, why: 'playing' })],
    6: [other({ ok: true, judged: 'frame' })],
    7: [other({ ok: true, judged: 'frame' }), noAccess], // (an empty frame of the page's own site, looked into from the top)
    8: [], // (a browser that skips a frame it can't run in)
  };
  fake.frames = (tabId) => frames[tabId] ?? [];
  fake.page = (tabId) => (tabId === 6 ? { ok: false, why: 'moved' } : { ok: true, judged: 'margin', foreign: 1 });
  const pass = await sleepIdle({ afterMs: 1 });
  assert.deepEqual(pass.skipped, { edited: 1, 'frame unknown': 2, playing: 1, moved: 1 });
  assert.deepEqual(slept().sort(), [4, 7]);
  const asked = fake.scripts.filter((x) => x.func === 'sleepInPage');
  assert.equal(asked.length, 7);
  assert.ok(asked.every((x) => x.allFrames), 'every frame asked');
});

test('a browser that won\'t run the check in every frame: asked in the top frame alone, and a page with frames it can\'t look into stays awake', async () => {
  await setUp([{ id: 2, url: 'https://framed.test/' }, { id: 3, url: 'https://plain.test/' }]);
  fake.noAllFrames = true;
  fake.page = (tabId) => ({ ok: true, judged: 'margin', foreign: tabId === 2 ? 1 : 0 });
  const pass = await sleepIdle({ afterMs: 1 });
  assert.deepEqual(pass.skipped, { 'frame unknown': 1 });
  assert.deepEqual(slept(), [3]);
  assert.deepEqual(fake.scripts.filter((x) => x.func === 'sleepInPage').map((x) => [x.tabId, x.allFrames]), [[2, true], [2, false], [3, true], [3, false]]);
});

test('a tab used while the pass goes on (in front a moment by Safari\'s tab bar or ⌘1–9, which no switch of Margin\'s sees) isn\'t put to sleep: neither one used during its own page\'s answer nor one used before its turn', async () => {
  await setUp([{ id: 2, url: 'https://two.test/', idleHours: 9 }, { id: 3, url: 'https://three.test/', idleHours: 8 }]);
  const use = (id) => mutate((s) => ({ ...s, tabs: { ...s.tabs, [id]: { ...s.tabs[id], lastActive: Date.now() } } }));
  fake.asking = async (tabId) => {
    if (tabId !== 2) return;
    await use(2);
    await use(3);
  };
  const pass = await sleepIdle();
  assert.deepEqual(pass.skipped, { used: 2 });
  assert.deepEqual(fake.updates, [], 'none sent to sleep');
  assert.deepEqual(fake.scripts.filter((x) => x.func === 'sleepInPage').map((x) => x.tabId), [2], '3 not even asked');
});

test('a page that said no isn\'t asked again each pass (asking resumes its process): not until its tab is used again, or an hour has passed; a pass asked for by hand asks it', async () => {
  await setUp([{ id: 2, url: 'https://draft.test/' }, { id: 3, url: 'https://idle.test/' }]);
  let draft = true;
  fake.page = (tabId) => (tabId === 2 && draft ? { ok: false, why: 'edited', judged: 'margin' } : { ok: true });
  const askedOf = (id) => fake.scripts.filter((x) => x.func === 'sleepInPage' && x.tabId === id).length;
  assert.deepEqual((await sleepIdle()).skipped, { edited: 1 });
  assert.equal(askedOf(2), 1);
  await mutate((s) => [...fake.tabs.values()].reduce((st, t) => M.upsertTab(st, t, Date.now()), s)); // 3 asleep, as onUpdated brings it in
  assert.ok(fake.session.sleepRefused?.[2], 'kept in storage.session (a pass is often in a background started for it)');
  // The next pass: not asked.
  assert.deepEqual(await sleepIdle(), { due: 1, slept: 0, skipped: { 'asked lately': 1 }, stopped: null });
  assert.equal(askedOf(2), 1);
  // By hand: asked.
  assert.deepEqual((await sleepIdle({ afterMs: 1 })).skipped, { edited: 1 });
  assert.equal(askedOf(2), 2);
  // Used since (its last use moved, still long ago): asked again.
  await mutate((s) => ({ ...s, tabs: { ...s.tabs, 2: { ...s.tabs[2], lastActive: s.tabs[2].lastActive + 1000 } } }));
  setSleepTiming({ refusedMs: 20 });
  try {
    assert.deepEqual((await sleepIdle()).skipped, { edited: 1 });
    assert.equal(askedOf(2), 3);
    // Its time up: asked again; the draft sent meanwhile, it sleeps, and its refusal is forgotten.
    assert.deepEqual((await sleepIdle()).skipped, { 'asked lately': 1 });
    await sleep(30);
    draft = false;
    assert.deepEqual(await sleepIdle(), { due: 1, slept: 1, skipped: {}, stopped: null });
    assert.equal(askedOf(2), 4);
    assert.equal(fake.session.sleepRefused?.[2], undefined);
  } finally {
    setSleepTiming({ refusedMs: 60 * 60_000 });
  }
});

test('a tab woken back to its page\'s address: that load isn\'t taken for a search made now (background.js learns no search engine from it)', async () => {
  const search = 'https://www.google.com/search?q=margin&client=safari';
  await setUp([{ id: 2, url: search }, { id: 3, url: 'https://awake.test/' }]);
  await mutate((s) => ({ ...s, tabs: { ...s.tabs, 2: { ...s.tabs[2], sleeping: { at: Date.now(), how: 'page' } } } }));
  sleepChanged(2, { url: search });
  assert.equal(wokeToAddress(2, search), true);
  assert.equal(wokeToAddress(2, 'https://www.google.com/search?q=other&client=safari'), false, 'a search made after it woke is');
  sleepChanged(3, { url: 'https://www.google.com/search?q=x&client=safari' });
  assert.equal(wokeToAddress(3, 'https://www.google.com/search?q=x&client=safari'), false, 'a tab that wasn\'t asleep');
});

test('sleepInPage: only a hidden page at the same address with nothing typed (Margin\'s watch, or a generous look at the page without it) and nothing playing; another site\'s frame: nothing typed or playing there, its address its own; the top frame counts the frames it can\'t look into', () => {
  const was = { document: globalThis.document, location: globalThis.location, navigator: globalThis.navigator, Margin: globalThis.Margin, window: globalThis.window };
  try {
    const el = (props) => ({ value: '', textContent: '', paused: true, ended: false, isContentEditable: false, options: [], checked: false, defaultChecked: false, ...props });
    // `frame`: run in a frame of another site (window.top isn't this window); `frames`: the page's own iframes.
    const page = ({ hidden = true, href = 'https://a.test/', fields = [], media = [], edits = undefined, late = false, frame = false, frames = [] } = {}) => {
      globalThis.document = { visibilityState: hidden ? 'hidden' : 'visible', querySelectorAll: (sel) => (sel.startsWith('audio') ? media : sel.startsWith('textarea') ? fields : sel.startsWith('iframe') ? frames : []), fullscreenElement: null };
      Object.defineProperty(globalThis, 'location', { value: { href }, configurable: true, writable: true });
      Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
      const win = { frameElement: frame === 'same' ? {} : null };
      win.top = frame ? {} : win;
      globalThis.window = win;
      globalThis.Margin = edits === undefined ? undefined : { content: { edits: Object.assign(() => edits, { late }) } };
    };
    const until = Date.now() + 1000;
    page();
    assert.deepEqual(sleepInPage('https://a.test/', until), { ok: true, judged: 'page', top: true, foreign: 0 });
    page({ edits: false, fields: [el({ value: 'set by the page' })] });
    assert.deepEqual(sleepInPage('https://a.test/', until), { ok: true, judged: 'margin', top: true, foreign: 0 }, 'Margin\'s watch: the page\'s own values aren\'t a draft');
    page({ edits: false, late: true });
    assert.equal(sleepInPage('https://a.test/', until).judged, 'margin-late', 'a watch started late says so');
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
    page({ edits: false, frames: [{ contentDocument: null }, { get contentDocument() { throw new Error('cross-origin'); } }] });
    assert.equal(sleepInPage('https://a.test/', until).foreign, 2, 'two frames of other sites');
    // In another site's frame: its own address, no watch of Margin's (any text counts).
    page({ frame: true, href: 'https://comments.test/embed', fields: [el({ value: 'a reply' })] });
    assert.deepEqual(sleepInPage('https://a.test/', until), { ok: false, why: 'edited', judged: 'frame', top: false });
    page({ frame: 'same', href: 'about:blank' });
    assert.equal(sleepInPage('https://a.test/', until).apart, false, 'a frame its parent looks into');
    page({ frame: true, href: 'https://comments.test/embed', edits: false, fields: [el({ value: 'a reply' })] });
    assert.equal(sleepInPage('https://a.test/', until).why, 'edited', 'a frame never takes the top frame\'s watch');
    page({ frame: true, href: 'https://video.test/embed', media: [el({ paused: false })] });
    assert.deepEqual(sleepInPage('https://a.test/', until), { ok: false, why: 'playing', top: false });
    page({ frame: true, href: 'https://ads.test/', frames: [{ contentDocument: null }] });
    assert.deepEqual(sleepInPage('https://a.test/', until), { ok: true, judged: 'frame', top: false, foreign: 1, apart: true }, 'another site\'s frame, with one of its own it can\'t look into');
  } finally {
    globalThis.document = was.document;
    Object.defineProperty(globalThis, 'location', { value: was.location, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'navigator', { value: was.navigator, configurable: true, writable: true });
    globalThis.Margin = was.Margin;
    globalThis.window = was.window;
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
