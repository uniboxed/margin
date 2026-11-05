// Margin's Settings form (the launcher's Settings), as fields a theme draws
// with Margin's own inputs (ui/sanitize.js: `m-input="setting-number"`,
// `setting-toggle`, `setting-choice`, `setting-list`, `setting-shortcut`)
// and buttons (`settings.run`), inside its guarded `settings` part: every
// word is Margin's (labels, help, options, statuses), the theme only lays it
// out. What each field saves stays here (`saveField`, `runField`), checked
// against the field's own kind and bounds; a theme only says which field.
// The same settings as the form before Margin 2 (themes/arcadia/newtab.js),
// less keep-ready and the warm-up (gone in Margin 2 Phase 2 step 8) and the switch
// log (development diagnostics). Pure: runs in Node.
import * as S from '../shared/search.js';
import * as shortcuts from '../shared/shortcuts.js';
import { siteList } from '../shared/sleep.js';
import { PACKAGE_THEMES, PACKAGE_THEME_NAMES } from '../themes/packages.js';

/**
 * A field of the form. `kind` and one `is…` flag (a theme's m-if tests
 * paths, not values): number, toggle, choice, list (lines of text),
 * shortcut (a key combination recorded), button, info (a paragraph), group
 * (a heading). `value`: what the input shows (text); `checked` for a
 * toggle; `options` for a choice.
 * @typedef {{
 *   id: string, kind: 'number' | 'toggle' | 'choice' | 'list' | 'shortcut' | 'button' | 'info' | 'group',
 *   label: string, help: string, value: string, checked: boolean, disabled: boolean,
 *   min: number | null, max: number | null, step: string,
 *   options: { id: string, label: string, selected: boolean }[],
 *   status: string, error: boolean, recording: boolean, placeholder: string,
 *   isNumber: boolean, isToggle: boolean, isChoice: boolean, isList: boolean, isShortcut: boolean,
 *   isButton: boolean, isInfo: boolean, isGroup: boolean, hasHelp: boolean, hasStatus: boolean,
 * }} SettingsField
 */

// The keyboard shortcuts' fields: the setting each records.
export const SHORTCUT_FIELDS = Object.freeze({
  sidebarShortcut: 'Show or hide the sidebar',
  nextTab: 'Next tab',
  prevTab: 'Previous tab',
  nextSpace: 'Next space',
  prevSpace: 'Previous space',
});
const SHORTCUT_NAMES = Object.freeze({ newTab: 'New tab (the command palette)', ...SHORTCUT_FIELDS });
export const SHORTCUT_HELP = 'Click a field, then press a key with ⌘, ⌥, ⌃ or ⇧. Esc cancels. If a combination shows nothing when you press it, Safari or macOS keeps it for itself (⌘⌥← / ⌘⌥→ switch Safari\'s tabs), so pick another.';

/** Every shortcut now: the palette's fixed ⌘T and the ones from Settings. @param {any} settings */
export function currentShortcuts(settings) {
  return {
    newTab: 'Meta+KeyT', // fixed: the palette's key (content/palette.js installNewTabKey)
    sidebarShortcut: settings?.sidebarShortcut ?? 'Alt+KeyS',
    ...shortcuts.navigationFor(settings),
  };
}

/** Which engine searches use (always the browser's: shared/search.js). @param {any} settings @param {any} features */
function engineText(settings, features) {
  const learned = settings?.safariSearch;
  if (features?.search === 'browser') return 'Searches use Chrome’s search engine (Chrome Settings → Search engine).';
  if (learned) return `Searches use Safari’s search engine: ${learned.name} (seen in Safari’s address bar ${new Date(learned.at).toLocaleString()}). Margin follows it: after changing it in Safari → Settings → Search, search once from Safari’s address bar.`;
  return `Searches use Safari’s default search engine (${S.SAFARI_DEFAULT.name}) until you search once from Safari’s address bar; from then on, whatever Safari uses (Safari → Settings → Search).`;
}

