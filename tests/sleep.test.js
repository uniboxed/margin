// Sleeping tabs (background/sleep.js, shared/sleep.js, state/model.js
// sleepyTabs and seenTab), against a fake of Safari's API: which tabs sleep,
// how (Safari closes the browser tab and keeps its Margin tab, not open:
// tests/kept-tabs.test.js has what's kept), and what Margin knows of a tab an
// earlier build left on its sleep page. Chrome's tabs.discard is in
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
  removed: [],
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
    remove: async (id) => {
      if (!fake.tabs.has(id)) throw new Error('no tab');
      fake.removed.push(id);
      fake.tabs.delete(id);
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

const { platform } = await import('../extension/shared/platform.js');
assert.equal(platform.sleepTabs, 'close', 'Safari closes a sleeping tab');
const S = await import('../extension/shared/sleep.js');
const M = await import('../extension/state/model.js');
const { oldOwnPageAddress } = await import('../extension/background/cut-off.js');
const { sleepIdle, sleepInPage, setSleepTiming, wakeAll } = await import('../extension/background/sleep.js');
const { takeClosing } = await import('../extension/background/closing.js');
const { decided, mutate, load } = await import('../extension/background/store.js');
const { switchLogTo } = await import('../extension/background/switch-log.js');
setSleepTiming({ gapMs: 5, askMs: 150, wakeGapMs: 1 });

// ---- a tab an earlier build left on Margin's sleep page (shared/sleep.js) --------------

// That build's sleep page's address for a page (its `k` was the sleep's key).
const oldAt = (url, { title = 'Page', base = BASE } = {}) => `${base}sleep/sleep.html?${new URLSearchParams({ u: url, t: title, k: 'k9' })}`;

test('an earlier build\'s sleep page: known by its path at any copy\'s address; only a web page\'s address is taken from it', () => {
  assert.deepEqual(S.oldSleepPage(oldAt('https://mail.example.com/inbox?q=a b&x=1#top', { title: 'Inbox (3)' })), { url: 'https://mail.example.com/inbox?q=a%20b&x=1#top', title: 'Inbox (3)' });
  assert.equal(S.oldSleepPage(oldAt('https://a.test/', { base: 'safari-web-extension://another-copy/' }))?.url, 'https://a.test/', 'an earlier copy\'s address');
  assert.equal(S.oldSleepPage('chrome-extension://abc/sleep/sleep.html?u=https://a.test/')?.url, 'https://a.test/');
  for (const not of ['https://example.com/sleep/sleep.html?u=https://a.test/', `${BASE}newtab/newtab.html`, `${BASE}sleep/other.html`, 'about:blank', '', null, undefined, 'not a url']) assert.equal(S.oldSleepPage(not), null, String(not));
  for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', oldAt('https://a.test/'), 'chrome://settings', '', '/relative']) {
    assert.equal(S.oldSleepPage(oldAt(bad))?.url, null, `never ${bad}`);
  }
  assert.equal(S.oldSleepPage(`${BASE}sleep/sleep.html`)?.url, null, 'no address at all');
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

test('a tab on an earlier build\'s sleep page keeps its page\'s address, title and icon through its updates, is marked asleep, and is awake again once it has another address', () => {
  let s = withTabs([rec(3, 'https://docs.test/a', 6, { title: 'Doc A', favIconUrl: 'data:image/png;base64,X' })]);
  const asleep = oldAt('https://docs.test/a', { title: 'Doc A' });
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

test('a tab on an earlier build\'s sleep page is archived by its page\'s address, title and icon, after the archive\'s hours, as any tab', () => {
  let s = withTabs([rec(4, 'https://news.test/story', 13, { title: 'Story', favIconUrl: 'data:image/png;base64,Y' })]);
  s = M.upsertTab(s, { id: 4, windowId: 1, index: 4, url: oldAt('https://news.test/story', { title: 'Story' }), title: 'Story', active: false }, NOW);
  const stale = M.staleTabs(s, NOW);
  assert.deepEqual(stale.map((t) => t.id), [4]);
  const entry = M.archiveEntryForTab(s, stale[0], { id: 'a1', closedAt: NOW });
  assert.deepEqual({ url: entry.url, title: entry.title, favIconUrl: entry.favIconUrl }, { url: 'https://news.test/story', title: 'Story', favIconUrl: 'data:image/png;base64,Y' });
});

test('after the update, a tab on an earlier build\'s sleep page is matched to its record by its page\'s address (its space kept), still asleep', () => {
  const work = M.createSpace(withTabs([rec(1, 'https://a.test/', 1), rec(2, 'https://sleepy.test/x', 6, { sleeping: { at: NOW - HOUR, how: 'page' } })]), { id: 'work', name: 'Work' });
  const before = { ...work, tabSpace: { 1: 'personal', 2: 'work' } };
  const old = oldAt('https://sleepy.test/x', { title: 'Sleepy', base: 'safari-web-extension://old-copy/' });
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

test('an earlier copy\'s sleep page isn\'t moved to this copy\'s (there\'s none: background/tabs.js keeps or loads its tab); the new-tab page is', () => {
  assert.equal(oldOwnPageAddress(oldAt('https://a.test/?q=1', { base: 'safari-web-extension://old-copy/' }), BASE), null);
  assert.equal(oldOwnPageAddress('safari-web-extension://old-copy/newtab/newtab.html', BASE), `${BASE}newtab/newtab.html?again`, 'the new-tab page as before');
});

// ---- the sleep pass (background/sleep.js) ------------------------------------------

/** @param {any[]} tabs @param {Record<string, any>} [settings] */
async function setUp(tabs, settings = {}) {
  fake.tabs = new Map(tabs.map((t) => [t.id, { windowId: 1, status: 'complete', active: false, audible: false, title: `T${t.id}`, ...t }]));
  fake.updates = [];
  fake.removed = [];
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
// The tabs a pass closed, each said to be Margin's own close, to keep (closing.js 'keep', 'sleep').
const slept = () => fake.removed.map((id) => {
  assert.deepEqual(takeClosing(id), { how: 'keep', why: 'sleep' }, `${id}: closed to be kept, asleep`);
  return id;
});

test('a pass: each tab long unused asked in its page, then closed as Margin\'s own close, to be kept (its Margin tab, not open), at most a few per pass, one at a time', async () => {
  await setUp([{ id: 1, url: 'https://front.test/', active: true }, ...[2, 3, 4, 5, 6, 7, 8].map((id) => ({ id, url: `https://s${id}.test/p`, idleHours: 4 + id }))]);
  const lines = [];
  switchLogTo((line) => lines.push(line));
  const pass = await sleepIdle();
  switchLogTo(null);
  assert.deepEqual(pass, { due: 7, slept: 5, skipped: { 'next pass': 2 }, stopped: null });
  assert.deepEqual(slept(), [8, 7, 6, 5, 4], 'the longest unused first');
  const asked = fake.scripts.filter((x) => x.func === 'sleepInPage');
  assert.deepEqual(asked.map((x) => x.tabId), [8, 7, 6, 5, 4]);
  assert.equal(asked[0].args[0], 'https://s8.test/p', 'asked whether it\'s still that page');
  assert.deepEqual(fake.updates, [], 'none sent anywhere, none brought to the front');
  assert.equal(lines.length, 1, 'one line in Margin.app\'s log for the pass');
  assert.match(lines[0], /^sleep: 7 due, 5 put to sleep \(tab 8 closed, kept, unused 7\d\d min, its page judged by margin; tab 7 .*\); skipped: next pass 2 \(\d+ ms\)$/);
  // The state as onRemoved brings it in (Margin's close, to keep: background.js closedTab).
  await mutate((s) => [8, 7, 6, 5, 4].reduce((st, id) => M.closedTab(st, id, { by: { how: 'keep', why: 'sleep' }, now: Date.now(), archiveId: `a${id}` }), s));
  const s = await load();
  assert.equal(s.tabs[8], undefined);
  assert.ok(Object.values(s.keptTabs).some((k) => k.url === 'https://s8.test/p' && k.why === 'sleep'), 'kept, not open, asleep');
  // The next pass: the two left (the five closed aren't due).
  const next = await sleepIdle();
  assert.deepEqual(next, { due: 2, slept: 2, skipped: {}, stopped: null });
});

test('a pass leaves alone: a tab in front, playing sound, loading, already asleep, not a web page, on the never list, not reachable, with a draft, playing, or shown meanwhile; one whose page doesn\'t answer in time, or has none (Safari unloaded it), waits for the next pass', async () => {
  const tabs = [
    { id: 1, url: 'https://front.test/', active: true },
    { id: 2, url: 'https://sound.test/', audible: true },
    { id: 3, url: 'https://loading.test/', status: 'loading' },
    { id: 4, url: oldAt('https://zzz.test/', { base: 'safari-web-extension://old/' }) },
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
  assert.deepEqual([fake.updates, fake.removed], [[], []], 'none sent anywhere or closed');
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
  assert.deepEqual(fake.removed, [], 'none put to sleep');
  assert.deepEqual(fake.scripts.filter((x) => x.func === 'sleepInPage').map((x) => x.tabId), [2], '3 not even asked');
});

test('a page that said no isn\'t asked again each pass (asking resumes its process): not until its tab is used again, or an hour has passed; a pass asked for by hand asks it', async () => {
  await setUp([{ id: 2, url: 'https://draft.test/' }, { id: 3, url: 'https://idle.test/' }]);
  let draft = true;
  fake.page = (tabId) => (tabId === 2 && draft ? { ok: false, why: 'edited', judged: 'margin' } : { ok: true });
  const askedOf = (id) => fake.scripts.filter((x) => x.func === 'sleepInPage' && x.tabId === id).length;
  assert.deepEqual((await sleepIdle()).skipped, { edited: 1 });
  assert.equal(askedOf(2), 1);
  await mutate((s) => M.closedTab(s, 3, { by: { how: 'keep', why: 'sleep' }, now: Date.now(), archiveId: 'a3' })); // 3 asleep, as onRemoved brings it in
  assert.deepEqual(slept(), [3]);
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

test('Wake all, in Safari: nothing to wake (a sleeping tab is closed, and opens as it\'s clicked); a tab on an earlier build\'s sleep page is left to the repair', async () => {
  await setUp([{ id: 1, url: 'https://front.test/', active: true }, { id: 2, url: oldAt('https://two.test/') }, { id: 4, url: 'https://awake.test/' }]);
  assert.equal(await wakeAll(), 0);
  assert.deepEqual([fake.updates, fake.removed], [[], []]);
});
