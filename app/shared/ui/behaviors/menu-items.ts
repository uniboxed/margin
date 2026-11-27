// What a context menu holds (ui/behaviors/menus.ts draws it from the theme's
// `menu` part): today's right-click menu on tabs, pins and folders
// (themes/arcadia/sidebar.js menuItems), the "+" menu, and one for spaces.
// Each item runs one of Margin's checked actions (ui/actions.ts), two-value
// ones included: the view model shows only the label (ui/view-model.ts),
// the runtime keeps the action. Pure: runs in Node.

import type { State } from '../../../../types/margin';
import type { FavoriteRow, FolderRow, PinRow, SpaceView } from '../view-model.ts';
import { FAVORITES_CAP, MAX_FOLDER_DEPTH, favoriteScopeOf, folderDepth } from '../../../../extension/shared/pinned-rules.ts';
import { normalizeUrl } from '../../../../extension/shared/view.ts';
import { themeChoices, spaceThemeId, spaceThemesOn } from '../space-theme.ts';
import { appKeysFor, formatAppKey } from '../../../../extension/shared/app-keys.ts';

// Margin.app's key for a new split (Settings' `appKeys.addSplit`, ⌃⇧= by default), '' when it's off.
const splitKeys = (settings: unknown) => formatAppKey('addSplit', appKeysFor(settings).addSplit);
import { matchAirTrafficRule } from '../../../../extension/shared/air-traffic.ts';

// The space editor's swatches (Arcadia's).
export const SPACE_COLORS = Object.freeze(['#6c5ce7', '#0984e3', '#00b894', '#fdcb6e', '#e17055', '#d63031', '#e84393', '#636e72']);

export type MenuItem = { id: string, label: string, separator: boolean, danger: boolean, confirm: boolean, action: string | null, arg?: any,
  /** Drawn, doing nothing (a feature Margin doesn't have yet: Arc's "+"); `hint` says so. */
  inert?: boolean, hint?: string,
  /** Its key, shown at its right (`⌘T`); its glyph's name, for a theme that draws one (`space`, `folder`, `boost`, `split`, `tab`). */
  keys?: string, icon?: string };
/** `look`: the theme's way of drawing it (`arc`: Arc's "+" menu, the theme's `--m-add-menu`; ui/behaviors/menus.ts). */
export type MenuTarget = { kind: 'tab' | 'pin' | 'favorite' | 'folder' | 'space' | 'add' | 'profile', id?: string | number | null, look?: string | null };

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
      // Split View (docs/PEEK-SPLIT.md §4): a pane's own items; any other row (not one of Margin's own pages) is added to
      // the split of the item in front, or split with it (the row's menu is the chooser of what's added).
      const inSplit = (state.splits ?? []).find((g) => g.panes.includes(String(tabId)) || (live?.mid && g.panes.includes(live.mid)));
      if (inSplit) {
        item('Remove from Split View', 'split.remove', tabId);
        item('Break Out of Split View', 'split.breakOut', tabId);
        item('Swap Panes', 'split.swap', inSplit.id);
        item(inSplit.axis === 'vertical' ? 'Side by Side' : 'Stacked', 'split.toggleAxis', inSplit.id);
      } else if (!/^margin:/i.test(url)) {
        item('Add to Split View', 'split.add', tabId);
      }
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
          item(`Always Open ${host} in This Space`, 'linkRules.addHost', tabId);
        }
        // The rule that routes this address now (the first that matches, as links are routed), to take it away. (Every
        // rule, on or off: Settings › Browsing.)
        const routing = matchAirTrafficRule(url, state.airTraffic ?? [], new Set((state.spaces ?? []).map((sp) => sp.id)));
        if (routing) item(`Remove Rule for ${routing.pattern}`, 'linkRules.remove', routing.id);
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
      // (Its icon removed: Arc's space with none, a dot in the switcher; M2.10. Edit Space… gives one back.)
      // (Its name, colour and theme as they are: `space.update` takes them all; its theme kept as the editor keeps it,
      // none when the one it had isn't there any more.)
      if (sp.emoji) {
        const own = sp.theme && themeChoices(features).some((c) => c.id === sp.theme) ? sp.theme : null;
        item('Remove Icon', 'space.update', { space: sp.id, name: sp.name || 'Space', emoji: null, color: /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(sp.color ?? '') ? sp.color : null, theme: own });
      }
      // Its background (M2.9: ui/behaviors/background-picker.ts), as Arc names it.
      item('Edit Theme Color…', 'space.editBackground', sp.id);
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
      // Arc's "+" (M2.10, docs/ARC-SIDEBAR.md: its popover, read from Arc), for a theme that asks for it: its order, its
      // glyphs and keys; Boost drawn, doing nothing (Tirth's choice: Margin hasn't got it yet; Arc's New Easel left out:
      // Margin won't have Easels); New Split where the host can make one (Margin.app's ⌃⇧=), New Tab.
      if (target.look === 'arc') {
        // (New Space: Arc's Create a Space, nothing made until its Create Space: ui/behaviors/ends.ts.)
        item('New Space', 'newSpace.open', undefined, { icon: 'space' });
        item('New Folder', 'folder.new', undefined, { icon: 'folder' });
        separator();
        item('New Boost', '', undefined, { icon: 'boost', inert: true, hint: 'Boosts aren’t in Margin yet: coming soon' });
        separator();
        if (features?.newSplit) item('New Split', 'split.new', undefined, { icon: 'split', keys: splitKeys(state.settings) });
        item('New Tab', 'tab.new', undefined, { icon: 'tab', keys: '⌘T' });
        break;
      }
      item('New Folder', 'folder.new');
      item('New Space', 'space.new');
      break;
    case 'profile': {
      // Create a Space's profiles: Margin.app's for the browser the new space opens in (the space in front's), by name.
      const sp = state.spaces?.find((s) => s.id === space?.id) as { browser?: string } | undefined;
      const browser = typeof sp?.browser === 'string' && sp.browser ? sp.browser : 'safari';
      const names = features?.profileNames?.names?.[browser];
      if (!names || typeof names !== 'object') return [];
      for (const [id, name] of Object.entries(names as Record<string, unknown>)) {
        if (typeof name === 'string' && id.length <= 40) item(name.slice(0, 40), 'newSpace.profile', { profile: id });
      }
      break;
    }
    default:
      return [];
  }
  while (list.at(-1)?.separator) list.pop();
  return list;
}

/** A confirming item's label (its first press): "Really delete?", as the editor's. */
export const CONFIRM_LABEL = 'Really delete?';
