// The page patterns the box handles (tests/box/): every pattern's header is whole
// and lets it off only rules that exist, the README's generated parts are up to
// date, and the rules (tests/box/rules.js judge) say what's broken, and only
// that. The patterns themselves run in browsers: tests/e2e/box-patterns.test.js
// (Chromium) and the WebKit host's `box-patterns` scenario.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { RULES, judge } from './box/rules.js';
import { boxPage, listPatterns, parseHeader } from './box/serve.js';
import { README, withParts } from './box/readme.mjs';

test('every pattern has a whole header, a page after it, and lets itself off only rules that exist', () => {
  const patterns = listPatterns();
  assert.ok(patterns.length >= 10, `${patterns.length} patterns`);
  for (const p of patterns) {
    assert.ok(p.title && p.from, `${p.name}: pattern and from`);
    assert.match(p.html, /-->\s*<!doctype html>/i, `${p.name}: <!doctype html> right after the header (standards mode)`);
    for (const a of p.allow) assert.ok(RULES[a.split(' ')[0]], `${p.name}: allow "${a}" names a rule (${Object.keys(RULES).join(', ')})`);
    if (p.allow.length) assert.ok(p.note, `${p.name}: what it's let off is said in note:`);
  }
});

// A file of the box's, as handled-by names it: a path under extension/.
const EXTENSION = new URL('../extension/', import.meta.url);
const FILE = /\b(?:background|content|shared|ui|themes)\/[\w./-]+\.js\b/g;
// A name in the code: camelCase (boxCss, matchMedia) or a constant (BOX_ROOT); plain words aren't.
const CODE_NAME = /\b(?:[a-z]+[A-Z]\w*|[A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/g;

test('every pattern says which of the box\'s files handle it, and they and the names it gives are there', () => {
  for (const p of listPatterns()) {
    const files = p.handledBy.match(FILE) ?? [];
    assert.ok(files.length, `${p.name}: handled-by names at least one file under extension/ ("${p.handledBy}")`);
    const texts = files.map((f) => {
      const url = new URL(f, EXTENSION);
      assert.ok(existsSync(url), `${p.name}: handled-by names ${f}, which isn't in extension/ (moved or renamed?)`);
      return readFileSync(url, 'utf8');
    });
    for (const name of p.handledBy.replace(FILE, '').match(CODE_NAME) ?? []) {
      assert.ok(texts.some((t) => new RegExp(`\\b${name}\\b`).test(t)), `${p.name}: handled-by names ${name}, which isn't in ${files.join(' or ')}`);
    }
  }
});

test('a header: fields over several lines, the defaults, and what isn\'t allowed', () => {
  const h = parseHeader('<!--\npattern: one\nfrom: a site,\n  and a round\nallow: same-layout #ad, same-scroll\n-->\n<!doctype html>');
  assert.equal(h.from, 'a site, and a round');
  assert.deepEqual(h.allow, ['same-layout #ad', 'same-scroll']);
  assert.equal(h.settle, 500);
  assert.equal(h.engines, 'both');
  assert.throws(() => parseHeader('<!doctype html>'), /no header/);
  assert.throws(() => parseHeader('<!--\npattern: one\n-->'), /no "from:"/);
  assert.throws(() => parseHeader('<!--\nfrom: x\n-->'), /no "pattern:"/);
  assert.throws(() => parseHeader('<!--\npattern: one\nfrom: x\nengines: gecko\n-->'), /engines/);
});

test('the server: a pattern\'s page, its plain reference the size asked for, and nothing else', () => {
  const page = boxPage('/pattern/html-class-width', new URLSearchParams());
  assert.match(page.body, /class="w-100 h-100"/);
  const ref = boxPage('/ref/html-class-width', new URLSearchParams('w=932&h=784'));
  assert.match(ref.body, /width:932px;height:784px/);
  assert.match(ref.body, /src="\.\.\/pattern\/html-class-width"/);
  assert.equal(boxPage('/ref/html-class-width', new URLSearchParams()), null, 'no size, no reference');
  assert.equal(boxPage('/pattern/../serve', new URLSearchParams()), null);
  assert.equal(boxPage('/pattern/nothing-here', new URLSearchParams()), null);
  assert.equal(boxPage('/case/html-class-width', new URLSearchParams()), null, 'the old name answers nothing');
});

test('the README\'s rules and table of patterns are up to date (node tests/box/readme.mjs)', () => {
  const text = readFileSync(README, 'utf8');
  assert.equal(text, withParts(text));
});

// A page as measure() sees it: in its box at the slot (260/8/8/8 in 1440×900), or plain.
const SETUP = { slot: { left: 260, top: 8, right: 8, bottom: 8 }, window: { w: 1440, h: 900 } };
const shot = (over = {}) => ({
  told: { w: 1172, h: 884, sx: 0, sy: 0 },
  root: { x: 260, y: 8, w: 1172, h: 884 },
  window: { left: 0, top: 0, scale: 1 },
  scroller: 'body',
  overflowX: 0,
  els: { '#nav': [0, 0, 1172, 46], 'main:1': [0, 46, 600, 300] },
  out: { mq: 'false' },
  ...over,
});
const plain = shot({ root: { x: 0, y: 0, w: 1172, h: 884 }, scroller: 'html' });

test('the rules: a page that is what it is plain breaks none', () => {
  assert.deepEqual(judge(shot(), plain, SETUP), []);
});

test('the rules: each one says what broke', () => {
  const broke = (over) => judge(shot(over), plain, SETUP).map((f) => f.split(':')[0]);
  assert.deepEqual(broke({ root: { x: 0, y: 8, w: 1172, h: 884 } }), ['box-at-slot']);
  assert.deepEqual(broke({ root: { x: 260, y: 8, w: 1440, h: 900 }, told: { w: 1172, h: 884, sx: 0, sy: 0 } }), ['box-size', 'told-size']);
  assert.deepEqual(broke({ told: { w: 1440, h: 900, sx: 0, sy: 0 } }), ['told-size']);
  assert.deepEqual(broke({ window: { left: 856, top: 0, scale: 1 } }), ['window-still']);
  assert.deepEqual(broke({ scroller: 'html' }), ['body-scrolls']);
  assert.deepEqual(broke({ overflowX: 268 }), ['no-overflow']);
  assert.deepEqual(broke({ els: { '#nav': [0, 0, 1440, 46], 'main:1': [0, 46, 600, 300] } }), ['same-layout']);
  assert.deepEqual(broke({ els: { '#nav': [0, 0, 1172, 46] } }), ['same-layout'], 'an element missing');
  assert.deepEqual(broke({ told: { w: 1172, h: 884, sx: 0, sy: 300 } }), ['same-scroll']);
  assert.deepEqual(broke({ out: { mq: 'true' } }), ['same-answers']);
});

test('the rules: within a rounding, and a pattern let off a rule or one element', () => {
  assert.deepEqual(judge(shot({ els: { '#nav': [1, 0, 1171, 46], 'main:1': [0, 47, 601, 300] }, root: { x: 260.4, y: 8, w: 1173, h: 884 } }), plain, SETUP), []);
  assert.deepEqual(judge(shot({ told: { w: 1172, h: 884, sx: 0, sy: 300 } }), plain, { ...SETUP, allow: ['same-scroll'] }), []);
  const moved = shot({ els: { '#nav': [0, 0, 1440, 46], 'main:1': [0, 99, 600, 300] } });
  const fails = judge(moved, plain, { ...SETUP, allow: ['same-layout #nav'] });
  assert.equal(fails.length, 1);
  assert.match(fails[0], /main:1 at 0,99/);
  assert.doesNotMatch(fails[0], /#nav/);
});
