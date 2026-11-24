// npm run library:vectors: the library's shared vectors (docs/CORE-REFACTOR.md step 4, part 8;
// tests/fixtures/library/README.md), recorded from library.ts as Margin.app runs it today: in JavaScriptCore, where a
// bare JSContext has no `URL` (so no address is parsed: the URL finding, DECISIONS.md 2026-11-23).
//
// 1. The ten TS test files that use the library run under hooks.ts: every perform, snapshot, importValues, stateOf
//    and targetOf they make is recorded with its inputs as the vectors hold them (log.ts).
// 2. 300 generated sequences of 30 steps (generate.ts, seeded) and the throw survey (each action's every field as
//    each wrong JSON type) are made here.
// 3. Each step's answer is library.ts's in Node with `URL` taken away (as JSC has none): a step whose answer differs
//    with `URL` is marked `"url": true` (the URL commit re-records those). Half an emoji left by a cut is dropped
//    (Tirth's answer 3: `"cut": true`).
// 4. Every case runs again in JavaScriptCore (tools/library-vectors/jsc.swift: dist/app/library.js as the app builds
//    it, LibraryRules.swift's way): a step JSC answers differently keeps JSC's answer (`"engine": "jsc"`); a throw's
//    words are JSC's (throws.json), the vectors name its site.
// 5. js.json: the JavaScript semantics' cases (js-cases.js) as JSC answers them, checked against Node's.
//
// Re-made only on purpose: a rule changed in both copies, in the same commit (part 8, "must not change").
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import * as L from '../../app/shared/library/library.ts';
import { buildApp, CONDITIONS } from '../../scripts/build.ts';
import { dropLoneSurrogates, hasLoneSurrogate, padEnv, plain, sortValues, byCodePoint, type Call } from './log.ts';
import { random, library, payload, action, FIELDS, WRONG, field } from './generate.ts';
import { edges } from './edges.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = join(ROOT, 'tests/fixtures/library');
const TEST_FILES = ['library', 'arc-data', 'arc-qol', 'favorites', 'sticky-pins', 'nested-folders', 'split-model', 'split-view', 'media-player', 'air-traffic'];
const SEQUENCES = 300;
const STEPS = 30;
const SEED = 0x11b7a5e;
const tmp = mkdtempSync(join(tmpdir(), 'library-vectors-'));
const log = (s: string) => process.stdout.write(`${s}\n`);
const counts: Record<string, number> = {};
const count = (k: string, n = 1) => { counts[k] = (counts[k] ?? 0) + n; };

// ---- library.ts as JSC runs it: no URL, and no Math.random (an answer that drew one isn't a vector) ----
const realRandom = Math.random;
let draws = 0;
Math.random = () => { draws++; return realRandom(); };
const savedURL = globalThis.URL;
function withoutUrl<T>(f: () => T): T {
  // (`URL` is a global property of Node's: gone, `new URL` is a ReferenceError, as in a bare JSContext.)
  delete (globalThis as any).URL;
  try { return f(); } finally { (globalThis as any).URL = savedURL; }
}

type Expect = any;
type Step = Record<string, any>;
type Case = { about: string, values: any, steps: Step[] };
const SITE = Symbol('site');

/** library.ts's perform outcome as a vector's `expect`: `{ ok, result, error?, changes, requests }`. */
const outcome = (o: any) => ({ ok: o.ok === true, result: o.ok ? (o.result ?? null) : null, ...(o.ok ? {} : { error: o.error }), changes: o.changes ?? [], requests: o.requests ?? [] });

// A step's answer, computed from its inputs: the kind's library.ts call (no URL) → { expect, url, random }.
function answer(step: Step, values: any) {
  const run = () => {
    if ('perform' in step) return outcome(L.perform(values, step.perform, step.payload, step.env));
    if ('snapshot' in step) return plain(L.snapshot(values));
    if ('import' in step) return plain(L.importValues(values, step.import.sets, step.import.order, { now: step.import.now }));
    if ('normal' in step) return plain(L.valuesOf(L.stateOf(values), values?.imports ?? {}));
    return plain(L.targetOf(step.target)) ?? null;
  };
  const before = draws;
  const today = plain(withoutUrl(run));
  const drew = draws !== before;
  const parsed = plain(run());
  return { expect: today, url: !isDeepStrictEqual(today, parsed), random: drew || draws !== before };
}

