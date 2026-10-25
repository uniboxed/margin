// Probe: does the top (shell) document render? usage: node paint-probe.mjs "#margin-stop" (needs node server.mjs running)
import { launch, A, sleep, card } from './lib.mjs';
const { context } = await launch({ headful: process.env.HEADFUL === '1' });
const page = await context.newPage();
await page.goto(`${A}/p/viewport` + (process.argv[2] || ''), { waitUntil: 'commit' });
await sleep(800);
const raf = await page.evaluate(() => Promise.race([new Promise((r) => requestAnimationFrame(() => r('raf-fired'))), new Promise((r) => setTimeout(() => r('raf-timeout'), 1000))]));
console.log('top rAF:', raf, 'readyState', await page.evaluate(() => [document.readyState, document.compatMode, JSON.stringify(performance.getEntriesByType('navigation')[0].toJSON()).slice(0,0), performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd, performance.getEntriesByType('navigation')[0].loadEventEnd]));
const f = card(page);
console.log('frame rAF:', await f.evaluate(() => Promise.race([new Promise((r) => requestAnimationFrame(() => r('raf-fired'))), new Promise((r) => setTimeout(() => r('raf-timeout'), 1000))])));
const cdp = await context.newCDPSession(page);
for (const wait of [0, 2000, 5000]) {
  await sleep(wait);
  const t = Date.now();
  const r = await Promise.race([cdp.send('Page.captureScreenshot', { format: 'png' }).then((x) => 'ok ' + x.data.length), sleep(4000).then(() => 'timeout')]);
  console.log('after extra', wait, 'ms screenshot:', r, Date.now() - t, 'ms');
}
await context.close();
