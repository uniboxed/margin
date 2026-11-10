// The copy's side of Margin.app's profile handoff (docs/HANDOFF.md §1.9, §2.5, §3.3, §6.1), against
// the real background with a fake of Safari's API: the windows calls (setWindowState, focusWindow,
// closeWindow) refused past their notAfter and busy while another for the window is pending,
// setWindowState waiting for the state to land and sending the window list at once; the frame probe
// (the background's side, the page's own with a fake animation frame, and Margin's new-tab page);
// the drafts before a close, their answers carrying each page's scroll; the scroll record (written as a
// page is hidden or left, kept with its Margin tab as its window closes, taken once when it's opened
// again, and the page's own part); the app's `parked` per epoch (the link's own end, against the fake app);
// `parkedActivity` for a tab Margin didn't open, for focus that isn't Margin's (and not within 1 s of
// its own call), and in place of raising a parked window; openPin and a row's tab preferring a window
// that isn't parked; sleep sparing a parked window's tab in front; openSpaceWindow's bounds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeApp } from './fake-app.ts';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listeners = {};
const event = (name) => ({ addListener: (fn) => (listeners[name] ??= []).push(fn), removeListener() {}, hasListener: () => false });
const fire = (name, ...args) => Promise.all((listeners[name] ?? []).map((fn) => fn(...args)));
const pick = (store, keys) => {
  if (keys == null) return structuredClone(store);
  const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
  return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
};

// Safari's windows: id → { id, state, focused, left, top, width, height }. A windows.update's state
// lands `landMs` after it's answered (a full-screen change animates); `holdUpdate`: the next update is
// answered only when `release()` is called (one stuck behind a hung tab). `drafts(tabId)`: what the
// draft check finds in that tab ('draft', 'none', 'never': no answer, 'error': no script there).
const fake = {
  tabs: new Map(), windows: new Map(), local: {}, session: {},
  windowUpdates: [], tabUpdates: [], removedWindows: [], created: [], scripts: [],
  landMs: 0, holdUpdate: false, release: () => {},
  probe: (_tabId: number, _m: any) => (undefined as any),
  drafts: (_tabId: number) => 'none',
  denied: new Set(),
  scrollY: ({} as Record<number, number>), // where each tab's page is scrolled, in its answer to the draft check
};
const win = (id, extra = {}) => ({ id, state: 'fullscreen', focused: false, left: 0, top: 0, width: 1512, height: 982, ...extra });
globalThis.fetch = async () => ({ ok: true, text: async () => '{}', json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) });
globalThis.chrome = {
  runtime: {
    id: 'test', getURL: (p) => `safari-web-extension://test/${p}`, getManifest: () => ({ version: '0', content_scripts: [{ js: ['content.js'] }] }),
    onInstalled: event('onInstalled'), onStartup: event('onStartup'), onMessage: event('onMessage'), sendMessage: async () => undefined, sendNativeMessage: async () => undefined,
  },
  permissions: { contains: async ({ origins: [o] }) => ![...fake.denied].some((d) => o.includes(d)), onAdded: event('pAdded'), onRemoved: event('pRemoved') },
  alarms: { get: async () => ({}), create: async () => {}, clear: async () => true, onAlarm: event('onAlarm') },
  commands: { onCommand: event('onCommand') },
  windows: {
    get: async (id) => { const w = fake.windows.get(id); if (!w) throw new Error(`No window with id: ${id}`); return { ...w }; },
    getAll: async () => [...fake.windows.values()].map((w) => ({ ...w })),
    getLastFocused: async () => ({ ...[...fake.windows.values()].find((w) => w.focused) ?? fake.windows.get(1) }),
    update: async (id, props) => {
      const w = fake.windows.get(id);
      if (!w) throw new Error(`No window with id: ${id}`);
      fake.windowUpdates.push({ id, ...props });
      if (fake.holdUpdate) {
        fake.holdUpdate = false;
        await new Promise((resolve) => { fake.release = resolve; });
      }
      if (props.focused) for (const other of fake.windows.values()) other.focused = other.id === id;
      if (props.state) setTimeout(() => { w.state = props.state; }, fake.landMs);
      return { ...w };
    },
    create: async (props) => {
      const id = 100 + fake.windows.size;
      const w = win(id, { state: props.state ?? 'normal', focused: true, left: 10, top: 25, width: 1200, height: 800 });
      fake.windows.set(id, w);
      const tab = { id: id * 10, windowId: id, url: props.url ?? 'safari-web-extension://test/newtab/newtab.html', title: '', index: 0, active: true, status: 'loading' };
      fake.tabs.set(tab.id, tab);
      return { ...w, tabs: [{ ...tab }] };
    },
    remove: async (id) => { fake.removedWindows.push(id); fake.windows.delete(id); },
    onFocusChanged: event('onFocusChanged'), onRemoved: event('wRemoved'), onBoundsChanged: event('wBounds'), onCreated: event('wCreated'),
  },
  tabs: {
    get: async (id) => { const t = fake.tabs.get(id); if (!t) throw new Error(`No tab with id: ${id}`); return { ...t }; },
    query: async (filter = {}) => [...fake.tabs.values()].filter((t) => (filter.active == null || t.active === filter.active) && (filter.windowId == null || t.windowId === filter.windowId)).map((t) => ({ ...t })),
    update: async (id, props) => {
      const tab = fake.tabs.get(id);
      if (!tab) throw new Error(`No tab with id: ${id}`);
      fake.tabUpdates.push({ id, ...props });
      if (props.active) for (const t of fake.tabs.values()) if (t.windowId === tab.windowId) t.active = t.id === id;
      return { ...tab };
    },
    create: async ({ windowId, url }) => {
      const tab = { id: 900 + fake.created.length, windowId: windowId ?? 1, url, title: '', index: 9, active: false, status: 'loading' };
      fake.tabs.set(tab.id, tab);
      fake.created.push(tab.id);
      return { ...tab };
    },
    remove: async () => {},
    sendMessage: async (tabId, message) => (message?.type === 'frameProbe' ? fake.probe(tabId, message) : undefined),
    getZoom: async () => 1, getZoomSettings: async () => ({ defaultZoomFactor: 1 }), reload: async () => {},
    onActivated: event('onActivated'), onCreated: event('onCreated'), onUpdated: event('onUpdated'), onRemoved: event('onRemoved'),
    onMoved: event('onMoved'), onAttached: event('onAttached'), onDetached: event('onDetached'), onZoomChange: event('onZoomChange'), onReplaced: event('onReplaced'),
  },
  scripting: {
    executeScript: async ({ target, func, args }) => {
      if (func?.name !== 'sleepInPage') return [{ result: true }];
      fake.scripts.push({ tabId: target.tabId, args, allFrames: !!target.allFrames });
      const said = fake.drafts(target.tabId);
      if (said === 'never') return new Promise(() => {});
      if (said === 'error') throw new Error('Could not execute script on this tab');
      const scroll = fake.scrollY[target.tabId] != null ? { scrollY: fake.scrollY[target.tabId] } : {};
      return [{ frameId: 0, result: said === 'draft' ? { ok: false, why: 'edited', judged: 'margin', top: true, ...scroll } : { ok: true, judged: 'margin', top: true, foreign: 0, ...scroll } }];
    },
    getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {}, updateContentScripts: async () => {},
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
    session: { get: async (keys) => pick(fake.session, keys), set: async (items) => { Object.assign(fake.session, structuredClone(items)); }, remove: async () => {} },
    onChanged: event('sChanged'),
  },
};

