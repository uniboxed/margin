import { createRequire } from 'node:module';
const require = createRequire('/home/user/margin/package.json');
const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch();
for (const fix of [false, true]) {
  const ctx = await b.newContext(); const p = await ctx.newPage();
  if (fix) await p.addInitScript(() => { if (window.top !== window) { try { void window.top.location.href; Object.defineProperty(window, 'self', { get() { return window.top; }, configurable: true }); } catch (e) {} } });
  const id = 'cr-owasp-' + fix; await p.goto('http://localhost:8701/owasp?id=' + id); await sleep(1500);
  const log = await (await fetch('http://localhost:8701/results?id=' + id)).json();
  console.log('=== Chromium OWASP snippet, main-world self fix:', fix);
  for (const e of log) if (['top-navigate', 'owasp-frame'].includes(e.ev)) console.log('  ', e.ev, JSON.stringify({ action: e.action, visible: e.visible, selfIsTop: e.selfIsTop, windowIsTop: e.windowIsTop }));
  await ctx.close();
}
await b.close();
