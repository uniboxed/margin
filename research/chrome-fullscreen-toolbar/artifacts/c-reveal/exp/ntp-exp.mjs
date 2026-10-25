// Headed Chromium on a private Xvfb (DISPLAY=:117, no window manager).
// Proxy for the Mac reveal lock: ImmersiveModeControllerMac::OnDidChangeFocus
// holds a reveal lock while the views-focused view is inside top chrome
// (omnibox). Here we measure where keyboard focus is after a real Ctrl+T
// (IDC_NEW_TAB) by (1) document.hasFocus() in each page and (2) whether
// xdotool-typed characters reach the page's keydown listener.
//
// usage: node ntp-exp.mjs <scenario> <action>
//   scenario: handoff (web page then Ctrl+T: Margin activates the page and
//             closes the NTP) | ntp (no web page: palette stays on the NTP)
//   action:   none | windows-update | reactivate | bounce | recreate |
//             navigate | reload | focus-js
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [scenario = 'ntp', action = 'none'] = process.argv.slice(2);
const require = createRequire('/home/user/margin/package.json');
const { chromium } = require('playwright');
const EXT = new URL('./ext', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const xdo = (...a) => { try { return execFileSync('xdotool', a, { encoding: 'utf8' }).trim(); } catch (e) { return `ERR ${e.message.split('\n')[0]}`; } };

const server = createServer((req, res) => {
  const name = decodeURIComponent(req.url.slice(1).split('?')[0]) || 'home';
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>${name}</title><body><h1>${name}</h1></body>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'crv-')), {
  headless: false,
  viewport: null,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--window-size=1000,700', '--window-position=0,0'],
});
let [worker] = context.serviceWorkers();
worker ??= await context.waitForEvent('serviceworker');
const sw = (fn, arg) => worker.evaluate(fn, arg);


// Hook keydown in every page (main world; capture on window sees keys typed
// into Margin's shadow-DOM inputs too, since keyboard events are composed).
const hook = async (p) => { try { await p.evaluate(() => { if (!window.__keys) { window.__keys = []; addEventListener('keydown', (e) => __keys.push(e.key), true); } }); } catch {} };
context.on('page', (p) => { p.on('domcontentloaded', () => hook(p)); hook(p); });

const first = context.pages()[0];
if (scenario.startsWith('handoff')) await first.goto(`${base}/page1`);
if (scenario === 'handoff-reloaded') {
  // Reload the extension (like reloading an unpacked build): page1's content
  // script is orphaned and Chrome does not inject a new one into open tabs.
  await sleep(800);
  const old = worker;
  worker.evaluate(() => chrome.runtime.reload()).catch(() => {});
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const w = context.serviceWorkers().find((x) => x !== old);
    if (w) { worker = w; break; }
    if (i === 39) {
      // Same object may be reused; open the extension page to wake a worker.
      worker = context.serviceWorkers().at(-1) ?? old;
    }
  }
  console.log('extension reloaded; new worker', worker.url());
}
await sleep(1200);
const title = scenario === 'handoff' ? 'page1' : 'about:blank';
const wid = xdo('search', '--onlyvisible', '--name', 'Chrome').split('\n').pop();
xdo('windowfocus', '--sync', wid);
xdo('mousemove', '--window', wid, '600', '450');
xdo('click', '1');
await sleep(400);

const report = async (label) => {
  const tabs = await sw(async () => (await chrome.tabs.query({})).map((t) => `${t.id}${t.active ? '*' : ''} ${t.url.replace(/^chrome-extension:\/\/[a-z]+/, 'ext:').slice(0, 50)}`)).catch(() => ['(service worker handle gone)']);
  const pages = [];
  for (const p of context.pages()) {
    await hook(p);
    try {
      pages.push(await p.evaluate(() => `${location.href.replace(/^chrome-extension:\/\/[a-z]+/, 'ext:').slice(0, 50)} hasFocus=${document.hasFocus()} vis=${document.visibilityState} keys=${JSON.stringify((window.__keys ?? []).join(''))} active=${document.activeElement?.tagName}`));
    } catch (e) { pages.push(`${p.url()} ERR`); }
  }
  console.log(`--- ${label}\n  tabs: ${tabs.join(' | ')}\n  ${pages.join('\n  ')}`);
};

xdo('key', '--clearmodifiers', 'ctrl+t'); // IDC_NEW_TAB, like ⌘T
await sleep(2500);
await report(`${scenario}: 2.5s after Ctrl+T`);
xdo('type', '--delay', '40', 'ab');
await sleep(500);
await report('after typing "ab"');

if (action !== 'none') {
  const r = await sw(async (action) => {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const ntpUrl = chrome.runtime.getURL('newtab/newtab.html');
    switch (action) {
      case 'windows-update': await chrome.windows.update(t.windowId, { focused: true }); break;
      case 'reactivate': await chrome.tabs.update(t.id, { active: true }); break;
      case 'bounce': {
        const others = (await chrome.tabs.query({ windowId: t.windowId })).filter((x) => x.id !== t.id);
        let other = others[0];
        let made = false;
        if (!other) { other = await chrome.tabs.create({ windowId: t.windowId, url: 'about:blank', active: false }); made = true; }
        await chrome.tabs.update(other.id, { active: true });
        await chrome.tabs.update(t.id, { active: true });
        if (made) await chrome.tabs.remove(other.id);
        break;
      }
      case 'recreate': {
        const n = await chrome.tabs.create({ windowId: t.windowId, index: t.index + 1, url: `${ntpUrl}#launcher`, active: true });
        await chrome.tabs.remove(t.id);
        return n.id;
      }
      case 'navigate': await chrome.tabs.update(t.id, { url: `${ntpUrl}?again#launcher` }); break;
      case 'reload': await chrome.tabs.reload(t.id); break;
    }
    return t.id + ' ' + t.url;
  }, action);
  if (action === 'enter') { xdo('key', 'Return'); }
  if (action === 'focus-js') {
    for (const p of context.pages()) { try { await p.evaluate(() => window.focus()); } catch {} }
  }
  await sleep(1500);
  await report(`after action ${action} (${r})`);
  xdo('type', '--delay', '40', 'cd');
  await sleep(500);
  await report(`after typing "cd" (action ${action})`);
}

await context.close();
server.close();
