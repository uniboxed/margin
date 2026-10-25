// The user's idea: move the page into our own wrapper positioned where the card is.
import { createRequire } from 'node:module';
const require = createRequire('/home/user/margin/package.json');
const { chromium } = require('playwright');
const W = 260;
const VARIANTS = {
  'absolute wrapper': `position:absolute; top:0; left:${W}px; right:8px;`,
  'absolute + transform': `position:absolute; top:0; left:${W}px; right:8px; transform:translateZ(0);`,
  'fixed scrolling wrapper + transform': `position:fixed; top:0; bottom:0; left:${W}px; right:8px; overflow:auto; transform:translateZ(0);`,
};
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1000, height: 600 } });
for (const [name, css] of Object.entries(VARIANTS)) {
  await p.goto(`file://${process.argv[2]}/probe.html`);
  const r = await p.evaluate(async (css) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = css;
    wrap.append(...document.body.childNodes);
    document.body.append(wrap);
    const out = await window.run();
    wrap.scrollTop = 500;
    await new Promise((r) => setTimeout(r, 100));
    const h = document.getElementById('header').getBoundingClientRect();
    out.afterWrapperScroll = { header: [Math.round(h.left), Math.round(h.top), Math.round(h.right)] };
    return out;
  }, css);
  console.log(name.padEnd(36), JSON.stringify(r));
}
await b.close();
