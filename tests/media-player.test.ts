// The background mini player (M2.4): the rule for what it shows (shared/media.ts), the copy's sources and their
// pushes (background/media.ts: a tab closed goes, the 30 s pause grace on a fake clock and timer, the artwork read in
// the background and never waited for), a page's report and buttons (content/media.ts, on a stand-in document),
// Margin.app's `hostMedia` (background/hosted.ts) and the library's `mediaControl` (app/shared/library/library.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../extension/state/model.ts';
import * as L from '../app/shared/library/library.ts';
import { mergeData, liveValues } from '../extension/shared/data-merge.ts';
import { PAUSE_GRACE_MS, selectBackgroundMedia, type MediaSource } from '../extension/shared/media.ts';
import { ARTWORK, createArtworkCache, createMediaHub, createMediaRegistry, loadArtwork, type MediaPushSource } from '../extension/background/media.ts';
import { applyMediaCommand, snapshotMedia, startMedia } from '../extension/content/media.ts';
import { createHostedTabs } from '../extension/background/hosted.ts';
import { buildViewModel } from '../extension/ui/view-model.ts';
import { checkAction, contextFromState, requestFor } from '../extension/ui/actions.ts';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// A clock and a timer the test turns.
function fakeTime(start = 10_000) {
  let clock = start;
  let pending: { fn: () => void, at: number, id: number } | null = null;
  let ids = 0;
  return {
    now: () => clock,
    timers: {
      set: (fn: () => void, ms: number) => { pending = { fn, at: clock + ms, id: ++ids }; return pending.id; },
      clear: (id: unknown) => { if (pending?.id === id) pending = null; },
    },
    get pending() { return pending; },
    advance(ms: number) {
      clock += ms;
      while (pending && pending.at <= clock) { const p = pending; pending = null; p.fn(); }
    },
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test('mini player: the tab in front never shows; a background one does (the state\'s audible tabs, the extension\'s own UI)', () => {
  let s = M.defaultState();
  s = M.setActiveSpace(s, 1, 'personal');
  s = M.upsertTab(s, { id: 1, windowId: 1, index: 0, active: true, audible: true, url: 'https://youtube.com/watch?v=1', title: 'Lo-fi Beats' } as BrowserTab, 1000);
  s = M.upsertTab(s, { id: 2, windowId: 1, index: 1, active: false, audible: false, url: 'https://docs.example/', title: 'Docs' } as BrowserTab, 1000);
  s = M.moveTab(s, 1, 'personal');
  s = M.moveTab(s, 2, 'personal');
  assert.equal(buildViewModel({ state: s, ui: { windowId: 1, tabId: 1 }, now: 2000 }).media, null, 'the playing tab in front: no mini player');
  s = M.upsertTab(s, { id: 1, windowId: 1, index: 0, active: false, audible: true, url: 'https://youtube.com/watch?v=1', title: 'Lo-fi Beats' } as BrowserTab, 1500);
  s = M.upsertTab(s, { id: 2, windowId: 1, index: 1, active: true, audible: false, url: 'https://docs.example/', title: 'Docs' } as BrowserTab, 1500);
  const vm = buildViewModel({ state: s, ui: { windowId: 1, tabId: 2 }, now: 2000 });
  assert.equal(vm.media?.tabId, 1);
  assert.equal(vm.media?.title, 'Lo-fi Beats');
  assert.deepEqual([vm.media?.playing, vm.media?.paused], [true, false]);
});

test('mini player: Margin.app\'s sources (a list, by the UI\'s numbers): the one in front skipped, playing before paused, artwork only as a data URL', () => {
  let s = M.defaultState();
  s = M.setActiveSpace(s, 1, 'personal');
  s = M.upsertTab(s, { id: 3, windowId: 1, index: 0, active: true, url: 'https://music.example/', title: 'Music' } as BrowserTab, 1000);
  s = M.moveTab(s, 3, 'personal');
  const src = (tabId: number, extra: Partial<MediaSource> = {}): MediaSource => ({ id: `tab:${tabId}`, source: 'tab', tabId, title: `T${tabId}`, subtitle: '', playing: true, muted: false, updatedAt: 1000, pausedAt: null, ...extra });
  const media = [src(3, { updatedAt: 3000 }), src(4, { playing: false, pausedAt: 1500, updatedAt: 2500 }), src(5, { updatedAt: 1200, artwork: PNG }), src(6, { artwork: 'https://x.example/a.jpg' })];
  const vm = buildViewModel({ state: s, ui: { windowId: 1, tabId: 3, media }, now: 2000 });
  assert.equal(vm.media?.tabId, 5, 'the tab in front (3) skipped; playing (5, 6) before paused (4); the newest first');
  assert.equal(vm.media?.artwork, PNG);
  const only6 = buildViewModel({ state: s, ui: { windowId: 1, tabId: 3, media: [src(6, { artwork: 'https://x.example/a.jpg' })] }, now: 2000 });
  assert.equal(only6.media?.artwork, null, 'an address never reaches the theme: only a data URL');
  const paused = buildViewModel({ state: s, ui: { windowId: 1, tabId: 3, media: [src(4, { playing: false, pausedAt: 1000 })] }, now: 1000 + PAUSE_GRACE_MS });
  assert.equal(paused.media?.paused, true, 'paused: still there at 30 s');
  assert.equal(buildViewModel({ state: s, ui: { windowId: 1, tabId: 3, media: [src(4, { playing: false, pausedAt: 1000 })] }, now: 1001 + PAUSE_GRACE_MS }).media, null, '…gone after');
  assert.equal(PAUSE_GRACE_MS, 30_000);
  assert.equal(selectBackgroundMedia([src(3)], { activeTabId: 3 }), null);
});

test('mini player: the copy\'s sources: a report pushed for its tab\'s window with its item; paused, 30 s on one timer, then gone; nothing scheduled while nothing is paused', () => {
  const t = fakeTime();
  const pushed: { windowId: number, sources: MediaPushSource[] }[] = [];
  const hub = createMediaHub({ push: (windowId, msg) => pushed.push({ windowId, sources: msg.sources }), itemOf: (id) => (id === 7 ? 't-item7' : null), now: t.now, timers: t.timers, artwork: async () => null });
  hub.report({ id: 7, windowId: 90, url: 'https://music.example/', title: 'Tab title' }, { playing: true, title: 'Song', artist: 'Band' });
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].windowId, 90);
  assert.deepEqual({ ...pushed[0].sources[0], updatedAt: 0 }, { tabId: 7, itemId: 't-item7', url: 'https://music.example/', title: 'Song', subtitle: 'Band', artwork: null, playing: true, muted: false, canPrev: false, canNext: false, updatedAt: 0, pausedAt: null });
  assert.equal(hub.timerSet, false, 'playing: no timer');
  hub.report({ id: 7, windowId: 90 }, { playing: true, title: 'Song', artist: 'Band' });
  assert.equal(pushed.length, 1, 'the same again: not pushed again');
  t.advance(1000);
  hub.report({ id: 7, windowId: 90 }, { playing: false, title: 'Song', artist: 'Band' });
  assert.equal(pushed.length, 2);
  assert.equal(pushed[1].sources[0].pausedAt, 11_000);
  assert.equal(hub.timerSet, true, 'paused: one timer, for its grace');
  t.advance(PAUSE_GRACE_MS - 1000);
  assert.equal(pushed.length, 2, 'still there within 30 s');
  t.advance(2000);
  assert.deepEqual(pushed.at(-1), { windowId: 90, sources: [] }, 'after 30 s: gone, its window told');
  assert.equal(hub.timerSet, false, 'nothing paused: no timer');
  assert.equal(hub.list().length, 0);
  // (A report of a page paused that never played: nothing.)
  hub.report({ id: 8, windowId: 90 }, { playing: false });
  assert.equal(pushed.length, 3);
});

