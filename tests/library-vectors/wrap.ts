// library.ts as the tests see it while the recorder runs them (hooks.ts sends their imports here): the same module,
// with perform, snapshot, importValues, stateOf, targetOf and call recorded. Each call is given its inputs as the
// vectors hold them (log.ts: plain JSON, ids in code-point order, enough ids), so what the test saw is what's recorded.
import * as L from '../../app/shared/library/library.ts';
import { calls, current, padEnv, plain, sortValues } from './log.ts';

export * from '../../app/shared/library/library.ts';

export function perform(values: L.Values, action: string, payload: any = {}, env: L.Env = { now: 0 }): L.Outcome {
  const v = sortValues(values);
  const p = plain(payload) ?? {};
  const e = padEnv(env);
  const out = L.perform(v, action, p, e);
  calls.push({ kind: 'perform', test: current.test, values: v, action, payload: p, env: e, out: plain(out) });
  return out;
}

export function snapshot(values: L.Values) {
  const v = sortValues(values);
  const out = L.snapshot(v);
  calls.push({ kind: 'snapshot', test: current.test, values: v, out: plain(out) });
  return out;
}

export function importValues(current_: L.Values, sets: L.ImportSet[], order: [string, string, string][] = [], env: L.Env = { now: 0 }) {
  const v = sortValues(current_);
  const s = (plain(sets) ?? []).map((set: any) => (set && typeof set === 'object' ? { ...set, values: sortValues(set.values) } : set));
  const o = plain(order) ?? [];
  const now = Number.isFinite(env?.now) ? env.now : 0;
  const out = L.importValues(v, s, o, { now });
  calls.push({ kind: 'import', test: current.test, values: v, sets: s, order: o, now, out: plain(out) });
  return out;
}

export function stateOf(values: L.Values) {
  const v = sortValues(values);
  calls.push({ kind: 'normal', test: current.test, values: v, out: plain(L.valuesOf(L.stateOf(v), v?.imports ?? {})) });
  return L.stateOf(v);
}

export function targetOf(raw: unknown) {
  const out = L.targetOf(plain(raw));
  calls.push({ kind: 'target', test: current.test, raw: plain(raw) ?? null, out: plain(out) ?? null });
  return out;
}

// The app's entry (JSON in and out): its perform, snapshot and importValues recorded as the direct ones.
export function call(name: string, args: string) {
  let list: any[];
  try { list = JSON.parse(args); } catch { return L.call(name, args); }
  if (!Array.isArray(list)) return L.call(name, args);
  if (name === 'perform') return JSON.stringify({ value: perform(list[0], list[1], list[2], list[3]) });
  if (name === 'snapshot') return JSON.stringify({ value: snapshot(list[0]) });
  if (name === 'importValues') return JSON.stringify({ value: importValues(list[0], list[1], list[2], list[3]) });
  return L.call(name, args);
}
