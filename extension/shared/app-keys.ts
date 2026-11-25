// Margin.app's own keys beyond navigation (its hot keys: app/platforms/macos/shell/Shortcuts.swift AppCommand, run by
// app/shared/host/overlay.ts): Settings' `appKeys`, by field id, each a combination as shared/shortcuts.ts writes
// them, or '' for off. Pages never take these (the content script's listener is navigation's alone): they exist only
// while Margin.app holds them. The numbered ones are one setting each: a combination with a digit, whose modifiers
// go with 1 to 9 (⌃1–9 the spaces, ⌘1–9 the sidebar's rows).
import { format, parse } from './shortcuts.ts';

export const APP_KEYS = Object.freeze({
  focusAddress: 'Meta+KeyL',
  copyUrl: 'Shift+Meta+KeyC',
  togglePin: 'Meta+KeyD',
  reopenArchived: 'Shift+Meta+KeyT',
  littleArc: 'Alt+Meta+KeyN',
  addSplit: 'Ctrl+Shift+Equal',
  spaceDigits: 'Ctrl+Digit1',
  itemDigits: 'Meta+Digit1',
});
export type AppKeyId = keyof typeof APP_KEYS;

// Each one's command (AppCommand's raw value; a numbered one's prefix, its digit after).
const COMMANDS: Record<AppKeyId, string> = {
  focusAddress: 'focus-address', copyUrl: 'copy-url', togglePin: 'toggle-pin', reopenArchived: 'reopen-archived',
  littleArc: 'little-arc', addSplit: 'add-split', spaceDigits: 'space-', itemDigits: 'item-',
};
const DIGITS = new Set<string>(['spaceDigits', 'itemDigits']);
const DIGIT = /^Digit[0-9]$/;

export const isAppKey = (id: string): id is AppKeyId => Object.hasOwn(APP_KEYS, id);
export const isDigitKey = (id: string) => DIGITS.has(id);

/** A combination as a key's setting takes it ('' off), or null: not one (a numbered key's must end in a digit). */
export function appKeyValue(id: string, combo: unknown): string | null {
  if (!isAppKey(id)) return null;
  const text = String(combo ?? '');
  if (text === '') return '';
  const parsed = parse(text);
  if (!parsed) return null;
  if (isDigitKey(id)) return DIGIT.test(parsed.code) ? text.replace(/Digit[0-9]$/, 'Digit1') : null;
  return text;
}

/** Each key's combination now: the saved one ('' off), else its default. */
export function appKeysFor(settings: any): Record<AppKeyId, string> {
  const out: Record<string, string> = { ...APP_KEYS };
  const saved = settings?.appKeys;
  if (saved && typeof saved === 'object') {
    for (const id of Object.keys(APP_KEYS)) {
      const v = appKeyValue(id, saved[id]);
      if (v != null && Object.hasOwn(saved, id)) out[id] = v;
    }
  }
  return out as Record<AppKeyId, string>;
}

/** The combinations a key stands for: a numbered one's nine, the rest its one, none when off. */
export function combosOf(id: string, combo: string): string[] {
  if (!combo) return [];
  if (!isDigitKey(id)) return [combo];
  const base = combo.replace(/Digit[0-9]$/, '');
  return Array.from({ length: 9 }, (_, i) => `${base}Digit${i + 1}`);
}

/** As Settings shows one: "⌘D", a numbered one "⌃1–9", '' when off. */
export function formatAppKey(id: string, combo: string): string {
  if (!combo) return '';
  return isDigitKey(id) ? `${format(combo).replace(/[0-9]$/, '')}1–9` : format(combo);
}

/** Margin.app's `keys` for them ({ command: [combination] }; [] off: background/link.ts keyBindings). */
export function appKeyBindings(settings: any): Record<string, string[]> {
  const keys = appKeysFor(settings);
  const out: Record<string, string[]> = {};
  for (const id of Object.keys(APP_KEYS) as AppKeyId[]) {
    if (isDigitKey(id)) {
      const combos = combosOf(id, keys[id]);
      for (let n = 1; n <= 9; n++) out[`${COMMANDS[id]}${n}`] = combos[n - 1] ? [combos[n - 1]] : [];
    } else out[COMMANDS[id]] = keys[id] ? [keys[id]] : [];
  }
  return out;
}

/** The space keys' modifiers as their symbols, one a cap (⌃1–9's `['⌃']`), for Arc's tooltip over a space's dot (M2.10);
 *  null when they're off. */
export function spaceKeyCaps(settings: any): string[] | null {
  const combo = appKeysFor(settings).spaceDigits;
  if (!combo) return null;
  const caps = [...format(combo).replace(/[0-9]$/, '')];
  return caps.length ? caps : null;
}
