// A stand-in for Margin's extension copies on the link (app/PROTOCOL.md), for
// e2e.swift, which runs Margin.app's real end (app/shell/) against it:
//   node fake-extension.mjs
// It does what the host tells it on stdin, one JSON object a line, and says
// what happened on stdout the same way. Several copies (profiles) at once,
// each its own socket (`id`).
//
//   { do: 'wantLink' } → { ev: 'wantLink', nonce } (the host passes it on as
//     the extension handler's notification would);
//   { native: { name, info } } (what the app dispatched into the extension)
//     → { ev: 'link', port } | { ev: 'appUp' } | { ev: 'native', name };
//   { do: 'connect', id, profile, token?, origin?, owner?, windows?, theme?,
//     chunkBytes?, kept? } → a socket to the linked port with the link's
//     token (or `token`) and a Safari extension's Origin (or `origin`):
//     { ev: 'open' | 'welcome' (ok) | 'close' (code, reason) | 'error', id };
//     welcomed, it says hello (version 2, `profile`, as `owner`, default
//     true), sends the state (tests/ui/fixtures.js smallState, Keep open on)
//     with `windows`, then the theme (`theme`: a built-in theme's id, sent in
//     pieces of `chunkBytes`, default 512 KB) → { ev: 'sent', id, what };
//   { do: 'delta', id, changes, favicons?, skip? } → a delta numbered next
//     (`skip`: one number missed, as a lost message would);
//   { do: 'windows', id, list } → a window list numbered next;
//   { do: 'retitle', id, tabId, title } → a delta of the open tabs with that
//     tab's title changed (how a copy stores tabs: `openTabs`);
//   { do: 'theme', id, theme, chunkBytes?, corrupt? } → a theme again
//     (`corrupt`: one piece's bytes changed);
//   { do: 'send', id, msg } → msg as is, its epoch filled in;
//   { do: 'mute', id, on } → ticks no longer answered; { do: 'close', id }.
// The lasting data (DATA.md "Messages"), with `data` on connect:
//   data: { acked?, rev?, queue?, wiped?, icons?, parts?, now? } → after the
//     state (and theme), data.hello with `acked` (default 0), `rev` (the set's
//     revision the copy has, left out if none) and `queue` (default none). `wiped`: the copy's storage is empty (Safari wiped it: Margin's
//     defaults). `icons`: that many 60 KB site icons added to its storage.
//     The app's data.need → { ev: 'dataNeed' } and data.snapshot of the
//     converter's set (shared/data-set.js dataSetFromStorage, its times at
//     `now`), in `parts` (default 1);
//   the app's data.snapshot, all its parts → { ev: 'dataSnapshot', id, parts,
//     bytes, counts (live items per collection), spaces (id → name),
//     omitted, rev, refilled } and taken as the cache (its rev kept): `refilled` is what
//     stateFromDataSet makes of it (spaces' names, pins, kept tabs' ids);
//   data.ack → { ev: 'dataAck', id, upTo, rev } (kept as acked, and its rev
//     if it has one); data.changes →
//     { ev: 'dataChanges', id, changes };
//   { do: 'dataChanges', id, changes } → data.changes from the copy;
//   { do: 'dataHello', id, acked?, rev?, queue? } → data.hello again.
// What the app sends: tick → { ev: 'tick' } and tock (unless muted); req →
// { ev: 'req', msg } and its reply ({ ok: true, result: { type, windowId,
// payload } }); setLayout → { ev: 'setLayout', msg }; resync →
// { ev: 'resync' } and the state again; bye → { ev: 'bye', why }; anything
// else → { ev: 'message', msg }. Every message from the app is checked to be
// under 1 MB ({ ev: 'tooBig' } if not).
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { smallState } from '../../tests/ui/fixtures.js';
import { toStorage } from '../../extension/shared/stored.js';
import { readBuiltinTheme } from '../../extension/ui/theme-loader.js';
import { dataSetFromStorage, stateFromDataSet } from '../../extension/shared/data-set.js';
import { liveValues } from '../../extension/shared/data-merge.js';
import { normalizeState } from '../../extension/state/model.js';
import { fromStorage } from '../../extension/shared/stored.js';