/** The changes a step merges into the values (a perform's, an import's), as the store merges them. */
function merge(values: any, changes: any[] | undefined) {
  const next: Record<string, any> = { ...values };
  for (const c of changes ?? []) {
    const list = { ...(next[c.collection] ?? {}) };
    if (c.deleted) delete list[c.id]; else list[c.id] = c.value;
    next[c.collection] = list;
  }
  return sortValues(next);
}
const changesOf = (step: Step) => ('perform' in step ? step.expect.changes : 'import' in step ? step.expect.changes : undefined);
const clean = (v: any) => (hasLoneSurrogate(v) ? dropLoneSurrogates(v) : v);

// Finishes a step from its inputs: its answer, its flags. False: not a vector (an answer from Math.random).
function finish(step: Step, values: any): boolean {
  const { expect, url, random: drew } = answer(step, values);
  if (drew) { count('dropped: drew Math.random'); return false; }
  if (url) step.url = true;
  if (hasLoneSurrogate(expect)) { step.cut = true; step.expect = dropLoneSurrogates(expect); } else step.expect = expect;
  trimIds(step);
  return true;
}

// The fixed ids after the last one the answer shows go (two kept spare): an id taken and never shown changes nothing,
// so the core, given fewer, answers the same.
const PADDED = /^zq\d{6}x$/;
function trimIds(step: Step) {
  if (!step.env) return;
  const text = JSON.stringify(step.expect);
  const ids: string[] = step.env.ids;
  let last = -1;
  ids.forEach((id, i) => { if (!PADDED.test(id) || text.includes(id)) last = i; });
  step.env = { ...step.env, ids: ids.slice(0, Math.min(ids.length, last + 3)) };
}

// ---- 1. the TS tests' calls ----------------------------------------------------------------------------------
function recordTests(): Map<string, Call[]> {
  const out = new Map<string, Call[]>();
  const hooks = pathToFileURL(join(ROOT, 'tests/library-vectors/hooks.ts')).href;
  const jobs = TEST_FILES.map((name) => ({ name, file: join(tmp, `${name}.jsonl`) }));
  for (const { name, file } of jobs) {
    const r = spawnSync(process.execPath, ['--import', hooks, join(ROOT, `tests/${name}.test.ts`)], { cwd: ROOT, env: { ...process.env, LIBRARY_VECTORS_OUT: file }, encoding: 'utf8' });
    if (r.status !== 0) { log(r.stdout.slice(-4000)); log(r.stderr.slice(-4000)); throw new Error(`tests/${name}.test.ts failed under the recorder`); }
    const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Call) : [];
    out.set(name, lines);
    log(`recorded ${name}.test.ts: ${lines.length} calls`);
  }
  return out;
}

function stepOf(c: Call): Step {
  switch (c.kind) {
    case 'perform': return { perform: c.action, payload: clean(c.payload), env: c.env };
    case 'snapshot': return { snapshot: true };
    case 'import': return { import: { sets: clean(c.sets), order: clean(c.order), now: c.now } };
    case 'normal': return { normal: true };
    case 'target': return { target: clean(c.raw) };
  }
}

