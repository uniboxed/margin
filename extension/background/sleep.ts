// Tabs not used for a while, put to sleep to free their memory (as Arc does):
// `settings.sleepAfterHours` (4; 0: never) since the tab was last used,
// except sites on `settings.neverSleepSites`. Safari keeps every tab's page
// process alive, however long it's been hidden (Tirth's 35 tabs: 16.5 GB),
// and gives extensions no tabs.discard (WebKit's extension engine has none,
// 2026-11-04). So in Safari Margin closes the browser tab and keeps its
// Margin tab, not open, in its space (Margin 2, PLAN.md §6:
// platform.sleepTabs 'close'; state/model.ts keepTab): all its memory goes,
// nothing is left running, and nothing breaks if Margin is removed; it opens
// again when clicked. Chrome and Edge: tabs.discard ('discard').
//
// Which tabs (state/model.ts sleepyTabs, then each tab as the browser has it
// now): a web page, not in front, not asleep already, not playing sound, not
// loading, not one Safari unloaded itself (nothing to free), not one a switch
// is going to, and, asked in the page itself (sleepInPage,
// in every frame: another site's frame can hold a draft too), hidden, nothing
// typed into it and not sent (content/edits.ts), nothing playing; a page that
// doesn't answer in time is left for a later pass. A page that said no isn't
// asked again for an hour unless its tab is used (asking resumes its
// process). Whether the tab is still unused is looked at again before the
// ask and before it's sent to sleep: a pass takes a while, and a tab shown
// meanwhile (Safari's tab bar, ⌘1–9) has been used.
// Pinned tabs sleep too. A few per pass (PER_RUN), one at a time, none while
// a switch is asked for or under way. A pass runs
// with the auto-archive's (every 15
// minutes: background.ts). A pass that found tabs due is a line in Margin.app's
// log (switch-log.ts appLog): how many, which slept, why the others didn't.
import * as M from '../state/model.ts';
import { api, cached, isOwner, load, now } from './store.ts';
import { platform } from '../shared/platform.ts';
import { neverSleeps } from '../shared/sleep.ts';
import { foundWithNoPage, isFocusing, mayAccess, switchBusy } from './tabs.ts';
import { appLog } from './switch-log.ts';
import { noteClosing, takeClosing } from './closing.ts';
import { isParked } from './handoff.ts';
import { keepScroll, keepScrolls } from './scroll-record.ts';

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
// content/edits.ts; a page without it, an earlier copy's or none, judged
// generously: any text in a field or an editor).
// Any other frame (another site's: a comment box, a form, a payment's, where
// the top frame can't look): nothing playing and nothing typed, judged that
// generous way (Margin's content script runs in top frames only), and
// whether its parent can't look into it (`apart`). Each frame counts the
// frames in it it can't look into (`foreign`): each of those must answer
// for itself (pageAnswer). Not past `until` (the background no longer waits
// for the answer then).
// `draftsOnly`: only whether something is typed and not sent (Margin.app's handoff asking before it
// closes a window: windowDrafts): shown, playing or at another address doesn't matter then.
// The top frame's answer that the page may sleep, or has a draft, says where it's scrolled too, when
// it isn't at the top (`scrollY`: the scroll record, background/scroll-record.ts; back at the top,
// the page said so itself as it was hidden): <html>'s, or <body>'s while Margin's page box scrolls it.
export function sleepInPage(expected: string, until: number, draftsOnly: boolean = false) {
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
    if (!draftsOnly && document.visibilityState !== 'hidden') return { ok: false, why: 'shown', top };
    if (!draftsOnly && top && location.href !== expected) return { ok: false, why: 'moved', top };
    const playing = (doc: Document) => [...doc.querySelectorAll('audio, video')].some((el: any) => (!el.paused && !el.ended) || (typeof MediaStream !== 'undefined' && el.srcObject instanceof MediaStream));
    if (!draftsOnly && (playing(document) || (navigator as any).mediaSession?.playbackState === 'playing' || (document as any).pictureInPictureElement || document.fullscreenElement)) return { ok: false, why: 'playing', top };
    const inUse = (doc: Document | null, depth = 0) => {
      if (!doc || depth > 4) return false;
      for (const el of ([...doc.querySelectorAll('textarea, input:not([type]), input[type=text], input[type=search], input[type=email], input[type=url], input[type=tel], input[type=number], input[type=password]')] as any[])) if (String(el.value ?? '').trim()) return true;
      for (const el of ([...doc.querySelectorAll('[contenteditable]:not([contenteditable=false])')] as any[])) if (el.isContentEditable && String(el.textContent ?? '').trim()) return true;
      for (const el of ([...doc.querySelectorAll('select')] as any[])) if ([...el.options].some((o) => o.selected !== o.defaultSelected)) return true;
      for (const el of ([...doc.querySelectorAll('input[type=checkbox], input[type=radio]')] as any[])) if (el.checked !== el.defaultChecked) return true;
      for (const frame of ([...doc.querySelectorAll('iframe, frame')] as any[])) {
        let inner = null;
        try {
          inner = frame.contentDocument;
        } catch {}
        if (inUse(inner, depth + 1)) return true;
      }
      return false;
    };
    // Frames this one can't look into (another site's).
    const foreignIn = (doc: Document, depth = 0) => {
      let n = 0;
      for (const frame of ([...doc.querySelectorAll('iframe, frame')] as any[])) {
        let inner = null;
        try {
          inner = frame.contentDocument;
        } catch {}
        n += !inner ? 1 : depth < 4 ? foreignIn(inner, depth + 1) : 0;
      }
      return n;
    };
    const own = top ? (globalThis as any).Margin?.content?.edits : null;
    let edited = null;
    try {
      edited = typeof own === 'function' ? own() : null;
    } catch {}
    const judged = typeof edited === 'boolean' ? (own.late ? 'margin-late' : 'margin') : top ? 'page' : 'frame';
    if (typeof edited !== 'boolean') edited = inUse(document);
    const y = top ? Math.round(Math.max(document.scrollingElement?.scrollTop ?? 0, document.body?.scrollTop ?? 0)) : 0;
    const scrolled = y > 0 ? { scrollY: y } : {};
    if (edited) return { ok: false, why: 'edited', judged, top, ...scrolled };
    return { ok: true, judged, top, foreign: foreignIn(document), ...scrolled, ...(top ? {} : { apart }) };
  } catch {
    return { ok: false, why: 'error', top };
  }
}

