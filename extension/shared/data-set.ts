// Margin's lasting data set (docs/DATA.md; PLAN.md §6 "Where data lives"): what
// Margin.app keeps in its files on the Mac, and the extension keeps a cache of.
// Here: the data set's items from the extension's state (and the state from
// them, to refill the cache), the converter from today's extension storage
// (used the first time the app links), and the queue of changes made while
// the app isn't linked, with their times. The merge itself is
// shared/data-merge.ts. Pure: no browser APIs (the background calls it:
// background/store.ts).
//
// What isn't in the data set: what only the running browser has (tab and
// window ids, which tab is open in which window, each window's space, the
// owner lease of Margin's copies), and what's this device's alone (a site's
// page zoom, the sidebar's scroll, the theme package's cached copy).
import { normalizeState } from '../state/model.ts';
import { fromStorage } from './stored.ts';
import { DATA_FORMAT, liveValues } from './data-merge.ts';
import type { State } from '../../types/margin';

// The collections, and for each the state keys it's made from (a change to
// one of those keys is looked at again: background/store.ts flush). User
// themes are kept in storage under keys of their own (ui/theme-loader.ts) and
// only the converter reads them for now.
export const SOURCES = Object.freeze({
  spaces: ['spaces'],
  pins: ['pins'],
  folders: ['folders'],
  tabs: ['tabs', 'tabSpace', 'keptTabs'],
  archive: ['archive'],
  settings: ['settings'],
  themeSettings: ['settings'],
  siteIcons: ['favicons'],
});
export const COLLECTIONS = Object.freeze([...Object.keys(SOURCES), 'userThemes']);
// Each tracked collection's times in storage.local, a key each (written with
// the state's keys: background/store.ts).
export const metaKey = (collection: string) => `dataMeta:${collection}`;
export const DATA_META_KEYS = Object.freeze(Object.keys(SOURCES).map(metaKey));

const isWeb = (url: string) => /^(https?|file):/i.test(url ?? '');
const finite = (v: unknown, or = 0): number => (Number.isFinite(v) ? v as number : or);

// ---- the items, from the state --------------------------------------------------

/**
 * One collection's items from the state: { id: value }.
 * */
export function collectionFrom(state: State, collection: string): Record<string, any> {
  switch (collection) {
    case 'spaces':
      return Object.fromEntries(state.spaces.map((s, i) => [s.id, { name: s.name ?? '', emoji: s.emoji ?? '', color: s.color ?? '', order: i }]));
    case 'pins':
      return Object.fromEntries(state.pins.map((p, i) => [p.id, { spaceId: p.spaceId, url: p.url, title: p.title ?? '', folderId: p.folderId ?? null, pos: finite(p.pos, i) }]));
    case 'folders':
      return Object.fromEntries((state.folders ?? []).map((f, i) => [f.id, { spaceId: f.spaceId, name: f.name ?? '', open: f.open !== false, pos: finite(f.pos, i) }]));
    case 'tabs': {
      // Margin's tabs, open or not (state/model.ts): an open one by its
      // Margin id, with its space; only web pages (as only they're kept).
      const out: Record<string, ReturnType<typeof tabValue>> = {};
      for (const t of Object.values(state.tabs ?? {})) {
        const spaceId = state.tabSpace?.[t.id];
        if (typeof t.mid !== 'string' || !isWeb(t.url) || typeof spaceId !== 'string') continue;
        out[t.mid] = tabValue(t, spaceId);
      }
      for (const k of Object.values(state.keptTabs ?? {})) out[k.id] = tabValue(k, k.spaceId);
      return out;
    }
    case 'archive':
      return Object.fromEntries(state.archive.map((a) => [a.id, { url: a.url, title: a.title ?? '', spaceId: a.spaceId ?? '', icon: a.favIconUrl ?? '', closedAt: finite(a.closedAt) }]));
    case 'settings':
      return Object.fromEntries(Object.entries(state.settings ?? {}).filter(([key]) => key !== 'themes'));
    case 'themeSettings':
      return { ...(state.settings?.themes ?? {}) };
    case 'siteIcons':
      return Object.fromEntries(Object.entries(state.favicons ?? {}).map(([origin, icon]) => [origin, { data: icon.data, href: icon.href ?? '', at: finite(icon.at) }]));
    default:
      return {};
  }
}
const tabValue = (t: { url: string, title?: string, favIconUrl?: string, order?: number, index?: number, lastActive?: number }, spaceId: string) => ({ url: t.url, title: t.title ?? '', icon: /^(https?|data):/.test(t.favIconUrl ?? '') ? t.favIconUrl : '', spaceId, order: finite(t.order, finite(t.index)), lastUsed: finite(t.lastActive) });

/** Every collection the state has. */
export function itemsFrom(state: State) {
  return Object.fromEntries(Object.keys(SOURCES).map((c) => [c, collectionFrom(state, c)]));
}

/** The user themes in storage.local (`userTheme:<id>`): { id: stored package }. */
export function userThemesFrom(raw: Record<string, any>) {
  return Object.fromEntries(Object.entries(raw ?? {}).filter(([key, v]) => key.startsWith('userTheme:') && v && typeof v === 'object').map(([key, v]) => [key.slice('userTheme:'.length), v]));
}

