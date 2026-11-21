// The background mini player's sources (M2.4), in the copy: what each tab's page says it plays (content/media.ts,
// the page request `mediaState`), kept in memory only, and told to Margin.app for that tab's window as a `media`
// push (docs/PROTOCOL.md "The mini player"). Margin.app passes it to the Margin window hosting that Safari window,
// whose UI shows the one playing in the background (shared/media.ts selectBackgroundMedia).
//
// - A tab closed, or its page left (a new document: webNavigation.onCommitted, main frame), goes at once
//   (background.ts). Safari's tab ids change on a restart or an update of Margin: nothing here outlives the
//   background, and a page playing then says so again (content/media.ts reports what plays as it starts).
// - Paused, a source stays PAUSE_GRACE_MS (30 s), then goes: one timer, only while something is paused; nothing
//   runs while nothing plays.
// - A tab Safari hears playing (`audible`) whose page said nothing (media in a frame, an Audio() never put in the
//   page): a source from the tab itself, its title and address, until its page says more.
// - Artwork: the page's Media Session artwork (an https address, or an image data URL), fetched here (the copy's
//   host permissions; no cookies sent), drawn at most ARTWORK.size px and sent as a PNG data URL. The report never
//   waits for it: sent without, then again once it's there. Kept per address, the last ARTWORK.keep only.
import { PAUSE_GRACE_MS, graceOver, selectBackgroundMedia, type MediaSource } from '../shared/media.ts';

export { PAUSE_GRACE_MS };

export const ARTWORK = { size: 128, maxBytes: 2_000_000, keep: 16, timeoutMs: 6000, maxUrl: 96_000 } as const;
/** Where a page's artwork may be read from: an https address, or an image of its own as a data URL. */
export const ARTWORK_URL = /^(https:\/\/[^\s]{1,2040}$|data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$)/i;
const ARTWORK_OUT = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
/** The most sources one window's push carries (the newest). */
export const MAX_SOURCES = 8;

/** What a page says (content/media.ts snapshotMedia), checked here: it comes from a page's process. */
export type MediaReportInput = {
  playing: boolean,
  muted?: boolean,
  title?: string,
  artist?: string,
  artworkUrl?: string,
  canPrev?: boolean,
  canNext?: boolean,
};
/** The tab it's about (the sender's, or the tabs API's). */
export type MediaTab = { id: number, windowId?: number | null, url?: string, title?: string, audible?: boolean, mutedInfo?: { muted?: boolean } };

type Entry = MediaSource & { tabId: number, windowId: number | null, artworkUrl: string, from: 'page' | 'tab' };
/** One source as the `media` push carries it. */
export type MediaPushSource = {
  tabId: number, itemId: string | null, url: string, title: string, subtitle: string, artwork: string | null,
  playing: boolean, muted: boolean, canPrev: boolean, canNext: boolean, updatedAt: number, pausedAt: number | null,
};

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const hostOf = (url: unknown) => { try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** The tabs' sources, in memory (a test's clock as `now`). */
export function createMediaRegistry({ now = () => Date.now() }: { now?: () => number } = {}) {
  const byTab = new Map<number, Entry>();

  function put(tab: MediaTab, input: MediaReportInput, from: Entry['from']): Entry | null {
    const t = now();
    const prev = byTab.get(tab.id);
    const playing = input.playing === true;
    const pausedAt = playing ? null : (prev?.playing ? t : prev?.pausedAt ?? null);
    // (Paused with nothing playing before: nothing to show.)
    if (!playing && pausedAt == null) {
      byTab.delete(tab.id);
      return null;
    }
    const artworkUrl = typeof input.artworkUrl === 'string' && ARTWORK_URL.test(input.artworkUrl) ? input.artworkUrl : '';
    const url = typeof tab.url === 'string' ? tab.url.slice(0, 2048) : prev?.url ?? '';
    const next: Entry = {
      id: `tab:${tab.id}`,
      source: 'tab',
      tabId: tab.id,
      windowId: Number.isInteger(tab.windowId) ? tab.windowId as number : prev?.windowId ?? null,
      title: text(input.title, 140) || prev?.title || text(tab.title, 140) || hostOf(url) || 'Media',
      subtitle: text(input.artist, 100) || (from === 'tab' ? hostOf(url) : ''),
      url,
      artworkUrl,
      artwork: artworkUrl && prev?.artworkUrl === artworkUrl ? prev.artwork ?? null : null,
      playing,
      muted: input.muted === true || tab.mutedInfo?.muted === true,
      canPrev: input.canPrev === true,
      canNext: input.canNext === true,
      updatedAt: t,
      pausedAt,
      from,
    };
    byTab.set(tab.id, next);
    return next;
  }

  /** What the tab's page said. */
  function report(tab: MediaTab, input: MediaReportInput) { return put(tab, input, 'page'); }

  /** Safari's `audible` for a tab: a source of its own only while its page has said nothing. */
  function audible(tab: MediaTab) {
    const prev = byTab.get(tab.id);
    if (prev?.from === 'page') return prev;
    if (!tab.audible && !prev) return null;
    return put(tab, { playing: !!tab.audible, title: tab.title }, 'tab');
  }

  /** A tab muted or not (tabs.onUpdated mutedInfo; Margin's mute): its source says so. */
  function muted(tabId: number, on: boolean) {
    const prev = byTab.get(tabId);
    if (!prev || prev.muted === on) return null;
    const next = { ...prev, muted: on };
    byTab.set(tabId, next);
    return next;
  }

  function remove(tabId: number) {
    const had = byTab.get(tabId) ?? null;
    byTab.delete(tabId);
    return had;
  }

  /** Every source not past its grace (those that are go). */
  function list(): Entry[] {
    const t = now();
    for (const [id, entry] of byTab) if (graceOver(entry, t)) byTab.delete(id);
    return [...byTab.values()];
  }

  const get = (tabId: number) => byTab.get(tabId) ?? null;
  const set = (entry: Entry) => { byTab.set(entry.tabId, entry); };

  function current(activeTabId: number | string | null = null): MediaSource | null {
    return selectBackgroundMedia(list(), { activeTabId, now: now() });
  }

  /** When the next paused source's grace is over (null: none paused). */
  function nextExpiry(): number | null {
    let at: number | null = null;
    for (const e of byTab.values()) if (!e.playing && e.pausedAt != null) at = Math.min(at ?? Infinity, e.pausedAt + PAUSE_GRACE_MS);
    return at;
  }

  return { report, audible, muted, remove, list, get, set, current, nextExpiry };
}

