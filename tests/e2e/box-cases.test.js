// The page box's cases (tests/box/, README.md there), in Chromium: each case's
// page in its box beside the sidebar, held to the box's rules (tests/box/rules.js)
// against the same page in a plain window the box's size (an iframe that size,
// tests/box/serve.js /ref/). The WebKit host runs the same cases (its
// `box-cases` scenario).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMargin } from './harness/margin.js';
import { SPACES } from './harness/seed.js';
import { pageBox, slot } from './harness/ui.js';
import { listCases } from '../box/serve.js';
import { judge, measure } from '../box/rules.js';

const WINDOW = { w: 1440, h: 900 };
const CASES = listCases().filter((c) => c.engines !== 'webkit');
let m;
let s;

before(async () => {
  m = await startMargin({ name: 'box-cases', seed: { spaces: SPACES, settings: { sidebarPinnedOpen: true } } });
  const ui = await m.ui();
  s = await m.until(() => slot(ui), { what: 'the slot' });
});
after(async () => { await m?.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Measured once the page has loaded and settled, then again for up to 1.5 s
// while a rule is broken (fonts and late layout), as the WebKit host's checks do.
async function run(c) {
  const w = WINDOW.w - s.left - s.right;
  const h = WINDOW.h - s.top - s.bottom;
  const ref = await m.context.newPage();
  const page = await m.context.newPage();
  try {
    await ref.goto(m.url('box.test', `/ref/${c.name}?w=${w}&h=${h}`), { waitUntil: 'load' });
    const frame = ref.frames().find((f) => f.url().endsWith(`/case/${c.name}`));
    assert.ok(frame, 'the plain reference has its frame');
    await page.goto(m.url('box.test', `/case/${c.name}`), { waitUntil: 'load' });
    await m.until(async () => !!(await pageBox(page)), { what: `${c.name} in its box` });
    await sleep(c.settle);
    const plain = await frame.evaluate(measure);
    const setup = { slot: s, window: WINDOW, allow: c.allow };
    let fails = [];
    for (const t0 = Date.now(); ;) {
      fails = judge(await page.evaluate(measure), plain, setup);
      if (!fails.length || Date.now() - t0 > 1500) break;
      await sleep(150);
    }
    return fails;
  } finally {
    await page.close().catch(() => {});
    await ref.close().catch(() => {});
  }
}

for (const c of CASES) {
  test(`box case ${c.name}: ${c.title}`, async () => {
    const fails = await run(c);
    assert.deepEqual(fails, [], `${c.name} (from ${c.from}):\n  ${fails.join('\n  ')}`);
  });
}
