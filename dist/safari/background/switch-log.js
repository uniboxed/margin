// Each switch Margin makes, as one line in Margin.app's log (background/link.js
// note → the extension handler → the system log: npm run log:app), so a switch
// that misbehaves in Tirth's Safari can be read from the log alone (Margin 2
// Phase 2 step 8). Low noise: one line per switch, written once it's over:
//
//   switch to tab 412 (activateTab, window 3): asked +0, tabs.update +1,
//   updated +18, onActivated +19, stored +64, delta out +81 ms
//
// - asked: the request reached the background (focusTab).
// - tabs.update / updated: the call went out, and Safari answered it.
// - onActivated: Safari's event for the tab (background.js), how many
//   activations the window heard meanwhile if more than one (an extra one
//   is something else switching too: the user, Safari).
// - stored: the state with the tab in front written (store.js), which pages
//   and the app draw from; delta out: that change sent to Margin.app (link.js)
//   — the overlay's highlight follows the state from there.
// - a step that went wrong says so (`failed: <why>`); one that never came by
//   DONE_MS is left out, and the line says what it waited for.
// No titles or addresses: tab and window ids only.

const DONE_MS = 3000;
/** @type {((line: string) => void) | null} */
let sink = null;
/** Where the lines go (background.js: the link's note). @param {(line: string) => void} fn */
export function switchLogTo(fn) {
  sink = fn;
}

/** @typedef {{ tabId: number, source: string, windowId: number | null, at: number, steps: [string, number][], activations: number, failed: string | null, timer: any, done: boolean }} Entry */
/** @type {Map<number, Entry>} tabId → the switch to it under way */
const open = new Map();
const lines = []; // the last few, for tests

function finish(/** @type {Entry} */ e, why = '') {
  if (e.done) return;
  e.done = true;
  clearTimeout(e.timer);
  if (open.get(e.tabId) === e) open.delete(e.tabId);
  const steps = e.steps.map(([what, t]) => `${what} +${t - e.at}`).join(', ');
  const extra = [e.activations > 1 ? `${e.activations} activations heard` : '', e.failed ? `failed: ${e.failed}` : '', why].filter(Boolean).join('; ');
  const line = `switch to tab ${e.tabId} (${e.source}${e.windowId != null ? `, window ${e.windowId}` : ''}): ${steps} ms${extra ? `; ${extra}` : ''}`;
  lines.push(line);
  if (lines.length > 20) lines.shift();
  try { sink?.(line); } catch {}
}

const has = (/** @type {Entry} */ e, what) => e.steps.some(([w]) => w === what);

export const switchLog = {
  /** A switch asked for (focusTab). @param {number} tabId @param {string} source @param {number | null} windowId */
  begin(tabId, source, windowId) {
    const prior = open.get(tabId);
    if (prior) finish(prior, 'another switch to it asked');
    /** @type {Entry} */
    const e = { tabId, source, windowId, at: Date.now(), steps: [['asked', Date.now()]], activations: 0, failed: null, timer: null, done: false };
    e.timer = setTimeout(() => finish(e, `no ${!has(e, 'onActivated') ? 'onActivated' : !has(e, 'stored') ? 'stored state' : 'delta'} within ${DONE_MS} ms`), DONE_MS);
    open.set(tabId, e);
    return {
      step: (/** @type {string} */ what) => { if (!e.done) e.steps.push([what, Date.now()]); },
      window: (/** @type {number | null} */ id) => { if (id != null) e.windowId = id; },
      fail: (/** @type {any} */ err) => { e.failed = String(err?.message ?? err); finish(e); },
    };
  },
  /** Safari's onActivated for a tab (background.js). @param {number} tabId @param {number} windowId */
  activated(tabId, windowId) {
    for (const e of open.values()) if (e.windowId === windowId || e.windowId == null) e.activations++;
    const e = open.get(tabId);
    if (e && !has(e, 'onActivated')) e.steps.push(['onActivated', Date.now()]);
  },
  /** The state with these tabs in front written (store.js). @param {number[]} tabIds */
  stored(tabIds) {
    for (const id of tabIds) {
      const e = open.get(id);
      if (e && has(e, 'onActivated') && !has(e, 'stored')) e.steps.push(['stored', Date.now()]);
    }
  },
  /** The open tabs sent to Margin.app as a delta (link.js); not linked: the line ends at stored. @param {boolean} sent */
  delta(sent) {
    for (const e of [...open.values()]) {
      if (!has(e, 'onActivated')) continue;
      if (!has(e, 'stored')) e.steps.push(['stored', Date.now()]); // (its write's event came first)
      if (sent) e.steps.push(['delta out', Date.now()]);
      finish(e, sent ? '' : 'not linked');
    }
  },
  /** For tests: the last lines. */
  lines: () => [...lines],
};
