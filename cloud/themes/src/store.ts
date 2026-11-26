// Uploads, reports, the signed index and the packages (docs/THEME-STORE.md §3, §4).

import { b64url, hex, hmac, sha256, signEd25519 } from './crypto.ts';
import { bytesResponse, fail, json } from './http.ts';
import type { KeyRow } from './keys.ts';
import { checkUpload, compareVersions, versionParts } from './package.ts';
import type { D1PreparedStatement, Env } from './types.ts';

/** A key's uploads publish at once (still reportable) after this many of its versions were approved in review. */
export const TRUSTED_AFTER = 2;
/** Reports, from this many networks, hide a theme until it's reviewed. */
export const HIDE_AFTER = 3;
export const AUTHOR_MAX = 40;
export const TAGS_MAX = 5;
const TAG = /^[a-z0-9][a-z0-9-]{0,19}$/;
export const REPORT_REASONS = Object.freeze(['broken', 'offensive', 'impersonation', 'copied', 'other']);
export const NOTE_MAX = 280;

export const trusted = (key: Pick<KeyRow, 'approved'>) => key.approved >= TRUSTED_AFTER;

/** The index's generation, raised by every change to what it lists; the stored index is rebuilt when it's behind. */
export const BUMP = 'UPDATE meta SET value = value + 1 WHERE name = \'generation\'';

/**
 * A display name as typed when sharing: NFC, with controls, format characters (bidi and zero-width marks among them),
 * unassigned and private-use characters and angle brackets removed, spaces collapsed. Null if nothing's left or it's
 * longer than 40 characters.
 */
export function cleanAuthor(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 400) return null;
  const name = raw.normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}<>]/gu, '').replace(/\s+/gu, ' ').trim();
  return name && [...name].length <= AUTHOR_MAX ? name : null;
}

