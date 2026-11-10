// The page box's kept sheet walks (shared/sheet-walk.ts, GitHub issue #3): which addresses name their contents,
// what's kept and how it's checked before it's used, the caps, and the background's writer
// (background/sheet-walks.ts). The walk itself, kept and used, runs in browsers: tests/e2e/sheet-walk.test.ts and
// the box pattern kept-sheet-walk (both engines).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_AGE_MS, MAX_ENTRY_CHARS, MAX_GROUP_CHARS, MAX_ORIGIN_FILES, SHEET_WALK_INDEX, capIndex, cleanEntry, cleanFiles, contentNamed, decodeItems,
  encodeItems, hash, isSheetWalkKey, mergeGroup, needsKeep, planFrom, ruleAt, sameEntry, sheetWalkKey, usable,
} from '../extension/shared/sheet-walk.ts';
import { createSheetWalks } from '../extension/background/sheet-walks.ts';
import { firstReadKeys, onlyMark, pageKeys } from '../extension/shared/stored.ts';

const NOW = Date.UTC(2026, 10, 10, 12);
const T = Math.floor(NOW / 1000);
const entry = (over = {}) => ({ n: 3, w: 'u0:abc|m1:def', t: T, ...over });

test('an address names its contents: a hash in its name or its query, or an integrity its <link> is held to', () => {
  for (const href of [
    'https://github.githubassets.com/assets/primer-5e94d7f3a59af8da.css',
    'https://github.githubassets.com/assets/landing-pages.30188270c594ac18.module.css',
    'https://example.com/_next/static/css/a1b2c3d4e5f60718.css',
    'https://example.com/assets/index-BZz3a8Qd.css', // Vite
    'https://example.com/styles.css?v=9f8e7d6c5b4a',
    'https://cdn.example.com/build/3e154969b9f9/site.css',
  ]) assert.ok(contentNamed(href), href);
  for (const href of [
    'https://example.com/styles.css',
    'https://example.com/css/main-20231101.css', // a date
    'https://example.com/css/bootstrap4.min.css',
    'https://example.com/css/MyStylesheet2024.css', // a word, not a hash
    'https://example.com/load.php?lang=en&modules=site.styles&only=styles&skin=vector-2022',
    'https://example.com/style.css?ver=6.4.2',
    'https://example.com/a/deadbeefcafe.css', // hex, but a word: no digit
    'data:text/css,a{}',
    'not a url',
  ]) assert.ok(!contentNamed(href), href);
  assert.ok(contentNamed('https://example.com/styles.css', 'sha384-abc'), 'an integrity is the browser\'s own proof');
  assert.ok(!contentNamed(`https://example.com/${'a1'.repeat(1100)}.css`), 'too long an address');
});

test('the keys: one per page origin and an index, never read with the state', () => {
  assert.equal(sheetWalkKey('https://github.com'), 'sheetWalk:https://github.com');
  assert.ok(isSheetWalkKey(sheetWalkKey('https://a.example')) && isSheetWalkKey(SHEET_WALK_INDEX) && !isSheetWalkKey('settings'));
  const seen = [sheetWalkKey('https://a.example'), SHEET_WALK_INDEX, 'settings'];
  assert.ok(!pageKeys(seen).some(isSheetWalkKey) && !firstReadKeys(seen).some(isSheetWalkKey), 'a page never reads them with its state, even once it has seen them change');
  assert.ok(onlyMark({ [sheetWalkKey('https://a.example')]: {}, [SHEET_WALK_INDEX]: {} }), 'their change draws nothing');
  assert.ok(!onlyMark({ [sheetWalkKey('https://a.example')]: {}, settings: {} }));
});

test('the rules that need work, as kept: kinds, paths and checks, and nothing else', () => {
  const items = [{ kind: 'u', path: [12], check: hash('a') }, { kind: 'm', path: [3, 0, 7], check: hash('b') }, { kind: 'i', path: [0], check: hash('c') }];
  const w = encodeItems(items as any);
  assert.deepEqual(decodeItems(w), items);
  assert.deepEqual(decodeItems(''), []);
  for (const bad of ['x1:abc', 'u:abc', 'u1abc', 'u1:ABC', 'u1:abc|', 'u1.:abc', 'u1:abcdefghi', 7]) assert.equal(decodeItems(bad as any), null, String(bad));
  assert.equal(hash('same'), hash('same'));
  assert.notEqual(hash('#a{width:50vw}'), hash('#a{width:60vw}'));
});

