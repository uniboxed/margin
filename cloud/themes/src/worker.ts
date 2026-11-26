// Margin's themes server (docs/THEME-STORE.md): a Cloudflare Worker on the free plan.
//
//   GET  /v1/challenge          a proof-of-work challenge (keys.ts)
//   POST /v1/keys               register the install's key with the work done
//   GET  /v1/me                 signed: the key as the server knows it
//   POST /v1/themes             signed: upload a .margintheme (store.ts upload)
//   POST /v1/reports            signed: report a theme
//   GET  /v1/index              the signed index of published themes
//   GET  /v1/packages/<sha256>  a published package
//   /admin                      the review page (admin.ts)

import { admin, authorized, challengeAuth } from './admin.ts';
import { fail, json, networkOf, parseObject, readBody } from './http.ts';
import { makeChallenge, register, secretOk, signer } from './keys.ts';
import { RATES, takeAll, type Taken } from './limits.ts';
import { MAX_PACKAGE } from './package.ts';
import { index, me, packageFile, report, upload } from './store.ts';
import type { Env } from './types.ts';

export { Limiter } from './limits.ts';

const JSON_MAX = 4096;

const limited = (t: Extract<Taken, { ok: false }>) => fail(429, 'rate', `Too many for now (${t.rule}): try again later.`, { 'Retry-After': String(t.retryAfter) });
const unconfigured = () => fail(503, 'unconfigured', 'The themes server isn\'t set up yet.');

/** One request, at `now` (ms). */
export async function handle(request: Request, env: Env, now: number): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const network = networkOf(request);

  if (path === '/admin' || path.startsWith('/admin/')) {
    if (!secretOk(env.ADMIN_TOKEN)) return fail(404, 'not-found', 'Not found.');
    const adminEnv = env as Env & { ADMIN_TOKEN: string };
    if (!(await authorized(request, adminEnv))) return challengeAuth();
    return admin(request, adminEnv, path, now);
  }

  if (path === '/v1/challenge') {
    if (method !== 'GET') return fail(405, 'method', 'GET only.', { Allow: 'GET' });
    if (!secretOk(env.CHALLENGE_SECRET)) return unconfigured();
    return json(200, await makeChallenge(env as Env & { CHALLENGE_SECRET: string }, now));
  }

  if (path === '/v1/keys') {
    if (method !== 'POST') return fail(405, 'method', 'POST only.', { Allow: 'POST' });
    if (!secretOk(env.CHALLENGE_SECRET)) return unconfigured();
    const body = await readBody(request, JSON_MAX);
    if (!body) return fail(413, 'too-large', 'The request is too large.');
    const input = parseObject(body);
    if (!input) return fail(400, 'json', 'The body must be a JSON object.');
    return register(request, env as Env & { CHALLENGE_SECRET: string }, body, input, now, async () => {
      const t = await takeAll(env, RATES.register, { network }, now);
      return t.ok ? null : limited(t);
    });
  }

  if (path === '/v1/me') {
    if (method !== 'GET') return fail(405, 'method', 'GET only.', { Allow: 'GET' });
    const body = await readBody(request, 0);
    if (!body) return fail(413, 'too-large', 'GET takes no body.');
    const who = await signer(request, env, body, now);
    if ('response' in who) return who.response;
    return me(who.key);
  }

  if (path === '/v1/themes') {
    if (method !== 'POST') return fail(405, 'method', 'POST only.', { Allow: 'POST' });
    const body = await readBody(request, MAX_PACKAGE);
    if (!body) return fail(413, 'too-large', `A package is at most ${MAX_PACKAGE} bytes.`);
    const who = await signer(request, env, body, now);
    if ('response' in who) return who.response;
    const t = await takeAll(env, RATES.upload, { key: who.key.id, network }, now);
    if (!t.ok) return limited(t);
    return upload(env, who.key, body, who.meta, now);
  }

  if (path === '/v1/reports') {
    if (method !== 'POST') return fail(405, 'method', 'POST only.', { Allow: 'POST' });
    if (!secretOk(env.CHALLENGE_SECRET)) return unconfigured();
    const body = await readBody(request, JSON_MAX);
    if (!body) return fail(413, 'too-large', 'The request is too large.');
    const who = await signer(request, env, body, now);
    if ('response' in who) return who.response;
    const input = parseObject(body);
    if (!input) return fail(400, 'json', 'The body must be a JSON object.');
    const t = await takeAll(env, RATES.report, { key: who.key.id, network }, now);
    if (!t.ok) return limited(t);
    return report(env as Env & { CHALLENGE_SECRET: string }, who.key, input, network, now);
  }

  if (path === '/v1/index') {
    if (method !== 'GET') return fail(405, 'method', 'GET only.', { Allow: 'GET' });
    if (!secretOk(env.SIGNING_KEY)) return unconfigured();
    return index(env as Env & { SIGNING_KEY: string }, now);
  }

  const pkg = /^\/v1\/packages\/([^/]+)$/.exec(path);
  if (pkg) {
    if (method !== 'GET') return fail(405, 'method', 'GET only.', { Allow: 'GET' });
    return packageFile(env, pkg[1]);
  }

  return fail(404, 'not-found', 'Not found.');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env, Date.now());
    } catch (err) {
      // Never the error's text to the caller (it may name internals); Cloudflare's logs keep it.
      console.error('themes:', err);
      return fail(500, 'server', 'Something went wrong on the themes server.');
    }
  },
};
