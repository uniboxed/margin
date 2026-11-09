// background/link.ts getting linked again whatever Safari does with the copy's
// native messages (fix/profile-relink, 2026-11-06): Safari 27.2 answers only
// one of several wantLinks its profiles' copies send at once (the others'
// promises never settle), while every copy hears every dispatch from the app.
// Against the fake app (tests/fake-app.ts) over a real WebSocket, with a fake
// Safari shared by several copies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeApp } from './fake-app.ts';

globalThis.chrome = { runtime: { getURL: (p) => `safari-web-extension://test/${p}`, getManifest: () => ({ version: '2.0.0' }) } };
const { createLink, LINK_META } = await import('../extension/background/link.ts');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await wait(10);
  }
  return false;
}

function area(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      if (keys == null) return structuredClone(data);
      const list = typeof keys === 'string' ? [keys] : keys;
      return structuredClone(Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]])));
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(keys) { for (const k of typeof keys === 'string' ? [keys] : keys) delete data[k]; },
  };
}

const NEVER = new Promise(() => {});

/**
 * A fake Safari with several profiles, as 27.2 behaves: every dispatch reaches every copy's
 * native port; `answers(message, i)` decides each wantLink's answer (a value, or NEVER), with
 * the default answering only the last of the wantLinks sent within `together` ms of each other.
 */
function safari({ app = null, together = 15, answers = null } = {}) {
  const copies = [];
  let batch = [];
  let batchTimer = null;
  const s = {
    app,
    up: () => !!s.app,
    copies,
    dispatch(m) { for (const c of copies) for (const p of c.ports) if (!p.dead) p.deliver(m); },
    // A copy's browser API, its own storage, Safari's id for its profile.
    copy({ profile, local = {} }) {
      const ports = [];
      const native = [];
      const api = {
        runtime: {
          getURL: (p) => `safari-web-extension://test/${p}`,
          getManifest: () => ({ version: '2.0.0' }),
          connectNative() {
            const listeners = [];
            const port = {
              dead: false, posted: [], onMessage: { addListener: (cb) => listeners.push(cb) }, onDisconnect: { addListener: () => {} },
              postMessage(m) { port.posted.push(m); }, disconnect() { port.dead = true; }, deliver: (m) => listeners.forEach((cb) => cb(m)),
            };
            ports.push(port);
            return port;
          },
          sendNativeMessage(_, message) {
            native.push({ ...message, at: Date.now() });
            const reply = { ok: true, appOpen: s.up(), launching: false, profile };
            // The handler passes the nonce on; the app dispatches its link into every copy.
            if (message.type === 'wantLink' && s.app) {
              const info = s.app.linkInfo(message.nonce);
              setTimeout(() => s.dispatch(info), 30);
            }
            if (answers) return answers(message, reply);
            // Only the last of a burst is answered (a few ms after the burst ends).
            return new Promise((resolve) => {
              batch.push({ resolve, reply });
              clearTimeout(batchTimer);
              batchTimer = setTimeout(() => {
                const last = batch.at(-1);
                batch = [];
                last.resolve(last.reply);
              }, together);
            });
          },
        },
        storage: { local: area(local), session: area() },
        windows: { getAll: async () => [] },
        tabs: { query: async () => [] },
        ports,
        native,
      };
      const notes = [];
      const link = createLink({
        api, isOwner: () => true, copy: () => ({ origin: `safari-web-extension://${profile}/`, since: 1 }), instanceId: profile,
        WebSocket: globalThis.WebSocket, enabled: () => true, canSocket: () => true, data: null,
        theme: async () => null, commandKeys: () => ({}), log: (...a) => notes.push(a.join(' ')), timing: s.timing,
      });
      const c = { api, link, ports, native, notes, profile, wantLinks: () => native.filter((m) => m.type === 'wantLink').length };
      copies.push(c);
      return c;
    },
    timing: { ping: 50, dead: 2000, check: 50, linkWait: 300, openWait: 500, keptWait: 200, reconnect: [20, 40], ask: [200, 800], gone: 300, windows: 1000, layoutWrite: 10, launchAsk: 30, launchAsks: 5, noLinkAsk: 150, noLinkAsks: 3, replyWait: 400, stuck: 5000 },
  };
  return s;
}

