// Margin 2 Phase 2 step 7: what pages said in their own UI, said by
// Margin.app's overlay. The copy's side, against a fake of the browser's API
// (the background as tests/no-ui-in-pages.test.js runs it) and a stand-in for
// the link: the notices the copy decides and pushes for a window (a page
// whose Margin is gone, one bound to an older copy), their buttons coming
// back as `noticeAction`, which tabs are loading (the tab's status, the page
// being left, a site's own navigation). And the rest of the way: the words
// (shared/notices.js), the overlay's notices and gestures
// (ui/app-feedback.js), the app host's loading and failures
// (ui/host-app.js), the gesture's view model, the page's own tellers
// (content/loads.js, content/trackpad.js gestureTeller). Safari's New Tab
// note: tests/wake.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listeners = {};
const event = (name) => ({ addListener: (fn) => (listeners[name] ??= []).push(fn), removeListener() {}, hasListener: () => false });
const fire = (name, ...args) => Promise.all((listeners[name] ?? []).map((fn) => fn(...args)));

const fake = { tabs: new Map(), nextId: 500, created: [], removed: [], local: {}, session: {}, registered: new Map(), toPages: [], updated: [], script: null };
const pick = (store, keys) => {
  if (keys == null) return structuredClone(store);
  const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
  return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
};
const NEW_TAB = 'safari-web-extension://test/newtab/newtab.html';
globalThis.fetch = async () => ({ ok: true, text: async () => '{}', json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) });
globalThis.chrome = {
  runtime: {
    id: 'test',
    getURL: (p) => `safari-web-extension://test/${p}`,
    getManifest: () => ({ version: '0', content_scripts: [{ js: ['content.js'] }] }),
    onInstalled: event('onInstalled'), onStartup: event('onStartup'), onMessage: event('onMessage'),
    sendMessage: async () => undefined,
    sendNativeMessage: async () => undefined,
  },
  permissions: { contains: async () => true, onAdded: event('pAdded'), onRemoved: event('pRemoved') },
  alarms: { get: async () => ({}), create: async () => {}, clear: async () => true, onAlarm: event('onAlarm') },
  commands: { onCommand: event('onCommand') },
  windows: {
    get: async (id) => ({ id, focused: true }), getAll: async () => [{ id: 1, focused: true }], getLastFocused: async () => ({ id: 1 }),
    update: async () => {}, create: async () => ({}), onFocusChanged: event('onFocusChanged'), onRemoved: event('wRemoved'), onBoundsChanged: event('wBounds'),
  },
  tabs: {
    get: async (id) => { const t = fake.tabs.get(id); if (!t) throw new Error(`No tab with id: ${id}`); return { ...t }; },
    query: async (filter = {}) => [...fake.tabs.values()].filter((t) => (filter.active == null || t.active === filter.active) && (filter.windowId == null || t.windowId === filter.windowId)).map((t) => ({ ...t })),
    update: async (id, props) => { fake.updated.push({ id, ...props }); return { ...fake.tabs.get(id) }; },
    create: async ({ windowId, url }) => {
      const tab = { id: fake.nextId++, windowId: windowId ?? 1, url, title: '', index: fake.tabs.size, active: false, status: 'loading' };
      fake.tabs.set(tab.id, tab);
      fake.created.push(url);
      return { ...tab };
    },
    remove: async (ids) => { for (const id of [].concat(ids)) { fake.removed.push(id); fake.tabs.delete(id); } },
    sendMessage: async (tabId, message) => { fake.toPages.push(message?.type); return undefined; },
    getZoom: async () => 1, getZoomSettings: async () => ({ defaultZoomFactor: 1 }), reload: async (id) => { fake.updated.push({ id, reload: true }); },
    onActivated: event('onActivated'), onCreated: event('onCreated'), onUpdated: event('onUpdated'), onRemoved: event('onRemoved'),
    onMoved: event('onMoved'), onAttached: event('onAttached'), onDetached: event('onDetached'), onZoomChange: event('onZoomChange'),
  },
  scripting: {
    executeScript: async (details) => [{ result: fake.script ? fake.script(details) : true }],
    getRegisteredContentScripts: async ({ ids } = {}) => [...fake.registered.values()].filter((s) => !ids || ids.includes(s.id)).map((s) => structuredClone(s)),
    registerContentScripts: async (list) => { for (const s of list) fake.registered.set(s.id, structuredClone(s)); },
    unregisterContentScripts: async ({ ids } = {}) => { for (const id of ids ?? [...fake.registered.keys()]) fake.registered.delete(id); },
    updateContentScripts: async () => {},
  },
  storage: {
    local: {
      get: async (keys) => pick(fake.local, keys),
      set: async (items) => {
        const changes = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { oldValue: fake.local[k], newValue: structuredClone(v) }]));
        Object.assign(fake.local, structuredClone(items));
        void fire('sChanged', changes, 'local');
      },
      remove: async (keys) => { for (const k of [].concat(keys)) delete fake.local[k]; },
    },
    session: {
      get: async (keys) => pick(fake.session, keys),
      set: async (items) => { Object.assign(fake.session, structuredClone(items)); },
      remove: async () => {},
    },
    onChanged: event('sChanged'),
  },
};

