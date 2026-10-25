import { createRequire } from 'node:module';
const require = createRequire('/home/user/margin/package.json');
const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => (typeof s === 'string' ? s.replaceAll('http://localhost:8701', '') : s);
const REC = `({top: location.href, frame: (()=>{try{return __f.contentWindow.location.href}catch(e){return 'XO'}})(), len: history.length, title: document.title, ev: __events.splice(0)})`;
const b = await chromium.launch();
for (const sync of [1, 0]) {
  const ctx = await b.newContext(); const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  const bf = async () => { const h = await cdp.send('Page.getNavigationHistory'); return h.entries.map((e, i) => (i === h.currentIndex ? '*' : '') + strip(e.url) + ' "' + e.title + '"'); };
  console.log(`=== Chromium sync=${sync}`);
  await p.goto(`http://localhost:8701/hist?n=A&sync=${sync}`); await sleep(800);
  const rec = async (label) => { const r = await p.evaluate(REC); console.log(`  ${label.padEnd(10)} addressbar=${strip(p.url()).padEnd(18)} top=${strip(r.top).padEnd(18)} frame=${strip(r.frame).padEnd(18)} len=${r.len} title=${JSON.stringify(r.title)} ev=${JSON.stringify(r.ev.map(strip))}`); console.log('              BF(oldest->newest, *=current):', JSON.stringify(await bf())); };
  await rec('initial');
  for (const n of ['B', 'C']) { await p.evaluate(`__f.contentWindow.eval("location.href='/hist?n=${n}'")`); await sleep(900); await rec('frame->' + n); }
  for (const [lbl, js] of [['back#1', 'history.back()'], ['back#2', 'history.back()'], ['forward#1', 'history.forward()']]) { await p.evaluate(js); await sleep(900); await rec(lbl); }
  await p.reload(); await sleep(1200); await rec('reload');
  await ctx.close();
}
await b.close();
