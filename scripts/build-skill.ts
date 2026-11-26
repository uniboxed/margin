// npm run skill:build [out]: the margin-theme skill (docs/THEME-STORE.md §6) as a folder anyone can give their own
// Claude (Claude Code: ~/.claude/skills/margin-theme), assembled from the one copy of each part in the repo:
//   SKILL.md                    skills/margin-theme/SKILL.md
//   reference/README.md         the theme guide, app/shared/ui/themes/README.md
//   template/                   Neubrutalism (it uses every binding, behaviour and part) under the id `my-theme`
//   scripts/check-theme.mjs     scripts/check-theme.ts bundled for Node alone: Margin's own import check
// Written to dist/skills/margin-theme by default (dist/ isn't committed).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATE_ID = 'my-theme';

/** The skill's folder at `out` (made afresh). */
export function buildSkill(out: string) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'reference'), { recursive: true });
  mkdirSync(join(out, 'scripts'), { recursive: true });
  cpSync(join(ROOT, 'skills/margin-theme/SKILL.md'), join(out, 'SKILL.md'));
  cpSync(join(ROOT, 'app/shared/ui/themes/README.md'), join(out, 'reference/README.md'));
  // The template: Neubrutalism's folder, its theme.json made a person's own (an id, a name, a first version).
  const template = join(out, 'template');
  cpSync(join(ROOT, 'app/shared/ui/themes/neubrutalism'), template, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(template, 'theme.json'), 'utf8'));
  Object.assign(manifest, { id: TEMPLATE_ID, name: 'My Theme', author: 'Your Name', version: '0.1.0' });
  writeFileSync(join(template, 'theme.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  // The checker: the app's own code, one file, Node's built-ins only.
  buildSync({
    entryPoints: [join(ROOT, 'scripts/check-theme.ts')],
    outfile: join(out, 'scripts/check-theme.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent',
    banner: { js: '// Margin\'s theme check (scripts/check-theme.ts), bundled: node check-theme.mjs <theme folder>' },
  });
  return out;
}

/** Whether this module is the command Node was given (its real path: macOS's temporary folders are behind a link). */
function isCommand(url: string) {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url)); } catch { return false; }
}

if (isCommand(import.meta.url)) {
  const out = resolve(process.argv[2] ?? join(ROOT, 'dist/skills/margin-theme'));
  buildSkill(out);
  console.log(`${out}: the margin-theme skill (SKILL.md, reference/, template/, scripts/check-theme.mjs)`);
}
