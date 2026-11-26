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
import * as S from '../../../extension/shared/search.ts';
import * as shortcuts from '../../../extension/shared/shortcuts.ts';
import { APP_KEYS, appKeysFor, appKeyValue, combosOf, formatAppKey, isAppKey, isDigitKey } from '../../../extension/shared/app-keys.ts';
import { siteList } from '../../../extension/shared/sleep.ts';
import { PACKAGE_THEMES, PACKAGE_THEME_NAMES, USER_THEME_ID } from './themes/packages.ts';
import { settingValueOk } from './theme-schema.ts';
import { SETTINGS_CATEGORY_IDS } from './actions.ts';
import { FEEDBACK_NAMES, FEEDBACK_SETTINGS, feedbackSetting } from './picker/feedback.ts';

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
// Margin.app's own keys (shared/app-keys.ts: Settings' `appKeys`), under their own heading; each can be turned off.
// The numbered ones: a combination with a digit, its modifiers for 1 to 9.
export const APP_SHORTCUT_FIELDS = Object.freeze({
  focusAddress: 'Edit the address',
  copyUrl: 'Copy the address',
  togglePin: 'Pin or unpin the tab',
  reopenArchived: 'Reopen the last archived tab',
  littleArc: 'Open a Quick Tab', // (the stored key keeps its first name: settings.appKeys.littleArc)
  addSplit: 'Add a split view',
  spaceDigits: 'Go to space 1–9',
  itemDigits: 'Go to favorite, pin or tab 1–9',
});
const SHORTCUT_NAMES = Object.freeze({ newTab: 'New tab (the command palette)', ...SHORTCUT_FIELDS, ...APP_SHORTCUT_FIELDS });
export const SHORTCUT_HELP = 'Click a field, then press a key with ⌘, ⌥, ⌃ or ⇧. Esc cancels; Delete turns off one of Margin.app’s keys. If a combination shows nothing when you press it, Safari or macOS keeps it for itself (⌘⌥← / ⌘⌥→ switch Safari\'s tabs), so pick another.';

/** Every shortcut now: the palette's fixed ⌘T and the ones from Settings. */
export function currentShortcuts(settings: any) {
  return {
    newTab: 'Meta+KeyT', // fixed: the palette's key (content/palette.js installNewTabKey)
    sidebarShortcut: settings?.sidebarShortcut ?? 'Alt+KeyS',
    ...shortcuts.navigationFor(settings),
  };
}

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
 * (`features`: shared/capabilities.ts's sleepTabs ('close', 'discard' or false), blockGestures,
 * marginFullscreen, newTabHint, search; importThemes and userThemes, Margin.app's imported themes)
 * and the form's own state (`ui`: the
 * shortcut being recorded, the statuses, the active theme: its id, name and theme.json settings).
 * */
