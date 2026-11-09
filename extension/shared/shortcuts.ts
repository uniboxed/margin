// Keyboard shortcut strings like "Alt+KeyK" (modifiers + KeyboardEvent.code).
// Matching on `code` keeps Option+K working even though macOS turns it into "˚".
import { platform, PROFILES } from './platform.ts';
const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'];
const MOD_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;
const KEY_CODES = /^(Key[A-Z]|Digit\d|F\d{1,2}|Arrow(Up|Down|Left|Right)|Space|Enter|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/;

function parse(text: unknown) {
  const parts = String(text ?? '').split('+').map((p) => p.trim()).filter(Boolean);
  const code = parts.pop();
  if (!code || !KEY_CODES.test(code)) return null;
  const mods = new Set(parts);
  if (!mods.size) return null; // a bare key would hijack typing
  if ([...mods].some((m) => !MODIFIERS.includes(m))) return null;
  return { ctrl: mods.has('Ctrl'), alt: mods.has('Alt'), shift: mods.has('Shift'), meta: mods.has('Meta'), code };
}

function matches(event: KeyboardEvent, text: unknown) {
  const s = parse(text);
  return !!s && event.code === s.code && event.ctrlKey === s.ctrl && event.altKey === s.alt
    && event.shiftKey === s.shift && event.metaKey === s.meta;
}

// KeyboardEvent → shortcut string, or null if it's a bare key or only modifiers.
function fromEvent(event: KeyboardEvent) {
  if (MOD_CODES.test(event.code) || !KEY_CODES.test(event.code)) return null;
  const mods = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta'].filter(Boolean);
  if (!mods.length) return null;
  return [...mods, event.code].join('+');
}

const SYMBOLS: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' };
function format(text: unknown) {
  const s = parse(text);
  if (!s) return '';
  const ARROWS: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
  const key = ARROWS[s.code] ?? s.code.replace(/^Key|^Digit/, '').replace(/^Slash$/, '/').replace(/^Period$/, '.').replace(/^Space$/, 'Space');
  return MODIFIERS.filter((m) => (s as Record<string, unknown>)[m.toLowerCase()]).map((m) => SYMBOLS[m]).join('') + key;
}

// Default navigation shortcuts come from the build's platform profile
// (shared/platform.ts): Safari ⌥⌘↓/↑ for tabs, Chrome ⌃⌘↓/↑; spaces ⌃⌘→/←
// in both. Separately, the manifest `commands` are ⌃⌘ + arrows in both
// builds. Chrome matches those in the browser, before the page. Safari doesn't
// (2026-11-04): its commands are menu key equivalents, and WebKit gives the
// focused page every ⌘ key first (WebViewImpl performKeyEquivalent); the menu
// sees it only if the page didn't handle it. Outlook's message list and
// Instagram's reels call preventDefault on any ArrowDown, so ⌃⌘↓ never reached
// Margin there. So on Safari this page listener takes the commands' keys too
// (commandKeys), ahead of every page script: it's on the window, in the
// capture phase, from document_start. It handles the Settings shortcuts, with
// key repeat, first.
const NAVIGATION = { ...(platform ?? PROFILES.chrome).navigation };
const navigationFor = (settings: any) => ({ ...NAVIGATION, ...settings?.shortcuts });

// Navigation actions, shared with the background and manifest commands.
const ACTIONS: Record<string, string> = { nextTab: 'next-tab', prevTab: 'prev-tab', nextSpace: 'next-space', prevSpace: 'prev-space' };

// A manifest command's key (`suggested_key.mac`: "MacCtrl+Command+Down") as a
// shortcut string here ("Ctrl+Meta+ArrowDown"); null for one this can't
// match. On the Mac, the manifest's `Ctrl` and `Command` are ⌘, `MacCtrl` ⌃.
const MANIFEST_MODIFIERS: Record<string, string> = { MacCtrl: 'Ctrl', Command: 'Meta', Ctrl: 'Meta', Alt: 'Alt', Option: 'Alt', Shift: 'Shift' };
const MANIFEST_KEYS: Record<string, string> = { Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', Comma: 'Comma', Period: 'Period', Space: 'Space' };
function fromManifest(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const parts = text.split('+').map((p) => p.trim()).filter(Boolean);
  const key = parts.pop() ?? '';
  const code = MANIFEST_KEYS[key] ?? (/^[A-Z]$/.test(key) ? `Key${key}` : /^[0-9]$/.test(key) ? `Digit${key}` : null);
  const mods = parts.map((p) => MANIFEST_MODIFIERS[p]);
  if (!code || mods.some((m) => !m)) return null;
  const shortcut = [...MODIFIERS.filter((m) => mods.includes(m)), code].join('+');
  return parse(shortcut) ? shortcut : null;
}
// The navigation commands' keys from a manifest: { nextTab: 'Ctrl+Meta+ArrowDown', … }.
function commandKeysFrom(manifest: any): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const [name, action] of Object.entries(ACTIONS)) {
    const key = fromManifest(manifest?.commands?.[action]?.suggested_key?.mac);
    if (key) keys[name] = key;
  }
  return keys;
}
// This build's, on Safari only (Chrome matches them before the page). From the
// manifest, so they can't drift from the commands Safari knows.
function commandKeys(): Record<string, string> {
  if (platform?.name !== 'safari') return {};
  try {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    return commandKeysFrom(api?.runtime?.getManifest?.());
  } catch {
    return {};
  }
}
// A press sent and not answered in this long: the listener asks whether its
// world still reaches Margin at all (worldAlive). Only a world cut off from
// Margin (its messages and storage calls neither arrive nor fail:
// background/cut-off.ts) makes it step aside; a background that is merely
// slow to answer (Safari starting it again after it went idle, the first
// sync) doesn't: its presses are queued as before (2026-11-04 review: a step
// aside on latency alone lost every press of a cold start, and could last for
// the document's life).
const NO_ANSWER_MS = 400;
// How long the world's storage gets to answer that (cut-off.ts asks the same).
const ALIVE_MS = 200;
// Whether this world's calls still arrive somewhere: a storage read answers
// within milliseconds in a live world, whatever the background is doing, and
// never (or fails at once) in one whose copy is gone. True where it can't be
// told (no storage).
function worldAlive(): Promise<boolean> {
  let local: { get?: (key: string) => unknown } | null = null;
  try {
    const api = (globalThis as any).browser ?? (globalThis as any).chrome;
    local = api?.storage?.local;
  } catch {}
  if (typeof local?.get !== 'function') return Promise.resolve(true);
  return Promise.race([
    // (`local.get` is a function: checked above.)
    Promise.resolve().then(() => local!.get!('owner')).then(() => true, () => false),
    new Promise<any>((resolve) => setTimeout(() => resolve(false), ALIVE_MS)),
  ]);
}

