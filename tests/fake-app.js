// A stand-in for Margin.app's end of the link (app/PROTOCOL.md), for the
// extension's link client's tests (tests/link.test.js): a WebSocket server on
// 127.0.0.1 done by hand (Node has a WebSocket client but no server), which
// refuses a wrong token or path before the socket opens, says welcome with
// its key, and records what the copy sends. It speaks only what the app
// does: text frames, ping, close.
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(text, opcode = 1) {
  const body = Buffer.from(text, 'utf8');
  const head = body.length < 126 ? Buffer.from([0x80 | opcode, body.length])
    : body.length < 65536 ? Buffer.from([0x80 | opcode, 126, body.length >> 8, body.length & 255])
    : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(body.length), 2); return h; })();
  return Buffer.concat([head, body]);
}

/**
 * `onMessage`, `onOpen` and `onClose` (optional): each message as it comes,
 * and each socket opening and closing (the e2e suite's shell follows them).
 * @param {{ token?: string, key?: string, welcome?: (key: string) => any, onMessage?: (message: any) => void, onOpen?: () => void, onClose?: () => void }} [options]
 */
export async function startFakeApp({ token = randomUUID(), key = randomUUID(), welcome = (k) => ({ k: 'welcome', v: 2, key: k }), onMessage = () => {}, onOpen = () => {}, onClose = () => {} } = {}) {
  /** @type {any[]} */
  const received = [];
  const sockets = new Set();
  const waiters = new Set();
  let refused = 0;
  const server = createServer((_, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/' || url.searchParams.get('t') !== token || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      refused++;
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    onOpen();
    socket.on('close', () => { sockets.delete(socket); onClose(); });
    socket.on('error', () => {});
    socket.write(frame(JSON.stringify(welcome(key))));
    let buf = Buffer.alloc(0);
    let pieces = null; // a text message sent in fragments, until its last (FIN)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const fin = (buf[0] & 128) !== 0;
        const opcode = buf[0] & 15;
        let len = buf[1] & 127;
        let at = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10; }
        const masked = (buf[1] & 128) !== 0;
        const mask = masked ? buf.subarray(at, at + 4) : null;
        if (masked) at += 4;
        if (buf.length < at + len) return;
        const body = Buffer.from(buf.subarray(at, at + len));
        if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
        buf = buf.subarray(at + len);
        if (opcode === 8) { socket.end(frame('', 8)); sockets.delete(socket); return; }
        if (opcode === 9) { socket.write(frame(body.toString('utf8'), 10)); continue; }
        if (opcode === 1 && !fin) { pieces = [body]; continue; }
        if (opcode === 0 && pieces) { pieces.push(body); if (!fin) continue; }
        else if (opcode !== 1) continue;
        const text = (opcode === 0 ? Buffer.concat(pieces) : body).toString('utf8');
        if (opcode === 0) pieces = null;
        const message = JSON.parse(text);
        received.push(message);
        onMessage(message);
        for (const w of [...waiters]) w();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = /** @type {any} */ (server.address()).port;
  return {
    port, token, key, received,
    get open() { return sockets.size; },
    get refused() { return refused; },
    /** What the app answers into the extension for `nonce` (ExtensionLink.swift answer). */
    linkInfo: (nonce) => ({ name: 'link', userInfo: { e: JSON.stringify({ v: 2, nonce, port, token, key, app: { version: '2.0' }, at: Date.now() }) } }),
    send(message) { for (const s of sockets) s.write(frame(JSON.stringify(message))); },
    /** The first message of kind `k` (and `test`), after `from` received, waited for up to `ms`. */
    async next(k, { from = 0, test = () => true, ms = 2000 } = {}) {
      const find = () => received.slice(from).find((m) => m.k === k && test(m));
      const end = Date.now() + ms;
      while (!find() && Date.now() < end) await new Promise((resolve) => { waiters.add(resolve); setTimeout(() => { waiters.delete(resolve); resolve(undefined); }, 20); });
      return find() ?? null;
    },
    /** Every socket dropped, as the app crashing would (no close frame). */
    drop() { for (const s of sockets) s.destroy(); sockets.clear(); },
    async close() {
      for (const s of sockets) s.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
