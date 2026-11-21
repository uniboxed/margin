// What a context menu holds (ui/behaviors/menus.ts draws it from the theme's
// `menu` part): today's right-click menu on tabs, pins and folders
// (themes/arcadia/sidebar.js menuItems), the "+" menu, and one for spaces.
// Each item runs one of Margin's checked actions (ui/actions.ts), two-value
// ones included: the view model shows only the label (ui/view-model.ts),
// the runtime keeps the action. Pure: runs in Node.

import type { State } from '../../../types/margin';
import type { FavoriteRow, FolderRow, PinRow, SpaceView } from '../view-model.ts';
import { FAVORITES_CAP, MAX_FOLDER_DEPTH, favoriteScopeOf, folderDepth, normalizeUrl } from '../../state/model.ts';
import { themeChoices, spaceThemeId, spaceThemesOn } from '../space-theme.ts';

// The space editor's swatches (Arcadia's).
export const SPACE_COLORS = Object.freeze(['#6c5ce7', '#0984e3', '#00b894', '#fdcb6e', '#e17055', '#d63031', '#e84393', '#636e72']);

export type MenuItem = { id: string, label: string, separator: boolean, danger: boolean, confirm: boolean, action: string | null, arg?: any };
export type MenuTarget = { kind: 'tab' | 'pin' | 'favorite' | 'folder' | 'space' | 'add', id?: string | number | null };

/**
 * The items of the menu for `target`, from the stored state and the space
 * as the sidebar shows it (ui/view-model.ts `space`: its `pinned` area, the
 * folders and pins in the order shown). None: no menu (its subject is gone).
 * */
