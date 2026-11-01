// Test pages for the WebKit host, and the log sink the test copy of Margin
// posts its console output to (run.sh adds that hook). Port 47811, or
// MARGIN_HOST_PORT.
//   /p/<Name>  a plain page titled <Name> ("F…": with a textarea; "P…": with a POST form; "S…": still loading for 1.5s;
//              "H…": heavy to paint, on a dark background, as a busy site is; "G…": a field with autofocus;
//              "T…": tall, with rules about the window's size for the box to answer;
//              "B…": busy, as a site with ads and animations is: a timer every 50ms doing work, a CSS animation, a frame loop)
//   /csp/<Name>  a page under a strict CSP, its sheet from /box.css
//   /x/<name>  a fixture for the box (FIXTURES: pages with one thing a box has to get right)
//   /other.css  a sheet of another origin, no CORS (on localhost: the page is on 127.0.0.1)
//   /box.css   rules about the window's size
//   /posted    where the POST form goes
//   POST /log  one log line, printed with a timestamp
import { createServer } from 'node:http';

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
const FIXTURES = {
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
  if (name.startsWith('G')) return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head><body><h1>Focus ${name}</h1><textarea id=t autofocus></textarea></body></html>`;
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
  const strict = /^\/csp\/(\w+)/.exec(req.url);
  if (strict) {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'");
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${strict[1]}</title><link rel=stylesheet href=/box.css></head><body>${BOX_BODY.replaceAll(/ style="[^"]*"/g, '')}</body></html>`);
  }
  if (req.url.startsWith('/posted')) {
    console.log(`${stamp()} SERVER ${req.method} ${req.url}`);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.end('<!doctype html><title>Posted</title><h1>Posted</h1><p>result</p>');
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