const SURE = (id) => ({ [LINK_META]: { profile: id, acked: 0 } }); // Safari's id kept from an answer before

test('relink: five copies starting at once (Safari answers one wantLink): every copy links, each as its own profile', async () => {
  const app = await startFakeApp();
  const s = safari({ app });
  const ids = ['s-default', 's-aaaa', 's-bbbb', 's-cccc', 's-dddd'];
  const copies = ids.map((id) => s.copy({ profile: id, local: SURE(id) }));
  try {
    const t0 = Date.now();
    await Promise.all(copies.map((c) => c.link.start({ route: async () => ({ ok: true }) })));
    assert.ok(await until(() => copies.every((c) => c.link.linked()), 3000), `linked: ${copies.map((c) => `${c.profile} ${c.link.linked()}`).join(', ')}`);
    assert.ok(Date.now() - t0 < 1500, `within the dispatch's time, not after waiting out the lost answers (${Date.now() - t0} ms)`);
    assert.deepEqual(copies.map((c) => c.wantLinks()), [1, 1, 1, 1, 1], 'each asked once');
    const hellos = [];
    for (let i = 0; i < ids.length; i++) hellos.push(await app.next('hello', { test: (m) => !hellos.includes(m) }));
    assert.deepEqual(hellos.map((h) => h.profile).sort(), [...ids].sort(), 'each copy\'s hello says its own profile');
  } finally {
    for (const c of copies) c.link.stop();
    await app.close();
  }
});

test('relink: a wantLink Safari never answers, and no link: asked again on the schedule, never stuck', async () => {
  const s = safari({ answers: () => NEVER });
  const c = s.copy({ profile: 's-aaaa', local: SURE('s-aaaa') });
  try {
    await c.link.start({ route: async () => ({ ok: true }) });
    assert.ok(await until(() => c.wantLinks() >= 3, 3000), `asked again and again (${c.wantLinks()})`);
    const times = c.native.map((m) => m.at);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    assert.ok(gaps.every((g) => g >= 400 + 150 - 20), `each after the answer's wait and the short wait, no busy loop: ${gaps}`);
    assert.ok(c.notes.some((n) => /no answer from the extension handler within 400 ms/.test(n)), 'said in the log');
    assert.ok(!c.link.linked());
  } finally {
    c.link.stop();
  }
});

test('relink: the app starting while a wantLink waits on a lost answer: asked again at once when it ends, then linked', async () => {
  const app = await startFakeApp();
  let lose = true;
  const s = safari({ answers: (_, reply) => (lose ? NEVER : Promise.resolve(reply)) });
  s.timing = { ...s.timing, noLinkAsk: 5000, ask: [5000, 5000] };
  const c = s.copy({ profile: 's-aaaa', local: SURE('s-aaaa') });
  try {
    await c.link.start({ route: async () => ({ ok: true }) });
    assert.equal(c.wantLinks(), 1);
    // The app comes up while the first wantLink waits (no app: no link for it), and says so.
    s.app = app;
    lose = false;
    s.dispatch({ name: 'appUp', userInfo: { e: JSON.stringify({ v: 2, at: Date.now() }) } });
    assert.ok(await until(() => c.link.linked(), 1500), 'linked soon after the first try ends, not at the 5 s ask');
    assert.equal(c.wantLinks(), 2);
  } finally {
    c.link.stop();
    await app.close();
  }
});

test('relink: a page starting, or the person asking, while a try waits on a lost answer: asked again once it ends', async () => {
  const app = await startFakeApp();
  let lose = true;
  const s = safari({ app: null, answers: (_, reply) => (lose ? NEVER : Promise.resolve(reply)) });
  s.timing = { ...s.timing, noLinkAsk: 5000, ask: [5000, 5000] };
  for (const how of ['poke', 'askNow']) {
    lose = true;
    s.app = null;
    const c = s.copy({ profile: `s-${how}`, local: SURE(`s-${how}`) });
    try {
      await c.link.start({ route: async () => ({ ok: true }) });
      s.app = app;
      lose = false;
      c.link[how]();
      assert.ok(await until(() => c.link.linked(), 1500), `${how}: linked once the try under way ended`);
      assert.equal(c.wantLinks(), 2, how);
    } finally {
      c.link.stop();
    }
  }
  await app.close();
});

