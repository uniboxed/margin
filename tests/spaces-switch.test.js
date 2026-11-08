// Showing a space (background/navigation.js showSpace), and the wake's use
// of Margin's own state and its site-access cache (background/tabs.js),
// against a fake browser API (Safari's profile: the wake runs).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fake = { zoom: {}, tabs: new Map(), nextId: 100, calls: { get: 0, contains: 0, create: [] }, messages: [], access: true, local: {}, current: new Set(), injected: [], probes: 0, probeHangs: false, removed: [], history: [] };
const asTab = (t) => ({ ...t });
globalThis.chrome = {
  runtime: { getURL: (path) => `safari-web-extension://test/${path}`, getManifest: () => ({ content_scripts: [{ js: ['content/other.bundle.js'], world: 'MAIN' }, { js: ['content/content.bundle.js'] }] }) },
  permissions: { contains: async () => { fake.calls.contains++; return fake.access; }, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
  tabs: {
    sendMessage: async (tabId, message) => { fake.messages.push({ tabId, ...message }); },
    getZoom: async (id) => fake.zoom[id] ?? 1,
    setZoom: async (id, zoom) => { fake.zoom[id] = zoom; },
    get: async (id) => {
      fake.calls.get++;
      const tab = fake.tabs.get(id);
      if (!tab) throw new Error(`No tab with id: ${id}`);
      return asTab(tab);
    },
    query: async ({ active, windowId } = {}) => [...fake.tabs.values()].filter((t) => (active == null || t.active === active) && (windowId == null || t.windowId === windowId)).map(asTab),
    update: async (id) => {
      const tab = fake.tabs.get(id);
      if (!tab) throw new Error(`No tab with id: ${id}`);
      for (const t of fake.tabs.values()) if (t.windowId === tab.windowId) t.active = t.id === id;
      return asTab(tab);
    },
    remove: async (ids) => {
      const list = [].concat(ids);
      fake.removed.push(list);
      for (const id of list) fake.tabs.delete(id);
    },
    goBack: async (id) => { fake.history.push(['back', id]); },
    goForward: async (id) => { fake.history.push(['forward', id]); },
    reload: async (id) => { fake.history.push(['reload', id]); },
    create: async ({ windowId, url, active }) => {
      const tab = { id: fake.nextId++, windowId, url, active: !!active, index: 99, title: '' };
      if (active) for (const t of fake.tabs.values()) if (t.windowId === windowId) t.active = false;
      fake.tabs.set(tab.id, tab);
      fake.calls.create.push(url);
      return asTab(tab);
    },
  },
  windows: { get: async (id) => ({ id, focused: true }), update: async () => ({}) },
  scripting: {
    executeScript: ({ target, func, files }) => {
      if (files) {
        fake.injected.push({ tabId: target.tabId, files });
        fake.current.add(target.tabId);
        return Promise.resolve([]);
      }
      // ensureCurrent's question: is Margin's current copy there? (Not the
      // wake's, which asks the copy there something else.)
      if (func?.name !== 'pageThere' && String(func).includes('Margin?.content')) {
        fake.probes++;
        if (fake.probeHangs) return new Promise(() => {});
        return sleep(2).then(() => [{ result: fake.current.has(target.tabId) }]);
      }
      return sleep(2).then(() => [{ result: true }]);
    },
  },
  storage: {
    local: {
      get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in fake.local).map((k) => [k, fake.local[k]])),
      set: async (items) => { Object.assign(fake.local, items); },
    },
  },
};

const M = await import('../extension/state/model.js');
const V = await import('../extension/shared/view.js');
const { mutate, load } = await import('../extension/background/store.js');
const { showSpace, navigate } = await import('../extension/background/navigation.js');
const { ensureCurrent, forgetCurrent, injectIntoOpenTabs } = await import('../extension/background/tabs.js');
// Tabs these tests didn't prove to have WebKit's mark count as having it, as
// every tab did before it was tracked (background/tabs.js; its own tests:
// tests/in-window.test.js).

