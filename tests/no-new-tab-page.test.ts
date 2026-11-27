// No new-tab page of Margin's in Margin.app's own window (2026-11-27, Tirth: Arc's palette over the page): its page area
// with nothing hosted is the card with nothing in it (no field, pins or archive), its Settings page as before; the
// palette's Archive opens the Library at its Archive there, the launcher's elsewhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildViewModel, type UiState } from '../app/shared/ui/view-model.ts';
import { rankPalette } from '../extension/shared/search.ts';
import { smallState, W } from './ui/fixtures.ts';
import type { State } from '../types/margin.d.ts';

const platform = { browser: 'safari', os: 'mac', features: {} };
const vm = (ui: Partial<UiState>) => buildViewModel({ state: smallState() as unknown as State, now: 0, ui: { windowId: W, mode: 'fullscreen', ...ui } as UiState, platform }, null);

test('Margin.app\'s window, nothing hosted: the launcher card with nothing in it', () => {
  const l = vm({ appWindow: true, launcherPage: true }).launcher!;
  assert.ok(l, 'the card is still drawn (opaque: never a see-through page area)');
  assert.deepEqual([l.canSearch, l.hasPins, l.hasArchive, l.hasSettings, l.pins.length, l.archive.length], [false, false, false, false, 0, 0]);
});

test('Margin.app\'s window: its Settings page is still drawn in the card', () => {
  const v = vm({ appWindow: true, launcherPage: true, settingsPage: true });
  assert.ok(v.settingsTab, 'the Settings page');
  assert.ok(v.settingsForm?.hasFields, 'its fields');
});

test('a browser\'s own launcher (not Margin.app\'s window) keeps its field, pins and archive', () => {
  const l = vm({ launcherPage: true }).launcher!;
  assert.equal(l.canSearch, true);
  assert.equal(l.hasPins, smallState().pins.length > 0);
});

test('the palette\'s Archive: the Library\'s in Margin.app\'s window, the launcher\'s elsewhere', () => {
  const ctx = { windowId: W, tabId: null, inNewTab: false, canToggleSidebar: true, canFullscreen: false };
  const archive = (c: Parameters<typeof rankPalette>[2]) => rankPalette(smallState() as unknown as State, 'archive', c).find((r) => r.id === 'action:launcher')!;
  assert.deepEqual(archive({ ...ctx, appWindow: true }).action, { local: 'archive' });
  assert.deepEqual(archive(ctx).action, { type: 'openLauncher', windowId: W });
});
