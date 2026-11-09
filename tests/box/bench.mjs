// The page box's benchmark: what the box costs a heavy page (tests/box/serve.js
// benchPage: 20,000 rules with viewport units and media queries, 3,000
// elements; in a <style>, and in a <link>ed sheet whose text the box can't
// see), in both engines Margin runs in, boxed and plain, the same page several
// times each: the page's load, and from load to its next frames (the box's
// work after load: sheets.js rewriting, box.js reading <body>).
// - Chromium: through Margin (the e2e harness, as the patterns run) and in a
//   plain Chromium (no extension) at the box's size.
// - WebKit: the WebKit host (tools/webkit-host, `box-bench`): plain before
//   Margin is installed, at the host's window size, then in its box.
// Each engine is compared with its own baseline (bench-baseline.json): it fails
// if the box's cost grew by more than a quarter and 30 ms. `--save` writes the
// baseline (on main, before a change); `--engine chromium|webkit`: one only
// (saving one keeps the other's baseline).
//
//   npm run bench:box                     measure both and compare
//   npm run bench:box -- --save           measure both and keep as the baseline
//   npm run bench:box -- --engine webkit  one engine
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startMargin } from '../e2e/harness/margin.js';
import { SPACES } from '../e2e/harness/seed.js';
import { HOST_RULES } from '../e2e/site/server.js';
import { BENCH_SIZES } from '../../tools/webkit-host/scenarios.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASELINE = fileURLToPath(new URL('./bench-baseline.json', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RUNS = 7;
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const argv = process.argv.slice(2);
const only = argv.includes('--engine') ? argv[argv.indexOf('--engine') + 1] : null;
if (only && !['chromium', 'webkit'].includes(only)) throw new Error(`--engine: chromium or webkit, not ${only}`);
const engines = only ? [only] : ['chromium', 'webkit'];

// Each way's median load and load-to-frames, and the box's own cost: what it adds to the page's.
const result = (boxed, plain) => ({ boxed, plain, costMs: { load: boxed.loadMs - plain.loadMs, frame: boxed.frameMs - plain.frameMs } });
const medians = (list) => ({ loadMs: median(list.map((b) => b.loadMs)), frameMs: median(list.map((b) => b.frameMs)) });

async function chromiumBench() {
  async function measure(open, url) {
    const list = [];
    for (let i = 0; i < RUNS; i++) {
      const page = await open();
      await page.goto(url, { waitUntil: 'load' });
      list.push(await page.waitForFunction(() => window.__bench, null, { timeout: 30_000 }).then((h) => h.jsonValue()));
      await page.close();
    }
    return medians(list);
  }
  const m = await startMargin({ name: 'box-bench', seed: { spaces: SPACES, settings: { sidebarPinnedOpen: true } } });
  await m.ui();
  const plain = await chromium.launch({ headless: false, args: ['--headless=new', `--host-resolver-rules=${HOST_RULES}`] });
  const plainCtx = await plain.newContext({ viewport: { width: 1172, height: 884 } });
  const results = {};
  try {
    for (const size of BENCH_SIZES) {
      const url = m.url('box.test', `/bench/${size}`);
      results[size] = result(await measure(() => m.context.newPage(), url), await measure(() => plainCtx.newPage(), url));
    }
  } finally {
    await plain.close().catch(() => {});
    await m.close().catch(() => {});
  }
  return results;
}

// The host logs each load's numbers as `page <tab>: BENCH {…}` (scenarios.mjs boxBench).
function webkitBench() {
  const run = spawnSync('tools/webkit-host/run.sh', ['box-bench'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, MARGIN_HOST_TIMEOUT: '900', MARGIN_HOST_PORT: process.env.MARGIN_HOST_PORT ?? '47831' },
  });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const failed = out.split('\n').filter((line) => / FAIL |TIMEOUT/.test(line));
  if (run.status !== 0 || failed.length) throw new Error(`the WebKit host's box-bench didn't run through (exit ${run.status}):\n${failed.slice(0, 10).join('\n') || out.slice(-2000)}`);
  const loads = [...out.matchAll(/ page \S+: BENCH (\{.*\})$/gm)].map((m) => JSON.parse(m[1]));
  const results = {};
  for (const size of BENCH_SIZES) {
    const of = (mode) => loads.filter((b) => b.size === size && b.mode === mode);
    if (!of('plain').length || !of('boxed').length) throw new Error(`the WebKit host logged no ${size} loads`);
    results[size] = result(medians(of('boxed')), medians(of('plain')));
  }
  return results;
}

const measured = {};
for (const engine of engines) measured[engine] = engine === 'chromium' ? await chromiumBench() : webkitBench();

for (const [engine, results] of Object.entries(measured)) {
  for (const [size, r] of Object.entries(results)) {
    console.log(`${engine.padEnd(8)} ${size}: load ${r.boxed.loadMs} ms boxed, ${r.plain.loadMs} plain; load to frame ${r.boxed.frameMs} ms, ${r.plain.frameMs} plain (the box's cost: load ${r.costMs.load}, frame ${r.costMs.frame})`);
  }
}
// The baseline by engine; one from before WebKit was measured is Chromium's.
const stored = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null;
const baseOf = (engine) => {
  const results = stored?.results ?? {};
  if (results.chromium || results.webkit) return results[engine] ?? null;
  return engine === 'chromium' && Object.keys(results).length ? results : null;
};
if (argv.includes('--save')) {
  const results = Object.fromEntries(['chromium', 'webkit'].map((e) => [e, measured[e] ?? baseOf(e)]).filter(([, r]) => r));
  writeFileSync(BASELINE, `${JSON.stringify({ at: new Date().toISOString().slice(0, 10), runs: RUNS, results }, null, 2)}\n`);
  console.log(`saved ${BASELINE}`);
} else {
  let worse = 0;
  for (const [engine, results] of Object.entries(measured)) {
    const base = baseOf(engine);
    if (!base) {
      console.log(`${engine}: no baseline yet (npm run bench:box -- --save, on main)`);
      continue;
    }
    for (const [size, r] of Object.entries(results)) {
      const was = base[size];
      if (!was) continue;
      for (const k of ['load', 'frame']) {
        const limit = Math.max(was.costMs[k], 0) * 1.25 + 30;
        const bad = r.costMs[k] > limit;
        if (bad) worse += 1;
        console.log(`${bad ? 'SLOWER' : 'ok    '} ${engine.padEnd(8)} ${size} ${k}: the box's cost ${r.costMs[k]} ms (baseline ${was.costMs[k]}, limit ${Math.round(limit)})`);
      }
    }
  }
  if (worse) process.exitCode = 1;
}
