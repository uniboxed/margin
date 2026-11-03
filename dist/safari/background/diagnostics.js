// DEVELOPMENT DIAGNOSTICS: remove before release (with the start page's
// "Switch log" button).
// A log of tab switches, to measure what the black-frame work does in real
// Safari: each switch Margin makes (what asked, how the wake went, how long
// until the tab was in front). Kept in the
// background's IndexedDB: it outlives the background's sleeps, and unlike
// storage it notifies no page. The last MAX_ENTRIES are kept.
const DB_NAME = 'margin-diagnostics';
const STORE = 'switches';
const MAX_ENTRIES = 300;

/** @type {Promise<IDBDatabase> | null} */
let db = null;
function open() {
  db ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { autoIncrement: true });
    request.onsuccess = () => {
      const opened = request.result;
      // Closed under us (by the browser): open again next time.
      opened.onclose = opened.onversionchange = () => {
        opened.close();
        db = null;
      };
      resolve(opened);
    };
    request.onerror = () => reject(request.error);
  });
  db.catch(() => { db = null; });
  return db;
}

const done = (/** @type {IDBTransaction} */ tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve(undefined);
  tx.onerror = tx.onabort = () => reject(tx.error);
});

let writes = Promise.resolve();
/** @type {((entry: Record<string, unknown>) => void) | null} */
let tap = null; // for tests: each entry as it's recorded
/** @param {((entry: Record<string, unknown>) => void) | null} fn */
export function tapLog(fn) {
  tap = fn;
}
/** @param {Record<string, unknown>} entry */
function record(entry) {
  tap?.(entry);
  if (!globalThis.indexedDB) return;
  writes = writes.then(async () => {
    const tx = (await open()).transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.add({ at: Date.now(), ...entry });
    // Trim the oldest past the cap (in request callbacks: no awaits inside a
    // transaction, which WebKit may commit in between).
    const count = store.count();
    count.onsuccess = () => {
      let extra = count.result - MAX_ENTRIES;
      if (extra <= 0) return;
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        if (!cursor.result || extra-- <= 0) return;
        cursor.result.delete();
        cursor.result.continue();
      };
    };
    await done(tx);
  }).catch(() => {});
}

/** A switch Margin made (background/tabs.js focusTab, background/navigation.js). */
/** `ready`: what a wait for a page loading behind ended on ('painted', 'loaded', or why it stopped); `unseen`: the tab was introduced because its page started visible and hadn't come into view from hidden since (background/tabs.js mayIntroduce); `barrier`: each paint barrier before the show, [{ how: 'drawn' | 'timeout' | 'none', ms }] (background/tabs.js paintBarrier); `heldAtAsk`: keep-ready held the tab as the switch was asked for; `hiddenForMs`: since it was last left (null: not known to this background); the preparation's `timings`: where the page's time went (content/core.js prepareForShow: lagMs from the call to the page running it, then readMs, renderMs, catchUpMs, layoutMs, and `known`: 1 when it drew from the state it had, without reading storage, as it knew the state's last write, and `revSent`: 1 when the background passed it one, 0 while a write was waiting or under way (background/store.js stateRev)); a preparation's `reason` 'awake budget': past PREPARE_AWAKE_MS for a tab whose wake answered (background/tabs.js awakeBudget); `kicked`: the tab, its wake stuck (Safari had likely suspended it), was brought to the front and straight back first, { at: ms from the ask, kickMs: Safari's answer to its two updates (well over ~110 ms: WebKit held the window for its page to draw), wakeMs: its new wake's answer, ms from that answer (null: none in time), outcome: 'resumed' | 'stuck' | …, behind: true when its wake had answered, but late: resumed behind, its content still hidden } (background/tabs.js kickTab, resumedBehind); `stuck`: its wake was not waited for (no answer in time): shown at once, its preparation called off (a kicked tab found loading, its page gone, is waited for behind the page instead: `loadWait`); `committed`: for a tab waited for behind the page (`restored`, `loadWait`), ms from the ask to its own document's first answer (null: none came, and it was shown with no document: Safari's empty view until it commits; background/tabs.js waitLoaded). */
export function recordSwitch({ source, tabId, asked, heldAtAsk = null, hiddenForMs = null, wake = null, preparation = null, introduced = null, unseen = null, kicked = null, stuck = null, restored = null, loadWait = null, committed = null, ready = null, barrier = null, shownAfter = null, error = null }) {
  record({
    kind: 'switch', source, tabId, heldAtAsk, hiddenForMs, introduced, unseen, kicked, stuck, restored, loadWait, committed, ready, barrier,
    wake: wake && { outcome: wake.outcome, ms: wake.ms, early: wake.startedAt < asked ? asked - wake.startedAt : 0 },
    preparation: preparation && { outcome: preparation.outcome, ms: preparation.ms, reason: preparation.reason ?? null, ...(preparation.timings ? { timings: preparation.timings } : {}) },
    waited: wake ? Math.max(0, wake.startedAt + wake.ms - asked) : 0,
    shownAfter, error,
  });
}

/** A background start that found storage empty (a first install, or Safari cleared Margin's data: seen at every relaunch of an unsigned build). */
export function recordEmptyStart() {
  record({ kind: 'start', emptyStorage: true });
}

/** A tab as Safari reports it when created (background/newtab-hint.js relies on openerTabId and index). */
export function recordCreated(tab) {
  record({
    kind: 'created', tabId: tab.id, active: !!tab.active, opener: tab.openerTabId ?? null, index: tab.index,
    scheme: String(tab.pendingUrl || tab.url || '').split(':')[0],
  });
}

/** Everything kept, oldest first. */
export async function readLog() {
  if (!globalThis.indexedDB) return [];
  await writes;
  const tx = (await open()).transaction(STORE, 'readonly');
  return new Promise((resolve) => {
    const request = tx.objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve([]);
  });
}

export async function clearLog() {
  if (!globalThis.indexedDB) return;
  await writes;
  const tx = (await open()).transaction(STORE, 'readwrite');
  tx.objectStore(STORE).clear();
  await done(tx);
}
