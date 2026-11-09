// Margin's state: storage.local, read through load() (the worker can be
// unloaded at any time, so nothing lives only in memory) and changed through
// mutate(). Only the copy of Margin that owns the storage writes it
// (shared/owner.ts): an older copy still running beside a newer one reads,
// never writes.
import * as M from '../state/model.ts';
import * as O from '../shared/owner.ts';
import { FAVICONS, FAVICONS_MARK, OPEN_TABS, OPEN_TABS_KEYS, fromStorage, openTabsCurrent, sameStored, storedName, toStorage } from '../shared/stored.ts';
import { DATA_META_KEYS, SOURCES, collectionFrom, dataSetFrom, fingerprint, itemsFrom, metaKey, pendingChanges, stateFromDataSet, track } from '../shared/data-set.ts';
import { mergeData } from '../shared/data-merge.ts';
import { appLog, switchLog } from './switch-log.ts';
import type { State } from '../../types/margin';

export const api = globalThis.browser ?? globalThis.chrome;

let cache: State | null = null;
let loading: Promise<State> | null = null;
let queue: Promise<unknown> = Promise.resolve();

// The state if it's loaded already (no wait), else null.
export const cached = () => cache;

// ---- which copy owns the storage (shared/owner.ts) ---------------------------
// This copy: its address, and its first background start (storage.session
// lasts as long as the copy, across its background's restarts).
const me = { origin: api?.runtime?.getURL?.('') ?? '', since: 0 };
let role: 'owner' | 'stale' | null = null;
let deciding: Promise<'owner' | 'stale'> | null = null;
// Settles once this copy knows whether it owns the storage (once per
// background start; every listener waits for it). A storage error doesn't
// stick: it's tried again a few times, and the next caller tries afresh.
export const decided = () => (deciding ??= decide().catch((err) => {
  deciding = null;
  throw err;
}));
export const isOwner = () => role === 'owner';
// Known not to own it (a newer copy does); null (not known yet) isn't stale.
export const isStale = () => role === 'stale';
// Whether the stored tabs are this copy's, matched to the open tabs (its
// background starting again within the same copy: nothing to wait for).
export const isSynced = () => role === 'owner' && synced;
// This copy (for pages' requests: whose tab ids they hold, background/tabs.ts).
export const thisCopy = () => ({ origin: me.origin, since: me.since });
async function decide() {
  for (let tries = 0; ; tries++) {
    try {
      return await decideOnce();
    } catch (err) {
      if (tries >= 3) throw err;
      console.warn('[margin] reading who owns the state failed; trying again:', err?.message ?? err);
      await new Promise<any>((resolve) => setTimeout(resolve, 150 * 3 ** tries));
    }
  }
}
async function decideOnce() {
  // A failed read isn't a first start (that would make this copy the newest).
  const session = api.storage.session ? await api.storage.session.get('since') : null;
  const { owner, [OPEN_TABS]: open } = await api.storage.local.get(['owner', OPEN_TABS]);
  // Whether this is the copy's first start (not its background waking): only
  // then may it claim a record from a clock that was ahead (shared/owner.ts).
  let first = false;
  if (Number.isFinite(session?.since)) me.since = session.since;
  // Without storage.session a restart can't be told from the copy's first
  // start: the record stands if it's this address.
  else if (!api.storage.session && owner?.origin === me.origin && Number.isFinite(owner.since)) me.since = owner.since;
  else {
    me.since = Date.now();
    first = true;
    await api.storage.session?.set({ since: me.since });
  }
  const own = O.ownership(owner, me) === 'own';
  const decision = await settle(owner, open, { starting: first });
  // This copy's background starting again: the stored tabs are already its
  // own, matched (shared/stored.ts), unless it stopped before that.
  if (decision === 'owner' && own) synced = openTabsCurrent(open, me.origin, me.since);
  return decision;
}
// The stored owner says what this copy is. Copies don't hear each other's
// storage writes (checked in WebKit), so a copy that owned the state finds out
// a newer one took over when it next writes (flush), a page says hello, or
// an event reaches it (recheckSoon). When it claims, the stored tabs are
// marked unmatched at once (`open`: as read): pages then wait for this copy's
// first sync (shared/stored.ts). `back`: claimed back from an older copy that
// claimed over this one (recheck): this copy's tabs stay matched.
async function settle(stored, open = null, { starting = false, back = false } = {}) {
  const decision = O.ownership(stored, me, starting ? Date.now() : undefined);
  if (decision === 'stale') {
    if (role !== 'stale') console.info('[margin] a newer copy of Margin is running: this one stays out of the way');
    role = 'stale';
    return role;
  }
  role = 'owner';
  if (decision === 'claim') {
    if (!back) synced = false;
    await api.storage.local.set({ owner: { ...me } });
    if (open?.synced) {
      await api.storage.local.set({ [OPEN_TABS]: { ...open, synced: false } }).catch((err) => {
        console.warn('[margin] marking the stored tabs unmatched failed:', err?.message ?? err);
      });
    }
    // The envelope a development build kept (workspace, workspaceBackup):
    // nothing reads it.
    void Promise.resolve().then(() => api.storage.local.remove(['workspace', 'workspaceBackup'])).catch(() => {});
  }
  return role;
}
// Whether this copy still owns the state (another may have claimed it since).
// An older copy that claimed over it (they started together) is claimed back:
// this copy's tabs stay matched, and are written again at once.
// One at a time: callers meanwhile share the check under way.
let checking: Promise<'owner' | 'stale' | null> | null = null;
export function recheck() {
  if (role !== 'owner') return Promise.resolve(role);
  return (checking ??= recheckNow().finally(() => { checking = null; }));
}
async function recheckNow() {
  const { owner } = await api.storage.local.get('owner').catch(() => ({ owner: null }));
  checkedAt = Date.now();
  if (!owner || (owner.origin === me.origin && owner.since === me.since)) return role;
  await settle(owner, null, { back: true }).catch(() => {});
  // Claimed back: this copy's tabs are written again now, over the older
  // copy's (not waited for: a recheck inside a write mustn't wait on itself).
  if (role === 'owner' && synced) {
    void write(OPEN_TABS_KEYS);
  }
  return role;
}
// The same, at most once a second (before a listener runs: background.ts
// owned). While a check is under way, every caller waits for it: events then
// go on in the order they came.
let checkedAt = 0;
export const recheckSoon = () => checking ?? (role === 'owner' && Date.now() - checkedAt > 1000 ? recheck() : Promise.resolve(role));
// Once the open tabs are matched to the state (a sync), pages may trust the
// stored tabs: they're written again, marked so (shared/stored.ts).
let synced = false;
export async function markSynced() {
  if (synced || role !== 'owner') return;
  synced = true;
  await write(OPEN_TABS_KEYS);
}

