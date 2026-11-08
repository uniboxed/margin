// <body>'s size and margins in the box, worked out from what the page says
// (shared/body-fit.js, read by content/page/box-body.js): lengths in pixels,
// margins collapsing as CSS 2 §8.3.1 adds them, and the width equation of
// §10.3.3 for a plain body, a centred one, one with a max-width and padding,
// right to left, and zoomed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collapsed, growsIn, isSized, pixels, resolve, settled, topMargin } from '../extension/shared/body-fit.js';

test('a length in pixels: px, a percent of the whole, and NaN for what takes a layout', () => {
  assert.equal(pixels('12px', 1000), 12);
  assert.equal(pixels('10%', 600), 60);
  assert.ok(Number.isNaN(pixels('auto', 1000)));
  assert.ok(Number.isNaN(pixels('fit-content', 1000)));
  assert.ok(Number.isNaN(pixels('calc(50% - 10px)', 200)), 'no parser (node, or a browser without one): NaN');
  let asked = '';
  const parse = (text) => { asked = text; return { to: () => ({ value: 90 }) }; };
  assert.equal(pixels('calc(50% - 10px)', 200, parse), 90);
  assert.equal(asked, 'calc(100px - 10px)', 'percents are lengths before the browser\'s arithmetic');
  assert.ok(Number.isNaN(pixels('calc(1em + 2px)', 200, () => { throw new Error('no'); })), 'what the parser refuses: NaN');
});

test('settled: auto, none and any length; not what takes a layout', () => {
  for (const v of ['auto', 'none', '0px', '5%']) assert.ok(settled(v), v);
  assert.ok(!settled('fit-content'));
});

test('margins collapse as CSS 2 adds them: the largest positive and the most negative', () => {
  assert.equal(collapsed([10, 20]), 20);
  assert.equal(collapsed([10, -5]), 5);
  assert.equal(collapsed([-10, -20]), -20);
  assert.equal(collapsed([]), 0);
});

test('sized: margins or a size that follow the box\'s width; grows: no height said', () => {
  const lengths = (over = {}) => {
    const l = ['8px', '8px', '8px', '8px', '0px', '0px', '0px', '0px', 'auto', '0px', 'none', 'auto'];
    for (const [i, v] of Object.entries(over)) l[Number(i)] = v;
    return { lengths: l };
  };
  assert.equal(isSized(lengths()), false);
  assert.equal(isSized(lengths({ 3: 'auto' })), true, 'an auto left margin');
  assert.equal(isSized(lengths({ 8: '600px' })), true, 'a width');
  assert.equal(isSized(lengths({ 10: '600px' })), true, 'a max-width');
  assert.equal(isSized(lengths({ 5: '5%' })), true, 'a percent padding');
  assert.equal(growsIn(lengths()), true);
  assert.equal(growsIn(lengths({ 11: '100%' })), false);
});

test('the top margin: only what it adds to the first children\'s it collapses with', () => {
  const said = { meets: true, collapses: ['20px'] };
  assert.equal(topMargin(10, said, 0, 1000), 0, 'less than the child\'s: nothing of its own');
  assert.equal(topMargin(30, said, 0, 1000), 10);
  assert.equal(topMargin(30, { ...said, meets: false }, 0, 1000), 30, 'a body whose margin doesn\'t meet its child\'s');
  assert.equal(topMargin(30, said, 4, 1000), 30, 'padding stands between them');
});

// A body as readSaid sees it: margins, paddings, then width, min-width, max-width, height.
const said = (lengths, over = {}) => ({ lengths, whole: 1000, zoom: 1, borders: 0, boxSizing: 'content-box', direction: 'ltr', column: false, meets: false, collapses: [], ...over });
const NONE = ['0px', '0px', '0px', '0px'];

test('the width equation: a plain body with the browser\'s 8px margins', () => {
  assert.deepEqual(resolve(said(['8px', '8px', '8px', '8px', ...NONE, 'auto', '0px', 'none', 'auto'])), { sized: false, grows: true, column: false, margins: [8, 8, 8, 8], paddings: [0, 0, 0, 0] });
});

test('the width equation: a centred body (auto margins and a width)', () => {
  const out = resolve(said(['0px', 'auto', '0px', 'auto', ...NONE, '600px', '0px', 'none', 'auto']));
  assert.deepEqual(out.margins, [0, 200, 0, 200]);
  assert.equal(out.sized, true);
});

test('the width equation: a max-width with padding, content-box and border-box', () => {
  const lengths = ['0px', 'auto', '0px', 'auto', '0px', '20px', '0px', '20px', 'auto', '0px', '600px', 'auto'];
  assert.deepEqual(resolve(said(lengths)).margins, [0, 180, 0, 180], 'content-box: 600 + 40 of padding');
  assert.deepEqual(resolve(said(lengths, { boxSizing: 'border-box' })).margins, [0, 200, 0, 200], 'border-box: 600 in all');
  assert.deepEqual(resolve(said(lengths)).paddings, [0, 20, 0, 20]);
});

test('the width equation: right to left takes what\'s over on the left', () => {
  const out = resolve(said(['0px', '10px', '0px', '10px', ...NONE, '500px', '0px', 'none', 'auto'], { direction: 'rtl' }));
  assert.deepEqual(out.margins, [0, 10, 0, 490]);
  const ltr = resolve(said(['0px', '10px', '0px', '10px', ...NONE, '500px', '0px', 'none', 'auto']));
  assert.deepEqual(ltr.margins, [0, 490, 0, 10]);
});

test('the width equation: a <body> moved by its own offset (left: 50%, a negative margin) as a whole', () => {
  // xkcd.com: absolute, left: 50%, width 780, margin-left -390: in a box 1172 wide, its column at 196.
  const out = resolve(said(['0px', 'auto', '0px', '-390px', ...NONE, '780px', '0px', 'none', 'auto'], { whole: 1172, offset: '586px' }));
  assert.deepEqual(out.margins, [0, 196, 0, 196]);
  assert.deepEqual(resolve(said(['8px', '8px', '8px', '8px', ...NONE, 'auto', '0px', 'none', 'auto'], { offset: '0px' })).margins, [8, 8, 8, 8], 'no offset: as before');
});

test('the width equation: in <body>\'s own pixels under zoom, and a top margin collapsing', () => {
  assert.deepEqual(resolve(said(['0px', 'auto', '0px', 'auto', ...NONE, '300px', '0px', 'none', 'auto'], { zoom: 2 })).margins, [0, 100, 0, 100], 'the whole is 500 of its pixels');
  assert.equal(resolve(said(['10px', '0px', '0px', '0px', ...NONE, 'auto', '0px', 'none', 'auto'], { meets: true, collapses: ['24px'] })).margins[0], 0);
});
