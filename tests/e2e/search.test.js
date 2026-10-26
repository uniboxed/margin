import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { launch, startServer, paletteSnapshot, waitFor, buildSafariProfile, gotoLauncher } from './helpers.js';

// Safari build: no search API, so Margin follows the engine Safari itself
// searches with, learned from Safari's address-bar search URLs (shared/search.js).
let ctx, dir, server;
before(async () => {
  dir = buildSafariProfile();
  ctx = await launch({ extensionPath: dir });
  server = await startServer();
  // Never hit real sites (search engines) from tests: the test server is http.
  await ctx.context.route(/^https:\/\//, (route) => route.fulfill({ contentType: 'text/html', body: '<title>engine</title>' }));
});
after(async () => {
  await ctx?.context.close();
  await server?.close();
  if (dir) rmSync(dirname(dir), { recursive: true, force: true });
});

const settings = () => ctx.worker.evaluate(() => chrome.storage.local.get('settings').then((s) => s.settings));
async function launcherSearch(text) {
  const page = await ctx.context.newPage();
  await gotoLauncher(page, ctx);
  await page.fill('#query', text);
  await page.press('#query', 'Enter');
  return page;
}

test('before Safari has searched: Safari\'s default engine (Google, with Safari\'s parameters)', async () => {
  assert.equal((await waitFor(settings)).safariSearch, null); // saved by the background on first run
  const page = await launcherSearch('hello world');
  await page.waitForURL('https://www.google.com/search?client=safari&rls=en&q=hello%20world&ie=UTF-8&oe=UTF-8');
  await page.close();
});

test('a search on an engine\'s own site doesn\'t change it; Safari\'s own search does, and Margin follows', async () => {
  const site = await ctx.context.newPage();
  await site.goto('https://duckduckgo.com/?q=typed+on+the+site');
  await site.waitForTimeout(500);
  assert.equal((await settings()).safariSearch, null, 'not from Safari\'s address bar');

  await site.goto('https://duckduckgo.com/?q=from+the+address+bar&t=osx&ia=web'); // what Safari opens
  const learned = await waitFor(async () => (await settings()).safariSearch);
  assert.equal(learned.name, 'DuckDuckGo');
  await site.close();

  const page = await launcherSearch('margin');
  await page.waitForURL('https://duckduckgo.com/?q=margin&t=osx&ia=web');
  await page.close();

  // The palette says where it searches, and goes there.
  const web = await ctx.context.newPage();
  await web.goto(`${server.base}/palette-search`);
  await web.waitForSelector('margin-sidebar-host', { state: 'attached' });
  await web.keyboard.press('Alt+KeyK');
  await web.keyboard.type('two words');
  const snap = await waitFor(async () => {
    const s = await paletteSnapshot(web);
    return s.ids.at(-1) === 'go' && s;
  });
  assert.equal(snap.titles.at(-1), 'Search for “two words”');
  await web.keyboard.press('ArrowUp');
  const opened = ctx.context.waitForEvent('page');
  await web.keyboard.press('Enter');
  const tab = await opened;
  await tab.waitForURL('https://duckduckgo.com/?q=two%20words&t=osx&ia=web');
  await tab.close();
  await web.close();

  // Settings shows which engine it follows; there's nothing to pick.
  const nt = await ctx.context.newPage();
  await gotoLauncher(nt, ctx);
  await nt.click('#settings summary');
  assert.match(await nt.textContent('#engine-info'), /Safari’s search engine: DuckDuckGo/);
  assert.equal(await nt.locator('#engine').count(), 0);
  await nt.close();
});

test('switching engines in Safari right after a Margin search in the same tab is still learned', async () => {
  // Margin searches (with the engine it knows) in this tab...
  const page = await launcherSearch('first');
  await page.waitForURL(/duckduckgo\.com\/\?q=first/);
  // ...then, in the same tab, a search from Safari's address bar with Yahoo.
  await page.goto('https://search.yahoo.com/search?ei=utf-8&fr=aaplw&p=second');
  await waitFor(async () => (await settings()).safariSearch?.name === 'Yahoo');
  const next = await launcherSearch('third');
  await next.waitForURL('https://search.yahoo.com/search?ei=utf-8&fr=aaplw&p=third');
  await next.close();
  await page.close();
});
