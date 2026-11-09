// What the box costs real sites, in both engines Margin runs in: each site loaded through Margin (in its box) and
// plain, several times each, and the page's own timings compared (the navigation's DOMContentLoaded and load, and
// its first contentful paint), as both engines report them. tests/box/bench.mjs measures heavy test pages exactly;
// this says what pages people use pay, with the network's noise in it (medians of several loads, both ways alike).
// - Chromium: through Margin (the e2e harness, its real-sites mode) and a plain Chromium at the box's size, a load
//   of each by turns.
// - WebKit: the WebKit host, in rounds: every site plain (Margin not installed), then Margin installed and every
//   site in its box, then uninstalled; plain at the host's window size (1200×800), boxed at 932×784.
// A load counts only if it was what it says (in its box, or not).
//
//   npm run bench:sites                                  both engines, the sites below
//   npm run bench:sites -- --engine webkit --runs 5
//   npm run bench:sites -- --sites github.com,bbc.com
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const SITES = opt('sites', [
  'github.com', 'en.wikipedia.org/wiki/Web_browser', 'www.bbc.com', 'www.apple.com', 'www.nytimes.com', 'www.theverge.com',
  'medium.com', 'developer.mozilla.org/en-US/', 'stripe.com', 'vercel.com', 'www.notion.com', 'www.figma.com',
  'www.airbnb.com', 'linear.app', 'tailwindcss.com', 'www.shopify.com', 'example.com', 'news.ycombinator.com',
  'xkcd.com', 'www.craigslist.org', 'www.youtube.com', 'www.reddit.com', 'www.amazon.com', 'edition.cnn.com',
].join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const RUNS = Number(opt('runs', 3));
const engine = opt('engine', null);
if (engine && !['chromium', 'webkit'].includes(engine)) throw new Error(`--engine: chromium or webkit, not ${engine}`);
const LOAD_MS = 30_000;
const SETTLE_MS = 500;
const url = (site) => `https://${site.includes('/') ? site : `${site}/`}`;

// In the page, once it has loaded: its timings, and whether it's in its box (<html> moved by the box's transform).
const TIMINGS = `const n = performance.getEntriesByType('navigation')[0]; const f = performance.getEntriesByName('first-contentful-paint')[0];
  const m = new DOMMatrix(getComputedStyle(document.documentElement).transform);
  return JSON.stringify({ dcl: n ? Math.round(n.domContentLoadedEventEnd) : 0, load: n ? Math.round(n.loadEventEnd) : 0, fcp: f ? Math.round(f.startTime) : 0, inBox: m.e > 0 });`;
const LOADED = "document.readyState === 'complete' && (performance.getEntriesByType('navigation')[0]?.loadEventEnd ?? 0) > 0";
const METRICS = ['fcp', 'dcl', 'load'];
const median = (list) => (list.length ? [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] : null);

async function chromiumSites() {
  const { chromium } = require('playwright');
  const { startMargin } = await import('../e2e/harness/margin.js');
  const { SPACES } = await import('../e2e/harness/seed.js');
  const { HOST_RULES } = await import('../e2e/site/server.js');
  const m = await startMargin({ name: 'sites-bench', web: true, seed: { spaces: SPACES, settings: { sidebarPinnedOpen: true } } });
  await m.ui();
  const plain = await chromium.launch({ headless: false, args: ['--headless=new', '--mute-audio', `--host-resolver-rules=${HOST_RULES.replace(', MAP * ~NOTFOUND', '')}`] });
  const plainCtx = await plain.newContext({ viewport: { width: 1172, height: 884 } });
  const once = async (ctx, address, mode) => {
    const page = await ctx.newPage();
    try {
      await page.goto(address, { waitUntil: 'load', timeout: LOAD_MS });
      await page.waitForFunction(LOADED, null, { timeout: LOAD_MS });
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      return { mode, ...JSON.parse(await page.evaluate(`(() => { ${TIMINGS} })()`)) };
    } catch {
      return null;
    } finally {
      await page.close().catch(() => {});
    }
  };
  const loads = [];
  try {
    for (const site of SITES) {
      // A first load of each, either way, not counted: both browsers then load it from a warm cache (their own).
      await once(m.context, url(site), 'boxed');
      await once(plainCtx, url(site), 'plain');
      for (let i = 0; i < RUNS; i++) {
        loads.push({ site, ...(await once(m.context, url(site), 'boxed')) });
        loads.push({ site, ...(await once(plainCtx, url(site), 'plain')) });
      }
    }
  } finally {
    await plain.close().catch(() => {});
    await m.close().catch(() => {});
  }
  return loads;
}

async function webkitSites() {
  const { boxedCheck, bareCheck } = await import('../../tools/webkit-host/scenarios.mjs');
  const steps = [];
  let n = 0;
  const load = (site, mode, logged) => {
    const name = `${mode}${n++}`;
    steps.push(
      { op: 'open', name, url: url(site), active: true },
      { op: 'checkPage', in: name, label: `${site} ${mode}: loaded`, js: `return ${LOADED}`, timeout: LOAD_MS },
      { op: 'wait', ms: SETTLE_MS },
      ...(logged ? [{ op: 'page', in: name, js: `${TIMINGS.replace('return JSON.stringify({', `return 'SITE ' + JSON.stringify({ site: ${JSON.stringify(site)}, mode: '${mode}', `)}` }] : []),
      { op: 'close', name },
    );
  };
  for (const site of SITES) load(site, 'plain', false); // warm, not counted (one network cache for both ways here)
  for (let round = 0; round < RUNS; round++) {
    for (const site of SITES) load(site, 'plain', true);
    if (round === 0) steps.push({ op: 'appStart', layout: [260, 8, 8, 8] }, { op: 'open', name: 'W', url: '/p/A', active: true }, { op: 'wait', ms: 800 });
    steps.push({ op: 'install' }, boxedCheck('W'));
    for (const site of SITES) load(site, 'boxed', true);
    steps.push({ op: 'uninstall' }, bareCheck('W'));
  }
  const file = join(tmpdir(), `margin-sites-bench-${process.pid}.json`);
  writeFileSync(file, JSON.stringify(steps));
  const run = spawnSync('tools/webkit-host/run.sh', [file], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, MARGIN_HOST_TIMEOUT: String(60 + SITES.length * RUNS * 2 * 20), MARGIN_HOST_PORT: process.env.MARGIN_HOST_PORT ?? '47832' },
  });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (/\bTIMEOUT\b/.test(out)) console.log('the WebKit host ran out of time: the loads before that count');
  return [...out.matchAll(/ page \S+: SITE (\{.*\})$/gm)].map((m) => JSON.parse(m[1]));
}

// Per site, the median of each way's loads that were what they say, and the box's extra; then across sites.
function summary(name, loads) {
  const ok = loads.filter((l) => l && l.load > 0 && (l.mode === 'boxed') === !!l.inBox);
  const rows = [];
  for (const site of SITES) {
    const of = (mode) => ok.filter((l) => l.site === site && l.mode === mode);
    if (!of('boxed').length || !of('plain').length) continue;
    const row = { site };
    for (const k of METRICS) {
      const values = (mode) => of(mode).map((l) => l[k]).filter((v) => v > 0);
      const [b, p] = [median(values('boxed')), median(values('plain'))];
      row[k] = b != null && p != null ? b - p : null;
    }
    rows.push(row);
  }
  console.log(`\n${name}: ${rows.length} of ${SITES.length} sites loaded both ways (${ok.length} loads counted); the box's extra, boxed minus plain, ms:`);
  console.log(`  ${'site'.padEnd(34)}${METRICS.map((k) => k.padStart(8)).join('')}`);
  for (const r of rows) console.log(`  ${r.site.padEnd(34)}${METRICS.map((k) => String(r[k] ?? '–').padStart(8)).join('')}`);
  const at = (k, q) => { const list = rows.map((r) => r[k]).filter((v) => v != null).sort((a, b) => a - b); return list.length ? list[Math.min(list.length - 1, Math.floor(q * list.length))] : '–'; };
  console.log(`  ${'median'.padEnd(34)}${METRICS.map((k) => String(at(k, 0.5)).padStart(8)).join('')}`);
  console.log(`  ${'slowest tenth'.padEnd(34)}${METRICS.map((k) => String(at(k, 0.9)).padStart(8)).join('')}`);
}

for (const e of engine ? [engine] : ['chromium', 'webkit']) summary(e, e === 'chromium' ? await chromiumSites() : await webkitSites());
