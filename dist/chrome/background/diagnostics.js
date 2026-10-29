// DEVELOPMENT DIAGNOSTICS: remove before release (with the start page's
// "Switch log" button and the shell's `shellShown` report).
// A log of tab switches, to measure what the black-frame work does in real
// Safari: each switch Margin makes (what asked, how the wake went, how long
// until the tab was in front), and how each page that was just shown came on
// screen (content/shell.js: why it was released and when). Kept in the
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
/** @param {Record<string, unknown>} entry */
function record(entry) {
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
export function recordSwitch({ source, tabId, asked, wake = null, preparation = null, introduced = null, restored = null, loadWait = null, shownAfter = null, error = null }) {
  record({
    kind: 'switch', source, tabId, introduced, restored, loadWait,
    wake: wake && { outcome: wake.outcome, ms: wake.ms, early: wake.startedAt < asked ? asked - wake.startedAt : 0 },
    preparation: preparation && { outcome: preparation.outcome, ms: preparation.ms, reason: preparation.reason ?? null },
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

/** How a page that was just shown came on screen (content/shell.js via handlers.js). */
export function recordShown(entry) {
  record({ kind: 'shown', ...entry });
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
