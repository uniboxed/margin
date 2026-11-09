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
// - nowhere a row already is (a drop that wouldn't move it is no target).

/**
 * What a drag holds: a row's kind and id.
 */
export type Drag = { kind: 'tab' | 'pin' | 'folder' | 'space', id: number | string };
export type Over = { zone: 'space', spaceId: string }
  | { zone: 'tabs', rows: number[], tab: number | null, y: number }
  | { zone: 'pins', row: { kind: 'pin' | 'folder', id: string, folder: string | null } | null, y: number }
  | { zone: 'folder', folder: string };
export type Target = { space: string }
  | { unpin: true }
  | { tab: number, side: 'before' | 'after' }
  | { into: string }
  | { folderId: string | null, beforeId: string | null, row?: { kind: 'pin' | 'folder', id: string }, side?: 'before' | 'after' };

/**
 * The ids at one level of the pinned area, in order: the top level (folders
 * and loose pins) for `folderId` null, else that folder's pins.
 * @param space the view model's space (`pinned`) */
export function levelIds(space: any, folderId: string | null): string[] {
  const pinned = space?.pinned ?? [];
  if (!folderId) return pinned.map((item) => item.id);
  return pinned.find((item) => item.isFolder && item.id === folderId)?.pins.map((p) => p.id) ?? [];
}

// The id after `id` at its level, not counting what's being dragged.
const after = (space, drag, folderId, id) => {
  const ids = levelIds(space, folderId).filter((x) => x !== drag.id);
  return ids[ids.indexOf(id) + 1] ?? null;
};

/**
 * Whether a pin or folder put at `level` before `beforeId` stays where it is.
 * */
export function stays(space: any, drag: Drag, level: string | null, beforeId: string | null) {
  if (drag.kind === 'tab') return false;
  const ids = levelIds(space, level);
  const at = ids.indexOf(String(drag.id));
  return at >= 0 && (ids[at + 1] ?? null) === (beforeId ?? null);
}

/**
 * Where a drop at `over` would go, or null (nowhere: it glides back).
 * @param space the view model's space (`id`, `pinned`)
 * */
export function dropTarget(drag: Drag, over: Over | null, space: any): Target | null {
  if (!drag || !over || drag.kind === 'space') return null; // spaces don't move (no handler)
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
    if (drag.kind === 'folder') return null;
    return drag.kind === 'pin' && levelIds(space, over.folder).includes(String(drag.id)) ? null : { into: over.folder };
  }
  if (over.zone !== 'pins') return null;
  const row = over.row;
  if (!row) return { folderId: null, beforeId: null };
  const y = over.y;
  if (row.kind === 'folder') {
    const folderId = row.id;
    const at = { kind: ('folder' as 'folder'), id: folderId };
    if (drag.kind === 'folder') {
      if (folderId === drag.id) return null;
      if (y < 0.5) return stays(space, drag, null, folderId) ? null : { folderId: null, beforeId: folderId, row: at, side: 'before' };
      // After an open folder: after its pins (the line under its last one).
      const beforeId = after(space, drag, null, folderId);
      return stays(space, drag, null, beforeId) ? null : { folderId: null, beforeId, row: at, side: 'after' };
    }
    // Its top edge: before it; the rest: into it (Arc).
    if (y < 0.25) return stays(space, drag, null, folderId) ? null : { folderId: null, beforeId: folderId, row: at, side: 'before' };
    return drag.kind === 'pin' && levelIds(space, folderId).includes(String(drag.id)) ? null : { into: folderId };
  }
  const pinId = row.id;
  const level = row.folder || null;
  if (drag.kind === 'folder' && level) return null; // folders stay at the top level
  if (drag.kind === 'pin' && pinId === drag.id) return null;
  const at = { kind: ('pin' as 'pin'), id: pinId };
  const place: Target = y < 0.5 ? { folderId: level, beforeId: pinId, row: at, side: 'before' } : { folderId: level, beforeId: after(space, drag, level, pinId), row: at, side: 'after' };
  return stays(space, drag, level, (place as any).beforeId) ? null : place;
}

/**
 * The action a drop at `where` runs (ui/actions.ts), as today's drop sends:
 * moveTabToSpace, unpin, moveTab, pinTab, movePin, moveFolder.
 * */
export function dropAction(drag: Drag, where: Target): { name: string, arg: any } {
  const w = (where as any);
  if (w.space) return { name: 'tab.moveToSpace', arg: { tab: drag.id, space: w.space } };
  if (w.unpin) return { name: 'tab.unpin', arg: String(drag.id) };
  if (w.tab != null) return { name: 'tab.move', arg: { tab: drag.id, nextTo: w.tab, side: w.side } };
  const folder = w.into ?? w.folderId ?? null;
  const before = w.into ? null : w.beforeId ?? null;
  if (drag.kind === 'tab') return { name: 'tab.pinAt', arg: { tab: drag.id, folder, before } };
  if (drag.kind === 'pin') return { name: 'pin.move', arg: { pin: String(drag.id), folder, before } };
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
