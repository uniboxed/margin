// The page box's benchmark: what the box costs a heavy page (tests/box/serve.js
// benchPage: 20,000 rules with viewport units and media queries, 3,000
// elements), in Chromium through Margin (the e2e harness, as the patterns run)
// and plain (no extension), the same page, several times each: the page's load,
// and from load to its next frames (the box's work after load: sheets.js
// rewriting, box.js reading <body>). Compared with the baseline
// (bench-baseline.json): it fails if the box's cost grew by more than a quarter
// and 30 ms. `--save` writes the baseline (on main, before a change).
//
//   npm run bench:box            measure and compare
//   npm run bench:box -- --save  measure and keep as the baseline
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startMargin } from '../e2e/harness/margin.js';
import { SPACES } from '../e2e/harness/seed.js';
import { HOST_RULES } from '../e2e/site/server.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASELINE = fileURLToPath(new URL('./bench-baseline.json', import.meta.url));
const RUNS = 7;
const SIZES = [{ rules: 20_000, elements: 3_000 }, { rules: 2_000, elements: 500 }];
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];

async function measure(open, url) {
  const loads = [];
  const frames = [];
  for (let i = 0; i < RUNS; i++) {
    const page = await open();
    await page.goto(url, { waitUntil: 'load' });
    const b = await page.waitForFunction(() => window.__bench, null, { timeout: 30_000 }).then((h) => h.jsonValue());
    loads.push(b.loadMs);
    frames.push(b.frameMs);
    await page.close();
  }
  return { loadMs: median(loads), frameMs: median(frames) };
}

const m = await startMargin({ name: 'box-bench', seed: { spaces: SPACES, settings: { sidebarPinnedOpen: true } } });
await m.ui();
const plain = await chromium.launch({ headless: false, args: ['--headless=new', `--host-resolver-rules=${HOST_RULES}`] });
const plainCtx = await plain.newContext({ viewport: { width: 1172, height: 884 } });
const results = {};
try {
  for (const { rules, elements } of SIZES) {
    const url = m.url('box.test', `/bench/${rules}/${elements}`);
    const boxed = await measure(() => m.context.newPage(), url);
    const bare = await measure(() => plainCtx.newPage(), url);
    // The box's own cost: what it adds to the page's.
    results[`${rules}/${elements}`] = { boxed, plain: bare, costMs: { load: boxed.loadMs - bare.loadMs, frame: boxed.frameMs - bare.frameMs } };
  }
} finally {
  await plain.close().catch(() => {});
  await m.close().catch(() => {});
}

for (const [size, r] of Object.entries(results)) {
  console.log(`${size}: load ${r.boxed.loadMs} ms through Margin, ${r.plain.loadMs} plain; load to frame ${r.boxed.frameMs} ms, ${r.plain.frameMs} plain (the box's cost: load ${r.costMs.load}, frame ${r.costMs.frame})`);
}
if (process.argv.includes('--save')) {
  writeFileSync(BASELINE, `${JSON.stringify({ at: new Date().toISOString().slice(0, 10), runs: RUNS, results }, null, 2)}\n`);
  console.log(`saved ${BASELINE}`);
} else if (existsSync(BASELINE)) {
  const base = JSON.parse(readFileSync(BASELINE, 'utf8')).results;
  let worse = 0;
  for (const [size, r] of Object.entries(results)) {
    const was = base[size];
    if (!was) continue;
    for (const k of ['load', 'frame']) {
      const limit = Math.max(was.costMs[k], 0) * 1.25 + 30;
      const bad = r.costMs[k] > limit;
      if (bad) worse += 1;
      console.log(`${bad ? 'SLOWER' : 'ok    '} ${size} ${k}: the box's cost ${r.costMs[k]} ms (baseline ${was.costMs[k]}, limit ${Math.round(limit)})`);
    }
  }
  if (worse) process.exitCode = 1;
}
