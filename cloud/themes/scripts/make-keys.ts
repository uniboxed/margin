// npm run themes:keys -- NAME…: makes the themes server's secrets and puts each one named straight into the Worker's
// secrets (`wrangler secret put`, from cloud/themes, logged in to Cloudflare), so no secret is ever written to a file,
// a terminal's history or this repo. The names:
//   SIGNING_KEY       the index's Ed25519 signing key (PKCS #8). Its public half is printed: it goes into Margin, and
//                     making a new one means every Margin before it can no longer verify the index. Once, ever.
//   CHALLENGE_SECRET  signs the proof of work's challenges and hashes reporters' networks.
//   ADMIN_TOKEN       the review page's password: printed once, for your password manager.
// The Claude API key (later) is pasted with `npx wrangler secret put ANTHROPIC_API_KEY` by hand.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { b64url } from '../src/crypto.ts';

export const NAMES = ['SIGNING_KEY', 'CHALLENGE_SECRET', 'ADMIN_TOKEN'] as const;
export type SecretName = typeof NAMES[number];

/** One secret's value, and what may be shown of it (the signing key's public half, the admin password). */
export async function makeSecret(name: SecretName): Promise<{ value: string, shown: string }> {
  if (name === 'SIGNING_KEY') {
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    return { value: Buffer.from(pkcs8).toString('base64'), shown: `the index's public key, for Margin: ${b64url(raw)}` };
  }
  const value = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { value, shown: name === 'ADMIN_TOKEN' ? `the review page's password (any user name), keep it in your password manager: ${value}` : '' };
}

function isCommand(url: string) {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url)); } catch { return false; }
}

if (isCommand(import.meta.url)) {
  const names = process.argv.slice(2);
  if (!names.length || !names.every((n): n is SecretName => (NAMES as readonly string[]).includes(n)) || new Set(names).size !== names.length) {
    console.error(`npm run themes:keys -- ${NAMES.join(' | ')} …  (each named is made and put into the Worker's secrets)`);
    process.exit(2);
  }
  const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  for (const name of names) {
    const { value, shown } = await makeSecret(name);
    const put = spawnSync('npx', ['wrangler', 'secret', 'put', name], { cwd, input: value, stdio: ['pipe', 'inherit', 'inherit'] });
    if (put.status !== 0) { console.error(`${name}: wrangler secret put failed; nothing shown, nothing kept`); process.exit(1); }
    console.log(shown ? `${name} set: ${shown}` : `${name} set`);
  }
}