test('mini player: a tab closed or its page left goes at once; its mute and Safari\'s audible as they change', () => {
  const t = fakeTime();
  const pushed: { windowId: number, sources: MediaPushSource[] }[] = [];
  const hub = createMediaHub({ push: (windowId, msg) => pushed.push({ windowId, sources: msg.sources }), now: t.now, timers: t.timers, artwork: async () => null });
  hub.report({ id: 1, windowId: 5 }, { playing: true, title: 'A' });
  hub.report({ id: 2, windowId: 5 }, { playing: true, title: 'B' });
  hub.muted(2, true);
  assert.equal(pushed.at(-1)?.sources.find((s) => s.tabId === 2)?.muted, true, 'muted (Margin\'s mute: tabs.update): said');
  hub.remove(2);
  assert.deepEqual(pushed.at(-1)?.sources.map((s) => s.tabId), [1], 'closed: gone at once, no grace');
  hub.remove(1);
  assert.deepEqual(pushed.at(-1), { windowId: 5, sources: [] });
  const count = pushed.length;
  hub.remove(1);
  assert.equal(pushed.length, count, 'gone already: nothing said');
  // Safari hears a tab playing whose page said nothing (an Audio() never in the page, a frame): a source of its own.
  hub.audible({ id: 3, windowId: 5, url: 'https://www.radio.example/live', title: 'Radio', audible: true });
  assert.deepEqual(pushed.at(-1)?.sources.map((s) => [s.tabId, s.title, s.subtitle, s.playing]), [[3, 'Radio', 'radio.example', true]]);
  hub.audible({ id: 3, windowId: 5, title: 'Radio', audible: false });
  assert.equal(pushed.at(-1)?.sources[0].playing, false, 'silent: paused, in its grace');
  // A page's own report is the source after that: Safari's audible no longer changes it.
  hub.report({ id: 3, windowId: 5 }, { playing: true, title: 'Show' });
  hub.audible({ id: 3, windowId: 5, title: 'Radio', audible: false });
  assert.equal(pushed.at(-1)?.sources[0].title, 'Show');
  assert.equal(pushed.at(-1)?.sources[0].playing, true);
  // The link back: every window with sources told again.
  const before = pushed.length;
  hub.tellAll();
  assert.equal(pushed.length, before + 1);
});

