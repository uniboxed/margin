import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../extension/shared/shell-logic.js';

const { skipReason, loopCheck, doctypeString, serialize, postFields, isBust, routable, excludePatterns, LOOP } = globalThis.Margin.shellLogic;

const fresh = {
  enabled: true, isTop: true, isHtml: true, contentType: 'text/html', charset: 'UTF-8', ready: 'loading', kids: [],
  navigationApi: true, hasOpener: false, origin: 'https://a.com', crossOriginIsolated: false, optedOut: false,
};

test('a fresh HTML load before parsing is fitted', () => {
  assert.equal(skipReason(fresh), null);
  // Other content scripts' nodes (and Margin's own hosts) don't count as parsing.
  assert.equal(skipReason({ ...fresh, kids: ['MARGIN-SIDEBAR-HOST', 'STYLE'] }), null);
  assert.equal(skipReason({ ...fresh, charset: 'utf-8' }), null);
  // HTML 4.01 Transitional without a system id is plain quirks (compatMode), with one standards-like: fitted.
  assert.equal(skipReason({ ...fresh, doctype: { publicId: '-//W3C//DTD HTML 4.01//EN', systemId: 'http://www.w3.org/TR/html4/strict.dtd' } }), null);
  assert.equal(skipReason({ ...fresh, doctype: { publicId: '-//W3C//DTD XHTML 1.0 Strict//EN', systemId: '' } }), null);
});

test('loads that can\'t be fitted say why', () => {
  const cases = [
    [{ enabled: false }, /browser/],
    [{ isTop: false }, /top frame/],
    [{ contentType: 'application/pdf' }, /not an HTML page/],
    [{ isHtml: false }, /not an HTML page/],
    [{ charset: 'Shift_JIS' }, /encoding/],
    [{ ready: 'interactive' }, /after the page loaded/],
    [{ kids: ['HEAD'] }, /after parsing started/],
    [{ kids: ['#comment'] }, /after parsing started/],
    [{ kids: ['FRAMESET'] }, /after parsing started/],
    [{ navigationApi: false }, /Navigation API/],
    [{ hasOpener: true }, /popup/],
    [{ origin: 'null' }, /sandboxed/],
    [{ crossOriginIsolated: true }, /isolated/],
    [{ compatMode: 'BackCompat' }, /quirks/],
    [{ doctype: { publicId: '-//W3C//DTD XHTML 1.0 Transitional//EN', systemId: 'http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd' } }, /quirks/],
    [{ doctype: { publicId: '-//W3C//DTD HTML 4.01 Frameset//EN', systemId: 'http://www.w3.org/TR/html4/frameset.dtd' } }, /quirks/],
    [{ optedOut: true }, /turned off/],
  ];
  for (const [change, why] of cases) assert.match(skipReason({ ...fresh, ...change }) ?? '', why, JSON.stringify(change));
});

test('the loop breaker trips on the third build within the window', () => {
  let r = loopCheck(null, 1000);
  assert.deepEqual(r, { times: [1000], tooMany: false });
  r = loopCheck(r.times, 2000);
  assert.equal(r.tooMany, false);
  r = loopCheck(r.times, 3000);
  assert.equal(r.tooMany, true);
  assert.equal(loopCheck([1000, 2000], 1000 + LOOP.windowMs + 1).tooMany, false, 'old builds expire');
  assert.equal(loopCheck('junk', 5).tooMany, false);
});

test('the page keeps its own doctype', () => {
  assert.equal(doctypeString({ name: 'html', publicId: '', systemId: '' }), '<!DOCTYPE html>');
  assert.equal(doctypeString(null), '');
  assert.equal(
    doctypeString({ name: 'html', publicId: '-//W3C//DTD HTML 4.01 Transitional//EN', systemId: 'http://www.w3.org/TR/html4/loose.dtd' }),
    '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">',
  );
  assert.equal(doctypeString({ name: 'html', publicId: '', systemId: 'about:legacy-compat' }), '<!DOCTYPE html SYSTEM "about:legacy-compat">');
});

test('serialization escapes <html> attributes', () => {
  assert.equal(
    serialize({ doctype: '<!DOCTYPE html>', attrs: [['lang', 'en'], ['data-x', 'a "b" & c']], inner: '<head></head><body>hi</body>' }),
    '<!DOCTYPE html><html lang="en" data-x="a &quot;b&quot; &amp; c"><head></head><body>hi</body></html>',
  );
  assert.equal(serialize({}), '<html></html>');
});