export function settingsFields(settings: any, features: any = {}, ui: { recording?: string | null, status?: Record<string, { text: string, error?: boolean } | undefined>, theme?: { id: string, name: string, settings: Record<string, any> } | null, spaceTheme?: string | null, airTraffic?: { rules?: unknown, spaces?: unknown } | null } = {}): SettingsField[] {
  const s = settings ?? {};
  const f = features ?? {};
  const status = ui.status ?? {};
  const list: SettingsField[] = [];
  // What Margin looks like: the built-in themes, then the ones imported (Margin.app's: `features.userThemes`). With a
  // space shown (`spaceTheme`: the theme it's drawn with, ui/space-theme.ts), its theme: each space has its own
  // (2026-11-20); else the profile's.
  const imported = userThemeList(f.userThemes);
  const known = (id: unknown) => PACKAGE_THEMES.includes(id as string) || imported.some((t) => t.id === id);
  const spaced = ui.spaceTheme != null;
  const chosen = spaced ? ui.spaceTheme : s.theme;
  const theme = known(chosen) ? chosen : PACKAGE_THEMES[0];
  const options = [...PACKAGE_THEMES.map((id) => ({ id, label: (PACKAGE_THEME_NAMES as Record<string, string>)[id] ?? id })), ...imported.map((t) => ({ id: t.id, label: t.name || t.id }))];
  list.push(field({ id: 'theme', kind: 'choice', label: spaced ? 'Theme of this space' : 'Theme', help: spaced ? 'Each space has its own theme. New spaces start with the theme of the space they’re made from.' : '', options: options.map((o) => ({ ...o, selected: o.id === theme })), value: theme, status: status.theme?.text ?? '', error: !!status.theme?.error }));
  list.push(...importFields(f, status, imported));
  list.push(...storeFields(f, status));
  // Edit Theme Color's ticks (M2.9 step 6, ui/picker/feedback.ts): haptics only where Margin.app plays them (`haptics`:
  // its own window, on the Mac), a click anywhere.
  const feedbackChoices = FEEDBACK_SETTINGS.filter((v) => v !== 'haptics' || f.haptics);
  const feedback = feedbackChoices.includes(feedbackSetting(s.pickerFeedback)) ? feedbackSetting(s.pickerFeedback) : 'auto';
  list.push(field({
    id: 'pickerFeedback', kind: 'choice', label: 'Edit Theme Color’s ticks',
    help: f.haptics ? 'As you turn its dial or drag its sliders: haptics on a Force Touch trackpad, a soft click with a mouse.' : 'As you turn its dial or drag its sliders: a soft click.',
    value: feedback,
    options: feedbackChoices.map((id) => ({ id, label: f.haptics || id !== 'auto' ? FEEDBACK_NAMES[id] : 'Automatic: a click', selected: id === feedback })),
  }));
  list.push(field({ id: 'engine', kind: 'info', label: engineText(s, f) }));
  const favScope = s.favoritesScope === 'profile' ? 'profile' : 'global';
  list.push(field({
    id: 'favoritesScope',
    kind: 'choice',
    label: 'Favorites scope',
    help: 'Show the same Favorites across all Spaces, or keep separate Favorites per browser profile.',
    value: favScope,
    options: [
      { id: 'global', label: 'Global across Spaces', selected: favScope === 'global' },
      { id: 'profile', label: 'Per browser profile', selected: favScope === 'profile' },
    ],
  }));
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
  list.push(field({ id: 'autoPeekPins', kind: 'toggle', label: 'Open external links from Pinned tabs and Favorites in a preview', checked: s.autoPeekPins !== false }));
  if (f.newTabHint) list.push(field({ id: 'newTabHint', kind: 'toggle', label: 'Tell me when a new tab seems to open Safari’s homepage instead of Margin (Safari Settings › General › “New tabs open with” should be Margin)', checked: s.newTabHint !== false }));
  list.push(...airTrafficFields(ui.airTraffic ?? null));
  // The active theme's own settings: after Margin's, under their own heading, so they don't read as Margin's.
  list.push(...themeOwnFields(s, ui.theme ?? null));
  // Keyboard shortcuts: recorded by pressing them.
  list.push(field({ id: 'shortcuts', kind: 'group', label: 'Keyboard shortcuts' }));
  const keys = currentShortcuts(s);
  for (const [id, label] of Object.entries(SHORTCUT_FIELDS)) {
    const recording = ui.recording === id;
    list.push(field({ id, kind: 'shortcut', label, value: recording ? '' : shortcuts.format(keys[id]), recording, placeholder: 'Press keys…' }));
  }
  list.push(field({ id: 'appShortcuts', kind: 'group', label: 'Margin.app' }));
  const app = appKeysFor(s);
  for (const [id, label] of Object.entries(APP_SHORTCUT_FIELDS)) {
    const recording = ui.recording === id;
    const combo = app[id as keyof typeof app];
    list.push(field({ id, kind: 'shortcut', label, value: recording ? '' : formatAppKey(id, combo), recording, placeholder: recording ? (isDigitKey(id) ? 'Press keys with a digit…' : 'Press keys…') : 'Off' }));
  }
  list.push(field({ id: 'resetShortcuts', kind: 'button', label: 'Reset shortcuts', status: status.shortcuts?.text ?? SHORTCUT_HELP, error: !!status.shortcuts?.error }));
  return list;
}

// ---- the Settings tab's categories (Margin.app's margin://settings, the new-tab page's #settings) ----------