/** An upload's X-Margin-Meta: {"author": "…", "tags": ["…"]}, base64url JSON. */
export function readMeta(header: string): { ok: true, author: string, tags: string[] } | { ok: false, message: string } {
  let meta: unknown;
  try {
    const raw = header.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(raw + '='.repeat((4 - (raw.length % 4)) % 4));
    meta = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch { return { ok: false, message: 'X-Margin-Meta must be base64url JSON: {"author": "…", "tags": […]}.' }; }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return { ok: false, message: 'X-Margin-Meta must be a JSON object.' };
  const { author: rawAuthor, tags: rawTags = [] } = meta as { author?: unknown, tags?: unknown };
  const author = cleanAuthor(rawAuthor);
  if (!author) return { ok: false, message: `The author's name must be 1 to ${AUTHOR_MAX} characters.` };
  if (!Array.isArray(rawTags) || rawTags.length > TAGS_MAX || !rawTags.every((t) => typeof t === 'string' && TAG.test(t)) || new Set(rawTags).size !== rawTags.length) {
    return { ok: false, message: `Tags: at most ${TAGS_MAX}, each 1 to 20 lower-case letters, digits and hyphens, none twice.` };
  }
  return { ok: true, author, tags: rawTags as string[] };
}

type VersionRow = { version: string, sha256: string, status: string };

/**
 * An upload: POST /v1/themes, the .margintheme file as the body, its author and tags in X-Margin-Meta. Its signature
 * and the rates are checked before this. The package is checked (cheaply), its theme id claimed for this key or
 * found to be its own, its version found newer than every one before it, stored under its SHA-256, and recorded:
 * in review, or published if the key is trusted.
 */
export async function upload(env: Env, key: KeyRow, zip: Uint8Array, metaHeader: string, now: number): Promise<Response> {
  const meta = readMeta(metaHeader);
  if (!meta.ok) return fail(400, 'meta', meta.message);
  const checked = await checkUpload(zip);
  if (!checked.ok) return json(422, { error: 'package', message: 'Margin wouldn\'t use this package.', errors: checked.errors.slice(0, 20) });
  const m = checked.manifest;
  const sha = hex(await sha256(zip));
  // The theme's id: the first key to upload it owns it.
  await env.DB.prepare('INSERT INTO themes (id, owner, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING').bind(m.id, key.id, now).run();
  const theme = await env.DB.prepare('SELECT owner FROM themes WHERE id = ?').bind(m.id).first<{ owner: string }>();
  if (!theme || theme.owner !== key.id) return fail(409, 'not-yours', `The theme id "${m.id}" is another author's: give yours its own id.`);
  const { results: versions } = await env.DB.prepare('SELECT version, sha256, status FROM versions WHERE theme_id = ?').bind(m.id).all<VersionRow>();
  const same = versions.find((v) => v.version === m.version);
  if (same) {
    // The same upload again (a retry) answers as the first did; other bytes under a version taken are refused.
    if (same.sha256 === sha) return json(200, { id: m.id, version: m.version, sha256: sha, status: same.status });
    return fail(409, 'version-taken', `Version ${m.version} of "${m.id}" was uploaded before: raise its version in theme.json.`);
  }
  const newest = versions.reduce<string | null>((top, v) => (top === null || compareVersions(v.version, top) > 0 ? v.version : top), null);
  if (newest && compareVersions(m.version, newest) < 0) return fail(409, 'version-older', `Version ${m.version} is older than ${newest}, uploaded before: raise its version in theme.json.`);
  // The file first, so a recorded version always has one (content-addressed: storing it again is harmless).
  await env.FILES.put(`packages/${sha}`, zip, { httpMetadata: { contentType: 'application/zip' }, sha256: sha });
  const status = trusted(key) ? 'published' : 'review';
  const [major, minor, patch] = versionParts(m.version);
  const insert = env.DB.prepare(`INSERT INTO versions (theme_id, version, major, minor, patch, sha256, size, name, description, author, tags, created_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (theme_id, version) DO NOTHING`)
    .bind(m.id, m.version, major, minor, patch, sha, zip.length, m.name, m.description, meta.author, JSON.stringify(meta.tags), now, status);
  const statements: D1PreparedStatement[] = [insert];
  if (status === 'published') statements.push(env.DB.prepare(BUMP));
  const [inserted] = await env.DB.batch(statements);
  if (!inserted.meta.changes) {
    // Another upload of this version won the race.
    const row = await env.DB.prepare('SELECT sha256, status FROM versions WHERE theme_id = ? AND version = ?').bind(m.id, m.version).first<VersionRow>();
    if (row?.sha256 === sha) return json(200, { id: m.id, version: m.version, sha256: sha, status: row.status });
    return fail(409, 'version-taken', `Version ${m.version} of "${m.id}" was uploaded before: raise its version in theme.json.`);
  }
  return json(201, { id: m.id, version: m.version, sha256: sha, status });
}

/**
 * A report: POST /v1/reports, {"theme", "reason", "note"?}, one per key per theme. Reports from HIDE_AFTER networks
 * hide the theme until it's reviewed. The network is kept only as an HMAC (never the address).
 */
export async function report(env: Env & { CHALLENGE_SECRET: string }, key: KeyRow, input: Record<string, unknown>, network: string, now: number): Promise<Response> {
  const { theme: id, reason, note = '' } = input;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) return fail(400, 'theme', 'theme must be a theme\'s id.');
  if (typeof reason !== 'string' || !REPORT_REASONS.includes(reason)) return fail(400, 'reason', `reason must be one of ${REPORT_REASONS.join(', ')}.`);
  if (typeof note !== 'string' || [...note].length > NOTE_MAX) return fail(400, 'note', `note must be text of at most ${NOTE_MAX} characters.`);
  const theme = await env.DB.prepare('SELECT owner, hidden FROM themes WHERE id = ?').bind(id).first<{ owner: string, hidden: number }>();
  if (!theme) return fail(404, 'no-theme', 'There\'s no theme with that id.');
  if (theme.owner === key.id) return fail(400, 'own-theme', 'That theme is this install\'s own.');
  const hashed = b64url((await hmac(env.CHALLENGE_SECRET, `margin-themes-network-v1\n${network}`)).subarray(0, 16));
  const cleanNote = note.normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/gu, ' ').trim();
  const added = await env.DB.prepare('INSERT INTO reports (theme_id, key_id, network, reason, note, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (theme_id, key_id) DO NOTHING')
    .bind(id, key.id, hashed, reason, cleanNote, now).run();
  if (!added.meta.changes) return json(200, { reported: true, again: true });
  if (!theme.hidden) {
    const row = await env.DB.prepare('SELECT COUNT(DISTINCT network) AS n FROM reports WHERE theme_id = ? AND cleared = 0').bind(id).first<{ n: number }>();
    if ((row?.n ?? 0) >= HIDE_AFTER) {
      await env.DB.batch([env.DB.prepare('UPDATE themes SET hidden = 1 WHERE id = ? AND hidden = 0').bind(id), env.DB.prepare(BUMP)]);
    }
  }
  return json(201, { reported: true });
}

