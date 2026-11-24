// Margin.app's library (docs/MARGIN-APP.md, phase 1; DECISIONS.md "Margin.app owns the spaces"): the person's
// spaces, pins, folders and Margin tabs ("items"), owned by the app in one data set of its own
// (app/platforms/macos/shell/Library.swift, data/app/), not by each profile's copy of the extension. An item is a
// web page (shown in a browser's profile), a Mac app (its bundle id) or one of Margin's own pages (Settings, drawn in
// Margin's window itself: `margin://settings`): its `target`.
//
// The edit rules are state/model.ts's, run here unchanged: the library's values become a model State (its items as
// kept tabs: a Margin tab with no browser tab, which is what an item is to the app), the model's function runs, and
// the values that changed come back as changes for the app to merge into its set (shared/data-merge.ts's rules,
// DataSet.swift). The app ran this file in JavaScriptCore until docs/CORE-REFACTOR.md step 4's switch; since, it
// runs margin-core's port (app/shared/core/src/library), and this file is the shared vectors' reference
// (tests/fixtures/library, recorded from it: scripts/build.ts buildLibraryScript); the unit tests import it as it is
// (tests/library.test.ts). Pure: no clock (the app gives `now`),
// no randomness the app doesn't give (`ids`), no browser API.
//
// What needs a browser or an app (showing a tab, opening an address, closing a page) isn't done here: each such
// action returns a request (`requests`) for the hosting phase (Library.swift's delegate), with the item and its
// target resolved.
import * as M from '../../../extension/state/model.ts';
import { frontItemOf } from '../../../extension/shared/front-item.ts';
import { matchAirTrafficRule } from '../../../extension/shared/air-traffic.ts';
import { fingerprint } from '../../../extension/shared/data-set.ts';
import type { State } from '../../../types/margin';

/** The library's collections (the data set's), and `imports`: the import's marker. */
export const COLLECTIONS = Object.freeze(['spaces', 'pins', 'favorites', 'airTraffic', 'splits', 'folders', 'tabs', 'archive', 'windows', 'imports']);
export const FORMAT = 1;

export type WebTarget = { kind: 'web', browser: string, profile: string | null };
export type AppTarget = { kind: 'app', bundleId: string, name: string };
/** One of Margin's own pages (MARGIN_PAGES), drawn by Margin's window in its page area: nothing hosted for it. */
export type MarginTarget = { kind: 'margin', page: string };
export type Target = WebTarget | AppTarget | MarginTarget;
/** collection → id → value (the data set's live values) */
export type Values = Record<string, Record<string, any>>;
export type Change = { collection: string, id: string, value: any } | { collection: string, id: string, deleted: true };
export type Request = { type: string, windowId?: string | number | null, item?: string | null, url?: string, target?: Target | null, [key: string]: any };
export type Env = { now: number, ids?: string[] };
export type Outcome = { ok: boolean, result?: any, error?: string, changes: Change[], requests: Request[] };

const BROWSERS = new Set(['safari', 'chrome', 'edge']);
/** Margin's own pages, and the title each item of one has. */
export const MARGIN_PAGES: Readonly<Record<string, string>> = Object.freeze({ settings: 'Settings' });
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;
const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : '');
const finite = (v: unknown, or = 0): number => (Number.isFinite(v) ? v as number : or);
const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o: unknown, key: string) => isObject(o) && Object.hasOwn(o, key);

// ---- targets -------------------------------------------------------------------------------------

/** A target as given (stored, or an action's), checked; null if it isn't one. */
export function targetOf(raw: unknown): Target | null {
  if (!isObject(raw)) return null;
  if (raw.kind === 'app') {
    const bundleId = str(raw.bundleId, 255);
    return BUNDLE_ID.test(bundleId) ? { kind: 'app', bundleId, name: str(raw.name, 100) || bundleId } : null;
  }
  if (raw.kind === 'margin') return typeof raw.page === 'string' && Object.hasOwn(MARGIN_PAGES, raw.page) ? { kind: 'margin', page: raw.page } : null;
  if (raw.kind === 'web') {
    const browser = BROWSERS.has(raw.browser) ? raw.browser : 'safari';
    return { kind: 'web', browser, profile: typeof raw.profile === 'string' && raw.profile ? raw.profile.slice(0, 256) : null };
  }
  return null;
}
const webTarget = (browser: string, profile: string | null): WebTarget => ({ kind: 'web', browser, profile });
/** An app item's address: what the model matches items and pins by (never a web page: never archived). */
export const appUrl = (bundleId: string) => `app://${bundleId}`;
/** A Margin page's address (never a web page's: never archived, never updated by a browser). */
export const marginUrl = (page: string) => `margin://${page}`;
/** An item's address and title for its target: an app's and a Margin page's are their own, a web page's as given. */
const placeOf = (target: Target, url: unknown, title: unknown) => {
  if (target.kind === 'app') return { url: appUrl(target.bundleId), title: str(title) || target.name };
  if (target.kind === 'margin') return { url: marginUrl(target.page), title: MARGIN_PAGES[target.page] };
  const u = str(url);
  return { url: u, title: str(title) || u };
};

// ---- the model's state from the values, and back ---------------------------------------------------
// Items are the model's kept tabs (keyed by their own `t-` ids); open tabs are the hosting's, never here. Each
// space, pin, item and archive entry carries its extras (a space's browser and profile, the others' target) through
// the model's functions, which spread what they change; the few that make a new object get them back here.

type LibSpace = State['spaces'][number] & { browser?: string, profile?: string | null };
type LibState = Omit<State, 'spaces'> & { spaces: LibSpace[] };

const sorted = (list: Record<string, any>) => Object.entries(isObject(list) ? list : {}).filter(([, v]) => isObject(v));

