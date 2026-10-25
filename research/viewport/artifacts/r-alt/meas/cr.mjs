import { createRequire } from 'module';
const require = createRequire('/home/user/margin/package.json');
const { chromium } = require('playwright');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1000, height: 600 } });
for (const u of process.argv.slice(2)) {
  await p.goto(u);
  try { await p.waitForFunction(() => document.title.startsWith('{'), null, { timeout: 8000 }); console.log(await p.title()); }
  catch (e) { console.log('TIMEOUT', u); }
}
await b.close();