// The host gone (it quit): nothing more to say.
process.stdout.on('error', () => process.exit(0));
const say = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const ORIGIN = 'safari-web-extension://12345678-ABCD-4321-DCBA-0123456789AB';
let nonce = null;
let link = null; // { port, token, key }, as the app sent it
let kept = null; // the one before
const sockets = new Map(); // id → { ws, epoch, seq, muted, raw }

// The fixture's state as a copy stores it (shared/stored.js toStorage), with Keep open on.
function storedState() {
  const s = smallState();
  s.settings = { ...s.settings, sidebarPinnedOpen: true };
  const keys = Object.keys(s).filter((k) => k !== 'openTabsBy');
  return toStorage(s, keys, { origin: ORIGIN, since: 1, synced: true });
}

const themes = new Map();
async function themeMessage(id) {
  if (!themes.has(id)) {
    const dir = fileURLToPath(new URL(`../../extension/themes/${id}/`, import.meta.url));
    const pkg = await readBuiltinTheme(id, { readFile: async (p) => { const b = readFileSync(dir + p); return /\.(json|html|css)$/.test(p) ? b.toString('utf8') : new Uint8Array(b); } });
    // background/theme-package.js ThemeMessage: the files' bytes as base64.
    themes.set(id, { id, manifest: pkg.manifest, html: pkg.html, css: pkg.css, files: Object.fromEntries(Object.entries(pkg.files).map(([p, b]) => [p, Buffer.from(b).toString('base64')])) });
  }
  return themes.get(id);
}

async function sendTheme(s, id, chunkBytes = 512 * 1024, corrupt = false) {
  const whole = Buffer.from(JSON.stringify(await themeMessage(id)), 'utf8');
  const transfer = createHash('sha256').update(whole).digest('hex');
  const parts = Math.max(1, Math.ceil(whole.length / chunkBytes));
  for (let part = 0; part < parts; part++) {
    let piece = whole.subarray(part * chunkBytes, (part + 1) * chunkBytes);
    if (corrupt && part === parts - 1) { piece = Buffer.from(piece); piece[0] ^= 0xff; }
    s.send({ k: 'theme', id, transfer, part, parts, size: whole.length, data: piece.toString('base64') });
  }
  say({ ev: 'sent', id: s.id, what: 'theme', parts, bytes: whole.length });
}

// The converter's set in `parts`: every collection named in part 0, the items dealt out in turn.
function snapshotParts(set, parts) {
  const out = Array.from({ length: parts }, (_, i) => ({ format: 1, items: i === 0 ? Object.fromEntries(Object.keys(set.items).map((c) => [c, {}])) : {} }));
  let n = 0;
  for (const [c, list] of Object.entries(set.items)) {
    for (const [itemId, item] of Object.entries(list)) {
      const part = out[n++ % parts].items;
      (part[c] ??= {})[itemId] = item;
    }
  }
  return out;
}

