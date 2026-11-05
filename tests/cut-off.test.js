// background/cut-off.js: a page whose Margin world is still bound to a copy
// that's gone (Safari reloads Margin when it's updated or Margin.app opens,
// and keeps the world in open pages), told apart from one bound to this copy;
// whether it's in use; its dead Margin put out of sight; what's done with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { cutOffAction, cutOffInPage, oldOwnPageAddress } from '../extension/background/cut-off.js';

const OWN = 'safari-web-extension://NEW/';
const OLD = 'safari-web-extension://OLD/';

// Just what cutOffInPage looks at: Margin's hosts and other children of
// <html>, fields (by the selector that finds them), the body's style.
function style(initial = {}) {
  const values = new Map(Object.entries(initial).map(([k, v]) => [k, [v, 'important']]));
  return {
    setProperty: (k, v, p = '') => values.set(k, [String(v), p]),
    removeProperty: (k) => values.delete(k),
    getPropertyValue: (k) => values.get(k)?.[0] ?? '',
    getPropertyPriority: (k) => values.get(k)?.[1] ?? '',
  };
}
function element(localName, extra = {}) {
  const attrs = new Map();
  return { localName, style: style(), setAttribute: (k, v) => attrs.set(k, v), getAttribute: (k) => attrs.get(k), ...extra };
}
// `storage`: what the world's storage.local.get does: 'dead' (never settles, as
// in a world whose copy is gone), 'fails', or 'answers' (a copy still running).
function page({ address = OLD, id = 'margin', fields = [], hidden = true, body = {}, throws = false, storage = 'dead' } = {}) {
  const hosts = [element('margin-sidebar-host'), element('margin-palette-host')];
  const other = element('main');
  const doc = {
    hidden,
    activeElement: null,
    documentElement: { children: [other, ...hosts] },
    body: element('body', { style: style(body) }),
    querySelectorAll: (selector) => (selector.startsWith('textarea, input') ? fields : []),
  };
  const runtime = { id, getURL: () => { if (throws) throw new Error('Extension context invalidated'); return address; } };
  const get = { dead: () => new Promise(() => {}), fails: () => Promise.reject(new Error('Extension context invalidated')), answers: async () => ({}) }[storage];
  return { doc, hosts, other, globals: { document: doc, navigator: {}, setTimeout, browser: { runtime, storage: { local: { get } } } } };
}
// cutOffInPage as executeScript runs it: its source alone, in a page's globals.
function run(p, quiet = false) {
  const context = vm.createContext({ ...p.globals });
  return vm.runInContext(`(${cutOffInPage.toString()})(${JSON.stringify(OWN)}, ${quiet})`, context);
}

test('cut off: a page whose world is this copy\'s isn\'t (and nothing in it is touched)', async () => {
  const p = page({ address: OWN });
  assert.deepEqual({ ...(await run(p, true)) }, { cutOff: false });
  assert.equal(p.hosts[0].style.getPropertyValue('display'), '');
});

test('cut off: the world bound to the copy that\'s gone, or to none, is', async () => {
  assert.deepEqual({ ...(await run(page())) }, { cutOff: true, busy: false, hidden: true, proven: false });
  assert.deepEqual({ ...(await run(page({ hidden: false }))) }, { cutOff: true, busy: false, hidden: false, proven: false }, 'in front');
  assert.equal((await run(page({ id: undefined }))).cutOff, true, 'no id: Chrome\'s copy that was reloaded');
  assert.equal((await run(page({ throws: true }))).cutOff, true, 'its address can\'t be had');
  assert.equal((await run(page({ storage: 'fails' }))).cutOff, true, 'its calls fail');
});

test('cut off: a world bound to another copy that still answers isn\'t (a copy Safari keeps running beside this one), and nothing in it is touched', async () => {
  const p = page({ storage: 'answers' });
  assert.deepEqual({ ...(await run(p, true)) }, { cutOff: false, otherCopy: true });
  assert.equal(p.hosts[0].style.getPropertyValue('display'), '', 'its sidebar left as that copy has it');
  const started = Date.now();
  assert.equal((await run(page())).cutOff, true);
  assert.ok(Date.now() - started < 1000, 'a dead world is waited for briefly');
});

