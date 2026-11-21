import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../extension/state/model.ts';
import { isAuthFlowUrl, isPeekableUrl, peekCardRect, shouldAutoPeek, siteDomain } from '../extension/shared/peek.ts';
import { buildViewModel } from '../extension/ui/view-model.ts';
import { checkAction, contextFromState } from '../extension/ui/actions.ts';
import { sanitizeTemplate } from '../extension/ui/sanitize.ts';
import { createHostedTabs, type HostedTabsApi } from '../extension/background/hosted.ts';

test('M2.5 Peek: external-domain auto-peek triggers on pinned/favorite tabs and excludes same-site and OAuth/SSO flows', () => {
  assert.equal(siteDomain('docs.github.com'), 'github.com');
  assert.equal(siteDomain('www.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(isPeekableUrl('https://example.com/page'), true);
  assert.equal(isPeekableUrl('javascript:alert(1)'), false);

  // External link from Pinned/Favorite -> Auto-Peek ON.
  assert.equal(shouldAutoPeek({
    href: 'https://linear.app/issue/123',
    currentUrl: 'https://mail.google.com/mail/u/0/#inbox',
    fromPinnedOrFav: true,
    autoPeekEnabled: true,
  }), true);

  // Same registrable domain -> normal navigation, no Auto-Peek.
  assert.equal(shouldAutoPeek({
    href: 'https://calendar.google.com/event/1',
    currentUrl: 'https://mail.google.com/mail/u/0/#inbox',
    fromPinnedOrFav: true,
    autoPeekEnabled: true,
  }), false);

  // From non-pinned Today tab -> no Auto-Peek (Shift+Click only).
  assert.equal(shouldAutoPeek({
    href: 'https://linear.app/issue/123',
    currentUrl: 'https://mail.google.com/mail/u/0/#inbox',
    fromPinnedOrFav: false,
    autoPeekEnabled: true,
  }), false);

  // Setting disabled -> no Auto-Peek.
  assert.equal(shouldAutoPeek({
    href: 'https://linear.app/issue/123',
    currentUrl: 'https://mail.google.com/mail/u/0/#inbox',
    fromPinnedOrFav: true,
    autoPeekEnabled: false,
  }), false);

  // OAuth / SSO flows are NEVER trapped in Peek.
  for (const authUrl of [
    'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc',
    'https://appleid.apple.com/auth/authorize',
    'https://acme.okta.com/app/saml',
    'https://app.example.com/login?next=/dashboard',
    'https://provider.example.com/connect?client_id=1&redirect_uri=https://app.example',
  ]) {
    assert.equal(isAuthFlowUrl(authUrl), true, authUrl);
    assert.equal(shouldAutoPeek({ href: authUrl, currentUrl: 'https://notion.so/page', fromPinnedOrFav: true, autoPeekEnabled: true }), false, authUrl);
  }
});

test('M2.5 Peek: centered modal card geometry reserves 44px chrome header and clamps cleanly', () => {
  const { card, content, headerHeight } = peekCardRect({ x: 260, y: 0, width: 1200, height: 900 });
  assert.equal(headerHeight, 44);
  assert.ok(card.width > 900 && card.width <= 1200);
  assert.ok(card.height > 700 && card.height <= 900);
  assert.equal(content.x, card.x);
  assert.equal(content.y, card.y + 44);
  assert.equal(content.height, card.height - 44);
});

test('M2.5 Peek: <m-peek> slot and peek part are guarded; view model exposes labels and actions validate', () => {
  const clean = sanitizeTemplate('<div><m-page></m-page><m-peek></m-peek><template m-part="peek"><div>Spoofed<button m-action="peek.expand">{{peek.labels.expand}}</button></div></template></div>');
  assert.equal(clean.errors.length, 0);
  assert.ok(clean.removed.some((r) => r.kind === 'text' && r.name.includes('Spoofed')), 'static text in guarded peek part is stripped');

  const s = M.defaultState();
  const vm = buildViewModel({ state: s, ui: { windowId: 1, peek: { url: 'https://stripe.com/docs', title: 'Stripe Docs', spaceId: 'personal', littleArc: true } } });
  assert.ok(vm.peek);
  assert.equal(vm.peek.host, 'stripe.com');
  assert.equal(vm.peek.littleArc, true);
  assert.equal(vm.peek.labels.expand, 'Open in Space');

  const ctx = contextFromState(s);
  for (const name of ['peek.close', 'peek.expand', 'peek.copyUrl', 'peek.back', 'peek.forward']) {
    assert.equal(checkAction(name, undefined, ctx).ok, true, name);
  }
  assert.equal(checkAction('peek.setSpace', 'personal', ctx).ok, true);
});

test('M2.5 Peek: hostedTabs.promotePeek moves the live Safari tab into the main hosted Space window', async () => {
  const movedCalls: any[] = [];
  const fakeTabs: HostedTabsApi = {
    async get(id) { return { id, windowId: 99, url: 'https://stripe.com/docs', active: true }; },
    async query() { return [{ id: 501, windowId: 99, url: 'https://stripe.com/docs', active: true }]; },
    async create({ windowId, url }) { return { id: 501, windowId, url, active: true }; },
    async update(id, props) { return { id, windowId: 1, url: props.url ?? 'https://stripe.com/docs', active: true }; },
    async move(id, props) { movedCalls.push({ id, props }); return { id, windowId: props.windowId, url: 'https://stripe.com/docs', active: true }; },
    async remove() {},
  };
  const hosted = createHostedTabs(() => fakeTabs);
  await hosted.show({ windowId: 99, itemId: 'peek-1', url: 'https://stripe.com/docs' });
  const res = await hosted.promotePeek({ fromItemId: 'peek-1', toWindowId: 1, toItemId: 't-expanded' });
  assert.equal(res.ok, true);
  assert.equal(res.moved, true);
  assert.deepEqual(movedCalls, [{ id: 501, props: { windowId: 1, index: -1 } }]);
  assert.equal(hosted.tags().get('t-expanded'), 501);
  assert.equal(hosted.tags().has('peek-1'), false);
});

test('M2.5 Peek: <m-peek-page> only in the peek part, once, empty; anywhere else it\'s removed and said', () => {
  const ok = sanitizeTemplate('<div><m-page></m-page><m-peek></m-peek><template m-part="peek"><div class="card"><div class="bar"><button m-action="peek.close" m-attr:aria-label="{{peek.labels.close}}"></button></div><m-peek-page class="peek-page"></m-peek-page></div></template></div>');
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.removed, []);
  assert.match(JSON.stringify(ok.tree), /"m-peek-page"/);
  const outside = sanitizeTemplate('<div><m-page></m-page><m-peek-page></m-peek-page><template m-part="toast"><m-peek-page></m-peek-page></template></div>');
  assert.equal(outside.removed.filter((r) => r.name === 'm-peek-page').length, 2, 'outside the peek part: removed');
  assert.doesNotMatch(JSON.stringify(outside.tree), /m-peek-page/);
  const twice = sanitizeTemplate('<div><m-page></m-page><template m-part="peek"><m-peek-page></m-peek-page><m-peek-page></m-peek-page></template></div>');
  assert.equal((JSON.stringify(twice.tree).match(/"m-peek-page"/g) ?? []).length, 1, 'one card page');
  assert.ok(twice.removed.some((r) => r.name === 'm-peek-page' && /second/.test(r.reason)));
  const filled = sanitizeTemplate('<div><m-page></m-page><template m-part="peek"><m-peek-page><span>x</span></m-peek-page></template></div>');
  assert.doesNotMatch(JSON.stringify(filled.tree), /"span"/, 'nothing inside it: the card\'s page goes there');
  const inFor = sanitizeTemplate('<div><m-page></m-page><template m-part="peek"><m-for each="space.today" as="t"><m-peek-page></m-peek-page></m-for></template></div>');
  assert.doesNotMatch(JSON.stringify(inFor.tree), /m-peek-page/, 'never in a list');
});

test('M2.5 Peek: the view model\'s card: loading until its window is in place, then ready; closing; Little Arc with no address', () => {
  const s = M.defaultState();
  const vm = (peek: any) => buildViewModel({ state: s, ui: { windowId: 1, peek } }).peek;
  const loading = vm({ url: 'https://docs.example.org/a', loading: true })!;
  assert.deepEqual([loading.loading, loading.ready, loading.closing, loading.littleArc, loading.isLittleArc, loading.host], [true, false, false, false, false, 'docs.example.org']);
  const ready = vm({ url: 'https://docs.example.org/a', loading: false })!;
  assert.deepEqual([ready.loading, ready.ready], [false, true]);
  assert.equal(vm({ url: 'https://docs.example.org/a', loading: false, closing: true })!.ready, false, 'going: covered again');
  const arc = vm({ url: '', littleArc: true, query: 'exa' })!;
  assert.deepEqual([arc.littleArc, arc.isLittleArc, arc.loading, arc.ready, arc.query, arc.host], [true, true, false, false, 'exa', '']);
  assert.equal(arc.labels.search, 'Search or enter address');
  assert.equal(vm({ url: '', loading: true })?.loading, true, 'a search on its way: its card loading with no address yet');
  assert.equal(vm({ url: '', loading: false }), null);
  assert.equal(vm(null), null);
  const ctx = contextFromState(s);
  assert.equal(checkAction('littleArc.open', undefined, ctx).ok, true);
});
