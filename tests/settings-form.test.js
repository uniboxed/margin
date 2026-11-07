// The launcher's Settings form (extension/ui/settings-form.js): every setting
// of the form before Margin 2 (themes/arcadia/newtab.js), less keep-ready,
// the warm-up and the switch log; what each field saves, checked; the inputs
// the sanitizer allows for it; the view model and the action that run it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsFields, saveField, runField, shortcutTaken, wokeText, SHORTCUT_HELP } from '../extension/ui/settings-form.js';
import { sanitizeTemplate } from '../extension/ui/sanitize.js';
import { checkAction, contextFromState, requestFor } from '../extension/ui/actions.js';
import { buildViewModel } from '../extension/ui/view-model.js';
import { smallState, W } from './ui/fixtures.js';
import { wrap } from './theme/payloads.js';

const SAFARI = { sleepTabs: 'close', blockGestures: true, newTabHint: true, search: 'learn', marginFullscreen: false };
// A browser whose sleeping tabs stay open, discarded (Chrome, Edge: Phase 5's), with Safari's other features.
const DISCARDS = { ...SAFARI, sleepTabs: 'discard' };
const CHROME = { sleepTabs: false, blockGestures: false, newTabHint: false, search: 'browser', marginFullscreen: true };
const byId = (fields) => Object.fromEntries(fields.map((f) => [f.id, f]));

test('Settings covers today\'s form: theme, search engine, archive, sleep, never-sleep sites, gestures, frame, the ⌘T hint, shortcuts; Wake all where sleeping tabs are discarded', () => {
  const fields = settingsFields({ theme: 'arcadia', archiveAfterHours: 12, sleepAfterHours: 4, neverSleepSites: ['mail.example.com'] }, SAFARI);
  assert.deepEqual(fields.map((f) => `${f.id}:${f.kind}`), [
    'theme:choice', 'engine:info', 'archiveAfterHours:number', 'sleepAfterHours:number', 'neverSleepSites:list',
    'blockGestures:toggle', 'swipeNavigation:toggle', 'pullToRefresh:toggle', 'frameWhenHidden:toggle', 'newTabHint:toggle',
    'shortcuts:group', 'sidebarShortcut:shortcut', 'nextTab:shortcut', 'prevTab:shortcut', 'nextSpace:shortcut', 'prevSpace:shortcut', 'resetShortcuts:button',
  ]);
  const f = byId(fields);
  assert.deepEqual(f.theme.options.map((o) => [o.id, o.label, o.selected]), [['arcadia', 'Arcadia', true], ['neo-brutalism', 'Neo-brutalism', false], ['pixel', 'Pixel', false]]);
  assert.equal(f.neverSleepSites.value, 'mail.example.com');
  assert.equal(f.archiveAfterHours.value, '12');
  assert.match(f.engine.label, /Safari’s default search engine/);
  assert.equal(f.resetShortcuts.status, SHORTCUT_HELP);
  assert.ok(f.blockGestures.isToggle && f.theme.isChoice && f.neverSleepSites.isList && f.nextTab.isShortcut && f.shortcuts.isGroup);
  // Safari closes a sleeping tab (each opens as it's clicked): nothing to wake.
  assert.ok(!('wakeAll' in f));
  const discards = byId(settingsFields({}, DISCARDS));
  assert.ok(discards.wakeAll?.isButton, 'Wake all where they\'re discarded');
  // Gone from the form: keep-ready, the warm-up, the switch log.
  for (const id of ['keepLeftTabReadyMinutes', 'warmUpTabs', 'switchLog']) assert.ok(!(id in f), id);
  // Chrome: its full-screen pair; no sleeping tabs, gestures or ⌘T hint.
  const chrome = byId(settingsFields({}, CHROME));
  assert.ok(chrome.marginFullscreenAuto?.isToggle && chrome.fullscreenOnly?.isToggle);
  for (const id of ['sleepAfterHours', 'neverSleepSites', 'wakeAll', 'blockGestures', 'newTabHint']) assert.ok(!(id in chrome), id);
  assert.match(chrome.engine.label, /Chrome’s search engine/);
  // Gestures off: swipe and pull can't be changed.
  const off = byId(settingsFields({ blockGestures: false }, SAFARI));
  assert.equal(off.swipeNavigation.disabled, true);
  assert.equal(off.pullToRefresh.disabled, true);
  // A shortcut being recorded shows empty.
  assert.equal(byId(settingsFields({}, SAFARI, { recording: 'nextTab' })).nextTab.value, '');
});

