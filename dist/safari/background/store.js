// Margin's state: storage.local, read through load() (the worker can be
// unloaded at any time, so nothing lives only in memory) and changed through
// mutate(). Only the copy of Margin that owns the storage writes it
// (shared/owner.js): an older copy still running beside a newer one reads,
// never writes.
import * as M from '../state/model.js';
import * as O from '../shared/owner.js';
import { OPEN_TABS, OPEN_TABS_KEYS, fromStorage, openTabsCurrent, storedName, toStorage } from '../shared/stored.js';
import { recordEmptyStart } from './diagnostics.js';
/** @import { State } from '../../types/margin' */

export const api = globalThis.browser ?? globalThis.chrome;

/** @type {State | null} */
let cache = null;
/** @type {Promise<State> | null} */
let loading = null;
/** @type {Promise<unknown>} */
let queue = Promise.resolve();

// The state if it's loaded already (no wait), else null.
export const cached = () => cache;

// ---- which copy owns the storage (shared/owner.js) ---------------------------
// This copy: its address, and its first background start (storage.session
// lasts as long as the copy, across its background's restarts).
const me = { origin: api?.runtime?.getURL?.('') ?? '', since: 0 };
/** @type {'owner' | 'stale' | null} */
let role = null;
/** @type {Promise<'owner' | 'stale'> | null} */
let deciding = null;
// Settles once this copy knows whether it owns the storage (at most once per
// background start; every listener waits for it).
export const decided = () => (deciding ??= decide());
export const isOwner = () => role === 'owner';
// Whether the stored tabs are this copy's, matched to the open tabs (its
// background starting again within the same copy: nothing to wait for).
export const isSynced = () => role === 'owner' && synced;
async function decide() {
  const session = api.storage.session ? await api.storage.session.get('since').catch(() => null) : null;
  const { owner, [OPEN_TABS]: open } = await api.storage.local.get(['owner', OPEN_TABS]);
  if (Number.isFinite(session?.since)) me.since = session.since;
  // Without storage.session a restart can't be told from the copy's first
  // start: the record stands if it's this address.
  else if (!api.storage.session && owner?.origin === me.origin && Number.isFinite(owner.since)) me.since = owner.since;
  else {
    me.since = Date.now();
    await api.storage.session?.set({ since: me.since }).catch(() => {});
  }
  const decision = await settle(owner, open);
  // This copy's background starting again: the stored tabs are already its
  // own, matched (shared/stored.js), unless it stopped before that.
  if (decision === 'owner' && O.ownership(owner, me) === 'own') synced = openTabsCurrent(open, me.origin);
  return decision;
}
// The stored owner says what this copy is. Copies don't hear each other's
// storage writes (checked in WebKit), so a copy that owned the state finds out
// a newer one took over when it next writes (flush) or a page says hello
// (recheck).
// Copies don't hear each other's writes, so when it claims, the stored
// tabs are marked unmatched at once, in the same write (`open`: as read):
// pages then wait for this copy's first sync (shared/stored.js).
async function settle(stored, open = null) {
  const decision = O.ownership(stored, me);
  if (decision === 'stale') {
    if (role !== 'stale') console.info('[margin] a newer copy of Margin is running: this one stays out of the way');
    role = 'stale';
    return role;
  }
  role = 'owner';
  if (decision === 'claim') {
    synced = false;
    await api.storage.local.set({ owner: { ...me }, ...(open?.synced ? { [OPEN_TABS]: { ...open, synced: false } } : {}) });
    // The envelope a development build kept (workspace, workspaceBackup):
    // nothing reads it.
    void Promise.resolve().then(() => api.storage.local.remove(['workspace', 'workspaceBackup'])).catch(() => {});
  }
  return role;
}
// Whether this copy still owns the state (another may have claimed it since).
export async function recheck() {
  if (role !== 'owner') return role;
  const { owner } = await api.storage.local.get('owner').catch(() => ({ owner: null }));
  if (owner && owner.origin !== me.origin) await settle(owner);
  return role;
}
// Once the open tabs are matched to the state (the first sync), pages may
// trust the stored tabs: they're written again, marked so (shared/stored.js).
let synced = false;
export async function markSynced() {
  if (synced || role !== 'owner') return;
  synced = true;
  await write(OPEN_TABS_KEYS);
}