// Window 1: the profile's own window, shown. Window 2: parked (out of sight). Window 3: the person's
// own second window (never parked).
fake.windows.set(1, win(1, { focused: true }));
fake.windows.set(2, win(2, { state: 'normal' }));
fake.windows.set(3, win(3, { state: 'normal' }));
fake.tabs.set(1, { id: 1, windowId: 1, url: 'https://a.test/', title: 'A', index: 0, active: true, status: 'complete' });
fake.tabs.set(2, { id: 2, windowId: 1, url: 'https://b.test/', title: 'B', index: 1, active: false, status: 'complete' });
fake.tabs.set(21, { id: 21, windowId: 2, url: 'https://p.test/', title: 'P', index: 0, active: true, status: 'complete' });
fake.tabs.set(22, { id: 22, windowId: 2, url: 'https://pin.test/', title: 'Pin', index: 1, active: false, status: 'complete' });
fake.tabs.set(31, { id: 31, windowId: 3, url: 'https://pin.test/', title: 'Pin', index: 0, active: true, status: 'complete' });
fake.session.alive = true;
fake.session.since = 1;
fake.session.startWorkAt = Date.now();

await import('../extension/background.ts');
const store = await import('../extension/background/store.ts');
const { appLink } = await import('../extension/background/app-link.ts');
const { handlers } = await import('../extension/background/handlers.ts');
const { setHandoffTiming } = await import('../extension/background/handoff.ts');
const { markMarginOpening, focusTab, resolveTab } = await import('../extension/background/tabs.ts');
const { sleepIdle, setSleepTiming } = await import('../extension/background/sleep.ts');
const M = await import('../extension/state/model.ts');
const { probeFrames, watchVisible } = await import('../extension/shared/frame-probe.ts');
const { createLink } = await import('../extension/background/link.ts');
for (let i = 0; i < 100 && !store.isSynced(); i++) await sleep(10);
assert.ok(store.isSynced(), 'synced');
setHandoffTiming({ pollMs: 10, landMs: 300, focusOwnMs: 150 });
setSleepTiming({ gapMs: 1, askMs: 100 });

// The link's word, as the background's link object would have it: which windows are parked, what
// it pushes, its notes and its window list sent now.
const said = { parked: new Set([2]), linked: true, pushes: [], notes: [], windowsNow: 0 };
appLink.parked = (w) => said.parked.has(w);
appLink.parkedActivity = (windowId, why, tabId = null) => {
  if (!said.linked) return false;
  said.pushes.push({ windowId, why, ...(tabId != null ? { tabId } : {}) });
  return true;
};
appLink.note = (...args) => { said.notes.push(args.join(' ')); };
appLink.windowsNow = async () => { said.windowsNow++; };
const fresh = () => { said.pushes.length = 0; said.notes.length = 0; said.windowsNow = 0; fake.windowUpdates.length = 0; fake.tabUpdates.length = 0; };

// ---- the windows calls ------------------------------------------------------------------------

test('setWindowState: past notAfter, refused with nothing called; in time, Safari asked once, answered when the state lands, the window list sent at once', async () => {
  fresh();
  fake.windows.get(2).state = 'normal';
  const late = await handlers.setWindowState({ windowId: 2, state: 'fullscreen', focused: true, notAfter: Date.now() - 210 });
  assert.equal(late.refused, 'late');
  assert.ok(late.pastMs >= 210 && late.pastMs < 400, `${late.pastMs} ms past`);
  assert.deepEqual(fake.windowUpdates, [], 'nothing called');
  assert.ok(said.notes.some((n) => /^setWindowState window 2: refused, \d+ ms past notAfter$/.test(n)), 'the log: ids and milliseconds only');

  fake.landMs = 60;
  const started = Date.now();
  const landed = await handlers.setWindowState({ windowId: 2, state: 'fullscreen', focused: true, notAfter: Date.now() + 1500 });
  assert.equal(landed.windowId, 2);
  assert.equal(landed.state, 'fullscreen');
  assert.ok(landed.landedAt >= started + 60, 'answered once Safari says it\'s there, not at the update');
  assert.deepEqual(fake.windowUpdates, [{ id: 2, state: 'fullscreen', focused: true }], 'one call, focused as asked');
  assert.equal(said.windowsNow, 1, 'the window list sent at once');

  fresh();
  await handlers.setWindowState({ windowId: 2, state: 'normal', notAfter: Date.now() + 1500 });
  assert.deepEqual(fake.windowUpdates, [{ id: 2, state: 'normal' }], 'normal: focus left alone');
  fake.landMs = 0;
});

test('setWindowState: a state that never lands answers timedOut after its 3 s (here shortened); a window gone fails', async () => {
  fresh();
  fake.landMs = 10_000;
  fake.windows.get(3).state = 'normal';
  const t0 = Date.now();
  const answer = await handlers.setWindowState({ windowId: 3, state: 'fullscreen', notAfter: Date.now() + 1500 });
  assert.deepEqual(answer, { windowId: 3, state: 'fullscreen', timedOut: true });
  assert.ok(Date.now() - t0 >= 290, 'waited its whole time');
  assert.equal(said.windowsNow, 1);
  fake.landMs = 0;
  fake.windows.get(3).state = 'normal';
  await assert.rejects(handlers.setWindowState({ windowId: 77, state: 'normal', notAfter: Date.now() + 1500 }), /No window/);
  await assert.rejects(handlers.setWindowState({ windowId: 3, state: 'minimized', notAfter: Date.now() + 1500 }), /no such window state/);
});

