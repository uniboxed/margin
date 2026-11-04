// Tabs not used for a while, put to sleep to free their memory (as Arc does):
// `settings.sleepAfterHours` (4; 0: never) since the tab was last used,
// except sites on `settings.neverSleepSites`. Safari keeps every tab's page
// process alive, however long it's been hidden (Tirth's 35 tabs: 16.5 GB),
// and gives extensions no tabs.discard (WebKit's extension engine has none,
// 2026-11-04). So in Safari the tab goes to Margin's sleep page (shared/
// sleep.js), whose address carries the page's: tabs.update, which gives the
// tab a web view of Margin's (an extension page's), so the page's own goes
// away with its process. Not location.replace from the page (no history
// entry): WebKit refuses a web page's own navigation to an extension page
// (NSURLErrorDomain -1008 in the WebKit host, 2026-11-04, with the page in
// web_accessible_resources; a fetch of it works). Shown, the sleep page goes
// back to the page's address with location.replace (no history entry for the
// sleep page). Chrome: tabs.discard.
//
// Which tabs (state/model.js sleepyTabs, then each tab as the browser has it
// now): a web page, not in front, not asleep already, not playing sound, not
// loading, not one Safari unloaded itself (nothing to free), not one a switch
// is going to or keep-ready holds, and, asked in the page itself (sleepInPage),
// hidden, nothing typed into it and not sent (content/edits.js), nothing
// playing; a page that doesn't answer in time is left for the next pass.
// Pinned tabs sleep too. A few per pass (PER_RUN), one at a time, none while
// a switch is asked for or under way, Safari is slow (slow.js), or the warm-up
// after a relaunch loads tabs. A pass runs with the auto-archive's (every 15
// minutes: background.js). Each pass, each tab put to sleep and each wake is
// in the switch log (`kind: 'sleep'`: diagnostics.js recordSleep).
//
// Margin keeps a sleeping tab as the page it was (state/model.js seenTab):
// its row, its title and icon, its space, its pin, its archive entry all go
// by the page's address. A switch of Margin's to one wakes it behind the page
// in front and shows it once it has loaded (background/tabs.js restoreTab).
import * as M from '../state/model.js';
import { api, cached, isOwner, load, now } from './store.js';
import { platform } from '../shared/platform.js';
import { isSleepPage, neverSleeps, sleepAddress } from '../shared/sleep.js';
import { foundWithNoPage, isFocusing, mayAccess, switchBusy, wakeAsleep } from './tabs.js';
import { hasNoPage, isHeld } from './keep-ready.js';
import { isSlow } from './slow.js';
import { warming } from './warm-up.js';
import { recordSleep } from './diagnostics.js';

// Times (tests shorten them: setSleepTiming).
const TIMING = {
  // Tabs put to sleep in one pass, at most (the rest wait for the next one).
  perRun: 5,
  // A page's answer, at most (then it's left for the next pass). A tab
  // unused for hours has a process Safari suspended: the script resumes it,
  // at background priority (a median 279 ms in Safari's log, seconds at worst).
  askMs: 3000,
  // Between two tabs.
  gapMs: 1000,
  // "Wake all": between two tabs.
  wakeGapMs: 250,
  // A pass on tab events, where there are no alarms: at most this often.
  throttleMs: 5 * 60_000,
};

