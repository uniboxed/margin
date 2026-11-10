// Screenshots of Tirth's "Browser Theme Explorations" boards (docs/phase6/
// boards/*.dc.html), headless Chromium, for comparing a theme with its board.
// The Design canvas runtime (support.js) isn't in the repo: dc-shim.js stands
// in for it ({{holes}}, sc-if, sc-for, on* handlers, setState).
//
//   node tools/boards/render.mts <board.dc.html> <out-dir> [name='{"state":…}'[|hover-selector]]…
//
// Every request is refused. The boards ask Google Fonts for their fonts;
// instead each family is loaded from the theme packages' bundled woff2
// (FONTS below); a family not bundled yet falls back to the system's, and
// the run says so. Each state is applied on top of the one before.
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const root = new URL('../../', import.meta.url);
const FONTS = [
  ['Archivo Black', 'extension/themes/neubrutalism/fonts/archivo-black-latin.woff2', '400'],
  ['Space Grotesk', 'extension/themes/neubrutalism/fonts/space-grotesk-latin.woff2', '300 700'],
  ['Press Start 2P', 'extension/themes/pixel/fonts/press-start-2p-latin.woff2', '400'],
  ['Pixelify Sans', 'extension/themes/pixel/fonts/pixelify-sans-latin.woff2', '400 700'],
];

const [board, out, ...states] = process.argv.slice(2);
if (!board || !out) {
  console.error('usage: node tools/boards/render.mts <board.dc.html> <out-dir> [name=json[|hover]]…');
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const faces = FONTS.map(([family, file, weight]) => {
  const path = new URL(file, root);
  if (!existsSync(path)) { console.log(`not bundled yet: ${family} (system font used)`); return ''; }
  return `@font-face{font-family:'${family}';font-weight:${weight};src:url(data:font/woff2;base64,${readFileSync(path).toString('base64')}) format('woff2')}`;
}).join('');
const shim = readFileSync(new URL('dc-shim.js', import.meta.url), 'utf8');
const html = readFileSync(board, 'utf8')
  .replace('<script src="./support.js"></script>', `<style>${faces}</style><script>${shim}</script>`);
const { width = 1440, height = 900 } = JSON.parse(/data-props='([^']*)'/.exec(html)?.[1] ?? '{}').$preview ?? {};

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.route('**/*', (route) => route.abort());
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('page error:', e.message));
  await page.setContent(html);
  await page.waitForFunction(() => (window as any).__ready);
  await page.evaluate(() => document.fonts.ready);
  const name = basename(board).replace(/\.dc\.html$/, '');
  await page.screenshot({ path: join(out, `${name}-default.png`) });
  for (const spec of states) {
    const [label, rest = ''] = spec.split(/=(.*)/s);
    const [json, hover] = rest.split('|');
    await page.mouse.move(width / 2, height / 2);
    await page.evaluate((j) => { const w = (window as any); Object.assign(w.__dc.state, JSON.parse(j || '{}')); w.__rerender(); }, json);
    if (hover) await page.hover(hover);
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(out, `${name}-${label}.png`) });
  }
} finally {
  await browser.close();
}
