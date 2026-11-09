// This copy's link to Margin.app (background/link.ts), with what it needs
// from the rest of the background: the store (ownership, the data set and
// its queue), the active theme's package, Safari's command keys. One per
// background; background.ts starts it once the copy knows it owns the state.
import { createLink } from './link.ts';
import { createParkedRestore } from './parked-restore.ts';
import { adoptAppSet, api, cached, isOwner, onDataChanges, pendingQueue, takeDataChanges, thisCopy } from './store.ts';
import { activeThemeId, STORED_THEME, themePackage } from './theme-package.ts';
import { dataSetFromStorage } from '../shared/data-set.ts';
import { commandKeys } from '../shared/shortcuts.ts';

// Windows the app had parked, known again after a Safari relaunch restores them (background/parked-restore.ts).
export const parkedRestore = createParkedRestore({
  api,
  state: () => cached(),
  liveWindows: async () => ((await Promise.resolve(api.windows?.getAll?.()).catch(() => null)) ?? []).map((w) => w.id).filter(Number.isInteger),
  onFound: () => { void appLink.windowsNow?.(); },
});

export const appLink = createLink({
  api,
  isOwner,
  wasParked: (windowId) => parkedRestore.wasParked(windowId),
  copy: thisCopy,
  instanceId: globalThis.crypto?.randomUUID?.() ?? null,
  commandKeys,
  data: {
    pendingQueue,
    // The converter (docs/DATA.md): all of storage as a data set, for an app that has none.
    snapshot: async () => dataSetFromStorage(await api.storage.local.get(null), { now: Date.now() }),
    adopt: (set, options) => adoptAppSet(set, options),
    take: takeDataChanges,
    onChanges: onDataChanges,
  },
  // The active theme's package: as stored for pages, else read.
  theme: async () => {
    const got = await api.storage.local.get(['settings', STORED_THEME]);
    const id = activeThemeId(got.settings);
    return got[STORED_THEME]?.id === id && got[STORED_THEME]?.pkg ? got[STORED_THEME].pkg : themePackage(id);
  },
});

appLink.onParked((windowId, on, forgot) => parkedRestore.parked(windowId, on, forgot));
api.windows?.onRemoved?.addListener?.((windowId) => parkedRestore.gone(windowId));
parkedRestore.start();
