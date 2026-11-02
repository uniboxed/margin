// Margin's state: storage.local, read through load() (the worker can be
// unloaded at any time, so nothing lives only in memory) and changed through
// mutate(). Only the copy of Margin that owns the storage writes it
// (shared/owner.js): an older copy still running beside a newer one reads,
// never writes.
import * as M from '../state/model.js';
import * as O from '../shared/owner.js';
import { FAVICONS, FAVICONS_MARK, OPEN_TABS, OPEN_TABS_KEYS, fromStorage, openTabsCurrent, sameStored, storedName, toStorage } from '../shared/stored.js';
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
// This copy (for pages' requests: whose tab ids they hold, background/tabs.js).
export const thisCopy = () => ({ origin: me.origin, since: me.since });
async function decide() {
  for (let tries = 0; ; tries++) {
    try {
      return await decideOnce();
    } catch (err) {
      if (tries >= 3) throw err;
      console.warn('[margin] reading who owns the state failed; trying again:', err?.message ?? err);
      await new Promise((resolve) => setTimeout(resolve, 150 * 3 ** tries));
    }
  }
}
async function decideOnce() {
  // A failed read isn't a first start (that would make this copy the newest).
  const session = api.storage.session ? await api.storage.session.get('since') : null;
  const { owner, [OPEN_TABS]: open } = await api.storage.local.get(['owner', OPEN_TABS]);
  // Whether this is the copy's first start (not its background waking): only
  // then may it claim a record from a clock that was ahead (shared/owner.js).
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
  // own, matched (shared/stored.js), unless it stopped before that.
  if (decision === 'owner' && own) synced = openTabsCurrent(open, me.origin, me.since);
  return decision;
}
// The stored owner says what this copy is. Copies don't hear each other's
// storage writes (checked in WebKit), so a copy that owned the state finds out
// a newer one took over when it next writes (flush), a page says hello, or
// an event reaches it (recheckSoon). When it claims, the stored tabs are
// marked unmatched at once (`open`: as read): pages then wait for this copy's
// first sync (shared/stored.js). `back`: claimed back from an older copy that
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
    if (open?.synced) await api.storage.local.set({ [OPEN_TABS]: { ...open, synced: false } }).catch((err) => console.warn('[margin] marking the stored tabs unmatched failed:', err?.message ?? err));
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
/** @type {Promise<'owner' | 'stale' | null> | null} */
let checking = null;
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
    for (const key of OPEN_TABS_KEYS) unsaved.add(key);
    void write([]);
  }
  return role;
}
// The same, at most once a second (before a listener runs: background.js
// owned). While a check is under way, every caller waits for it: events then
// go on in the order they came.
let checkedAt = 0;
export const recheckSoon = () => checking ?? (role === 'owner' && Date.now() - checkedAt > 1000 ? recheck() : Promise.resolve(role));
// Once the open tabs are matched to the state (a sync), pages may trust the
// stored tabs: they're written again, marked so (shared/stored.js).
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
  const raw = await api.storage.local.get([...new Set([...names, ...M.STATE_KEYS, FAVICONS_MARK])]);
  const next = M.normalizeState(fromStorage(raw));
  // First run: persist defaults so readers (content scripts) see a full state.
  const missing = M.STATE_KEYS.filter((key) => !(storedName(key) in raw));
  // Icons kept by a build before their mark: written again with it, once, so
  // pages read them only when they change (shared/stored.js readForPage).
  if (FAVICONS in raw && !(FAVICONS_MARK in raw)) missing.push(FAVICONS);
  if (!('spaces' in raw) && role === 'owner') {
    console.info('[margin] storage was empty at start (a first install, or Safari cleared Margin\'s data): starting from the open tabs');
    recordEmptyStart();
  }
  // Saved under another build's default shortcuts (normalizeShortcuts moved
  // them): save, so pages, which read storage directly, use the new ones.
  if (raw.settings && raw.settings.shortcutDefaults !== next.settings.shortcutDefaults) missing.push('settings');
  // Removed settings to drop, or theme settings to fill in or move (a saved
  // top-level sidebarWidth became Arcadia's): save, for the same reason.
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
// False if this copy doesn't own the state (any more): nothing was written.
async function flush() {
  if (role !== 'owner') return false;
  if (!unsaved.size || !cache) return true;
  if ((await recheck()) !== 'owner') return false; // a newer copy took over meanwhile
  const keys = [...unsaved];
  unsaved.clear();
  try {
    // The icons' mark in a set() of its own, once the icons are stored: Safari
    // writes one set()'s keys in no set order and stops at the first that
    // fails, so a new mark could land over the old icons, and a page holding
    // them would never read the new ones (shared/stored.js readForPage).
    const { [FAVICONS_MARK]: mark, ...values } = toStorage(cache, keys, { origin: me.origin, since: me.since, synced });
    await api.storage.local.set(values);
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
/** @param {(state: State) => State | void | Promise<State | void>} fn @returns {Promise<State>} */
export function mutate(fn) {
  const run = queue.then(async () => {
    const prev = await load();
    if (role !== 'owner') return prev;
    const next = /** @type {State} */ ((await fn(prev)) ?? prev);
    // Changed by value: a tab event with nothing new (a page that finished
    // loading again, the same title) rebuilds its records, but isn't written.
    // A real change still goes through flush, which asks first whether this
    // copy still owns the state.
    const changed = M.STATE_KEYS.filter((key) => !sameStored(next[key], prev[key]));
    cache = next;
    for (const key of changed) unsaved.add(key);
    // A newer copy took over while this change was made: it wasn't written,
    // so it fails (auto-archive doesn't close tabs it couldn't archive; a
    // page is told: background.js).
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

// `onSync({ state, renumbered, fresh })`: told after the sync (in the queue).
/** @param {{ fresh?: boolean, onSync?: (sync: { state: State, renumbered: boolean, fresh: boolean }) => void }} [options] */
// Any sync that went through lets pages trust the stored tabs (markSynced).
export function resync({ fresh, onSync } = {}) {
  return mutate(async (s) => {
    const tabs = await api.tabs.query({});
    const isFresh = fresh ?? (await isFreshSession());
    const next = M.syncTabs(s, tabs, { fresh: isFresh, now: now() });
    onSync?.({ state: next, renumbered: M.isRenumbered(s, tabs, { fresh: isFresh }), fresh: isFresh });
    return next;
  }).then(async (next) => {
    await markSynced();
    return next;
  });
}
