// Arcadia's visual parity check: today's Arcadia (themes/arcadia, its own
// modules) and the arcadia-2 package rendered by the UI runtime, fed the
// same fixed state (tests/theme/parity-harness.js), screenshotted at the
// same size in each case, in Playwright's WebKit and Chromium, headless,
// with every network request refused. Each pair is compared pixel by pixel
// in the browser (canvas), and the report says, per case and engine, how
// many pixels differ (any channel by more than THRESHOLD) and where.
//
//   node tests/theme/parity.js [out-dir] [--engine webkit|chromium] [--case name]
//
// Saves <case>-<engine>-old.png, -new.png and -diff.png (the differing
// pixels in red over a faded copy of the old) and report.json in out-dir.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { chromium, webkit } from 'playwright';
import { themeForPage } from './package.js';

const THRESHOLD = 24; // per channel, out of 255: below it, antialiasing noise
const VIEWPORT = { width: 1280, height: 800 };
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
const onlyEngine = flag('--engine');
const onlyCase = flag('--case');
const out = resolve(args[0] ?? 'parity-out');
mkdirSync(out, { recursive: true });

const script = buildSync({
  entryPoints: [fileURLToPath(new URL('./parity-harness.js', import.meta.url))],
  bundle: true, format: 'iife', write: false, target: 'es2022', logLevel: 'silent',
}).outputFiles[0].text;
const pkg = themeForPage(fileURLToPath(new URL('../../extension/themes/arcadia-2/', import.meta.url)));

async function shoot(browser, which, name, dark) {
  const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: dark ? 'dark' : 'light', deviceScaleFactor: 1, reducedMotion: 'no-preference' });
  await context.route('**/*', (route) => route.abort());
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => { if (!/^(data|blob|about):/.test(r.url())) requests.push(r.url()); });
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#fff"></body></html>');
  await page.addScriptTag({ content: script });
  const info = which === 'old' ? await page.evaluate((n) => P.old(n), name) : await page.evaluate(([n, p]) => P.new(n, p), [name, pkg]);
  await page.evaluate(() => P.settle());
  const png = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  await context.close();
  return { png, errors, requests, info };
}

// Compares two PNGs in a page: the share of pixels that differ, their box,
// and a picture of where.
async function compare(browser, a, b) {
  const context = await browser.newContext({ viewport: { width: 200, height: 200 } });
  const page = await context.newPage();
  await page.setContent('<!doctype html><body></body>');
  const result = await page.evaluate(async ([a64, b64, threshold]) => {
    const load = async (b) => createImageBitmap(await (await fetch(`data:image/png;base64,${b}`)).blob());
    const [ia, ib] = await Promise.all([load(a64), load(b64)]);
    const width = Math.max(ia.width, ib.width);
    const height = Math.max(ia.height, ib.height);
    const pixels = (img) => { const c = new OffscreenCanvas(width, height); const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, width, height).data; };
    const pa = pixels(ia);
    const pb = pixels(ib);
    const c = new OffscreenCanvas(width, height);
    const g = c.getContext('2d');
    const diff = g.createImageData(width, height);
    let n = 0;
    let box = null;
    for (let i = 0, p = 0; i < pa.length; i += 4, p++) {
      const d = Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2]));
      if (d > threshold) {
        n++;
        const x = p % width;
        const y = (p / width) | 0;
        box = box ? { left: Math.min(box.left, x), top: Math.min(box.top, y), right: Math.max(box.right, x), bottom: Math.max(box.bottom, y) } : { left: x, top: y, right: x, bottom: y };
        diff.data.set([255, 0, 0, 255], i);
      } else {
        const v = 255 - ((255 - (pa[i] + pa[i + 1] + pa[i + 2]) / 3) * 0.25);
        diff.data.set([v, v, v, 255], i);
      }
    }
    g.putImageData(diff, 0, 0);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { pixels: n, total: width * height, box, diff: btoa(bin) };
  }, [a.toString('base64'), b.toString('base64'), THRESHOLD]);
  await context.close();
  return result;
}

const ENGINES = [['webkit', webkit], ['chromium', chromium]].filter(([n]) => !onlyEngine || n === onlyEngine);
const report = [];
for (const [engineName, engine] of ENGINES) {
  const browser = await engine.launch({ headless: true });
  try {
    const probe = await browser.newContext();
    const p = await probe.newPage();
    await p.setContent('<!doctype html><body></body>');
    await p.addScriptTag({ content: script });
    const cases = (await p.evaluate(() => P.cases())).filter((c) => !onlyCase || c === onlyCase);
    await probe.close();
    for (const name of cases) {
      const dark = /dark/.test(name);
      const old = await shoot(browser, 'old', name, dark);
      const now = await shoot(browser, 'new', name, dark);
      const d = await compare(browser, old.png, now.png);
      const base = join(out, `${name}-${engineName}`);
      writeFileSync(`${base}-old.png`, old.png);
      writeFileSync(`${base}-new.png`, now.png);
      writeFileSync(`${base}-diff.png`, Buffer.from(d.diff, 'base64'));
      const entry = {
        case: name, engine: engineName, differing: d.pixels, share: Number((100 * d.pixels / d.total).toFixed(3)), box: d.box,
        errors: [...old.errors.map((e) => `old: ${e}`), ...now.errors.map((e) => `new: ${e}`)],
        requests: [...old.requests, ...now.requests],
        warnings: now.info?.warnings ?? [], refused: now.info?.refused ?? [],
      };
      report.push(entry);
      console.log(`${engineName.padEnd(8)} ${name.padEnd(16)} ${String(entry.share).padStart(7)} %  ${String(d.pixels).padStart(7)} px  ${d.box ? `x ${d.box.left}–${d.box.right}, y ${d.box.top}–${d.box.bottom}` : ''}${entry.errors.length ? `  errors: ${entry.errors.join(' | ')}` : ''}${entry.requests.length ? `  requests: ${entry.requests.length}` : ''}`);
    }
  } finally {
    await browser.close();
  }
}
writeFileSync(join(out, 'report.json'), JSON.stringify({ threshold: THRESHOLD, viewport: VIEWPORT, results: report }, null, 2));
