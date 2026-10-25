// Keyboard shortcut strings like "Alt+KeyK" (modifiers + KeyboardEvent.code).
// Matching on `code` keeps Option+K working even though macOS turns it into "˚".
// Classic script: attaches to globalThis.Margin.
(() => {
  const Margin = (globalThis.Margin ??= {});
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

  // Default navigation shortcuts; users can change them in Settings
  // (settings.shortcuts). Spaces aren't on ⌘⌥←/→: Safari keeps those for its
  // own tab switching, so pages never see them. Keep in sync with
  // state/model.js DEFAULT_SETTINGS.shortcuts.
  const NAVIGATION = {
    nextTab: 'Alt+Meta+ArrowDown',
    prevTab: 'Alt+Meta+ArrowUp',
    nextSpace: 'Ctrl+Meta+ArrowRight',
    prevSpace: 'Ctrl+Meta+ArrowLeft',
  };
  const navigationFor = (settings) => ({ ...NAVIGATION, ...settings?.shortcuts });

  // Navigation actions, shared with the background and manifest commands.
  const ACTIONS = { nextTab: 'next-tab', prevTab: 'prev-tab', nextSpace: 'next-space', prevSpace: 'prev-space' };

  // Capture-phase listener for the navigation shortcuts, used by the content
  // script and the new-tab page. It only reports the action: the background
  // does the work (background.js navigate), the same as for the manifest
  // `commands`, so whichever path Safari delivers a key press through, it's
  // handled once, in one place.
  // `getSettings()` → current settings (shortcuts may change any time);
  // return null to pause, e.g. while a shortcut is being recorded.
  function installNavigation({ send, getSettings }) {
    addEventListener('keydown', (event) => {
      const settings = getSettings();
      if (settings === null) return;
      const keys = navigationFor(settings);
      const name = Object.keys(keys).find((n) => matches(event, keys[n]));
      if (!name) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat && name.endsWith('Space')) return; // don't fly through spaces while held
      send('navigate', { action: ACTIONS[name] });
    }, true);
  }

  Margin.shortcuts = { parse, matches, fromEvent, format, NAVIGATION, ACTIONS, navigationFor, installNavigation };
})();
