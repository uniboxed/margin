// Spaces across a browser's profiles, as Margin.app sends them to each
// overlay (`across`: app/shell/BrowserProfiles.swift `across(for:)`,
// ShellProfiles.swift): the profile this window is in, every profile Margin
// knows (name, emoji, color: the person names them once, or, with Full Disk
// Access, the name is Safari's own, `nameFrom` 'safari', with Safari's symbol
// for it as a small picture, `symbol`), and every space of
// every profile in the one order the person controls. The UI (ui/
// view-model.ts) draws this window's own spaces from its own state, as
// always, in their places in that order, and the other profiles' spaces as
// chips whose ids are `x:` and a hash of their profile and id (`foreignKey`):
// ids of two profiles can be the same, and an action naming one goes to the
// app (ui/host-app.ts), never to this copy. No `across` (the in-page host,
// or an app with one profile): nothing changes.

export type AcrossProfile = { id: string, name: string, emoji: string, color: string, named: boolean, nameFrom: string, symbol: string, here: boolean, linked: boolean, stale: boolean, lastSeen: number, spaces: number };
export type AcrossSpace = { profile: string, id: string, name: string, emoji: string, color: string, tabCount: number };
export type AcrossWindow = { profile: string, windowId: number };
export type AcrossSwitching = { profile: string, space: string, phase: string, notice: string, noticeKind: string, noticeProfile: string, from: AcrossWindow | null, noticeIn: AcrossWindow | null, content?: any };
export type SwitchSettings = { closeWindows: boolean };
export type Across = { profile: string, profiles: AcrossProfile[], spaces: AcrossSpace[], switching: AcrossSwitching | null, switchSettings: SwitchSettings | null, contents?: Record<string, any> };

const text = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
// A symbol's picture: a small PNG as a data: URL (the app makes it), nothing else.
const SYMBOL = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;
const symbolOf = (v) => (typeof v === 'string' && v.length <= 16384 && SYMBOL.test(v) ? v : '');

/** What the app sent, checked; null if there's nothing usable. */
export function acrossOf(raw): Across | null {
  if (!raw || typeof raw !== 'object' || typeof raw.profile !== 'string' || !Array.isArray(raw.spaces)) return null;
  const profiles = (Array.isArray(raw.profiles) ? raw.profiles : []).filter((p) => p && typeof p.id === 'string').slice(0, 64).map((p) => ({
    id: p.id, name: text(p.name, 40) || 'Profile', emoji: text(p.emoji, 8), color: COLOR.test(p.color) ? p.color : '',
    named: !!p.named, nameFrom: p.nameFrom === 'safari' ? 'safari' : '', symbol: symbolOf(p.symbol), here: p.id === raw.profile, linked: !!p.linked, stale: !!p.stale,
    lastSeen: Number(p.lastSeen) || 0, spaces: Number(p.spaces) || 0,
  }));
  const spaces = raw.spaces.filter((s) => s && typeof s.profile === 'string' && typeof s.id === 'string').slice(0, 512).map((s) => ({
    profile: s.profile, id: s.id, name: text(s.name, 40), emoji: text(s.emoji, 8), color: COLOR.test(s.color) ? s.color : '', tabCount: Math.max(0, Number(s.tabCount) || 0),
  }));
  const sw = raw.switching && typeof raw.switching === 'object' ? raw.switching : null;
  const switching = sw ? {
    profile: text(sw.profile, 64), space: text(sw.space, 64), phase: text(sw.phase, 32), notice: text(sw.notice, 400),
    noticeKind: Object.hasOwn(SWITCH_NOTICES, sw.noticeKind) ? sw.noticeKind : '', noticeProfile: text(sw.noticeProfile, 64),
    from: windowOf(sw.from), noticeIn: windowOf(sw.noticeIn), content: contentOf(sw.content),
  } : null;
  const ss = raw.switchSettings && typeof raw.switchSettings === 'object' ? raw.switchSettings : null;
  const switchSettings = ss ? { closeWindows: ss.closeWindows === true } : null;
  // Every other profile's spaces' contents (the app's data), by `${profile}\u0000${space}`: a swipe draws the
  // neighbouring space beside this one (ui/behaviors/swipe.ts), another profile's too.
  const contents: Record<string, AcrossContent> = {};
  for (const e of (Array.isArray(raw.contents) ? raw.contents : []).slice(0, 128)) {
    if (!e || typeof e.profile !== 'string' || typeof e.space !== 'string') continue;
    const c = contentOf(e.content);
    if (c && c.space === e.space) contents[`${text(e.profile, 64)}\u0000${text(e.space, 64)}`] = c;
  }
  return { profile: raw.profile, profiles, spaces, switching, switchSettings, contents };
}

