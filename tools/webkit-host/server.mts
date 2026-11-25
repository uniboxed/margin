// Test pages for the WebKit host, and the log sink the test copy of Margin
// posts its console output to (run.sh adds that hook). Port 47811, or
// MARGIN_HOST_PORT.
//   /p/<Name>  a plain page titled <Name> ("F…": with a textarea; "P…": with a POST form; "S…": still loading for 1.5s;
//              "I…": another site's frame with text in a field; "J…": another site's frame with nothing typed,
//              and empty, srcdoc and sandboxed frames; "K…": a data: frame;
//              "H…": heavy to paint, on a dark background, as a busy site is; "G…": a field with autofocus;
//              "T…": tall;
//              "B…": busy, as a site with ads and animations is: a timer every 50ms doing work, a CSS animation, a frame loop;
//              "Z…": all there at once, but its load comes late: an image that takes 3s;
//              "Y…": an app's page: parsed at once with an empty body, its own content drawn by its script 0.25s
//              later (window.__textAt), its load at 3s; window.__liftAt: when Margin's loading cover lifted)
//   /x/<name>  a fixture (FIXTURES: pages with one thing a scenario needs)
//   /posted    where the POST form goes
//   /slow?ms=N an image that arrives N ms after it's asked for
//   POST /log  one log line, printed with a timestamp
import { createServer } from 'node:http';

const PORT = Number(process.env.MARGIN_HOST_PORT) || 47811;
const t0 = Date.now();
const stamp = () => `[${String(Date.now() - t0).padStart(6)}]`;

const TALL = '<div style="height: 5000px">tall</div>';
const FIXTURES: Record<string, string> = {
  // A page that takes ArrowDown whatever the modifiers, at every level, before
  // anything else of its own (as Outlook's message list and Instagram's reels
  // do): Margin's listener, on the window from document_start, still comes
  // first (commandkeys).
  'eats-arrows': `<script>window.__eaten = { window: 0, document: 0, body: 0 }; const eat = (where) => (e) => { if (e.code !== 'ArrowDown') return; __eaten[where]++; e.preventDefault(); e.stopImmediatePropagation(); }; addEventListener('keydown', eat('window'), true); document.addEventListener('keydown', eat('document'), true); addEventListener('DOMContentLoaded', () => document.body.addEventListener('keydown', eat('body')));</script><textarea id=t></textarea><p>Mail</p>`,
  // Another site's frame (localhost: the page is on 127.0.0.1) with text in a field, and one with none.
  'frame-draft': `<textarea id=t>a reply typed in a frame</textarea>`,
  'frame-plain': `<p>an embed with nothing typed</p>`,
};
const page = (name: string) => {
  if (name.startsWith('T')) return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head><body>${TALL}</body></html>`;
  if (name.startsWith('P')) return `<!doctype html><title>${name}</title><form id=f method=post action=/posted><input name=x value=1></form>`;
  if (name.startsWith('H')) {
    const box = (i: number) => `<div class=b style="background:linear-gradient(${i % 360}deg,hsl(${i % 360} 60% 40%),hsl(${(i * 7) % 360} 70% 30%))">${i} ${'word '.repeat(6)}</div>`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title><style>body{margin:0;background:#202124;color:#e8eaed;font:14px sans-serif;display:flex;flex-wrap:wrap;gap:4px}.b{width:150px;height:60px;border-radius:12px;box-shadow:0 4px 18px rgba(0,0,0,.6),inset 0 0 12px rgba(255,255,255,.25);filter:drop-shadow(0 0 3px #000);overflow:hidden}</style></head><body>${Array.from({ length: 3000 }, (_, i) => box(i)).join('')}</body></html>`;
  }
  if (name.startsWith('B')) return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title><style>@keyframes s{to{transform:rotate(360deg)}}.s{width:80px;height:80px;background:#48c;animation:s 1s linear infinite}</style></head><body><h1>Busy ${name}</h1><div class=s></div><p id=n>0</p><script>let n=0;setInterval(()=>{let x=0;for(let i=0;i<20000;i++)x+=Math.sqrt(i);document.getElementById('n').textContent=++n},50);(function f(){requestAnimationFrame(f)})()</script></body></html>`;
  if (name.startsWith('Z')) return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title><style>body{margin:0;font:20px sans-serif;background:#fff}</style></head><body><h1>Late ${name}</h1><p>${'text '.repeat(200)}</p><img src="/slow?ms=3000&n=${Date.now()}"></body></html>`;
  if (name.startsWith('Y')) return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title><style>body{margin:0;font:20px sans-serif;background:#fff}</style></head><body><script>window.__textAt=0;setTimeout(()=>{document.body.insertAdjacentHTML('beforeend','<h1>Shell ${name}</h1><p>'+'text '.repeat(200)+'</p>');window.__textAt=performance.timeOrigin+performance.now()},250);let on=false;const w=setInterval(()=>{const c=document.querySelector('margin-sidebar-host')?.dataset.loadingCover;if(c==='true')on=true;else if(on&&c==='false'){window.__liftAt=performance.timeOrigin+performance.now();clearInterval(w)}},5)</script><img src="/slow?ms=3000&n=${Date.now()}"></body></html>`;
  if (name.startsWith('G')) return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head><body><h1>Focus ${name}</h1><textarea id=t autofocus></textarea></body></html>`;
  // "I…": another site's frame with text in a field; "J…": another site's frame with none, beside
  // frames of the page's own site with no address of their own (empty, srcdoc: Gmail has some)
  // and a sandboxed one; "K…": a data: frame (no site: no extension may look into it).
  const framed = (frames: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head><body><h1>Framed ${name}</h1>${frames}</body></html>`;
  if (name.startsWith('I')) return framed(`<iframe src="http://localhost:${PORT}/x/frame-draft"></iframe>`);
  if (name.startsWith('J')) return framed(`<iframe src="http://localhost:${PORT}/x/frame-plain"></iframe><iframe></iframe><iframe srcdoc="<p>inline</p>"></iframe><iframe sandbox src="http://localhost:${PORT}/x/frame-plain"></iframe>`);
  if (name.startsWith('K')) return framed(`<iframe src="data:text/html,<textarea>typed</textarea>"></iframe>`);
  if (name.startsWith('F')) return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head><body><h1>Form ${name}</h1><textarea id=t></textarea></body></html>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title><style>body{margin:0;font:20px sans-serif;background:#fff}</style></head><body><h1>Page ${name}</h1><p>${'text '.repeat(200)}</p></body></html>`;
};

// (`req.url!`: a server's request always has its address.)
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
  const fixture = /^\/x\/([\w-]+)/.exec(req.url!);
  if (fixture && FIXTURES[fixture[1]]) {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${fixture[1]}</title></head><body>${FIXTURES[fixture[1]]}</body></html>`);
  }
  const slow = /^\/slow\?ms=(\d+)/.exec(req.url!);
  if (slow) {
    return setTimeout(() => {
      res.setHeader('content-type', 'image/gif');
      res.end(Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64'));
    }, Number(slow[1]));
  }
  if (req.url!.startsWith('/posted')) {
    console.log(`${stamp()} SERVER ${req.method} ${req.url}`);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.end('<!doctype html><title>Posted</title><h1>Posted</h1><p>result</p>');
  }
  const match = /^\/p\/(\w+)/.exec(req.url!);
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
