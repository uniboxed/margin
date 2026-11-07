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
const get = (host, path, encoding = 'utf8') =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: site.port, path, headers: { host: `${host}:${site.port}` } }, (res) => {
      let body = '';
      res.setEncoding(encoding);
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    });
    req.on('error', reject);
    req.end();
  });

// The slow report, fast: for checks that only read its HTML.
const quick = (path) => (path === '/report' ? '/report?ms=200' : path);

const pages = () => site.sites.flatMap((s) => (s.pages ?? []).map((p) => ({ site: s, ...p })));

test('every page loads whole: its title, its pictures, no errors, nothing outside the test hosts', async () => {
  const list = [{ site: site.sites[0], path: '/', title: 'Margin test site' }, ...pages()];
  assert.ok(list.length >= 10);
  for (const { site: s, path, title, ticks } of list) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const res = await page.goto(site.url(s.host, path), { waitUntil: 'load' });
    assert.equal(res.status(), 200, `${s.host}${path}`);
    // A ticking title (the timer) has moved on by now: same shape, not the same time.
    if (ticks) assert.match(await page.title(), new RegExp(`^\\d\\d:\\d\\d${title.slice(5).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), `${s.host}${path} title`);
    else assert.equal(await page.title(), title, `${s.host}${path} title`);
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
    // Nothing spills out of its grid column (a card pushed wide by its chart, say).
    const spills = await page.evaluate(() => [...document.querySelectorAll('*')].filter((el) => getComputedStyle(el).display.endsWith('grid')).flatMap((grid) => {
      const g = grid.getBoundingClientRect();
      const right = g.right - parseFloat(getComputedStyle(grid).paddingRight);
      return [...grid.children].filter((c) => getComputedStyle(c).position !== 'absolute' && getComputedStyle(c).position !== 'fixed' && c.getBoundingClientRect().width > 0 && c.getBoundingClientRect().right > right + 1)
        .map((c) => `${grid.className || grid.localName} > ${c.className || c.localName}: ${Math.round(c.getBoundingClientRect().right)} > ${Math.round(right)}`);
    }));
    assert.deepEqual(spills, [], `${s.host}${path}: grid items inside their grid`);
    await page.close();
  }
  assert.deepEqual(leaks, []);
});

test('each site’s icon is what the page says it is', async () => {
  const want = {
    'dispatch.test': 'image/svg+xml',
    'shop.test': 'image/png',
    'reel.test': 'image/png',
    'docs.test': 'image/x-icon',
    'murmur.test': 'image/svg+xml',
    'noir.test': 'image/svg+xml',
    'accounts.test': 'image/svg+xml',
    'slow.test': 'image/png',
    'harbor.test': 'image/x-icon',
    'radio.test': 'image/x-icon',
    'app.test': 'image/svg+xml',
  };
  const magic = { 'image/png': '\x89PNG', 'image/x-icon': '\0\0\x01\0', 'image/svg+xml': '<svg' };
  for (const [host, type] of Object.entries(want)) {
    const s = site.sites.find((x) => x.host === host);
    const html = (await get(host, quick(s.pages[0].path))).body;
    const href = /<link rel="icon"[^>]*href="([^"]+)"/.exec(html)?.[1];
    assert.ok(href, `${host} links an icon`);
    const res = await get(host, href, 'latin1');
    assert.equal(res.status, 200, `${host} ${href}`);
    assert.equal(res.type, type, `${host} ${href}`);
    assert.ok(res.body.startsWith(magic[type]), `${host} ${href} is a real ${type}`);
  }
  // No link: /favicon.ico (metrics), or nothing at all (embed, a letter).
  for (const host of ['metrics.test', 'embed.test']) assert.doesNotMatch((await get(host, '/')).body, /rel="icon"/, host);
  assert.ok((await get('metrics.test', '/favicon.ico', 'latin1')).body.startsWith('\0\0\x01\0'));
  assert.equal((await get('embed.test', '/favicon.ico')).status, 404);
  // A bad icon: said to be a PNG, an HTML page in fact.
  const bad = await get('maps.test', '/pin.png');
  assert.equal(bad.type, 'image/png');
  assert.match(bad.body, /^<!doctype html>/);
  // data: icons, redrawn by the page.
  for (const [host, path] of [['post.test', '/inbox'], ['focus.test', '/']]) {
    const page = await context.newPage();
    await page.goto(site.url(host, path));
    assert.match(await page.getAttribute('link[rel=icon]', 'href'), /^data:image\/png;base64,/, host);
    await page.close();
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

test('the report arrives in parts over about 3 s', async () => {
  const t0 = Date.now();
  const firstAt = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: site.port, path: '/report', headers: { host: `slow.test:${site.port}` } }, (res) => {
      let first;
      res.on('data', () => (first ??= Date.now() - t0));
      res.on('end', () => resolve([first, Date.now() - t0]));
    });
    req.on('error', reject);
    req.end();
  });
  const [first, last] = firstAt;
  assert.ok(first < 500, `first part at ${first} ms`);
  assert.ok(last >= 2200, `last part at ${last} ms`);
  const page = await context.newPage();
  const start = Date.now();
  await page.goto(site.url('slow.test', '/report'), { waitUntil: 'load' });
  assert.ok(Date.now() - start >= 2800, 'load comes with the last pictures');
  assert.equal(await page.locator('.sec').count(), 4);
  await page.close();
});

test('the app moves by pushState, and its Reports route takes 700 ms through the Navigation API', async () => {
  const page = await context.newPage();
  await page.goto(site.url('app.test', '/'));
  assert.equal(await page.title(), 'Home · Orbit');
  await page.evaluate(() => (window.__kept = true));
  await page.click('a[href="/projects"]');
  assert.equal(new URL(page.url()).pathname, '/projects');
  assert.equal(await page.title(), 'Projects · Orbit');
  const start = Date.now();
  await page.click('.nav a[href="/reports"]');
  await page.waitForSelector('.report-ready');
  assert.ok(Date.now() - start >= 650, 'the slow route');
  assert.equal(new URL(page.url()).pathname, '/reports');
  assert.equal(await page.evaluate(() => window.__kept), true, 'the same document all along');
  await page.goBack();
  assert.equal(await page.title(), 'Projects · Orbit');
  await page.close();
});

test('the mail draft guards the page; opening an unread message lowers the count', async () => {
  const page = await context.newPage();
  await page.goto(site.url('post.test', '/inbox'));
  assert.equal(await page.title(), 'Inbox (4) — Post');
  await page.click('.m[data-i="1"]');
  assert.equal(await page.title(), 'Inbox (3) — Post');
  await page.click('#compose');
  await page.fill('#c-body', 'Hi Nora');
  const asked = new Promise((resolve) => page.once('dialog', async (d) => { resolve(d.type()); await d.accept(); }));
  await page.close({ runBeforeUnload: true });
  assert.equal(await asked, 'beforeunload');
});

test('the feed loads more as it nears the end; the timer counts down', async () => {
  const page = await context.newPage();
  await page.goto(site.url('murmur.test', '/home'));
  assert.equal(await page.locator('.post').count(), 8);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 3000);
  await page.waitForFunction(() => document.querySelectorAll('.post').length >= 16);
  await page.goto(site.url('focus.test', '/?from=90'));
  assert.equal(await page.title(), '01:30 · Focus');
  await page.waitForFunction(() => document.title === '01:29 · Focus');
  await page.close();
});

test('the video and the tune play', async () => {
  const page = await context.newPage();
  await page.goto(site.url('reel.test', '/watch'));
  await page.click('#big-play');
  await page.waitForFunction(() => document.querySelector('video').currentTime > 0.2);
  await page.goto(site.url('radio.test', '/'));
  await page.click('#play');
  await page.waitForFunction(() => document.querySelector('audio').currentTime > 0.2);
  assert.equal(await page.getAttribute('#play', 'aria-label'), 'Pause');
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
    for (const p of s.pages ?? []) bodies.push((await get(s.host, quick(p.path))).body);
    for (const body of bodies) {
      const outside = [...body.matchAll(/(?:https?:)?\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1]).filter((h) => !h.endsWith('.test') && h !== 'www.w3.org');
      assert.deepEqual(outside, [], s.host);
    }
  }
});
