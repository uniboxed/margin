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
/** `ready`: what a wait for a page loading behind ended on ('painted', 'loaded', or why it stopped); `unseen`: the tab was introduced because its page started visible and hadn't come into view from hidden since (background/tabs.js mayIntroduce); `barrier`: each paint barrier before the show, [{ how: 'drawn' | 'timeout' | 'none', ms }] (background/tabs.js paintBarrier); `heldAtAsk`: keep-ready held the tab as the switch was asked for; `hiddenForMs`: since it was last left (null: not known to this background); the preparation's `timings`: where the page's time went (content/core.js prepareForShow: lagMs from the call to the page running it, then readMs, renderMs, catchUpMs, layoutMs, and `known`: 1 when it drew from the state it had, without reading storage, as it knew the state's last write, and `revSent`: 1 when the background passed it one, 0 while a write was waiting or under way (background/store.js stateRev)); a preparation's `reason` 'awake budget': past PREPARE_AWAKE_MS for a tab whose wake answered (background/tabs.js awakeBudget); `wakeStartedBy`: what started the wake a switch to a tab Safari may have suspended waited for ('hover', 'press', 'reveal', 'space', 'keys' or 'switch': background/tabs.js wakeTab), `wakeMs`: its page's answer, ms from the wake's start (null: none by the time the wait ended), `waitedOnOldPage`: ms from the ask to the wait's end, the page before on screen meanwhile, `wakeOutcome`: 'awake' (answered in time), 'resumed' (answered once its process was resumed: drawn before it was shown), 'capped' (no answer by 1.6 s: shown as it was, its preparation called off), 'no page', or 'left'/'hurried' (another switch, a key press); the wake's own `by` says what started it; `kicked`: the tab was brought to the front and the page in front straight back during that wait, for a foreground resume (background/tabs.js Kick: `at` from the ask, `kickMs` Safari's answer to the two updates, near 250 when WebKit held the window for the tab's paint, `wakeMs` the wake's answer from then, `outcome`; on a switch forced at its deadline too); `committed`: for a tab waited for behind the page (`restored`, `loadWait`), ms from the ask to its own document's first answer (null: none came, and it was shown with no document: Safari's empty view until it commits; background/tabs.js waitLoaded). `restoreStart`: how a tab restored behind was found loading ('loading': Safari said so; 'ran': a script ran in its own document; 'waiting': a script hadn't answered in time, so Safari's 'complete' wasn't taken as loaded until it was seen loading or its document answered: background/tabs.js loadStarted); `plain`: shown as it was without its steps ('tab': Safari too slow to say where it was, 'late': asked with no time left for them, within its page's grace: background/tabs.js focusTab); `slow`: the switch found Safari or the Mac slow, { what, ms, ago, own, sources }: the last sign, `own` if it was one of the switch's own calls, and how many sources counted then (background/slow.js: the switch then shows its tab soon after the ask, a restore behind the page cut short, `restored: 'cut'`); `before`: a timed request's way to its switch (background.js): `left`, ms of its page's wait left as it arrived, `waited`, ms from then to focusTab, and of those `decided`, `sync` (the first sync) and `resolve` (its tab's lookup). `markReason`: why it was or wasn't introduced (background/tabs.js WebKit's mark): 'proven:<how>' (introduced, kicked, shown, inView: not introduced), 'unproven', 'never shown', 'loaded behind' (introduced), each with ':skipped:<why>' after when it needed an introduction and didn't get one ('capped', 'cut', 'no room', 'off', 'left', 'no page', 'window busy', …). `layersBack`: whether the show waited for the tab's layers ('barrier': its page drew since its wake, flip or kick; 'timeout': it ran out of time for that; 'skipped:<why>': not waited for, 'running' when its page answered its wake with its process running, nothing to wait for, or 'capped', 'forced', 'plain-tab', 'plain-late', 'passing', 'no page', …). */
export function recordSwitch({ source, tabId, asked, heldAtAsk = null, hiddenForMs = null, wake = null, preparation = null, introduced = null, unseen = null, markReason = null, layersBack = null, wakeStartedBy = null, wakeMs = null, waitedOnOldPage = null, wakeOutcome = null, kicked = null, restored = null, restoreStart = null, loadWait = null, committed = null, ready = null, barrier = null, shownAfter = null, error = null, stuckAt = null, forced = null, unconfirmed = null, before = null, plain = null, slow = null, pageWaitedMs = null, flip = null, drewVisible = null, gate = null, showMs = null, hurried = null, cutOff = null }) {
  record({
    kind: 'switch', source, tabId, heldAtAsk, hiddenForMs, introduced, unseen, markReason, layersBack, wakeStartedBy, wakeMs, waitedOnOldPage, wakeOutcome, restored, ...(restoreStart ? { restoreStart } : {}), loadWait, committed, ready, barrier,
    // Held to its page's deadline (background/tabs.js focusTab): the step it
    // was stuck at, whether it was shown as it was then, and whether Safari
    // hadn't answered its show by the time the page was answered.
    // (`pageWaitedMs`: how much of that it spent waiting for the tab's own
    // page, left out of the plan for a slow Safari.)
    ...(stuckAt ? { stuckAt, forced, unconfirmed, ...(pageWaitedMs != null ? { pageWaitedMs } : {}) } : {}),
    ...(kicked ? { kicked } : {}),
    // A timed request's way to its switch (background.js): what was left of
    // its page's wait as it came, and what it waited for before focusTab.
    ...(before ? { before } : {}),
    // Shown as it was, without its steps (`plain`), and what showed Safari
    // slow (background/slow.js), if it was.
    ...(plain ? { plain } : {}),
    ...(slow ? { slow } : {}),
    // (2026-11-04) A flip in this switch, Safari's answer to each of its two
    // updates (ms from when it went out); when its page drew after it, by its
    // own word (ms from then: background/tabs.js S2); the show's wait for its
    // page (`gate`: how it ended, each ping's time and what the page said of
    // its visibility, a call about no page to tell a slow Safari, PINGS_MAX at most); Safari's answer to the show
    // (`showMs`); a show given up for a later key press (`hurried`); the
    // switch's cut-off probe.
    ...(flip ? { flip } : {}),
    ...(drewVisible != null ? { drewVisible } : {}),
    ...(gate ? { gate } : {}),
    ...(showMs != null ? { showMs } : {}),
    ...(hurried ? { hurried } : {}),
    ...(cutOff != null ? { cutOff } : {}),
    wake: wake && { outcome: wake.outcome, ms: wake.ms, early: wake.startedAt < asked ? asked - wake.startedAt : 0, by: wake.by ?? null },
    preparation: preparation && { outcome: preparation.outcome, ms: preparation.ms, reason: preparation.reason ?? null, ...(preparation.timings ? { timings: preparation.timings } : {}) },
    waited: wake ? Math.max(0, wake.startedAt + wake.ms - asked) : 0,
    shownAfter, error,
  });
}

/** A pass of the repair of the open tabs (background/tabs.js injectIntoOpenTabs): how many tabs there were, how many it asked, how many of those had no page, and how long it gave way to switches. */
export function recordRepair({ pass, tabs, asked, noPage, gaveWayMs, ms }) {
  record({ kind: 'repair', pass, tabs, asked, noPage, gaveWayMs, ms });
}

/** The warm-up after a relaunch (background/warm-up.js): `step` 'plan' (the tabs picked, `candidates` [{ tabId, why }], and the `evidence` it was a relaunch: { noPage, withPage, update }), 'not relaunch' (the same evidence), 'tab' (`tabId`, `why` it was picked: 'recent' | 'space' | 'pinned'; `waitedMs` from the step before to its flip; `outcome`: the restore's 'painted' | 'loaded' | 'loading' | 'not loaded' | 'in front' | 'left' | 'hurried' | 'gone' | 'cut', 'not tried', or 'skipped: <why>'; `ms` from its flip to its end; `restoreStart`, `committed` as a switch's), or 'end' (`why`, `done`, `total`, `ms` from its start; `waits`: what it waited for and how often). */
export function recordWarmUp(entry) {
  record({ kind: 'warmUp', ...entry });
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