test('one windows call per window: a second setWindowState, focusWindow or closeWindow while one is pending is busy, nothing called; another window\'s runs; late comes before busy', async () => {
  fresh();
  fake.windows.get(2).state = 'normal';
  fake.holdUpdate = true;
  const first = handlers.setWindowState({ windowId: 2, state: 'fullscreen', notAfter: Date.now() + 5000 });
  await sleep(10);
  assert.equal(fake.windowUpdates.length, 1);
  assert.deepEqual(await handlers.setWindowState({ windowId: 2, state: 'normal', notAfter: Date.now() + 5000 }), { busy: true });
  assert.deepEqual(await handlers.focusWindow({ windowId: 2, notAfter: Date.now() + 5000 }), { busy: true });
  assert.deepEqual(await handlers.closeWindow({ windowId: 2, notAfter: Date.now() + 5000 }), { busy: true });
  assert.equal((await handlers.closeWindow({ windowId: 2, notAfter: Date.now() - 50 })).refused, 'late', 'late, though busy too');
  assert.equal(fake.windowUpdates.length, 1, 'none of them called Safari');
  assert.deepEqual(fake.removedWindows, []);
  assert.ok(said.notes.some((n) => n === 'focusWindow window 2: busy (a windows call for it is still pending)'));
  const other = await handlers.focusWindow({ windowId: 3, notAfter: Date.now() + 5000 });
  assert.deepEqual(other, { windowId: 3, state: 'normal' }, 'another window: not held up');
  fake.release();
  assert.equal((await first).state, 'fullscreen');
  assert.deepEqual(await handlers.focusWindow({ windowId: 2, notAfter: Date.now() + 5000 }), { windowId: 2, state: 'fullscreen' }, 'the first one answered: free again');

  // Today's switch (no notAfter): never busy, as before (its undo's close isn't dropped behind its
  // own focus), but pending all the same: a handoff's call meanwhile is busy.
  fresh();
  fake.windows.set(8, win(8, { state: 'normal' }));
  fake.holdUpdate = true;
  const todays = handlers.focusWindow({ windowId: 8, fullscreen: true });
  await sleep(10);
  assert.deepEqual(await handlers.setWindowState({ windowId: 8, state: 'fullscreen', notAfter: Date.now() + 5000 }), { busy: true });
  assert.equal(await handlers.closeWindow({ windowId: 8 }), null, 'today\'s close: run');
  assert.ok(!fake.windows.has(8));
  fake.windows.set(8, win(8, { state: 'normal' })); // (so the held focus can answer)
  fake.release();
  await todays;
  fake.windows.delete(8);
  fake.windows.get(1).focused = true;
});

test('focusWindow and closeWindow: today\'s switch sends no notAfter (never late); past one, nothing called', async () => {
  fresh();
  fake.windows.set(9, win(9, { state: 'normal' }));
  assert.equal((await handlers.focusWindow({ windowId: 9, notAfter: Date.now() - 5 })).refused, 'late');
  assert.equal((await handlers.closeWindow({ windowId: 9, notAfter: Date.now() - 5 })).refused, 'late');
  assert.deepEqual(fake.windowUpdates, []);
  assert.ok(fake.windows.has(9), 'not closed');
  assert.deepEqual(await handlers.focusWindow({ windowId: 9, fullscreen: true }), { windowId: 9, state: 'normal' });
  assert.deepEqual(fake.windowUpdates, [{ id: 9, focused: true, state: 'fullscreen' }]);
  assert.equal(await handlers.closeWindow({ windowId: 9 }), null);
  assert.ok(!fake.windows.has(9), 'closed');
  await assert.rejects(handlers.closeWindow({}), /no window/);
  fake.windows.get(1).focused = true;
});

// ---- openSpaceWindow ---------------------------------------------------------------------------

test('openSpaceWindow: answers the new window\'s bounds as Safari gave them and sends the window list at once; one full-screen request', async () => {
  fresh();
  const s = await store.load();
  const answer = await handlers.openSpaceWindow({ spaceId: s.spaces[0].id, fullscreen: true });
  assert.equal(answer.state, 'fullscreen');
  assert.deepEqual(answer.bounds, { left: 10, top: 25, width: 1200, height: 800 });
  assert.equal(said.windowsNow, 1);
  assert.deepEqual(fake.windowUpdates, [], 'no second full-screen request');
  fake.windows.delete(answer.windowId);
  fake.tabs.delete(answer.tabId);
  fake.windows.get(1).focused = true;
});

// ---- newWindow: ⌘N (docs/BROWSER-WINDOWS.md §5) -------------------------------------------------------------

test('newWindow from a window: a Margin window of its own in full screen like it, on the space it shows, its tab in that space; bounds answered, the list sent at once', async () => {
  fresh();
  let s = await store.load();
  const space = s.spaces[s.spaces.length - 1];
  await handlers.setSpace({ windowId: 1, spaceId: space.id });
  fake.windows.get(1).state = 'fullscreen';
  const before = said.windowsNow;
  const answer = await handlers.newWindow({ fromWindowId: 1 });
  s = await store.load();
  assert.equal(answer.state, 'fullscreen', 'full screen like the window it came from');
  assert.deepEqual(answer.bounds, { left: 10, top: 25, width: 1200, height: 800 });
  assert.equal(s.activeSpaceByWindow[answer.windowId], space.id, 'on the space that window shows');
  assert.equal(s.tabSpace[answer.windowId * 10], space.id, 'its tab in that space');
  assert.equal(said.windowsNow, before + 1);
  // A normal window's: a normal window. With no window to start from, as before: the browser's choice of space.
  fake.windows.get(1).state = 'normal';
  const normal = await handlers.newWindow({ fromWindowId: 1 });
  assert.equal(normal.state, 'normal');
  const bare = await handlers.newWindow();
  assert.equal(bare.state, 'normal');
  for (const w of [answer, normal, bare]) { fake.windows.delete(w.windowId); fake.tabs.delete(w.windowId * 10); }
  fake.windows.get(1).state = 'fullscreen';
  fake.windows.get(1).focused = true;
});

// ---- the frame probe ---------------------------------------------------------------------------

test('frameProbe (the background): passed to the window\'s tab in front, its answer with its tab; no answer in timeoutMs, or no tab: none', async () => {
  fresh();
  const asked = [];
  fake.probe = async (tabId, m) => { asked.push([tabId, m]); return { frames: 6, firstAt: 1000, lastAt: 1074, width: 1512, height: 982, hasFocus: true, visible: true, visibleAt: 990 }; };
  const answer = await handlers.frameProbe({ windowId: 2, width: 1512, height: 982, frames: 6, nudgeMs: 80, timeoutMs: 400 });
  assert.deepEqual(asked, [[21, { type: 'frameProbe', width: 1512, height: 982, frames: 6, nudgeMs: 80, timeoutMs: 400 }]], 'the parked window\'s tab in front');
  assert.deepEqual(answer, { tabId: 21, frames: 6, firstAt: 1000, lastAt: 1074, width: 1512, height: 982, hasFocus: true, visible: true, visibleAt: 990 });
  assert.ok(said.notes.includes('frameProbe tab 21: 6 frames in 74 ms at 1512×982, focused'), 'the log: ids, counts, sizes and times');

  fake.probe = () => new Promise(() => {});
  const t0 = Date.now();
  assert.deepEqual(await handlers.frameProbe({ windowId: 2, width: 1512, height: 982, timeoutMs: 100 }), { none: 'no page' });
  assert.ok(Date.now() - t0 < 400, 'by its timeout (and a moment)');
  fake.probe = async () => undefined; // no script in that page
  assert.deepEqual(await handlers.frameProbe({ windowId: 2, width: 1512, height: 982, timeoutMs: 100 }), { none: 'no page' });
  assert.deepEqual(await handlers.frameProbe({ windowId: 55, width: 1512, height: 982, timeoutMs: 100 }), { none: 'no page' }, 'no tab there');
  fake.probe = () => undefined;
});

