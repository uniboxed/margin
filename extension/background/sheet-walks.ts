// The page box's kept sheet walks (shared/sheet-walk.ts): the background is the only one that writes them, one write
// at a time, so the index and the origins' keys always agree and the cap holds.
import { capIndex, cleanFiles, cleanMark, mergeGroup, sheetWalkKey, SHEET_WALK_INDEX, type Group, type Index } from '../shared/sheet-walk.ts';

type Local = { get: (keys: string[]) => Promise<Record<string, any>>, set: (items: Record<string, any>) => Promise<void>, remove: (keys: string[]) => Promise<void> };

/** A writer over storage.local (`storage()`); `keep(origin, v, files, now)` resolves to whether it wrote. */
export function createSheetWalks(storage: () => Local) {
  let queue: Promise<unknown> = Promise.resolve();
  async function write(origin: string, mark: string, files: Record<string, any>, now: number) {
    const local = storage();
    const key = sheetWalkKey(origin);
    const raw = await local.get([key, SHEET_WALK_INDEX]);
    const group: Group | null = raw[key] && typeof raw[key] === 'object' ? raw[key] : null;
    // No files: the group was used (its time, for the cap); files with nothing new in them: no write.
    const next = mergeGroup(group, mark, files, now) ?? (!Object.keys(files).length && group?.v === mark ? { ...group, at: now } : null);
    if (!next) return false;
    const { index, drop } = capIndex(raw[SHEET_WALK_INDEX] as Index, origin, Object.keys(next.files).length, JSON.stringify(next).length, now);
    await local.set({ [key]: next, [SHEET_WALK_INDEX]: index });
    if (drop.length) await local.remove(drop.map(sheetWalkKey));
    return true;
  }
  return {
    keep(origin: string, v: unknown, files: unknown, now = Date.now()) {
      const mark = cleanMark(v);
      if (!mark || !/^https?:\/\/[^/]+$/.test(origin)) return Promise.resolve(false);
      const clean = cleanFiles(files);
      const done = queue.then(() => write(origin, mark, clean, now));
      queue = done.catch(() => {});
      return done.catch(() => false);
    },
  };
}