// ---- reading and writing ---------------------------------------------------------

export function load(): Promise<State> {
  if (cache) return Promise.resolve(cache);
  loading ??= read().finally(() => { loading = null; });
  return loading;
}
async function read() {
  await decided();
  const names = M.STATE_KEYS.map(storedName);
  // The old names too, for a first start after an update (shared/stored.ts).
  const raw = await api.storage.local.get([...new Set([...names, ...M.STATE_KEYS, FAVICONS_MARK, ...DATA_META_KEYS])]);
  const stored = fromStorage(raw);
  const next = M.normalizeState(stored);
  // First run: persist defaults so readers (content scripts) see a full state.
  const missing = M.STATE_KEYS.filter((key) => !(storedName(key) in raw));
  // Tabs from before Margin's own tab ids (state/model.ts), or an earlier
  // build's lost tabs, given ids now: written, so they keep them.
  if (role === 'owner' && M.tabIdsAdded(stored, next)) missing.push(...OPEN_TABS_KEYS, 'lostTabs');
  // What the lasting data set's items were when this copy last wrote them
  // (shared/data-set.ts): the queue for the app is kept from here (flush). A
  // collection with none yet (storage from before it, or wiped) starts from
  // the state as read, every item at 0: nothing in it is queued.
  dataMeta = readMeta(raw);
  if (role === 'owner') {
    for (const collection of Object.keys(SOURCES)) {
      if (dataMeta[collection]) continue;
      dataMeta[collection] = track(null, collectionFrom(next, collection), Date.now());
      metaUnsaved.add(collection);
    }
  }
  // Icons kept by a build before their mark: written again with it, once, so
  // pages read them only when they change (shared/stored.ts readForPage).
  if (FAVICONS in raw && !(FAVICONS_MARK in raw)) missing.push(FAVICONS);
  if (!('spaces' in raw) && role === 'owner') {
    appLog('storage was empty at start (a first install, or Safari cleared Margin\'s data): starting from the open tabs');
  }
  // Saved under another build's default shortcuts (normalizeShortcuts moved
  // them): save, so pages, which read storage directly, use the new ones.
  if (raw.settings && raw.settings.shortcutDefaults !== next.settings.shortcutDefaults) missing.push('settings');
  // Removed settings to drop, or theme settings to fill in or move (a saved
  // top-level sidebarWidth became Arcadia's): save, for the same reason.
  else if (raw.settings && ('searchEngine' in raw.settings || 'sidebarWidth' in raw.settings || !raw.settings.themes || raw.settings.theme !== next.settings.theme)) missing.push('settings');
  cache ??= next;
  if (missing.length) write(missing);
  writeMetaSoon();
  return cache;
}