// A fake page for the probe: its window's size, its animation frames run by hand (`tick`), its clock.
function fakePage({ width = 1512, height = 982 } = {}) {
  const page = { clock: 1000, frames: [], children: [], focus: true, visibility: 'visible', listeners: {} };
  const el = () => {
    const node = {
      attrs: {}, style: { cssText: '', set: {}, setProperty(k, v, p) { node.style.set[k] = [v, p]; } },
      setAttribute(k, v) { node.attrs[k] = v; },
      remove() { page.children = page.children.filter((c) => c !== node); },
    };
    return node;
  };
  const doc = {
    documentElement: { appendChild: (node) => page.children.push(node) },
    createElement: () => el(),
    hasFocus: () => page.focus,
    get visibilityState() { return page.visibility; },
    addEventListener: (type, fn) => (page.listeners[type] ??= []).push(fn),
  };
  const winObj = { outerWidth: width, outerHeight: height };
  const env = {
    win: winObj, doc, now: () => page.clock,
    raf: (cb) => page.frames.push(cb),
  };
  // One animation frame `ms` after the last.
  const tick = (ms = 16) => {
    page.clock += ms;
    const run = page.frames.splice(0);
    for (const cb of run) cb();
  };
  return { page, doc, win: winObj, env, tick };
}

test('the page\'s probe: a 1×1 fixed nudge out of the layout, its alpha 0.01 and 0.02 on alternate frames; frames counted only after nudgeMs and at the full-screen size; answered, and the nudge gone', async () => {
  const { page, win: w, env, tick } = fakePage({ width: 1200, height: 800 });
  const done = probeFrames({ width: 1512, height: 982, frames: 3, nudgeMs: 40, timeoutMs: 400 }, env);
  assert.equal(page.children.length, 1, 'the nudge in the page');
  const nudge = page.children[0];
  assert.equal(nudge.attrs['aria-hidden'], 'true');
  for (const rule of ['position: fixed !important', 'width: 1px !important', 'height: 1px !important', 'pointer-events: none !important', 'all: initial !important']) assert.ok(nudge.style.cssText.includes(rule), rule);
  tick();
  const first = nudge.style.set['background-color'];
  tick();
  const second = nudge.style.set['background-color'];
  assert.deepEqual([first, second], [['rgba(128, 128, 128, 0.02)', 'important'], ['rgba(128, 128, 128, 0.01)', 'important']], 'alternate frames');
  tick(); // 48 ms: past the nudge, but the window isn't full screen yet
  w.outerWidth = 1513; // within 2 pt
  w.outerHeight = 982;
  tick();
  tick();
  assert.equal(page.children.length, 1, 'nudging until the count is done');
  tick();
  const answer = await done;
  assert.deepEqual(answer, { frames: 3, firstAt: 1064, lastAt: 1096, width: 1513, height: 982, hasFocus: true, visible: true });
  assert.equal(page.children.length, 0, 'the nudge gone');
});

test('the page\'s probe: no frames by timeoutMs (WebKit running none, or never at the size): null, and the nudge gone; its last visibilitychange to visible said', async () => {
  const a = fakePage({ width: 800 });
  const timedOut = probeFrames({ width: 1512, height: 982, frames: 6, nudgeMs: 80, timeoutMs: 50 }, a.env);
  for (let i = 0; i < 4; i++) a.tick();
  assert.equal(await timedOut, null);
  assert.equal(a.page.children.length, 0);

  const b = fakePage();
  const visibleAt = watchVisible({ doc: b.doc, now: b.env.now });
  b.page.clock = 1234;
  for (const fn of b.page.listeners.visibilitychange) fn();
  const shown = probeFrames({ width: 1512, height: 982, frames: 1, nudgeMs: 0, timeoutMs: 400 }, { ...b.env, visibleAt });
  assert.equal(b.page.children.length, 0, 'no nudge asked: none put in');
  b.page.focus = false;
  b.tick();
  assert.deepEqual(await shown, { frames: 1, firstAt: 1250, lastAt: 1250, width: 1512, height: 982, hasFocus: false, visible: true, visibleAt: 1234 });
});

// ---- the drafts before a close -------------------------------------------------------------------

test('windowDrafts: every tab of the window asked at once (its drafts only, every frame), 400 ms in all; a draft, unknown (no access, no answer, no script), and tabs with nothing to hold text left out', async () => {
  fresh();
  fake.windows.set(5, win(5, { state: 'normal' }));
  const tabs = {
    51: ['https://draft.test/', 'draft'], 52: ['https://clean.test/', 'none'], 53: ['https://slow.test/', 'never'],
    54: ['https://noscript.test/', 'error'], 55: ['https://denied.test/', 'none'], 56: ['safari-web-extension://test/newtab/newtab.html', 'draft'],
  };
  for (const [id, [url]] of Object.entries(tabs)) fake.tabs.set(Number(id), { id: Number(id), windowId: 5, url, title: '', index: 0, active: id === '51', status: 'complete' });
  fake.tabs.set(57, { id: 57, windowId: 5, url: 'https://asleep.test/', title: '', index: 0, active: false, status: 'complete', discarded: true });
  fake.denied.add('denied.test');
  fake.drafts = (tabId) => tabs[tabId]?.[1] ?? 'none';
  fake.scripts.length = 0;
  const t0 = Date.now();
  const answer = await handlers.windowDrafts({ windowId: 5 });
  const took = Date.now() - t0;
  assert.deepEqual(answer.drafts, [51]);
  assert.deepEqual([...answer.unknown].sort(), [53, 54, 55], 'no answer in time, no script, no access');
  assert.ok(took >= 380 && took < 700, `400 ms in all (${took} ms)`);
  assert.deepEqual([...new Set(fake.scripts.map((s) => s.tabId))].sort(), [51, 52, 53, 54], 'only web pages it may reach, not the asleep one or Margin\'s own');
  assert.ok(fake.scripts.every((s) => s.args[2] === true), 'drafts only');
  assert.ok(fake.scripts.some((s) => s.allFrames), 'in every frame');
  for (const id of [...Object.keys(tabs), 57]) fake.tabs.delete(Number(id));
  fake.windows.delete(5);
  fake.denied.clear();

  fake.drafts = () => 'none';
  fake.windows.set(6, win(6));
  fake.tabs.set(61, { id: 61, windowId: 6, url: 'https://clean.test/', title: '', index: 0, active: true, status: 'complete' });
  assert.deepEqual(await handlers.windowDrafts({ windowId: 6 }), { drafts: [], unknown: [] }, 'nothing typed: the window may close');
  fake.tabs.delete(61);
  fake.windows.delete(6);
});