// The calls of one test as cases: a call that starts from the last one's values with its changes merged goes on
// the same case; any other starts a new one.
function casesOf(file: string, calls: Call[]): Case[] {
  const cases: Case[] = [];
  let cur: { c: Case, values: any, test: string } | null = null;
  const perTest = new Map<string, number>();
  for (const call of calls) {
    const step = stepOf(call);
    const values = call.kind === 'target' ? null : clean(call.values);
    const fits = cur && cur.test === call.test && (values === null || isDeepStrictEqual(values, cur.values));
    if (!fits) {
      if (values === null && cur && cur.test === call.test) { /* a target reads no values: it goes on */ } else {
        const n = (perTest.get(call.test) ?? 0) + 1;
        perTest.set(call.test, n);
        cur = { c: { about: `${file}.test.ts: ${call.test || '(top level)'}${n > 1 ? ` #${n}` : ''}`, values: values ?? {}, steps: [] }, values: values ?? {}, test: call.test };
        cases.push(cur.c);
      }
    }
    if (!finish(step, cur!.values)) { cur = null; continue; }
    // (What the test saw with URL, against today's without: noted by `url`.)
    cur!.c.steps.push(step);
    cur!.values = merge(cur!.values, changesOf(step));
  }
  return cases.filter((c) => c.steps.length);
}

// ---- 2. generated sequences, the survey -----------------------------------------------------------------------
function generated(): Case[] {
  const r = random(SEED);
  const out: Case[] = [];
  for (let n = 0; n < SEQUENCES; n++) {
    const values = sortValues(clean(library(r)));
    const c: Case = { about: `sequence ${n} (seed ${SEED.toString(16)})`, values, steps: [] };
    let cur = values;
    let made = 0;
    for (let i = 0; i < STEPS; i++) {
      let step: Step;
      const k = r.int(32);
      if (k === 0) step = { snapshot: true };
      else if (k === 1) step = { normal: true };
      else {
        const name = action(r, L.ACTION_NAMES);
        step = { perform: name, payload: clean(payload(r, cur, name)), env: padEnv({ now: 2000 + n * 100 + i + (r.chance(0.1) ? 0.5 : 0), ids: [] })! };
      }
      if (!finish(step, cur)) break;
      c.steps.push(step);
      cur = merge(cur, changesOf(step));
      made++;
    }
    if (made) out.push(c);
  }
  return out;
}

// The hand-written edges (edges.ts): each step given its env, answered as the others.
function handEdges(): Case[] {
  return edges().map((e, n) => {
    let cur = sortValues(clean(e.values));
    const c: Case = { about: `edges: ${e.about}`, values: cur, steps: [] };
    for (const [i, raw] of e.steps.entries()) {
      const step: Step = 'perform' in raw ? { perform: raw.perform, payload: clean(raw.payload ?? {}), env: padEnv({ now: 4000 + n * 100 + i, ids: [] }) } : { ...raw };
      if (!finish(step, cur)) throw new Error(`edges: ${e.about}, step ${i}: drew Math.random`);
      c.steps.push(step);
      cur = merge(cur, changesOf(step));
    }
    return c;
  });
}

// The throw survey: every action, on a library that has one of everything, each of its fields as each wrong type
// (the others right), and payloads that aren't objects. Its cases keep the steps that threw (a throw changes
// nothing, so they all start from the same values).
function survey(): Case[] {
  const r = random(SEED ^ 0x5a7);
  let base: any;
  for (;;) {
    base = sortValues(clean(library(r)));
    const full = ['spaces', 'tabs', 'pins', 'folders', 'favorites', 'airTraffic', 'splits', 'archive', 'windows'].every((c) => Object.keys(base[c] ?? {}).length);
    if (full) break;
  }
  const out: Case[] = [];
  for (const name of L.ACTION_NAMES) {
    const c: Case = { about: `survey: ${name}`, values: base, steps: [] };
    const fields = FIELDS[name] ?? [];
    const right = () => Object.fromEntries(fields.map((f) => [f, field(r, base, f)]));
    const payloads: unknown[] = [null, 5, 'x', [], [1]];
    for (const f of fields) for (const w of WRONG) payloads.push({ ...right(), [f]: w });
    for (const p of payloads) {
      const step: Step = { perform: name, payload: plain(p) ?? {}, env: padEnv({ now: 3000, ids: [] })! };
      if (!finish(step, base)) continue;
      count('survey: calls');
      if (step.expect.ok === false && typeof step.expect.error === 'string' && step.expect.error.startsWith('failed:')) c.steps.push(step);
    }
    if (c.steps.length) out.push(c);
  }
  return out;
}

// ---- 3. where a throw is: its site's name, from the stack of a copy of library.ts that keeps what it caught ----
const instrumented = (() => {
  const src = readFileSync(join(ROOT, 'app/shared/library/library.ts'), 'utf8');
  const caught = 'return { ok: false, error: `failed: ${(e as Error)?.message ?? e}`';
  if (!src.includes(caught)) throw new Error('library.ts: its catch moved (record.ts looks for it)');
  const text = src.replace(caught, `(globalThis as any).__libraryThrow = e; ${caught}`)
    .replace(/from '(\.\.\/[^']+)'/g, (_, p) => `from '${pathToFileURL(join(ROOT, 'app/shared/library', p)).href}'`);
  const file = join(tmp, 'library-instrumented.ts');
  writeFileSync(file, text);
  return file;
})();
const I: typeof L = await import(pathToFileURL(instrumented).href);

type Site = { action: string, where: string, node: string, jsc?: string, payload: unknown };
const sites = new Map<string, Site>();
// The site of a step that threw: `<action>: <Node's words>` (stable across edits of the files; its place in the code
// is `where`, for a reader).
function siteOf(step: Step, values: any): string {
  (globalThis as any).__libraryThrow = undefined;
  withoutUrl(() => I.perform(values, step.perform, step.payload, step.env));
  const e = (globalThis as any).__libraryThrow as Error | undefined;
  const message = String(e?.message ?? e);
  const frame = String(e?.stack ?? '').split('\n').find((l) => /\.ts:\d+:\d+/.test(l)) ?? '';
  const m = /at (?:(\S+) )?\(?(?:file:\/\/)?([^)]*?\.ts):(\d+):\d+\)?/.exec(frame);
  const file = m ? basename(m[2]).replace('library-instrumented', 'library') : '?';
  const fn = m?.[1]?.replace(/^Object\./, '') ?? '?';
  const key = `${step.perform}: ${message}`;
  if (!sites.has(key)) sites.set(key, { action: step.perform, where: `${file} ${fn}`, node: message, payload: step.payload });
  return key;
}

