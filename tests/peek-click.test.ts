// The preview's link clicks (content/peek.ts), the page's side, against a stand-in window and links: only in a window Margin
// draws, in the bubble phase after the page's own handlers, never stopping the event; the link's own default done when
// the app refuses or doesn't answer in time. And the copy's side (background/peek.ts): the app's answer waited for
// until the click's time only. And the card window's keys (Esc, ⌘↩) only where the page didn't handle them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PEEK_ANSWER_MS, startCardKeys, startPeek, type PeekLink } from '../extension/content/peek.ts';
import { createPeekAnswers } from '../extension/background/peek.ts';

const PAGE = 'https://mail.example.com/inbox';
function stand() {
  const listeners: { type: string, fn: (e: any) => void, capture: boolean }[] = [];
  const win = {
    addEventListener(type: string, fn: (e: any) => void, capture = false) { listeners.push({ type, fn, capture: !!capture }); },
    removeEventListener(type: string, fn: (e: any) => void) { const i = listeners.findIndex((l) => l.type === type && l.fn === fn); if (i >= 0) listeners.splice(i, 1); },
  };
  return { win, listeners, fire: (type: string, e: any) => { for (const l of [...listeners]) if (l.type === type) l.fn(e); } };
}
function anchor(href: string, attrs: Record<string, string> = {}) {
  return {
    nodeType: 1, localName: 'a', href,
    hasAttribute: (n: string) => n === 'href' || n in attrs,
    getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
  };
}
function click(link: any, mods: Partial<{ shiftKey: boolean, metaKey: boolean, ctrlKey: boolean, altKey: boolean, button: number, defaultPrevented: boolean, isTrusted: boolean }> = {}) {
  const inner = { nodeType: 1, localName: 'span', hasAttribute: () => false };
  const e: any = {
    isTrusted: true, button: 0, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, defaultPrevented: false, ...mods,
    stopped: 0, prevented: 0,
    composedPath: () => [inner, link, { nodeType: 1, localName: 'body', hasAttribute: () => false }],
    preventDefault() { e.prevented++; e.defaultPrevented = true; },
    stopPropagation() { e.stopped++; },
    stopImmediatePropagation() { e.stopped++; },
  };
  return e;
}
const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup({ drawn = true, pinned = false, auto = true, answer = (async () => true) as (url: string, source: string, newTab: boolean) => Promise<unknown>, timeoutMs = 60 } = {}) {
  const s = stand();
  const asked: string[] = [];
  const fell: PeekLink[] = [];
  const state = { drawn, pinned };
  const peek = startPeek({
    win: s.win, currentUrl: () => PAGE, isDrawn: () => state.drawn, isPinnedOrFav: () => state.pinned, autoPeekEnabled: () => auto,
    ask: (url, source, newTab) => { asked.push(`${source} ${url}${newTab ? ' new-tab' : ''}`); return answer(url, source, newTab); },
    fallback: (l) => fell.push(l), timeoutMs,
  });
  return { ...s, asked, fell, state, peek };
}

test('Preview click: heard in the bubble phase on the window (after the page), never in the capture phase', () => {
  const s = setup();
  assert.deepEqual(s.listeners.map((l) => [l.type, l.capture]), [['click', false]]);
  s.peek.destroy();
  assert.equal(s.listeners.length, 0);
});

test('Preview click: Shift+click on a link asks for the card and cancels the default, but never stops the event', async () => {
  const s = setup();
  const e = click(anchor('https://docs.example.org/a'), { shiftKey: true });
  s.fire('click', e);
  assert.deepEqual(s.asked, ['shift-click https://docs.example.org/a']);
  assert.equal(e.prevented, 1, 'its default cancelled at once (it can\'t be later)');
  assert.equal(e.stopped, 0, 'the page\'s other listeners still hear it');
  await later(80);
  assert.deepEqual(s.fell, [], 'the app took it: nothing else opened');
});

test('Preview click: a click the page handled itself (defaultPrevented) is left alone, as are ⌘/⌃/⌥ clicks, other buttons and untrusted ones', () => {
  const s = setup({ pinned: true });
  const link = anchor('https://other.example.net/');
  for (const mods of [{ defaultPrevented: true, shiftKey: true }, { defaultPrevented: true }, { metaKey: true, shiftKey: true }, { ctrlKey: true }, { altKey: true, shiftKey: true }, { button: 1, shiftKey: true }, { isTrusted: false, shiftKey: true }]) {
    const e = click(link, mods);
    s.fire('click', e);
    assert.equal(e.stopped, 0);
    assert.equal(mods.defaultPrevented ? e.prevented : e.prevented, 0, JSON.stringify(mods));
  }
  assert.deepEqual(s.asked, []);
});

test('Preview click: nothing intercepted in a window Margin doesn\'t draw (or a dormant copy: isDrawn false)', () => {
  const s = setup({ drawn: false, pinned: true });
  const e = click(anchor('https://docs.example.org/a'), { shiftKey: true });
  s.fire('click', e);
  const f = click(anchor('https://other.example.net/'));
  s.fire('click', f);
  assert.deepEqual(s.asked, []);
  assert.equal(e.prevented + f.prevented, 0, 'the browser does what it always does');
});

