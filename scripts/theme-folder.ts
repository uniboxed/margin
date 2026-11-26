// A theme folder's package files, read as `theme:pack` and `theme:check` read it (theme.json, theme.html, theme.css,
// fonts, images and notes; anything else left out and said; links refused; two folders deep at most). Its own module,
// with no command of its own, so the checker can be bundled without the packer (scripts/build-skill.ts).
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { IMPORT_LIMITS } from '../app/shared/ui/theme-import.ts';

const KEEP = /^(theme\.(json|html|css)|.+\.(woff2|png|jpe?g|gif|webp|avif|svg|txt|md))$/i;

/** The folder's package files (path → bytes), and what was left out. */
export function folderFiles(dir: string) {
  const files: Record<string, Uint8Array> = {};
  const left: string[] = [];
  const walk = (sub: string, depth: number) => {
    for (const name of readdirSync(join(dir, sub)).sort()) {
      if (name === '.DS_Store') continue;
      const rel = sub ? `${sub}/${name}` : name;
      const st = lstatSync(join(dir, rel));
      if (st.isSymbolicLink()) throw new Error(`${rel} is a link: Margin takes none`);
      if (st.isDirectory()) {
        if (name.startsWith('.')) { left.push(`${rel}/`); continue; }
        if (depth >= IMPORT_LIMITS.depth) throw new Error(`${rel}: more than ${IMPORT_LIMITS.depth} folders deep`);
        walk(rel, depth + 1);
      } else if (st.isFile()) {
        if (KEEP.test(name) && !name.startsWith('.') && (sub || /^theme\.|\.(txt|md)$/i.test(name))) files[rel] = new Uint8Array(readFileSync(join(dir, rel)));
        else left.push(rel);
      }
    }
  };
  walk('', 0);
  return { files, left };
}
