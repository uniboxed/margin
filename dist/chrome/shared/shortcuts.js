// Keyboard shortcut strings like "Alt+KeyK" (modifiers + KeyboardEvent.code).
// Matching on `code` keeps Option+K working even though macOS turns it into "˚".
import { platform, PROFILES } from './platform.js';
const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'];
const MOD_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;
const KEY_CODES = /^(Key[A-Z]|Digit\d|F\d{1,2}|Arrow(Up|Down|Left|Right)|Space|Enter|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/;

function parse(text) {
  const parts = String(text ?? '').split('+').map((p) => p.trim()).filter(Boolean);
  const code = parts.pop();
  if (!code || !KEY_CODES.test(code)) return null;
  const mods = new Set(parts);
  if (!mods.size) return null; // a bare key would hijack typing
  if ([...mods].some((m) => !MODIFIERS.includes(m))) return null;
  return { ctrl: mods.has('Ctrl'), alt: mods.has('Alt'), shift: mods.has('Shift'), meta: mods.has('Meta'), code };
}

function matches(event, text) {
  const s = parse(text);
  return !!s && event.code === s.code && event.ctrlKey === s.ctrl && event.altKey === s.alt
    && event.shiftKey === s.shift && event.metaKey === s.meta;
}

// KeyboardEvent → shortcut string, or null if it's a bare key or only modifiers.
function fromEvent(event) {
  if (MOD_CODES.test(event.code) || !KEY_CODES.test(event.code)) return null;
  const mods = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta'].filter(Boolean);
  if (!mods.length) return null;
  return [...mods, event.code].join('+');
}

const SYMBOLS = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' };
function format(text) {
  const s = parse(text);
  if (!s) return '';
  const ARROWS = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
  const key = ARROWS[s.code] ?? s.code.replace(/^Key|^Digit/, '').replace(/^Slash$/, '/').replace(/^Period$/, '.').replace(/^Space$/, 'Space');
  return MODIFIERS.filter((m) => s[m.toLowerCase()]).map((m) => SYMBOLS[m]).join('') + key;
}

// Default navigation shortcuts come from the build's platform profile
// (shared/platform.js): Safari ⌥⌘↓/↑ for tabs, Chrome ⌃⌘↓/↑; spaces ⌃⌘→/←
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
const navigationFor = (settings) => ({ ...NAVIGATION, ...settings?.shortcuts });

// Navigation actions, shared with the background and manifest commands.
const ACTIONS = { nextTab: 'next-tab', prevTab: 'prev-tab', nextSpace: 'next-space', prevSpace: 'prev-space' };

// A manifest command's key (`suggested_key.mac`: "MacCtrl+Command+Down") as a
// shortcut string here ("Ctrl+Meta+ArrowDown"); null for one this can't
// match. On the Mac, the manifest's `Ctrl` and `Command` are ⌘, `MacCtrl` ⌃.
const MANIFEST_MODIFIERS = { MacCtrl: 'Ctrl', Command: 'Meta', Ctrl: 'Meta', Alt: 'Alt', Option: 'Alt', Shift: 'Shift' };
const MANIFEST_KEYS = { Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', Comma: 'Comma', Period: 'Period', Space: 'Space' };
/** @param {unknown} text @returns {string | null} */
function fromManifest(text) {
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
/** @param {any} manifest @returns {Record<string, string>} */
function commandKeysFrom(manifest) {
  /** @type {Record<string, string>} */
  const keys = {};
  for (const [name, action] of Object.entries(ACTIONS)) {
    const key = fromManifest(manifest?.commands?.[action]?.suggested_key?.mac);
    if (key) keys[name] = key;
  }
  return keys;
}
// This build's, on Safari only (Chrome matches them before the page). From the
// manifest, so they can't drift from the commands Safari knows.
/** @returns {Record<string, string>} */
function commandKeys() {
  if (platform?.name !== 'safari') return {};
  try {
    const api = /** @type {any} */ (globalThis).browser ?? /** @type {any} */ (globalThis).chrome;
    return commandKeysFrom(api?.runtime?.getManifest?.());
  } catch {
    return {};
  }
}
// A press sent and not answered in this long: the page's world is cut off
// from Margin (its messages neither arrive nor fail: background/cut-off.js),
// and the listener lets the keys pass (to the page, and to Safari's commands,
// which a copy of Margin running elsewhere answers) until one is answered.
const NO_ANSWER_MS = 400;

// Capture-phase listener for the navigation shortcuts, used by the content
// script and the new-tab page. It only reports the action: the background
// does the work (background.js navigate), the same as for the manifest
// `commands`, so whichever path Safari delivers a key press through, it's
// handled once, in one place (a press taken here is the page's, so Safari's
// command doesn't fire for it; background/navigation.js counts one that
// came both ways once).
// `getSettings()` → current settings (shortcuts may change any time);
// return null to pause, e.g. while a shortcut is being recorded.
// `target`: the window to listen on. `commands`: the manifest commands' keys
// it takes too, after the Settings shortcuts (commandKeys: Safari's).
// It steps aside, the keys left to the page and Safari's commands, in a page
// cut off from Margin: one the background found so (`Margin.cutOff`, set in
// this world: background/cut-off.js), or once a press sent hasn't been
// answered in NO_ANSWER_MS (until one is).
function installNavigation({ send, getSettings, target = globalThis, commands = commandKeys() }) {
  let unanswered = false;
  const cutOff = () => {
    try {
      return /** @type {any} */ (globalThis).Margin?.cutOff === true;
    } catch {
      return false;
    }
  };
  target.addEventListener('keydown', (event) => {
    const settings = getSettings();
    if (settings === null || unanswered || cutOff()) return;
    const keys = navigationFor(settings);
    const name = Object.keys(keys).find((n) => matches(event, keys[n])) ?? Object.keys(commands).find((n) => matches(event, commands[n]));
    if (!name) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat && name.endsWith('Space')) return; // don't fly through spaces while held
    const reply = send('navigate', { action: ACTIONS[name] });
    if (!reply || typeof reply.then !== 'function') return;
    let answered = false;
    const timer = setTimeout(() => { if (!answered) unanswered = true; }, NO_ANSWER_MS);
    reply.then((taken) => {
      answered = true;
      clearTimeout(timer);
      if (taken === true) unanswered = false;
    }, () => {
      answered = true;
      clearTimeout(timer);
    });
  }, true);
}

export { parse, matches, fromEvent, format, NAVIGATION, ACTIONS, navigationFor, installNavigation, commandKeysFrom, commandKeys };
