// Test pages for the WebKit host, and the log sink the test copy of Margin
// posts its console output to (run.sh adds that hook). Port 47811, or
// MARGIN_HOST_PORT.
//   /p/<Name>  a plain page titled <Name> ("F…": with a textarea; "P…": with a POST form; "S…": still loading for 1.5s;
//              "H…": heavy to paint, on a dark background, as a busy site is; "G…": a field with autofocus)
//   /posted    where the POST form goes
//   POST /log  one log line, printed with a timestamp
import { createServer } from 'node:http';

const PORT = Number(process.env.MARGIN_HOST_PORT) || 47811;
const t0 = Date.now();
const stamp = () => `[${String(Date.now() - t0).padStart(6)}]`;

const page = (name) => {
  if (name.startsWith('P')) return `<!doctype html><title>${name}</title><form id=f method=post action=/posted><input name=x value=1></form>`;
  if (name.startsWith('H')) {
    const box = (i) => `<div class=b style="background:linear-gradient(${i % 360}deg,hsl(${i % 360} 60% 40%),hsl(${(i * 7) % 360} 70% 30%))">${i} ${'word '.repeat(6)}</div>`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title><style>body{margin:0;background:#202124;color:#e8eaed;font:14px sans-serif;display:flex;flex-wrap:wrap;gap:4px}.b{width:150px;height:60px;border-radius:12px;box-shadow:0 4px 18px rgba(0,0,0,.6),inset 0 0 12px rgba(255,255,255,.25);filter:drop-shadow(0 0 3px #000);overflow:hidden}</style></head><body>${Array.from({ length: 3000 }, (_, i) => box(i)).join('')}</body></html>`;
  }
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
