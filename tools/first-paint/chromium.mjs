// First paint at any insets, in Chromium (README.md here). Loads dist/chrome
// headless (Playwright's Chromium, never installed from here), sets each
// layout through the background (setLayout), and for fresh page loads checks
// the probe's frames (pages.mjs) and the first frames Chromium composited (a
// screencast): the page in its box at the layout's insets from the first
// frame, and never moved after. Usage: node tools/first-paint/chromium.mjs [runs]
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROBE, judge, serveFp } from './pages.mjs';
import { layoutFiles } from '../../extension/shared/page-box.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const RUNS = Number(process.argv[2] ?? 6);
const REAL = process.env.FP_REAL !== '0'; // also a real site (Wikipedia)
const VW = 1200;
const VH = 800;
const LAYOUTS = {
  'left sidebar': { left: 260, top: 8, right: 8, bottom: 8, radius: 6.25 },
  'right sidebar': { left: 8, top: 8, right: 260, bottom: 8, radius: 6.25 },
  'top bar': { left: 8, top: 60, right: 8, bottom: 8, radius: 6.25 },
  'framed card': { left: 16, top: 16, right: 16, bottom: 16, radius: 18 },
};
const FRAME_ONLY = { left: 8, top: 8, right: 8, bottom: 8, radius: 6.25 };

const ext = join(mkdtempSync(join(tmpdir(), 'margin-fp-')), 'ext');
cpSync(fileURLToPath(new URL('../../dist/chrome', import.meta.url)), ext, { recursive: true });

