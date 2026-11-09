import * as M from '../state/model.ts';
import * as V from '../shared/view.ts';
import { api, cached, isSynced, load, mutate, now, recheckSoon, StaleError } from './store.ts';
import { anyFocusing, focusTab, openTab, tellApp, tellPage } from './tabs.ts';
import { appLog } from './switch-log.ts';
import { showTab } from './away.ts';
import { NAV_CHAIN_MS, OVERLAY_SWITCH_PREFIX } from '../shared/switching.ts';

// Next/previous tab and space. Three delivery paths land here: Margin.app's
// keys (`navigate` requests, while it draws Margin), the manifest `commands`
// (⌃⌘ + arrows; they work where Margin has no page listener: Safari's own
// pages, the address bar, a page before its script has loaded) and the
// page's keydown listener (key repeat, custom shortcuts from Settings, and on
// Safari the commands' keys too: Safari runs a command only once the focused
// page has turned the key down, and a page that calls preventDefault on its
// arrows ate it, shared/shortcuts.ts).
//  - One key press arriving through two paths counts once (the app's, a
//    page's and a command's are three sources).
//  - Each press's target is worked out as it's pressed, continuing from the
//    one before (for a moment: NAV_CHAIN_MS), else from the tab the state has
//    in front, so fast presses all count even before Safari has finished
//    switching.
//  - Margin.app's overlay is told at once ('switching' with the target, the
//    chain and the press's number: it highlights the tab and keeps it until
//    the state has it in front, shared/switching.ts), then done or failed for
//    that press.
//  - One switch per window is with Safari at a time; presses that come
//    meanwhile wait, and a newer one takes the place of the one waiting
//    (latest wins), so Safari is never sent through every tab passed (a held
//    key, fast taps: each was a full switch, one after another, the highlight
//    a tab at a time behind). The first press goes at once; a press after the
//    switches are done is never skipped. The same for spaces (one showSpace at
//    a time, the newest waiting).
//  - Each is the plain switch (background/tabs.ts focusTab): no wakes ahead,
//    no passing checks (Phase 2 step 8). The window's page in front is told
//    as its switch starts (content pages, Chrome).
const NAV_DEDUPE_MS = 150;
const lastNav = { action: null, source: null, at: 0 };
export const navTarget = new Map(); // windowId → { tabId, at }
const spaceTarget = new Map(); // windowId → { spaceId, at, spaces: the chain's targets }
let seqs = 0;
/**
 * A window's presses: the one with Safari now, the ones waiting (in order; a
 * newer press of the same kind replaces the last), the chain's number, and
 * the tabs this window's presses asked Safari for, with when (their
 * activations aren't the user's: `navActivated`).
 * `given`: Margin.app's overlay's pick for a tab press, with its switch id (navigate `given`).
 */
export type Press = { kind: 'tab' | 'space', action: string, dir: number, target: any, seq: number, chain: number, switchId: string, done: Promise<void>, finish: () => void, given?: { target: number, switchId: string | null } };
const runs: Map<number, { busy: Press | null, waiting: Press[], chain: number, asked: Map<number, number>, shown: number | null, front: number | null }> = new Map();
// Each key run (a window's presses until KEY_RUN_QUIET_MS after the last one's switch is over, none
// waiting) as one line in Margin.app's log (switch-log.ts appLog): its presses, how many switches
// Safari was asked for (tabs.update, or a space's), how many presses a newer one took the place of
// before their turn, how many were heard twice, how long from the last press to landing (Safari's
// activation of its tab, else its answer), and how many times the overlay was told an older
// press's target after a newer one's (its highlight going back: must be 0). Ids and counts only.
export const KEY_RUN_QUIET_MS = 400;
export type KeyRun = { tabs: number, spaces: number, asked: number, skipped: number, twice: number, none: number, failed: number,
  lastPressAt: number, lastSeq: number, lastTarget: any, toldSeq: number, back: number, answeredAt: number | null, activatedAt: number | null, timer: any };
