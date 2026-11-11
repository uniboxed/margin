// Synthetic read-only context for the owned NativeHandoffCover probe. No live data.
import { ARCADIA, NEO, PIXEL, themeForPage } from '../../tests/theme/package.ts';
import { smallState, W } from '../../tests/ui/fixtures.ts';
import { toStorage } from '../../extension/shared/stored.ts';

const stored = smallState();
const state = { ...stored, settings: { ...stored.settings, sidebarPinnedOpen: true } };
const id = process.argv[2] ?? 'arcadia';
const paths = { arcadia: ARCADIA, neubrutalism: NEO, pixel: PIXEL };
if (!(id in paths)) throw new Error('unknown built-in probe theme');
const path = paths[id as keyof typeof paths];
state.settings.theme = id;
console.log(JSON.stringify({
  profile: 'source', windowId: W, browser: 'safari', mode: 'fullscreen',
  platform: { browser: 'safari', os: 'mac', app: true },
  state: toStorage(state, Object.keys(state), { origin: 'safari-web-extension://margin', since: 1, synced: true }),
  windows: [{ windowId: W, state: 'fullscreen', focused: true, activeTabId: 13 }],
  theme: { id, ...themeForPage(path) },
  across: {
    v: 1, profile: 'source',
    profiles: [{ id: 'source', name: 'Probe source', spaces: 1 }, { id: 'target', name: 'Probe target', spaces: 1 }],
    spaces: [{ profile: 'source', id: 'home', name: 'Source' }, { profile: 'target', id: 'home', name: 'Target' }],
    switching: {
      profile: 'target', space: 'home', phase: 'covered', from: { profile: 'source', windowId: W },
      content: { space: 'home', folders: [], pins: [], tabs: [] },
    },
  },
}));