// Window 1: Personal tabs 1 (in front), 2; Work tabs 3, 4 (4 used last); window 2: Work tab 5.
async function setup() {
  fake.tabs = new Map();
  fake.calls = { get: 0, contains: 0, create: [] };
  const tabs = [
    { id: 1, windowId: 1, url: 'https://p1.com/', active: true, index: 0 },
    { id: 2, windowId: 1, url: 'https://p2.com/', active: false, index: 1 },
    { id: 3, windowId: 1, url: 'https://w3.com/', active: false, index: 2 },
    { id: 4, windowId: 1, url: 'https://w4.com/', active: false, index: 3 },
    { id: 5, windowId: 2, url: 'https://w5.com/', active: true, index: 0 },
  ];
  for (const t of tabs) fake.tabs.set(t.id, { title: '', ...t });
  await mutate(() => {
    let s = M.defaultState();
    s = M.createSpace(s, { id: 'work', name: 'Work', emoji: '💼', color: '#0984e3' });
    s = M.createSpace(s, { id: 'empty', name: 'Empty', emoji: '🫙', color: '#00b894' });
    for (const t of tabs) s = M.upsertTab(s, t, 0);
    s = M.moveTab(M.moveTab(M.moveTab(s, 3, 'work'), 4, 'work'), 5, 'work');
    s = { ...s, tabs: { ...s.tabs, 3: { ...s.tabs[3], lastActive: 10 }, 4: { ...s.tabs[4], lastActive: 20 }, 5: { ...s.tabs[5], lastActive: 99 } } };
    return s;
  });
}
const front = (windowId = 1) => [...fake.tabs.values()].find((t) => t.windowId === windowId && t.active)?.id;

test('showSpace: the space\'s most recent tab in that window comes to the front', async () => {
  await setup();
  await showSpace(1, 'work');
  assert.equal(V.activeSpaceId(await load(), 1), 'work');
  assert.equal(front(1), 4, 'tab 4, used last in window 1 (not tab 5 of window 2)');
  assert.equal(front(2), 5, 'the other window untouched');
});

test('showSpace: a tab of the space already in front stays; bringTab: false changes only the sidebar', async () => {
  await setup();
  await showSpace(1, 'personal');
  assert.equal(front(1), 1);
  await showSpace(1, 'work', { bringTab: false });
  assert.equal(V.activeSpaceId(await load(), 1), 'work');
  assert.equal(front(1), 1, 'the page in front stayed');
});

test('showSpace: a tab closed meanwhile: the next most recent one', async () => {
  await setup();
  fake.tabs.delete(4); // Margin's state still lists it
  await showSpace(1, 'work');
  assert.equal(front(1), 3);
});

test('showSpace: an empty space opens the start page in it; an untouched start page in front moves instead', async () => {
  await setup();
  await showSpace(1, 'empty');
  assert.deepEqual(fake.calls.create, ['safari-web-extension://test/newtab/newtab.html#launcher']);
  const opened = front(1);
  assert.equal((await load()).tabSpace[opened], 'empty');
  await mutate((s) => M.upsertTab(s, fake.tabs.get(opened), 0));
  await mutate((s) => M.createSpace(s, { id: 'empty2', name: 'Empty 2', emoji: '📭', color: '#636e72' }));
  await showSpace(1, 'empty2');
  assert.equal(fake.calls.create.length, 1, 'no second start page');
  assert.equal((await load()).tabSpace[opened], 'empty2', 'the untouched one moved');
});