export function stateOf(values: Values): LibState {
  const base = M.defaultState();
  const spaces = sorted(values?.spaces).sort((a, b) => finite(a[1].order) - finite(b[1].order) || a[0].localeCompare(b[0]))
    .map(([id, s]) => ({ id, name: str(s.name, 200), emoji: str(s.emoji, 16), color: str(s.color, 32), browser: BROWSERS.has(s.browser) ? s.browser : 'safari', profile: typeof s.profile === 'string' && s.profile ? s.profile : null, ...(M.themeIdOk(s.theme) ? { theme: s.theme } : {}) }));
  const pins = sorted(values?.pins).filter(([, p]) => typeof p.spaceId === 'string' && typeof p.url === 'string')
    .map(([id, p]) => ({ id, spaceId: p.spaceId, url: p.url, title: str(p.title), ...(typeof p.customTitle === 'string' && p.customTitle ? { customTitle: str(p.customTitle, 200) } : {}), ...(typeof p.folderId === 'string' && p.folderId ? { folderId: p.folderId } : {}), pos: finite(p.pos), target: targetOf(p.target) ?? webTarget('safari', null) }));
  const favorites = sorted(values?.favorites).filter(([, f]) => typeof f.url === 'string')
    .map(([id, f]) => ({ id, scope: typeof f.scope === 'string' && f.scope ? f.scope : 'global', url: f.url, title: str(f.title), ...(typeof f.customTitle === 'string' && f.customTitle ? { customTitle: str(f.customTitle, 200) } : {}), pos: finite(f.pos), target: targetOf(f.target) ?? webTarget('safari', null) }));
  const airTraffic = sorted(values?.airTraffic).filter(([, r]) => typeof r.pattern === 'string' && typeof r.spaceId === 'string')
    .sort((a, b) => finite(a[1].order) - finite(b[1].order) || a[0].localeCompare(b[0]))
    .map(([id, r], i) => ({ id, pattern: str(r.pattern, 200), spaceId: r.spaceId, enabled: r.enabled !== false, order: finite(r.order, i) }));
  // A split's panes as stored: item ids (strings), each once, at most MAX_SPLIT_PANES, each with the ratio stored at its
  // own place (one per pane: the ratios of those left kept relative to each other); fewer than 2: no split. (Panes whose
  // item is gone leave in perform: state/model.ts settleSplits.)
  const splits = sorted(values?.splits).filter(([, g]) => typeof g.spaceId === 'string' && Array.isArray(g.panes)).flatMap(([id, g]) => {
    const given: unknown[] = g.panes;
    const at = given.flatMap((x, i) => (typeof x === 'string' && x && given.indexOf(x) === i ? [i] : [])).slice(0, M.MAX_SPLIT_PANES);
    if (at.length < 2) return [];
    const ratios = Array.isArray(g.ratios) && g.ratios.length === given.length ? at.map((i) => { const r = finite(g.ratios[i], 1); return r > 0 ? r : 1; }) : at.map(() => 1);
    const sum = ratios.reduce((a, b) => a + b, 0);
    return [{
      id, spaceId: g.spaceId, axis: g.axis === 'vertical' ? 'vertical' as const : 'horizontal' as const,
      panes: at.map((i) => given[i] as string),
      ratios: ratios.map((r) => Math.round((r / sum) * 10000) / 10000),
      ...(g.pinned ? { pinned: true } : {}),
      ...(typeof g.folderId === 'string' && g.folderId ? { folderId: g.folderId } : {}),
      ...(Number.isFinite(g.pos) ? { pos: g.pos } : {}),
    }];
  });
  const folders = sorted(values?.folders).filter(([, f]) => typeof f.spaceId === 'string')
    .map(([id, f]) => ({ id, spaceId: f.spaceId, name: str(f.name, 200), open: f.open !== false, pos: finite(f.pos), ...(typeof f.parentId === 'string' && f.parentId ? { parentId: f.parentId } : {}) }));
  const archive = sorted(values?.archive).filter(([, a]) => typeof a.url === 'string')
    .sort((a, b) => finite(b[1].closedAt) - finite(a[1].closedAt) || a[0].localeCompare(b[0]))
    .map(([id, a]) => ({ id, url: a.url, title: str(a.title), spaceId: str(a.spaceId, 256), favIconUrl: str(a.icon, 100_000), closedAt: finite(a.closedAt), target: targetOf(a.target) ?? webTarget('safari', null) }));
  const keptTabs: Record<string, any> = {};
  for (const [id, t] of sorted(values?.tabs)) {
    if (!M.isTabId(id) || typeof t.url !== 'string' || typeof t.spaceId !== 'string') continue;
    keptTabs[id] = {
      id, url: t.url, title: str(t.title), favIconUrl: str(t.icon, 100_000), spaceId: t.spaceId, order: finite(t.order),
      lastActive: finite(t.lastUsed), wasActive: t.selected === true, keptAt: finite(t.lastUsed), why: 'library',
      target: targetOf(t.target) ?? webTarget('safari', null),
      ...(typeof t.pinnedBy === 'string' && t.pinnedBy ? { pinnedBy: t.pinnedBy } : {}),
      ...(typeof t.favoriteId === 'string' && t.favoriteId ? { favoriteId: t.favoriteId } : {}),
      ...(typeof t.customTitle === 'string' && t.customTitle ? { customTitle: str(t.customTitle, 200) } : {}),
      ...(isObject(t.imported) ? { imported: { browser: str(t.imported.browser, 32), profile: str(t.imported.profile, 256), id: str(t.imported.id, 256) } } : {}),
    };
  }
  const activeSpaceByWindow: Record<string, string> = {};
  for (const [w, v] of sorted(values?.windows)) if (typeof v.spaceId === 'string') activeSpaceByWindow[w] = v.spaceId;
  return { ...base, spaces, pins, favorites, airTraffic, splits, folders, archive, keptTabs, activeSpaceByWindow, tabs: {}, tabSpace: {}, awayByWindow: {}, favicons: {} } as unknown as LibState;
}

export function valuesOf(state: LibState, imports: Record<string, any> = {}): Values {
  const out: Values = { spaces: {}, pins: {}, favorites: {}, airTraffic: {}, splits: {}, folders: {}, tabs: {}, archive: {}, windows: {}, imports: { ...imports } };
  state.spaces.forEach((s, i) => { out.spaces[s.id] = { name: s.name ?? '', emoji: s.emoji ?? '', color: s.color ?? '', order: i, browser: s.browser ?? 'safari', profile: s.profile ?? null, ...(M.themeIdOk(s.theme) ? { theme: s.theme } : {}) }; });
  state.pins.forEach((p: any, i) => { out.pins[p.id] = { spaceId: p.spaceId, url: p.url, title: p.title ?? '', ...(p.customTitle ? { customTitle: p.customTitle } : {}), folderId: p.folderId ?? null, pos: finite(p.pos, i), target: targetOf(p.target) ?? webTarget('safari', null) }; });
  (state.favorites ?? []).forEach((f: any, i) => { out.favorites[f.id] = { scope: f.scope || 'global', url: f.url, title: f.title ?? '', ...(f.customTitle ? { customTitle: f.customTitle } : {}), pos: finite(f.pos, i), target: targetOf(f.target) ?? webTarget('safari', null) }; });
  (state.airTraffic ?? []).forEach((r: any, i) => { out.airTraffic[r.id] = { pattern: r.pattern, spaceId: r.spaceId, enabled: r.enabled !== false, order: finite(r.order, i) }; });
  (state.splits ?? []).forEach((g: any) => { out.splits[g.id] = { spaceId: g.spaceId, axis: g.axis === 'vertical' ? 'vertical' : 'horizontal', panes: g.panes, ratios: g.ratios, ...(g.pinned ? { pinned: true } : {}), ...(g.folderId ? { folderId: g.folderId } : {}), ...(Number.isFinite(g.pos) ? { pos: g.pos } : {}) }; });
  (state.folders ?? []).forEach((f, i) => { out.folders[f.id] = { spaceId: f.spaceId, name: f.name ?? '', open: f.open !== false, pos: finite(f.pos, i), ...(f.parentId ? { parentId: f.parentId } : {}) }; });
  for (const k of Object.values(state.keptTabs ?? {}) as any[]) {
    out.tabs[k.id] = {
      url: k.url, title: k.title ?? '', icon: k.favIconUrl ?? '', spaceId: k.spaceId, order: finite(k.order), lastUsed: finite(k.lastActive), selected: !!k.wasActive,
      target: targetOf(k.target) ?? webTarget('safari', null),
      ...(k.pinnedBy ? { pinnedBy: k.pinnedBy } : {}),
      ...(k.favoriteId ? { favoriteId: k.favoriteId } : {}),
      ...(k.customTitle ? { customTitle: k.customTitle } : {}),
      ...(k.imported ? { imported: k.imported } : {}),
    };
  }
  for (const a of state.archive as any[]) out.archive[a.id] = { url: a.url, title: a.title ?? '', spaceId: a.spaceId ?? '', icon: a.favIconUrl ?? '', closedAt: finite(a.closedAt), target: targetOf(a.target) ?? webTarget('safari', null) };
  for (const [w, spaceId] of Object.entries(state.activeSpaceByWindow ?? {})) out.windows[w] = { spaceId };
  return out;
}

/** The changes from `before` to `after` (values each), by collection then id. */
export function diff(before: Values, after: Values): Change[] {
  const out: Change[] = [];
  for (const collection of COLLECTIONS) {
    const a = before?.[collection] ?? {};
    const b = after?.[collection] ?? {};
    for (const id of Object.keys(b).sort()) if (JSON.stringify(a[id]) !== JSON.stringify(b[id])) out.push({ collection, id, value: b[id] });
    for (const id of Object.keys(a).sort()) if (!(id in b)) out.push({ collection, id, deleted: true });
  }
  return out;
}

