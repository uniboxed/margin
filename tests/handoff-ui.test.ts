// The overlay's side of the switch between profiles (docs/HANDOFF.md §5, §7):
// the "switching" cover in the view model (only in the overlay of the window
// the switch leaves, only before and under the freeze), its guarded slot and
// part, when the overlay says the cover is drawn (`switch.coverShown`, never
// mid-swipe), its `framed { mode }` after a `shown`, "Close windows to save
// memory" in Settings and how it's saved (the app's `switch.closeWindows`),
// `across.switchSettings`, and the switch's notices by kind with their
// button going back to the app. The app's side: tools/app-tests/handoff-ui-tests.swift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SWITCH_NOTICES, acrossOf, isWindow } from '../extension/shared/across.ts';
import { buildViewModel } from '../extension/ui/view-model.ts';
import { CLOSE_WINDOWS_LABEL, saveField, settingsFields } from '../extension/ui/settings-form.ts';
import { createAppHost } from '../extension/ui/host-app.ts';
import { COVER_FRAMES, answerFramed, createCoverWatch } from '../extension/ui/switch-cover.ts';
import { GUARDED_PARTS, GUARDED_SLOTS, sanitizeTemplate } from '../extension/ui/sanitize.ts';
import { toStorage } from '../extension/shared/stored.ts';
import { readTheme, ARCADIA, NEO } from './theme/package.ts';
import { smallState, W, OTHER_WINDOW } from './ui/fixtures.ts';

const HERE = 's-default';
const WORK = 's-1111';
const rawAcross = (extra = {}) => ({
  v: 1,
  profile: HERE,
  profiles: [
    { id: HERE, name: 'Default', emoji: '', color: '#6c5ce7', here: true, linked: true, spaces: 1 },
    { id: WORK, name: 'Work', emoji: '💼', color: '#00b894', here: false, linked: true, spaces: 1 },
  ],
  spaces: [
    { profile: HERE, id: 'home', name: 'Home', emoji: '🏠', color: '#6c5ce7', tabCount: 6 },
    { profile: WORK, id: 'mail', name: 'Mail', emoji: '✉️', color: '#e17055', tabCount: 1 },
  ],
  switchSettings: { closeWindows: false },
  ...extra,
});
const switching = (phase, more = {}) => ({ profile: WORK, space: 'mail', phase, from: { profile: HERE, windowId: W }, ...more });
const build = (raw, ui = {}) => buildViewModel({ state: { ...smallState(), across: acrossOf(raw) }, ui: { windowId: W, ...ui }, platform: { browser: 'safari', os: 'mac' } });

// ---- the cover in the view model ----

test('the cover: only while the switch gets ready or the screen is frozen, in the window it leaves', () => {
  for (const phase of ['preparing', 'waitingForLink', 'waitingForProfile', 'frozen']) {
    const vm = build(rawAcross({ switching: switching(phase) }));
    assert.ok(vm.switchCover, phase);
    assert.equal(vm.switchCover.text, 'Switching to Work…');
    assert.deepEqual(vm.switchCover.profile, { name: 'Work', emoji: '💼', color: '#00b894', initial: 'W', symbol: null });
    assert.deepEqual(vm.switchCover.space, { name: 'Mail', emoji: '✉️' });
    assert.equal(vm.switchCover.hasSpace, true);
    assert.equal(vm.switchCover.label, 'Switching to Work… Mail');
  }
  // After the freeze, and today's close-based switch's phases: none.
  for (const phase of ['after', 'landed', 'recovering', 'idle', 'creating', 'settling', 'closing', 'checking', '']) {
    assert.equal(build(rawAcross({ switching: switching(phase) })).switchCover, null, phase || 'no phase');
  }
  assert.equal(build(rawAcross({ switching: switching('frozen') }), { windowId: OTHER_WINDOW }).switchCover, null, 'another window of this profile');
  assert.equal(build(rawAcross({ switching: switching('frozen', { from: { profile: WORK, windowId: W } }) })).switchCover, null, 'the same window id in another profile');
  assert.equal(build(rawAcross({ switching: switching('frozen', { from: null }) })).switchCover, null, 'no window it leaves');
  assert.equal(build(rawAcross()).switchCover, null, 'no switch');
  assert.equal(buildViewModel({ state: smallState(), ui: { windowId: W } }).switchCover, null, 'no Margin.app (the in-page host)');
  assert.equal(buildViewModel({ state: null, ui: { windowId: W } }).switchCover, null, 'no state yet');
});

