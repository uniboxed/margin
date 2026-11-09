// What a context menu holds (ui/behaviors/menus.ts draws it from the theme's
// `menu` part): today's right-click menu on tabs, pins and folders
// (themes/arcadia/sidebar.js menuItems), the "+" menu, and one for spaces.
// Each item runs one of Margin's checked actions (ui/actions.ts), two-value
// ones included: the view model shows only the label (ui/view-model.ts),
// the runtime keeps the action. Pure: runs in Node.

import { foreignSpace, isMultiProfile, profileOf } from '../../shared/across.ts';
import { cloudShown } from '../../shared/cloud-tabs.ts';

// The space editor's swatches (Arcadia's).
export const SPACE_COLORS = Object.freeze(['#6c5ce7', '#0984e3', '#00b894', '#fdcb6e', '#e17055', '#d63031', '#e84393', '#636e72']);

export type MenuItem = { id: string, label: string, separator: boolean, danger: boolean, confirm: boolean, action: string | null, arg?: any };
export type MenuTarget = { kind: 'tab' | 'pin' | 'folder' | 'space' | 'add' | 'cloud', id?: string | number | null };

/**
 * The items of the menu for `target`, from the stored state and the space
 * as the sidebar shows it (ui/view-model.ts `space`: its `pinned` area, the
 * folders and pins in the order shown). None: no menu (its subject is gone).
 * */
export function menuItems(target: MenuTarget | null | undefined, { state, space }: { state: any, space: any }): MenuItem[] {
  if (!target || !state) return [];
  const list = [];
  let n = 0;
  let s = 0;
  const item = (label, action, arg?, extra = {}) => list.push({ id: `i${n++}`, label, separator: false, danger: false, confirm: false, action, ...(arg === undefined ? {} : { arg }), ...extra });
  const separator = () => { if (list.length && !list.at(-1).separator) list.push({ id: `s${s++}`, label: '', separator: true, danger: false, confirm: false, action: null }); };
  const pinned = space?.pinned ?? [];
  const folders = pinned.filter((p) => p.isFolder);
  const shownPins = pinned.flatMap((p) => (p.isFolder ? p.pins : [p]));
  switch (target.kind) {
    case 'folder': {
      const folder = (state.folders ?? []).find((f) => f.id === target.id);
      if (!folder) return [];
      item('Rename Folder', 'folder.rename', folder.id);
      item(folder.open === false ? 'Open Folder' : 'Close Folder', 'folder.toggle', folder.id);
      separator();
      item('Delete Folder (pins stay)', 'folder.delete', folder.id, { danger: true });
      break;
    }
    case 'pin': {
      const pin = (state.pins ?? []).find((p) => p.id === target.id);
      if (!pin) return [];
      const shown = shownPins.find((p) => p.id === pin.id);
      item('Unpin', 'tab.unpin', pin.id);
      separator();
      for (const f of folders) if (f.id !== shown?.folderId) item(`Move to 📁 ${f.name}`, 'pin.move', { pin: pin.id, folder: f.id, before: null });
      if (shown?.folderId) item('Remove from Folder', 'pin.move', { pin: pin.id, folder: null, before: null });
      item('New Folder with Pin', 'folder.newWithPin', pin.id);
      if (shown?.tabId != null && state.tabs?.[shown.tabId]) {
        separator();
        item('Close Tab', 'tab.close', shown.tabId);
      }
      break;
    }
    case 'tab': {
      // An open tab (the browser's id), or a Margin tab that isn't open (its
      // own id: the same menu; closing it archives it).
      const tabId = target.id;
      const kept = typeof tabId === 'string' ? state.keptTabs?.[tabId] : null;
      if (!kept && (!Number.isInteger(tabId) || !state.tabs?.[tabId])) return [];
      item('Pin Tab', 'tab.pin', tabId);
      for (const f of folders) item(`Pin to 📁 ${f.name}`, 'tab.pinAt', { tab: tabId, folder: f.id, before: null });
      item('New Folder with Tab', 'folder.newWithTab', tabId);
      const spaceId = kept ? kept.spaceId : state.tabSpace?.[tabId];
      const others = (state.spaces ?? []).filter((sp) => sp.id !== spaceId);
      if (others.length) {
        separator();
        for (const sp of others) item(`Move to ${sp.emoji} ${sp.name}`, 'tab.moveToSpace', { tab: tabId, space: sp.id });
      }
      separator();
      item('Close Tab', 'tab.close', tabId);
      break;
    }
    case 'space': {
      const across = isMultiProfile(state.across) ? state.across : null;
      // Another profile's space (Margin.app): switching to it, moving it, its profile.
      const foreign = across ? foreignSpace(across, String(target.id)) : null;
      if (foreign) {
        const p = profileOf(across, foreign.profile);
        item('Switch to Space', 'space.switch', target.id);
        separator();
        item('Move Left', 'space.move', { space: target.id, dir: -1 });
        item('Move Right', 'space.move', { space: target.id, dir: 1 });
        separator();
        item(`Edit Profile “${p?.name ?? 'Profile'}”…`, 'profile.edit', foreign.profile);
        item(`New Space in ${p?.name ?? 'Profile'}`, 'space.newIn', foreign.profile);
        // One that isn't open in the browser (gone, or not used for long): out of the list until it opens again.
        if (p && !p.linked) {
          separator();
          item(p.stale ? `Forget ${p.name} (not seen for a month)` : `Forget ${p.name}`, 'profile.forget', foreign.profile, { danger: true, confirm: true });
        }
        break;
      }
      const sp = (state.spaces ?? []).find((x) => x.id === target.id);
      if (!sp) return [];
      item('Edit Space…', 'space.edit', sp.id);
      item('Rename Space', 'space.rename', sp.id);
      if (across) {
        separator();
        item('Move Left', 'space.move', { space: sp.id, dir: -1 });
        item('Move Right', 'space.move', { space: sp.id, dir: 1 });
      }
      separator();
      item('New Space', 'space.new');
      if (across) {
        const here = profileOf(across, across.profile);
        item(`Edit Profile “${here?.name ?? 'Profile'}”…`, 'profile.edit', across.profile);
      }
      // A profile's last space can't be deleted (the editor's rule); a second press confirms.
      if (state.spaces.length > 1) {
        separator();
        item('Delete Space', 'space.delete', sp.id, { danger: true, confirm: true });
      }
      break;
    }
    case 'cloud': {
      // A tab of iCloud Tabs (on another device): opened here, or its address
      // copied. Margin can't close it there, and there's no "new window with
      // this address" request to offer.
      const tab = cloudShown(state)?.devices.flatMap((d) => d.tabs).find((t) => t.id === target.id);
      if (!tab) return [];
      item('Open', 'cloud.open', tab.id);
      item('Copy Link', 'cloud.copy', tab.id);
      break;
    }
    case 'add':
      item('New Folder', 'folder.new');
      item('New Space', 'space.new');
      // Several profiles: a new space in another one (made there; it shows in the list at once).
      if (isMultiProfile(state.across)) {
        for (const p of state.across.profiles) if (!p.here && p.spaces > 0) item(`New Space in ${p.name}`, 'space.newIn', p.id);
      }
      break;
    default:
      return [];
  }
  while (list.at(-1)?.separator) list.pop();
  return list;
}

/** A confirming item's label (its first press): "Really delete?", as the editor's. */
export const CONFIRM_LABEL = 'Really delete?';
