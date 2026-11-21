// Event-driven media state tracker for web pages (Track 2 M2.4 Mini Player).
// Zero polling: reacts solely to DOM media events (`play`, `pause`, `ended`,
// `volumechange`, `loadedmetadata`) on `<audio>`/`<video>` elements and reads
// `navigator.mediaSession.metadata` when present. Also handles remote control
// commands (`toggle`, `prev`, `next`, `mute`) from Margin's background.

export type PageMediaReport = {
  playing: boolean,
  muted: boolean,
  title: string,
  artist: string,
  artworkUrl: string,
};

function mediaElements(doc: Document): HTMLMediaElement[] {
  return [...doc.querySelectorAll('audio, video')] as HTMLMediaElement[];
}

function readMetadata(doc: Document): { title: string, artist: string, artworkUrl: string } {
  const meta = (doc.defaultView?.navigator as any)?.mediaSession?.metadata;
  const title = typeof meta?.title === 'string' && meta.title.trim() ? meta.title.trim().slice(0, 140) : (doc.title || '').trim().slice(0, 140);
  const artist = typeof meta?.artist === 'string' && meta.artist.trim()
    ? meta.artist.trim().slice(0, 100)
    : typeof meta?.album === 'string' && meta.album.trim()
      ? meta.album.trim().slice(0, 100)
      : '';
  let artworkUrl = '';
  if (Array.isArray(meta?.artwork) && meta.artwork.length) {
    const pick = meta.artwork.find((a: any) => typeof a?.src === 'string' && /^(https?:|data:image\/)/i.test(a.src));
    if (pick?.src) artworkUrl = pick.src;
  }
  return { title, artist, artworkUrl };
}

export function snapshotMedia(doc: Document): PageMediaReport {
  const list = mediaElements(doc);
  const active = list.find((m) => !m.paused && !m.ended) ?? list[0] ?? null;
  const playing = list.some((m) => !m.paused && !m.ended);
  const muted = active ? (active.muted || active.volume === 0) : false;
  const { title, artist, artworkUrl } = readMetadata(doc);
  return { playing, muted, title, artist, artworkUrl };
}

export function applyMediaCommand(doc: Document, command: 'toggle' | 'prev' | 'next' | 'mute'): boolean {
  const list = mediaElements(doc);
  const playing = list.find((m) => !m.paused && !m.ended);
  const target = playing ?? list[0] ?? null;
  if (command === 'toggle') {
    if (!target) return false;
    if (!target.paused && !target.ended) { target.pause(); return true; }
    void Promise.resolve(target.play()).catch(() => {});
    return true;
  }
  if (command === 'mute') {
    if (!target) return false;
    target.muted = !target.muted;
    return true;
  }
  // Best-effort prev/next: dispatch standard MediaTrack keys or seek restart for prev.
  if (command === 'prev' && target) {
    if (target.currentTime > 3) { target.currentTime = 0; return true; }
    return false;
  }
  return false;
}

export function startMedia({ doc = document, send }: { doc?: Document, send: (report: PageMediaReport) => void }) {
  let lastKey = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  const report = () => {
    timer = null;
    const snap = snapshotMedia(doc);
    const key = `${snap.playing}:${snap.muted}:${snap.title}:${snap.artist}:${snap.artworkUrl}`;
    if (key === lastKey) return;
    lastKey = key;
    send(snap);
  };
  const schedule = () => {
    if (timer != null) return;
    timer = setTimeout(report, 120);
  };
  const onEvent = (e: Event) => {
    const el = e.target as Element | null;
    if (!el || (el.tagName !== 'AUDIO' && el.tagName !== 'VIDEO')) return;
    schedule();
  };
  const events = ['play', 'pause', 'ended', 'volumechange', 'loadedmetadata'] as const;
  for (const type of events) doc.addEventListener(type, onEvent, true);
  return {
    command: (cmd: 'toggle' | 'prev' | 'next' | 'mute') => {
      const ok = applyMediaCommand(doc, cmd);
      schedule();
      return ok;
    },
    destroy() {
      if (timer != null) clearTimeout(timer);
      for (const type of events) doc.removeEventListener(type, onEvent, true);
    },
  };
}
