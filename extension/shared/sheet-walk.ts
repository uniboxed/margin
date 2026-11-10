// What the page box's walk of a style sheet found (content/page/sheets.ts), kept per file, so a return visit
// touches only the rules that need it instead of every rule (GitHub: some 38,000 rules, about 450 to rewrite).
// GitHub issue #3. Pure: the page's world (sheets.ts), Margin's content script (content/sheet-walk-link.ts) and the
// background (background/handlers.ts keepSheetWalk) share it, and node tests it.
//
// Only for a file whose address names its contents (contentNamed: a hash in its name or query, or an `integrity`
// on its <link>): a file that changes under the same address can't be told from the same file without reading all
// of it, so every other file gets the full walk, every time. And a kept entry is checked before it's used (the
// sheet's rule count, its size where the browser says, and each kept rule at its place: its kind and a hash of its
// selector and text): anything off, and the file gets the full walk, and what that finds replaces the entry. What
// no check short of the full walk sees (a content-named file changed in place, a rule that needed nothing now
// needing work, its size and rule count the same) is right again within a day: an entry older than MAX_AGE_MS
// isn't used, and the full walk that runs instead keeps it again.
//
// Kept in Margin's own storage.local, never the site's, never sent anywhere: one key per page origin (`sheetWalk:
// <origin>`, read by that origin's pages only, so a page can only ever feed itself), and an index of them (when each
// was last used, how many files, how large), written only by the background, capped (MAX_FILES and MAX_CHARS in all,
// the least recently used origins dropped first; an origin's own at MAX_ORIGIN_FILES and MAX_GROUP_CHARS: a page
// that sends all it may still can't take much of Margin's storage), gone with Margin's data. Pages never read these keys with the state (shared/stored.ts).

export const SHEET_WALK_PREFIX = 'sheetWalk:';
export const SHEET_WALK_INDEX = 'sheetWalkIndex';
export const isSheetWalkKey = (key: string) => key === SHEET_WALK_INDEX || key.startsWith(SHEET_WALK_PREFIX);
export const sheetWalkKey = (origin: string) => `${SHEET_WALK_PREFIX}${origin}`;

/** Files and characters kept in all, and per page origin; an entry's largest size (larger: the full walk each time). */
export const MAX_FILES = 300;
export const MAX_CHARS = 1_000_000;
export const MAX_ORIGIN_FILES = 40;
export const MAX_GROUP_CHARS = 64_000;
export const MAX_ENTRY_CHARS = 24_000;
const MAX_HREF = 2048;
const MAX_MARK = 32;
/** A group's use is written again at most this often (its `at`, for the cap's order). */
export const USED_EVERY_MS = 24 * 3600 * 1000;
/** An entry older than this isn't used: the full walk, and what it finds kept again (`t`). */
export const MAX_AGE_MS = 24 * 3600 * 1000;

/**
 * One file's walk. `n`: its rule count; `s`: its size as the browser decoded it, where it says (0: it doesn't);
 * `r`: its <link>'s `integrity`; `w`: the rules that need the box's work, as `<kind><path>:<check>` joined by `|`:
 * kind `u` (a style with viewport units), `m` (a @media about the window's size), `i` (an @import, walked as its
 * own file); path the indices down to it (`12.3`); check a hash (hash below) of what the walk read there. `h`: the
 * selectors with `:has(` in them, each with its path. `t`: when it was walked, in seconds.
 */
export type Entry = { n: number, w: string, t: number, s?: number, r?: string, h?: [string, string][] };
/** A page origin's files, under the mark of the walk that made them (`v`: a group under another mark is ignored). */
export type Group = { v: string, at: number, files: Record<string, Entry> };
/** origin → [last used, files, characters] */
export type Index = Record<string, [number, number, number]>;
export type Kind = 'u' | 'm' | 'i';
export type Item = { kind: Kind, path: number[], check: string };

