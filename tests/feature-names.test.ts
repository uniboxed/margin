// Margin's own names for the features Arc has too (decided 2026-11-21: never Arc's names in the product). What a person
// or a theme author sees says "Quick Tab" (Arc's Little Arc), "preview" (the card a link opens in: Arc's Peek) and
// "Link Rules" (Arc's Air Traffic Control), and never "Arc" as a product's name (Arcadia, the built-in theme, keeps its
// own). Code comments may name Arc; "peek" stays the sidebar's hover reveal (the `m-peek` attribute,
// `window.sidebar === 'peek'`). Internal names that are stored or go over the wire keep their first names
// (DECISIONS.md "Margin's own names for Arc's features").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from '../extension/state/model.ts';
import { settingsFields, APP_SHORTCUT_FIELDS, SHORTCUT_FIELDS, SHORTCUT_HELP } from '../extension/ui/settings-form.ts';
import { menuItems } from '../extension/ui/behaviors/menu-items.ts';
import { buildViewModel } from '../extension/ui/view-model.ts';
import { sanitizeTemplate } from '../extension/ui/sanitize.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const rel = (p: string) => relative(ROOT, p).split('\\').join('/');

// Arc's names as a person would read them: Arc itself (a word of its own, so "Arcadia" and "arc" the shape pass),
// Little Arc, Air Traffic (Control), and Peek with a capital (the card; the sidebar's reveal is never "Peek" in words).
const ARC_NAMES = /\bArc\b|\bArc[’']s\b|Little Arc|Air Traffic|\bPeek\b|Auto-Peek/;
const found = (text: string) => ARC_NAMES.exec(text)?.[0] ?? null;

function files(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'tests' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, ext, out);
    else if (ext.test(name)) out.push(p);
  }
  return out;
}

// A source file's string literals, comments left out (a small scanner: '…', "…", `…`; // and /* */ comments; Swift's
// """…""" and #"…"# too). Regular expressions aren't told apart from division: none of the files' regexes holds a quote
// that would start a string here (the test fails loudly if one ever does, on a garbled string).
function strings(src: string, swift = false): string[] {
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; continue; }
    if (swift && src.startsWith('"""', i)) { const end = src.indexOf('"""', i + 3); out.push(src.slice(i + 3, end < 0 ? n : end)); i = end < 0 ? n : end + 3; continue; }
    if (swift && src.startsWith('#"', i)) { const end = src.indexOf('"#', i + 2); out.push(src.slice(i + 2, end < 0 ? n : end)); i = end < 0 ? n : end + 2; continue; }
    if (c === '"' || (!swift && (c === '\'' || c === '`'))) {
      let j = i + 1;
      let s = '';
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') { s += src.slice(j, j + 2); j += 2; continue; }
        if (c !== '`' && src[j] === '\n') break; // (not a string after all: a quote in a regex or a word)
        s += src[j++];
      }
      out.push(s);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

test('feature names: no string in the extension, Margin\'s UI or Margin.app names Arc or its features', () => {
  const sources = [
    ...files(join(ROOT, 'extension'), /\.ts$/),
    ...files(join(ROOT, 'app/shared'), /\.ts$/),
  ];
  const swift = [...files(join(ROOT, 'app/platforms/macos'), /\.swift$/), ...files(join(ROOT, 'app/engines'), /\.swift$/)];
  const bad: string[] = [];
  for (const f of sources) for (const s of strings(readFileSync(f, 'utf8'))) if (found(s)) bad.push(`${rel(f)}: ${JSON.stringify(s.slice(0, 120))}`);
  for (const f of swift) for (const s of strings(readFileSync(f, 'utf8'), true)) if (found(s)) bad.push(`${rel(f)}: ${JSON.stringify(s.slice(0, 120))}`);
  assert.ok(sources.length > 50 && swift.length > 20, `the sources found: ${sources.length} TypeScript, ${swift.length} Swift`);
  // (The scanner sees the words it should: Margin's own names, in a TypeScript and a Swift file.)
  assert.ok(strings(readFileSync(join(ROOT, 'extension/ui/settings-form.ts'), 'utf8')).includes('Link Rules'));
  assert.ok(strings(readFileSync(join(ROOT, 'app/platforms/macos/shell/HostedPeek.swift'), 'utf8'), true).some((s) => s.startsWith('Quick Tab open')));
  assert.ok(found('Arc’s look') && found('Little Arc') && found('Open in Peek') && !found('Arcadia') && !found('the sidebar peeks'), 'what counts as Arc\'s names');
  assert.deepEqual(bad, []);
});

