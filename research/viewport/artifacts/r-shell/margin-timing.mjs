// Load the real Margin Chrome build and compare its "injected" time with responseStart.
import { createRequire } from 'module';
const require = createRequire('/home/user/margin/package.json');
const { chromium } = require('playwright');
const server = process.argv[2];
const ext = '/home/user/margin/dist/chrome';
const ctx = await chromium.launchPersistentContext('', { headless: false, args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
await new Promise((r) => setTimeout(r, 1500));
for (const d of [0, 150, 400]) {
  for (let i = 0; i < 2; i++) {
    const page = await ctx.newPage();
    let line = null;
    page.on('console', (m) => { if (m.text().startsWith('[margin] timing')) line = m.text(); });
    await page.goto(`${server}/p?mode=none&tag=mt${d}-${i}&delay=${d}`, { waitUntil: 'load' });
    await page.waitForTimeout(800);
    const rs = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return { requestStart: Math.round(n.requestStart), responseStart: Math.round(n.responseStart), domInteractive: Math.round(n.domInteractive) }; });
    console.log(`ttfb=${d}`, JSON.stringify(rs), line);
    await page.close();
  }
}
await ctx.close();