fake.tabs.set(1, { id: 1, windowId: 1, url: 'https://a.test/', title: 'A', index: 0, active: true, status: 'complete' });
fake.local.settings = { fullscreenOnly: false }; // Chrome's profile (this file's): Margin in every window
fake.session.alive = true;
fake.session.since = 1;
fake.session.startWorkAt = Date.now();

const sender = (id) => ({ tab: { ...fake.tabs.get(id) }, url: fake.tabs.get(id)?.url });
function ask(type, payload = {}, from = 1) {
  return new Promise((resolve) => {
    listeners.onMessage[0]({ type, ...payload }, sender(from), (reply) => resolve(reply));
  });
}

await import('../extension/background.js');
const store = await import('../extension/background/store.js');
for (let i = 0; i < 100 && !store.isSynced(); i++) await sleep(10);
assert.ok(store.isSynced(), 'synced');

// The link, linked: what's pushed to each window's overlay.
const pushed = [];
let linked = true;
const stand = { linked: () => linked, push: (windowId, msg) => { if (!linked) return false; pushed.push({ windowId, msg }); return true; } };
const notices = await import('../extension/background/notices.js');
const pageLoads = await import('../extension/background/page-loads.js');
notices.useLinkForTests(stand);
pageLoads.useLinkForTests(stand);
const { repairCutOff, forgetCurrent } = await import('../extension/background/tabs.js');
const words = await import('../extension/shared/notices.js');
const { createAppNotices, createGestureFeedback, GESTURE_DONE_MS } = await import('../extension/ui/app-feedback.js');
const { createAppHost } = await import('../extension/ui/host-app.js');
const { buildViewModel } = await import('../extension/ui/view-model.js');
const { startLoads, TRANSITION_MS } = await import('../extension/content/loads.js');
const { gestureTeller, GESTURE_TELL_MS } = await import('../extension/content/trackpad.js');
const kinds = (kind) => pushed.filter((p) => p.msg.type === 'notice' && p.msg.kind === kind);

// ---- the words ------------------------------------------------------------------

