// Esc in a page Margin.app hosts (content/keep-fullscreen.ts): an Escape the page left alone has its default
// prevented in a window Margin.app draws, so Safari doesn't take that window out of full screen; the page's own Esc
// (its handlers, a field's, a dialog's, a popover's, a video's full screen), Peek's card's Esc and every other key work
// as before. The same rules in real engines (the DOM's own dispatch order): tests/theme/keep-fullscreen.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startKeepFullscreen } from '../extension/content/keep-fullscreen.ts';
import { startCardKeys } from '../extension/content/peek.ts';

// A window as the DOM dispatches on it: its capture listeners (a copy of the list as the event reaches it), the
// page's handlers below it, then its bubble listeners (a copy taken then: one added meanwhile runs, last).
function stand() {
  const listeners: { type: string, fn: (e: any) => void, capture: boolean }[] = [];
  const win = {
    addEventListener(type: string, fn: (e: any) => void, capture = false) { listeners.push({ type, fn, capture: !!capture }); },
    removeEventListener(type: string, fn: (e: any) => void, capture = false) {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === !!capture);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  const dispatch = (e: any, below: ((e: any) => void)[] = []) => {
    for (const l of listeners.filter((x) => x.type === e.type && x.capture)) if (listeners.includes(l)) l.fn(e);
    for (const fn of below) { if (e.stopped) return e; fn(e); }
    if (e.stopped) return e;
    for (const l of listeners.filter((x) => x.type === e.type && !x.capture)) if (listeners.includes(l)) l.fn(e);
    return e;
  };
  return { win, listeners, dispatch };
}
function key(k: string, extra: Record<string, unknown> = {}) {
  const e: any = {
    type: 'keydown', key: k, isTrusted: true, isComposing: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
    defaultPrevented: false, stopped: false, target: { localName: 'div' }, ...extra,
    preventDefault() { e.defaultPrevented = true; },
    stopPropagation() { e.stopped = true; },
    composedPath() { return [e.target, { localName: 'body' }]; },
  };
  return e;
}

test('keep full screen: an Escape the page left alone, in a window Margin.app draws: its default prevented (Safari keeps full screen)', () => {
  const s = stand();
  let drawn = true;
  const guard = startKeepFullscreen({ win: s.win, doc: () => ({}), isDrawn: () => drawn });
  assert.deepEqual(s.listeners.map((l) => [l.type, l.capture]), [['keydown', true]], 'one capture listener, nothing per frame');
  assert.equal(s.dispatch(key('Escape')).defaultPrevented, true);
  assert.equal(s.listeners.length, 1, 'its last-word listener gone with the key');
  drawn = false;
  assert.equal(s.dispatch(key('Escape')).defaultPrevented, false, 'a window Margin.app doesn\'t draw: Safari\'s own Esc');
  drawn = true;
  for (const mod of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey']) assert.equal(s.dispatch(key('Escape', { [mod]: true })).defaultPrevented, false, `${mod}: another key`);
  assert.equal(s.dispatch(key('Escape', { isComposing: true })).defaultPrevented, false, 'an input method\'s Esc cancels what\'s composed');
  assert.equal(s.dispatch(key('Escape', { isTrusted: false })).defaultPrevented, false, 'a page\'s own synthetic key');
  for (const k of ['a', 'Enter', 'Tab', 'ArrowDown']) assert.equal(s.dispatch(key(k)).defaultPrevented, false, `${k}: untouched`);
  guard.destroy();
  assert.equal(s.listeners.length, 0);
  assert.equal(s.dispatch(key('Escape')).defaultPrevented, false, 'stopped: nothing');
});

test('keep full screen: the page\'s own Esc first: its window listeners (registered before or after) hear it unhandled; handled, or stopped, it\'s left alone', () => {
  const s = stand();
  const heard: string[] = [];
  s.win.addEventListener('keydown', (e) => heard.push(`before ${e.defaultPrevented}`));
  startKeepFullscreen({ win: s.win, doc: () => ({}), isDrawn: () => true });
  s.win.addEventListener('keydown', (e) => heard.push(`after ${e.defaultPrevented}`));
  const e = s.dispatch(key('Escape'));
  assert.deepEqual(heard, ['before false', 'after false'], 'every page listener sees the key as the page would have');
  assert.equal(e.defaultPrevented, true, 'then prevented, last');
  // The page handled it (a menu closing): nothing more.
  const handled = s.dispatch(key('Escape'), [(ev) => ev.preventDefault()]);
  assert.equal(handled.defaultPrevented, true);
  // The page stopped it: never decided, and the listener left for it never acts on the next key.
  const stopped = s.dispatch(key('Escape'), [(ev) => ev.stopPropagation()]);
  assert.equal(stopped.defaultPrevented, false, 'stopped by the page: its own');
  const next = s.dispatch(key('a'));
  assert.equal(next.defaultPrevented, false, 'the next key isn\'t touched');
  assert.equal(s.listeners.filter((l) => !l.capture).length, 2, 'only the page\'s own bubble listeners left');
});

test('keep full screen: an element in full screen (a video), a search field, a modal dialog or an open popover keep the engine\'s own Esc', () => {
  const s = stand();
  let doc: any = {};
  startKeepFullscreen({ win: s.win, doc: () => doc, isDrawn: () => true });
  doc = { fullscreenElement: { localName: 'video' } };
  assert.equal(s.dispatch(key('Escape')).defaultPrevented, false, 'a video in full screen: Esc leaves it');
  doc = { webkitFullscreenElement: { localName: 'div' } };
  assert.equal(s.dispatch(key('Escape')).defaultPrevented, false, 'WebKit\'s own name for it');
  doc = { webkitCurrentFullScreenElement: { localName: 'div' } };
  assert.equal(s.dispatch(key('Escape')).defaultPrevented, false);
  doc = {};
  assert.equal(s.dispatch(key('Escape', { target: { localName: 'input', type: 'search' } })).defaultPrevented, false, 'a search field clears');
  assert.equal(s.dispatch(key('Escape', { target: { localName: 'input', type: 'text' } })).defaultPrevented, true, 'a text field has no Esc of its own: Safari\'s would leave full screen');
  doc = { querySelector: (q: string) => (q === 'dialog:modal' ? { localName: 'dialog' } : null) };
  assert.equal(s.dispatch(key('Escape')).defaultPrevented, false, 'a modal dialog closes');
  doc = { querySelector: (q: string) => { if (q === 'dialog:modal') throw new Error('not known'); return q === ':popover-open' ? {} : null; } };
  assert.equal(s.dispatch(key('Escape')).defaultPrevented, false, 'an open popover closes (an unknown selector is none)');
  doc = { querySelector: () => null };
  assert.equal(s.dispatch(key('Escape')).defaultPrevented, true);
});

test('keep full screen: Peek\'s card still closes on Esc (its listener first), and an Esc it leaves (in a field) is kept from Safari', () => {
  const s = stand();
  const sent: string[] = [];
  let focused: any = { localName: 'body' };
  startKeepFullscreen({ win: s.win, doc: () => ({}), isDrawn: () => true });
  const card = startCardKeys({ win: s.win, active: () => focused, send: (k) => sent.push(k) });
  card.set(true); // (the copy says so after the page started: its listener is added after this one's)
  const esc = s.dispatch(key('Escape'));
  assert.deepEqual(sent, ['close'], 'the card closes');
  assert.equal(esc.defaultPrevented, true);
  focused = { localName: 'input' };
  const inField = s.dispatch(key('Escape', { target: { localName: 'input', type: 'text' } }));
  assert.deepEqual(sent, ['close'], 'in a field: not closed');
  assert.equal(inField.defaultPrevented, true, 'and not Safari\'s either');
});

test('keep full screen: the page core starts it in every page, with Peek\'s rule for the windows Margin.app draws', async () => {
  const { readFile } = await import('node:fs/promises');
  const core = await readFile(new URL('../extension/content/core.ts', import.meta.url), 'utf8');
  assert.match(core, /startKeepFullscreen\(\{ isDrawn: drawnHere \}\)/, 'started by the page core');
  assert.match(core, /startPeek\(\{\s*isDrawn: drawnHere,/, 'the same windows as Peek\'s clicks (main\'s, a card\'s, a pane\'s)');
  assert.ok(core.indexOf('startKeepFullscreen({') > core.indexOf('const cardKeys = startCardKeys('), 'after the card\'s keys');
});
