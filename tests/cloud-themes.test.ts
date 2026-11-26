// The themes server (cloud/themes, docs/THEME-STORE.md §2–§4) on Node, its bindings faked (tests/cloud-themes/
// fakes.ts): keys and the proof of work, signed requests, the limits, uploads and their cheap checks, ownership and
// versions, review and trust, reports, blocking, the signed index and the packages, the review page's guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildSync } from 'esbuild';
import { handle } from '../cloud/themes/src/worker.ts';
import { b64url, hex, unb64url, verifyEd25519, leadingZeroBits, signEd25519 } from '../cloud/themes/src/crypto.ts';
import { networkOf } from '../cloud/themes/src/http.ts';
import { signedText, CHALLENGE_LIFE } from '../cloud/themes/src/keys.ts';
import { Limiter, RATES } from '../cloud/themes/src/limits.ts';
import { checkUpload, compareVersions } from '../cloud/themes/src/package.ts';
import { cleanAuthor, INDEX_CONTEXT, HIDE_AFTER } from '../cloud/themes/src/store.ts';
import { makeSecret } from '../cloud/themes/scripts/make-keys.ts';
import { packTheme, zipFiles } from '../scripts/pack-theme.ts';
import { fakeEnv, MapStorage, type FakeEnv } from './cloud-themes/fakes.ts';

const BASE = 'https://themes.example';
const enc = (s: string) => new TextEncoder().encode(s);
const DAY = 86_400_000;
// A UTC midnight, then 10:00 that day: the clock the tests move.
const T0 = Date.UTC(2026, 10, 25, 10, 0, 0);

const WAYS_OUT = '<div class="r"><m-page></m-page><m-launcher></m-launcher><m-prompt></m-prompt><m-notice></m-notice>'
  + '<template m-part="launcher"><main><m-settings></m-settings></main></template>'
  + '<template m-part="settings"><div></div></template><template m-part="prompt"><div></div></template><template m-part="notice"><div></div></template></div>';
function themeFiles(id: string, version: string, manifest: Record<string, unknown> = {}) {
  return {
    'theme.json': enc(JSON.stringify({ format: 2, id, name: `Theme ${id}`, version, author: 'Someone', description: `About ${id}`, ...manifest })),
    'theme.html': enc(WAYS_OUT),
    'theme.css': enc('.r{display:flex}'),
  };
}
const themeZip = (id: string, version: string, manifest: Record<string, unknown> = {}) => zipFiles(themeFiles(id, version, manifest));

type Opts = { body?: Uint8Array | string, meta?: unknown, ip?: string, time?: number, headers?: Record<string, string>, unsigned?: boolean, sign?: (text: string) => string | Promise<string> };

/** An install: its own key pair, and requests signed with it. */
class Install {
  env: FakeEnv; clock: { now: number }; ip: string; pair: CryptoKeyPair; publicKey: string; id: string;
  constructor(env: FakeEnv, clock: { now: number }, ip: string, pair: CryptoKeyPair, publicKey: string, id: string) {
    this.env = env; this.clock = clock; this.ip = ip; this.pair = pair; this.publicKey = publicKey; this.id = id;
  }
  static async make(env: FakeEnv, clock: { now: number }, ip = '203.0.113.7') {
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const id = createHash('sha256').update(raw).digest('hex').slice(0, 32);
    return new Install(env, clock, ip, pair, b64url(raw), id);
  }
  async signature(text: string) {
    return b64url(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, this.pair.privateKey, enc(text))));
  }
  async request(method: string, path: string, o: Opts = {}) {
    const body = typeof o.body === 'string' ? enc(o.body) : o.body ?? new Uint8Array(0);
    const time = String(o.time ?? this.clock.now);
    const meta = o.meta === undefined ? '' : b64url(enc(JSON.stringify(o.meta)));
    const headers: Record<string, string> = { 'CF-Connecting-IP': o.ip ?? this.ip };
    if (!o.unsigned) {
      const text = signedText(method, path, time, createHash('sha256').update(body).digest('hex'), meta);
      Object.assign(headers, { 'X-Margin-Key': this.id, 'X-Margin-Time': time, 'X-Margin-Signature': await (o.sign ?? ((t) => this.signature(t)))(text) });
      if (meta) headers['X-Margin-Meta'] = meta;
    }
    Object.assign(headers, o.headers ?? {});
    const init: RequestInit = { method, headers };
    if (method !== 'GET') init.body = body as Uint8Array<ArrayBuffer>;
    return handle(new Request(BASE + path, init), this.env, this.clock.now);
  }
  async challenge() {
    const res = await handle(new Request(`${BASE}/v1/challenge`), this.env, this.clock.now);
    assert.equal(res.status, 200);
    return await res.json() as { challenge: string, bits: number, expires: number };
  }
  solve(challenge: string, bits: number) {
    for (let n = 0; ; n++) {
      const d = createHash('sha256').update(`margin-themes-pow-v1\n${challenge}\n${this.publicKey}\n${n}`).digest();
      if (leadingZeroBits(d) >= bits) return String(n);
    }
  }
  async register(o: Opts = {}) {
    const { challenge, bits } = await this.challenge();
    return this.request('POST', '/v1/keys', { body: JSON.stringify({ publicKey: this.publicKey, challenge, nonce: this.solve(challenge, bits) }), ...o });
  }
  async upload(zip: Uint8Array, meta: unknown = { author: 'Ana', tags: ['dark'] }, o: Opts = {}) {
    return this.request('POST', '/v1/themes', { body: zip, meta, ...o });
  }
}