test('showSpace: a space with only tabs that aren\'t open (kept): its top one opens, not a new tab (Tirth, 2026-11-08)', async () => {
  await setup();
  // Work's two tabs in window 1 closed and kept (put to sleep), tab 5 (window 2) left out of it.
  await mutate((s) => M.keepTab(M.keepTab(s, 3, 'sleep'), 4, 'sleep'));
  fake.tabs.delete(3); fake.tabs.delete(4);
  const kept = Object.values((await load()).keptTabs).filter((k) => k.spaceId === 'work');
  assert.equal(kept.length, 2);
  const view = V.sidebar(await mutate((s) => M.setActiveSpace(s, 1, 'work')), 1);
  const top = view.tabs.find((t) => t.kept);
  await mutate((s) => M.setActiveSpace(s, 1, 'personal'));
  const result = await showSpace(1, 'work');
  assert.deepEqual(fake.calls.create, [top.url], 'the top kept tab\'s address, no start page');
  assert.equal((await load()).tabSpace[front(1)], 'work');
  assert.equal(result?.tab?.id, front(1));
  assert.ok(!(await load()).keptTabs[top.id], 'that Margin tab is the open one now');
});

test('showSpace: the space\'s tab comes to the front without waiting for the space to be written', async () => {
  await setup();
  // Storage takes no write until released.
  const set = chrome.storage.local.set;
  let release = () => {};
  const held = new Promise((resolve) => { release = resolve; });
  chrome.storage.local.set = async (items) => {
    await held;
    Object.assign(fake.local, items);
  };
  let switching;
  try {
    switching = showSpace(1, 'work');
    const until = Date.now() + 2000;
    while (front(1) !== 4 && Date.now() < until) await sleep(5);
    assert.equal(front(1), 4, 'tab 4 in front while storage still holds every write');
  } finally {
    release();
    chrome.storage.local.set = set;
  }
  await switching;
  assert.equal(V.activeSpaceId(await load(), 1), 'work');
});

test('showSpace (Safari): the space is written with the next write (its tab\'s activation), not on its own before the switch', async () => {
  await setup();
  const stored = () => fake.local.openTabs?.activeSpaceByWindow?.[1] ?? null;
  const before = stored();
  await showSpace(1, 'work');
  assert.equal(front(1), 4);
  assert.equal(V.activeSpaceId(await load(), 1), 'work', 'in the state at once');
  assert.equal(stored(), before, 'not written on its own before the switch');
  // The activation (background.js) writes the open tabs: the space goes with it.
  await mutate((st) => M.activateTab(st, 4, 1, Date.now()));
  assert.equal(stored(), 'work');
  // With no other write, within 2 s.
  await showSpace(1, 'personal');
  assert.equal(front(1), 1);
  assert.equal(stored(), 'work');
  await sleep(2100);
  assert.equal(stored(), 'personal');
});

test('showSpace: only the sidebar\'s space, a tab of the space already in front, or no such space: written before it returns', async () => {
  await setup();
  const stored = () => fake.local.openTabs?.activeSpaceByWindow?.[1] ?? null;
  await showSpace(1, 'work', { bringTab: false });
  assert.equal(stored(), 'work');
  assert.equal(front(1), 1);
  await showSpace(1, 'personal');
  assert.equal(stored(), 'personal');
  assert.equal(front(1), 1);
  await showSpace(1, 'nowhere');
  assert.equal(stored(), 'personal');
  assert.equal(front(1), 1);
});

// Storage takes no write until released; a write is under way (any change),
// and `change` is queued behind it before the space is shown.
async function showBehindHeldWrite(spaceId, change) {
  const set = chrome.storage.local.set;
  let release = () => {};
  const held = new Promise((resolve) => { release = resolve; });
  chrome.storage.local.set = async (items) => {
    await held;
    Object.assign(fake.local, items);
  };
  try {
    void mutate((s) => M.updateSpace(s, 'empty', { name: 'Empty 2' }));
    void mutate(change);
    const switching = showSpace(1, spaceId);
    await sleep(30);
    release();
    chrome.storage.local.set = set;
    await switching;
  } finally {
    release();
    chrome.storage.local.set = set;
  }
}