// ---- the queue for Margin.app (shared/data-set.ts) ------------------------------
// Each tracked collection's meta: what its items were when last written, since
// when, and what's been deleted (tombstones). Looked at again for the
// collections whose state keys a write takes (with their times then), and
// written in a set() of its own META_WRITE_MS later, off a switch's way: in
// the same set() as the state, its larger writes and change events made a
// carried sidebar miss a switched-to page's first frame in the WebKit host
// (`switching`, 2 of 4 runs). A meta write lost with the background is made
// good at the collection's next write (it's looked at against the stored
// meta again), with that later time. The queue of changes made while the app
// isn't linked is every item and tombstone with a time (pendingQueue).
// Margin.app takes it on link (step 3: DATA.md).
let dataMeta: Record<string, any> = {};
const metaUnsaved = new Set<any>();
const META_WRITE_MS = 1500;
let metaTimer = null;
function writeMetaSoon() {
  if (metaTimer || !metaUnsaved.size) return;
  metaTimer = setTimeout(() => {
    metaTimer = null;
    queue = queue.then(writeMeta);
  }, META_WRITE_MS);
}
async function writeMeta() {
  if (role !== 'owner' || !metaUnsaved.size) return;
  const metas = [...metaUnsaved];
  metaUnsaved.clear();
  try {
    await api.storage.local.set(Object.fromEntries(metas.map((collection) => [metaKey(collection), dataMeta[collection]])));
  } catch (err) {
    console.warn('[margin] saving the data set\'s times failed; trying again with the next write:', err?.message ?? err);
    for (const collection of metas) metaUnsaved.add(collection);
    writeMetaSoon();
  }
}
function readMeta(raw: Record<string, any>) {
  const metas = {};
  for (const collection of Object.keys(SOURCES)) {
    const meta = raw?.[metaKey(collection)];
    if (meta && typeof meta === 'object' && meta.items && typeof meta.items === 'object') metas[collection] = meta;
  }
  return metas;
}
// The collections `keys` feed, looked at again now: those that changed are
// written with them.
function trackKeys(keys) {
  if (!cache) return;
  const at = Date.now();
  const changes: any[] = [];
  for (const [collection, sources] of Object.entries(SOURCES)) {
    if (!sources.some((key) => keys.includes(key))) continue;
    const before = dataMeta[collection] ?? null;
    const items = collectionFrom(cache, collection);
    const meta = track(before, items, at);
    if (meta === before) continue;
    dataMeta[collection] = meta;
    metaUnsaved.add(collection);
    if (dataListeners.size) changes.push(...changedItems(collection, before, meta, items));
  }
  if (changes.length) for (const cb of [...dataListeners]) cb(changes);
}
// The changes one look at a collection found (its meta before and after): the
// items with a new time, and the new tombstones.
function changedItems(collection, before, after, items) {
  const out = [];
  for (const [id, [at, fp]] of Object.entries(after.items)) {
    const had = before?.items?.[id];
    if (at > 0 && (had?.[0] !== at || had?.[1] !== fp)) out.push({ collection, id, updatedAt: at, value: items[id] });
  }
  for (const [id, at] of Object.entries(after.gone ?? {})) if (before?.gone?.[id] !== at) out.push({ collection, id, updatedAt: at, deleted: true });
  return out;
}

