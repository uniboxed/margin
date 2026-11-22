// A space's item used last (the selected one breaks a tie, then its id): the item a split is made with when another is
// added to it (Margin.app's library, app/shared/library/library.ts `addToSplit`), and the one the page's room check
// pairs the added one with (ui/behaviors/split.ts `refusesAdd`). One rule for both: the real screen, 2026-11-21 19:32,
// "Add to Split View" on the row of the Safari tab in front split it with Notes (used before it), while the page's check
// measured that tab beside itself (574 + 574: fits), so a split that couldn't fit (Notes' 701 + 574 in 1264) was made.
export type FrontCandidate = { id: string, spaceId?: unknown, lastActive?: unknown, wasActive?: unknown };

const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function frontItemOf<K extends FrontCandidate>(items: Iterable<K>, spaceId: unknown, except: string | null = null): K | null {
  let best: K | null = null;
  for (const k of items) {
    if (!k || k.spaceId !== spaceId || k.id === except) continue;
    if (!best) { best = k; continue; }
    const d = finite(k.lastActive) - finite(best.lastActive) || Number(!!k.wasActive) - Number(!!best.wasActive) || best.id.localeCompare(k.id);
    if (d > 0) best = k;
  }
  return best;
}
