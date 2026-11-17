// The windows calls Margin.app makes through a copy (background/handoff.ts), against the real background
// with a fake of Safari's API: setWindowState and closeWindow refused past their notAfter and busy while
// another for the window is pending, setWindowState waiting for the state to land and sending the window
// list at once; newWindow; and the scroll record (written as a page is hidden or left, kept with its Margin
// tab as its window closes, taken once when it's opened again, and the page's own part).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeApp } from './fake-app.ts';
import { fakeBrowser, type FakeBrowserApi } from './fake-browser.ts';


const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Every event's listeners, by the event's name: each called with what that event gives.
const listeners: Record<string, ((...args: any[]) => unknown)[]> = {};
const event = (name: string) => ({ addListener: (fn: (...args: any[]) => unknown) => (listeners[name] ??= []).push(fn), removeListener() {}, hasListener: () => false });
const fire = (name: string, ...args: unknown[]) => Promise.all((listeners[name] ?? []).map((fn) => fn(...args)));
const pick = (store: Record<string, any>, keys?: string | string[] | Record<string, any> | null) => {
  if (keys == null) return structuredClone(store);
  const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
  return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
};

// Safari's windows: id → { id, state, focused, left, top, width, height }. A windows.update's state
// lands `landMs` after it's answered (a full-screen change animates); `holdUpdate`: the next update is
// answered only when `release()` is called (one stuck behind a hung tab). `drafts(tabId)`: what the
// draft check finds in that tab ('draft', 'none', 'never': no answer, 'error': no script there).
const fake = {
  tabs: new Map<number, BrowserTab>(), windows: new Map<number, BrowserWindow>(), local: {} as Record<string, any>, session: {} as Record<string, any>, // stored JSON
  windowUpdates: [] as ({ id: number } & Record<string, unknown>)[], tabUpdates: [] as ({ id: number } & Record<string, unknown>)[],
  removedWindows: [] as number[], created: [] as number[], createdWith: [] as any[], scripts: [] as { tabId: number, args?: any[], allFrames: boolean }[],
  landMs: 0, holdUpdate: false, release: (() => {}) as (value?: unknown) => void,
  probe: (_tabId: number, _m: any) => (undefined as any),
  drafts: (_tabId: number) => 'none',
  denied: new Set<string>(),
  scrollY: ({} as Record<number, number>), // where each tab's page is scrolled, in its answer to the draft check
};
const win = (id: number, extra: Partial<BrowserWindow> = {}): BrowserWindow => ({ id, state: 'fullscreen', focused: false, left: 0, top: 0, width: 1512, height: 982, ...extra });
// Every fetch answered with an empty document: only what Margin reads of a response.
globalThis.fetch = (async () => ({ ok: true, text: async () => '{}', json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) })) as unknown as typeof fetch;
globalThis.chrome = fakeBrowser({
  runtime: {
    id: 'test', getURL: (p) => `safari-web-extension://test/${p}`, getManifest: () => ({ version: '0', content_scripts: [{ js: ['content.js'] }] }),
    onInstalled: event('onInstalled'), onStartup: event('onStartup'), onMessage: event('onMessage'), sendMessage: async () => undefined, sendNativeMessage: async () => undefined,
  },
  // Margin asks by origin.
  permissions: { contains: async ({ origins: [o] }: { origins: string[] }) => ![...fake.denied].some((d) => o.includes(d)), onAdded: event('pAdded'), onRemoved: event('pRemoved') },
  alarms: { get: async () => ({}), create: async () => {}, onAlarm: event('onAlarm') }, // (no clear: Margin never calls it)
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
      fake.createdWith.push(props);
      const w = win(id, { state: props.state ?? 'normal', focused: props.focused !== false, left: 10, top: 25, width: 1200, height: 800 });
      fake.windows.set(id, w);
      // (One address, as Margin opens them.)
      const tab = { id: id * 10, windowId: id, url: (props.url ?? 'safari-web-extension://test/newtab/newtab.html') as string, title: '', index: 0, active: true, status: 'loading' };
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
      remove: async (keys) => { for (const k of ([] as string[]).concat(keys)) delete fake.local[k]; },
    },
    session: { get: async (keys) => pick(fake.session, keys), set: async (items) => { Object.assign(fake.session, structuredClone(items)); }, remove: async () => {} },
    onChanged: event('sChanged'),
  },
});

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
const { createLink } = await import('../extension/background/link.ts');
type Said = import('../extension/background/link.ts').Said;
type FakeApp = Awaited<ReturnType<typeof startFakeApp>>;
// The windows calls' answers as each test reads them: refused (late, or busy), or the window's state.
type Refused = { refused?: string, pastMs?: number, busy?: boolean };
type Landed = { windowId: number, state: string | null, landedAt?: number, timedOut?: boolean };
// The handlers as these tests call some of them: without a sender (the request's own fields say the window).
type Handlers = typeof handlers;
type NoSender = { [K in keyof Handlers]: Handlers[K] extends (message: infer M, sender: BrowserMessageSender) => infer R ? (message: M, sender?: BrowserMessageSender) => R : Handlers[K] };
for (let i = 0; i < 100 && !store.isSynced(); i++) await sleep(10);
assert.ok(store.isSynced(), 'synced');
setHandoffTiming({ pollMs: 10, landMs: 300, focusOwnMs: 150 });
setSleepTiming({ gapMs: 1, askMs: 100 });

