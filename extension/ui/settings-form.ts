// Margin's Settings form (the launcher's Settings), as fields a theme draws
// with Margin's own inputs (ui/sanitize.ts: `m-input="setting-number"`,
// `setting-toggle`, `setting-choice`, `setting-list`, `setting-shortcut`)
// and buttons (`settings.run`), inside its guarded `settings` part: every
// word is Margin's (labels, help, options, statuses), the theme only lays it
// out. What each field saves stays here (`saveField`, `runField`), checked
// against the field's own kind and bounds; a theme only says which field.
// The same settings as the form before Margin 2 (themes/arcadia/newtab.js),
// less keep-ready and the warm-up (gone in Margin 2 Phase 2 step 8) and the switch
// log (development diagnostics). Pure: runs in Node.
import * as S from '../shared/search.ts';
import * as shortcuts from '../shared/shortcuts.ts';
import { siteList } from '../shared/sleep.ts';
import { PACKAGE_THEMES, PACKAGE_THEME_NAMES, USER_THEME_ID } from '../themes/packages.ts';
import { settingValueOk } from './theme-schema.ts';

/**
 * A field of the form. `kind` and one `is…` flag (a theme's m-if tests
 * paths, not values): number, toggle, choice, list (lines of text),
 * shortcut (a key combination recorded), button, info (a paragraph), group
 * (a heading). `value`: what the input shows (text); `checked` for a
 * toggle; `options` for a choice.
 */
export type SettingsField = {
  id: string, kind: 'number' | 'toggle' | 'choice' | 'list' | 'shortcut' | 'color' | 'button' | 'info' | 'group',
  label: string, help: string, value: string, checked: boolean, disabled: boolean,
  min: number | null, max: number | null, step: string,
  options: { id: string, label: string, selected: boolean }[],
  status: string, error: boolean, recording: boolean, placeholder: string,
  isNumber: boolean, isToggle: boolean, isChoice: boolean, isList: boolean, isShortcut: boolean,
  isColor: boolean, isButton: boolean, isInfo: boolean, isGroup: boolean, hasHelp: boolean, hasStatus: boolean,
  fromTheme: boolean,
};

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

/** Every shortcut now: the palette's fixed ⌘T and the ones from Settings. */
export function currentShortcuts(settings: any) {
  return {
    newTab: 'Meta+KeyT', // fixed: the palette's key (content/palette.js installNewTabKey)
    sidebarShortcut: settings?.sidebarShortcut ?? 'Alt+KeyS',
    ...shortcuts.navigationFor(settings),
  };
}

// "Close windows to save memory" (docs/HANDOFF.md §5): Margin.app's, for the
// whole browser, so every profile's Settings show the same value.
export const CLOSE_WINDOWS_LABEL = 'Close windows to save memory: when you switch to another profile, the window you leave closes. Switching takes a little longer and its pages reload when you come back. Off: the window stays open, out of sight, with your place, text and video kept.';

/** Which engine searches use (always the browser's: shared/search.ts). */
function engineText(settings: any, features: any) {
  const learned = settings?.safariSearch;
  if (features?.search === 'browser') return 'Searches use Chrome’s search engine (Chrome Settings → Search engine).';
  if (learned) return `Searches use Safari’s search engine: ${learned.name} (seen in Safari’s address bar ${new Date(learned.at).toLocaleString()}). Margin follows it: after changing it in Safari → Settings → Search, search once from Safari’s address bar.`;
  return `Searches use Safari’s default search engine (${S.SAFARI_DEFAULT.name}) until you search once from Safari’s address bar; from then on, whatever Safari uses (Safari → Settings → Search).`;
}

function field(f: Partial<SettingsField> & { id: string, kind: SettingsField['kind'], label: string }): SettingsField {
  const out = {
    help: '', value: '', checked: false, disabled: false, min: null, max: null, step: '', options: [], status: '', error: false, recording: false, placeholder: '',
    ...f,
  };
  return {
    ...out,
    isNumber: out.kind === 'number', isToggle: out.kind === 'toggle', isChoice: out.kind === 'choice', isList: out.kind === 'list',
    isShortcut: out.kind === 'shortcut', isColor: out.kind === 'color', isButton: out.kind === 'button', isInfo: out.kind === 'info', isGroup: out.kind === 'group',
    hasHelp: !!out.help, hasStatus: !!out.status, fromTheme: !!out.fromTheme,
  };
}