test('notices: Margin\'s words, each kind\'s buttons; a switch that didn\'t happen gets the notice for why', () => {
  assert.deepEqual(Object.keys(words.NOTICES).sort(), ['new-tab-setting', 'no-answer', 'not-responding', 'not-shown', 'tab-gone', 'updated-while-open']);
  assert.match(words.NOTICES['not-responding'].text, /isn’t responding on this page/);
  assert.deepEqual(words.NOTICES['not-responding'].actions.map((a) => a.id), ['reload', 'later']);
  assert.match(words.NOTICES['updated-while-open'].text, /Quit and reopen Safari/);
  assert.match(words.NOTICES['new-tab-setting'].text, /Safari Settings › General, set “New tabs open with” to Margin/, 'the set-up window\'s words');
  assert.equal(words.isNoticeAction('new-tab-setting', 'never'), true);
  assert.equal(words.isNoticeAction('new-tab-setting', 'reload'), false);
  assert.equal(words.isNotice('toString'), false);
  assert.equal(words.switchFailure('That tab is no longer open'), 'tab-gone');
  assert.equal(words.switchFailure('No tab with id: 4'), 'tab-gone');
  assert.equal(words.switchFailure('no answer from Margin: timedOut'), 'no-answer');
  assert.equal(words.switchFailure('Too late'), 'not-shown');
  assert.equal(words.switchFailure('no answer from Margin: down'), null, 'the link down: the overlay says it\'s reconnecting');
  assert.equal(words.switchFailure('a newer copy of Margin is running'), null);
  assert.equal(words.switchFailure(null), null, 'no reason given: no notice (as pages had it)');
});

// ---- the copy deciding -------------------------------------------------------------

test('a page in front whose Margin is gone: "isn\'t responding" in its window\'s overlay, once a page; Reload loads it again (a GET), and it\'s not said again', async () => {
  pushed.length = 0;
  notices.resetNotices();
  fake.tabs.set(30, { id: 30, windowId: 4, url: 'https://draft.test/', title: 'Draft', index: 2, active: true, status: 'complete' });
  fake.script = () => ({ cutOff: true, busy: true, hidden: false, proven: false }); // something typed: not reloaded by Margin
  assert.equal(await repairCutOff({ ...fake.tabs.get(30) }), 'quiet');
  assert.deepEqual(kinds('not-responding'), [{ windowId: 4, msg: { type: 'notice', kind: 'not-responding', tabId: 30 } }]);
  assert.equal(fake.updated.filter((u) => u.id === 30).length, 0, 'not loaded again by Margin: in use');
  forgetCurrent(30);
  await repairCutOff({ ...fake.tabs.get(30) });
  assert.equal(kinds('not-responding').length, 1, 'said once a page');
  const reply = await ask('noticeAction', { notice: 'not-responding', action: 'reload', tabId: 30 });
  assert.deepEqual(reply, { ok: true, result: true });
  assert.deepEqual(fake.updated.filter((u) => u.id === 30), [{ id: 30, url: 'https://draft.test/' }], 'a GET of its address');
  notices.resetNotices();
  notices.noticeAnswered('not-responding', 30, 'https://draft.test/');
  assert.equal(notices.tellNotice(4, 'not-responding', { tabId: 30, url: 'https://draft.test/' }), false, 'answered: never again for that page');
  assert.equal(notices.tellNotice(4, 'not-responding', { tabId: 30, url: 'https://draft.test/other' }), true, 'another page in that tab may');
  fake.script = null;
});

test('a page behind whose Margin is gone: no notice (Margin loads it again)', async () => {
  pushed.length = 0;
  notices.resetNotices();
  fake.tabs.set(31, { id: 31, windowId: 4, url: 'https://behind.test/', title: 'Behind', index: 3, active: false, status: 'complete' });
  fake.script = () => ({ cutOff: true, busy: false, hidden: true, proven: false });
  assert.equal(await repairCutOff({ ...fake.tabs.get(31) }), 'reloaded');
  assert.deepEqual(kinds('not-responding'), []);
  fake.script = null;
});

test('a page in front bound to an older copy Safari still runs: "updated while Safari was open"; behind, nothing', async () => {
  pushed.length = 0;
  notices.resetNotices();
  fake.tabs.set(32, { id: 32, windowId: 5, url: 'https://old.test/', title: 'Old', index: 0, active: true, status: 'complete' });
  fake.tabs.set(33, { id: 33, windowId: 5, url: 'https://old2.test/', title: 'Old 2', index: 1, active: false, status: 'complete' });
  fake.script = () => ({ cutOff: false, otherCopy: true });
  assert.equal(await repairCutOff({ ...fake.tabs.get(33) }), false);
  assert.deepEqual(kinds('updated-while-open'), [], 'behind: nothing');
  assert.equal(await repairCutOff({ ...fake.tabs.get(32) }), false);
  assert.deepEqual(kinds('updated-while-open'), [{ windowId: 5, msg: { type: 'notice', kind: 'updated-while-open', tabId: 32 } }]);
  assert.deepEqual(await ask('noticeAction', { notice: 'updated-while-open', action: 'ok', tabId: 32 }), { ok: true, result: true });
  fake.script = null;
});