// ---- the app's data (DATA.md, background/link.ts) --------------------------------
// While Margin.app is linked, every change this copy makes to the data set is
// told as it's written (`onDataChanges`: the changes trackKeys found). What
// the app sends (its data set, or its own changes) becomes the state here,
// with the app's times kept for what agrees with it, so nothing it sent is
// queued back to it as a change of this copy's.
const dataListeners: Set<(changes: any[]) => void> = new Set<any>();
export const onDataChanges = (cb: (changes: any[]) => void) => { dataListeners.add(cb); return () => dataListeners.delete(cb); };
// Two values the same, whatever order their keys came in (the app's JSON keeps none).
const canonical = (v) => (Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v);
const sameValue = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
/**
 * A collection's meta after the state took a data set's items: an item that
 * agrees with the set has the set's time; one that doesn't (a live change the
 * set hasn't heard: an open tab's title) keeps its time if it hadn't changed,
 * else now (it's queued). Tombstones: the set's, and this copy's own for
 * items still gone.
 * */
export function metaFromSet(meta: any, items: Record<string, any>, setItems: Record<string, any>, now: number) {
  const next = {};
  for (const [id, value] of Object.entries(items)) {
    const fp = fingerprint(value);
    const s = setItems?.[id];
    if (s && s.deleted !== true && Number.isFinite(s.updatedAt) && sameValue(s.value, value)) next[id] = [s.updatedAt, fp];
    else if (meta?.items?.[id]?.[1] === fp) next[id] = meta.items[id];
    else next[id] = [now, fp];
  }
  const gone = {};
  for (const [id, at] of Object.entries(meta?.gone ?? {})) if (!(id in next)) gone[id] = at;
  for (const [id, s] of Object.entries(setItems ?? {})) {
    if (s?.deleted === true && !(id in next) && Number.isFinite(s.updatedAt)) gone[id] = Math.max(gone[id] ?? 0, s.updatedAt);
  }
  return { items: next, gone };
}
/**
 * The state from a data set (`setFor(state)`: the app's whole set, or this
 * copy's merged with the app's changes), keeping the live state
 * (shared/data-set.ts stateFromDataSet), with the set's times.
 * */
export function adoptDataSet(setFor: (state: State) => { items?: Record<string, Record<string, any>> }) {
  return mutate((s) => {
    const set = setFor(s);
    const next = stateFromDataSet(s, set);
    const at = Date.now();
    for (const collection of Object.keys(SOURCES)) {
      if (!set?.items?.[collection]) continue;
      dataMeta[collection] = metaFromSet(dataMeta[collection], collectionFrom(next, collection), set.items[collection], at);
      metaUnsaved.add(collection);
    }
    writeMetaSoon();
    return next;
  });
}
/**
 * The app's whole data set (DATA.md "For the extension's end"), with the
 * changes this copy made after its data.hello merged on top (a snapshot
 * crossing a change doesn't undo it), and the items the app left out
 * (`omitted`: [[collection, id]], too big to send) kept as this copy has them.
 */