// (`features`: the host's (Margin.app's imported themes: a space's menu offers them too). Every caller gives the same,
// so the items and their ids are the same where they're drawn and where one is run.)
export function menuItems(target: MenuTarget | null | undefined, { state, space, favorites = null, features = null }: { state: (Omit<Partial<State>, 'settings'> & { settings?: Partial<State['settings']> } & Record<string, any>) | null, space: SpaceView | null | undefined, favorites?: { items: FavoriteRow[] } | null, features?: Record<string, any> | null }): MenuItem[] {
  if (!target || !state) return [];
  const list: MenuItem[] = [];
  let n = 0;
  let s = 0;
  const item = (label: string, action: string, arg?: unknown, extra = {}) => list.push({ id: `i${n++}`, label, separator: false, danger: false, confirm: false, action, ...(arg === undefined ? {} : { arg }), ...extra });
  const separator = () => { if (list.length && !list.at(-1)!.separator) list.push({ id: `s${s++}`, label: '', separator: true, danger: false, confirm: false, action: null }); };
  const pinned = space?.pinned ?? [];
  const flat = space?.pinnedFlat ?? null;
  const folders: FolderRow[] = flat
    ? flat.filter((p): p is FolderRow => p.isFolder)
    : pinned.filter((p): p is FolderRow => p.isFolder);
  const shownPins: PinRow[] = flat
    ? flat.filter((p): p is PinRow => !p.isFolder)
    : pinned.flatMap((p) => (p.isFolder ? p.pins : [p]));
  const scope = favoriteScopeOf(state as State, space?.id ?? null);
  const scopeFavs = (state.favorites ?? []).filter((f) => (f.scope || 'global') === scope);
  const canAddFav = (url: string) => !!url && scopeFavs.length < FAVORITES_CAP && !scopeFavs.some((f) => normalizeUrl(f.url) === normalizeUrl(url));
  switch (target.kind) {
    case 'favorite': {
      const fav = (state.favorites ?? []).find((f) => f.id === target.id);
      if (!fav) return [];
      const shown = favorites?.items?.find((f) => f.id === fav.id) ?? null;
      const isWeb = /^https?:\/\//i.test(fav.url ?? '');
      const liveTab = shown?.tabId != null ? state.tabs?.[shown.tabId] : null;
      if (shown?.drifted) item('Reset to Favorite URL', 'favorite.reset', fav.id);
      item('Remove from Favorites', 'favorite.remove', fav.id);
      item('Rename Favorite', 'favorite.rename', fav.id);
      if (isWeb) item('Copy URL', 'favorite.copyUrl', fav.id);
      if (liveTab && shown?.tabId != null) {
        separator();
        if (isWeb) item(liveTab.muted ? 'Unmute Tab' : 'Mute Tab', 'tab.mute', shown.tabId);
        item(isWeb ? 'Sleep Tab' : 'Unload App', 'tab.unload', shown.tabId);
        item('Close Tab', 'tab.close', shown.tabId);
      }
      break;
    }
    case 'folder': {
      const folder = (state.folders ?? []).find((f) => f.id === target.id);
      if (!folder) return [];
      item('Rename Folder', 'folder.rename', folder.id);
      item(folder.open === false ? 'Open Folder' : 'Close Folder', 'folder.toggle', folder.id);
      const depth = folderDepth(state as State, folder.id, folder.spaceId);
      if (depth < MAX_FOLDER_DEPTH - 1) item('New Subfolder', 'folder.newIn', folder.id);
      if (folder.parentId) item('Move Out of Folder', 'folder.nest', { folder: folder.id, parent: null, before: null });
      separator();
      item('Delete Folder (pins stay)', 'folder.delete', folder.id, { danger: true });
      break;
    }
    case 'pin': {
      const pin = (state.pins ?? []).find((p) => p.id === target.id);
      if (!pin) return [];
      const shown = shownPins.find((p) => p.id === pin.id);
      const isWeb = /^https?:\/\//i.test(pin.url ?? '');
      const liveTab = shown?.tabId != null ? state.tabs?.[shown.tabId] : null;
      if (shown?.drifted) item('Reset to Pinned URL', 'pin.reset', pin.id);
      item('Unpin', 'tab.unpin', pin.id);
      if (canAddFav(pin.url)) item('Add to Favorites', 'favorite.addPin', pin.id);
      item('Rename Pin', 'pin.rename', pin.id);
      if (isWeb) item('Copy URL', 'pin.copyUrl', pin.id);
      separator();
      for (const f of folders) if (f.id !== shown?.folderId) item(`Move to 📁 ${f.name}`, 'pin.move', { pin: pin.id, folder: f.id, before: null });
      if (shown?.folderId) item('Remove from Folder', 'pin.move', { pin: pin.id, folder: null, before: null });
      item('New Folder with Pin', 'folder.newWithPin', pin.id);
      if (liveTab && shown?.tabId != null) {
        separator();
        if (isWeb) item(liveTab.muted ? 'Unmute Tab' : 'Mute Tab', 'tab.mute', shown.tabId);
        item(isWeb ? 'Sleep Tab' : 'Unload App', 'tab.unload', shown.tabId);
        item('Close Tab', 'tab.close', shown.tabId);
      }
      break;
    }
    case 'tab': {
      // An open tab (the browser's id), or a Margin tab that isn't open (its
      // own id: the same menu; closing it archives it).
      const tabId = target.id;
      const kept = typeof tabId === 'string' ? state.keptTabs?.[tabId] : null;
      const live = Number.isInteger(tabId) ? state.tabs?.[tabId as number] : null;
      if (!kept && !live) return [];
      const url = (live?.url ?? kept?.url ?? '');
      const isWeb = /^https?:\/\//i.test(url);
      item('Pin Tab', 'tab.pin', tabId);
      if (canAddFav(url)) item('Add to Favorites', 'favorite.add', tabId);
      for (const f of folders) item(`Pin to 📁 ${f.name}`, 'tab.pinAt', { tab: tabId, folder: f.id, before: null });
      item('New Folder with Tab', 'folder.newWithTab', tabId);
      item('Rename Tab', 'tab.rename', tabId);
      if (isWeb) {
        separator();
        item('Copy URL', 'tab.copyUrl', tabId);
        item('Duplicate Tab', 'tab.duplicate', tabId);
        if (live) item(live.muted ? 'Unmute Tab' : 'Mute Tab', 'tab.mute', tabId);
      }
      const spaceId = kept ? kept.spaceId : state.tabSpace?.[tabId as number]; // (not kept: an open tab's id)
      const others = (state.spaces ?? []).filter((sp) => sp.id !== spaceId);
      if (isWeb && spaceId) {
        let host = '';
        try { host = new URL(url).hostname.toLowerCase(); } catch {}
        if (host && !(state.airTraffic ?? []).some((r) => r.pattern === host && r.spaceId === spaceId && r.enabled !== false)) {
          item(`Always Open ${host} in This Space`, 'airTraffic.addHost', tabId);
        }
      }
      if (others.length) {
        separator();
        for (const sp of others) item(`Move to ${sp.emoji} ${sp.name}`, 'tab.moveToSpace', { tab: tabId, space: sp.id });
      }
      separator();
      if (live) item(isWeb ? 'Sleep Tab' : 'Unload App', 'tab.unload', tabId);
      item('Close Tab', 'tab.close', tabId);
      break;
    }
    case 'space': {
      const sp = (state.spaces ?? []).find((x) => x.id === target.id);
      if (!sp) return [];
      item('Edit Space…', 'space.edit', sp.id);
      item('Rename Space', 'space.rename', sp.id);
      // Its theme (ui/space-theme.ts), the one it's drawn with checked: where each space's is drawn.
      if (spaceThemesOn(features)) {
        separator();
        const choices = themeChoices(features);
        const drawn = spaceThemeId(sp, state.settings, features, choices);
        for (const c of choices) item(`Theme: ${c.name}${c.id === drawn ? ' ✓' : ''}`, 'space.setTheme', { space: sp.id, theme: c.id });
      }
      separator();
      item('New Space', 'space.new');
      // The last space can't be deleted (the editor's rule); a second press confirms.
      if (state.spaces!.length > 1) { // (sp is one of them)
        separator();
        item('Delete Space', 'space.delete', sp.id, { danger: true, confirm: true });
      }
      break;
    }
    case 'add':
      item('New Folder', 'folder.new');
      item('New Space', 'space.new');
      break;
    default:
      return [];
  }
  while (list.at(-1)?.separator) list.pop();
  return list;
}

/** A confirming item's label (its first press): "Really delete?", as the editor's. */
export const CONFIRM_LABEL = 'Really delete?';
