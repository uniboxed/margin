// The test site itself: every page loads whole in headless Chromium (no
// extension), nothing leaves the .test hosts, every picture and icon
// arrives, and the site's own behaviours (404s, ?fp, the sign-in redirect,
// the host rules) hold. The other e2e files rely on all of this.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { request } from 'node:http';
import { HOST_RULES, startSite } from './site/server.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

let site;
let browser;
let context;
const leaks = [];

before(async () => {
  site = await startSite();
  browser = await chromium.launch({ headless: true, args: ['--headless=new', `--host-resolver-rules=${HOST_RULES}`, '--autoplay-policy=no-user-gesture-required'] });
  context = await browser.newContext({ viewport: { width: 1200, height: 860 } });
  context.on('request', (r) => {
    const u = new URL(r.url());
    if (/^https?:$/.test(u.protocol) && !u.hostname.endsWith('.test')) leaks.push(r.url());
  });
});

after(async () => {
  await browser?.close();
  await site?.close();
});

// A plain request to one of the site's hosts (no browser).
const get = (host, path) =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: site.port, path, headers: { host: `${host}:${site.port}` } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    });
    req.on('error', reject);
    req.end();
  });

const pages = () => site.sites.flatMap((s) => (s.pages ?? []).map((p) => ({ site: s, ...p })));

test('every page loads whole: its title, its pictures, no errors, nothing outside the test hosts', async () => {
  const list = [{ site: site.sites[0], path: '/', title: 'Margin test site' }, ...pages()];
  assert.ok(list.length >= 10);
  for (const { site: s, path, title } of list) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const res = await page.goto(site.url(s.host, path), { waitUntil: 'load' });
    assert.equal(res.status(), 200, `${s.host}${path}`);
    assert.equal(await page.title(), title, `${s.host}${path} title`);
    // Lazy pictures too: scroll through the page.
    await page.evaluate(async () => {
      for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight) {
        scrollTo(0, y);
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
      }
      scrollTo(0, 0);
    });
    await page.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 8000 });
    const broken = await page.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).map((i) => i.src));
    assert.deepEqual(broken, [], `${s.host}${path} pictures`);
    assert.deepEqual(errors, [], `${s.host}${path} errors`);
    await page.close();
  }
  assert.deepEqual(leaks, []);
});

test('each site’s icon is what the page says it is', async () => {
  const want = {
    'dispatch.test': 'image/svg+xml',
    'shop.test': 'image/png',
    'docs.test': 'image/x-icon',
    'noir.test': 'image/svg+xml',
    'accounts.test': 'image/svg+xml',
    'harbor.test': 'image/x-icon',
  };
  for (const [host, type] of Object.entries(want)) {
    const s = site.sites.find((x) => x.host === host);
    const html = (await get(host, s.pages[0].path)).body;
    const href = /<link rel="icon"[^>]*href="([^"]+)"/.exec(html)?.[1];
    assert.ok(href, `${host} links an icon`);
    const res = await get(host, href);
    assert.equal(res.status, 200, `${host} ${href}`);
    assert.equal(res.type, type, `${host} ${href}`);
  }
});

test('any missing path is the site’s own 404 page', async () => {
  for (const s of site.sites) {
    const res = await get(s.host, '/missing');
    assert.equal(res.status, 404, s.host);
    const html = res.body;
    assert.match(html, /This page drifted away/);
    assert.ok(html.includes(`Page not found · ${s.name}`), s.host);
  }
});

test('?fp puts the first-frames recorder at the top of <head>', async () => {
  const page = await context.newPage();
  await page.goto(site.url('dispatch.test', '/2026/11/the-quiet-city?fp&late=300'));
  await page.waitForFunction(() => window.__fp?.frames.length >= 5);
  const head = await page.evaluate(() => document.head.firstElementChild.tagName);
  assert.equal(head, 'SCRIPT');
  await page.close();
});

test('signing in posts, redirects and lands signed in; a wrong password is the form again', async () => {
  const page = await context.newPage();
  await page.goto(site.url('accounts.test', '/signin'));
  await page.fill('#email', 'nora@field.test');
  await page.fill('#password', 'wrong');
  await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
  assert.match(await page.textContent('.alert'), /password isn’t right/);
  await page.fill('#password', 'correct horse');
  const [res] = await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
  assert.equal(new URL(page.url()).pathname, '/welcome');
  assert.equal(res.request().redirectedFrom()?.method(), 'POST');
  assert.match(await page.textContent('h1'), /Good morning, Nora/);
  await page.close();
});

test('the product page’s bag changes the title', async () => {
  const page = await context.newPage();
  await page.goto(site.url('shop.test', '/p/canvas-tote'));
  await page.click('#add');
  assert.equal(await page.title(), '(1) Bag · Canvas Tote — Common Goods');
  await page.close();
});

test('the host rules keep everything else off the network', async () => {
  const page = await context.newPage();
  await assert.rejects(page.goto('http://example.com/'), /ERR_NAME_NOT_RESOLVED/);
  await page.close();
  leaks.length = 0;
});

test('pages name no address outside the test site', async () => {
  for (const s of site.sites) {
    const bodies = Object.values(s.assets ?? {}).map((a) => String(a.body));
    for (const p of s.pages ?? []) bodies.push((await get(s.host, p.path)).body);
    for (const body of bodies) {
      const outside = [...body.matchAll(/(?:https?:)?\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1]).filter((h) => !h.endsWith('.test') && h !== 'www.w3.org');
      assert.deepEqual(outside, [], s.host);
    }
  }
});
