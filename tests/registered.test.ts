// What the background registers for a page's first paint (background/
// registered.ts), and how a layout is spelled for it (shared/page-box.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseLayout, layoutFromSettings, layoutOf, pagePlan } from '../extension/background/registered.ts';
import { firstPaintFile, layoutFiles, layoutOfFiles, layoutOwnCss, readFirstPaint, spelled } from '../extension/shared/page-box.ts';

const keepOpen = { sidebarPinnedOpen: true };
const L = (left: number, top = 8, right = 8, bottom = 8, radius = 6.25) => ({ left, top, right, bottom, radius });
// Margin.app's layout for a window, as the link keeps it (shared/app-link.ts).
const app = (left: number, top = 8, right = 8, bottom = 8, radius = 6.25) => ({ insets: { left, top, right, bottom }, radius, mode: 'fullscreen' });

test('a layout spelled in digit files: every place of every side, zeros too, read back the same', () => {
  const files = layoutFiles(L(260));
  assert.equal(files.length, 20, 'at.css and 19 digits');
  assert.equal(files[0], 'content/layout/at.css');
  assert.ok(files.includes('content/layout/left-0-0.css') && files.includes('content/layout/left-1-4.css') && files.includes('content/layout/left-2-0.css') && files.includes('content/layout/left-3-1.css'), '260 px is 1040 quarter pixels');
  assert.ok(files.includes('content/layout/top-3-0.css'), 'a zero place is spelled too (WebKit keeps an old registration\'s CSS: the newest must set every place)');
  for (const layout of [L(260), L(0, 0, 0, 0, 0), L(1023.75, 999.5, 0.25, 12.5, 63.75), L(301.25, 52, 8, 8, 10)]) assert.deepEqual(layoutOfFiles(layoutFiles(layout)), spelled(layout));
  assert.deepEqual(spelled(L(5000, -3, 8.1, 8, 99)), L(1023.75, 0, 8, 8, 63.75), 'within range, to a quarter pixel');
  assert.equal(layoutOfFiles(['content/page.bundle.js']), null);
});

test('the page\'s world reads the first paint\'s variables: nothing yet, off, or the theme and its layout (sums worked out, a window\'s own plain values)', () => {
  // A computed style: only its variables, what readFirstPaint reads of one.
  const style = (vars: Record<string, string>) => ({ getPropertyValue: (name: string) => vars[name] ?? '' }) as CSSStyleDeclaration;
  assert.equal(readFirstPaint(style({})), null, 'no registration\'s CSS yet');
  assert.deepEqual(readFirstPaint(style({ '--margin-box-fp': ' off' })), { theme: null, layout: null });
  assert.deepEqual(readFirstPaint(style({ '--margin-box-fp': 'evil theme' })), { theme: null, layout: null }, 'not a theme id');
  const sums = { '--margin-box-fp': ' arcadia', '--margin-box-at-left': 'calc(0px + 60px + 0px + 200px)', '--margin-box-at-top': 'calc(8px + 0px + 0px + 0px)', '--margin-box-at-right': ' 8px', '--margin-box-at-bottom': 'calc(0.25px + 7.75px)', '--margin-box-at-radius': 'calc(0.25px + 6px + 0px)' };
  assert.deepEqual(readFirstPaint(style(sums)), { theme: 'arcadia', layout: { left: 260, top: 8, right: 8, bottom: 8, radius: 6.25 } });
  assert.equal(layoutOwnCss(L(300, 12, 16, 20, 10)), 'html:root { --margin-box-at-left: 300px; --margin-box-at-top: 12px; --margin-box-at-right: 16px; --margin-box-at-bottom: 20px; --margin-box-at-radius: 10px; }', 'a window\'s own: outweighs the registered sums');
});

test('the layout to register: the one most windows have; a tie keeps the one registered; none measured yet: the settings\'; no box at any edge: none', () => {
  assert.deepEqual(chooseLayout({}, { 1: app(260), 2: app(260), 3: app(300) }), L(260));
  const tie = { 1: app(260), 2: app(300) };
  assert.deepEqual(chooseLayout({}, tie, JSON.stringify(spelled(L(300)))), L(300), 'a tie: the one registered stays');
  assert.deepEqual(chooseLayout(keepOpen, {}), L(260), 'none measured: Keep open at its width');
  assert.deepEqual(chooseLayout({ ...keepOpen, themes: { arcadia: { sidebarWidth: 330 } } }, {}), L(330));
  assert.deepEqual(chooseLayout({ sidebarPinnedOpen: false }, {}), L(8), 'the frame alone');
  assert.equal(chooseLayout({ sidebarPinnedOpen: false, frameWhenHidden: false }, {}), null);
  assert.equal(chooseLayout({}, { 1: app(0, 0, 0, 0) }), null, 'the theme\'s page fills the window');
  assert.deepEqual(layoutOf(app(260, 8, 8, 8, 10)), L(260, 8, 8, 8, 10));
  assert.deepEqual(layoutFromSettings(keepOpen), L(260));
});

