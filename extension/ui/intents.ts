// What the sidebar shows of a click before the state says so (the pending intents): a row closed leaves at once, a
// pin opened is the one in front at once. The state comes back through Margin.app (or the copy) a moment later, and
// over a busy hosting queue seconds later; until then the click would seem to do nothing. Each intent overlays its
// change on the state the UI draws (ui/runtime.ts viewState), until the state agrees (confirmed: the overlay goes,
// the state shows the same), the request fails or the state says otherwise (corrected: the overlay goes, the state
// shows what's true), or it's waited too long (timed out: the same). Nothing pending, nothing done: `apply` hands back
// the state it was given.
//
// A switch to a row that has a tab (open, or a Margin tab not open) is shared/switching.ts's: its highlight moves at
// the click and stays through a chain of switches. These are what it can't draw: a pin with no tab yet (the switch
// has no tab to highlight), and closes. A switch asked for drops a pin's open (the newest click wins), and a pin's
// open ends a switch under way (ui/runtime.ts).
//
// Pure: no DOM, no timers (the runtime re-draws at `nextDeadline`); `now` is given.
import type { State } from '../../types/margin';
import * as V from '../shared/view.ts';

/** A pin's open waits this long for the state to have it in front (a hosted app's show takes seconds). */
export const OPEN_MS = 8000;
/** A close waits this long for the state to lose the row. */
export const CLOSE_MS = 5000;
/** After its request is answered, the state has this long to agree (a copy's storage reaches the page a little later). */
export const ANSWER_GRACE_MS = 1000;

export type RowId = number | string;
type Close = {
  kind: 'close', id: RowId, windowId: number | null, at: number, answeredAt: number | null,
  /** The row in front next, as Margin will choose it (the space's most recent other one), when the closed one was in front. */
  next: RowId | null, gone: boolean,
};
type Open = { kind: 'open', pinId: string, url: string, spaceId: string, windowId: number | null, at: number, answeredAt: number | null };
export type Intent = Close | Open;

/** What the UI draws in front ahead of the state: a tab or Margin tab (`tab`, as a switch highlights it), or a pin. */
export type Front = { tab: RowId | null, pin: string | null };

type AnyState = (Partial<State> & Record<string, any>) | null | undefined;

const frontOf = (state: AnyState, windowId: number | null) =>
  Object.values(state?.tabs ?? {}).find((t: any) => t?.windowId === windowId && t?.active) as { id: number, url: string, mid?: string } | undefined;
// Whether the state still has the row: an open tab by its id (or, in Margin.app, by its item's: `mid`), a Margin tab.
const hasRow = (state: AnyState, id: RowId) => (typeof id === 'number' ? !!state?.tabs?.[id] : !!state?.keptTabs?.[id] || Object.values(state?.tabs ?? {}).some((t: any) => t?.mid === id));

/**
 * The row in front after `id` closes, as Margin chooses it (library.ts frontOf, background/handlers.ts closeTab): the
 * most recently used other row of its space in this window, open or not. Null when `id` isn't the row in front.
 */
export function nextFront(state: AnyState, id: RowId, windowId: number | null): RowId | null {
  if (!state?.tabs) return null;
  const front = frontOf(state, windowId);
  if (!front || (front.id !== id && front.mid !== id)) return null;
  const spaceId = state.tabSpace?.[front.id];
  if (spaceId == null) return null;
  let best: { id: RowId, at: number } | null = null;
  const consider = (rowId: RowId, at: unknown) => { const n = Number(at) || 0; if (!best || n > best.at) best = { id: rowId, at: n }; };
  for (const t of Object.values(state.tabs) as any[]) if (t && t.id !== front.id && t.windowId === windowId && state.tabSpace?.[t.id] === spaceId) consider(t.id, t.lastActive);
  for (const k of Object.values(state.keptTabs ?? {}) as any[]) if (k && k.id !== id && k.spaceId === spaceId) consider(k.id, k.lastActive);
  return (best as { id: RowId } | null)?.id ?? null;
}