// ---- 4. JavaScriptCore ----------------------------------------------------------------------------------------
function jscTool() {
  const bin = join(tmp, 'jsc');
  const r = spawnSync('swiftc', ['-O', join(ROOT, 'tools/library-vectors/jsc.swift'), '-o', bin], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`jsc.swift: ${r.stderr}`);
  return bin;
}
// library.ts's own functions for the steps library.js's entry doesn't take (normal, target) and for js.json, built as
// the app's library.js is (scripts/build.ts buildApp's options).
function extraBundle() {
  const entry = [
    "import { stateOf, valuesOf, targetOf, nsId, nsTabId } from './app/shared/library/library.ts';",
    "import { normalizeUrl } from './extension/state/model.ts';",
    "import { normalizePattern, patternMatchesUrl } from './extension/shared/air-traffic.ts';",
    "import { fingerprint } from './extension/shared/data-set.ts';",
    'globalThis.marginVectors = { stateOf, valuesOf, targetOf, nsId, nsTabId, normalizeUrl, normalizePattern, patternMatchesUrl, fingerprint };',
  ].join('\n');
  return buildSync({
    stdin: { contents: entry, resolveDir: ROOT, sourcefile: 'vectors-entry.js' },
    conditions: [CONDITIONS.safari], tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true, useDefineForClassFields: true } },
    bundle: true, format: 'iife', target: 'esnext', minifyWhitespace: true, minifySyntax: true, legalComments: 'none', charset: 'utf8', write: false, logLevel: 'warning',
  }).outputFiles[0].text;
}
const EXTRA = extraBundle();
function jscScript() {
  const app = join(tmp, 'app');
  buildApp(app);
  const runner = `
;(() => {
  const call = (name, args) => { const o = JSON.parse(marginLibrary.call(name, JSON.stringify(args))); if (o.error) throw new Error(o.error); return o.value; };
  const byCodePoint = (a, b) => { const x = [...a], y = [...b]; for (let i = 0; i < Math.min(x.length, y.length); i++) { const d = x[i].codePointAt(0) - y[i].codePointAt(0); if (d) return d; } return x.length - y.length; };
  // (As the store reads them: each collection's ids in code-point order.)
  const merge = (values, changes) => { const next = { ...values }; for (const c of changes || []) { const list = { ...(next[c.collection] || {}) }; if (c.deleted) delete list[c.id]; else list[c.id] = c.value; next[c.collection] = Object.fromEntries(Object.keys(list).sort(byCodePoint).map((k) => [k, list[k]])); } return next; };
  const cases = JSON.parse(INPUT);
  return JSON.stringify(cases.map((c) => { let v = c.values; return c.steps.map((s) => {
    let got;
    if ('perform' in s) { const o = call('perform', [v, s.perform, s.payload, s.env]); got = { ok: o.ok === true, result: o.ok ? (o.result ?? null) : null, ...(o.ok ? {} : { error: o.error }), changes: o.changes || [], requests: o.requests || [] }; }
    else if ('snapshot' in s) got = call('snapshot', [v]);
    else if ('import' in s) got = call('importValues', [v, s.import.sets, s.import.order, { now: s.import.now }]);
    else if ('normal' in s) got = marginVectors.valuesOf(marginVectors.stateOf(v), (v && v.imports) || {});
    else got = marginVectors.targetOf(s.target) ?? null;
    if ('perform' in s || 'import' in s) v = merge(v, s.expect.changes);
    return got;
  }); }));
})()`;
  // The vectors' bundle first: library.js's own marginLibrary is the one called.
  return `${EXTRA}\n${readFileSync(join(app, 'library.js'), 'utf8')}\n${runner}`;
}
function runJsc(bin: string, script: string, cases: Case[]): any[][] {
  const s = join(tmp, 'run.js'), i = join(tmp, 'in.json'), o = join(tmp, 'out.json');
  writeFileSync(s, script);
  writeFileSync(i, JSON.stringify(cases.map((c) => ({ values: c.values, steps: c.steps }))));
  const r = spawnSync(bin, [s, i, o], { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`jsc: ${r.stderr}`);
  return JSON.parse(readFileSync(o, 'utf8'));
}

// JSC's answers against Node's: a throw's words go to its site; any other difference keeps JSC's answer (and the
// case stops there: what follows was made from Node's).
function checkJsc(cases: Case[], answers: any[][]) {
  cases.forEach((c, ci) => {
    let values = c.values;
    for (let si = 0; si < c.steps.length; si++) {
      const step = c.steps[si];
      let got = answers[ci][si];
      if (hasLoneSurrogate(got)) got = dropLoneSurrogates(got);
      const threw = 'perform' in step && step.expect.ok === false && /^failed:/.test(step.expect.error ?? '');
      if (threw) {
        const key = siteOf(step, values);
        const jsc = typeof got?.error === 'string' && got.error.startsWith('failed: ') ? got.error.slice(8) : `(not a throw: ${JSON.stringify(got)})`;
        const site = sites.get(key)!;
        if (site.jsc !== undefined && site.jsc !== jsc) throw new Error(`site ${key}: JSC says "${site.jsc}" and "${jsc}"`);
        site.jsc = jsc;
        step.expect = { ...step.expect, error: { failed: key } };
        count('steps: threw');
      } else if (!isDeepStrictEqual(got, step.expect)) {
        log(`JSC differs from Node: ${c.about}, step ${si}: ${firstDifference(got, step.expect, '$')}`);
        step.engine = 'jsc';
        step.expect = got;
        count('steps: JSC differs from Node');
        c.steps.length = si + 1;
      }
      values = merge(values, changesOf(step));
    }
  });
}

function firstDifference(a: any, b: any, path: string): string {
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (!isDeepStrictEqual(a[k], b[k])) return firstDifference(a[k], b[k], `${path}.${k}`);
  }
  return `${path}: JSC ${JSON.stringify(a)?.slice(0, 200)}, Node ${JSON.stringify(b)?.slice(0, 200)}`;
}

