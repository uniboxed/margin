// Settings as its own page, for each built-in theme's own file (Margin.app's Settings tab, margin://settings; the
// new-tab page's #settings), decided by Tirth (2026-11-20): as macOS's System Settings, its categories in a sidebar
// (Appearance, Tabs, Browsing, Keyboard) and the chosen one's settings beside it, with no start-page sections; a
// category clicked shows its own fields; in Margin.app's own window, Settings is never under the launcher's search
// field (its own tab there). In a real engine, the theme's own buttons clicked.
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import type { Harness } from './harness.ts';

declare const T: Harness;

const PLATFORM = { browser: 'safari', os: 'mac', features: { sleepTabs: 'close', blockGestures: true, newTabHint: true, search: 'learn' } };

export async function settingsPageChecks(page: Page) {
  const ev = <R, const A>(fn: (arg: A) => R | Promise<R>, arg?: A) => page.evaluate(fn as (arg: unknown) => R | Promise<R>, arg);
  const count = (s: string) => ev((x) => T.rtCount(x), s);
  const text = (s: string) => ev((x) => T.rtText(x), s);

  // Margin.app's own window, its launcher: no Settings under the search field.
  await ev((p) => T.mountRuntime({ container: 'document', width: 1280, height: 800, mode: 'fullscreen', appWindow: true, platform: p }), PLATFORM);
  assert.ok(await count('.launcher') === 1, 'the launcher drawn');
  assert.equal(await count('.launcher [aria-expanded]'), 0, 'no Settings button in the launcher (its own tab)');
  assert.equal(await count('.settings-form, .settings-page'), 0);

  // Its Settings tab: the page.
  await ev(() => T.rtSetUi({ settingsPage: true }));
  assert.equal(await count('.launcher'), 0, 'no launcher behind it');
  assert.equal(await count('.launcher-query, .tile, .archive-row'), 0, 'no start-page sections');
  assert.deepEqual(await text('.settings-title'), ['Settings']);
  assert.deepEqual(await text('.settings-category .category-label'), ['Appearance', 'Tabs', 'Browsing', 'Keyboard']);
  assert.equal(await count('.settings-category .category-icon svg'), 4, 'each with its icon');
  assert.deepEqual(await text('.settings-category.selected .category-label'), ['Appearance'], 'the first chosen');
  assert.deepEqual(await text('.pane-title'), ['Appearance']);
  assert.equal(await count('.settings-form select'), 2, 'the theme choice, and Edit Theme Color\'s ticks');
  assert.equal(await count('.settings-form input.shortcut'), 0);

  // A category clicked: its own fields.
  await page.click('.settings-category[data-category="keyboard"]');
  assert.deepEqual(await text('.pane-title'), ['Keyboard']);
  assert.deepEqual(await text('.settings-category.selected .category-label'), ['Keyboard']);
  assert.equal(await count('.settings-form input.shortcut'), 13, 'the five, and Margin.app\'s eight');
  assert.deepEqual(await text('.settings-form .setting-group'), ['Margin.app'], 'Margin.app\'s under their own heading');
  assert.equal(await count('.settings-form select'), 0);
  await page.click('.settings-category[data-category="tabs"]');
  assert.equal(await count('.settings-form input.number'), 2, 'archive and sleep');
  assert.equal(await count('.settings-form textarea'), 1, 'never-sleep sites');
  await page.click('.settings-category[data-category="browsing"]');
  assert.ok(await count('.settings-form input.toggle') >= 4, 'gestures, the frame, the hint');
  // The page's parts sit side by side: the categories left of the settings, both inside the page card.
  const boxes = await ev(() => {
    const box = (s: string) => { const r = document.querySelector(s)!.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; };
    return { nav: box('.settings-nav'), pane: box('.settings-pane'), page: box('.settings-page') };
  });
  assert.ok(boxes.nav[2] <= boxes.pane[0] + 1, `the categories beside the settings: ${boxes.nav} ${boxes.pane}`);
  assert.ok(boxes.nav[0] >= boxes.page[0] - 1 && boxes.pane[2] <= boxes.page[2] + 1, 'inside the page card');
  assert.deepEqual(await ev(() => T.rtRefused()), []);
  await ev(() => T.unmountRuntime());

  // Over a browser (the new-tab page's #settings): the same page; its launcher still has Settings under the field.
  await ev((p) => T.mountRuntime({ container: 'document', width: 1280, height: 800, mode: 'inpage', inNewTab: true, platform: p }), PLATFORM);
  assert.equal(await count('.launcher [aria-expanded]'), 1, 'the launcher\'s Settings button');
  await ev(() => T.rtSetUi({ settingsPage: true }));
  assert.equal(await count('.settings-category'), 4);
  await ev(() => T.unmountRuntime());
}