// The link's word, as the background's link object would have it: its notes and its window list sent now.
const said = { notes: [] as string[], windowsNow: 0 };
appLink.note = (...args) => { said.notes.push(args.join(' ')); };
appLink.windowsNow = async () => { said.windowsNow++; };
const fresh = () => { said.notes.length = 0; said.windowsNow = 0; fake.windowUpdates.length = 0; fake.tabUpdates.length = 0; };

// ---- the windows calls ------------------------------------------------------------------------

test('setWindowState: past notAfter, refused with nothing called; in time, Safari asked once, answered when the state lands, the window list sent at once', async () => {
  fresh();
  fake.windows.get(2)!.state = 'normal';
  const late = (await handlers.setWindowState({ windowId: 2, state: 'fullscreen', focused: true, notAfter: Date.now() - 210 })) as Refused;
  assert.equal(late.refused, 'late');
  assert.ok(late.pastMs! >= 210 && late.pastMs! < 400, `${late.pastMs} ms past`);
  assert.deepEqual(fake.windowUpdates, [], 'nothing called');
  assert.ok(said.notes.some((n) => /^setWindowState window 2: refused, \d+ ms past notAfter$/.test(n)), 'the log: ids and milliseconds only');

  fake.landMs = 60;
  const started = Date.now();
  const landed = (await handlers.setWindowState({ windowId: 2, state: 'fullscreen', focused: true, notAfter: Date.now() + 1500 })) as Landed;
  assert.equal(landed.windowId, 2);
  assert.equal(landed.state, 'fullscreen');
  assert.ok(landed.landedAt! >= started + 60, 'answered once Safari says it\'s there, not at the update');
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
  fake.windows.get(3)!.state = 'normal';
  const t0 = Date.now();
  const answer = await handlers.setWindowState({ windowId: 3, state: 'fullscreen', notAfter: Date.now() + 1500 });
  assert.deepEqual(answer, { windowId: 3, state: 'fullscreen', timedOut: true });
  assert.ok(Date.now() - t0 >= 290, 'waited its whole time');
  assert.equal(said.windowsNow, 1);
  fake.landMs = 0;
  fake.windows.get(3)!.state = 'normal';
  await assert.rejects(handlers.setWindowState({ windowId: 77, state: 'normal', notAfter: Date.now() + 1500 }), /No window/);
  await assert.rejects(handlers.setWindowState({ windowId: 3, state: 'minimized' as string as 'normal', notAfter: Date.now() + 1500 }), /no such window state/); // (one the app may send)
});

test('one windows call per window: a second setWindowState or closeWindow while one is pending is busy, nothing called; another window\'s runs; late comes before busy', async () => {
  fresh();
  fake.windows.get(2)!.state = 'normal';
  fake.holdUpdate = true;
  const first = handlers.setWindowState({ windowId: 2, state: 'fullscreen', notAfter: Date.now() + 5000 });
  await sleep(10);
  assert.equal(fake.windowUpdates.length, 1);
  assert.deepEqual(await handlers.setWindowState({ windowId: 2, state: 'normal', notAfter: Date.now() + 5000 }), { busy: true });
  assert.deepEqual(await handlers.closeWindow({ windowId: 2, notAfter: Date.now() + 5000 }), { busy: true });
  assert.equal(((await handlers.closeWindow({ windowId: 2, notAfter: Date.now() - 50 })) as Refused).refused, 'late', 'late, though busy too');
  assert.equal(fake.windowUpdates.length, 1, 'none of them called Safari');
  assert.deepEqual(fake.removedWindows, []);
  assert.ok(said.notes.some((n) => n === 'closeWindow window 2: busy (a windows call for it is still pending)'));
  fake.windows.set(3, fake.windows.get(3) ?? win(3, { state: 'normal' }));
  const other = (await handlers.setWindowState({ windowId: 3, state: 'normal', notAfter: Date.now() + 5000 })) as Refused;
  assert.ok(!other.busy && !other.refused, 'another window: not held up');
  fake.release();
  assert.equal(((await first) as Landed).state, 'fullscreen');
  const again = (await handlers.setWindowState({ windowId: 2, state: 'fullscreen', notAfter: Date.now() + 5000 })) as Refused;
  assert.ok(!again.busy && !again.refused, 'the first one answered: free again');

  // A close with no notAfter (the host's): never busy, but pending all the same.
  fresh();
  fake.windows.set(8, win(8, { state: 'normal' }));
  fake.holdUpdate = true;
  const held = handlers.setWindowState({ windowId: 8, state: 'fullscreen', notAfter: Date.now() + 5000 });
  await sleep(10);
  assert.equal(await handlers.closeWindow({ windowId: 8 }), null, 'a close with no notAfter: run');
  assert.ok(!fake.windows.has(8));
  fake.release();
  await held.catch(() => {});
  fake.windows.get(1)!.focused = true;
});

