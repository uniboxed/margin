import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS, buildTo, manifestFor } from '../scripts/build.js';
import '../extension/shared/platform.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const { platformProfiles: PROFILES } = globalThis.Margin;

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

test('each build is stamped with its own profile', () => {
  for (const target of TARGETS) {
    const source = readFileSync(join(root, 'dist', target, 'shared/platform.js'), 'utf8');
    assert.match(source, new RegExp(`const BUILD_TARGET = '${target}';`));
  }
  assert.equal(PROFILES.safari.fetchFavicons, true, 'Safari gives no tab.favIconUrl');
  assert.equal(PROFILES.chrome.fetchFavicons, false, 'Chrome provides tab.favIconUrl');
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
  test(`${target}: manifest commands are valid there and match the profile's default shortcuts`, () => {
    const { commands } = manifestFor(target);
    const withKeys = Object.entries(commands).filter(([, c]) => c.suggested_key);
    assert.ok(withKeys.length <= 4, 'browsers allow at most 4 commands with a shortcut');
    for (const [name, c] of withKeys) {
      const spec = c.suggested_key.mac;
      assert.ok(webkitShortcut(spec), `${name}: Safari would drop "${spec}"`);
      if (target === 'chrome') assert.ok(chromeAccepts(spec) && chromeAccepts(c.suggested_key.default), `${name}: Chrome refuses "${spec}"`);
    }
    const { navigation } = PROFILES[target];
    assert.deepEqual(Object.keys(navigation).sort(), Object.keys(ACTIONS).sort());
    for (const [setting, command] of Object.entries(ACTIONS)) {
      assert.deepEqual(webkitShortcut(commands[command].suggested_key.mac), fromSetting(navigation[setting]), `${target} ${setting}`);
    }
  });
}

test('safari: tabs on ⌘⌥↓/↑, spaces on ⌃⌘→/← (Safari keeps ⌘⌥←/→ for itself)', () => {
  const { commands } = manifestFor('safari');
  assert.equal(commands['next-tab'].suggested_key.mac, 'Command+Alt+Down');
  assert.equal(commands['prev-tab'].suggested_key.mac, 'Command+Alt+Up');
  for (const c of ['next-space', 'prev-space']) assert.doesNotMatch(commands[c].suggested_key.mac, /Alt/);
});

test('the validators agree with what was verified by hand', () => {
  assert.equal(chromeAccepts('Command+Alt+Down'), false, 'Chrome refused this (extension failed to load)');
  assert.equal(chromeAccepts('Ctrl+Alt+Down'), false);
  assert.equal(chromeAccepts('MacCtrl+Command+Down'), true);
  assert.ok(webkitShortcut('Command+Alt+Down'));
  assert.equal(webkitShortcut('Command+Alt+Shift+Down'), null, 'WebKit: at most 3 parts');
  assert.equal(webkitShortcut('Hyper+Down'), null);
});
