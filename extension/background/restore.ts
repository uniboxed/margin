// Tabs that may be coming back from before (the browser restarted, Margin
// updated, a window closed), whose Margin tabs wait, not open, in keptTabs
// with the window they were lost with (state/model.ts reclaimTabs): a session
// reopened later (History › Reopen All Windows from Last Session, a closed
// window reopened, ⌘⇧T: a window new to Margin), and the tabs of a window
// that was still being restored, or had no address yet, when the ids changed.
// Only those tabs (never ones the user had before; never one placed in a
// space on purpose, M.moveTab) are offered, for RESTORE_MS after their window
// was first watched; tabs created in it count for ARRIVE_MS (a window is
// restored in one burst), new-tab pages never (a tab coming back has its
// address). Once they stop arriving or changing (QUIET_MS), they take back
// their Margin tabs (state/model.ts reclaimTabs: id, place, space). Kept in
// the worker's memory: a worker unloaded within that minute loses what's left
// to take back (those Margin tabs stay, not open).
import * as M from '../state/model.ts';
import * as V from '../shared/view.ts';
import { mutate, now } from './store.ts';

const RESTORE_MS = 60_000;
const ARRIVE_MS = 10_000;
const QUIET_MS = 1500;
/** window id → its candidate tabs */
const watched: Map<number, { since: number, tabs: Set<number> }> = new Map();
let timer: number | null = null;

// Margin tabs lost with a window lately, that a window coming back takes back.
const waiting = (state: import('../../types/margin').State, t = now()) => Object.values(state.keptTabs ?? {}).some((k) => k.from && t - (k.from.at ?? 0) <= M.LOST_MS);

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(run, QUIET_MS);
}
function expire(t: number) {
  for (const [windowId, w] of watched) if (t - w.since > RESTORE_MS) watched.delete(windowId);
}
async function run() {
  const t = now();
  expire(t);
  const tabIds = [...watched.values()].flatMap((w) => [...w.tabs]);
  if (tabIds.length) await mutate((s) => (waiting(s, t) ? M.reclaimTabs(s, tabIds, t) : s));
}
const watch = (windowId, tabIds) => {
  const w = watched.get(windowId) ?? { since: now(), tabs: new Set<any>() };
  for (const id of tabIds) w.tabs.add(id);
  watched.set(windowId, w);
};

// After a sync that renumbered the tabs, with Margin tabs left waiting: every
// window's tabs not matched yet, and its tabs to come (see tabCreated).
export function synced({ state, renumbered }: { state: import('../../types/margin').State, renumbered: boolean }) {
  if (!renumbered || !waiting(state)) return;
  const byWindow = new Map();
  for (const t of Object.values(state.tabs)) byWindow.set(t.windowId, [...(byWindow.get(t.windowId) ?? []), ...(t.restored ? [] : [t.id])]);
  for (const [windowId, tabIds] of byWindow) watch(windowId, tabIds);
  schedule();
}

// A tab created (called in the queue, before it's recorded): a candidate in a
// watched window, or in a window Margin has no tab in yet.
export function tabCreated(state: import('../../types/margin').State, tab: BrowserTab) {
  if (!waiting(state) || V.isNewTabPage(tab.pendingUrl || tab.url)) return;
  const t = now();
  expire(t);
  const w = watched.get(tab.windowId);
  const fresh = !Object.values(state.tabs).some((x) => x.windowId === tab.windowId);
  if (w ? t - w.since > ARRIVE_MS : !fresh) return;
  watch(tab.windowId, [tab.id]);
  schedule();
}

// A candidate's address changed: it may match now.
export function tabChanged(tab: BrowserTab) {
  if (watched.get(tab.windowId)?.tabs.has(tab.id)) schedule();
}
