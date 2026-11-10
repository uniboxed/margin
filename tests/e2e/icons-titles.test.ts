// Site icons and titles, from real-looking pages to the overlay. Safari gives
// extensions no favIconUrl, so the Safari profile fetches each page's own
// icon once per site, shrinks it to 32×32 where it can, and keeps it as a
// data: URL (background/site-icons.ts). Every kind the test site has: SVG,
// PNG, ICO, the /favicon.ico fallback, a data: URL, none (a letter), and a
// bad one (an HTML page served as the icon). Titles that change reach the
// overlay, also from a tab that isn't in front; long titles are cut.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMargin, type Margin } from './harness/margin.ts';
import { SPACES } from './harness/seed.ts';
import { sidebar, palette, tabRow, pinRow } from './harness/ui.ts';
import type { Page } from 'playwright';
import type { Pin } from '../../types/margin.d.ts';

let m: Margin;
let ui: Page;

// (`!`: a test's front tab is there; were it not, the id is still undefined and the test fails where it's used.)
const frontId = async (): Promise<number> => (await m.front())?.id!;
const favicons = async () => (await m.stored('favicons')).favicons ?? {};
const origin = (host: string) => new URL(m.url(host, '/')).origin;
const pngSize = (dataUrl: string) => { const b = Buffer.from(dataUrl.split(',')[1], 'base64'); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
const row = async (id: number | undefined) => (await sidebar(ui)).tabs.find((r) => r.id === id);

// Each site, what its icon is, and what Margin should keep and draw.
// (`tab`: each site's tab, once it's open.)
const KINDS: { host: string, path: string, kind: string, stored: RegExp | null, size?: number[], href?: string, tab?: number }[] = [
  { host: 'dispatch.test', path: '/2026/11/the-quiet-city', kind: 'SVG', stored: /^data:image\/svg\+xml/ },
  { host: 'shop.test', path: '/', kind: 'PNG (192 px)', stored: /^data:image\/png/, size: [32, 32] },
  { host: 'docs.test', path: '/guide/getting-started', kind: 'ICO', stored: /^data:image\/png/, size: [32, 32] },
  { host: 'metrics.test', path: '/', kind: 'no link: /favicon.ico', stored: /^data:image\//, href: '/favicon.ico' },
  { host: 'focus.test', path: '/?paused', kind: 'a data: URL the page draws', stored: /^data:image\// },
  { host: 'embed.test', path: '/', kind: 'none', stored: null },
  { host: 'maps.test', path: '/', kind: 'an HTML page as /pin.png', stored: null },
];

before(async () => {
  m = await startMargin({ name: 'icons', seed: { spaces: SPACES, settings: { sidebarPinnedOpen: true } } });
  ui = await m.ui();
  for (const k of KINDS) {
    await m.open(k.host, k.path);
    k.tab = await frontId();
  }
});
after(async () => { await m?.close(); });

test('each kind of site icon is kept per site and drawn on its row', async (t) => {
  for (const k of KINDS.filter((x) => x.stored)) {
    const entry = await m.until(async () => (await favicons())[origin(k.host)], { timeout: 8000, what: `${k.host}'s icon (${k.kind})` });
    assert.match(entry.data, k.stored!, `${k.host}: ${k.kind}`);
    if (k.size) assert.deepEqual(pngSize(entry.data), k.size, `${k.host}: shrunk to 32 × 32`);
    if (k.href) assert.equal(entry.href, `${origin(k.host)}${k.href}`);
    const r = await m.until(async () => { const x = await row(k.tab); return x?.icon?.kind === 'image' && x.icon.loaded && x; }, { what: `${k.host}'s icon drawn` });
    assert.match((r.icon as { src: string }).src, /^data:image\//, 'drawn from the kept data: URL (the overlay loads nothing from the web)');
  }
  // None, or a bad one: nothing kept, the row shows the site's letter.
  await new Promise((r) => setTimeout(r, 1000));
  const kept = await favicons();
  for (const k of KINDS.filter((x) => !x.stored)) {
    assert.equal(kept[origin(k.host)], undefined, `${k.host} (${k.kind}): nothing kept`);
    const r = await row(k.tab);
    assert.equal(r!.icon?.kind, 'letter', `${k.host}: a letter`);
  }
  assert.deepEqual(m.shell.blocked, []);
  await m.shoot(t, 'icons');
});

test('a site\'s icon is fetched once: a second page of the site uses the kept one', async () => {
  const before = (await favicons())[origin('shop.test')];
  await m.open('shop.test', '/p/canvas-tote');
  const tote = await frontId();
  await m.until(async () => (await row(tote))?.icon?.kind === 'image', { what: 'the product\'s icon drawn' });
  await new Promise((r) => setTimeout(r, 500));
  const after = (await favicons())[origin('shop.test')];
  assert.equal(after.at, before.at, 'not fetched again');
  assert.equal(after.data, before.data);
});

test('another host\'s icon over plain http is refused', async () => {
  // A page on the portfolio's host whose icon is the shop's, over http (routed locally).
  const url = m.url('noir.test', '/elsewhere');
  await m.context.route(url, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><title>Borrowed icon</title><link rel="icon" href="${m.url('shop.test', '/icon-192.png')}"></head><body style="font:16px system-ui;padding:40px">A page whose icon is another site's.</body></html>` }));
  await m.open(url);
  const tab = await frontId();
  await m.until(async () => (await row(tab))?.title === 'Borrowed icon', { what: 'its row' });
  await new Promise((r) => setTimeout(r, 1200));
  const kept = (await favicons())[origin('noir.test')];
  assert.ok(!kept || !kept.href.startsWith(origin('shop.test')), `not the other host's: ${kept?.href}`);
  await m.context.unroute(url);
});

test('a closed pin draws its site\'s kept icon', async (t) => {
  const res = await m.shell.request('pinTab', { tabId: KINDS[2].tab }, m.shell.frontWindowId());
  assert.equal(res.ok, true);
  const pin = await m.until(async () => (await m.stored('pins')).pins?.find((p: Pin) => p.url.startsWith(origin('docs.test'))), { what: 'the docs pinned' });
  await m.bg((id) => chrome.tabs.remove(id), KINDS[2].tab!);
  const drawn = await m.until(async () => (await sidebar(ui)).pins.find((p) => p.id === pin.id && !p.open), { what: 'the pin, closed' });
  assert.equal(drawn.icon?.kind, 'image');
  assert.equal(drawn.icon.src, (await favicons())[origin('docs.test')].data);
  await ui.hover(pinRow(pin.id));
  await m.shoot(t, 'closed-pin');
});

test('titles that change reach the overlay, also from a tab not in front', async (t) => {
  // The feed's unread count, cleared on the page.
  const feed = await m.open('murmur.test', '/home');
  const feedTab = await frontId();
  await m.until(async () => (await row(feedTab))?.title === '(3) Murmur', { what: 'the feed\'s count' });
  await feed.click('#notif');
  await m.until(async () => (await row(feedTab))?.title === 'Murmur', { what: 'the count cleared' });

  // The timer counts down in its title each second, while another tab is in front.
  await m.open('focus.test', '/?from=600');
  const timerTab = await frontId();
  await m.until(async () => /^\d\d:\d\d · Focus$/.test((await row(timerTab))?.title ?? ''), { what: 'the timer\'s title' });
  await ui.click(tabRow(feedTab));
  await m.until(async () => (await frontId()) === feedTab, { what: 'the feed in front' });
  const first = (await row(timerTab))!.title;
  const next = await m.until(async () => { const x = (await row(timerTab))?.title; return x !== first && x; }, { timeout: 5000, what: 'the hidden timer\'s title moving on' });
  assert.match(next, /^\d\d:\d\d · Focus$/);
  await m.shoot(t, 'titles');
});

test('a long title is cut in the row and in the palette, whole in its tooltip', async (t) => {
  await m.open('dispatch.test', '/longread');
  const tab = await frontId();
  const title = (await m.tabs()).find((x) => x.id === tab)!.title!;
  assert.ok(title.length >= 150, `a long title (${title.length})`);
  await m.until(async () => (await row(tab))?.title === title, { what: 'the row has the whole title' });
  const cut = await ui.$eval(`${tabRow(tab)} .title`, (el) => ({ scroll: el.scrollWidth, client: el.clientWidth, overflow: getComputedStyle(el).textOverflow, rowRight: el.closest('a')!.getBoundingClientRect().right, right: el.getBoundingClientRect().right }));
  assert.ok(cut.scroll > cut.client, 'wider than its row');
  assert.equal(cut.overflow, 'ellipsis');
  assert.ok(cut.right <= cut.rowRight, 'kept inside the row');

  m.shell.key('palette');
  await m.until(async () => (await palette(ui)).focused, { what: 'the palette' });
  await ui.keyboard.type('river remembers');
  const p = await m.until(async () => { const x = await palette(ui); return x.rows.some((r) => r.id === `tab:${tab}`) && x; }, { what: 'the long read in the palette' });
  assert.ok(p.rows.find((r) => r.id === `tab:${tab}`));
  const inPalette = await ui.$eval(`.palette .result[data-id="tab:${tab}"]`, (el) => ({ title: el.getAttribute('title'), scroll: el.querySelector('.title')!.scrollWidth, client: el.querySelector('.title')!.clientWidth, height: el.getBoundingClientRect().height }));
  assert.equal(inPalette.title, title, 'the whole title as its tooltip');
  assert.ok(inPalette.scroll > inPalette.client && inPalette.height < 80, 'cut on one line');
  await m.shoot(t, 'long-title');
  await ui.keyboard.press('Escape');
});
