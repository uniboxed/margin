// Loading, as the overlay draws it (background/page-loads.ts: the copy's
// `push loading`, the row's busy mark): a report that streams in over 3 s;
// a page being left, shown at once, long before a slow server answers; a
// reload; a page that stays after all (a 204, a mail draft's "Leave page?"),
// whose loading goes. (The old loader.test.js read the in-page pill.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMargin } from './harness/margin.ts';
import { SPACES } from './harness/seed.ts';
import { sidebar } from './harness/ui.ts';

let m;
let ui;

const frontId = async () => (await m.front())?.id;
const row = async (id) => (await sidebar(ui)).tabs.find((r) => r.id === id) ?? null;
const loadingPushes = (from) => m.shell.received.slice(from).filter((x) => x.k === 'push' && x.msg?.type === 'loading').map((x) => ({ ...x.msg, at: x.at }));
const settle = async (id) => m.until(async () => (await row(id)) && !(await row(id)).busy, { timeout: 8000, what: `tab ${id} not busy` });

before(async () => {
  m = await startMargin({ name: 'loading', seed: { spaces: SPACES, settings: { sidebarPinnedOpen: true } } });
  ui = await m.ui();
});
after(async () => { await m?.close(); });

test('a report that streams in: its row is busy until its last picture is in', async (t) => {
  const page = await m.context.newPage();
  const loaded = page.goto(m.url('slow.test', '/report?ms=3000'), { waitUntil: 'load' });
  await page.waitForSelector('#loading', { state: 'attached' });
  const tab = await m.until(async () => { const f = await m.front(); return f?.url.includes('slow.test') && f; }, { what: 'the report in front' });
  await m.until(async () => (await row(tab.id))?.busy, { what: 'its row busy' });
  await page.waitForSelector('section.sec');
  assert.equal((await row(tab.id)).busy, true, 'still busy with half the report in');
  await m.shoot(t, 'half-in', { page });
  await loaded;
  await settle(tab.id);
  await m.shoot(t, 'all-in', { page });
});

test('leaving a page shows loading at once, long before the slow server answers', async (t) => {
  const page = await m.open('docs.test', '/guide/getting-started');
  const tab = await frontId();
  await settle(tab);
  const from = m.shell.received.length;
  const started = Date.now();
  await page.evaluate((to) => setTimeout(() => { location.href = to; }, 20), m.url('docs.test', '/guide/installation?wait=1500'));
  await m.until(async () => (await row(tab))?.busy, { timeout: 1000, what: 'busy while the server takes 1.5 s' });
  const seenAfter = Date.now() - started;
  const was = (await m.tabs()).find((x) => x.id === tab);
  assert.match(was.url, /getting-started/, 'still the old page: the next one hasn\'t come');
  assert.ok(seenAfter < 1000, `shown ${seenAfter} ms after leaving`);
  assert.ok(loadingPushes(from).some((p) => p.tabIds.includes(tab)), 'the copy pushed it');
  await m.shoot(t, 'leaving');
  await page.waitForURL(/installation/);
  await settle(tab);
});

test('the same for a reload', async () => {
  const page = await m.open('shop.test', '/?wait=1200');
  const tab = await frontId();
  await settle(tab);
  const reload = page.reload();
  await m.until(async () => (await row(tab))?.busy, { timeout: 1000, what: 'busy during the reload' });
  await reload;
  await settle(tab);
});

test('a page that stays after all (a 204): loading goes once the person does something there', async () => {
  const page = await m.open('noir.test', '/');
  const tab = await frontId();
  await settle(tab);
  await page.evaluate((to) => setTimeout(() => { location.href = to; }, 20), m.url('noir.test', '/work?nocontent'));
  // Busy at once (the page said it's leaving); the browser may end it itself when nothing comes.
  await m.until(async () => (await row(tab))?.busy, { timeout: 1000, what: 'busy on leaving' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(new URL(page.url()).pathname, '/', 'the page stayed');
  await page.mouse.click(700, 400);
  await settle(tab);
});

test('a mail draft\'s "Leave page?": staying takes the loading back', async (t) => {
  const page = await m.open('post.test', '/inbox');
  const tab = await frontId();
  await settle(tab);
  await page.click('#compose');
  await page.locator('#c-body').pressSequentially('Back on Monday.');
  let asked = 0;
  page.on('dialog', (d) => { asked++; void d.dismiss(); }); // "Stay on page"
  const from = m.shell.received.length;
  await page.evaluate((to) => setTimeout(() => { location.href = to; }, 20), m.url('harbor.test', '/'));
  await m.until(() => asked > 0, { what: 'the page asking before it goes' });
  await m.until(() => loadingPushes(from).some((p) => p.tabIds.includes(tab)), { what: 'loading said on leaving' });
  await settle(tab);
  assert.match(await page.title(), /Inbox/, 'the mail stayed');
  assert.equal(await page.inputValue('#c-body'), 'Back on Monday.', 'with its draft');
  await m.shoot(t, 'stayed', { page });
});
