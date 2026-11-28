// Where a dragged row goes (ui/behaviors/drag.ts), today's rules
// (themes/arcadia/sidebar.js dropTarget, stays, drop) without the DOM: the
// drag layer says what's under the pointer, these say what a drop there
// does, and which action it runs. Pure: runs in Node.
//
// The rules (Arc's):
// - a tab dropped on another space's chip moves there;
// - in the tabs: a tab goes before or after the tab under the pointer (the
//   browser's own order follows); a pin dropped there is unpinned (its tab
//   stays open, as a tab);
// - in the pinned area: on a folder's row, its top quarter is before it and
//   the rest into it (a folder dragged: its top half before, the rest after
//   it and its pins); on a pin's row, before (top half) or after it, at its
//   level; below the last row, the end of the top level. A tab dropped there
//   is pinned in that place, a pin moves there, folders stay at the top level;
// - nowhere a row already is (a drop that wouldn't move it is no target);
// - on the page (Margin's own window, docs/FLEX-SPLIT.md step 2): a tab beside the page shown, between two panes or
//   in a pane's place, beside a pane on any side (where: ui/behaviors/split.ts dropAt, which says it as the
//   `split.drop` it runs).
import type { FolderRow, SpaceView } from '../view-model.ts';
import { MAX_FOLDER_DEPTH } from '../../../../extension/shared/pinned-rules.ts';

/**
 * What a drag holds: a row's kind and id.
 */
export type Drag = { kind: 'tab' | 'pin' | 'folder' | 'space' | 'favorite', id: number | string };
export type Over = { zone: 'space', spaceId: string }
  | { zone: 'tabs', rows: number[], tab: number | null, y: number }
  | { zone: 'pins', row: { kind: 'pin' | 'folder', id: string, folder: string | null } | null, y: number }
  | { zone: 'folder', folder: string }
  | { zone: 'favorites', rows: string[], favorite: string | null, x: number }
  | { zone: 'page', drop: SplitDrop };
/** A row dropped on the page: `split.drop`'s argument (ui/actions.ts). */
export type SplitDrop = { tab: number | string, split: string | null, nextTo: number | string | null, pane: number | null, side: 'left' | 'right' | 'top' | 'bottom' | 'middle' };
export type Target = { space: string }
  | { unpin: true }
  | { unfavorite: true }
  | { favoriteAdd: true }
  | { favoriteBefore: string | null }
  | { tab: number, side: 'before' | 'after' }
  | { into: string }
  | { folderId: string | null, beforeId: string | null, row?: { kind: 'pin' | 'folder', id: string }, side?: 'before' | 'after' }
  | { page: SplitDrop };

function allFlat(space: SpaceView | null | undefined) {
  if (space?.pinnedFlat) return space.pinnedFlat;
  const out: (FolderRow | SpaceView['pinned'][number])[] = [];
  for (const item of space?.pinned ?? []) {
    out.push(item);
    if (item.isFolder) out.push(...item.pins);
  }
  return out;
}

function folderMap(space: SpaceView | null | undefined) {
  const byId = new Map<string, FolderRow>();
  for (const item of allFlat(space)) if (item.isFolder) byId.set(item.id, item);
  return byId;
}

function depthOf(byId: Map<string, FolderRow>, id: string): number {
  let d = 0;
  let cur: string | null = id;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const parent: string | null = byId.get(cur)?.parentFolderId ?? null;
    if (!parent) break;
    d++;
    cur = parent;
  }
  return d;
}

function hasAncestor(byId: Map<string, FolderRow>, id: string, ancestorId: string): boolean {
  let cur: string | null = id;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    if (cur === ancestorId) return true;
    seen.add(cur);
    cur = byId.get(cur)?.parentFolderId ?? null;
  }
  return false;
}

function subtreeHeight(byId: Map<string, FolderRow>, id: string, seen = new Set<string>()): number {
  if (seen.has(id)) return 0;
  seen.add(id);
  let best = 0;
  for (const f of byId.values()) {
    if (f.parentFolderId === id) best = Math.max(best, 1 + subtreeHeight(byId, f.id, seen));
  }
  return best;
}

