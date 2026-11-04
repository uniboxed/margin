// The tabs likely to be clicked next, loaded quietly after a Safari relaunch.
//
// Safari brings every tab back unloaded after a relaunch (only the tab in
// front of each window loads), and loads one as it's selected: the first
// click on each is a restore behind the page (background/tabs.js restoreTab),
// 0.5–2.5 s of the spinner, more on a Mac busy after a reboot. So once Safari
// has settled, the tabs most likely to be clicked are loaded behind the page
// here, one at a time, while the user is idle: the tab used last before the
// one in front, the tab each other space would show, the tabs open on a pin,
// then the rest of the tabs used last (pickTabs), `settings.warmUpTabs` of
// them at most (6; 0: off). Each the way a switch's restore loads it (warmTab:
// the same flip, limits and safety nets), with nothing covered or held, and
// it gives way at once to anything the user does.
// Safari only (platform.warmUp): Chrome loads the tabs it restores itself.
//
// Once per Safari session, after a relaunch only (`fresh` sync and the open
// tabs say so: start, plan), in storage.session (`warmUp`): a background
// Safari stops and starts again goes on from where it was, or does nothing.
// Only tabs Safari unloaded and nobody has shown since (never a tab with a
// page: a suspended one isn't kicked), only in the window in front as it's
// planned, on screen, with the page in front idle (gate, the page's idle.js),
// and Safari not slow, before or during the gate's own calls. Work that can
// wait: it never writes into the signs switches go by (slow.js), never counts
// toward turning restores off (tabs.js restoreTab), and makes no Safari call
// of its own while a switch is under way. The sidebar of the page in front
// shows how far it got ("Getting your tabs ready", 3 of 6:
// themes/arcadia/sidebar.js), while tabs are loading (a page drops the note
// NOTE_MS after its last news), and the user can stop it there.
import { api, cached, isOwner, load } from './store.js';
import { platform } from '../shared/platform.js';
import { hiddenFor, sessionKnown } from './keep-ready.js';
import { foundWithNoPage, foundWithPage, inPage, repairUnderWay, startedAt, switchBusy, warmTab, warmUpBlocked } from './tabs.js';
import { lastSignAt, timed } from './slow.js';
import { recordWarmUp } from './diagnostics.js';
import { warmUpCount } from '../shared/view.js';

// Times (tests shorten them: setWarmUpTiming).
const TIMING = {
  // From the background's start: Safari restores its windows, Margin's first
  // sync and its repair of the open tabs (passes at 0, 0.35, 1.2 and 3 s) go first.
  startAfterMs: 8000,
  // The repair waited for this long at most.
  repairWaitMs: 20_000,
  // A background that stopped and started again during a run goes on after this.
  resumeAfterMs: 3000,
  // The whole run: past this from its start, whatever is left stays unloaded.
  runMaxMs: 5 * 60_000,
  // No sign of a slow Safari (slow.js), nor of the warm-up's own timers
  // running late, for this long before each tab.
  quietMs: 8000,
  // The warm-up's own pause this late: the Mac busy.
  lagMaxMs: 250,
  // The page in front with no pointer, wheel, scroll or input for this long,
  // and no key for keysMs (a pause in typing is longer).
  idleMs: 2000,
  keysMs: 5000,
  // Between two tabs; and before a look again when something isn't right.
  gapMs: 1500,
  retryMs: 1000,
  // A tab warmed still loading: the next waits until it's done, this long
  // at most from its flip (one load at a time, even a heavy page's).
  loadingMaxMs: 20_000,
  // A wait for the same reason again (Safari slow, another window, the user
  // away): each twice as long as the one before, up to this.
  backoffMaxMs: 30_000,
  // The note in the sidebar with no news for this long goes (the page's own
  // timer: content/core.js): a run waiting on the user, or one that ended
  // where its last word didn't reach, leaves no note stuck.
  noteMs: 15_000,
  // A switch under way: the note's message waits this long before a look again.
  calmMs: 300,
  // The page in front's answer to whether the user is idle.
  idleAnswerMs: 400,
};
// After a relaunch every tab but the one in front of each window is unloaded;
// after an update (or Margin turned on again), a new copy finds them loaded.
// A relaunch: of the background tabs the repair could ask, at least this
// share had no page, and at least one.
const RELAUNCH_SHARE = 0.6;
const KEY = 'warmUp';
// Tabs warmed that Safari didn't load behind: this many and the run ends (a
// switch's restores aren't affected: tabs.js restoreTab).
const WARM_MISSES = 2;