test('showSpace: a change queued behind a write under way is seen: the tab used last comes to the front', async () => {
  await setup();
  await showBehindHeldWrite('work', (s) => ({ ...s, tabs: { ...s.tabs, 3: { ...s.tabs[3], lastActive: 1000 } } }));
  assert.equal(front(1), 3, 'tab 3, used last in Work (not tab 4, last in the cache before the change)');
  assert.equal(V.activeSpaceId(await load(), 1), 'work');
});

test('showSpace: the tab in front moved to the space behind a write under way stays in front', async () => {
  await setup();
  await showBehindHeldWrite('work', (s) => M.moveTab(s, 1, 'work'));
  assert.equal(front(1), 1, 'tab 1, now in Work, stays');
  assert.equal(V.activeSpaceId(await load(), 1), 'work');
});

test('pins: only a tab of the pin\'s own space is the pin\'s (no jump to another space)', async () => {
  await setup();
  let s = await load();
  s = M.addPin(s, { id: 'p', spaceId: 'work', url: 'https://p1.com/', title: 'p1' });
  assert.equal(V.pinTabId(s, 'p', 1), null, 'p1.com is open only in Personal');
  assert.equal(M.recentTabOfSpace(s, 1, 'work')?.id, 4);
  assert.equal(M.recentTabOfSpace(s, 1, 'work', 4)?.id, 3);
  assert.equal(M.recentTabOfSpace(s, 1, 'empty'), null);
});

test('ensureCurrent: a tab without the current copy gets it once; one that has it, nothing; once per run, again after it closes', async () => {
  await setup();
  fake.current = new Set([1]);
  fake.injected = [];
  fake.probes = 0;
  await ensureCurrent(1);
  assert.deepEqual(fake.injected, [], 'it has the current copy');
  await Promise.all([ensureCurrent(2), ensureCurrent(2)]); // two activations at once
  assert.deepEqual(fake.injected, [{ tabId: 2, files: ['content/content.bundle.js'] }], 'the sidebar\'s scripts (not the page-world one), once');
  const probes = fake.probes;
  await ensureCurrent(2);
  await ensureCurrent(1);
  assert.equal(fake.probes, probes, 'checked once per run');
  forgetCurrent(2); // closed
  fake.current.delete(2);
  await ensureCurrent(2);
  assert.equal(fake.injected.length, 2, 'checked again');
});

test('ensureCurrent: a page that doesn\'t answer (busy, asleep) isn\'t injected, and is checked again next time', async () => {
  await setup();
  fake.current = new Set();
  fake.injected = [];
  fake.probeHangs = true;
  await ensureCurrent(3);
  assert.deepEqual(fake.injected, []);
  fake.probeHangs = false;
  await ensureCurrent(3);
  assert.equal(fake.injected.length, 1, 'next time it answered: injected');
});

test('install repair: gives open pages this copy at once and never reinjects a current page', async () => {
  await setup();
  fake.tabs.set(6, { id: 6, windowId: 1, url: 'safari://startpage/', active: false, index: 6 });
  for (const id of fake.tabs.keys()) forgetCurrent(id);
  fake.current = new Set([1]);
  fake.injected = [];
  await injectIntoOpenTabs({ retry: false });
  assert.deepEqual(fake.injected.map((x) => x.tabId).sort(), [2, 3, 4, 5], 'not the current copy\'s page, not a browser page');
});

test('next/previous: each press a plain switch, chained from the one before; the page is told it\'s switching, then done or failed', async () => {
  await setup();
  await showSpace(1, 'personal');
  fake.messages = [];
  navigate('next-tab', 'key', 1);
  await navigate('next-tab', 'key', 1); // pressed while the first waits: tab 1 → 2 → back to 1
  await sleep(10);
  const switching = fake.messages.filter((m) => m.type === 'switching');
  assert.deepEqual(switching.map((m) => [m.from, m.tabId]), [[1, 2], [2, 1]]);
  assert.deepEqual(fake.messages.filter((m) => m.type === 'switch-done').map((m) => [m.from, m.tabId]), [[1, 2], [2, 1]], 'each page told it landed');
  fake.messages = [];
  fake.tabs.delete(2); // closed, Margin's state still lists it
  await navigate('next-tab', 'key', 1);
  await sleep(10);
  assert.deepEqual(fake.messages.map((m) => [m.type, m.from, m.tabId]), [['switching', 1, 2], ['switch-failed', 1, 2]]);
});