test('an entry from the page\'s world is taken only as it should be, and small', () => {
  assert.deepEqual(cleanEntry({ n: 3, w: 'u0:abc', t: T, s: 120, r: '', h: [['2', 'body:has(.x)']], extra: 1 }), { n: 3, w: 'u0:abc', t: T, s: 120, h: [['2', 'body:has(.x)']] });
  for (const bad of [null, 'x', { w: '' }, { n: -1, w: '', t: T }, { n: 1, w: 'nope', t: T }, { n: 1, w: '', t: 'x' }, { n: 1, w: '', t: T, s: -2 },
    { n: 1, w: '', t: T, h: [['1', 'body .x']] }, { n: 1, w: '', t: T, h: [['a', 'body:has(.x)']] }, { n: 1, w: '', t: T, h: 'body:has(.x)' }]) {
    assert.equal(cleanEntry(bad), null, JSON.stringify(bad));
  }
  const big = { n: 1, w: '', t: T, h: Array.from({ length: 2000 }, (_, i) => [String(i), `.c${i}:has(.x)`]) };
  assert.ok(JSON.stringify(big).length > MAX_ENTRY_CHARS);
  assert.equal(cleanEntry(big), null, 'too large to keep: the full walk each time');
  const files = cleanFiles({
    'https://a.example/app-3f9a1c2b7d.css': entry(),
    'https://a.example/app.css': entry(), // not content-named: never kept
    'https://a.example/bad-3f9a1c2b7d.css': { n: 'x' },
  });
  assert.deepEqual(Object.keys(files), ['https://a.example/app-3f9a1c2b7d.css']);
  const many = Object.fromEntries(Array.from({ length: MAX_ORIGIN_FILES + 5 }, (_, i) => [`https://a.example/f${i}-3f9a1c2b7d.css`, entry()]));
  assert.equal(Object.keys(cleanFiles(many)).length, MAX_ORIGIN_FILES);
});

// A style sheet as the plan reads it: rules with a kind, their text, and rules nested in them.
const rule = (kind: string, text: string, cssRules: any[] = []) => ({ kind, text, cssRules });
const read = (kind: string, r: any) => (r.kind === (kind === 'h' ? 'u' : kind) ? { check: kind === 'h' ? r.text : hash(r.text), said: r.text } : null);
const sheet = () => [
  rule('u', '#a { width: 50vw }'),
  rule('x', '.plain { color: red }'),
  rule('m', '(min-width: 900px)', [rule('u', '.b:has(.c) { height: 10vh }'), rule('x', '.d {}')]),
];
const kept = () => ({ n: 3, t: T, w: encodeItems([{ kind: 'u', path: [0], check: hash('#a { width: 50vw }') }, { kind: 'm', path: [2], check: hash('(min-width: 900px)') }, { kind: 'u', path: [2, 0], check: hash('.b:has(.c) { height: 10vh }') }] as any), h: [['2.0', '.b:has(.c) { height: 10vh }']] as [string, string][] });

test('a kept walk is used only once every rule it names is found, at its place, as it was', () => {
  const plan = planFrom(kept(), sheet(), read);
  assert.deepEqual(plan!.work.map((w) => [w.kind, w.said]), [['u', '#a { width: 50vw }'], ['m', '(min-width: 900px)'], ['u', '.b:has(.c) { height: 10vh }']]);
  assert.deepEqual(plan!.has, ['.b:has(.c) { height: 10vh }']);
  assert.equal(ruleAt(sheet(), [2, 1]).text, '.d {}');
  assert.equal(ruleAt(sheet(), [2, 5]), null);
  assert.equal(ruleAt(sheet(), [1, 0]), null, 'no rules in it');

  const more = [...sheet(), rule('x', '.e {}')];
  assert.equal(planFrom(kept(), more, read), null, 'a rule more: the full walk');
  const edited = sheet();
  edited[0] = rule('u', '#a { width: 60vw }');
  assert.equal(planFrom(kept(), edited, read), null, 'a kept rule with another value');
  const moved = sheet();
  [moved[0], moved[1]] = [moved[1], moved[0]];
  assert.equal(planFrom(kept(), moved, read), null, 'a kept rule not at its place (another kind there)');
  const gone = sheet();
  gone[2] = rule('m', '(min-width: 900px)', []);
  assert.equal(planFrom(kept(), gone, read), null, 'a nested rule not there');
  const query = sheet();
  query[2] = rule('m', '(min-width: 901px)', sheet()[2].cssRules);
  assert.equal(planFrom(kept(), query, read), null, 'a query that changed');
  const has = { ...kept(), h: [['2.0', '.b:has(.z) { height: 10vh }']] as [string, string][] };
  assert.equal(planFrom(has, sheet(), read), null, 'a :has() selector not as kept');
});