const keyRuns: Map<number, KeyRun> = new Map();
const keyRunOf = (windowId: number) => {
  let r = keyRuns.get(windowId);
  if (!r) keyRuns.set(windowId, r = { tabs: 0, spaces: 0, asked: 0, skipped: 0, twice: 0, none: 0, failed: 0, lastPressAt: 0, lastSeq: 0, lastTarget: undefined, toldSeq: 0, back: 0, answeredAt: null, activatedAt: null, timer: null });
  clearTimeout(r.timer);
  r.timer = null;
  return r;
};
function keyRunIdle(windowId: number) {
  const r = keyRuns.get(windowId);
  const run = runs.get(windowId);
  if (!r || run?.busy || run?.waiting.length) return; // (said once its switches are over)
  clearTimeout(r.timer);
  r.timer = setTimeout(() => {
    keyRuns.delete(windowId);
    const n = (k: number, what: string) => `${k} ${what}${k === 1 ? '' : what.endsWith('s') ? 'es' : 's'}`;
    const presses = [r.tabs ? n(r.tabs, 'tab press') : '', r.spaces ? n(r.spaces, 'space press') : ''].filter(Boolean).join(' and ');
    const landedAt = r.activatedAt ?? r.answeredAt;
    const landed = landedAt == null ? 'never landed' : `landed ${Math.max(0, landedAt - r.lastPressAt)} ms after the last press (${r.activatedAt != null ? 'Safari\'s activation' : 'Safari\'s answer'})`;
    const extra = [r.none ? `${r.none} already in front` : '', r.failed ? `${r.failed} failed` : '', r.twice ? `${n(r.twice, 'press')} heard twice, counted once` : ''].filter(Boolean).join(', ');
    appLog(`key run in window ${windowId}: ${presses}, Safari asked ${n(r.asked, 'time')}, ${r.skipped} skipped (a newer press took their place)${extra ? `, ${extra}` : ''}, ${landed}; highlight told backwards ${n(r.back, 'time')}`);
  }, KEY_RUN_QUIET_MS);
}
const runOf = (windowId: number) => {
  let run = runs.get(windowId);
  if (!run) runs.set(windowId, run = { busy: null, waiting: [], chain: 0, asked: new Map(), shown: null, front: null });
  return run;
};

// The tab a press goes to, worked out now: from the chain's last target, else
// the tab the state has in front (undefined: not known yet, worked out at its
// turn with Safari's answer; null: nothing to go to).
function tabTargetNow(windowId: number, dir: number) {
  const s = isSynced() ? cached() : null;
  if (!s) return { target: undefined, chained: false };
  const chained = navTarget.get(windowId);
  const from = chained && now() - chained.at < NAV_CHAIN_MS && s.tabs[chained.tabId] ? chained.tabId : null;
  const current = from ?? Object.values(s.tabs).find((t) => t.windowId === windowId && t.active)?.id ?? null;
  if (current == null) return { target: undefined, chained: false };
  return { target: V.cycleTab(s, windowId, current, dir), chained: from != null };
}
function spaceTargetNow(windowId: number, dir: number) {
  const s = isSynced() ? cached() : null;
  if (!s) return undefined;
  const chained = spaceTarget.get(windowId);
  const from = chained && now() - chained.at < NAV_CHAIN_MS ? chained.spaceId : null;
  return V.cycleSpace(s, windowId, dir, from);
}

// The overlay told about a key's switch (only it: the page is told as the switch starts).
function tellOverlay(windowId: number, press: Press, type: string, reason: string | null = null) {
  const r = keyRuns.get(windowId);
  if (r && type === 'switching') {
    if (press.seq < r.toldSeq) r.back++;
    else r.toldSeq = press.seq;
    if (press.seq === r.lastSeq) r.lastTarget = press.target;
  }
  tellApp(windowId, { type, tabId: press.target, switchId: press.switchId, chain: press.chain, seq: press.seq, ...(reason ? { reason } : {}) });
}

/**
 * `given`: the target Margin.app's overlay worked out and highlighted at the key press (its own chain, the same rule:
 * shared/view.ts cycleTab), with its switch id: taken as this press's while that tab is still open here, so the
 * highlight never waits for this background (busy with the switch before, or waking: Tirth, 2026-11-07) and the two
 * never differ.
 */
