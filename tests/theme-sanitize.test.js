// The theme sanitizer and the action checks (PLAN.md §4), with known XSS,
// CSS-leak and action-abuse payloads. The same payloads run live in WebKit
// and Chromium in tests/theme/browser.test.js (npm run test:theme).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeTemplate, sanitizeCss, sanitizeDeclarations, checkCssValue, checkIconUrl,
  tokenizeCss, parseInterpolation, isBundledPath, LIMITS,
} from '../extension/ui/sanitize.js';
import { ACTIONS, checkAction, contextFromState, createDispatcher, isAction } from '../extension/ui/actions.js';
import { checkManifest } from '../extension/ui/theme-schema.js';
import { sanitizeTheme } from '../extension/ui/theme-loader.js';
import { HTML_PAYLOADS, CSS_PAYLOADS, ACTION_PAYLOADS, wrap } from './theme/payloads.js';
import { auditTree } from './theme/audit.js';
import { readTheme } from './theme/package.js';
import { MockState, pngIcon } from './theme/view-model.js';

const MANIFEST = JSON.stringify({ format: 2, id: 'payload', name: 'Payload', version: '1.0.0' });
const leaks = (text) => /evil\.test|javascript:|vbscript:|expression\(/i.test(text);

// --- Built-in themes pass the same rules as anyone's -------------------------

test('Neo-brutalism passes the sanitizer with nothing removed', () => {
  const t = readTheme();
  const r = sanitizeTheme({ ...t, files: Object.keys(t.files) });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.removed, []);
  assert.equal(r.ok, true);
  assert.equal(r.stats.pages, 1);
  assert.deepEqual(auditTree(r.tree), []);
  assert.equal(r.manifest.fonts.length, 4);
  assert.ok(r.css.includes('.page{'), 'the page card survives');
  assert.ok(!/@import|url\(/.test(r.css), 'no imports or URLs in the theme');
});

test('Neo-brutalism bundles its fonts as woff2 with the OFL text, and the template names no font service', () => {
  const t = readTheme();
  for (const f of ['fonts/archivo-black-latin.woff2', 'fonts/space-grotesk-latin.woff2']) {
    assert.ok(t.files[f], f);
    assert.equal(t.files[f].subarray(0, 4).toString('latin1'), 'wOF2', `${f} is woff2`);
  }
  for (const f of ['fonts/OFL-ArchivoBlack.txt', 'fonts/OFL-SpaceGrotesk.txt']) assert.match(t.files[f].toString(), /SIL Open Font License, Version 1\.1/);
  assert.doesNotMatch(t.html + t.css + t.manifest, /fonts\.googleapis|fonts\.gstatic|https?:\/\//);
});

// --- HTML payloads ------------------------------------------------------------

for (const [name, fragment] of HTML_PAYLOADS) {
  test(`html payload: ${name}`, () => {
    const r = sanitizeTemplate(wrap(fragment), { files: [] });
    const violations = auditTree(r.tree);
    assert.deepEqual(violations, [], 'nothing dangerous survives');
    const kept = JSON.stringify(r.tree);
    assert.ok(!/"on[a-z]+"/i.test(kept), 'no on* attribute');
    assert.ok(!/"(srcdoc|formaction|srcset|ping)"/.test(kept));
    // Fine as written: the danger is in the view model's values, which the
    // renderer checks when they arrive (tests/theme/browser.test.js).
    const benign = /xmlns attributes|kept: images are sandboxed|^comment$|fed a URL|fed a remote|view-model HTML|double interpolation/.test(name);
    if (!benign) assert.ok(r.removed.length > 0 || r.errors.length > 0, `the sanitizer reports what it removed (${name})`);
  });
}

test('the sanitizer reports each removal with what, why and where', () => {
  const r = sanitizeTemplate(wrap('\n<img src=x onerror="__trip(1)">\n<script>__trip(2)</script>'), { files: [] });
  assert.deepEqual(r.removed.map((x) => [x.kind, x.name, x.at]), [
    ['element', 'script', 3],
    ['attribute', '<img> src', 2],
    ['attribute', '<img> onerror', 2],
  ]);
  assert.match(r.removed.find((x) => x.name === '<img> onerror').reason, /event handlers/);
});

test('entity-encoded and obfuscated javascript: links are removed, # links kept', () => {
  for (const href of ['&#106;avascript:x', 'java&#x09;script:x', 'JAVASCRIPT:x', ' #x', 'https://evil.test', '//evil.test', '#x y']) {
    const r = sanitizeTemplate(wrap(`<a href="${href}">x</a>`));
    assert.ok(!JSON.stringify(r.tree).includes('"href"'), href);
  }
  for (const href of ['#', '#top']) {
    const r = sanitizeTemplate(wrap(`<a href="${href}">x</a>`));
    assert.ok(JSON.stringify(r.tree).includes(`["href","${href}"]`), href);
  }
});

test('bundled images only: present in the package, no traversal, rewritten through assetUrl', () => {
  const files = ['images/a.png', 'fonts/x.woff2'];
  const assetUrl = (p) => `margin-theme://t/${p}`;
  const keep = sanitizeTemplate(wrap('<img src="images/a.png" alt="">'), { files, assetUrl });
  assert.ok(JSON.stringify(keep.tree).includes('margin-theme://t/images/a.png'));
  for (const src of ['images/b.png', '../images/a.png', 'images/../images/a.png', '/images/a.png', 'fonts/x.woff2', 'images/a.png?x', './images/a.png']) {
    const r = sanitizeTemplate(wrap(`<img src="${src}" alt="">`), { files, assetUrl });
    assert.ok(!JSON.stringify(r.tree).includes('"src"'), src);
  }
  assert.equal(isBundledPath('images/a.png', files), true);
  assert.equal(isBundledPath('images/a.png', undefined), false);
});

test('a data: image is kept in an <img>; other data: types are not', () => {
  const png = pngIcon([1, 2, 3]);
  assert.ok(JSON.stringify(sanitizeTemplate(wrap(`<img src="${png}" alt="">`)).tree).includes(png));
  for (const src of ['data:text/html,<b>x</b>', 'data:image/png,notbase64', 'data:image/png;base64,@@@', 'data:application/javascript;base64,YQ==', 'DATA:image/png;base64,AAAA']) {
    assert.ok(!JSON.stringify(sanitizeTemplate(wrap(`<img src="${src}" alt="">`)).tree).includes('"src"'), src);
  }
});

test('bindings may only target allowed attributes', () => {
  const ok = sanitizeTemplate(wrap('<button type="button" aria-label="Go to {{t.title}}" title="{{t.title}}" data-id="{{t.id}}" m-attr:aria-pressed="{{s.active}}" m-class:on="{{t.active}}" m-style:--accent="{{space.color}}">x</button>'));
  assert.deepEqual(ok.removed, []);
  const bad = [
    '<a href="{{tab.url}}">x</a>', '<img src="{{t.icon}}" alt="">', '<div style="color:{{c}}">x</div>', '<div class="{{c}}">x</div>',
    '<div id="{{c}}">x</div>', '<div m-attr:href="{{u}}">x</div>', '<div m-attr:src="{{u}}">x</div>', '<div m-attr:style="{{u}}">x</div>',
    '<div m-attr:onclick="{{u}}">x</div>', '<div m-attr:srcdoc="{{u}}">x</div>', '<div m-attr:class="{{u}}">x</div>',
    '<div m-style:color="{{u}}">x</div>', '<div m-style:--x="red">x</div>', '<div m-class:on="yes">x</div>', '<img m-icon="data:image/png;base64,AA" alt="">',
    '<div m-icon="{{t.icon}}">x</div>',
  ];
  for (const html of bad) {
    const r = sanitizeTemplate(wrap(html));
    assert.ok(r.removed.some((x) => x.kind === 'attribute'), html);
    assert.doesNotMatch(JSON.stringify(r.tree), /\{\{(tab\.url|t\.icon|c|u)\}\}/, html);
  }
});

test('bindings are dotted paths only: no expressions, no prototype walks', () => {
  assert.deepEqual(parseInterpolation('{{a.b}} tabs').parts, [{ path: ['a', 'b'] }, ' tabs']);
  assert.deepEqual(parseInterpolation('{{ list.0.name }}').parts, [{ path: ['list', '0', 'name'] }]);
  for (const bad of ['{{a + b}}', '{{a()}}', "{{a['b']}}", '{{__proto__}}', '{{a.constructor}}', '{{a.prototype.x}}', '{{0.a}}', '{{a..b}}', '{{a.b-c}}']) {
    assert.equal(parseInterpolation(bad).bound, false, bad);
    assert.ok(parseInterpolation(bad).bad !== null, bad);
  }
  const r = sanitizeTemplate(wrap('<m-for each="spaces" as="__proto__"><i>x</i></m-for><m-if test="a.constructor"><i>y</i></m-if>'));
  assert.ok(!JSON.stringify(r.tree).includes('m-for'));
  assert.ok(!JSON.stringify(r.tree).includes('m-if'));
});

test('m-action only on buttons and links, only listed actions', () => {
  const r = sanitizeTemplate(wrap('<button m-action="tab.activate" m-arg="{{t.id}}">a</button><a href="#" m-action="space.new">b</a><div m-action="tab.close">c</div><button m-action="eval">d</button><button m-arg="{{x}}">e</button>'));
  const kept = JSON.stringify(r.tree);
  assert.ok(kept.includes('"m-action","tab.activate"'));
  assert.ok(kept.includes('"m-action","space.new"'));
  assert.equal((kept.match(/m-action/g) ?? []).length, 2);
  assert.ok(!kept.includes('"m-arg","{{x}}"'), 'm-arg without an action');
});

test('template structure: one root, exactly one <m-page>, outside lists', () => {
  assert.match(sanitizeTemplate('<div></div>').errors.join(), /exactly one <m-page>/);
  assert.match(sanitizeTemplate('<div><m-page></m-page><m-page></m-page></div>').errors.join(), /found 2/);
  assert.match(sanitizeTemplate('<div><m-page></m-page></div><div></div>').errors.join(), /one root element/);
  assert.match(sanitizeTemplate('<div><m-for each="a" as="b"><m-page></m-page></m-for><m-page></m-page></div>').errors.join(), /inside <m-for>/);
  const deep = '<m-for each="a" as="b">'.repeat(4) + '</m-for>'.repeat(4);
  assert.match(sanitizeTemplate(wrap(deep)).errors.join(), /nested deeper than 3/);
  assert.match(sanitizeTemplate(wrap('<div>'.repeat(60))).errors.join(), /nested deeper/);
  assert.match(sanitizeTemplate('x'.repeat(LIMITS.htmlBytes + 1)).errors.join(), /larger than/);
  assert.match(sanitizeTemplate(wrap('<i></i>'.repeat(LIMITS.htmlNodes))).errors.join(), /nodes/);
});

test('buttons are always type=button (never submit), inputs need m-input', () => {
  const r = sanitizeTemplate(wrap('<button>a</button><input placeholder="x"><input m-input="palette" type="password">'));
  const kept = JSON.stringify(r.tree);
  assert.ok(kept.includes('["type","button"]'));
  assert.equal((kept.match(/"input"/g) ?? []).length, 1, 'only the m-input one');
  assert.ok(!kept.includes('password'));
});

test('svg: drawing elements kept, scripts, foreign content, animation and external references removed', () => {
  const r = sanitizeTemplate(wrap('<svg viewBox="0 0 24 24" class="ico"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><path d="M0 0" fill="url(#g)"/><use href="#g"/><use href="https://evil.test/x#y"/><animate attributeName="href"/><foreignObject/><image href="x.png"/></svg>'));
  const kept = JSON.stringify(r.tree);
  for (const ok of ['"viewBox"', '"linearGradient"', '"url(#g)"', '["href","#g"]']) assert.ok(kept.includes(ok), ok);
  for (const gone of ['evil.test', 'animate', 'foreignObject', '"image"']) assert.ok(!kept.includes(gone), gone);
});

// --- CSS payloads ------------------------------------------------------------

for (const [name, css] of CSS_PAYLOADS) {
  test(`css payload: ${name}`, () => {
    const r = sanitizeCss(css, { files: [] });
    assert.ok(!leaks(r.css), `nothing that loads or runs survives: ${r.css.slice(0, 200)}`);
    assert.ok(!/@import|@namespace|@document|@-moz-document|attr\(|image\("|src\(/i.test(r.css), r.css.slice(0, 200));
    if (/kept, sandboxed/.test(name)) {
      assert.match(r.css, /data:image\/svg\+xml;base64/);
      return;
    }
    if (/comment splitting property name/.test(name)) {
      assert.equal(r.css, '.a{}', 'two idents are no declaration');
      return;
    }
    assert.ok(r.removed.length > 0 || r.errors.length > 0, 'reported');
  });
}

test('css: kept rules come out equivalent, with bundled and data: URLs, and comments become separators', () => {
  const files = ['images/dot.png', 'fonts/a.woff2'];
  const assetUrl = (p) => `margin-theme://t/${p}`;
  const r = sanitizeCss(`
    .a { color: red !important; background: url(images/dot.png) no-repeat }
    .b/**/.c { font-family: "\\2192" }
    @font-face { font-family: A; src: url("fonts/a.woff2") format("woff2") }
    @media (max-width: 600px) { .a:hover > .b { --x: calc(1px + 2px) } }
    .d { background-image: url(data:image/png;base64,iVBORw0KGgo=) }
    .e { & .f { color: blue } }
    @keyframes spin { to { transform: rotate(360deg) } }
    @layer base, theme;
  `, { files, assetUrl });
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.errors, []);
  assert.match(r.css, /\.a\{color:red !important;background:url\("margin-theme:\/\/t\/images\/dot\.png"\) no-repeat;\}/);
  assert.match(r.css, /\.b\/\*\*\/\.c\{font-family:"→";\}/);
  assert.match(r.css, /@font-face\{font-family:A;src:url\("margin-theme:\/\/t\/fonts\/a\.woff2"\) format\("woff2"\);\}/);
  assert.match(r.css, /@media \(max-width: 600px\)\{\.a:hover > \.b\{--x:calc\(1px \+ 2px\);\}\}/);
  assert.match(r.css, /\.e\{& \.f\{color:blue;\}\}/);
  assert.match(r.css, /@keyframes spin\{to\{transform:rotate\(360deg\);\}\}/);
  assert.match(r.css, /@layer base, theme;/);
});

test('css tokenizer: escapes are decoded where CSS decodes them, so u\\72l( is a url token', () => {
  const kinds = (s) => tokenizeCss(s).filter((t) => t.t !== 'ws').map((t) => `${t.t}:${t.v ?? ''}`);
  assert.deepEqual(kinds('u\\72l(x)'), ['url:x']);
  assert.deepEqual(kinds('\\75 rl(x)'), ['url:x']);
  assert.deepEqual(kinds('url( "x" )'), ['func:url', 'str:x', '):']);
  assert.deepEqual(kinds('ur/**/l(x)'), ['ident:ur', 'func:l', 'ident:x', '):']);
  assert.deepEqual(kinds('"a\\"b"'), ['str:a"b']);
  assert.deepEqual(kinds('url(a b)'), ['badurl:']);
  assert.deepEqual(kinds('@\\69mport'), ['at:import']);
  assert.ok(tokenizeCss('u\\72l(x)')[0].esc, 'marked as escaped');
});

test('css limits: bytes, rules, nesting, selector length', () => {
  assert.match(sanitizeCss('a{}'.repeat(LIMITS.cssRules + 1)).errors.join(), /more than \d+ rules/);
  assert.match(sanitizeCss(`/*${'x'.repeat(LIMITS.cssBytes)}*/`).errors.join(), /larger than/);
  assert.match(sanitizeCss(`${'a{'.repeat(12)}color:red${'}'.repeat(12)}`).errors.join(), /nested deeper/);
  assert.equal(sanitizeCss(`${'.x'.repeat(600)}{color:red}`).removed[0].reason, 'selector too long');
  assert.equal(sanitizeCss('a{color:red}\u0000').errors[0], 'css: NUL character');
});

test('style attributes go through the same CSS rules', () => {
  assert.equal(sanitizeDeclarations('color: red; background: url(https://evil.test/x)').css, 'color:red;');
  assert.equal(sanitizeDeclarations('width: expression(alert(1)); color: blue').css, 'color:blue;');
  assert.equal(sanitizeDeclarations('a{color:red}').css, '');
});

test('values Margin binds into CSS variables: colors and lengths, never URLs, strings or escapes', () => {
  for (const ok of ['#ffd23f', 'red', '12px', 'rgb(1 2 3 / 50%)', 'calc(100% - 4px)', 'color-mix(in srgb, red, blue)', 3, '-1.5em']) assert.equal(checkCssValue(ok), true, String(ok));
  for (const bad of ['url(https://evil.test/x)', 'u\\72l(x)', '"a"', "'x'", 'red;background:url(x)', 'image-set("x" 1x)', 'red !important', 'attr(x)', '{', 'a\nb', 'x'.repeat(300), NaN, Infinity, null, {}, 'expression(1)', 'env(x)', 'src("x")']) {
    assert.equal(checkCssValue(bad), false, String(bad));
  }
});

test('icon values: base64 data: images only', () => {
  assert.equal(checkIconUrl(pngIcon([9, 9, 9])), true);
  for (const bad of ['https://evil.test/i.png', 'javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'data:text/html;base64,PGI+', 'data:image/png;base64,@@', null, 3]) assert.equal(checkIconUrl(bad), false, String(bad));
});

test('theme.json: fields checked, unknown ones removed, fonts must be bundled woff2', () => {
  const r = checkManifest(JSON.stringify({ format: 2, id: 'x', name: 'X', version: '1.0.0', script: 'alert(1)', fonts: [{ family: 'A', file: 'fonts/a.woff2' }, { family: 'B', file: 'https://evil.test/b.woff2' }, { family: 'C"; src:url(x)', file: 'fonts/a.woff2' }] }), { files: ['fonts/a.woff2'] });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.manifest.fonts.map((f) => f.family), ['A']);
  assert.deepEqual(r.removed.map((x) => x.name).sort(), ['fonts[1]', 'fonts[2]', 'script']);
  assert.match(checkManifest('{"id":"X Y"}').errors.join(), /bad id/);
  assert.match(checkManifest('nope').errors.join(), /theme\.json/);
  const s = checkManifest(JSON.stringify({ format: 2, id: 'x', name: 'X', version: '1.0.0', settings: { accent: { type: 'color', default: 'url(https://evil.test/beacon)' }, gap: { type: 'length', default: '16px' } } }));
  assert.deepEqual(Object.keys(s.manifest.settings), ['gap'], 'a setting default is a bound CSS value: no URLs');
});

// --- Actions -----------------------------------------------------------------

test('the action list is PLAN.md §3\'s, plus palette.run and the behaviors\' and menus\' own', () => {
  const plan = ['tab.activate', 'tab.close', 'tab.new', 'tab.pin', 'tab.unpin', 'tab.moveToSpace', 'pin.open', 'folder.toggle', 'folder.new', 'space.switch', 'space.new', 'space.edit', 'today.clear', 'nav.back', 'nav.forward', 'nav.reload', 'palette.open', 'palette.close', 'sidebar.toggle', 'archive.open', 'archive.restore', 'window.close', 'window.minimise', 'window.fullscreen', 'settings.open'];
  const step2 = ['tab.move', 'tab.pinAt', 'pin.move', 'folder.newWithTab', 'folder.newWithPin', 'folder.rename', 'folder.setName', 'folder.move', 'folder.delete', 'space.rename', 'space.setName', 'space.update', 'space.delete', 'menu.open', 'menu.run', 'menu.close', 'editor.save', 'editor.cancel', 'editor.delete', 'editor.color'];
  const step3 = ['notice.run', 'notice.close', 'prompt.run', 'prompt.close', 'launcher.more'];
  const step4 = ['settings.run'];
  assert.deepEqual(Object.keys(ACTIONS).sort(), [...plan, 'palette.run', ...step2, ...step3, ...step4].sort());
  assert.ok(isAction('tab.activate'));
  assert.equal(isAction('toString'), false);
  assert.equal(isAction('__proto__'), false);
});

const mock = new MockState();
const ctx = contextFromState(mock.state);

for (const [name, action, arg] of ACTION_PAYLOADS) {
  test(`action abuse: ${name}`, () => {
    const verdict = checkAction(action, arg, ctx);
    assert.equal(verdict.ok, false);
  });
}

test('good actions pass the checks; refused ones are logged and never run', () => {
  const tab = mock.vm.space.today[0].id;
  assert.equal(checkAction('tab.activate', tab, ctx).ok, true);
  assert.equal(checkAction('space.switch', 'work', ctx).ok, true);
  assert.equal(checkAction('folder.toggle', 'personal-f0', ctx).ok, true);
  assert.equal(checkAction('today.clear', undefined, ctx).ok, true);
  assert.equal(checkAction('tab.new', 'studio', ctx).ok, true);
  assert.equal(checkAction('tab.moveToSpace', { tab, space: 'work' }, ctx).ok, true);
  assert.equal(checkAction('archive.restore', 'a1', ctx).ok, true);
  const ran = [];
  const log = [];
  const dispatch = createDispatcher({ context: () => ctx, run: (n, a) => ran.push([n, a]), log: (e) => log.push(e) });
  assert.equal(dispatch('tab.close', tab), true);
  assert.equal(dispatch('tab.close', 999999), false);
  assert.equal(dispatch('eval', 'alert(1)'), false);
  assert.deepEqual(ran, [['tab.close', tab]]);
  assert.deepEqual(log.map((e) => e.name), ['tab.close', 'eval']);
  assert.match(log[1].reason, /unknown action/);
});
