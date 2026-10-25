// Headed Chromium on DISPLAY=:99: does keyboard (views) focus end up in the
// previous tab's web contents after Margin's ⌘T hand-off, or does it stay in
// the omnibox (which is what holds ImmersiveModeControllerMac::focus_lock_ on
// a Mac in immersive full screen)?
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire('/home/user/margin/package.json');
const { chromium } = require('playwright');
const EXT = new URL('./ext', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env };
const xdo = (...args) => {
  try { return execFileSync('xdotool', args, { env, encoding: 'utf8' }).trim(); } catch (e) { return `ERR ${e.message.split('\n')[0]}`; }
};

const server = createServer((req, res) => {
  const name = decodeURIComponent(req.url.slice(1).split('?')[0]) || 'home';
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>${name}</title><body><h1>${name}</h1><script>
    window.__keys = [];
    addEventListener('keydown', (e) => __keys.push(e.key), true);
  </script></body>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const variant = process.argv[2] ?? 'baseline';
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'crv-')), {
  headless: false,
  // env inherited
  viewport: null,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--window-size=1000,700', '--window-position=0,0'],
});
let [worker] = context.serviceWorkers();
worker ??= await context.waitForEvent('serviceworker');
const page = context.pages()[0];
await page.goto(`${base}/page1`);
await sleep(1500);

const sw = (fn, arg) => worker.evaluate(fn, arg);
const tabs = () => sw(async () => (await chrome.tabs.query({})).map((t) => ({ id: t.id, active: t.active, url: t.url.replace(/^chrome-extension:\/\/[a-z]+/, 'ext:') })));
const state = async (label) => {
  const pages = context.pages();
  const out = { label, tabs: await tabs(), x11focus: xdo('getwindowfocus', 'getwindowname') };
  out.pages = await Promise.all(pages.map(async (p) => {
    try {
      return await p.evaluate(() => ({ url: location.href.slice(0, 60), hasFocus: document.hasFocus(), visibility: document.visibilityState, keys: (window.__keys ?? []).join(''), active: document.activeElement?.tagName }));
    } catch (e) { return { url: p.url(), err: String(e).slice(0, 80) }; }
  }));
  console.log(JSON.stringify(out));
};

// Give the X window input focus, then click into the page so the web contents
// has views focus (a real user on a page).
const wid = xdo('search', '--onlyvisible', '--name', 'page1').split('\n').pop();
console.log('window', wid, xdo('getwindowname', wid));
xdo('windowactivate', '--sync', wid);
xdo('windowfocus', '--sync', wid);
await sleep(300);
// Click in the page (x=500,y=400 is inside the web contents for a 1000x700 window).
xdo('mousemove', '--window', wid, '600', '450');
xdo('click', '1');
await sleep(500);
await state('before ctrl+t (page clicked)');
xdo('type', '--delay', '50', 'p');
await sleep(300);
await state('typed "p" before ctrl+t');

// Real browser accelerator: Ctrl+T -> IDC_NEW_TAB -> chrome::NewTab (⌘T on Mac).
xdo('key', '--clearmodifiers', 'ctrl+t');
await sleep(2500);
await state('2.5s after ctrl+t (Margin hand-off done?)');
xdo('type', '--delay', '50', 'xyz');
await sleep(500);
await state('after typing "xyz"');

if (variant === 'windows-update') {
  await sw(async () => { const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); await chrome.windows.update(t.windowId, { focused: true }); });
} else if (variant === 'reactivate') {
  await sw(async () => { const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); await chrome.tabs.update(t.id, { active: true }); });
} else if (variant === 'bounce') {
  await sw(async () => {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tmp = await chrome.tabs.create({ windowId: t.windowId, url: 'about:blank', active: true });
    await chrome.tabs.update(t.id, { active: true });
    await chrome.tabs.remove(tmp.id);
  });
} else if (variant === 'window-focus') {
  await context.pages()[0].evaluate(() => window.focus());
}
if (variant !== 'baseline') {
  await sleep(800);
  await state(`after variant ${variant}`);
  xdo('type', '--delay', '50', 'q');
  await sleep(500);
  await state(`after typing "q" (variant ${variant})`);
}

await context.close();
server.close();