// ---- the artwork ----------------------------------------------------------------------------------

const b64 = (bytes: Uint8Array) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/**
 * A page's artwork as a small PNG data URL (at most `size` px on its longer side), or null: not an address it may
 * be read from, not an image, too big, not there within `timeoutMs`. No cookies, no referrer. Where the background
 * can't draw (no OffscreenCanvas or createImageBitmap), a small enough PNG, JPEG, WebP or GIF as it is.
 */
export async function loadArtwork(url: string, { size = ARTWORK.size, maxBytes = ARTWORK.maxBytes, timeoutMs = ARTWORK.timeoutMs } = {}): Promise<string | null> {
  const g = globalThis as any;
  if (typeof url !== 'string' || !ARTWORK_URL.test(url) || typeof g.fetch !== 'function') return null;
  const abort = typeof g.AbortController === 'function' ? new g.AbortController() : null;
  const timer = setTimeout(() => abort?.abort(), timeoutMs);
  try {
    const res = await g.fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: abort?.signal });
    if (!res?.ok) return null;
    const blob: Blob = await res.blob();
    const type = String(blob.type || res.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(png|jpeg|webp|gif|avif|bmp)$/.test(type) || blob.size > maxBytes) return null;
    if (typeof g.OffscreenCanvas === 'function' && typeof g.createImageBitmap === 'function') {
      const bitmap = await g.createImageBitmap(blob);
      try {
        const scale = Math.min(1, size / Math.max(1, bitmap.width, bitmap.height));
        const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = new g.OffscreenCanvas(w, h);
        const context = canvas.getContext('2d');
        if (!context) return null;
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap, 0, 0, w, h);
        const out: Blob = await canvas.convertToBlob({ type: 'image/png' });
        const data = `data:image/png;base64,${b64(new Uint8Array(await out.arrayBuffer()))}`;
        return data.length <= ARTWORK.maxUrl && ARTWORK_OUT.test(data) ? data : null;
      } finally {
        bitmap.close?.();
      }
    }
    if (!/^image\/(png|jpeg|webp|gif)$/.test(type) || blob.size > ARTWORK.maxUrl * 0.7) return null;
    const data = `data:${type};base64,${b64(new Uint8Array(await blob.arrayBuffer()))}`;
    return ARTWORK_OUT.test(data) ? data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The artwork made so far, by address (the newest `keep`), and each one being made, once. */
export function createArtworkCache({ load = loadArtwork as (url: string) => Promise<string | null>, keep = ARTWORK.keep as number } = {}) {
  const done = new Map<string, string | null>();
  const making = new Map<string, Promise<string | null>>();
  return {
    /** What's made for `url` (null: it couldn't be), undefined: not yet. */
    get(url: string): string | null | undefined {
      if (!done.has(url)) return undefined;
      const v = done.get(url)!;
      done.delete(url);
      done.set(url, v); // (used: the newest)
      return v;
    },
    want(url: string): Promise<string | null> {
      if (done.has(url)) return Promise.resolve(done.get(url)!);
      const had = making.get(url);
      if (had) return had;
      const p = load(url).catch(() => null).then((v) => {
        making.delete(url);
        done.set(url, v);
        while (done.size > keep) done.delete(done.keys().next().value!);
        return v;
      });
      making.set(url, p);
      return p;
    },
    get size() { return done.size; },
  };
}

// ---- the copy's sources, told to Margin.app -----------------------------------------------------------

