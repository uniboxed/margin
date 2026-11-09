// Every built-in theme (themes/packages.ts PACKAGE_THEMES: a theme Phase 6
// adds is picked up here as it is), chosen in Settings, sent to the app in
// pieces again and drawn by the overlay with real content: the sidebar with
// tabs, pins, a folder and iCloud Tabs; the page box at the theme's gutters;
// the palette with results; the launcher with the archive; a menu; the space
// editor; a notice; the hidden sidebar and its peek. Pictures of each part
// for each theme. Only what every theme has is read (class names the themes
// share and the words Margin gives them), never one theme's own layout.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMargin } from './harness/margin.ts';
import { SPACES, cloudTabsOf } from './harness/seed.ts';
import { pageBox, slot, settled } from './harness/ui.ts';
import { PACKAGE_THEMES, PACKAGE_THEME_NAMES } from '../../extension/themes/packages.ts';

let m;
let ui;
let windowId;

const SEED = (url) => ({
  spaces: SPACES,
  pins: [
    { id: 'pin-mail', url: url('post.test', '/inbox'), title: 'Inbox — Post', spaceId: 'sp-home', folderId: null },
    { id: 'pin-dash', url: url('metrics.test', '/'), title: 'Overview · Metrics', spaceId: 'sp-home', folderId: 'fold-daily' },
    { id: 'pin-radio', url: url('radio.test', '/'), title: 'The sound of low tide · Radio Field', spaceId: 'sp-home', folderId: 'fold-daily' },
  ],
  folders: [{ id: 'fold-daily', name: 'Daily', spaceId: 'sp-home', open: true }],
  archive: [
    { id: 'ar-signin', url: url('accounts.test', '/signin'), title: 'Sign in · Accounts', spaceId: 'sp-home', favIconUrl: '', closedAt: Date.now() - 2 * 3600_000 },
    { id: 'ar-feed', url: url('murmur.test', '/home'), title: '(3) Murmur', spaceId: 'sp-home', favIconUrl: '', closedAt: Date.now() - 26 * 3600_000 },
  ],
  settings: { sidebarPinnedOpen: true },
});

// The themes in the order they're switched to: each one chosen in the Settings of the one before,
// the first (the one in use at the start) last.
const ORDER = [...PACKAGE_THEMES.slice(1), PACKAGE_THEMES[0]];