export function adoptAppSet(set: { items?: Record<string, Record<string, any>> }, { changes = [], omitted = [] }: { changes?: any[], omitted?: any[] } = {}) {
  return adoptDataSet((s) => {
    let full = set;
    if (omitted.length) {
      const mine = dataSetFrom(s, { metas: dataMeta });
      const items = { ...set.items };
      for (const [collection, id] of omitted) {
        const item = mine.items?.[collection]?.[id];
        if (item && items[collection]) items[collection] = { ...items[collection], [id]: item };
      }
      full = { ...set, items };
    }
    return changes.length ? mergeData(full, changes) : full;
  });
}
/** The app's own changes (its UI, another window's copy), merged in by the same rule as the app's. */
export const takeDataChanges = (changes: any[]) => adoptDataSet((s) => mergeData(dataSetFrom(s, { metas: dataMeta }), changes));
/** The changes queued for the app after `since` (0: all), oldest first, with the state's values now. */
export async function pendingQueue(since: number = 0) {
  const state = await load();
  return pendingChanges(dataMeta, itemsFrom(state), since);
}
/** The meta as kept now (tests, and the data set's converter: shared/data-set.ts dataSetFrom). */
export const dataMetas = () => ({ ...dataMeta });

// Keys whose write failed (Safari's storage can be busy: SQLite error 5 in
// Tirth's log while two copies wrote at once): written again shortly, and
// with the next write. The cache keeps the change meanwhile.
const unsaved = new Set<any>();
let retryTimer = null;
let retryMs = 250;
// Writes `keys` from the cache, queued behind the state's other writes.
function write(keys) {
  for (const key of keys) {
    later.delete(key);
    unsaved.add(key);
  }
  queue = queue.then(flush);
  return queue;
}
// Keys whose only change not yet sent can wait (mutate's `within`), and when
// the write that takes them is due. Any write before then takes them along.
const later = new Set<any>();
let laterTimer = null;
let laterAt = Infinity;
function writeWithin(ms) {
  const at = performance.now() + ms; // a clock that only runs forward, as the timer's
  if (laterTimer && laterAt <= at) return;
  clearTimeout(laterTimer);
  laterAt = at;
  laterTimer = setTimeout(() => {
    dropLater();
    write([]);
  }, ms);
}
// On their way now (the write that takes them is queued or under way).
function dropLater() {
  later.clear();
  clearTimeout(laterTimer);
  laterTimer = null;
  laterAt = Infinity;
}
// False if this copy doesn't own the state (any more): nothing was written.
async function flush() {
  if (role !== 'owner') return false;
  if (!unsaved.size || !cache) {
    writeMetaSoon();
    return true;
  }
  if ((await recheck()) !== 'owner') return false; // a newer copy took over meanwhile
  const keys = [...unsaved];
  unsaved.clear();
  dropLater();
  // The changes' times for Margin.app's queue, now; written a moment later.
  trackKeys(keys);
  writeMetaSoon();
  try {
    // The icons' mark in a set() of its own, once the icons are stored: Safari
    // writes one set()'s keys in no set order and stops at the first that
    // fails, so a new mark could land over the old icons, and a page holding
    // them would never read the new ones (shared/stored.ts readForPage).
    const { [FAVICONS_MARK]: mark, ...values } = toStorage(cache, keys, { origin: me.origin, since: me.since, synced });
    await api.storage.local.set(values);
    // A switch's line in the log (background/switch-log.ts): its tab in front, stored.
    switchLog.stored(Object.values(cache?.tabs ?? {}).filter((t) => t?.active).map((t) => t.id));
    // Through once the icons' mark is too (a page that read before it would
    // keep the old icons).
    if (mark !== undefined) await api.storage.local.set({ [FAVICONS_MARK]: mark });
    retryMs = 250;
  } catch (err) {
    console.warn('[margin] saving', keys.join(', '), `failed; trying again in ${retryMs}ms:`, err?.message ?? err);
    for (const key of keys) if (!unsaved.has(key)) unsaved.add(key);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => write([]), retryMs);
    retryMs = Math.min(retryMs * 2, 5000);
  }
  return true;
}