test('what\'s kept is too old to use after a day, and is kept again then', () => {
  assert.ok(usable(entry(), NOW) && usable(entry(), NOW + MAX_AGE_MS - 1000));
  assert.ok(!usable(entry(), NOW + MAX_AGE_MS + 1000), 'a day old: the full walk, and what it finds kept');
  assert.ok(!usable(entry({ t: T + 3600 }), NOW), 'from the future (a clock set back): not trusted');
  assert.ok(sameEntry(entry(), { t: T + 50, w: 'u0:abc|m1:def', n: 3 }), 'the same, whatever the order of its keys or when');
  assert.ok(!sameEntry(entry(), entry({ w: 'u0:abc' })) && !sameEntry(entry(), entry({ s: 10 })) && !sameEntry(entry(), null));
  assert.ok(!needsKeep(entry(), entry({ t: T + 60 }), NOW + 60_000), 'walked again as kept, soon after (it came too late to use): no write');
  assert.ok(needsKeep(entry(), entry({ t: T + 13 * 3600 }), NOW + 13 * 3600_000), 'as kept, but half a day on: kept again, with its new time');
  assert.ok(needsKeep(entry(), entry({ n: 4 }), NOW) && needsKeep(undefined, entry(), NOW));
});

test('an origin\'s group: what\'s new taken in, nothing written when nothing changed, another mark replaced', () => {
  const a = 'https://a.example/a-3f9a1c2b7d.css';
  const b = 'https://a.example/b-3f9a1c2b7d.css';
  const g1 = mergeGroup(null, 'm1', { [a]: entry() }, NOW)!;
  assert.deepEqual(g1, { v: 'm1', at: NOW, files: { [a]: entry() } });
  assert.equal(mergeGroup(g1, 'm1', { [a]: entry() }, NOW + 1), null, 'the same: no write');
  assert.equal(mergeGroup(g1, 'm1', {}, NOW + 1), null);
  const g2 = mergeGroup(g1, 'm1', { [b]: entry({ n: 9 }), [a]: entry({ n: 4 }) }, NOW + 2)!;
  assert.deepEqual(Object.keys(g2.files), [b, a]);
  assert.equal(g2.files[a].n, 4, 'a changed file replaced');
  assert.equal(mergeGroup(g2, 'm1', { [a]: entry({ n: 4, t: T + 999 }) }, NOW + 3)!.files[a].t, T + 999, 'walked again later: its time kept');
  assert.deepEqual(Object.keys(mergeGroup(g2, 'm2', { [a]: entry() }, NOW + 3)!.files), [a], 'another walk\'s mark (Margin or the browser updated): all of it replaced');
  let g: any = null;
  for (let i = 0; i < MAX_ORIGIN_FILES + 3; i++) g = mergeGroup(g, 'm1', { [`https://a.example/f${i}-3f9a1c2b7d.css`]: entry() }, NOW + i);
  assert.equal(Object.keys(g.files).length, MAX_ORIGIN_FILES);
  assert.ok(!(`https://a.example/f0-3f9a1c2b7d.css` in g.files) && `https://a.example/f${MAX_ORIGIN_FILES + 2}-3f9a1c2b7d.css` in g.files, 'the oldest go first');
  // Large entries: the group stays under MAX_GROUP_CHARS, the newest kept.
  const large = (i: number) => entry({ h: Array.from({ length: 200 }, (_, j) => [String(j), `.c${i}-${j}:has(.x)`]) });
  let lg: any = null;
  for (let i = 0; i < 20; i++) lg = mergeGroup(lg, 'm1', { [`https://a.example/l${i}-3f9a1c2b7d.css`]: large(i) }, NOW + i);
  assert.ok(JSON.stringify(lg.files).length <= MAX_GROUP_CHARS, `${JSON.stringify(lg.files).length} chars`);
  assert.ok(Object.keys(lg.files).length < 20 && `https://a.example/l19-3f9a1c2b7d.css` in lg.files);
});

