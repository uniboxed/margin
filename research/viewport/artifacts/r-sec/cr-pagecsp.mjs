import { createRequire } from 'module';
const require = createRequire('/home/user/margin/package.json');
const { chromium } = require('playwright');
const ext = new URL('./ext2', import.meta.url).pathname;
const V = 'http://www.victim.test:8871';
const ctx = await chromium.launchPersistentContext('', { headless: false, args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--host-resolver-rules=MAP *.test 127.0.0.1'] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
const page = await ctx.newPage();
const shellPolicy = "script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'self'";
const ruleSets = {
  noRules: [],
  mainFrame_setStrictShellCSP: [{ id: 1, priority: 1, action: { type: 'modifyHeaders', responseHeaders: [{ header: 'content-security-policy', operation: 'set', value: shellPolicy }] }, condition: { resourceTypes: ['main_frame'], requestDomains: ['www.victim.test'] } }],
};
const out = {};
for (const [rn, rules] of Object.entries(ruleSets)) {
  await sw.evaluate((r) => globalThis.setRules(r), rules);
  for (const csp of ['', "frame-src 'none'", "default-src 'none'", "child-src 'none'", "frame-src 'self'", "script-src 'self'"]) {
    await page.goto(`${V}/page?csp=${encodeURIComponent(csp)}`);
    await page.waitForFunction(() => document.title !== 'page', null, { timeout: 8000 }).catch(() => {});
    out[`${rn} | site CSP=[${csp}]`] = await page.title();
  }
}
for (const [k, v] of Object.entries(out)) console.log(k.padEnd(60), v);
await ctx.close();
