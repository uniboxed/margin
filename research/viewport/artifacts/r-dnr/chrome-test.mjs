import { createRequire } from 'module';
const require = createRequire('/home/user/margin/package.json');
const { chromium } = require('playwright');
const ext = process.argv[2];
const B = 'http://127.0.0.1:8763', X = 'http://localhost:8763';
const cases = {
  sameOriginShell: `${B}/shell?f=/plain,/xfo-deny,/xfo-same,/csp-none,/csp-self`,
  thirdPartyTop: `${X}/shell?f=${B}/plain,${B}/xfo-deny,${B}/csp-none`,
  nestedAttack: `${X}/shell?f=${encodeURIComponent(B + '/shell?f=/xfo-deny,/csp-none')}&expect=/xfo-deny,/csp-none`,
};
const args = ext ? ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`] : ['--headless=new'];
const ctx = await chromium.launchPersistentContext('', { headless: false, args });
if (ext) { let sw = ctx.serviceWorkers()[0]; await new Promise((r) => setTimeout(r, 1500)); }
const out = {};
for (const [k, url] of Object.entries(cases)) {
  const p = await ctx.newPage();
  await p.goto(url);
  await p.waitForFunction(() => document.title !== 'pending', null, { timeout: 8000 }).catch(() => {});
  out[k] = JSON.parse(await p.title().catch(() => '"?"'));
  await p.close();
}
for (const k in out) for (const n in out[k]) if (typeof out[k][n] === "object") out[k][n] = "LOADED" + (out[k][n].xm ? "+xm" : ""); console.log(JSON.stringify(out));
await ctx.close();