// The target space's contents, from Margin.app's data for its profile (ShellProfiles.swift spaceContent): what
// the window a switch starts from draws in its sidebar while the switch runs, so the space is there at once and
// the window that takes over shows the same (ui/view-model.ts foreignSpace). Strings capped; icons only small
// `data:` images; ids as the app gave them.
export type AcrossRow = { id: string, title: string, url: string, icon: string, folderId: string | null, pos: number, active: boolean };
export type AcrossContent = { space: string, pins: AcrossRow[], folders: { id: string, name: string, open: boolean, pos: number }[], tabs: AcrossRow[] };
const ICON = /^data:image\/(png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/]+=*$/;
function contentOf(c): AcrossContent | null {
  if (!c || typeof c !== 'object' || typeof c.space !== 'string') return null;
  const row = (r) => (r && typeof r === 'object' && typeof r.id === 'string' ? {
    id: text(r.id, 64), title: text(r.title, 300), url: text(r.url, 2048),
    icon: typeof r.icon === 'string' && r.icon.length <= 16384 && ICON.test(r.icon) ? r.icon : '',
    folderId: typeof r.folderId === 'string' && r.folderId ? text(r.folderId, 64) : null,
    pos: Number(r.pos) || 0, active: r.active === true,
  } : null);
  const list = (v, n) => (Array.isArray(v) ? v : []).slice(0, n).map(row).filter(Boolean);
  const folders = (Array.isArray(c.folders) ? c.folders : []).slice(0, 50).filter((f) => f && typeof f.id === 'string')
    .map((f) => ({ id: text(f.id, 64), name: text(f.name, 60), open: f.open !== false, pos: Number(f.pos) || 0 }));
  return { space: text(c.space, 64), pins: list(c.pins, 200), folders, tabs: list(c.tabs, 80) };
}

/** A window as the app names it, or null. */
function windowOf(w): AcrossWindow | null {
  if (!w || typeof w !== 'object' || typeof w.profile !== 'string' || !w.profile || !Number.isInteger(w.windowId)) return null;
  return { profile: w.profile.slice(0, 64), windowId: w.windowId };
}

/** Whether `w` is this overlay's window: `profile` the overlay's own (`across.profile`), `windowId` its window. */
export const isWindow = (w: AcrossWindow | null | undefined, profile: string, windowId: number | null | undefined) => !!w && w.profile === profile && w.windowId === windowId;

// The cross-profile switch's notices (app/HANDOFF.md §1.5, §1.9, §1.10, §4.5):
// the app sends only a kind and the profile it's about (`noticeKind`,
// `noticeProfile`), and these are the words, with that profile's name. A
// button goes back to the app (ui/host-app.ts perform 'notice': `switch.notice`).
export const SWITCH_NOTICES: Readonly<Record<string, { text: (profile: string) => string, actions: { id: string, label: string }[] }>> = Object.freeze({
  // Close mode kept the window it left: a page in it has unsent text (or didn't say). The person may close it.
  'window-kept-draft': { text: (p) => `Kept ${p}’s window open: a page in it has text you haven’t sent.`, actions: [{ id: 'close', label: 'Close window' }] },
  // A sheet or dialog is up on the window being left: no switch.
  'dialog-open': { text: () => 'Finish the dialog in this window first.', actions: [] },
  // The window being left has a windows call stuck in Safari: no switch.
  'window-busy': { text: () => 'Safari is busy in this window.', actions: [] },
  // A switch that gave up landed after all, with nothing done meanwhile.
  'late-landing': { text: (p) => `Switched to ${p} (Safari was slow).`, actions: [] },
  // The profile's copy didn't come back in time: its parked window was put back on the Desktop.
  'window-on-desktop': { text: (p) => `${p}’s window is on the Desktop. Margin can’t reach its extension right now.`, actions: [] },
});

/** More than one profile has spaces shown: the UI says which profile each space is in. */
export const isMultiProfile = (a: Across | null | undefined) => !!a && new Set(a.spaces.map((s) => s.profile)).size > 1;

// FNV-1a, 32 bits, in base 36: short and stable.
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
/** Another profile's space's chip id. */
export const foreignKey = (profile: string, id: string) => `x:${hash(`${profile}\u0000${id}`)}:${hash(`${id}\u0000${profile}`)}`;

/** The other profile's space a chip id names, or null. */
export function foreignSpace(a: Across | null | undefined, chipId: string) {
  if (!a || typeof chipId !== 'string' || !chipId.startsWith('x:')) return null;
  return a.spaces.find((s) => s.profile !== a.profile && foreignKey(s.profile, s.id) === chipId) ?? null;
}

/**
 * The spaces the sidebar shows, in the one order: this profile's from its
 * own state (`own`, in their own order: they fill the places this profile's
 * spaces have in the order, a new one after them), the others' from `across`.
 * Each entry: `{ own: true, space }` or `{ own: false, entry, key }`.
 * */
export function orderedSpaces(own: any[], a: Across | null | undefined) {
  if (!isMultiProfile(a) || !a) return own.map((space) => ({ own: true, space }));
  const out: any[] = [];
  let i = 0;
  let lastOwn = -1;
  for (const entry of a.spaces) {
    if (entry.profile === a.profile) {
      if (i < own.length) { out.push({ own: true, space: own[i++] }); lastOwn = out.length - 1; }
    } else {
      out.push({ own: false, entry, key: foreignKey(entry.profile, entry.id) });
    }
  }
  if (i < own.length) out.splice(lastOwn + 1, 0, ...own.slice(i).map((space) => ({ own: true, space })));
  return out;
}

/** A profile by id. */
export const profileOf = (a: Across | null | undefined, id: string) => a?.profiles.find((p) => p.id === id) ?? null;