test('closeWindow: with no notAfter never late; past one, nothing called', async () => {
  fresh();
  fake.windows.set(9, win(9, { state: 'normal' }));
  assert.equal(((await handlers.closeWindow({ windowId: 9, notAfter: Date.now() - 5 })) as Refused).refused, 'late');
  assert.deepEqual(fake.windowUpdates, []);
  assert.ok(fake.windows.has(9), 'not closed');
  assert.equal(await handlers.closeWindow({ windowId: 9 }), null);
  assert.ok(!fake.windows.has(9), 'closed');
  await assert.rejects(handlers.closeWindow({} as { windowId: number }), /no window/); // (none said)
  fake.windows.get(1)!.focused = true;
});

// ---- newWindow: ⌘N (docs/BROWSER-WINDOWS.md §5) -------------------------------------------------------------

test('newWindow from a window: a Margin window of its own in full screen like it, on the space it shows, its tab in that space; bounds answered, the list sent at once', async () => {
  fresh();
  let s = await store.load();
  const space = s.spaces[s.spaces.length - 1];
  await (handlers as NoSender).setSpace({ windowId: 1, spaceId: space.id });
  fake.windows.get(1)!.state = 'fullscreen';
  const before = said.windowsNow;
  const answer = (await handlers.newWindow({ fromWindowId: 1 }))!;
  s = await store.load();
  assert.equal(answer.state, 'fullscreen', 'full screen like the window it came from');
  assert.deepEqual(answer.bounds, { left: 10, top: 25, width: 1200, height: 800 });
  assert.equal(s.activeSpaceByWindow[answer.windowId], space.id, 'on the space that window shows');
  assert.equal(s.tabSpace[answer.windowId * 10], space.id, 'its tab in that space');
  assert.equal(said.windowsNow, before + 1);
  // A normal window's: a normal window. With no window to start from, as before: the browser's choice of space.
  fake.windows.get(1)!.state = 'normal';
  const normal = (await handlers.newWindow({ fromWindowId: 1 }))!;
  assert.equal(normal.state, 'normal');
  const bare = (await handlers.newWindow())!;
  assert.equal(bare.state, 'normal');
  for (const w of [answer, normal, bare]) { fake.windows.delete(w.windowId); fake.tabs.delete(w.windowId * 10); }
  fake.windows.get(1)!.state = 'fullscreen';
  fake.windows.get(1)!.focused = true;
});

