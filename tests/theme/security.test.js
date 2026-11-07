// The security suite's live part (docs/phase6-themes.md §4), in Playwright's
// WebKit (Safari's engine) and Chromium, headless, every request refused and
// watched. Part of npm run test:theme and npm run test:security.
//
// - every built-in theme, and every package named in MARGIN_THEMES, loads as
//   the overlay loads one and draws hostile data (markup titles, script
//   addresses, icons from elsewhere, the palette and Settings open): nothing
//   runs, nothing loads, the DOM audit finds nothing;
// - Phase 6's template and stylesheet payloads, rendered in the document;
//   ids named like the overlay's globals leave those globals as they were;
// - the overlay's policy on its own (app/shell/OverlayWebView.swift
//   OverlaySchemeHandler.policy, read from the source): a page served with it
//   and the payloads put in raw, with no sanitizer at all, runs no script of
//   theirs and makes no request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium, webkit } from 'playwright';
import { harnessScript } from './package.js';
import { HTML_PAYLOADS, CSS_PAYLOADS, TEMPLATE_PAYLOADS_2, CSS_PAYLOADS_2, CSS_KEPT_2 } from './payloads.js';
import { suitePackages } from '../security/packages.js';

const ENGINES = [['webkit', webkit], ['chromium', chromium]];
const MANIFEST = JSON.stringify({ format: 2, id: 'payload', name: 'Payload', version: '1.0.0' });
const script = harnessScript();
const b64 = (pkg) => ({ ...pkg, files: Object.fromEntries(Object.entries(pkg.files).map(([k, v]) => [k, Buffer.from(v).toString('base64')])) });
const packages = suitePackages().map((p) => ({ label: p.label, pkg: b64(p.read()) }));
const swift = readFileSync(new URL('../../app/shell/OverlayWebView.swift', import.meta.url), 'utf8');
const POLICY = /static let policy = "([^"]+)"/.exec(swift)?.[1];

