// A stand-in for Margin.app's shell (app/shell/Shell.swift, Overlay.swift,
// OverlayWebView.swift), in Node, for the e2e suite. The link's server is
// tests/fake-app.js; the overlays are the real dist/app/overlay.html, one
// WebKit page per window the shell draws over. It does what the shell does
// for overlays and nothing of the window server: a window is "bound" when
// it's in full screen.
//
// - the mirror: the snapshot, the deltas in order (a gap asks for a resync),
//   the window list;
// - the theme's pieces put together and checked (size, SHA-256);
// - one overlay per full-screen window, sized to it, with the page hello
//   Shell.hello(for:) makes; `drawn` on before it shows, off 1.5 s after a
//   window leaves full screen (or was never in it), at once when it closes;
// - the bridge ops: hello, send (a `req` for that window), layout (`setLayout`
//   for a layout measured at the window's size, rounded to half a point, only
//   a change), hits, focus, pointerWant, perform, ready and log, kept for checks;
// - forwarding: state, changes, windows (not a list that differs only in
//   `visible`), push (a palette held until its overlay is shown, else dropped
//   with `drawn` off and `paletteDropped`; notices and loading held for an
//   overlay made later), link (reconnecting, then linked);
// - the app's keys (`key('palette')`, `navigate('next-tab')`), ticks every
//   5 s, drops, a goodbye, a restart (new port, token and key, then `appUp`);
// - the data messages: `data.hello` answered with the seed's `data.snapshot`
//   (or `data.need`), `data.changes` kept.
import { createHash } from 'node:crypto';
import { startFakeApp } from '../../fake-app.js';

const RECONNECT_GRACE_MS = 6000;
const UNWANTED_GRACE_MS = 1500;
const PALETTE_HOLD_MS = 1500;
const HELD_TYPES = new Set(['notice', 'loading']);

const half = (v) => Math.round(Number(v) * 2) / 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{
 *   webkit: any,                       // a Playwright WebKit browser
 *   overlayUrl: string,                // dist/app/overlay.html, served with the app's policy
 *   dataSet?: any,                     // the app's data set for this profile (a seed), or null
 *   cloudTabs?: any,                   // the app's iCloud Tabs ({ status, devices }) or null
 *   across?: any,                      // spaces across profiles, or null
 *   makeFullscreen?: (windowId: number) => Promise<void>, // what macOS does for a new window of a full-screen app
 *   verbose?: boolean,
 * }} options
 */