/**
 * The form's fields for the stored settings, the browser's features
 * (`features`: shared/platform.ts's sleepTabs ('close', 'discard' or false), blockGestures,
 * marginFullscreen, newTabHint, search; cloudTabs, Margin.app's Safari windows; importThemes and
 * userThemes, Margin.app's imported themes; switchSettings, Margin.app's Safari windows with more than
 * one profile: the switch's settings, `{ closeWindows }`) and the form's own state (`ui`: the
 * shortcut being recorded, the statuses, the active theme: its id, name and theme.json settings).
 * */
export function settingsFields(settings: any, features: any = {}, ui: { recording?: string | null, status?: Record<string, { text: string, error?: boolean } | undefined>, theme?: { id: string, name: string, settings: Record<string, any> } | null } = {}): SettingsField[] {
  const s = settings ?? {};
  const f = features ?? {};
  const status = ui.status ?? {};
  const list: SettingsField[] = [];
  // What Margin looks like: the built-in themes, then the ones imported (Margin.app's: `features.userThemes`).
  const imported = userThemeList(f.userThemes);
  const theme = PACKAGE_THEMES.includes(s.theme) || imported.some((t) => t.id === s.theme) ? s.theme : PACKAGE_THEMES[0];
  const options = [...PACKAGE_THEMES.map((id) => ({ id, label: (PACKAGE_THEME_NAMES as Record<string, string>)[id] ?? id })), ...imported.map((t) => ({ id: t.id, label: t.name || t.id }))];
  list.push(field({ id: 'theme', kind: 'choice', label: 'Theme', options: options.map((o) => ({ ...o, selected: o.id === theme })), value: theme, status: status.theme?.text ?? '', error: !!status.theme?.error }));
  list.push(...importFields(f, status, imported));
  list.push(field({ id: 'engine', kind: 'info', label: engineText(s, f) }));
  list.push(field({ id: 'archiveAfterHours', kind: 'number', label: 'Archive tabs not used for (hours, 0 = never)', value: String(s.archiveAfterHours ?? 12), min: 0, max: 720, step: '1' }));
  if (f.sleepTabs) {
    list.push(field({ id: 'sleepAfterHours', kind: 'number', label: 'Put tabs to sleep after not using them for (hours, 0 = never). A sleeping tab frees its memory and loads again when you go back to it', value: String(s.sleepAfterHours ?? 4), min: 0, max: 720, step: 'any' }));
    list.push(field({ id: 'neverSleepSites', kind: 'list', label: 'Never put these sites to sleep (one per line; each includes its subdomains)', value: siteList(s.neverSleepSites ?? []).join('\n'), placeholder: 'mail.example.com' }));
    // Only where a sleeping tab stays open, discarded (Chrome, Edge): Safari
    // closes it (each opens again as it's clicked), so there's none to wake.
    if (f.sleepTabs === 'discard') list.push(field({ id: 'wakeAll', kind: 'button', label: 'Wake all sleeping tabs', status: status.wakeAll?.text ?? '', error: !!status.wakeAll?.error }));
  }
  if (f.blockGestures) {
    const gestures = s.blockGestures !== false;
    list.push(field({ id: 'blockGestures', kind: 'toggle', label: 'Use Margin’s trackpad gestures instead of Safari’s (no all-tabs pinch, no bounce)', checked: gestures }));
    list.push(field({ id: 'swipeNavigation', kind: 'toggle', label: 'Swipe sideways with two fingers to go back or forward', checked: s.swipeNavigation !== false, disabled: !gestures }));
    // Margin's pull-to-refresh replaces Safari's, which only goes away with the bounce.
    list.push(field({ id: 'pullToRefresh', kind: 'toggle', label: 'Pull down at the top of a page to reload', checked: s.pullToRefresh !== false, disabled: !gestures }));
  }
  if (f.marginFullscreen) {
    list.push(field({ id: 'marginFullscreenAuto', kind: 'toggle', label: 'In full screen, hide Chrome’s toolbar (it otherwise shows on every tab change)', checked: s.marginFullscreenAuto !== false }));
    list.push(field({ id: 'fullscreenOnly', kind: 'toggle', label: 'Use Margin only in full screen (in a window, it offers full screen instead)', checked: s.fullscreenOnly !== false }));
  }
  list.push(field({ id: 'frameWhenHidden', kind: 'toggle', label: 'With the sidebar hidden, keep the frame around pages', checked: s.frameWhenHidden !== false }));
  // iCloud Tabs (Margin.app with Safari): the sidebar's live folder and the palette's section.
  if (f.cloudTabs) list.push(field({ id: 'showCloudTabs', kind: 'toggle', label: 'Show iCloud Tabs: the tabs open on your other devices, in the sidebar and the command palette', checked: s.showCloudTabs !== false }));
  // Switching between profiles (Margin.app): the app's setting, not this copy's (saveField).
  if (f.switchSettings) list.push(field({ id: 'closeWindows', kind: 'toggle', label: CLOSE_WINDOWS_LABEL, checked: f.switchSettings.closeWindows === true }));
  // DEV-HOOK: Margin.app's quit prompt back on after "Always quit" (development only; Margin.app's own setting).
  if (typeof ((f as any)).devAskBeforeQuit === 'boolean') {
    list.push(field({ id: 'devAskBeforeQuit', kind: 'toggle', label: 'Ask before quitting Safari (development only)', checked: ((f as any)).devAskBeforeQuit === true }));
  }
  if (f.newTabHint) list.push(field({ id: 'newTabHint', kind: 'toggle', label: 'Tell me when a new tab seems to open Safari’s homepage instead of Margin (Safari Settings › General › “New tabs open with” should be Margin)', checked: s.newTabHint !== false }));
  // The active theme's own settings: after Margin's, under their own heading, so they don't read as Margin's.
  list.push(...themeOwnFields(s, ui.theme ?? null));
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

// ---- themes: imported ones, and the active theme's own settings ---------------

// A theme's own words (its name, author, a setting's label) inside Margin's
// form: capped, and with no characters that reorder or hide text.
const INVISIBLE = /[\u0000-\u001f\u007f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
export const themeText = (text: unknown, max: number) => { const t = String(text ?? '').replace(INVISIBLE, '').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

/** Margin.app's index of imported themes, as Settings shows it. */
export function userThemeList(list: unknown) {
  return (Array.isArray(list) ? list : []).filter((e) => e && typeof e.id === 'string' && USER_THEME_ID.test(e.id) && !PACKAGE_THEMES.includes(e.id)).slice(0, 50)
    .map((e) => ({ id: e.id, name: themeText(e.name, 40), version: themeText(e.version, 16), author: themeText(e.author, 40) }));
}

const SETTING_PREFIX = 'themeSetting:';
const REMOVE_PREFIX = 'removeTheme:';

/** Import Theme… (Margin.app only: `features.importThemes`) and each imported theme with Remove, under the theme choice. */
function importFields(f: Record<string, any>, status: Record<string, { text: string; error?: boolean; } | undefined>, imported: { id: any; name: string; version: string; author: string; }[]) {
  const out: SettingsField[] = [];
  if (!f.importThemes) return out;
  out.push(field({ id: 'themeImport', kind: 'button', label: 'Import Theme…', status: status.themeImport?.text ?? 'A theme’s folder, or a .margintheme file. You’ll see it before it’s used.', error: !!status.themeImport?.error }));
  for (const t of imported) {
    out.push(field({ id: `userTheme:${t.id}`, kind: 'info', label: `“${t.name || t.id}” ${t.version}${t.author ? ` · by ${t.author}` : ''}` }));
    out.push(field({ id: `${REMOVE_PREFIX}${t.id}`, kind: 'button', label: `Remove “${t.name || t.id}”` }));
  }
  return out;
}

/** The active theme's own settings (`theme`: the runtime's loaded theme: id, name, its theme.json settings), under "Settings of “Name”". */
function themeOwnFields(s: Record<string, any>, theme: { id: string; name: string; settings: Record<string, any>; } | null) {
  const out: SettingsField[] = [];
  const specs = theme?.settings && typeof theme.settings === 'object' ? Object.entries(theme.settings) : [];
  // Margin's own width setting (m-resize drags it) is shown as the theme's too.
  if (!theme || !specs.length) return out;
  out.push(field({ id: 'themeSettings', kind: 'group', label: `Settings of “${themeText(theme.name, 40) || theme.id}”` }));
  const saved = s.themes?.[theme.id] && typeof s.themes[theme.id] === 'object' ? s.themes[theme.id] : {};
  for (const [key, spec] of specs.slice(0, 32)) {
    const value = Object.hasOwn(saved, key) && settingValueOk(spec, saved[key]) ? saved[key] : spec.default;
    const base = { id: `${SETTING_PREFIX}${key}`, label: themeText(spec.label, 40) || key, fromTheme: true };
    switch (spec.type) {
      case 'toggle': out.push(field({ ...base, kind: 'toggle', checked: value === true })); break;
      case 'number': out.push(field({ ...base, kind: 'number', value: String(value), min: spec.min ?? null, max: spec.max ?? null, step: spec.step ? String(spec.step) : 'any' })); break;
      case 'length': {
        const m = /^(-?\d+(?:\.\d+)?)([a-z%]*)$/.exec(String(value));
        out.push(field({ ...base, kind: 'number', value: m ? m[1] : '', min: spec.min ?? null, max: spec.max ?? null, step: spec.step ? String(spec.step) : 'any' }));
        break;
      }
      case 'choice': out.push(field({ ...base, kind: 'choice', value: String(value), options: (spec.choices ?? []).map((c: unknown) => ({ id: String(c), label: themeText(c, 40), selected: String(c) === String(value) })) })); break;
      case 'color': out.push(field({ ...base, kind: 'color', value: String(value) })); break;
      default: break;
    }
  }
  return out;
}

/**
 * A change to one of the active theme's own settings: `updateThemeSettings`
 * for that theme, checked against its spec. A length keeps its default's unit.
 * */
export function saveThemeField(f: SettingsField, value: any, theme: { id: string, settings: Record<string, any> } | null) {
  if (!f?.id?.startsWith(SETTING_PREFIX) || !theme) return null;
  const key = f.id.slice(SETTING_PREFIX.length);
  const spec = theme.settings?.[key];
  if (!spec) return null;
  let v = value;
  if (spec.type === 'number') v = Number(value);
  if (spec.type === 'length') v = `${String(value).trim()}${/[a-z%]+$/.exec(String(spec.default))?.[0] ?? 'px'}`;
  if (spec.type === 'choice') v = spec.choices?.find((c: unknown) => String(c) === String(value));
  if (!settingValueOk(spec, v)) return null;
  return { type: ('updateThemeSettings' as 'updateThemeSettings'), payload: { themeId: theme.id, patch: { [key]: v } } };
}

/** The prompt Remove asks first (in Margin's prompt part). */
export function removePrompt(fieldId: string, list: any[]) {
  if (!fieldId.startsWith(REMOVE_PREFIX)) return null;
  const id = fieldId.slice(REMOVE_PREFIX.length);
  const t = userThemeList(list).find((e) => e.id === id);
  if (!t) return null;
  return {
    id: `remove-theme:${id}`,
    title: 'Remove theme',
    text: `Remove “${t.name || t.id}”? Windows using it go back to Arcadia.`,
    actions: [{ id: 'remove', label: 'Remove', danger: true }, { id: 'cancel', label: 'Cancel' }],
  };
}

// ---- what a field saves ------------------------------------------------------

/**
 * What a change of a field asks the background for: `updateSettings`'s
 * patch, or null (not a field, a bad value, nothing to save). `value`: what
 * the input holds (text; a toggle's checked state as a boolean). A setting
 * that's Margin.app's (`closeWindows`) asks the host instead: `{ perform,
 * arg }`, its `perform` (ui/host-app.ts), which the app saves.
 * */
export function saveField(f: SettingsField | null | undefined, value: any, settings: any): { type: 'updateSettings', payload: { patch: Record<string, any> } } | { perform: 'switch.closeWindows' | 'switch.askBeforeQuit', arg: { on: boolean } } | null {
  if (!f || f.disabled) return null;
  const patch = (p: Record<string, any>) => ({ type: ('updateSettings' as 'updateSettings'), payload: { patch: p } });
  switch (f.kind) {
    case 'number': {
      const n = Number(value);
      if (String(value).trim() === '' || !Number.isFinite(n) || n < (f.min ?? -Infinity)) return null;
      const clamped = Math.min(n, f.max ?? Infinity);
      return patch({ [f.id]: f.step === 'any' ? clamped : Math.round(clamped) });
    }
    case 'toggle':
      if (typeof value !== 'boolean') return null;
      if (f.id === 'closeWindows') return { perform: 'switch.closeWindows', arg: { on: value } };
      if (f.id === 'devAskBeforeQuit') return { perform: 'switch.askBeforeQuit', arg: { on: value } }; // DEV-HOOK
      return patch({ [f.id]: value });
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
 * what's wrong, or null
 */
export function shortcutTaken(id: string, combo: string, settings: any): string | null {
  const taken = Object.entries(currentShortcuts(settings)).find(([other, value]) => other !== id && value === combo);
  return taken ? `${shortcuts.format(combo)} is already used for “${(SHORTCUT_NAMES as Record<string, string>)[taken[0]]}”.` : null;
}

/** What a button asks the background for. */
export function runField(f: SettingsField | null | undefined) {
  if (f?.id === 'wakeAll') return { type: 'wakeSleeping', payload: {} };
  if (f?.id === 'resetShortcuts') return { type: 'updateSettings', payload: { patch: { sidebarShortcut: 'Alt+KeyS', shortcuts: { ...shortcuts.NAVIGATION } } } };
  return null;
}

/** What Wake all says once it's answered. */
export const wokeText = (woke: any) => (typeof woke !== 'number' ? 'Couldn’t reach Margin.' : woke ? `Woke ${woke} tab${woke === 1 ? '' : 's'}.` : 'No tabs are asleep.');
