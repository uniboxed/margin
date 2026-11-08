// Test pages for the WebKit host, and the log sink the test copy of Margin
// posts its console output to (run.sh adds that hook). Port 47811, or
// MARGIN_HOST_PORT.
//   /p/<Name>  a plain page titled <Name> ("F…": with a textarea; "P…": with a POST form; "S…": still loading for 1.5s;
//              "I…": another site's frame with text in a field; "J…": another site's frame with nothing typed,
//              and empty, srcdoc and sandboxed frames; "K…": a data: frame;
//              "H…": heavy to paint, on a dark background, as a busy site is; "G…": a field with autofocus;
//              "T…": tall, with rules about the window's size for the box to answer;
//              "B…": busy, as a site with ads and animations is: a timer every 50ms doing work, a CSS animation, a frame loop;
//              "Z…": all there at once, but its load comes late: an image that takes 3s;
//              "Y…": an app's page: parsed at once with an empty body, its own content drawn by its script 0.25s
//              later (window.__textAt), its load at 3s; window.__liftAt: when Margin's loading cover lifted)
//   /fp/<Name>?late=N  a page that records where <html> is in each of its first frames (window.__fp:
//              the page's first paint, Margin 2 Phase 3), holding Margin's word to its box back
//              until N ms (as Safari runs content scripts late) so the first paint alone is seen
//   /csp/<Name>  a page under a strict CSP, its sheet from /box.css
//   /x/<name>  a fixture for the box (FIXTURES: pages with one thing a box has to get right)
//   /other.css  a sheet of another origin, no CORS (on localhost: the page is on 127.0.0.1)
//   /box.css   rules about the window's size
//   /posted    where the POST form goes
//   /slow?ms=N an image that arrives N ms after it's asked for
//   POST /log  one log line, printed with a timestamp
import { createServer } from 'node:http';
import { boxPage } from '../../tests/box/serve.js';

const PORT = Number(process.env.MARGIN_HOST_PORT) || 47811;
const t0 = Date.now();
const stamp = () => `[${String(Date.now() - t0).padStart(6)}]`;