// ---- reading and writing ---------------------------------------------------------

/** @returns {Promise<State>} */
export function load() {
  if (cache) return Promise.resolve(cache);
  loading ??= read().finally(() => { loading = null; });
  return loading;
}
async function read() {
  await decided();
  const names = M.STATE_KEYS.map(storedName);
  // The old names too, for a first start after an update (shared/stored.js).
  const raw = await api.storage.local.get([...new Set([...names, ...M.STATE_KEYS])]);
  const next = M.normalizeState(fromStorage(raw));
  // First run: persist defaults so readers (content scripts) see a full state.
  const missing = M.STATE_KEYS.filter((key) => !(storedName(key) in raw));
  if (!('spaces' in raw) && role === 'owner') {
    console.info('[margin] storage was empty at start (a first install, or Safari cleared Margin\'s data): starting from the open tabs');
    recordEmptyStart();
  }
  // Saved under another build's default shortcuts (normalizeShortcuts moved
  // them): save, so pages, which read storage directly, use the new ones.
  if (raw.settings && raw.settings.shortcutDefaults !== next.settings.shortcutDefaults) missing.push('settings');
  // Removed settings to drop, or theme settings to fill in or move (a saved
  // top-level sidebarWidth became Arcadium's): save, for the same reason.
  else if (raw.settings && ('searchEngine' in raw.settings || 'sidebarWidth' in raw.settings || !raw.settings.themes || raw.settings.theme !== next.settings.theme)) missing.push('settings');
  cache ??= next;
  if (missing.length) write(missing);
  return cache;
}

// Keys whose write failed (Safari's storage can be busy: SQLite error 5 in
// Tirth's log while two copies wrote at once): written again shortly, and
// with the next write. The cache keeps the change meanwhile.
const unsaved = new Set();
let retryTimer = null;
let retryMs = 250;
// Writes `keys` from the cache, queued behind the state's other writes.
function write(keys) {
  for (const key of keys) unsaved.add(key);
  queue = queue.then(flush);
  return queue;
}
async function flush() {
  if (!unsaved.size || role !== 'owner' || !cache) return;
  if ((await recheck()) !== 'owner') return; // a newer copy took over meanwhile
  const keys = [...unsaved];
  unsaved.clear();
  try {
    await api.storage.local.set(toStorage(cache, keys, { origin: me.origin, synced }));
    retryMs = 250;
  } catch (err) {
    console.warn('[margin] saving', keys.join(', '), `failed; trying again in ${retryMs}ms:`, err?.message ?? err);
    for (const key of keys) if (!unsaved.has(key)) unsaved.add(key);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => write([]), retryMs);
    retryMs = Math.min(retryMs * 2, 5000);
  }
}

// Serialize every read-modify-write so concurrent tab events can't clobber
// each other, and persist only the keys that changed. Not in a copy that
// doesn't own the storage: nothing runs, the state stays as it is.
/** @param {(state: State) => State | void | Promise<State | void>} fn @returns {Promise<State>} */
export function mutate(fn) {
  const run = queue.then(async () => {
    const prev = await load();
    if (role !== 'owner') return prev;
    const next = /** @type {State} */ ((await fn(prev)) ?? prev);
    const changed = M.STATE_KEYS.filter((key) => next[key] !== prev[key]);
    cache = next;
    for (const key of changed) unsaved.add(key);
    await flush();
    return next;
  });
  queue = run.catch((err) => console.error('[margin]', err));
  return run;
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

// `onSync({ state, renumbered, fresh })`: told after the sync (in the queue).
/** @param {{ fresh?: boolean, onSync?: (sync: { state: State, renumbered: boolean, fresh: boolean }) => void }} [options] */
export function resync({ fresh, onSync } = {}) {
  return mutate(async (s) => {
    const tabs = await api.tabs.query({});
    const isFresh = fresh ?? (await isFreshSession());
    const next = M.syncTabs(s, tabs, { fresh: isFresh, now: now() });
    onSync?.({ state: next, renumbered: M.isRenumbered(s, tabs, { fresh: isFresh }), fresh: isFresh });
    return next;
  });
}
