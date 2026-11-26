// npm run theme:check <folder>: a theme folder checked as Margin checks an import, a theme loaded unpacked and each save
// in its folder (docs/THEME-STORE.md §1): the package's caps and file kinds, the sanitizer, an id that isn't a
// built-in's, and the parts that let someone switch away from it (ui/theme-import.ts checkImport, the app's own code).
// What Margin would remove when it loads it is listed (not fatal, as for any load), and motion that may not be
// smooth. Exits 1 when Margin wouldn't use it.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageFromFiles, checkImport } from '../app/shared/ui/theme-import.ts';
import { folderFiles } from './theme-folder.ts';
import { motionAdvice, motionNotes } from './theme-motion.ts';

export type ThemeCheck = {
  ok: boolean,
  errors: string[],
  removed: string[],
  left: string[],
  motion: ReturnType<typeof motionNotes>,
  manifest: { id: string, name: string, version: string, author: string } | null,
};

/** The folder checked as Margin checks it. */
export function checkTheme(dir: string): ThemeCheck {
  let read;
  try { read = folderFiles(dir); } catch (err) {
    return { ok: false, errors: [(err as Error).message], removed: [], left: [], motion: [], manifest: null };
  }
  const pkg = packageFromFiles(read.files);
  if (!pkg.ok) return { ok: false, errors: pkg.errors, removed: [], left: read.left, motion: [], manifest: null };
  const checked = checkImport(pkg.pkg);
  return { ok: checked.ok, errors: checked.errors, removed: checked.removed, left: read.left, motion: motionNotes(pkg.pkg.css), manifest: checked.manifest };
}

/** Whether this module is the command Node was given (its real path: macOS's temporary folders are behind a link). */
function isCommand(url: string) {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url)); } catch { return false; }
}

if (isCommand(import.meta.url)) {
  const [dirArg] = process.argv.slice(2);
  if (!dirArg) { console.error('npm run theme:check <theme folder>'); process.exit(2); }
  const result = checkTheme(resolve(dirArg));
  if (result.ok && result.manifest) console.log(`ok: “${result.manifest.name}” ${result.manifest.id} ${result.manifest.version}: Margin would use it`);
  else console.error(`Margin wouldn’t use it:\n${result.errors.map((e) => `  ${e}`).join('\n')}`);
  if (result.removed.length) console.log(`Margin removes when it loads it: ${result.removed.join('; ')}`);
  if (result.left.length) console.log(`left out (not part of a theme package): ${result.left.join(', ')}`);
  if (result.motion.length) console.log(`Motion that may not be smooth:\n${motionAdvice(result.motion).join('\n')}`);
  process.exit(result.ok ? 0 : 1);
}
