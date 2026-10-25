import { createRequire } from 'node:module';
const require = createRequire('/home/user/margin/package.json');
const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => (typeof s === 'string' ? s.replaceAll('http://localhost:8701', '') : s);
const REC = `({top: location.href, frame: (()=>{try{return __f.contentWindow.location.href}catch(e){return 'XO/none'}})(), title: document.title, ev: (window.__events||[]).splice(0)})`;
const b = await chromium.launch();
for (const route of ['hist2', 'hist']) {
  const ctx = await b.newContext(); const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  const bf = async () => { const h = await cdp.send('Page.getNavigationHistory'); return h.entries.map((e, i) => (i === h.currentIndex ? '*' : '') + strip(e.url) + ' "' + e.title + '"'); };
  const uiGo = async (delta) => { const h = await cdp.send('Page.getNavigationHistory'); await cdp.send('Page.navigateToHistoryEntry', { entryId: h.entries[h.currentIndex + delta].id }); };
  console.log(`=== Chromium route=${route} (browser-initiated back/forward via CDP Page.navigateToHistoryEntry)`);
  await p.goto(`http://localhost:8701/${route}?n=A&sync=1`); await sleep(800);
  const rec = async (label) => { let r; try { r = await p.evaluate(REC); } catch (e) { r = { err: String(e).slice(0, 80), ev: [] }; } console.log(`  ${label.padEnd(10)} addressbar=${strip(p.url()).padEnd(28)} top=${strip(r.top)?.padEnd(28)} frame=${strip(r.frame)?.padEnd(14)} title=${JSON.stringify(r.title)} ev=${JSON.stringify((r.ev || []).map(strip))}`); console.log('              BF:', JSON.stringify(await bf())); };
  await rec('initial');
  for (const n of ['B', 'C']) {
    if (route === 'hist2') await p.evaluate(`navFrame('/hist2?n=${n}')`); else await p.evaluate(`__f.contentWindow.eval("location.href='/hist?n=${n}'")`);
    await sleep(900); await rec('frame->' + n);
  }
  await uiGo(-1); await sleep(900); await rec('UI back');
  await uiGo(+1); await sleep(900); await rec('UI fwd');
  await p.evaluate(`location.href='http://localhost:8702/site?id=leave&role=xo'`); await sleep(1200); await rec('left site');
  for (const [lbl, d] of [['UI back', -1], ['UI back', -1], ['UI back', -1], ['UI fwd', +1]]) { await uiGo(d); await sleep(1500); await rec(lbl); }
  await ctx.close();
}
await b.close();
