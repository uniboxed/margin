// Which copy of Margin is in charge of its storage. Safari can keep an older
// copy of Margin running beside a newer one until it quits (after an update,
// or each rebuild in development): both see the same tabs, each under its own
// ids, and they share storage.local. Seen in Tirth's Safari: two copies wrote
// the same page as tab 6835 and as tab 4660, so pages listed tabs by ids
// their own copy didn't have, and switching to them failed. So one copy, the
// newest, owns the storage: it alone writes the state, and pages of the
// others stay out of the way (content/core.js). Pure: the background
// (background/store.js) and pages both use it.
//
// A copy is told apart by its address (runtime.getURL(''): every copy gets
// its own, and Safari gives each launch a new one) and when it started
// (`since`: its first background start, kept in its storage.session, which
// lasts as long as the copy). Storage key `owner`: { origin, since }. Whose
// the stored tab ids are, and whether they're matched to the open tabs yet,
// the tabs say themselves (shared/stored.js).

/** @typedef {{ origin: string, since: number }} Owner */

/** Whether copy `a` is newer than copy `b` (ties by address, so two copies never both claim). */
export function newer(/** @type {Owner} */ a, /** @type {Owner} */ b) {
  return a.since !== b.since ? a.since > b.since : a.origin > b.origin;
}

// A record from a copy whose clock was ahead (then set right) would keep
// every later copy out: one from the future beyond this is claimed by a copy
// starting (`now` given). Not by one already running: two copies would then
// claim from each other in turn (the older one over the future record, that
// one back over the older), so a running copy takes the record as it is.
const CLOCK_SLACK_MS = 60_000;

/**
 * What the copy `me` does, given the stored owner: 'own' (it's the owner),
 * 'claim' (it becomes the owner: none yet, or an older copy's record) or
 * 'stale' (a newer copy owns the storage). `now`: only when the copy starts.
 * @param {Owner | null | undefined} stored @param {Owner} me @param {number} [now]
 * @returns {'own' | 'claim' | 'stale'}
 */
export function ownership(stored, me, now) {
  if (!stored || typeof stored.origin !== 'string' || !Number.isFinite(stored.since)) return 'claim';
  if (stored.origin === me.origin) return stored.since === me.since ? 'own' : 'claim';
  if (now != null && stored.since > now + CLOCK_SLACK_MS) return 'claim';
  return newer(stored, me) ? 'stale' : 'claim';
}