function canNestFolder(space: SpaceView | null | undefined, folderId: string, parentId: string | null): boolean {
  if (!parentId) return true;
  if (folderId === parentId) return false;
  const byId = folderMap(space);
  if (!byId.has(parentId)) return false;
  if (hasAncestor(byId, parentId, folderId)) return false;
  return depthOf(byId, parentId) + 1 + subtreeHeight(byId, folderId) < MAX_FOLDER_DEPTH;
}

/**
 * The ids at one level of the pinned area, in order: the top level (folders
 * and loose pins) for `folderId` null, else that folder's direct children
 * (subfolders and pins).
 * @param space the view model's space (`pinned` / `pinnedFlat`) */
export function levelIds(space: SpaceView | null | undefined, folderId: string | null): string[] {
  if (space?.pinnedFlat) {
    return space.pinnedFlat
      .filter((item) => (item.isFolder ? (item.parentFolderId ?? null) : (item.folderId ?? null)) === (folderId ?? null))
      .map((item) => item.id);
  }
  const pinned = space?.pinned ?? [];
  if (!folderId) return pinned.map((item) => item.id);
  return pinned.find((item): item is FolderRow => item.isFolder && item.id === folderId)?.pins.map((p) => p.id) ?? [];
}

// The id after `id` at its level, not counting what's being dragged.
const after = (space: SpaceView | null | undefined, drag: Drag, folderId: null | string, id: string) => {
  const ids = levelIds(space, folderId).filter((x) => x !== drag.id);
  return ids[ids.indexOf(id) + 1] ?? null;
};

/**
 * Whether a pin or folder put at `level` before `beforeId` stays where it is.
 * */
export function stays(space: SpaceView | null | undefined, drag: Drag, level: string | null, beforeId: string | null) {
  if (drag.kind === 'tab') return false;
  const ids = levelIds(space, level);
  const at = ids.indexOf(String(drag.id));
  return at >= 0 && (ids[at + 1] ?? null) === (beforeId ?? null);
}

/**
 * Where a drop at `over` would go, or null (nowhere: it glides back).
 * @param space the view model's space (`id`, `pinned`, `pinnedFlat`)
 * */
export function dropTarget(drag: Drag, over: Over | null, space: SpaceView | null | undefined): Target | null {
  if (!drag || !over || drag.kind === 'space') return null; // spaces don't move (no handler)
  if (over.zone === 'page') return drag.kind === 'tab' && over.drop.tab === drag.id ? { page: over.drop } : null;
  if (over.zone === 'favorites') {
    if (drag.kind === 'tab' || drag.kind === 'pin') return { favoriteAdd: true };
    if (drag.kind !== 'favorite') return null;
    if (!over.favorite) {
      const last = over.rows.at(-1);
      return last === String(drag.id) ? null : { favoriteBefore: null };
    }
    const id = String(drag.id);
    if (over.favorite === id) return null;
    const at = over.rows.indexOf(over.favorite);
    const own = over.rows.indexOf(id);
    if (over.x < 0.5) {
      if (at === own + 1) return null;
      return { favoriteBefore: over.favorite };
    }
    const next = over.rows[at + 1] ?? null;
    if (next === id) return null;
    return { favoriteBefore: next };
  }
  if (drag.kind === 'favorite') {
    return over.zone === 'tabs' ? { unfavorite: true } : null;
  }
  if (over.zone === 'space') return drag.kind === 'tab' && over.spaceId !== space?.id ? { space: over.spaceId } : null;
  if (over.zone === 'tabs') {
    if (drag.kind === 'pin') return { unpin: true };
    if (drag.kind !== 'tab' || over.tab == null) return null;
    const side = over.y < 0.5 ? 'before' : 'after';
    const at = over.rows.indexOf(over.tab);
    const own = over.rows.indexOf((drag.id as number));
    // Where it is already: nowhere to go.
    if (over.tab === drag.id || (side === 'before' && at === own + 1) || (side === 'after' && at === own - 1)) return null;
    return { tab: over.tab, side };
  }
  if (over.zone === 'folder') {
    if (drag.kind === 'folder') {
      const id = String(drag.id);
      if (!canNestFolder(space, id, over.folder)) return null;
      return levelIds(space, over.folder).includes(id) ? null : { into: over.folder };
    }
    return drag.kind === 'pin' && levelIds(space, over.folder).includes(String(drag.id)) ? null : { into: over.folder };
  }
  if (over.zone !== 'pins') return null;
  const row = over.row;
  if (!row) return stays(space, drag, null, null) ? null : { folderId: null, beforeId: null };
  const y = over.y;
  if (row.kind === 'folder') {
    const folderId = row.id;
    const level = row.folder || null;
    const at = { kind: ('folder' as 'folder'), id: folderId };
    if (drag.kind === 'folder') {
      const id = String(drag.id);
      if (folderId === id) return null;
      // Middle band nests into the target folder (when valid and not already a direct child); edges place before/after at its level.
      if (y >= 0.25 && y <= 0.75 && canNestFolder(space, id, folderId)) {
        return levelIds(space, folderId).includes(id) ? null : { into: folderId };
      }
      if (!canNestFolder(space, id, level)) return null;
      if (y < 0.5) return stays(space, drag, level, folderId) ? null : { folderId: level, beforeId: folderId, row: at, side: 'before' };
      // After an open folder: after its children (the line under its last one).
      const beforeId = after(space, drag, level, folderId);
      return stays(space, drag, level, beforeId) ? null : { folderId: level, beforeId, row: at, side: 'after' };
    }
    // Its top edge: before it; the rest: into it (Arc).
    if (y < 0.25) return stays(space, drag, level, folderId) ? null : { folderId: level, beforeId: folderId, row: at, side: 'before' };
    return drag.kind === 'pin' && levelIds(space, folderId).includes(String(drag.id)) ? null : { into: folderId };
  }
  const pinId = row.id;
  const level = row.folder || null;
  if (drag.kind === 'folder' && !canNestFolder(space, String(drag.id), level)) return null;
  if (drag.kind === 'pin' && pinId === drag.id) return null;
  const at = { kind: ('pin' as 'pin'), id: pinId };
  const place: Target = y < 0.5 ? { folderId: level, beforeId: pinId, row: at, side: 'before' } : { folderId: level, beforeId: after(space, drag, level, pinId), row: at, side: 'after' };
  return stays(space, drag, level, (place as any).beforeId) ? null : place;
}