test('the draft check in the page, drafts only: shown, playing or moved don\'t matter then, only what\'s typed', async () => {
  const { sleepInPage } = await import('../extension/background/sleep.ts');
  const doc = (typed) => ({
    visibilityState: 'visible',
    querySelectorAll: (sel) => (sel.startsWith('audio') ? [{ paused: false, ended: false }] : sel.startsWith('textarea') && typed ? [{ value: 'hello' }] : []),
  });
  const run = (typed, draftsOnly) => {
    Object.assign(globalThis, { window: {}, document: doc(typed), location: { href: 'https://elsewhere.test/' } });
    globalThis.window.top = globalThis.window;
    try {
      return sleepInPage('https://a.test/', Date.now() + 1000, draftsOnly);
    } finally {
      for (const k of ['window', 'document', 'location']) delete globalThis[k];
    }
  };
  assert.equal(run(false, false).why, 'shown', 'a sleep\'s check: a shown page stays');
  assert.equal(run(false, true).ok, true, 'drafts only: shown, playing and another address don\'t count');
  assert.deepEqual([run(true, true).ok, run(true, true).why], [false, 'edited']);
});

// ---- parkedActivity --------------------------------------------------------------------------

test('a tab made in a parked window that Margin didn\'t open: the app told (tab); Margin\'s own, or in a window not parked: nothing', async () => {
  fresh();
  await sleep(2100); // past any tab Margin opened in the tests before
  await fire('onCreated', { id: 70, windowId: 2, url: 'https://link.test/', active: true, index: 2 });
  assert.deepEqual(said.pushes, [{ windowId: 2, why: 'tab', tabId: 70 }]);
  await fire('onCreated', { id: 71, windowId: 1, url: 'https://link.test/', active: true, index: 2 });
  assert.equal(said.pushes.length, 1, 'not parked');
  markMarginOpening();
  await fire('onCreated', { id: 72, windowId: 2, url: 'https://kept.test/', active: false, index: 3 });
  assert.equal(said.pushes.length, 1, 'Margin opened it');
});

test('focus landing on a parked window: the app told (focus), unless within 1 s (here shortened) of Margin\'s own windows call for it; a window not parked: nothing', async () => {
  fresh();
  await fire('onFocusChanged', 2);
  assert.deepEqual(said.pushes, [{ windowId: 2, why: 'focus' }], 'the person\'s: Window menu, ⌘`, the Dock');
  await fire('onFocusChanged', 1);
  await fire('onFocusChanged', -1);
  assert.equal(said.pushes.length, 1, 'not parked, or none');

  said.pushes.length = 0;
  fake.windows.get(2).state = 'normal';
  await handlers.setWindowState({ windowId: 2, state: 'normal', notAfter: Date.now() + 1000 });
  await fire('onFocusChanged', 2);
  assert.deepEqual(said.pushes, [], 'Margin\'s own call a moment ago');
  assert.ok(said.notes.includes('focus heard on parked window 2: Margin\'s own windows call, not told'));
  await sleep(170);
  await fire('onFocusChanged', 2);
  assert.deepEqual(said.pushes, [{ windowId: 2, why: 'focus' }], 'after it: the person\'s');

  said.pushes.length = 0;
  fake.holdUpdate = true;
  const pending = handlers.focusWindow({ windowId: 2, notAfter: Date.now() + 5000 });
  await sleep(200);
  await fire('onFocusChanged', 2);
  assert.deepEqual(said.pushes, [], 'while its call is pending: Margin\'s');
  fake.release();
  await pending;
  for (const w of fake.windows.values()) w.focused = w.id === 1;
});

test('a tab Margin\'s UI asks for in a parked window: shown there, the window not raised, the app asked (raise); not linked, raised as before', async () => {
  fresh();
  fake.windows.get(2).focused = false;
  await focusTab(22, { source: 'test' });
  assert.deepEqual(fake.tabUpdates, [{ id: 22, active: true }], 'in front in its window (shown when the app hands off)');
  assert.deepEqual(fake.windowUpdates, [], 'not raised');
  assert.deepEqual(said.pushes, [{ windowId: 2, why: 'raise', tabId: 22 }]);

  fresh();
  said.linked = false;
  await focusTab(21, { source: 'test' });
  assert.deepEqual(fake.windowUpdates, [{ id: 2, focused: true }], 'the app can\'t be told: raised');
  said.linked = true;

  fresh();
  await focusTab(2, { source: 'test' });
  assert.deepEqual(said.pushes, [], 'a window not parked: as ever');
  for (const w of fake.windows.values()) w.focused = w.id === 1;
  fake.tabs.get(21).active = true;
  fake.tabs.get(22).active = false;
});

test('openPin and a row\'s tab: a tab in a window that isn\'t parked first; one only in a parked window: the app asked to show it', async () => {
  fresh();
  const s0 = await store.load();
  const spaceId = s0.spaces[0].id;
  await store.mutate((s) => {
    let next = s;
    for (const id of [1, 2, 21, 22, 31]) next = M.upsertTab(next, fake.tabs.get(id), Date.now());
    for (const id of [1, 2, 21, 22, 31]) next = M.moveTab(next, id, spaceId);
    return { ...next, pins: [...next.pins, { id: 'pin1', url: 'https://pin.test/', title: 'Pin', spaceId, folderId: null }] };
  });
  // From window 1 (no such tab there): the person's own window 3's, not the parked one's.
  const shown = await handlers.openPin({ pinId: 'pin1', windowId: 1 });
  assert.equal(shown.shown, 31);
  assert.deepEqual(said.pushes, []);
  // A row's tab found by its address: the same.
  const found = await resolveTab(9999, { url: 'https://pin.test/', index: 1 }, 1);
  assert.equal(found?.id, 31, 'not the parked window\'s, though nearer its place');
  // Only in the parked window now.
  fake.tabs.delete(31);
  await fire('onRemoved', 31, { windowId: 3, isWindowClosing: false });
  for (let i = 0; i < 50 && (await store.load()).tabs[31]; i++) await sleep(10);
  assert.equal((await store.load()).tabs[31], undefined);
  fresh();
  const parked = await handlers.openPin({ pinId: 'pin1', windowId: 1 });
  assert.equal(parked.shown, 22);
  assert.deepEqual(said.pushes, [{ windowId: 2, why: 'raise', tabId: 22 }]);
  assert.deepEqual(fake.windowUpdates, [], 'not raised');
  fake.tabs.get(21).active = true;
  fake.tabs.get(22).active = false;
});

// ---- sleeping tabs -----------------------------------------------------------------------------

test('sleep: a parked window\'s tab in front never sleeps', async () => {
  const lines = [];
  const { switchLogTo } = await import('../extension/background/switch-log.ts');
  switchLogTo((line) => lines.push(line));
  // Margin's record says tab 21 isn't in front (its window's front moved meanwhile); Safari says it is.
  await store.mutate((s) => {
    const tabs = { ...s.tabs };
    for (const id of [21, 22]) if (tabs[id]) tabs[id] = { ...tabs[id], active: false, lastActive: 1, wokeAt: undefined };
    return { ...s, tabs };
  });
  fake.tabs.get(21).active = true;
  fake.tabs.get(22).active = false;
  const pass = await sleepIdle({ afterMs: 1000, max: 0 });
  assert.ok(pass, 'a pass ran');
  const second = await sleepIdle({ afterMs: 1000, max: 5 });
  assert.equal(second.skipped['in front, parked'], 1, 'its own reason in the log');
  assert.ok(lines.some((l) => /in front, parked 1/.test(l)));
});

