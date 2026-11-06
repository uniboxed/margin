// The test build: Safari's profile (shared/platform.js: nativeApp, icon
// fetching, sleeping tabs, the learned search engine) with Chrome's manifest
// so Chromium loads it, plus two changes in this copy only:
//
// - `nativeMessaging` in its permissions (Chrome's manifest has none), and a
//   `key`, so the extension's id is known before launch (the native host's
//   manifest names it);
// - the link's socket guard (background/link.js canSocket: no socket in a
//   worker, because WebKit hangs one there) let through: Chromium's service
//   worker opens sockets fine. It's one exact string in the bundle; if it
//   moves, this fails at once rather than test an unlinked copy.
import { generateKeyPairSync, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTo } from '../../../scripts/build.js';

export const SOCKET_GUARD = 'canSocket=()=>typeof globalThis.document=="object"&&typeof globalThis.WorkerGlobalScope>"u"';

/** The extension id Chromium gives an extension whose manifest has this public key (DER). */
export function extensionId(der) {
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...hex].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join('');
}

/** Builds the test build into `dir` (made fresh). @returns {{ path: string, id: string }} */
export function testBuild(dir) {
  const path = buildTo(join(dir, 'ext'), { profile: 'safari', manifest: 'chrome' });
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const manifestPath = join(path, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.key = der.toString('base64');
  manifest.permissions = [...new Set([...(manifest.permissions ?? []), 'nativeMessaging'])];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const bundlePath = join(path, 'background.bundle.js');
  const bundle = readFileSync(bundlePath, 'utf8');
  if (!bundle.includes(SOCKET_GUARD)) throw new Error('the e2e harness: the link\'s socket guard (background/link.js canSocket) is no longer the string it patches; update SOCKET_GUARD in tests/e2e/harness/build.js');
  writeFileSync(bundlePath, bundle.replace(SOCKET_GUARD, 'canSocket=()=>!0'));
  return { path, id: extensionId(der) };
}