test('cut off: something typed makes it busy (not loaded again)', async () => {
  assert.equal((await run(page({ fields: [{ value: '  ' }] }))).busy, false, 'only spaces');
  assert.equal((await run(page({ fields: [{ value: 'a draft' }] }))).busy, true);
  const playing = page();
  playing.globals.navigator = { mediaSession: { playbackState: 'playing' } };
  assert.equal((await run(playing)).busy, true, 'media playing');
});

test('cut off: quiet puts the dead Margin out of sight, and the page back from under its cover', async () => {
  const p = page({ body: { opacity: '0' } });
  await run(p);
  assert.equal(p.hosts[0].style.getPropertyValue('display'), '', 'only asked: nothing changed');
  await run(p, true);
  for (const host of p.hosts) {
    assert.equal(host.style.getPropertyValue('display'), 'none');
    assert.equal(host.style.getPropertyPriority('display'), 'important');
    assert.equal(host.style.getPropertyValue('pointer-events'), 'none');
    assert.equal(host.getAttribute('data-margin-off'), '', 'what the host\'s own styles respect');
  }
  assert.equal(p.other.style.getPropertyValue('display'), '', 'the page\'s own elements left alone');
  assert.equal(p.doc.body.style.getPropertyValue('opacity'), '', 'the old copy\'s arrival cover undone');
  const own = page();
  own.doc.body.style.setProperty('opacity', '0'); // the page's own (not !important)
  await run(own, true);
  assert.equal(own.doc.body.style.getPropertyValue('opacity'), '0', 'a page\'s own opacity kept');
});

test('cut off: what\'s done with a page', () => {
  assert.equal(cutOffAction(null), 'none', 'no answer');
  assert.equal(cutOffAction({ cutOff: false }), 'none');
  assert.equal(cutOffAction({ cutOff: true, busy: false, hidden: true }), 'reload');
  assert.equal(cutOffAction({ cutOff: true, busy: false, hidden: false }), 'reload', 'in front too: its Margin can\'t work until then');
  assert.equal(cutOffAction({ cutOff: true, busy: true, hidden: true }), 'quiet');
});

test("a tab on Margin's new-tab page from a copy that's gone is sent to this copy's, the path and hash kept, marked as not a new tab", () => {
  assert.equal(oldOwnPageAddress(`${OLD}newtab/newtab.html#launcher`, OWN), `${OWN}newtab/newtab.html?again#launcher`);
  assert.equal(oldOwnPageAddress(`${OLD}newtab/newtab.html`, OWN), `${OWN}newtab/newtab.html?again`);
  assert.equal(oldOwnPageAddress(`${OLD}newtab/newtab.html?again`, OWN), `${OWN}newtab/newtab.html?again`);
});

test("this copy's own new-tab page, another of its files, web pages and other schemes are left alone", () => {
  assert.equal(oldOwnPageAddress(`${OWN}newtab/newtab.html`, OWN), null);
  assert.equal(oldOwnPageAddress(`${OLD}themes/arcadia/newtab.html`, OWN), null);
  assert.equal(oldOwnPageAddress('https://example.com/newtab/newtab.html', OWN), null);
  assert.equal(oldOwnPageAddress('chrome-extension://OLD/newtab/newtab.html', OWN), null);
  assert.equal(oldOwnPageAddress(undefined, OWN), null);
  assert.equal(oldOwnPageAddress('not a url', OWN), null);
});

// ---- 2026-11-04: the old copy's keys, its proof, and never a reload in front --

test('cut off: a page found so is told in its world (its old listener for the navigation keys steps aside: shared/shortcuts.js); one bound to this copy, or to another still running, isn\'t', async () => {
  const dead = page();
  const deadWorld = vm.createContext({ ...dead.globals });
  await vm.runInContext(`(${cutOffInPage.toString()})(${JSON.stringify(OWN)}, false)`, deadWorld);
  assert.equal(vm.runInContext('globalThis.Margin?.cutOff', deadWorld), true);
  for (const p of [page({ address: OWN }), page({ storage: 'answers' })]) {
    const world = vm.createContext({ ...p.globals });
    await vm.runInContext(`(${cutOffInPage.toString()})(${JSON.stringify(OWN)}, false)`, world);
    assert.equal(vm.runInContext('globalThis.Margin?.cutOff', world), undefined);
  }
});

