// Spaces across a browser's profiles, as Margin.app sends them to each
// overlay (`across`: app/shell/BrowserProfiles.swift `across(for:)`,
// ShellProfiles.swift): the profile this window is in, every profile Margin
// knows (name, emoji, color: the person names them once, or, with Full Disk
// Access, the name is Safari's own, `nameFrom` 'safari', with Safari's symbol
// for it as a small picture, `symbol`), and every space of
// every profile in the one order the person controls. The UI (ui/
// view-model.js) draws this window's own spaces from its own state, as
// always, in their places in that order, and the other profiles' spaces as
// chips whose ids are `x:` and a hash of their profile and id (`foreignKey`):
// ids of two profiles can be the same, and an action naming one goes to the
// app (ui/host-app.js), never to this copy. No `across` (the in-page host,
// or an app with one profile): nothing changes.

/**
 * @typedef {{ id: string, name: string, emoji: string, color: string, named: boolean, nameFrom: string, symbol: string, here: boolean, linked: boolean, stale: boolean, lastSeen: number, spaces: number }} AcrossProfile
 * @typedef {{ profile: string, id: string, name: string, emoji: string, color: string, tabCount: number }} AcrossSpace
 * @typedef {{ profile: string, profiles: AcrossProfile[], spaces: AcrossSpace[], switching: { profile?: string, space?: string, phase?: string, notice?: string } | null }} Across
 */

const text = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
// A symbol's picture: a small PNG as a data: URL (the app makes it), nothing else.
const SYMBOL = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;
const symbolOf = (v) => (typeof v === 'string' && v.length <= 16384 && SYMBOL.test(v) ? v : '');

/** What the app sent, checked; null if there's nothing usable. @returns {Across | null} */
export function acrossOf(raw) {
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
  const switching = sw ? { profile: text(sw.profile, 64), space: text(sw.space, 64), phase: text(sw.phase, 32), notice: text(sw.notice, 400) } : null;
  return { profile: raw.profile, profiles, spaces, switching };
}

/** More than one profile has spaces shown: the UI says which profile each space is in. @param {Across | null | undefined} a */
export const isMultiProfile = (a) => !!a && new Set(a.spaces.map((s) => s.profile)).size > 1;

// FNV-1a, 32 bits, in base 36: short and stable.
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
/** Another profile's space's chip id. @param {string} profile @param {string} id */
export const foreignKey = (profile, id) => `x:${hash(`${profile}\u0000${id}`)}:${hash(`${id}\u0000${profile}`)}`;

/** The other profile's space a chip id names, or null. @param {Across | null | undefined} a @param {string} chipId */
export function foreignSpace(a, chipId) {
  if (!a || typeof chipId !== 'string' || !chipId.startsWith('x:')) return null;
  return a.spaces.find((s) => s.profile !== a.profile && foreignKey(s.profile, s.id) === chipId) ?? null;
}

/**
 * The spaces the sidebar shows, in the one order: this profile's from its
 * own state (`own`, in their own order: they fill the places this profile's
 * spaces have in the order, a new one after them), the others' from `across`.
 * Each entry: `{ own: true, space }` or `{ own: false, entry, key }`.
 * @param {any[]} own @param {Across | null | undefined} a
 */
export function orderedSpaces(own, a) {
  if (!isMultiProfile(a) || !a) return own.map((space) => ({ own: true, space }));
  /** @type {any[]} */
  const out = [];
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

/** A profile by id. @param {Across | null | undefined} a @param {string} id */
export const profileOf = (a, id) => a?.profiles.find((p) => p.id === id) ?? null;
