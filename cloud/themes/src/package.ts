// An uploaded package's cheap check (docs/THEME-STORE.md §3 step 2): what fits in the free plan's 10 ms of CPU.
// The zip's shape, names, kinds and stated sizes by the app's own reader (ui/theme-import.ts zipEntries, nothing
// inflated), the package's layout by its own rules (packageFromFiles, on the names alone), and theme.json, the one
// file inflated, by its own schema (ui/theme-schema.ts checkManifest). The full check (the sanitizer, the template,
// each file's content) is Margin's: before it uploads, and on every device each time the theme is installed or
// loaded.

import { IMPORT_LIMITS, packageFromFiles, zipEntries, zipEntryBytes } from '../../../app/shared/ui/theme-import.ts';
import { BUILTIN_THEMES, PACKAGE_LIMITS } from '../../../app/shared/ui/theme-loader.ts';
import { checkManifest } from '../../../app/shared/ui/theme-schema.ts';

export const MAX_PACKAGE = IMPORT_LIMITS.zipBytes;

/** What the index shows of a package, from its theme.json. */
export type Manifest = { id: string, name: string, version: string, description: string };

export type Checked = { ok: true, manifest: Manifest } | { ok: false, errors: string[] };

export async function checkUpload(zip: Uint8Array): Promise<Checked> {
  const read = zipEntries(zip);
  if (!read.ok) return read;
  const files = read.entries.filter((e) => !e.dir);
  // The layout (the theme's folder, the three texts, depth, case), on the names: no file's bytes are read for it.
  const names: Record<string, Uint8Array> = Object.fromEntries(files.map((e) => [e.name, new Uint8Array(0)]));
  const layout = packageFromFiles(names);
  if (!layout.ok) return layout;
  if (Object.keys(layout.pkg.files).length > PACKAGE_LIMITS.files) return { ok: false, errors: [`package: more than ${PACKAGE_LIMITS.files} files`] };
  // theme.json, where packageFromFiles found it: at the top, or in the one folder everything is in.
  const kept = files.filter((e) => !e.junk);
  const root = kept.some((e) => e.name === 'theme.json') ? '' : `${kept[0].name.slice(0, kept[0].name.indexOf('/'))}/`;
  const entry = kept.find((e) => e.name === `${root}theme.json`)!;
  const got = await zipEntryBytes(zip, entry);
  if (!got.ok) return got;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(got.bytes).replace(/^\ufeff/, ''); } catch { return { ok: false, errors: ['theme.json: not UTF-8 text'] }; }
  const checked = checkManifest(text, { files: Object.keys(layout.pkg.files) });
  if (!checked.manifest) return { ok: false, errors: checked.errors };
  const m = checked.manifest;
  if (BUILTIN_THEMES.includes(m.id)) return { ok: false, errors: [`its id "${m.id}" is a built-in theme's: give it your own`] };
  return { ok: true, manifest: { id: m.id, name: m.name, version: m.version, description: m.description ?? '' } };
}

/** A version's parts, for ordering ("1.10.0" after "1.9.3"). */
export function versionParts(version: string): [number, number, number] {
  const [a, b, c] = version.split('.').map(Number);
  return [a, b, c];
}

export function compareVersions(x: string, y: string): number {
  const a = versionParts(x);
  const b = versionParts(y);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