// What the overlay shows, in lower case (a theme may set words in capitals).
const text = () => ui.evaluate(() => document.body.innerText.toLowerCase());
const row = (title) => ui.locator('.tab:not(.pin)', { hasText: title }).first();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const sides = (b) => b && { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
// What each theme drew, for the checks after the pictures (kept as todo while a theme has it wrong).
const drawnBy = {};

before(async () => {
  m = await startMargin({ name: 'themes', seed: SEED });
  m.shell.setCloudTabs(cloudTabsOf(m.url));
  windowId = m.shell.frontWindowId();
  for (const [host, path] of [['dispatch.test', '/2026/11/the-quiet-city'], ['shop.test', '/p/canvas-tote'], ['docs.test', '/guide/getting-started']]) await m.open(host, path);
  ui = await m.ui();
});
after(async () => { await m?.close(); });

test('every built-in theme is here', () => {
  assert.ok(PACKAGE_THEMES.includes('arcadia') && PACKAGE_THEMES.includes('neo-brutalism'), PACKAGE_THEMES.join(', '));
  assert.equal(m.shell.themeId, PACKAGE_THEMES[0], 'the first is the one in use at the start');
});

for (const id of ORDER) {
  const name = PACKAGE_THEME_NAMES[id] ?? id;
  test(`${name}: chosen in Settings, sent again, and drawn with real content`, async (t) => {
    const shot = (label, options) => m.shoot(t, `${id}-${label}`, options);
    const errors = m.shell.pageErrors.length;

    // ---- chosen in the launcher's Settings, over Margin's new-tab page ------------------------
    const nt = await m.context.newPage();
    await nt.goto(m.newTabUrl());
    await m.until(() => ui.locator('.launcher').isVisible(), { what: 'the launcher' });
    // Closed in a new tab, though the theme before was chosen with them open (app/overlay/overlay.ts followPage).
    assert.equal(await ui.locator('m-settings select').count(), 0, 'a new tab\'s Settings start closed');
    // (In any case: Pixel's says SETTINGS.)
    await ui.locator('.launcher button', { hasText: /^settings$/i }).first().click();
    const picker = ui.locator('select', { has: ui.locator('option', { hasText: name }) }).first();
    await m.until(() => picker.isVisible(), { what: 'the theme picker' });
    const pieces = m.shell.received.filter((x) => x.k === 'theme').length;
    await picker.selectOption({ label: name });
    await m.until(() => m.shell.themeId === id, { timeout: 8000, what: `${name} sent to the app` });
    assert.ok(m.shell.received.filter((x) => x.k === 'theme').length > pieces, 'its pieces sent again');
    assert.equal((await m.stored('settings')).settings.theme, id);

    // The launcher drawn by the new theme, with the archive.
    await m.until(async () => (await ui.locator('.launcher .archive-row').count()) >= 2, { what: 'the archive in the launcher' });
    assert.match(await ui.locator('.launcher').innerText(), /Sign in · Accounts/i);
    // An address field, where the theme draws one, over Margin's own page.
    drawnBy[id] = { address: await ui.evaluate(() => [...document.querySelectorAll('.address')].map((el) => el.textContent.trim()).join(' ')) };
    await shot('launcher', { page: nt });
    await nt.close();

    // ---- the sidebar with tabs, pins, a folder and iCloud Tabs; the page in its box ---------------
    await row('The Quiet City').click();
    const article = await m.until(async () => { const f = await m.front(); return f?.url.includes('the-quiet-city') && f; }, { what: 'the article in front' });
    const page = await m.pageOf(article.id);
    // Where the theme puts the page: its slot, inside any border it draws (the layout the app is sent).
    const s = await m.until(() => { const l = m.shell.layoutsSent.findLast((x) => x.windowId === windowId); return l && Date.now() - l.at < 60_000 && l.insets; }, { what: 'the theme\'s layout' });
    await m.until(async () => JSON.stringify(sides(await pageBox(page))) === JSON.stringify(s), { what: `the page in ${name}'s slot ${JSON.stringify(s)}` });
    const drawn = await slot(ui);
    for (const k of ['left', 'top', 'right', 'bottom']) assert.ok(s[k] >= drawn[k] && s[k] - drawn[k] <= 4, `the box inside the slot ${name} draws (${k}: ${s[k]} in ${drawn[k]})`);
    const words = await text();
    for (const w of ['Inbox — Post', 'Daily', 'Overview · Metrics', 'Canvas Tote', 'Getting started']) assert.ok(words.includes(w.toLowerCase()), `${name} draws "${w}"`);
    assert.equal(await ui.locator('.cloud-device').count(), 3, 'three devices in iCloud Tabs');
    await shot('sidebar');

    // ---- the palette with results ----------------------------------------------------------------
    m.shell.key('palette');
    await m.until(() => ui.evaluate(() => !!document.querySelector('.palette') && document.activeElement?.localName === 'input'), { what: 'the palette, its field focused' });
    await ui.keyboard.type('quiet');
    await m.until(async () => /The Quiet City/i.test(await ui.locator('.palette').innerText()), { what: 'results' });
    await shot('palette');
    await ui.keyboard.press('Escape');
    await m.until(async () => (await ui.locator('.palette').count()) === 0, { what: 'the palette closed' });

    // ---- a tab's menu ------------------------------------------------------------------------------
    await row('Canvas Tote').click({ button: 'right' });
    await m.until(() => ui.locator('.menu-item', { hasText: 'Pin Tab' }).isVisible(), { what: 'the tab\'s menu' });
    await shot('menu');
    await ui.keyboard.press('Escape');
    await m.until(async () => (await ui.locator('.menu-item').count()) === 0, { what: 'the menu closed' });

    // ---- the space editor ------------------------------------------------------------------------
    await ui.locator('.chip').first().click({ button: 'right' });
    await ui.locator('.menu-item', { hasText: 'Edit Space…' }).click();
    await m.until(() => ui.locator('.editor').isVisible(), { what: 'the editor' });
    await shot('editor');
    await ui.keyboard.press('Escape');
    await m.until(async () => (await ui.locator('.editor').count()) === 0, { what: 'the editor closed' });

    // ---- a notice: a tab closed while the overlay lagged behind --------------------------------------
    await m.open('noir.test', '/');
    const noir = (await m.front()).id;
    await m.until(() => row('NOIR').isVisible(), { what: 'the portfolio\'s row' });
    await row('The Quiet City').click();
    await m.until(async () => (await m.front())?.id === article.id, { what: 'the article in front' });
    m.shell.hold(true);
    try {
      await m.bg((tabId) => chrome.tabs.remove(tabId), noir);
      await m.until(async () => !(await m.tabs()).some((x) => x.id === noir), { what: 'the portfolio closed' });
      await row('NOIR').click();
      await m.until(async () => /no longer open/i.test(await ui.locator('.notice').innerText().catch(() => '')), { what: 'the notice' });
      await settled(ui);
      drawnBy[id].notice = await ui.evaluate(() => {
        const text = document.querySelector('.notice .text') ?? document.querySelector('.notice');
        const r = text.getBoundingClientRect();
        const cs = getComputedStyle(text);
        const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
        return { width: Math.round(document.querySelector('.notice').getBoundingClientRect().width), lines: Math.round(r.height / line) };
      });
      await shot('notice');
    } finally {
      m.shell.hold(false);
    }
    await m.until(async () => (await row('NOIR').count()) === 0, { what: 'the row gone' });
    // The notice goes on its own (4 s): not in the next pictures.
    await m.until(async () => (await ui.locator('.notice').count()) === 0, { timeout: 8000, interval: 100, what: 'the notice gone' });

    // ---- the hidden sidebar and its peek ---------------------------------------------------------
    m.shell.key('toggle-sidebar');
    const hidden = await m.until(() => { const l = m.shell.layoutsSent.findLast((x) => x.windowId === windowId); return l.insets.left < s.left && l.insets; }, { what: 'the hidden sidebar\'s layout' });
    await m.until(async () => JSON.stringify(sides(await pageBox(page))) === JSON.stringify(hidden), { what: 'the page widened' });
    await pause(100);
    await settled(ui);
    await shot('hidden');
    m.shell.key('toggle-sidebar');
    await m.until(async () => (await text()).includes('inbox — post'), { what: 'the sidebar out over the page' });
    await pause(100);
    await settled(ui);
    assert.deepEqual(sides(await pageBox(page)), hidden, 'the page stays where it is for a peek');
    await shot('peek');
    m.shell.key('toggle-sidebar');
    await m.shell.request('updateSettings', { patch: { sidebarPinnedOpen: true } }, windowId);
    await m.until(() => m.shell.layoutsSent.findLast((x) => x.windowId === windowId).insets.left === s.left, { what: 'the sidebar kept open again' });

    assert.deepEqual(m.shell.pageErrors.slice(errors), [], `no errors in the overlay with ${name}`);
    assert.deepEqual(m.shell.blocked, [], 'the overlay loaded nothing from the web');
  });
}

test('a short notice is drawn on a line or two, not a word per line', () => {
  for (const id of ORDER) {
    const n = drawnBy[id]?.notice;
    assert.ok(n, `${id}: its notice measured`);
    assert.ok(n.lines <= 2 && n.width >= 160, `${id}: ${n.lines} lines, ${n.width} px wide`);
  }
});

test('over Margin\'s new-tab page, an address field shows no extension id', () => {
  for (const id of ORDER) {
    const address = drawnBy[id]?.address;
    assert.ok(address != null, `${id}: read`);
    assert.ok(!address.includes(m.extensionId), `${id}: "${address}"`);
  }
});