async function open(browser, { viewport = { width: 1440, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const seen = { requests: [], dialogs: [], errors: [] };
  page.on('request', (r) => { if (!/^(data|blob|about):/.test(r.url())) seen.requests.push(r.url()); });
  page.on('dialog', (d) => { seen.dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  page.on('pageerror', (e) => seen.errors.push(e.message));
  await context.route('**/*', (route) => route.abort());
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
  await page.addScriptTag({ content: script });
  return { context, page, seen };
}
const settle = async (page) => {
  await page.waitForTimeout(800);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
};

test('the overlay\'s policy is PLAN.md §4\'s', () => {
  assert.equal(POLICY, "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'");
});

for (const [name, engine] of ENGINES) {
  test(`security suite in ${name}`, async (t) => {
    const browser = await engine.launch({ headless: true });
    try {
      for (const { label, pkg } of packages) {
        await t.test(`${label}: loads as the overlay loads it and draws hostile data; nothing runs or loads`, async () => {
          const s = await open(browser);
          const loaded = await s.page.evaluate((p) => T.loadPackage(p), pkg);
          assert.equal(loaded.ok, true, JSON.stringify(loaded.errors));
          assert.equal(loaded.removed, 0, 'nothing removed');
          assert.deepEqual(loaded.fontErrors, []);
          await s.page.evaluate(() => T.mountRuntime({ container: 'document' }));
          const r = await s.page.evaluate(() => T.rtHostile());
          assert.deepEqual(r.audit, [], 'the DOM audit finds nothing');
          await s.page.evaluate(() => { T.rtSetUi({ palette: { open: false, query: '' } }); });
          await s.page.evaluate(() => T.rtSetUi({ settingsOpen: true }));
          await settle(s.page);
          assert.deepEqual(await s.page.evaluate(() => T.tripped()), []);
          assert.deepEqual(s.seen.requests, []);
          assert.deepEqual(s.seen.dialogs, []);
          assert.deepEqual(s.seen.errors, []);
          await s.context.close();
        });
      }

      await t.test('Phase 6 payloads in the document: nothing survives, nothing loads, the globals stay', async () => {
        const s = await open(browser);
        const before = await s.page.evaluate(() => T.globals());
        const out = await s.page.evaluate(([m, a, b]) => T.runPayloads(m, a, b), [MANIFEST, TEMPLATE_PAYLOADS_2.map(([n, f]) => [n, f]), [...CSS_PAYLOADS_2, ...CSS_KEPT_2]]);
        for (const r of out) {
          if (r.violations) assert.deepEqual(r.violations, [], r.name);
          if (r.css != null) assert.doesNotMatch(r.css, /evil\.test/, r.name);
        }
        assert.deepEqual(await s.page.evaluate(() => T.globals()), before, 'ids named like globals changed none');
        assert.equal(await s.page.evaluate(() => document.querySelectorAll('[id="webkit"],[id="marginApp"],[id="browser"],[id="T"]').length), 0);
        await settle(s.page);
        assert.deepEqual(await s.page.evaluate(() => T.tripped()), []);
        assert.deepEqual(s.seen.requests, []);
        await s.context.close();
      });

      const rawPage = async (policy) => {
        const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
        const page = await context.newPage();
        const requests = [];
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        const ORIGIN = 'https://overlay.test';
        const tripwire = 'window.__tripped=[];window.__trip=function(n){window.__tripped.push(String(n))};window.alert=function(m){window.__tripped.push("alert:"+m)};';
        // The raw payloads, as the page's own script would put them in if the sanitizer were skipped.
        const raw = `(${() => {
          const body = document.body;
          for (const html of /** @type {any} */ (window).__html) { const d = document.createElement('div'); d.innerHTML = html; body.appendChild(d); }
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(/** @type {any} */ (window).__css.join('\n'));
          document.adoptedStyleSheets = [sheet];
          const st = document.createElement('style'); st.textContent = /** @type {any} */ (window).__css.join('\n'); document.head.appendChild(st);
          const div = document.createElement('div'); div.className = 'a b tab'; div.title = 'a secret title'; div.dataset.url = 'https://bank.example/account';
          div.innerHTML = '<input class="a" value="a"><ul class="a"><li>x</li></ul>'; body.appendChild(div);
          try { fetch('https://evil.test/fetch').catch(() => {}); } catch {}
          try { new Image().src = 'https://evil.test/new-image.png'; } catch {}
          window.__done = true;
        }})()`;
        const data = `window.__html=${JSON.stringify([...HTML_PAYLOADS, ...TEMPLATE_PAYLOADS_2].map(([, f]) => f))};window.__css=${JSON.stringify([...CSS_PAYLOADS, ...CSS_PAYLOADS_2].map(([, c]) => c).filter((c) => c.length < 100000))};`;
        await context.route('**/*', (route) => {
          const url = route.request().url();
          const headers = { ...(policy ? { 'Content-Security-Policy': policy } : {}), 'Cache-Control': 'no-store' };
          if (url === `${ORIGIN}/overlay.html`) return route.fulfill({ status: 200, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' }, body: '<!doctype html><html><head><meta charset="utf-8"><script src="trip.js"></script><script src="data.js"></script><script src="raw.js"></script></head><body></body></html>' });
          if (url === `${ORIGIN}/trip.js`) return route.fulfill({ status: 200, headers: { ...headers, 'Content-Type': 'text/javascript' }, body: tripwire });
          if (url === `${ORIGIN}/data.js`) return route.fulfill({ status: 200, headers: { ...headers, 'Content-Type': 'text/javascript' }, body: data });
          if (url === `${ORIGIN}/raw.js`) return route.fulfill({ status: 200, headers: { ...headers, 'Content-Type': 'text/javascript' }, body: `document.addEventListener('DOMContentLoaded',function(){${raw}})` });
          requests.push(url);
          return route.abort();
        });
        await page.goto(`${ORIGIN}/overlay.html`);
        await page.waitForFunction(() => /** @type {any} */ (window).__done === true);
        // Hover and click everything, so handlers that wait for the pointer have their chance.
        await page.mouse.move(10, 10);
        await page.mouse.move(600, 400);
        await page.waitForTimeout(1500);
        const tripped = await page.evaluate(() => /** @type {any} */ (window).__tripped);
        await context.close();
        return { tripped, requests: requests.filter((u) => !u.startsWith(ORIGIN)), errors };
      };

      await t.test('control: the same raw page with no policy runs payloads and makes requests', async () => {
        const r = await rawPage(null);
        assert.ok(r.tripped.length > 0, 'payload scripts run');
        assert.ok(r.requests.some((u) => u.includes('evil.test')), 'payloads load');
      });

      await t.test('the overlay\'s policy alone: raw payloads, no sanitizer, run nothing and load nothing', async () => {
        assert.ok(POLICY);
        const r = await rawPage(POLICY);
        assert.deepEqual(r.tripped, [], 'no script of the payloads ran');
        assert.deepEqual(r.requests, [], 'no request left the page');
        t.diagnostic(`${HTML_PAYLOADS.length + TEMPLATE_PAYLOADS_2.length} raw templates and ${CSS_PAYLOADS.length + CSS_PAYLOADS_2.length} raw stylesheets under the policy`);
      });
    } finally {
      await browser.close();
    }
  });
}