/** @typedef {'recent' | 'space' | 'pinned'} Why why a tab was picked */
/** @typedef {{ id: number, why: Why }} Pick */
/** @typedef {{ v: 1, state: 'running' | 'done' | 'stopped' | 'not relaunch' | 'off', at: number, until: number, picked: Pick[], done: Record<string, string>, why?: string, windowId?: number | null, shown?: boolean, told?: number[], misses?: number }} Run what's kept in storage.session; `windowId`: the window warmed (in front as planned); `shown`: the note is up (the first tab has started); `told`: the pages given the note while it runs (each gets its end); `misses`: tabs Safari didn't load behind */
/** @typedef {{ done: number, total: number, state: 'running' | 'done' | 'stopped', forMs?: number }} Progress what the sidebar's note shows; `forMs`: how long it stays up with no news */

let fresh = false; // this background's first sync found a new Safari session (or a new copy)
let installed = null; // runtime.onInstalled's reason, in this background
/** @type {Run | null} */
let run = null;
let resumed = false; // this background took a run over from the one before
let stopWhy = null; // why the run should stop at its next look (the user, the setting)
let actedAt = 0; // the page in front's last word that the user did something (idle.js)
let noteAt = 0; // the note's last news (a tab started or ended)
let started = null; // the run's loop, once started (one per background)
/** @type {Map<string, number>} */
const waits = new Map(); // DEVELOPMENT DIAGNOSTICS: what the run waited for, how many times

