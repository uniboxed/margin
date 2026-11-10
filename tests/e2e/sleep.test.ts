// Sleeping tabs (background/sleep.ts), in Safari's profile: a pass asked for
// by hand (`margin.sleepNow(ms)`) closes the browser tab of each idle page
// and keeps its Margin tab, not open, in its space; a click opens it again at
// its address. Pages that are busy stay open: a mail draft, the podcast and
// the video playing, a site on the never-sleep list, text typed in another
// site's frame, and the tab in front.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMargin, type Margin } from './harness/margin.ts';
import { SPACES } from './harness/seed.ts';
import { sidebar, tabRow } from './harness/ui.ts';
import type { Page } from 'playwright';
import type { Pass } from '../../extension/background/sleep.ts';

// background.ts's console helper: a pass of sleeping tabs now, for tabs unused for `ms`.
type SleepNow = (ms: number) => Promise<Pass | null>;

let m: Margin;
let ui: Page;
const ids: Record<string, number> = {};

// (`!`: a test's front tab is there; were it not, the id is still undefined and the test fails where it's used.)
const frontId = async (): Promise<number> => (await m.front())?.id!;
const openIds = async () => new Set((await m.tabs()).map((t) => t.id));
const rowsByTitle = async (re: RegExp) => (await sidebar(ui)).tabs.filter((r) => re.test(r.title));

before(async () => {
  m = await startMargin({ name: 'sleep', seed: { spaces: SPACES, settings: { sidebarPinnedOpen: true, neverSleepSites: ['metrics.test'] } } });
  ui = await m.ui();
  ids.index = await frontId();
  await m.open('shop.test', '/p/canvas-tote');
  ids.tote = await frontId();
  await m.open('docs.test', '/guide/getting-started');
  ids.docs = await frontId();

  // Mail with a draft typed in its compose box.
  const mail = await m.open('post.test', '/inbox');
  ids.mail = await frontId();
  await mail.click('#compose');
  await mail.fill('#c-to', 'ines@harbor.test');
  await mail.fill('#c-subject', 'Ferry on Saturday');
  await mail.locator('#c-body').pressSequentially('Shall we take the 9:40?');

  // The podcast and the video, playing.
  const radio = await m.open('radio.test', '/');
  ids.radio = await frontId();
  // The tune is 24 s: on a busy machine the rest of this set-up can outlast it, and ended is rightly not playing.
  await radio.evaluate(() => { (document.getElementById('audio') as HTMLAudioElement).loop = true; });
  await radio.click('#play');
  await radio.waitForFunction(() => !(document.getElementById('audio') as HTMLMediaElement).paused);
  const reel = await m.open('reel.test', '/watch');
  ids.reel = await frontId();
  await reel.click('#big-play');
  await reel.waitForFunction(() => !(document.getElementById('player') as HTMLMediaElement).paused);

  // A site on the never-sleep list.
  await m.open('metrics.test', '/');
  ids.metrics = await frontId();

  // Text typed in another site's frame (the map's search box, maps.test in embed.test).
  const embeds = await m.open('embed.test', '/');
  ids.embeds = await frontId();
  await embeds.frameLocator('#f-map').locator('#find').fill('Sennen Cove');

  // The tab in front while the pass runs.
  await m.open('harbor.test', '/');
  ids.harbor = await frontId();
  await m.until(async () => (await sidebar(ui)).tabs.filter((r) => !r.notOpen).length >= 9, { what: 'nine rows' });
});
after(async () => { await m?.close(); });

