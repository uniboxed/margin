// The background mini player's one rule (M2.4), shared by the copy (background/media.ts) and the UI
// (ui/view-model.ts): which of the sources playing is the one the mini player shows.
//
// As Arc: only media playing in the background. A source that is the tab (or, later, the app) in front of the
// window drawing the mini player is never it: the page itself shows it. Playing ones before paused ones, the newest
// first. A paused one stays for PAUSE_GRACE_MS after it paused (so Play is still there after a Pause pressed in the
// mini player), then goes.

export const PAUSE_GRACE_MS = 30_000;

export type MediaSource = {
  id: string,
  source: 'tab' | 'app',
  tabId: number | string | null,
  bundleId?: string | null,
  title: string,
  subtitle: string,
  url?: string,
  artwork?: string | null,
  icon?: string | null,
  playing: boolean,
  muted: boolean,
  canPrev?: boolean,
  canNext?: boolean,
  updatedAt: number,
  pausedAt?: number | null,
};

/** Whether a paused source's grace is over at `now` (a playing one never is). */
export const graceOver = (s: Pick<MediaSource, 'playing' | 'pausedAt'>, now: number) =>
  !s.playing && (s.pausedAt == null || now - s.pausedAt > PAUSE_GRACE_MS);

/**
 * The one background source the mini player shows, or null: nothing playing in the background, nor paused within
 * its grace. `activeTabId` (`activeBundleId` for a hosted app): what's in front, never shown.
 */
export function selectBackgroundMedia(
  sources: readonly (MediaSource | null | undefined)[],
  { activeTabId = null, activeBundleId = null, now = Date.now() }: { activeTabId?: number | string | null, activeBundleId?: string | null, now?: number } = {},
): MediaSource | null {
  const eligible = sources.filter((s): s is MediaSource => {
    if (!s) return false;
    if (s.source === 'tab' && activeTabId != null && s.tabId === activeTabId) return false;
    if (s.source === 'app' && activeBundleId && s.bundleId && s.bundleId === activeBundleId) return false;
    return !graceOver(s, now);
  });
  if (!eligible.length) return null;
  eligible.sort((a, b) => Number(b.playing) - Number(a.playing) || b.updatedAt - a.updatedAt);
  return eligible[0];
}
