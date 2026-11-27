// Safari drawing a page shrunk to fit its window (content/page-scale.ts): told to Margin.app's log when it starts and
// when it ends, with the sizes; a magnified page (a pinch) and an unchanged one never told; nothing while Margin.app
// doesn't draw around the window, and told once it does (a reload of a page already shrunk).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPageScale } from '../extension/content/page-scale.ts';

function page(scale = 1) {
  const handlers: Record<string, (() => void)[]> = {};
  const add = (prefix: string) => (type: string, fn: () => void) => { (handlers[prefix + type] ??= []).push(fn); };
  const remove = (prefix: string) => (type: string, fn: () => void) => { handlers[prefix + type] = (handlers[prefix + type] ?? []).filter((f) => f !== fn); };
  const win = {
    innerWidth: 1212, outerWidth: 1212, devicePixelRatio: 2,
    visualViewport: { scale, addEventListener: add('vv:'), removeEventListener: remove('vv:') },
    addEventListener: add(''), removeEventListener: remove(''),
    document: { visibilityState: 'visible', addEventListener: add('doc:') },
  };
  const fire = (key: string) => { for (const fn of handlers[key] ?? []) fn(); };
  // Laid out `width` wide in a 1212 pt window: Safari's shrink to fit, the pixel ratio with it.
  const layout = (width: number) => {
    const s = Math.min(1, 1212 / width);
    Object.assign(win, { innerWidth: width, outerWidth: width, devicePixelRatio: 2 * s });
    win.visualViewport.scale = s;
  };
  return { win, fire, layout };
}

test('page scale: shrunk to fit told once as it starts and once as it ends, with the sizes', () => {
  const { win, fire, layout } = page();
  const said: [string, Record<string, unknown>][] = [];
  startPageScale({ on: () => true, send: (type, payload) => said.push([type, payload]), win });
  assert.deepEqual(said, [], 'whole: nothing');
  layout(1392);
  fire('vv:resize');
  fire('resize');
  assert.deepEqual(said, [['pageScale', { n: 1, scale: 0.871, inner: 1392, outer: 1392, dpr: 1.741, shown: true }]], 'shrunk: told once, the real Mac\'s numbers');
  layout(1392);
  fire('resize');
  assert.equal(said.length, 1, 'still shrunk: not told again');
  layout(1212);
  fire('resize');
  assert.deepEqual(said.at(-1), ['pageScale', { n: 2, scale: 1, inner: 1212, outer: 1212, dpr: 2, shown: true }], 'whole again: told');
  win.visualViewport.scale = 2.5;
  fire('vv:resize');
  assert.equal(said.length, 2, 'a pinch magnifies: never told');
});

test('page scale: nothing while Margin.app doesn\'t draw around the window; a page already shrunk told once it does', () => {
  const { win, fire } = page(0.871);
  const said: [string, Record<string, unknown>][] = [];
  let on = false;
  const watcher = startPageScale({ on: () => on, send: (type, payload) => said.push([type, payload]), win });
  fire('resize');
  assert.deepEqual(said, [], 'not drawn: nothing');
  on = true;
  win.document.visibilityState = 'hidden';
  watcher.check();
  assert.equal(said.length, 1, 'the link known: told');
  assert.equal((said[0] as [string, Record<string, unknown>])[1].shown, false, 'with whether it\'s shown');
});

// Margin.app's relay after a drag (HostEngine relayNarrowed) asking the page how Safari lays it out: now; once whole;
// once whole and laid out narrower than a width; answered only after the frame that draws it; by its deadline at the
// latest, `met: false`.
function framed(scale = 1) {
  const p = page(scale);
  const frames: (() => void)[] = [];
  Object.assign(p.win, {
    requestAnimationFrame: (fn: () => void) => { frames.push(fn); return frames.length; },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
  });
  // One frame drawn: the callbacks asked before it run (any they ask, the next frame's).
  const frame = () => { for (const fn of frames.splice(0)) fn(); };
  return { ...p, frame };
}
const settled = async <T>(promise: Promise<T>) => {
  let value: T | undefined;
  let done = false;
  void promise.then((v) => { value = v; done = true; });
  await new Promise((r) => setImmediate(r));
  return { done, value };
};

test('page layout: asked with nothing to wait for, answered now with its scale and layout width', async () => {
  const { win } = framed(0.871);
  win.innerWidth = 1392;
  const watcher = startPageScale({ on: () => true, send: () => {}, win });
  assert.deepEqual(await watcher.layout({}), { scale: 0.871, inner: 1392, met: true });
});

test('page layout: once whole, answered after the frame that draws it; a resize that undoes it keeps it waiting', async () => {
  const { win, fire, layout, frame } = framed(0.871);
  win.innerWidth = 1392;
  const watcher = startPageScale({ on: () => true, send: () => {}, win });
  const asked = watcher.layout({ whole: true, deadline: Date.now() + 5000 });
  assert.equal((await settled(asked)).done, false, 'shrunk: waiting');
  layout(1212); // (its window as wide as its layout: whole)
  fire('vv:resize');
  frame();
  assert.equal((await settled(asked)).done, false, 'whole, its frame not drawn yet');
  layout(1392);
  fire('resize');
  frame();
  assert.equal((await settled(asked)).done, false, 'shrunk again before it was drawn: still waiting');
  layout(1212);
  fire('resize');
  frame();
  frame();
  assert.deepEqual((await settled(asked)).value, { scale: 1, inner: 1212, met: true });
});

test('page layout: whole and laid out narrower than a width; its deadline answers as it is, not met', async () => {
  const { win, fire, frame } = framed(1);
  win.innerWidth = 1398;
  const watcher = startPageScale({ on: () => true, send: () => {}, win });
  const asked = watcher.layout({ whole: true, below: 1397.5, deadline: Date.now() + 5000 });
  frame();
  frame();
  assert.equal((await settled(asked)).done, false, 'whole but still at the wider width: waiting');
  win.innerWidth = 1202;
  fire('resize');
  frame();
  frame();
  assert.deepEqual((await settled(asked)).value, { scale: 1, inner: 1202, met: true });
  const late = await watcher.layout({ whole: true, below: 1000, deadline: Date.now() + 20 });
  assert.deepEqual(late, { scale: 1, inner: 1202, met: false }, 'never met: answered at its deadline');
});
