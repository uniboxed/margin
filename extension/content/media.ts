// What a page plays, for the background mini player (M2.4; background/media.ts): told to the copy as the page
// request `mediaState` when it changes, and the mini player's buttons done here (`mediaCommand`).
//
// Cost: nothing runs while nothing plays. No polling, no MutationObserver: one capturing listener on the document
// per media event (`play`, `playing`, `pause`, `ended`, `volumechange`, `loadedmetadata`, `emptied`: media events
// don't bubble, a capturing one on the document hears every <audio> and <video> in it), a report at most every
// 120 ms after one, the page's elements and controls read only then; and once as the script starts (Margin
// updated or Safari restarted while it played: that page says so again).
//
// What it reads: the page's <audio> and <video> elements, and its Media Session's metadata (title, artist, album,
// artwork), which this isolated world sees. The page's Media Session action handlers it can't call (they're the
// page world's), so Previous and Next press the page's own player buttons when it has them (a button labelled
// exactly Next or Previous, as YouTube, YouTube Music, Spotify, SoundCloud and Apple Music label theirs), and
// Previous otherwise starts the track again. Media in a frame, in a shadow root or never put in the page (an Audio()
// object) isn't seen here: Safari's `audible` for the tab stands in (background/media.ts).

export type PageMediaReport = {
  playing: boolean,
  muted: boolean,
  title: string,
  artist: string,
  artworkUrl: string,
  canPrev: boolean,
  canNext: boolean,
};
export type MediaCommand = 'toggle' | 'prev' | 'next' | 'mute';
export const MEDIA_COMMANDS: readonly MediaCommand[] = ['toggle', 'prev', 'next', 'mute'];

const EVENTS = ['play', 'playing', 'pause', 'ended', 'volumechange', 'loadedmetadata', 'emptied'] as const;
const REPORT_MS = 120;
// A player's own buttons, by their label (aria-label, else title): exactly these words, maybe with what's played and
// a shortcut in brackets ("Next (SHIFT+n)"). Never "Next page", "Skip ad" or "Back".
const NEXT = /^(next|skip to next)( (track|song|video|episode))?( \(.{1,20}\))?$/i;
const PREV = /^(previous|prev|skip to previous)( (track|song|video|episode))?( \(.{1,20}\))?$/i;
// Artwork the copy may fetch: an https address, or a data URL image of the page's own (not too big for a message).
const ARTWORK = /^(https:\/\/\S{1,2040}$|data:image\/(png|jpeg|webp|gif);base64,)/i;
const ARTWORK_DATA_MAX = 400_000;

const playingNow = (m: HTMLMediaElement) => !m.paused && !m.ended;

function mediaElements(doc: Document): HTMLMediaElement[] {
  return [...doc.querySelectorAll('audio, video')] as HTMLMediaElement[];
}

function control(doc: Document, label: RegExp): HTMLElement | null {
  for (const el of doc.querySelectorAll<HTMLElement>('button[aria-label], button[title], [role="button"][aria-label]')) {
    const name = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
    if (!label.test(name)) continue;
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true' || el.hidden) continue;
    return el;
  }
  return null;
}

function readMetadata(doc: Document): { title: string, artist: string, artworkUrl: string } {
  let meta: any = null;
  try { meta = (doc.defaultView?.navigator as any)?.mediaSession?.metadata ?? null; } catch {}
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const title = str(meta?.title, 140) || str(doc.title, 140);
  const artist = str(meta?.artist, 100) || str(meta?.album, 100);
  let artworkUrl = '';
  try {
    // The largest the page offers (its sizes "512x512"), as the mini player draws it small and sharp.
    const list: any[] = Array.isArray(meta?.artwork) ? [...meta.artwork] : [];
    const side = (a: any) => Math.max(0, ...String(a?.sizes ?? '').split(/\s+/).map((s) => Number(s.split(/x/i)[0]) || 0));
    const usable = list.filter((a) => typeof a?.src === 'string' && ARTWORK.test(a.src) && a.src.length <= ARTWORK_DATA_MAX);
    usable.sort((a, b) => side(b) - side(a));
    if (usable[0]) artworkUrl = usable[0].src;
  } catch {}
  return { title, artist, artworkUrl };
}

export function snapshotMedia(doc: Document): PageMediaReport {
  const list = mediaElements(doc);
  const active = list.find(playingNow) ?? list[0] ?? null;
  const playing = list.some(playingNow);
  const muted = active ? (active.muted || active.volume === 0) : false;
  const { title, artist, artworkUrl } = readMetadata(doc);
  // (Controls looked for only while there's media: a page with none never reads its buttons.)
  const canNext = !!active && !!control(doc, NEXT);
  const canPrev = !!active && (!!control(doc, PREV) || Number.isFinite(active.duration));
  return { playing, muted, title, artist, artworkUrl, canPrev, canNext };
}

export function applyMediaCommand(doc: Document, command: MediaCommand): boolean {
  const list = mediaElements(doc);
  const target = list.find(playingNow) ?? list[0] ?? null;
  switch (command) {
    case 'toggle':
      if (!target) return false;
      if (playingNow(target)) target.pause();
      else void Promise.resolve(target.play()).catch(() => {});
      return true;
    case 'mute':
      if (!target) return false;
      target.muted = !target.muted;
      return true;
    case 'next': {
      const button = control(doc, NEXT);
      if (!button) return false;
      button.click();
      return true;
    }
    case 'prev': {
      const button = control(doc, PREV);
      if (button) { button.click(); return true; }
      if (!target) return false;
      target.currentTime = 0;
      return true;
    }
    default:
      return false;
  }
}

export function startMedia({ doc = document, send, setTimer = setTimeout, clearTimer = clearTimeout }: {
  doc?: Document,
  send: (report: PageMediaReport) => void,
  setTimer?: (fn: () => void, ms: number) => unknown,
  clearTimer?: (t: any) => void,
}) {
  let lastKey = '';
  let timer: unknown = null;
  const report = () => {
    timer = null;
    const snap = snapshotMedia(doc);
    const key = JSON.stringify(snap);
    if (key === lastKey) return;
    // (Nothing ever played here: nothing to say.)
    if (!lastKey && !snap.playing) return;
    lastKey = key;
    send(snap);
  };
  const schedule = () => {
    if (timer != null) return;
    timer = setTimer(report, REPORT_MS);
  };
  const onEvent = (e: Event) => {
    const el = e.target as Element | null;
    if (el?.localName !== 'audio' && el?.localName !== 'video') return;
    schedule();
  };
  for (const type of EVENTS) doc.addEventListener(type, onEvent, true);
  // (Started while something plays already: Margin updated, its script put in this page again.)
  if (mediaElements(doc).some(playingNow)) schedule();
  return {
    command(cmd: unknown) {
      if (!MEDIA_COMMANDS.includes(cmd as MediaCommand)) return false;
      const ok = applyMediaCommand(doc, cmd as MediaCommand);
      schedule();
      return ok;
    },
    destroy() {
      if (timer != null) clearTimer(timer);
      for (const type of EVENTS) doc.removeEventListener(type, onEvent, true);
    },
  };
}
