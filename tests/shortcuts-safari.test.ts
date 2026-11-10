// The page's listener for the navigation keys in the Safari build
// (shared/shortcuts.ts): Safari gives the focused page every ⌘ key before its
// own commands (menu key equivalents), and a page that turns ArrowDown down
// whatever the modifiers (Outlook's list, Instagram's reels) ate ⌃⌘↓, so the
// listener takes the commands' keys too, from the manifest (2026-11-04). The
// profile is the build's, read as shared/capabilities.ts is first imported: this
// file is Safari's.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { manifestFor } = await import('../scripts/build.ts');
// The shipped manifest's navigation commands have no keys now (Tirth, 2026-11-08: no ⌃⌘ arrows; the last test
// here). The listener still takes whatever keys a manifest's commands have, tested with the ⌃⌘ ones they had.
const shipped = manifestFor('safari');
const withKeys = (mac: string) => ({ suggested_key: { default: 'Alt+Shift+Down', mac } });
const manifest = { ...shipped, commands: { ...shipped.commands,
  'next-tab': { ...shipped.commands['next-tab'], ...withKeys('MacCtrl+Command+Down') },
  'prev-tab': { ...shipped.commands['prev-tab'], ...withKeys('MacCtrl+Command+Up') },
  'next-space': { ...shipped.commands['next-space'], ...withKeys('MacCtrl+Command+Right') } } };
globalThis.chrome = ({ runtime: { getURL: (path) => `safari-web-extension://test/${path}`, getManifest: () => manifest } } as any);
const shortcuts = await import('../extension/shared/shortcuts.ts');
const { capabilities } = await import('../extension/shared/capabilities.ts');

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
  assert.equal(capabilities.name, 'safari');
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

test('Safari: in a page found cut off from Margin (Margin.cutOff in its world) the keys pass: the commands\' keys on to Safari\'s commands, kept from the page\'s own listeners; the Settings keys to the page', () => {
  const { sent, press } = listening();
  globalThis.Margin = { cutOff: true };
  try {
    const command = press('ArrowDown', ctrlCmd);
    assert.equal(command.prevented, false, 'not turned down: WebKit gives it to the menu, where the copy running now answers it');
    assert.equal(command.stopped, true, 'and the page (Outlook, Instagram) never sees it to eat it');
    const own = press('ArrowDown', { altKey: true, metaKey: true });
    assert.equal(own.prevented, false);
    assert.equal(own.stopped, false, 'a Settings key has no command: the page\'s');
    assert.equal(sent.length, 0);
  } finally {
    delete globalThis.Margin;
  }
});

test('Safari: a ⌃⌘ arrow that Settings give to the sidebar is left to it, not taken for the command', () => {
  const { sent, press } = listening({ settings: { shortcuts: {}, sidebarShortcut: 'Ctrl+Meta+ArrowDown' } });
  const e = press('ArrowDown', ctrlCmd);
  assert.equal(e.prevented, false);
  assert.equal(e.stopped, false);
  assert.equal(sent.length, 0);
  press('ArrowUp', ctrlCmd);
  assert.deepEqual(sent.map((m) => m.action), ['prev-tab']);
});

// The world's storage, as worldAlive reads it: `answer` false never answers (a
// world whose copy is gone).
function storage(answers: boolean) {
  globalThis.chrome.storage = { local: { get: () => (answers ? Promise.resolve({}) : new Promise(() => {})) } };
}
const after = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('Safari: a press with no answer in 400 ms, in a world whose storage doesn\'t answer either (its copy gone, nobody has told it yet), makes the listener step aside, and it stays aside while the world is dead', async () => {
  storage(false);
  try {
    const { sent, press } = listening({ answer: () => new Promise(() => {}) }); // neither arrives nor fails
    assert.equal(press('ArrowDown', ctrlCmd).prevented, true, 'the first press is taken (and lost)');
    await after(650);
    const next = press('ArrowDown', ctrlCmd);
    assert.equal(next.prevented, false, 'the next goes on to Safari\'s command');
    assert.equal(next.stopped, true);
    await after(250);
    assert.equal(press('ArrowDown', { altKey: true, metaKey: true }).prevented, false, 'asked again: still dead');
    assert.equal(sent.length, 1);
  } finally {
    delete globalThis.chrome.storage;
  }
});

test('Safari: a slow but live background (a cold start) never makes the listener step aside: a second press while the first is unanswered is taken and sent', async () => {
  storage(true);
  try {
    let n = 0;
    const { sent, press } = listening({ answer: () => (++n === 1 ? after(700).then(() => true) : Promise.resolve(true)) });
    press('ArrowDown', { altKey: true, metaKey: true });
    await after(450);
    const second = press('ArrowDown', { altKey: true, metaKey: true });
    assert.equal(second.prevented, true);
    await after(400);
    assert.equal(sent.length, 2);
  } finally {
    delete globalThis.chrome.storage;
  }
});

test('Safari: a late answer that is no answer (a send that gave up: undefined) in a live world leaves the listener taking the keys', async () => {
  storage(true);
  try {
    let n = 0;
    const { sent, press } = listening({ answer: () => (++n === 1 ? after(500).then(() => undefined) : Promise.resolve(true)) });
    assert.equal(press('ArrowDown', { altKey: true, metaKey: true }).prevented, true);
    await after(700);
    for (let i = 0; i < 3; i++) assert.equal(press('ArrowDown', { altKey: true, metaKey: true }).prevented, true);
    assert.equal(sent.length, 4);
  } finally {
    delete globalThis.chrome.storage;
  }
});

test('Safari: taken as cut off on a slow storage, the world is asked again at the next press (which passes) and at the late answer, and taken again once it answers', async () => {
  let alive = false;
  globalThis.chrome.storage = { local: { get: () => (alive ? Promise.resolve({}) : new Promise(() => {})) } };
  try {
    let late = () => {};
    const { sent, press } = listening({ answer: () => (sent.length === 1 ? new Promise((resolve) => { late = () => resolve(true); }) : Promise.resolve(true)) });
    press('ArrowDown', ctrlCmd);
    await after(650);
    alive = true;
    assert.equal(press('ArrowDown', ctrlCmd).prevented, false, 'aside: this one passes, and asks again');
    await after(10);
    assert.equal(press('ArrowDown', ctrlCmd).prevented, true, 'alive after all: taken');
    late();
    await after(10);
    assert.equal(sent.length, 2);
  } finally {
    delete globalThis.chrome.storage;
  }
});

test('Safari, the shipped manifest: no command keys, so ⌃⌘↓ is the page\'s, and ⌥⌘ arrows are Margin\'s (tabs and spaces)', () => {
  assert.deepEqual(shortcuts.commandKeysFrom(shipped), {});
  assert.deepEqual(capabilities.navigation, { nextTab: 'Alt+Meta+ArrowDown', prevTab: 'Alt+Meta+ArrowUp', nextSpace: 'Alt+Meta+ArrowRight', prevSpace: 'Alt+Meta+ArrowLeft' });
});