const server = createServer((req, res) => {
  if (!serveFp(req.url, res)) { res.statusCode = 404; res.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'margin-fp-profile-')), {
  headless: false,
  viewport: { width: VW, height: VH },
  args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
await context.addInitScript(PROBE);
let [worker] = context.serviceWorkers();
worker ??= await context.waitForEvent('serviceworker');
const id = new URL(worker.url()).host;
const control = context.pages()[0] ?? await context.newPage();
await control.goto(`chrome-extension://${id}/newtab/newtab.html`);
const send = (message) => control.evaluate((m) => chrome.runtime.sendMessage(m), message);
await send({ type: 'updateSettings', patch: { fullscreenOnly: false, sidebarPinnedOpen: false, frameWhenHidden: true } });
const controlWindow = await worker.evaluate(() => chrome.tabs.query({}).then((t) => t.find((tab) => tab.url?.includes('/newtab/newtab.html')).windowId));

const registered = () => worker.evaluate(() => chrome.scripting.getRegisteredContentScripts({ ids: ['margin-page'] }).then((r) => r[0]?.css ?? null));
async function registeredAs(layout) {
  const want = JSON.stringify(layoutFiles(layout));
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    if (JSON.stringify(await registered()) === want) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`not registered: ${JSON.stringify(layout)}`);
}
async function pin(layout, fixup = 'committed') {
  const t = performance.now();
  await send({ type: 'setLayout', pin: true, layout, fixup });
  await registeredAs(layout);
  return performance.now() - t;
}

// A screencast's frames, read where they're decoded: each frame's insets,
// where the page's color starts along the middle row and column (null: no
// page color yet, the blank page before).
async function decode(frames) {
  return control.evaluate(async ({ frames, vw, vh }) => {
    const canvas = new OffscreenCanvas(vw, vh);
    const g = canvas.getContext('2d', { willReadFrequently: true });
    // Outside the box: the window's canvas (the page's red) or Margin's frame
    // (gray, darker by the card's shadow next to it). Inside: <body>, green.
    // Each pixel is taken as the nearest of these (JPEG blurs the edges).
    const PALETTE = [[156, 157, 161, true], [120, 121, 125, true], [238, 51, 51, true], [51, 170, 51, false], [17, 17, 17, false], [255, 255, 255, false], [200, 200, 200, false]];
    const outside = (d, i) => {
      let best = null;
      let far = Infinity;
      for (const c of PALETTE) {
        const dist = (d[i] - c[0]) ** 2 + (d[i + 1] - c[1]) ** 2 + (d[i + 2] - c[2]) ** 2;
        if (dist < far) [far, best] = [dist, c];
      }
      return best[3];
    };
    const green = (d, i) => d[i + 1] > 130 && d[i] < 110 && d[i + 2] < 110;
    const run = (d, n, step) => { let k = 0; while (k < n && outside(d, (step > 0 ? k : n - 1 - k) * 4)) k++; return k; };
    const out = [];
    for (const data of frames) {
      const img = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${data}`)).blob());
      g.drawImage(img, 0, 0, vw, vh);
      const row = g.getImageData(0, Math.round(vh / 2), vw, 1).data;
      // (Not the middle: Margin's loading pill is at the top's middle.)
      const col = g.getImageData(Math.round(vw * 0.3), 0, 1, vh).data;
      let page = false;
      for (let x = 0; x < vw && !page; x++) page = green(row, x * 4);
      // No page color yet: the empty page before.
      out.push(page ? { left: run(row, vw, 1), right: run(row, vw, -1), top: run(col, vh, 1), bottom: run(col, vh, -1) } : null);
    }
    return out;
  }, { frames, vw: VW, vh: VH });
}
const near = (a, b) => !!a && ['left', 'top', 'right', 'bottom'].every((k) => Math.abs(a[k] - b[k]) <= 2);

// One fresh page load in a new tab of `windowId`: the tab first, empty, then
// the screencast, then the page.
async function newTab(windowId) {
  const made = context.waitForEvent('page');
  await worker.evaluate((w) => chrome.tabs.create({ windowId: w, url: 'about:blank', active: true }), windowId);
  const page = await made;
  await page.waitForLoadState().catch(() => {});
  return page;
}
async function load(windowId, url, layout, { screencast = true, tab = null } = {}) {
  const page = tab ?? await newTab(windowId);
  const cdp = screencast ? await context.newCDPSession(page) : null;
  const shots = [];
  if (cdp) {
    cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      shots.push(data);
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 });
  }
  await page.goto(url, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(900);
  const fp = await page.evaluate(() => window.__fp && { ...window.__fp, head: window.__fpHead, started: window[Symbol.for('margin.page.started')] ?? null }).catch(() => null);
  if (cdp) await cdp.send('Page.stopScreencast').catch(() => {});
  const result = judge(fp, layout, VW, VH);
  if (cdp && process.env.FP_SHOTS) {
    const loadNo = (globalThis.loadNo = (globalThis.loadNo ?? 0) + 1);
    shots.forEach((data, i) => writeFileSync(join(process.env.FP_SHOTS, `${loadNo}-${url.split('/').slice(-2).join('-').replace(/\W/g, '_')}-${i}.jpg`), Buffer.from(data, 'base64')));
    console.log(JSON.stringify({ url, decoded: await decode(shots), probe: fp?.frames?.slice(0, 4), head: fp?.head }));
  }
  if (cdp) {
    const seen = (await decode(shots)).filter(Boolean);
    let moved = 0;
    for (let i = 1; i < seen.length; i++) if (!near(seen[i], seen[i - 1])) moved++;
    Object.assign(result, { shots: seen.length, shotFirst: seen[0] ?? null, shotFirstOk: near(seen[0], layout), shotMoves: moved });
  }
  await page.close();
  return result;
}

const rows = [];
function summarize(label, results) {
  const n = results.length;
  const count = (f) => results.filter(f).length;
  const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const row = {
    label, n,
    headOk: count((r) => r.headOk), headTakenOver: count((r) => r.headTakenOver),
    pageStartOk: count((r) => r.pageStartOk), pageStartVars: count((r) => r.pageStart?.vars), ownAtHead: count((r) => r.ownAtHead), ownAtFirst: count((r) => r.ownAtFirst), selfFixed: count((r) => r.selfAt != null),
    // Started elsewhere by the page's world, and Chromium could paint before Margin's script moved it.
    wrongDrawable: count((r) => r.head && !r.headOk && r.paintAt != null && (r.boxAt == null || r.boxAt > r.paintAt)), boxMs: median(results.map((r) => r.boxAt)),
    firstFrameOk: count((r) => r.firstOk), cssFirstOk: count((r) => r.cssOk), noMove: count((r) => r.moves === 0), endOk: count((r) => r.lastOk),
    shotFirstOk: count((r) => r.shotFirstOk), shotNoMove: count((r) => r.shotMoves === 0),
    firstFrameMs: median(results.map((r) => r.firstFrameAt)), okMs: median(results.map((r) => r.okAt)), paintMs: median(results.map((r) => r.paintAt)),
    bad: results.filter((r) => !r.firstOk || r.moves || (r.shots != null && (!r.shotFirstOk || r.shotMoves))).slice(0, 2).map((r) => ({ head: r.head, first: r.first, vars: r.firstVars, off: r.firstOff, okFrom: r.okFrom, moves: r.moves, shotFirst: r.shotFirst, shotMoves: r.shotMoves })),
    headBad: results.filter((r) => r.head && !r.headOk).slice(0, 2).map((r) => r.head),
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
// `late`: Margin's content script holds its box messages for 250 ms
// (content/page-link.js, ?late=): what the first-paint CSS and the page's
// world do alone, as in Safari, whose content scripts come about that late.
const pages = [['light', (i, late) => `${BASE}/fp/light/n${i}${late ? '?late=250' : ''}`], ['heavy', (i, late) => `${BASE}/fp/heavy/n${i}${late ? '?late=250' : ''}`]];
if (REAL) pages.push(['wikipedia', (i) => `https://en.wikipedia.org/wiki/${['WebKit', 'Blink_(browser_engine)', 'Safari_(web_browser)', 'Chromium_(web_browser)', 'Gecko_(software)', 'Servo_(software)'][i % 6]}?fp=${i}`]);
const runsFor = (kind) => (kind === 'wikipedia' ? Math.min(RUNS, 3) : RUNS);

// 1. Registered: the window has the layout that's registered.
const pinTimes = [];
for (const [name, layout] of Object.entries(LAYOUTS)) {
  pinTimes.push(await pin(layout));
  for (const late of [false, true]) {
    for (const [kind, url] of pages) {
      if (kind === 'wikipedia' && late) continue;
      const results = [];
      for (let i = 0; i < runsFor(kind); i++) results.push(await load(controlWindow, url(i, late), layout, { screencast: kind !== 'wikipedia' }));
      summarize(`registered${late ? ' late' : ''} · ${name} · ${kind}`, results);
    }
  }
}

if (process.env.FP_ONLY === 'registered') {
  await context.close();
  process.exit(0);
}

// 2. A second window with its own layout, other than the registered one:
// given as its pages commit (webNavigation.onCommitted or tabs.onUpdated),
// or not at all (the content script moves the box when it hears).
const made = context.waitForEvent('page');
const otherWindow = (await worker.evaluate(() => chrome.windows.create({ url: 'about:blank', focused: true }))).id;
await (await made).waitForLoadState().catch(() => {});
for (const [fixup, late] of [['committed', false], ['committed', true], ['updated', false], ['off', false], ['off', true]]) {
  for (const [name, layout] of Object.entries(LAYOUTS)) {
    const registeredOne = name === 'left sidebar' ? FRAME_ONLY : LAYOUTS['left sidebar'];
    await pin(registeredOne, fixup);
    await send({ type: 'setLayout', windowId: otherWindow, layout });
    for (const [kind, url] of pages) {
      if (kind === 'wikipedia' && (fixup !== 'committed' || late)) continue;
      const results = [];
      for (let i = 0; i < runsFor(kind); i++) results.push(await load(otherWindow, url(i, late), layout, { screencast: kind !== 'wikipedia' }));
      summarize(`own (${fixup}${late ? ', late' : ''}) · ${name} · ${kind}`, results);
    }
  }
}
const log = (await send({ type: 'layoutLog' }))?.result ?? [];
const took = log.filter((e) => e.ok === true).map((e) => e.took).sort((a, b) => a - b);
console.log(JSON.stringify({ insertCSS: { n: took.length, medianMs: took[Math.floor(took.length / 2)], maxMs: took.at(-1), failed: log.filter((e) => e.ok !== true).slice(0, 3) } }));
await send({ type: 'setLayout', windowId: otherWindow, layout: null });

// 3. At run time: an open page follows a new layout, and a page loaded as
// soon as setLayout has answered, or while it's still registering, starts at
// the new one.
await pin(LAYOUTS['left sidebar']);
const switches = [];
const order = Object.values(LAYOUTS);
for (let i = 0; i < 8; i++) {
  const from = order[i % 4];
  const to = order[(i + 1) % 4];
  const open = await newTab(controlWindow);
  await open.goto(`${BASE}/fp/light/live${i}`, { waitUntil: 'load' });
  await open.waitForTimeout(400);
  const before = judge(await open.evaluate(() => window.__fp), from, VW, VH).lastOk;
  const raceTab = await newTab(controlWindow);
  const t = performance.now();
  // Loaded while the new layout is being registered: not waited for.
  const racing = load(controlWindow, `${BASE}/fp/light/race${i}`, to, { screencast: false, tab: raceTab });
  await send({ type: 'setLayout', pin: true, layout: to });
  const answered = performance.now() - t;
  await registeredAs(to);
  const registeredMs = performance.now() - t;
  const after = await load(controlWindow, `${BASE}/fp/light/after${i}`, to, { screencast: false });
  const live = await open.evaluate(() => { const s = getComputedStyle(document.documentElement); const m = new DOMMatrixReadOnly(s.transform); return { left: m.e, top: m.f, w: parseFloat(s.width), h: parseFloat(s.height) }; });
  const liveOk = Math.abs(live.left - to.left) < 0.1 && Math.abs(live.top - to.top) < 0.1 && Math.abs(live.w - (VW - to.left - to.right)) < 0.1 && Math.abs(live.h - (VH - to.top - to.bottom)) < 0.1;
  const race = await racing;
  switches.push({ before, liveOk, answeredMs: Math.round(answered), registeredMs: Math.round(registeredMs), afterFirstOk: after.firstOk, afterMoves: after.moves, raceFirstOk: race.firstOk, raceMoves: race.moves, raceFirst: race.first });
  await open.close();
}
console.log(JSON.stringify({ runtime: switches }));
console.log(JSON.stringify({ pinMs: pinTimes.map(Math.round) }));

writeFileSync(join(tmpdir(), 'margin-fp-chromium.json'), JSON.stringify({ rows, switches }, null, 2));
await context.close();
server.close();