// FNV-1a, 32 bits, in base 36: a check, not a secret.
export function hash(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// A piece of an address that's a content hash: hex (8 or more, with a digit and a letter: not a date, not a word),
// or base64-like (8 or more letters and digits, both cases and a digit, no run of 4 lowercase letters: not a word,
// as `index-BZz3a8Qd.css` from Vite). A hash that happens to look like neither costs only the full walk.
const HEX = /^[0-9a-f]{8,64}$/i;
const B64 = /^[A-Za-z0-9]{8,64}$/;
function hashLike(token: string) {
  if (!/\d/.test(token)) return false;
  if (HEX.test(token)) return /[a-f]/i.test(token);
  return B64.test(token) && /[A-Z]/.test(token) && /[a-z]/.test(token) && !/[a-z]{4}/.test(token);
}

/** Whether a style sheet's address names its contents (`integrity`: its <link>'s, which the browser holds it to). */
export function contentNamed(href: string, integrity = '') {
  if (typeof href !== 'string' || href.length > MAX_HREF) return false;
  let url;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (integrity) return true;
  const tokens = [...url.pathname.split(/[/._~+-]/), ...[...url.searchParams.values()].flatMap((v) => v.split(/[/._~+,-]/))];
  return tokens.some(hashLike);
}

export const pathText = (path: number[]) => path.join('.');

export function encodeItems(items: Item[]) {
  return items.map((item) => `${item.kind}${pathText(item.path)}:${item.check}`).join('|');
}

/** The items of `w`, or null if it isn't what encodeItems makes. */
export function decodeItems(w: string): Item[] | null {
  if (typeof w !== 'string') return null;
  if (!w) return [];
  const out: Item[] = [];
  for (const part of w.split('|')) {
    const m = /^([umi])(\d{1,6}(?:\.\d{1,6}){0,15}):([0-9a-z]{1,8})$/.exec(part);
    if (!m) return null;
    out.push({ kind: m[1] as Kind, path: m[2].split('.').map(Number), check: m[3] });
  }
  return out;
}

const PATH = /^\d{1,6}(?:\.\d{1,6}){0,15}$/;
/** An entry as kept, or null if it isn't one (from the page's world: anything). */
export function cleanEntry(raw: any): Entry | null {
  if (!raw || typeof raw !== 'object') return null;
  const { n, s, r, w, h, t } = raw;
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000) return null;
  if (!Number.isInteger(t) || t < 0) return null;
  if (s !== undefined && (!Number.isInteger(s) || s < 0)) return null;
  if (r !== undefined && (typeof r !== 'string' || r.length > 1024)) return null;
  if (decodeItems(w) == null) return null;
  if (h !== undefined && (!Array.isArray(h) || !h.every((pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && PATH.test(pair[0]) && typeof pair[1] === 'string' && pair[1].includes(':has(')))) return null;
  const entry: Entry = { n, w, t };
  if (s) entry.s = s;
  if (r) entry.r = r;
  if (h?.length) entry.h = h.map(([p, sel]: [string, string]) => [p, sel]);
  return JSON.stringify(entry).length <= MAX_ENTRY_CHARS ? entry : null;
}

/** Whether two entries say the same (whatever their keys' order: storage doesn't keep it; `when`: and their time). */
export const sameEntry = (a: Entry | null | undefined, b: Entry | null | undefined, when = false) => !!a && !!b && JSON.stringify([a.n, a.w, a.s ?? 0, a.r ?? '', a.h ?? [], when ? a.t : 0]) === JSON.stringify([b.n, b.w, b.s ?? 0, b.r ?? '', b.h ?? [], when ? b.t : 0]);

/** Whether an entry may be used at `now` (ms): walked less than MAX_AGE_MS ago (and not after now: a clock set back). */
export const usable = (entry: Entry | null | undefined, now: number) => !!entry && Number.isInteger(entry.t) && now - entry.t * 1000 < MAX_AGE_MS && entry.t * 1000 <= now + 60_000;

/**
 * Whether a file the page walked in full (`entry`) is worth a write against what was kept (`known`): something in
 * it changed, or the kept one is half its life old (a walk as kept, which runs when the kept walks came too late
 * to use, writes nothing until then).
 */
export const needsKeep = (known: Entry | null | undefined, entry: Entry, now: number) => !sameEntry(known, entry) || now - known!.t * 1000 > MAX_AGE_MS / 2;

/** A page's files, as kept: only content-named addresses, only clean entries, at most MAX_ORIGIN_FILES. */
export function cleanFiles(raw: any): Record<string, Entry> {
  const out: Record<string, Entry> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [href, value] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_ORIGIN_FILES) break;
    const entry = cleanEntry(value);
    if (entry && contentNamed(href, entry.r ?? '')) out[href] = entry;
  }
  return out;
}

export const cleanMark = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= MAX_MARK && /^[0-9a-z]+$/.test(v) ? v : null);