test('next/previous from Margin.app\'s overlay: its own pick taken (it highlighted it at the press); one not open in that window, worked out here', async () => {
  await setup();
  await showSpace(1, 'personal');
  await sleep(1600); // (no chain from an earlier press)
  fake.messages = [];
  // The overlay's pick (tab 3, where the rule here would say 2): taken, with its switch id.
  await navigate('next-tab', 'app', 1, { target: 3, switchId: 'ov-7' });
  await sleep(10);
  assert.deepEqual(fake.messages.filter((m) => m.type === 'switching').map((m) => [m.tabId, m.switchId]), [[3, 'ov-7']]);
  assert.equal(front(), 3);
  await showSpace(1, 'personal');
  await sleep(1600);
  fake.messages = [];
  // A pick that isn't a tab of that window: worked out here, as for any press.
  await navigate('next-tab', 'app', 1, { target: 999, switchId: 'ov-8' });
  await sleep(10);
  assert.deepEqual(fake.messages.filter((m) => m.type === 'switching').map((m) => m.tabId), [2]);
  assert.notEqual(fake.messages.find((m) => m.type === 'switching')?.switchId, 'ov-8', 'nor its switch id');
});

test('page zoom: remembered per site (only away from the default), capped, so its pages draw Margin at its size at once', async () => {
  const { handlers, zoomChanged } = await import('../extension/background/handlers.js');
  const at = (url) => ({ tab: { id: 1, url }, url });
  const zooms = () => Object.fromEntries(Object.entries(fake.local.pageZoom ?? {}).map(([k, v]) => [k, v[0]]));
  fake.zoom[1] = 1.5;
  assert.equal(await handlers.getZoom({}, at('https://p1.com/a')), 1.5);
  await sleep(10);
  assert.deepEqual(zooms(), { 'https://p1.com': 1.5 });
  fake.zoom[1] = 1;
  await handlers.getZoom({}, at('https://p1.com/a'));
  await sleep(10);
  assert.deepEqual(zooms(), {}, 'back to 100%: forgotten');
  // A default zoom (Chrome's setting): kept once, not per site.
  chrome.tabs.getZoomSettings = async () => ({ defaultZoomFactor: 1.1 });
  zoomChanged(); // (the browser's tabs.onZoomChange, background.js)
  fake.zoom[1] = 1.1;
  for (const n of [1, 2, 3]) await handlers.getZoom({}, at(`https://site${n}.com/`));
  await sleep(10);
  assert.deepEqual(zooms(), { '*': 1.1 });
  delete chrome.tabs.getZoomSettings;
  zoomChanged();
  // At most 150 sites, the oldest changes dropped.
  for (let n = 0; n < 160; n++) {
    fake.zoom[1] = 1.5;
    await handlers.getZoom({}, at(`https://z${n}.com/`));
    await sleep(1);
  }
  await sleep(20);
  const kept = Object.keys(zooms()).filter((k) => k !== '*');
  assert.equal(kept.length, 150);
  assert.ok(!kept.includes('https://z0.com') && kept.includes('https://z159.com'));
});

