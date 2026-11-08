// The page's CSS spoken for its box: media queries and viewport units.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asksSize, declarations, hasUnits, shiftQuery, shiftStyle, shiftUnits } from '../extension/shared/page-css.js';
import { readFileSync } from 'node:fs';
import { FITTED_BODY, HOLD_ELEMENT, bodyBackgroundCss, NO_BOX_CSS, READ_ELEMENT, SAID_CSS, STILL_CSS, bodyFitCss, boxCss, boxRules, BOX_ROOT } from '../extension/shared/page-box.js';

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
  assert.equal(shiftUnits('100vw'), 'calc(100vw - 1 * var(--margin-box-dw))');
  assert.equal(shiftUnits('50vh'), 'calc(50vh - 0.5 * var(--margin-box-dh))');
  assert.equal(shiftUnits('100dvh'), 'calc(100dvh - 1 * var(--margin-box-dh))');
  assert.equal(shiftUnits('10vmin'), 'min(calc(10vw - 0.1 * var(--margin-box-dw)), calc(10vh - 0.1 * var(--margin-box-dh)))');
  assert.equal(shiftUnits('-50vw'), 'calc(-50vw - -0.5 * var(--margin-box-dw))');
  assert.equal(shiftUnits('.5vw'), 'calc(.5vw - 0.005 * var(--margin-box-dw))');
});

test('the same value twice changes it once; two in one rule both change', () => {
  const once = shiftUnits('calc(50vw - 50%)');
  assert.equal(once, 'calc(calc(50vw - 0.5 * var(--margin-box-dw)) - 50%)');
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
  assert.ok(css.includes(boxRules(BOX_ROOT, box)));
  assert.match(css, /--margin-box-dw: 268px; --margin-box-dh: 16px/);
  assert.match(css, /transform: translate\(260px, 8px\) !important/);
  assert.match(css, /width: calc\(100vw - 268px\) !important; height: calc\(100vh - 16px\) !important/);
  assert.ok(css.indexOf('@media screen') < css.indexOf(boxRules(BOX_ROOT, box)));
  assert.ok(css.startsWith(NO_BOX_CSS), 'print and no box: 0');
  assert.doesNotMatch(boxRules(BOX_ROOT, box), /overflow:/, 'a page\'s own overflow stays readable (content/page/box.js)');
  assert.ok(css.includes(`html:not(#m#m#m#m#m) {`), 'the box\'s <html> outweighs a page\'s `.w-100 { width: 100% !important }` (tests/box/patterns/html-class-width.html)');
  assert.ok(css.includes(`html:not(#m#m#m#m#m):fullscreen {`), '<html> in full screen outweighs the box\'s <html>');
});

