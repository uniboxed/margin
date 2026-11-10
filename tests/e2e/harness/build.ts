// The test build: Safari's profile (shared/capabilities.ts: nativeApp, icon
// fetching, sleeping tabs, the learned search engine) with Chrome's manifest
// so Chromium loads it, plus two changes in this copy only:
//
// - `nativeMessaging` in its permissions (Chrome's manifest has none), and a
//   `key`, so the extension's id is known before launch (the native host's
//   manifest names it);
// - the link's socket guard (background/link.ts canSocket: no socket in a
//   worker, because WebKit hangs one there) let through: Chromium's service
//   worker opens sockets fine. It's one exact string in the bundle; if it
//   moves, this fails at once rather than test an unlinked copy.
//
// And one thing Chromium does that Safari doesn't: Safari gives extensions no
// tab.favIconUrl (background/site-icons.ts fetches each site's icon itself).
// The background here sees tabs without it (SAFARI_TABS, put before the
// bundle), so the icons Margin draws are the ones it fetched, as in Safari.
//
// And one thing headless Chromium does that Safari doesn't: every tab is
// visible (document.visibilityState is 'visible' behind the front tab too).
// A script the background runs in a tab that isn't in front sees it hidden
// while it runs (HIDDEN_BEHIND), as Safari's tab would be: the sleeping
// tabs' ask (background/sleep.ts sleepInPage) needs it.
import { generateKeyPairSync, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTo } from '../../../scripts/build.ts';

export const SAFARI_TABS = `// e2e: tabs as Safari gives them (no favIconUrl).
(() => {
  const strip = (v) => {
    if (Array.isArray(v)) v.forEach(strip);
    else if (v && typeof v === 'object') { delete v.favIconUrl; if (Array.isArray(v.tabs)) v.tabs.forEach(strip); }
    return v;
  };
  for (const ns of new Set([globalThis.chrome, globalThis.browser].filter(Boolean))) {
    for (const [area, fns] of [[ns.tabs, ['get', 'query', 'create', 'update', 'duplicate', 'move', 'reload', 'getCurrent']], [ns.windows, ['get', 'getAll', 'getCurrent', 'getLastFocused', 'create', 'update']]]) {
      if (!area) continue;
      for (const name of fns) {
        const fn = area[name];
        if (typeof fn === 'function') area[name] = (...args) => { const out = fn.apply(area, args); return out && typeof out.then === 'function' ? out.then(strip) : out; };
      }
    }
    for (const event of ['onCreated', 'onUpdated']) {
      const e = ns.tabs?.[event];
      if (!e) continue;
      const add = e.addListener.bind(e);
      e.addListener = (cb) => add((...args) => { args.forEach(strip); if (event === 'onUpdated' && args[1] && Object.keys(args[1]).length === 0) return; return cb(...args); });
    }
  }
})();
`;

export const HIDDEN_BEHIND = `// e2e: a tab behind the front one is hidden, as in Safari.
(() => {
  const s = globalThis.chrome?.scripting;
  if (!s?.executeScript) return;
  const run = s.executeScript.bind(s);
  const mark = (on) => {
    globalThis.__e2eHidden = on;
    if (globalThis.__e2eVisibility) return;
    globalThis.__e2eVisibility = true;
    const real = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState').get;
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get() { return globalThis.__e2eHidden ? 'hidden' : real.call(this); } });
  };
  s.executeScript = async (inj) => {
    const tabId = inj?.target?.tabId;
    if (typeof inj?.func !== 'function' || tabId == null) return run(inj);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.active) return run(inj);
    const target = { tabId, ...(inj.target.allFrames ? { allFrames: true } : {}), ...(inj.target.frameIds ? { frameIds: inj.target.frameIds } : {}) };
    await run({ target, func: mark, args: [true] }).catch(() => {});
    try { return await run(inj); } finally { run({ target, func: mark, args: [false] }).catch(() => {}); }
  };
})();
`;

export const SOCKET_GUARD = 'canSocket=()=>!!capabilities?.socketInWorker||typeof globalThis.document=="object"&&typeof globalThis.WorkerGlobalScope>"u"';

/** The extension id Chromium gives an extension whose manifest has this public key (DER). */
export function extensionId(der) {
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...hex].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join('');
}

/** Builds the test build into `dir` (made fresh). */
export function testBuild(dir): { path: string, id: string } {
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
  if (!bundle.includes(SOCKET_GUARD)) throw new Error('the e2e harness: the link\'s socket guard (background/link.ts canSocket) is no longer the string it patches; update SOCKET_GUARD in tests/e2e/harness/build.ts');
  writeFileSync(bundlePath, SAFARI_TABS + HIDDEN_BEHIND + bundle.replace(SOCKET_GUARD, 'canSocket=()=>!0'));
  return { path, id: extensionId(der) };
}