test('page zoom: an unchanged zoom is answered without reading storage or the zoom settings again, until a zoom or `pageZoom` changes', async () => {
  const { handlers, zoomChanged, zoomStored } = await import('../extension/background/handlers.js');
  const at = (url) => ({ tab: { id: 7, url }, url });
  const get = chrome.storage.local.get;
  const reads = { pageZoom: 0, settings: 0 };
  chrome.storage.local.get = async (keys) => {
    if ([].concat(keys).includes('pageZoom')) reads.pageZoom++;
    return get(keys);
  };
  chrome.tabs.getZoomSettings = async () => {
    reads.settings++;
    return { defaultZoomFactor: 1 };
  };
  try {
    zoomStored();
    zoomChanged();
    fake.zoom[7] = 1.25;
    for (let n = 0; n < 5; n++) await handlers.getZoom({}, at('https://cached.com/a'));
    await sleep(10);
    assert.equal(fake.local.pageZoom['https://cached.com'][0], 1.25, 'written once it changed');
    const afterWrite = { ...reads };
    for (let n = 0; n < 5; n++) await handlers.getZoom({}, at('https://cached.com/b'));
    await sleep(10);
    assert.deepEqual(reads, afterWrite, 'the same zoom again: no reads');
    assert.ok(afterWrite.pageZoom <= 3 && afterWrite.settings === 1, `read before the write, again for it, and once after it (${JSON.stringify(afterWrite)})`);
    // `pageZoom` cleared here (its storage event, background.js): the next
    // ask reads it again, and writes what's right.
    fake.local.pageZoom = {};
    zoomStored();
    await handlers.getZoom({}, at('https://cached.com/c'));
    await sleep(10);
    assert.equal(fake.local.pageZoom['https://cached.com'][0], 1.25);
    // Another copy of Margin wrote a site (its storage event never reaches
    // this one) while this one kept what it read: a write here is built from
    // what's stored now.
    await handlers.getZoom({}, at('https://cached.com/d'));
    await sleep(10);
    fake.local.pageZoom = { ...fake.local.pageZoom, 'https://other.com': [1.5, Date.now()] };
    fake.zoom[7] = 1.1;
    await handlers.getZoom({}, at('https://third.com/'));
    await sleep(10);
    assert.deepEqual(Object.keys(fake.local.pageZoom).sort(), ['https://cached.com', 'https://other.com', 'https://third.com'], 'the other copy\'s site kept');
    // The browser's default zoom changed (tabs.onZoomChange): its settings asked again.
    zoomChanged();
    await handlers.getZoom({}, at('https://cached.com/e'));
    await sleep(10);
    assert.equal(reads.settings, 2);
  } finally {
    chrome.storage.local.get = get;
    delete chrome.tabs.getZoomSettings;
    zoomChanged();
  }
});

test('a window reopened after the ids changed takes its old tabs\' spaces once its tabs stop arriving (background/restore.js)', async () => {
  const restore = await import('../extension/background/restore.js');
  await setup();
  // Old tabs waiting: a Work window with a.com and b.com.
  // (Margin tabs kept, not open, lost with that window.)
  const from = { key: 'k', at: Date.now(), size: 2, windowId: 77 };
  await mutate((s) => ({ ...s, keptTabs: {
    't-a': { id: 't-a', url: 'https://a.com/', title: 'A', favIconUrl: '', spaceId: 'work', order: 0, lastActive: 1, keptAt: from.at, why: 'window', from: { ...from, index: 0 } },
    't-b': { id: 't-b', url: 'https://b.com/', title: 'B', favIconUrl: '', spaceId: 'work', order: 1, lastActive: 2, keptAt: from.at, why: 'window', from: { ...from, index: 1 } },
  } }));
  for (const [id, url, index] of [[300, 'https://a.com/', 0], [301, 'https://b.com/', 1]]) {
    const t = { id, windowId: 30, url, index, active: index === 1, title: '' };
    await mutate((s) => {
      restore.tabCreated(s, t);
      return M.upsertTab(s, t, Date.now());
    });
  }
  assert.equal((await load()).tabSpace[300], 'personal', 'meanwhile: the window\'s space');
  await sleep(1700);
  const s = await load();
  assert.deepEqual([s.tabSpace[300], s.tabSpace[301]], ['work', 'work']);
  assert.equal(V.activeSpaceId(s, 30), 'work');
  assert.deepEqual(s.keptTabs, {}, 'taken back');
  assert.deepEqual([s.tabs[300].mid, s.tabs[301].mid], ['t-a', 't-b'], 'open again as the same Margin tabs');
});

