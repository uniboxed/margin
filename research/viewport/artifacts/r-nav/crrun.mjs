// Chromium runner: node crrun.mjs '<json array of specs>'
// spec = {url, wait, id, steps:[{js?, frameJs?, clickFrame?, wait?, record?, label?}], ext?: dir}
import { createRequire } from 'node:module';
const require = createRequire('/home/user/margin/package.json');
const { chromium } = require('playwright');

const specs = JSON.parse(process.argv[2]);
const extDir = process.env.EXT;
let ctx, browser;
if (extDir) {
  ctx = await chromium.launchPersistentContext('', { headless: false, args: ['--headless=new', `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`] });
} else {
  browser = await chromium.launch();
  ctx = await browser.newContext();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
for (const spec of specs) {
  const page = await ctx.newPage();
  const out = { url: spec.url, records: [], urlChanges: [] };
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) out.urlChanges.push(f.url()); });
  try { await page.goto(spec.url, { waitUntil: 'load', timeout: 10000 }); } catch (e) { out.gotoErr = String(e).slice(0, 120); }
  await sleep(spec.wait ?? 1500);
  for (const st of spec.steps || []) {
    try {
      if (st.js) out.jsResult = await page.evaluate(st.js);
      if (st.clickFrame) { const fr = page.frames().find((f) => f.name() === 'margin-frame'); await fr.click(st.clickFrame); }
      if (st.back) await page.goBack({ timeout: 3000 }).catch((e) => (out.backErr = String(e).slice(0, 80)));
      if (st.forward) await page.goForward({ timeout: 3000 }).catch((e) => (out.fwdErr = String(e).slice(0, 80)));
    } catch (e) { out.stepErr = String(e).slice(0, 200); }
    await sleep(st.wait ?? 0);
    if (st.record) {
      let val;
      try { val = await page.evaluate(spec.recordExpr || '({top: location.href, title: document.title, len: history.length})'); } catch (e) { val = 'ERR ' + String(e).slice(0, 100); }
      out.records.push({ label: st.label || st.js || '', page: val, url: page.url(), title: await page.title().catch(() => null) });
    }
  }
  out.finalUri = page.url();
  out.finalTitle = await page.title().catch(() => null);
  if (spec.id) out.log = await (await fetch('http://localhost:8701/results?id=' + encodeURIComponent(spec.id))).json();
  results.push(out);
  await page.close();
}
console.log(JSON.stringify(results));
await ctx.close();
if (browser) await browser.close();