test('the cover: a space it doesn\'t know shows the profile alone; the same switch is the same object', () => {
  const vm = build(rawAcross({ switching: switching('preparing', { space: 'gone' }) }));
  assert.equal(vm.switchCover.hasSpace, false);
  assert.equal(vm.switchCover.label, 'Switching to Work…');
  const a = build(rawAcross({ switching: switching('preparing') }));
  const b = buildViewModel({ state: { ...smallState(), across: acrossOf(rawAcross({ switching: switching('frozen') })) }, ui: { windowId: W }, platform: { browser: 'safari', os: 'mac' } }, a);
  assert.equal(b.switchCover, a.switchCover, 'preparing then frozen: nothing to redraw');
  assert.equal(a.switchCover.id, b.switchCover.id);
});

test('across: the window a switch leaves, the notice\'s window and kind, and the switch\'s settings, checked as they come', () => {
  const a = acrossOf(rawAcross({ switching: { ...switching('frozen'), noticeKind: 'late-landing', noticeProfile: WORK, noticeIn: { profile: WORK, windowId: 4 } } }));
  assert.deepEqual(a.switching.from, { profile: HERE, windowId: W });
  assert.deepEqual(a.switching.noticeIn, { profile: WORK, windowId: 4 });
  assert.equal(a.switching.noticeKind, 'late-landing');
  assert.deepEqual(a.switchSettings, { closeWindows: false });
  assert.ok(isWindow(a.switching.from, HERE, W) && !isWindow(a.switching.from, HERE, 99) && !isWindow(null, HERE, W));
  const bad = acrossOf(rawAcross({ switching: { ...switching('frozen'), from: { profile: HERE, windowId: '7' }, noticeKind: 'toString', noticeIn: { windowId: 2 } }, switchSettings: { closeWindows: 'yes' } }));
  assert.equal(bad.switching.from, null, 'a window id that isn\'t a number');
  assert.equal(bad.switching.noticeIn, null);
  assert.equal(bad.switching.noticeKind, '', 'only a kind Margin has words for');
  assert.deepEqual(bad.switchSettings, { closeWindows: false }, 'only true is on');
  assert.equal(acrossOf({ ...rawAcross(), switchSettings: undefined }).switchSettings, null);
});

// ---- the slot and the part ----

const root = (inner) => `<div class="t">${inner}<m-page></m-page></div>`;
const texts = (tree) => {
  const out = [];
  const walk = (n) => { if (n.type === 'text' && n.value.trim()) out.push(n.value.trim()); for (const c of n.children ?? []) walk(c); };
  walk(tree);
  return out;
};

test('the sanitizer: <m-switch-cover> and its part are allowed, and only as guarded: Margin\'s words alone', () => {
  assert.ok(GUARDED_PARTS.includes('switch-cover') && GUARDED_SLOTS.includes('m-switch-cover'));
  const r = sanitizeTemplate(root(`
    <m-switch-cover class="slot">Your account is locked<span>{{switchCover.text}}</span></m-switch-cover>
    <template m-part="switch-cover">
      <div class="cover" aria-label="Enter your password" m-attr:aria-label="{{switchCover.label}}">
        <span>Log in again:</span><span>{{switchCover.text}}</span>
        <svg viewBox="0 0 4 4"><path d="M0 0h4"></path></svg>
      </div>
    </template>`));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(texts(r.tree), ['{{switchCover.text}}', '{{switchCover.text}}'], 'only the bound words');
  const reasons = r.removed.map((x) => `${x.kind} ${x.name}: ${x.reason}`);
  assert.ok(reasons.some((w) => /Your account is locked/.test(w) && /m-switch-cover/.test(w)), 'the slot\'s own words');
  assert.ok(reasons.some((w) => /Log in again/.test(w) && /switch-cover/.test(w)), 'the part\'s');
  assert.ok(reasons.some((w) => /aria-label/.test(w) || /Enter your password/.test(w)), 'a static label too');
  assert.ok(JSON.stringify(r.tree).includes('"m-switch-cover"'), 'the slot kept');
  assert.ok(JSON.stringify(r.tree).includes('"svg"'), 'decoration stays');
});