test('restore: a new-tab page opened in a window never counts as a tab coming back', async () => {
  const restore = await import('../extension/background/restore.js');
  await setup();
  await mutate((s) => ({ ...s, keptTabs: { 't-a': { id: 't-a', url: 'https://a.com/', title: 'A', favIconUrl: '', spaceId: 'work', order: 0, lastActive: 1, keptAt: Date.now(), why: 'window', from: { key: 'k', at: Date.now(), size: 1, index: 0, windowId: 77 } } } }));
  const t = { id: 400, windowId: 40, url: 'safari-web-extension://test/newtab/newtab.html', index: 0, active: true, title: '' };
  await mutate((s) => {
    restore.tabCreated(s, t);
    return M.upsertTab(s, t, Date.now());
  });
  await mutate((s) => M.upsertTab(s, { ...t, url: 'https://a.com/' }, Date.now())); // then typed a.com
  restore.tabChanged({ ...t, url: 'https://a.com/' });
  await sleep(1700);
  assert.equal((await load()).tabSpace[400], 'personal');
});

// The runtime's today.clear (ui/actions.js): the canvas designs' Clear.
test('clearToday: the window\'s space\'s tabs no pin shows close, archived; the tab in front gives way to the space\'s pinned tab first', async () => {
  await setup();
  fake.removed = [];
  await mutate((s) => M.addPin(s, { id: 'pp', spaceId: 'personal', url: 'https://p2.com/', title: 'P2' }));
  const { handlers } = await import('../extension/background/handlers.js');
  assert.deepEqual(await handlers.clearToday({ windowId: 1 }, {}), [1], 'tab 2 is the pin\'s');
  assert.equal(front(1), 2, 'the space\'s pinned tab came to the front first');
  assert.deepEqual(fake.removed, [[1]]);
  assert.deepEqual([...fake.tabs.keys()].sort(), [2, 3, 4, 5], 'other spaces and windows untouched');
  assert.equal((await load()).archive[0].url, 'https://p1.com/', 'archived, as closing one is');
  await mutate((s) => M.removeTab(s, 1)); // the browser's onRemoved, as background.js handles it
  assert.deepEqual(await handlers.clearToday({ windowId: 1 }, {}), [], 'nothing left to clear');
  assert.deepEqual(fake.removed, [[1]]);
});

test('clearToday: nothing of the space left open: its start page opens in it first, so the window stays in the space', async () => {
  await setup();
  fake.removed = [];
  await showSpace(1, 'work');
  assert.equal(front(1), 4);
  const { handlers } = await import('../extension/background/handlers.js');
  const closed = await handlers.clearToday({}, { tab: { id: 4, windowId: 1 } });
  assert.deepEqual(closed.sort(), [3, 4], 'the window from the page that asked');
  assert.deepEqual(fake.calls.create, ['safari-web-extension://test/newtab/newtab.html#launcher']);
  const opened = front(1);
  assert.equal((await load()).tabSpace[opened], 'work');
  assert.ok(fake.tabs.has(5), 'Work\'s tab in window 2 stays');
});

test('goBack, goForward, reload: the tab in front of the window (the app\'s nav buttons)', async () => {
  await setup();
  fake.history = [];
  const { handlers } = await import('../extension/background/handlers.js');
  assert.equal(await handlers.goBack({ windowId: 1 }, {}), true);
  assert.equal(await handlers.goForward({ windowId: 2 }, {}), true);
  assert.equal(await handlers.reload({ tabId: 2 }, {}), true);
  assert.equal(await handlers.goBack({}, { tab: { id: 4, windowId: 1 } }), true, 'a page\'s own window');
  assert.deepEqual(fake.history, [['back', 1], ['forward', 5], ['reload', 2], ['back', 1]]);
  assert.equal(await handlers.goBack({}, {}), false, 'no window, no tab');
});