async function setup(over = {}) {
  const { env, indexKey } = await fakeEnv(over);
  const clock = { now: T0 };
  return { env, indexKey, clock, install: async (ip?: string) => { const i = await Install.make(env, clock, ip); assert.equal((await i.register()).status, 201); return i; } };
}

const ADMIN = (env: FakeEnv) => ({ Authorization: `Basic ${btoa(`admin:${env.ADMIN_TOKEN}`)}` });
async function adminPost(env: FakeEnv, now: number, fields: Record<string, string>, headers: Record<string, string> = {}) {
  const page = await (await handle(new Request(`${BASE}/admin`, { headers: ADMIN(env) }), env, now)).text();
  const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)?.[1] ?? '';
  const body = new URLSearchParams({ csrf, ...fields }).toString();
  return handle(new Request(`${BASE}/admin`, { method: 'POST', body, headers: { ...ADMIN(env), Origin: BASE, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded', ...headers } }), env, now);
}
async function readIndex(env: FakeEnv, indexKey: Uint8Array, now: number) {
  const res = await handle(new Request(`${BASE}/v1/index`), env, now);
  assert.equal(res.status, 200);
  const { index, signature } = await res.json() as { index: string, signature: string };
  assert.ok(await verifyEd25519(indexKey, unb64url(signature)!, INDEX_CONTEXT + index), 'the index\'s signature verifies with the public key');
  return JSON.parse(index) as { format: number, generation: number, themes: { id: string, version: string, sha256: string, author: string, authorKey: string, name: string, tags: string[], size: number }[] };
}

test('keys: a challenge, the work, registered once; again answers with the same id; /v1/me signed', async () => {
  const { env, clock } = await setup();
  const a = await Install.make(env, clock);
  const res = await a.register();
  assert.equal(res.status, 201);
  const first = await res.json() as { id: string, created: number };
  assert.equal(first.id, a.id);
  assert.equal(first.created, T0);
  clock.now += 1000;
  const again = await a.register();
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { id: a.id, created: T0 });
  const me = await a.request('GET', '/v1/me');
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { id: a.id, created: T0, approved: 0, trusted: false });
  assert.equal(env.DB.rows('SELECT COUNT(*) AS n FROM keys')[0].n, 1);
});

test('keys: the proof of work refused when it isn\'t this server\'s, has expired, asks too little, or isn\'t done', async () => {
  const { env, clock } = await setup();
  const a = await Install.make(env, clock);
  const post = (body: Record<string, unknown>) => a.request('POST', '/v1/keys', { body: JSON.stringify({ publicKey: a.publicKey, ...body }) });
  const errorOf = async (r: Response) => { const j = await r.json() as { error: string, message: string }; return `${r.status} ${j.error}: ${j.message}`; };
  const { challenge, bits } = await a.challenge();
  const nonce = a.solve(challenge, bits);
  // Not done: a nonce that doesn't reach the bits (the first one that fails).
  let bad = 0;
  while (leadingZeroBits(createHash('sha256').update(`margin-themes-pow-v1\n${challenge}\n${a.publicKey}\n${bad}`).digest()) >= bits) bad++;
  assert.match(await errorOf(await post({ challenge, nonce: String(bad) })), /400 proof-of-work: the nonce doesn't prove the work/);
  assert.match(await errorOf(await post({ challenge, nonce: 'abc' })), /400 proof-of-work: the nonce must be/);
  // Another server's (or edited): its bits lowered, its time moved, its MAC another's.
  const [exp, b, rand, mac] = challenge.split('.');
  assert.match(await errorOf(await post({ challenge: [exp, '1', rand, mac].join('.'), nonce })), /not a challenge this server gives/);
  assert.match(await errorOf(await post({ challenge: [String(Number(exp) + DAY), b, rand, mac].join('.'), nonce })), /not a challenge this server gives/);
  assert.match(await errorOf(await post({ challenge: [exp, b, rand, 'A'.repeat(43)].join('.'), nonce })), /not a challenge this server gives/);
  // The work done for another key isn't this key's.
  const b2 = await Install.make(env, clock);
  assert.match(await errorOf(await b2.request('POST', '/v1/keys', { body: JSON.stringify({ publicKey: b2.publicKey, challenge, nonce }) })),
    /proof-of-work|nonce/);
  // Asks too little once the server wants more.
  env.POW_BITS = String(bits + 4);
  assert.match(await errorOf(await post({ challenge, nonce })), /asks for too little work/);
  env.POW_BITS = String(bits);
  // Expired after 10 minutes.
  clock.now += CHALLENGE_LIFE;
  assert.match(await errorOf(await post({ challenge, nonce })), /has expired/);
  clock.now -= CHALLENGE_LIFE;
  // A public key that isn't 32 bytes.
  assert.match(await errorOf(await a.request('POST', '/v1/keys', { body: JSON.stringify({ publicKey: b64url(new Uint8Array(31)), challenge, nonce }) })), /400 public-key/);
  // Done right, it registers; nothing before did.
  assert.equal(env.DB.rows('SELECT COUNT(*) AS n FROM keys')[0].n, 0);
  assert.equal((await post({ challenge, nonce })).status, 201);
});

test('keys: registering must be signed by the key registered', async () => {
  const { env, clock } = await setup();
  const a = await Install.make(env, clock);
  const other = await Install.make(env, clock);
  assert.equal((await a.register({ unsigned: true })).status, 401);
  assert.equal((await a.register({ sign: (t) => other.signature(t) })).status, 401);
  // Signed by another key under that key's id: the id isn't this public key's.
  const { challenge, bits } = await a.challenge();
  const nonce = a.solve(challenge, bits);
  const res = await other.request('POST', '/v1/keys', { body: JSON.stringify({ publicKey: a.publicKey, challenge, nonce }) });
  assert.equal(res.status, 401);
  // Signed by the key, but sent under another id.
  const misnamed = await a.request('POST', '/v1/keys', { body: JSON.stringify({ publicKey: a.publicKey, challenge, nonce }), headers: { 'X-Margin-Key': other.id } });
  assert.equal(misnamed.status, 401);
  assert.equal(env.DB.rows('SELECT COUNT(*) AS n FROM keys')[0].n, 0);
});

test('signed requests: unsigned, unknown, another key\'s signature, an edited body, path or meta, a clock 5 minutes off: refused', async () => {
  const { env, clock, install } = await setup();
  const a = await install();
  const zip = themeZip('mine', '1.0.0');
  const status = async (p: Promise<Response>) => (await p).status;
  assert.equal(await status(a.request('GET', '/v1/me', { unsigned: true })), 401);
  const stranger = await Install.make(env, clock);
  assert.equal(await status(stranger.request('GET', '/v1/me')), 401);
  const other = await install('198.51.100.9');
  assert.equal(await status(a.request('GET', '/v1/me', { sign: (t) => other.signature(t) })), 401);
  // Signed for one body, path or meta, sent with another.
  const signedFor = (o: { method?: string, path?: string, body?: Uint8Array, meta?: string }) => (text: string) => {
    const [ctx, method, path, time, sha, meta] = text.split('\n');
    return a.signature([ctx, o.method ?? method, o.path ?? path, time, o.body ? createHash('sha256').update(o.body).digest('hex') : sha, o.meta ?? meta].join('\n'));
  };
  assert.equal(await status(a.upload(zip, undefined, { sign: signedFor({ body: themeZip('mine', '1.0.1') }) })), 401);
  assert.equal(await status(a.upload(zip, undefined, { sign: signedFor({ path: '/v1/reports' }) })), 401);
  assert.equal(await status(a.upload(zip, undefined, { sign: signedFor({ meta: b64url(enc('{"author":"Someone else"}')) }) })), 401);
  assert.equal(await status(a.upload(zip, undefined, { sign: signedFor({ method: 'PUT' }) })), 401);
  // The clock: 5 minutes either way is fine, more isn't.
  assert.equal(await status(a.request('GET', '/v1/me', { time: clock.now - 5 * 60_000 })), 200);
  assert.equal(await status(a.request('GET', '/v1/me', { time: clock.now + 5 * 60_000 })), 200);
  const off = await a.request('GET', '/v1/me', { time: clock.now - 5 * 60_000 - 1 });
  assert.equal(off.status, 401);
  assert.equal((await off.json() as { error: string }).error, 'clock');
  assert.equal(env.DB.rows('SELECT COUNT(*) AS n FROM versions')[0].n, 0, 'nothing refused was stored');
});

test('uploads: in review (not listed, not downloadable) until approved; then in the signed index, its file the one uploaded', async () => {
  const { env, indexKey, clock, install } = await setup();
  const a = await install();
  const zip = themeZip('mine', '1.0.0');
  const res = await a.upload(zip, { author: '  Ana\u202e  Lima\u0000 ', tags: ['dark', 'minimal'] });
  assert.equal(res.status, 201);
  const sha = createHash('sha256').update(zip).digest('hex');
  assert.deepEqual(await res.json(), { id: 'mine', version: '1.0.0', sha256: sha, status: 'review' });
  assert.equal((await readIndex(env, indexKey, clock.now)).themes.length, 0);
  assert.equal((await handle(new Request(`${BASE}/v1/packages/${sha}`), env, clock.now)).status, 404);
  // Review approves it.
  const done = await adminPost(env, clock.now, { action: 'approve', theme: 'mine', version: '1.0.0' });
  assert.equal(done.status, 303);
  const index = await readIndex(env, indexKey, clock.now);
  assert.equal(index.themes.length, 1);
  const [entry] = index.themes;
  assert.deepEqual({ ...entry }, { id: 'mine', name: 'Theme mine', description: 'About mine', version: '1.0.0', author: 'Ana Lima', authorKey: a.id.slice(0, 8), tags: ['dark', 'minimal'], sha256: sha, size: zip.length, updated: T0 });
  const file = await handle(new Request(`${BASE}/v1/packages/${sha}`), env, clock.now);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('Content-Type'), 'application/zip');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), zip);
  // The index stays signed when it's served from R2 again.
  const again = await readIndex(env, indexKey, clock.now + 1);
  assert.equal(again.generation, index.generation);
});

