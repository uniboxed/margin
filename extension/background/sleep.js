// Tabs not used for a while, put to sleep to free their memory (as Arc does):
// `settings.sleepAfterHours` (4; 0: never) since the tab was last used,
// except sites on `settings.neverSleepSites`. Safari keeps every tab's page
// process alive, however long it's been hidden (Tirth's 35 tabs: 16.5 GB),
// and gives extensions no tabs.discard (WebKit's extension engine has none,
// 2026-11-04). So in Safari Margin closes the browser tab and keeps its
// Margin tab, not open, in its space (Margin 2, PLAN.md §6:
// platform.sleepTabs 'close'; state/model.js keepTab): all its memory goes,
// nothing is left running, and nothing breaks if Margin is removed; it opens
// again when clicked. Chrome and Edge: tabs.discard ('discard').
//
// Which tabs (state/model.js sleepyTabs, then each tab as the browser has it
// now): a web page, not in front, not asleep already, not playing sound, not
// loading, not one Safari unloaded itself (nothing to free), not one a switch
// is going to, and, asked in the page itself (sleepInPage,
// in every frame: another site's frame can hold a draft too), hidden, nothing
// typed into it and not sent (content/edits.js), nothing playing; a page that
// doesn't answer in time is left for a later pass. A page that said no isn't
// asked again for an hour unless its tab is used (asking resumes its
// process). Whether the tab is still unused is looked at again before the
// ask and before it's sent to sleep: a pass takes a while, and a tab shown
// meanwhile (Safari's tab bar, ⌘1–9) has been used.
// Pinned tabs sleep too. A few per pass (PER_RUN), one at a time, none while
// a switch is asked for or under way. A pass runs
// with the auto-archive's (every 15
// minutes: background.js). A pass that found tabs due is a line in Margin.app's
// log (switch-log.js appLog): how many, which slept, why the others didn't.
import * as M from '../state/model.js';
import { api, cached, isOwner, load, now } from './store.js';
import { platform } from '../shared/platform.js';
import { neverSleeps } from '../shared/sleep.js';
import { foundWithNoPage, isFocusing, mayAccess, switchBusy } from './tabs.js';
import { appLog } from './switch-log.js';
import { noteClosing, takeClosing } from './closing.js';

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
  // A page that refused isn't asked again for this long, unless its tab is used.
  refusedMs: 60 * 60_000,
};