// ---- what to warm ---------------------------------------------------------------
const isWeb = (/** @type {string | undefined} */ url) => /^https?:/i.test(url ?? '');
const key = (/** @type {string | undefined} */ url) => String(url ?? '').replace(/#.*$/, '').replace(/\/$/, '');
// The tabs likely to be clicked next, most likely first, `max` at most: the
// tab used last before the one in front (straight back), the tab each other
// space shows (its icon, a swipe) in each window, spaces by their own last
// use, the tabs open on a pin of their space, then the tabs used last.
// `eligible(record)`: a tab that may be warmed; `windowId`: only that
// window's (the one in front: only its tabs are warmed).
/** @param {import('../../types/margin').State} s @param {{ max: number, eligible: (t: import('../../types/margin').TabRecord) => boolean, windowId?: number | null }} options @returns {Pick[]} */
export function pickTabs(s, { max, eligible, windowId = null }) {
  if (!(max > 0)) return [];
  const all = Object.values(s?.tabs ?? {}).filter((t) => windowId == null || t.windowId === windowId);
  const tabs = all.filter((t) => !t.active);
  const recent = [...tabs].sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
  /** @type {Map<string, import('../../types/margin').TabRecord>} */
  const fronts = new Map(); // window:space → its tab used last (any, the one in front too)
  for (const t of all) {
    const spaceId = s.tabSpace?.[t.id];
    if (!spaceId) continue;
    const at = `${t.windowId}:${spaceId}`;
    const known = fronts.get(at);
    // The tab in front stands for its own space (it's shown already).
    if (!known || (!known.active && (t.active || (t.lastActive ?? 0) > (known.lastActive ?? 0)))) fronts.set(at, t);
  }
  const spaceFronts = [...fronts.values()].filter((t) => !t.active).sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
  const pinned = recent.filter((t) => (s.pins ?? []).some((p) => p.spaceId === s.tabSpace?.[t.id] && key(p.url) === key(t.url)));
  /** @type {Pick[]} */
  const out = [];
  const seen = new Set();
  const add = (/** @type {import('../../types/margin').TabRecord | undefined} */ t, /** @type {Why} */ why) => {
    if (!t || out.length >= max || seen.has(t.id) || !eligible(t)) return;
    seen.add(t.id);
    out.push({ id: t.id, why });
  };
  // (The first eligible of the tabs used last, then the rest in that order.)
  add(recent.find((t) => eligible(t)), 'recent');
  for (const t of spaceFronts) add(t, 'space');
  for (const t of pinned) add(t, 'pinned');
  for (const t of recent) add(t, 'recent');
  return out;
}

// ---- kept in storage.session ------------------------------------------------------
const save = () => {
  if (!run) return;
  const kept = structuredClone(run);
  void Promise.resolve().then(() => api.storage.session?.set({ [KEY]: kept })).catch(() => {});
};
/** @returns {Promise<Run | null>} */
const read = () => Promise.resolve(api.storage.session?.get(KEY)).then((stored) => {
  const r = stored?.[KEY];
  return r && r.v === 1 && Array.isArray(r.picked) ? r : null;
}, () => null);

// ---- when ------------------------------------------------------------------------
// background.js: the first sync found a new Safari session (storage.session
// empty): a relaunch, or a new copy of Margin (an update, Margin turned on).
export function freshSession() {
  fresh = true;
}
// background.js: runtime.onInstalled. An update is never a relaunch (its
// tabs have their pages): a run under way stops.
/** @param {string} reason */
export function noteInstalled(reason) {
  installed = reason; // (a run kept by the copy before stops at its next look: loop)
}
// background.js, once this copy owns the state and its tabs are matched (the
// first sync): a run to start or go on with, if there is one. Once per background.
export function start() {
  if (!platform?.warmUp || started) return started;
  started = begin().catch((err) => console.warn('[margin] warm-up', err));
  return started;
}
async function begin() {
  const kept = await read();
  if (kept) {
    // A background Safari stopped and started again in the same session.
    if (kept.state !== 'running') return;
    run = kept;
    resumed = true;
    // Its time up (or stopped from the note meanwhile): ended, and the
    // pages given the note told so.
    const why = stopWhy ?? (Date.now() >= kept.until ? 'out of time' : null);
    if (why) return finish(why);
    await pause(TIMING.resumeAfterMs);
    await sessionKnown(); // the tabs left this session, by the background before too (hiddenFor)
    return loop();
  }
  // No run in this session, and not a new one: nothing to do (a background
  // started again before the plan was kept).
  if (!fresh) return;
  await until(startedAt + TIMING.startAfterMs);
  await Promise.race([repairUnderWay(), pause(TIMING.repairWaitMs)]);
  if (await planned()) return loop();
}
// The run, if this is a relaunch and there's something to warm.
/** @returns {Promise<boolean>} */
async function planned() {
  const s = await load();
  const max = warmUpCount(s.settings);
  const at = Date.now();
  const keep = (/** @type {Run['state']} */ state, /** @type {Pick[]} */ picked = [], why = null, windowId = null) => {
    run = { v: 1, state, at, until: at + TIMING.runMaxMs, picked, done: {}, windowId, told: [], ...(why ? { why } : {}) };
    save();
  };
  if (!max || stopWhy) {
    keep('off', [], stopWhy ?? 'turned off');
    return false;
  }
  await sessionKnown(); // the tabs left this session (keep-ready: hiddenFor), also by the background before
  const open = await timed('tabs.query', api.tabs.query({})).catch(() => []);
  const [front] = await timed('tabs.query', api.tabs.query({ active: true, lastFocusedWindow: true })).catch(() => []);
  const behind = open.filter((t) => !t.active && isWeb(t.url));
  const evidence = { noPage: behind.filter((t) => foundWithNoPage(t.id) || t.discarded === true).length, withPage: behind.filter((t) => foundWithPage(t.id)).length, update: installed === 'update' };
  if (evidence.update || evidence.noPage < 1 || evidence.noPage / (evidence.noPage + evidence.withPage) < RELAUNCH_SHARE) {
    keep('not relaunch');
    recordWarmUp({ step: 'not relaunch', evidence });
    return false;
  }
  const live = new Map(open.map((t) => [t.id, t]));
  const windowId = front?.windowId ?? null;
  const picked = windowId == null ? [] : pickTabs(s, {
    max,
    windowId,
    eligible: (t) => {
      const tab = live.get(t.id);
      return !!tab && !tab.active && !tab.audible && isWeb(tab.url) && foundWithNoPage(t.id) && hiddenFor(t.id) == null;
    },
  });
  if (!picked.length) {
    keep('done', [], 'nothing to warm');
    recordWarmUp({ step: 'end', why: 'nothing to warm', done: 0, total: 0, ms: 0 });
    return false;
  }
  keep('running', picked, null, windowId);
  recordWarmUp({ step: 'plan', windowId, candidates: picked.map((p) => ({ tabId: p.id, why: p.why })), evidence });
  return true;
}

// ---- the run ------------------------------------------------------------------------
async function loop() {
  if (!run) return;
  /** @type {{ id: number, at: number } | null} */
  let previous = null; // the tab warmed last, perhaps still loading
  let waitFrom = Date.now();
  let lastWhy = null; // the last wait's reason, and how many times in a row
  let streak = 0;
  for (;;) {
    const why = stopWhy ?? (installed === 'update' ? 'Margin updated' : Date.now() >= run.until ? 'out of time' : !isOwner() ? 'not in charge' : null);
    if (why) return finish(why);
    const left = run.picked.filter((p) => !(String(p.id) in run.done));
    if (!left.length) return finish('done');
    const step = await gate(left, previous);
    if ('stop' in step) return finish(step.stop);
    if ('wait' in step) {
      waits.set(step.why, (waits.get(step.why) ?? 0) + 1);
      streak = step.why === lastWhy ? streak + 1 : 0;
      lastWhy = step.why;
      await pause(step.backoff ? Math.min(step.wait * 2 ** streak, TIMING.backoffMaxMs) : step.wait);
      continue;
    }
    lastWhy = null;
    streak = 0;
    if ('skip' in step) {
      run.done[String(step.skip.id)] = `skipped: ${step.why}`;
      recordWarmUp({ step: 'tab', tabId: step.skip.id, why: step.skip.why, outcome: `skipped: ${step.why}` });
      save();
      note();
      continue;
    }
    const { pick, tab, front, askedAt } = step;
    // The note up, or kept up (each tab is news: content/core.js NOTE_MS).
    run.shown = true;
    note();
    const flipAt = Date.now();
    const stop = () => actedAt >= askedAt || stopWhy != null || signSince(askedAt);
    const out = await warmTab(tab, { stop, frontId: front.id });
    // Not tried after all, the user, a switch or a slow Safari first (its
    // flip wasn't sent): tried again once they're done.
    if (out.behind == null && (actedAt >= askedAt || switchBusy() || signSince(askedAt))) {
      waits.set('gave way', (waits.get('gave way') ?? 0) + 1);
      await pause(TIMING.retryMs);
      continue;
    }
    const outcome = out.behind ?? 'not tried';
    run.done[String(pick.id)] = outcome;
    if (outcome === 'not loaded') run.misses = (run.misses ?? 0) + 1;
    recordWarmUp({ step: 'tab', tabId: pick.id, why: pick.why, waitedMs: flipAt - waitFrom, outcome, ms: Date.now() - flipAt, ...(out.started ? { restoreStart: out.started } : {}), ...(out.committed != null ? { committed: out.committed } : {}) });
    save();
    note();
    if (outcome === 'in front') return finish('Safari left a tab in front');
    if ((run.misses ?? 0) >= WARM_MISSES) return finish('Safari not loading tabs behind');
    if (out.behind != null) previous = { id: pick.id, at: flipAt };
    await pause(TIMING.gapMs);
    waitFrom = Date.now();
  }
}
let quietUntil = 0; // the warm-up's own timers late: the Mac busy until then, at least
// A sign that Safari is slow (slow.js, any source) since `at`.
const signSince = (/** @type {number} */ at) => (lastSignAt() ?? -Infinity) >= at;
/** @typedef {{ stop: string } | { wait: number, why: string, backoff?: boolean } | { skip: Pick, why: string } | { pick: Pick, tab: any, front: any, askedAt: number }} Step `backoff`: a wait that grows when it comes again (loop) */
// What the next step is: stop, wait (and why), skip a tab, or warm one now.
// The checks that cost nothing come first; Safari is asked only once they
// pass, and its answers are the last check: a sign that it's slow during
// them and nothing is flipped.
/** @param {Pick[]} left @param {{ id: number, at: number } | null} previous @returns {Promise<Step>} */
async function gate(left, previous) {
  const gateAt = Date.now();
  const s = cached();
  if (s && !warmUpCount(s.settings)) return { stop: 'turned off' };
  // A pick closed since it was picked (Margin's record of it gone).
  const closed = s ? left.find((p) => !s.tabs?.[p.id]) : null;
  if (closed) return { skip: closed, why: 'gone' };
  const blocked = await warmUpBlocked();
  if (blocked === 'switch') return { wait: TIMING.retryMs, why: 'switch' };
  if (blocked) return { stop: blocked };
  const sign = lastSignAt();
  const quiet = Math.max(quietUntil, sign != null ? sign + TIMING.quietMs : 0);
  if (Date.now() < quiet) return { wait: Math.min(quiet - Date.now(), TIMING.quietMs), why: 'slow', backoff: true };
  // One load at a time: the tab warmed before still loading, the next waits
  // (loadingMaxMs from its flip at most: a heavy page, and the next one
  // starts while it finishes). The one before playing sound by itself (a
  // site allowed to auto-play; WebKit should hold media in a page that
  // isn't in a window, unverified in Safari) ends the run.
  if (previous && Date.now() - previous.at < TIMING.loadingMaxMs) {
    const before = await timed('tabs.get', api.tabs.get(previous.id), previous.id).catch(() => null);
    if (before?.audible) return { stop: 'a tab warmed played sound' };
    if (before?.status === 'loading') return { wait: TIMING.retryMs, why: 'loading' };
  }
  // The tab in front of the window last focused: the page asked whether the
  // user is idle there (visible, focused: Safari in use and the window on
  // screen, nothing typed or touched for a while). Two Safari calls while
  // waiting for that; the rest once it's so.
  const [front] = await timed('tabs.query', api.tabs.query({ active: true, lastFocusedWindow: true })).catch(() => []);
  if (!front || !isWeb(front.url)) return { wait: TIMING.gapMs, why: 'no page in front', backoff: true };
  if (run?.windowId != null && front.windowId !== run.windowId) return { wait: TIMING.gapMs, why: 'another window', backoff: true };
  if (front.audible) return { wait: TIMING.gapMs, why: 'playing', backoff: true };
  // (A pick moved to another window since: left alone.)
  const pick = left.find((p) => (s?.tabs?.[p.id]?.windowId ?? null) === front.windowId);
  if (!pick) return { skip: left[0], why: 'another window' };
  const askedAt = Date.now();
  const idle = await askIdle(front);
  if (!idle) return { wait: TIMING.gapMs, why: 'page not answering', backoff: true };
  if (idle.idle !== true) {
    const why = String(idle.why ?? 'not idle');
    // (The page's own retry for input, which says when it will be idle at
    // the earliest; away, hidden or in a frame, it grows.)
    const away = !['input', 'typing', 'watching'].includes(why);
    return { wait: Math.max(TIMING.retryMs / 2, Math.min(Number(idle.retryMs) || TIMING.retryMs, 3 * TIMING.keysMs)), why, backoff: away };
  }
  // Its window: not minimized, not in full screen (Safari's own; a page's
  // element in full screen the page says).
  const win = await timed('windows.get', Promise.resolve(api.windows?.get?.(front.windowId))).catch(() => null);
  if (win?.focused === false) return { wait: TIMING.gapMs, why: 'Safari not in use', backoff: true };
  if (win?.state === 'minimized' || win?.state === 'fullscreen') return { wait: TIMING.gapMs, why: win.state, backoff: true };
  const tab = await timed('tabs.get', api.tabs.get(pick.id), pick.id).catch(() => null);
  if (!tab) return { skip: pick, why: 'gone' };
  if (tab.windowId !== front.windowId) return { skip: pick, why: 'another window' };
  if (tab.active || hiddenFor(pick.id) != null) return { skip: pick, why: 'shown' };
  if (tab.status !== 'complete' || !isWeb(tab.url)) return { skip: pick, why: 'loading' };
  // With a page: never touched (a suspended tab isn't kicked). A background
  // that took the run over has no repair's word for it: its page asked.
  if (resumed && !foundWithNoPage(pick.id)) await inPage(pick.id, tab.url, () => true, [], 1000);
  if (!foundWithNoPage(pick.id)) return { skip: pick, why: 'has a page' };
  // Safari slow answering these very calls (they were the look at it):
  // nothing flipped.
  if (signSince(gateAt)) return { wait: TIMING.quietMs, why: 'slow', backoff: true };
  // (Again, as those answers came: a switch since, the user.)
  if (switchBusy() || actedAt >= askedAt) return { wait: TIMING.retryMs, why: 'switch' };
  return { pick, tab, front, askedAt };
}
// Whether the user is idle on the page in front (content/idle.js): it
// watches for input from then on, and says so once (userActed).
/** @param {any} front @returns {Promise<{ idle: boolean, retryMs?: number, why?: string } | null>} */
async function askIdle(front) {
  let timer;
  const answer = await Promise.race([
    Promise.resolve(api.tabs.sendMessage(front.id, { type: 'warm-up-idle', idleMs: TIMING.idleMs, keysMs: TIMING.keysMs })).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), TIMING.idleAnswerMs); }),
  ]);
  clearTimeout(timer);
  return answer && typeof answer === 'object' ? /** @type {any} */ (answer) : null;
}
// The run is over (`why`): kept so, and the note says it.
/** @param {string} why */
function finish(why) {
  if (!run) return;
  run.state = why === 'done' ? 'done' : 'stopped';
  run.why = why;
  save();
  const total = run.picked.length;
  recordWarmUp({ step: 'end', why, done: Object.keys(run.done).length, total, ms: Date.now() - run.at, waits: Object.fromEntries(waits) });
  note();
}

