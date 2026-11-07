// The packages the security suite checks (npm run test:security): every
// built-in theme, and any named in MARGIN_THEMES (colon-separated folders,
// so a theme can be checked before it's shared:
// `MARGIN_THEMES=~/my-theme npm run test:security`).
import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_THEMES } from '../../extension/themes/packages.js';
import { readTheme } from '../theme/package.js';

const THEMES = fileURLToPath(new URL('../../extension/themes/', import.meta.url));
const TEXTS = new Set(['theme.json', 'theme.html', 'theme.css']);

/** A user's folder as Margin reads one: every regular file but the three, two levels deep at most, links refused. */
export function readFolder(dir) {
  const files = {};
  const walk = (sub, depth) => {
    for (const name of readdirSync(join(dir, sub))) {
      if (name === '.DS_Store') continue;
      const rel = sub ? `${sub}/${name}` : name;
      const st = lstatSync(join(dir, rel));
      if (st.isSymbolicLink()) throw new Error(`${rel}: a link (refused)`);
      if (st.isDirectory()) { if (depth >= 2) throw new Error(`${rel}: deeper than two folders`); walk(rel, depth + 1); }
      else if (st.isFile() && !TEXTS.has(rel)) files[rel] = new Uint8Array(readFileSync(join(dir, rel)));
    }
  };
  walk('', 0);
  const text = (f) => readFileSync(join(dir, f), 'utf8');
  return { manifest: text('theme.json'), html: text('theme.html'), css: text('theme.css'), files };
}

/**
 * @returns {{ label: string, builtin: boolean, id: string | null, dir: string | null, read: () => { manifest: string, html: string, css: string, files: Record<string, Uint8Array> } }[]}
 */
export function suitePackages(env = process.env.MARGIN_THEMES) {
  const out = PACKAGE_THEMES.map((id) => ({
    label: `built-in ${id}`, builtin: true, id, dir: join(THEMES, id),
    read: () => { const t = readTheme(join(THEMES, id)); return { ...t, files: Object.fromEntries(Object.entries(t.files).map(([k, v]) => [k, new Uint8Array(v)])) }; },
  }));
  for (const raw of (env ?? '').split(':').map((s) => s.trim()).filter(Boolean)) {
    const path = resolve(raw.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
    if (!existsSync(path)) throw new Error(`MARGIN_THEMES: ${raw} doesn't exist`);
    out.push({ label: `MARGIN_THEMES ${raw}`, builtin: false, id: null, dir: path, read: () => readFolder(path) });
  }
  return out;
}