export function navigate(action: string, source: string, windowId: number | null | undefined, given: { target?: unknown, switchId?: unknown } = {}) {
  const t = now();
  if (windowId == null) return Promise.resolve();
  const run = runOf(windowId);
  const idle = () => run.busy?.done ?? Promise.resolve();
  if (action === lastNav.action && source !== lastNav.source && t - lastNav.at < NAV_DEDUPE_MS) {
    const r = keyRuns.get(windowId);
    if (r) r.twice++;
    return idle();
  }
  Object.assign(lastNav, { action, source, at: t });
  const kind = action === 'next-tab' || action === 'prev-tab' ? 'tab' : action === 'next-space' || action === 'prev-space' ? 'space' : null;
  if (!kind) return Promise.resolve();
  const keyRun = keyRunOf(windowId);
  keyRun[kind === 'tab' ? 'tabs' : 'spaces']++;
  keyRun.lastPressAt = Date.now();
  keyRun.answeredAt = keyRun.activatedAt = null;
  keyRun.lastTarget = undefined;
  const dir = action.startsWith('next') ? 1 : -1;
   let finish: () => void = () => {};
  const done = new Promise<any>((resolve) => { finish = () => resolve(undefined); });
  const seq = ++seqs;
  keyRun.lastSeq = seq;
  const press: Press = { kind, action, dir, target: undefined, seq, chain: run.chain, switchId: `nav-${seq}`, done, finish };
  // Its target now, unless a press of the other kind is ahead of it (a tab
  // after a space: the space's tabs aren't known until it's shown).
  const ahead = [run.busy, ...run.waiting].filter(Boolean);
  const mixed = ahead.some((p) => p?.kind !== kind || p?.target === undefined);
  if (kind === 'tab' && Number.isInteger(given.target)) press.given = { target: (given.target as number), switchId: overlaySwitchId(given.switchId) };
  const s0 = isSynced() ? cached() : null;
  const givenTarget = press.given && s0 ? takeGiven(press, s0, windowId) : undefined;
  if (kind === 'tab' && !mixed) {
    const now0 = tabTargetNow(windowId, dir);
    const { target, chained } = givenTarget !== undefined ? { target: givenTarget, chained: now0.chained } : now0;
    if (target === null) { finish(); keyRunIdle(windowId); return idle(); } // nothing to go to
    if (target !== undefined) {
      if (!chained) run.chain++;
      press.chain = run.chain;
      press.target = target;
      navTarget.set(windowId, { tabId: target, at: now() });
      tellOverlay(windowId, press, 'switching');
    }
  } else if (kind === 'space' && !mixed) {
    const target = spaceTargetNow(windowId, dir);
    if (target === null) { finish(); keyRunIdle(windowId); return idle(); }
    if (target !== undefined) {
      press.target = target;
      if (keyRun.lastSeq === seq) keyRun.lastTarget = target;
      const chained = spaceTarget.get(windowId);
      const spaces = chained && now() - chained.at < NAV_CHAIN_MS ? chained.spaces : new Set<any>();
      spaceTarget.set(windowId, { spaceId: target, at: now(), spaces: spaces.add(target) });
    }
  }
  // Latest wins: the press waiting last, of this kind and with its target known, gives way.
  const last = run.waiting.at(-1);
  if (last && last.kind === kind && last.target !== undefined && press.target !== undefined) {
    run.waiting.pop();
    keyRun.skipped++;
    if (kind === 'tab') tellOverlay(windowId, last, 'switch-done'); // (the overlay has moved on to this one)
    void done.then(last.finish);
  }
  run.waiting.push(press);
  drive(windowId);
  return done;
}

// The overlay's switch id for a press it highlighted (shared/switching.ts OVERLAY_SWITCH_PREFIX), else none.
const overlaySwitchId = (id: unknown) => (typeof id === 'string' && id.startsWith(OVERLAY_SWITCH_PREFIX) && id.length < 40 ? id : null);
// The overlay's pick for a press, while it's a tab of that window in `s`: taken, with its switch id (undefined: not).
function takeGiven(press: Press, s: any, windowId: number) {
  const given = press.given;
  if (!given || s?.tabs?.[given.target]?.windowId !== windowId) return undefined;
  if (given.switchId) press.switchId = given.switchId;
  return given.target;
}

function drive(windowId: number) {
  const run = runOf(windowId);
  if (run.busy || !run.waiting.length) return;
  const press = (run.waiting.shift() as Press);
  run.busy = press;
  void runPress(windowId, press, run)
    .catch((err) => console.warn('[margin] navigate', err))
    .finally(() => {
      run.busy = null;
      press.finish();
      const r = keyRuns.get(windowId);
      if (r && press.seq === r.lastSeq && r.answeredAt == null) r.answeredAt = Date.now();
      drive(windowId);
      if (!run.busy && !run.waiting.length) keyRunIdle(windowId);
    });
}

