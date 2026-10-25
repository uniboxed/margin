import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, startServer } from './helpers.js';

let ctx, server;
before(async () => {
  ctx = await launch();
  server = await startServer();
});
after(async () => {
  await ctx?.context.close();
  await server?.close();
});

const records = () => ctx.worker.evaluate(async () => (await chrome.storage.session.get('probe')).probe ?? []);

test('the injection probe records an empty <html> at document_start', async () => {
  const page = await ctx.context.newPage();
  await page.goto(`${server.base}/probe-page?secret=1#x`);
  let rec;
  for (let i = 0; i < 50 && !rec; i++) {
    rec = (await records()).find((r) => r.url.endsWith('/probe-page') && r.source === 'manifest');
    if (!rec) await page.waitForTimeout(100);
  }
  assert.ok(rec, 'a record arrives');
  assert.equal(rec.verdict, 'pass');
  assert.deepEqual(rec.kids, []);
  assert.equal(rec.ready, 'loading');
  assert.equal(rec.url, `${server.base}/probe-page`, 'no query or hash stored');
  assert.equal(rec.nav, 'navigate');
  assert.equal(rec.contentType, 'text/html');
  await page.close();
});

test('the registered copy runs too, after Margin\'s own scripts', async () => {
  const page = await ctx.context.newPage();
  await page.goto(`${server.base}/probe-registered`);
  let rec;
  for (let i = 0; i < 50 && !rec; i++) {
    rec = (await records()).find((r) => r.url.endsWith('/probe-registered') && r.source === 'registered');
    if (!rec) await page.waitForTimeout(100);
  }
  assert.ok(rec, 'a registered record arrives');
  assert.ok(['pass', 'foreign'].includes(rec.verdict), rec.verdict);
  assert.ok(!rec.kids.some((k) => k === 'HEAD' || k === 'BODY'), rec.kids.join());
  await page.close();
});

test('the results page lists the records', async () => {
  const page = await ctx.context.newPage();
  await page.goto(`chrome-extension://${ctx.extensionId}/diag/probe.html`);
  await page.waitForSelector('#rows tr');
  assert.match(await page.textContent('#summary'), /^manifest: \d+\/\d+ before the parser/);
  assert.equal(await page.textContent('#rows tr td.pass'), 'pass');
  await page.close();
});