// ---- the app's `parked`, per epoch (the link's own end) ---------------------------------------------

test('link: parked — kept per window as the app says it, this epoch\'s only; a new link, the link going off and a closed window forget it', async () => {
  const app = await startFakeApp();
  const area = () => {
    const data = {};
    return { data, get: async (keys) => pick(data, keys), set: async (v) => { Object.assign(data, structuredClone(v)); }, remove: async (keys) => { for (const k of [].concat(keys)) delete data[k]; } };
  };
  const ports = [];
  const api = {
    runtime: {
      getURL: (p) => `safari-web-extension://test/${p}`, getManifest: () => ({ version: '2.0.0' }),
      connectNative() {
        const cbs = [];
        const port = { onMessage: { addListener: (cb) => cbs.push(cb) }, onDisconnect: { addListener() {} }, postMessage() {}, disconnect() {}, deliver: (m) => cbs.forEach((cb) => cb(m)) };
        ports.push(port);
        return port;
      },
      async sendNativeMessage(_, message) {
        const open = !!api.app;
        if (open && message.type === 'wantLink') setTimeout(() => ports.at(-1)?.deliver(api.app.linkInfo(message.nonce)), 5);
        return { ok: true, appOpen: open };
      },
    },
    storage: { local: area(), session: area() },
    windows: { getAll: async () => [{ id: 7, left: 0, top: 0, width: 1280, height: 800, state: 'normal', focused: false }] },
    tabs: { query: async () => [] },
    app,
  };
  const link = createLink({
    api, isOwner: () => true, copy: () => ({ origin: 'safari-web-extension://test/', since: 1 }), instanceId: 'i1',
    WebSocket: globalThis.WebSocket, enabled: () => true, canSocket: () => true, data: null,
    theme: async () => null, commandKeys: () => ({}), log: () => {},
    timing: { ping: 50, dead: 10_000, check: 50, linkWait: 500, openWait: 500, keptWait: 300, reconnect: [20, 40, 80], ask: [100, 400], gone: 300, windows: 50, layoutWrite: 10, launchAsk: 30, launchAsks: 5 },
  });
  const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(10); } return false; };
  try {
    await link.start({ route: async () => ({ ok: true }) });
    const hello = await app.next('hello');
    const told = [];
    link.onParked((w, on) => told.push([w, on]));
    assert.equal(link.parked(7), false, 'not said');
    app.send({ k: 'parked', epoch: hello.epoch, windowId: 7, on: true, at: 5 });
    app.send({ k: 'parked', epoch: 'old', windowId: 8, on: true, at: 5 });
    app.send({ k: 'parked', epoch: hello.epoch, windowId: 7, on: true, at: 6 });
    app.send({ k: 'parked', epoch: hello.epoch, windowId: 'x', on: true, at: 6 });
    assert.ok(await until(() => link.parked(7)));
    await sleep(30);
    assert.equal(link.parked(8), false, 'another epoch\'s');
    assert.deepEqual(told, [[7, true]], 'a change only');
    assert.deepEqual(link.parkedWindows(), [7]);
    app.send({ k: 'parked', epoch: hello.epoch, windowId: 7, on: false, at: 7 });
    assert.ok(await until(() => !link.parked(7)), 'shown again');
    // A closed window's goes.
    app.send({ k: 'parked', epoch: hello.epoch, windowId: 7, on: true, at: 8 });
    assert.ok(await until(() => link.parked(7)));
    link.windowClosed(7);
    assert.equal(link.parked(7), false);
    // A new link: the epoch before's goes (the app says it again).
    app.send({ k: 'parked', epoch: hello.epoch, windowId: 7, on: true, at: 9 });
    assert.ok(await until(() => link.parked(7)));
    const from = app.received.length;
    app.drop();
    await sleep(15);
    assert.equal(link.parked(7), true, 'reconnecting: still parked (the app may still have it)');
    const again = await app.next('hello', { from });
    assert.notEqual(again.epoch, hello.epoch);
    assert.ok(await until(() => !link.parked(7)), 'a new epoch: forgotten');
    app.send({ k: 'parked', epoch: again.epoch, windowId: 7, on: true, at: 10 });
    assert.ok(await until(() => link.parked(7)));
    // Off (the app quit): none.
    api.app = null;
    app.send({ k: 'bye', why: 'Margin.app quit' });
    assert.ok(await until(() => !link.parked(7)));
    assert.deepEqual(told.at(-1), [7, false]);
  } finally {
    link.stop();
    await app.close();
  }
});

// ---- Margin's new-tab page answers the probe as web pages do ------------------------------------

test('Margin\'s new-tab page: answers the frame probe as a web page does', async () => {
  const frames = [];
  const els = {};
  const el = () => ({ hidden: true, textContent: '', listeners: {}, addEventListener() {}, focus() {}, setAttribute() {}, style: { cssText: '', setProperty() {} }, remove() {} });
  for (const id of ['notice', 'title', 'why', 'start', 'retry', 'status', 'go', 'address']) els[id] = el();
  const added = [];
  Object.assign(globalThis, {
    document: {
      getElementById: (id) => els[id] ?? null, addEventListener() {}, visibilityState: 'visible', hasFocus: () => true,
      documentElement: { appendChild: (n) => added.push(n) }, createElement: () => el(),
    },
    addEventListener() {}, location: { hash: '', search: '', reload() {} }, history: { length: 2 },
    requestAnimationFrame: (cb) => frames.push(cb), outerWidth: 1512, outerHeight: 982,
  });
  const onMessage = [];
  globalThis.browser = {
    runtime: { getURL: (p) => `safari-web-extension://test/${p}`, sendMessage: async () => ({ ok: true }), onMessage: { addListener: (fn) => onMessage.push(fn) } },
    storage: { local: { get: async () => ({ appLink: { state: 'linked', layouts: {}, drawn: {} }, settings: {} }) }, onChanged: { addListener() {} } },
    tabs: { getCurrent: async () => ({ id: 5, windowId: 7 }) },
  };
  try {
    await import('../extension/newtab/newtab.ts?probe');
    await sleep(20);
    let answer;
    const open = onMessage.map((fn) => fn({ type: 'frameProbe', width: 1512, height: 982, frames: 2, nudgeMs: 0, timeoutMs: 400 }, {}, (a) => { answer = a; }));
    assert.ok(open.includes(true), 'answered later (the channel kept open)');
    for (let i = 0; i < 3; i++) for (const cb of frames.splice(0)) cb();
    await sleep(5);
    assert.equal(answer?.frames, 2);
    assert.equal(answer?.width, 1512);
    assert.equal(answer?.visible, true);
  } finally {
    for (const k of ['document', 'addEventListener', 'location', 'history', 'requestAnimationFrame', 'outerWidth', 'outerHeight', 'browser']) delete globalThis[k];
  }
});