// ---- what it says ---------------------------------------------------------------------
/** The note's progress, while it's up (null: none). @returns {Progress | null} */
export function progress() {
  if (!run || !run.shown || run.state === 'not relaunch' || run.state === 'off') return null;
  const state = run.state === 'running' ? 'running' : run.state === 'done' ? 'done' : 'stopped';
  return { done: Math.min(Object.keys(run.done).length, run.picked.length), total: run.picked.length, state };
}
// Still news: the note's last word came less than NOTE_MS ago (a page given
// it now drops it when the others do).
const noteLeft = () => Math.max(0, noteAt + TIMING.noteMs - Date.now());
// The tab in front of the window warmed, as Margin has it (no Safari call).
const frontTab = () => Object.values(cached()?.tabs ?? {}).find((t) => t.active && t.windowId === run?.windowId)?.id ?? null;
// Margin's own message to a page, held while a switch is under way (its
// calls go first), and sent once it's over.
let calmTimer = null;
/** @type {Map<number, () => any>} */
const held = new Map();
/** @param {number} tabId @param {() => any} message */
function sendCalm(tabId, message) {
  held.set(tabId, message);
  if (calmTimer) return;
  const flush = () => {
    calmTimer = null;
    if (switchBusy()) return void (calmTimer = setTimeout(flush, TIMING.calmMs));
    const out = [...held];
    held.clear();
    for (const [id, make] of out) {
      const m = make();
      if (m) void Promise.resolve(api.tabs.sendMessage(id, m)).catch(() => {});
    }
  };
  if (switchBusy()) calmTimer = setTimeout(flush, TIMING.calmMs);
  else flush();
}
// News: the page in front of the window warmed told how far it got (its
// sidebar's note: themes/arcadia/sidebar.js), each page given the note kept
// (`told`); once it's over, each of them gets the last word (the note ends)
// and its idle watch ends.
function note() {
  const shown = progress();
  if (!shown || !run) return;
  const r = run;
  r.told ??= [];
  const to = new Set(shown.state === 'running' ? [] : r.told);
  const front = frontTab();
  if (front != null) to.add(front);
  if (shown.state === 'running') {
    noteAt = Date.now();
    if (front != null && !r.told.includes(front)) r.told.push(front);
  } else r.told = [];
  save();
  for (const id of to) sendCalm(id, () => ({ type: 'warm-up', progress: { ...shown, forMs: shown.state === 'running' ? noteLeft() : 0 } }));
}
// background.js: a tab came to the front during the run: its page gets the
// note too, while it's news (a page left drops it as it's hidden: content/core.js).
/** @param {number} tabId @param {number} [windowId] */
export function frontChanged(tabId, windowId) {
  const shown = progress();
  if (!run || shown?.state !== 'running' || (windowId != null && windowId !== run.windowId) || noteLeft() < 1000) return;
  const r = run;
  r.told ??= [];
  if (!r.told.includes(tabId)) {
    r.told.push(tabId);
    save();
  }
  sendCalm(tabId, () => {
    const now = progress();
    return now?.state === 'running' && noteLeft() >= 1000 ? { type: 'warm-up', progress: { ...now, forMs: noteLeft() } } : null;
  });
}
// handlers.js: a page starting in front of the window warmed (its hello)
// gets the note with its answer, while it's news.
/** @param {{ id?: number, active?: boolean, windowId?: number } | undefined} tab */
export const noteFor = (tab) => {
  const shown = progress();
  if (!run || shown?.state !== 'running' || tab?.active === false || (tab?.windowId != null && tab.windowId !== run.windowId) || noteLeft() < 1000) return null;
  const r = run;
  r.told ??= [];
  if (tab?.id != null && !r.told.includes(tab.id)) {
    r.told.push(tab.id);
    save();
  }
  return { ...shown, forMs: noteLeft() };
};
// handlers.js: the page in front says the user did something (a key, a
// click, a scroll, its focus gone: content/idle.js).
/** @param {number} [at] */
export function userActed(at = Date.now()) {
  actedAt = Math.max(actedAt, Math.min(Number(at) || Date.now(), Date.now()));
}
// handlers.js: the note's ×. Kept at once: a background Safari started for
// this message hasn't read the run yet (begin), and stops it as it does; with
// none to read it, the kept run is marked stopped here (and its pages told).
export async function stopByUser() {
  stopWhy ??= 'stopped by you';
  if (run) return;
  const kept = await read();
  if (run || kept?.state !== 'running') return;
  const told = kept.told ?? [];
  const ended = { ...kept, state: 'stopped', why: stopWhy, told: [] };
  await Promise.resolve(api.storage.session?.set({ [KEY]: ended })).catch(() => {});
  recordWarmUp({ step: 'end', why: stopWhy, done: Object.keys(kept.done ?? {}).length, total: kept.picked.length, ms: Date.now() - kept.at });
  const shown = { done: Math.min(Object.keys(kept.done ?? {}).length, kept.picked.length), total: kept.picked.length, state: 'stopped', forMs: 0 };
  for (const id of told) sendCalm(id, () => ({ type: 'warm-up', progress: shown }));
}

