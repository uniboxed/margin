// The page box's kept sheet walks (shared/sheet-walk.ts, GitHub issue #3), in Chromium: the kept-sheet-walk box
// pattern loaded again and again, each time held to the box's rules against the same page in a plain frame the
// box's size (tests/box/rules.ts), as its sheets change under the same addresses (tests/box/serve.ts walkCss):
// - first visit: the full walk, and what it found kept for the content-named files (not the plain one);
// - return visit: the kept walks used, no full walk, the same layout;
// - a kept rule changed, or a rule more, at the same address: found by the checks, the full walk, the entry replaced;
// - a change the checks can't see (a rule that needed nothing now needs work, the size and count the same): right
//   once the entry is a day old (MAX_AGE_MS), when the full walk runs again.
// The WebKit host's `kept-walks` scenario does the same in WebKit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMargin } from './harness/margin.ts';
import { SPACES } from './harness/seed.ts';
import { pageBox, slot } from './harness/ui.ts';
import { listPatterns, WALK_FILES } from '../box/serve.ts';
import { judge, measure } from '../box/rules.ts';
import { MAX_AGE_MS, sheetWalkKey } from '../../extension/shared/sheet-walk.ts';

const WINDOW = { w: 1440, h: 900 };
const PATTERN = listPatterns().find((p) => p.name === 'kept-sheet-walk');
let m;
let s;
let origin;
const href = (file) => `${origin}/walk-css/${file}`;
const MAIN = () => href(WALK_FILES.main);
const IMPORTED = () => href(WALK_FILES.imported);

