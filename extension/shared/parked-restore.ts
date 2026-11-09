// Windows Margin.app had parked (out of sight in a private Space, app/HANDOFF.md §2.5) coming back after Safari
// quit and opened again: Safari restores every window it had, the parked ones too, as normal windows on the
// Desktop (Tirth, 2026-11-07: "i see those hidden tabs as small windowed windows on the homescreen"). Window and tab
// ids are new after a relaunch; Margin's own tab ids (`mid`, state/model.ts) are matched back to the restored tabs
// by address and order. So a parked window is recorded by its tabs' Margin ids, and a restored window is known as
// one only if every one of its tabs is that record's, at least half of the record's tabs are back in it, and no
// other window qualifies. Pure: background/parked-restore.ts keeps the records and asks.

/**
 * The Margin ids of a window's tabs, as the state has them now (none: nothing to record).
 * */
export function midsOf(state: { tabs?: Record<string, { windowId?: number, mid?: string }> } | null, windowId: number): string[] {
  return Object.values(state?.tabs ?? {}).filter((t) => t?.windowId === windowId && typeof t.mid === 'string').map((t) => (t.mid as string)).sort();
}

/**
 * Which live windows are recorded parked windows come back (new window id → the record's old id). A record whose
 * window is still there isn't asked about (it's still parked, or still open). `taken`: windows already matched.
 * @param records old window id → its tabs' Margin ids
 * @param live the window ids open now
 * */
export function restoredParked(records: Record<string, { mids: string[] }>, state: { tabs?: Record<string, { windowId?: number, mid?: string }> } | null, live: number[]): Map<number, number> {
  const out = new Map();
  const liveSet = new Set(live);
  const byWindow = new Map(live.map((w) => [w, midsOf(state, w)]));
  for (const [old, record] of Object.entries(records ?? {})) {
    const oldId = Number(old);
    const mids = new Set(Array.isArray(record?.mids) ? record.mids : []);
    if (!mids.size || liveSet.has(oldId)) continue;
    const fits = live.filter((w) => {
      if (out.has(w)) return false;
      const own = byWindow.get(w) ?? [];
      if (!own.length || !own.every((m) => mids.has(m))) return false;
      return own.length >= Math.max(1, Math.ceil(mids.size / 2));
    });
    if (fits.length === 1) out.set(fits[0], oldId);
  }
  return out;
}
