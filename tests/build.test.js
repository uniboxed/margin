import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILES } from '../extension/shared/platform.js';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_SHELL_FILES, TARGETS, buildTo, manifestFor } from '../scripts/build.js';
import { THEMES } from '../extension/themes/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));

const listFiles = (dir, prefix = '') => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? listFiles(path, `${prefix}${name}/`) : [`${prefix}${name}`];
}).sort();

test('dist/ is up to date with extension/ and platform/ (run `npm run build`)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'margin-build-'));
  try {
    for (const target of TARGETS) {
      const fresh = buildTo(join(tmp, target), { profile: target });
      const committed = join(root, 'dist', target);
      assert.deepEqual(listFiles(committed), listFiles(fresh), `dist/${target}: file list`);
      for (const f of listFiles(fresh)) {
        assert.ok(readFileSync(join(committed, f)).equals(readFileSync(join(fresh, f))), `dist/${target}/${f} is stale`);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('each build loads one bundled script per context', () => {
  for (const target of TARGETS) {
    const dir = join(root, 'dist', target);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.content_scripts[0].js, ['content/content.bundle.js'], target);
    // background/tabs.js injectIntoOpenTabs finds the sidebar's entry this way.
    assert.deepEqual(manifest.content_scripts.find((c) => c.world !== 'MAIN').js, ['content/content.bundle.js'], target);
    assert.equal(manifest.background.service_worker, 'background.bundle.js', target);
    const background = readFileSync(join(dir, 'background.bundle.js'), 'utf8');
    assert.match(background, /\["content\/shell\.bundle\.js"\]/, `${target}: the background registers the shell bundle`);
    assert.doesNotMatch(background, /importScripts\(/, `${target}: nothing left to import`);
    const scripts = [...readFileSync(join(dir, 'newtab/newtab.html'), 'utf8').matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(scripts, ['newtab.bundle.js'], target);
    for (const file of ['content/content.bundle.js', 'content/shell.bundle.js', 'newtab/newtab.bundle.js']) assert.ok(statSync(join(dir, file)).size > 0, `${target}/${file}`);
    // The fitted layout's page-world part: the card's setup, and only in
    // Chrome the writer (Safari never has it listening).
    assert.deepEqual(manifest.content_scripts.find((c) => c.world === 'MAIN').js, ['content/shell-main.bundle.js'], target);
    const main = readFileSync(join(dir, 'content/shell-main.bundle.js'), 'utf8');
    assert.match(main, /margin-page-ready/, `${target}: the card setup`);
    assert.equal(/margin-shell-write/.test(main), target === 'chrome', `${target}: the writer only in Chrome`);
    // Each theme: a content bundle the background registers ('margin-theme',
    // the path from theme.js) and a new-tab module exporting mount().
    assert.match(background, /margin-theme/, `${target}: the background registers the theme`);
    for (const theme of Object.values(THEMES)) {
      assert.ok(background.includes(JSON.stringify(theme.content)), `${target}: ${theme.content} is the registered path`);
      assert.ok(statSync(join(dir, theme.content)).size > 0, `${target}/${theme.content}`);
      assert.match(readFileSync(join(dir, theme.newtab), 'utf8'), /export\s*\{[^}]*\bmount\b/, `${target}/${theme.newtab} exports mount`);
    }
    // Safari drops every registered script if a file one lists is missing, so
    // the sources an earlier version registered must still be there.
    for (const file of LEGACY_SHELL_FILES) assert.ok(statSync(join(dir, file)).isFile(), `${target}/${file}`);
  }
});

test('each build is stamped with its own profile', () => {
  for (const target of TARGETS) {
    const source = readFileSync(join(root, 'dist', target, 'shared/platform.js'), 'utf8');
    assert.match(source, new RegExp(`const BUILD_TARGET = '${target}';`));
  }
  assert.equal(PROFILES.safari.fetchFavicons, true, 'Safari gives no tab.favIconUrl');
  assert.equal(PROFILES.chrome.fetchFavicons, false, 'Chrome provides tab.favIconUrl');
  assert.equal(PROFILES.safari.prepareSidebar, true, 'Safari prepares a hidden destination before its web view is swapped in');
  assert.equal(PROFILES.chrome.prepareSidebar, false, 'Chrome keeps its hidden tab frame without the extra handoff');
});

// The rules of WebKit's parseCommandShortcut (Safari's command loading): 2–3
// parts, the last one the key; modifiers Command/Ctrl (⌘), Alt (⌥), MacCtrl
// (⌃), Shift; at most 4 commands with a shortcut. An invalid shortcut drops
// just that command. The key list is the subset Margin could plausibly use.
const WEBKIT_MODIFIERS = { Command: '⌘', Ctrl: '⌘', Alt: '⌥', MacCtrl: '⌃', Shift: '⇧' };
const WEBKIT_KEYS = /^([A-Z0-9]|F([1-9]|1[0-2])|Comma|Period|Home|End|PageUp|PageDown|Space|Insert|Delete|Up|Down|Left|Right)$/;
function webkitShortcut(spec) {
  const parts = spec.split('+');
  if (parts.length < 2 || parts.length > 3) return null;
  const key = parts.pop();
  if (!WEBKIT_KEYS.test(key)) return null;
  const mods = parts.map((p) => WEBKIT_MODIFIERS[p]);
  if (mods.some((m) => !m) || new Set(mods).size !== mods.length) return null;
  if (mods.every((m) => m === '⇧')) return null; // Shift alone isn't a shortcut
  return { mods: new Set(mods), key };
}

// Chrome refuses Command+Alt / Ctrl+Alt in manifest commands (verified: the
// whole extension then fails to load, even when the key is only under "ios").
function chromeAccepts(spec) {
  const parts = spec.split('+');
  if (parts.includes('Alt') && (parts.includes('Command') || parts.includes('Ctrl'))) return false;
  return parts.length >= 2 && parts.length <= 3 && WEBKIT_KEYS.test(parts.at(-1));
}

// Settings combo (e.g. 'Alt+Meta+ArrowDown') → the manifest's mac spec, as a
// modifier set + key so the order of parts doesn't matter.
const PAGE_TO_WEBKIT = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' };
function fromSetting(combo) {
  const parts = combo.split('+');
  return { mods: new Set(parts.slice(0, -1).map((p) => PAGE_TO_WEBKIT[p])), key: parts.at(-1).replace(/^Arrow/, '') };
}

const ACTIONS = { nextTab: 'next-tab', prevTab: 'prev-tab', nextSpace: 'next-space', prevSpace: 'prev-space' };

for (const target of TARGETS) {
  test(`${target}: manifest commands load in Safari and Chrome and match the profile's shortcuts`, () => {
    const { commands } = manifestFor(target);
    const withKeys = Object.entries(commands).filter(([, c]) => c.suggested_key);
    assert.ok(withKeys.length <= 4, 'browsers allow at most 4 commands with a shortcut');
    for (const [name, c] of withKeys) {
      const spec = c.suggested_key.mac;
      assert.ok(webkitShortcut(spec), `${name}: Safari would drop "${spec}"`);
      assert.ok(chromeAccepts(spec) && chromeAccepts(c.suggested_key.default), `${name}: Chrome refuses "${spec}"`);
    }
    const { navigation } = PROFILES[target];
    assert.deepEqual(Object.keys(navigation).sort(), Object.keys(ACTIONS).sort());
    // Safari's tab shortcuts are page-only extras (⌥⌘↓/↑, test below), and
    // its previous space (⌃⌘←) is page-only too: ⌘T has its command slot.
    const shared = target === 'safari' ? ['nextSpace'] : Object.keys(ACTIONS);
    for (const setting of shared) {
      assert.deepEqual(webkitShortcut(commands[ACTIONS[setting]].suggested_key.mac), fromSetting(navigation[setting]), `${target} ${setting}`);
    }
  });
}

test('safari: ⌥⌘↓/↑ page shortcuts for tabs, on top of the ⌃⌘ commands', () => {
  const { navigation } = PROFILES.safari;
  assert.equal(navigation.nextTab, 'Alt+Meta+ArrowDown');
  assert.equal(navigation.prevTab, 'Alt+Meta+ArrowUp');
  const { commands } = manifestFor('safari');
  for (const c of Object.values(ACTIONS).filter((a) => a !== 'prev-space')) assert.match(commands[c].suggested_key.mac, /^MacCtrl\+Command\+(Up|Down|Left|Right)$/, c);
  assert.equal(commands['prev-space'].suggested_key, undefined, '⌘T took its slot');
});

test('the validators agree with what was verified by hand', () => {
  assert.equal(chromeAccepts('Command+Alt+Down'), false, 'Chrome refused this (extension failed to load)');
  assert.equal(chromeAccepts('Ctrl+Alt+Down'), false);
  assert.equal(chromeAccepts('MacCtrl+Command+Down'), true);
  assert.ok(webkitShortcut('Command+Alt+Down'));
  assert.equal(webkitShortcut('Command+Alt+Shift+Down'), null, 'WebKit: at most 3 parts');
  assert.equal(webkitShortcut('Hyper+Down'), null);
});

test('the `search` permission (chrome.search) is Chrome-only; Safari has no search API', () => {
  assert.ok(manifestFor('chrome').permissions.includes('search'));
  assert.ok(!manifestFor('safari').permissions.includes('search'));
  // Safari's own: nativeMessaging, for the Mac app's set-up window (background/onboarding.js).
  assert.ok(manifestFor('safari').permissions.includes('nativeMessaging'));
  assert.ok(!manifestFor('chrome').permissions.includes('nativeMessaging'));
  const base = manifestFor('safari').permissions.filter((p) => p !== 'nativeMessaging');
  assert.deepEqual(manifestFor('chrome').permissions.filter((p) => p !== 'search'), base, 'otherwise the same list');
  assert.equal(PROFILES.chrome.search, 'browser');
  assert.equal(PROFILES.safari.search, 'learn');
});
