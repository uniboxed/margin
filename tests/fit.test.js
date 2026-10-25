import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../extension/shared/fit.js';

const { linear, fixedDeclarations, isFullBleed, bleedDeclarations, alignDeclarations } = globalThis.Margin.fit;

// Stand-ins for CSS Typed OM computed values.
const unit = (value, u) => ({ value, unit: u });
const keyword = (value) => ({ value });
const sum = (...values) => ({ operator: 'sum', values });
const negate = (value) => ({ operator: 'negate', value });
const product = (...values) => ({ operator: 'product', values });

// A 1000px window, 260px sidebar, 8px frame: the card is 260…992.
const view = { left: 260, width: 732, right: 8, viewport: 1000, window: 1000 };
const auto = { auto: true };
const lin = (p, px) => ({ p, px });

test('linear: computed values as p% + px', () => {
  assert.deepEqual(linear(unit(12, 'px')), lin(0, 12));
  assert.deepEqual(linear(unit(50, 'percent')), lin(50, 0));
  assert.deepEqual(linear(keyword('auto')), auto);
  assert.deepEqual(linear(sum(unit(50, 'percent'), negate(unit(100, 'px')))), lin(50, -100), 'calc(50% - 100px), Chromium');
  assert.deepEqual(linear(sum(unit(50, 'percent'), unit(-100, 'px'))), lin(50, -100), 'calc(50% - 100px), WebKit');
  assert.deepEqual(linear(product(unit(2, 'number'), unit(25, 'percent'))), lin(50, 0));
  assert.equal(linear(keyword('anchor-center')), null, 'not a length: leave it alone');
  assert.equal(linear({ operator: 'min', values: [unit(1, 'px'), unit(2, 'px')] }), null);
  assert.equal(linear(unit(1, 'em')), null);
  assert.equal(linear(undefined), null);
});

test('fixed elements: insets and widths re-resolved against the card', () => {
  const fixed = (spec, used = { left: 0, right: 0 }, borderBox = 0) => Object.fromEntries(fixedDeclarations(spec, used, borderBox, view));

  assert.deepEqual(fixed({ left: lin(0, 0), right: lin(0, 0), width: auto }), { left: '260px', right: '8px' }, 'full-width bar fills the card');
  assert.deepEqual(fixed({ left: lin(0, 12), right: auto, width: lin(0, 80) }, { left: 12, right: 908 }, 80), { left: '272px' }, 'logo keeps its 12px');
  assert.deepEqual(fixed({ left: auto, right: lin(0, 10), width: lin(0, 60) }, { left: 930, right: 10 }, 60), { right: '18px' }, 'corner button stays 10px in');
  assert.deepEqual(fixed({ left: lin(50, 0), right: auto, width: lin(0, 300) }, { left: 500, right: 200 }, 300), { left: '626px' }, 'left: 50% is the card\'s middle');
  assert.deepEqual(fixed({ left: lin(10, 0), right: auto, width: lin(50, 0) }), { left: '333.2px', width: '366px' }, 'percent width is the card\'s');
  assert.deepEqual(fixed({ left: lin(0, 0), right: auto, width: lin(0, 1000) }, undefined, 1000), { left: '260px', width: '732px', 'box-sizing': 'border-box' }, '100vw is the card');
  assert.deepEqual(fixed({ left: lin(50, -100), right: auto, width: lin(0, 200) }, undefined, 200), { left: '526px' }, 'calc(50% - 100px)');
  assert.deepEqual(fixed({ left: lin(0, 0), right: lin(0, 0), width: lin(0, 400) }, undefined, 400), { left: '260px', right: '8px' }, 'fixed px width kept (margin: auto centres it in the card)');

  assert.deepEqual(fixed({ left: auto, right: auto, width: auto }), {}, 'static position: already pushed');
  assert.deepEqual(fixed({ left: null, right: lin(0, 0), width: auto }), {}, 'anchor-positioned: leave it');
});

test('full-bleed: window-wide in-flow elements fit the card, aligned by at most the push', () => {
  assert.equal(isFullBleed(1000, view), true);
  assert.equal(isFullBleed(985, { ...view, viewport: 985 }), true, '100% of the viewport without the scrollbar');
  assert.equal(isFullBleed(732, view), false, 'already the card');
  assert.equal(isFullBleed(500, view), false);
  assert.equal(isFullBleed(1000, { ...view, width: 1000 }), false, 'nothing to fit (no sidebar)');

  assert.deepEqual(Object.fromEntries(bleedDeclarations(view)), { width: '732px', 'min-width': '0', 'box-sizing': 'border-box' });
  assert.deepEqual(alignDeclarations(126, -134, view), [['margin-left', '0px']], 'margin-left: calc(50% - 50vw)');
  assert.deepEqual(alignDeclarations(394, 0, view), [['margin-left', '-134px']], 'left: 50% + translate(-50%)');
  assert.deepEqual(alignDeclarations(260, 0, view), [], 'already aligned');
  assert.deepEqual(alignDeclarations(260 + 732 * 2, 0, view), [], 'a carousel\'s third slide stays where it is');
});
