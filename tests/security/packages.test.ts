// Every built-in theme, and every package named in MARGIN_THEMES, through
// the checks an imported theme goes through (docs/phase6-themes.md §4):
// the package's caps and file kinds (with each file's first bytes), the
// sanitizer with nothing removed, the tree audit, the parts a theme needs to
// be switched away from, bundled fonts with their licence, no addresses, and (built-ins) a first paint that only paints
// under its own mark. Part of npm test and npm run test:security.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkPackage, sanitizeTheme } from '../../extension/ui/theme-loader.ts';
import { auditTree } from '../theme/audit.ts';
import { checkImport, missingWaysOut } from '../../extension/ui/theme-import.ts';
import { readSuitePackages } from './packages.ts';

const ADDRESS = /https?:\/\/|\/\/[a-z0-9-]+\.[a-z]|fonts\.googleapis|fonts\.gstatic|typekit|use\.fontawesome|cdn\.|@import/i;

for (const p of await readSuitePackages()) {
  test(`${p.label}: passes every check an imported theme goes through`, () => {
    const { pkg } = p;
    assert.deepEqual(checkPackage(pkg), [], 'caps, file kinds and first bytes');
    const r = sanitizeTheme({ ...pkg, files: Object.keys(pkg.files) });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.removed, [], 'nothing removed');
    assert.deepEqual(auditTree(r.tree), []);
    // The parts every theme draws so it can be switched away from (Settings in the launcher, prompts, notices).
    assert.deepEqual(missingWaysOut(r.structure), [], 'the parts a theme needs');
    if (p.builtin) assert.equal(r.manifest.id, p.id, 'its id is its folder\'s');
    else assert.deepEqual(checkImport(pkg).errors, [], 'importable: its id isn\'t a built-in\'s');
    // Fonts: woff2 only, each folder of them with a licence text (and, built in, where they came from).
    const fonts = Object.keys(pkg.files).filter((f) => /\.woff2$/i.test(f));
    for (const f of r.manifest.fonts) assert.ok(fonts.includes(f.file), `${f.file} is bundled`);
    const notes = Object.keys(pkg.files).filter((f) => /\.(txt|md)$/i.test(f));
    const text = (f) => new TextDecoder().decode(pkg.files[f]);
    if (fonts.length) {
      assert.ok(notes.some((n) => /SIL Open Font License|Apache License|OFL|licen[cs]e/i.test(text(n))), 'a licence text for its fonts');
      if (p.builtin) assert.ok(notes.some((n) => /SOURCES\.txt$/.test(n)), 'SOURCES.txt says where its fonts came from');
    }
    // No addresses anywhere it's read from (notes may name where fonts came from: they're never loaded).
    for (const [name, body] of [['theme.json', pkg.manifest], ['theme.html', pkg.html], ['theme.css', pkg.css]]) {
      assert.doesNotMatch(body, ADDRESS, `${name} names no address or font service`);
    }
    for (const f of Object.keys(pkg.files).filter((x) => /\.svg$/i.test(x))) assert.doesNotMatch(text(f), ADDRESS, `${f} names no address`);
  });

  if (p.builtin && existsSync(join(p.dir, 'first-paint.css'))) {
    test(`${p.label}: its first paint paints only under its own mark, with no address and no text`, () => {
      const css = readFileSync(join(p.dir, 'first-paint.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      assert.doesNotMatch(css, /url\(|@import|image-set|src\s*\(/i);
      for (const m of css.matchAll(/content\s*:\s*([^;}]*)/gi)) assert.match(m[1].trim(), /^(""|'')\s*(!important)?$/, 'content only ever empty');
      // Every rule's selectors under html[data-margin-at="<id>"] (at-rules' preludes aside).
      const selectors = [...css.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()).filter((s) => !s.startsWith('@'));
      assert.ok(selectors.length > 0);
      for (const list of selectors) {
        for (const sel of list.split(',').map((s) => s.trim())) assert.ok(sel.startsWith(`html[data-margin-at="${p.id}"]`), `${sel} is under its mark`);
      }
    });
  }
}