test('the body: nothing the placeholders share, its width in a sheet of its own, and a body that grows stays auto', () => {
  const box = { left: 260, top: 8, right: 8, bottom: 8 };
  assert.doesNotMatch(boxRules(BOX_ROOT, box), /body/, 'the page\'s world reads what the page says with its sheets off: a placeholder can\'t be in the way');
  assert.doesNotMatch(boxCss(box), /max-width: none !important; box-sizing: border-box !important; height/);
  assert.match(boxCss(box), /position: relative !important; top: auto !important; bottom: auto !important;/, 'a scroll lock\'s top mustn\'t move the scroller');
  assert.doesNotMatch(boxCss(box), /inset: auto/, 'a page\'s own left or right is read (tests/box/patterns/body-centred-by-offset.html)');
  assert.match(bodyFitCss(), /left: auto !important; right: auto !important;/, 'and held still once it\'s given back as padding');
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

test('<html> clips both ways, and only sideways while the page says its own overflow-x', () => {
  const box = { left: 300, top: 10, right: 10, bottom: 10 };
  assert.match(boxCss(box), /:where\(html\) \{ overflow: clip; \}/, 'nothing said: the window never scrolls');
  const sideways = boxCss(box, 1, false);
  assert.match(sideways, /:where\(html\) \{ overflow-x: clip; \}/);
  assert.doesNotMatch(sideways, /:where\(html\) \{ overflow: clip/, 'no clip up and down to turn into hidden');
});

test('<html> itself in full screen (YouTube\'s video) is the whole window, not the box', () => {
  const box = { left: 260, top: 8, right: 8, bottom: 8 };
  const css = boxCss(box);
  const head = `${BOX_ROOT}:fullscreen {`;
  const rule = css.slice(css.indexOf(head), css.indexOf('}', css.indexOf(head)));
  assert.ok(rule.length > 0, 'a rule for it');
  assert.match(rule, /transform: none !important/);
  assert.match(rule, /width: 100vw !important; height: 100vh !important/);
  assert.match(rule, /--margin-box-left: 0px/);
  // More specific than the box's own <html> rule (BOX_ROOT), both !important: it wins.
  assert.ok(css.indexOf(head) > css.indexOf('transform: translate('), 'after the box\'s rule too');
  const zoomed = boxCss(box, 2);
  assert.match(zoomed.slice(zoomed.indexOf(head) + head.length), /^\s*transform: none !important; width: 50vw !important; height: 50vh !important/, 'in the page\'s zoomed pixels');
});

test('the box follows a page\'s zoom on <html>', () => {
  const box = { left: 300, top: 10, right: 10, bottom: 10 };
  assert.ok(boxRules(BOX_ROOT, box).includes('calc(100vw - 310px)'), 'with no zoom, as ever');
  const zoomed = boxCss(box, 2);
  assert.ok(zoomed.includes('calc(50vw - 155px)'));
  assert.ok(zoomed.includes('translate(150px, 5px)'));
  assert.ok(zoomed.includes('--margin-box-dw: 155px'));
});

// A declaration block as a browser keeps one (enough of it): a shorthand with a var() is kept as
// its text, its longhands reading empty (pending the var()); one without is its longhands.
function fakeStyle(decls) {
  const LONG = { font: ['font-style', 'font-weight', 'font-size', 'line-height', 'font-family'], padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'] };
  const longs = new Map();
  const shorts = new Map();
  const style = {
    getPropertyValue: (n) => (shorts.has(n) ? shorts.get(n) : longs.get(n)?.[0] ?? ''),
    getPropertyPriority: (n) => longs.get(n)?.[1] ?? '',
    setProperty(n, v, p = '') {
      if (LONG[n]) {
        if (v.includes('var(')) { shorts.set(n, v); for (const l of LONG[n]) { longs.delete(l); longs.set(l, ['', p]); } } else for (const l of LONG[n]) { longs.delete(l); longs.set(l, [v, p]); }
      } else { for (const [s, ls] of Object.entries(LONG)) if (ls.includes(n)) shorts.delete(s); longs.delete(n); longs.set(n, [v, p]); }
    },
    set cssText(text) { if (text) throw new Error('only emptied'); longs.clear(); shorts.clear(); },
    get cssText() { return [...shorts].map(([n, v]) => `${n}: ${v};`).concat([...longs].filter(([n]) => ![...shorts.keys()].some((s) => LONG[s].includes(n))).map(([n, [v]]) => `${n}: ${v};`)).join(' '); },
    [Symbol.iterator]: () => [...longs.keys()][Symbol.iterator](),
  };
  for (const [n, v] of decls) style.setProperty(n, v);
  return style;
}

test('declarations: a block\'s text in its declarations, not split inside brackets or strings', () => {
  assert.deepEqual(declarations('font: 800 clamp(30px, 3.2vw, 44px) / 1.15 var(--sans); color: red !important; background: url("a;b.png"); content: \'x;y\'; --x: { a; b }'), [
    ['font', '800 clamp(30px, 3.2vw, 44px) / 1.15 var(--sans)', false], ['color', 'red', true], ['background', 'url("a;b.png")', false], ['content', "'x;y'", false], ['--x', '{ a; b }', false],
  ]);
  assert.deepEqual(declarations(''), []);
});

test('shiftStyle: vw in a font shorthand with a var() is moved too; a longhand set apart from it is kept', () => {
  const style = fakeStyle([['font', '800 clamp(30px, 3.2vw, 44px)/1.15 var(--sans)'], ['color', 'red']]);
  shiftStyle(style, fakeStyle([]));
  assert.equal(style.getPropertyValue('font'), shiftUnits('800 clamp(30px, 3.2vw, 44px)/1.15 var(--sans)'));
  assert.match(style.getPropertyValue('font'), /--margin-box-dw/);
  assert.equal(style.getPropertyValue('color'), 'red');
  // Twice: once.
  const once = style.getPropertyValue('font');
  shiftStyle(style, fakeStyle([]));
  assert.equal(style.getPropertyValue('font'), once);
  // Without a var(): the longhands, as before.
  const plain = fakeStyle([['padding', '4vw']]);
  shiftStyle(plain, fakeStyle([]));
  assert.equal(plain.getPropertyValue('padding-left'), shiftUnits('4vw'));
});

test('shiftStyle: a shorthand the text gives whole is set as its longhands, which still read', () => {
  // The block's text says `padding: 4vw 2px` (a browser joins its longhands so).
  const style = fakeStyle([['padding', '4vw 2px'], ['color', 'red']]);
  shiftStyle(style, fakeStyle([]), 'padding: 4vw 2px; color: red;');
  assert.equal(style.getPropertyValue('padding-left'), shiftUnits('4vw 2px'), 'the fake takes a shorthand\'s value for each longhand');
  assert.ok(!style.getPropertyValue('padding'), 'not set again as a whole, which a var() would leave pending');
});

test('shiftStyle: only what has units is touched, however many custom properties a block has', () => {
  const decls = Array.from({ length: 2000 }, (_, i) => [`--t${i}`, `${i}px`]);
  decls.push(['--wide', '50vw']);
  const style = fakeStyle(decls);
  let reads = 0;
  let writes = 0;
  const { getPropertyValue, setProperty } = style;
  style.getPropertyValue = (n) => (reads++, getPropertyValue(n));
  style.setProperty = (n, v, p) => (writes++, setProperty(n, v, p));
  shiftStyle(style, fakeStyle([]));
  assert.equal(writes, 1);
  assert.equal(reads, 0, 'none read one by one');
  assert.equal(getPropertyValue('--wide'), shiftUnits('50vw'));
});

test('a body\'s background image is kept on <body>, which fills the box, not the window\'s canvas; a color alone is left to the canvas', () => {
  assert.equal(bodyBackgroundCss({ backgroundImage: 'none', backgroundColor: 'rgb(0, 0, 0)' }), '');
  const css = bodyBackgroundCss({ backgroundImage: 'linear-gradient(red, blue)', backgroundColor: 'rgb(1, 2, 3)' });
  assert.match(css, /^@media screen \{ :where\(html\) \{/, 'no weight: a page\'s own rule on <html> wins');
  assert.match(css, /background-color: rgb\(1, 2, 3\)/, 'the canvas keeps <body>\'s color');
  assert.match(css, /background-image: linear-gradient\(transparent, transparent\)/, 'something on <html> stops it going to the canvas');
});