test('not linked: kept, and said once linked if its page is still in front; only Margin\'s own kinds', async () => {
  pushed.length = 0;
  notices.resetNotices();
  linked = false;
  assert.equal(notices.tellNotice(1, 'not-responding', { tabId: 1, url: 'https://a.test/' }), false);
  assert.equal(notices.tellNotice(1, 'updated-while-open', { tabId: 2, url: 'https://b.test/' }), false);
  assert.equal(notices.tellNotice(1, 'not-responding', { tabId: 3, url: 'https://c.test/', now: Date.now() - 2 * notices.PENDING_MS }), false);
  assert.deepEqual(pushed, [], 'nowhere to say it yet');
  linked = true;
  const tabs = { 1: { id: 1, windowId: 1, active: true, url: 'https://a.test/' }, 2: { id: 2, windowId: 1, active: false, url: 'https://b.test/' }, 3: { id: 3, windowId: 1, active: true, url: 'https://c.test/' } };
  assert.equal(await notices.linkedAgain({ getTab: async (id) => tabs[id] }), 1);
  assert.deepEqual(pushed, [{ windowId: 1, msg: { type: 'notice', kind: 'not-responding', tabId: 1 } }], 'the page still in front: said; one behind now, or decided too long ago: not');
  assert.equal(await notices.linkedAgain({ getTab: async (id) => tabs[id] }), 0, 'once');
  pushed.length = 0;
  assert.equal(notices.tellNotice(1, 'nonsense', { tabId: 1 }), false);
  assert.deepEqual(pushed, []);
});

test('noticeAction: "Don\'t show again" on the New Tab note turns its setting off; anything not a notice\'s button is refused', async () => {
  assert.deepEqual(await ask('noticeAction', { notice: 'new-tab-setting', action: 'never', tabId: 1 }), { ok: true, result: true });
  assert.equal((await store.load()).settings.newTabHint, false);
  assert.deepEqual(await ask('noticeAction', { notice: 'new-tab-setting', action: 'reload', tabId: 1 }), { ok: true, result: false });
  assert.deepEqual(await ask('noticeAction', { notice: 'whatever', action: 'ok' }), { ok: true, result: false });
  const { APP_REQUESTS } = await import('../extension/background/link.js');
  assert.ok(APP_REQUESTS.has('noticeAction'), 'a request the app\'s UI makes');
  await store.mutate((s) => ({ ...s, settings: { ...s.settings, newTabHint: true } }));
});

test('loading: the tab\'s status, the page being left, a site\'s own navigation, each for its window\'s overlay, a moment after it changes', async () => {
  pageLoads.resetLoads();
  pushed.length = 0;
  const loads = () => pushed.filter((p) => p.msg.type === 'loading').map((p) => [p.windowId, p.msg.tabIds]);
  // The page in front being left (its beforeunload): long before Safari says the tab is loading.
  await ask('pageLoading', { on: true, why: 'leaving' }, 1);
  await sleep(40);
  assert.deepEqual(loads(), [[1, [1]]]);
  await fire('onUpdated', 1, { status: 'loading' }, { ...fake.tabs.get(1), status: 'loading' });
  await sleep(40);
  assert.deepEqual(loads(), [[1, [1]]], 'loading still: nothing new to say');
  await fire('onUpdated', 1, { status: 'complete' }, { ...fake.tabs.get(1), status: 'complete' });
  await sleep(40);
  assert.deepEqual(loads(), [[1, [1]], [1, []]], 'its next page loaded: done, the leaving too');
  // A same-page navigation.
  await ask('pageLoading', { on: true, why: 'navigating' }, 1);
  await sleep(40);
  await ask('pageLoading', { on: false, why: 'navigating' }, 1);
  await sleep(40);
  assert.deepEqual(loads().slice(2), [[1, [1]], [1, []]]);
  // A tab in another window: told to that window only; closed: gone.
  await fire('onUpdated', 30, { status: 'loading' }, { ...fake.tabs.get(30), status: 'loading' });
  await sleep(40);
  assert.deepEqual(loads().at(-1), [4, [30]]);
  await fire('onRemoved', 30, { windowId: 4, isWindowClosing: false });
  await sleep(40);
  assert.deepEqual(loads().at(-1), [4, []]);
  assert.deepEqual(pageLoads.loadingTabs(1), []);
});

