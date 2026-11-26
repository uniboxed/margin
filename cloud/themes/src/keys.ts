// No accounts (docs/THEME-STORE.md §2): each Margin install has an Ed25519 key of its own, registered once with a
// proof of work, and signs every request with it.
//
// The proof of work. GET /v1/challenge gives
//   challenge = "<expires, ms>.<bits>.<16 random bytes, base64url>.<HMAC-SHA-256 of 'margin-themes-challenge-v1\n'
//                + the first three parts, joined by '.', base64url>"
// and the app finds a nonce (decimal digits, at most 20) for which
//   SHA-256("margin-themes-pow-v1\n" + challenge + "\n" + publicKey + "\n" + nonce)
// starts with `bits` zero bits; publicKey is the raw 32-byte key in base64url.
//
// A signed request has three headers:
//   X-Margin-Key        the key's id (32 lower-case hex: the first 16 bytes of the public key's SHA-256)
//   X-Margin-Time       the time it was signed, ms since 1970 (within 5 minutes of the server's)
//   X-Margin-Signature  base64url Ed25519 signature of
//                       "margin-themes-v1\n" + METHOD + "\n" + path + "\n" + time + "\n" + hex SHA-256 of the body
//                       + "\n" + the X-Margin-Meta header ("" if none)
// The path is the URL's path alone; the API takes no query strings (a proxy may respell one). What a request says
// besides its body (an upload's author and tags) is the X-Margin-Meta header, base64url JSON, signed with it.

import { b64url, hex, hmac, keyId, leadingZeroBits, randomBytes, sha256, unb64url, verifyEd25519 } from './crypto.ts';
import { fail, json } from './http.ts';
import type { Env } from './types.ts';

export const CHALLENGE_LIFE = 10 * 60_000;
export const CLOCK_SKEW = 5 * 60_000;
export const DEFAULT_POW_BITS = 28;
const MAX_POW_BITS = 32;

/** A registered key, as D1 keeps it. */
export type KeyRow = { id: string, public_key: string, created_at: number, approved: number, blocked: number };

/** The proof of work's zero bits: wrangler.toml's POW_BITS, within 8–32 (Margin does at most 30). */
export function powBits(env: Env): number {
  const n = Number(env.POW_BITS ?? DEFAULT_POW_BITS);
  return Number.isInteger(n) && n >= 8 && n <= MAX_POW_BITS ? n : DEFAULT_POW_BITS;
}

/** Whether a secret is set and long enough to be one (32 random bytes in base64 or hex are 43 or more). */
export function secretOk(secret: string | undefined): secret is string {
  return typeof secret === 'string' && secret.length >= 32;
}

export async function makeChallenge(env: Env & { CHALLENGE_SECRET: string }, now: number) {
  const bits = powBits(env);
  const expires = now + CHALLENGE_LIFE;
  const head = `${expires}.${bits}.${b64url(randomBytes(16))}`;
  const mac = b64url(await hmac(env.CHALLENGE_SECRET, `margin-themes-challenge-v1\n${head}`));
  return { challenge: `${head}.${mac}`, bits, expires };
}

const CHALLENGE = /^(\d{13})\.(\d{1,2})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

/** Why a challenge and its nonce don't prove the work for this key, or null when they do. */
export async function powProblem(env: Env & { CHALLENGE_SECRET: string }, challenge: unknown, publicKey: string, nonce: unknown, now: number): Promise<string | null> {
  const m = typeof challenge === 'string' ? CHALLENGE.exec(challenge) : null;
  if (!m) return 'not a challenge this server gives';
  const [text, expires, bits] = m;
  const head = text.slice(0, text.lastIndexOf('.'));
  const mac = b64url(await hmac(env.CHALLENGE_SECRET, `margin-themes-challenge-v1\n${head}`));
  if (mac !== m[4]) return 'not a challenge this server gives';
  if (Number(expires) <= now) return 'the challenge has expired: ask for another';
  if (Number(expires) > now + CHALLENGE_LIFE + CLOCK_SKEW) return 'not a challenge this server gives';
  if (Number(bits) < powBits(env) || Number(bits) > MAX_POW_BITS) return 'the challenge asks for too little work: ask for another';
  if (typeof nonce !== 'string' || !/^\d{1,20}$/.test(nonce)) return 'the nonce must be 1 to 20 digits';
  const digest = await sha256(`margin-themes-pow-v1\n${text}\n${publicKey}\n${nonce}`);
  return leadingZeroBits(digest) >= Number(bits) ? null : 'the nonce doesn\'t prove the work';
}

/** The text a request's signature signs. */
export function signedText(method: string, path: string, time: string, bodySha256: string, meta: string): string {
  return `margin-themes-v1\n${method}\n${path}\n${time}\n${bodySha256}\n${meta}`;
}

