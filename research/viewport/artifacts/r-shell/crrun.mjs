// Chromium harness: load the unpacked MV3 test extension, open each URL,
// collect content-script ('R ') console messages and the server request log.
import { createRequire } from 'module';
const require = createRequire('/home/user/margin/package.json');
const { chromium } = require('playwright');
const HERE = '/tmp/claude-0/-home-user-margin/0b6cb4e1-de7e-571b-8d96-9abc72d8e3bb/scratchpad/r-shell/';
const server = process.argv[2];
const paths = process.argv.slice(3);
const ext = HERE + 'ext';
const ctx = await chromium.launchPersistentContext('', { headless: false, viewport: { width: 1000, height: 600 }, args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
await new Promise((r) => setTimeout(r, 1000));
for (const p of paths) {
  await fetch(server + '/clear');
  const page = await ctx.newPage();
  const cs = [], cons = [];
  page.on('console', (m) => { const t = m.text(); if (t.startsWith('R ')) cs.push(JSON.parse(t.slice(2))); else cons.push(t.slice(0, 300)); });
  const t0 = Date.now();
  await page.goto(server + p, { waitUntil: 'commit' }).catch((e) => cons.push('goto:' + e.message.slice(0, 200)));
  await page.waitForTimeout(2500);
  const log = await (await fetch(server + '/log')).json();
  console.log(JSON.stringify({ url: p, t0, cs, server: log, console: cons.filter((c) => !c.startsWith('P ')) }));
  await page.close();
}
await ctx.close();