before(async () => {
  m = await startMargin({ name: 'sheet-walk', seed: { spaces: SPACES, settings: { sidebarPinnedOpen: true } } });
  const ui = await m.ui();
  s = await m.until(() => slot(ui), { what: 'the slot' });
  origin = new URL(m.url('box.test', '/')).origin;
});
after(async () => { await m?.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kept = async () => (await m.stored([sheetWalkKey(origin)]))[sheetWalkKey(origin)] ?? null;

async function version(v) {
  const page = await m.context.newPage();
  try {
    await page.goto(m.url('box.test', `/walk-css-set?v=${v}`));
    assert.equal(await page.textContent('body'), `version ${v}`);
  } finally {
    await page.close();
  }
}

// One visit: the pattern in its box against its plain reference; what the page's world said of its walks
// (`margin:sheet-walk-keep`: the files it walked in full, the ones it used as kept).
async function visit() {
  const w = WINDOW.w - s.left - s.right;
  const h = WINDOW.h - s.top - s.bottom;
  const ref = await m.context.newPage();
  const page = await m.context.newPage();
  await page.addInitScript(() => {
    (window as any).__keeps = [];
    document.addEventListener('margin:sheet-walk-keep', (e) => (window as any).__keeps.push(JSON.parse((e as CustomEvent).detail)));
  });
  try {
    await ref.goto(m.url('box.test', `/ref/${PATTERN.name}?w=${w}&h=${h}`), { waitUntil: 'load' });
    const frame = ref.frames().find((f) => f.url().endsWith(`/pattern/${PATTERN.name}`));
    await page.goto(m.url('box.test', `/pattern/${PATTERN.name}`), { waitUntil: 'load' });
    await m.until(async () => !!(await pageBox(page)), { what: 'the pattern in its box' });
    await sleep(PATTERN.settle);
    const plain = await frame.evaluate(measure);
    let fails = [];
    let boxed;
    for (const t0 = Date.now(); ;) {
      boxed = await page.evaluate(measure);
      fails = judge(boxed, plain, { slot: s, window: WINDOW, allow: PATTERN.allow });
      if (!fails.length || Date.now() - t0 > 1500) break;
      await sleep(150);
    }
    await m.until(() => page.evaluate(() => (window as any).__keeps.length > 0), { what: 'the page\'s world told what it walked' });
    const keeps = await page.evaluate(() => (window as any).__keeps);
    return { fails, els: boxed.els, walked: keeps.flatMap((k) => Object.keys(k.files)).sort(), used: keeps.flatMap((k) => k.used).sort() };
  } finally {
    await page.close().catch(() => {});
    await ref.close().catch(() => {});
  }
}

test('kept sheet walks: first visit, return visit, files changed under the same address, and an entry too old', async () => {
  assert.ok(PATTERN, 'the kept-sheet-walk pattern');
  await version('a');

  const first = await visit();
  assert.deepEqual(first.fails, [], `first visit:\n  ${first.fails.join('\n  ')}`);
  assert.deepEqual(first.walked, [MAIN(), IMPORTED()].sort(), 'the content-named files walked in full and kept; the plain one never kept');
  assert.deepEqual(first.used, []);
  const one = await m.until(async () => { const g = await kept(); return g?.files?.[MAIN()] && g.files[IMPORTED()] ? g : null; }, { what: 'the walks kept' });
  assert.ok(!(href(WALK_FILES.plain) in one.files));
  assert.ok(one.files[MAIN()].h?.some(([, selector]) => selector.includes(':has(#x.on)')), 'the :has() selector kept with it');
  assert.ok(JSON.stringify(one).length < 4000, `small: ${JSON.stringify(one).length} chars`);

  const again = await visit();
  assert.deepEqual(again.fails, [], `return visit:\n  ${again.fails.join('\n  ')}`);
  assert.deepEqual(again.used, [MAIN(), IMPORTED()].sort(), 'both used as kept');
  assert.deepEqual(again.walked, [], 'nothing walked in full');
  assert.deepEqual(again.els, first.els, 'the same layout as the full walk\'s');

  // Two kept rules with other values, the rule count and the size the same.
  await version('b');
  const b = await visit();
  assert.deepEqual(b.fails, [], `a kept rule changed under the same address:\n  ${b.fails.join('\n  ')}`);
  assert.deepEqual(b.walked, [MAIN()], 'the changed file walked in full; the one it imports, unchanged, used as kept');
  assert.deepEqual(b.used, [IMPORTED()]);
  const two = await m.until(async () => { const g = await kept(); return g?.files?.[MAIN()]?.w !== one.files[MAIN()].w ? g : null; }, { what: 'the changed file\'s entry replaced' });
  assert.equal(two.files[IMPORTED()].w, one.files[IMPORTED()].w);
  const bAgain = await visit();
  assert.deepEqual([bAgain.fails, bAgain.walked], [[], []], 'and used as kept from then on');

  // A rule more.
  await version('c');
  const c = await visit();
  assert.deepEqual(c.fails, [], `a rule more under the same address:\n  ${c.fails.join('\n  ')}`);
  assert.deepEqual(c.walked, [MAIN()]);
  await m.until(async () => (await kept())?.files?.[MAIN()]?.n === two.files[MAIN()].n + 1, { what: 'the entry with the rule more' });

  // Back to a, then a change no check sees: right once the entry is too old to use.
  await version('a');
  assert.deepEqual((await visit()).walked, [MAIN()]);
  await m.until(async () => (await kept())?.files?.[MAIN()]?.n === one.files[MAIN()].n, { what: 'a\'s entry again' });
  await version('d');
  await m.bg(({ key, main, age }) => chrome.storage.local.get(key).then((raw) => {
    const group = raw[key];
    group.files[main].t -= age;
    return chrome.storage.local.set({ [key]: group });
  }), { key: sheetWalkKey(origin), main: MAIN(), age: Math.ceil(MAX_AGE_MS / 1000) + 60 });
  const d = await visit();
  assert.deepEqual(d.fails, [], `a day on, a change no check sees:\n  ${d.fails.join('\n  ')}`);
  assert.deepEqual(d.walked, [MAIN()], 'the entry too old: the full walk');
  await version('a');
});
