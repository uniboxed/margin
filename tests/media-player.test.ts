import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../extension/state/model.ts';
import { PAUSE_GRACE_MS, createMediaRegistry, selectBackgroundMedia, type MediaSource } from '../extension/background/media.ts';
import { buildViewModel } from '../extension/ui/view-model.ts';
import { checkAction, contextFromState, requestFor } from '../extension/ui/actions.ts';

test('M2.4 Mini Player: exact Arc visibility — hidden when active tab is playing, shown when background tab plays', () => {
  let s = M.defaultState();
  s = M.setActiveSpace(s, 1, 'personal');
  s = M.upsertTab(s, { id: 1, windowId: 1, index: 0, active: true, audible: true, url: 'https://youtube.com/watch?v=1', title: 'Lo-fi Beats' } as BrowserTab, 1000);
  s = M.upsertTab(s, { id: 2, windowId: 1, index: 1, active: false, audible: false, url: 'https://docs.example/', title: 'Docs' } as BrowserTab, 1000);
  s = M.moveTab(s, 1, 'personal');
  s = M.moveTab(s, 2, 'personal');

  // When playing tab (1) is active in front: Mini Player MUST NOT appear.
  const vmPlayingFront = buildViewModel({ state: s, ui: { windowId: 1, tabId: 1 }, now: 2000 });
  assert.equal(vmPlayingFront.media, null, 'foreground playing tab does not show mini player');

  // Switch to Docs (tab 2): YouTube (tab 1) is now in background -> Mini Player appears!
  s = M.upsertTab(s, { id: 1, windowId: 1, index: 0, active: false, audible: true, url: 'https://youtube.com/watch?v=1', title: 'Lo-fi Beats' } as BrowserTab, 1500);
  s = M.upsertTab(s, { id: 2, windowId: 1, index: 1, active: true, audible: false, url: 'https://docs.example/', title: 'Docs' } as BrowserTab, 1500);
  const vmBg = buildViewModel({ state: s, ui: { windowId: 1, tabId: 2 }, now: 2000 });
  assert.ok(vmBg.media, 'background playing tab shows mini player');
  assert.equal(vmBg.media.source, 'tab');
  assert.equal(vmBg.media.tabId, 1);
  assert.equal(vmBg.media.title, 'Lo-fi Beats');
  assert.equal(vmBg.media.playing, true);
  assert.equal(vmBg.media.paused, false);
});

test('M2.4 Mini Player: 8-second pause grace keeps mini player alive briefly, then hides after grace expires', () => {
  let clock = 10_000;
  const reg = createMediaRegistry({ now: () => clock });
  reg.report(5, { playing: true, title: 'Track A', artist: 'Artist A' });
  assert.equal(reg.current(2)?.playing, true);

  // Pause at t = 12_000.
  clock = 12_000;
  reg.report(5, { playing: false });
  clock = 15_000; // 3s after pause: still inside 8s grace!
  const duringGrace = reg.current(2);
  assert.ok(duringGrace);
  assert.equal(duringGrace.playing, false);

  // Past PAUSE_GRACE_MS (8s): disappears cleanly.
  clock = 12_000 + PAUSE_GRACE_MS + 1;
  assert.equal(reg.current(2), null);
});

test('M2.4 Mini Player: hosted app source hides when that app is in front and rejects non-data artwork URLs', () => {
  const s = M.defaultState();
  const appMedia: MediaSource = {
    id: 'app:com.spotify.client',
    source: 'app',
    tabId: 't-spotify',
    bundleId: 'com.spotify.client',
    title: 'Midnight City',
    subtitle: 'M83',
    artwork: 'https://evil.example/track.jpg', // must be rejected by checkIconUrl
    playing: true,
    muted: false,
    canPrev: true,
    canNext: true,
    updatedAt: 5000,
  };
  assert.equal(selectBackgroundMedia([appMedia], { activeBundleId: 'com.spotify.client', now: 5000 }), null);
  const vm = buildViewModel({ state: s, ui: { windowId: 1, media: appMedia }, now: 5000 });
  assert.ok(vm.media);
  assert.equal(vm.media.title, 'Midnight City');
  assert.equal(vm.media.subtitle, 'M83');
  assert.equal(vm.media.artwork, null, 'remote artwork URL blocked (data: image only)');
  assert.equal(vm.media.canPrev, true);
  assert.equal(vm.media.canNext, true);

  // Actions validate and map cleanly.
  const ctx = contextFromState(s);
  for (const name of ['media.toggle', 'media.prev', 'media.next', 'media.mute', 'media.focus']) {
    assert.equal(checkAction(name, undefined, ctx).ok, true, name);
    assert.equal(requestFor(name, undefined, { state: s, ui: { windowId: 1 } }).kind, 'send', name);
  }
});
