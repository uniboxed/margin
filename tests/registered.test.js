// What the background registers for the first paint and the page's box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseDefault, layoutFromSettings, pagePlan, placeholderPlan } from '../extension/background/registered.js';
import { LAYOUT_SUM_FILE, allLayoutFiles, layoutDigitFile, layoutFiles, layoutOwnCss, readLayoutVars, spelled } from '../extension/shared/page-box.js';

const keepOpen = { sidebarPinnedOpen: true };
const closed = 'themes/arcadia/docked/layout-closed.css';
const docked = 'themes/arcadia/docked/layout.css';

test('placeholders: the frame while hidden, the sidebar\'s box with Keep open, none where nothing shows; one file for any layout', () => {
  assert.deepEqual(placeholderPlan({ sidebarPinnedOpen: false }, { showing: true }), [{ id: 'margin-docked', css: [closed], matches: ['<all_urls>'] }]);
  assert.deepEqual(placeholderPlan({ sidebarPinnedOpen: false }, { showing: false }), [], 'not where Margin works only in full screen: CSS can\'t tell windows apart');
  assert.deepEqual(placeholderPlan({ sidebarPinnedOpen: false, frameWhenHidden: false }, { showing: true }), [], 'the setting off: no frame');
  assert.deepEqual(placeholderPlan({ sidebarPinnedOpen: false, frameWhenHidden: false }, { showing: true, explicit: true })[0].css, [closed], 'a window\'s layout set: its box');
  assert.deepEqual(placeholderPlan(keepOpen, { showing: true })[0].css, [docked]);
  assert.deepEqual(placeholderPlan({ ...keepOpen, themes: { arcadia: { sidebarWidth: 330 } } }, { showing: true })[0].css, [docked], 'the width is in the variables, not the file');
  assert.deepEqual(placeholderPlan(keepOpen, { showing: false }), []);
});

test('the page\'s script: one bundle, with the layout\'s variables as CSS, only while pages have a box', () => {
  const hidden = pagePlan({ sidebarPinnedOpen: false }, { showing: true });
  assert.equal(hidden.js.at(-1), 'content/page.bundle.js');
  assert.ok(!hidden.js.some((f) => f.includes('/at-')), 'no file per width');
  assert.deepEqual(hidden.css, layoutFiles({ left: 8, top: 8, right: 8, bottom: 8, radius: 6.25 }), 'hidden: the frame\'s box');
  assert.deepEqual(pagePlan({ ...keepOpen, frameWhenHidden: false }, { showing: true }).css, layoutFiles({ left: 260, top: 8, right: 8, bottom: 8, radius: 6.25 }), 'Keep open has its box whatever the frame does');
  assert.equal(pagePlan({ sidebarPinnedOpen: false, frameWhenHidden: false }, { showing: true }), null, 'no frame, no Keep open: the page as it is, nothing loaded');
  assert.ok(pagePlan({ sidebarPinnedOpen: false, frameWhenHidden: false }, { showing: true, layout: { left: 8, top: 60, right: 8, bottom: 8, radius: 0 } }), 'a layout set: a box');
  assert.equal(pagePlan(keepOpen, { showing: false }), null, 'Chrome with no window in full screen');
});

test('layouts: today\'s from the settings until one is set; the most windows\' is registered, ties to the latest', () => {
  assert.deepEqual(layoutFromSettings(keepOpen), { left: 260, top: 8, right: 8, bottom: 8, radius: 6.25 });
  assert.deepEqual(chooseDefault(keepOpen, {}), { layout: layoutFromSettings(keepOpen), explicit: false });
  const right = { left: 8, top: 8, right: 260, bottom: 8, radius: 6.25 };
  const top = { left: 8, top: 60, right: 8, bottom: 8, radius: 0 };
  assert.deepEqual(chooseDefault(keepOpen, { windows: { 1: { layout: right, at: 1 }, 2: { layout: top, at: 3 }, 3: { layout: right, at: 2 } } }).layout, right);
  assert.deepEqual(chooseDefault(keepOpen, { windows: { 1: { layout: right, at: 1 }, 2: { layout: top, at: 3 } } }).layout, top);
  assert.deepEqual(chooseDefault(keepOpen, { windows: { 1: { layout: right, at: 1 } }, pinned: top }).layout, top);
});

// The variables as a browser computes them: each property's last declaration
// wins (no selectors here: every rule is on <html>), and var() is substituted.
function computed(sheets) {
  const props = new Map();
  for (const css of sheets) for (const [, name, value] of css.matchAll(/(--[\w-]+):\s*([^;]+);/g)) props.set(name, value.trim());
  const sub = (value) => value.replace(/var\((--[\w-]+), ([^)]+)\)/g, (_, name, fallback) => (props.has(name) ? sub(props.get(name)) : fallback));
  return { getPropertyValue: (name) => (props.has(name) ? sub(props.get(name)) : '') };
}

test('first-paint variables: any layout spelled in digit files reads back the same, whatever earlier ones are left, and a window\'s own sheet wins', () => {
  const all = new Map(allLayoutFiles());
  const sheetsOf = (layout) => layoutFiles(layout).map((f) => all.get(f));
  assert.ok(layoutFiles({ left: 260 }).every((f) => all.has(f)), 'every file it lists is built');
  assert.equal(all.size, 164);
  assert.equal(readLayoutVars(computed([])), null, 'nothing registered: no layout');
  const layouts = [{ left: 260, top: 8, right: 8, bottom: 8, radius: 6.25 }, { left: 8, top: 8, right: 260, bottom: 8, radius: 0 }, { left: 16, top: 16, right: 16, bottom: 16, radius: 18 }, { left: 1023.75, top: 0.25, right: 0, bottom: 333.5, radius: 63.75 }];
  for (const [i, layout] of layouts.entries()) {
    assert.equal(layoutFiles(layout).length, 20);
    assert.deepEqual(readLayoutVars(computed(sheetsOf(layout))), layout);
    // WebKit keeps applying an earlier registration's sheets, the newest last.
    assert.deepEqual(readLayoutVars(computed([...layouts.slice(0, i).reverse().flatMap(sheetsOf), ...sheetsOf(layout)])), layout, 'earlier registrations left over change nothing');
    assert.deepEqual(readLayoutVars(computed([...sheetsOf(layout), layoutOwnCss({ left: 8, top: 60, right: 8, bottom: 8, radius: 0 })])), { left: 8, top: 60, right: 8, bottom: 8, radius: 0 });
  }
  assert.deepEqual(spelled({ left: 260.1, top: -4, right: 5000, bottom: 8, radius: 6.3 }), { left: 260, top: 0, right: 1023.75, bottom: 8, radius: 6.25 }, 'quarter pixels, within range');
  assert.equal(layoutFiles({ left: 260 })[0], LAYOUT_SUM_FILE);
  assert.equal(layoutDigitFile('left', 3, 1), 'content/layout/left-3-1.css');
});
