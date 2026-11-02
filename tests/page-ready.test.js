// When a page loading is worth showing (shared/page-ready.js readyInPage),
// and the rendering update a switch waits for before a show
// (background/tabs.js paintBarrierInPage). Both run in the page through
// scripting.executeScript, which sends only their source: each is run here in
// a context of its own, with a fake page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

globalThis.chrome = { runtime: { getURL: (path) => `safari-web-extension://test/${path}`, getManifest: () => ({ version: '0' }) } };
const { readyInPage } = await import('../extension/shared/page-ready.js');
const { paintBarrierInPage } = await import('../extension/background/tabs.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A page loading: `readyState`, its paint entries, its listeners and
// observers, and what's in its <body>, in document order (`add`: an element
// or a text, `in` an element; each element laid out at `rect` [left, top,
// width, height] in a 1200 × 800 window, `visible` as checkVisibility has it).
function fakePage({ href = 'https://a.test/', readyState = 'loading' } = {}) {
  const listeners = new Map();
  const observers = new Set();
  const changes = new Set();
  const intervals = new Set();
  const paints = [];
  const nodes = [];
  const key = (where, type, capture) => `${where}:${type}${capture ? ':capture' : ''}`;
  const page = {
    location: { href },
    innerWidth: 1200,
    innerHeight: 800,
    Node: { TEXT_NODE: 3 },
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    document: {
      readyState,
      body: {},
      documentElement: {},
      // Over `nodes`, as a TreeWalker goes: a rejected node's own nodes left out with it.
      createTreeWalker: (root, what, filter) => {
        const rejected = new Set();
        let i = -1;
        return {
          nextNode() {
            while (++i < nodes.length) {
              const node = nodes[i];
              if ((node.parentElement && rejected.has(node.parentElement)) || filter.acceptNode(node) === 2) {
                rejected.add(node);
                continue;
              }
              return node;
            }
            return null;
          },
        };
      },
      addEventListener: (type, fn, capture) => listeners.set(key('document', type, capture), fn),
      removeEventListener: (type, fn, capture) => listeners.delete(key('document', type, capture)),
    },
    addEventListener: (type, fn) => listeners.set(key('window', type), fn),
    removeEventListener: (type) => listeners.delete(key('window', type)),
    performance: {
      now: () => Date.now(),
      getEntriesByType: (type) => (type === 'paint' ? paints : []),
    },
    PerformanceObserver: class {
      constructor(fn) { this.fn = fn; }
      observe() { observers.add(this); }
      disconnect() { observers.delete(this); }
    },
    MutationObserver: class {
      constructor(fn) { this.fn = fn; }
      observe() { changes.add(this); }
      disconnect() { changes.delete(this); }
    },
    setTimeout,
    clearTimeout,
    setInterval: (fn, ms) => { const id = setInterval(fn, ms); intervals.add(id); return id; },
    clearInterval: (id) => { intervals.delete(id); clearInterval(id); },
  };
  const element = (localName, { rect = [10, 10, 300, 20], visible = true, parent = null, ...more } = {}) => ({
    nodeType: 1,
    localName,
    parentElement: parent,
    getBoundingClientRect: () => ({ left: rect[0], top: rect[1], width: rect[2], height: rect[3], right: rect[0] + rect[2], bottom: rect[1] + rect[3] }),
    checkVisibility: () => visible,
    ...more,
  });
  return {
    context: vm.createContext(page),
    listening: () => listeners.size + observers.size + changes.size + intervals.size,
    state(next) {
      page.document.readyState = next;
      listeners.get('document:readystatechange')?.();
      if (next === 'complete') listeners.get('window:load')?.();
    },
    paint(name = 'first-contentful-paint') {
      paints.push({ name });
      for (const o of observers) o.fn();
    },
    // An element (`localName`, options as above) or, with `text`, a text in `parent`.
    add(localName, options = {}) {
      const node = localName === '#text' ? { nodeType: 3, data: options.data, parentElement: options.parent ?? null } : element(localName, options);
      nodes.push(node);
      for (const c of changes) c.fn([]);
      return node;
    },
  };
}
const ready = (page, ms) => vm.runInContext(`(${readyInPage})(${ms})`, page.context);
const answer = (page, ms) => {
  const result = { how: null };
  result.done = ready(page, ms).then((value) => { result.how = value; });
  return result;
};

test('readyInPage: painted once the document is parsed, its first contentful paint has come and something of its own is drawn in view, whichever comes last; then nothing left listening', async () => {
  const page = fakePage();
  const p = page.add('p');
  page.add('#text', { data: 'Hello', parent: p });
  const asked = answer(page, 2000);
  page.paint('first-paint'); // a background, nothing contentful
  page.paint();
  await sleep(20);
  assert.equal(asked.how, null, 'still parsing: a few lines of its head painted');
  page.state('interactive');
  await asked.done;
  assert.equal(asked.how, 'painted');
  assert.equal(page.listening(), 0);
  const parsed = fakePage({ readyState: 'interactive' });
  parsed.add('#text', { data: 'Hi', parent: parsed.add('h1') });
  const later = answer(parsed, 2000);
  await sleep(20);
  assert.equal(later.how, null, 'its content there, nothing contentful painted yet');
  parsed.paint();
  await later.done;
  assert.equal(later.how, 'painted');
});

test('readyInPage: a first contentful paint that is Margin\'s (its sidebar, the cover\'s spinner: outside <body>) with nothing of the page\'s own drawn is not painted; the page\'s own content, once drawn, is', async () => {
  const page = fakePage({ readyState: 'interactive' });
  page.paint(); // Margin's
  const asked = answer(page, 2000);
  await sleep(30);
  assert.equal(asked.how, null, 'an empty body: an app still building itself');
  page.add('#text', { data: '  \n ', parent: page.add('div') });
  const script = page.add('script');
  page.add('#text', { data: 'window.app = 1', parent: script });
  page.add('img', { complete: false, naturalWidth: 0 });
  page.add('#text', { data: 'below the window', parent: page.add('p', { rect: [10, 900, 300, 20] }) });
  page.add('#text', { data: 'not laid out', parent: page.add('p', { rect: [0, 0, 0, 0] }) });
  page.add('#text', { data: 'faded out', parent: page.add('p', { visible: false }) });
  page.add('div', { rect: [0, 0, 1200, 800] }); // a skeleton's grey box
  await sleep(150);
  assert.equal(asked.how, null, 'spaces, a script, an image still on its way, text out of view or hidden, empty boxes: nothing drawn of its own');
  page.add('#text', { data: 'Inbox', parent: page.add('h1') });
  await asked.done;
  assert.equal(asked.how, 'painted', 'looked at again as the page changed');
  assert.equal(page.listening(), 0);
  for (const [localName, options] of [['img', { complete: true, naturalWidth: 40 }], ['canvas', {}], ['svg', {}], ['video', {}]]) {
    const drawn = fakePage({ readyState: 'interactive' });
    drawn.paint();
    drawn.add(localName, options);
    assert.equal(await ready(drawn, 300), 'painted', localName);
  }
});

test('readyInPage: loaded on its load event, at once if it has; a timeout at the limit; the empty page a tab starts with is blank', async () => {
  const loading = fakePage();
  const answered = ready(loading, 2000);
  loading.state('complete');
  assert.equal(await answered, 'loaded');
  assert.equal(loading.listening(), 0);
  assert.equal(await ready(fakePage({ readyState: 'complete' }), 2000), 'loaded');
  const started = Date.now();
  const stuck = fakePage();
  assert.equal(await ready(stuck, 80), 'timeout');
  assert.ok(Date.now() - started >= 75);
  assert.equal(stuck.listening(), 0);
  const empty = fakePage({ readyState: 'interactive' });
  empty.paint();
  assert.equal(await ready(empty, 80), 'timeout', 'painted (Margin) but nothing of its own by the limit');
  assert.equal(empty.listening(), 0);
  assert.equal(await ready(fakePage({ href: 'about:blank' }), 2000), 'blank');
});

test('paintBarrierInPage: answers at the second rendering update (an observation of the page\'s root, then another started after that update: the first update\'s commit has gone out), adding nothing to the page and setting off no error there; at its limit otherwise', async () => {
  const observed = [];
  const skipped = [];
  let disconnected = 0;
  let delivering = false;
  const context = (deliverMs) => vm.createContext({
    document: { documentElement: { localName: 'html' } },
    setTimeout,
    clearTimeout,
    MessageChannel,
    ResizeObserver: class {
      constructor(fn) { this.fn = fn; }
      observe(target) {
        // One started while observers are being told, within the same update: the browser skips
        // it there and tells the page "ResizeObserver loop completed with undelivered
        // notifications." (an error event its own listeners get).
        if (delivering) skipped.push(target.localName);
        observed.push(target.localName);
        if (deliverMs != null) setTimeout(() => { delivering = true; try { this.fn([]); } finally { delivering = false; } }, deliverMs);
      }
      disconnect() { disconnected++; }
    },
  });
  const started = Date.now();
  assert.equal(await vm.runInContext(`(${paintBarrierInPage})(400)`, context(20)), 'drawn');
  const took = Date.now() - started;
  assert.ok(took >= 35 && took < 250, `two updates, ${took}ms`);
  assert.deepEqual(observed, ['html', 'html']);
  assert.deepEqual(skipped, [], 'the second observer started after the first update, not within it');
  assert.ok(disconnected >= 2, 'both observers let go');
  assert.equal(await vm.runInContext(`(${paintBarrierInPage})(50)`, context(null)), 'timeout');
  assert.equal(await vm.runInContext(`(${paintBarrierInPage})(50)`, vm.createContext({ document: { documentElement: {} }, setTimeout, clearTimeout })), 'none', 'no ResizeObserver');
});
