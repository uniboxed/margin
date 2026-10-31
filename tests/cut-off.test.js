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
  assert.deepEqual({ ...(await run(page())) }, { cutOff: true, busy: false, hidden: true });
  assert.deepEqual({ ...(await run(page({ hidden: false }))) }, { cutOff: true, busy: false, hidden: false }, 'in front');
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
  assert.equal(oldOwnPageAddress(`${OLD}themes/arcadium/newtab.html`, OWN), null);
  assert.equal(oldOwnPageAddress('https://example.com/newtab/newtab.html', OWN), null);
  assert.equal(oldOwnPageAddress('chrome-extension://OLD/newtab/newtab.html', OWN), null);
  assert.equal(oldOwnPageAddress(undefined, OWN), null);
  assert.equal(oldOwnPageAddress('not a url', OWN), null);
});