/** @param {Partial<SettingsField> & { id: string, kind: SettingsField['kind'], label: string }} f @returns {SettingsField} */
function field(f) {
  const out = {
    help: '', value: '', checked: false, disabled: false, min: null, max: null, step: '', options: [], status: '', error: false, recording: false, placeholder: '',
    ...f,
  };
  return {
    ...out,
    isNumber: out.kind === 'number', isToggle: out.kind === 'toggle', isChoice: out.kind === 'choice', isList: out.kind === 'list',
    isShortcut: out.kind === 'shortcut', isButton: out.kind === 'button', isInfo: out.kind === 'info', isGroup: out.kind === 'group',
    hasHelp: !!out.help, hasStatus: !!out.status,
  };
}

/**
 * The form's fields for the stored settings, the browser's features
 * (`features`: shared/platform.js's sleepTabs, blockGestures,
 * marginFullscreen, newTabHint, search) and the form's own state (`ui`: the
 * shortcut being recorded, the statuses).
 * @param {any} settings
 * @param {any} features
 * @param {{ recording?: string | null, status?: Record<string, { text: string, error?: boolean }> }} [ui]
 * @returns {SettingsField[]}
 */
export function settingsFields(settings, features = {}, ui = {}) {
  const s = settings ?? {};
  const f = features ?? {};
  const status = ui.status ?? {};
  const list = [];
  // What Margin looks like.
  const theme = PACKAGE_THEMES.includes(s.theme) ? s.theme : PACKAGE_THEMES[0];
  list.push(field({ id: 'theme', kind: 'choice', label: 'Theme', options: PACKAGE_THEMES.map((id) => ({ id, label: PACKAGE_THEME_NAMES[id] ?? id, selected: id === theme })), value: theme }));
  list.push(field({ id: 'engine', kind: 'info', label: engineText(s, f) }));
  list.push(field({ id: 'archiveAfterHours', kind: 'number', label: 'Archive tabs not used for (hours, 0 = never)', value: String(s.archiveAfterHours ?? 12), min: 0, max: 720, step: '1' }));
  if (f.sleepTabs) {
    list.push(field({ id: 'sleepAfterHours', kind: 'number', label: 'Put tabs to sleep after not using them for (hours, 0 = never). A sleeping tab frees its memory and loads again when you go back to it', value: String(s.sleepAfterHours ?? 4), min: 0, max: 720, step: 'any' }));
    list.push(field({ id: 'neverSleepSites', kind: 'list', label: 'Never put these sites to sleep (one per line; each includes its subdomains)', value: siteList(s.neverSleepSites ?? []).join('\n'), placeholder: 'mail.example.com' }));
    list.push(field({ id: 'wakeAll', kind: 'button', label: 'Wake all sleeping tabs', status: status.wakeAll?.text ?? '', error: !!status.wakeAll?.error }));
  }
  if (f.blockGestures) {
    const gestures = s.blockGestures !== false;
    list.push(field({ id: 'blockGestures', kind: 'toggle', label: 'Use Margin’s trackpad gestures instead of Safari’s (pinch zooms the page; no all-tabs pinch, no bounce)', checked: gestures }));
    list.push(field({ id: 'swipeNavigation', kind: 'toggle', label: 'Swipe sideways with two fingers to go back or forward', checked: s.swipeNavigation !== false, disabled: !gestures }));
    // Margin's pull-to-refresh replaces Safari's, which only goes away with the bounce.
    list.push(field({ id: 'pullToRefresh', kind: 'toggle', label: 'Pull down at the top of a page to reload', checked: s.pullToRefresh !== false, disabled: !gestures }));
  }
  if (f.marginFullscreen) {
    list.push(field({ id: 'marginFullscreenAuto', kind: 'toggle', label: 'In full screen, hide Chrome’s toolbar (it otherwise shows on every tab change)', checked: s.marginFullscreenAuto !== false }));
    list.push(field({ id: 'fullscreenOnly', kind: 'toggle', label: 'Use Margin only in full screen (in a window, it offers full screen instead)', checked: s.fullscreenOnly !== false }));
  }
  list.push(field({ id: 'frameWhenHidden', kind: 'toggle', label: 'With the sidebar hidden, keep the frame around pages', checked: s.frameWhenHidden !== false }));
  if (f.newTabHint) list.push(field({ id: 'newTabHint', kind: 'toggle', label: 'Tell me when a new tab seems to open Safari’s homepage instead of Margin (Safari Settings › General › “New tabs open with” should be Margin)', checked: s.newTabHint !== false }));
  // Keyboard shortcuts: recorded by pressing them.
  list.push(field({ id: 'shortcuts', kind: 'group', label: 'Keyboard shortcuts' }));
  const keys = currentShortcuts(s);
  for (const [id, label] of Object.entries(SHORTCUT_FIELDS)) {
    const recording = ui.recording === id;
    list.push(field({ id, kind: 'shortcut', label, value: recording ? '' : shortcuts.format(keys[id]), recording, placeholder: 'Press keys…' }));
  }
  list.push(field({ id: 'resetShortcuts', kind: 'button', label: 'Reset shortcuts', status: status.shortcuts?.text ?? SHORTCUT_HELP, error: !!status.shortcuts?.error }));
  return list;
}

