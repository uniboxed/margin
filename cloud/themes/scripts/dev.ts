// node cloud/themes/scripts/dev.ts [--pow-bits N] [--port N]: the themes server on this Mac, for Margin.app's end-to-end
// checks (tools/app-tests/e2e-store.swift) and for trying the store by hand: the Worker's own code (src/worker.ts
// `handle`) over Node's HTTP on 127.0.0.1, its bindings the tests' fakes (tests/cloud-themes/fakes.ts: D1 on Node's
// SQLite, R2 and the Limiter in memory: everything gone when it stops). It prints one line of JSON once it listens,
// { url, key, adminToken }, then serves until its input closes (the test that started it ended) or it's stopped.
// Point Margin at it with MARGIN_THEME_STORE_URL and MARGIN_THEME_STORE_KEY.
import { createServer } from 'node:http';
import { handle } from '../src/worker.ts';
import { b64url } from '../src/crypto.ts';
import { fakeEnv } from '../../../tests/cloud-themes/fakes.ts';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const adminToken = b64url(crypto.getRandomValues(new Uint8Array(32)));
const { env, indexKey } = await fakeEnv({ POW_BITS: arg('--pow-bits', '12'), ADMIN_TOKEN: adminToken });

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  headers.set('CF-Connecting-IP', req.socket.remoteAddress ?? '127.0.0.1');
  const url = `http://${req.headers.host ?? '127.0.0.1'}${req.url ?? '/'}`;
  let response: Response;
  try {
    response = await handle(new Request(url, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body }), env, Date.now());
  } catch (err) {
    console.error('dev server:', err);
    response = Response.json({ error: 'server', message: 'Something went wrong on the themes server.' }, { status: 500 });
  }
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(Number(arg('--port', '0')), '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  console.log(JSON.stringify({ url: `http://127.0.0.1:${port}`, key: b64url(indexKey), adminToken }));
});
process.stdin.on('end', () => { server.close(); process.exit(0); });
process.stdin.resume();