test('uploads: a theme id is its first uploader\'s; the same upload again is answered as before; a taken or older version is refused', async () => {
  const { env, clock, install } = await setup();
  const a = await install();
  const b = await install('198.51.100.9');
  const zip = themeZip('mine', '1.2.0');
  assert.equal((await a.upload(zip)).status, 201);
  const taken = await b.upload(themeZip('mine', '2.0.0'));
  assert.equal(taken.status, 409);
  assert.equal((await taken.json() as { error: string }).error, 'not-yours');
  const retry = await a.upload(zip);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json() as { status: string }).status, 'review');
  const sameVersion = await a.upload(themeZip('mine', '1.2.0', { description: 'changed' }));
  assert.equal(sameVersion.status, 409);
  assert.equal((await sameVersion.json() as { error: string }).error, 'version-taken');
  const older = await a.upload(themeZip('mine', '1.1.9'));
  assert.equal(older.status, 409);
  assert.equal((await older.json() as { error: string }).error, 'version-older');
  assert.equal((await a.upload(themeZip('mine', '1.10.0'))).status, 201);
  assert.deepEqual(env.DB.rows('SELECT version FROM versions ORDER BY major, minor, patch').map((r) => r.version), ['1.2.0', '1.10.0']);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  void clock;
});

test('uploads: a key is trusted after two approvals, its next versions published at once; the index lists each theme\'s newest', async () => {
  const { env, indexKey, clock, install } = await setup();
  const a = await install();
  for (const [id, v] of [['one', '1.0.0'], ['two', '1.0.0']]) {
    assert.equal((await a.upload(themeZip(id, v))).status, 201);
    assert.equal((await adminPost(env, clock.now, { action: 'approve', theme: id, version: v })).status, 303);
  }
  // Approving the same version again changes nothing (and doesn't count twice).
  await adminPost(env, clock.now, { action: 'approve', theme: 'one', version: '1.0.0' });
  assert.equal(env.DB.rows('SELECT approved FROM keys WHERE id = ?', a.id)[0].approved, 2);
  assert.deepEqual((await readIndex(env, indexKey, clock.now)).themes.map((t) => `${t.id} ${t.version}`), ['one 1.0.0', 'two 1.0.0']);
  clock.now += 1000;
  const res = await a.upload(themeZip('one', '1.1.0'));
  assert.equal((await res.json() as { status: string }).status, 'published');
  const index = await readIndex(env, indexKey, clock.now);
  assert.deepEqual(index.themes.map((t) => `${t.id} ${t.version}`), ['one 1.1.0', 'two 1.0.0']);
  // A rejected version is never listed; the published one before it stays.
  const b = await install('198.51.100.9');
  assert.equal((await b.upload(themeZip('three', '1.0.0'))).status, 201);
  assert.equal((await adminPost(env, clock.now, { action: 'reject', theme: 'three', version: '1.0.0', note: 'copied' })).status, 303);
  assert.deepEqual((await readIndex(env, indexKey, clock.now)).themes.map((t) => t.id), ['one', 'two']);
  assert.equal(env.DB.rows('SELECT approved FROM keys WHERE id = ?', b.id)[0].approved, 0);
  // A rejected version isn't an approval: one rejected and one approved leave the key one short of trusted.
  assert.equal((await b.upload(themeZip('four', '1.0.0'))).status, 201);
  await adminPost(env, clock.now, { action: 'approve', theme: 'four', version: '1.0.0' });
  assert.equal(env.DB.rows('SELECT approved FROM keys WHERE id = ?', b.id)[0].approved, 1);
  assert.equal((await (await b.upload(themeZip('four', '1.0.1'))).json() as { status: string }).status, 'review');
});

