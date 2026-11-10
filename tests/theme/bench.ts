// Times the theme renderer with Neubrutalism and 200 tabs, in Playwright's
// WebKit and Chromium, headless. `npm run bench:theme` (add `--runs=N`).
// The page is cross-origin isolated (COOP and COEP headers on a routed
// localhost page, nothing listens there) for Chromium's 5 µs clock; WebKit's
// stays at 1 ms, so there a sample is 10 views updated back to back. Every
// other request is refused.
import { chromium, webkit } from 'playwright';
import { harnessScript, themeForPage } from './package.ts';
import type { Harness } from './harness.ts';

// What the harness puts on the page's window (harness.ts), as the page functions below read it.
declare const T: Harness;

const runs = Number(process.argv.find((a) => a.startsWith('--runs='))?.slice(7) ?? 50);
const script = harnessScript();
const pkg = themeForPage();
const fmt = (v: number) => v.toFixed(2);

const all: Record<string, { version: string, clock: Awaited<ReturnType<Harness['resolution']>>, batch: number, results: Awaited<ReturnType<Harness['bench']>>, stray: string[], sanitize: Awaited<ReturnType<Harness['timeSanitize']>> }> = {};
for (const [name, engine] of [['WebKit', webkit], ['Chromium', chromium]] as const) {
  const browser = await engine.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const stray: string[] = [];
  await context.route('**/*', (route) => {
    if (route.request().url() === 'http://localhost:8765/') {
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' },
        body: '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>',
      });
    }
    stray.push(route.request().url());
    return route.abort();
  });
  await page.goto('http://localhost:8765/');
  await page.addScriptTag({ content: script });
  await page.evaluate((p) => T.loadNeo(p), pkg);
  const clock = await page.evaluate(() => T.resolution());
  const sanitize = await page.evaluate((p) => T.timeSanitize(p), pkg);
  const version = browser.version();
  // A clock coarser than 0.1 ms: time 10 views updated back to back.
  const batch = clock.resolution > 0.1 ? 10 : 1;
  const results = await page.evaluate(({ r, b }) => T.bench({ runs: r, batch: b }), { r: runs, b: batch });
  all[name] = { version, clock, batch, results, stray, sanitize };
  await browser.close();
}

for (const [name, { version, clock, batch, results, stray, sanitize }] of Object.entries(all)) {
  const method = batch > 1 ? `each sample is ${batch} views updated back to back, divided by ${batch}` : 'each sample is one update';
  console.log(`\n### ${name} ${version} (timer step ${clock.resolution.toFixed(3)} ms, cross-origin isolated: ${clock.crossOriginIsolated}; ${method}; stray requests: ${stray.length})\n`);
  console.log(`| ${runs} runs each, ms | update: median | update: p95 | update + layout: median | update + layout: p95 |`);
  console.log('|---|---:|---:|---:|---:|');
  for (const [label, { js, layout }] of Object.entries(results)) {
    console.log(`| ${label} | ${fmt(js.median)} | ${fmt(js.p95)} | ${fmt(layout.median)} | ${fmt(layout.p95)} |`);
  }
  console.log(`\nSanitizing the package and building its template: median ${fmt(sanitize)} ms (timer step ${clock.resolution.toFixed(3)} ms).`);
}
if (process.argv.includes('--json')) console.log(JSON.stringify(all, null, 2));
