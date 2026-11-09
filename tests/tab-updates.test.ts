// background/tab-updates.ts: a hidden tab's changes are gathered into one
// write of the state, its title alone written at most every 2 s; the tab in
// front, and a hidden tab's new address, at once; and any write before then
// takes them along, in order (background/store.ts mutate `within`). Against a
// fake storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Until `ready()`, at most `ms`: a busy machine fires timers late, so a write
// that's due is waited for, not timed. (A check that nothing's written yet
// can only pass more often then.)
const until = async (ready, ms = 1500) => {
  const end = Date.now() + ms;
  while (!ready() && Date.now() < end) await sleep(10);
};
const local = {};
const sets = [];
let failNext = false;
globalThis.chrome = ({
  runtime: { getURL: (path) => `safari-web-extension://test/${path}` },
  storage: {
    local: {
      get: async (keys) => (keys == null ? { ...local } : Object.fromEntries([].concat(keys).filter((k) => k in local).map((k) => [k, structuredClone(local[k])]))),
      set: async (items) => {
        sets.push(structuredClone(items));
        if (failNext) {
          failNext = false;
          throw new Error('busy');
        }
        Object.assign(local, structuredClone(items));
      },
      remove: async () => {},
    },
    session: { get: async () => ({}), set: async () => {} },
  },
} as any);
const { decided, load, mutate } = await import('../extension/background/store.ts');
const { GATHER_MS, TITLE_EVERY_MS, tabGone, tabUpdated } = await import('../extension/background/tab-updates.ts');
const M = await import('../extension/state/model.ts');

await decided();
await load();
// Tab 1 in front, 2 to 5 behind, in window 1.
const tab = (id, more = {}) => ({ id, windowId: 1, index: id, url: `https://t${id}.test/`, title: `T${id}`, active: false, ...more });
await mutate((s) => M.activateTab([tab(1), tab(2), tab(3), tab(4), tab(5)].reduce((state, t) => M.upsertTab(state, t, 1), s), 1, 1, 1));
const writes = () => sets.filter((set) => 'openTabs' in set);
const stored = (id) => local.openTabs.tabs[id];
const settle = () => sleep(GATHER_MS + 60);
const reset = async () => {
  await settle();
  sets.length = 0;
};

test('a hidden tab\'s changes: gathered into one write GATHER_MS later; the state has each at once', async () => {
  await reset();
  for (let i = 1; i <= 5; i++) {
    await tabUpdated(2, { title: `chat (${i})` }, tab(2, { title: `chat (${i})` }));
    await sleep(30);
  }
  assert.equal((await load()).tabs[2].title, 'chat (5)', 'in the state at once');
  assert.equal(writes().length, 0, 'not written yet');
  assert.equal(stored(2).title, 'T2');
  await until(() => writes().length);
  assert.equal(writes().length, 1, 'one write');
  assert.equal(stored(2).title, 'chat (5)');
  // Its page's icon, and its load: one write.
  sets.length = 0;
  const icon = { favIconUrl: 'https://t2.test/f.png', title: 'chat (5)' };
  await tabUpdated(2, { favIconUrl: icon.favIconUrl }, tab(2, icon));
  await tabUpdated(2, { status: 'complete' }, tab(2, icon));
  assert.equal(writes().length, 0, 'not written yet');
  await until(() => writes().length);
  await settle();
  assert.equal(writes().length, 1);
  assert.equal(stored(2).favIconUrl, icon.favIconUrl);
});

// After a restart or an update (new ids) tabs are matched to their records by
// address (model.ts matchTabs): one that waited, lost with the background
// stopping, would leave its tab unmatched, in the window's active space.
test('a hidden tab\'s new address: written at once, also when it comes only with the load; a new fragment waits', async () => {
  await reset();
  const more = { title: 'T5' };
  await tabUpdated(5, { status: 'loading', url: 'https://t5.test/next' }, tab(5, { ...more, url: 'https://t5.test/next' }));
  assert.equal(writes().length, 1, 'at once');
  assert.equal(stored(5).url, 'https://t5.test/next');
  await tabUpdated(5, { status: 'complete' }, tab(5, { ...more, url: 'https://t5.test/redirected' }));
  assert.equal(writes().length, 2, 'Safari giving it only with the load (a redirect): at once');
  assert.equal(stored(5).url, 'https://t5.test/redirected');
  // The same page (matchTabs ignores the fragment): it waits.
  await tabUpdated(5, { url: 'https://t5.test/redirected#inbox' }, tab(5, { ...more, url: 'https://t5.test/redirected#inbox' }));
  assert.equal(writes().length, 2, 'not written yet');
  await until(() => writes().length > 2);
  assert.equal(writes().length, 3);
  assert.equal(stored(5).url, 'https://t5.test/redirected#inbox');
});

test('a hidden tab\'s title alone: written at most every TITLE_EVERY_MS; another tab\'s isn\'t held back by it', async () => {
  await sleep(TITLE_EVERY_MS); // tab 2's last title write well past
  sets.length = 0;
  const start = Date.now();
  await tabUpdated(2, { title: 'a' }, tab(2, { title: 'a' }));
  await until(() => stored(2).title === 'a');
  assert.equal(stored(2).title, 'a', 'the first: GATHER_MS later');
  const first = Date.now();
  await tabUpdated(2, { title: 'b' }, tab(2, { title: 'b' }));
  await tabUpdated(3, { title: 'other' }, tab(3, { title: 'other' }));
  await until(() => stored(3).title === 'other');
  // Tab 3's own write (GATHER_MS) takes tab 2's along: that's free.
  assert.equal(stored(3).title, 'other');
  assert.equal(stored(2).title, 'b');
  sets.length = 0;
  await tabUpdated(2, { title: 'c' }, tab(2, { title: 'c' }));
  await sleep(GATHER_MS + 100);
  if (Date.now() < start + GATHER_MS + TITLE_EVERY_MS) assert.equal(writes().length, 0, `not again within ${TITLE_EVERY_MS} ms of the one before (${Date.now() - first} ms)`);
  await tabUpdated(2, { title: 'd' }, tab(2, { title: 'd' }));
  await until(() => writes().length, start + GATHER_MS + TITLE_EVERY_MS + 1000 - Date.now());
  assert.equal(writes().length, 1, 'then one write, with the last title');
  assert.ok(Date.now() >= start + TITLE_EVERY_MS, 'not before');
  assert.equal(stored(2).title, 'd');
});

