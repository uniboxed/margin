// The pinned area's and the favorites' rules the pages need as the background has them (state/model.ts): how many
// favorites a scope holds, how deep folders nest, a folder's depth, and which favorites a space shows. Here so the
// content script and the UI read them without loading the model (and the themes it pulls in): tests/layering.test.ts.
// Pure, no browser APIs. state/model.ts takes them from here (one copy).
import type { State } from '../../types/margin';

/** Favorites in one scope, at most. */
export const FAVORITES_CAP = 12;
/** Folders nest this many levels deep, the top one counted. */
export const MAX_FOLDER_DEPTH = 4;

/** The favorites a space shows: everyone's ('global'), or its browser profile's (Settings' favoritesScope 'profile'). */
export function favoriteScopeOf(state: Pick<State, 'settings' | 'spaces'>, spaceId?: string | null): string {
  if (state.settings?.favoritesScope !== 'profile') return 'global';
  const sp: any = spaceId ? state.spaces.find((s) => s.id === spaceId) : null;
  const profile = typeof sp?.profile === 'string' && sp.profile ? sp.profile : 'default';
  return `profile:${profile}`;
}

/** How many folders a folder is inside (0: at the top), its space's only, a cycle in stored data cut. */
export function folderDepth(state: Pick<State, 'folders'>, folderId: string | null | undefined, spaceId: string): number {
  const folderIn = (id: string | null | undefined) => (state.folders ?? []).find((f) => f.id === id && f.spaceId === spaceId) ?? null;
  let depth = 0;
  const seen = new Set<string>();
  let cur = folderId ? folderIn(folderId) : null;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const parent = cur.parentId ? folderIn(cur.parentId) : null;
    if (!parent) break;
    depth++;
    cur = parent;
  }
  return depth;
}

const pinOfSpace = (state: Pick<State, 'pins'>, pinId: unknown, spaceId: string | null | undefined) => typeof pinId === 'string' && !!pinId && state.pins.some((p) => p.id === pinId && p.spaceId === spaceId);
const hasFavorite = (state: Pick<State, 'favorites'>, favoriteId: unknown) => typeof favoriteId === 'string' && !!favoriteId && (state.favorites ?? []).some((f) => f.id === favoriteId);

/** Whether a tab of `spaceId` belongs to a pin other than `pinId` or a favorite other than `favoriteId` (a pin's or
 * favorite's search by address never takes another's tab). */
export function boundElsewhere(state: Pick<State, 'pins' | 'favorites'>, r: { pinnedBy?: string, favoriteId?: string } | null | undefined, spaceId: string | null | undefined, { pinId = null, favoriteId = null }: { pinId?: string | null, favoriteId?: string | null } = {}) {
  if (!r) return false;
  if (r.pinnedBy && r.pinnedBy !== pinId && pinOfSpace(state, r.pinnedBy, spaceId)) return true;
  if (r.favoriteId && r.favoriteId !== favoriteId && hasFavorite(state, r.favoriteId)) return true;
  return false;
}
