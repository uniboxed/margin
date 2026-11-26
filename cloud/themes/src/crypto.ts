// The themes server's cryptography, on Web Crypto alone (the Workers runtime's and Node's are the same API):
// SHA-256, HMAC-SHA-256, Ed25519, and the encodings the API uses (base64url without padding, lower-case hex).

const enc = new TextEncoder();

/** Bytes as base64url, no padding. */
export function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url (no padding) as bytes, or null for anything else: other letters, padding, a length no encoding has. */
export function unb64url(text: unknown): Uint8Array | null {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  let bin;
  try { bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)); } catch { return null; }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  // One spelling per value: the unused low bits of the last letter must be zero.
  return b64url(out) === text ? out : null;
}

export function hex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

const view = (data: Uint8Array | string) => (typeof data === 'string' ? enc.encode(data) : data) as Uint8Array<ArrayBuffer>;

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', view(data)));
}

export async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', view(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, view(data)));
}

/** Two texts compared without their contents changing how long it takes (their digests, compared in full). */
export async function sameText(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** How many zero bits a digest starts with. */
export function leadingZeroBits(bytes: Uint8Array): number {
  let n = 0;
  for (const b of bytes) {
    if (b === 0) { n += 8; continue; }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

/** Whether `signature` is `publicKey`'s (32 raw bytes) Ed25519 signature of `data`. False for any malformed part. */
export async function verifyEd25519(publicKey: Uint8Array, signature: Uint8Array, data: Uint8Array | string): Promise<boolean> {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey('raw', view(publicKey), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, view(signature), view(data));
  } catch { return false; }
}

/** The server's Ed25519 signature of `data`, with its private key (PKCS #8, base64: the SIGNING_KEY secret). */
export async function signEd25519(pkcs8: string, data: Uint8Array | string): Promise<Uint8Array> {
  const der = Uint8Array.from(atob(pkcs8.trim()), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, view(data)));
}

/** A key's id: the first 16 bytes of its public key's SHA-256, in hex (docs/THEME-STORE.md §2). */
export async function keyId(publicKey: Uint8Array): Promise<string> {
  return hex((await sha256(publicKey)).subarray(0, 16));
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}
