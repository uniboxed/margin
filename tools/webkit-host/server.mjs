// Test pages for the WebKit host, and the log sink the test copy of Margin
// posts its console output to (run.sh adds that hook). Port 47811.
//   /p/<Name>  a plain page titled <Name> ("F…": with a textarea; "P…": with a POST form)
//   /posted    where the POST form goes
//   POST /log  one log line, printed with a timestamp
import { createServer } from 'node:http';

const PORT = 47811;
const t0 = Date.now();
const stamp = () => `[${String(Date.now() - t0).padStart(6)}]`;

const page = (name) => {
  if (name.startsWith('P')) return `<!doctype html><title>${name}</title><form id=f method=post action=/posted><input name=x value=1></form>`;
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
    return res.end(page(match[1]));
  }
  res.statusCode = 404;
  res.end();
}).listen(PORT, '127.0.0.1', () => console.log(`server on ${PORT}`));
