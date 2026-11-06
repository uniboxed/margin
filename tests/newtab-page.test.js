// Margin's new-tab page (newtab/newtab.js) against a fake page and browser API: what it shows
// follows the link to Margin.app even when it misses a storage event (a write before its listener
// reaches Safari, a suspended or hidden page), its Start button never starts an app that's already
// linked, and linked with nothing drawn over its window it shows its address field and says why,
// with no Start button and nothing about the app not running.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const page = {};
function reset({ reads }) {
  // `reads`: what each storage read of appLink gives, in turn (the last one from then on).
  Object.assign(page, { reads: [...reads], changed: [], doc: {}, win: {}, reloads: 0, sent: [] });
  const el = (extra = {}) => ({ hidden: true, textContent: '', disabled: false, value: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, focus() { page.focused = true; }, ...extra });
  page.els = { notice: el(), title: el({ textContent: 'Margin.app isn’t running' }), why: el(), start: el(), status: el(), go: el(), address: el() };
  page.visibility = 'visible';
}
const on = (store) => (type, fn) => { (store[type] ??= []).push(fn); };
globalThis.document = {
  getElementById: (id) => page.els[id] ?? null,
  addEventListener: (type, fn) => on(page.doc)(type, fn),
  get visibilityState() { return page.visibility; },
};
globalThis.addEventListener = (type, fn) => on(page.win)(type, fn);
globalThis.location = { hash: '', search: '', reload: () => { page.reloads++; } };
globalThis.history = { length: 2 }; // not a fresh new tab: no hand-off asked
globalThis.browser = {
  runtime: {
    getURL: (p) => `safari-web-extension://test/${p}`,
    sendMessage: async (m) => { page.sent.push(m.type); return { ok: true, result: m.type === 'startApp' ? true : undefined }; },
    onMessage: { addListener() {} },
  },
  storage: {
    local: { get: async () => ({ appLink: page.reads.length > 1 ? page.reads.shift() : page.reads[0] }) },
    onChanged: { addListener: (fn) => page.changed.push(fn) },
  },
  tabs: { getCurrent: async () => ({ id: 5, windowId: 7 }) },
};
let n = 0;
const load = async () => { await import(`../extension/newtab/newtab.js?${++n}`); await sleep(20); };
const fire = (store, type, event = {}) => { for (const fn of store[type] ?? []) fn(event); };

test('the new-tab page: "linked" written before its listener was handed over is caught by the read right after it', async () => {
  reset({ reads: [{ state: 'off' }, { state: 'linked' }] });
  await load();
  assert.equal(page.changed.length >= 1, true, 'listening');
  assert.equal(page.reloads, 1, 'loaded again for the app');
});

test('the new-tab page: hidden, it misses the storage event; shown again, it reads the link and is loaded again', async () => {
  reset({ reads: [{ state: 'off' }, { state: 'off' }] });
  await load();
  assert.equal(page.reloads, 0);
  assert.equal(page.els.notice.hidden, false, 'the notice');
  page.visibility = 'hidden';
  page.reads = [{ state: 'linked' }]; // (no onChanged: the page was suspended)
  fire(page.doc, 'visibilitychange');
  await sleep(20);
  assert.equal(page.reloads, 0, 'hidden: nothing read');
  page.visibility = 'visible';
  fire(page.doc, 'visibilitychange');
  await sleep(20);
  assert.equal(page.reloads, 1, 'shown: loaded again');
  fire(page.win, 'pageshow', { persisted: true });
  fire(page.win, 'focus');
  await sleep(20);
  assert.equal(page.reloads, 3, 'back from the back/forward cache, or focused: read again too');
});

test('the new-tab page: Start never starts an app that\'s linked by now: loaded again instead', async () => {
  reset({ reads: [{ state: 'off' }, { state: 'off' }] });
  await load();
  assert.equal(page.els.start.hidden, false, 'the start button');
  page.reads = [{ state: 'linked' }];
  await page.els.start.listeners.click();
  assert.equal(page.reloads, 1);
  assert.ok(!page.sent.includes('startApp'), 'not asked to start');
});

test('the new-tab page: linked, with nothing drawn over its window: the address field, why, no Start, nothing about the app not running; drawn later: loaded again', async () => {
  const undrawn = { state: 'linked', layouts: {}, drawn: { 7: false } };
  reset({ reads: [undrawn] });
  await load();
  assert.equal(page.reloads, 0);
  assert.equal(page.els.notice.hidden, false, 'the notice, with the address field');
  assert.equal(page.focused, true, 'the address field focused');
  assert.equal(page.els.title.textContent, 'Margin.app hasn’t placed this window yet');
  assert.ok(!/isn’t running/.test(page.els.title.textContent + page.els.why.textContent));
  assert.equal(page.els.start.hidden, true, 'no Start button');
  for (const fn of page.changed) fn({ appLink: { newValue: { ...undrawn, drawn: { 7: false, 8: true } } } }, 'local');
  assert.equal(page.reloads, 0, 'another window\'s word: nothing');
  for (const fn of page.changed) fn({ appLink: { newValue: { ...undrawn, drawn: { 7: true } } } }, 'local');
  assert.equal(page.reloads, 1, 'drawn now: loaded again, for the app');
});

test('the new-tab page: linked and drawn (or not said): nothing of its own', async () => {
  reset({ reads: [{ state: 'linked', layouts: {}, drawn: {} }] });
  await load();
  assert.equal(page.els.notice.hidden, true);
  assert.equal(page.reloads, 0);
});
