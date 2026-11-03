// A page's switch is answered before the page stops waiting (its deadline),
// whatever Safari or storage does meanwhile (background.js's reply guard,
// background/tabs.js focusTab), and a page says Margin isn't responding only
// once its copy is gone (shared/no-answer.js). Through background.js's own
// message listener, against a fake Safari whose calls can hang, as a tab's
// hung process made them on 2026-11-03.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const never = () => new Promise(() => {});
const listeners = {};
const event = (name) => ({ addListener: (fn) => (listeners[name] ??= []).push(fn), removeListener() {}, hasListener: () => false });
const fire = (name, ...args) => (listeners[name] ?? []).map((fn) => fn(...args));

const fake = {
  tabs: new Map(),
  // Tabs whose process hangs: Safari's update of one answers (and happens)
  // only at `hungUntil` (never, with Infinity).
  hung: new Map(),
  // Tabs whose tabs.get waits on their hung process until then.
  getHung: new Map(),
  // Safari's updates all held up, in order, until then (and their
  // activations with them): Safari busy behind a hung process.
  stallUntil: 0,
  prepNotReady: false, // a page's sidebar answers that it isn't ready
  queryMs: 0, // how long tabs.query takes (Safari busy)
  localSetMs: 0,
  local: {},
  session: {},
  updates: [],
  created: [],
};
let stalled = Promise.resolve();
const pick = (store, keys) => {
  if (keys == null) return structuredClone(store);
  const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
  return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
};
const bringToFront = (id) => {
  const tab = fake.tabs.get(id);
  if (!tab || tab.active) return;
  for (const t of fake.tabs.values()) if (t.windowId === tab.windowId) t.active = t.id === id;
  fire('onActivated', { tabId: id, windowId: tab.windowId });
};
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
  alarms: { get: async () => null, create: async () => {}, clear: async () => true, onAlarm: event('onAlarm') },
  commands: { onCommand: event('onCommand') },
  windows: {
    get: async (id) => ({ id, focused: true }), getAll: async () => [{ id: 1, focused: true }], getLastFocused: async () => ({ id: 1 }),
    update: async () => {}, onFocusChanged: event('onFocusChanged'), onRemoved: event('wRemoved'), onBoundsChanged: event('wBounds'),
  },
  tabs: {
    get: async (id) => { const u = fake.getHung.get(id); if (u === Infinity) await never(); if (u > Date.now()) await sleep(u - Date.now()); const t = fake.tabs.get(id); if (!t) throw new Error(`No tab with id ${id}`); return { ...t }; },
    query: async ({ active, windowId } = {}) => {
      if (fake.queryMs) await sleep(fake.queryMs);
      return [...fake.tabs.values()].filter((t) => (active == null || t.active === active) && (windowId == null || t.windowId === windowId)).map((t) => ({ ...t }));
    },
    update: async (id, change) => {
      fake.updates.push({ id, change, at: Date.now() });
      if (fake.stallUntil > Date.now()) {
        const turn = stalled.then(() => sleep(Math.max(0, fake.stallUntil - Date.now()))).then(() => {
          if (change.active) bringToFront(id);
          return { ...fake.tabs.get(id) };
        });
        stalled = turn.catch(() => {});
        return turn;
      }
      const until = fake.hung.get(id);
      if (until === Infinity) return never();
      if (until > Date.now()) await sleep(until - Date.now());
      if (change.active) bringToFront(id);
      return { ...fake.tabs.get(id) };
    },
    sendMessage: (tabId, message) => (message?.type === 'margin-hold' ? never() : sleep(2).then(() => (message?.type === 'switching' || message?.type === 'margin-release' ? true : undefined))),
    getZoom: async () => 1, getZoomSettings: async () => ({ defaultZoomFactor: 1 }),
    create: async (options) => { fake.created.push({ ...options, at: Date.now() }); return { id: 999, windowId: 1, url: options?.url, active: !!options?.active, index: 9, status: 'loading' }; }, remove: async () => {}, reload: async () => {},
    onActivated: event('onActivated'), onCreated: event('onCreated'), onUpdated: event('onUpdated'), onRemoved: event('onRemoved'),
    onMoved: event('onMoved'), onAttached: event('onAttached'), onDetached: event('onDetached'), onZoomChange: event('onZoomChange'),
  },
  scripting: {
    executeScript: ({ func, args }) => {
      let result = true;
      if (func?.name === 'prepareSidebarInPage') result = fake.prepNotReady ? { ready: false, reason: 'busy' } : { ready: true, token: args?.[0]?.token };
      else if (func?.name === 'paintBarrierInPage') result = 'drawn';
      else if (func?.name === 'cutOffInPage') result = { cutOff: false };
      else if (func?.name === 'readyInPage') result = 'loaded';
      return sleep(2).then(() => [{ result }]);
    },
    getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {}, updateContentScripts: async () => {},
  },
  storage: {
    local: {
      get: async (keys) => pick(fake.local, keys),
      set: async (items) => { if (fake.localSetMs) await sleep(fake.localSetMs); Object.assign(fake.local, structuredClone(items)); },
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

for (let id = 1; id <= 9; id++) fake.tabs.set(id, { id, windowId: 1, url: `https://t${id}.test/`, title: `T${id}`, index: id - 1, status: 'complete', active: id === 1 });

await import('../extension/background.js');
const store = await import('../extension/background/store.js');
const M = await import('../extension/state/model.js');
const { focusTab, isNeverShown, tabOpened, tabShown } = await import('../extension/background/tabs.js');
const { copyAlive, mayNotice } = await import('../extension/shared/no-answer.js');

const front = () => [...fake.tabs.values()].find((t) => t.active).id;
const sender = (id) => ({ tab: { ...fake.tabs.get(id) }, url: fake.tabs.get(id).url });
// A page's request, as content/core.js send() makes it, with its deadline.
// Shorter than a page's 7 s, so the tests don't take that long: the limits
// all count back from it.
const WAIT_MS = 3000;
function ask(type, payload = {}, from = front()) {
  const asked = Date.now();
  const deadline = asked + WAIT_MS;
  return new Promise((resolve) => {
    const keep = listeners.onMessage[0]({ type, ...payload, deadline }, sender(from), (reply) => resolve({ reply, ms: Date.now() - asked, deadline }));
    assert.equal(keep, true);
  });
}
// Answered in time, or not at all (by a while after the deadline).
const inTime = (asking) => Promise.race([asking, sleep(WAIT_MS + 3000).then(() => ({ reply: 'no answer', ms: Infinity }))]);
// Margin's state knows tab `id` is in front (its activation has been handled).
async function settledOn(id) {
  for (let i = 0; i < 100; i++) {
    const s = await store.load();
    if (s.tabs[id]?.active) return;
    await sleep(10);
  }
  assert.fail(`tab ${id} never known in front`);
}

test('setup: Margin started, owning the state, its tabs matched', async () => {
  for (let i = 0; i < 100 && !store.isSynced(); i++) await sleep(20);
  assert.ok(store.isSynced());
  await settledOn(1);
});

test('a switch to a tab whose process hangs (Safari\'s update of it never answers) is answered before the page stops waiting, as shown (Safari carries the update out)', async () => {
  fake.hung.set(2, Infinity);
  const { reply, ms } = await inTime(ask('activateTab', { tabId: 2 }));
  assert.notEqual(reply, 'no answer', 'answered at all');
  assert.ok(ms < WAIT_MS - 300, `answered ${ms} ms after the ask (the page waits ${WAIT_MS})`);
  assert.deepEqual(reply, { ok: true, result: { shown: 2 } });
  fake.hung.delete(2);
});

test('a switch whose introduction waits on Safari (its calls stalled behind a hung process) is shown as it is before the deadline, and nothing of its own goes out after', async () => {
  fake.tabs.get(1).active = true;
  fake.tabs.get(2).active = false;
  bringToFront(1);
  await settledOn(1);
  tabOpened({ id: 3, active: false }); // never shown: introduced first
  fake.queryMs = 4000;
  const { reply, ms, deadline } = await inTime(ask('activateTab', { tabId: 3 }));
  fake.queryMs = 0;
  assert.notEqual(reply, 'no answer');
  assert.ok(ms < WAIT_MS - 300, `answered ${ms} ms after the ask`);
  assert.deepEqual(reply, { ok: true, result: { shown: 3 } });
  assert.equal(front(), 3, 'shown');
  const answeredAt = Date.now();
  await sleep(4500); // Safari's answers come; the switch's own steps stand down
  assert.deepEqual(fake.updates.filter((u) => u.at > answeredAt).map((u) => u.id), [], 'no update after the answer');
  assert.equal(front(), 3);
  assert.ok(answeredAt < deadline);
  tabShown(3);
});

test('a space\'s switch queued behind slow storage writes is answered before its deadline (it didn\'t happen), and no tab comes to the front after', async () => {
  bringToFront(1);
  await settledOn(1);
  await store.mutate((s) => M.createSpace(s, { name: 'Work' }));
  const work = (await store.load()).spaces.find((x) => x.name === 'Work');
  assert.ok(work);
  await store.mutate((s) => M.moveTab(s, 4, work.id));
  fake.updates = [];
  fake.localSetMs = 1500;
  for (const id of [1, 5, 6]) void store.mutate((s) => M.upsertTab(s, { ...fake.tabs.get(id), title: `changed ${id} ${Date.now()}` }, Date.now()));
  const { reply, ms } = await inTime(ask('setSpace', { windowId: 1, spaceId: work.id }));
  assert.notEqual(reply, 'no answer');
  assert.ok(ms < WAIT_MS - 200, `answered ${ms} ms after the ask`);
  assert.equal(reply.ok, false);
  assert.match(reply.error, /Too late/);
  const answeredAt = Date.now();
  await sleep(4000); // the writes done, the switch finds its page gave up
  fake.localSetMs = 0;
  assert.deepEqual(fake.updates.filter((u) => u.at > answeredAt).map((u) => u.id), [], 'no switch after its page stopped waiting');
  assert.equal(front(), 1);
});

test('a switch asked with little time left is shown at once, as it is (1.2 s left), or not at all (0.9 s: it would land after its page said it didn\'t)', async () => {
  bringToFront(1);
  await settledOn(1);
  fake.updates = [];
  const asked = Date.now();
  const quick = await focusTab(7, { deadline: asked + 1200 });
  assert.equal(quick.tab?.id, 7);
  assert.ok(Date.now() - asked < 400, `answered ${Date.now() - asked} ms after the ask`);
  assert.equal(front(), 7);
  await sleep(300);
  assert.deepEqual(fake.updates.map((u) => u.id), [7], 'shown once: nothing of its own steps after');
  bringToFront(1);
  await settledOn(1);
  fake.updates = [];
  await assert.rejects(focusTab(8, { deadline: Date.now() + 900 }), /Too late/);
  await sleep(300);
  assert.deepEqual(fake.updates, []);
  assert.equal(front(), 1);
});

test('a show Safari carries out late, after the user has switched elsewhere since, doesn\'t take the front from that switch', async () => {
  bringToFront(1);
  await settledOn(1);
  tabShown(4);
  tabShown(5);
  fake.updates = [];
  const t0 = Date.now();
  // Tab 4's process hangs for 6 s: Safari's calls on it wait (its update
  // happens only then).
  fake.getHung.set(4, t0 + 6000);
  fake.hung.set(4, t0 + 6000);
  const work = (await store.load()).spaces.find((x) => x.name === 'Work');
  assert.ok(work);
  const first = inTime(ask('setSpace', { windowId: 1, spaceId: work.id }, 1));
  await sleep(1700); // past its forced show (the deadline less 1.5 s)
  const second = inTime(ask('activateTab', { tabId: 5 }, 1));
  const [a, b] = await Promise.all([first, second]);
  assert.ok(a.ms < WAIT_MS - 300, `the first answered ${a.ms} ms after its ask`);
  assert.deepEqual(b.reply, { ok: true, result: { shown: 5 } });
  assert.equal(front(), 5);
  await sleep(Math.max(0, t0 + 7000 - Date.now())); // tab 4's update lands at 6 s
  assert.equal(front(), 5, 'the newer switch stands');
  fake.getHung.delete(4);
  fake.hung.delete(4);
  await settledOn(5);
});

test('a switch whose tab Safari is slow to look up (tabs.get waits on its hung process) is still shown, and answered in time', async () => {
  bringToFront(1);
  await settledOn(1);
  tabShown(6);
  fake.updates = [];
  const t0 = Date.now();
  fake.getHung.set(6, t0 + 5000);
  const { reply, ms } = await inTime(ask('activateTab', { tabId: 6, hint: { url: 'https://t6.test/', index: 5, title: 'T6' } }, 1));
  assert.ok(ms < WAIT_MS - 300, `answered ${ms} ms after the ask`);
  assert.deepEqual(reply, { ok: true, result: { shown: 6 } });
  assert.equal(front(), 6);
  await sleep(Math.max(0, t0 + 5500 - Date.now()));
  assert.equal(front(), 6);
  assert.deepEqual(fake.updates.map((u) => u.id), [6], 'shown once');
  fake.getHung.delete(6);
  await settledOn(6);
});

test('a space\'s switch carrying the sidebar open, its show unanswered and the background busy just before the answer, is answered as shown', async () => {
  bringToFront(1);
  await settledOn(1);
  const work = (await store.load()).spaces.find((x) => x.name === 'Work');
  assert.ok(work);
  tabShown(4);
  fake.updates = [];
  fake.hung.set(4, Infinity);
  fake.prepNotReady = true;
  const busy = setTimeout(() => { const until = Date.now() + 150; while (Date.now() < until); }, WAIT_MS - 850);
  const slow = setTimeout(() => { fake.queryMs = 1000; }, WAIT_MS - 1000);
  try {
    const { reply, ms } = await inTime(ask('setSpace', { windowId: 1, spaceId: work.id, show: 'hover' }, 1));
    assert.ok(ms < WAIT_MS - 200, `answered ${ms} ms after the ask`);
    assert.deepEqual(reply, { ok: true, result: { shown: 4 } });
  } finally {
    clearTimeout(busy);
    clearTimeout(slow);
    fake.queryMs = 0;
    fake.prepNotReady = false;
    fake.hung.delete(4);
  }
  bringToFront(1);
  await settledOn(1);
});

test('a pin with no open tab, asked behind slow storage writes, is answered as not done, and no tab opens after', async () => {
  bringToFront(1);
  await settledOn(1);
  const spaceId = (await store.load()).spaces[0].id;
  await store.mutate((s) => ({ ...s, pins: [...s.pins, { id: 'p-late', url: 'https://pin.test/', title: 'Pin', spaceId }] }));
  fake.created = [];
  fake.localSetMs = 1500;
  for (const id of [1, 5, 6]) void store.mutate((s) => M.upsertTab(s, { ...fake.tabs.get(id), title: `pinned ${id} ${Date.now()}` }, Date.now()));
  const { reply, ms } = await inTime(ask('openPin', { pinId: 'p-late', windowId: 1 }, 1));
  assert.ok(ms < WAIT_MS - 200, `answered ${ms} ms after the ask`);
  assert.equal(reply.ok, false);
  assert.match(reply.error, /Too late/);
  await sleep(5000); // the writes done
  fake.localSetMs = 0;
  assert.deepEqual(fake.created, [], 'no tab opened after its page was told it didn\'t');
});

test('an introduction\'s activations Safari sends late, after a switch out of time was shown as it is, aren\'t taken as switches', async () => {
  bringToFront(1);
  await settledOn(1);
  tabOpened({ id: 8, active: false }); // never shown: introduced first
  assert.ok(isNeverShown(8));
  // Which activations background.js handles as switches (not an introduction's).
  const handled = [];
  const listen = listeners.onActivated[0];
  listeners.onActivated[0] = (info) => {
    const result = listen(info);
    if (result !== undefined) handled.push(info.tabId);
    return result;
  };
  const t0 = Date.now();
  // Safari holds up every update until 2.4 s (past the forced show at 1.5 s),
  // then carries them out in order: the introduction's two, then the show.
  fake.stallUntil = t0 + 2400;
  const { reply, ms } = await inTime(ask('activateTab', { tabId: 8 }, 1));
  assert.ok(ms < WAIT_MS - 300, `answered ${ms} ms after the ask`);
  assert.deepEqual(reply, { ok: true, result: { shown: 8 } });
  await sleep(Math.max(0, t0 + 3200 - Date.now()));
  fake.stallUntil = 0;
  assert.equal(front(), 8);
  assert.deepEqual(fake.updates.slice(-3).map((u) => u.id), [8, 1, 8], 'introduced, then shown');
  listeners.onActivated[0] = listen;
  await settledOn(8);
  assert.deepEqual(handled, [8], 'only the show taken as a switch, not the introduction\'s way there and back');
  tabShown(8);
});

test('a request that says Margin isn\'t responding only for requests someone waits on', () => {
  for (const type of ['prewake', 'away', 'back', 'pageBlinked', 'pageIcon', 'fetchStyle', 'getZoom', 'switchLog']) assert.equal(mayNotice(type), false, type);
  for (const type of ['activateTab', 'openPin', 'setSpace', 'hello', 'closeTab', 'newTab']) assert.equal(mayNotice(type), true, type);
});

test('the copy is alive when its storage answers, however late its background; gone when the call fails or never answers', async () => {
  assert.equal(await copyAlive({ storage: { local: { get: async () => ({}) } } }, 100), true);
  assert.equal(await copyAlive({ storage: { local: { get: () => sleep(50).then(() => ({})) } } }, 100), true);
  assert.equal(await copyAlive({ storage: { local: { get: () => never() } } }, 100), false);
  assert.equal(await copyAlive({ storage: { local: { get: async () => { throw new Error('Extension context invalidated'); } } } }, 100), false);
  assert.equal(await copyAlive({ storage: { local: { get: () => { throw new Error('no storage'); } } } }, 100), false);
});

test.after(() => setTimeout(() => process.exit(0), 50));
