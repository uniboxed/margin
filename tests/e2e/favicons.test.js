import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { launch, evalInShadow, waitFor, buildSafariProfile, gotoLauncher, readState } from './helpers.js';

const PNG = readFileSync(new URL('../../extension/icons/icon-48.png', import.meta.url));
// Icon fetching is Safari's (Chrome provides tab.favIconUrl), so these run
// the Safari profile.
let ctx, safariBuild;
const servers = [];

// One server per case: icons are stored per site (origin).
async function site(routes) {
  const server = createServer((req, res) => {
    const route = routes[req.url];
    if (!route) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': route.type }).end(route.body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
const page = (title, head = '') => ({ type: 'text/html', body: `<!doctype html><title>${title}</title>${head}<h1>${title}</h1>` });

before(async () => {
  safariBuild = buildSafariProfile();
  ctx = await launch({ extensionPath: safariBuild });
});
after(async () => {
  await ctx?.context.close();
  for (const s of servers) s.close();
  if (safariBuild) rmSync(dirname(safariBuild), { recursive: true, force: true });
});

const favicons = () => ctx.worker.evaluate(() => chrome.storage.local.get('favicons').then((s) => s.favicons ?? {}));
async function visit(url) {
  const p = await ctx.context.newPage();
  await p.goto(url);
  await p.waitForSelector('margin-sidebar-host', { state: 'attached' });
  return p;
}
const pngSize = (dataUrl) => {
  const b = Buffer.from(dataUrl.split(',')[1], 'base64');
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

test('a page’s own icon is fetched once, shrunk to 32×32 and stored per site', async () => {
  const origin = await site({ '/': page('with-icon', '<link rel="icon" href="/icon.png" sizes="48x48">'), '/icon.png': { type: 'image/png', body: PNG } });
  const p = await visit(`${origin}/`);
  const entry = await waitFor(async () => (await favicons())[origin]);
  assert.match(entry.data, /^data:image\/png;base64,/);
  assert.deepEqual(pngSize(entry.data), [32, 32]);
  assert.equal(entry.href, `${origin}/icon.png`);
  await p.close();
});

test('no icon link: falls back to /favicon.ico', async () => {
  const origin = await site({ '/': page('no-link'), '/favicon.ico': { type: 'image/x-icon', body: PNG } });
  const p = await visit(`${origin}/`);
  const entry = await waitFor(async () => (await favicons())[origin]);
  assert.match(entry.data, /^data:image\/png;base64,/);
  await p.close();
});

test('not an image (HTML served as the icon) is rejected; letter avatar stays', async () => {
  const origin = await site({ '/': page('fake-icon', '<link rel="icon" href="/fake.png">'), '/fake.png': { type: 'image/png', body: '<!doctype html>oops' } });
  const p = await visit(`${origin}/`);
  await p.waitForTimeout(1500);
  assert.equal((await favicons())[origin], undefined);
  await p.close();
});

test('another host’s icon over plain http on a local address is refused', async () => {
  const iconHost = await site({ '/x.png': { type: 'image/png', body: PNG } });
  const port = new URL(iconHost).port;
  const origin = await site({ '/': page('foreign-icon', `<link rel="icon" href="http://localhost:${port}/x.png">`) });
  const p = await visit(`${origin}/`);
  await p.waitForTimeout(1500);
  assert.equal((await favicons())[origin], undefined, 'not fetched (and /favicon.ico is a 404 here)');
  await p.close();
});

test('closed pins show the stored icon (as Safari would, without favIconUrl)', async () => {
  const origin = await site({ '/': page('pinned-icon', '<link rel="icon" href="/i.png">'), '/i.png': { type: 'image/png', body: PNG } });
  const p = await visit(`${origin}/`);
  await waitFor(async () => (await favicons())[origin]);
  const nt = await ctx.context.newPage();
  await gotoLauncher(nt, ctx);
  const tabId = await ctx.worker.evaluate((o) => chrome.tabs.query({}).then((ts) => ts.find((t) => t.url.startsWith(o)).id), origin);
  const space = (await readState(ctx.worker, 'tabSpace'))[tabId];
  const windowId = await nt.evaluate(() => chrome.tabs.getCurrent().then((t) => t.windowId));
  await nt.evaluate(([id, w, sp]) => chrome.runtime.sendMessage({ type: 'pinTab', tabId: id }).then(() =>
    chrome.runtime.sendMessage({ type: 'setSpace', windowId: w, spaceId: sp, bringTab: false })), [tabId, windowId, space]);
  await p.close(); // pin is now closed: no tab, so no browser favIconUrl
  const other = await visit(`${await site({ '/': page('viewer') })}/`);
  const src = await waitFor(() => evalInShadow(other, 'margin-sidebar-host', function () {
    return [...this.querySelectorAll('.pin')].find((n) => n.textContent.includes('pinned-icon'))?.querySelector('img')?.src;
  }));
  assert.match(src, /^data:image\/png;base64,/);
  await other.close();
  await nt.close();
});