// Capture-phase listener for the navigation shortcuts, used by the content
// script and the new-tab page. It only reports the action: the background
// does the work (background.ts navigate), the same as for the manifest
// `commands`, so whichever path Safari delivers a key press through, it's
// handled once, in one place (a press taken here is the page's, so Safari's
// command doesn't fire for it; background/navigation.ts counts one that
// came both ways once).
// `getSettings()` → current settings (shortcuts may change any time);
// return null to pause, e.g. while a shortcut is being recorded.
// `target`: the window to listen on. `commands`: the manifest commands' keys
// it takes too, after the Settings shortcuts (commandKeys: Safari's), unless
// Settings give that key to the sidebar (`sidebarShortcut`, content/layout.ts).
// In a page cut off from Margin it steps aside: one the background found so
// (`Margin.cutOff`, set in this world: background/cut-off.ts), or once a press
// went unanswered for NO_ANSWER_MS and the world's storage didn't answer
// either (worldAlive; asked again at the next press, which then passes). The
// commands' keys then go on to Safari's commands, which the copy running now
// answers, kept from the page's own listeners (stopImmediatePropagation, not
// preventDefault: WebKit gives a key the page didn't turn down to the menu);
// the Settings keys go to the page, as nothing else can take them there.
function installNavigation({ send, getSettings, target = globalThis, commands = commandKeys() }: { send: (type: 'navigate', payload: { action: string }) => Promise<unknown> | undefined, getSettings: () => any, target?: { addEventListener: typeof addEventListener }, commands?: Record<string, string> }) {
  let aside = false;
  let asking: Promise<boolean> | null = null;
  const askAlive = () => {
    asking ??= worldAlive().then((alive) => {
      asking = null;
      aside = !alive;
      return alive;
    });
    return asking;
  };
  const cutOff = () => {
    try {
      return (globalThis as any).Margin?.cutOff === true;
    } catch {
      return false;
    }
  };
  target.addEventListener('keydown', (event) => {
    const settings = getSettings();
    if (settings === null) return;
    const keys = navigationFor(settings);
    const own = Object.keys(keys).find((n) => matches(event, keys[n]));
    const command = own ? null : Object.keys(commands).find((n) => matches(event, commands[n]) && !matches(event, settings?.sidebarShortcut));
    const name = own ?? command;
    if (!name) return;
    const dead = cutOff();
    if (dead || aside) {
      if (!dead) void askAlive(); // (the next press is taken again if it's alive)
      if (command) event.stopImmediatePropagation();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    // Don't fly through spaces while held, on this path (a page's keys, when
    // Margin.app doesn't hold them). The app's own held keys repeat, spaces
    // too (Tirth, 2026-11-05), one switch at a time: background/navigation.ts.
    if (event.repeat && name.endsWith('Space')) return;
    const reply = send('navigate', { action: ACTIONS[name] });
    if (!reply || typeof reply.then !== 'function') return;
    let answered = false;
    const timer = setTimeout(() => { if (!answered) void askAlive(); }, NO_ANSWER_MS);
    // Any answer, however late (undefined from a send that gave up): the
    // world asked again if it was taken as cut off meanwhile.
    const settle = () => {
      answered = true;
      clearTimeout(timer);
      if (aside) void askAlive();
    };
    reply.then(settle, settle);
  }, true);
}

export { parse, matches, fromEvent, format, NAVIGATION, ACTIONS, navigationFor, installNavigation, commandKeysFrom, commandKeys };