test('mini player: artwork from an address is read in the background, never waited for, kept per address (the last 16)', async () => {
  const t = fakeTime();
  const pushed: MediaPushSource[][] = [];
  const asked: string[] = [];
  let release: (v: string | null) => void = () => {};
  const hub = createMediaHub({
    push: (_, msg) => pushed.push(msg.sources), now: t.now, timers: t.timers,
    artwork: (url) => { asked.push(url); return new Promise((r) => { release = r; }); },
  });
  hub.report({ id: 1, windowId: 5 }, { playing: true, title: 'A', artworkUrl: 'https://img.example/a.jpg' });
  assert.equal(pushed.length, 1, 'pushed at once…');
  assert.equal(pushed[0][0].artwork, null, '…without the artwork');
  hub.report({ id: 1, windowId: 5 }, { playing: true, title: 'A2', artworkUrl: 'https://img.example/a.jpg' });
  assert.deepEqual(asked, ['https://img.example/a.jpg'], 'asked once while it\'s being made');
  release(PNG);
  await flush();
  assert.equal(pushed.at(-1)?.[0].artwork, PNG, 'then again with it');
  hub.report({ id: 2, windowId: 5 }, { playing: true, title: 'B', artworkUrl: 'https://img.example/a.jpg' });
  assert.equal(pushed.at(-1)?.find((s) => s.tabId === 2)?.artwork, PNG, 'kept: another tab with the same artwork has it at once');
  assert.equal(asked.length, 1);
  // Never an address it may not read.
  for (const bad of ['http://img.example/a.jpg', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html;base64,PGI+']) {
    hub.report({ id: 3, windowId: 5 }, { playing: true, title: 'C', artworkUrl: bad });
    assert.equal(asked.length, 1, bad);
  }
  // The cache: the newest `keep` only.
  const cache = createArtworkCache({ load: async (u) => `data:image/png;base64,${u.length}`, keep: 2 });
  for (const u of ['https://a/1', 'https://a/22', 'https://a/333']) await cache.want(u);
  assert.equal(cache.size, 2);
  assert.equal(cache.get('https://a/1'), undefined, 'the oldest went');
  assert.equal(ARTWORK.keep, 16);
});

test('mini player: loadArtwork: https or an image data URL only, no cookies, an image only, not too big; a small one as it is where nothing can draw', async () => {
  const g = globalThis as any;
  const realFetch = g.fetch;
  const asked: { url: string, init: any }[] = [];
  try {
    g.fetch = async (url: string, init: any) => {
      asked.push({ url, init });
      if (url.includes('page')) return new Response('<html>', { headers: { 'content-type': 'text/html' } });
      if (url.includes('huge')) return new Response(new Blob([new Uint8Array(ARTWORK.maxBytes + 1)], { type: 'image/png' }));
      if (url.includes('gone')) return new Response('', { status: 404 });
      return realFetch(PNG);
    };
    assert.equal(await loadArtwork('http://img.example/a.png'), null);
    assert.equal(asked.length, 0, 'http never fetched');
    assert.match(await loadArtwork('https://img.example/a.png') ?? '', /^data:image\/png;base64,/);
    assert.equal(asked[0].init.credentials, 'omit', 'no cookies');
    assert.equal(asked[0].init.referrerPolicy, 'no-referrer');
    assert.equal(await loadArtwork('https://img.example/page'), null, 'not an image');
    assert.equal(await loadArtwork('https://img.example/huge'), null, 'too big');
    assert.equal(await loadArtwork('https://img.example/gone'), null);
    assert.equal(await loadArtwork(PNG), PNG, 'a page\'s own data URL');
  } finally {
    g.fetch = realFetch;
  }
});

// ---- the page's side (content/media.ts), on a stand-in document ----

function fakeDoc({ media = [] as any[], buttons = [] as { label: string, disabled?: boolean }[], metadata = null as any } = {}) {
  const listeners = new Map<string, Set<(e: any) => void>>();
  const clicks: string[] = [];
  const btns = buttons.map((b) => ({ getAttribute: (n: string) => (n === 'aria-label' ? b.label : null), disabled: !!b.disabled, hidden: false, click: () => clicks.push(b.label) }));
  const doc: any = {
    title: 'Page title',
    defaultView: { navigator: { mediaSession: { metadata } } },
    querySelectorAll: (sel: string) => (sel.startsWith('audio') ? media : sel.startsWith('button') ? btns : []),
    addEventListener: (type: string, fn: any) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(fn); },
    removeEventListener: (type: string, fn: any) => listeners.get(type)?.delete(fn),
    fire: (type: string, target: any) => { for (const fn of listeners.get(type) ?? []) fn({ type, target }); },
    listeners, clicks,
  };
  return doc;
}
const element = (playing: boolean) => ({ localName: 'video', paused: !playing, ended: false, muted: false, volume: 1, duration: 200, currentTime: 50, play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; } });