test('uploads: the cheap check refuses what Margin wouldn\'t use, before anything is stored', async () => {
  const { env, clock, install } = await setup();
  const a = await install();
  // Each attempt on a day of its own: refused uploads count against the 5 a day too (the check costs CPU).
  const refused = async (zip: Uint8Array, pattern: RegExp) => {
    clock.now += DAY;
    const res = await a.upload(zip);
    assert.equal(res.status, 422, String(pattern));
    const { errors } = await res.json() as { errors: string[] };
    assert.match(errors.join('\n'), pattern);
  };
  await refused(enc('not a zip at all, just text that is long enough'), /not a zip file/);
  await refused(themeZip('arcadia', '1.0.0'), /built-in theme's/);
  await refused(zipFiles({ ...themeFiles('mine', '1.0.0'), 'theme.json': enc('{"id":"mine","name":"Mine"}') }), /version missing/);
  await refused(zipFiles({ ...themeFiles('mine', '1.0.0'), 'theme.json': enc('{"id":"mine","name":"Mine","version":"1.0"}') }), /bad version/);
  await refused(zipFiles({ ...themeFiles('mine', '1.0.0'), 'script.js': enc('alert(1)') }), /not a file a theme may bundle/);
  await refused(zipFiles({ 'theme.json': themeFiles('mine', '1.0.0')['theme.json'], 'theme.css': enc('') }), /theme\.html missing/);
  await refused(zipFiles({ ...themeFiles('mine', '1.0.0'), 'a/b/c/d.png': new Uint8Array(10) }), /folders deep/);
  // A bomb: an entry that says it inflates to more than its kind may hold is refused from the directory alone.
  const bomb = zipFiles({ ...themeFiles('mine', '1.0.0'), 'big.png': new Uint8Array(300 * 1024) });
  await refused(bomb, /larger than/);
  // theme.json's CRC-32 wrong: the one file inflated is checked.
  const bad = zipFiles(themeFiles('mine', '1.0.0'));
  const view = new DataView(bad.buffer);
  const cdAt = view.getUint32(bad.length - 22 + 16, true);
  // theme.json sorts after theme.css and theme.html: the third directory entry.
  let at = cdAt;
  for (let i = 0; i < 2; i++) at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  view.setUint32(at + 16, view.getUint32(at + 16, true) ^ 1, true);
  await refused(bad, /CRC-32/);
  assert.equal(env.DB.rows('SELECT COUNT(*) AS n FROM versions')[0].n, 0);
  assert.equal(env.DB.rows('SELECT COUNT(*) AS n FROM themes')[0].n, 0, 'no id claimed by a refused package');
  assert.equal(env.FILES.puts, 0);
  // Larger than a package may be: refused before it's read.
  const huge = await a.upload(new Uint8Array(4 * 1024 * 1024 + 1));
  assert.equal(huge.status, 413);
  // The meta: an author's name of nothing but controls, too many tags.
  assert.equal((await a.upload(themeZip('mine', '1.0.0'), { author: '\u202e\u0000' })).status, 400);
  assert.equal((await a.upload(themeZip('mine', '1.0.0'), { author: 'Ana', tags: ['a', 'b', 'c', 'd', 'e', 'f'] })).status, 400);
  assert.equal((await a.upload(themeZip('mine', '1.0.0'), { author: 'Ana', tags: ['Bad Tag'] })).status, 400);
  clock.now += DAY;
  assert.equal((await a.upload(themeZip('mine', '1.0.0'), { author: 'Ana', tags: ['dark', 'dark'] })).status, 400);
});

test('the cheap check: every built-in, packed as Margin packs it and given an id of its own, passes; a theme in one folder too', async () => {
  for (const id of ['arcadia', 'neubrutalism', 'pixel', 'liquid-glass', 'material']) {
    const packed = packTheme(new URL(`../app/shared/ui/themes/${id}/`, import.meta.url).pathname);
    const checked = await checkUpload(packed.bytes);
    // A built-in's own id is refused, as checkImport refuses it; the rest of it passes.
    assert.equal(checked.ok, false);
    assert.match((checked as { errors: string[] }).errors.join(), /built-in/);
  }
  const folder = Object.fromEntries(Object.entries(themeFiles('wrapped', '0.1.0')).map(([p, b]) => [`wrapped/${p}`, b]));
  const checked = await checkUpload(zipFiles({ ...folder, '__MACOSX/wrapped/._theme.json': new Uint8Array(4) }));
  assert.deepEqual(checked, { ok: true, manifest: { id: 'wrapped', name: 'Theme wrapped', version: '0.1.0', description: 'About wrapped' } });
});

test('limits: 5 uploads a day per key (429 with Retry-After until 00:00 UTC), 20 a day per network, the key\'s count given back when the network refuses', async () => {
  const { env, clock, install } = await setup();
  const a = await install();
  for (let i = 0; i < 5; i++) assert.equal((await a.upload(themeZip(`t${i}`, '1.0.0'))).status, 201);
  const sixth = await a.upload(themeZip('t5', '1.0.0'));
  assert.equal(sixth.status, 429);
  assert.equal(sixth.headers.get('Retry-After'), String(14 * 3600));
  clock.now = Date.UTC(2026, 10, 26, 0, 0, 0);
  assert.equal((await a.upload(themeZip('t5', '1.0.0'))).status, 201);
  // One network: 20 a day across its keys.
  const ip = '192.0.2.44';
  const keys = [];
  for (let i = 0; i < 5; i++) keys.push(await install(ip));
  let n = 0;
  for (const k of keys.slice(0, 4)) for (let i = 0; i < 5; i++) assert.equal((await k.upload(themeZip(`n${n++}`, '1.0.0'))).status, 201);
  const over = await keys[4].upload(themeZip(`n${n}`, '1.0.0'));
  assert.equal(over.status, 429);
  // Its own 5 weren't used: from another network it can upload all of them.
  for (let i = 0; i < 5; i++) assert.equal((await keys[4].upload(themeZip(`m${i}`, '1.0.0'), undefined, { ip: '192.0.2.45' })).status, 201);
  assert.equal((await keys[4].upload(themeZip('m5', '1.0.0'), undefined, { ip: '192.0.2.46' })).status, 429);
});

test('limits: 20 new keys a day per network (an IPv6 network is its /64); a key registered before doesn\'t count', async () => {
  const { env, clock } = await setup();
  for (let i = 0; i < 20; i++) {
    const k = await Install.make(env, clock, `2001:db8:1:2:${i.toString(16)}::1`);
    assert.equal((await k.register()).status, 201);
  }
  const k = await Install.make(env, clock, '2001:0db8:0001:0002:ffff:0:0:9');
  const refused = await k.register();
  assert.equal(refused.status, 429);
  assert.equal(env.DB.rows('SELECT COUNT(*) AS n FROM keys')[0].n, 20);
  assert.equal((await k.register({ ip: '2001:db8:1:3::1' })).status, 201);
  // Registered already: answered again without counting.
  assert.equal((await k.register()).status, 200);
});

test('limits: the Limiter counts exactly under requests at once; minutes and hours slide; give takes one back', async () => {
  const store = new MapStorage();
  const storage = store.map;
  const limiter = new Limiter({ storage: store });
  const rules = [{ name: 'a', limit: 3, per: 'minute' as const }];
  assert.deepEqual(await limiter.count('take', rules, 1000), { ok: true });
  assert.deepEqual(await limiter.count('take', rules, 2000), { ok: true });
  assert.deepEqual(await limiter.count('take', rules, 30_000), { ok: true });
  assert.deepEqual(await limiter.count('take', rules, 40_000), { ok: false, rule: 'a', retryAfter: 21 });
  assert.deepEqual(await limiter.count('take', rules, 61_001), { ok: true });
  assert.deepEqual(await limiter.count('give', rules, 61_002), { ok: true });
  assert.deepEqual(await limiter.count('take', rules, 61_003), { ok: true });
  assert.equal((await limiter.count('take', rules, 61_004)).ok, false);
  // All or nothing: one rule at its limit counts against none.
  const both = [{ name: 'free', limit: 10, per: 'hour' as const }, ...rules];
  assert.equal((await limiter.count('take', both, 61_005)).ok, false);
  assert.equal(((storage.get('hour:free') ?? []) as number[]).length, 0);
  // Through the fake namespace, 30 at once against a limit of 7: exactly 7 taken.
  const { env } = await fakeEnv();
  const { count } = await import('../cloud/themes/src/limits.ts');
  const results = await Promise.all(Array.from({ length: 30 }, () => count(env, 'key:x', 'take', [{ name: 'b', limit: 7, per: 'day' }], T0)));
  assert.equal(results.filter((r) => r.ok).length, 7);
  assert.ok(RATES.upload.key[0].limit === 5 && RATES.upload.network[0].limit === 20 && RATES.register.network[0].limit === 20);
});

test('reports: one per key per theme; reports from 3 networks hide a theme (not 3 from one); review shows it again and clears them', async () => {
  const { env, indexKey, clock, install } = await setup();
  const owner = await install();
  await owner.upload(themeZip('mine', '1.0.0'));
  await adminPost(env, clock.now, { action: 'approve', theme: 'mine', version: '1.0.0' });
  const reportFrom = (k: Install, o: Opts = {}) => k.request('POST', '/v1/reports', { body: JSON.stringify({ theme: 'mine', reason: 'broken', note: 'it\u202e breaks' }), ...o });
  assert.equal((await reportFrom(owner)).status, 400, 'not one\'s own');
  const sameNet = [];
  for (let i = 0; i < HIDE_AFTER; i++) sameNet.push(await install('192.0.2.10'));
  for (const k of sameNet) assert.equal((await reportFrom(k)).status, 201);
  assert.equal((await reportFrom(sameNet[0])).status, 200, 'again: answered, not counted');
  assert.equal((await readIndex(env, indexKey, clock.now)).themes.length, 1, 'three reports from one network don\'t hide it');
  assert.equal(env.DB.rows('SELECT network FROM reports')[0].network.includes('192'), false, 'the network kept as an HMAC only');
  const k2 = await install('198.51.100.20');
  const k3 = await install('2001:db8:9::1');
  assert.equal((await reportFrom(k2)).status, 201);
  assert.equal((await readIndex(env, indexKey, clock.now)).themes.length, 1);
  assert.equal((await reportFrom(k3)).status, 201);
  assert.equal((await readIndex(env, indexKey, clock.now)).themes.length, 0, 'hidden after reports from three networks');
  const sha = createHash('sha256').update(themeZip('mine', '1.0.0')).digest('hex');
  assert.equal((await handle(new Request(`${BASE}/v1/packages/${sha}`), env, clock.now)).status, 404, 'a hidden theme\'s file isn\'t served');
  const page = await (await handle(new Request(`${BASE}/admin`, { headers: ADMIN(env) }), env, clock.now)).text();
  assert.match(page, /it\s+breaks/);
  assert.equal((await adminPost(env, clock.now, { action: 'unhide', theme: 'mine' })).status, 303);
  assert.equal((await readIndex(env, indexKey, clock.now)).themes.length, 1);
  assert.equal(env.DB.rows('SELECT COUNT(*) AS n FROM reports WHERE cleared = 0')[0].n, 0);
  // Bad reports.
  assert.equal((await k2.request('POST', '/v1/reports', { body: JSON.stringify({ theme: 'nope', reason: 'broken' }) })).status, 404);
  assert.equal((await k2.request('POST', '/v1/reports', { body: JSON.stringify({ theme: 'mine', reason: 'meh' }) })).status, 400);
  assert.equal((await k2.request('POST', '/v1/reports', { body: JSON.stringify({ theme: 'mine', reason: 'other', note: 'x'.repeat(281) }) })).status, 400);
});

test('blocking: a blocked key\'s themes leave the index and its requests are refused; unblocking brings them back', async () => {
  const { env, indexKey, clock, install } = await setup();
  const a = await install();
  await a.upload(themeZip('mine', '1.0.0'));
  await adminPost(env, clock.now, { action: 'approve', theme: 'mine', version: '1.0.0' });
  assert.equal((await readIndex(env, indexKey, clock.now)).themes.length, 1);
  assert.equal((await adminPost(env, clock.now, { action: 'block', key: a.id })).status, 303);
  assert.equal((await readIndex(env, indexKey, clock.now)).themes.length, 0);
  assert.equal((await a.request('GET', '/v1/me')).status, 403);
  assert.equal((await a.upload(themeZip('mine', '1.1.0'))).status, 403);
  assert.equal((await a.register()).status, 403);
  await adminPost(env, clock.now, { action: 'unblock', key: a.id });
  assert.equal((await readIndex(env, indexKey, clock.now)).themes.length, 1);
  assert.equal((await a.request('GET', '/v1/me')).status, 200);
});

test('the review page: only with the password; changes only from the page (its origin and token); what it shows escaped', async () => {
  const { env, clock, install } = await setup();
  const a = await install();
  await a.upload(themeZip('mine', '1.0.0'), { author: 'Ana "quotes" & co' });
  const get = (headers: Record<string, string> = {}) => handle(new Request(`${BASE}/admin`, { headers }), env, clock.now);
  assert.equal((await get()).status, 401);
  assert.equal((await get({ Authorization: `Basic ${btoa('admin:wrong')}` })).status, 401);
  assert.equal((await get({ Authorization: `Basic ${btoa(`admin:${env.ADMIN_TOKEN}x`)}` })).status, 401);
  const ok = await get(ADMIN(env));
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('Content-Security-Policy') ?? '', /default-src 'none'/);
  const html = await ok.text();
  assert.match(html, /Ana &#34;quotes&#34; &#38; co/);
  assert.equal(html.includes('"quotes"'), false);
  // From another site: refused, even with the browser's password.
  assert.equal((await adminPost(env, clock.now, { action: 'approve', theme: 'mine', version: '1.0.0' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await adminPost(env, clock.now, { action: 'approve', theme: 'mine', version: '1.0.0' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const noToken = await handle(new Request(`${BASE}/admin`, { method: 'POST', body: 'action=approve&theme=mine&version=1.0.0', headers: { ...ADMIN(env), Origin: BASE, 'Content-Type': 'application/x-www-form-urlencoded' } }), env, clock.now);
  assert.equal(noToken.status, 403);
  assert.equal(env.DB.rows('SELECT status FROM versions')[0].status, 'review');
  // A package in review downloads from the page, not from the public route.
  const sha = createHash('sha256').update(themeZip('mine', '1.0.0')).digest('hex');
  assert.equal((await handle(new Request(`${BASE}/admin/packages/${sha}`, { headers: ADMIN(env) }), env, clock.now)).status, 200);
  // No password set: no review page at all.
  const { env: bare } = await fakeEnv({ ADMIN_TOKEN: undefined });
  assert.equal((await handle(new Request(`${BASE}/admin`, { headers: ADMIN(env) }), bare, clock.now)).status, 404);
});

test('the index: rebuilt only when what it lists changed; signed over its exact text', async () => {
  const { env, indexKey, clock, install } = await setup();
  const first = await readIndex(env, indexKey, clock.now);
  assert.deepEqual(first.themes, []);
  const puts = env.FILES.puts;
  await readIndex(env, indexKey, clock.now + 1);
  assert.equal(env.FILES.puts, puts, 'served from R2, not rebuilt');
  const a = await install();
  await a.upload(themeZip('mine', '1.0.0'));
  await readIndex(env, indexKey, clock.now + 2);
  assert.equal(env.FILES.puts, puts + 1, 'an upload in review stores the file, not a new index');
  await adminPost(env, clock.now, { action: 'approve', theme: 'mine', version: '1.0.0' });
  const after = await readIndex(env, indexKey, clock.now + 3);
  assert.ok(after.generation > first.generation);
  assert.equal(after.themes.length, 1);
  // A signature over other text doesn't verify.
  const { index, signature } = await (await handle(new Request(`${BASE}/v1/index`), env, clock.now)).json() as { index: string, signature: string };
  assert.equal(await verifyEd25519(indexKey, unb64url(signature)!, INDEX_CONTEXT + index.replace('mine', 'mime')), false);
  assert.equal(await verifyEd25519(indexKey, unb64url(signature)!, index), false, 'the context line is part of what\'s signed');
});

test('not set up: no secrets, a 503 that says so; unknown routes and methods', async () => {
  const { env } = await fakeEnv({ CHALLENGE_SECRET: undefined, SIGNING_KEY: undefined });
  assert.equal((await handle(new Request(`${BASE}/v1/challenge`), env, T0)).status, 503);
  assert.equal((await handle(new Request(`${BASE}/v1/index`), env, T0)).status, 503);
  assert.equal((await handle(new Request(`${BASE}/v1/nope`), env, T0)).status, 404);
  assert.equal((await handle(new Request(`${BASE}/v1/index`, { method: 'POST' }), env, T0)).status, 405);
  assert.equal((await handle(new Request(`${BASE}/v1/packages/../../index.json`), env, T0)).status, 404);
});

test('networks: IPv4 whole; IPv6 by its /64 however it\'s written; IPv4 in IPv6 as IPv4; anything else one "unknown"', () => {
  const net = (ip?: string) => networkOf(new Request(BASE, { headers: ip ? { 'CF-Connecting-IP': ip } : {} }));
  assert.equal(net('203.0.113.7'), '4:203.0.113.7');
  assert.equal(net('2001:db8:1:2::1'), net('2001:0DB8:0001:0002:ffff:ffff:ffff:ffff'));
  assert.notEqual(net('2001:db8:1:2::1'), net('2001:db8:1:3::1'));
  assert.equal(net('::ffff:203.0.113.7'), '4:203.0.113.7');
  assert.equal(net('::'), '6:0:0:0:0::/64');
  for (const bad of [undefined, '', 'localhost', '300.1.1.1', '1:2:3:4:5:6:7:8:9', '1::2::3', 'fe80::1%en0', '::ffff:300.1.1.1']) assert.equal(net(bad), 'unknown', String(bad));
});

test('names and encodings: an author\'s name cleaned; base64url one spelling per value', () => {
  assert.equal(cleanAuthor('  A\u200bn\u202ea   B '), 'Ana B');
  assert.equal(cleanAuthor('<b>x</b>'), 'bx/b');
  assert.equal(cleanAuthor('x'.repeat(40)), 'x'.repeat(40));
  assert.equal(cleanAuthor('x'.repeat(41)), null);
  assert.equal(cleanAuthor('\u0000\u202e'), null);
  assert.equal(cleanAuthor(5), null);
  assert.deepEqual(unb64url('AQI'), new Uint8Array([1, 2]));
  assert.equal(unb64url('AQJ'), null, 'unused bits set');
  assert.equal(unb64url('AQI='), null, 'padding');
  assert.equal(unb64url('A+/'), null);
  assert.equal(hex(new Uint8Array([0, 255])), '00ff');
});

test('npm run themes:keys: a signing key whose public half verifies its signatures; random secrets long enough', async () => {
  const signing = await makeSecret('SIGNING_KEY');
  const pub = unb64url(/: ([A-Za-z0-9_-]{43})$/.exec(signing.shown)![1])!;
  const sig = await signEd25519(signing.value, 'hello');
  assert.ok(await verifyEd25519(pub, sig, 'hello'));
  const a = await makeSecret('CHALLENGE_SECRET');
  const b = await makeSecret('CHALLENGE_SECRET');
  assert.ok(a.value.length >= 43 && a.value !== b.value && a.shown === '');
  assert.match((await makeSecret('ADMIN_TOKEN')).shown, /password/);
});

test('the Worker bundles for Cloudflare: browser APIs only, no Node built-ins, well under the free plan\'s 3 MB', () => {
  const out = buildSync({
    entryPoints: [new URL('../cloud/themes/src/worker.ts', import.meta.url).pathname],
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, logLevel: 'silent', minify: true,
  });
  assert.equal(out.errors.length, 0);
  const code = out.outputFiles[0].text;
  assert.ok(code.length < 1024 * 1024, `${code.length} bytes`);
  assert.equal(/\bprocess\.|require\(|node:/.test(code), false);
});
