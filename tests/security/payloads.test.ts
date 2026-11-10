// The payloads PLAN.md §4's rules called for that tests/theme-sanitize.test.ts
// and tests/theme-guard.test.ts didn't have yet (docs/phase6-themes.md §4):
// template, stylesheet, manifest and file payloads, each refused or removed.
// The same template and stylesheet payloads run live in WebKit and Chromium
// in tests/theme/security.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeTemplate, sanitizeCss, RESERVED_IDS } from '../../extension/ui/sanitize.ts';
import { checkManifest } from '../../extension/ui/theme-schema.ts';
import { checkPackage, contentMatches, svgStarts } from '../../extension/ui/theme-loader.ts';
import { TEMPLATE_PAYLOADS_2, CSS_PAYLOADS_2, CSS_KEPT_2, MANIFEST_PAYLOADS, MANIFEST_REMOVED, FILE_PAYLOADS, wrap } from '../theme/payloads.ts';
import { auditTree } from '../theme/audit.ts';

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
    assert.equal(({} as any).polluted, undefined, 'nothing polluted');
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

// The svg check's rules, as the regex it replaced had them (on files that couldn't slow it down).
const OLD_SVG_START = /^﻿?\s*(?:<\?xml[^>]{0,200}\?>\s*)?(?:<!--[\s\S]{0,4000}?-->\s*)*(?:<!DOCTYPE svg[^>]{0,400}>\s*)?<svg[\s>]/i;
const SVG_CASES: Array<[string, string]> = [
  ['plain', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
  ['closed at once', '<svg>'],
  ['byte-order mark and space', '﻿ \n\t<svg viewBox="0 0 1 1"></svg>'],
  ['xml declaration', '<?xml version="1.0" encoding="UTF-8"?>\n<svg/>'],
  ['xml declaration with nothing in it', '<?xml?><svg/>'],
  ['upper case', '<?XML version="1.0"?><!DOCTYPE SVG PUBLIC "-//W3C//DTD SVG 1.1//EN"><SVG/>'],
  ['comments', '<!-- a --> <!----><!-- b\n-- c --><svg/>'],
  ['a doctype', '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg/>'],
  ['everything', '﻿<?xml version="1.0"?>\n<!-- made by hand -->\n<!DOCTYPE svg>\n<svg>'],
  ['an html page', '<!DOCTYPE html><html><svg/></html>'],
  ['a script first', '<script>alert(1)</script><svg/>'],
  ['text first', 'hello <svg/>'],
  ['svg in a longer name', '<svgfoo/>'],
  ['svg at the very end', '<svg'],
  ['empty', ''],
  ['an unclosed comment', '<!-- <svg/>'],
  ['a comment over 4000', `<!--${'x'.repeat(4001)}--><svg/>`],
  ['a comment of 4000', `<!--${'x'.repeat(4000)}--><svg/>`],
  ['a declaration over 200', `<?xml ${'a'.repeat(200)}?><svg/>`],
  ['a declaration of 200', `<?xml${'a'.repeat(199)}?><svg/>`],
  ['a declaration ended by > alone', '<?xml version="1.0"><svg/>'],
  ['a doctype over 400', `<!DOCTYPE svg${'a'.repeat(401)}><svg/>`],
  ['a doctype of 400', `<!DOCTYPE svg${'a'.repeat(400)}><svg/>`],
  ['a doctype of another kind', '<!DOCTYPE html><svg/>'],
  ['two declarations', '<?xml version="1.0"?><?xml version="1.0"?><svg/>'],
  ['a comment ends at its first -->', '<!-- a --> not space --> <svg/>'],
  ['--> inside a comment', '<!-- a -- b --><svg/>'],
];

test('svg: the same files pass and fail as with the regex it replaced', () => {
  for (const [name, text] of SVG_CASES) assert.equal(svgStarts(text), OLD_SVG_START.test(text), name);
});

test('svg: files made to slow the check are refused at once (CodeQL js/redos)', () => {
  const crafted = [
    '<!---->'.repeat(4000) + 'x', // took the regex minutes and more
    '<!-- -->'.repeat(2000) + 'x',
    '<!--' + '-->-->'.repeat(30000) + 'x',
    '<!--' + '-'.repeat(200000),
    ('<!-- a -->' + ' '.repeat(50)).repeat(1500) + 'x',
    ' '.repeat(500000) + 'x',
  ];
  for (const text of crafted) {
    const started = performance.now();
    const ok = contentMatches('evil.svg', new TextEncoder().encode(text));
    const took = performance.now() - started;
    assert.equal(ok, false);
    assert.ok(took < 200, `${text.length} characters checked in ${took.toFixed(1)} ms`);
  }
});