function takeData(s, m) {
  switch (m.k) {
    case 'data.need': {
      say({ ev: 'dataNeed', id: s.id, all: m.all, profile: m.profile });
      const set = dataSetFromStorage(s.raw, { now: s.data.now ?? Date.now() });
      const parts = snapshotParts(set, s.data.parts ?? 1);
      const transfer = randomUUID();
      parts.forEach((part, i) => s.send({ k: 'data.snapshot', profile: s.profile, format: 1, set: part, transfer, part: i, parts: parts.length }));
      return say({ ev: 'sent', id: s.id, what: 'data.snapshot', parts: parts.length });
    }
    case 'data.snapshot': {
      if (s.incoming?.transfer !== m.transfer) s.incoming = { transfer: m.transfer, parts: new Map(), bytes: 0 };
      s.incoming.parts.set(m.part, m);
      s.incoming.bytes += Buffer.byteLength(JSON.stringify(m));
      if (s.incoming.parts.size < m.parts) return;
      const items = {};
      for (const part of s.incoming.parts.values()) for (const [c, list] of Object.entries(part.set.items)) Object.assign((items[c] ??= {}), list);
      const set = { format: 1, items };
      const omitted = s.incoming.parts.get(0)?.omitted ?? [];
      const rev = s.incoming.parts.get(0)?.rev ?? null;
      if (rev) s.rev = rev;
      const bytes = s.incoming.bytes;
      s.incoming = null;
      s.cache = set;
      const state = stateFromDataSet(normalizeState(fromStorage(s.raw)), set);
      return say({
        ev: 'dataSnapshot', id: s.id, parts: m.parts, bytes, omitted, rev,
        counts: Object.fromEntries(Object.keys(items).map((c) => [c, Object.keys(liveValues(set, c)).length])),
        spaces: Object.fromEntries(Object.entries(liveValues(set, 'spaces')).map(([sid, v]) => [sid, v.name])),
        refilled: { spaces: state.spaces.map((x) => x.name), pins: state.pins.length, keptTabs: Object.keys(state.keptTabs ?? {}).sort() },
      });
    }
    case 'data.ack':
      s.acked = m.upTo;
      if (m.rev) s.rev = m.rev;
      return say({ ev: 'dataAck', id: s.id, upTo: m.upTo, rev: m.rev ?? null, profile: m.profile });
    case 'data.changes':
      return say({ ev: 'dataChanges', id: s.id, changes: m.changes, profile: m.profile });
    default:
      return say({ ev: 'message', id: s.id, msg: m });
  }
}