// Executed in each of the tab's frames (allFrames), in Margin's content-script
// world (sent as source: self-contained). Whether the page may sleep as it is
// now. The top frame (`top: true`, the answer that counts for the page):
// still `expected` (no other address since it was looked at), hidden,
// nothing playing, nothing typed and not sent (Margin's own watch,
// content/edits.js; a page without it, an earlier copy's or none, judged
// generously as content/takeover.js does: any text in a field or an editor).
// Any other frame (another site's: a comment box, a form, a payment's, where
// the top frame can't look): nothing playing and nothing typed, judged that
// generous way (Margin's content script runs in top frames only), and
// whether its parent can't look into it (`apart`). Each frame counts the
// frames in it it can't look into (`foreign`): each of those must answer
// for itself (pageAnswer). Not past `until` (the background no longer waits
// for the answer then).
/** @param {string} expected @param {number} until */
export function sleepInPage(expected, until) {
  let top = true;
  let apart = false;
  try {
    top = window.top === window;
    apart = !top && window.frameElement == null;
  } catch {
    apart = true;
  }
  try {
    if (Date.now() > until) return { ok: false, why: 'late', top };
    if (document.visibilityState !== 'hidden') return { ok: false, why: 'shown', top };
    if (top && location.href !== expected) return { ok: false, why: 'moved', top };
    const playing = (/** @type {Document} */ doc) => [...doc.querySelectorAll('audio, video')].some((/** @type {any} */ el) => (!el.paused && !el.ended) || (typeof MediaStream !== 'undefined' && el.srcObject instanceof MediaStream));
    if (playing(document) || /** @type {any} */ (navigator).mediaSession?.playbackState === 'playing' || /** @type {any} */ (document).pictureInPictureElement || document.fullscreenElement) return { ok: false, why: 'playing', top };
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
        } catch {}
        if (inUse(inner, depth + 1)) return true;
      }
      return false;
    };
    // Frames this one can't look into (another site's).
    const foreignIn = (/** @type {Document} */ doc, depth = 0) => {
      let n = 0;
      for (const frame of /** @type {any[]} */ ([...doc.querySelectorAll('iframe, frame')])) {
        let inner = null;
        try {
          inner = frame.contentDocument;
        } catch {}
        n += !inner ? 1 : depth < 4 ? foreignIn(inner, depth + 1) : 0;
      }
      return n;
    };
    const own = top ? /** @type {any} */ (globalThis).Margin?.content?.edits : null;
    let edited = null;
    try {
      edited = typeof own === 'function' ? own() : null;
    } catch {}
    const judged = typeof edited === 'boolean' ? (own.late ? 'margin-late' : 'margin') : top ? 'page' : 'frame';
    if (typeof edited !== 'boolean') edited = inUse(document);
    if (edited) return { ok: false, why: 'edited', judged, top };
    return { ok: true, judged, top, foreign: foreignIn(document), ...(top ? {} : { apart }) };
  } catch {
    return { ok: false, why: 'error', top };
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
  // A pass asked for by hand asks every page again (its refusals still count).
  const byHand = afterMs != null;
  if (due.length) await readRefusals();
  /** @type {Record<string, number>} */
  const skipped = {};
  const skip = (/** @type {string} */ why) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  let slept = 0;
  /** @type {string[]} the tabs put to sleep, for the log */
  const sleptLines = [];
  /** @type {string | null} */
  let stopped = null;
  for (const [i, record] of due.entries()) {
    if (slept >= max) {
      skip('next pass');
      continue;
    }
    if (!byHand && refusedLately(record)) {
      skip('asked lately');
      continue;
    }
    stopped = !isOwner() ? 'not in charge' : switchBusy() ? 'switch' : null;
    if (stopped) break;
    const outcome = await sleepTab(record, afterMs);
    if (typeof outcome === 'string') {
      skip(outcome);
      continue;
    }
    sleptLines.push(outcome.line);
    slept++;
    if (slept < max && i < due.length - 1) await pause(TIMING.gapMs);
  }
  if (refusalsChanged) writeRefusals();
  if (due.length) {
    const skips = Object.entries(skipped).map(([why, n]) => `${why} ${n}`).join(', ');
    appLog(`sleep: ${due.length} due, ${slept} put to sleep${sleptLines.length ? ` (${sleptLines.join('; ')})` : ''}${skips ? `; skipped: ${skips}` : ''}${stopped ? `; stopped: ${stopped}` : ''} (${Date.now() - startedAt} ms)`);
  }
  return { due: due.length, slept, skipped, stopped };
}

// A tab's last use: since then it's been unused (state/model.js sleepyTabs).
const lastUseOf = (/** @type {any} */ record) => Math.max(record?.lastActive ?? 0, record?.wokeAt ?? 0);
// Still due as the state is now: a tab used since the pass began (in front a
// moment, through Margin or Safari's own tab bar or ⌘1–9: its last use moves)
// isn't put to sleep seconds after.
/** @param {number} tabId @param {number | null} afterMs */
function stillDue(tabId, afterMs) {
  const s = cached();
  return !!s && M.sleepyTabs(s, now(), { afterMs }).some((t) => t.id === tabId);
}

