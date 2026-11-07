// The payloads PLAN.md §4's rules called for that tests/theme-sanitize.test.js
// and tests/theme-guard.test.js didn't have yet (docs/phase6-themes.md §4):
// template, stylesheet, manifest and file payloads, each refused or removed.
// The same template and stylesheet payloads run live in WebKit and Chromium
// in tests/theme/security.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeTemplate, sanitizeCss, RESERVED_IDS } from '../../extension/ui/sanitize.js';
import { checkManifest } from '../../extension/ui/theme-schema.js';
import { checkPackage, contentMatches } from '../../extension/ui/theme-loader.js';
import { TEMPLATE_PAYLOADS_2, CSS_PAYLOADS_2, CSS_KEPT_2, MANIFEST_PAYLOADS, MANIFEST_REMOVED, FILE_PAYLOADS, wrap } from '../theme/payloads.js';
import { auditTree } from '../theme/audit.js';

const said = (r) => [...r.errors, ...r.removed.map((x) => `${x.kind} ${x.name}: ${x.reason}`)].join('\n');
const PKG = { manifest: '{"format":2,"id":"mine","name":"Mine","version":"1.0.0"}', html: wrap(''), css: '' };

for (const [name, fragment, expect] of TEMPLATE_PAYLOADS_2) {
  test(`template payload: ${name}`, () => {
    const r = sanitizeTemplate(wrap(fragment), { files: [] });
    assert.match(said(r), expect);
    assert.deepEqual(auditTree(r.tree), []);
  });
}

test('the guarded part keeps nothing that can show the symbol\'s words', () => {
  const r = sanitizeTemplate(wrap(TEMPLATE_PAYLOADS_2[0][1]), { files: [] });
  assert.doesNotMatch(JSON.stringify(r.tree.children[0].children.find((c) => c.name === 'template')), /"use"/);
});

test('reserved ids: each refused in html and svg, any case; other ids kept', () => {
  for (const id of RESERVED_IDS) {
    for (const v of [id, id.toUpperCase()]) {
      const r = sanitizeTemplate(wrap(`<div id="${v}"></div><svg id="${v}"></svg>`), { files: [] });
      assert.doesNotMatch(JSON.stringify(r.tree), new RegExp(`"id","${v}"`), v);
    }
  }
  // Any id like a global of Margin's own (`margin` and a capital, digit or "_"), now or later.
  for (const v of ['marginFallbackTheme', 'marginSomethingLater', 'MARGINX', 'margin_x', 'margin2']) {
    const r = sanitizeTemplate(wrap(`<div id="${v}"></div>`), { files: [] });
    assert.doesNotMatch(JSON.stringify(r.tree), new RegExp(`"id","${v}"`), v);
  }
  const ok = sanitizeTemplate(wrap('<div id="sidebar"></div><div id="margin-results"></div><svg><defs><linearGradient id="g1"></linearGradient></defs></svg>'), { files: [] });
  assert.deepEqual(ok.removed, []);
});

for (const [name, css] of CSS_PAYLOADS_2) {
  test(`css payload: ${name}`, () => {
    const r = sanitizeCss(css, { files: [] });
    assert.ok(r.removed.length > 0 || r.errors.length > 0, 'reported');
    assert.doesNotMatch(r.css, /evil\.test|url\(\s*["']?data:font|counter-style|symbols/i);
  });
}
for (const [name, css] of CSS_KEPT_2) {
  test(`css kept: ${name}`, () => {
    const r = sanitizeCss(css, { files: [] });
    assert.deepEqual(r.removed, []);
    assert.match(r.css, /data:font\/woff2/);
  });
}

for (const [name, json, expect] of MANIFEST_PAYLOADS) {
  test(`manifest payload: ${name}`, () => {
    const r = checkManifest(json, { files: [] });
    assert.equal(r.manifest, null);
    assert.match(r.errors.join('\n'), expect);
  });
}
for (const [name, json, expect] of MANIFEST_REMOVED) {
  test(`manifest payload: ${name} (removed, the rest kept)`, () => {
    const r = checkManifest(json, { files: [] });
    assert.ok(r.manifest);
    assert.match(r.removed.map((x) => `${x.name}: ${x.reason}`).join('\n'), expect);
    assert.equal(/** @type {any} */ ({}).polluted, undefined, 'nothing polluted');
    assert.equal(Object.getPrototypeOf(r.manifest.settings), Object.prototype);
  });
}

for (const [name, files, expect] of FILE_PAYLOADS) {
  test(`file payload: ${name}`, () => {
    assert.match(checkPackage({ ...PKG, files }).join('\n'), expect);
  });
}

test('first bytes: real signatures pass', () => {
  const b = (...xs) => new Uint8Array(xs.flatMap((x) => (typeof x === 'string' ? [...x].map((c) => c.charCodeAt(0)) : x)));
  assert.ok(contentMatches('a.woff2', b('wOF2', [0, 1, 0, 0])));
  assert.ok(contentMatches('a.png', b([0x89], 'PNG\r\n\x1a\n', [0])));
  assert.ok(contentMatches('a.jpeg', b([0xff, 0xd8, 0xff, 0xe0])));
  assert.ok(contentMatches('a.gif', b('GIF89a')));
  assert.ok(contentMatches('a.webp', b('RIFF', [1, 2, 3, 4], 'WEBPVP8 ')));
  assert.ok(contentMatches('a.avif', b([0, 0, 0, 0x1c], 'ftypavif')));
  assert.ok(contentMatches('a.svg', b('<?xml version="1.0"?>\n<!-- x --><svg xmlns="http://www.w3.org/2000/svg"/>')));
  assert.ok(contentMatches('LICENSE.md', b('# Licence\n')));
  assert.ok(!contentMatches('a.woff2', b('wOFF')), 'woff 1 is not woff2');
});