export async function startShell({ webkit, overlayUrl, dataSet = null, cloudTabs = null, across = null, makeFullscreen = null, verbose = !!process.env.MARGIN_E2E_VERBOSE }) {
  const say = (...args) => { if (verbose) console.log('[shell]', ...args); };
  const context = await webkit.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  // The overlay loads nothing from the web (the app's content rules): anything else is a failure.
  const overlayOrigin = new URL(overlayUrl).origin;
  const blocked = [];
  await context.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(overlayOrigin) || /^(data|blob):/.test(u)) return route.continue();
    blocked.push(u);
    return route.abort();
  });

  /** Everything the copy sent, in order (all epochs). */
  const received = [];
  const requests = []; // the app's reqs, with their replies
  const performs = []; // what overlays asked the app (`perform`)
  const layoutsSent = []; // setLayout messages
  const drawnSent = []; // drawn messages
  const dataChanges = []; // the copy's data.changes
  const overlayLogs = [];
  const pageErrors = [];
  const listeners = new Set();

  let app = null;
  let running = true; // Margin.app is running (the handler's `appOpen`)
  let launching = false; // the handler is starting it (`launching`)
  let linkAnswers = true; // the app answers wantLink with a link
  let hello = null;
  let epoch = null;
  let seq = 0;
  let resyncing = false;
  let raw = null;
  let windows = [];
  let keys = null;
  let themeJSON = null;
  let themeId = null;
  let parts = { transfer: null, got: new Map() };
  let reconnectTimer = null;
  let tickTimer = null;
  let seed = dataSet;
  let cloud = cloudTabs;
  let acrossNow = across;
  let reqId = 0;
  const waiting = new Map();
  /** @type {Map<number, any>} */
  const overlays = new Map();
  const drawnOn = new Map(); // windowId → the last `drawn` sent
  const outbox = new Map(); // windowId → { seq, key } of setLayout
  const unwanted = new Map(); // windowId → timer to say drawn false
  const held = new Map(); // windowId (-1 every window) → type → msg
  const heldPalette = new Map(); // windowId → { msg, until, newTab }
  const fullscreenAsked = new Set();
  let holding = false; // the app's word to its overlays held back (a test makes the overlay lag)
  const backlog = [];

  const notify = () => { for (const fn of [...listeners]) fn(); };
  const send = (msg) => app?.send(msg);

  async function startApp() {
    app = await startFakeApp({
      onMessage: (m) => { received.push(m); take(m); notify(); },
      onClose: () => { if (!app?.open) linkDown('dropped'); },
    });
    clearInterval(tickTimer);
    tickTimer = setInterval(() => send({ k: 'tick', at: Date.now() }), 5000);
  }
  await startApp();

  // ---- what the copy says ----------------------------------------------------
  function take(m) {
    switch (m.k) {
      case 'hello': {
        const again = hello && hello.profile === m.profile && reconnectTimer;
        hello = m;
        epoch = m.epoch;
        seq = 0;
        outbox.clear();
        drawnOn.clear();
        resyncing = false;
        say('hello', m.browser, m.profile, again ? '(back within the grace)' : '');
        if (again) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
          for (const o of overlays.values()) o.push({ type: 'link', state: 'linked' });
        }
        return;
      }
      case 'snapshot':
        if (m.epoch !== epoch) return;
        raw = m.state ?? {};
        windows = Array.isArray(m.windows) ? m.windows : [];
        seq = m.seq;
        resyncing = false;
        for (const o of overlays.values()) o.push({ type: 'state', state: raw, windows });
        return void sync();
      case 'delta':
      case 'windows': {
        if (m.epoch !== epoch) return;
        if (resyncing) return;
        if (m.seq !== seq + 1) { resyncing = true; say('a gap: resync'); send({ k: 'resync', epoch }); return; }
        seq = m.seq;
        if (m.k === 'delta') {
          raw = { ...(raw ?? {}) };
          for (const [key, change] of Object.entries(m.changes ?? {})) {
            if (key === 'favicons') continue;
            if (change && 'newValue' in change) raw[key] = change.newValue; else delete raw[key];
          }
          if (m.favicons) {
            const icons = { ...(raw.favicons ?? {}), ...(m.favicons.set ?? {}) };
            for (const site of m.favicons.del ?? []) delete icons[site];
            raw.favicons = icons;
          }
          const msg = { type: 'changes', changes: m.changes ?? {}, ...(m.favicons ? { favicons: { set: m.favicons.set ?? {}, del: m.favicons.del ?? [] } } : {}) };
          for (const o of overlays.values()) o.push(msg);
          return;
        }
        const before = windows;
        windows = Array.isArray(m.list) ? m.list : [];
        if (!onlyVisibility(before, windows)) for (const o of overlays.values()) o.push({ type: 'windows', list: windows });
        return void sync();
      }
      case 'theme': {
        if (m.epoch !== epoch) return;
        if (parts.transfer !== m.transfer) parts = { transfer: m.transfer, got: new Map() };
        parts.got.set(m.part, m.data);
        if (parts.got.size !== m.parts) return;
        const whole = Buffer.concat([...parts.got.entries()].sort((a, b) => a[0] - b[0]).map(([, d]) => Buffer.from(d, 'base64')));
        const sha = createHash('sha256').update(whole).digest('hex');
        if (whole.length !== m.size || sha !== m.transfer) throw new Error(`the theme's pieces don't add up (${whole.length} of ${m.size} bytes)`);
        themeJSON = whole.toString('utf8');
        themeId = m.id;
        say('theme', m.id, whole.length, 'bytes in', m.parts, 'piece(s)');
        const theme = JSON.parse(themeJSON);
        for (const o of overlays.values()) o.push({ type: 'theme', theme });
        return void sync();
      }
      case 'keys':
        keys = m.bindings;
        return;
      case 'push':
        return void pushed(m.windowId ?? null, m.msg);
      case 'reply': {
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        w?.(m);
        return;
      }
      case 'data.hello':
        if (seed) send({ k: 'data.snapshot', epoch, profile: m.profile, format: seed.format ?? 1, set: seed, transfer: `seed-${Date.now()}`, part: 0, parts: 1 });
        else send({ k: 'data.need', epoch, profile: m.profile, all: true });
        return;
      case 'data.changes':
        dataChanges.push(...(m.changes ?? []));
        return;
      case 'bye':
        say('the copy said goodbye:', m.why);
        return void linkDown(`bye (${m.why})`);
      default:
        return;
    }
  }

  const strip = (list) => list.map((w) => { const { visible, visibleAt, ...rest } = w; return rest; });
  const onlyVisibility = (a, b) => a.length === b.length && b.length > 0 && JSON.stringify(strip(a)) === JSON.stringify(strip(b));

  function pushed(windowId, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (HELD_TYPES.has(msg.type)) {
      const k = windowId ?? -1;
      if (!held.has(k)) held.set(k, new Map());
      held.get(k).set(msg.type, { msg, at: Date.now() });
    }
    if (msg.type === 'keyHeard') return void say('keyHeard', msg.command, msg.from);
    if (msg.type === 'palette' && windowId != null) {
      const o = overlays.get(windowId);
      if (o?.ready) return o.push({ type: 'push', msg });
      say('palette for window', windowId, 'held');
      heldPalette.set(windowId, { msg, until: Date.now() + PALETTE_HOLD_MS, newTab: msg.newTab === true || heldPalette.get(windowId)?.newTab === true });
      setTimeout(() => {
        const h = heldPalette.get(windowId);
        if (!h || Date.now() < h.until) return;
        heldPalette.delete(windowId);
        say('palette for window', windowId, 'dropped');
        if (!overlays.get(windowId)?.ready) sendDrawn(windowId, false);
        if (h.newTab) void request('paletteDropped', { windowId, newTab: true }, windowId).catch(() => {});
      }, PALETTE_HOLD_MS + 50);
      return;
    }
    for (const [id, o] of overlays) if (windowId == null || id === windowId) o.push({ type: 'push', msg });
  }

  function heldFor(windowId) {
    const out = [];
    for (const k of [-1, windowId]) for (const [type, { msg, at }] of held.get(k) ?? []) if (type !== 'notice' || Date.now() - at <= 60_000) out.push({ msg, at });
    return out.sort((a, b) => a.at - b.at).map((e) => e.msg);
  }

  // ---- the link going -------------------------------------------------------------
  function linkDown(why) {
    if (!hello) return;
    say('link down:', why);
    for (const w of waiting.values()) w({ ok: false, error: 'link down' });
    waiting.clear();
    const goneAtOnce = why.startsWith('bye') || why === 'quit';
    if (goneAtOnce || !overlays.size) return void closeAll();
    for (const o of overlays.values()) o.push({ type: 'link', state: 'reconnecting' });
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; say('no relink within the grace: overlays closed'); closeAll(); }, RECONNECT_GRACE_MS);
  }
  function closeAll() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    for (const id of [...overlays.keys()]) void closeOverlay(id);
    hello = null;
    epoch = null;
  }

  // ---- the windows ---------------------------------------------------------------
  function sendDrawn(windowId, on) {
    if (drawnOn.get(windowId) === on || epoch == null) return;
    drawnOn.set(windowId, on);
    const msg = { k: 'drawn', epoch, windowId, on, at: Date.now() };
    drawnSent.push(msg);
    say('drawn', windowId, on);
    send(msg);
  }

  function sync() {
    if (!hello || raw == null) return;
    const ids = new Set(windows.map((w) => w.windowId));
    for (const id of [...overlays.keys()]) if (!ids.has(id)) { if (drawnOn.get(id)) sendDrawn(id, false); void closeOverlay(id); }
    for (const [id, t] of unwanted) if (!ids.has(id)) { clearTimeout(t); unwanted.delete(id); }
    for (const w of windows) {
      const id = w.windowId;
      const wanted = w.state === 'fullscreen' && w.state !== 'minimized';
      if (wanted) {
        clearTimeout(unwanted.get(id));
        unwanted.delete(id);
        const o = overlays.get(id);
        if (!o && themeJSON) openOverlay(w);
        else if (o) { sendDrawn(id, true); o.resize(w); offerLayout(o); }
      } else {
        if (makeFullscreen && !fullscreenAsked.has(id) && w.state === 'normal' && overlays.size) {
          fullscreenAsked.add(id);
          void makeFullscreen(id).catch(() => {});
          continue;
        }
        if (!unwanted.has(id) && drawnOn.get(id) !== false) {
          unwanted.set(id, setTimeout(() => {
            unwanted.delete(id);
            const now = windows.find((x) => x.windowId === id);
            if (now && now.state === 'fullscreen') return;
            sendDrawn(id, false);
            void closeOverlay(id);
          }, UNWANTED_GRACE_MS));
        }
      }
    }
  }

  async function closeOverlay(id) {
    const o = overlays.get(id);
    if (!o) return;
    overlays.delete(id);
    held.delete(id);
    notify();
    await o.page.close().catch(() => {});
  }

  function openOverlay(w) {
    const id = w.windowId;
    const o = {
      windowId: id, page: null, ready: false, asked: false, layout: null, hits: null, focus: false, pointerWant: null,
      size: { width: w.width, height: w.height }, chain: Promise.resolve(), opened: Date.now(),
      push(msg) {
        if (!o.asked) return;
        if (holding) return void backlog.push([o, msg]);
        const json = JSON.stringify(msg);
        o.chain = o.chain.then(() => o.page?.evaluate((j) => globalThis.marginApp?.receive(j), json)).catch(() => {});
      },
      resize(win) {
        if (win.width === o.size.width && win.height === o.size.height) return;
        o.size = { width: win.width, height: win.height };
        void o.page?.setViewportSize(o.size).catch(() => {});
      },
    };
    overlays.set(id, o);
    sendDrawn(id, true);
    o.ready$ = (async () => {
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      o.page = page;
      await page.setViewportSize(o.size);
      page.on('pageerror', (e) => { pageErrors.push({ windowId: id, message: e.message }); say('overlay error', e.message); });
      page.on('console', (c) => { if (c.type() === 'error') pageErrors.push({ windowId: id, message: c.text() }); });
      await page.exposeBinding('__marginPost', (_, body) => bridge(o, body));
      await page.addInitScript(() => {
        /** @type {any} */ (window).webkit = { messageHandlers: { margin: { postMessage: (b) => /** @type {any} */ (window).__marginPost(b) } } };
      });
      await page.goto(overlayUrl);
    })().catch((e) => { if (overlays.get(id) === o) say('overlay failed to open', e.message); });
    notify();
  }

  async function bridge(o, body) {
    const op = body?.op;
    switch (op) {
      case 'hello': {
        o.asked = true;
        if (!hello) return 'null';
        const win = windows.find((x) => x.windowId === o.windowId);
        return JSON.stringify({
          windowId: o.windowId, profile: hello.profile, browser: hello.browser,
          mode: win?.state === 'fullscreen' ? 'fullscreen' : 'windowed',
          platform: { browser: hello.browser, os: 'mac', app: true },
          state: raw, windows, across: acrossNow, cloudTabs: hello.browser === 'safari' ? cloud : null,
          held: heldFor(o.windowId), theme: themeJSON ? JSON.parse(themeJSON) : null,
        });
      }
      case 'send': {
        if (!hello) throw new Error('no answer from Margin: down');
        const res = await request(body.type, body.payload ?? {}, o.windowId);
        return JSON.stringify({ ok: res.ok, ...(res.ok ? { result: res.result } : { error: res.error }), ...(res.stale ? { stale: true } : {}) });
      }
      case 'ready':
        if (!o.ready) {
          o.ready = true;
          say('overlay drawn for window', o.windowId, 'after', Date.now() - o.opened, 'ms');
          const pal = heldPalette.get(o.windowId);
          heldPalette.delete(o.windowId);
          o.push({ type: 'shown', focus: o.focusOnShow === true });
          if (pal && Date.now() <= pal.until) o.push({ type: 'push', msg: pal.msg });
          notify();
        }
        return null;
      case 'layout':
        if (!body.geometry?.insets || !body.geometry?.container) return null;
        o.layout = body.geometry;
        offerLayout(o);
        return null;
      case 'hits': o.hits = { rects: body.rects ?? [], all: !!body.all }; return null;
      case 'focus': o.focus = body.on === true; return null;
      case 'pointerWant': o.pointerWant = body; return null;
      case 'perform': {
        performs.push({ windowId: o.windowId, name: body.name, arg: body.arg ?? null, at: Date.now() });
        if (body.name === 'window.fullscreen') void request('toggleFullscreen', { windowId: o.windowId }, o.windowId).catch(() => {});
        notify();
        return null;
      }
      case 'log':
        overlayLogs.push({ windowId: o.windowId, level: body.level, text: String(body.text ?? '') });
        say('overlay log', body.level, String(body.text ?? '').slice(0, 200));
        notify();
        return null;
      default:
        return null;
    }
  }

  // Only a layout measured at the window's size, and only a change (Shell.layoutChanged, the outbox).
  function offerLayout(o) {
    const g = o.layout;
    if (!g || epoch == null || !drawnOn.get(o.windowId)) return;
    if (Math.abs(g.container.width - o.size.width) >= 1 || Math.abs(g.container.height - o.size.height) >= 1) return;
    const insets = Object.fromEntries(['left', 'top', 'right', 'bottom'].map((k) => [k, half(g.insets[k] ?? 0)]));
    const key = JSON.stringify([insets, g.radius, g.radii]);
    const last = outbox.get(o.windowId);
    if (last?.key === key) return;
    const next = (last?.seq ?? 0) + 1;
    outbox.set(o.windowId, { seq: next, key });
    const msg = { k: 'setLayout', epoch, windowId: o.windowId, seq: next, insets, radius: g.radius ?? 0, radii: g.radii ?? null, container: { width: o.size.width, height: o.size.height }, mode: g.mode === 'windowed' ? 'windowed' : 'fullscreen', at: Date.now() };
    layoutsSent.push(msg);
    send(msg);
    notify();
  }

  /** The app's `req` for a window; resolves with the copy's reply ({ ok, result } or { ok: false, error }). */
  function request(type, payload = {}, windowId = null) {
    if (!hello || epoch == null) return Promise.resolve({ ok: false, error: 'not linked' });
    const id = ++reqId;
    const entry = { id, type, payload, windowId, at: Date.now(), reply: null };
    requests.push(entry);
    const got = new Promise((resolve) => {
      const timer = setTimeout(() => { waiting.delete(id); resolve({ ok: false, error: 'no answer in 15 s' }); }, 15_000);
      waiting.set(id, (m) => { clearTimeout(timer); entry.reply = m; resolve(m); });
    });
    send({ k: 'req', id, epoch, windowId, type, payload, at: Date.now() });
    return got;
  }

  const frontWindowId = () => (windows.find((w) => w.focused) ?? windows[0])?.windowId ?? null;

  /** Waits until `check()` is truthy (re-checked on every message and every 25 ms). */
  async function until(check, { timeout = 5000, what = 'a condition' } = {}) {
    const end = Date.now() + timeout;
    for (;;) {
      const v = check();
      if (v) return v;
      if (Date.now() > end) throw new Error(`the shell waited ${timeout} ms for ${what}`);
      await new Promise((resolve) => {
        const done = () => { listeners.delete(done); clearTimeout(t); resolve(undefined); };
        const t = setTimeout(done, 25);
        listeners.add(done);
      });
    }
  }

  return {
    received, requests, performs, layoutsSent, drawnSent, dataChanges, overlayLogs, pageErrors, blocked,
    get app() { return app; },
    get hello() { return hello; },
    get epoch() { return epoch; },
    get linked() { return !!hello && !!app?.open; },
    get state() { return raw; },
    get windows() { return windows; },
    get keys() { return keys; },
    get themeId() { return themeId; },
    get theme() { return themeJSON ? JSON.parse(themeJSON) : null; },
    get overlays() { return overlays; },
    get running() { return running; },
    frontWindowId,
    until,
    request,

    /** What Safari's handler answers `wantLink` (relay.js), and the link it dispatches. */
    wantLink(nonce) {
      if (!running) return { reply: { ok: true, appOpen: false, launching } };
      return { reply: { ok: true, appOpen: true, launching: false }, link: linkAnswers ? JSON.parse(app.linkInfo(nonce).userInfo.e) : null };
    },
    /** The overlay over a window (its page drawn), waited for. */
    async overlay(windowId = frontWindowId(), { timeout = 10_000 } = {}) {
      const o = await until(() => { const x = overlays.get(windowId ?? frontWindowId()); return x?.ready && x; }, { timeout, what: `the overlay of window ${windowId}` });
      await o.ready$;
      return o;
    },
    /** The app's hot key: `palette` and `toggle-sidebar` go to the front overlay; the rest are the copy's `navigate`. */
    key(name, windowId = frontWindowId()) {
      if (name === 'palette' || name === 'toggle-sidebar') return void overlays.get(windowId)?.push({ type: 'command', name });
      return request('navigate', { action: name, windowId }, windowId);
    },
    navigate(action, windowId = frontWindowId()) { return request('navigate', { action, windowId }, windowId); },
    /** What the app sends an overlay (pointer, pressOutside, blur, shown…). */
    tell(windowId, msg) { overlays.get(windowId)?.push(msg); },
    drawn(windowId, on) { sendDrawn(windowId, on); },
    /** Holds back what the overlays are told (`true`), then gives it all in order (`false`). */
    hold(on) {
      holding = on;
      if (on) return;
      for (const [o, msg] of backlog.splice(0)) if (overlays.get(o.windowId) === o) o.push(msg);
    },
    /** The app's set for the next data.hello (a seed), or sent now when linked. */
    seed(set, { now = false } = {}) {
      seed = set;
      if (now && hello) send({ k: 'data.snapshot', epoch, profile: hello.profile, format: set.format ?? 1, set, transfer: `seed-${Date.now()}`, part: 0, parts: 1 });
    },
    setCloudTabs(value) {
      cloud = value;
      for (const o of overlays.values()) o.push({ type: 'cloudTabs', cloudTabs: value });
    },
    setAcross(value) {
      acrossNow = value;
      for (const o of overlays.values()) o.push({ type: 'across', across: value });
    },
    /** The app killed: every socket dropped, no close frame; it stays "running" unless `gone`. */
    drop({ gone = false } = {}) { if (gone) running = false; app.drop(); },
    /** The app's goodbye (it's quitting). */
    bye(why = 'quitting') { send({ k: 'bye', why }); running = false; setTimeout(() => app.drop(), 50); linkDown('quit'); },
    /** Not running, or starting (the handler's answers). */
    setRunning(on, { starting = false } = {}) { running = on; launching = starting; },
    setLinkAnswers(on) { linkAnswers = on; },
    /** A new app: new port, token and key; then `appUp` (relay.dispatch is the caller's). */
    async restart() {
      const old = app;
      old.drop();
      await old.close();
      running = true;
      launching = false;
      await startApp();
    },
    async close() {
      clearInterval(tickTimer);
      clearTimeout(reconnectTimer);
      for (const t of unwanted.values()) clearTimeout(t);
      await context.close().catch(() => {});
      await app?.close().catch(() => {});
    },
  };
}

export { sleep };