async function runPress(windowId: number, press: Press, run: ReturnType<typeof runOf>) {
  if (press.kind === 'tab') {
    if (press.target === undefined) {
      // Not known at the press (the state not synced yet, a space switch ahead): worked out now.
      const s = await load();
      const chained = navTarget.get(windowId);
      const current = chained && now() - chained.at < NAV_CHAIN_MS && s.tabs[chained.tabId]
        ? chained.tabId
        : (await api.tabs.query({ active: true, windowId }))[0]?.id;
      if (!(chained && now() - chained.at < NAV_CHAIN_MS)) run.chain++;
      press.chain = run.chain;
      const next = takeGiven(press, s, windowId) ?? V.cycleTab(s, windowId, current, press.dir);
      if (next == null) return;
      press.target = next;
      navTarget.set(windowId, { tabId: next, at: now() });
      tellOverlay(windowId, press, 'switching');
    }
    const next = (press.target as number);
    const keyRun = keyRuns.get(windowId);
    // Back to the tab this window's last switch showed, with nothing shown since: nothing to ask Safari.
    if (run.shown === next && run.front === next) {
      if (keyRun) keyRun.none++;
      tellOverlay(windowId, press, 'switch-done');
      return;
    }
    run.asked.set(next, Date.now());
    if (keyRun) keyRun.asked++;
    // The page on screen is told (`from` says which page it's for: Margin's own pages hear it as a broadcast).
    const shownPage = api.tabs.query({ active: true, windowId }).then(([shown]) => {
      if (!shown || shown.id === next) return null;
      tellPage(shown, { type: 'switching', tabId: next, from: shown.id, switchId: press.switchId }, { app: false });
      return shown;
    }, () => null);
    const told = (type: string, reason: string | null = null) => {
      tellOverlay(windowId, press, type, reason);
      return shownPage.then((shown) => shown && tellPage(shown, { type, tabId: next, from: shown.id, switchId: press.switchId, ...(reason ? { reason } : {}) }, { app: false }));
    };
    try {
      await showTab(next, windowId, { source: press.action }); // one in another window comes here (docs/BROWSER-WINDOWS.md §9)
    } catch (err) {
      run.shown = null;
      if (keyRun) keyRun.failed++;
      void told('switch-failed', String((err as any)?.message ?? err));
      throw err;
    }
    run.shown = next;
    void told('switch-done');
    // The state follows from Safari's activation; written here too (a tab handed
    // off is left out of those), not waited for: the next press needn't wait on storage.
    void mutate((st) => M.activateTab(st, next, windowId, now())).catch(() => {});
  } else {
    const spaceId = press.target !== undefined ? press.target : V.cycleSpace(await load(), windowId, press.dir);
    if (spaceId == null) return;
    run.shown = null;
    const keyRun = keyRuns.get(windowId);
    if (keyRun) keyRun.asked++;
    await showSpace(windowId, spaceId).catch((err) => { if (keyRun) keyRun.failed++; throw err; });
    // Show where you landed (auto-hide mode), once the presses are done; Margin's own pages ignore it.
    if (run.waiting.length) return;
    const [tab] = await api.tabs.query({ active: true, windowId });
    if (tab) api.tabs.sendMessage(tab.id, { type: 'command', command: 'peek' }).catch(() => {});
  }
}

// A tab shown in a window (Safari's onActivated: background.ts): a switch the
// user made themselves (Safari's tab bar, a click on a row) starts the next
// key's chain from there; the activations of this window's own key switches
// don't.
const OWN_MS = 1500;
export function navActivated(windowId: number, tabId: number) {
  const run = runs.get(windowId);
  if (run) run.front = tabId;
  const keyRun = keyRuns.get(windowId);
  if (keyRun && keyRun.lastTarget === tabId && keyRun.activatedAt == null) keyRun.activatedAt = Date.now();
  const asked = run?.asked.get(tabId);
  for (const [id, at] of run?.asked ?? []) if (Date.now() - at >= OWN_MS) run?.asked.delete(id);
  if (asked != null && Date.now() - asked < OWN_MS) return;
  if (navTarget.get(windowId)?.tabId !== tabId) navTarget.delete(windowId);
  // A space key's own switch shows a tab of a space its chain went to: the chain goes on.
  const space = spaceTarget.get(windowId);
  if (space && !space.spaces.has(cached()?.tabSpace?.[tabId])) spaceTarget.delete(windowId);
}

export const NAV_ACTIONS = new Set(['next-tab', 'prev-tab', 'next-space', 'prev-space']);

