import { createRequire } from 'node:module';
const require = createRequire('/home/user/margin/package.json');
const { chromium } = require('playwright');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1000, height: 600 } });
for (const m of ['push', 'zoom']) {
  await p.goto(`file://${process.argv[2]}/zoomfit.html?mode=${m}`);
  await p.waitForFunction(() => document.title.startsWith('{'));
  console.log(`chromium ${m}: ${await p.title()}`);
}
await b.close();