// The waits are counted on a clock that only runs forward (performance.now):
// the Mac's clock set back (by hand, or synced after a sleep) mustn't hold a
// write back by as much, nor one set forward keep a later write waiting.
test('the Mac\'s clock set back or forward: a hidden tab\'s changes still written in time', async () => {
  await reset();
  const real = Date.now;
  try {
    await tabUpdated(4, { title: 'c1' }, tab(4, { title: 'c1' }));
    await until(() => stored(4).title === 'c1');
    assert.equal(stored(4).title, 'c1');
    Date.now = () => real() - 60_000;
    await tabUpdated(4, { title: 'c2' }, tab(4, { title: 'c2' }));
    await tabUpdated(4, { title: 'c3' }, tab(4, { title: 'c3' }));
    await until(() => stored(4).title === 'c3', GATHER_MS + TITLE_EVERY_MS + 1000);
    assert.equal(stored(4).title, 'c3', 'set back: within TITLE_EVERY_MS');
    Date.now = real;
    // A title waiting its 2 s, then the clock set forward, then another tab's
    // icon (GATHER_MS): both in that tab's write.
    await tabUpdated(4, { title: 'c4' }, tab(4, { title: 'c4' }));
    Date.now = () => real() + 60_000;
    const start = performance.now();
    await tabUpdated(3, { favIconUrl: 'https://t3.test/f.png' }, tab(3, { title: 'other', favIconUrl: 'https://t3.test/f.png' }));
    await until(() => stored(3).favIconUrl === 'https://t3.test/f.png');
    assert.ok(performance.now() - start < TITLE_EVERY_MS - GATHER_MS, `set forward: GATHER_MS, not the title's wait (${Math.round(performance.now() - start)} ms)`);
    assert.equal(stored(4).title, 'c4', 'taken along');
  } finally {
    Date.now = real;
  }
});

test('the tab in front, and a tab not known yet: written at once', async () => {
  await reset();
  await tabUpdated(1, { title: 'front' }, tab(1, { title: 'front', active: true }));
  assert.equal(writes().length, 1);
  assert.equal(stored(1).title, 'front');
  await tabUpdated(1, { status: 'complete' }, tab(1, { title: 'front', url: 'https://t1.test/done', active: true }));
  assert.equal(stored(1).url, 'https://t1.test/done', 'its page loaded: at once');
  // Safari saying active for a tab the state has behind (or the other way):
  // at once too.
  await tabUpdated(3, { title: 'just left' }, tab(3, { title: 'just left', active: true }));
  assert.equal(stored(3).title, 'just left');
  await tabUpdated(9, { url: 'https://new.test/' }, tab(9, { url: 'https://new.test/' }));
  assert.ok(stored(9), 'a tab not known yet');
  assert.equal(writes().length, 4);
  sets.length = 0;
  await tabUpdated(2, { status: 'loading' }, tab(2, { title: 'd', favIconUrl: 'https://t2.test/f.png' }));
  await settle();
  assert.equal(writes().length, 0, 'nothing the state keeps: nothing written');
});

test('a write before then (a switch) takes the waiting changes along, in order, and the timer writes nothing after', async () => {
  await reset();
  const later = { favIconUrl: 'https://t2.test/g.png', title: 'd' };
  await tabUpdated(2, { favIconUrl: later.favIconUrl }, tab(2, later));
  assert.equal(writes().length, 0);
  // The switch to it (background.ts activated): at once, with the icon.
  await mutate((s) => M.activateTab(s, 2, 1, Date.now()));
  assert.equal(writes().length, 1, 'one write');
  assert.equal(stored(2).favIconUrl, later.favIconUrl, 'the icon it waited with');
  assert.equal(stored(2).active, true);
  assert.equal(stored(1).active, false);
  await settle();
  assert.equal(writes().length, 1, 'nothing more');
  // Back to tab 1 for the tests after.
  await mutate((s) => M.activateTab(s, 1, 1, Date.now()));
});

test('a tab closed with a change waiting: gone from storage, not brought back by it', async () => {
  await reset();
  await tabUpdated(9, { title: 'closing' }, tab(9, { url: 'https://new.test/', title: 'closing' }));
  await mutate((s) => M.removeTab(s, 9));
  tabGone(9);
  assert.equal(stored(9), undefined);
  await settle();
  assert.equal(stored(9), undefined);
  assert.equal(writes().length, 1);
});

test('a change with nothing new doesn\'t write the waiting ones early', async () => {
  await reset();
  const icon = 'https://t3.test/b.png';
  await tabUpdated(3, { favIconUrl: icon }, tab(3, { title: 'just left', favIconUrl: icon }));
  await mutate((s) => s);
  await tabUpdated(1, { status: 'complete' }, tab(1, { title: 'front', url: 'https://t1.test/done', active: true })); // the same again
  assert.equal(writes().length, 0, 'still waiting');
  await until(() => writes().length);
  assert.equal(writes().length, 1);
  assert.equal(stored(3).favIconUrl, icon);
});