// ---- the scroll record (docs/DATA.md "The scroll record") ------------------------------------------

test('the scroll record in the model: on the record for its address only, kept with its Margin tab, taken once when it opens again, never in the data set', async () => {
  const { collectionFrom } = await import('../extension/shared/data-set.ts');
  let s = M.normalizeState({});
  s = M.upsertTab(s, { id: 5, windowId: 1, url: 'https://read.test/long', title: 'Long', index: 0, active: true }, 1000);
  s = M.noteScroll(s, 5, { y: 1234.6, url: 'https://read.test/long#part' });
  assert.equal(s.tabs[5].scroll, 1235, 'rounded, the same page with a fragment');
  assert.equal(M.noteScroll(s, 5, { y: 50, url: 'https://elsewhere.test/' }), s, 'another address (a late word): nothing');
  assert.equal(M.noteScroll(s, 5, { y: 1235, url: 'https://read.test/long' }), s, 'the same place: no change to write');
  assert.equal(M.noteScroll(s, 99, { y: 50, url: 'https://read.test/long' }), s, 'no record: nothing');
  assert.equal(M.noteScroll(s, 5, { y: 0, url: 'https://read.test/long' }).tabs[5].scroll, undefined, 'back at the top: none');
  assert.equal(M.upsertTab(s, { id: 5, windowId: 1, url: 'https://read.test/long', title: 'Long (2)', index: 0 }, 1100).tabs[5].scroll, 1235, 'kept through its updates');
  assert.equal(M.upsertTab(s, { id: 5, windowId: 1, url: 'https://read.test/other', title: 'Other', index: 0 }, 1100).tabs[5].scroll, undefined, 'another page: dropped');
  assert.ok(!('scroll' in collectionFrom(s, 'tabs')[s.tabs[5].mid]), 'not in the data set');

  // Its window closing: kept, with the place and the address it's for.
  const closed = M.closedTab(s, 5, { windowClosing: true, now: 2000, archiveId: 'a-1' });
  const kept = Object.values(closed.keptTabs)[0];
  assert.deepEqual(kept.scroll, { y: 1235, url: 'https://read.test/long' });
  assert.ok(!('scroll' in collectionFrom(closed, 'tabs')[kept.id]), 'a kept tab\'s neither');
  // Opened again (a tab made blank, then at its address): the place to take, once.
  let open = M.upsertTab(closed, { id: 6, windowId: 2, url: '', title: '', index: 0 }, 3000);
  open = M.linkKept(open, 6, kept.id, 3000);
  assert.deepEqual(open.tabs[6].restoreScroll, { y: 1235, url: 'https://read.test/long' });
  open = M.upsertTab(open, { id: 6, windowId: 2, url: 'https://read.test/long', title: 'Long', index: 0 }, 3100);
  assert.ok(open.tabs[6].restoreScroll, 'kept while it loads its page');
  assert.equal(M.upsertTab(open, { id: 6, windowId: 2, url: 'https://redirected.test/', title: '', index: 0 }, 3100).tabs[6].restoreScroll, undefined, 'at another page: dropped');
  const first = M.takeScroll(open, 6, 'https://read.test/long');
  assert.equal(first.y, 1235);
  assert.equal(first.state.tabs[6].restoreScroll, undefined);
  assert.equal(M.takeScroll(first.state, 6, 'https://read.test/long').y, null, 'once');
  assert.equal(M.takeScroll(open, 6, 'https://other.test/').y, null, 'another address: none');
  assert.equal(M.takeScroll(open, 6, 'https://other.test/').state.tabs[6].restoreScroll, undefined, '…and it\'s gone');
  // A kept tab with no place: nothing to take.
  const plain = M.closedTab(M.upsertTab(M.normalizeState({}), { id: 7, windowId: 1, url: 'https://top.test/', title: '', index: 0 }, 1), 7, { windowClosing: true, now: 2, archiveId: 'a-2' });
  const k2 = Object.values(plain.keptTabs)[0];
  assert.equal(k2.scroll, undefined);
  assert.equal(M.linkKept(M.upsertTab(plain, { id: 8, windowId: 1, url: '', title: '', index: 0 }, 3), 8, k2.id, 3).tabs[8].restoreScroll, undefined);
});

test('the scroll record in the background: a page\'s word written to its tab, kept as its window closes, taken once by the page of the reopened tab', async () => {
  fake.windows.set(8, win(8, { state: 'normal' }));
  const url = 'https://scroll.test/article';
  const tab = { id: 81, windowId: 8, url, title: 'Article', index: 0, active: true, status: 'complete' };
  fake.tabs.set(81, tab);
  await store.mutate((s) => M.upsertTab(s, tab, Date.now()));
  assert.equal(await handlers.pageScroll({ y: 2200, url }, { tab: { id: 81 } }), null);
  assert.equal((await store.load()).tabs[81].scroll, 2200);
  await handlers.pageScroll({ y: 10, url: 'https://elsewhere.test/' }, { tab: { id: 81 } });
  assert.equal((await store.load()).tabs[81].scroll, 2200, 'another page\'s word: nothing');
  await handlers.pageScroll({ y: 10, url }, {});
  assert.equal((await store.load()).tabs[81].scroll, 2200, 'no tab: nothing');

  // Its window closes (the app's closeWindow): kept with its place.
  fake.tabs.delete(81);
  fake.windows.delete(8);
  await fire('onRemoved', 81, { windowId: 8, isWindowClosing: true });
  await store.mutate((s) => s);
  const kept = Object.values((await store.load()).keptTabs).find((k) => k.url === url);
  assert.deepEqual(kept?.scroll, { y: 2200, url });

  // Opened again from the sidebar: its page asks, once.
  const { shown } = await handlers.activateTab({ tabId: kept.id, windowId: 1 }, { tab: { windowId: 1 } });
  assert.deepEqual((await store.load()).tabs[shown].restoreScroll, { y: 2200, url });
  assert.equal(await handlers.takeScroll({ url }, { tab: { id: shown } }), 2200);
  assert.equal(await handlers.takeScroll({ url }, { tab: { id: shown } }), null, 'once');
  assert.equal((await store.load()).tabs[shown].restoreScroll, undefined);
  fake.tabs.delete(shown);
  await store.mutate((s) => M.removeTab(s, shown));
});