/**
 * Settings as its own page, as macOS's System Settings: a sidebar of categories, the chosen one's fields beside it
 * (decided by Tirth, 2026-11-20). Every field is in one; a theme that draws the categories (it reads `settingsTab`)
 * gets the chosen one's fields only, any other theme the whole form.
 */
export const SETTINGS_CATEGORIES = Object.freeze([
  { id: 'appearance', label: 'Appearance', help: 'The theme Margin is drawn with, and its own settings.' },
  // Margin.app only (`features.themeStore`): view-model.ts leaves it out elsewhere.
  { id: 'themes', label: 'Themes', help: 'Themes other people made: try one in your window before you install it.' },
  { id: 'tabs', label: 'Tabs', help: 'When tabs are archived or put to sleep.' },
  { id: 'browsing', label: 'Browsing', help: 'Searches, gestures and pages.' },
  { id: 'keyboard', label: 'Keyboard', help: 'Shortcuts for Margin’s sidebar, tabs and spaces.' },
] as const);
export type SettingsCategory = typeof SETTINGS_CATEGORIES[number]['id'];
export { SETTINGS_CATEGORY_IDS } from './actions.ts'; // (the same ids, in this order: tests/settings-form.test.ts)
export const DEFAULT_CATEGORY: SettingsCategory = 'appearance';
const TABS_FIELDS = new Set(['favoritesScope', 'archiveAfterHours', 'sleepAfterHours', 'neverSleepSites', 'wakeAll']);
const BROWSING_FIELDS = new Set(['engine', 'blockGestures', 'swipeNavigation', 'pullToRefresh', 'marginFullscreenAuto', 'fullscreenOnly', 'frameWhenHidden', 'autoPeekPins', 'newTabHint']);
const KEYBOARD_FIELDS = new Set(['shortcuts', ...Object.keys(SHORTCUT_FIELDS), 'appShortcuts', ...Object.keys(APP_SHORTCUT_FIELDS), 'resetShortcuts']);

/** The category a field is in (one of SETTINGS_CATEGORIES'): Appearance for the themes' fields and any field not listed. */
export function categoryOf(id: string): SettingsCategory {
  if (STORE_FIELDS.has(id) || STORE_PREFIXES.some((p) => id.startsWith(p))) return 'themes';
  if (TABS_FIELDS.has(id)) return 'tabs';
  if (BROWSING_FIELDS.has(id)) return 'browsing';
  if (KEYBOARD_FIELDS.has(id)) return 'keyboard';
  if (id === AIR_TRAFFIC_GROUP || id === AIR_TRAFFIC_NONE || id.startsWith(AIR_TRAFFIC_TOGGLE) || id.startsWith(AIR_TRAFFIC_REMOVE)) return 'browsing';
  return 'appearance';
}

// ---- Link Rules (state.airTraffic, its stored name: shared/air-traffic.ts) ---------------------------------
// Each rule: a toggle (on routes the links it matches to its space; off, kept but not used) and Remove. Made in a
// tab's menu ("Always Open <site> in This Space"), which also removes the one routing that tab's address.
const AIR_TRAFFIC_GROUP = 'linkRules';
const AIR_TRAFFIC_NONE = 'linkRulesNone';
const AIR_TRAFFIC_TOGGLE = 'linkRule:';
const AIR_TRAFFIC_REMOVE = 'removeLinkRule:';
const RULE_ID = /^[A-Za-z0-9_:-]{1,64}$/;

function airTrafficFields(given: { rules?: unknown, spaces?: unknown } | null) {
  if (!given) return [];
  const spaces = Array.isArray(given.spaces) ? given.spaces : [];
  const rules = (Array.isArray(given.rules) ? given.rules : [])
    .filter((r) => r && typeof r.id === 'string' && RULE_ID.test(r.id) && typeof r.pattern === 'string')
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0)).slice(0, 100);
  const out: SettingsField[] = [field({ id: AIR_TRAFFIC_GROUP, kind: 'group', label: 'Link Rules' })];
  if (!rules.length) {
    out.push(field({ id: AIR_TRAFFIC_NONE, kind: 'info', label: 'No rules yet. To open a site’s links in one space, choose “Always Open <site> in This Space” in a tab’s menu.' }));
    return out;
  }
  for (const r of rules) {
    const sp = spaces.find((x: any) => x?.id === r.spaceId);
    const where = sp ? `${themeText(sp.emoji, 8)} ${themeText(sp.name, 40)}`.trim() : 'a space that’s gone';
    const pattern = themeText(r.pattern, 200);
    out.push(field({ id: `${AIR_TRAFFIC_TOGGLE}${r.id}`, kind: 'toggle', label: `Open ${pattern} in ${where}`, checked: r.enabled !== false }));
    out.push(field({ id: `${AIR_TRAFFIC_REMOVE}${r.id}`, kind: 'button', label: `Remove rule for ${pattern}` }));
  }
  return out;
}

