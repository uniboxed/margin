// Screenshots for the browser stores' listings: Margin over the test site, in
// each built-in theme, at the stores' 1280 × 800. Headless, off-screen. No
// iCloud Tabs (Safari's alone), nothing that names a browser.
//
//   node tools/store-shots.mts [out dir]
//
// Out dir: $MARGIN_E2E_SHOTS/store, else <tmp>/margin-e2e-shots/store. The
// pictures are drawn at the harness's 1440 × 900; scale them down to 1280 × 800
// (same shape) with any image tool.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Before the harness is loaded: it reads the folder once.
process.env.MARGIN_E2E_SHOTS = process.argv[2] || join(process.env.MARGIN_E2E_SHOTS || join(tmpdir(), 'margin-e2e-shots'), 'store');
const { startMargin } = await import('../tests/e2e/harness/margin.ts');
const { SPACES } = await import('../tests/e2e/harness/seed.ts');
const { settled } = await import('../tests/e2e/harness/ui.ts');
const { PACKAGE_THEMES } = await import('../extension/themes/packages.ts');

const SEED = (url) => ({
  spaces: SPACES,
  pins: [
    { id: 'pin-mail', url: url('post.test', '/inbox'), title: 'Inbox — Post', spaceId: 'sp-home', folderId: null },
    { id: 'pin-app', url: url('app.test', '/'), title: 'Projects · Field', spaceId: 'sp-home', folderId: null },
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

const m = await startMargin({ name: 'store', seed: SEED });
try {
  const windowId = m.shell.frontWindowId();
  for (const [host, path] of [['harbor.test', '/'], ['shop.test', '/p/canvas-tote'], ['docs.test', '/guide/getting-started'], ['dispatch.test', '/2026/11/the-quiet-city']]) await m.open(host, path);
  const ui = await m.ui();
  const still = async () => { await new Promise((r) => setTimeout(r, 400)); await settled(ui); };
  for (const id of PACKAGE_THEMES) {
    if (m.shell.themeId !== id) {
      await m.shell.request('updateSettings', { patch: { theme: id } }, windowId);
      await m.until(() => m.shell.themeId === id, { timeout: 8000, what: `${id} in use` });
    }
    await ui.locator('.tab:not(.pin)', { hasText: 'The Quiet City' }).first().click();
    await m.until(async () => (await m.front())?.url.includes('the-quiet-city'), { what: 'the article in front' });
    await ui.evaluate(() => document.querySelectorAll('*').forEach((el) => { if (el.scrollTop) el.scrollTop = 0; }));
    await still();
    await m.shoot('shots', `${id}-sidebar`);

    m.shell.key('palette');
    await m.until(() => ui.evaluate(() => !!document.querySelector('.palette') && document.activeElement?.localName === 'input'), { what: 'the palette' });
    await ui.keyboard.type('canvas');
    await m.until(async () => /Canvas Tote/i.test(await ui.locator('.palette').innerText()), { what: 'results' });
    await still();
    await m.shoot('shots', `${id}-palette`);
    await ui.keyboard.press('Escape');
    await m.until(async () => (await ui.locator('.palette').count()) === 0, { what: 'the palette closed' });

    const nt = await m.context.newPage();
    await nt.goto(m.newTabUrl());
    await m.until(async () => (await ui.locator('.launcher .archive-row').count()) >= 2, { what: 'the launcher' });
    await still();
    await m.shoot('shots', `${id}-launcher`, { page: nt });
    await nt.close();
  }
  console.log(`pictures in ${process.env.MARGIN_E2E_SHOTS}`);
} finally {
  await m.close();
}
