// Margin's new-tab page (newtab/newtab.ts) against a fake page and browser API: it never draws anything of Margin's
// (2026-11-27). A fresh new tab Margin.app doesn't take (not linked, or a window it doesn't draw) goes to the browser's
// own new tab (shared/own-new-tab.ts), once; one it takes is the background's to hand to Margin's palette; anything
// else (Back, a reload, `#launcher`, `?again`, `?mark=`) stays blank and is never sent anywhere; the link changing
// later never loads it again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeBrowser } from './fake-browser.ts';
import { capabilities } from '../extension/shared/capabilities.ts';
import { ownNewTabUrl } from '../extension/shared/own-new-tab.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Page = { link: unknown, sent: string[], updates: [number, { url?: string }][], refuse: boolean, reloads: number, storageListeners: number };
const page: Page = { link: null, sent: [], updates: [], refuse: false, reloads: 0, storageListeners: 0 };
const doc = { title: 'New Tab', getElementById: () => null, addEventListener() {} };
globalThis.document = (doc as unknown as Document);
globalThis.addEventListener = (() => {}) as typeof globalThis.addEventListener;
const loc = { hash: '', search: '', reload: () => { page.reloads++; } };
globalThis.location = (loc as unknown as Location);
const hist = { length: 1 };
globalThis.history = (hist as History);
globalThis.browser = fakeBrowser({
  runtime: {
    getURL: (p) => `safari-web-extension://test/${p}`,
    sendMessage: async (m) => { page.sent.push(m.type); return { ok: true, result: undefined }; },
    onMessage: { addListener() {} },
  },
  storage: {
    local: { get: async (key) => (key === 'appLink' ? { appLink: page.link } : { settings: null }) },
    onChanged: { addListener: () => { page.storageListeners++; } },
  },
  tabs: {
    getCurrent: async () => ({ id: 5, windowId: 7 }),
    update: async (id, props) => {
      page.updates.push([id, props]);
      if (page.refuse) throw new Error('refused');
      return { id };
    },
  },
});
const OWN = ownNewTabUrl(capabilities?.name, navigator.userAgent);
let n = 0;
async function load({ link = null as unknown, fresh = true, hash = '', search = '', refuse = false } = {}) {
  Object.assign(page, { link, sent: [], updates: [], refuse, reloads: 0, storageListeners: 0 });
  doc.title = 'New Tab';
  hist.length = fresh ? 1 : 2;
  loc.hash = hash;
  loc.search = search;
  await import(`../extension/newtab/newtab.ts?${++n}`);
  await sleep(20);
}

test('the browser\'s own new tab for this build: Safari\'s start page or Chrome\'s new tab', () => {
  assert.ok(OWN === 'favorites://' || OWN === 'chrome://new-tab-page/', String(OWN));
});

test('not linked: a fresh new tab goes to the browser\'s own, once, titled as any new tab; the background asked first', async () => {
  await load({ link: { state: 'off' } });
  assert.deepEqual(page.updates, [[5, { url: OWN }]]);
  assert.deepEqual(page.sent.filter((t) => t === 'newTabPage'), ['newTabPage']);
  assert.equal(doc.title, 'New Tab');
  await load({ link: undefined });
  assert.deepEqual(page.updates, [[5, { url: OWN }]], 'no link written yet: the same');
});

test('linked, a window Margin.app draws: the new tab is the background\'s (Margin\'s palette), never sent elsewhere', async () => {
  await load({ link: { state: 'linked', drawn: { 7: true } } });
  assert.deepEqual(page.updates, []);
  assert.deepEqual(page.sent.filter((t) => t === 'newTabPage'), ['newTabPage']);
  await load({ link: { state: 'reconnecting' } });
  assert.deepEqual(page.updates, [], 'reconnecting, its window not said: as drawn');
});

test('linked, a window Margin.app doesn\'t draw (the person\'s own): the browser\'s own new tab', async () => {
  await load({ link: { state: 'linked', drawn: { 7: false } } });
  assert.deepEqual(page.updates, [[5, { url: OWN }]]);
});

test('refused by the browser: left blank, titled as any new tab', async () => {
  await load({ link: { state: 'off' }, refuse: true });
  assert.equal(page.updates.length, 1);
  assert.equal(doc.title, 'New Tab');
});

test('not a fresh new tab (Back, a reload, its start page, a gone copy\'s): blank, never sent anywhere', async () => {
  for (const [o, title] of [[{ fresh: false }, 'New Tab'], [{ hash: '#launcher' }, 'Margin'], [{ hash: '#settings' }, 'Settings'], [{ search: '?again' }, 'New Tab']] as const) {
    await load({ link: { state: 'off' }, ...o });
    assert.deepEqual(page.updates, [], JSON.stringify(o));
    assert.equal(page.sent.includes('newTabPage'), false, JSON.stringify(o));
    assert.equal(doc.title, title, JSON.stringify(o));
  }
});

test('a window Margin.app asked for (?mark=): its title carries the mark, never handed anywhere', async () => {
  await load({ link: { state: 'off' }, search: '?mark=abcdEFGH1234' });
  assert.equal(doc.title, 'Margin abcdEFGH1234');
  assert.deepEqual(page.updates, []);
});

test('the link changing later never loads the page again (it draws nothing either way)', async () => {
  await load({ link: { state: 'off' }, fresh: false });
  assert.equal(page.reloads, 0);
  assert.equal(page.storageListeners, 1, 'only the settings\' (the navigation keys)');
});