test('cut off: a world found so gets a listener (once) that keeps the commands\' keys from the page\'s own listeners, not turned down, so Safari\'s command (this copy\'s) runs: the way out by keys of a page that eats arrows (review, 2026-11-04)', async () => {
  const p = page();
  const listeners = [];
  const world = vm.createContext({ ...p.globals, addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }) });
  const keys = ['Ctrl+Meta+ArrowDown', 'Ctrl+Meta+ArrowUp'];
  for (let i = 0; i < 2; i++) await vm.runInContext(`(${cutOffInPage.toString()})(${JSON.stringify(OWN)}, false, ${JSON.stringify(keys)})`, world);
  assert.equal(listeners.length, 1, 'once per world');
  assert.equal(listeners[0].type, 'keydown');
  assert.equal(listeners[0].capture, true);
  const press = (code, mods) => {
    const e = { code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods, stopped: false, prevented: false };
    e.stopImmediatePropagation = () => { e.stopped = true; };
    e.preventDefault = () => { e.prevented = true; };
    listeners[0].fn(e);
    return e;
  };
  const down = press('ArrowDown', { ctrlKey: true, metaKey: true });
  assert.deepEqual([down.stopped, down.prevented], [true, false]);
  assert.equal(press('ArrowDown', {}).stopped, false, 'a bare arrow is the page\'s');
  assert.equal(press('ArrowDown', { altKey: true, metaKey: true }).stopped, false, 'another combination is the page\'s');
  assert.equal(press('ArrowLeft', { ctrlKey: true, metaKey: true }).stopped, false, 'a key no command has');
  const live = page({ address: OWN });
  const liveListeners = [];
  await vm.runInContext(`(${cutOffInPage.toString()})(${JSON.stringify(OWN)}, false, ${JSON.stringify(keys)})`, vm.createContext({ ...live.globals, addEventListener: (...a) => liveListeners.push(a) }));
  assert.equal(liveListeners.length, 0, 'none in a page that isn\'t cut off');
});

test('cut off: the old copy\'s word that this document\'s tab was proven to have WebKit\'s mark comes with the answer (kept before the page is loaded again)', async () => {
  const p = page();
  const world = vm.createContext({ ...p.globals, Margin: { inWindowAt: 123 } });
  const answer = await vm.runInContext(`(${cutOffInPage.toString()})(${JSON.stringify(OWN)}, false)`, world);
  assert.equal(answer.proven, true);
});

// The background's side (background/tabs.js repairCutOff), against a fake
// Safari: tabs, their pages' answer to the probe, the loads it asks for.
const fake = { tabs: new Map(), updates: [], scripts: [], session: {}, local: {}, probe: () => ({ cutOff: false }) };
async function background() {
  globalThis.chrome = {
    runtime: { id: 'x', getURL: (path) => `${OWN}${path}`, getManifest: () => ({ version: '0', content_scripts: [{ js: ['content/main.js'] }] }) },
    permissions: { contains: async () => true },
    windows: { get: async (id) => ({ id, focused: true }), update: async () => {} },
    tabs: {
      get: async (id) => { const t = fake.tabs.get(id); if (!t) throw new Error('no tab'); return { ...t }; },
      query: async ({ active, windowId } = {}) => [...fake.tabs.values()].filter((t) => (active == null || t.active === active) && (windowId == null || t.windowId === windowId)).map((t) => ({ ...t })),
      update: async (id, change) => { fake.updates.push({ id, change, at: Date.now() }); return { ...fake.tabs.get(id) }; },
      reload: async (id) => { fake.updates.push({ id, change: { reload: true }, at: Date.now() }); },
      sendMessage: async () => null,
    },
    scripting: {
      executeScript: async ({ target, func, args }) => {
        fake.scripts.push({ tabId: target.tabId, func, args });
        return [{ result: func?.name === 'cutOffInPage' ? fake.probe(target.tabId, args) : true }];
      },
    },
    storage: {
      local: { get: async (k) => Object.fromEntries([].concat(k ?? Object.keys(fake.local)).filter((x) => x in fake.local).map((x) => [x, structuredClone(fake.local[x])])), set: async (v) => { Object.assign(fake.local, structuredClone(v)); }, remove: async () => {} },
      session: { get: async (k) => Object.fromEntries([].concat(k).filter((x) => x in fake.session).map((x) => [x, structuredClone(fake.session[x])])), set: async (v) => { Object.assign(fake.session, structuredClone(v)); } },
      onChanged: { addListener() {} },
    },
  };
  const tabs = await import('../extension/background/tabs.js');
  const store = await import('../extension/background/store.js');
  await store.decided();
  return tabs;
}
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const loadsOf = (id) => fake.updates.filter((u) => u.id === id && (u.change.url || u.change.reload));