test('mini player: a page\'s report: its element and Media Session (title, artist, the largest https artwork), its own Next button; nothing while nothing played', () => {
  const v = element(true);
  const doc = fakeDoc({ media: [v], buttons: [{ label: 'Next page' }, { label: 'Next (SHIFT+n)' }, { label: 'Skip ad' }], metadata: { title: 'Song', artist: 'Band', artwork: [{ src: 'https://i.example/96.jpg', sizes: '96x96' }, { src: 'https://i.example/512.jpg', sizes: '512x512' }, { src: 'http://i.example/1024.jpg', sizes: '1024x1024' }] } });
  assert.deepEqual(snapshotMedia(doc), { playing: true, muted: false, title: 'Song', artist: 'Band', artworkUrl: 'https://i.example/512.jpg', canPrev: true, canNext: true });
  assert.equal(applyMediaCommand(doc, 'next'), true);
  assert.deepEqual(doc.clicks, ['Next (SHIFT+n)'], 'only a button labelled Next: never "Next page" or "Skip ad"');
  assert.equal(applyMediaCommand(doc, 'prev'), true);
  assert.equal(v.currentTime, 0, 'no Previous button: the track from its start');
  assert.equal(applyMediaCommand(doc, 'toggle'), true);
  assert.equal(v.paused, true);
  const none = fakeDoc({ buttons: [{ label: 'Next' }] });
  assert.equal(snapshotMedia(none).canNext, false, 'no media: its buttons aren\'t looked at');
});

