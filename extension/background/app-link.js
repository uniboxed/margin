// This copy's link to Margin.app (background/link.js), with what it needs
// from the rest of the background: the store (ownership, the data set and
// its queue), the active theme's package, Safari's command keys. One per
// background; background.js starts it once the copy knows it owns the state.
import { createLink } from './link.js';
import { adoptAppSet, api, isOwner, onDataChanges, pendingQueue, takeDataChanges, thisCopy } from './store.js';
import { activeThemeId, STORED_THEME, themePackage } from './theme-package.js';
import { dataSetFromStorage } from '../shared/data-set.js';
import { commandKeys } from '../shared/shortcuts.js';

export const appLink = createLink({
  api,
  isOwner,
  copy: thisCopy,
  instanceId: globalThis.crypto?.randomUUID?.() ?? null,
  commandKeys,
  data: {
    pendingQueue,
    // The converter (DATA.md): all of storage as a data set, for an app that has none.
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