test('the cap: files and characters in all, the origins used least recently dropped first, never the one written', () => {
  const index = { 'https://old.example': [NOW - 3000, 30, 1000], 'https://mid.example': [NOW - 2000, 30, 1000], 'https://new.example': [NOW - 1000, 30, 1000], bad: 'x', short: [NOW, 1] };
  const { index: next, drop } = capIndex(index as any, 'https://w.example', 20, 1000, NOW, { maxFiles: 70 });
  assert.deepEqual(drop, ['https://old.example', 'https://mid.example']);
  assert.deepEqual(Object.keys(next).sort(), ['https://new.example', 'https://w.example']);
  assert.deepEqual(next['https://w.example'], [NOW, 20, 1000]);
  assert.deepEqual(capIndex(index as any, 'https://w.example', 1, 2500, NOW, { maxChars: 4000 }).drop, ['https://old.example', 'https://mid.example'], 'by size too');
  assert.deepEqual(capIndex(null, 'https://w.example', 500, 9e6, NOW, { maxFiles: 80, maxChars: 1000 }).drop, [], 'alone, even over the cap (its own caps hold it)');
});

// storage.local as the background has it, its calls logged.
function fakeStorage(start: Record<string, any> = {}) {
  const data: Record<string, any> = structuredClone(start);
  const log: string[] = [];
  return {
    data, log,
    get: async (keys: string[]) => { log.push(`get ${keys.join(',')}`); return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])])); },
    set: async (items: Record<string, any>) => { log.push(`set ${Object.keys(items).join(',')}`); Object.assign(data, structuredClone(items)); },
    remove: async (keys: string[]) => { log.push(`remove ${keys.join(',')}`); for (const k of keys) delete data[k]; },
  };
}

test('the background keeps a page\'s walks under its own origin, one write at a time, and caps them', async () => {
  const store = fakeStorage();
  const walks = createSheetWalks(() => store);
  const a = 'https://a.example/a-3f9a1c2b7d.css';
  assert.equal(await walks.keep('https://a.example', 'm1', { [a]: entry(), 'https://a.example/plain.css': entry() }, NOW), true);
  assert.deepEqual(Object.keys(store.data[sheetWalkKey('https://a.example')].files), [a], 'only content-named files');
  assert.deepEqual(store.data[SHEET_WALK_INDEX], { 'https://a.example': [NOW, 1, JSON.stringify(store.data[sheetWalkKey('https://a.example')]).length] });
  assert.equal(await walks.keep('https://a.example', 'm1', { [a]: entry() }, NOW + 5), false, 'nothing new: no write');
  assert.equal(await walks.keep('https://a.example', 'm1', {}, NOW + 9), true, 'used: the group\'s time');
  assert.equal(store.data[SHEET_WALK_INDEX]['https://a.example'][0], NOW + 9);
  for (const [origin, mark] of [['', 'm1'], ['javascript:', 'm1'], ['https://a.example/path', 'm1'], ['https://a.example', ''], ['https://a.example', 'M!']]) {
    assert.equal(await walks.keep(origin, mark, { [a]: entry() }, NOW), false, `${origin} ${mark}`);
  }
  // Several at once (pages of several sites saying at once): each write sees the one before it, the index has them all.
  const sites = Array.from({ length: 12 }, (_, i) => `https://s${i}.example`);
  await Promise.all(sites.map((o, i) => walks.keep(o, 'm1', Object.fromEntries(Array.from({ length: 30 }, (_, j) => [`${o}/f${j}-3f9a1c2b7d.css`, entry()])), NOW + 100 + i)));
  const index = store.data[SHEET_WALK_INDEX];
  const total = Object.values(index).reduce((sum: number, [, n]: any) => sum + n, 0);
  assert.ok(total <= 300, `${total} files kept in all`);
  assert.deepEqual(Object.keys(store.data).filter((k) => k.startsWith('sheetWalk:')).sort(), Object.keys(index).map(sheetWalkKey).sort(), 'the index and the keys agree');
  assert.ok(!('https://a.example' in index) && !(sheetWalkKey('https://a.example') in store.data), 'the origin used longest ago went first');
  assert.ok(index['https://s11.example'], 'the newest stays');
  const failing = createSheetWalks(() => ({ ...store, set: async () => { throw new Error('quota'); } }));
  assert.equal(await failing.keep('https://z.example', 'm1', { 'https://z.example/z-3f9a1c2b7d.css': entry() }, NOW), false, 'a failed write: false, and the next still runs');
  assert.equal(await failing.keep('https://z.example', 'm1', { 'https://z.example/z-3f9a1c2b7d.css': entry() }, NOW), false);
});