test('POSTs are rebuilt with text-like input types, files included', () => {
  const types = { user: 'email', pass: 'password', remember: 'checkbox', csrf: 'hidden' };
  assert.deepEqual(postFields([['user', 'a@b.c'], ['pass', 's3cret'], ['remember', 'on'], ['csrf', 'x']], (n) => types[n]), [
    { name: 'user', value: 'a@b.c', type: 'email' },
    { name: 'pass', value: 's3cret', type: 'password' },
    { name: 'remember', value: 'on', type: 'hidden' },
    { name: 'csrf', value: 'x', type: 'hidden' },
  ]);
  assert.deepEqual(postFields([['q', '1']]), [{ name: 'q', value: '1', type: 'hidden' }]);
  const file = { name: 'a.png', size: 3 };
  assert.deepEqual(postFields([['title', 'x'], ['file', file]]), [{ name: 'title', value: 'x', type: 'hidden' }, { name: 'file', file, type: 'file' }]);
});

test('frame busting is a script navigation of the top to the same page', () => {
  assert.equal(isBust({ destination: 'https://a.com/x', current: 'https://a.com/x', type: 'push' }), true);
  assert.equal(isBust({ destination: 'https://a.com/x#top', current: 'https://a.com/x', type: 'replace' }), true);
  assert.equal(isBust({ destination: 'https://a.com/y', current: 'https://a.com/x', type: 'push' }), false);
  assert.equal(isBust({ destination: 'https://a.com/x', current: 'https://a.com/x', type: 'reload' }), false);
  assert.equal(isBust({ destination: 'https://a.com/x', current: 'https://a.com/x', type: 'traverse' }), false);
});

test('only web links are redone at the top', () => {
  assert.equal(routable('https://a.com/'), true);
  assert.equal(routable('HTTP://a.com/'), true);
  for (const url of ['mailto:a@b.c', 'tel:123', 'javascript:void(0)', 'zoommtg://x', 'blob:https://a.com/1']) assert.equal(routable(url), false, url);
});

test('per-site opt-outs become exclude patterns', () => {
  assert.deepEqual(excludePatterns(['https://a.com', 'http://b.org:8080', 'https://a.com', 'file:///x', 'junk']), ['https://a.com/*', 'http://b.org/*']);
  assert.deepEqual(excludePatterns(undefined), []);
});

const { cardNavigatingClick, reportKey, getSubmissionUrl, topOnly } = globalThis.Margin.shellLogic;

test('only plain clicks that navigate the card itself are redone at the top', () => {
  const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, download: false, target: '' };
  assert.equal(cardNavigatingClick(click), true);
  assert.equal(cardNavigatingClick({ ...click, target: null }), true);
  assert.equal(cardNavigatingClick({ ...click, target: '_SELF' }), true);
  for (const change of [{ button: 1 }, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { download: true }, { target: '_blank' }, { target: '_top' }, { target: 'named' }]) {
    assert.equal(cardNavigatingClick({ ...click, ...change }), false, JSON.stringify(change));
  }
});

test('refused URLs are matched the way WebKit reports them for frame-src', () => {
  const origin = 'https://github.com';
  assert.equal(reportKey('https://github.com/a/b?x=1#diff-1', origin), 'https://github.com/a/b?x=1', 'own origin: no fragment');
  assert.equal(reportKey('https://u:p@github.com/a', origin), 'https://github.com/a', 'no credentials');
  assert.equal(reportKey('https://docs.github.com/en/x#y', origin), 'https://docs.github.com', 'another origin: origin only');
  assert.equal(reportKey('blob:https://github.com/123', origin), 'blob');
  assert.equal(reportKey('data:text/plain,x', origin), 'data');
  assert.equal(reportKey('not a url', origin), '');
});

test('GET submissions replace the query with the form data', () => {
  assert.equal(getSubmissionUrl('https://a.com/s?old=1#top', [['q', 'a b'], ['f', { name: 'x.png' }]]), 'https://a.com/s?q=a+b&f=x.png#top');
  assert.equal(getSubmissionUrl('https://a.com/s', [['t', 'one\ntwo\r\nthree\rfour']]), 'https://a.com/s?t=one%0D%0Atwo%0D%0Athree%0D%0Afour');
  assert.equal(topOnly('data:text/html,x'), true);
  assert.equal(topOnly('https://a.com'), false);
});