type Timers = { set: (fn: () => void, ms: number) => unknown, clear: (t: unknown) => void };

/**
 * The sources and their pushes: `push(windowId, msg)` (appLink.push), `itemOf(tabId)` (the Margin.app item a hosted
 * tab shows: background/hosted.ts), `artwork` (the loader: loadArtwork, a test's stand-in).
 */
export function createMediaHub({
  push,
  itemOf = () => null,
  artwork = loadArtwork,
  now = () => Date.now(),
  timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) },
}: {
  push: (windowId: number, msg: { type: 'media', sources: MediaPushSource[] }) => unknown,
  itemOf?: (tabId: number) => string | null,
  artwork?: (url: string) => Promise<string | null>,
  now?: () => number,
  timers?: Timers,
}) {
  const registry = createMediaRegistry({ now });
  const art = createArtworkCache({ load: artwork });
  const told = new Map<number, string>(); // each window's push last sent (its JSON): the same one isn't sent again
  let timer: unknown = null;

  function sourcesOf(windowId: number): MediaPushSource[] {
    return registry.list().filter((e) => e.windowId === windowId)
      .sort((a, b) => Number(b.playing) - Number(a.playing) || b.updatedAt - a.updatedAt)
      .slice(0, MAX_SOURCES)
      .map((e) => ({
        tabId: e.tabId, itemId: itemOf(e.tabId), url: e.url ?? '', title: e.title, subtitle: e.subtitle, artwork: e.artwork ?? null,
        playing: e.playing, muted: e.muted, canPrev: !!e.canPrev, canNext: !!e.canNext, updatedAt: e.updatedAt, pausedAt: e.pausedAt ?? null,
      }));
  }

  function tell(windowId: number | null | undefined) {
    if (!Number.isInteger(windowId)) return;
    const sources = sourcesOf(windowId as number);
    const json = JSON.stringify(sources);
    if (told.get(windowId as number) === json) return;
    if (!sources.length && !told.has(windowId as number)) return; // (never told of any: nothing to take back)
    if (sources.length) told.set(windowId as number, json); else told.delete(windowId as number);
    push(windowId as number, { type: 'media', sources });
  }

  // The next paused source's grace over: it goes, its window told. No timer while nothing is paused.
  function schedule() {
    if (timer != null) { timers.clear(timer); timer = null; }
    const at = registry.nextExpiry();
    if (at == null) return;
    timer = timers.set(() => {
      timer = null;
      const windows = new Set(registry.list().map((e) => e.windowId));
      for (const w of told.keys()) if (!windows.has(w)) tell(w);
      for (const w of windows) tell(w);
      schedule();
    }, Math.max(0, at - now()) + 50);
  }

  function withArtwork(entry: MediaSource & { artworkUrl: string, tabId: number, windowId: number | null } | null) {
    if (!entry?.artworkUrl) return;
    const url = entry.artworkUrl;
    const cached = art.get(url);
    if (cached !== undefined) {
      if (entry.artwork !== cached) registry.set({ ...(entry as Entry), artwork: cached });
      return;
    }
    void art.want(url).then((data) => {
      const latest = registry.get(entry.tabId);
      if (!latest || latest.artworkUrl !== url || latest.artwork === data) return;
      registry.set({ ...latest, artwork: data });
      tell(latest.windowId);
    });
  }

  return {
    /** A page's report (the sender's tab). */
    report(tab: MediaTab, input: MediaReportInput) {
      const before = registry.get(tab.id);
      const entry = registry.report(tab, input);
      withArtwork(entry);
      if (before && before.windowId !== (entry?.windowId ?? before.windowId)) tell(before.windowId);
      tell(entry?.windowId ?? before?.windowId);
      schedule();
      return registry.get(tab.id);
    },
    /** Safari's `audible` changed for a tab (tabs.onUpdated). */
    audible(tab: MediaTab) {
      const before = registry.get(tab.id);
      const entry = registry.audible(tab);
      if (entry === before) return;
      tell(entry?.windowId ?? before?.windowId);
      schedule();
    },
    /** A tab's mute changed (tabs.onUpdated mutedInfo). */
    muted(tabId: number, on: boolean) {
      const entry = registry.muted(tabId, on);
      if (entry) tell(entry.windowId);
    },
    /** A tab closed or its page left: its source goes at once. */
    remove(tabId: number) {
      const had = registry.remove(tabId);
      if (!had) return;
      tell(had.windowId);
      schedule();
    },
    /** Every window with sources told again (the link to Margin.app came back). */
    tellAll() {
      told.clear();
      for (const w of new Set(registry.list().map((e) => e.windowId))) tell(w);
    },
    has: (tabId: number) => registry.get(tabId) != null,
    list: () => registry.list(),
    current: (activeTabId: number | string | null = null) => registry.current(activeTabId),
    /** For the tests: whether the grace timer is set, and how many artworks are kept. */
    get timerSet() { return timer != null; },
    get artworkKept() { return art.size; },
  };
}