/**
 * The action a drop at `where` runs (ui/actions.ts), as today's drop sends:
 * moveTabToSpace, unpin, moveTab, pinTab, movePin, moveFolder / nestFolder.
 * */
export function dropAction(drag: Drag, where: Target): { name: string, arg: any } {
  const w = (where as any);
  if (w.page) return { name: 'split.drop', arg: w.page };
  if (w.space) return { name: 'tab.moveToSpace', arg: { tab: drag.id, space: w.space } };
  if (w.unpin) return { name: 'tab.unpin', arg: String(drag.id) };
  if (w.unfavorite) return { name: 'favorite.remove', arg: String(drag.id) };
  if (w.favoriteAdd) return drag.kind === 'pin' ? { name: 'favorite.addPin', arg: String(drag.id) } : { name: 'favorite.add', arg: drag.id };
  if ('favoriteBefore' in w) return { name: 'favorite.move', arg: { favorite: String(drag.id), before: w.favoriteBefore ?? null } };
  if (w.tab != null) return { name: 'tab.move', arg: { tab: drag.id, nextTo: w.tab, side: w.side } };
  const folder = w.into ?? w.folderId ?? null;
  const before = w.into ? null : w.beforeId ?? null;
  if (drag.kind === 'tab') return { name: 'tab.pinAt', arg: { tab: drag.id, folder, before } };
  if (drag.kind === 'pin') return { name: 'pin.move', arg: { pin: String(drag.id), folder, before } };
  if (folder != null) return { name: 'folder.nest', arg: { folder: String(drag.id), parent: folder, before } };
  return { name: 'folder.move', arg: { folder: String(drag.id), before } };
}

/**
 * Where a tab dragged next to another lands in the window's own order
 * (background/handlers.ts moveTab). The sidebar lists tabs newest first, the
 * reverse of the window's order: above `other` in the list ('before') is
 * just after it in the window, below it ('after') just before. The index is
 * the one tabs.move takes: the tab's own place counts until it moves.
 * @param from the dragged tab's index @param to the other tab's index */
export function moveIndex(from: number, to: number, side: 'before' | 'after') {
  return side === 'before' ? (from < to ? to : to + 1) : (from < to ? to - 1 : to);
}
