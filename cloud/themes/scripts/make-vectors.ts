// npm run themes:vectors: cloud/themes/vectors.json, the formats the server and Margin's client (margin-core's
// data::theme_store) must agree on, made by the server's own code: a key from a fixed seed and its id, a signed
// request, a proof of work's smallest nonce, a signed index (its entries good and bad), and a theme shared as its
// .margintheme. tests/cloud-themes-vectors.test.ts checks the file is what this makes (and that the server and the
// app's reader take each part); the Rust tests read it and must produce the same bytes.
import { createHash } from 'node:crypto';
import { writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { b64url, hex, leadingZeroBits } from '../src/crypto.ts';
import { signedText } from '../src/keys.ts';
import { INDEX_CONTEXT } from '../src/store.ts';

const enc = (s: string) => new TextEncoder().encode(s);
export const VECTORS_PATH = fileURLToPath(new URL('../vectors.json', import.meta.url));

/** An Ed25519 private key from its 32-byte seed (PKCS #8's fixed prefix, then the seed). */
async function privateKey(seed: Uint8Array) {
  const der = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seed]);
  return crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, true, ['sign']);
}
async function publicOf(seed: Uint8Array) {
  const jwk = await crypto.subtle.exportKey('jwk', await privateKey(seed));
  return jwk.x as string; // base64url of the raw public key
}
const sign = async (seed: Uint8Array, text: string) => b64url(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, await privateKey(seed), enc(text))));

/** Files as a zip, each stored (the app's and core's reader take it): the test's own writer, independent of core's. */
export function storedZip(entries: [string, Uint8Array][]) {
  const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xffffffff) >>> 0; };
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const [name, data] of entries) {
    const n = enc(name);
    const local = new DataView(new ArrayBuffer(30));
    [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, 0, 2], [12, DATE, 2], [14, crc32(data), 4], [18, data.length, 4], [22, data.length, 4], [26, n.length, 2], [28, 0, 2]]
      .forEach(([at, v, size]) => (size === 4 ? local.setUint32(at, v, true) : local.setUint16(at, v, true)));
    const cd = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, (3 << 8) | 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, 0, 2], [14, DATE, 2], [16, crc32(data), 4], [20, data.length, 4], [24, data.length, 4], [28, n.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, (0o100644 << 16) >>> 0, 4], [42, offset, 4]]
      .forEach(([at, v, size]) => (size === 4 ? cd.setUint32(at, v, true) : cd.setUint16(at, v, true)));
    parts.push(new Uint8Array(local.buffer), n, data);
    central.push(new Uint8Array(cd.buffer), n);
    offset += 30 + n.length + data.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

export async function makeVectors() {
  const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const indexSeed = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
  const publicKey = await publicOf(seed);
  const raw = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/') + '='), (c) => c.charCodeAt(0));
  const keyId = createHash('sha256').update(raw).digest('hex').slice(0, 32);
  // A signed upload.
  const body = enc('PK\u0005\u0006 an upload\'s bytes');
  const meta = b64url(enc(JSON.stringify({ author: 'Ana', tags: [] })));
  const time = '1795600000000';
  const text = signedText('POST', '/v1/themes', time, hex(new Uint8Array(createHash('sha256').update(body).digest())), meta);
  const request = { method: 'POST', path: '/v1/themes', time, body: Buffer.from(body).toString('base64'), meta, text, signature: await sign(seed, text) };
  // The proof of work: the smallest nonce for 12 bits.
  const challenge = '1795600600000.12.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  let nonce = 0;
  while (leadingZeroBits(createHash('sha256').update(`margin-themes-pow-v1\n${challenge}\n${publicKey}\n${nonce}`).digest()) < 12) nonce++;
  const pow = { challenge, publicKey, bits: 12, nonce: String(nonce) };
  // A signed index: two good entries, and three Margin leaves out (a built-in's id, a bad sha256, a repeated id).
  const good = (id: string, updated: number) => ({ id, name: `Theme ${id}`, description: 'About it', version: '1.2.0', author: 'Ana', authorKey: '0123abcd', tags: [], sha256: 'a'.repeat(64), size: 1234, updated });
  const indexText = JSON.stringify({ format: 1, generation: 7, made: 1795600000000, themes: [
    good('dusk', 2), { ...good('arcadia', 3) }, { ...good('broken', 4), sha256: 'nope' }, good('paper', 1), { ...good('dusk', 5), name: 'Again' },
  ] });
  const index = { publicKey: await publicOf(indexSeed), body: JSON.stringify({ index: indexText, signature: await sign(indexSeed, INDEX_CONTEXT + indexText) }) };
  // A stored theme (as margin-core keeps one) and the .margintheme it's shared as.
  const manifest = JSON.stringify({ format: 2, id: 'shared', name: 'Shared', version: '1.0.0', author: '  Ana   Lima ' });
  const html = '<div class="r"><m-page></m-page><m-launcher></m-launcher><m-prompt></m-prompt><m-notice></m-notice><template m-part="launcher"><main><m-settings></m-settings></main></template><template m-part="settings"><div></div></template><template m-part="prompt"><div></div></template><template m-part="notice"><div></div></template></div>';
  const css = '.r{display:flex}';
  const files = { 'LICENSE.txt': Buffer.from('mine').toString('base64') };
  const message = JSON.stringify({ id: 'shared', manifest, html, css, files });
  const zip = storedZip([['LICENSE.txt', enc('mine')], ['theme.css', enc(css)], ['theme.html', enc(html)], ['theme.json', enc(manifest)]]);
  const share = { message, zip: Buffer.from(zip).toString('base64') };
  return { seed: Buffer.from(seed).toString('base64'), publicKey, keyId, request, pow, index, share };
}

function isCommand(url: string) {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url)); } catch { return false; }
}

if (isCommand(import.meta.url)) {
  writeFileSync(VECTORS_PATH, `${JSON.stringify(await makeVectors(), null, 2)}\n`);
  console.log(`${VECTORS_PATH}: written`);
}
