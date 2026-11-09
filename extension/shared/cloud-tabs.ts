// iCloud Tabs (Margin.app with Safari; DECISIONS.md "Margin 2: iCloud Tabs"):
// the tabs open in Safari on the person's other Apple devices, which the app
// reads from Safari's own file (app/shell/CloudTabs.swift) and gives each
// Safari overlay (`cloudTabs` in its hello, then `{ type: 'cloudTabs' }`:
// app/PROTOCOL.md). The extension never has them. This file checks what the
// app sent (`cloudOf`), says whether they're shown (`cloudShown`: the
// "Show iCloud Tabs" setting), and has Margin's words for them (a device's
// name told apart from another's, "updated 5 min ago", "On Tirth's iPhone"),
// for the view model (ui/view-model.ts `cloudTabs`) and the palette
// (shared/search.ts). Pure: no browser APIs, runs in Node.

export type CloudTab = { id: string, title: string, url: string, pinned: boolean, viewedAt: number };
export type CloudDevice = { id: string, name: string, kind: 'phone' | 'pad' | 'mac' | 'vision' | 'other', model: string, modifiedAt: number, ephemeral: boolean, duplicateName: boolean, tabs: CloudTab[] };
export type CloudTabs = { status: 'ready' | 'noAccess' | 'noData' | 'failed', devices: CloudDevice[] };

export const MAX_DEVICES = 50;
export const MAX_TABS = 500;
const KINDS = new Set(['phone', 'pad', 'mac', 'vision', 'other']);
const STATUSES = new Set(['ready', 'noAccess', 'noData', 'failed']);
const ID = /^[A-Za-z0-9_:.-]{1,64}$/;
// A device not used for this long is shown dimmed.
export const STALE_MS = 7 * 24 * 3600 * 1000;

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const time = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
// eslint-disable-next-line no-control-regex
const plain = (s) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
const webUrl = (u) => typeof u === 'string' && u.length <= 4096 && /^https?:\/\/[^\s]+$/i.test(u);

/**
 * What the app sent, checked and capped (a bad device or tab is left out):
 * null when there's nothing usable (not Safari, or not read yet).
 * */
export function cloudOf(raw: any): CloudTabs | null {
  if (!raw || typeof raw !== 'object' || !STATUSES.has(raw.status)) return null;
  const devices: CloudDevice[] = [];
  const seen = new Set<any>();
  for (const d of Array.isArray(raw.devices) ? raw.devices : []) {
    if (devices.length >= MAX_DEVICES) break;
    if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !ID.test(d.id) || seen.has(d.id)) continue;
    seen.add(d.id);
    const ids = new Set<any>();
    const tabs: CloudTab[] = [];
    for (const t of Array.isArray(d.tabs) ? d.tabs : []) {
      if (tabs.length >= MAX_TABS) break;
      if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !ID.test(t.id) || ids.has(t.id) || !webUrl(t.url)) continue;
      ids.add(t.id);
      tabs.push({ id: t.id, title: plain(str(t.title, 300)), url: t.url, pinned: t.pinned === true, viewedAt: time(t.viewedAt) });
    }
    if (!tabs.length) continue;
    devices.push({
      id: d.id, name: plain(str(d.name, 128)), kind: KINDS.has(d.kind) ? d.kind : 'other', model: str(d.model, 128),
      modifiedAt: time(d.modifiedAt), ephemeral: d.ephemeral === true, duplicateName: d.duplicateName === true, tabs,
    });
  }
  return { status: raw.status, devices: raw.status === 'ready' ? devices : [] };
}

/** iCloud Tabs as shown: the app's (state.cloudTabs), unless Settings turned them off. */
export function cloudShown(state: any): CloudTabs | null {
  const cloud = state?.cloudTabs;
  if (!cloud || typeof cloud !== 'object' || state?.settings?.showCloudTabs === false) return null;
  return cloud;
}

const KIND_NAMES = { phone: 'iPhone', pad: 'iPad', mac: 'Mac', vision: 'Apple Vision Pro', other: 'Device' };

/**
 * Each device's name as shown: Safari's, told apart where two read the same
 * (Safari's own flag, or the same name here): "Name (iPhone)", then
 * "Name (iPhone 2)". A device with no name: its kind's.
 * */
export function deviceNames(devices: CloudDevice[]): Map<string, string> {
  const base = (d) => d.name || KIND_NAMES[d.kind] || 'Device';
  const count = new Map();
  for (const d of devices) count.set(base(d).toLowerCase(), (count.get(base(d).toLowerCase()) ?? 0) + 1);
  const out = new Map();
  const used = new Map();
  for (const d of devices) {
    const name = base(d);
    if ((count.get(name.toLowerCase()) ?? 0) < 2 && !d.duplicateName) { out.set(d.id, name); continue; }
    const kind = KIND_NAMES[d.kind] ?? 'Device';
    const key = `${name.toLowerCase()}\u0000${kind}`;
    const n = (used.get(key) ?? 0) + 1;
    used.set(key, n);
    out.set(d.id, d.name ? `${name} (${kind}${n > 1 ? ` ${n}` : ''})` : `${kind}${n > 1 ? ` ${n}` : ''}`);
  }
  return out;
}

/** When the device was last used: its newest tab viewed, or its record's time. */
export function lastUsed(d: CloudDevice) {
  const viewed = Math.max(0, ...d.tabs.map((t) => t.viewedAt));
  return { at: Math.max(viewed, d.modifiedAt), exact: viewed >= d.modifiedAt || !atMidnight(d.modifiedAt) };
}

// Safari keeps a device's record time rounded to the local day.
const atMidnight = (ms) => { const t = new Date(ms); return t.getHours() === 0 && t.getMinutes() === 0 && t.getSeconds() === 0 && t.getMilliseconds() === 0; };
const dayStart = (ms) => { const t = new Date(ms); t.setHours(0, 0, 0, 0); return t.getTime(); };

/**
 * "updated 5 min ago" (Margin's words): to the minute when the time is
 * exact, to the day when it's only the day Safari recorded.
 * */
export function updatedText(at: number, exact: boolean, now: number): string {
  if (!at) return '';
  const days = Math.round((dayStart(now) - dayStart(at)) / 86_400_000);
  const dayText = () => (days <= 0 ? 'updated today' : days === 1 ? 'updated yesterday' : days < 60 ? `updated ${days} days ago` : `updated ${Math.round(days / 30)} months ago`);
  if (!exact) return dayText();
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return 'updated just now';
  if (minutes < 60) return `updated ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `updated ${hours} h ago` : dayText();
}

/** "On Tirth's iPhone": where a tab is, from the device's name as shown. */
export const onDevice = (name: string) => `On ${name}`;
