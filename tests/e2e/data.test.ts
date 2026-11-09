// The copy's side of the data set (docs/DATA.md "Messages", background/link.ts):
// the app's set taken as the cache; changes made while linked sent as
// data.changes; changes made while Margin.app wasn't there queued and sent
// in the next data.hello; and a profile whose storage was wiped refilled
// from the app (found by Safari's id for the profile). The merge and the
// files are the app's (tools/app-tests).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMargin } from './harness/margin.ts';
import { SPACES } from './harness/seed.ts';
import { SAFARI_PROFILE } from './harness/shell.ts';
import { sidebar, pinRow, folderRow } from './harness/ui.ts';

let m;
let ui;
let windowId;

const SEED = (url) => ({
  spaces: SPACES,
  pins: [
    { id: 'pin-mail', url: url('post.test', '/inbox'), title: 'Inbox — Post', spaceId: 'sp-work', folderId: null },
    { id: 'pin-dash', url: url('metrics.test', '/'), title: 'Overview · Metrics', spaceId: 'sp-work', folderId: 'fold-daily' },
    { id: 'pin-docs', url: url('docs.test', '/guide/getting-started'), title: 'Getting started · Lattice Docs', spaceId: 'sp-work', folderId: 'fold-daily' },
  ],
  folders: [{ id: 'fold-daily', name: 'Daily', spaceId: 'sp-work', open: true }],
  archive: [{ id: 'ar-tote', url: url('shop.test', '/p/canvas-tote'), title: 'Canvas Tote — Common Goods', spaceId: 'sp-home', favIconUrl: '', closedAt: Date.now() - 3 * 3600_000 }],
  settings: { sidebarPinnedOpen: true, archiveAfterHours: 24 },
});

const hellos = () => m.shell.received.filter((x) => x.k === 'data.hello');
const has = (changes, collection, test = () => true) => changes.some((c) => c.collection === collection && test(c));

before(async () => {
  m = await startMargin({ name: 'data', seed: SEED });
  ui = await m.ui();
  windowId = m.shell.frontWindowId();
});
after(async () => { await m?.close(); });

test('the app\'s set is the copy\'s: spaces, pins in a folder, the archive and settings', async (t) => {
  const hello = hellos()[0];
  assert.equal(hello.profile, SAFARI_PROFILE, 'the profile is Safari\'s id for it');
  assert.equal(hello.format, 1);
  const s = await m.state();
  assert.deepEqual(s.spaces.map((x) => x.id), SPACES.map((x) => x.id));
  assert.deepEqual(s.pins.map((p) => p.id).sort(), ['pin-dash', 'pin-docs', 'pin-mail']);
  assert.equal(s.folders[0].name, 'Daily');
  assert.equal(s.archive[0].id, 'ar-tote');
  assert.equal(s.settings.archiveAfterHours, 24);
  // Drawn: Work's pins, two of them in the folder.
  await ui.click('.chip[data-space-id="sp-work"]');
  await m.until(async () => (await sidebar(ui)).space === 'Work', { what: 'Work' });
  await m.until(async () => (await ui.$(folderRow('fold-daily'))) && (await ui.$(pinRow('pin-mail'))), { what: 'the folder and the pin' });
  const pins = (await sidebar(ui)).pins;
  assert.deepEqual(pins.filter((p) => p.nested).map((p) => p.id).sort(), ['pin-dash', 'pin-docs']);
  await m.shoot(t, 'work');
  await ui.click('.chip[data-space-id="sp-home"]');
  await m.until(async () => (await sidebar(ui)).space === 'Home', { what: 'Home again' });
});

test('changes made while linked go to the app as they\'re made', async () => {
  const from = m.shell.dataChanges.length;
  assert.equal((await m.shell.request('updateSettings', { patch: { archiveAfterHours: 48 } }, windowId)).ok, true);
  const page = await m.open('noir.test', '/');
  const tab = (await m.front()).id;
  assert.equal((await m.shell.request('pinTab', { tabId: tab }, windowId)).ok, true);
  await m.until(() => has(m.shell.dataChanges.slice(from), 'settings', (c) => JSON.stringify(c.value ?? null).includes('48')), { timeout: 8000, what: 'the setting sent' });
  await m.until(() => has(m.shell.dataChanges.slice(from), 'pins', (c) => /noir\.test/.test(c.value?.url ?? '')), { timeout: 8000, what: 'the new pin sent' });
  const changes = m.shell.dataChanges.slice(from);
  assert.ok(changes.every((c) => Number.isFinite(c.updatedAt) && typeof c.id === 'string'), 'each with its id and time');
  await page.close();
});

test('changes made while Margin.app wasn\'t there are queued and sent in the next hello', async () => {
  const page = await m.open('accounts.test', '/signin');
  const tab = (await m.front()).id;
  await m.until(async () => (await m.state()).tabs[tab]?.title.startsWith('Sign in'), { what: 'the sign-in page known' });
  await m.shell.kill();
  await m.until(() => !m.shell.linked, { what: 'the link down' });
  // Closed in Safari meanwhile: archived (state/model.ts closedTab).
  await page.close();
  const entry = await m.until(async () => (await m.state()).archive.find((a) => a.title.startsWith('Sign in')), { what: 'the sign-in page archived' });
  await new Promise((r) => setTimeout(r, 1800)); // its change noted (the meta's own write, 1.5 s later)
  const before = hellos().length;
  await m.shell.restart();
  m.relay.dispatch('appUp', { v: 2, at: Date.now() });
  const hello = await m.until(() => hellos()[before], { timeout: 10_000, what: 'a data.hello to the new app' });
  assert.ok(has(hello.queue, 'archive', (c) => c.id === entry.id), `the archived page in the queue (${hello.queue.length} changes)`);
  assert.ok(has(hello.queue, 'pins', (c) => /noir\.test/.test(c.value?.url ?? '')), 'and what the app never confirmed (no data.ack here): the pin');
  await m.linked();
  await m.shell.overlay();
  ui = await m.ui();
});

test('a profile whose storage was wiped is filled again from the app\'s set', async (t) => {
  // Safari wiped Margin's storage (local and session), and its background started again (stopped, then woken by a page).
  const before = hellos().length;
  const nt = await m.context.newPage();
  const cdp = await m.context.newCDPSession(nt);
  await cdp.send('ServiceWorker.enable');
  await m.bg(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await cdp.send('ServiceWorker.stopAllWorkers');
  await nt.goto(m.newTabUrl());
  // The stopped background may have said hello under a profile of its own making first (the app
  // asks that one for its set: data.need); the one started again finds Safari's id for it.
  const hello = await m.until(() => hellos().slice(before).find((h) => h.profile === SAFARI_PROFILE), { timeout: 15_000, what: 'a data.hello from the background started again' });
  assert.equal(hello.profile, SAFARI_PROFILE, 'the same profile, by Safari\'s id');
  assert.equal(hello.rev, undefined, 'no revision: it has nothing of the app\'s');
  await m.until(async () => (await m.state()).spaces?.map((x) => x.id).join() === SPACES.map((x) => x.id).join(), { timeout: 8000, what: 'the spaces back' });
  const s = await m.state();
  assert.ok(s.pins?.some((p) => p.id === 'pin-mail'), 'the pins back');
  assert.ok(s.folders?.some((f) => f.id === 'fold-daily'), 'the folder back');
  await nt.close();
  await m.shell.overlay();
  ui = await m.ui();
  await m.until(async () => (await sidebar(ui)).chips.length === 3, { what: 'three chips drawn' });
  await m.shoot(t, 'refilled');
});