// In the host's 1200 window, true of the box at 260 and not of the window.
const BOX_CSS = `#wide { color: rgb(9, 9, 9); }
@media (max-width: 1000px) { #wide { color: rgb(1, 2, 3); } }
#full { width: 100vw; height: 10px; }
#bleed { margin-left: calc(50% - 50vw); margin-right: calc(50% - 50vw); height: 10px; }
.locked { overflow: hidden; }`;
const BOX_BODY = '<h1 id=wide>Tall</h1><div id=full></div><div style="width: 400px"><div id=bleed></div></div><div id=inline style="height: 100vh"></div><div style="height: 3000px">end</div>';
const TALL = '<div style="height: 5000px">tall</div>';
// A read is a <margin-read> in <html> for a moment: this counts them.
const COUNT_READS = `<script>window.__reads = 0; new MutationObserver((records) => { for (const r of records) for (const n of r.addedNodes) if (n.localName === 'margin-read') __reads++; }).observe(document.documentElement, { childList: true });</script>`;
// Where <html> is in each of a page's first 40 frames (at each rendering
// update, before it's drawn: after the page's world's own look, which asked
// for its frame first), and what the first paint's CSS said then. Margin's
// word to the page's box (`margin:box`) is held back until `late` ms, as
// Safari's content scripts come about that late (Spike 4).
const FIRST_FRAMES = `<script>(() => {
  const late = Number(new URLSearchParams(location.search).get('late') || 0);
  const fp = window.__fp = { frames: [], held: 0, heard: 0 };
  addEventListener('margin:box', (e) => { if (performance.now() < late) { e.stopImmediatePropagation(); e.preventDefault(); fp.held++; } else fp.heard++; }, true);
  const look = () => {
    const html = document.documentElement;
    const s = getComputedStyle(html);
    const m = new DOMMatrix(s.transform);
    fp.frames.push({ t: Math.round(performance.now()), x: m.e, y: m.f, w: Math.round(parseFloat(s.width)), mark: html.getAttribute('data-margin-at'), said: s.getPropertyValue('--margin-box-fp').trim(), left: s.getPropertyValue('--margin-box-at-left').trim(), frame: getComputedStyle(html, '::after').boxShadow });
    if (fp.frames.length < 40) requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
})();</script>`;
const FIXTURES = {
  // msu.edu's pattern (Tirth, 2026-11-07: "i can't scroll in there at all"): <html> clips sideways only, so its
  // scrolling stays auto, and <body> says overflow: hidden, harmless where <html> scrolls. In the box <body> scrolls.
  'root-x-hidden': `<style>html { overflow-x: hidden } body { overflow: hidden; margin: 0 } .tall { height: 5000px; background: linear-gradient(#eee, #999) }</style><div class="tall">tall</div>`,
  // A page whose main thread stalls `stall` ms (default 1200), `after` ms
  // (default 30) after it handles being hidden, as Instagram's did in Safari
  // on 2026-11-04 (heavyflip); it takes 100 ms to handle being shown. Dark, so
  // a frame of Safari's empty view isn't told from it by colour: the scenario
  // counts layers (probeShow).
  'heavy-visible': `<style>html, body { background: rgb(18, 18, 18); color: #eee; margin: 0 }</style><script>window.__vis = []; const q = new URLSearchParams(location.search); const stall = Number(q.get('stall') ?? 1200); const after = Number(q.get('after') ?? 30); const spin = (ms) => { const end = performance.now() + ms; while (performance.now() < end); }; document.addEventListener('visibilitychange', () => { __vis.push([document.visibilityState, Date.now()]); if (!document.hidden) return spin(100); if (after > 0) setTimeout(() => spin(stall), after); else spin(stall); });</script><h1 id=h style="height: 2000px">Heavy</h1>`,
  // A page that takes ArrowDown whatever the modifiers, at every level, before
  // anything else of its own (as Outlook's message list and Instagram's reels
  // do): Margin's listener, on the window from document_start, still comes
  // first (commandkeys).
  'eats-arrows': `<script>window.__eaten = { window: 0, document: 0, body: 0 }; const eat = (where) => (e) => { if (e.code !== 'ArrowDown') return; __eaten[where]++; e.preventDefault(); e.stopImmediatePropagation(); }; addEventListener('keydown', eat('window'), true); document.addEventListener('keydown', eat('document'), true); addEventListener('DOMContentLoaded', () => document.body.addEventListener('keydown', eat('body')));</script><textarea id=t></textarea><p>Mail</p>`,
  // A body whose background is a gradient, as a full-height timer's: with nothing on <html> it
  // would be the canvas's, laid out from the window's corner (body-background).
  'body-gradient': `<style>body { margin: 0; min-height: 100vh; background: linear-gradient(90deg, rgb(255, 0, 0), rgb(0, 0, 255)) }</style><h1>Gradient</h1>`,
  // Apps that say what <body> is only after `load`, by a <style>, a <link>, a rule a script inserts, a class.
  'late-style': `<script>addEventListener('load', () => setTimeout(() => { const s = document.createElement('style'); s.textContent = 'html, body { margin: 0; height: 100% } #app { height: 100% }'; document.head.append(s); }, 300));</script><div id=app>Mail</div>`,
  'late-link': `<script>addEventListener('load', () => setTimeout(() => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'data:text/css,html, body { margin: 0; height: 100%25 } %23app { height: 100%25 }'; document.head.append(l); }, 300));</script><div id=app>Mail</div>`,
  'late-rule': `<style id=s></style><script>addEventListener('load', () => setTimeout(() => { const sheet = document.getElementById('s').sheet; sheet.insertRule('#app { height: 100% }'); sheet.insertRule('html, body { margin: 0; height: 100% }'); }, 300));</script><div id=app>Mail</div>`,
  'late-class': `<style>body.ready { margin: 0; height: 100% } #app { height: 100% }</style><script>addEventListener('load', () => setTimeout(() => document.body.classList.add('ready'), 300));</script><div id=app>Mail</div>`,
  'late-scrolled': `<style>html { scroll-behavior: smooth } body { transition: all 1s; margin: 40px } aside { position: absolute; top: 0; height: 200px; width: 100px; overflow: auto } </style><aside id=pane><div style="height: 3000px"></div></aside><div id=tall style="height: 5000px"></div>`,
  'body-has': `<style>html { height: 100% } body:has(#app) { margin: 0; height: 100% } #app { height: 100% }</style><div id=app>Mail</div>`,
  'body-fit': `<style>body { width: fit-content; max-width: 600px; margin: 0 auto }</style><p id=p>Some words that take up the width of the column they sit in, more than one line of them, and then some more.</p>`,
  'html-flex': `<style>html { display: flex; height: 100% } body { margin: auto; width: 500px }</style><p id=p>Centred both ways.</p>`,
  'observer': `<script>new MutationObserver(() => document.documentElement.dataset.seen = '1').observe(document, { childList: true, subtree: true });</script><div id=app>Mail</div>`,
  'body-has-moving': `<style>body:has(main) { max-width: 600px; margin: 0 auto; transition: all 1s }</style><main id=h>Centred</main>`,
  // What a read of the real <body> reaches, and what edits a sheet with no new sheet.
  'late-has': `<script>addEventListener('load', () => setTimeout(() => { const s = document.createElement('style'); s.textContent = 'html { height: 100% } body:has(#app) { margin: 0; height: 100% } #app { height: 100% }'; document.head.append(s); }, 300));</script><div id=app>Mail</div>`,
  'late-text': `<style id=s>.nothing { color: red }</style><script>addEventListener('load', () => setTimeout(() => { document.getElementById('s').firstChild.data = 'html, body { margin: 0; height: 100% } #app { height: 100% }'; }, 300));</script><div id=app>Mail</div>`,
  // Another site's frame (localhost: the page is on 127.0.0.1) with text in a field, and one with none.
  'frame-draft': `<textarea id=t>a reply typed in a frame</textarea>`,
  'frame-plain': `<p>an embed with nothing typed</p>`,
  'late-disabled': `<style>html, body { margin: 0; height: 100% } #app { height: 100% }</style><style id=s>body { margin: 40px }</style><script>addEventListener('load', () => setTimeout(() => { document.getElementById('s').sheet.disabled = true; }, 300));</script><div id=app>Mail</div>`,
  'late-rule-style': `<style>html, body { height: 100% } #app { height: 100% }</style><style id=s>body { margin: 40px }</style><script>addEventListener('load', () => setTimeout(() => { document.getElementById('s').sheet.cssRules[0].style.margin = '0'; }, 300));</script><div id=app>Mail</div>`,
  'late-selector': `<style>html, body { height: 100% } #app { height: 100% }</style><style id=s>.nothing { margin: 0 }</style><script>addEventListener('load', () => setTimeout(() => { document.getElementById('s').sheet.cssRules[0].selectorText = 'body'; }, 300));</script><div id=app>Mail</div>`,
  'calc-width': `<style>body { width: calc(100% - 100px); margin: 0 auto }</style><h1 id=h style="margin: 0">Centred</h1>${TALL}`,
  'percent-pad': `<style>body { margin: 0; padding: 0 5% }</style><h1 id=h style="margin: 0">Padded</h1>`,
  'rtl-width': `<style>body { direction: rtl; width: 600px; margin: 0 }</style><h1 id=h style="margin: 0">Right</h1>`,
  'first-margin': `<h1 id=h>Top</h1><style>body { margin: 30px } #h { margin: 1% 0 0 }</style>`,
  'first-dialog': `<dialog id=d>Open</dialog><style>body { margin: 30px } dialog { margin: 100px auto }</style><p id=p style="margin: 0">Under it</p>`,
  'moving': `<style>body { background: rgb(255, 255, 255); transition: background-color 1s } body.dark { background: rgb(0, 0, 0) }</style><p id=p>Fades</p>`,
  'column-moving': `<style>html, body { height: 100% } body { display: flex; flex-direction: column; height: auto; min-height: 100vh } body > * { transition: all .5s; flex: 1 1 0 }</style><section id=a>a</section><section>b</section>`,
  // A body whose margin moves; a first child's margin; rules and lists a script edits.
  'read-drawer': `<style>body { margin: 0; transition: margin-left .4s linear } body.open { margin-left: 300px }</style><p id=h style="margin: 0">Page</p>${TALL}`,
  'read-key': `${COUNT_READS}<style>body { margin: 8px }</style><div id=a>First</div><p id=h style="margin: 0">Next</p>`,
  'read-wrapper': `<style>body { margin: 8px }</style><div id=w><h1 id=h style="margin: 40px 0 0; height: 30px">Top</h1></div>`,
  'read-neg-child': `<style>body { margin: 8px }</style><div id=h style="margin-top: -5px; height: 20px">Top</div>`,
  'read-border-top': `<style>body { margin: 8px; border-top: 2px solid }</style><div id=h style="margin-top: 20px; height: 20px">Top</div>`,
  'read-flex': `<style>body { margin: 8px; display: flex }</style><div id=h style="margin-top: 20px; height: 20px">Top</div>`,
  'read-abs-first': `<style>body { margin: 8px }</style><div style="position: absolute; margin-top: 30px"></div><div id=h style="height: 20px">Top</div>`,
  'read-neg-body': `<style>body { margin: 0 0 0 -20px }</style><div id=h style="height: 20px">Top</div>`,
  'read-zoom-body': `<style>body { zoom: 1.5; max-width: 400px; margin: 0 auto }</style><div id=h style="height: 20px">Top</div>`,
  'read-zoom-html': `<style>html { zoom: 1.25 } body { max-width: 400px; margin: 0 auto }</style><div id=h style="height: 20px">Top</div>`,
  'read-border-box': `<style>body { box-sizing: border-box; width: 500px; padding: 0 20px; border: 0 solid; border-width: 0 5px; margin: 0 auto }</style><div id=h style="height: 20px">Top</div>`,
  'read-query': `<style>body { margin: 40px } @media (max-width: 800px) { body { margin: 0 } }</style><div id=h style="height: 20px">Top</div>`,
  'read-vw': `<style>body { margin: 0 5vw }</style><div id=h style="height: 20px">Top</div>`,
  'read-sheets': `${COUNT_READS}<style id=m>body { margin: 40px }</style><style id=l>body { margin-top: 40px }</style><style id=q>@media screen { body { padding-top: 7px } }</style><div id=h style="height: 20px">Top</div>`,
  'read-has': `${COUNT_READS}<style>body:has(.on) { margin: 33px } .card:has(img) { color: red }</style><div id=h style="height: 20px">Top</div><div id=x></div>`,
  'read-container': `<style>body { margin: 0 } .c { container-type: inline-size } @container (min-width: 1px) { p { color: rgb(1, 1, 1) } }</style><div class=c id=c>${TALL}${TALL}</div>`,
  'read-strong': `<style>html body#b { transition: all .5s !important; max-width: 600px; margin: 0 auto } body::before { content: ''; display: block; padding: inherit; margin: inherit; transition: all .3s }</style><p id=h>Page</p>`,
  'read-dialog': `<dialog id=d>Open</dialog><style>dialog { margin-top: 90px; transition: overlay .5s allow-discrete, display .5s allow-discrete, opacity .5s; opacity: 1 } dialog::backdrop { transition: all .5s }</style><p id=h>Page</p>`,
  'read-fit-smooth': `<style>body { width: fit-content; min-width: 600px; scroll-behavior: smooth }</style><div id=h>${TALL}${TALL}</div>`,
  'read-echo': `${COUNT_READS}<script>new MutationObserver((records) => { if (records.some((r) => r.attributeName !== 'data-sync')) document.documentElement.dataset.sync = String(Math.random()); }).observe(document.documentElement, { attributes: true });</script><p id=h>Page</p>`,
  'read-idle': `${COUNT_READS}<style>body { margin: 12px }</style><p id=h style="margin: 0">Page</p>${TALL}`,
  // What a page finds in its own document, and lengths that move by other routes.
  'shape-nth': `<div id=h style="height: 20px">Top</div>`,
  'shape-html': `<style>body { max-width: 700px; margin: 0 auto }</style><div id=h style="height: 20px">Top</div><script>window.__parsed = [...document.documentElement.children].map((c) => c.localName).join();</script>`,
  'shape-zoom': `<style>.z { zoom: 1.5 } body { margin: 20px }</style><div id=h style="height: 20px">Top</div>`,
  'shape-text': `<style>body { margin: 8px }</style><div>hello<p id=h style="margin-top: 40px">Below</p></div>`,
  'shape-contain': `<style>body { margin: 8px }</style><div id=h style="contain: layout; margin-top: 40px; height: 20px">Top</div>`,
  'shape-unhide': `<style>body { margin: 8px }</style><div id=b hidden style="margin-top: 40px; height: 10px"></div><div id=h style="height: 20px">Top</div>`,
  'shape-script': `<script>window.__frames = 0; { const raf = window.requestAnimationFrame; window.requestAnimationFrame = function (fn) { __frames++; return raf.call(window, fn); }; }</script><div>First</div><ul id=l></ul>`,
  'shape-moving': `<style>body { margin: 8px } #h { height: 20px; transition: margin-top .3s } #h.o { margin-top: 60px }</style><div id=h>Top</div>`,
  'shape-em': `<style>body { margin: 1em; transition: font-size .3s } body.o { font-size: 40px }</style><div id=h style="height: 20px">Top</div>`,
  'shape-var': `<style>@property --g { syntax: "<length>"; inherits: true; initial-value: 0px } body { margin: 0 0 0 var(--g); transition: --g .3s } body.o { --g: 90px }</style><div id=h style="height: 20px">Top</div>`,
  'shape-rules': `<style id=s></style><style>html, body { margin: 0 } body:has(.two) { margin-left: 44px }</style><div id=h style="height: 20px">Top</div>`,
  'center-max': `<style>body { max-width: 600px; margin: 0 auto }</style><h1 id=h>Centred</h1>${TALL}`,
  'center-width': `<style>body { width: 600px; margin: 40px auto }</style><h1 id=h style="margin: 0">Centred</h1>${TALL}`,
  'flex-column': '<style>body { margin: 0; display: flex; flex-direction: column; min-height: 100vh } section { height: 800px; overflow: hidden; flex: 0 1 auto } footer { height: 80px }</style><section id=a>a</section><section>b</section><footer id=f>f</footer>',
  'flex-one': '<style>body { margin: 0; display: flex; flex-direction: column; min-height: 100vh } section { flex: 1; overflow: hidden } footer { height: 80px }</style><section id=a><div style="height: 2000px">a</div></section><footer id=f>f</footer>',
  percent: '<style>html { height: 100% } body { margin: 0; min-height: 100% } #w { height: 100% }</style><div id=w><div style="height: 2500px">w</div></div><footer id=f>f</footer>',
  app: '<style>html, body { height: 100%; margin: 0 } #app { height: 100%; overflow: auto }</style><div id=app><div style="height: 3000px">app</div></div>',
  rows: '<style>body { margin: 0 }</style><div id=row style="height: 50px; margin-top: 1500px">row</div><div style="height: 4000px"></div>',
  views: '<style>body { margin: 0 } #panel { position: fixed; left: 10px; top: 10px; width: 100px; height: 100px; overflow: auto } #near { margin-top: 900px; height: 20px } #far { margin-top: 4000px; height: 20px }</style><div id=panel><div id=inside>in</div></div><div id=near>near</div><div id=far>far</div>',
  top: '<style>body { margin: 0 } #corner { position: fixed; top: 100px; right: 20px; left: auto; margin: 0 } #drawer { left: 0; right: auto; margin: 0 } #centred { position: fixed; top: 50%; left: 50%; translate: -50% -50%; margin: 0; padding: 0; border: 0; width: 100px; height: 40px } #placed { position: fixed; inset: auto; margin: 0; padding: 0; border: 0; width: 50px; height: 20px }</style><dialog id=plain>plain</dialog><dialog id=corner>corner</dialog><dialog id=drawer>drawer</dialog><div id=centred popover>centred</div><div id=placed popover>placed</div>',
  pane: '<style>html, body { height: 100%; margin: 0 } #app { height: 100%; overflow: auto }</style><div id=app><p id=line>first line</p><div style="height: 3000px">app</div></div>',
  linked: `<link id=l rel=stylesheet href="http://localhost:${PORT}/other.css"><p id=w>wide?</p>`,
};
const page = (name) => {
  if (name.startsWith('T')) return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title><style>${BOX_CSS}</style></head><body>${BOX_BODY}</body></html>`;
  if (name.startsWith('P')) return `<!doctype html><title>${name}</title><form id=f method=post action=/posted><input name=x value=1></form>`;
  if (name.startsWith('H')) {
    const box = (i) => `<div class=b style="background:linear-gradient(${i % 360}deg,hsl(${i % 360} 60% 40%),hsl(${(i * 7) % 360} 70% 30%))">${i} ${'word '.repeat(6)}</div>`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title><style>body{margin:0;background:#202124;color:#e8eaed;font:14px sans-serif;display:flex;flex-wrap:wrap;gap:4px}.b{width:150px;height:60px;border-radius:12px;box-shadow:0 4px 18px rgba(0,0,0,.6),inset 0 0 12px rgba(255,255,255,.25);filter:drop-shadow(0 0 3px #000);overflow:hidden}</style></head><body>${Array.from({ length: 3000 }, (_, i) => box(i)).join('')}</body></html>`;
  }
  if (name.startsWith('B')) return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title><style>@keyframes s{to{transform:rotate(360deg)}}.s{width:80px;height:80px;background:#48c;animation:s 1s linear infinite}</style></head><body><h1>Busy ${name}</h1><div class=s></div><p id=n>0</p><script>let n=0;setInterval(()=>{let x=0;for(let i=0;i<20000;i++)x+=Math.sqrt(i);document.getElementById('n').textContent=++n},50);(function f(){requestAnimationFrame(f)})()</script></body></html>`;
  if (name.startsWith('Z')) return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title><style>body{margin:0;font:20px sans-serif;background:#fff}</style></head><body><h1>Late ${name}</h1><p>${'text '.repeat(200)}</p><img src="/slow?ms=3000&n=${Date.now()}"></body></html>`;
  if (name.startsWith('Y')) return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title><style>body{margin:0;font:20px sans-serif;background:#fff}</style></head><body><script>window.__textAt=0;setTimeout(()=>{document.body.insertAdjacentHTML('beforeend','<h1>Shell ${name}</h1><p>'+'text '.repeat(200)+'</p>');window.__textAt=performance.timeOrigin+performance.now()},250);let on=false;const w=setInterval(()=>{const c=document.querySelector('margin-sidebar-host')?.dataset.loadingCover;if(c==='true')on=true;else if(on&&c==='false'){window.__liftAt=performance.timeOrigin+performance.now();clearInterval(w)}},5)</script><img src="/slow?ms=3000&n=${Date.now()}"></body></html>`;
  if (name.startsWith('G')) return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head><body><h1>Focus ${name}</h1><textarea id=t autofocus></textarea></body></html>`;
  // "I…": another site's frame with text in a field; "J…": another site's frame with none, beside
  // frames of the page's own site with no address of their own (empty, srcdoc: Gmail has some)
  // and a sandboxed one; "K…": a data: frame (no site: no extension may look into it).
  const framed = (frames) => `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head><body><h1>Framed ${name}</h1>${frames}</body></html>`;
  if (name.startsWith('I')) return framed(`<iframe src="http://localhost:${PORT}/x/frame-draft"></iframe>`);
  if (name.startsWith('J')) return framed(`<iframe src="http://localhost:${PORT}/x/frame-plain"></iframe><iframe></iframe><iframe srcdoc="<p>inline</p>"></iframe><iframe sandbox src="http://localhost:${PORT}/x/frame-plain"></iframe>`);
  if (name.startsWith('K')) return framed(`<iframe src="data:text/html,<textarea>typed</textarea>"></iframe>`);
  if (name.startsWith('F')) return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head><body><h1>Form ${name}</h1><textarea id=t></textarea></body></html>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title><style>body{margin:0;font:20px sans-serif;background:#fff}</style></head><body><h1>Page ${name}</h1><p>${'text '.repeat(200)}</p></body></html>`;
};

createServer((req, res) => {
  if (req.url === '/log' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      console.log(`${stamp()} ${body.slice(0, 400)}`);
      res.setHeader('access-control-allow-origin', '*');
      res.end();
    });
    return;
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'POST');
    return res.end();
  }
  if (req.url === '/other.css') {
    res.setHeader('content-type', 'text/css');
    return res.end('@media (max-width: 1000px) { #w { color: rgb(1, 2, 3); } }');
  }
  const fixture = /^\/x\/([\w-]+)/.exec(req.url);
  if (fixture && FIXTURES[fixture[1]]) {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${fixture[1]}</title></head><body>${FIXTURES[fixture[1]]}</body></html>`);
  }
  if (req.url === '/box.css') {
    res.setHeader('content-type', 'text/css');
    return res.end(BOX_CSS);
  }
  const firstPaint = /^\/fp\/(\w+)/.exec(req.url);
  if (firstPaint) {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${firstPaint[1]}</title>${FIRST_FRAMES}<style>body{margin:0;font:20px sans-serif;background:#fff}</style></head><body><h1>Page ${firstPaint[1]}</h1><p>${'text '.repeat(400)}</p></body></html>`);
  }
  const strict = /^\/csp\/(\w+)/.exec(req.url);
  if (strict) {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'");
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${strict[1]}</title><link rel=stylesheet href=/box.css></head><body>${BOX_BODY.replaceAll(/ style="[^"]*"/g, '')}</body></html>`);
  }
  const slow = /^\/slow\?ms=(\d+)/.exec(req.url);
  if (slow) {
    return setTimeout(() => {
      res.setHeader('content-type', 'image/gif');
      res.end(Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64'));
    }, Number(slow[1]));
  }
  if (req.url.startsWith('/posted')) {
    console.log(`${stamp()} SERVER ${req.method} ${req.url}`);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.end('<!doctype html><title>Posted</title><h1>Posted</h1><p>result</p>');
  }
  // The page patterns the box handles (tests/box/serve.js): /box/pattern/<name>, /box/ref/<name>?w=&h=.
  if (req.url.startsWith('/box/')) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const out = boxPage(u.pathname.slice('/box'.length), u.searchParams);
    if (out) {
      res.setHeader('content-type', out.type);
      res.setHeader('cache-control', 'no-store');
      return res.end(out.body);
    }
  }
  const match = /^\/p\/(\w+)/.exec(req.url);
  if (match) {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    // "S…": a slow page, still loading for 1.5s after its start arrived.
    if (match[1].startsWith('S')) {
      res.write(`<!doctype html><html><head><meta charset="utf-8"><title>${match[1]}</title></head><body><h1>Slow ${match[1]}</h1>`);
      return setTimeout(() => res.end('<p>done</p></body></html>'), 1500);
    }
    return res.end(page(match[1]));
  }
  res.statusCode = 404;
  res.end();
}).listen(PORT, '127.0.0.1', () => console.log(`server on ${PORT}`));
