// Real sites: screenshot the push alone vs push + adapter (code from adapter2.html).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire('/home/user/margin/package.json');
const { chromium } = require('playwright');
const dir = process.argv[2];
const html = readFileSync(`${dir}/adapter2.html`, 'utf8');
// The adapter: everything in the script up to the measurement helpers.
const body = html.split('<script>')[1].split('const measure =')[0].replace('const ms = adaptAll();', '');
const code = `(() => { ${body}; return { ms: adaptAll(), marked: document.querySelectorAll('[data-mfx]').length }; })()`;
const pushOnly = `(() => { ${body.split('const hasTypedOM')[0]} })()`;
const SITES = (process.argv[3] || 'https://www.google.com/search?q=arc+browser,https://github.com/tirrth,https://www.youtube.com,https://www.apple.com,https://stripe.com').split(',');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
for (const url of SITES) {
  const name = new URL(url).hostname.replace(/^www\./, '');
  try {
    await p.goto(url, { waitUntil: 'load', timeout: 20000 });
    await p.waitForTimeout(1500);
    await p.evaluate(pushOnly);
    await p.waitForTimeout(300);
    await p.screenshot({ path: `${dir}/real-${name}-push.png` });
    const r = await p.evaluate(code);
    await p.waitForTimeout(300);
    await p.screenshot({ path: `${dir}/real-${name}-adapted.png` });
    console.log(name, JSON.stringify(r));
  } catch (e) {
    console.log(name, 'FAILED', e.message.split('\n')[0]);
  }
}
await b.close();
