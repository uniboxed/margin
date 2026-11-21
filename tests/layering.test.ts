// What pages load stays theirs: the content script (content/main.ts) and the UI (ui/, the app's overlay) reach the
// background's state and code (extension/state/, extension/background/) through no import, so their bundles carry
// none of it (2026-11-21 review: the Safari content bundle grew 32.8 → 40.1 KB, part of it model.ts and the themes it
// pulls, for favoriteScopeOf). Pure rules both sides need live in extension/shared/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p: string) => relative(ROOT, p).split('\\').join('/');
const IMPORT = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const IMPORTS: Record<string, string | Record<string, string>> = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).imports ?? {};

function resolveImport(from: string, spec: string): string | null {
  if (spec.startsWith('#')) { const to = IMPORTS[spec]; const target = typeof to === 'string' ? to : to?.default; return target ? resolve(ROOT, target) : null; }
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec);
  for (const c of [base, `${base}.ts`, join(base, 'index.ts')]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}
// Every import (types only left out: they're gone from the bundles) reached from `entries`, as [from, to] pairs.
function reached(entries: string[]) {
  const seen = new Set<string>();
  const edges: [string, string][] = [];
  const queue = entries.map((e) => resolve(ROOT, e));
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const text = readFileSync(f, 'utf8').replace(/^\s*import\s+type\s[^;]*;/gm, '').replace(/^\s*export\s+type\s[^;]*;/gm, '');
    for (const m of text.matchAll(IMPORT)) {
      const to = resolveImport(f, m[1] ?? m[2] ?? m[3]);
      if (!to) continue;
      edges.push([rel(f), rel(to)]);
      queue.push(to);
    }
  }
  return edges;
}
const backgroundSide = (f: string) => f.startsWith('extension/state/') || f.startsWith('extension/background/');

// Still to move (2026-11-21): the Mini Player's pick, background/media.ts, is in the hands of the media work; once it's
// done, its pure part moves to shared/ and this goes.
const KNOWN = new Set(['extension/ui/view-model.ts -> extension/background/media.ts']);

test('the content script reaches nothing of the background\'s', () => {
  const bad = reached(['extension/content/main.ts']).filter(([, to]) => backgroundSide(to)).map(([a, b]) => `${a} -> ${b}`);
  assert.deepEqual(bad, []);
});

test('the UI (its runtime, behaviors, view model) and the app\'s overlay reach nothing of the background\'s but what\'s known', () => {
  const ui = readdirSync(join(ROOT, 'extension/ui')).filter((n) => n.endsWith('.ts')).map((n) => `extension/ui/${n}`);
  const bad = [...new Set(reached([...ui, 'app/shared/host/overlay.ts']).filter(([from, to]) => backgroundSide(to) && !backgroundSide(from)).map(([a, b]) => `${a} -> ${b}`))];
  assert.deepEqual(bad.filter((e) => !KNOWN.has(e)), []);
});