// Executed in the tab's page, in Margin's content-script world (sent as
// source: self-contained). Whether the page may sleep as it is now: still
// `expected` (no other address since it was looked at), hidden, nothing
// playing, nothing typed and not sent (Margin's own watch, content/edits.js;
// a page without it, an earlier copy's or none, judged generously as
// content/takeover.js does: any text in a field or an editor). Not past
// `until` (the background no longer waits for the answer then).
/** @param {string} expected @param {number} until */
export function sleepInPage(expected, until) {
  try {
    if (Date.now() > until) return { ok: false, why: 'late' };
    if (document.visibilityState !== 'hidden') return { ok: false, why: 'shown' };
    if (location.href !== expected) return { ok: false, why: 'moved' };
    const playing = (/** @type {Document} */ doc) => [...doc.querySelectorAll('audio, video')].some((/** @type {any} */ el) => (!el.paused && !el.ended) || (typeof MediaStream !== 'undefined' && el.srcObject instanceof MediaStream));
    if (playing(document) || /** @type {any} */ (navigator).mediaSession?.playbackState === 'playing' || /** @type {any} */ (document).pictureInPictureElement || document.fullscreenElement) return { ok: false, why: 'playing' };
    const inUse = (/** @type {Document | null} */ doc, depth = 0) => {
      if (!doc || depth > 4) return false;
      for (const el of /** @type {any[]} */ ([...doc.querySelectorAll('textarea, input:not([type]), input[type=text], input[type=search], input[type=email], input[type=url], input[type=tel], input[type=number], input[type=password]')])) if (String(el.value ?? '').trim()) return true;
      for (const el of /** @type {any[]} */ ([...doc.querySelectorAll('[contenteditable]:not([contenteditable=false])')])) if (el.isContentEditable && String(el.textContent ?? '').trim()) return true;
      for (const el of /** @type {any[]} */ ([...doc.querySelectorAll('select')])) if ([...el.options].some((o) => o.selected !== o.defaultSelected)) return true;
      for (const el of /** @type {any[]} */ ([...doc.querySelectorAll('input[type=checkbox], input[type=radio]')])) if (el.checked !== el.defaultChecked) return true;
      for (const frame of /** @type {any[]} */ ([...doc.querySelectorAll('iframe, frame')])) {
        let inner = null;
        try {
          inner = frame.contentDocument;
        } catch {
          continue;
        }
        if (inUse(inner, depth + 1)) return true;
      }
      return false;
    };
    const own = /** @type {any} */ (globalThis).Margin?.content?.edits;
    let edited = null;
    try {
      edited = typeof own === 'function' ? own() : null;
    } catch {}
    const judged = typeof edited === 'boolean' ? 'margin' : 'page';
    if (typeof edited !== 'boolean') edited = inUse(document);
    if (edited) return { ok: false, why: 'edited', judged };
    return { ok: true, judged };
  } catch {
    return { ok: false, why: 'error' };
  }
}

// ---- a pass ----------------------------------------------------------------------
/** @typedef {{ due: number, slept: number, skipped: Record<string, number>, stopped: string | null }} Pass */
/** @type {Promise<Pass | null> | null} */
let running = null;
// A pass (one at a time). `afterMs`: tabs unused for this long instead of the
// setting's hours (a pass asked for by hand: the background's console,
// `margin.sleepNow(ms)`, or the WebKit host); `max`: in place of TIMING.perRun.
/** @param {{ afterMs?: number | null, max?: number }} [options] @returns {Promise<Pass | null>} */
export function sleepIdle(options = {}) {
  if (!platform?.sleepTabs) return Promise.resolve(null);
  return (running ??= run(options).finally(() => { running = null; }));
}
let lastRun = 0;
// Where there are no alarms: on tab events, at most every TIMING.throttleMs.
export function sleepIdleThrottled() {
  if (now() - lastRun < TIMING.throttleMs) return;
  lastRun = now();
  void sleepIdle();
}

/** @param {{ afterMs?: number | null, max?: number }} options @returns {Promise<Pass>} */
async function run({ afterMs = null, max = TIMING.perRun }) {
  const startedAt = Date.now();
  const s = await load();
  const due = M.sleepyTabs(s, now(), { afterMs });
  /** @type {Record<string, number>} */
  const skipped = {};
  const skip = (/** @type {string} */ why) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  let slept = 0;
  /** @type {string | null} */
  let stopped = null;
  for (const [i, record] of due.entries()) {
    if (slept >= max) {
      skip('next pass');
      continue;
    }
    stopped = !isOwner() ? 'not in charge' : switchBusy() ? 'switch' : isSlow() ? 'Safari slow' : warming() ? 'warm-up' : null;
    if (stopped) break;
    const outcome = await sleepTab(record);
    if (outcome !== true) {
      skip(outcome);
      continue;
    }
    slept++;
    if (slept < max && i < due.length - 1) await pause(TIMING.gapMs);
  }
  if (due.length) recordSleep({ step: 'run', due: due.length, slept, skipped, ...(stopped ? { stopped } : {}), ms: Date.now() - startedAt });
  if (slept) console.info(`[margin] put ${slept} tab(s) to sleep`);
  return { due: due.length, slept, skipped, stopped };
}

