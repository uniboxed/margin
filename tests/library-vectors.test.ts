// The library's shared vectors (tests/fixtures/library/, docs/CORE-REFACTOR.md step 4, part 8) against library.ts:
// every case's steps, in order, each from the case's values with the earlier steps' expected changes merged in. As
// JavaScriptCore ran it (Margin.app's until step 4's switch), with no `URL`, but a `url` step: that one with Node's `URL`, the browsers'
// answer (Tirth's answer 11), and it must differ without. A throw's words are Node's for its site (throws.json); half an
// emoji left by a cut is dropped before comparing (Tirth's answer 3). margin-core runs the same files
// (app/shared/core/src/library/vectors.rs; with the Mac's sorter, margin-ffi's library_tests.rs), which Margin.app runs
// since the switch. Re-recorded with `npm run library:vectors`, only
// with a rule changed on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as L from '../app/shared/library/library.ts';
import { dropLoneSurrogates, sortValues } from './library-vectors/log.ts';

const DIR = new URL('./fixtures/library/', import.meta.url);
const files = readdirSync(new URL('cases/', DIR)).filter((f) => f.endsWith('.json')).sort();
const read = (path: string) => JSON.parse(readFileSync(new URL(path, DIR), 'utf8'));
const throws: Record<string, { node: string, jsc: string }> = read('throws.json').sites;
const KINDS = ['perform', 'snapshot', 'import', 'normal', 'target'] as const;

function withoutUrl<T>(f: () => T): T {
  const saved = globalThis.URL;
  delete (globalThis as any).URL;
  try { return f(); } finally { globalThis.URL = saved; }
}
const merge = (values: any, changes: any[] = []) => {
  const next: Record<string, any> = { ...values };
  for (const c of changes) {
    const list = { ...(next[c.collection] ?? {}) };
    if (c.deleted) delete list[c.id]; else list[c.id] = c.value;
    next[c.collection] = list;
  }
  return sortValues(next);
};
const plain = (v: unknown) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

function answer(step: any, values: any, url = false) {
  const run = () => {
    if ('perform' in step) {
      const o = L.perform(values, step.perform, step.payload, step.env);
      return plain({ ok: o.ok, result: o.ok ? (o.result ?? null) : null, ...(o.ok ? {} : { error: o.error }), changes: o.changes, requests: o.requests });
    }
    if ('snapshot' in step) return plain(L.snapshot(values));
    if ('import' in step) return plain(L.importValues(values, step.import.sets, step.import.order, { now: step.import.now }));
    if ('normal' in step) return plain(L.valuesOf(L.stateOf(values), values?.imports ?? {}));
    return plain(L.targetOf(step.target));
  };
  return url ? run() : withoutUrl(run);
}
const expected = (step: any) => {
  const site = step.expect?.error?.failed;
  return site ? { ...step.expect, error: `failed: ${throws[site].node}` } : step.expect;
};

const seen: Record<string, number> = {};
for (const file of files) {
  test(`library vectors: ${file}`, () => {
    const group = read(`cases/${file}`);
    assert.ok(Array.isArray(group.cases) && group.cases.length, 'cases');
    for (const [ci, c] of group.cases.entries()) {
      let values = c.values;
      for (const [si, step] of c.steps.entries()) {
        const kind = KINDS.find((k) => k in step)!;
        seen[kind] = (seen[kind] ?? 0) + 1;
        const where = `${file} case ${ci} (${c.about}) step ${si} (${kind} ${step.perform ?? ''})`;
        if (step.engine !== 'jsc') assert.deepEqual(dropLoneSurrogates(answer(step, values, step.url === true)), expected(step), where);
        if (step.url) {
          seen.url = (seen.url ?? 0) + 1;
          assert.notDeepEqual(dropLoneSurrogates(answer(step, values)), expected(step), `${where}: a url step answers otherwise with no URL`);
        }
        if (kind === 'perform' || kind === 'import') values = merge(values, step.expect.changes);
      }
    }
  });
}

test('library vectors: every kind of step, every action, every throw site', () => {
  for (const kind of KINDS) assert.ok(seen[kind] > 0, `${kind} steps`);
  assert.ok(seen.url >= 70, `the url steps: ${seen.url}`);
  const actions = new Set<string>();
  const sites = new Set<string>();
  for (const file of files) for (const c of read(`cases/${file}`).cases) for (const s of c.steps) {
    if ('perform' in s) actions.add(s.perform);
    if (s.expect?.error?.failed) sites.add(s.expect.error.failed);
  }
  for (const name of L.ACTION_NAMES) assert.ok(actions.has(name), `a vector of ${name}`);
  assert.deepEqual([...sites].sort(), Object.keys(throws).sort(), 'each site in throws.json has a vector, and each vector\'s site is there');
  for (const s of Object.values(throws)) assert.ok(s.jsc && s.node, 'both engines\' words');
});