test('the built-in themes: the slot over the page and a part of their own, with no words of their own', () => {
  for (const dir of [ARCADIA, NEO]) {
    const t = readTheme(dir);
    assert.match(t.html, /<m-switch-cover class="switch-cover-slot"><\/m-switch-cover>/, dir);
    assert.match(t.html, /<template m-part="switch-cover">/, dir);
    const r = sanitizeTemplate(t.html);
    assert.deepEqual(r.errors, [], dir);
    assert.deepEqual(r.removed.filter((x) => /switch-cover/.test(x.reason)), [], `${dir}: nothing of the theme's own removed`);
    assert.match(t.css, /\.switch-cover-slot\s*\{/, dir);
  }
});

// ---- coverShown and framed ----

function frames() {
  const queue = [];
  return {
    requestFrame: (fn) => { queue.push(fn); },
    // One animation frame: what was asked before it runs.
    tick() { const now = queue.splice(0); for (const fn of now) fn(); return now.length; },
    get pending() { return queue.length; },
  };
}

test('coverShown: after two frames with the cover drawn, once per cover', () => {
  assert.equal(COVER_FRAMES, 2);
  const f = frames();
  let cover = null;
  const said = [];
  const watch = createCoverWatch({ requestFrame: f.requestFrame, cover: () => cover, settling: () => false, say: () => said.push(cover) });
  watch.check();
  assert.equal(f.pending, 0, 'no cover: nothing asked');
  cover = 'work';
  watch.check();
  watch.check();
  assert.equal(f.pending, 1, 'one frame asked, however many changes');
  f.tick();
  assert.deepEqual(said, [], 'one frame is not enough');
  f.tick();
  assert.deepEqual(said, ['work']);
  assert.equal(f.pending, 0);
  watch.check();
  f.tick(); f.tick();
  assert.deepEqual(said, ['work'], 'said once for this cover');
  cover = 'home';
  watch.check();
  f.tick(); f.tick();
  assert.deepEqual(said, ['work', 'home'], 'a new target counts again');
  cover = null;
  watch.check();
  cover = 'home';
  watch.check();
  f.tick(); f.tick();
  assert.deepEqual(said, ['work', 'home', 'home'], 'gone and back: a new cover');
});

test('coverShown: never while a swipe moves or settles; two clear frames after it', () => {
  const f = frames();
  let settling = true;
  const said = [];
  const watch = createCoverWatch({ requestFrame: f.requestFrame, cover: () => 'work', settling: () => settling, say: () => said.push(1) });
  watch.check();
  for (let i = 0; i < 13; i++) f.tick(); // the swipe's 220 ms
  assert.deepEqual(said, [], 'not mid-slide');
  assert.equal(f.pending, 1, 'still watching each frame');
  f.tick();
  settling = false;
  f.tick();
  assert.deepEqual(said, []);
  settling = true;
  f.tick();
  settling = false;
  f.tick();
  assert.deepEqual(said, [], 'a settling frame starts the count again');
  f.tick();
  assert.deepEqual(said, [1]);
});

test('coverShown: the cover gone before its second frame: nothing said, and no frames asked after', () => {
  const f = frames();
  let cover = 'work';
  const said = [];
  const watch = createCoverWatch({ requestFrame: f.requestFrame, cover: () => cover, settling: () => false, say: () => said.push(1) });
  watch.check();
  f.tick();
  cover = null;
  f.tick();
  assert.deepEqual(said, []);
  assert.equal(f.pending, 0);
});

test('framed: on the next frame after `shown`, with the mode at that frame', () => {
  const f = frames();
  const posts = [];
  let mode = 'windowed';
  answerFramed({ requestFrame: f.requestFrame, mode: () => mode, post: (op, body) => posts.push([op, body]) });
  assert.deepEqual(posts, [], 'not before a frame');
  mode = 'fullscreen';
  f.tick();
  assert.deepEqual(posts, [['framed', { mode: 'fullscreen' }]]);
  answerFramed({ requestFrame: f.requestFrame, mode: () => 'windowed', post: (op, body) => posts.push([op, body]) });
  f.tick();
  assert.deepEqual(posts.at(-1), ['framed', { mode: 'windowed' }]);
  answerFramed({ requestFrame: f.requestFrame, mode: () => 'inpage', post: (op, body) => posts.push([op, body]) });
  f.tick();
  assert.deepEqual(posts.at(-1), ['framed', { mode: 'fullscreen' }], 'only the two modes');
});

test('the overlay page: framed after shown, coverShown from the cover\'s slot with no swipe (app/shared/host/overlay.ts)', () => {
  const src = readFileSync(fileURLToPath(new URL('../app/shared/host/overlay.ts', import.meta.url)), 'utf8');
  const shown = src.slice(src.indexOf("case 'shown':"), src.indexOf("case 'push':"));
  assert.match(shown, /answerFramed\(/);
  assert.match(src, /createCoverWatch\(/);
  assert.match(src, /querySelector\('m-switch-cover'\)/);
  assert.match(src, /'\.m-swiping, \.m-settling'/);
  assert.match(src, /perform\('switch\.coverShown'\)/);
});

// ---- the setting ----

test('Settings: "Close windows to save memory" after "Show iCloud Tabs", only with the app\'s value; saved by the app', () => {
  const ids = (fields) => fields.map((f) => f.id);
  assert.ok(!ids(settingsFields({}, { cloudTabs: true })).includes('closeWindows'), 'not without it (one profile, Chrome, the in-page host)');
  const fields = settingsFields({}, { cloudTabs: true, switchSettings: { closeWindows: false } });
  const at = ids(fields).indexOf('closeWindows');
  assert.equal(at, ids(fields).indexOf('showCloudTabs') + 1, 'right after Show iCloud Tabs');
  const f = fields[at];
  assert.equal(f.kind, 'toggle');
  assert.equal(f.checked, false);
  assert.equal(f.label, CLOSE_WINDOWS_LABEL);
  assert.equal(CLOSE_WINDOWS_LABEL, 'Close windows to save memory: when you switch to another profile, the window you leave closes. Switching takes a little longer and its pages reload when you come back. Off: the window stays open, out of sight, with your place, text and video kept.');
  assert.equal(settingsFields({ closeWindows: true }, { switchSettings: { closeWindows: false } }).find((x) => x.id === 'closeWindows').checked, false, 'the app\'s value, not a stored setting');
  assert.equal(settingsFields({}, { switchSettings: { closeWindows: true } }).find((x) => x.id === 'closeWindows').checked, true);
  assert.deepEqual(saveField(f, true, {}), { perform: 'switch.closeWindows', arg: { on: true } });
  assert.deepEqual(saveField(f, false, {}), { perform: 'switch.closeWindows', arg: { on: false } });
  assert.equal(saveField(f, 'true', {}), null, 'a toggle takes a boolean');
});

function appHost(raw, browser = 'safari') {
  const posts = [];
  const post = async (op, body = {}) => { posts.push({ op, ...body }); return null; };
  const keys = ['spaces', 'pins', 'folders', 'archive', 'settings', 'tabs', 'tabSpace', 'activeSpaceByWindow', 'favicons'];
  const state = toStorage(smallState(), keys, { origin: 'o', since: 1, synced: true });
  const notices = [];
  const host = createAppHost({ hello: { windowId: W, profile: HERE, browser, platform: { browser }, state, windows: [], across: raw }, post, onNotice: (arg) => notices.push(arg) });
  return { host, posts, notices };
}

test('the app host: the setting is a feature for Safari with more than one profile, following across', () => {
  const { host, posts } = appHost(rawAcross());
  assert.deepEqual(host.platform.features.switchSettings, { closeWindows: false });
  host.receive({ type: 'across', across: rawAcross({ switchSettings: { closeWindows: true } }) });
  assert.deepEqual(host.platform.features.switchSettings, { closeWindows: true });
  const fields = buildViewModel({ state: host.getState(), ui: { windowId: W, settingsOpen: true, launcherPage: true }, platform: host.platform }).settingsForm.fields;
  assert.equal(fields.find((f) => f.id === 'closeWindows').checked, true, 'drawn in Settings');
  host.receive({ type: 'across', across: rawAcross({ profiles: rawAcross().profiles.slice(0, 1) }) });
  assert.equal(host.platform.features.switchSettings, null, 'one profile: no field');
  host.receive({ type: 'across', across: null });
  assert.equal(host.platform.features.switchSettings, null);
  assert.equal(appHost(rawAcross(), 'chrome').host.platform.features.switchSettings, null, 'not Chrome\'s yet');
  assert.equal(appHost({ ...rawAcross(), switchSettings: undefined }).host.platform.features.switchSettings, null, 'an app that doesn\'t say');
  assert.equal(host.perform('switch.closeWindows', { on: true }), true);
  assert.deepEqual(posts.at(-1), { op: 'perform', name: 'switch.closeWindows', arg: { on: true } });
  assert.equal(host.perform('switch.closeWindows', { on: 'yes' }), false);
  assert.equal(host.perform('switch.coverShown'), true);
  assert.deepEqual(posts.at(-1), { op: 'perform', name: 'switch.coverShown', arg: null });
});

// ---- the switch's notices ----

test('notices: each kind in Margin\'s words, with its profile\'s name; the one window it\'s for', () => {
  const said = (kind, extra = {}, ui = {}) => build(rawAcross({ switching: { noticeKind: kind, noticeProfile: WORK, ...extra } }), ui).notice;
  assert.deepEqual(said('window-kept-draft'), {
    id: 'switch:window-kept-draft', text: 'Kept Work’s window open: a page in it has text you haven’t sent.',
    actions: [{ id: 'close', label: 'Close window', primary: false, danger: false }], hasActions: true,
  });
  assert.equal(said('dialog-open').text, 'Finish the dialog in this window first.');
  assert.equal(said('window-busy').text, 'Safari is busy in this window.');
  assert.equal(said('late-landing').text, 'Switched to Work (Safari was slow).');
  assert.equal(said('window-on-desktop').text, 'Work’s window is on the Desktop. Margin can’t reach its extension right now.');
  for (const kind of Object.keys(SWITCH_NOTICES)) assert.equal(said(kind).id, `switch:${kind}`);
  assert.equal(said('late-landing', { noticeIn: { profile: HERE, windowId: OTHER_WINDOW } }), null, 'another window\'s');
  assert.ok(said('late-landing', { noticeIn: { profile: HERE, windowId: W } }), 'this window\'s');
  assert.equal(said('nonsense'), null, 'a kind Margin has no words for');
  assert.equal(said('nonsense', { notice: 'Couldn’t switch to Work: no answer. Nothing was closed.' }).id, 'profile-switch', 'the app\'s own text, as before');
  assert.equal(said('dialog-open', {}, { notice: { id: 'x#1', text: 'A page notice', actions: [] } }).id, 'x#1', 'a notice of the page\'s first');
});

test('notices: a button of the switch\'s goes to the app; the copy\'s notices still go to the copy', () => {
  const { host, posts, notices } = appHost(rawAcross());
  assert.equal(host.perform('notice', { id: 'switch:window-kept-draft', action: 'close' }), true);
  assert.deepEqual(posts.at(-1), { op: 'perform', name: 'switch.notice', arg: { kind: 'window-kept-draft', action: 'close' } });
  assert.deepEqual(notices, []);
  host.perform('notice', { id: 'not-responding#1', action: 'reload' });
  assert.deepEqual(notices, [{ id: 'not-responding#1', action: 'reload' }]);
});


test('the target space drawn in the window a switch leaves, from the app\'s data: its pins, folders and tabs, the last used highlighted', () => {
  const content = {
    space: 'mail',
    pins: [{ id: 'p1', title: 'Inbox', url: 'https://mail.example/', icon: '', folderId: null, pos: 1 }, { id: 'p2', title: 'Docs', url: 'https://docs.example/', folderId: 'f1', pos: 0 }],
    folders: [{ id: 'f1', name: 'Work stuff', open: true, pos: 0 }],
    tabs: [{ id: 't1', title: 'Report', url: 'https://r.example/', active: false }, { id: 't2', title: 'Chat', url: 'https://chat.example/', icon: 'data:image/png;base64,AAAA', active: true }],
  };
  for (const phase of ['preparing', 'waitingForProfile', 'frozen']) {
    const vm = build(rawAcross({ switching: switching(phase, { content }) }));
    assert.equal(vm.space.switching, true, phase);
    assert.equal(vm.space.name, 'Mail');
    assert.deepEqual(vm.space.pinned.map((p) => `${p.kind}:${p.id}`), ['folder:x:f1', 'pin:x:p1'], 'folders and loose pins by their places');
    assert.deepEqual(vm.space.folders[0].pins.map((p) => p.title), ['Docs']);
    assert.deepEqual(vm.space.today.map((t) => [t.id, t.title, t.active]), [['x:t1', 'Report', false], ['x:t2', 'Chat', true]]);
    assert.equal(vm.space.today[1].icon, 'data:image/png;base64,AAAA');
    assert.equal(vm.spaces.filter((s) => s.active).length, 1, 'one chip active: the target');
    assert.ok(vm.spaces.find((s) => s.active)?.foreign);
  }
  // Not in another window, not after the freeze, not for another space's contents.
  assert.equal(build(rawAcross({ switching: switching('frozen', { content }) }), { windowId: OTHER_WINDOW }).space.switching, false);
  assert.equal(build(rawAcross({ switching: switching('after', { content }) })).space.switching, false);
  assert.equal(build(rawAcross({ switching: switching('frozen', { content: { ...content, space: 'other' } }) })).space.switching, false);
  // An icon that isn't a small data: image is dropped.
  const odd = acrossOf(rawAcross({ switching: switching('frozen', { content: { ...content, tabs: [{ id: 't', title: 'x', url: 'https://x/', icon: 'javascript:alert(1)' }] } }) }));
  assert.equal(odd.switching.content.tabs[0].icon, '');
});
