// Auto-archive and the archive, through the overlay: the alarm, stale tabs
// archived while pinned and active ones stay, the sidebar's archive button
// opening Margin's start page with the archived tabs, and an archived tab
// restored from there and from the palette into its own space.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMargin, type Margin } from './harness/margin.ts';
import { SPACES } from './harness/seed.ts';
import { sidebar, palette, chip, startPageInFront } from './harness/ui.ts';
import type { Page } from 'playwright';
import type { ArchiveEntry, Settings } from '../../types/margin.d.ts';

let m: Margin;
let ui: Page;

const HOUR = 3600_000;
const SEED = (url: (host: string, path: string) => string) => ({
  spaces: SPACES,
  archive: [
    { id: 'ar-dash', url: url('metrics.test', '/'), title: 'Overview · Metrics', spaceId: 'sp-work', favIconUrl: '', closedAt: Date.now() - 6 * HOUR },
    { id: 'ar-podcast', url: url('radio.test', '/'), title: 'The sound of low tide · Radio Field', spaceId: 'sp-home', favIconUrl: '', closedAt: Date.now() - 30 * HOUR },
  ],
  settings: { sidebarPinnedOpen: true },
});

// (`!`: a test's front tab is there; were it not, the id is still undefined and the test fails where it's used.)
const frontId = async (): Promise<number> => (await m.front())?.id!;
const archive = async (): Promise<ArchiveEntry[]> => (await m.stored('archive')).archive ?? [];
const setSettings = (patch: Partial<Settings>) => m.shell.request('updateSettings', { patch }, m.shell.frontWindowId());

before(async () => {
  m = await startMargin({ name: 'archive', seed: SEED });
  ui = await m.ui();
});
after(async () => { await m?.close(); });

test('the background schedules the archive check (browser.alarms)', async () => {
  const alarm = await m.until(() => m.bg(() => chrome.alarms!.get('margin-archive')), { what: 'the alarm' });
  assert.equal(alarm.periodInMinutes, 15);
});

test('stale tabs are closed and archived; a pinned one and the one in front stay', async (t) => {
  await m.open('dispatch.test', '/longread');
  const longread = await frontId();
  await m.open('accounts.test', '/signin');
  const signin = await frontId();
  await m.open('embed.test', '/');
  const embeds = await frontId();
  const res = await m.shell.request('pinTab', { tabId: embeds }, m.shell.frontWindowId());
  assert.equal(res.ok, true);
  await m.open('harbor.test', '/');
  const harbor = await frontId();
  await m.until(async () => (await sidebar(ui)).tabs.some((r) => r.id === harbor && r.active), { what: 'the travel page in front' });
  await m.shoot(t, 'before');

  assert.equal((await setSettings({ archiveAfterHours: 1 / 3600 })).ok, true); // one second
  await new Promise((r) => setTimeout(r, 1200));
  const count = await m.bg(() => (globalThis.margin.archiveNow as () => Promise<number>)());
  assert.ok(count >= 2, `archived ${count}`);
  await setSettings({ archiveAfterHours: 12 });

  await m.until(async () => { const open = (await m.tabs()).map((x) => x.id); return !open.includes(longread) && !open.includes(signin); }, { what: 'the stale tabs closed' });
  const open = (await m.tabs()).map((x) => x.id);
  assert.ok(open.includes(embeds), 'the pinned tab stays');
  assert.ok(open.includes(harbor), 'the tab in front stays');
  const titles = (await archive()).map((a) => a.title);
  assert.ok(titles.some((x) => x.startsWith('Sign in')), `the sign-in page archived: ${titles.join(' | ')}`);
  assert.ok(titles.some((x) => x.length > 150), 'the long read archived');
  assert.ok(!titles.some((x) => /^Harbor|coast walk/.test(x)), 'not the pinned one or the one in front');
  await m.until(async () => { const v = await sidebar(ui); return !v.tabs.some((r) => r.id === longread || r.id === signin); }, { what: 'their rows gone' });
  await m.shoot(t, 'after');
});

