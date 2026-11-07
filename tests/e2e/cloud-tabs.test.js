// iCloud Tabs in the overlay (Margin.app reads them: app/shell/CloudTabs.swift;
// the overlay draws them: shared/cloud-tabs.js, the theme's cloud-tabs part):
// the folder above New Tab with each device and its tabs; devices closed and
// opened; a tab opened as a new tab; Copy Link and Full Disk Access asked of
// the app; the setting off hides them; the palette's iCloud section. The
// devices are made up (tests/fixtures/cloud-tabs.js), their tabs this test
// site's pages (harness/seed.js cloudTabsOf).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMargin } from './harness/margin.js';
import { SPACES, cloudTabsOf } from './harness/seed.js';
import { palette, sidebar } from './harness/ui.js';
import { PHONE, AIR, PAD } from '../fixtures/cloud-tabs.js';

let m;
let ui;
let windowId;

const cloudView = () => ui.evaluate(() => ({
  folder: !!document.querySelector('.cloud'),
  open: !!document.querySelector('.cloud.open'),
  devices: [...document.querySelectorAll('.cloud-device')].map((d) => ({ id: d.dataset.deviceId, open: d.classList.contains('open'), stale: d.classList.contains('stale'), label: d.getAttribute('aria-label') ?? '' })),
  tabs: [...document.querySelectorAll('.cloud-tab')].map((t) => t.dataset.cloudTabId),
  note: document.querySelector('.cloud-note .text')?.textContent ?? null,
  fix: !!document.querySelector('.cloud-fix'),
  aboveNewTab: (() => {
    const c = document.querySelector('.cloud');
    const n = document.querySelector('.new-tab-row');
    return !!c && !!n && !!(c.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING);
  })(),
}));
const setSettings = (patch) => m.shell.request('updateSettings', { patch }, windowId);
// A press on the folder or a device, then the overlay told of the new setting (the press after
// it is made from that, or from what's drawn). `from`: the shell's message count before the press.
async function pressed(selector) {
  const from = m.shell.received.length;
  await ui.click(selector);
  await m.until(() => m.shell.received.slice(from).some((x) => x.k === 'delta' && x.changes?.settings), { what: 'the setting changed' });
  await m.shell.overlays.get(windowId).chain;
}

let site;
before(async () => {
  m = await startMargin({ name: 'cloud-tabs', seed: { spaces: SPACES, settings: { sidebarPinnedOpen: true } } });
  site = m.url;
  m.shell.setCloudTabs(cloudTabsOf(site));
  ui = await m.ui();
  windowId = m.shell.frontWindowId();
  await m.until(async () => (await cloudView()).devices.length === 3, { what: 'three devices drawn' });
});
after(async () => { await m?.close(); });

test('the folder sits above New Tab, with each device and its tabs; an old device is dimmed', async (t) => {
  const v = await cloudView();
  assert.equal(v.folder && v.open, true, 'the folder, open');
  assert.equal(v.aboveNewTab, true, 'above New Tab');
  assert.deepEqual(v.devices.map((d) => d.id), [PHONE, AIR, PAD], 'in the app\'s order');
  assert.match(v.devices[0].label, /iPhone/);
  assert.equal(v.devices.find((d) => d.id === PAD).stale, true, 'the iPad not used for ten days, dimmed');
  assert.ok(v.tabs.includes('T-PHONE-2'), 'the phone\'s tabs shown');
  await m.shoot(t, 'folder');
});

test('a device closed and opened again; the folder too', async () => {
  await pressed(`.cloud-device[data-device-id="${PHONE}"]`);
  await m.until(async () => !(await cloudView()).tabs.includes('T-PHONE-1'), { what: 'the phone\'s tabs hidden' });
  assert.deepEqual((await m.stored('settings')).settings.cloudTabsClosed, [PHONE], 'kept in the settings');
  assert.ok((await cloudView()).tabs.includes('T-AIR-1'), 'the others still open');
  await pressed(`.cloud-device[data-device-id="${PHONE}"]`);
  await m.until(async () => (await cloudView()).tabs.includes('T-PHONE-1'), { what: 'the phone\'s tabs back' });

  await pressed('.cloud-head');
  await m.until(async () => !(await cloudView()).open, { what: 'the folder closed' });
  assert.equal((await cloudView()).tabs.length, 0);
  await pressed('.cloud-head');
  await m.until(async () => (await cloudView()).open, { what: 'the folder open' });
  await m.until(async () => (await m.stored('settings')).settings.cloudTabsOpen === true, { what: 'open in the settings' });
});

