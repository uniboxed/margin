// This copy's windows that Margin.app had parked, remembered across a Safari quit, so the ones Safari restores as
// normal windows on the Desktop are known again (shared/parked-restore.ts) and told to the app (`wasParked` on the
// window's entry: background/link.ts), which closes them (their tabs stay in their spaces, not open) unless it has
// them parked still (Tirth, 2026-11-07).
//
// - A record (storage.local `parkedWindows`: old window id → its tabs' Margin ids, no address, no title) is written
//   when the app parks a window, and goes when the app stops parking it. A link going away or a new link doesn't
//   remove it (the app says its parked windows again on a new link; Safari quitting may drop the link first).
// - Looked for only in the first minute after this copy starts (a relaunch restores its windows at once): a window
//   the person reopens later (History › Reopen All Windows) is never taken for one. Then every record whose window
//   is gone is dropped.
import { midsOf, restoredParked } from '../shared/parked-restore.ts';

const KEY = 'parkedWindows';
const LOOK_MS = 60_000;
const EVERY_MS = 1000;

export function createParkedRestore({ api, state, liveWindows, onFound, now = () => Date.now() }: { api: any, state: () => any, liveWindows: () => Promise<number[]>, onFound: () => void, now?: () => number }) {
  let records: Record<string, { mids: string[], at: number }> = {};
  let loaded = false;
  const startedAt = now();
  const found: Set<number> = new Set();
  let timer: number | null = null;

  const save = () => api.storage?.local?.set?.({ [KEY]: records })?.catch?.(() => {});
  const load = Promise.resolve(api.storage?.local?.get?.(KEY)).then((got) => {
    const kept = got?.[KEY];
    // Anything parked in the meantime (before the read) is kept over what was stored.
    if (kept && typeof kept === 'object') records = { ...kept, ...records };
    loaded = true;
  }, () => { loaded = true; });

  async function look() {
    await load;
    const live = await liveWindows();
    const restored = restoredParked(records, state(), live);
    let more = false;
    for (const [windowId, old] of restored) {
      delete records[old];
      if (!found.has(windowId)) { found.add(windowId); more = true; }
    }
    if (now() - startedAt >= LOOK_MS) {
      // Done looking: the records whose window is gone go (one still open is still parked).
      const liveSet = new Set(live);
      for (const old of Object.keys(records)) if (!liveSet.has(Number(old))) delete records[old];
      clearInterval(timer);
      timer = null;
    }
    if (restored.size || !timer) await save();
    if (more) onFound();
  }

  return {
    /** Start looking (once the background is up). */
    start() {
      if (timer) return;
      timer = setInterval(() => { void look(); }, EVERY_MS);
       (timer as any)?.unref?.(); // (a test importing the background isn't held open by it)
      void look();
    },
    /** The app parked a window (`on`), or stopped (`on` false); `forgot`: a link going, not the app's word. */
    parked(windowId: number, on: boolean, forgot = false) {
      if (!Number.isInteger(windowId)) return;
      if (on) {
        const mids = midsOf(state(), windowId);
        if (!mids.length) return;
        records[windowId] = { mids, at: now() };
      } else if (!forgot) {
        if (!(windowId in records)) return;
        delete records[windowId];
      } else return;
      void load.then(save);
    },
    /** Whether a window is one this copy had parked before Safari quit (looked at in its first minute). */
    wasParked: (windowId: number) => found.has(windowId),
    /** A window closed: no longer one to tell. */
    gone(windowId: number) { found.delete(windowId); },
    get loaded() { return loaded; },
  };
}
