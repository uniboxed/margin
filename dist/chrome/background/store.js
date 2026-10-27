// Margin's state: storage.local, read through load() (the worker can be
// unloaded at any time, so nothing lives only in memory) and changed through
// mutate().
import * as M from '../state/model.js';
/** @import { State } from '../../types/margin' */

export const api = globalThis.browser ?? globalThis.chrome;

/** @type {State | null} */
let cache = null;
/** @type {Promise<unknown>} */
let queue = Promise.resolve();

// The state if it's loaded already (no wait), else null.
export const cached = () => cache;

/** @returns {Promise<State>} */
export async function load() {
  if (cache) return cache;
  const raw = await api.storage.local.get(M.STATE_KEYS);
  cache = M.normalizeState(raw);
  // First run: persist defaults so readers (content scripts) see a full state.
  const missing = M.STATE_KEYS.filter((key) => !(key in raw));
  // Saved under another build's default shortcuts (normalizeShortcuts moved
  // them): save, so pages, which read storage directly, use the new ones.
  if (raw.settings && raw.settings.shortcutDefaults !== cache.settings.shortcutDefaults) missing.push('settings');
  // Removed settings to drop, or theme settings to fill in or move (a saved
  // top-level sidebarWidth became Arcadium's): save, for the same reason.
  else if (raw.settings && ('searchEngine' in raw.settings || 'sidebarWidth' in raw.settings || !raw.settings.themes || raw.settings.theme !== cache.settings.theme)) missing.push('settings');
  if (missing.length) await api.storage.local.set(Object.fromEntries(missing.map((key) => [key, cache[key]])));
  return cache;
}

// Serialize every read-modify-write so concurrent tab events can't clobber
// each other, and persist only the keys that changed.
/** @param {(state: State) => State | void | Promise<State | void>} fn @returns {Promise<State>} */
export function mutate(fn) {
  const run = queue.then(async () => {
    const prev = await load();
    const next = /** @type {State} */ ((await fn(prev)) ?? prev);
    const changes = {};
    for (const key of M.STATE_KEYS) if (next[key] !== prev[key]) changes[key] = next[key];
    cache = next;
    if (Object.keys(changes).length) await api.storage.local.set(changes);
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

// `onSync({ state, renumbered })`: told after the sync (in the queue).
/** @param {{ fresh?: boolean, onSync?: (sync: { state: State, renumbered: boolean }) => void }} [options] */
export function resync({ fresh, onSync } = {}) {
  return mutate(async (s) => {
    const tabs = await api.tabs.query({});
    const isFresh = fresh ?? (await isFreshSession());
    const next = M.syncTabs(s, tabs, { fresh: isFresh, now: now() });
    onSync?.({ state: next, renumbered: M.isRenumbered(s, tabs, { fresh: isFresh }) });
    return next;
  });
}
