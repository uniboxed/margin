// What the recorder keeps while a test file runs (hooks.ts writes it out), and how a call's inputs are made the
// vectors' (the same for the recorded calls, the generated sequences and the survey):
// - plain JSON (the app gave library.js JSON text, LibraryRules.swift, until step 4's switch), each collection's ids in code-point order
//   (the order margin-core's store reads them in: DataSet's BTreeMap; docs/CORE-REFACTOR.md step 4, part 4's "first of
//   several");
// - every env's ids given, valid, and enough (never library.ts's Math.random fallback): the test's own first, then
//   fixed ones.

export type Call =
  | { kind: 'perform', test: string, values: any, action: string, payload: any, env: { now: number, ids: string[] }, out: any }
  | { kind: 'snapshot', test: string, values: any, out: any }
  | { kind: 'import', test: string, values: any, sets: any[], order: any[], now: number, out: any }
  | { kind: 'normal', test: string, values: any, out: any }
  | { kind: 'target', test: string, raw: any, out: any };

export const calls: Call[] = [];
export const current = { test: '' };

/** Code-point order (UTF-16 order differs past U+FFFF: never JS's default sort for ids). */
export const byCodePoint = (a: string, b: string) => {
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
};

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A value as JSON gives it back (undefined gone, -0 as 0, NaN as null). */
export const plain = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** The library's values as plain JSON with each collection's ids in code-point order. */
export function sortValues(values: unknown): any {
  const v = plain(values ?? {});
  if (!isObject(v)) return v;
  const out: Record<string, any> = {};
  for (const [collection, list] of Object.entries(v)) {
    out[collection] = isObject(list) ? Object.fromEntries(Object.keys(list).sort(byCodePoint).map((id) => [id, list[id]])) : list;
  }
  return out;
}

let pad = 0;
/** The env with the test's ids, then fixed ones: enough for any action (a clear of every item). */
// (An id given that isn't one, `x1`, stays: library.ts draws Math.random for its turn, and record.ts drops an answer
// that drew one.)
export function padEnv(env: any, need = 48): { now: number, ids: string[] } {
  const given: unknown[] = Array.isArray(env?.ids) ? env.ids : [];
  const ids = given.map((id) => (typeof id === 'string' ? id : ''));
  while (ids.length < given.length + need) ids.push(`zq${String(++pad).padStart(6, '0')}x`);
  return { now: Number.isFinite(env?.now) ? env.now : 0, ids };
}

/** A string (anywhere in a value) with half of a surrogate pair. */
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
export const hasLoneSurrogate = (v: unknown): boolean => new RegExp(LONE.source).test(rawStrings(v));
function rawStrings(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(rawStrings).join('\u0000');
  if (isObject(v)) return Object.entries(v).map(([k, x]) => `${k}\u0000${rawStrings(x)}`).join('\u0000');
  return '';
}
/** Every half of a surrogate pair dropped (Tirth's answer 3: a cut through an emoji drops the broken half). */
export function dropLoneSurrogates(v: any): any {
  if (typeof v === 'string') return v.replace(LONE, '');
  if (Array.isArray(v)) return v.map(dropLoneSurrogates);
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [dropLoneSurrogates(k), dropLoneSurrogates(x)]));
  return v;
}