test('mini player: a page\'s reports: on media events only (one capturing listener each, no polling), coalesced, the same never twice; started while playing, said at once', () => {
  const timers: (() => void)[] = [];
  const setTimer = (fn: () => void) => { timers.push(fn); return timers.length; };
  const run = () => { while (timers.length) timers.shift()!(); };
  const v = element(false);
  const doc = fakeDoc({ media: [v] });
  const sent: any[] = [];
  const w = startMedia({ doc, send: (r) => sent.push(r), setTimer, clearTimer: () => {} });
  assert.deepEqual([...doc.listeners.keys()].sort(), ['emptied', 'ended', 'loadedmetadata', 'pause', 'play', 'playing', 'volumechange']);
  assert.equal(timers.length, 0, 'nothing playing as it starts: nothing scheduled');
  doc.fire('loadedmetadata', v);
  run();
  assert.equal(sent.length, 0, 'never played: nothing said');
  v.paused = false;
  doc.fire('play', v); doc.fire('playing', v); doc.fire('volumechange', v);
  assert.equal(timers.length, 1, 'a burst: one report');
  run();
  assert.equal(sent.length, 1);
  doc.fire('playing', v);
  run();
  assert.equal(sent.length, 1, 'nothing changed: not said again');
  doc.fire('play', { localName: 'div' });
  assert.equal(timers.length, 0, 'not a media element: nothing');
  assert.equal(w.command('toggle'), true);
  run();
  assert.equal(sent.at(-1).playing, false);
  assert.equal(w.command('rm -rf'), false, 'not a command');
  w.destroy();
  assert.equal([...doc.listeners.values()].every((s) => s.size === 0), true);
  // Put in a page that plays already (Margin updated): said at once.
  const playing = fakeDoc({ media: [element(true)] });
  const sent2: any[] = [];
  startMedia({ doc: playing, send: (r) => sent2.push(r), setTimer, clearTimer: () => {} });
  run();
  assert.equal(sent2[0]?.playing, true);
});

// ---- Margin.app's side: the copy's hostMedia, the library's mediaControl ----

test('mini player: hostMedia: the item\'s tab\'s page told the button; mute by the tab; its tab from the push when the copy lost the tag', async () => {
  const tabs = new Map<number, any>([[700, { id: 700, windowId: 90, url: 'https://music.example/', active: false, mutedInfo: { muted: false } }]]);
  const sent: any[] = [];
  const api: any = {
    async get(id: number) { const t = tabs.get(id); if (!t) throw new Error('no tab'); return { ...t }; },
    async query() { return [...tabs.values()]; },
    async create() { throw new Error('no'); },
    async update(id: number, props: any) { const t = tabs.get(id); if (props.muted != null) t.mutedInfo = { muted: props.muted }; return { ...t }; },
    async remove() {},
    async sendMessage(id: number, msg: any) { sent.push([id, msg]); return { ok: true }; },
  };
  const h = createHostedTabs(() => api);
  assert.deepEqual(await h.media({ itemId: 't-music', command: 'toggle' }), { ok: false }, 'no tag, no tab named: nothing');
  assert.deepEqual(await h.media({ itemId: 't-music', command: 'next', tabId: 700 }), { ok: true });
  assert.deepEqual(sent, [[700, { type: 'mediaCommand', command: 'next' }]]);
  assert.equal(h.itemOf(700), 't-music', 'tagged now');
  assert.deepEqual(await h.media({ itemId: 't-music', command: 'mute' }), { ok: true, muted: true });
  assert.equal(sent.length, 1, 'mute: the tab, not the page');
  await assert.rejects(h.media({ itemId: 't-music', command: 'eval' }), /not a media command/);
  await assert.rejects(h.media({ itemId: '../x y', command: 'toggle' }), /no item/);
  assert.deepEqual(await h.media({ itemId: 't-other', command: 'toggle', tabId: 700 }), { ok: false }, 'another item\'s tab: never');
});

