#!/usr/bin/env node
// A release's notes, from the Conventional Commits since the previous tag (the release workflow:
// .github/workflows/release.yml). Features, fixes and speed first; the rest counted, not listed.
//   node scripts/release-notes.mjs v0.2.0 > notes.md
import { execFileSync } from 'node:child_process';

const tag = process.argv[2];
if (!tag) { console.error('usage: node scripts/release-notes.mjs <tag>'); process.exit(2); }
const git = (...args) => { try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const previous = git('describe', '--tags', '--abbrev=0', `${tag}^`);
const range = previous ? `${previous}..${tag}` : tag;
// Each commit's subject, merges left out (their branches' commits are listed themselves).
const subjects = git('log', '--no-merges', '--format=%s', range).split('\n').filter(Boolean);

const SECTIONS = [['feat', 'New'], ['fix', 'Fixed'], ['perf', 'Faster']];
const parse = (s) => /^(\w+)(?:\(([^)]+)\))?(!)?: (.+)$/.exec(s);
const out = [`## Margin ${tag.replace(/^v/, '')}`, ''];
let rest = 0;
for (const [type, title] of SECTIONS) {
  const items = subjects.map(parse).filter((m) => m && m[1] === type);
  if (!items.length) continue;
  out.push(`### ${title}`, '');
  for (const [, , scope, breaking, text] of items) out.push(`- ${breaking ? '**Breaking:** ' : ''}${scope ? `**${scope}:** ` : ''}${text}`);
  out.push('');
}
for (const s of subjects) { const m = parse(s); if (!m || !SECTIONS.some(([t]) => t === m[1])) rest += 1; }
if (rest) out.push(`Also ${rest} other change${rest === 1 ? '' : 's'} (refactoring, tests, docs, build).`, '');
out.push(previous ? `Everything since ${previous}: \`git log ${previous}..${tag}\`.` : 'The first release.');
console.log(out.join('\n'));
