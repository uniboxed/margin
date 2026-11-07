// The packages the security suite checks (npm run test:security): every
// built-in theme, and any named in MARGIN_THEMES (colon-separated folders or
// .margintheme files, read as Margin reads an import: ui/theme-import.js), so
// a theme can be checked before it's shared:
// `MARGIN_THEMES=~/my-theme npm run test:security`.
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_THEMES } from '../../extension/themes/packages.js';
import { readTheme } from '../theme/package.js';
import { packageFromFiles, packageFromZip } from '../../extension/ui/theme-import.js';
import { folderFiles } from '../../scripts/pack-theme.js';

const THEMES = fileURLToPath(new URL('../../extension/themes/', import.meta.url));

/**
 * @returns {{ label: string, builtin: boolean, id: string | null, dir: string | null, read: (() => Pkg) | null, readAsync?: (() => Promise<Pkg>) | null }[]}
 * @typedef {{ manifest: string, html: string, css: string, files: Record<string, Uint8Array> }} Pkg
 */
export function suitePackages(env = process.env.MARGIN_THEMES) {
  const out = PACKAGE_THEMES.map((id) => ({
    label: `built-in ${id}`, builtin: true, id, dir: join(THEMES, id),
    read: () => { const t = readTheme(join(THEMES, id)); return { ...t, files: Object.fromEntries(Object.entries(t.files).map(([k, v]) => [k, new Uint8Array(v)])) }; },
  }));
  for (const raw of (env ?? '').split(':').map((s) => s.trim()).filter(Boolean)) {
    const path = resolve(raw.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
    if (!existsSync(path)) throw new Error(`MARGIN_THEMES: ${raw} doesn't exist`);
    const asImport = (r) => { if (!r.ok) throw new Error(`${raw}: ${r.errors.join('; ')}`); return r.pkg; };
    const zip = /\.margintheme$/i.test(path);
    out.push({
      label: `MARGIN_THEMES ${raw}`, builtin: false, id: null, dir: zip ? null : path,
      // A folder as Margin.app reads one (scripts/pack-theme.js folderFiles: links refused, hidden folders left out).
      read: zip ? null : () => asImport(packageFromFiles(folderFiles(path).files)),
      readAsync: zip ? async () => asImport(await packageFromZip(new Uint8Array(readFileSync(path)))) : null,
    });
  }
  return out;
}

/** Every package of the suite, read. */
export async function readSuitePackages(env) {
  const out = [];
  for (const p of suitePackages(env)) out.push({ ...p, pkg: p.read ? p.read() : await p.readAsync() });
  return out;
}