test('updateThemeSettings: a package theme\'s settings (built in, or imported), plain values only', async () => {
  await setup();
  const { handlers } = await import('../extension/background/handlers.js');
  await handlers.updateThemeSettings({ themeId: 'neo-brutalism', patch: { sidebarWidth: '300px', evil: { url: 'x' }, 'Bad Name': 1, long: 'x'.repeat(200) } });
  assert.deepEqual((await load()).settings.themes['neo-brutalism'], { sidebarWidth: '300px' });
  await handlers.updateThemeSettings({ themeId: 'neo-brutalism', patch: { dots: true } });
  assert.deepEqual((await load()).settings.themes['neo-brutalism'], { sidebarWidth: '300px', dots: true }, 'merged');
  await handlers.updateThemeSettings({ themeId: 'nope', patch: { a: 1 } });
  assert.equal((await load()).settings.themes.nope, undefined, 'not a theme Margin has');
  fake.local.userThemes = [{ id: 'mine', name: 'Mine', version: '1.0.0' }];
  await handlers.updateThemeSettings({ themeId: 'mine', patch: { accent: '#ff0000' } });
  assert.deepEqual((await load()).settings.themes.mine, { accent: '#ff0000' }, 'an imported theme');
  delete fake.local.userThemes;
  await handlers.updateThemeSettings({ themeId: 'arcadia', patch: { sidebarWidth: 333 } });
  assert.equal((await load()).settings.themes.arcadia.sidebarWidth, 330, 'Arcadia\'s own, as before (snapped)');
});

test('userThemes: Margin.app\'s index of imported themes kept (ids checked, built-ins\' left out); updateSettings then takes a listed id', async () => {
  await setup();
  const { handlers } = await import('../extension/background/handlers.js');
  await handlers.updateSettings({ patch: { theme: 'mine' } });
  assert.notEqual((await load()).settings.theme, 'mine', 'not listed yet: refused');
  assert.equal(await handlers.userThemes({ list: 'evil' }), false);
  assert.equal(await handlers.userThemes({ list: [{ id: 'mine', name: 'Mine', version: '1.0.0', author: 'Me', bytes: 9, html: '<x>' }, { id: 'arcadia', name: 'Fake' }, { id: '../evil' }, null] }), true);
  assert.deepEqual(fake.local.userThemes, [{ id: 'mine', name: 'Mine', version: '1.0.0', author: 'Me' }], 'only the index\'s fields, never a package');
  await handlers.updateSettings({ patch: { theme: 'mine' } });
  assert.equal((await load()).settings.theme, 'mine');
  await handlers.userThemes({ list: [] });
  await handlers.updateSettings({ patch: { theme: 'mine' } });
  await handlers.updateSettings({ patch: { theme: 'arcadia' } });
  assert.equal((await load()).settings.theme, 'arcadia');
  delete fake.local.userThemes;
});

// (Last: this copy is stale from here on.)
test('showSpace (Safari): a copy a newer one replaced, its last check over a second ago, fails as stale before it switches anything (its write waits, and wouldn\'t ask until then)', async () => {
  await setup();
  await sleep(1100);
  const owner = fake.local.owner;
  fake.local.owner = { origin: 'safari-web-extension://newer/', since: (owner?.since ?? 0) + 1000 };
  const { StaleError } = await import('../extension/background/store.js');
  await assert.rejects(showSpace(1, 'work'), StaleError);
  assert.equal(front(1), 1, 'nothing brought');
  assert.equal(V.activeSpaceId(await load(), 1), 'personal');
});