/**
 * The origin's group with a page's files taken in (`files`: from cleanFiles), or null when nothing in it changed
 * (no write). A group under another mark is replaced. Files beyond MAX_ORIGIN_FILES, or past MAX_GROUP_CHARS: the
 * ones the group had longest go first (an object keeps its keys' order: what's taken in goes last).
 */
export function mergeGroup(group: Group | null | undefined, mark: string, files: Record<string, Entry>, now: number): Group | null {
  const kept = group && group.v === mark && group.files && typeof group.files === 'object' ? group.files : {};
  const changed = Object.entries(files).filter(([href, entry]) => !sameEntry(kept[href], entry, true));
  if (!changed.length) return null;
  const next: Record<string, Entry> = {};
  for (const [href, entry] of Object.entries(kept)) if (!changed.some(([h]) => h === href)) next[href] = entry;
  for (const [href, entry] of changed) next[href] = entry;
  const hrefs = Object.keys(next);
  for (const href of hrefs.slice(0, Math.max(0, hrefs.length - MAX_ORIGIN_FILES))) delete next[href];
  let chars = JSON.stringify(next).length;
  for (const href of Object.keys(next)) {
    if (chars <= MAX_GROUP_CHARS) break;
    chars -= JSON.stringify(next[href]).length + href.length + 4;
    delete next[href];
  }
  return { v: mark, at: now, files: next };
}

/**
 * The index with `origin` at `files` files of `chars` characters, used at `now`, and the origins to drop to keep
 * MAX_FILES and MAX_CHARS in all: the least recently used first, never the one just written.
 */
export function capIndex(index: Index | null | undefined, origin: string, files: number, chars: number, now: number, { maxFiles = MAX_FILES, maxChars = MAX_CHARS } = {}) {
  const next: Index = {};
  for (const [o, v] of Object.entries(index ?? {})) {
    if (Array.isArray(v) && Number.isFinite(v[0]) && Number.isInteger(v[1]) && Number.isInteger(v[2])) next[o] = [v[0], v[1], v[2]];
  }
  next[origin] = [now, files, chars];
  let total = Object.values(next).reduce((sum, [, n]) => sum + n, 0);
  let size = Object.values(next).reduce((sum, [, , c]) => sum + c, 0);
  const drop: string[] = [];
  for (const [o] of Object.entries(next).filter(([o]) => o !== origin).sort((a, b) => a[1][0] - b[1][0])) {
    if (total <= maxFiles && size <= maxChars) break;
    total -= next[o][1];
    size -= next[o][2];
    delete next[o];
    drop.push(o);
  }
  return { index: next, drop };
}

/** A rule as the plan needs it: what the page's world reads of a CSSOM rule (content/page/sheets.ts). */
export type RuleList = { length: number, [i: number]: any };
/**
 * The rule at `path` in `rules`, or null.
 * */
export function ruleAt(rules: RuleList, path: number[]) {
  let list: RuleList | null | undefined = rules;
  let rule = null;
  for (const i of path) {
    if (!list || i >= list.length) return null;
    rule = list[i];
    if (!rule) return null;
    list = rule.cssRules;
  }
  return rule;
}

/**
 * What a kept entry says to do in `rules`, each rule found and checked first (`read(kind, rule)`: the check of
 * what's there now, the hash of what the walk read, or null if it's not that kind of rule; `said`: what it read,
 * handed back for the work), or null if anything is off: the rule count, a rule missing or not as it was, a :has()
 * selector not there. Nothing is done until all of it checks.
 */
export function planFrom<T>(entry: Entry, rules: RuleList, read: (kind: Kind | 'h', rule: any) => { check: string, said: T } | null) {
  if (rules.length !== entry.n) return null;
  const items = decodeItems(entry.w);
  if (!items) return null;
  const work: { kind: Kind, rule: any, said: T }[] = [];
  for (const item of items) {
    const rule = ruleAt(rules, item.path);
    const now = rule ? read(item.kind, rule) : null;
    if (!now || now.check !== item.check) return null;
    work.push({ kind: item.kind, rule, said: now.said });
  }
  const has: string[] = [];
  for (const [p, selector] of entry.h ?? []) {
    const rule = ruleAt(rules, p.split('.').map(Number));
    const now = rule ? read('h', rule) : null;
    if (!now || now.check !== selector) return null;
    has.push(selector);
  }
  return { work, has };
}