// ---- 5. js.json ------------------------------------------------------------------------------------------------
function jsJson(bin: string) {
  const script = `${EXTRA}\n${readFileSync(join(ROOT, 'tests/library-vectors/js-cases.js'), 'utf8')}`;
  const s = join(tmp, 'js.js'), i = join(tmp, 'js-in.json'), o = join(tmp, 'js-out.json');
  writeFileSync(s, script);
  writeFileSync(i, '{}');
  const r = spawnSync(bin, [s, i, o], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`jsc js-cases.js: ${r.stderr}`);
  const jsc = JSON.parse(readFileSync(o, 'utf8'));
  // Node in a context of its own: JavaScript's built-ins only, no URL (Node's, not the language's), as a bare JSContext.
  const node = JSON.parse(runInNewContext(script, { INPUT: '{}' }));
  // Where Node differs, JSC's answer is kept and the difference named.
  const differs: string[] = [];
  for (const part of ['cases', 'url']) for (const k of Object.keys(jsc[part])) if (!isDeepStrictEqual(jsc[part][k], node[part][k])) differs.push(`${part}.${k}`);
  return { ...jsc, engine: 'jsc', nodeDiffers: differs };
}

// ---- writing -----------------------------------------------------------------------------------------------------
// One step a line, each collection of the values a line: readable diffs when a rule changes on purpose.
function caseFile(about: string, from: string, cases: Case[]) {
  const ln = (v: unknown) => JSON.stringify(v);
  const order = (s: Step) => {
    const kind = ['perform', 'snapshot', 'import', 'normal', 'target'].find((k) => k in s)!;
    const head: Record<string, unknown> = { [kind]: s[kind] };
    for (const k of ['payload', 'env']) if (k in s) head[k] = s[k];
    for (const k of ['url', 'cut', 'engine']) if (k in s) head[k] = s[k];
    head.expect = s.expect;
    return head;
  };
  const body = cases.map((c) => {
    const values = Object.entries(c.values ?? {}).map(([k, v]) => `      ${ln(k)}: ${ln(v)}`).join(',\n');
    const steps = c.steps.map((s) => `      ${ln(order(s))}`).join(',\n');
    return `    {\n      "about": ${ln(c.about)},\n      "values": {\n${values.replace(/^ {6}/gm, '        ')}\n      },\n      "steps": [\n${steps}\n      ]\n    }`;
  });
  return `{\n  "about": ${ln(about)},\n  "from": ${ln(from)},\n  "cases": [\n${body.join(',\n')}\n  ]\n}\n`;
}