function connect({ id, profile = 'P1', token, origin = ORIGIN, owner = true, windows = [], theme = 'arcadia', chunkBytes, kept: old = false, data = null }) {
  const to = old ? kept : link;
  const ws = new WebSocket(`ws://127.0.0.1:${to.port}/?t=${encodeURIComponent(token ?? to.token)}`, { headers: { Origin: origin } });
  const raw = data?.wiped ? {} : storedState();
  for (let i = 0; i < (data?.icons ?? 0); i++) (raw.favicons ??= {})[`https://icon${i}.test`] = { data: 'data:image/png;base64,' + 'A'.repeat(60_000), href: `https://icon${i}.test/favicon.ico`, at: 1 };
  const s = { id, ws, profile, epoch: randomUUID(), seq: 0, muted: false, welcomed: false, raw, windows, data, acked: data?.acked ?? 0, rev: data?.rev ?? null, cache: null, incoming: null };
  sockets.set(id, s);
  s.send = (m) => ws.send(JSON.stringify({ epoch: s.epoch, ...m }));
  const snapshot = () => s.send({ k: 'snapshot', seq: ++s.seq, state: s.raw, windows: s.windows });
  ws.onopen = () => say({ ev: 'open', id });
  ws.onerror = () => say({ ev: 'error', id });
  ws.onclose = (e) => say({ ev: 'close', id, code: e.code, reason: e.reason });
  ws.onmessage = (e) => {
    const text = String(e.data);
    if (Buffer.byteLength(text) > 1_000_000) say({ ev: 'tooBig', id, bytes: Buffer.byteLength(text) });
    const m = JSON.parse(text);
    if (!s.welcomed) {
      s.welcomed = true;
      const ok = m.k === 'welcome' && m.v === 2 && m.key === to.key;
      say({ ev: 'welcome', id, ok });
      if (!ok) return ws.close();
      s.send({ k: 'hello', v: 2, profile, browser: 'safari', origin: ORIGIN, since: 1, ext: '2.0.0', owner, instanceId: `fake-${id}` });
      if (!owner) return;
      snapshot();
      say({ ev: 'sent', id, what: 'snapshot' });
      if (theme) void sendTheme(s, theme, chunkBytes);
      if (data) {
        s.send({ k: 'data.hello', profile, format: 1, acked: s.acked, ...(s.rev ? { rev: s.rev } : {}), queue: data.queue ?? [] });
        say({ ev: 'sent', id, what: 'data.hello' });
      }
      return;
    }
    switch (m.k) {
      case 'tick':
        say({ ev: 'tick', id });
        if (!s.muted) s.send({ k: 'tock', at: Date.now() });
        return;
      case 'req':
        say({ ev: 'req', id, msg: m });
        return s.send({ k: 'reply', id: m.id, ok: m.epoch === s.epoch, result: { type: m.type, windowId: m.windowId, payload: m.payload } });
      case 'setLayout':
        return say({ ev: 'setLayout', id, msg: m });
      case 'resync':
        say({ ev: 'resync', id });
        return snapshot();
      case 'bye':
        return say({ ev: 'bye', id, why: m.why });
      default:
        if (typeof m.k === 'string' && m.k.startsWith('data.')) return takeData(s, m);
        return say({ ev: 'message', id, msg: m });
    }
  };
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const c = JSON.parse(line);
  if (c.native) {
    const { name, info } = c.native;
    if (name === 'link' && info.nonce === nonce) {
      if (link && link.token !== info.token) kept = link;
      link = { port: info.port, token: info.token, key: info.key };
      return say({ ev: 'link', port: info.port, v: info.v });
    }
    if (name === 'appUp') return say({ ev: 'appUp' });
    return say({ ev: 'native', name });
  }
  const s = sockets.get(c.id);
  switch (c.do) {
    case 'wantLink':
      nonce = randomUUID();
      return say({ ev: 'wantLink', nonce });
    case 'connect':
      return connect(c);
    case 'delta': {
      for (const [key, change] of Object.entries(c.changes ?? {})) {
        if ('newValue' in change) s.raw[key] = change.newValue; else delete s.raw[key];
      }
      s.seq += c.skip ? 2 : 1;
      s.send({ k: 'delta', seq: s.seq, changes: c.changes ?? {}, ...(c.favicons ? { favicons: c.favicons } : {}) });
      return say({ ev: 'sent', id: c.id, what: 'delta', seq: s.seq });
    }
    case 'retitle': {
      const open = structuredClone(s.raw.openTabs);
      open.tabs[c.tabId].title = c.title;
      s.raw.openTabs = open;
      s.send({ k: 'delta', seq: ++s.seq, changes: { openTabs: { newValue: open } } });
      return say({ ev: 'sent', id: c.id, what: 'delta', seq: s.seq });
    }
    case 'windows':
      s.windows = c.list;
      s.send({ k: 'windows', seq: ++s.seq, list: c.list });
      return say({ ev: 'sent', id: c.id, what: 'windows', seq: s.seq });
    case 'theme':
      return void sendTheme(s, c.theme, c.chunkBytes, c.corrupt);
    case 'send':
      s.send(c.msg);
      return say({ ev: 'sent', id: c.id, what: c.msg.k });
    case 'dataChanges':
      s.send({ k: 'data.changes', profile: c.profile ?? s.profile, changes: c.changes });
      return say({ ev: 'sent', id: c.id, what: 'data.changes' });
    case 'dataHello':
      const rev = c.rev ?? s.rev;
      s.send({ k: 'data.hello', profile: s.profile, format: 1, acked: c.acked ?? s.acked, ...(rev ? { rev } : {}), queue: c.queue ?? [] });
      return say({ ev: 'sent', id: c.id, what: 'data.hello' });
    case 'mute':
      s.muted = c.on;
      return;
    case 'close':
      s.ws.close();
      return;
    default:
      return say({ ev: 'unknown', c });
  }
});
say({ ev: 'ready' });
