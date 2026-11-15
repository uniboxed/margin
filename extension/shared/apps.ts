// Installed apps (Margin.app with `MarginHosted` on: docs/MARGIN-APP.md, phase 4): the Mac's apps Margin can
// host in its page area, as the app read them (app/platforms/macos/shell/AppCatalog.swift) and gives every
// overlay (`apps` in its hello, then `{ type: 'apps', apps }`: docs/PROTOCOL.md "Installed apps"). The palette
// finds them (shared/search.ts), and picking one asks the app to open it (`app.open`). This file checks what
// the app sent (`appsOf`). Pure: no browser APIs, runs in Node.

export type InstalledApp = { bundleId: string, name: string, icon: string | null };

export const MAX_APPS = 3000;
// A bundle id as macOS allows it (letters, digits, '-', '.'; '_' too, which older apps use).
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
// The app's icons: small PNGs, base64.
const ICON = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
const ICON_MAX = 64 * 1024;
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

export const isBundleId = (v: unknown): v is string => typeof v === 'string' && BUNDLE_ID.test(v);

/**
 * What the app sent, checked and capped (a bad entry is left out, a bundle id listed twice kept once):
 * null when there's nothing (hosting off, or not read yet).
 * */
export function appsOf(raw: unknown): InstalledApp[] | null {
  if (!Array.isArray(raw)) return null;
  const out: InstalledApp[] = [];
  const seen = new Set<string>();
  for (const a of raw) {
    if (out.length >= MAX_APPS) break;
    if (!a || typeof a !== 'object' || !isBundleId(a.bundleId) || seen.has(a.bundleId.toLowerCase())) continue;
    const name = typeof a.name === 'string' ? plain(a.name.slice(0, 128)) : '';
    if (!name) continue;
    seen.add(a.bundleId.toLowerCase());
    const icon = typeof a.icon === 'string' && a.icon.length <= ICON_MAX && ICON.test(a.icon) ? a.icon : null;
    out.push({ bundleId: a.bundleId, name, icon });
  }
  return out;
}