test('Settings: what a field saves is checked against the field, never taken from the theme', () => {
  const f = byId(settingsFields({ theme: 'arcadia', shortcuts: {} }, SAFARI));
  assert.deepEqual(saveField(f.archiveAfterHours, '24', {}), { type: 'updateSettings', payload: { patch: { archiveAfterHours: 24 } } });
  assert.deepEqual(saveField(f.archiveAfterHours, '9999', {}).payload.patch, { archiveAfterHours: 720 }, 'clamped');
  assert.deepEqual(saveField(f.archiveAfterHours, '2.6', {}).payload.patch, { archiveAfterHours: 3 }, 'whole hours');
  assert.deepEqual(saveField(f.sleepAfterHours, '0.5', {}).payload.patch, { sleepAfterHours: 0.5 }, 'any step');
  for (const bad of ['-1', '', 'x', 'Infinity']) assert.equal(saveField(f.archiveAfterHours, bad, {}), null, bad);
  assert.deepEqual(saveField(f.blockGestures, false, {}).payload.patch, { blockGestures: false });
  assert.equal(saveField(f.blockGestures, 'false', {}), null, 'a toggle takes a boolean');
  assert.deepEqual(saveField(f.theme, 'neo-brutalism', {}).payload.patch, { theme: 'neo-brutalism' });
  assert.equal(saveField(f.theme, 'evil', {}), null, 'only a listed theme');
  assert.equal(saveField(f.theme, 'arcadia', {}), null, 'the one already chosen: nothing');
  assert.deepEqual(saveField(f.neverSleepSites, 'https://Mail.Example.com/x\nnews.test, bad host!', {}).payload.patch, { neverSleepSites: ['mail.example.com', 'news.test', 'bad'] });
  assert.deepEqual(saveField(f.sidebarShortcut, 'Alt+KeyD', {}).payload.patch, { sidebarShortcut: 'Alt+KeyD' });
  const nav = saveField(f.nextTab, 'Ctrl+Alt+KeyN', { shortcuts: {} }).payload.patch.shortcuts;
  assert.equal(nav.nextTab, 'Ctrl+Alt+KeyN');
  assert.ok(['prevTab', 'nextSpace', 'prevSpace'].every((k) => typeof nav[k] === 'string'), 'the others kept');
  assert.equal(saveField(f.nextTab, 'nonsense', {}), null);
  assert.equal(saveField(f.engine, 'x', {}), null, 'a paragraph saves nothing');
  const disabled = byId(settingsFields({ blockGestures: false }, SAFARI)).swipeNavigation;
  assert.equal(saveField(disabled, true, {}), null, 'a disabled field saves nothing');
  assert.match(shortcutTaken('nextTab', 'Alt+KeyS', {}), /already used for “Show or hide the sidebar”/);
  assert.equal(shortcutTaken('sidebarShortcut', 'Alt+KeyS', {}), null, 'its own');
  assert.match(shortcutTaken('nextTab', 'Meta+KeyT', {}), /New tab/);
  assert.deepEqual(runField(byId(settingsFields({}, DISCARDS)).wakeAll), { type: 'wakeSleeping', payload: {} });
  assert.equal(runField(f.resetShortcuts).payload.patch.sidebarShortcut, 'Alt+KeyS');
  assert.equal(runField(f.theme), null);
  assert.deepEqual([wokeText(2), wokeText(1), wokeText(0), wokeText(undefined)], ['Woke 2 tabs.', 'Woke 1 tab.', 'No tabs are asleep.', 'Couldn’t reach Margin.']);
});