// A space shown in a window (Arc): the window's sidebar shows it, and its
// most recent tab in that window comes to the front (the tab shown stays if
// it's already one of the space's); with none there, Margin's start page
// opens in it, or the untouched start or new-tab page in front moves to it
// (no pile of empty pages). `bringTab: false`: only the sidebar's space.
// A switch to one of its tabs doesn't wait for the space to be written: the
// write waits for the next one, the activation's (which sets the same space:
// background.ts followTab), SPACE_WRITE_MS at most, so the switch isn't held
// up behind a storage write. What to bring is still read from the state the
// change is made to, behind every change queued before it (the cache can be
// behind those while a write is under way): the tab used last, a tab just
// moved to the space staying.
const SPACE_WRITE_MS = 2000;
// The tab in front of the window: Safari's answer, or, past FRONT_KNOWN_MS,
// Margin's own (its tabs matched to the open ones): after a reboot Safari
// took seconds to answer (2026-11-03), and a space's switch waited that long
// before it started.
const FRONT_KNOWN_MS = 150;
async function frontOf(windowId: number) {
  const asking: Promise<{ tab: any }> = Promise.resolve().then(() => api.tabs.query({ active: true, windowId })).then(([tab]) => ({ tab: tab ?? null }));
  const known = isSynced() ? Object.values(cached()?.tabs ?? {}).find((t) => t.windowId === windowId && t.active) ?? null : null;
  if (!known) return (await asking).tab;
  let timer: number | undefined;
  const answer = await Promise.race([asking.catch(() => null), new Promise<any>((resolve) => { timer = setTimeout(() => resolve(null), FRONT_KNOWN_MS); })]).finally(() => clearTimeout(timer));
  return (answer as { tab: any } | null)?.tab ?? known;
}
export async function showSpace(windowId: number | null | undefined, spaceId: string, { bringTab = true, deadline }: { bringTab?: boolean, deadline?: number } = {}): Promise<{ tab: any } | undefined> {
  if (windowId == null) return;
  const shown = bringTab ? await frontOf(windowId) : null;
  const candidatesIn = (st: import('../../types/margin').State) => Object.values(st.tabs)
    .filter((t) => t.windowId === windowId && st.tabSpace[t.id] === spaceId && t.id !== shown?.id)
    .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
  const switching = (st: import('../../types/margin').State) => bringTab && st.spaces.some((x) => x.id === spaceId) && !(shown && st.tabSpace[shown.id] === spaceId) && candidatesIn(st).length > 0;
  // The write that waits doesn't ask whether this copy still owns the state
  // (store.ts flush does, as it writes): asked here (at most once a second),
  // so a copy a newer one replaced fails as stale rather than switching tabs
  // from its own state, out of date.
  if ((await recheckSoon()) !== 'owner') throw new StaleError();
  let before: string | null = null;
  const s = await mutate((st) => {
    before = V.activeSpaceId(st, windowId);
    return M.setActiveSpace(st, windowId, spaceId);
  }, { within: (st) => (switching(st) ? SPACE_WRITE_MS : null) });
  if (V.activeSpaceId(s, windowId) !== spaceId || !bringTab) return; // no such space, or only the sidebar
  if (shown && s.tabSpace[shown.id] === spaceId) return;
  const candidates = candidatesIn(s);
  // The window back to the space it showed (its tab in front is still of that
  // one), unless something else changed it meanwhile.
  const goBack = async () => {
    if (!before || before === spaceId) return;
    const [front] = await api.tabs.query({ active: true, windowId }).catch(() => []);
    await mutate((st) => (V.activeSpaceId(st, windowId) === spaceId && (!front || st.tabSpace[front.id] === before) ? M.setActiveSpace(st, windowId, before!) : st)).catch(() => {}); // (`before`: checked above)
  };
  for (const tab of candidates) {
    try {
      return await focusTab(tab.id, { source: 'space', deadline });
    } catch (err) {
      // Closed meanwhile: the next one. Anything else (Safari didn't switch,
      // too late) is this switch failing, not a reason to open a start page.
      if (!/No tab with id/i.test(String((err as Error | undefined)?.message ?? err))) {
        if (!anyFocusing()) await goBack();
        throw err;
      }
    }
  }
  // Nothing of the space open, only tabs that aren't (put to sleep, or kept as a window closed: state/model.ts
  // keptTabs): the top one opens, as a click on its row does (handlers.ts openKept), not a new tab (Tirth, 2026-11-08).
  const top = V.sidebar(s, windowId).tabs.find((t) => t.kept);
  if (top) {
    const live = await api.tabs.query({ windowId }).catch(() => null);
    const index = M.stripIndexFor(s, windowId, top.order as number, live); // (a kept tab always has its place)
    const tab = await openTab({ windowId, url: top.url, spaceId, deadline, index, keptId: String(top.id) });
    return { tab };
  }
  const startPage = api.runtime.getURL('newtab/newtab.html#launcher');
  const untouched = shown && (shown.url === startPage || V.isNewTabPage(shown.url || shown.pendingUrl));
  if (untouched) await mutate((st) => M.moveTab(st, shown.id, spaceId));
  else await openTab({ windowId, url: startPage, spaceId, deadline });
}
