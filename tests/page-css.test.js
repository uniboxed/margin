// The page's CSS spoken for its box: media queries and viewport units.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asksSize, hasUnits, shiftQuery, shiftUnits } from '../extension/shared/page-css.js';
import { readFileSync } from 'node:fs';
import { FITTED_BODY, HOLD_ELEMENT, NO_BOX_CSS, READ_ELEMENT, SAID_CSS, STILL_CSS, bodyFitCss, boxCss, boxRules } from '../extension/shared/page-box.js';

test('a query about the window\'s size moves by the room the page doesn\'t have', () => {
  assert.equal(shiftQuery('(max-width: 900px)', 268, 16), '(max-width: 1168px)');
  assert.equal(shiftQuery('(min-height: 600px)', 268, 16), '(min-height: 616px)');
  assert.equal(shiftQuery('screen and (min-width: 40em) and (max-width: 1000px)', 100, 0), 'screen and (min-width: 740px) and (max-width: 1100px)');
  assert.equal(shiftQuery('(width >= 500px)', 10, 0), '(width >= 510px)');
  assert.equal(shiftQuery('(500px <= width)', 10, 0), '(510px <= width)');
  assert.equal(shiftQuery('(prefers-color-scheme: dark)', 10, 10), '(prefers-color-scheme: dark)');
  assert.equal(shiftQuery('(min-device-width: 500px)', 10, 10), '(min-device-width: 500px)');
});

test('a query moved there and back is where it was (the ledger moves by the difference)', () => {
  const moved = shiftQuery('(max-width: 900px)', 268, 16);
  assert.equal(shiftQuery(moved, 50 - 268, 0), '(max-width: 950px)');
  assert.equal(shiftQuery(shiftQuery(moved, -218, 0), -50, 0), '(max-width: 900px)');
  assert.equal(shiftQuery('(max-width: 60em)', 0, 0), '(max-width: 60em)', 'no move: left as written');
});

test('asksSize: the window\'s size, not the screen\'s or anything else', () => {
  assert.ok(asksSize('(max-width: 1px)'));
  assert.ok(asksSize('(width > 1px)'));
  assert.ok(!asksSize('(max-device-width: 1px)'));
  assert.ok(!asksSize('print'));
});

test('viewport units become the box\'s, through variables', () => {
  assert.equal(shiftUnits('100vw'), 'calc(100vw - 1 * var(--margin-dw))');
  assert.equal(shiftUnits('50vh'), 'calc(50vh - 0.5 * var(--margin-dh))');
  assert.equal(shiftUnits('100dvh'), 'calc(100dvh - 1 * var(--margin-dh))');
  assert.equal(shiftUnits('10vmin'), 'min(calc(10vw - 0.1 * var(--margin-dw)), calc(10vh - 0.1 * var(--margin-dh)))');
  assert.equal(shiftUnits('-50vw'), 'calc(-50vw - -0.5 * var(--margin-dw))');
  assert.equal(shiftUnits('.5vw'), 'calc(.5vw - 0.005 * var(--margin-dw))');
});

test('the same value twice changes it once; two in one rule both change', () => {
  const once = shiftUnits('calc(50vw - 50%)');
  assert.equal(once, 'calc(calc(50vw - 0.5 * var(--margin-dw)) - 50%)');
  assert.equal(shiftUnits(once), once);
});

test('what isn\'t a length stays: addresses, strings, names', () => {
  assert.equal(shiftUnits('url(a-10vw.png)'), 'url(a-10vw.png)');
  assert.equal(shiftUnits('"100vw"'), '"100vw"');
  assert.equal(shiftUnits('fade-10vw 1s'), 'fade-10vw 1s');
  assert.equal(shiftUnits('10px'), '10px');
  assert.ok(!hasUnits('10px'));
  assert.ok(hasUnits('100svh'));
});

test('the box: the same rules in the page and the placeholder, under @media screen, and its variables stay defined', () => {
  const box = { left: 260, top: 8, right: 8, bottom: 8 };
  const css = boxCss(box);
  assert.ok(css.includes(boxRules('html', box)));
  assert.match(css, /--margin-dw: 268px; --margin-dh: 16px/);
  assert.match(css, /transform: translate\(260px, 8px\) !important/);
  assert.match(css, /width: calc\(100vw - 268px\) !important; height: calc\(100vh - 16px\) !important/);
  assert.ok(css.indexOf('@media screen') < css.indexOf(boxRules('html', box)));
  assert.ok(css.startsWith(NO_BOX_CSS), 'print and no box: 0');
  assert.doesNotMatch(boxRules('html', box), /overflow:/, 'a page\'s own overflow stays readable (content/page/box.js)');
});