test('loading: a sign that never ends goes after its time', async () => {
  pageLoads.resetLoads();
  pushed.length = 0;
  const { MAX_MS } = pageLoads;
  const was = MAX_MS.leaving;
  MAX_MS.leaving = 60;
  try {
    pageLoads.pageSaid(7, 2, true, 'leaving');
    await sleep(30);
    assert.deepEqual(pageLoads.loadingTabs(2), [7]);
    await sleep(80);
    assert.deepEqual(pageLoads.loadingTabs(2), []);
    assert.deepEqual(pushed.filter((p) => p.msg.type === 'loading').map((p) => p.msg.tabIds), [[7], []]);
  } finally {
    MAX_MS.leaving = was;
  }
});

// ---- the overlay drawing it ----------------------------------------------------------

function overlayNotices(front = () => 12) {
  const shown = [];
  const sent = [];
  const timers = [];
  const n = createAppNotices({
    show: (v) => shown.push(v),
    send: (type, payload) => sent.push([type, payload]),
    frontTab: front,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  });
  return { n, shown, sent, timers };
}

test('the overlay\'s notices: a pushed kind drawn in Margin\'s words; its button closes it and goes to the copy as noticeAction, with its tab', () => {
  const { n, shown, sent, timers } = overlayNotices();
  assert.equal(n.push({ type: 'notice', kind: 'not-responding', tabId: 12 }), true);
  const v = shown.at(-1);
  assert.equal(v.text, words.NOTICES['not-responding'].text);
  assert.deepEqual(v.actions.map((a) => a.label), ['Reload', 'Not now']);
  assert.equal(timers.at(-1).ms, 20000);
  assert.equal(n.run({ id: 'someone else', action: 'reload' }), false);
  assert.equal(n.run({ id: v.id, action: 'reload' }), true);
  assert.deepEqual(sent, [['noticeAction', { notice: 'not-responding', action: 'reload', tabId: 12 }]]);
  assert.equal(n.current, null);
  assert.equal(n.push({ type: 'notice', kind: 'make me say this' }), false, 'only Margin\'s kinds: no words from the link');
});

test('the overlay\'s notices: one about a tab\'s page goes once another tab is in front; a switch\'s goes by itself; the newest takes the place', () => {
  let front = 12;
  const { n, shown, timers } = overlayNotices(() => front);
  n.push({ type: 'notice', kind: 'updated-while-open', tabId: 12 });
  n.front(12);
  assert.ok(n.current);
  front = 13;
  n.front(13);
  assert.equal(n.current, null);
  assert.equal(shown.at(-1), null, 'taken down');
  // About a tab not in front yet (a switch to it under way): kept until it has been.
  n.push({ type: 'notice', kind: 'not-responding', tabId: 14 });
  n.front(13);
  assert.equal(n.current?.kind, 'not-responding');
  n.front(14);
  n.front(13);
  assert.equal(n.current, null);
  // A switch that didn't happen: the copy's, with why; this overlay's own request's.
  assert.equal(n.push({ type: 'switch-failed', tabId: 5 }), false, 'no reason: no notice');
  assert.equal(n.push({ type: 'switch-failed', tabId: 5, reason: 'That tab is no longer open' }), true);
  assert.equal(shown.at(-1).text, 'That tab is no longer open.');
  assert.equal(timers.at(-1).ms, 4000);
  assert.equal(n.switchFailed('no answer from Margin: timedOut'), true);
  assert.equal(n.current.kind, 'no-answer', 'the newest');
  timers.at(-1).fn();
  assert.equal(n.current, null, 'after its time');
  assert.equal(n.switchFailed('no answer from Margin: down'), false);
});

