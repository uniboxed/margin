// Liquid Glass (extension/themes/liquid-glass/): the package itself, read in Node. It passes the sanitizer whole,
// asks for the system's materials in its manifest, and keeps to the rules the real glass needs (seen off screen,
// DECISIONS.md "Liquid Glass"): every use of `-apple-visual-effect` inside `@supports`, on a few elements only, none
// with an outer shadow, and no `backdrop-filter` anywhere. In real engines: tests/theme/liquid-glass.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeTheme } from '../extension/ui/theme-loader.ts';
import { VISUAL_EFFECTS } from '../extension/ui/sanitize.ts';
import { wantsSystemMaterials } from '../extension/ui/theme-schema.ts';
import { PACKAGE_THEMES, PACKAGE_THEME_NAMES } from '../extension/themes/packages.ts';
import { motionNotes } from '../scripts/theme-motion.ts';
import { auditTree } from './theme/audit.ts';
import { readTheme, GLASS } from './theme/package.ts';

const t = readTheme(GLASS);
const clean = sanitizeTheme({ ...t, files: Object.keys(t.files) });
// The sheet without its comments, as rules are counted below.
const css = t.css.replace(/\/\*[\s\S]*?\*\//g, '');

test('Liquid Glass is a built-in theme, named so', () => {
  assert.ok(PACKAGE_THEMES.includes('liquid-glass'));
  assert.equal((PACKAGE_THEME_NAMES as Record<string, string>)['liquid-glass'], 'Liquid Glass');
  assert.equal(PACKAGE_THEMES[0], 'arcadia', 'Arcadia stays the default');
});

test('Liquid Glass passes the sanitizer with nothing removed, and bundles nothing (the system\'s font)', () => {
  assert.deepEqual([clean.errors, clean.removed], [[], []]);
  assert.equal(clean.ok, true);
  assert.equal(clean.stats.pages, 1);
  assert.deepEqual(auditTree(clean.tree), []);
  assert.deepEqual(Object.keys(t.files), []);
  assert.deepEqual([clean.manifest.id, clean.manifest.name, clean.manifest.fonts, clean.manifest.images], ['liquid-glass', 'Liquid Glass', [], []]);
  assert.doesNotMatch(t.html + t.css + t.manifest, /https?:\/\/|url\(|@import|@font-face/);
});

test('Liquid Glass asks for the system\'s materials; no other built-in theme does', () => {
  assert.equal(clean.manifest.systemMaterials, true);
  assert.equal(wantsSystemMaterials(t.manifest), true);
  for (const id of PACKAGE_THEMES.filter((x) => x !== 'liquid-glass')) {
    assert.equal(wantsSystemMaterials(readTheme(GLASS.replace('liquid-glass', id)).manifest), false, id);
  }
});

test('Liquid Glass: no backdrop-filter, no blur filter, no image: the system\'s glass or plain fills', () => {
  assert.doesNotMatch(css, /backdrop-filter/i);
  assert.doesNotMatch(css, /\bfilter\s*:/i);
  assert.doesNotMatch(css, /\bblur\(/i);
});

test('Liquid Glass: every material is inside @supports, after the plain look, on a few elements, none with an outer shadow', () => {
  const at = css.indexOf('@supports (-apple-visual-effect: -apple-system-glass-material)');
  assert.ok(at > 0, 'the block is there');
  assert.equal(css.slice(0, at).includes('-apple-visual-effect'), false, 'nothing outside it: other browsers read the plain look only');
  assert.equal(css.indexOf('@supports (-apple-visual-effect', at + 1), -1, 'one block');
  const block = css.slice(at);
  // The plain look first: each kind of surface has its fill before the block.
  for (const rule of ['.glass { background: var(--pop-fill)', '.panel.glass { background: var(--panel-fill)', '.capsule { border-radius: 999px; background: var(--capsule-fill)', '.tab.on, .new-tab.on { background: var(--lit-fill)']) {
    const i = css.indexOf(rule);
    assert.ok(i > 0 && i < at, rule);
  }
  // The materials used: Liquid Glass and its subdued kind (and `none`), all on the list the sanitizer allows.
  const used = [...block.matchAll(/-apple-visual-effect:\s*([a-z-]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].sort(), ['-apple-system-glass-material', '-apple-system-glass-material-subdued', 'none']);
  for (const v of used) assert.ok(VISUAL_EFFECTS.includes(v), v);
  // Who gets one: the panels that float and the capsules in the panel, by class, never a row or a tile as such.
  const rules = [...block.matchAll(/([^{}]+)\{([^{}]*-apple-visual-effect:\s*-apple-system-glass[^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);
  assert.deepEqual(rules.map(([selector]) => selector), ['.glass, .panel.glass', '.capsule', '.tab.on, .new-tab.on, .tab.on:hover, .new-tab.on:hover']);
  // Nothing past the box: no shadow, and clipped (a glass layer grows to cover whatever reaches past it).
  assert.match(block, /\.glass, \.panel\.glass, \.capsule, \.tab\.on, \.new-tab\.on \{ overflow: hidden; box-shadow: none; \}/);
  // With more contrast, or less transparency, the plain look.
  assert.match(block, /@media \(prefers-contrast: no-preference\)/);
  assert.match(block, /@media \(prefers-reduced-transparency: reduce\)[\s\S]*-apple-visual-effect: none/);
});

test('Liquid Glass: the template has few glass elements (a layer each), and every part the other themes have but iCloud Tabs and other profiles', () => {
  const count = (re: RegExp) => (t.html.match(re) ?? []).length;
  // In the sidebar at rest: the panel and three capsules (the tab in front is the fifth layer).
  assert.equal(count(/class="panel glass"/g), 1);
  assert.equal(count(/class="[^"]*\bcapsule\b[^"]*"/g), 3);
  // What floats: the command bar, a menu, a notice, a prompt, the space editor.
  assert.equal(count(/class="[^"]*\bglass\b[^"]*"/g), 6);
  for (const part of ['menu', 'space-editor', 'notice', 'prompt', 'launcher', 'settings']) assert.equal(count(new RegExp(`<template m-part="${part}">`, 'g')), 1, part);
  for (const slot of ['m-page', 'm-menu', 'm-editor', 'm-notice', 'm-prompt', 'm-launcher', 'm-settings', 'm-window-controls', 'm-drag-region']) assert.ok(t.html.includes(`<${slot}`), slot);
  for (const behavior of ['m-peek="left"', 'm-resize="sidebar"', 'm-swipe="spaces"', 'm-scroll="tabs"', 'm-scroll="palette"', 'm-drag="tab"', 'm-drag="pin"', 'm-drag="folder"', 'm-drop="tabs"', 'm-drop="pins"', 'm-drop="folder"', 'm-drop="space"', 'm-rename="space"', 'm-rename="folder"', 'm-input="palette"', 'm-input="launcher"', 'm-input="space-name"', 'm-input="space-emoji"']) assert.ok(t.html.includes(behavior), behavior);
  for (const input of ['setting-number', 'setting-toggle', 'setting-choice', 'setting-list', 'setting-shortcut', 'setting-color']) assert.ok(t.html.includes(`m-input="${input}"`), input);
  assert.doesNotMatch(t.html, /cloud|foreign|profile/i, 'no iCloud Tabs part, no other profile\'s chips');
});

test('Liquid Glass animates transform and opacity only, and stills what loops with reduced motion', () => {
  assert.deepEqual(motionNotes(t.css), []);
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  for (const what of ['.reload.loading .ico', '.tab.busy .fav', '.load-bar.on::before']) assert.ok(reduced.includes(what), what);
});

test('Liquid Glass feels native: the arrow over buttons and rows, labels not selected, no bounce but in lists', () => {
  assert.match(css, /\.lg \{[^}]*cursor: default;[^}]*user-select: none;/);
  assert.match(css, /\.btn \{[^}]*cursor: default;/);
  assert.equal(/cursor:\s*pointer/.test(css), false, 'no hand cursor anywhere');
  assert.match(css, /\.lg \{[^}]*overscroll-behavior: none;/);
  for (const list of ['.tabs', '.palette-rows', '.launcher']) assert.match(css, new RegExp(`\\${list} \\{[^}]*overscroll-behavior: contain;`), list);
  assert.match(css, /font: 13px\/1\.25 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;/);
  assert.match(css, /--accent: AccentColor;/);
});