/** A category asked for (the UI's `settingsCategory`), else the first. */
export const categoryNamed = (id: unknown): SettingsCategory => (typeof id === 'string' && SETTINGS_CATEGORY_IDS.includes(id) ? id as SettingsCategory : DEFAULT_CATEGORY);

/** One category's fields, in the form's order. Keyboard's own heading ("Keyboard shortcuts") goes: the page's title says it. */
export function fieldsIn(fields: SettingsField[], category: SettingsCategory): SettingsField[] {
  return fields.filter((f) => categoryOf(f.id) === category && !(category === 'keyboard' && f.id === 'shortcuts'));
}

// ---- themes: imported ones, and the active theme's own settings ---------------

// A theme's own words (its name, author, a setting's label) inside Margin's
// form: capped, and with no characters that reorder or hide text.
const INVISIBLE = /[\u0000-\u001f\u007f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
export const themeText = (text: unknown, max: number) => { const t = String(text ?? '').replace(INVISIBLE, '').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

/** Margin.app's index of imported themes, as Settings shows it. */
export function userThemeList(list: unknown) {
  return (Array.isArray(list) ? list : []).filter((e) => e && typeof e.id === 'string' && USER_THEME_ID.test(e.id) && !PACKAGE_THEMES.includes(e.id)).slice(0, 50)
    .map((e) => ({ id: e.id, name: themeText(e.name, 40), version: themeText(e.version, 16), author: themeText(e.author, 40), linked: e.linked === true, store: !!e.store && typeof e.store === 'object' }));
}

const SETTING_PREFIX = 'themeSetting:';
const REMOVE_PREFIX = 'removeTheme:';
/** Unlink “Name” (a theme loaded unpacked: its folder followed no more). */
export const UNLINK_PREFIX = 'unlinkTheme:';

/**
 * Import Theme… and Load Unpacked… (Margin.app only: `features.importThemes`) and each imported theme with Remove (a
 * linked one, loaded unpacked, with Unlink too), under the theme choice.
 */
function importFields(f: Record<string, any>, status: Record<string, { text: string; error?: boolean; } | undefined>, imported: { id: any; name: string; version: string; author: string; linked?: boolean; store?: boolean; }[]) {
  const out: SettingsField[] = [];
  if (!f.importThemes) return out;
  // What each one does, under its button as a line of its own (every theme draws an info line; a button's status is
  // replaced by what happened): a copy taken once, or a folder followed while a theme is made.
  out.push(field({ id: 'themeImport', kind: 'button', label: 'Import Theme…', status: status.themeImport?.text ?? '', error: !!status.themeImport?.error }));
  out.push(field({ id: 'themeImportAbout', kind: 'info', label: 'Adds a copy of a theme, from a .margintheme file or a folder, to use as it is. Later changes to the original don’t reach the copy: import it again to update it.' }));
  out.push(field({ id: 'themeLink', kind: 'button', label: 'Load Unpacked…', status: status.themeLink?.text ?? '', error: !!status.themeLink?.error }));
  out.push(field({ id: 'themeLinkAbout', kind: 'info', label: 'For making or editing a theme: links its folder instead of copying it. Each time you save a file in it, Margin checks the theme and draws it again. Unlink stops following the folder.' }));
  const rows = storeRows(f.themeStore);
  for (const t of imported) {
    // Where it came from: the theme store (an update said when its list has one), a folder followed, or a copy.
    const newer = t.store ? rows.find((r) => r.id === t.id && r.state === 'update') : null;
    const source = t.store ? ` · from the theme store${newer ? `, ${newer.version} is in Themes` : ''}` : t.linked ? ' · linked to its folder' : ' · a copy';
    out.push(field({ id: `userTheme:${t.id}`, kind: 'info', label: `“${t.name || t.id}” ${t.version}${t.author ? ` · by ${t.author}` : ''}${source}` }));
    if (t.linked) out.push(field({ id: `${UNLINK_PREFIX}${t.id}`, kind: 'button', label: `Unlink “${t.name || t.id}”` }));
    // One of the person's own (a copy or linked: never one from the store) can be shared to the store.
    if (f.themeStore && !t.store) out.push(field({ id: `${THEME_SHARE}${t.id}`, kind: 'button', label: `Share “${t.name || t.id}”…`, status: status[`${THEME_SHARE}${t.id}`]?.text ?? '', error: !!status[`${THEME_SHARE}${t.id}`]?.error }));
    out.push(field({ id: `${REMOVE_PREFIX}${t.id}`, kind: 'button', label: `Remove “${t.name || t.id}”` }));
  }
  return out;
}

// ---- the theme store (Margin.app: docs/THEME-STORE.md §4) -------------------------------------------------
// Settings' Themes: the store's themes (Margin.app checked its list's signature and says what each is to this install:
// `features.themeStore`, `{ state, rows, message }`), each with Try (it's downloaded and previewed like an import, and
// Use Theme in the preview's bar installs it), Update, and Report. Every word is Margin's; a theme's name, author and
// description are the store's, cleaned.
export const STORE_TRY = 'storeTry:';
export const STORE_REPORT = 'storeReport:';
export const THEME_SHARE = 'themeShare:';
const STORE_FIELDS = new Set(['storeGroup', 'storeAbout', 'storeRefresh']);
const STORE_PREFIXES = ['storeTheme:', 'storeText:', STORE_TRY, STORE_REPORT];
const STORE_MAX = 200;
const STORE_STATES = ['install', 'installed', 'update', 'yours'];

/** The store's rows as Margin.app sent them, each checked and its texts cleaned. */
export function storeRows(store: unknown) {
  const rows = (store as { rows?: unknown } | null)?.rows;
  return (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.id === 'string' && USER_THEME_ID.test(r.id) && !PACKAGE_THEMES.includes(r.id) && STORE_STATES.includes(r.state)).slice(0, STORE_MAX)
    .map((r) => ({
      id: r.id as string, name: themeText(r.name, 60) || r.id, version: themeText(r.version, 16), author: themeText(r.author, 40), authorKey: /^[0-9a-f]{8}$/.test(r.authorKey) ? r.authorKey as string : '',
      description: themeText(r.description, 280), state: r.state as string, installedVersion: themeText(r.installedVersion, 16),
    }));
}

function storeFields(f: Record<string, any>, status: Record<string, { text: string; error?: boolean; } | undefined>) {
  const out: SettingsField[] = [];
  if (!f.themeStore) return out;
  const store = f.themeStore && typeof f.themeStore === 'object' ? f.themeStore : {};
  const rows = storeRows(store);
  out.push(field({ id: 'storeGroup', kind: 'group', label: 'The theme store' }));
  out.push(field({ id: 'storeAbout', kind: 'info', label: 'Themes other people made. Try draws one in your window first, and Use Theme in its bar installs it. Margin checks each one as it checks a theme you import: a theme runs no code and loads nothing from outside itself.' }));
  const said = store.state === 'ready' ? (rows.length ? `${rows.length} ${rows.length === 1 ? 'theme' : 'themes'}.` : 'No themes yet.')
    : store.state === 'closed' ? 'The theme store isn’t open yet.'
    : store.state === 'error' ? themeText(store.message, 300) || 'Margin couldn’t read the theme store’s list.'
    : 'Loading the store’s themes…';
  out.push(field({ id: 'storeRefresh', kind: 'button', label: 'Refresh', status: status.storeRefresh?.text ?? said, error: status.storeRefresh ? !!status.storeRefresh.error : store.state === 'error' }));
  for (const r of rows) {
    const by = `${r.author ? ` · by ${r.author}` : ''}${r.authorKey ? ` (${r.authorKey})` : ''}`;
    const state = r.state === 'installed' ? ' · installed' : r.state === 'update' ? ` · ${r.installedVersion} installed` : r.state === 'yours' ? ' · you have a theme of your own with this id' : '';
    out.push(field({ id: `storeTheme:${r.id}`, kind: 'info', label: `“${r.name}” ${r.version}${by}${state}` }));
    if (r.description) out.push(field({ id: `storeText:${r.id}`, kind: 'info', label: r.description }));
    const tryLabel = r.state === 'update' ? `Update “${r.name}” to ${r.version}` : r.state === 'install' ? `Try “${r.name}”` : null;
    if (tryLabel) out.push(field({ id: `${STORE_TRY}${r.id}`, kind: 'button', label: tryLabel, status: status[`${STORE_TRY}${r.id}`]?.text ?? '', error: !!status[`${STORE_TRY}${r.id}`]?.error }));
    if (r.state !== 'yours') out.push(field({ id: `${STORE_REPORT}${r.id}`, kind: 'button', label: `Report “${r.name}”…`, status: status[`${STORE_REPORT}${r.id}`]?.text ?? '', error: !!status[`${STORE_REPORT}${r.id}`]?.error }));
  }
  return out;
}

/** The reasons a report gives, as the store takes them (cloud/themes/src/store.ts REPORT_REASONS). */
export const REPORT_REASONS = Object.freeze([
  { id: 'broken', label: 'It’s broken' },
  { id: 'offensive', label: 'It’s offensive' },
  { id: 'impersonation', label: 'It pretends to be another' },
  { id: 'copied', label: 'It’s copied' },
]);

/** Report “Name”… and Share “Name”… ask first, in Margin's prompt: why, or whether. */
export function storePrompt(fieldId: string, features: Record<string, any>) {
  if (fieldId.startsWith(STORE_REPORT)) {
    const id = fieldId.slice(STORE_REPORT.length);
    const r = storeRows(features?.themeStore).find((x) => x.id === id);
    if (!r) return null;
    return {
      id: `report-theme:${id}`,
      title: `Report “${r.name}”`,
      text: 'What’s wrong with it? Reports from three different places hide a theme until it’s reviewed.',
      actions: [...REPORT_REASONS.map((x) => ({ id: x.id, label: x.label })), { id: 'cancel', label: 'Cancel' }],
    };
  }
  if (fieldId.startsWith(THEME_SHARE)) {
    const id = fieldId.slice(THEME_SHARE.length);
    const t = userThemeList(features?.userThemes).find((e) => e.id === id && !e.store);
    if (!t) return null;
    return {
      id: `share-theme:${id}`,
      title: `Share “${t.name || t.id}”`,
      text: `Margin uploads it to the theme store as it is now, with its author${t.author ? `, “${t.author}”,` : ''} from its theme.json and an anonymous key of this Mac’s. It’s reviewed before others can find it.`,
      actions: [{ id: 'share', label: 'Share', primary: true }, { id: 'cancel', label: 'Cancel' }],
    };
  }
  return null;
}

/** A Settings line a theme store answer may go to: a store theme's Try or Report, one of the person's Share. */
export const storeKey = (key: unknown): key is string => typeof key === 'string' && /^(storeTry|storeReport|themeShare):[a-z0-9][a-z0-9-]{0,40}$/.test(key);

/** What a theme store request came to, in Margin's words: the store's own on a refusal (capped by the app). */
export function storeWords(msg: { key?: string, ok?: boolean, message?: unknown, data?: any }): { text: string, error: boolean } {
  const theirs = typeof msg.message === 'string' && msg.message.trim() ? msg.message.slice(0, 300) : null;
  if (!msg.ok) return { text: theirs ?? 'The theme store didn’t answer: try again later.', error: true };
  const d = msg.data && typeof msg.data === 'object' ? msg.data : {};
  if (String(msg.key).startsWith('storeReport:')) return { text: d.again ? 'You reported it already.' : 'Reported. Thank you: the store’s review looks at it.', error: false };
  if (String(msg.key).startsWith('themeShare:')) {
    const version = typeof d.version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(d.version) ? ` ${d.version}` : '';
    if (d.status === 'published') return { text: `Shared${version}: others can find it in Themes now.`, error: false };
    if (d.status === 'rejected') return { text: `This version${version} was shared before, and review didn’t take it: raise its version in its theme.json to share it again.`, error: true };
    return { text: `Shared${version}: it’s waiting for review before others can find it.`, error: false };
  }
  return { text: '', error: false };
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
 * the input holds (text; a toggle's checked state as a boolean).
 * */
export function saveField(f: SettingsField | null | undefined, value: any, settings: any): { type: 'updateSettings', payload: { patch: Record<string, any> } } | { type: 'toggleAirTrafficRule', payload: { ruleId: string, enabled: boolean } } | null {
  if (!f || f.disabled) return null;
  const patch = (p: Record<string, any>) => ({ type: ('updateSettings' as 'updateSettings'), payload: { patch: p } });
  // A link rule turned on or off (the rule, not a setting).
  if (f.kind === 'toggle' && f.id.startsWith(AIR_TRAFFIC_TOGGLE)) {
    const ruleId = f.id.slice(AIR_TRAFFIC_TOGGLE.length);
    return typeof value === 'boolean' && RULE_ID.test(ruleId) ? { type: 'toggleAirTrafficRule' as const, payload: { ruleId, enabled: value } } : null;
  }
  switch (f.kind) {
    case 'number': {
      const n = Number(value);
      if (String(value).trim() === '' || !Number.isFinite(n) || n < (f.min ?? -Infinity)) return null;
      const clamped = Math.min(n, f.max ?? Infinity);
      return patch({ [f.id]: f.step === 'any' ? clamped : Math.round(clamped) });
    }
    case 'toggle':
      if (typeof value !== 'boolean') return null;
      return patch({ [f.id]: value });
    case 'choice': return f.options.some((o) => o.id === value) && value !== f.value ? patch({ [f.id]: value }) : null;
    case 'list': return f.id === 'neverSleepSites' ? patch({ neverSleepSites: siteList(String(value ?? '')) }) : null;
    case 'shortcut': {
      const combo = String(value ?? '');
      // Margin.app's keys: '' turns one off; a numbered one's digit stands for 1–9.
      if (isAppKey(f.id)) {
        const v = appKeyValue(f.id, combo);
        return v == null ? null : patch({ appKeys: { ...appKeysFor(settings), [f.id]: v } });
      }
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
  // (A numbered key stands for nine combinations: any of them taken is.)
  const mine = isAppKey(id) ? combosOf(id, appKeyValue(id, combo) ?? '') : [combo];
  const all: [string, string[]][] = [
    ...(Object.entries(currentShortcuts(settings)) as [string, string][]).map(([k, v]): [string, string[]] => [k, [v]]),
    ...(Object.entries(appKeysFor(settings)) as [string, string][]).map(([k, v]): [string, string[]] => [k, combosOf(k, v)]),
  ];
  const taken = all.find(([other, values]) => other !== id && values.some((v) => mine.includes(v)));
  return taken ? `${shortcuts.format(combo)} is already used for “${(SHORTCUT_NAMES as Record<string, string>)[taken[0]]}”.` : null;
}

/** What a button asks the background for. */
export function runField(f: SettingsField | null | undefined) {
  if (f?.id === 'wakeAll') return { type: 'wakeSleeping', payload: {} };
  if (f?.id === 'resetShortcuts') return { type: 'updateSettings', payload: { patch: { sidebarShortcut: 'Alt+KeyS', shortcuts: { ...shortcuts.NAVIGATION }, appKeys: { ...APP_KEYS } } } };
  if (f?.isButton && f.id.startsWith(AIR_TRAFFIC_REMOVE)) {
    const ruleId = f.id.slice(AIR_TRAFFIC_REMOVE.length);
    return RULE_ID.test(ruleId) ? { type: 'removeAirTrafficRule', payload: { ruleId } } : null;
  }
  return null;
}

/** What Wake all says once it's answered. */
export const wokeText = (woke: any) => (typeof woke !== 'number' ? 'Couldn’t reach Margin.' : woke ? `Woke ${woke} tab${woke === 1 ? '' : 's'}.` : 'No tabs are asleep.');
