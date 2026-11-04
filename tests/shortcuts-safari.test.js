// The page's listener for the navigation keys in the Safari build
// (shared/shortcuts.js): Safari gives the focused page every ⌘ key before its
// own commands (menu key equivalents), and a page that turns ArrowDown down
// whatever the modifiers (Outlook's list, Instagram's reels) ate ⌃⌘↓, so the
// listener takes the commands' keys too, from the manifest (2026-11-04). The
// profile is the build's, read as shared/platform.js is first imported: this
// file is Safari's.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { manifestFor } = await import('../scripts/build.js');
const manifest = manifestFor('safari');
globalThis.chrome = /** @type {any} */ ({ runtime: { getURL: (path) => `safari-web-extension://test/${path}`, getManifest: () => manifest } });
const shortcuts = await import('../extension/shared/shortcuts.js');
const { platform } = await import('../extension/shared/platform.js');

// A window to listen on, and a key press as WebKit dispatches it there.
function listening({ settings = { shortcuts: {} }, answer = async () => true } = {}) {
  let listener = null;
  const sent = [];
  const target = { addEventListener: (type, fn, capture) => { if (type === 'keydown' && capture) listener = fn; } };
  const state = { settings };
  shortcuts.installNavigation({ send: (type, payload) => { sent.push({ type, ...payload }); return answer(); }, getSettings: () => state.settings, target });
  const press = (code, mods = {}) => {
    const e = { code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false, prevented: false, stopped: false, ...mods };
    e.preventDefault = () => { e.prevented = true; };
    e.stopImmediatePropagation = () => { e.stopped = true; };
    listener(e);
    return e;
  };
  return { sent, press, state };
}
const ctrlCmd = { ctrlKey: true, metaKey: true };

test('Safari: the commands\' keys come from the manifest (⌃⌘↓/↑ for tabs, ⌃⌘→ for the next space; the previous space has none there)', () => {
  assert.equal(platform.name, 'safari');
  assert.deepEqual(shortcuts.commandKeys(), { nextTab: 'Ctrl+Meta+ArrowDown', prevTab: 'Ctrl+Meta+ArrowUp', nextSpace: 'Ctrl+Meta+ArrowRight' });
  assert.equal(shortcuts.NAVIGATION.nextTab, 'Alt+Meta+ArrowDown', 'Settings say ⌥⌘↓');
});

test('Safari: ⌃⌘↓ while Settings say ⌥⌘↓ is the next tab, taken from the page (prevented, stopped), and ⌥⌘↓ still is', () => {
  const { sent, press } = listening();
  const e = press('ArrowDown', ctrlCmd);
  assert.ok(e.prevented && e.stopped, 'the page never sees it, so Safari\'s command doesn\'t fire for it either');
  assert.deepEqual(sent, [{ type: 'navigate', action: 'next-tab' }]);
  press('ArrowUp', ctrlCmd);
  press('ArrowDown', { altKey: true, metaKey: true });
  assert.deepEqual(sent.map((m) => m.action), ['next-tab', 'prev-tab', 'next-tab']);
  const plain = press('ArrowDown');
  assert.equal(plain.prevented, false, 'a bare arrow is the page\'s');
  const shifted = press('ArrowDown', { ...ctrlCmd, shiftKey: true });
  assert.equal(shifted.prevented, false, 'another combination is the page\'s');
  assert.equal(sent.length, 3);
});

test('Safari: a custom binding of ⌃⌘↓ in Settings still wins over the command\'s', () => {
  const { sent, press } = listening({ settings: { shortcuts: { nextSpace: 'Ctrl+Meta+ArrowDown' } } });
  press('ArrowDown', ctrlCmd);
  assert.deepEqual(sent.map((m) => m.action), ['next-space']);
});

test('Safari: null settings (a shortcut being recorded, Margin out of the way) pause it: the key is the page\'s, and Safari\'s command', () => {
  const { sent, press, state } = listening();
  state.settings = null;
  assert.equal(press('ArrowDown', ctrlCmd).prevented, false);
  assert.equal(sent.length, 0);
});

test('Safari: in a page found cut off from Margin (Margin.cutOff in its world) the keys pass to the page and Safari\'s commands', () => {
  const { sent, press } = listening();
  globalThis.Margin = { cutOff: true };
  try {
    assert.equal(press('ArrowDown', ctrlCmd).prevented, false);
    assert.equal(press('ArrowDown', { altKey: true, metaKey: true }).prevented, false);
    assert.equal(sent.length, 0);
  } finally {
    delete globalThis.Margin;
  }
});

test('Safari: a press whose message gets no answer in 400 ms (a world whose copy is gone, which nobody has told yet) makes the listener step aside until one is answered', async () => {
  let reply = () => new Promise(() => {}); // never arrives nor fails
  const { sent, press } = listening({ answer: () => reply() });
  assert.equal(press('ArrowDown', ctrlCmd).prevented, true, 'the first press is taken (and lost)');
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(press('ArrowDown', ctrlCmd).prevented, false, 'the next goes to the page and Safari\'s command');
  assert.equal(sent.length, 1);
  // A slow answer that comes after all (a background starting): taken again from then.
  let late = () => {};
  const { press: pressSlow } = listening({ answer: () => new Promise((resolve) => { late = () => resolve(true); }) });
  pressSlow('ArrowDown', ctrlCmd);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(pressSlow('ArrowDown', ctrlCmd).prevented, false, 'aside while unanswered');
  late();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(pressSlow('ArrowDown', ctrlCmd).prevented, true, 'answered: taken again');
  reply = async () => true;
});