// One tab: once it's asleep, its line for the log; else why not.
/** @param {import('../../types/margin').TabRecord} record @param {number | null} afterMs @returns {Promise<{ line: string } | string>} */
async function sleepTab(record, afterMs) {
  if (!stillDue(record.id, afterMs)) return 'used';
  const tab = await api.tabs.get(record.id).catch(() => null);
  if (!tab) return 'gone';
  if (tab.active) return 'in front';
  if (tab.discarded) return 'asleep';
  if (!/^https?:/i.test(tab.url ?? '')) return 'not a web page';
  if (neverSleeps(tab.url, cached()?.settings?.neverSleepSites)) return 'never sleeps';
  if (tab.status !== 'complete') return 'loading';
  if (tab.audible) return 'playing';
  if (isFocusing(tab.id)) return 'switching';
  // Safari unloaded it already: nothing to free.
  if (foundWithNoPage(tab.id)) return 'no page';
  if (!(await mayAccess(tab.url))) return 'no access';
  const how = platform?.sleepTabs === 'discard' ? 'discard' : 'close';
  if (how === 'discard' && typeof api.tabs.discard !== 'function') return 'no discard';
  if (!stillDue(record.id, afterMs)) return 'used';
  const answer = await ask(tab.id, tab.url);
  // Its page said no (or nothing): not asked again for a while (refusedLately).
  const refused = (/** @type {string} */ why) => {
    noteRefusal(record);
    return why;
  };
  if (answer === 'no page') return refused('no page');
  if (answer == null) return refused('no answer');
  if (!answer.ok) return refused(answer.why ?? 'refused');
  // Still hidden, at the same address, unused, and nothing to give way to
  // (its page's answer took a moment).
  const live = await api.tabs.get(tab.id).catch(() => null);
  if (!live) return 'gone';
  if (live.active || isFocusing(tab.id)) return 'switching';
  if (live.url !== tab.url) return 'moved';
  if (switchBusy()) return 'switch';
  if (!stillDue(record.id, afterMs)) return 'used';
  if (how === 'discard') {
    if (!(await api.tabs.discard(tab.id).then(() => true, () => false))) return 'discard failed';
  } else {
    // Its browser tab closed, its Margin tab kept, not open, in its space
    // (background.js tabs.onRemoved: closing.js says it's Margin's, to keep).
    noteClosing([tab.id], 'keep', 'sleep');
    if (!(await Promise.resolve(api.tabs.remove(tab.id)).then(() => true, () => false))) {
      takeClosing(tab.id);
      return 'not closed';
    }
  }
  forgetRefusal(record.id);
  return { line: `tab ${tab.id} ${how === 'discard' ? 'discarded' : 'closed, kept'}, unused ${Math.round((now() - lastUseOf(record)) / 60_000)} min, its page judged by ${answer.judged ?? 'nothing'}` };
}

// sleepInPage's answer for the page, 'no page' (no script runs there), or
// null (none in time). Asked in every frame: text in another site's frame
// (a comment box, a form, a payment's) is a draft too. A browser that won't
// run it in every frame is asked in the top frame alone (and a page with
// frames it can't look into then stays awake: pageAnswer).
/** @param {number} tabId @param {string} expected */
async function ask(tabId, expected) {
  const until = Date.now() + TIMING.askMs;
  const call = (/** @type {boolean} */ allFrames) => Promise.resolve(api.scripting?.executeScript?.({ target: allFrames ? { tabId, allFrames: true } : { tabId }, func: sleepInPage, args: [expected, until] }));
  let timer;
  const answer = await Promise.race([
    call(true).then(pageAnswer, () => call(false).then(pageAnswer, () => 'no page')),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), TIMING.askMs + 200); }),
  ]);
  clearTimeout(timer);
  return /** @type {{ ok: boolean, why?: string, judged?: string } | 'no page' | null} */ (answer);
}

