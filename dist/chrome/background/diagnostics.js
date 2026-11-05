// DEVELOPMENT DIAGNOSTICS: remove before release (with the start page's
// "Switch log" button).
// A log of what Margin did that matters for checking it in real Safari (a
// pass of the open-tab repair, sleeping tabs, tabs as Safari made them; each
// switch is a line in Margin.app's log instead: background/switch-log.js). Kept in the
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

/** A pass of the repair of the open tabs (background/tabs.js injectIntoOpenTabs): how many tabs there were, how many it asked, how many of those had no page, and how long it gave way to switches. */
export function recordRepair({ pass, tabs, asked, noPage, gaveWayMs, ms }) {
  record({ kind: 'repair', pass, tabs, asked, noPage, gaveWayMs, ms });
}

/** Sleeping tabs (background/sleep.js): `step` 'run' (a pass: `due`, the tabs long enough unused; `slept`; `skipped`, how many for each reason { [why]: count }; `stopped`, why the pass ended early, if it did; `ms`), 'slept' (`tabId`, `how`: 'page' | 'discard', `idleMin` since its last use), or 'woke' (`tabId`, `by`: 'switch' (Margin's, loaded behind the page: `restored` as a switch's), 'shown' (Safari's own show, or its page shown otherwise), 'all' (Settings' "Wake all"); `how`: 'address' (sent to its page's address), 'flip' (shown for an instant: its sleep page sent it back), 'reload' (Chrome)). */
export function recordSleep(entry) {
  record({ kind: 'sleep', ...entry });
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