// ---- ids ----------------------------------------------------------------------------------------------
// The app gives a few random letters per action (`env.ids`, from SecRandom); a test gives its own. With none
// left, Math.random (JavaScriptCore has no crypto).
function idMaker(env: Env) {
  const given = [...(env?.ids ?? [])];
  const letters = () => {
    const next = given.shift();
    if (typeof next === 'string' && /^[A-Za-z0-9]{4,30}$/.test(next)) return next;
    return Array.from({ length: 10 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
  };
  return { tab: () => `t-${letters()}`, other: (prefix: string) => `${prefix}-${letters()}` };
}

// ---- the actions ----------------------------------------------------------------------------------------
// The same names (and payloads) the UI sends its copy today (ui/actions.ts, background/handlers.ts), where
// they mean something to the library, and the hosting's own (addItem, updateItem, itemClosed, removeItem,
// setSpaceProfile, forgetWindow). A tab id here is always an item's (a string).

const win = (p: any) => (typeof p?.windowId === 'number' || (typeof p?.windowId === 'string' && p.windowId) ? String(p.windowId) : null);
const hasSpace = (s: LibState, id: unknown) => typeof id === 'string' && s.spaces.some((sp) => sp.id === id);
const spaceOf = (s: LibState, id: string) => s.spaces.find((sp) => sp.id === id) ?? null;
/** The space a window shows (null: none yet, or no spaces). */
const windowSpace = (s: LibState, w: string | null) => (w != null && hasSpace(s, s.activeSpaceByWindow[w as any]) ? s.activeSpaceByWindow[w as any] : s.spaces[0]?.id ?? null);
const itemsOf = (s: LibState, spaceId: string) => Object.values(s.keptTabs ?? {}).filter((k) => k.spaceId === spaceId);
/** A space's item used last (the selected one breaks a tie). */
const frontOf = (s: LibState, spaceId: string, except: string | null = null) => frontItemOf(Object.values(s.keptTabs ?? {}), spaceId, except);
const lastPlace = (s: LibState) => Math.max(-1, ...Object.values(s.keptTabs ?? {}).map((k) => finite(k.order)));
const targetOfItem = (k: any): Target => targetOf(k?.target) ?? webTarget('safari', null);
/** The target a new web item of this space gets: the space's browser and profile. */
const spaceTarget = (s: LibState, spaceId: string): WebTarget => { const sp = spaceOf(s, spaceId); return webTarget(sp?.browser ?? 'safari', sp?.profile ?? null); };

// The item `id` used now, selected in its space (the others not), and the window showing its space.
function used(s: LibState, id: string, w: string | null, now: number): LibState {
  const k = s.keptTabs[id];
  if (!k) return s;
  const keptTabs = { ...s.keptTabs };
  for (const other of itemsOf(s, k.spaceId)) if (other.id !== id && other.wasActive) keptTabs[other.id] = { ...other, wasActive: false };
  keptTabs[id] = { ...k, lastActive: now, wasActive: true };
  const next = { ...s, keptTabs };
  return w != null ? M.setActiveSpace(next, w as any, k.spaceId) as LibState : next;
}

// A new item, in the list's newest place.
// The item `k` pinned as `pinId` (pinTab, createFolder with an item): the pin takes its address, title, given name and
// target; the item stays, bound to it (`pinnedBy`). Unchanged when the space has a pin at that address already.
function pinOfItem(s: LibState, k: any, pinId: string, folderId: string | null, beforeId: string | null): LibState {
  let next = M.addPin(s, { id: pinId, spaceId: k.spaceId, url: k.url, title: k.title, folderId, beforeId }) as LibState;
  if (next === s) return s;
  if (k.customTitle) next = M.renamePin(next, pinId, k.customTitle) as LibState;
  next = { ...next, pins: next.pins.map((pin) => (pin.id === pinId ? { ...pin, target: targetOfItem(k) } : pin)) } as LibState;
  return M.bindTabToPin(next, k.id, pinId) as LibState;
}

function addItem(s: LibState, id: string, { spaceId, url, title, icon, target, now, pinnedBy, favoriteId }: { spaceId: string, url: string, title: string, icon: string, target: Target, now: number, pinnedBy?: string | null, favoriteId?: string | null }): LibState {
  const item = { id, url, title, favIconUrl: icon, spaceId, order: lastPlace(s) + 1, lastActive: now, wasActive: false, keptAt: now, why: 'library', target, ...(pinnedBy ? { pinnedBy } : {}), ...(favoriteId ? { favoriteId } : {}) };
  return { ...s, keptTabs: { ...s.keptTabs, [id]: item } } as LibState;
}

// An item to the archive (a web page's), or forgotten (an app's, or a page that isn't http): the model's archiveKept,
// with the entry's target.
function archiveItem(s: LibState, id: string, archiveId: string, now: number): LibState {
  const k: any = s.keptTabs[id];
  if (!k) return s;
  const next = M.archiveKept(s, id, { id: archiveId, closedAt: now }) as LibState;
  if (!next.archive.some((a) => a.id === archiveId)) return next;
  return { ...next, archive: next.archive.map((a) => (a.id === archiveId ? { ...a, target: targetOfItem(k) } : a)) } as LibState;
}

type Ctx = { s: LibState, p: any, now: number, ids: ReturnType<typeof idMaker>, requests: Request[] };
type Handler = (ctx: Ctx) => { s: LibState, result?: any, error?: string };
const fail = (s: LibState, error: string) => ({ s, error });

// ---- split view's rules (docs/PEEK-SPLIT.md §4) ----
// Why `adding` can't join a split of `panes` in `spaceId` (null: it can): 4 panes at most, one space, never Margin's own
// pages, a Mac app once (its one window is one pane).
function splitRefusal(s: LibState, panes: string[], adding: string[], spaceId: string): string | null {
  const all = [...panes, ...adding.filter((id) => !panes.includes(id))];
  if (all.length > M.MAX_SPLIT_PANES) return `a split has ${M.MAX_SPLIT_PANES} panes at most`;
  const apps = new Set<string>();
  for (const id of all) {
    const k = s.keptTabs[id];
    if (!k) return 'no such item';
    if (k.spaceId !== spaceId) return 'a split\'s panes are of one space';
    const t = targetOfItem(k);
    if (t.kind === 'margin') return 'Margin\'s own pages aren\'t split';
    if (t.kind === 'app') {
      if (apps.has(t.bundleId)) return `${t.name} is in this split already`;
      apps.add(t.bundleId);
    }
  }
  return null;
}
// The hosting's request to show a split: its panes (in order), the one focused (null: the window's own choice).
function splitShown(s: LibState, group: NonNullable<LibState['splits']>[number], focus: string | null, p: any): Request {
  return {
    type: 'showSplit', windowId: p?.windowId ?? null, splitId: group.id, item: focus, axis: group.axis, ratios: group.ratios,
    panes: group.panes.filter((id) => !!s.keptTabs[id]).map((itemId) => ({ item: itemId, url: s.keptTabs[itemId]?.url ?? '', target: targetOfItem(s.keptTabs[itemId]) })),
  };
}
// The item shown after `id` closes when it's a split's pane: the split's next pane (the one after it, else before it),
// so the split goes on with the rest (or the one left, alone); null: not a pane.
function splitNext(s: LibState, id: string): string | null {
  const group = M.splitForItem(s, id);
  if (!group) return null;
  const i = group.panes.indexOf(id);
  const rest = group.panes.filter((x) => x !== id && !!s.keptTabs[x]);
  return rest[Math.min(i, rest.length - 1)] ?? null;
}

const ACTIONS: Record<string, Handler> = {
  // ---- spaces ----
  setSpace({ s, p, requests }) {
    const w = win(p);
    if (w == null || !hasSpace(s, p.spaceId)) return fail(s, 'no such window or space');
    const next = M.setActiveSpace(s, w as any, p.spaceId) as LibState;
    const front = frontOf(next, p.spaceId);
    requests.push({ type: 'setSpace', windowId: p.windowId, spaceId: p.spaceId, item: front?.id ?? null, ...(front ? { url: front.url, target: targetOfItem(front) } : {}) });
    return { s: next, result: { spaceId: p.spaceId, shown: front?.id ?? null } };
  },
  createSpace({ s, p, ids }) {
    const id = ids.other('sp');
    const w = win(p);
    // Its browser and profile: as asked, else those of the space the window shows. Its theme: as asked, else that
    // space's (none there: none, the profile's, as that space).
    const from = spaceOf(s, windowSpace(s, w) ?? '');
    const browser = BROWSERS.has(p?.browser) ? p.browser : from?.browser ?? 'safari';
    const profile = own(p, 'profile') ? (typeof p.profile === 'string' && p.profile ? p.profile : null) : from?.profile ?? null;
    const theme = M.themeIdOk(p?.theme) ? p.theme : from?.theme ?? null;
    let next = M.createSpace(s, { id, name: p?.name, emoji: p?.emoji, color: p?.color, theme }) as LibState;
    next = { ...next, spaces: next.spaces.map((sp) => (sp.id === id ? { ...sp, browser, profile } : sp)) };
    if (w != null) next = M.setActiveSpace(next, w as any, id) as LibState;
    return { s: next, result: { spaceId: id } };
  },
  renameSpace({ s, p }) {
    if (!hasSpace(s, p?.spaceId)) return fail(s, 'no such space');
    let next = M.updateSpace(s, p.spaceId, { name: p.name, emoji: p.emoji, color: p.color, ...(own(p, 'theme') ? { theme: p.theme } : {}) }) as LibState;
    if (own(p, 'profile')) next = ACTIONS.setSpaceProfile({ s: next, p, now: 0, ids: null as any, requests: [] }).s;
    return { s: next };
  },
  // A space's theme: a theme's id, or null (none: the profile's settings.theme).
  setSpaceTheme({ s, p }) {
    if (!hasSpace(s, p?.spaceId)) return fail(s, 'no such space');
    if (p.theme !== null && !M.themeIdOk(p.theme)) return fail(s, 'not a theme id');
    return { s: M.updateSpace(s, p.spaceId, { theme: p.theme }) as LibState };
  },
  // A space's browser profile (null: the browser's default), for its new web items.
  setSpaceProfile({ s, p }) {
    if (!hasSpace(s, p?.spaceId)) return fail(s, 'no such space');
    const profile = typeof p.profile === 'string' && p.profile ? p.profile.slice(0, 256) : null;
    return { s: { ...s, spaces: s.spaces.map((sp) => (sp.id === p.spaceId ? { ...sp, profile, ...(BROWSERS.has(p.browser) ? { browser: p.browser } : {}) } : sp)) } };
  },
  // Its items, pins, folders, archive entries and windows go to the first space left (the model's cascade).
  deleteSpace({ s, p }) {
    if (!hasSpace(s, p?.spaceId)) return fail(s, 'no such space');
    if (s.spaces.length < 2) return fail(s, 'the last space');
    return { s: M.deleteSpace(s, p.spaceId) as LibState, result: { into: s.spaces.find((sp) => sp.id !== p.spaceId)!.id } };
  },
  orderSpaces({ s, p }) {
    if (!Array.isArray(p?.spaceIds)) return fail(s, 'no order');
    return { s: M.orderSpaces(s, p.spaceIds.filter((id: unknown) => typeof id === 'string')) as LibState };
  },
  // ---- items ----
  // The page or app asked for opened in the window's space (or `spaceId`): a new item, shown (the hosting opens it).
  newTab({ s, p, now, ids, requests }) {
    const w = win(p);
    const matched = !hasSpace(s, p?.spaceId) && typeof p?.url === 'string'
      ? matchAirTrafficRule(p.url, s.airTraffic, new Set(s.spaces.map((sp) => sp.id)))
      : null;
    const spaceId = hasSpace(s, p?.spaceId) ? p.spaceId : matched?.spaceId ?? windowSpace(s, w);
    if (!spaceId) return fail(s, 'no space');
    const target = targetOf(p?.target) ?? spaceTarget(s, spaceId);
    const { url, title } = placeOf(target, p?.url, target.kind === 'app' ? '' : p?.title);
    if (!url) return fail(s, 'no address'); // (⌘T with nothing typed is the palette: the UI's own)
    const id = ids.tab();
    let next = addItem(s, id, { spaceId, url, title, icon: '', target, now });
    next = used(next, id, w, now);
    requests.push({ type: 'newTab', windowId: p?.windowId ?? null, item: id, url, target, spaceId });
    return { s: next, result: { tabId: id } };
  },
  // An item the hosting opened itself (a link Safari opened in a new tab, an app picked in the palette): added, not
  // shown by the library (`front`: used now).
  addItem({ s, p, now, ids }) {
    const w = win(p);
    const spaceId = hasSpace(s, p?.spaceId) ? p.spaceId : windowSpace(s, w);
    if (!spaceId) return fail(s, 'no space');
    const target = targetOf(p?.target) ?? spaceTarget(s, spaceId);
    const { url, title } = placeOf(target, p?.url, p?.title);
    if (!url) return fail(s, 'no address');
    const id = ids.tab();
    const pinnedBy = typeof p?.pinnedBy === 'string' && s.pins.some((x) => x.id === p.pinnedBy && x.spaceId === spaceId) ? p.pinnedBy : null;
    const favoriteId = typeof p?.favoriteId === 'string' && (s.favorites ?? []).some((x) => x.id === p.favoriteId) ? p.favoriteId : null;
    let next = addItem(s, id, { spaceId, url, title, icon: target.kind === 'margin' ? '' : str(p.icon, 100_000), target, now, pinnedBy, favoriteId });
    if (p.front) next = used(next, id, w, now);
    return { s: next, result: { tabId: id } };
  },
  // The page an item's tab shows now (its address, title, icon), as the hosting saw it. A web item's only (an app's
  // title too; a Margin page's never changes).
  updateItem({ s, p }) {
    const k: any = s.keptTabs[p?.tabId];
    if (!k) return fail(s, 'no such item');
    if (targetOfItem(k).kind === 'margin') return { s };
    if (targetOfItem(k).kind === 'app') {
      const title = str(p.title);
      return { s: title && title !== k.title ? { ...s, keptTabs: { ...s.keptTabs, [k.id]: { ...k, title } } } : s };
    }
    const patch: Record<string, string> = {};
    if (typeof p.url === 'string' && /^(https?|file):/i.test(p.url)) patch.url = p.url;
    if (typeof p.title === 'string') patch.title = str(p.title);
    if (typeof p.icon === 'string') patch.favIconUrl = str(p.icon, 100_000);
    return { s: { ...s, keptTabs: { ...s.keptTabs, [k.id]: { ...k, ...patch } } } };
  },
  // One of Margin's own pages (`page`: MARGIN_PAGES) in the window: the item of that page in the window's space, shown
  // again, else a new one (Settings asked for from the palette, a menu, a theme's button).
  openMarginPage({ s, p, now, ids, requests }) {
    if (typeof p?.page !== 'string' || !Object.hasOwn(MARGIN_PAGES, p.page)) return fail(s, 'no such page');
    const w = win(p);
    const spaceId = windowSpace(s, w);
    if (!spaceId) return fail(s, 'no space');
    const target: MarginTarget = { kind: 'margin', page: p.page };
    const had = itemsOf(s, spaceId).filter((k) => { const t = targetOfItem(k); return t.kind === 'margin' && t.page === p.page; })
      .sort((a, b) => finite(b.lastActive) - finite(a.lastActive) || a.id.localeCompare(b.id))[0];
    if (had) {
      requests.push({ type: 'activateTab', windowId: p.windowId ?? null, item: had.id, url: had.url, target, spaceId });
      return { s: used(s, had.id, w, now), result: { tabId: had.id } };
    }
    const id = ids.tab();
    const { url, title } = placeOf(target, '', '');
    const next = used(addItem(s, id, { spaceId, url, title, icon: '', target, now }), id, w, now);
    requests.push({ type: 'newTab', windowId: p.windowId ?? null, item: id, url, target, spaceId });
    return { s: next, result: { tabId: id } };
  },
  activateTab({ s, p, now, requests }) {
    const k = s.keptTabs[p?.tabId];
    if (!k) return fail(s, 'no such item');
    requests.push({ type: 'activateTab', windowId: p.windowId ?? null, item: k.id, url: k.url, target: targetOfItem(k), spaceId: k.spaceId });
    return { s: used(s, k.id, win(p), now), result: { shown: k.id } };
  },
  // Closed from Margin (its ×, ⌘W): to the archive (a web page), and the hosting closes its page.
  // A sticky pin's or a favorite's item isn't archived: the item goes (an item is a pin's open tab here) and the pin
  // or favorite stays, not open; opened again, it opens at its own address.
  closeTab({ s, p, now, ids, requests }) {
    const k: any = s.keptTabs[p?.tabId];
    if (!k) return fail(s, 'no such item');
    // (A pin of the item's own space, or a favorite: an item moved to another space is no pin's, archived as any.)
    const isSticky = M.boundElsewhere(s, k, k.spaceId);
    const existingSplit = M.splitForItem(s, k.id);
    // (A split's pane: the split goes on with the rest, its next pane in front; one left: that one, alone.)
    const paneNext = splitNext(s, k.id);
    let next = existingSplit ? M.removeFromSplit(s, existingSplit.id, k.id) as LibState : s;
    next = isSticky ? M.forgetKept(next, k.id) as LibState : archiveItem(next, k.id, ids.other('a'), now);
    const after = (paneNext ? next.keptTabs[paneNext] : null) ?? frontOf(next, k.spaceId);
    requests.push({ type: 'closeTab', item: k.id, url: k.url, target: targetOfItem(k), spaceId: k.spaceId, next: after?.id ?? null });
    return { s: next };
  },
  // Manual sleep / unload: closes the live browser tab or asks the hosted app to quit, while keeping the item in its space.
  unloadTab({ s, p, requests }) {
    const k = s.keptTabs[p?.tabId];
    if (!k) return fail(s, 'no such item');
    const after = frontOf(s, k.spaceId, k.id);
    requests.push({ type: 'unloadTab', windowId: p?.windowId ?? null, item: k.id, url: k.url, target: targetOfItem(k), spaceId: k.spaceId, next: after?.id ?? null });
    return { s, result: { item: k.id } };
  },
  // Duplicate a web item right next to it in the same space and open it.
  duplicateTab({ s, p, now, ids, requests }) {
    const k: any = s.keptTabs[p?.tabId];
    if (!k) return fail(s, 'no such item');
    const target = targetOfItem(k);
    if (target.kind !== 'web') return fail(s, 'only web items can be duplicated');
    const id = ids.tab();
    const w = win(p);
    let next = addItem(s, id, { spaceId: k.spaceId, url: k.url, title: k.title, icon: k.favIconUrl ?? '', target, now });
    next = M.placeKept(next, id, k.id, 'before', k.spaceId) as LibState;
    next = used(next, id, w, now);
    requests.push({ type: 'newTab', windowId: p?.windowId ?? null, item: id, url: k.url, target, spaceId: k.spaceId });
    return { s: next, result: { tabId: id } };
  },
  // Mute / unmute a live web item's tab (hosted Safari copy toggles mutedInfo).
  muteTab({ s, p, requests }) {
    const k = s.keptTabs[p?.tabId];
    if (!k) return fail(s, 'no such item');
    requests.push({ type: 'muteTab', windowId: p?.windowId ?? null, item: k.id, url: k.url, target: targetOfItem(k), spaceId: k.spaceId });
    return { s, result: { item: k.id } };
  },
  // The background mini player's buttons (M2.4) for a web item's page: play or pause, the previous or next track,
  // done by the hosting (HostedSession.swift: the copy's `hostMedia`); mute as muteTab; `focus` shows it as
  // activateTab does. Nothing of the library changes.
  mediaControl(ctx) {
    const { s, p, requests } = ctx;
    const k = s.keptTabs[p?.tabId];
    if (!k) return fail(s, 'no such item');
    const command = p?.command;
    if (command === 'focus') return ACTIONS.activateTab(ctx);
    if (command === 'mute') return ACTIONS.muteTab(ctx);
    if (command !== 'toggle' && command !== 'prev' && command !== 'next') return fail(s, 'not a media command');
    const target = targetOfItem(k);
    if (target.kind !== 'web') return fail(s, 'only a web item plays in the mini player');
    requests.push({ type: 'mediaControl', windowId: p?.windowId ?? null, item: k.id, url: k.url, target, spaceId: k.spaceId, command });
    return { s, result: { item: k.id } };
  },
  // Its page closed outside Margin (the browser's own tab bar, the app quit): archived as closeTab, nothing asked.
  itemClosed({ s, p, now, ids }) {
    if (!s.keptTabs[p?.tabId]) return fail(s, 'no such item');
    return { s: archiveItem(s, p.tabId, ids.other('a'), now) };
  },
  // Gone without a trace (not archived).
  removeItem({ s, p }) {
    if (!s.keptTabs[p?.tabId]) return fail(s, 'no such item');
    return { s: M.forgetKept(s, p.tabId) as LibState };
  },
  moveTabToSpace({ s, p }) {
    if (!s.keptTabs[p?.tabId] || !hasSpace(s, p.spaceId)) return fail(s, 'no such item or space');
    return { s: M.moveTab(s, String(p.tabId), p.spaceId) as LibState };
  },
  // Dragged in the list beside another item (`side` as the list shows them: 'before' is above).
  moveTab({ s, p }) {
    const k = s.keptTabs[p?.tabId];
    if (!k || typeof p.nextTo !== 'string' || (p.side !== 'before' && p.side !== 'after')) return fail(s, 'no such item');
    const next = M.placeKept(s, k.id, p.nextTo, p.side, k.spaceId) as LibState;
    return { s: next, result: next.keptTabs[k.id]?.order !== k.order };
  },
  // "Clear": the window's space's items go to the archive; the hosting closes their pages.
  clearToday({ s, p, now, ids, requests }) {
    const spaceId = windowSpace(s, win(p));
    if (!spaceId) return { s, result: [] };
    const closing = itemsOf(s, spaceId).map((k) => k.id).sort();
    const next = closing.reduce((st, id) => archiveItem(st, id, ids.other('a'), now), s);
    if (closing.length) requests.push({ type: 'clearToday', windowId: p?.windowId ?? null, spaceId, items: closing });
    return { s: next, result: closing };
  },
  restoreArchive({ s, p, now, ids, requests }) {
    const entry: any = s.archive.find((a) => a.id === p?.archiveId);
    if (!entry) return fail(s, 'no such entry');
    const spaceId = hasSpace(s, entry.spaceId) ? entry.spaceId : windowSpace(s, win(p));
    if (!spaceId) return fail(s, 'no space');
    const id = ids.tab();
    const target = targetOf(entry.target) ?? spaceTarget(s, spaceId);
    let next = addItem(M.removeArchived(s, entry.id) as LibState, id, { spaceId, url: entry.url, title: entry.title, icon: entry.favIconUrl ?? '', target, now });
    next = used(next, id, win(p), now);
    requests.push({ type: 'restoreArchive', windowId: p.windowId ?? null, item: id, url: entry.url, target, spaceId });
    return { s: next, result: { tabId: id } };
  },
  // ⇧⌘T: reopen the most recently archived entry in this space (or newest overall if this space has none).
  restoreLastArchive({ s, p, now, ids, requests }) {
    const spaceId = windowSpace(s, win(p));
    const entry = (spaceId ? s.archive.find((a) => a.spaceId === spaceId) : null) ?? s.archive[0];
    if (!entry) return { s, result: null };
    return ACTIONS.restoreArchive({ s, p: { ...p, archiveId: entry.id }, now, ids, requests });
  },
  // ---- pins ----
  // An item pinned in its space: a pin at its address with its target and given name, and the item stays as the pin's
  // tab (sticky pins: `pinnedBy`, as an open tab pinned in the extension), so the page shown stays shown with its row
  // (the pin's, open and active) and its address; hidden from Today as a pin's tab. Its close then isn't an archive
  // (closeTab), the pin opens it (openPin), and unpinned it's Today's again (unpin: removePin unbinds it).
  pinTab({ s, p, ids }) {
    const k: any = s.keptTabs[p?.tabId];
    if (!k) return fail(s, 'no such item');
    const id = ids.other('p');
    const next = pinOfItem(s, k, id, p.folderId ?? null, p.beforeId ?? null);
    return next === s ? { s, result: null } : { s: next, result: id };
  },
  // Unpinned: the pin goes; its item (open or not) stays, unbound: Today's again.
  unpin({ s, p, requests }) {
    const pin: any = s.pins.find((x) => x.id === p?.pinId);
    if (!pin) return fail(s, 'no such pin');
    requests.push({ type: 'unpin', pin: pin.id, url: pin.url, target: targetOf(pin.target), spaceId: pin.spaceId });
    return { s: M.removePin(s, pin.id) as LibState };
  },
  // Shown in the window: its item in the space if there is one (bound via pinnedBy first, else URL), else the hosting opens it.
  openPin({ s, p, now, requests }) {
    const pin: any = s.pins.find((x) => x.id === p?.pinId);
    if (!pin) return fail(s, 'no such pin');
    const w = win(p);
    const bound = Object.values(s.keptTabs ?? {}).find((k) => k.pinnedBy === pin.id && k.spaceId === pin.spaceId) ?? null;
    // (By its address: never an item another pin or a favorite has.)
    const item = bound ?? M.keptForUrl(s, pin.url, pin.spaceId, { pinId: pin.id });
    let next = w != null ? M.setActiveSpace(s, w as any, pin.spaceId) as LibState : s;
    if (item) {
      if (item.pinnedBy !== pin.id) next = M.bindTabToPin(next, item.id, pin.id) as LibState;
      next = used(next, item.id, w, now);
    }
    requests.push({ type: 'openPin', windowId: p.windowId ?? null, pin: pin.id, item: item?.id ?? null, url: item?.url ?? pin.url, target: targetOf(pin.target), spaceId: pin.spaceId });
    return { s: next, result: { pin: pin.id, item: item?.id ?? null } };
  },
  // Reset a drifted sticky pin's live item back to the pin's root URL.
  resetPin({ s, p, now, requests }) {
    const pin: any = s.pins.find((x) => x.id === p?.pinId);
    if (!pin) return fail(s, 'no such pin');
    const w = win(p);
    const item = Object.values(s.keptTabs ?? {}).find((k) => k.pinnedBy === pin.id && k.spaceId === pin.spaceId)
      ?? M.keptForUrl(s, pin.url, pin.spaceId, { pinId: pin.id });
    let next = w != null ? M.setActiveSpace(s, w as any, pin.spaceId) as LibState : s;
    if (item) {
      next = { ...next, keptTabs: { ...next.keptTabs, [item.id]: { ...next.keptTabs[item.id], url: pin.url, title: pin.title || next.keptTabs[item.id].title } } } as LibState;
      next = used(next, item.id, w, now);
    }
    requests.push({ type: 'resetPin', windowId: p.windowId ?? null, pin: pin.id, item: item?.id ?? null, url: pin.url, target: targetOf(pin.target), spaceId: pin.spaceId });
    return { s: next, result: { pin: pin.id, item: item?.id ?? null } };
  },
  renamePin({ s, p }) {
    if (!s.pins.some((x) => x.id === p?.pinId)) return fail(s, 'no such pin');
    return { s: M.renamePin(s, p.pinId, p?.title ?? '') as LibState };
  },
  renameTab({ s, p }) {
    if (!s.keptTabs[p?.tabId]) return fail(s, 'no such item');
    return { s: M.renameTab(s, p.tabId, p?.title ?? '') as LibState };
  },
  movePin({ s, p }) {
    return { s: M.movePin(s, p?.pinId, { folderId: p?.folderId ?? null, beforeId: p?.beforeId ?? null }) as LibState };
  },
  // ---- favorites ----
  addFavorite({ s, p, ids }) {
    const k: any = typeof p?.tabId === 'string' ? s.keptTabs[p.tabId] : null;
    const pin: any = !k && typeof p?.pinId === 'string' ? s.pins.find((x) => x.id === p.pinId) : null;
    const spaceId = k?.spaceId ?? pin?.spaceId ?? windowSpace(s, win(p));
    // Its scope, as the sidebar shows favorites (shared/view.ts sidebar: state/model.ts favoriteScopeOf): the person's
    // setting `favoritesScope`, which the app gives (LibraryWindowSource, from the profile's settings, over anything the
    // page sent), and the profile of the space the window shows (else the item's): never a scope a page names.
    const w = win(p);
    const shown = w != null && hasSpace(s, s.activeSpaceByWindow[w as any]) ? s.activeSpaceByWindow[w as any] : spaceId;
    const scope = M.favoriteScopeOf({ ...s, settings: { ...s.settings, favoritesScope: p?.favoritesScope === 'profile' ? 'profile' : 'global' } } as LibState, shown);
    const target = k ? targetOfItem(k) : pin ? targetOf(pin.target) ?? webTarget('safari', null) : targetOf(p?.target) ?? (spaceId ? spaceTarget(s, spaceId) : webTarget('safari', null));
    const url = k?.url ?? pin?.url ?? str(p?.url);
    const title = k?.title ?? pin?.title ?? str(p?.title) ?? url;
    const customTitle = k?.customTitle ?? pin?.customTitle;
    if (!url) return fail(s, 'no address');
    const id = ids.other('fav');
    let next = M.addFavorite(s, { id, scope, url, title, customTitle, target, beforeId: p?.beforeId ?? null }) as LibState;
    if (next === s) return { s, result: null };
    if (k) next = M.bindTabToFavorite(next, k.id, id) as LibState;
    if (pin) next = M.removePin(next, pin.id) as LibState;
    return { s: next, result: id };
  },
  removeFavorite({ s, p }) {
    if (!(s.favorites ?? []).some((f) => f.id === p?.favoriteId)) return fail(s, 'no such favorite');
    return { s: M.removeFavorite(s, p.favoriteId) as LibState };
  },
  openFavorite({ s, p, now, requests }) {
    const fav: any = (s.favorites ?? []).find((x) => x.id === p?.favoriteId);
    if (!fav) return fail(s, 'no such favorite');
    const w = win(p);
    const spaceId = windowSpace(s, w) ?? s.spaces[0]?.id ?? null;
    // Its item (the one used last, if it has more), else one at its address no pin or other favorite has.
    const bound = M.keptOfFavorite(s, fav.id)[0] ?? null;
    const item = bound ?? Object.values(s.keptTabs ?? {}).find((k) => M.normalizeUrl(k.url) === M.normalizeUrl(fav.url) && !M.boundElsewhere(s, k, k.spaceId, { favoriteId: fav.id })) ?? null;
    let next = s;
    if (item) {
      if (item.favoriteId !== fav.id) next = M.bindTabToFavorite(next, item.id, fav.id) as LibState;
      next = used(next, item.id, null, now);
    }
    requests.push({ type: 'openFavorite', windowId: p.windowId ?? null, favorite: fav.id, item: item?.id ?? null, url: item?.url ?? fav.url, target: targetOf(fav.target) ?? (spaceId ? spaceTarget(s, spaceId) : webTarget('safari', null)), spaceId });
    return { s: next, result: { favorite: fav.id, item: item?.id ?? null } };
  },
  resetFavorite({ s, p, now, requests }) {
    const fav: any = (s.favorites ?? []).find((x) => x.id === p?.favoriteId);
    if (!fav) return fail(s, 'no such favorite');
    const w = win(p);
    const spaceId = windowSpace(s, w) ?? s.spaces[0]?.id ?? null;
    const item = M.keptOfFavorite(s, fav.id)[0] ?? null;
    let next = s;
    if (item) {
      next = { ...next, keptTabs: { ...next.keptTabs, [item.id]: { ...next.keptTabs[item.id], url: fav.url, title: fav.title || next.keptTabs[item.id].title } } } as LibState;
      next = used(next, item.id, null, now);
    }
    requests.push({ type: 'resetFavorite', windowId: p.windowId ?? null, favorite: fav.id, item: item?.id ?? null, url: fav.url, target: targetOf(fav.target) ?? (spaceId ? spaceTarget(s, spaceId) : webTarget('safari', null)), spaceId });
    return { s: next, result: { favorite: fav.id, item: item?.id ?? null } };
  },
  renameFavorite({ s, p }) {
    if (!(s.favorites ?? []).some((x) => x.id === p?.favoriteId)) return fail(s, 'no such favorite');
    return { s: M.renameFavorite(s, p.favoriteId, p?.title ?? '') as LibState };
  },
  moveFavorite({ s, p }) {
    return { s: M.moveFavorite(s, p?.favoriteId, { beforeId: p?.beforeId ?? null }) as LibState };
  },
  // ---- Link rules ----
  addAirTrafficRule({ s, p, ids }) {
    const spaceId = hasSpace(s, p?.spaceId) ? p.spaceId : windowSpace(s, win(p));
    if (!spaceId) return fail(s, 'no space');
    const id = ids.other('atc');
    const next = M.addAirTrafficRule(s, { id, pattern: str(p?.pattern, 200), spaceId, enabled: p?.enabled !== false }) as LibState;
    if (next === s) return fail(s, 'bad pattern');
    return { s: next, result: id };
  },
  removeAirTrafficRule({ s, p }) {
    return { s: M.removeAirTrafficRule(s, str(p?.ruleId, 128)) as LibState };
  },
  toggleAirTrafficRule({ s, p }) {
    return { s: M.toggleAirTrafficRule(s, str(p?.ruleId, 128), typeof p?.enabled === 'boolean' ? p.enabled : undefined) as LibState };
  },
  routeUrl({ s, p }) {
    const url = str(p?.url);
    const rule = matchAirTrafficRule(url, s.airTraffic, new Set(s.spaces.map((sp) => sp.id)));
    if (!rule) return { s, result: null };
    return { s, result: { ruleId: rule.id, pattern: rule.pattern, spaceId: rule.spaceId, target: spaceTarget(s, rule.spaceId) } };
  },
  // ---- split view (2–4 panes, docs/PEEK-SPLIT.md §4) ----
  // A split's panes are items of one space: web pages (any profile) and Mac apps, each app once (its one window can be
  // one pane only); never one of Margin's own pages. Each change the hosting must show asks for it as `showSplit` with
  // the pane to focus (`item`; null: the one the window shows, if it's a pane, else the first): the hosting shows the
  // whole split for it (HostedSession.swift showSplit). A resize asks nothing: the page placed the panes as it was dragged.
  createSplit({ s, p, ids, now, requests }) {
    const raw: string[] = Array.isArray(p?.panes) ? p.panes.filter((x: unknown): x is string => typeof x === 'string' && !!s.keptTabs[x]) : [];
    if (raw.length < 2) return fail(s, 'need at least 2 items');
    const spaceId = hasSpace(s, p?.spaceId) ? p.spaceId : s.keptTabs[raw[0]].spaceId;
    const why = splitRefusal(s, [], raw, spaceId);
    if (why) return fail(s, why);
    const id = ids.other('spv');
    let next = M.createSplit(s, { id, spaceId, panes: raw, axis: p?.axis === 'vertical' ? 'vertical' : 'horizontal', ratios: p?.ratios }) as LibState;
    const group = (next.splits ?? []).find((g) => g.id === id);
    if (!group) return fail(s, 'not a split');
    const focus = typeof p?.focus === 'string' && group.panes.includes(p.focus) ? p.focus : group.panes[group.panes.length - 1];
    next = used(next, focus, win(p), now);
    requests.push(splitShown(next, group, focus, p));
    return { s: next, result: { splitId: id } };
  },
  // `tabId` into the split of the item in front of its space (`nextTo`: that item; `splitId`: that split), or a new
  // split of the two: Arc's Add to Split View on a row. Refused: a split of 4 already, an app that's in it already, an
  // item of another space, one of Margin's own pages. Already a pane of it: the split shown, that pane focused.
  addToSplit({ s, p, ids, now, requests }) {
    const k = s.keptTabs[p?.tabId];
    if (!k) return fail(s, 'no such item');
    const w = win(p);
    const given = typeof p?.nextTo === 'string' && s.keptTabs[p.nextTo] && p.nextTo !== k.id ? s.keptTabs[p.nextTo] : null;
    const front = given ?? frontOf(s, k.spaceId, k.id);
    const existing = (typeof p?.splitId === 'string' ? (s.splits ?? []).find((g) => g.id === p.splitId) : null)
      ?? (front ? M.splitForItem(s, front.id) : null);
    if (existing) {
      if (existing.panes.includes(k.id)) {
        requests.push(splitShown(s, existing, k.id, p));
        return { s: used(s, k.id, w, now), result: { splitId: existing.id } };
      }
      const why = splitRefusal(s, existing.panes, [k.id], existing.spaceId);
      if (why) return fail(s, why);
      const next = M.addToSplit(s, existing.id, k.id) as LibState;
      const group = (next.splits ?? []).find((g) => g.id === existing.id);
      if (!group || !group.panes.includes(k.id)) return fail(s, 'not added');
      requests.push(splitShown(next, group, k.id, p));
      return { s: used(next, k.id, w, now), result: { splitId: existing.id } };
    }
    if (!front) return fail(s, 'no second item to split with');
    return ACTIONS.createSplit({ s, p: { ...p, panes: [front.id, k.id], spaceId: k.spaceId, focus: k.id }, now, ids, requests });
  },
  openSplit({ s, p, now, requests }) {
    const group = (s.splits ?? []).find((g) => g.id === p?.splitId);
    if (!group) return fail(s, 'no such split');
    const first = group.panes.find((id) => !!s.keptTabs[id]);
    if (!first) return fail(s, 'split has no items');
    const focus = typeof p?.focus === 'string' && group.panes.includes(p.focus) ? p.focus : first;
    const next = used(s, focus, win(p), now);
    requests.push(splitShown(next, group, focus, p));
    return { s: next, result: { splitId: group.id } };
  },
  // Out of its split, shown alone (the others stay a split, or the split goes with one left).
  breakOutSplit({ s, p, now, requests }) {
    const group = M.splitForItem(s, p?.tabId);
    const k = s.keptTabs[p?.tabId];
    if (!group || !k) return { s };
    const next = used(M.removeFromSplit(s, group.id, k.id) as LibState, k.id, win(p), now);
    requests.push({ type: 'activateTab', windowId: p.windowId ?? null, item: k.id, url: k.url, target: targetOfItem(k), spaceId: k.spaceId });
    return { s: next };
  },
  // Out of its split, the rest of it shown (its next pane focused, or `focus` when it's one of the rest; one left: that
  // one, alone). `focus`: Margin.app's own when a pane that couldn't open leaves (HostedSession.swift), the pane that had
  // the keys keeping them.
  removeFromSplit({ s, p, now, requests }) {
    const group = M.splitForItem(s, p?.tabId);
    const k = s.keptTabs[p?.tabId];
    if (!group || !k) return { s };
    const kept = typeof p?.focus === 'string' && p.focus !== k.id && group.panes.includes(p.focus) && !!s.keptTabs[p.focus] ? p.focus : null;
    const after = kept ?? splitNext(s, k.id);
    let next = M.removeFromSplit(s, group.id, k.id) as LibState;
    const left = (next.splits ?? []).find((g) => g.id === group.id);
    if (after && next.keptTabs[after]) {
      next = used(next, after, win(p), now);
      const a = next.keptTabs[after];
      requests.push(left ? splitShown(next, left, after, p) : { type: 'activateTab', windowId: p.windowId ?? null, item: a.id, url: a.url, target: targetOfItem(a), spaceId: a.spaceId });
    }
    return { s: next };
  },
  closeSplitPane({ s, p, now, ids, requests }) {
    return ACTIONS.closeTab({ s, p, now, ids, requests });
  },
  swapSplit({ s, p, requests }) {
    const group = (s.splits ?? []).find((g) => g.id === p?.splitId);
    if (!group) return fail(s, 'no such split');
    const a = Number.isInteger(p?.a) ? p.a : 0;
    const b = Number.isInteger(p?.b) ? p.b : 1;
    const next = M.swapSplitPanes(s, group.id, a, b) as LibState;
    const after = (next.splits ?? []).find((g) => g.id === group.id);
    if (after && next !== s) requests.push(splitShown(next, after, null, p));
    return { s: next };
  },
  resizeSplit({ s, p }) {
    const group = (s.splits ?? []).find((g) => g.id === p?.splitId);
    if (!group) return fail(s, 'no such split');
    return { s: M.resizeSplit(s, group.id, p?.ratios) as LibState };
  },
  toggleSplitAxis({ s, p, requests }) {
    const group = (s.splits ?? []).find((g) => g.id === p?.splitId);
    if (!group) return fail(s, 'no such split');
    const next = M.toggleSplitAxis(s, group.id) as LibState;
    const after = (next.splits ?? []).find((g) => g.id === group.id);
    if (after) requests.push(splitShown(next, after, null, p));
    return { s: next };
  },
  // ---- folders ----
  // In the window's space (or `spaceId`), holding `pinIds`, or the item `tabId` pinned into it (it's the pin then).
  createFolder({ s, p, ids }) {
    const id = ids.other('f');
    const k: any = typeof p?.tabId === 'string' ? s.keptTabs[p.tabId] : null;
    const parentFolder = typeof p?.parentId === 'string' ? (s.folders ?? []).find((f) => f.id === p.parentId) : null;
    const spaceId = hasSpace(s, p?.spaceId) ? p.spaceId : parentFolder ? parentFolder.spaceId : k ? k.spaceId : windowSpace(s, win(p));
    if (!spaceId) return fail(s, 'no space');
    const pinIds: string[] = Array.isArray(p?.pinIds) ? p.pinIds.filter((x: unknown) => typeof x === 'string') : [];
    const firstPin = s.pins.find((x) => x.id === pinIds[0] && x.spaceId === spaceId);
    const before = p?.beforeId ?? (firstPin && !firstPin.folderId ? firstPin.id : null);
    let next = M.createFolder(s, { id, spaceId, name: p?.name, pinIds, parentId: parentFolder?.id ?? null, beforeId: before }) as LibState;
    if (k && next !== s) next = pinOfItem(next, k, ids.other('p'), id, null);
    return { s: next, result: next === s ? null : id };
  },
  renameFolder({ s, p }) { return { s: M.renameFolder(s, p?.folderId, p?.name) as LibState }; },
  setFolderOpen({ s, p }) { return { s: M.setFolderOpen(s, p?.folderId, !!p?.open) as LibState }; },
  deleteFolder({ s, p }) { return { s: M.deleteFolder(s, p?.folderId) as LibState }; },
  moveFolder({ s, p }) { return { s: M.moveFolder(s, p?.folderId, { parentId: p?.parentId ?? null, beforeId: p?.beforeId ?? null }) as LibState }; },
  nestFolder({ s, p }) { return { s: M.moveFolder(s, p?.folderId, { parentId: p?.parentId ?? null, beforeId: p?.beforeId ?? null }) as LibState }; },
  // ---- Margin's windows ----
  // A Margin window closed for good: its space is forgotten (a new one starts in the first space).
  forgetWindow({ s, p }) {
    const w = win(p);
    if (w == null || !(w in s.activeSpaceByWindow)) return { s };
    const activeSpaceByWindow = { ...s.activeSpaceByWindow } as Record<string, string>;
    delete activeSpaceByWindow[w];
    return { s: { ...s, activeSpaceByWindow } };
  },
};

/** The actions the library takes (the rest are refused: `unsupported`). */
export const ACTION_NAMES = Object.freeze(Object.keys(ACTIONS).sort());

/**
 * One action on the library's values: the changes to merge (values, not yet timed: the app stamps them), what it
 * answers, and what it asks of the hosting. Never throws: a bad action is `ok: false` with no changes.
 */
export function perform(values: Values, action: string, payload: any = {}, env: Env = { now: 0 }): Outcome {
  const handler = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
  if (!handler) return { ok: false, error: 'unsupported', changes: [], requests: [] };
  const state = stateOf(values);
  const before = valuesOf(state, values?.imports ?? {});
  const requests: Request[] = [];
  let out;
  try {
    out = handler({ s: state, p: isObject(payload) ? payload : {}, now: finite(env?.now), ids: idMaker(env), requests });
  } catch (e) {
    return { ok: false, error: `failed: ${(e as Error)?.message ?? e}`, changes: [], requests: [] };
  }
  if (out.error) return { ok: false, error: out.error, changes: [], requests: [] };
  // Splits checked against the items left (an item archived, forgotten, closed outside Margin leaves its split).
  const after = M.settleSplits(out.s) as LibState;
  return { ok: true, result: out.result ?? null, changes: diff(before, valuesOf(after, values?.imports ?? {})), requests };
}

/**
 * What the UI draws (app/shared/ui/host-app.ts takes it as its stored values: shared/stored.ts fromStorage): the
 * spaces, pins, folders and archive as the extension stores them, and the items as kept tabs (`openTabs.keptTabs`),
 * each with its target; no open tabs (the hosting adds those it has). `library` says it's the library's.
 */
export function snapshot(values: Values) {
  const s = stateOf(values);
  return {
    library: { v: FORMAT, imported: isObject(values?.imports?.done) },
    spaces: s.spaces,
    pins: s.pins,
    favorites: s.favorites ?? [],
    airTraffic: s.airTraffic ?? [],
    splits: s.splits ?? [],
    folders: s.folders,
    archive: s.archive,
    openTabs: { origin: 'margin-app', since: 0, synced: true, tabs: {}, tabSpace: {}, activeSpaceByWindow: s.activeSpaceByWindow, awayByWindow: {}, keptTabs: s.keptTabs },
  };
}

// ---- the import (decided by Tirth, 2026-11-15) ----------------------------------------------------------------
// Each profile's data set, as the app keeps it (DataStore.swift), into the library once: its spaces with the profile
// as their own, its pins, folders, Margin tabs (open or kept: all become items, web pages in that profile) and archive.
// Ids are namespaced, so two profiles' `personal` stay two spaces: a space, pin, folder or archive entry by
// `<browser>:<profile>:<id>`, an item by `t-` and a hash of the same (the model takes only `t-` ids for tabs). The same
// sets give the same ids, so an import run again (a crash before its marker was written) merges into itself.
// `order`: every space as [browser, profile, id] in the person's order (browser.json's, read by the app), the
// others after it in their sets' order. Nothing in the sets is changed or deleted.

export type ImportSet = { browser: string, profile: string, values: Values };

const NAME_MAX = 256;
export function nsId(browser: string, profile: string, id: string) {
  const name = `${browser}:${profile}:${id}`;
  return name.length <= NAME_MAX ? name : `${browser}:${fingerprint(profile)}${fingerprint(`${profile}\n`)}:${fingerprint(id)}${fingerprint(`${id}\n`)}`;
}
export function nsTabId(browser: string, profile: string, id: string) {
  const key = `${browser}\n${profile}\n${id}`;
  return `t-${fingerprint(key)}${fingerprint(`${key}\n`)}`;
}

export function importValues(current: Values, sets: ImportSet[], order: [string, string, string][] = [], env: Env = { now: 0 }) {
  const now = finite(env?.now);
  const next: Values = Object.fromEntries(COLLECTIONS.map((c) => [c, { ...(current?.[c] ?? {}) }]));
  const counts = { spaces: 0, pins: 0, folders: 0, tabs: 0, archive: 0 };
  const placed: string[] = []; // space ids in the order they go
  const rank = new Map(order.map(([b, p, id], i) => [nsId(b, p, id), i]));
  const ok = sets.filter((set) => set && BROWSERS.has(set.browser) && typeof set.profile === 'string' && set.profile && isObject(set.values));
  for (const { browser, profile, values } of ok) {
    const target = webTarget(browser, profile);
    const spaceIds = new Map<string, string>();
    const own = sorted(values.spaces).sort((a, b) => finite(a[1].order) - finite(b[1].order) || a[0].localeCompare(b[0]));
    for (const [id, sp] of own) {
      const lib = nsId(browser, profile, id);
      spaceIds.set(id, lib);
      placed.push(lib);
      next.spaces[lib] = { name: str(sp.name, 200), emoji: str(sp.emoji, 16), color: str(sp.color, 32), order: 0, browser, profile };
      counts.spaces++;
    }
    const folderIds = new Map<string, string>();
    for (const [id, f] of sorted(values.folders)) {
      const spaceId = spaceIds.get(f.spaceId);
      if (!spaceId) continue;
      const lib = nsId(browser, profile, id);
      folderIds.set(id, lib);
      next.folders[lib] = { spaceId, name: str(f.name, 200), open: f.open !== false, pos: finite(f.pos) };
      counts.folders++;
    }
    for (const [id, pin] of sorted(values.pins)) {
      const spaceId = spaceIds.get(pin.spaceId);
      if (!spaceId || typeof pin.url !== 'string') continue;
      next.pins[nsId(browser, profile, id)] = { spaceId, url: pin.url, title: str(pin.title), folderId: (typeof pin.folderId === 'string' && folderIds.get(pin.folderId)) || null, pos: finite(pin.pos), target };
      counts.pins++;
    }
    for (const [id, t] of sorted(values.tabs)) {
      const spaceId = spaceIds.get(t.spaceId);
      if (!spaceId || typeof t.url !== 'string' || !/^(https?|file):/i.test(t.url)) continue;
      next.tabs[nsTabId(browser, profile, id)] = {
        url: t.url, title: str(t.title), icon: /^(https?|data):/.test(t.icon ?? '') ? str(t.icon, 100_000) : '', spaceId, order: finite(t.order),
        lastUsed: finite(t.lastUsed), selected: t.selected === true, target, imported: { browser, profile, id },
      };
      counts.tabs++;
    }
    for (const [id, a] of sorted(values.archive)) {
      if (typeof a.url !== 'string') continue;
      // An entry of a space the set no longer has: the profile's first.
      const spaceId = spaceIds.get(a.spaceId) ?? spaceIds.get(own[0]?.[0]);
      if (!spaceId) continue;
      next.archive[nsId(browser, profile, id)] = { url: a.url, title: str(a.title), spaceId, icon: str(a.icon, 100_000), closedAt: finite(a.closedAt), target };
      counts.archive++;
    }
  }
  // The order: what the library had first, then the person's order, then the rest as the sets gave them.
  const had = sorted(current?.spaces).sort((a, b) => finite(a[1].order) - finite(b[1].order)).map(([id]) => id).filter((id) => !placed.includes(id));
  const incoming = placed.map((id, i) => ({ id, i })).sort((a, b) => (rank.get(a.id) ?? order.length + a.i) - (rank.get(b.id) ?? order.length + b.i)).map((x) => x.id);
  [...had, ...incoming].forEach((id, i) => { next.spaces[id] = { ...next.spaces[id], order: i }; });
  // Items' places: the list is one per space, so each profile's own numbers keep their order within its spaces.
  next.imports.done = { at: now, sets: ok.map((set) => `${set.browser}:${set.profile}`), ...counts };
  // Through the model's reading once, so what's stored is what stateOf/valuesOf give (no change on the next action).
  const normal = valuesOf(stateOf(next), next.imports);
  return { changes: diff(current ?? {}, normal), counts };
}

// ---- the JavaScriptCore entry (the vectors' recorder's; the app's until step 4's switch) -------------------------
// One function, JSON in and out (no object bridging): marginLibrary.call(name, argsJSON) → resultJSON.
const API: Record<string, (...args: any[]) => any> = {
  perform: (values, action, payload, env) => perform(values, action, payload, env),
  snapshot: (values) => snapshot(values),
  importValues: (current, sets, order, env) => importValues(current, sets, order, env),
  actions: () => ACTION_NAMES,
};
export function call(name: string, args: string) {
  if (!Object.hasOwn(API, name)) return JSON.stringify({ error: `no function ${name}` });
  try {
    const list = JSON.parse(args);
    return JSON.stringify({ value: API[name](...(Array.isArray(list) ? list : [])) });
  } catch (e) {
    return JSON.stringify({ error: String((e as Error)?.message ?? e) });
  }
}
(globalThis as any).marginLibrary = { call, version: FORMAT };
