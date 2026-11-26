// cloud/themes/vectors.json: the formats the themes server and Margin's client (margin-core's data::theme_store, whose
// Rust tests read the same file) must agree on. It must be what the server's own code makes (npm run themes:vectors),
// and each part must be what the server and the app's reader take.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { makeVectors, VECTORS_PATH } from '../cloud/themes/scripts/make-vectors.ts';
import { unb64url, verifyEd25519, leadingZeroBits } from '../cloud/themes/src/crypto.ts';
import { signedText } from '../cloud/themes/src/keys.ts';
import { INDEX_CONTEXT, readMeta } from '../cloud/themes/src/store.ts';
import { checkUpload } from '../cloud/themes/src/package.ts';
import { packageFromZip, checkImport } from '../app/shared/ui/theme-import.ts';

const file = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));

test('vectors.json is what the server\'s code makes (npm run themes:vectors)', async () => {
  assert.deepEqual(file, await makeVectors());
});

test('vectors: the request\'s signature verifies as the server checks it; its meta reads', async () => {
  const r = file.request;
  const body = Buffer.from(r.body, 'base64');
  assert.equal(signedText(r.method, r.path, r.time, createHash('sha256').update(body).digest('hex'), r.meta), r.text);
  assert.ok(await verifyEd25519(unb64url(file.publicKey)!, unb64url(r.signature)!, r.text));
  assert.equal(createHash('sha256').update(unb64url(file.publicKey)!).digest('hex').slice(0, 32), file.keyId);
  assert.deepEqual(readMeta(r.meta), { ok: true, author: 'Ana', tags: [] });
});

test('vectors: the nonce is the smallest that proves 12 bits', () => {
  const { challenge, publicKey, bits, nonce } = file.pow;
  const zeros = (n: number) => leadingZeroBits(createHash('sha256').update(`margin-themes-pow-v1\n${challenge}\n${publicKey}\n${n}`).digest());
  assert.ok(zeros(Number(nonce)) >= bits);
  for (let n = 0; n < Number(nonce); n++) assert.ok(zeros(n) < bits, String(n));
});

test('vectors: the index is signed with its key over the context line and its text', async () => {
  const { index, signature } = JSON.parse(file.index.body);
  assert.ok(await verifyEd25519(unb64url(file.index.publicKey)!, unb64url(signature)!, INDEX_CONTEXT + index));
});

test('vectors: the shared .margintheme passes the server\'s cheap check and the app\'s full one', async () => {
  const zip = new Uint8Array(Buffer.from(file.share.zip, 'base64'));
  assert.deepEqual(await checkUpload(zip), { ok: true, manifest: { id: 'shared', name: 'Shared', version: '1.0.0', description: '' } });
  const read = await packageFromZip(zip);
  assert.ok(read.ok);
  const checked = checkImport((read as Extract<typeof read, { ok: true }>).pkg);
  assert.ok(checked.ok, JSON.stringify(checked));
  const message = JSON.parse(file.share.message);
  assert.equal((read as Extract<typeof read, { ok: true }>).pkg.manifest, message.manifest, 'theme.json as stored, byte for byte');
});
