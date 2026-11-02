// The page's CSS spoken for its box: media queries and viewport units.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asksSize, hasUnits, shiftQuery, shiftUnits } from '../extension/shared/page-css.js';
import { hasStatefulPseudo } from '../extension/content/page/sheets.js';
import { readFileSync } from 'node:fs';
import { BODY_COVER_CSS, BODY_GUARD_CSS, FITTED_BODY, NO_BOX_CSS, SAID_CSS, bodyFitCss, bodyHoldCss, boxCss, boxRules } from '../extension/shared/page-box.js';

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
  assert.match(BODY_GUARD_CSS, /min-height: 100% !important; max-height: 100% !important;/, 'kept through a read: a layout during one must not shrink <body> past its scroll');
  assert.doesNotMatch(bodyFitCss(), /min-height:/, 'the fit selector can turn off without removing the height guard');
  assert.doesNotMatch(bodyFitCss({ grows: true }), /flex-shrink/);
  assert.match(bodyFitCss({ grows: true, column: true }), /flex-shrink: 0 !important/);
  assert.doesNotMatch(bodyFitCss({ column: true }), /flex-shrink/, 'a body the page holds at the box\'s height lets its children shrink, as in a window');
  const source = readFileSync(new URL('../extension/content/page/box.js', import.meta.url), 'utf8');
  assert.match(source, /inlineLocked = Array\.from\(body\.style\)/, 'inline important geometry is not translated a second time into padding');
});