test('cut off, in front: put out of sight at once, not loaded again in front; loaded again once it\'s left, behind', async () => {
  const tabs = await background();
  fake.tabs = new Map([[1, { id: 1, windowId: 1, url: 'https://front.test/a', active: true, status: 'complete' }], [2, { id: 2, windowId: 1, url: 'https://other.test/', active: false, status: 'complete' }]]);
  fake.probe = (id, [, quiet]) => (id === 1 ? { cutOff: true, busy: false, hidden: false, proven: true, quiet } : { cutOff: false });
  assert.equal(await tabs.repairCutOff({ ...fake.tabs.get(1) }), 'quiet');
  assert.deepEqual(loadsOf(1), [], 'not loaded again in front');
  assert.ok(fake.scripts.some((x) => x.tabId === 1 && x.func.name === 'cutOffInPage' && x.args[1] === true), 'its dead sidebar put out of sight');
  // Left (the user's switch to tab 2): loaded again, behind.
  fake.tabs.get(1).active = false;
  fake.tabs.get(2).active = true;
  tabs.tabLeft(1);
  await sleepMs(250);
  assert.deepEqual(loadsOf(1), [], 'not at once: once the switch away has landed');
  await sleepMs(400);
  assert.equal(loadsOf(1).length, 1, `loaded again once behind: ${JSON.stringify(fake.updates)}`);
  assert.equal(loadsOf(1)[0].change.url, 'https://front.test/a');
});

test('cut off, in front and in use (something typed): put out of sight, not loaded again when it\'s left either', async () => {
  const tabs = await background();
  fake.updates = [];
  fake.tabs = new Map([[5, { id: 5, windowId: 2, url: 'https://draft.test/', active: true, status: 'complete' }], [6, { id: 6, windowId: 2, url: 'https://b.test/', active: false, status: 'complete' }]]);
  fake.probe = (id) => (id === 5 ? { cutOff: true, busy: true, hidden: false, proven: false } : { cutOff: false });
  assert.equal(await tabs.repairCutOff({ ...fake.tabs.get(5) }), 'quiet');
  fake.tabs.get(5).active = false;
  fake.tabs.get(6).active = true;
  tabs.tabLeft(5);
  await sleepMs(500);
  assert.deepEqual(loadsOf(5), []);
});

test('cut off, with a switch to it under way (behind still): put out of sight in one probe, not loaded again; loaded again once it\'s left', async () => {
  const tabs = await background();
  fake.updates = [];
  fake.scripts = [];
  fake.tabs = new Map([[7, { id: 7, windowId: 3, url: 'https://next.test/', active: false, status: 'complete' }], [8, { id: 8, windowId: 3, url: 'https://front.test/', active: true, status: 'complete' }]]);
  fake.probe = (id) => (id === 7 ? { cutOff: true, busy: false, hidden: true, proven: false } : { cutOff: false });
  assert.equal(await tabs.repairCutOff({ ...fake.tabs.get(7) }, { forSwitch: true }), 'quiet');
  assert.deepEqual(loadsOf(7), []);
  const probes = fake.scripts.filter((x) => x.tabId === 7 && x.func.name === 'cutOffInPage');
  assert.equal(probes.length, 1, 'one script');
  assert.equal(probes[0].args[1], true, 'which puts it out of sight');
  // Shown, then left.
  fake.tabs.get(7).active = true;
  fake.tabs.get(8).active = false;
  fake.tabs.get(7).active = false;
  fake.tabs.get(8).active = true;
  tabs.tabLeft(7);
  await sleepMs(700);
  assert.equal(loadsOf(7).length, 1);
});
