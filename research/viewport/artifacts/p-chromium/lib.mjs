// Shared helpers for the iframe-shell prototype tests.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire('/home/user/margin/package.json');
export const { chromium } = require('playwright');

export const DIR = fileURLToPath(new URL('.', import.meta.url));
export const EXT = fileURLToPath(new URL('./ext', import.meta.url));
export const A = 'http://localhost:8921'; // site
export const B = 'http://localhost:8922'; // same-site, cross-origin
export const X = 'http://127.0.0.1:8921'; // cross-site

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startServer() {
  const child = spawn(process.execPath, [DIR + 'server.mjs'], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => {
    let n = 0;
    child.stdout.on('data', (d) => { n += (String(d).match(/listening/g) || []).length; if (n >= 2) resolve(); });
  });
  return { close: () => child.kill() };
}

export async function serverLog({ clear = false } = {}) {
  const r = await fetch(`${A}/__log${clear ? '?clear=1' : ''}`);
  return r.json();
}
export const clearLog = () => serverLog({ clear: true });

export async function launch({ ext = true, viewport = { width: 1000, height: 600 }, headful = process.env.HEADFUL === '1' } = {}) {
  const args = headful ? [] : ['--headless=new'];
  if (ext) args.push(`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`);
  const context = await chromium.launchPersistentContext('', { headless: false, viewport, args });
  let worker = null;
  if (ext) {
    [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent('serviceworker');
    // Wait until bg.js top-level code ran (test hooks defined).
    await waitFor(() => worker.evaluate(() => typeof self.setStaticRuleset === 'function'));
  }
  return { context, worker };
}

export async function waitFor(check, { timeout = 5000, interval = 25 } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await check(); } catch (e) { last = undefined; }
    if (last) return last;
    await sleep(interval);
  }
  return null;
}

// The shell's iframe (direct child of the main frame).
export const card = (page) => page.mainFrame().childFrames()[0] || null;

export async function shellLog(page) {
  try {
    return JSON.parse((await page.evaluate(() => document.documentElement.getAttribute('data-margin-log'))) || '[]');
  } catch { return null; }
}

export async function gotoShell(page, url, { wait = true } = {}) {
  // waitUntil 'load' never resolves: window.stop() at document_start means the top document
  // never fires DOMContentLoaded/load (measured, see notes). Wait for the card instead.
  await page.goto(url, { waitUntil: 'commit' });
  if (!wait) return null;
  return waitFor(async () => {
    const f = card(page);
    if (!f || f.url() === 'about:blank') return null;
    const ok = await f.evaluate(() => document.readyState === 'complete').catch(() => false);
    return ok ? f : null;
  }, { timeout: 8000 });
}

export async function frameUrlIs(page, re, timeout = 5000) {
  return waitFor(() => { const f = card(page); return f && re.test(f.url()) ? f : null; }, { timeout });
}

export const summarizeLog = (log, pred = () => true) => log.filter(pred).map((e) => `${e.t} ${e.method} ${e.host}${e.path} dest=${e.dest} site=${e.site}${e.cookie ? ' cookie=[' + e.cookie + ']' : ''}${e.body ? ' body=' + e.body : ''}`);

// Resolve to `fallback` if `p` takes longer than `ms` (pages stuck in navigation loops).
export const within = (p, ms = 1500, fallback = 'TIMEOUT') => Promise.race([Promise.resolve(p).catch((e) => 'ERR ' + String(e).split('\n')[0]), sleep(ms).then(() => fallback)]);
export const progress = (...a) => process.stderr.write(a.join(' ') + '\n');