test('relink: a try stuck past STUCK_MS (a promise that never settles) is left at the next ping, and the link asked for again', async () => {
  const app = await startFakeApp();
  let lose = true;
  const s = safari({ app: null, answers: (_, reply) => (lose ? NEVER : Promise.resolve(reply)) });
  // The answer's wait as long as a promise that never settles; the stuck limit short.
  s.timing = { ...s.timing, replyWait: 3000, stuck: 300, noLinkAsk: 5000, ask: [5000, 5000] };
  const c = s.copy({ profile: 's-aaaa', local: SURE('s-aaaa') });
  try {
    void c.link.start({ route: async () => ({ ok: true }) }); // (its first try never ends by itself)
    assert.ok(await until(() => c.wantLinks() === 1));
    s.app = app;
    lose = false;
    assert.ok(await until(() => c.link.linked(), 2000), 'linked by a new try');
    assert.equal(c.wantLinks(), 2);
    assert.ok(c.notes.some((n) => /under way \d+ s .*left, and the link asked for again/.test(n)), `said in the log: ${c.notes.join(' | ')}`);
  } finally {
    c.link.stop();
    await app.close();
  }
});

test('relink: a copy whose profile id Safari hasn\'t given yet waits for the answer before hello; a lost one is asked again, and the hello says Safari\'s id', async () => {
  const app = await startFakeApp();
  let n = 0;
  const s = safari({ app, answers: (_, reply) => (++n === 1 ? NEVER : Promise.resolve(reply)) });
  const c = s.copy({ profile: 's-eeee', local: {} }); // storage wiped: a profile id of its own
  try {
    await c.link.start({ route: async () => ({ ok: true }) });
    assert.ok(await until(() => c.link.linked(), 2500), 'linked at the next ask');
    assert.equal(c.wantLinks(), 2, 'the first answer lost, asked again');
    assert.equal((await app.next('hello')).profile, 's-eeee', 'Safari\'s id, not one of its own');
    assert.equal(c.api.storage.local.data[LINK_META].profile, 's-eeee');
  } finally {
    c.link.stop();
    await app.close();
  }
});

test('relink: the app quits (bye) and starts again with five copies: every copy links again from its appUp', async () => {
  const app = await startFakeApp();
  const s = safari({ app });
  s.timing = { ...s.timing, ask: [5000, 60_000] }; // after the goodbye, only appUp would ask soon
  const ids = ['s-default', 's-aaaa', 's-bbbb', 's-cccc', 's-dddd'];
  const copies = ids.map((id) => s.copy({ profile: id, local: SURE(id) }));
  let app2 = null;
  try {
    // Linked one after another (no burst), then the app says goodbye to all.
    for (const c of copies) {
      await c.link.start({ route: async () => ({ ok: true }) });
      assert.ok(await until(() => c.link.linked(), 1500), `${c.profile} linked first`);
    }
    s.app = null;
    app.send({ k: 'bye', why: 'Margin.app quit' });
    assert.ok(await until(() => copies.every((c) => !c.link.linked()), 1000));
    app2 = await startFakeApp();
    s.app = app2;
    const t0 = Date.now();
    s.dispatch({ name: 'appUp', userInfo: { e: JSON.stringify({ v: 2, at: Date.now() }) } });
    assert.ok(await until(() => copies.every((c) => c.link.linked()), 2000), `linked again: ${copies.map((c) => `${c.profile} ${c.link.linked()}`).join(', ')}`);
    assert.ok(Date.now() - t0 < 1500, `at once (${Date.now() - t0} ms)`);
  } finally {
    for (const c of copies) c.link.stop();
    await app.close();
    await app2?.close();
  }
});