test('Preview click: auto-preview only from a pinned tab or favorite, to another site, never an auth flow; a download or a same-page anchor never', () => {
  const s = setup({ pinned: false });
  s.fire('click', click(anchor('https://other.example.net/')));
  assert.deepEqual(s.asked, [], 'not pinned: a plain click is the page\'s');
  s.state.pinned = true;
  s.fire('click', click(anchor('https://calendar.example.com/x')));
  assert.deepEqual(s.asked, [], 'the same site: navigates as usual');
  s.fire('click', click(anchor('https://accounts.google.com/o/oauth2/v2/auth?client_id=1')));
  assert.deepEqual(s.asked, [], 'an auth flow is never trapped in a card');
  s.fire('click', click(anchor('https://other.example.net/file.zip', { download: '' }), { shiftKey: true }));
  s.fire('click', click(anchor(`${PAGE}#section`), { shiftKey: true }));
  s.fire('click', click(anchor('mailto:a@example.com'), { shiftKey: true }));
  assert.deepEqual(s.asked, []);
  s.fire('click', click(anchor('https://other.example.net/')));
  assert.deepEqual(s.asked, ['auto-peek https://other.example.net/']);
});

test('Preview click: refused by the app: the link opens as the page would have had it, in the same tab or a new one for target=_blank', async () => {
  const s = setup({ answer: async () => false });
  s.fire('click', click(anchor('https://docs.example.org/a'), { shiftKey: true }));
  s.fire('click', click(anchor('https://docs.example.org/b', { target: '_blank' }), { shiftKey: true }));
  s.fire('click', click(anchor('https://docs.example.org/c', { target: '_self' }), { shiftKey: true }));
  await later(10);
  assert.deepEqual(s.fell.map((l) => [l.url, l.newTab]), [['https://docs.example.org/a', false], ['https://docs.example.org/b', true], ['https://docs.example.org/c', false]]);
  assert.deepEqual(s.asked[1], 'shift-click https://docs.example.org/b new-tab');
});

test('Preview click: no answer in time: the link opens anyway, once (a late yes changes nothing); a failed ask too', async () => {
  let late: (v: unknown) => void = () => {};
  const s = setup({ answer: () => new Promise((r) => { late = r; }), timeoutMs: 30 });
  s.fire('click', click(anchor('https://docs.example.org/a'), { shiftKey: true }));
  await later(50);
  assert.equal(s.fell.length, 1);
  late(true);
  await later(5);
  assert.equal(s.fell.length, 1, 'never twice');
  const t = setup({ answer: async () => { throw new Error('no background'); } });
  t.fire('click', click(anchor('https://docs.example.org/a'), { shiftKey: true }));
  await later(5);
  assert.equal(t.fell.length, 1);
  assert.equal(PEEK_ANSWER_MS, 400);
});

test('Preview click: the copy waits for the app\'s answer until the click\'s time only (then no), a late answer is refused', async () => {
  let clock = 1000;
  const timers: (() => void)[] = [];
  const answers = createPeekAnswers({ now: () => clock, later: (fn) => { timers.push(fn); return timers.length; }, cancel: () => {} });
  const a = answers.id(), b = answers.id();
  assert.notEqual(a, b);
  const pa = answers.wait(a, 1300);
  const pb = answers.wait(b, 1300);
  assert.equal(answers.answer(a, true), true);
  assert.equal(await pa, true);
  clock = 1301;
  for (const t of timers) t();
  assert.equal(await pb, null, 'no answer by its time: a no (the app is told to drop it)');
  assert.equal(answers.answer(b, true), false, 'too late: the page opened the link itself');
  assert.equal(answers.answer('nope', true), false);
  assert.equal(answers.pending(), 0);
});

test('Preview card keys: only in the card\'s window, only what the page didn\'t handle, never in a field', () => {
  const s = stand();
  const sent: string[] = [];
  let focused: any = { localName: 'body' };
  const keys = startCardKeys({ win: s.win, active: () => focused, send: (k) => sent.push(k) });
  const key = (k: string, mods: Record<string, unknown> = {}) => { const e: any = { isTrusted: true, key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false, target: { localName: 'div' }, ...mods, preventDefault() { e.defaultPrevented = true; } }; s.fire('keydown', e); return e; };
  key('Escape');
  assert.deepEqual(sent, [], 'not a card window: nothing listens');
  keys.set(true);
  assert.deepEqual(s.listeners.map((l) => [l.type, l.capture]), [['keydown', false]]);
  key('Escape', { defaultPrevented: true });
  key('Escape', { target: { localName: 'input' } });
  focused = { localName: 'div', isContentEditable: true };
  key('Escape');
  focused = { localName: 'body' };
  key('Escape', { repeat: true });
  key('Enter');
  assert.deepEqual(sent, []);
  const esc = key('Escape');
  key('Enter', { metaKey: true });
  assert.deepEqual(sent, ['close', 'expand']);
  assert.equal(esc.defaultPrevented, true);
  keys.set(false);
  assert.equal(s.listeners.length, 0);
});