test('newWindow made ready out of sight (Margin.app at its launch): a blank page, focused (a hidden Safari orders no unfocused window in); any other address ignored', async () => {
  fresh();
  fake.createdWith = [];
  const blank = (await handlers.newWindow({ fullscreen: false, url: 'about:blank', background: true } as any))!;
  assert.deepEqual(fake.createdWith[0], { focused: true, url: 'about:blank' }, 'focused, whatever an older app asks');
  assert.equal(fake.tabs.get(blank.windowId * 10)?.url, 'about:blank', 'nothing loaded in it');
  const other = (await handlers.newWindow({ fullscreen: false, url: 'https://a.example/' }))!;
  assert.deepEqual(fake.createdWith[1], { focused: true }, 'only a blank page is taken');
  for (const w of [blank, other]) { fake.windows.delete(w.windowId); fake.tabs.delete(w.windowId * 10); }
  fake.windows.get(1)!.focused = true;
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
  // Tabs as the test gives them: without `active` (not in front).
  assert.equal(M.upsertTab(s, { id: 5, windowId: 1, url: 'https://read.test/long', title: 'Long (2)', index: 0 } as BrowserTab, 1100).tabs[5].scroll, 1235, 'kept through its updates');
  assert.equal(M.upsertTab(s, { id: 5, windowId: 1, url: 'https://read.test/other', title: 'Other', index: 0 } as BrowserTab, 1100).tabs[5].scroll, undefined, 'another page: dropped');
  assert.ok(!('scroll' in collectionFrom(s, 'tabs')[s.tabs[5].mid!]), 'not in the data set');

  // Its window closing: kept, with the place and the address it's for.
  const closed = M.closedTab(s, 5, { windowClosing: true, now: 2000, archiveId: 'a-1' });
  const kept = Object.values(closed.keptTabs)[0];
  assert.deepEqual(kept.scroll, { y: 1235, url: 'https://read.test/long' });
  assert.ok(!('scroll' in collectionFrom(closed, 'tabs')[kept.id]), 'a kept tab\'s neither');
  // Opened again (a tab made blank, then at its address): the place to take, once.
  let open = M.upsertTab(closed, { id: 6, windowId: 2, url: '', title: '', index: 0 } as BrowserTab, 3000);
  open = M.linkKept(open, 6, kept.id, 3000);
  assert.deepEqual(open.tabs[6].restoreScroll, { y: 1235, url: 'https://read.test/long' });
  open = M.upsertTab(open, { id: 6, windowId: 2, url: 'https://read.test/long', title: 'Long', index: 0 } as BrowserTab, 3100);
  assert.ok(open.tabs[6].restoreScroll, 'kept while it loads its page');
  assert.equal(M.upsertTab(open, { id: 6, windowId: 2, url: 'https://redirected.test/', title: '', index: 0 } as BrowserTab, 3100).tabs[6].restoreScroll, undefined, 'at another page: dropped');
  const first = M.takeScroll(open, 6, 'https://read.test/long');
  assert.equal(first.y, 1235);
  assert.equal(first.state.tabs[6].restoreScroll, undefined);
  assert.equal(M.takeScroll(first.state, 6, 'https://read.test/long').y, null, 'once');
  assert.equal(M.takeScroll(open, 6, 'https://other.test/').y, null, 'another address: none');
  assert.equal(M.takeScroll(open, 6, 'https://other.test/').state.tabs[6].restoreScroll, undefined, '…and it\'s gone');
  // A kept tab with no place: nothing to take.
  const plain = M.closedTab(M.upsertTab(M.normalizeState({}), { id: 7, windowId: 1, url: 'https://top.test/', title: '', index: 0 } as BrowserTab, 1), 7, { windowClosing: true, now: 2, archiveId: 'a-2' });
  const k2 = Object.values(plain.keptTabs)[0];
  assert.equal(k2.scroll, undefined);
  assert.equal(M.linkKept(M.upsertTab(plain, { id: 8, windowId: 1, url: '', title: '', index: 0 } as BrowserTab, 3), 8, k2.id, 3).tabs[8].restoreScroll, undefined);
});

test('the scroll record in the background: a page\'s word written to its tab, kept as its window closes, taken once by the page of the reopened tab', async () => {
  fake.windows.set(8, win(8, { state: 'normal' }));
  const url = 'https://scroll.test/article';
  const tab = { id: 81, windowId: 8, url, title: 'Article', index: 0, active: true, status: 'complete' };
  fake.tabs.set(81, tab);
  await store.mutate((s) => M.upsertTab(s, tab, Date.now()));
  // Senders with only what the handlers read of their tab.
  assert.equal(await handlers.pageScroll({ y: 2200, url }, { tab: { id: 81 } as BrowserTab }), null);
  assert.equal((await store.load()).tabs[81].scroll, 2200);
  await handlers.pageScroll({ y: 10, url: 'https://elsewhere.test/' }, { tab: { id: 81 } as BrowserTab });
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
  const { shown } = await handlers.activateTab({ tabId: kept!.id, windowId: 1 }, { tab: { windowId: 1 } as BrowserTab });
  assert.deepEqual((await store.load()).tabs[shown].restoreScroll, { y: 2200, url });
  assert.equal(await handlers.takeScroll({ url }, { tab: { id: shown } as BrowserTab }), 2200);
  assert.equal(await handlers.takeScroll({ url }, { tab: { id: shown } as BrowserTab }), null, 'once');
  assert.equal((await store.load()).tabs[shown].restoreScroll, undefined);
  fake.tabs.delete(shown);
  await store.mutate((s) => M.removeTab(s, shown));
});