// ---- the queue of changes (the extension's side, while not linked) ---------------
// For each tracked collection, what each item was when last looked at (a
// short fingerprint) and since when (its `at`), and the items deleted since
// (tombstones, `gone`): { items: { id: [at, fingerprint] }, gone: { id: at } }.
// Made the first time with every item at 0: what the cache had then isn't a
// change of this copy's (the app's data wins over it), so a cache Safari
// wiped and Margin started afresh in never overwrites the app's data with its
// defaults. A change from then on has its time; the queue is every item and
// tombstone with a time after the last one the app took (`since`).
// Tombstones are kept TOMBSTONE_MS, at most TOMBSTONE_CAP per collection.
export const TOMBSTONE_MS = 60 * 24 * 3600_000;
export const TOMBSTONE_CAP = 2000;

// FNV-1a over the value's JSON (its keys in the order the state has them).
export function fingerprint(value: any) {
  const text = JSON.stringify(value) ?? 'undefined';
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// A change's time: now, or just after the item's last time if that isn't
// before now (a change in the same millisecond as the last, or a time from
// Margin.app's clock ahead of this one), so a change always has a newer time
// than what it changed: Margin.app merges by time, and the change is told
// (background/store.ts changedItems).
const later = (now: number, ...times: (number | undefined)[]) => Math.max(now, ...times.filter(Number.isFinite).map((t) => (t as number) + 1)); // (finite: numbers)
/**
 * A collection's meta after looking at its items now: unchanged (the same
 * object) if nothing changed, else new times for the items that changed or
 * appeared and tombstones for the ones gone. `meta` null: made at 0.
 * */
export function track(meta: any, items: Record<string, any>, now: number): { items: Record<string, [number, string]>, gone: Record<string, number> } {
  const fresh = !meta || typeof meta !== 'object' || typeof meta.items !== 'object';
  const before = fresh ? {} : meta.items;
  const gone: Record<string, number> = fresh ? {} : { ...meta.gone };
  const next: Record<string, [number, string]> = {};
  let changed = fresh;
  for (const [id, value] of Object.entries(items)) {
    const fp = fingerprint(value);
    const had = before[id];
    if (had && had[1] === fp) next[id] = had;
    else {
      next[id] = [fresh ? 0 : later(now, had?.[0], gone[id]), fp];
      changed = true;
    }
    if (id in gone) {
      delete gone[id];
      changed = true;
    }
  }
  for (const id of Object.keys(before)) {
    if (id in items) continue;
    gone[id] = later(now, before[id]?.[0]);
    changed = true;
  }
  // Old tombstones go, and the oldest beyond the cap.
  const dated = Object.entries(gone).sort((a, b) => b[1] - a[1]);
  const keep = dated.filter(([, at], i) => now - at <= TOMBSTONE_MS && i < TOMBSTONE_CAP);
  if (keep.length !== dated.length) changed = true;
  if (!changed) return meta;
  return { items: next, gone: Object.fromEntries(keep) };
}

/**
 * The queue: every change after `since` (the last change the app took; 0:
 * every change ever queued), oldest first, with the values the state has now
 * (a later change to an item replaces an earlier one: one entry per item).
 * @param metas collection → meta (track's)
 * @param items collection → items (collectionFrom's)
 */
export function pendingChanges(metas: Record<string, ReturnType<typeof track> | null | undefined>, items: Record<string, Record<string, any>>, since: number = 0) {
  const out: ({ collection: string, id: string, updatedAt: number, value: any } | { collection: string, id: string, updatedAt: number, deleted: true })[] = [];
  for (const collection of Object.keys(SOURCES)) {
    const meta = metas?.[collection];
    if (!meta) continue;
    for (const [id, [at]] of Object.entries(meta.items ?? {})) {
      if (at > since && id in (items[collection] ?? {})) out.push({ collection, id, updatedAt: at, value: items[collection][id] });
    }
    for (const [id, at] of Object.entries(meta.gone ?? {})) if (at > since) out.push({ collection, id, updatedAt: at, deleted: true });
  }
  return out.sort((a, b) => a.updatedAt - b.updatedAt || a.collection.localeCompare(b.collection) || a.id.localeCompare(b.id));
}

// ---- the whole data set ------------------------------------------------------------

/**
 * The data set from the state: every item with its time (the meta's; `now`
 * for one the meta doesn't have), and the meta's tombstones. User themes from
 * storage (`userThemes`: userThemesFrom), at `now`.
 */
export function dataSetFrom(state: State, { metas = {}, now = 0, userThemes = {} }: { metas?: Record<string, any>, now?: number, userThemes?: Record<string, any> } = {}) {
  const items: Record<string, any> = {};
  for (const collection of Object.keys(SOURCES)) {
    const meta = metas[collection];
    const list: Record<string, any> = {};
    for (const [id, value] of Object.entries(collectionFrom(state, collection))) list[id] = { updatedAt: meta?.items?.[id]?.[0] ?? now, value };
    for (const [id, at] of Object.entries(meta?.gone ?? {})) if (!(id in list)) list[id] = { updatedAt: at, deleted: true };
    items[collection] = list;
  }
  items.userThemes = Object.fromEntries(Object.entries(userThemes).map(([id, value]) => [id, { updatedAt: now, value }]));
  return { format: DATA_FORMAT, items };
}

/**
 * The converter, for the first time the app links: today's extension storage
 * (all of storage.local, as `get(null)` returns it) as a data set. Times from
 * the queue's meta where storage has it, else `now`.
 */
export function dataSetFromStorage(raw: Record<string, any>, { now = 0 }: { now?: number } = {}) {
  const state = normalizeState(fromStorage(raw ?? {}));
  const metas = Object.fromEntries(Object.keys(SOURCES).map((c) => [c, raw?.[metaKey(c)] ?? null]).filter(([, m]) => m));
  return dataSetFrom(state, { metas, now, userThemes: userThemesFrom(raw) });
}

/**
 * The extension's state refilled from a data set (the app's, merged with the
 * queue: step 3), keeping what only the running browser has: its open tabs
 * (each keeps its browser tab; its space and place come from its Margin tab,
 * if the set has it), each window's space, the owner. Margin tabs the set has
 * that aren't open are kept tabs. A collection the set doesn't have at all
 * stays as the state has it.
 * */
export function stateFromDataSet(state: State, set: { items?: Record<string, Record<string, any>> }): State {
  const has = (c: string) => !!set?.items?.[c] && typeof set.items[c] === 'object';
  const next = { ...state };
  if (has('spaces')) {
    const spaces = Object.entries(liveValues(set, 'spaces')).sort((a, b) => finite(a[1].order) - finite(b[1].order)).map(([id, s]) => ({ id, name: s.name, emoji: s.emoji, color: s.color }));
    if (spaces.length) next.spaces = spaces;
  }
  if (has('pins')) next.pins = Object.entries(liveValues(set, 'pins')).map(([id, p]) => ({ id, spaceId: p.spaceId, url: p.url, title: p.title, ...(p.folderId ? { folderId: p.folderId } : {}), pos: finite(p.pos) }));
  if (has('folders')) next.folders = Object.entries(liveValues(set, 'folders')).map(([id, f]) => ({ id, spaceId: f.spaceId, name: f.name, open: f.open !== false, pos: finite(f.pos) }));
  if (has('archive')) next.archive = Object.entries(liveValues(set, 'archive')).sort((a, b) => finite(b[1].closedAt) - finite(a[1].closedAt)).map(([id, a]) => ({ id, url: a.url, title: a.title, spaceId: a.spaceId, favIconUrl: a.icon ?? '', closedAt: finite(a.closedAt) }));
  if (has('settings') || has('themeSettings')) {
    next.settings = { ...state.settings, ...(has('settings') ? liveValues(set, 'settings') : {}), ...(has('themeSettings') ? { themes: { ...state.settings.themes, ...liveValues(set, 'themeSettings') } } : {}) };
  }
  if (has('siteIcons')) next.favicons = liveValues(set, 'siteIcons');
  if (has('tabs')) {
    const tabs = liveValues(set, 'tabs');
    const openIds = new Set<any>();
    const records = { ...state.tabs };
    const tabSpace = { ...state.tabSpace };
    for (const r of Object.values(state.tabs)) {
      const t = typeof r.mid === 'string' ? tabs[r.mid] : null;
      if (!t) continue;
      openIds.add(r.mid);
      if (next.spaces.some((s) => s.id === t.spaceId)) tabSpace[r.id] = t.spaceId;
      if (Number.isFinite(t.order) && t.order !== r.order) records[r.id] = { ...r, order: t.order };
    }
    const keptTabs: Record<string, any> = {};
    for (const [id, t] of Object.entries(tabs)) {
      if (openIds.has(id) || !next.spaces.some((s) => s.id === t.spaceId)) continue;
      const had = state.keptTabs?.[id];
      keptTabs[id] = { ...(had ?? { keptAt: finite(t.lastUsed), why: 'app' }), id, url: t.url, title: t.title ?? '', favIconUrl: t.icon ?? '', spaceId: t.spaceId, order: finite(t.order), lastActive: finite(t.lastUsed) };
    }
    Object.assign(next, { tabs: records, tabSpace, keptTabs });
  }
  // A tab in a space the set took away (one open before the set came in, in
  // the copy's default space): it joins its window's space, or the first.
  if (next.spaces !== state.spaces) {
    const known = (id: string) => next.spaces.some((s) => s.id === id);
    const home = (tabId: string) => {
      const id = next.activeSpaceByWindow?.[next.tabs?.[tabId as unknown as number]?.windowId as number];
      return known(id) ? id : next.spaces[0].id;
    };
    const stray = Object.entries(next.tabSpace ?? {}).filter(([, sid]) => !known(sid));
    if (stray.length) next.tabSpace = { ...next.tabSpace, ...Object.fromEntries(stray.map(([tabId]) => [tabId, home(tabId)])) };
  }
  return next;
}