// One tab: true once it's asleep, else why not.
/** @param {import('../../types/margin').TabRecord} record @returns {Promise<true | string>} */
async function sleepTab(record) {
  const tab = await api.tabs.get(record.id).catch(() => null);
  if (!tab) return 'gone';
  if (tab.active) return 'in front';
  if (isSleepPage(tab.url) || tab.discarded) return 'asleep';
  if (!/^https?:/i.test(tab.url ?? '')) return 'not a web page';
  if (neverSleeps(tab.url, cached()?.settings?.neverSleepSites)) return 'never sleeps';
  if (tab.status !== 'complete') return 'loading';
  if (tab.audible) return 'playing';
  if (isFocusing(tab.id)) return 'switching';
  if (isHeld(tab.id)) return 'held';
  // Safari unloaded it already: nothing to free.
  if (hasNoPage(tab.id) || foundWithNoPage(tab.id)) return 'no page';
  if (!(await mayAccess(tab.url))) return 'no access';
  const how = platform?.sleepTabs === 'discard' ? 'discard' : 'page';
  if (how === 'discard' && typeof api.tabs.discard !== 'function') return 'no discard';
  const answer = await ask(tab.id, tab.url);
  if (answer === 'no page') return 'no page';
  if (answer == null) return 'no answer';
  if (!answer.ok) return answer.why ?? 'refused';
  // Still hidden, at the same address, and nothing to give way to (its page's
  // answer took a moment).
  const live = await api.tabs.get(tab.id).catch(() => null);
  if (!live) return 'gone';
  if (live.active || isFocusing(tab.id)) return 'switching';
  if (live.url !== tab.url) return 'moved';
  if (switchBusy()) return 'switch';
  if (how === 'discard') {
    if (!(await api.tabs.discard(tab.id).then(() => true, () => false))) return 'discard failed';
  } else {
    const to = sleepAddress(api.runtime.getURL(''), { url: tab.url, title: tab.title || record.title, key: newKey() });
    if (!(await api.tabs.update(tab.id, { url: to }).then(() => true, () => false))) return 'not sent';
  }
  const lastUse = Math.max(record.lastActive ?? 0, record.wokeAt ?? 0);
  recordSleep({ step: 'slept', tabId: tab.id, how, idleMin: Math.round((now() - lastUse) / 60_000), judged: answer.judged ?? null });
  return true;
}

// sleepInPage's answer, 'no page' (no script runs there), or null (none in time).
/** @param {number} tabId @param {string} expected */
async function ask(tabId, expected) {
  const until = Date.now() + TIMING.askMs;
  let timer;
  const answer = await Promise.race([
    Promise.resolve(api.scripting?.executeScript?.({ target: { tabId }, func: sleepInPage, args: [expected, until] })).then(
      (rows) => (Array.isArray(rows) && rows[0] && !rows[0].error ? rows[0].result ?? null : 'no page'),
      () => 'no page',
    ),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), TIMING.askMs + 200); }),
  ]);
  clearTimeout(timer);
  return /** @type {{ ok: boolean, why?: string, judged?: string } | 'no page' | null} */ (answer);
}

const newKey = () => {
  try {
    return [...globalThis.crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return Math.random().toString(36).slice(2, 14);
  }
};
/** @param {number} ms */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- waking --------------------------------------------------------------------
// Settings' "Wake all sleeping tabs": every tab asleep, one after another (a
// tab in front wakes itself). Safari: sent to its page's address (wakeAsleep);
// Chrome: each tab discarded loaded again. How many it woke.
/** @type {Set<number>} */
const wakingAll = new Set();
export async function wakeAll() {
  const open = await api.tabs.query({}).catch(() => []);
  let woke = 0;
  for (const tab of open) {
    if (tab.active || (platform?.sleepTabs === 'page' ? !isSleepPage(tab.url) : tab.discarded !== true)) continue;
    wakingAll.add(tab.id);
    const how = platform?.sleepTabs === 'page'
      ? await wakeAsleep(tab)
      : (await Promise.resolve(api.tabs.reload(tab.id)).then(() => true, () => false)) ? 'reload' : null;
    if (how) {
      woke++;
      recordSleep({ step: 'woke', tabId: tab.id, by: 'all', how });
    } else wakingAll.delete(tab.id);
    await pause(TIMING.wakeGapMs);
  }
  setTimeout(() => wakingAll.clear(), 10_000);
  return woke;
}

// tabs.onUpdated (background.js): a tab Margin had asleep has another address
// now (or Chrome loaded it again): woken. In the switch log, unless Margin
// woke it itself (a switch: background/tabs.js; "Wake all": above). Before
// the change is in the state. `change`: the event's.
/** @param {number} tabId @param {{ url?: string, discarded?: boolean }} change */
export function sleepChanged(tabId, change) {
  const record = cached()?.tabs?.[tabId];
  // (Not a tab Safari unloaded itself, should it say `discarded`.)
  if (!record?.sleeping || (record.sleeping.how !== 'page' && platform?.sleepTabs !== 'discard')) return;
  const woke = (change.url != null && !isSleepPage(change.url)) || change.discarded === false;
  if (!woke || wakingAll.has(tabId) || isFocusing(tabId)) return;
  recordSleep({ step: 'woke', tabId, by: 'shown' });
}

// For tests.
/** @param {Partial<typeof TIMING>} given */
export function setSleepTiming(given) {
  Object.assign(TIMING, given);
}