/** An index entry: a theme's newest published version. */
export type IndexEntry = { id: string, name: string, description: string, version: string, author: string, authorKey: string, tags: string[], sha256: string, size: number, updated: number };

/** What the index signs: its exact text, after this line and a newline (docs/THEME-STORE.md §4). */
export const INDEX_CONTEXT = 'margin-themes-index-v1\n';

/** The index as it is now, built from D1 in one transaction (its generation and its rows agree). */
export async function buildIndex(env: Env, now: number): Promise<{ generation: number, text: string }> {
  const [gen, rows] = await env.DB.batch([
    env.DB.prepare('SELECT value FROM meta WHERE name = \'generation\''),
    env.DB.prepare(`SELECT v.theme_id, v.version, v.name, v.description, v.author, v.tags, v.sha256, v.size, v.created_at, t.owner
      FROM versions v JOIN themes t ON t.id = v.theme_id JOIN keys k ON k.id = t.owner
      WHERE v.status = 'published' AND t.hidden = 0 AND k.blocked = 0
      ORDER BY v.theme_id, v.major DESC, v.minor DESC, v.patch DESC`),
  ]);
  const generation = Number((gen.results[0] as { value: number } | undefined)?.value ?? 0);
  const themes: IndexEntry[] = [];
  for (const r of rows.results as { theme_id: string, version: string, name: string, description: string, author: string, tags: string, sha256: string, size: number, created_at: number, owner: string }[]) {
    if (themes.length && themes[themes.length - 1].id === r.theme_id) continue; // an older version
    themes.push({ id: r.theme_id, name: r.name, description: r.description, version: r.version, author: r.author, authorKey: r.owner.slice(0, 8), tags: JSON.parse(r.tags), sha256: r.sha256, size: r.size, updated: r.created_at });
  }
  return { generation, text: JSON.stringify({ format: 1, generation, made: now, themes }) };
}

/**
 * GET /v1/index: {"index": "<its JSON, as text>", "signature": "<Ed25519 over INDEX_CONTEXT + the text, base64url>"}.
 * Kept in R2 with its generation, and rebuilt (and signed) only when D1's generation has moved on: a request costs
 * one row read and one R2 read. Two rebuilds at once can store out of order; the next request sees the older
 * generation and rebuilds again.
 */
export async function index(env: Env & { SIGNING_KEY: string }, now: number): Promise<Response> {
  const [stored, gen] = await Promise.all([
    env.FILES.get('index.json'),
    env.DB.prepare('SELECT value FROM meta WHERE name = \'generation\'').first<{ value: number }>(),
  ]);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' };
  if (stored && stored.customMetadata?.generation === String(gen?.value ?? 0)) return bytesResponse(stored.body, headers);
  const built = await buildIndex(env, now);
  const signature = b64url(await signEd25519(env.SIGNING_KEY, INDEX_CONTEXT + built.text));
  const body = JSON.stringify({ index: built.text, signature });
  await env.FILES.put('index.json', body, { httpMetadata: { contentType: 'application/json' }, customMetadata: { generation: String(built.generation) } });
  return bytesResponse(body, headers);
}

/** GET /v1/packages/<sha256>: a published version's file, while its theme is listed. */
export async function packageFile(env: Env, sha: string, { review = false } = {}): Promise<Response> {
  if (!/^[0-9a-f]{64}$/.test(sha)) return fail(404, 'no-package', 'There\'s no package with that SHA-256.');
  if (!review) {
    const listed = await env.DB.prepare(`SELECT 1 AS ok FROM versions v JOIN themes t ON t.id = v.theme_id JOIN keys k ON k.id = t.owner
      WHERE v.sha256 = ? AND v.status = 'published' AND t.hidden = 0 AND k.blocked = 0 LIMIT 1`).bind(sha).first();
    if (!listed) return fail(404, 'no-package', 'There\'s no package with that SHA-256.');
  }
  const file = await env.FILES.get(`packages/${sha}`);
  if (!file) return fail(404, 'no-package', 'There\'s no package with that SHA-256.');
  return bytesResponse(file.body, {
    'Content-Type': 'application/zip',
    'Content-Length': String(file.size),
    'Content-Disposition': `attachment; filename="${sha.slice(0, 12)}.margintheme"`,
    'ETag': `"${sha}"`,
    'Cache-Control': review ? 'no-store' : 'public, max-age=3600',
  });
}

/** GET /v1/me: the install's key as the server knows it. */
export function me(key: KeyRow): Response {
  return json(200, { id: key.id, created: key.created_at, approved: key.approved, trusted: trusted(key) });
}
