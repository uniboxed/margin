import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PROFILES } from '../extension/shared/any-engine-profile.ts';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIST, FIRST_PAINT_THEMES, LEGACY_FILES, TARGETS, buildTo, manifestFor } from '../scripts/build.ts';
import { allLayoutFiles, firstPaintFile, layoutFiles } from '../extension/shared/page-box.ts';
import { PACKAGE_THEMES } from '../extension/themes/packages.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

const listFiles = (dir, prefix = '') => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? listFiles(path, `${prefix}${name}/`) : [`${prefix}${name}`];
}).sort();

test('dist/ is up to date with extension/ (run `npm run build`)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'margin-build-'));
  try {
    for (const target of TARGETS) {
      const fresh = buildTo(join(tmp, target), { profile: target });
      const committed = join(root, 'dist', DIST[target]);
      assert.deepEqual(listFiles(committed), listFiles(fresh), `dist/${DIST[target]}: file list`);
      for (const f of listFiles(fresh)) {
        assert.ok(readFileSync(join(committed, f)).equals(readFileSync(join(fresh, f))), `dist/${DIST[target]}/${f} is stale`);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('each build loads one bundled script per context', () => {
  for (const target of TARGETS) {
    const dir = join(root, 'dist', DIST[target]);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.content_scripts[0].js, ['content/content.bundle.js'], target);
    // background/tabs.ts injectIntoOpenTabs finds the sidebar's entry this way.
    assert.deepEqual(manifest.content_scripts.find((c) => c.world !== 'MAIN').js, ['content/content.bundle.js'], target);
    // Safari's background is a page (the link to Margin.app: background/link.ts), Chrome's a worker.
    if (target === 'safari') assert.deepEqual(manifest.background, { scripts: ['background.bundle.js'] }, target); // non-persistent: Manifest V3's default (WebKit), and Safari's converter warns on the key
    else assert.deepEqual(manifest.background, { service_worker: 'background.bundle.js' }, target);
    const background = readFileSync(join(dir, 'background.bundle.js'), 'utf8');
    assert.match(background, /content\/page\.bundle\.js/, `${target}: the background registers the page's script`);
    assert.doesNotMatch(background, /importScripts\(/, `${target}: nothing left to import`);
    const scripts = [...readFileSync(join(dir, 'newtab/newtab.html'), 'utf8').matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(scripts, ['newtab.bundle.js'], target);
    const awayScripts = [...readFileSync(join(dir, 'away/away.html'), 'utf8').matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(awayScripts, ['away.bundle.js'], `${target}: the stand-in page (background/away.ts)`);
    for (const file of ['content/content.bundle.js', 'content/page.bundle.js', 'newtab/newtab.bundle.js', 'away/away.bundle.js']) assert.ok(statSync(join(dir, file)).size > 0, `${target}/${file}`);
    // Nothing in the page's world from the manifest: a page Margin leaves
    // alone loads none of it (background/registered.ts).
    assert.equal(manifest.content_scripts.find((c) => c.world === 'MAIN'), undefined, target);
    // The first paint (background/registered.ts): every digit file of every
    // place, at.css, and each built-in theme's file.
    for (const [file, css] of allLayoutFiles()) assert.equal(readFileSync(join(dir, file), 'utf8'), css, `${target}/${file}`);
    assert.deepEqual(FIRST_PAINT_THEMES, PACKAGE_THEMES, 'every built-in theme has its first paint');
    for (const id of FIRST_PAINT_THEMES) assert.match(readFileSync(join(dir, firstPaintFile(id)), 'utf8'), new RegExp(`--margin-box-fp: ${id};[\\s\\S]*html\\[data-margin-at="${id}"\\]:not\\(#m#m#m#m#m\\) \\{[\\s\\S]*translate\\(var\\(--margin-box-at-left\\)`), `${target}: ${id}'s first paint`);
    for (const file of layoutFiles({ left: 1023.75, top: 0, right: 8.25, bottom: 999, radius: 63.75 })) assert.ok(statSync(join(dir, file)).size > 0, `${target}/${file}: there for any layout`);
    // Safari loads none of its registrations if a path one names is missing:
    // the build before Phase 3's stay, empty, until no Safari has them.
    for (const file of LEGACY_FILES) assert.equal(statSync(join(dir, file)).size, 0, `${target}/${file}: an empty stub`);
    // Each built-in theme ships as its package (read by the background for
    // Margin.app); no theme script is registered.
    for (const id of PACKAGE_THEMES) for (const f of ['theme.json', 'theme.html', 'theme.css']) assert.ok(statSync(join(dir, `themes/${id}/${f}`)).size > 0, `${target}/themes/${id}/${f}`);
    // Pages draw none of Margin's UI (Margin 2 Phase 2 step 5): the UI
    // runtime, the theme loader and the in-page host aren't in the content
    // script or the new-tab page.
    for (const file of ['content/content.bundle.js', 'newtab/newtab.bundle.js', 'away/away.bundle.js']) {
      const text = readFileSync(join(dir, file), 'utf8');
      for (const word of ['createRuntime', 'createInPageHost', 'loadTheme', 'sanitizeCss', 'attachShadow']) assert.ok(!text.includes(word), `${target}/${file}: no ${word}`);
    }
  }
});

test('each build has its own engine\'s profile and modules, and none of the other\'s', () => {
  assert.deepEqual(DIST, { safari: 'webkit', chrome: 'chromium' }, 'named by engine');
  // A function only one engine's module has: [the engine whose build has it, its name].
  const only = [['safari', 'newTabPageSeen'], ['safari', 'reportEvent'], ['chrome', 'toggleMarginFullscreen'], ['chrome', 'followFullscreen']];
  for (const target of TARGETS) {
    // (The sources aren't shipped: the profile is in the bundles.)
    const bundle = readFileSync(join(root, 'dist', DIST[target], 'background.bundle.js'), 'utf8');
    for (const name of TARGETS) assert.equal(bundle.includes(`name:"${name}"`), name === target, `${target}: ${name}'s profile`);
    for (const [owner, fn] of only) assert.equal(new RegExp(`function ${fn}\\b`).test(bundle), owner === target, `${target}: ${fn}`);
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
    // The navigation commands have no keys (Tirth, 2026-11-08: no ⌃⌘ arrows): the Settings shortcuts only.
    for (const action of Object.values(ACTIONS)) assert.equal(commands[action].suggested_key, undefined, `${target} ${action}`);
  });
}

test('safari: ⌥⌘↓/↑ for tabs and ⌥⌘→/← for spaces, no ⌃⌘ arrows anywhere', () => {
  const { navigation } = PROFILES.safari;
  assert.deepEqual(navigation, { nextTab: 'Alt+Meta+ArrowDown', prevTab: 'Alt+Meta+ArrowUp', nextSpace: 'Alt+Meta+ArrowRight', prevSpace: 'Alt+Meta+ArrowLeft' });
  const { commands } = manifestFor('safari');
  assert.ok(!JSON.stringify(commands).includes('MacCtrl+Command'), 'no ⌃⌘ command keys');
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
  // Both: nativeMessaging (Safari's extension handler; Chrome's and Edge's connector, docs/PROTOCOL.md).
  assert.ok(manifestFor('safari').permissions.includes('nativeMessaging'));
  assert.ok(manifestFor('chrome').permissions.includes('nativeMessaging'));
  assert.deepEqual(manifestFor('chrome').permissions.filter((p) => p !== 'search').sort(), manifestFor('safari').permissions.slice().sort(), 'otherwise the same list');
  assert.equal(PROFILES.chrome.search, 'browser');
  assert.equal(PROFILES.safari.search, 'learn');
});

test('Chrome\'s build: a fixed key, whose id is the one Margin.app\'s host files name (app/engines/chromium/src/lib.rs, the connector\'s)', () => {
  const key = manifestFor('chrome').key;
  assert.equal(typeof key, 'string');
  // Chrome's id from a key: the SHA-256 of its DER, its first 32 hex digits as a–p.
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  const id = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
  assert.equal(id, 'njeebbcmlenfopaecfbphgcfihbdmkec');
  assert.ok(readFileSync(new URL('../app/engines/chromium/src/lib.rs', import.meta.url), 'utf8').includes(`"${id}"`), 'the app names the same id');
  assert.equal(manifestFor('safari').key, undefined, 'Safari\'s build has none');
});
