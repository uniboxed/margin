import { createRequire } from 'node:module';
const require = createRequire('/home/user/margin/package.json');
const { chromium } = require('playwright');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1000, height: 600 } });
for (const s of ['margin', 'transform', 'filter', 'body-scroller', 'zoom']) {
  await p.goto(`file://${process.argv[2]}/probe.html?s=${s}`);
  const r = await p.evaluate(() => window.run());
  console.log(s.padEnd(14), JSON.stringify(r));
}
await b.close();