test('feature names: the built-in themes\' templates, styles and descriptions use Margin\'s names (the sidebar\'s m-peek reveal aside)', () => {
  const themes = join(ROOT, 'extension/themes');
  const ids = readdirSync(themes).filter((d) => statSync(join(themes, d)).isDirectory());
  assert.deepEqual(ids.sort(), ['arcadia', 'liquid-glass', 'material', 'neubrutalism', 'pixel']);
  for (const id of ids) {
    const html = readFileSync(join(themes, id, 'theme.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const css = readFileSync(join(themes, id, 'theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const json = readFileSync(join(themes, id, 'theme.json'), 'utf8');
    assert.equal(found(html), null, `${id}: theme.html`);
    assert.equal(found(css), null, `${id}: theme.css`);
    assert.equal(found(json), null, `${id}: theme.json`);
    // The card's old theme API: its slot, part, page element, bindings, actions and field; the sidebar's reveal stays.
    const old = /<m-peek[\s>]|<m-peek-page|m-part="peek"|\{\{\s*peek\.|test="peek\.|m-action="peek\.|m-input="peek"|littleArc|LittleArc|little-arc|airTraffic/;
    assert.equal(old.exec(html)?.[0] ?? null, null, `${id}: the card's old names in theme.html`);
    assert.match(html, /<m-preview[\s>]/, `${id}: the preview slot`);
    assert.match(html, /<template m-part="preview">/, `${id}: the preview part`);
    assert.match(html, /<m-preview-page[\s>]/, `${id}: the preview card's page`);
    assert.match(html, /m-peek="left"/, `${id}: the sidebar's hover reveal keeps its name`);
    // Its classes: the card's are preview-*, quick-tab; the reveal zone keeps peek-zone.
    assert.deepEqual([...new Set(css.match(/\.peek-[\w-]+|little-arc/g) ?? [])].filter((c) => c !== '.peek-zone'), [], `${id}: theme.css classes`);
  }
  const arcadia = readFileSync(join(themes, 'arcadia/theme.ts'), 'utf8');
  const description = /description:\s*'([^']*)'/.exec(arcadia)?.[1] ?? '';
  assert.ok(description && !found(description), `Arcadia's description: ${description}`);
});

test('feature names: what Settings, a tab\'s menu and the preview card show, drawn', () => {
  let s = M.defaultState();
  s = M.setActiveSpace(s, 1, 'personal');
  s = M.upsertTab(s, { id: 9, windowId: 1, index: 0, active: true, url: 'https://stripe.com/docs', title: 'Stripe' } as BrowserTab, 100);
  s = M.moveTab(s, 9, 'personal');
  s = M.addAirTrafficRule(s, { id: 'r1', pattern: 'linear.app', spaceId: 'personal' });
  const all = { marginFullscreen: true, newTabHint: true, blockGestures: true, sleepTabs: true, userThemes: true, importThemes: true };
  const fields = settingsFields(s.settings, all, { airTraffic: { rules: s.airTraffic, spaces: s.spaces } });
  const words: string[] = fields.flatMap((f) => [f.label, f.help, f.placeholder, f.status, ...f.options.map((o) => o.label)]).filter((w) => typeof w === 'string' && w !== '');
  words.push(...Object.values(APP_SHORTCUT_FIELDS), ...Object.values(SHORTCUT_FIELDS), SHORTCUT_HELP);
  assert.deepEqual(words.filter(found), []);
  assert.ok(words.includes('Link Rules'), 'the rules\' group');
  assert.ok(words.includes('Open external links from Pinned tabs and Favorites in a preview'));
  assert.ok(words.includes('Open a Quick Tab'));
  const vm = buildViewModel({ state: s, ui: { windowId: 1, tabId: 9 } });
  const menu = menuItems({ kind: 'tab', id: 9 }, { state: s, space: vm.space }).map((i) => i.label).filter(Boolean) as string[];
  assert.ok(menu.includes('Always Open stripe.com in This Space'), JSON.stringify(menu));
  assert.deepEqual(menu.filter(found), []);
  const card = buildViewModel({ state: s, ui: { windowId: 1, peek: { url: '', littleArc: true } } }).preview!;
  assert.deepEqual([card.quickTab, card.isQuickTab], [true, true]);
  assert.deepEqual(Object.values(card.labels).filter(found), []);
});

test('feature names: the card\'s first theme names are refused (its slot, part, page, field and actions), the sidebar\'s m-peek kept', () => {
  const r = sanitizeTemplate('<div><m-page></m-page><div m-peek="left"></div><m-peek></m-peek><template m-part="peek"><div><m-peek-page></m-peek-page>'
    + '<input m-input="peek"><button m-action="peek.close"></button><button m-action="littleArc.open"></button><button m-action="airTraffic.remove"></button></div></template></div>');
  const said = r.removed.map((x) => `${x.name}: ${x.reason}`);
  for (const want of [/^m-peek: not one of Margin's elements$/, /^<template> m-part: unknown part$/, /^m-peek-page: not one of Margin's elements$/,
    /^<input> m-input: unknown m-input value$/, /unknown action "peek\.close"/, /unknown action "littleArc\.open"/, /unknown action "airTraffic\.remove"/]) {
    assert.ok(said.some((x) => want.test(x)), `${want}: ${JSON.stringify(said)}`);
  }
  const tree = JSON.stringify(r.tree);
  assert.doesNotMatch(tree, /"m-peek-page"|"name":"m-peek"|"peek\.close"|"littleArc\.open"|"airTraffic\.remove"/);
  assert.match(tree, /\["m-peek","left"\]/, 'the sidebar\'s hover zone keeps its m-peek');
  // The new names pass.
  const ok = sanitizeTemplate('<div><m-page></m-page><m-preview></m-preview><template m-part="preview"><div><m-preview-page></m-preview-page>'
    + '<input m-input="preview"><button m-action="preview.close"></button><button m-action="quickTab.open"></button></div></template></div>');
  assert.deepEqual([ok.errors, ok.removed], [[], []]);
});