test('the app host: the window\'s tabs loading from the copy\'s push, drawn as the rows\' and the tab in front\'s loading; why a request failed', async () => {
  const { toStorage } = await import('../extension/shared/stored.js');
  const { smallState, W } = await import('./ui/fixtures.js');
  const state = smallState();
  const raw = toStorage(state, ['spaces', 'pins', 'folders', 'archive', 'settings', 'tabs', 'tabSpace', 'activeSpaceByWindow', 'favicons'], { origin: 'o', since: 1, synced: true });
  const front = Object.values(state.tabs).find((t) => t.windowId === W && t.active);
  const before = buildViewModel({ state: { ...state, openTabsBy: null }, ui: { windowId: W, mode: 'fullscreen' } });
  const other = before.space.today.find((r) => r.id !== front.id && r.open);
  let answer = { ok: false, error: 'That tab is no longer open' };
  const noticed = [];
  const host = createAppHost({
    hello: { windowId: W, state: raw, windows: [{ windowId: W, state: 'fullscreen', activeTabId: front.id }] },
    post: async (op) => (op === 'send' ? JSON.stringify(answer) : null),
    onNotice: (arg) => noticed.push(arg),
    warn: () => {},
  });
  assert.equal(host.frontTabId, front.id);
  let drawn = 0;
  host.onState(() => drawn++);
  host.receive({ type: 'push', msg: { type: 'loading', tabIds: [front.id, other.id, 'x'] } });
  assert.equal(drawn, 1);
  assert.deepEqual(host.loading.sort(), [front.id, other.id].sort());
  const vm = buildViewModel({ state: host.getState(), ui: { windowId: W, mode: 'fullscreen' }, platform: host.platform });
  assert.equal(vm.tab.loading, true, 'the tab in front');
  const row = vm.space.today.find((r) => r.id === other.id);
  assert.ok(row, 'its row');
  assert.equal(row.loading, true, 'loading');
  host.receive({ type: 'push', msg: { type: 'loading', tabIds: [front.id, other.id] } });
  assert.equal(drawn, 1, 'the same set: nothing drawn again');
  host.receive({ type: 'push', msg: { type: 'loading', tabIds: [] } });
  assert.equal(buildViewModel({ state: host.getState(), ui: { windowId: W }, platform: host.platform }).tab.loading, false);
  // A request that failed: why, once, for the notice.
  assert.equal(await host.send('activateTab', { tabId: other.id }), undefined);
  assert.deepEqual(host.takeFailure(), { type: 'activateTab', error: 'That tab is no longer open' });
  assert.equal(host.takeFailure(), null, 'taken once');
  answer = { ok: false, stale: true, error: 'a newer copy of Margin is running' };
  await host.send('activateTab', { tabId: other.id });
  assert.equal(host.takeFailure(), null, 'a copy that stood back: nothing to say');
  // A notice's button: to the overlay's notices.
  assert.equal(host.perform('notice', { id: 'n#1', action: 'ok' }), true);
  assert.deepEqual(noticed, [{ id: 'n#1', action: 'ok' }]);
});

