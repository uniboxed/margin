// The test's end of the native messaging host (native-host.mts): Safari's
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
import { createServer, type AddressInfo, type Socket } from 'node:net';

// A host process connected: undecided (kind null) until it's a one-off ask or the lasting port.
type Conn = { socket: Socket, kind: 'port' | 'once' | null, timer: Timer | null };
// A dispatch into the lasting port, as ExtensionLink.swift sends it (background/link.ts reads userInfo.e).
type Dispatch = { name: string, userInfo: { e: string } };

const ONE_OFF = new Set(['wantLink']);

/**
 * @param options
 *   `wantLink`: the handler's reply, and the `link` to dispatch (the app's
 *   ExtensionLink.swift answer), if any.
 */
export async function startRelay({ wantLink, verbose = !!process.env.MARGIN_E2E_VERBOSE }: { wantLink: (nonce: string) => { reply: unknown, link?: unknown }, verbose?: boolean }) {
  const say = (...args: unknown[]) => { if (verbose) console.log('[relay]', ...args); };
  const conns: Set<Conn> = new Set();
  const logs: { at: number, line: string }[] = [];
  const asks: { at: number, nonce: unknown }[] = [];
  const queued: Dispatch[] = []; // dispatches waiting for a lasting port
  let pings = 0;

  const write = (c: Conn, obj: unknown) => { try { c.socket.write(JSON.stringify(obj) + '\n'); } catch {} };
  const lasting = () => [...conns].filter((c) => c.kind === 'port');
  const becomePort = (c: Conn) => {
    if (c.kind) return;
    c.kind = 'port';
    clearTimeout(c.timer);
    for (const d of queued.splice(0)) write(c, d);
  };
  function dispatch(name: string, info: unknown) {
    const msg: Dispatch = { name, userInfo: { e: JSON.stringify(info) } };
    const ports = lasting();
    if (!ports.length) return void queued.push(msg);
    for (const c of ports) write(c, msg);
  }

  const server = createServer((socket) => {
    const c: Conn = { socket, kind: null, timer: null };
    say('a host process connected');
    conns.add(c);
    c.timer = setTimeout(() => becomePort(c), 300);
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buf += chunk;
      for (let i: number; (i = buf.indexOf('\n')) >= 0;) {
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
        } else write(c, { ok: true }); // the set-up window's checks (extension/engines/webkit/safari/onboarding.ts)
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => { clearTimeout(c.timer); conns.delete(c); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port, // (a TCP server's address is always one)
    logs, asks,
    get pings() { return pings; },
    get ports() { return lasting().length; },
    dispatch,
    async close() {
      for (const c of conns) c.socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