// ---- the run ---------------------------------------------------------------------------------------------------------
const started = Date.now();
const recorded = recordTests();
const groups: { file: string, about: string, from: string, cases: Case[] }[] = [];
for (const [name, calls] of recorded) {
  const cases = casesOf(name, calls);
  count('recorded: calls', calls.length);
  groups.push({ file: `recorded-${name}.json`, about: `tests/${name}.test.ts's calls of library.ts, as the test made them (npm run library:vectors).`, from: 'recorded', cases });
}
const gen = generated();
const PER_FILE = 25;
for (let i = 0; i * PER_FILE < gen.length; i++) {
  groups.push({ file: `generated-${String(i).padStart(2, '0')}.json`, about: `Generated sequences ${i * PER_FILE}-${Math.min(gen.length, (i + 1) * PER_FILE) - 1} of ${SEQUENCES} (tests/library-vectors/generate.ts, seed ${SEED.toString(16)}).`, from: 'generated', cases: gen.slice(i * PER_FILE, (i + 1) * PER_FILE) });
}
groups.push({ file: 'edges.json', about: 'The hand-written edges (tests/library-vectors/edges.ts): ties, cuts, JS\'s spaces, addresses with no URL, numbers, payload keys.', from: 'edges', cases: handEdges() });
groups.push({ file: 'survey.json', about: 'The throw survey: every action, each payload field as each wrong JSON type, the steps that threw (their words: throws.json).', from: 'survey', cases: survey() });

const bin = jscTool();
const script = jscScript();
const all = groups.flatMap((g) => g.cases);
const answers = runJsc(bin, script, all);
checkJsc(all, answers);
const js = jsJson(bin);

mkdirSync(join(OUT, 'cases'), { recursive: true });
for (const f of readdirSync(join(OUT, 'cases'))) if (/^(recorded|generated)-.*\.json$|^(survey|edges)\.json$/.test(f)) rmSync(join(OUT, 'cases', f));
for (const g of groups) writeFileSync(join(OUT, 'cases', g.file), caseFile(g.about, g.from, g.cases));
const siteList = Object.fromEntries([...sites.entries()].sort(([a], [b]) => byCodePoint(a, b)).map(([k, s]) => [k, { action: s.action, where: s.where, jsc: s.jsc, node: s.node, payload: s.payload }]));
writeFileSync(join(OUT, 'throws.json'), `{\n  "about": "Every place an action of library.ts throws (a TypeError on a payload of the wrong type), caught by perform as \`failed: <the engine's words>\`: JavaScriptCore's words (Margin.app's, and the core's) and Node's. Vectors name a site (\`\\"error\\": { \\"failed\\": \\"<site>\\" }\`).",\n  "sites": {\n${Object.entries(siteList).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n  }\n}\n`);
writeFileSync(join(OUT, 'js.json'), `${JSON.stringify(js, null, 1)}\n`);

const steps = all.reduce((n, c) => n + c.steps.length, 0);
const kinds: Record<string, number> = {};
for (const c of all) for (const s of c.steps) { const k = ['perform', 'snapshot', 'import', 'normal', 'target'].find((x) => x in s)!; kinds[k] = (kinds[k] ?? 0) + 1; }
const flags = { url: all.flatMap((c) => c.steps).filter((s) => s.url).length, cut: all.flatMap((c) => c.steps).filter((s) => s.cut).length, jsc: all.flatMap((c) => c.steps).filter((s) => s.engine).length };
log(`${groups.length} files, ${all.length} cases, ${steps} steps ${JSON.stringify(kinds)}; flags ${JSON.stringify(flags)}; ${sites.size} throw sites; js.json: ${Object.keys(js.cases).length} groups, Node differs on ${js.nodeDiffers.length}`);
log(JSON.stringify(counts));
log(`${((Date.now() - started) / 1000).toFixed(1)} s`);
rmSync(tmp, { recursive: true, force: true });
void cpus; void dirname;