test('gestures: the view model\'s gesture from the overlay\'s feedback; done goes after a moment, one that stops being told after its time', () => {
  const set = [];
  const timers = [];
  const g = createGestureFeedback({ set: (v) => set.push(v), setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
  g.push({ kind: 'pull', state: 'pulling', progress: 0.43 });
  const vm = (ui) => buildViewModel({ state: null, ui: { gesture: ui } }).gesture;
  assert.deepEqual({ ...vm(set.at(-1)) }, { pull: true, swipe: false, back: false, forward: false, armed: false, done: false, progress: 0.45, percent: 45 });
  assert.equal(timers.at(-1).ms, 1000);
  g.push({ kind: 'pull', state: 'trigger', progress: 1.2 });
  assert.deepEqual({ ...vm(set.at(-1)) }, { pull: true, swipe: false, back: false, forward: false, armed: true, done: true, progress: 1, percent: 100 });
  assert.equal(timers.at(-1).ms, GESTURE_DONE_MS);
  timers.at(-1).fn();
  assert.equal(set.at(-1), null);
  g.push({ kind: 'swipe', state: 'armed', progress: 1, direction: 1 });
  assert.deepEqual({ ...vm(set.at(-1)) }, { pull: false, swipe: true, back: false, forward: true, armed: true, done: false, progress: 1, percent: 100 });
  g.push({ kind: 'swipe', state: 'idle' });
  assert.equal(set.at(-1), null);
  assert.equal(vm(null), null);
});

test('gestures: the page tells a change of state at once, its progress in steps of 0.05 at most every 30 ms, nothing while idle', () => {
  let t = 0;
  const told = [];
  const tell = gestureTeller('pull', (g) => told.push(g), () => t);
  tell({ state: 'idle', progress: 0 });
  assert.deepEqual(told, [], 'idle from idle: nothing');
  tell({ state: 'pulling', progress: 0.11 });
  t += 5; tell({ state: 'pulling', progress: 0.3 });
  t += 5; tell({ state: 'armed', progress: 1 });
  t += GESTURE_TELL_MS; tell({ state: 'armed', progress: 1.4 });
  t += 1; tell({ state: 'trigger', progress: 1 });
  assert.deepEqual(told.map((g) => [g.state, g.progress]), [['pulling', 0.1], ['armed', 1], ['trigger', 1]]);
  const swipe = [];
  gestureTeller('swipe', (g) => swipe.push(g), () => 0)({ state: 'pulling', progress: 0.5, direction: -1 });
  assert.deepEqual(swipe, [{ kind: 'swipe', state: 'pulling', progress: 0.5, direction: -1 }]);
});

test('loads: the page being left told at once, taken back when it stays; a slow same-page navigation told until it ends; nothing while the app doesn\'t draw', async () => {
  const handlers = {};
  const win = { addEventListener: (type, fn) => { (handlers[type] ??= []).push(fn); }, navigation: { transition: null, addEventListener: (type, fn) => { (handlers[`nav:${type}`] ??= []).push(fn); } } };
  const said = [];
  let on = true;
  startLoads({ on: () => on, send: (type, payload) => said.push([type, payload]), win });
  const ev = { defaultPrevented: false, returnValue: '' };
  handlers.beforeunload[0](ev);
  assert.deepEqual(said, [['pageLoading', { on: true, why: 'leaving' }]]);
  handlers.pointerdown[0]();
  assert.deepEqual(said.at(-1), ['pageLoading', { on: false, why: 'leaving' }], 'the person did something there: it stayed');
  // A "Leave page?" prompt: taken back once the event is done.
  handlers.beforeunload[0]({ defaultPrevented: true });
  await sleep(5);
  assert.deepEqual(said.slice(-2), [['pageLoading', { on: true, why: 'leaving' }], ['pageLoading', { on: false, why: 'leaving' }]]);
  let finish;
  win.navigation.transition = { finished: new Promise((resolve) => { finish = resolve; }) };
  handlers['nav:navigate'][0]();
  await sleep(TRANSITION_MS + 40);
  assert.deepEqual(said.at(-1), ['pageLoading', { on: true, why: 'navigating' }]);
  finish();
  await sleep(5);
  assert.deepEqual(said.at(-1), ['pageLoading', { on: false, why: 'navigating' }]);
  on = false;
  const before = said.length;
  handlers.beforeunload[0](ev);
  assert.equal(said.length, before, 'not drawn by the app: nothing');
});
