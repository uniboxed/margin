// Screenshots of every page of the test site, for a person to look at after
// changing it. Headless Chromium, no extension, the site's own host rules.
//
//   node tests/e2e/site/shoot.mjs [out dir] [name filter]
//
// Out dir: $MARGIN_E2E_SHOTS/site, else <tmp>/margin-e2e-shots/site. Prints
// any request that left the test hosts and any page error.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOST_RULES, startSite } from './server.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const out = process.argv[2] || join(process.env.MARGIN_E2E_SHOTS || join(tmpdir(), 'margin-e2e-shots'), 'site');
const only = process.argv[3];
mkdirSync(out, { recursive: true });

// Shots after doing something on a page.
const EXTRA = {
  'dispatch.test/2026/11/the-quiet-city': [['scrolled', (p) => p.mouse.wheel(0, 2600)]],
  'shop.test/p/canvas-tote': [['added', (p) => p.click('#add')]],
  'shop.test/': [['carousel', async (p) => { await p.click('.arrows button[data-dir="1"]'); await p.mouse.wheel(0, 500); }]],
  'murmur.test/home': [['more', async (p) => { for (let i = 0; i < 6; i++) await p.mouse.wheel(0, 2500); await p.waitForFunction(() => document.querySelectorAll('.post').length > 12); }]],
  'post.test/inbox': [['compose', async (p) => { await p.click('#compose'); await p.fill('#c-to', 'nora@field.test'); await p.fill('#c-body', 'Hi Nora,\n\nThe draft for Thursday is attached.'); }]],
  'harbor.test/': [['modal', (p) => p.click('#open-dates')], ['scrolled', async (p) => { await p.keyboard.press('Escape'); await p.click('#cookie-ok'); await p.mouse.wheel(0, 1400); }]],
  'noir.test/': [['work', (p) => p.mouse.wheel(0, 900)]],
  'docs.test/guide/getting-started': [['scrolled', (p) => p.mouse.wheel(0, 1800)]],
  'accounts.test/signin': [['error', async (p) => { await p.fill('#email', 'nora'); await p.click('button[type=submit]'); }], ['signed-in', async (p) => { await p.fill('#email', 'nora@field.test'); await p.fill('#password', 'correct horse'); await Promise.all([p.waitForURL('**/welcome'), p.click('button[type=submit]')]); }]],
  'app.test/': [['projects', (p) => p.click('a[href="/projects"]')], ['report', async (p) => { await p.click('a[href="/reports"]'); await p.waitForSelector('.report-ready', { timeout: 3000 }); }]],
  'radio.test/': [['playing', async (p) => { await p.click('#play'); await p.waitForTimeout(600); }]],
  'reel.test/watch': [['playing', async (p) => { await p.evaluate(() => document.querySelector('video').play()); await p.waitForTimeout(1500); }]],
};

const site = await startSite();
const browser = await chromium.launch({ headless: true, args: ['--headless=new', `--host-resolver-rules=${HOST_RULES}`, '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1200, height: 860 }, deviceScaleFactor: 1 });
const leaks = [];
context.on('request', (r) => {
  const u = new URL(r.url());
  if (/^https?:$/.test(u.protocol) && !u.hostname.endsWith('.test') && u.hostname !== '127.0.0.1') leaks.push(r.url());
});

const pages = [{ host: 'margin.test', path: '/' }, ...site.sites.flatMap((s) => (s.pages ?? []).map((p) => ({ host: s.host, path: p.path })))];
pages.push({ host: 'shop.test', path: '/missing' }, { host: 'noir.test', path: '/missing' }, { host: 'docs.test', path: '/missing' });

let n = 0;
for (const { host, path } of pages) {
  const key = `${host}${path}`;
  const name = key.replace(/[^\w.-]+/g, '_').replace(/_$/, '');
  if (only && !key.includes(only)) continue;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !(path === '/missing' && m.text().includes('404')) && errors.push(m.text()));
  try {
    await page.goto(site.url(host, path), { waitUntil: 'load', timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(out, `${name}.png`) });
    n++;
    for (const [label, act] of EXTRA[key] ?? []) {
      await act(page);
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(out, `${name}--${label}.png`) });
      n++;
    }
  } catch (err) {
    errors.push(String(err.message).split('\n')[0]);
  }
  if (errors.length) console.log(`${key}: ${errors.join(' | ')}`);
  await page.close();
}
console.log(`${n} screenshots in ${out}`);
if (leaks.length) console.log(`left the test hosts: ${[...new Set(leaks)].join(', ')}`);
await browser.close();
await site.close();