test('the body: nothing the placeholders share, its width in a sheet of its own, and a body that grows stays auto', () => {
  const box = { left: 260, top: 8, right: 8, bottom: 8 };
  assert.doesNotMatch(boxRules('html', box), /body/, 'the page\'s world reads what the page says with its sheets off: a placeholder can\'t be in the way');
  assert.doesNotMatch(boxCss(box), /max-width: none !important; box-sizing: border-box !important; height/);
  assert.match(boxCss(box), /position: relative !important; inset: auto !important/);
  assert.match(bodyFitCss(), /width: auto !important; max-width: none !important/);
  assert.match(bodyFitCss(), /box-sizing: border-box !important; height: 100% !important;/);
  assert.match(bodyFitCss({ grows: true }), /box-sizing: border-box !important; height: auto !important;/);
  for (const options of [{}, { grows: true }]) assert.match(bodyFitCss(options).split('\n')[1], /^\s*html > body:where\(:first-of-type\) \{ min-height: 100% !important; max-height: 100% !important; \}/, 'kept through a read, not behind it: a layout during one must not shrink <body> past its scroll');
  assert.doesNotMatch(bodyFitCss({ grows: true }), /flex-shrink/);
  assert.match(bodyFitCss({ grows: true, column: true }), /flex-shrink: 0 !important/);
  assert.doesNotMatch(bodyFitCss({ column: true }), /flex-shrink/, 'a body the page holds at the box\'s height lets its children shrink, as in a window');
});

test('a read leaves nothing in the page, and is held against what a page says', () => {
  assert.ok(FITTED_BODY.includes(`:nth-last-child(1 of body:first-of-type, ${READ_ELEMENT})`), 'on with nothing there: a page\'s new <html> or a stray <body> changes nothing');
  assert.ok(STILL_CSS.includes(`:nth-last-child(1 of body:first-of-type, ${HOLD_ELEMENT})`));
  assert.doesNotMatch(`${bodyFitCss()} ${STILL_CSS}`, /:state\(/, 'the element has no custom state: nothing to define, nothing a page can refuse');
  assert.doesNotMatch(`${bodyFitCss()} ${STILL_CSS}`, /~ body|\+ body/, 'after <body>, not before: `:nth-child` and `head:first-child + body` stay the page\'s');
  const source = readFileSync(new URL('../extension/content/page/box.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /customElements|attachInternals/, 'a page can patch or refuse the registry');
  assert.doesNotMatch(`${bodyFitCss()} ${STILL_CSS}`, /:has\(/, 'it costs every page in Chromium as children are added');
  assert.doesNotMatch(`${bodyFitCss()} ${STILL_CSS} ${SAID_CSS}`, /data-margin|\[data-/);
  assert.match(STILL_CSS, /:not\(#m#m#m#m#m\)/, 'the weight of five ids: a page\'s `html body#b { transition: all !important }` loses');
  assert.match(STILL_CSS, /::before.*::after/, 'pseudo-elements inherit from <body>');
  assert.match(bodyFitCss({ held: true }), /\* \{ transition-duration: 0s !important/);
  assert.doesNotMatch(bodyFitCss(), /\* \{ transition-duration/, 'only on a page that needs it: it restyles the whole page');
});

test('the rule that reads top margins depends on no sibling, and stays off real backdrops', () => {
  assert.doesNotMatch(SAID_CSS, /:(first|last|only)-child|:nth-/, 'a structural pseudo-class costs every parent on each child added or removed');
  assert.match(SAID_CSS, /:not\(dialog, \[popover\], :fullscreen\)::backdrop/);
});

test('a rule on <html>\'s size has to outweigh nothing to hide the flags', () => {
  for (const flag of [READ_ELEMENT, HOLD_ELEMENT]) assert.ok(STILL_CSS.includes(`${flag}:not(#m#m#m#m#m)`), 'a page\'s `:root :not(#z#z) { display: block !important }` must not show one');
});

test('the box follows a page\'s zoom on <html>', () => {
  const box = { left: 300, top: 10, right: 10, bottom: 10 };
  assert.ok(boxRules('html', box).includes('calc(100vw - 310px)'), 'with no zoom, as ever');
  const zoomed = boxCss(box, 2);
  assert.ok(zoomed.includes('calc(50vw - 155px)'));
  assert.ok(zoomed.includes('translate(150px, 5px)'));
  assert.ok(zoomed.includes('--margin-dw: 155px'));
});