test('Settings inputs: each of Margin\'s on its own element, their options and text Margin\'s, inside a guarded part', () => {
  const r = sanitizeTemplate(wrap(`<template m-part="settings"><div>
    <input m-input="setting-number" type="number"><input m-input="setting-toggle"><input m-input="setting-shortcut">
    <select m-input="setting-choice"><option value="x">Evil</option></select>
    <textarea m-input="setting-list" rows="3">typed by the theme <b>x</b></textarea>
    <textarea>a plain one</textarea><select><option>plain</option></select>
    <input m-input="setting-list"><select m-input="setting-number"></select>
    <span>Delete everything</span></div></template>`));
  assert.deepEqual(r.errors, []);
  const els = [];
  const walk = (n) => { if (n.type === 'el') els.push(n); for (const c of n.children ?? []) walk(c); };
  walk(r.tree);
  const inputs = els.filter((e) => ['input', 'select', 'textarea'].includes(e.name)).map((e) => `${e.name}:${e.attrs.find(([k]) => k === 'm-input')?.[1]}:${e.children.length}`);
  assert.deepEqual(inputs, ['input:setting-number:0', 'input:setting-toggle:0', 'input:setting-shortcut:0', 'select:setting-choice:0', 'textarea:setting-list:0']);
  assert.ok(!els.find((e) => e.name === 'input' && e.attrs.some(([k]) => k === 'type')), 'their type is Margin\'s to set');
  assert.ok(r.removed.some((x) => /Delete everything/.test(x.name)), 'a static word in the settings part goes');
  assert.ok(!JSON.stringify(r.tree).includes('Evil') && !JSON.stringify(r.tree).includes('typed by the theme'));
});

test('Settings in the view model: on Margin\'s own pages, while open; its buttons are the only settings.run arguments', () => {
  const state = { ...smallState(), settings: { ...smallState().settings, theme: 'arcadia' } };
  const vm = (ui) => buildViewModel({ state, ui: { windowId: W, ...ui }, platform: { browser: 'safari', os: 'mac', features: DISCARDS } });
  assert.equal(vm({}).settingsForm, null, 'a web page');
  assert.equal(vm({ launcherPage: true }).settingsForm, null, 'closed');
  assert.equal(vm({ launcherPage: true }).launcher.settingsOpen, false);
  assert.equal(vm({ launcherPage: true }).window.sidebar, 'open', 'the sidebar beside the launcher, Keep open or not');
  assert.equal(vm({}).window.sidebar, 'hidden');
  const open = vm({ launcherPage: true, settingsOpen: true });
  assert.equal(open.launcher.settingsOpen, true);
  assert.ok(open.settingsForm.fields.some((f) => f.id === 'wakeAll'));
  const buttons = open.settingsForm.fields.filter((f) => f.isButton).map((f) => f.id);
  const ctx = contextFromState(state, [], { settingIds: buttons });
  assert.deepEqual(checkAction('settings.run', 'wakeAll', ctx), { ok: true });
  assert.equal(checkAction('settings.run', 'theme', ctx).ok, false, 'not a button');
  assert.equal(checkAction('settings.run', 'wakeAll', contextFromState(state)).ok, false, 'not while the form is closed');
  assert.deepEqual(requestFor('settings.open', undefined, { state, ui: { windowId: 7 } }), { kind: 'send', type: 'openLauncher', payload: { windowId: 7, settings: true } });
});

// DEV-HOOK: Margin.app's "ask before quitting" (its quit prompt, app/shell/QuitPrompt.swift), a development switch:
// shown only when the app says it (`devAskBeforeQuit`), saved by the app.
test('settings: the development switch for Margin\'s quit prompt, only when the app says it, saved by the app', () => {
  assert.equal(settingsFields({}, {}).find((f) => f.id === 'devAskBeforeQuit'), undefined, 'not said: not shown');
  const field = settingsFields({}, { devAskBeforeQuit: false }).find((f) => f.id === 'devAskBeforeQuit');
  assert.ok(field && field.kind === 'toggle' && field.checked === false && /development/i.test(field.label), JSON.stringify(field));
  assert.equal(settingsFields({}, { devAskBeforeQuit: true }).find((f) => f.id === 'devAskBeforeQuit')?.checked, true);
  assert.deepEqual(saveField(field, true, {}), { perform: 'switch.askBeforeQuit', arg: { on: true } }, 'the app saves it');
});