// Found by this suite (2026-11-06): the archive button opens Margin's start page (openLauncher:
// newtab.html#launcher), which the overlay doesn't take for a new-tab page (see newtab.test.ts):
// no launcher, no archive list, and the page says "Margin.app isn't running" while linked.
test('the archive button opens Margin\'s start page with the archived tabs; one restored comes back in place', async (t) => {
  await ui.click('.bar-button.archive');
  const page = await m.until(async () => { const f = await m.front(); return f?.url.startsWith(m.newTabUrl()) && f; }, { what: 'Margin\'s start page in front' });
  await m.shoot(t, 'start-page');
  try {
    // Looked for once the overlay has the page in front, not waited on (as in newtab.test.ts).
    await m.until(async () => startPageInFront(await sidebar(ui), page.id), { what: 'the start page in front in the overlay' });
    assert.ok((await sidebar(ui)).launcher, 'the launcher drawn over the start page');
    const rows = await m.until(async () => { const r = await ui.$$eval('.archive-row .title', (els) => els.map((e) => e.textContent)); return r.length >= 3 && r; }, { what: 'the archive list' });
    assert.ok(rows.some((r) => r.startsWith('Sign in')), `the newest first: ${rows.join(' | ')}`);
    assert.equal(rows.at(-1), 'The sound of low tide · Radio Field', 'the oldest last');
    await m.shoot(t, 'archive-list');
    await ui.locator('.archive-row', { hasText: 'The sound of low tide' }).click();
    await m.until(async () => (await m.front())?.url === m.url('radio.test', '/'), { what: 'the podcast back' });
    assert.ok(!(await m.tabs()).some((x) => x.id === page.id && x.url.startsWith(m.newTabUrl())), 'the start page made way');
    await m.until(async () => !(await archive()).some((a) => a.id === 'ar-podcast'), { what: 'out of the archive' });
  } finally {
    // Not left open for the next test (the palette's restore).
    if ((await m.tabs()).some((x) => x.id === page.id)) await m.bg((id) => chrome.tabs.remove(id), page.id);
  }
});

test('the launcher over a new tab lists the archived tabs, newest first, and one restored takes the page\'s place', async (t) => {
  const page = await m.context.newPage();
  await page.goto(m.newTabUrl());
  const nt = await m.until(async () => { const f = await m.front(); return f?.url.startsWith(m.newTabUrl()) && f; }, { what: 'the new-tab page in front' });
  await m.until(async () => (await sidebar(ui)).launcher, { what: 'the launcher drawn' });
  const rows = await m.until(async () => { const r = await ui.$$eval('.archive-row .title', (els) => els.map((e) => e.textContent)); return r.length >= 3 && r; }, { what: 'the archive list' });
  // As the archive holds them, newest first (what the test before left in it: it restores one too, which can come back).
  const stored = [...(await archive())].sort((a, b) => b.closedAt - a.closedAt);
  const order = rows.map((title) => stored.findIndex((a) => a.title === title));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), `the newest first: ${rows.join(' | ')}`);
  await m.shoot(t, 'archive-list', { page });
  // The oldest listed, restored: it takes the new-tab page's place. (Not the Work dashboard: the next test restores it
  // from the palette, into its own space.)
  const last = order.filter((at) => stored[at].id !== 'ar-dash').at(-1);
  assert.ok(last != null, 'an archived tab to restore');
  const oldest = stored[last];
  await ui.locator('.archive-row', { hasText: oldest.title }).last().click();
  await m.until(async () => (await m.front())?.url === oldest.url, { what: `${oldest.title} back` });
  assert.ok(!(await m.tabs()).some((x) => x.id === nt.id && x.url.startsWith(m.newTabUrl())), 'the new-tab page made way');
  await m.until(async () => !(await archive()).some((a) => a.id === oldest.id), { what: 'out of the archive' });
});

test('an archived tab restored from the palette opens in its own space', async (t) => {
  // The test before's new-tab page closes after its restore (it made way), and the tab the browser then brings
  // forward is a switch: landing during this restore, it reads as the user going elsewhere, and the dashboard
  // stays behind (seen under the gate's load, 2026-11-10). So: once it's gone, and what's in front has settled.
  await m.until(async () => !(await m.tabs()).some((x) => x.url.startsWith(m.newTabUrl())), { what: 'the new-tab page gone' });
  let seen: number | null = null;
  await m.until(async () => { const id = await frontId(); const same = id != null && id === seen; seen = id; return same; }, { interval: 300, what: 'the tab in front settled' });
  m.shell.key('palette');
  await m.until(async () => (await palette(ui)).focused, { what: 'the palette' });
  await ui.keyboard.type('metrics');
  await m.until(async () => (await palette(ui)).rows.some((r) => r.id === 'archive:ar-dash'), { what: 'the archived dashboard' });
  await m.shoot(t, 'palette');
  await ui.click('.palette .result[data-id="archive:ar-dash"]');
  const dash = await m.until(async () => { const f = await m.front(); return f?.url === m.url('metrics.test', '/') && f; }, { what: 'the dashboard open' });
  assert.equal((await m.state()).tabSpace[dash.id], 'sp-work', 'in Work, where it was');
  await m.until(async () => (await sidebar(ui)).space === 'Work', { what: 'the window shows Work' });
  await m.until(async () => (await sidebar(ui)).tabs.some((r) => r.id === dash.id && r.active), { what: 'its row, highlighted' });
  await ui.click(chip('sp-home'));
  await m.until(async () => (await sidebar(ui)).space === 'Home', { what: 'Home again' });
});