// Serialize every read-modify-write so concurrent tab events can't clobber
// each other, and persist only the keys that changed. Not in a copy that
// doesn't own the storage: nothing runs, the state stays as it is.
// `within(state)`: ms the write may wait (null: none), from the state before
// the change. The change is in the state at once, in order with every other,
// and written within that time, or sooner with any write made before then
// (background/tab-updates.ts: a hidden tab's title and address, gathered).
// Every page hears each write (storage.onChanged), so fewer are cheaper.
export function mutate(fn: (state: State) => State | void | Promise<State | void>, { within }: { within?: (state: State) => number | null } = {}): Promise<State> {
  const run = queue.then(async () => {
    const prev = await load();
    if (role !== 'owner') return prev;
    const wait = within?.(prev) ?? null;
    const next = (((await fn(prev)) ?? prev) as State);
    // Changed by value: a tab event with nothing new (a page that finished
    // loading again, the same title) rebuilds its records, but isn't written.
    // A real change still goes through flush, which asks first whether this
    // copy still owns the state.
    const changed = M.STATE_KEYS.filter((key) => !sameStored(next[key], prev[key]));
    cache = next;
    if (wait != null && wait > 0) {
      // A key with a change already on its way (a failed write to try again)
      // stays so.
      for (const key of changed) {
        if (!unsaved.has(key)) later.add(key);
        unsaved.add(key);
      }
      if (changed.length) writeWithin(wait);
      return next;
    }
    // Nothing new, and nothing on its way but changes that can wait: they
    // still wait.
    if (!changed.length && [...unsaved].every((key) => later.has(key))) return next;
    for (const key of changed) {
      later.delete(key);
      unsaved.add(key);
    }
    // A newer copy took over while this change was made: it wasn't written,
    // so it fails (auto-archive doesn't close tabs it couldn't archive; a
    // page is told: background.ts).
    if (!(await flush())) throw new StaleError();
    return next;
  });
  queue = run.catch((err) => { if (!(err instanceof StaleError)) console.error('[margin]', err); });
  return run;
}
export class StaleError extends Error {
  constructor() {
    super('a newer copy of Margin is running');
  }
}

export const newId = () => crypto.randomUUID().slice(0, 8);
export const now = () => Date.now();

// A browser restart gives every tab and window a new id. storage.session is
// cleared on restart, so an empty one means "fresh"; without it we fall back
// to runtime.onStartup.
async function isFreshSession() {
  if (!api.storage.session) return false;
  const { alive } = await api.storage.session.get('alive');
  if (alive) return false;
  await api.storage.session.set({ alive: true });
  return true;
}

// Safari's open tabs, asked by a sync (a question of its own: what changed
// since is in it), and the question under way, if any: a switch looking for
// its tab by address before the first sync (tabs.ts resolveTab) takes that
// one rather than queueing a second behind it, on a Safari slow after a
// relaunch.
let openAsked: Promise<any[]> | null = null;
function askOpenTabs() {
  const asking = Promise.resolve().then(() => api.tabs.query({}));
  openAsked = asking;
  const over = () => { if (openAsked === asking) openAsked = null; };
  asking.then(over, over);
  return asking;
}
export const openTabsAsked = () => openAsked ?? askOpenTabs();
// `onSync({ state, renumbered, fresh, tabs })`: told after the sync (in the queue), with Safari's open tabs.
// Any sync that went through lets pages trust the stored tabs (markSynced).
export function resync({ fresh, onSync }: { fresh?: boolean, onSync?: (sync: { state: State, renumbered: boolean, fresh: boolean, tabs: any[] }) => void } = {}) {
  return mutate(async (s) => {
    const tabs = await askOpenTabs();
    const isFresh = fresh ?? (await isFreshSession());
    const next = M.syncTabs(s, tabs, { fresh: isFresh, now: now() });
    onSync?.({ state: next, renumbered: M.isRenumbered(s, tabs, { fresh: isFresh }), fresh: isFresh, tabs });
    return next;
  }).then(async (next) => {
    await markSynced();
    return next;
  });
}