// The page's answer from its frames' (executeScript's results): the top
// frame's (its address, whether it's shown, its own fields, and the frames
// of its own site it looks into), and a no from any other frame. Every frame
// no other could look into (another site's, or one with no site: `foreign`)
// must have answered for itself, or the tab stays awake. WebKit gives an
// error, not an answer, for a frame it has no access to (empty, srcdoc and
// data: frames, in the WebKit host, 2026-11-04): one of the top frame's own
// site was looked into from there; one with no site of its own wasn't.
/** @param {unknown} rows */
export function pageAnswer(rows) {
  if (!Array.isArray(rows) || !rows.length) return 'no page';
  const answers = rows.filter((/** @type {any} */ row) => !!row && !row.error && !!row.result && typeof row.result === 'object' && typeof row.result.ok === 'boolean');
  const top = answers.find((row) => row.result.top !== false);
  if (!top) return 'no page';
  if (!top.result.ok) return top.result;
  let unseen = 0;
  let answered = 0;
  for (const row of answers) {
    unseen += Math.max(0, Number(row.result.foreign) || 0);
    if (row === top) continue;
    if (row.result.top !== false) return { ok: false, why: 'frame unknown', judged: 'frame' }; // two top frames?
    if (!row.result.ok) return { ok: false, why: row.result.why ?? 'refused', judged: row.result.judged ?? 'frame' };
    if (row.result.apart === true) answered++;
  }
  if (unseen > answered) return { ok: false, why: 'frame unknown', judged: 'frame' };
  return top.result;
}

// ---- pages that said no ---------------------------------------------------------
// A page that refused (a draft, playing, shown, no answer) isn't asked again
// each pass: asking resumes a process Safari suspended and costs up to the
// ask's time. Not until the tab has been used since (its last use moves) or
// TIMING.refusedMs has gone by. Kept in storage.session (a pass every 15
// minutes is often in a background started for it), here too for a
// browser without it. tabId → { use: its last use then, until }.
const REFUSED_KEY = 'sleepRefused';
/** @type {Record<string, { use: number, until: number }>} */
let refusals = {};
let refusalsChanged = false;
async function readRefusals() {
  if (typeof api.storage?.session?.get === 'function') {
    const stored = await Promise.resolve(api.storage.session.get(REFUSED_KEY)).catch(() => null);
    const kept = stored?.[REFUSED_KEY];
    refusals = kept && typeof kept === 'object' ? { ...kept } : {};
  }
  const at = now();
  for (const [id, r] of Object.entries(refusals)) {
    if (!(r?.until > at)) {
      delete refusals[id];
      refusalsChanged = true;
    }
  }
}
function writeRefusals() {
  refusalsChanged = false;
  void Promise.resolve(api.storage?.session?.set?.({ [REFUSED_KEY]: refusals })).catch(() => {});
}
/** @param {any} record */
function refusedLately(record) {
  const r = refusals[String(record.id)];
  if (!r) return false;
  if (r.until > now() && r.use === lastUseOf(record)) return true;
  delete refusals[String(record.id)];
  refusalsChanged = true;
  return false;
}
/** @param {any} record */
function noteRefusal(record) {
  refusals[String(record.id)] = { use: lastUseOf(record), until: now() + TIMING.refusedMs };
  refusalsChanged = true;
}
/** @param {number} tabId */
function forgetRefusal(tabId) {
  if (!(String(tabId) in refusals)) return;
  delete refusals[String(tabId)];
  refusalsChanged = true;
}

/** @param {number} ms */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- waking ----------------------------------------------------------------------
// Settings' "Wake all sleeping tabs", where sleeping tabs are discarded
// (Chrome, Edge): each tab discarded loaded again, one after another (a tab in
// front wakes itself). How many it woke. Safari closes sleeping tabs: none
// open to wake (each opens as it's clicked).
export async function wakeAll() {
  if (platform?.sleepTabs !== 'discard') return 0;
  const open = await api.tabs.query({}).catch(() => []);
  let woke = 0;
  for (const tab of open) {
    if (tab.active || tab.discarded !== true) continue;
    if (await Promise.resolve(api.tabs.reload(tab.id)).then(() => true, () => false)) woke++;
    await pause(TIMING.wakeGapMs);
  }
  return woke;
}

// For tests.
/** @param {Partial<typeof TIMING>} given */
export function setSleepTiming(given) {
  Object.assign(TIMING, given);
}
