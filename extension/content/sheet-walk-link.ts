// The page box's kept sheet walks (shared/sheet-walk.ts), between Margin's storage and the page's world
// (content/page/sheets.ts). This page's origin's are read at start, on their own (a key of their own, not with the
// state), and handed across as soon as they're here and whenever the page's world asks; what the page's world walked
// in full comes back, and what's new in it goes to the background to keep (background/handlers.ts keepSheetWalk).
// The page's world can't be told from the page here: what it sends is checked (cleanFiles), kept only under this
// page's own origin, and a page gets a few writes at most.
import { cleanFiles, cleanMark, needsKeep, sheetWalkKey, USED_EVERY_MS, type Group } from '../shared/sheet-walk.ts';
import { mark } from '../shared/dom.ts';

const WRITES = 3;

// `marks`: the content script's test marks (shared/dom.ts mark): the files the page's world said it walked in full
// (`sheetWalkWalked`) and used as kept (`sheetWalkUsed`), for the hosts' checks.
export function startSheetWalkLink(api: any, send: (type: 'keepSheetWalk', payload: any, retry: boolean) => Promise<any>, marks: { dataset: Record<string, string | undefined> }) {
  if (window !== top || !(document.documentElement instanceof HTMLHtmlElement) || !/^https?:$/.test(location.protocol)) return;
  const key = sheetWalkKey(location.origin);
  let group: Group | null | undefined; // undefined: not read yet; null: none kept
  const say = () => {
    if (group) document.dispatchEvent(new CustomEvent('margin:sheet-walk', { detail: JSON.stringify(group) }));
  };
  Promise.resolve(api.storage.local.get(key)).then((raw: any) => {
    const kept = raw?.[key];
    group = kept && typeof kept === 'object' && kept.files && typeof kept.files === 'object' ? kept : null;
    say();
  }, () => { group = null; });
  // The page's world starting (asked), or ready (it may have started before this was listening).
  document.addEventListener('margin:sheet-walk-ask', say);
  document.addEventListener('margin:box-ready', say);

  let writes = 0;
  const told = { walked: new Set<string>(), used: new Set<string>() };
  document.addEventListener('margin:sheet-walk-keep', (event) => {
    let said: any;
    try {
      said = JSON.parse(String((event as CustomEvent).detail));
    } catch {
      return;
    }
    if ((globalThis as any).__marginMarks) {
      for (const href of Object.keys(said?.files ?? {})) told.walked.add(href);
      for (const href of Array.isArray(said?.used) ? said.used : []) told.used.add(String(href));
      mark(marks, 'sheetWalkWalked', [...told.walked].sort().join());
      mark(marks, 'sheetWalkUsed', [...told.used].sort().join());
    }
    if (writes >= WRITES || group === undefined) return;
    const v = cleanMark(said?.v);
    if (!v) return;
    const known = group?.v === v ? group.files : {};
    const now = Date.now();
    const files = Object.fromEntries(Object.entries(cleanFiles(said.files)).filter(([href, entry]) => needsKeep(known[href], entry, now)));
    // Files used as kept: the group's use, for the cap's order, once a day at most.
    const used = group?.v === v && Array.isArray(said.used) && said.used.length > 0 && !(now - group.at < USED_EVERY_MS);
    if (!Object.keys(files).length && !used) return;
    writes++;
    group = { v, at: now, files: { ...known, ...files } };
    void send('keepSheetWalk', { v, files }, false);
  });
}
