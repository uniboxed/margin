// Test matrix for the same-origin iframe shell prototype (real unpacked MV3 extension, Chromium).
// Usage: node run.mjs [T1 T2 ...]   (no args = all). Results: results/<T>.json + stdout.
import { mkdirSync, writeFileSync } from 'node:fs';
import { A, B, X, DIR, launch, startServer, serverLog, clearLog, waitFor, card, shellLog, gotoShell, frameUrlIs, sleep, summarizeLog } from './lib.mjs';
import { tests as more } from './tests2.mjs';

mkdirSync(DIR + 'results', { recursive: true });

const measureViewport = () => {
  const r = (id) => document.getElementById(id).getBoundingClientRect();
  return {
    url: location.href,
    innerWidth, innerHeight,
    clientWidth: document.documentElement.clientWidth,
    headerLeft: r('hdr').left, headerWidth: r('hdr').width, headerTop: r('hdr').top,
    vwWidth: r('vw').width,
    mq800: matchMedia('(max-width: 800px)').matches,
    mqCssContent: getComputedStyle(document.getElementById('mq'), '::after').content,
    visualViewportWidth: visualViewport.width,
    scrollY, scrolls: window.__scrolls,
  };
};

const tests = {
  // ------------------------------------------------------------------ T1 viewport
  async T1() {
    const out = {};
    for (const ext of [false, true]) {
      const { context } = await launch({ ext });
      const page = await context.newPage();
      let f;
      if (ext) f = await gotoShell(page, `${A}/p/viewport`);
      else { await page.goto(`${A}/p/viewport`); f = page.mainFrame(); }
      const res = { before: await f.evaluate(measureViewport) };
      if (ext) res.iframeRectInTop = await page.evaluate(() => JSON.parse(JSON.stringify(document.getElementById('margin-frame').getBoundingClientRect())));
      await page.screenshot({ path: `${DIR}results/T1-${ext ? 'shell' : 'plain'}.png` });
      // Wheel over the page area (inside the card when shelled).
      await page.mouse.move(600, 300);
      await page.mouse.wheel(0, 600);
      await sleep(400);
      res.afterWheel = await f.evaluate(measureViewport);
      res.topScrollY = await page.evaluate(() => scrollY);
      await f.evaluate(() => window.scrollTo(0, 1500));
      await sleep(200);
      res.afterScrollTo = await f.evaluate(measureViewport);
      await page.screenshot({ path: `${DIR}results/T1-${ext ? 'shell' : 'plain'}-scrolled.png` });
      out[ext ? 'shell' : 'plain'] = res;
      await context.close();
    }
    const s = out.shell, w = s.iframeRectInTop.width;
    out.verdict = {
      iframeWidth: w,
      headerSpansIframe: s.before.headerLeft === 0 && s.before.headerWidth === s.before.clientWidth,
      vwEqualsIframe: s.before.vwWidth === w,
      innerWidthEqualsIframe: s.before.innerWidth === w,
      mqReflectsIframe: s.before.mq800 === (w <= 800),
      wheelScrolls: s.afterWheel.scrollY > 0 && s.afterWheel.scrolls > 0,
      headerStaysPut: s.afterWheel.headerTop === 0 && s.afterScrollTo.headerTop === 0,
    };
    return out;
  },

  // ------------------------------------------------------------------ T2 cookies + storage
  async T2() {
    const out = {};
    const { context } = await launch();
    const page = await context.newPage();
    await clearLog();
    // 1. Direct top-level visit whose response sets Lax, Strict and HttpOnly cookies.
    const f = await gotoShell(page, `${A}/p/cookies?cookie=1`);
    let log = await serverLog();
    out.firstVisit = summarizeLog(log, (e) => e.path.startsWith('/p/cookies'));
    out.frameDocumentCookie = await f.evaluate(() => document.cookie);
    // 2. Arrive cross-site: start on 127.0.0.1 (another site), click a link to localhost:8922.
    await gotoShell(page, `${X}/p/start-xs`);
    await clearLog();
    await card(page).click('#xo'); // http://localhost:8922/p/xo (cross-site from 127.0.0.1)
    await waitFor(() => page.url().startsWith(B));
    const f2 = await waitFor(async () => { const c = card(page); return c && c.url().startsWith(B) && (await c.evaluate(() => document.readyState === 'complete').catch(() => false)) ? c : null; });
    log = await serverLog();
    out.crossSiteArrival = summarizeLog(log, (e) => e.path.startsWith('/p/xo'));
    out.crossSiteArrivalFrameCookie = await f2?.evaluate(() => document.cookie);
    out.crossSiteArrivalReferer = log.filter((e) => e.path.startsWith('/p/xo') && (e.dest === 'document' || e.dest === 'iframe')).map((e) => `${e.dest}: Referer=${e.referer || '(none)'} Sec-Fetch-User=${e.user ?? '(none)'}`);
    out.crossSiteArrivalDocumentReferrerInCard = await f2?.evaluate(() => document.referrer);
    // 3. Storage: written top-level without the shell, read inside the shell's card, and back.
    const plain = await context.newPage();
    await plain.goto(`${A}/p/storage#margin-noshell`);
    await plain.evaluate(() => { localStorage.setItem('fromPlainTop', 'yes'); });
    const f3 = await gotoShell(page, `${A}/p/storage2`);
    out.storage = {
      cardSeesPlainTopLocalStorage: await f3.evaluate(() => localStorage.getItem('fromPlainTop')),
    };
    await f3.evaluate(() => { localStorage.setItem('fromCard', 'yes'); sessionStorage.setItem('ss', 'card'); });
    out.storage.shellTopSeesCardLocalStorage = await page.evaluate(() => localStorage.getItem('fromCard'));
    out.storage.shellTopSeesCardSessionStorage = await page.evaluate(() => sessionStorage.getItem('ss'));
    out.storage.plainTopSeesCardLocalStorage = await plain.evaluate(() => localStorage.getItem('fromCard'));
    await context.close();
    return out;
  },

  // ------------------------------------------------------------------ T3 same-origin navigation in the card
  async T3() {
    const out = {};
    const { context } = await launch();
    const page = await context.newPage();
    const f = await gotoShell(page, `${A}/p/A`);
    await page.evaluate(() => { window.__marker = 'top-alive'; });
    await clearLog();
    const t0 = Date.now();
    await f.click('#b');
    const fb = await frameUrlIs(page, /\/p\/B$/);
    const synced = await waitFor(async () => page.url().endsWith('/p/B') && (await page.title()) === 'page B');
    out.linkClick = {
      frameUrl: fb?.url(), topUrl: page.url(), topTitle: await page.title(), syncedMs: Date.now() - t0, synced: !!synced,
      topMarker: await page.evaluate(() => window.__marker),
      topNavEntries: await page.evaluate(() => performance.getEntriesByType('navigation').length),
      requests: summarizeLog(await serverLog(), (e) => e.dest === 'document' || e.dest === 'iframe'),
      favicon: await page.evaluate(() => document.querySelector('link[rel=icon]')?.href),
      themeColor: await page.evaluate(() => document.querySelector('meta[name=theme-color]')?.content),
    };
    // SPA pushState + title change + hash link inside the card.
    const fc = card(page);
    await fc.evaluate(() => history.pushState({}, '', '/spa/one?x=1'));
    await waitFor(() => page.url().endsWith('/spa/one?x=1'), { timeout: 2000 });
    out.pushState = { topUrl: page.url() };
    await fc.evaluate(() => { document.title = 'SPA title'; });
    await waitFor(async () => (await page.title()) === 'SPA title', { timeout: 2000 });
    out.titleChange = { topTitle: await page.title() };
    await fc.evaluate(() => history.replaceState({}, '', '/p/B'));
    await fc.click('#hash');
    await waitFor(() => page.url().endsWith('#section2'), { timeout: 2000 });
    out.hashLink = { topUrl: page.url(), frameUrl: card(page).url() };
    out.topMarkerAtEnd = await page.evaluate(() => window.__marker);
    out.shellLog = (await shellLog(page)).filter((e) => e.ev !== 'focus');
    await context.close();
    return out;
  },
  ...more,
};

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(tests);
const server = await startServer();
const summary = {};
try {
  for (const name of wanted) {
    const t = Date.now();
    try {
      const res = await tests[name]();
      writeFileSync(`${DIR}results/${name}.json`, JSON.stringify(res, null, 2));
      summary[name] = { ok: true, ms: Date.now() - t };
      console.log(`== ${name} (${Date.now() - t} ms)\n${JSON.stringify(res.verdict ?? res, null, 1).slice(0, 6000)}`);
    } catch (e) {
      summary[name] = { ok: false, error: String(e.stack || e) };
      console.log(`== ${name} FAILED\n${e.stack || e}`);
    }
  }
} finally {
  server.close();
}
writeFileSync(`${DIR}results/summary-${wanted.join('_')}.json`, JSON.stringify(summary, null, 2));
process.exit(0);