// Found by this suite (2026-11-06), fixed: the folder is drawn closed at once (the runtime's pending
// settings), but the next press's request was made from the state as stored (ui/runtime.js
// dispatch: host.getState(), not viewState), which still said open: it asked to close again. The
// same for a device, and for Keep open. Held here by keeping the app's word back between the presses.
test('the folder pressed twice before the setting comes back: closed, then open again', async () => {
  await m.until(async () => (await cloudView()).open, { what: 'the folder open' });
  m.shell.hold(true);
  try {
    await ui.click('.cloud-head');
    await m.until(async () => !(await cloudView()).open, { what: 'drawn closed' });
    await ui.click('.cloud-head');
    await m.until(async () => (await cloudView()).open, { what: 'drawn open' });
  } finally {
    m.shell.hold(false);
  }
  await new Promise((r) => setTimeout(r, 500));
  const asked = m.shell.requests.filter((r) => r.type === 'updateSettings' && 'cloudTabsOpen' in (r.payload.patch ?? {})).slice(-2).map((r) => r.payload.patch.cloudTabsOpen);
  try {
    assert.deepEqual(asked, [false, true], 'closed, then opened');
    assert.equal((await m.stored('settings')).settings.cloudTabsOpen, true, 'open in the settings, as drawn');
    assert.equal((await cloudView()).open, true, 'still drawn open once the app\'s word comes');
  } finally {
    await setSettings({ cloudTabsOpen: true });
    await m.until(async () => (await cloudView()).open, { what: 'the folder open for the next test' });
  }
});

test('a tab from the phone opens here as a new tab, in the space in front', async (t) => {
  const before = (await m.tabs()).length;
  await ui.click('.cloud-tab[data-cloud-tab-id="T-PHONE-2"]');
  const tab = await m.until(async () => { const f = await m.front(); return f?.url === site('dispatch.test', '/2026/11/the-quiet-city') && f; }, { what: 'the article open in front' });
  assert.equal((await m.tabs()).length, before + 1, 'a new tab');
  assert.equal((await m.state()).tabSpace[tab.id], 'sp-home');
  await m.until(async () => (await sidebar(ui)).tabs.some((r) => r.id === tab.id && r.active), { what: 'its row, highlighted' });
  await m.shoot(t, 'opened');
});

test('Copy Link from a cloud tab\'s menu asks the app to copy its address', async () => {
  await ui.click('.cloud-tab[data-cloud-tab-id="T-AIR-1"]', { button: 'right' });
  await m.until(async () => (await sidebar(ui)).menu.includes('Copy Link'), { what: 'the menu' });
  await ui.locator('.tab-menu .menu-item', { hasText: 'Copy Link' }).click();
  const asked = await m.until(() => m.shell.performs.find((p) => p.name === 'copyText'), { what: 'copyText asked of the app' });
  assert.deepEqual(asked.arg, { text: site('slow.test', '/report') });
  assert.equal(asked.windowId, windowId);
});

test('the palette finds tabs on other devices, under each device, and leaves out one open here', async (t) => {
  m.shell.key('palette');
  await m.until(async () => (await palette(ui)).focused, { what: 'the palette' });
  await ui.keyboard.type('quiet');
  const rows = await m.until(async () => { const p = await palette(ui); return p.rows.some((r) => r.id === 'cloud:T-PHONE-1') && p.rows; }, { what: 'the phone\'s Harbor tab in the palette' });
  const cloud = rows.filter((r) => r.id.startsWith('cloud:'));
  assert.ok(cloud.every((r) => r.badge === 'iCloud'), 'marked iCloud');
  assert.match(cloud[0].section, /iPhone/, `under the phone: ${cloud[0].section}`);
  assert.ok(!cloud.some((r) => r.id === 'cloud:T-PHONE-2'), 'the article, open here now, isn\'t offered again');
  await m.shoot(t, 'palette');
  await ui.keyboard.press('Escape');
  await m.until(async () => !(await palette(ui)).open, { what: 'the palette closed' });
});

test('no access: the folder says so, and its button asks the app for Full Disk Access', async (t) => {
  m.shell.setCloudTabs({ status: 'noAccess', devices: [] });
  const v = await m.until(async () => { const x = await cloudView(); return x.fix && x; }, { what: 'the Full Disk Access row' });
  assert.ok(v.note, `it says why: ${v.note}`);
  await m.shoot(t, 'no-access');
  await ui.click('.cloud-fix');
  await m.until(() => m.shell.performs.some((p) => p.name === 'cloud.access'), { what: 'cloud.access asked of the app' });
  m.shell.setCloudTabs(cloudTabsOf(site));
  await m.until(async () => (await cloudView()).devices.length === 3, { what: 'the devices back' });
});

test('Show iCloud Tabs off hides the folder and the palette\'s section', async () => {
  assert.equal((await setSettings({ showCloudTabs: false })).ok, true);
  await m.until(async () => !(await cloudView()).folder, { what: 'no folder' });
  m.shell.key('palette');
  await m.until(async () => (await palette(ui)).focused, { what: 'the palette' });
  await ui.keyboard.type('field report');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!(await palette(ui)).rows.some((r) => r.id.startsWith('cloud:')), 'no iCloud rows');
  await ui.keyboard.press('Escape');
  await setSettings({ showCloudTabs: true });
  await m.until(async () => (await cloudView()).folder, { what: 'the folder back' });
});