export function createIntents({ now = Date.now, onChange = () => {} }: { now?: () => number, onChange?: () => void } = {}) {
  let list: Intent[] = [];
  const remove = (intent: Intent) => { const at = list.indexOf(intent); if (at >= 0) { list.splice(at, 1); return true; } return false; };
  // Its request: answered (the state has ANSWER_GRACE_MS more to agree), or failed (gone now).
  const follow = (intent: Intent, request: Promise<unknown> | null | undefined, failed: (result: unknown) => boolean) => {
    if (!request || typeof (request as Promise<unknown>).then !== 'function') return;
    request.then((result) => {
      if (!list.includes(intent)) return;
      if (failed(result)) { remove(intent); onChange(); return; }
      intent.answeredAt = now();
      onChange();
    }, () => { if (remove(intent)) onChange(); });
  };

  // Settled intents out: confirmed by the state, corrected, or timed out.
  function settle(raw: AnyState) {
    const t = now();
    list = list.filter((i) => {
      const late = i.answeredAt != null && t - i.answeredAt > ANSWER_GRACE_MS;
      if (i.kind === 'close') {
        if (t - i.at > CLOSE_MS) return false;
        const gone = !hasRow(raw, i.id);
        if (gone) i.gone = true;
        // In front next: kept until the state has a row in front other than the closed one.
        const fronted = i.next == null || (() => { const f = frontOf(raw, i.windowId); return !!f && f.id !== i.id && f.mid !== i.id; })();
        if (gone && fronted) return false;
        // Answered and the state still has it a while later: it didn't close (or the state never says so).
        return !(late && !gone);
      }
      if (t - i.at > OPEN_MS) return false;
      const f = frontOf(raw, i.windowId);
      if (f && V.normalizeUrl(f.url) === V.normalizeUrl(i.url) && raw?.tabSpace?.[f.id] === i.spaceId) return false; // in front: confirmed
      // The pin's gone (unpinned, its space deleted): nothing to draw.
      return !!raw?.pins?.some((p: any) => p.id === i.pinId);
    });
  }

  return {
    get size() { return list.length; },
    /** What's pending (the tests read it). */
    list: () => list.map((i) => ({ ...i })),
    /**
     * A row closed (`tab.close`): drawn gone at once. `id`: the row's (an open tab's number, a Margin tab's string).
     * `state`: the state as drawn, for the row in front next.
     */
    close(id: RowId, state: AnyState, windowId: number | null, request?: Promise<unknown> | null) {
      if (list.some((i) => i.kind === 'close' && i.id === id)) return;
      const intent: Close = { kind: 'close', id, windowId, at: now(), answeredAt: null, next: nextFront(state, id, windowId), gone: false };
      list.push(intent);
      // (A close's answer is nothing on success: only a rejection says it failed.)
      follow(intent, request, () => false);
    },
    /** A pin with no tab opened (`pin.open`): drawn in front at once. Its request answers undefined if it failed. */
    open(pin: { id: string, url: string, spaceId: string }, windowId: number | null, request?: Promise<unknown> | null) {
      list = list.filter((i) => i.kind !== 'open');
      const intent: Open = { kind: 'open', pinId: pin.id, url: pin.url, spaceId: pin.spaceId, windowId, at: now(), answeredAt: null };
      list.push(intent);
      follow(intent, request, (result) => result === undefined);
    },
    /** A switch asked for since: no pin drawn in front for an older click (true: one was). */
    dropOpens() {
      const had = list.some((i) => i.kind === 'open');
      if (had) list = list.filter((i) => i.kind !== 'open');
      return had;
    },
    /**
     * The state as the UI draws it: the closed rows out of it, and what's in front ahead of it (`front`, null when
     * nothing is). The same state object when nothing is pending.
     * `raw`: the state before any overlay (what confirms or corrects); `state`: the one to draw (others' overlays on it).
     */
    apply<S extends AnyState>(raw: AnyState, state: S): { state: S, front: Front | null } {
      if (!list.length || !state) return { state, front: null };
      settle(raw);
      if (!list.length) return { state, front: null };
      let out: any = state;
      let front: Front | null = null;
      for (const i of list) {
        // (The newest intent's front wins: the list is in the order they came.)
        if (i.kind === 'open') { front = { tab: null, pin: i.pinId }; continue; }
        if (i.next != null) front = { tab: i.next, pin: null };
        if (i.gone || !hasRow(out, i.id)) continue;
        if (out === state) out = { ...state, tabs: { ...state.tabs }, tabSpace: { ...state.tabSpace }, keptTabs: { ...(state.keptTabs ?? {}) } };
        if (typeof i.id === 'number') { delete out.tabs[i.id]; delete out.tabSpace[i.id]; }
        else {
          delete out.keptTabs[i.id];
          for (const t of Object.values(out.tabs) as any[]) if (t?.mid === i.id) { delete out.tabs[t.id]; delete out.tabSpace[t.id]; }
        }
      }
      return { state: out, front };
    },
    /** When the soonest pending intent runs out (the runtime draws again then), or null. */
    nextDeadline(): number | null {
      let soonest: number | null = null;
      for (const i of list) {
        const ends = [i.at + (i.kind === 'close' ? CLOSE_MS : OPEN_MS)];
        if (i.answeredAt != null) ends.push(i.answeredAt + ANSWER_GRACE_MS);
        const end = Math.min(...ends) + 1;
        if (soonest == null || end < soonest) soonest = end;
      }
      return soonest;
    },
    clear() { list = []; },
  };
}