test('what\'s registered: linked, the page\'s script with the layout\'s files and the theme\'s first paint; not linked, nothing, or the same at a layout of zeros (no box) once a first paint was registered in this run of Safari', () => {
  const on = pagePlan(keepOpen, { linked: true, showing: true, layout: L(260) })!; // linked, a box: a plan (the asserts below say what)
  assert.equal(on.js.at(-1), 'content/page.bundle.js', 'the page\'s script (after Chrome\'s full-screen-only check where Margin works only in full screen)');
  assert.deepEqual(on.css, [...layoutFiles(L(260)), firstPaintFile('arcadia')]);
  assert.equal(pagePlan({ theme: 'neubrutalism' }, { linked: true, showing: true, layout: L(272, 16, 16, 16, 18) })!.css.at(-1), 'content/layout/theme-neubrutalism.css');
  assert.equal(pagePlan({ theme: 'someone-elses' }, { linked: true, showing: true, layout: L(260) })!.css.at(-1), firstPaintFile('arcadia'), 'a theme with no first paint of its own: Arcadia\'s');
  assert.equal(pagePlan(keepOpen, { linked: false, layout: L(260) }), null, 'not linked: nothing');
  assert.equal(pagePlan(keepOpen, { linked: true, showing: true, layout: null }), null, 'no box anywhere: nothing');
  const zeros = [...layoutFiles(L(0, 0, 0, 0, 0)), firstPaintFile('arcadia')];
  assert.deepEqual(pagePlan(keepOpen, { linked: false, layout: L(260), wasOn: true })!.css, zeros, 'off after a first paint: no box (updated, never taken away: WebKit would keep drawing the one in between)');
  assert.equal(pagePlan(keepOpen, { linked: false, layout: L(260), wasOn: true })!.on, false);
  assert.deepEqual(pagePlan(keepOpen, { linked: true, showing: true, layout: null, wasOn: true })!.css, zeros, 'no box anywhere');
  assert.deepEqual(pagePlan(keepOpen, { linked: true, showing: false, layout: L(260), wasOn: true })!.css, zeros, 'Chrome with no window in full screen');
  assert.equal(on.on, true);
});

test('the layout to register counts only the windows Margin.app draws, of this epoch; the settings\' only before it said anything of a window; it draws none: none', () => {
  const at = (left: number, epoch = 'e1') => ({ ...app(left), epoch });
  const link = (drawn: Record<string, boolean>, epoch = 'e1') => ({ epoch, drawn });
  assert.deepEqual(chooseLayout({}, { 1: at(300), 2: at(300), 3: at(260) }, null, link({ 1: false, 2: false, 3: true })), L(260), 'two undrawn windows outweigh nothing');
  assert.deepEqual(chooseLayout({}, { 1: at(300, 'e0'), 2: at(300, 'e0'), 3: at(260) }, null, link({})), L(260), 'an older epoch\'s layouts count for nothing');
  assert.deepEqual(chooseLayout(keepOpen, {}, null, link({})), L(260), 'nothing said yet this epoch: the settings\'');
  assert.equal(chooseLayout(keepOpen, { 1: at(300) }, null, link({ 1: false })), null, 'every window undrawn: no box');
  assert.equal(chooseLayout(keepOpen, {}, null, link({ 1: false, 2: false })), null);
  const registered = JSON.stringify(spelled(L(300)));
  assert.deepEqual(chooseLayout(keepOpen, {}, registered, link({ 1: true })), L(300), 'one drawn but not measured yet: the one registered stays');
  assert.deepEqual(chooseLayout(keepOpen, {}, null, link({ 1: true })), L(260), 'or the settings\' with none registered');
  assert.deepEqual(chooseLayout({}, { 1: app(300), 2: app(300) }), L(300), 'no link given (an older background\'s layouts): as before');
  const last = { 41: at(300, 'e0'), 42: at(300, 'e0') };
  assert.deepEqual(chooseLayout(keepOpen, {}, null, { epoch: 'e1', drawn: {}, last }), L(300), 'nothing said yet this epoch: the epoch before\'s (a relink, a relaunch: no registration in between)');
  assert.deepEqual(chooseLayout(keepOpen, { 1: at(260) }, null, { epoch: 'e1', drawn: {}, last }), L(260), 'this epoch\'s once there');
  assert.equal(chooseLayout(keepOpen, {}, null, { epoch: 'e1', drawn: { 1: false }, last }), null, 'the epoch before\'s never outweighs this one\'s word');
});
