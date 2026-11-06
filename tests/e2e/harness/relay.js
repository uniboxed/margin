// The test's end of the native messaging host (native-host.mjs): Safari's
// extension handler as the copy sees it.
//
// - `wantLink { nonce }` is answered as the handler would ({ ok, appOpen,
//   launching }: `answer`), and when the app is up, the app's `link` is
//   dispatched into the lasting port (ExtensionLink.swift answer).
// - pings are answered; the copy's notes for the app's log (`{ type: 'log' }`)
//   are kept in `logs`.
// - `dispatch(name, info)`: anything else the app dispatches (`appUp`).
//
// Chromium's one-off messages and its lasting port are separate host
// processes; a process is the lasting port once it says something other than
// a one-off ask, or after 300 ms of saying nothing (a one-off says its
// message at once).
import { createServer } from 'node:net';

const ONE_OFF = new Set(['wantLink']);

/**
 * @param {{ wantLink: (nonce: string) => { reply: any, link?: any } }} options
 *   `wantLink`: the handler's reply, and the `link` to dispatch (the app's
 *   ExtensionLink.swift answer), if any.
 */
export async function startRelay({ wantLink, verbose = !!process.env.MARGIN_E2E_VERBOSE }) {
  const say = (...args) => { if (verbose) console.log('[relay]', ...args); };
  /** @type {Set<any>} */
  const conns = new Set();
  /** @type {any[]} */
  const logs = [];
  /** @type {any[]} */
  const asks = [];
  /** @type {any[]} */
  const queued = []; // dispatches waiting for a lasting port
  let pings = 0;

  const write = (c, obj) => { try { c.socket.write(JSON.stringify(obj) + '\n'); } catch {} };
  const lasting = () => [...conns].filter((c) => c.kind === 'port');
  const becomePort = (c) => {
    if (c.kind) return;
    c.kind = 'port';
    clearTimeout(c.timer);
    for (const d of queued.splice(0)) write(c, d);
  };
  function dispatch(name, info) {
    const msg = { name, userInfo: { e: JSON.stringify(info) } };
    const ports = lasting();
    if (!ports.length) return void queued.push(msg);
    for (const c of ports) write(c, msg);
  }

  const server = createServer((socket) => {
    const c = { socket, kind: null, timer: null };
    say('a host process connected');
    conns.add(c);
    c.timer = setTimeout(() => becomePort(c), 300);
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buf += chunk;
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (!parsed.msg) continue;
        const msg = parsed.msg;
        say(msg.type === 'log' ? `log: ${msg.line}` : JSON.stringify(msg).slice(0, 200));
        if (ONE_OFF.has(msg.type) || msg.v === 1) {
          c.kind = 'once';
          clearTimeout(c.timer);
        } else becomePort(c);
        if (msg.type === 'ping') { pings++; write(c, { ok: true }); }
        else if (msg.type === 'log') logs.push({ at: Date.now(), line: String(msg.line ?? '') });
        else if (msg.type === 'wantLink') {
          asks.push({ at: Date.now(), nonce: msg.nonce });
          const { reply, link } = wantLink(String(msg.nonce ?? ''));
          write(c, reply);
          if (link) setTimeout(() => dispatch('link', link), 10);
        } else write(c, { ok: true }); // the set-up window's checks (background/onboarding.js)
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => { clearTimeout(c.timer); conns.delete(c); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: /** @type {any} */ (server.address()).port,
    logs, asks,
    get pings() { return pings; },
    get ports() { return lasting().length; },
    dispatch,
    async close() {
      for (const c of conns) c.socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