const KEY_ID = /^[0-9a-f]{32}$/;
const TIME = /^\d{13}$/;

type SignatureHeaders = { ok: true, id: string, time: string, signature: Uint8Array, meta: string } | { ok: false, response: Response };

/** The signature headers, read; or a response saying what's wrong with them. */
function signatureHeaders(request: Request, now: number): SignatureHeaders {
  const id = request.headers.get('X-Margin-Key') ?? '';
  const time = request.headers.get('X-Margin-Time') ?? '';
  const signature = unb64url(request.headers.get('X-Margin-Signature') ?? '');
  const meta = request.headers.get('X-Margin-Meta') ?? '';
  if (!KEY_ID.test(id) || !TIME.test(time) || !signature || signature.length !== 64) return { ok: false, response: fail(401, 'unsigned', 'This request must be signed with the install\'s key.') };
  if (Math.abs(Number(time) - now) > CLOCK_SKEW) return { ok: false, response: fail(401, 'clock', 'This Mac\'s clock is more than 5 minutes from the server\'s.') };
  if (meta.length > 4096) return { ok: false, response: fail(400, 'meta', 'X-Margin-Meta is too long.') };
  return { ok: true, id, time, signature, meta };
}

/** Whether the request is signed by this public key (base64url), over this body. */
async function signedBy(request: Request, publicKey: string, h: { time: string, signature: Uint8Array, meta: string }, body: Uint8Array) {
  const raw = unb64url(publicKey);
  if (!raw) return false;
  const path = new URL(request.url).pathname;
  return verifyEd25519(raw, h.signature, signedText(request.method, path, h.time, hex(await sha256(body)), h.meta));
}

/**
 * The registered key that signed the request, or a response refusing it: unsigned, a clock too far off, a key the
 * server doesn't know, a signature that doesn't verify, a blocked key.
 */
export async function signer(request: Request, env: Env, body: Uint8Array, now: number): Promise<{ key: KeyRow, meta: string } | { response: Response }> {
  const h = signatureHeaders(request, now);
  if (!h.ok) return { response: h.response };
  const key = await env.DB.prepare('SELECT id, public_key, created_at, approved, blocked FROM keys WHERE id = ?').bind(h.id).first<KeyRow>();
  if (!key) return { response: fail(401, 'unknown-key', 'This install\'s key isn\'t registered: register it first.') };
  if (!(await signedBy(request, key.public_key, h, body))) return { response: fail(401, 'signature', 'The request\'s signature doesn\'t verify.') };
  if (key.blocked) return { response: fail(403, 'blocked', 'This install can\'t share or report themes.') };
  return { key, meta: h.meta };
}

/**
 * Registering a key: POST /v1/keys, {"publicKey", "challenge", "nonce"}, signed with that key. The proof of work and
 * the signature are checked before anything is counted or stored. A key registered before answers with its id again.
 */
export async function register(request: Request, env: Env & { CHALLENGE_SECRET: string }, body: Uint8Array, input: Record<string, unknown>, now: number, takeNetwork: () => Promise<Response | null>): Promise<Response> {
  const publicKey = input.publicKey;
  const raw = unb64url(publicKey);
  if (typeof publicKey !== 'string' || !raw || raw.length !== 32) return fail(400, 'public-key', 'publicKey must be a raw Ed25519 public key (32 bytes, base64url).');
  const pow = await powProblem(env, input.challenge, publicKey, input.nonce, now);
  if (pow) return fail(400, 'proof-of-work', pow);
  const h = signatureHeaders(request, now);
  if (!h.ok) return h.response;
  const id = await keyId(raw);
  if (h.id !== id) return fail(401, 'signature', 'X-Margin-Key isn\'t this public key\'s id.');
  if (!(await signedBy(request, publicKey, h, body))) return fail(401, 'signature', 'The request\'s signature doesn\'t verify.');
  const known = await env.DB.prepare('SELECT id, created_at, blocked FROM keys WHERE id = ?').bind(id).first<{ id: string, created_at: number, blocked: number }>();
  if (known) {
    if (known.blocked) return fail(403, 'blocked', 'This install can\'t share or report themes.');
    return json(200, { id, created: known.created_at });
  }
  const refused = await takeNetwork();
  if (refused) return refused;
  await env.DB.prepare('INSERT INTO keys (id, public_key, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING').bind(id, publicKey, now).run();
  const row = await env.DB.prepare('SELECT created_at FROM keys WHERE id = ?').bind(id).first<{ created_at: number }>();
  return json(201, { id, created: row?.created_at ?? now });
}