// ---- a pass ----------------------------------------------------------------------
export type Pass = { due: number, slept: number, skipped: Record<string, number>, stopped: string | null };
let running: Promise<Pass | null> | null = null;
// A pass (one at a time). `afterMs`: tabs unused for this long instead of the
// setting's hours (a pass asked for by hand: the background's console,
// `margin.sleepNow(ms)`, or the WebKit host); `max`: in place of TIMING.perRun.
export function sleepIdle(options: { afterMs?: number | null, max?: number } = {}): Promise<Pass | null> {
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

async function run({ afterMs = null, max = TIMING.perRun }: { afterMs?: number | null, max?: number }): Promise<Pass> {
  const startedAt = Date.now();
  const s = await load();
  const due = M.sleepyTabs(s, now(), { afterMs });
  // A pass asked for by hand asks every page again (its refusals still count).
  const byHand = afterMs != null;
  if (due.length) await readRefusals();
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  let slept = 0;
  /** the tabs put to sleep, for the log */
  const sleptLines: string[] = [];
  let stopped: string | null = null;
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

// A tab's last use: since then it's been unused (state/model.ts sleepyTabs).
const lastUseOf = (record: any) => Math.max(record?.lastActive ?? 0, record?.wokeAt ?? 0);
// Still due as the state is now: a tab used since the pass began (in front a
// moment, through Margin or Safari's own tab bar or ⌘1–9: its last use moves)
// isn't put to sleep seconds after.
function stillDue(tabId: number, afterMs: number | null) {
  const s = cached();
  return !!s && M.sleepyTabs(s, now(), { afterMs }).some((t) => t.id === tabId);
}

// One tab: once it's asleep, its line for the log; else why not.
async function sleepTab(record: import('../../types/margin').TabRecord, afterMs: number | null): Promise<{ line: string } | string> {
  if (!stillDue(record.id, afterMs)) return 'used';
  const tab = await api.tabs.get(record.id).catch(() => null);
  if (!tab) return 'gone';
  // A parked window's tab in front (out of sight while another profile's window is shown:
  // app/HANDOFF.md §2.5) is the page shown when the window comes back: it never sleeps.
  if (tab.active && isParked(tab.windowId)) return 'in front, parked';
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
  const refused = (why: string) => {
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
    // (background.ts tabs.onRemoved: closing.ts says it's Margin's, to keep),
    // with where its page was scrolled (queued before the close's change).
    if (Number.isFinite(answer.scrollY)) void keepScroll(tab.id, tab.url, answer.scrollY);
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
async function ask(tabId: number, expected: string) {
  const until = Date.now() + TIMING.askMs;
  const call = (allFrames: boolean) => Promise.resolve(api.scripting?.executeScript?.({ target: allFrames ? { tabId, allFrames: true } : { tabId }, func: sleepInPage, args: [expected, until] }));
  let timer;
  const answer = await Promise.race([
    call(true).then(pageAnswer, () => call(false).then(pageAnswer, () => 'no page')),
    new Promise<any>((resolve) => { timer = setTimeout(() => resolve(null), TIMING.askMs + 200); }),
  ]);
  clearTimeout(timer);
  return (answer as { ok: boolean, why?: string, judged?: string, scrollY?: number } | 'no page' | null);
}

// The page's answer from its frames' (executeScript's results): the top
// frame's (its address, whether it's shown, its own fields, and the frames
// of its own site it looks into), and a no from any other frame. Every frame
// no other could look into (another site's, or one with no site: `foreign`)
// must have answered for itself, or the tab stays awake. WebKit gives an
// error, not an answer, for a frame it has no access to (empty, srcdoc and
// data: frames, in the WebKit host, 2026-11-04): one of the top frame's own
// site was looked into from there; one with no site of its own wasn't.
export function pageAnswer(rows: unknown) {
  if (!Array.isArray(rows) || !rows.length) return 'no page';
  const answers = rows.filter((row: any) => !!row && !row.error && !!row.result && typeof row.result === 'object' && typeof row.result.ok === 'boolean');
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

// ---- drafts, before Margin.app closes a window ------------------------------------------
// The window's tabs with text typed and not sent (app/HANDOFF.md §4.5: the app closes a window only
// when there's none), asked in every tab at once with the same check as a sleep's (sleepInPage, its
// drafts only, in every frame), DRAFTS_MS in all. `unknown`: a web page that couldn't say (no access,
// no answer in time, a frame nothing can look into); the app keeps the window then too. Not asked: a
// tab that isn't a web page (Margin's own pages, Safari's) and one with no page to hold text (asleep,
// or unloaded by Safari).
const DRAFTS_MS = 400;
export async function windowDrafts(windowId: number, { ms = DRAFTS_MS }: { ms?: number } = {}): Promise<{ drafts: number[], unknown: number[] }> {
  const started = Date.now();
  const until = started + ms;
  const tabs = await answerOrNull(Promise.resolve(api.tabs.query({ windowId })), ms);
  // Not an answer: the app keeps the window, as for a draft.
  if (!Array.isArray(tabs)) throw new Error(`Safari didn't list the window's tabs in ${ms} ms`);
  const drafts: number[] = [];
  const unknown: number[] = [];
  const scrolls: { tabId: number, url: string, y: number }[] = [];
  await Promise.all(tabs.map(async (tab) => {
    if (!Number.isInteger(tab?.id) || !/^https?:/i.test(tab.url ?? '') || tab.discarded || foundWithNoPage(tab.id)) return;
    const said = await answerOrNull(draftIn(tab, until), Math.max(0, until - Date.now()));
    if (said?.scrollY != null) scrolls.push({ tabId: tab.id, url: tab.url, y: said.scrollY });
    if (said?.is === 'draft') drafts.push(tab.id);
    else if (said?.is !== 'none') unknown.push(tab.id);
  }));
  // Where each page is scrolled, just before the close it was asked for (the scroll record).
  void keepScrolls(scrolls);
  appLog(`windowDrafts window ${windowId}: ${tabs.length} tabs, ${drafts.length} with a draft, ${unknown.length} unknown (${Date.now() - started} ms)`);
  return { drafts, unknown };
}
// `is` 'draft', 'none', or null (it couldn't say), and where the page is scrolled if it said.
async function draftIn(tab: any, until: number): Promise<{ is: 'draft' | 'none' | null, scrollY: number | null } | null> {
  if (!(await mayAccess(tab.url))) return null;
  const call = (allFrames: boolean) => Promise.resolve(api.scripting?.executeScript?.({ target: allFrames ? { tabId: tab.id, allFrames: true } : { tabId: tab.id }, func: sleepInPage, args: [tab.url, until, true] }));
  const answer = await call(true).then(pageAnswer, () => call(false).then(pageAnswer, () => 'no page'));
  if (answer === 'no page' || !answer) return null;
  const scrollY = Number.isFinite(answer.scrollY) ? answer.scrollY : null;
  if (answer.ok) return { is: 'none', scrollY };
  return { is: answer.why === 'edited' ? 'draft' : null, scrollY };
}
async function answerOrNull<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer;
  try {
    return await Promise.race([promise.catch(() => null), new Promise<any>((resolve) => { timer = setTimeout(() => resolve(null), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

// ---- pages that said no ---------------------------------------------------------
// A page that refused (a draft, playing, shown, no answer) isn't asked again
// each pass: asking resumes a process Safari suspended and costs up to the
// ask's time. Not until the tab has been used since (its last use moves) or
// TIMING.refusedMs has gone by. Kept in storage.session (a pass every 15
// minutes is often in a background started for it), here too for a
// browser without it. tabId → { use: its last use then, until }.
const REFUSED_KEY = 'sleepRefused';
let refusals: Record<string, { use: number, until: number }> = {};
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
function refusedLately(record: any) {
  const r = refusals[String(record.id)];
  if (!r) return false;
  if (r.until > now() && r.use === lastUseOf(record)) return true;
  delete refusals[String(record.id)];
  refusalsChanged = true;
  return false;
}
function noteRefusal(record: any) {
  refusals[String(record.id)] = { use: lastUseOf(record), until: now() + TIMING.refusedMs };
  refusalsChanged = true;
}
function forgetRefusal(tabId: number) {
  if (!(String(tabId) in refusals)) return;
  delete refusals[String(tabId)];
  refusalsChanged = true;
}

const pause = (ms: number) => new Promise<any>((resolve) => setTimeout(resolve, ms));

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
export function setSleepTiming(given: Partial<typeof TIMING>) {
  Object.assign(TIMING, given);
}