test('a pass closes idle pages\' browser tabs and keeps their Margin tabs, not open, in the space', async (t) => {
  await m.shoot(t, 'before');
  await new Promise((r) => setTimeout(r, 50));
  const pass = await m.bg(() => (globalThis.margin.sleepNow as SleepNow)(20));
  assert.ok(pass, 'a pass ran (Safari\'s profile sleeps tabs)');

  const open = await openIds();
  for (const name of ['index', 'tote', 'docs']) assert.ok(!open.has(ids[name]), `${name}: its browser tab closed`);
  assert.equal(pass.slept, 3, `three put to sleep: ${JSON.stringify(pass)}`);

  // Kept, not open, in Home, with their titles.
  const kept = Object.values((await m.state()).keptTabs ?? {});
  const titles = kept.map((k) => k.title);
  assert.ok(titles.some((x) => x.startsWith('Canvas Tote')), `the product kept: ${titles.join(' | ')}`);
  assert.ok(titles.some((x) => /Getting started/i.test(x)), 'the docs page kept');
  assert.ok(kept.every((k) => k.spaceId === 'sp-home' && k.why === 'sleep'));
  const rows = await m.until(async () => { const r = (await sidebar(ui)).tabs.filter((x) => x.notOpen); return r.length === 3 && r; }, { what: 'three rows drawn not open' });
  assert.ok(rows.every((r) => !r.active));
  await m.shoot(t, 'after');
});

test('busy pages stay open: a draft, sound and video playing, a never-sleep site, a frame with text, the one in front', async () => {
  const open = await openIds();
  for (const name of ['mail', 'radio', 'reel', 'metrics', 'embeds', 'harbor']) assert.ok(open.has(ids[name]), `${name} stays open`);
  // The copy's own note of the pass, for the app's log: why each stayed.
  const line = await m.until(() => m.relay.logs.findLast((l) => l.line.startsWith('sleep: '))?.line, { what: 'the pass in the app\'s log' });
  assert.match(line, /3 put to sleep/);
  assert.match(line, /edited [12]/, `the draft and the frame's text: ${line}`);
  assert.match(line, /playing 2/, `the podcast and the video: ${line}`);
  assert.doesNotMatch(line, /https?:|\.test/, 'no addresses in the log');
});

test('a not-open tab opens again at its address when clicked, and the draft is still there', async (t) => {
  const [row] = await rowsByTitle(/^Canvas Tote/);
  assert.ok(row?.notOpen, 'the product\'s row, not open');
  await ui.click(tabRow(row.key));
  const tab = await m.until(async () => { const f = await m.front(); return f?.url === m.url('shop.test', '/p/canvas-tote') && f.status === 'complete' && f; }, { timeout: 8000, what: 'the product open again, in front' });
  await m.until(async () => (await sidebar(ui)).tabs.find((r) => r.id === tab.id && r.active && !r.notOpen), { what: 'its row open and highlighted' });
  // One row for it, not two: the kept row gave way to the open tab's (whatever title the tab shows
  // while it loads), for good.
  await m.until(async () => (await m.tabs()).find((x) => x.id === tab.id)?.title!.startsWith('Canvas Tote'), { what: 'its title back' });
  await m.until(async () => { const r = await rowsByTitle(/^Canvas Tote/); return r.length === 1 && r[0].id === tab.id; }, { what: 'one row titled Canvas Tote, the open tab\'s' });
  for (let i = 0; i < 6; i++) {
    const rows = (await sidebar(ui)).tabs;
    assert.ok(!rows.some((r) => r.key === row.key), 'the kept row gone');
    assert.equal(rows.filter((r) => r.id === tab.id).length, 1, 'one row for the open tab');
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal((await m.state()).tabSpace[tab.id], 'sp-home', 'in its space');
  await m.shoot(t, 'woken');

  // The mail tab kept its draft through the pass.
  const mail = (await m.pageOf(ids.mail))!;
  assert.equal(await mail.inputValue('#c-subject'), 'Ferry on Saturday');
});

test('the never-sleep list is the person\'s: off the list, the dashboard sleeps too', async () => {
  assert.equal((await m.shell.request('updateSettings', { patch: { neverSleepSites: [] } }, m.shell.frontWindowId())).ok, true);
  await m.until(async () => ((await m.stored('settings')).settings.neverSleepSites ?? []).length === 0, { what: 'the list emptied' });
  await new Promise((r) => setTimeout(r, 50));
  await m.bg(() => (globalThis.margin.sleepNow as SleepNow)(20));
  await m.until(async () => !(await openIds()).has(ids.metrics), { what: 'the dashboard asleep' });
  assert.ok((await openIds()).has(ids.mail), 'the draft still keeps the mail awake');
});