function library(values: L.Values = {}) {
  let set: any = { format: 1, items: {} };
  let clock = 1000;
  const merge = (changes: L.Change[]) => { clock += 1; set = mergeData(set, changes.map((c) => ({ ...c, updatedAt: clock }))); };
  merge(Object.entries(values).flatMap(([collection, list]) => Object.entries(list).map(([id, value]) => ({ collection, id, value }))));
  const live = () => Object.fromEntries(L.COLLECTIONS.map((c) => [c, liveValues(set, c)]));
  return { act(action: string, payload: any = {}) { const out = L.perform(live(), action, payload, { now: clock + 1, ids: ['x1', 'x2', 'x3'] }); merge(out.changes); return out; } };
}

test('mini player: the library\'s mediaControl: a request for the hosting, nothing changed; focus and mute as activateTab and muteTab', () => {
  const lib = library({
    spaces: { a: { name: 'A', order: 0, browser: 'safari', profile: null } },
    tabs: {
      't-web1': { url: 'https://music.example/', title: 'Music', spaceId: 'a', order: 0, target: { kind: 'web', browser: 'safari', profile: null } },
      't-app1': { url: 'app://com.apple.Notes', title: 'Notes', spaceId: 'a', order: 1, target: { kind: 'app', bundleId: 'com.apple.Notes', name: 'Notes' } },
    },
  });
  assert.ok(L.ACTION_NAMES.includes('mediaControl'));
  const out = lib.act('mediaControl', { tabId: 't-web1', command: 'toggle', windowId: 3 });
  assert.equal(out.ok, true);
  assert.deepEqual(out.changes, []);
  assert.deepEqual(out.requests, [{ type: 'mediaControl', windowId: 3, item: 't-web1', url: 'https://music.example/', target: { kind: 'web', browser: 'safari', profile: null }, spaceId: 'a', command: 'toggle' }]);
  for (const command of ['prev', 'next']) assert.equal(lib.act('mediaControl', { tabId: 't-web1', command }).requests[0].command, command);
  assert.equal(lib.act('mediaControl', { tabId: 't-web1', command: 'mute' }).requests[0].type, 'muteTab');
  assert.equal(lib.act('mediaControl', { tabId: 't-web1', command: 'focus', windowId: 3 }).requests[0].type, 'activateTab');
  assert.deepEqual([lib.act('mediaControl', { tabId: 't-web1', command: 'rm' }).error, lib.act('mediaControl', { tabId: 't-app1', command: 'toggle' }).error, lib.act('mediaControl', { tabId: 't-none', command: 'toggle' }).error],
    ['not a media command', 'only a web item plays in the mini player', 'no such item']);
});

test('mini player: the UI\'s buttons: each a valid action the runtime sends', () => {
  const s = M.defaultState();
  const ctx = contextFromState(s);
  for (const name of ['media.toggle', 'media.prev', 'media.next', 'media.mute', 'media.focus']) {
    assert.equal(checkAction(name, undefined, ctx).ok, true, name);
    assert.equal(requestFor(name, undefined, { state: s, ui: { windowId: 1 } }).kind, 'send', name);
  }
  // (The registry alone, for the extension's own UI: the background source picked.)
  const reg = createMediaRegistry({ now: () => 5000 });
  reg.report({ id: 9, windowId: 1 }, { playing: true, title: 'X' });
  assert.equal(reg.current(9), null, 'in front: not it');
  assert.equal(reg.current(1)?.tabId, 9);
});