test('WebKit reads through transient head state without changing tree shape; Blink can stay private', () => {
  const readAttribute = 'data-margin-read-test';
  const fitted = bodyFitCss({}, readAttribute);
  const held = bodyHoldCss({}, readAttribute);
  assert.equal(FITTED_BODY, 'html > body:where(:first-of-type)');
  assert.match(fitted, /:where\(head:first-of-type:not\(\[data-margin-read-test="read"\]\)\) ~ body/);
  assert.match(held, /:where\(head:first-of-type\[data-margin-read-test\]\) ~ body/);
  assert.doesNotMatch(`${fitted} ${held}`, /:state\(|body[^,{]*:(last|only)-child|body[^,{]*:nth-/, 'body structural selectors stay exactly as authored');
  const source = readFileSync(new URL('../extension/content/page/box.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /customElements|attachInternals/, 'a page can patch or refuse the registry');
  assert.doesNotMatch(source, /createElement\(READ|createElement\(HOLD|append\.call\(html/, 'no child marker can affect structural selectors, hydration or custom elements');
  assert.doesNotMatch(`${fitted} ${held}`, /:has\(/, 'it costs every page in Chromium as children are added');
  assert.match(held, /:not\(#m#m#m#m#n\)/, 'five ids of weight with an impossible argument: even `<body id="m">` still matches');
  assert.match(held, /::before.*::after/, 'pseudo-elements inherit from <body>');
  assert.match(bodyHoldCss({ held: true }), /\* \{ transition-duration: 0s !important/);
  assert.doesNotMatch(bodyFitCss(), /transition-duration/, 'the selected hold sheet owns transition suppression');
});

test('the arrival cover uses a private fast path with a verified inline fallback', () => {
  assert.match(BODY_COVER_CSS, /opacity: 0 !important/);
  assert.match(BODY_COVER_CSS, /transition-duration: 0s !important/);
  const core = readFileSync(new URL('../extension/content/core.js', import.meta.url), 'utf8');
  assert.match(core, /link\.setCovered\(true\)/);
  assert.match(core, /getComputedStyle\(page\)\.opacity !== HIDE_VALUE/, 'a losing private author rule falls back before the page is presented');
  assert.match(core, /if \(!privatelyCovered\) page\.style\.setProperty/, 'inline style covers an older page script or an authored stronger opacity rule');
  assert.match(core, /preparingShow\.arrival/, 'an unpublished preparation still owns and can cancel its arrival cover');
});

test('a hidden destination reconciles sheets and geometry before its acknowledgement layout', () => {
  const main = readFileSync(new URL('../extension/content/page/main.js', import.meta.url), 'utf8');
  const core = readFileSync(new URL('../extension/content/core.js', import.meta.url), 'utf8');
  assert.ok(main.indexOf('sheets.flush()') < main.indexOf('box.prepare(sheets.flush)'), 'viewport rewrites precede the one pending body reading, and resize-handler writes are flushed again');
  assert.ok(core.indexOf('geometryReady = link.prepare()') < core.indexOf('host.getBoundingClientRect()'), 'the final forced layout acknowledges page-world geometry too');
});

test('dynamic rule hooks do not replace the inline-style hot path', () => {
  const sheets = readFileSync(new URL('../extension/content/page/sheets.js', import.meta.url), 'utf8');
  assert.doesNotMatch(sheets, /declarationProto\.(setProperty|removeProperty)\s*=/, 'element.style methods stay native');
  assert.doesNotMatch(sheets, /styleMapProto\[name\]\s*=/, 'inline Typed OM methods stay native');
  assert.match(sheets, /Object\.setPrototypeOf\(declaration, declarationPrototype\(\)\)/, 'retained rule declarations share one lightweight child prototype');
  assert.match(sheets, /Object\.create\(declarationProto, descriptors\)/, 'the complete property table is allocated once per page, not once per rule');
  assert.match(sheets, /value === null \? '' : String\(value\)/, 'rule declarations preserve native null-to-empty-string conversion');
  assert.match(sheets, /for \(const name in probe\)/, 'the browser supplies the complete version-specific CSS property list');
  assert.match(sheets, /for \(let owner = probe; owner; owner = Object\.getPrototypeOf\(owner\)\)/, 'inherited WebKit properties keep their native enumeration shape');
  assert.match(sheets, /nativeSet\.call\(this, shifted\)/, 'WebKit vendor aliases use the engine\'s own named-property setters');
  assert.match(sheets, /queueHasRebuild\(\); \/\/ a removed grouping rule/, 'deleting a rule rebuilds nested :has() metadata');
});

test('sheet observation stays scoped while preflight can drain every style source', () => {
  const sheets = readFileSync(new URL('../extension/content/page/sheets.js', import.meta.url), 'utf8');
  assert.match(sheets, /const WATCH = \{[^\n]+attributeFilter: \['style'\]/, 'the document-wide observer sees no generic href/type/disabled churn');
  assert.match(sheets, /const STYLE_ATTRIBUTES = \{[^\n]+\['media', 'disabled', 'href', 'rel', 'type'\]/, 'activation attributes are watched only on style and link nodes');
  assert.match(sheets, /styleAttributeWatch\.takeRecords\(\)/, 'destination preflight drains targeted style-attribute records too');
  assert.match(sheets, /let shadowHasRoots = new Set\(\)/, 'shadow :has() work is bounded to roots that actually contain such selectors');
});

test('only stateful :has selectors need page-interaction hooks', () => {
  assert.equal(hasStatefulPseudo('body:has(.modal > [open])'), false);
  assert.equal(hasStatefulPseudo('body:not(:has(input:checked))'), true);
  assert.equal(hasStatefulPseudo(':host-context(body:hover) article:has(.ready)'), true);
  assert.equal(hasStatefulPseudo('body:has([data-copy=":hover"] .ready)'), false, 'attribute text is not a pseudo-class');
  assert.equal(hasStatefulPseudo('body:has(.focus-visible-copy)'), false, 'class names are not pseudo-classes');
  const sheets = readFileSync(new URL('../extension/content/page/sheets.js', import.meta.url), 'utf8');
  assert.match(sheets, /listenForHasState\(documentHasState \|\| shadowHasStateRoots\.size > 0\)/, 'structural-only :has() keeps global interaction listeners off');
});

test('the rule that reads top margins depends on no sibling, and stays off real backdrops', () => {
  assert.doesNotMatch(SAID_CSS, /:(first|last|only)-child|:nth-/, 'a structural pseudo-class costs every parent on each child added or removed');
  assert.match(SAID_CSS, /:not\(dialog, \[popover\], :fullscreen\)::backdrop/);
});

test('the box follows a page\'s zoom on <html>', () => {
  const box = { left: 300, top: 10, right: 10, bottom: 10 };
  assert.ok(boxRules('html', box).includes('calc(100vw - 310px)'), 'with no zoom, as ever');
  const zoomed = boxCss(box, 2);
  assert.ok(zoomed.includes('calc(50vw - 155px)'));
  assert.ok(zoomed.includes('translate(150px, 5px)'));
  assert.ok(zoomed.includes('--margin-dw: 155px'));
});