// ---- timers -------------------------------------------------------------------------------
// A pause; one that ends late says the Mac is busy (the next tab waits).
// Kept to the warm-up (quietUntil), not said to slow.js: its timers run
// while Safari is in the background, where macOS fires them late anyway,
// and switches mustn't take that as Safari slow.
/** @param {number} ms */
const pause = (ms) => new Promise((resolve) => {
  const due = Date.now() + ms;
  setTimeout(() => {
    if (Date.now() - due > TIMING.lagMaxMs) quietUntil = Date.now() + TIMING.quietMs;
    resolve(undefined);
  }, Math.max(0, ms));
});
/** @param {number} at */
const until = (at) => pause(Math.max(0, at - Date.now()));

// For tests.
/** @param {Partial<typeof TIMING>} given */
export function setWarmUpTiming(given) {
  Object.assign(TIMING, given);
}
export const warmUpState = () => ({ run: run && structuredClone(run), stopWhy, resumed, waits: Object.fromEntries(waits) });
export function resetWarmUp() {
  fresh = false;
  installed = null;
  run = null;
  resumed = false;
  stopWhy = null;
  actedAt = 0;
  noteAt = 0;
  started = null;
  quietUntil = 0;
  waits.clear();
  clearTimeout(calmTimer);
  calmTimer = null;
  held.clear();
}
