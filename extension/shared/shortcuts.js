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

  // Fixed navigation shortcuts (⌘⌥ + arrows).
  const NAVIGATION = {
    nextTab: 'Alt+Meta+ArrowDown',
    prevTab: 'Alt+Meta+ArrowUp',
    nextSpace: 'Alt+Meta+ArrowRight',
    prevSpace: 'Alt+Meta+ArrowLeft',
  };

  // Capture-phase listener for the navigation shortcuts, shared by the
  // content script and the new-tab page. `getContext()` → { state, windowId,
  // tabId }; `onSpace(spaceId)` runs after a space switch (e.g. to peek the
  // sidebar). Requires shared/view.js.
  function installNavigation({ getContext, send, onSpace }) {
    addEventListener('keydown', (event) => {
      const action = Object.keys(NAVIGATION).find((name) => matches(event, NAVIGATION[name]));
      if (!action) return;
      const { state, windowId } = getContext();
      if (!state || windowId == null) return;
      // Before the background has told this page its tab id, the page being
      // looked at is the window's active tab. (Without this, ↓ could "move"
      // to the tab you're already on, so nothing seemed to happen.)
      const tabId = getContext().tabId ?? Object.values(state.tabs ?? {}).find((t) => t.windowId === windowId && t.active)?.id ?? null;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat && action.endsWith('Space')) return; // don't fly through spaces while held
      if (action === 'nextTab' || action === 'prevTab') {
        const next = Margin.view.cycleTab(state, windowId, tabId, action === 'nextTab' ? 1 : -1);
        if (next != null) send('activateTab', { tabId: next });
      } else {
        const spaceId = Margin.view.cycleSpace(state, windowId, action === 'nextSpace' ? 1 : -1);
        if (spaceId == null) return;
        send('setSpace', { windowId, spaceId });
        onSpace?.(spaceId);
      }
    }, true);
  }

  Margin.shortcuts = { parse, matches, fromEvent, format, NAVIGATION, installNavigation };
})();
