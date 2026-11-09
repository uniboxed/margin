import * as M from '../state/model.ts';
import * as I from '../shared/icons.ts';
import { load, mutate, now } from './store.ts';

// Safari gives extensions no tab.favIconUrl. Each page reports its best icon
// link (content/core.ts → pageIcon); the background fetches it once per
// site — no cookies, no third-party service — shrinks it to 32×32 where the
// browser can, and stores a data: URL in state.favicons[origin]. Showing it
// later makes no network request.
const ICON_MAX_AGE = 7 * 24 * 3600_000;
export const iconInflight = new Map(); // origin → promise
const iconFailed = new Set<any>(); // `${origin} ${href}` that yielded nothing (this worker's lifetime)

// A local-network host. By name only: a public name that resolves to a private
// address (DNS rebinding) isn't caught.
const PRIVATE_HOST = /^([^.]+$|.*\.local$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[)/i;
// The page chooses the icon URL, and the background can fetch what pages
// can't: another site's icon must be https and not on a local network.
export function iconUrlAllowed(href: string, pageUrl: string | undefined) {
  if (/^data:image\//i.test(href)) return true;
  let u, page;
  try {
    u = new URL(href);
    page = new URL(pageUrl as string); // (none: it throws, and that's caught)
  } catch {
    return false;
  }
  if (!/^https?:$/.test(u.protocol)) return false;
  if (u.hostname === page.hostname) return true;
  return u.protocol === 'https:' && !PRIVATE_HOST.test(u.hostname);
}

// The same care for a style sheet: a page has its sheets fetched by the
// background (content/page-link.ts) and can read what comes back, so a sheet
// on a local network is only for a page that's on one too.
export function styleUrlAllowed(href: string, pageUrl: string) {
  try {
    const u = new URL(href);
    if (!/^https?:$/.test(u.protocol)) return false;
    if (!PRIVATE_HOST.test(u.hostname)) return true;
    const page = new URL(pageUrl);
    return u.hostname === page.hostname || PRIVATE_HOST.test(page.hostname);
  } catch {
    return false;
  }
}

async function shrinkIcon(bytes: Uint8Array<ArrayBuffer>, type: string) {
  if (type === 'image/svg+xml' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return null;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type }));
    const canvas = new OffscreenCanvas(I.SIZE, I.SIZE);
    // (A new canvas: its 2D context is there.)
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, I.SIZE, I.SIZE);
    bitmap.close?.();
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null; // e.g. a format this browser can't decode here: keep the original if small
  }
}

async function fetchIcon(href: string) {
  if (/^data:image\//i.test(href)) return href.length <= I.MAX_STORED * 1.4 ? href : null;
  const res = await fetch(href, { credentials: 'omit', signal: AbortSignal.timeout?.(6000) });
  if (!res.ok || Number(res.headers.get('content-length')) > I.MAX_DOWNLOAD) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length || bytes.length > I.MAX_DOWNLOAD) return null;
  const type = I.sniffType(bytes);
  if (!type) return null; // not an image (e.g. an HTML 404 page)
  const small = await shrinkIcon(bytes, type);
  if (small) return I.dataUrl('image/png', small);
  return bytes.length <= I.MAX_STORED ? I.dataUrl(type, bytes) : null;
}

export async function learnIcon(origin: string, href: string) {
  const s = await load();
  const known = s.favicons[origin];
  if (known && known.href === href && now() - known.at < ICON_MAX_AGE) return;
  const candidates = [...new Set([href, `${origin}/favicon.ico`])].filter((c) => !iconFailed.has(`${origin} ${c}`));
  for (const candidate of candidates) {
    const data = await fetchIcon(candidate).catch(() => null);
    if (data) {
      await mutate((st) => M.rememberFavicon(st, origin, { data, href, at: now() }));
      return;
    }
    iconFailed.add(`${origin} ${candidate}`);
  }
}