test('the draft answers: each page\'s scroll with them, written to its tab just before the close they were asked for; the sleep check\'s too', async () => {
  fake.windows.set(9, win(9));
  const tabs = [
    { id: 91, windowId: 9, url: 'https://one.test/', title: '', index: 0, active: true, status: 'complete' },
    { id: 92, windowId: 9, url: 'https://two.test/', title: '', index: 1, active: false, status: 'complete' },
  ];
  for (const t of tabs) fake.tabs.set(t.id, t);
  await store.mutate((s) => tabs.reduce((st, t) => M.upsertTab(st, t, Date.now()), s));
  fake.scrollY = { 91: 640 };
  fake.drafts = (tabId) => (tabId === 92 ? 'draft' : 'none');
  assert.deepEqual(await handlers.windowDrafts({ windowId: 9 }), { drafts: [92], unknown: [] });
  await store.mutate((s) => s);
  const s = await store.load();
  assert.equal(s.tabs[91].scroll, 640);
  assert.equal(s.tabs[92].scroll, undefined, 'at the top (said nothing of it): none');

  // The page's own answer: <html>'s place, or <body>'s while Margin's box scrolls it; the top frame only.
  const { sleepInPage } = await import('../extension/background/sleep.ts');
  const run = (html, body, top = true) => {
    const doc = { visibilityState: 'hidden', querySelectorAll: () => [], scrollingElement: { scrollTop: html }, body: { scrollTop: body } };
    Object.assign(globalThis, { window: {}, document: doc, location: { href: 'https://a.test/' } });
    globalThis.window.top = top ? globalThis.window : {};
    globalThis.window.frameElement = null;
    try {
      return sleepInPage('https://a.test/', Date.now() + 1000, true);
    } finally {
      for (const k of ['window', 'document', 'location']) delete globalThis[k];
    }
  };
  assert.equal(run(320.4, 0).scrollY, 320);
  assert.equal(run(0, 900).scrollY, 900, 'the box\'s <body>');
  assert.equal(run(0, 0).scrollY, undefined, 'at the top: not said');
  assert.equal(run(320, 0, false).scrollY, undefined, 'another frame says nothing of it');
  for (const t of tabs) fake.tabs.delete(t.id);
  fake.windows.delete(9);
  fake.scrollY = {};
  fake.drafts = () => 'none';
  await store.mutate((st) => tabs.reduce((x, t) => M.removeTab(x, t.id), st));
});

test('the page\'s part: its scroll said as it\'s hidden (once a second, the last after that) and as it\'s left, only when it moved; a reopened tab\'s place taken once, until it\'s there or the person moves', async () => {
  const { startScrollRecord } = await import('../extension/content/scroll-record.ts');
  const page = () => {
    const on = {};
    const add = (target) => (type, fn) => (on[`${target}:${type}`] ??= []).push(fn);
    const remove = (target) => (type, fn) => { on[`${target}:${type}`] = (on[`${target}:${type}`] ?? []).filter((f) => f !== fn); };
    const html = { scrollTop: 0 };
    const body = { scrollTop: 0, max: Infinity };
    const doc = {
      visibilityState: 'visible', readyState: 'complete', scrollingElement: html, body,
      addEventListener: add('doc'), removeEventListener: remove('doc'),
    };
    const win = { location: { href: 'https://page.test/a' }, addEventListener: add('win'), removeEventListener: remove('win') };
    const sent = [];
    const answers = { takeScroll: null };
    const send = async (type, payload) => { sent.push({ type, ...payload }); return answers[type] ?? null; };
    const emit = (key) => { for (const fn of [...(on[key] ?? [])]) fn(); };
    return { doc, win, html, body, sent, answers, send, emit, on };
  };
  const p = page();
  let boxed = false;
  const rec = startScrollRecord({ send: p.send, retired: () => false, boxed: () => boxed, doc: p.doc, win: p.win, everyMs: 60, restoreMs: 300 });
  p.doc.visibilityState = 'hidden';
  p.emit('doc:visibilitychange');
  assert.deepEqual(p.sent, [], 'never scrolled: nothing said');
  p.html.scrollTop = 410;
  p.emit('doc:visibilitychange');
  assert.deepEqual(p.sent, [{ type: 'pageScroll', y: 410, url: 'https://page.test/a' }]);
  p.html.scrollTop = 500;
  p.emit('doc:visibilitychange');
  assert.equal(p.sent.length, 1, 'within a second of the last: later');
  await sleep(80);
  assert.deepEqual(p.sent.at(-1), { type: 'pageScroll', y: 500, url: 'https://page.test/a' }, 'the last, after the wait');
  p.emit('doc:visibilitychange');
  assert.equal(p.sent.length, 2, 'not moved: nothing');
  p.html.scrollTop = 520;
  p.emit('win:pagehide');
  assert.deepEqual(p.sent.at(-1), { type: 'pageScroll', y: 520, url: 'https://page.test/a' }, 'left: at once');

  // Reopened: asked once, set until it's there (the page growing), with the box on: <body>.
  const q = page();
  q.answers.takeScroll = 1800;
  boxed = true;
  q.body.scrollTop = 0;
  let tall = false;
  Object.defineProperty(q.body, 'scrollTop', { get() { return this._y ?? 0; }, set(v) { this._y = tall ? v : Math.min(v, 300); }, configurable: true });
  const rec2 = startScrollRecord({ send: q.send, retired: () => false, boxed: () => boxed, doc: q.doc, win: q.win, everyMs: 60, restoreMs: 1000 });
  rec2.take(false);
  assert.deepEqual(q.sent, [], 'no place on its record: not asked');
  rec2.take(true);
  rec2.take(true);
  await sleep(5);
  assert.deepEqual(q.sent, [{ type: 'takeScroll', url: 'https://page.test/a' }], 'asked once');
  assert.equal(q.body.scrollTop, 300, 'as far as the page goes yet');
  tall = true;
  await sleep(250);
  assert.equal(q.body.scrollTop, 1800, 'then there');
  assert.equal(q.html.scrollTop, 0, '<html> left alone under the box');
  assert.ok((q.on['win:wheel'] ?? []).length === 0, 'done: its listeners gone');

  // The person scrolls first: left where they put it.
  const r = page();
  r.answers.takeScroll = 5000;
  boxed = false;
  Object.defineProperty(r.html, 'scrollTop', { get() { return this._y ?? 0; }, set(v) { this._y = Math.min(v, 100); }, configurable: true });
  const rec3 = startScrollRecord({ send: r.send, retired: () => false, boxed: () => boxed, doc: r.doc, win: r.win, everyMs: 60, restoreMs: 2000 });
  rec3.take(true);
  await sleep(5);
  r.emit('win:wheel');
  r.html._y = 40;
  await sleep(450);
  assert.equal(r.html.scrollTop, 40, 'not set again after the person moved');
  // A page still loading: set once it's parsed.
  const t = page();
  t.answers.takeScroll = 70;
  t.doc.readyState = 'loading';
  startScrollRecord({ send: t.send, retired: () => false, boxed: () => false, doc: t.doc, win: t.win }).take(true);
  await sleep(5);
  assert.equal(t.html.scrollTop, 0);
  t.emit('doc:DOMContentLoaded');
  assert.equal(t.html.scrollTop, 70);
  void rec;
});
