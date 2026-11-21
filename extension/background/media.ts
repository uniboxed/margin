// Background Mini Player coordinator (Track 2 M2.4).
// Exact Arc behavior: shows the Mini Player ONLY when a background tab or
// hosted app is playing audio (never for the tab/app currently in front), with
// a short pause grace (PAUSE_GRACE_MS) so pausing from the Mini Player doesn't
// immediately dismiss it before the user can hit Play again.

export const PAUSE_GRACE_MS = 8_000;

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

/**
 * Selects the single background media source to display in the Mini Player
 * (or null when nothing is playing in the background or within pause grace).
 *
 * Exact Arc visibility rule:
 * - A source matching `activeTabId` (or `activeBundleId` for a hosted app) is
 *   in the foreground and MUST NOT be shown in the Mini Player.
 * - Background sources currently playing take priority over recently paused ones.
 * - Paused background sources remain eligible for `PAUSE_GRACE_MS` (8s).
 */
export function selectBackgroundMedia(
  sources: MediaSource[],
  { activeTabId = null, activeBundleId = null, now = Date.now() }: { activeTabId?: number | string | null, activeBundleId?: string | null, now?: number } = {},
): MediaSource | null {
  const eligible = sources.filter((s) => {
    if (!s) return false;
    if (s.source === 'tab' && activeTabId != null && s.tabId === activeTabId) return false;
    if (s.source === 'app' && activeBundleId && s.bundleId && s.bundleId === activeBundleId) return false;
    if (s.playing) return true;
    return s.pausedAt != null && now - s.pausedAt <= PAUSE_GRACE_MS;
  });
  if (!eligible.length) return null;
  eligible.sort((a, b) => Number(b.playing) - Number(a.playing) || b.updatedAt - a.updatedAt);
  return eligible[0];
}

export type MediaReportInput = {
  playing: boolean,
  muted?: boolean,
  title?: string,
  artist?: string,
  artwork?: string | null,
  url?: string,
  canPrev?: boolean,
  canNext?: boolean,
};

/**
 * In-memory registry of active tab media reports in the extension background.
 */
export function createMediaRegistry({ now = () => Date.now() }: { now?: () => number } = {}) {
  const byTab = new Map<number, MediaSource>();

  function report(tabId: number, input: MediaReportInput) {
    const t = now();
    const prev = byTab.get(tabId);
    const playing = !!input.playing;
    const pausedAt = playing ? null : (prev?.playing ? t : prev?.pausedAt ?? null);
    if (!playing && pausedAt == null) {
      byTab.delete(tabId);
      return null;
    }
    const next: MediaSource = {
      id: `tab:${tabId}`,
      source: 'tab',
      tabId,
      title: (input.title || prev?.title || 'Media').slice(0, 140),
      subtitle: (input.artist || prev?.subtitle || '').slice(0, 100),
      url: input.url ?? prev?.url ?? '',
      artwork: input.artwork !== undefined ? input.artwork : (prev?.artwork ?? null),
      playing,
      muted: !!input.muted,
      canPrev: input.canPrev ?? prev?.canPrev ?? false,
      canNext: input.canNext ?? prev?.canNext ?? false,
      updatedAt: t,
      pausedAt,
    };
    byTab.set(tabId, next);
    return next;
  }

  function fromAudibleTab(tab: { id: number, audible?: boolean, mutedInfo?: { muted?: boolean }, title?: string, url?: string }) {
    const prev = byTab.get(tab.id);
    if (tab.audible) {
      return report(tab.id, {
        playing: true,
        muted: !!tab.mutedInfo?.muted,
        title: prev?.title || tab.title || tab.url || 'Media',
        artist: prev?.subtitle || '',
        url: tab.url ?? prev?.url ?? '',
      });
    }
    if (prev?.playing) {
      return report(tab.id, { playing: false, muted: !!tab.mutedInfo?.muted });
    }
    return prev ?? null;
  }

  function remove(tabId: number) {
    byTab.delete(tabId);
  }

  function list(): MediaSource[] {
    const t = now();
    for (const [id, entry] of byTab) {
      if (!entry.playing && (entry.pausedAt == null || t - entry.pausedAt > PAUSE_GRACE_MS)) byTab.delete(id);
    }
    return [...byTab.values()];
  }

  function current(activeTabId: number | string | null = null): MediaSource | null {
    return selectBackgroundMedia(list(), { activeTabId, now: now() });
  }

  return { report, fromAudibleTab, remove, list, current };
}
