import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTo } from '../../scripts/build.js';

// Resolve playwright from local node_modules or the globally installed copy.
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

// The Chrome build (`npm run test:e2e` rebuilds dist/ first).
export const EXTENSION_PATH = fileURLToPath(new URL('../../dist/chrome', import.meta.url));

// Safari's behavior (shared/platform.js profile) with Chrome's manifest, so
// the tests can load it the same way as the Chrome build.
export function buildSafariProfile() {
  return buildTo(join(mkdtempSync(join(tmpdir(), 'margin-safari-')), 'ext'), { profile: 'safari', manifest: 'chrome' });
}

// A copy of a build whose hosts show their state (shared/dom.js mark).
function marked(built) {
  const copy = join(mkdtempSync(join(tmpdir(), 'margin-marks-')), 'ext');
  cpSync(built, copy, { recursive: true });
  const bundle = join(copy, 'content/content.bundle.js');
  writeFileSync(bundle, `globalThis.__marginMarks = true;\n${readFileSync(bundle, 'utf8')}`);
  return copy;
}

export async function launch({ extensionPath: built = EXTENSION_PATH } = {}) {
  const extensionPath = marked(built);
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      '--headless=new',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  // E2E drives ordinary headless windows. Chrome builds default to Margin's
  // full-screen-only mode, where the launcher becomes a notice and page
  // content scripts stay dormant. Send the setting through the background's
  // real handler (not storage.local directly, which would desynchronise its
  // in-memory store) before any test page opens.
  const setup = await context.newPage();
  try {
    await setup.goto(`chrome-extension://${extensionId}/newtab/newtab.html#launcher`);
    await setup.evaluate(async () => {
      for (let i = 0; i < 200; i++) {
        try {
          const answer = await chrome.runtime.sendMessage({ type: 'updateSettings', patch: { fullscreenOnly: false } });
          if (answer?.ok) return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('Margin background did not accept the E2E settings');
    });
  } finally {
    await setup.close();
  }
  return { context, worker, extensionId };
}

// Tiny local site so content scripts have an http(s) page to match.
export async function startServer() {
  const server = createServer((req, res) => {
    const name = decodeURIComponent(req.url.slice(1).split('?')[0]) || 'home';
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const bg = req.url.includes('dark') ? '#111' : '#fff';
    res.end(`<!doctype html><title>${name}</title><body style="margin:0;background:${bg}"><h1>${name}</h1></body>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

// Closed shadow roots are invisible to page JS and Playwright locators, but
// the DevTools protocol can pierce them. Runs `fn` with `this` = shadow root.
export async function evalInShadow(page, hostTag, fn, ...args) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const host = findNode(root, (n) => n.localName === hostTag);
    if (!host?.shadowRoots?.length) return undefined;
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: host.shadowRoots[0].backendNodeId });
    const { result, exceptionDetails } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: fn.toString(),
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  } finally {
    await cdp.detach();
  }
}

// The page-box intentionally virtualizes DOM geometry in the page world. Use
// DevTools' layout model when a test needs the pixels actually painted by an
// extension node inside its closed shadow root.
export async function boxInShadow(page, hostTag, selector) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const host = findNode(root, (node) => node.localName === hostTag);
    if (!host?.shadowRoots?.length) return undefined;
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: host.shadowRoots[0].backendNodeId });
    const { result, exceptionDetails } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: 'function (selector) { return this.querySelector(selector); }',
      arguments: [{ value: selector }],
      returnByValue: false,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    if (!result.objectId || result.subtype === 'null') return undefined;
    const { model } = await cdp.send('DOM.getBoxModel', { objectId: result.objectId });
    const xs = model.border.filter((_, index) => index % 2 === 0);
    const ys = model.border.filter((_, index) => index % 2 === 1);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    const right = Math.max(...xs);
    const bottom = Math.max(...ys);
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  } finally {
    await cdp.detach();
  }
}

function findNode(node, pred) {
  if (pred(node)) return node;
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
    const found = findNode(child, pred);
    if (found) return found;
  }
  return null;
}

export async function waitFor(check, { timeout = 5000, interval = 50 } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await check();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor timed out (last value: ${JSON.stringify(last)})`);
}

// Sidebar state from inside the closed shadow root.
export function sidebarSnapshot(page) {
  return evalInShadow(page, 'margin-sidebar-host', function () {
    const q = (sel) => [...this.querySelectorAll(sel)];
    const aside = this.querySelector('.margin-sidebar');
    return {
      open: aside.classList.contains('open'),
      theme: aside.dataset.theme,
      chips: q('.chip').map((c) => ({ id: c.dataset.spaceId, active: c.classList.contains('active') })),
      pins: q('.pin .title').map((n) => n.textContent),
      tabs: q('.tab .title').map((n) => n.textContent),
    };
  });
}

// Click the first element matching `selector` (optionally containing `text`) in the shadow root.
export function clickInShadow(page, selector, text) {
  return evalInShadow(page, 'margin-sidebar-host', function (sel, txt) {
    const node = [...this.querySelectorAll(sel)].find((n) => txt == null || (n.closest('li') ?? n).textContent.includes(txt));
    if (!node) throw new Error(`no ${sel} ${txt ?? ''}`);
    node.click();
    return true;
  }, selector, text ?? null);
}

export const tabsInBrowser = (worker) =>
  worker.evaluate(() => chrome.tabs.query({}).then((ts) => ts.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active }))));

export function paletteSnapshot(page) {
  return evalInShadow(page, 'margin-palette-host', function () {
    const open = !!this.querySelector('.palette.shown');
    const rows = [...this.querySelectorAll('.results li[data-id]')];
    return {
      open,
      focused: this.activeElement?.classList.contains('query') ?? false,
      ids: rows.map((r) => r.dataset.id),
      titles: rows.map((r) => r.querySelector('.title').textContent),
      selected: rows.find((r) => r.getAttribute('aria-selected') === 'true')?.dataset.id ?? null,
    };
  });
}

// Margin's launcher page opened on purpose (not as a fresh ⌘T tab, which
// hands off to the palette and closes itself).
export const launcherUrl = (ctx) => `chrome-extension://${ctx.extensionId}/newtab/newtab.html#launcher`;
// Opens the launcher and waits until the active theme has drawn it (the
// new-tab page loads the theme's module, then mounts it).
export async function gotoLauncher(page, ctx) {
  await page.goto(launcherUrl(ctx));
  await page.waitForSelector('#launcher');
}

// Change settings through the background's model, using a short-lived
// extension page as the sender. Writing storage directly leaves its in-memory
// state stale and makes subsequent registration/layout assertions racy.
export async function updateSettings(ctx, patch) {
  const control = await ctx.context.newPage();
  try {
    await gotoLauncher(control, ctx);
    const answer = await control.evaluate((next) => chrome.runtime.sendMessage({ type: 'updateSettings', patch: next }), patch);
    if (!answer?.ok) throw new Error(`updateSettings failed: ${JSON.stringify(answer)}`);
  } finally {
    await control.close();
  }
}

// One key of Margin's state, from the worker. The open tabs, their spaces and
// each window's space are stored together as `openTabs`, and lostTabs as
// `lostTabs2` (extension/shared/stored.js); everything else under its own name.
export function readState(worker, key) {
  return worker.evaluate((k) => chrome.storage.local.get(null).then((raw) => {
    if (['tabs', 'tabSpace', 'activeSpaceByWindow'].includes(k)) return raw.openTabs?.[k];
    if (k === 'lostTabs') return raw.lostTabs2;
    return raw[k];
  }), key);
}