test('the sleep check\'s answer says where the page is scrolled', async () => {
  // The page's own answer: <html>'s place, or <body>'s where the page scrolls it; the top frame only.
  const { sleepInPage } = await import('../extension/background/sleep.ts');
  const run = (html: number, body: number, top = true): { ok: boolean, scrollY?: number } => {
    const doc = { visibilityState: 'hidden', querySelectorAll: () => [], scrollingElement: { scrollTop: html }, body: { scrollTop: body } };
    Object.assign(globalThis, { window: {}, document: doc, location: { href: 'https://a.test/' } });
    globalThis.window.top = top ? globalThis.window : ({} as Window); // another frame's top
    globalThis.window.frameElement = null;
    try {
      return sleepInPage('https://a.test/', Date.now() + 1000);
    } finally {
      for (const k of ['window', 'document', 'location']) delete (globalThis as Record<string, unknown>)[k];
    }
  };
  assert.equal(run(320.4, 0).scrollY, 320);
  assert.equal(run(0, 900).scrollY, 900, 'a page that scrolls its <body>');
  assert.equal(run(0, 0).scrollY, undefined, 'at the top: not said');
  assert.equal(run(320, 0, false).scrollY, undefined, 'another frame says nothing of it');
});

test('the page\'s part: its scroll said as it\'s hidden (once a second, the last after that) and as it\'s left, only when it moved; a reopened tab\'s place taken once, until it\'s there or the person moves', async () => {
  const { startScrollRecord } = await import('../extension/content/scroll-record.ts');
  const page = () => {
    const on: Record<string, (() => void)[]> = {};
    const add = (target: string) => (type: string, fn: () => void) => (on[`${target}:${type}`] ??= []).push(fn);
    const remove = (target: string) => (type: string, fn: () => void) => { on[`${target}:${type}`] = (on[`${target}:${type}`] ?? []).filter((f) => f !== fn); };
    // (`_y`: where a test's own scrollTop keeps its value.)
    const html: { scrollTop: number, _y?: number } = { scrollTop: 0 };
    const body = { scrollTop: 0, max: Infinity };
    const doc = {
      visibilityState: 'visible', readyState: 'complete', scrollingElement: html, body,
      addEventListener: add('doc'), removeEventListener: remove('doc'),
    };
    const win = { location: { href: 'https://page.test/a' }, addEventListener: add('win'), removeEventListener: remove('win') };
    const sent: Record<string, unknown>[] = [];
    const answers = { takeScroll: null as number | null };
    const send = async (type: string, payload: Record<string, unknown>) => { sent.push({ type, ...payload }); return (answers as Record<string, number | null>)[type] ?? null; };
    const emit = (key: string) => { for (const fn of [...(on[key] ?? [])]) fn(); };
    return { doc, win, html, body, sent, answers, send, emit, on };
  };
  const p = page();
  const rec = startScrollRecord({ send: p.send, retired: () => false, doc: p.doc, win: p.win, everyMs: 60, restoreMs: 300 });
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

  // Reopened: asked once, set until it's there (the page growing).
  const q = page();
  q.answers.takeScroll = 1800;
  let tall = false;
  Object.defineProperty(q.html, 'scrollTop', { get() { return this._y ?? 0; }, set(v) { this._y = tall ? v : Math.min(v, 300); }, configurable: true });
  const rec2 = startScrollRecord({ send: q.send, retired: () => false, doc: q.doc, win: q.win, everyMs: 60, restoreMs: 1000 });
  rec2.take(false);
  assert.deepEqual(q.sent, [], 'no place on its record: not asked');
  rec2.take(true);
  rec2.take(true);
  await sleep(5);
  assert.deepEqual(q.sent, [{ type: 'takeScroll', url: 'https://page.test/a' }], 'asked once');
  assert.equal(q.html.scrollTop, 300, 'as far as the page goes yet');
  tall = true;
  await sleep(250);
  assert.equal(q.html.scrollTop, 1800, 'then there');
  assert.ok((q.on['win:wheel'] ?? []).length === 0, 'done: its listeners gone');

  // The person scrolls first: left where they put it.
  const r = page();
  r.answers.takeScroll = 5000;
  Object.defineProperty(r.html, 'scrollTop', { get() { return this._y ?? 0; }, set(v) { this._y = Math.min(v, 100); }, configurable: true });
  const rec3 = startScrollRecord({ send: r.send, retired: () => false, doc: r.doc, win: r.win, everyMs: 60, restoreMs: 2000 });
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
  startScrollRecord({ send: t.send, retired: () => false, doc: t.doc, win: t.win }).take(true);
  await sleep(5);
  assert.equal(t.html.scrollTop, 0);
  t.emit('doc:DOMContentLoaded');
  assert.equal(t.html.scrollTop, 70);
  void rec;
});