// ---- what a field saves ------------------------------------------------------

/**
 * What a change of a field asks the background for: `updateSettings`'s
 * patch, or null (not a field, a bad value, nothing to save). `value`: what
 * the input holds (text; a toggle's checked state as a boolean).
 * @param {SettingsField} f @param {any} value @param {any} settings
 * @returns {{ type: 'updateSettings', payload: { patch: Record<string, any> } } | null}
 */
export function saveField(f, value, settings) {
  if (!f || f.disabled) return null;
  const patch = (p) => ({ type: /** @type {'updateSettings'} */ ('updateSettings'), payload: { patch: p } });
  switch (f.kind) {
    case 'number': {
      const n = Number(value);
      if (String(value).trim() === '' || !Number.isFinite(n) || n < (f.min ?? -Infinity)) return null;
      const clamped = Math.min(n, f.max ?? Infinity);
      return patch({ [f.id]: f.step === 'any' ? clamped : Math.round(clamped) });
    }
    case 'toggle': return typeof value === 'boolean' ? patch({ [f.id]: value }) : null;
    case 'choice': return f.options.some((o) => o.id === value) && value !== f.value ? patch({ [f.id]: value }) : null;
    case 'list': return f.id === 'neverSleepSites' ? patch({ neverSleepSites: siteList(String(value ?? '')) }) : null;
    case 'shortcut': {
      const combo = String(value ?? '');
      if (!shortcuts.parse(combo) || !Object.hasOwn(SHORTCUT_FIELDS, f.id)) return null;
      if (f.id === 'sidebarShortcut') return patch({ sidebarShortcut: combo });
      return patch({ shortcuts: { ...shortcuts.navigationFor(settings), [f.id]: combo } });
    }
    default: return null;
  }
}

/**
 * A shortcut pressed while a field records it: taken by another (the
 * message says which), or fine.
 * @param {string} id @param {string} combo @param {any} settings
 * @returns {string | null} what's wrong, or null
 */
export function shortcutTaken(id, combo, settings) {
  const taken = Object.entries(currentShortcuts(settings)).find(([other, value]) => other !== id && value === combo);
  return taken ? `${shortcuts.format(combo)} is already used for “${SHORTCUT_NAMES[taken[0]]}”.` : null;
}

/** What a button asks the background for. @param {SettingsField} f */
export function runField(f) {
  if (f?.id === 'wakeAll') return { type: 'wakeSleeping', payload: {} };
  if (f?.id === 'resetShortcuts') return { type: 'updateSettings', payload: { patch: { sidebarShortcut: 'Alt+KeyS', shortcuts: { ...shortcuts.NAVIGATION } } } };
  return null;
}

/** What Wake all says once it's answered. @param {any} woke */
export const wokeText = (woke) => (typeof woke !== 'number' ? 'Couldn’t reach Margin.' : woke ? `Woke ${woke} tab${woke === 1 ? '' : 's'}.` : 'No tabs are asleep.');
