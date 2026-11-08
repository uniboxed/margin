// What a crawl found (tools/site-crawl/crawl.mjs): counts by verdict and by flag, and the sites
// under each flag, best ranked first. Reads --out's results.jsonl; writes summary.json and
// summary.md next to it, and prints the short form.
//
//   node tools/site-crawl/summarize.mjs --out ~/margin-crawl/run
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const i = argv.indexOf('--out');
const OUT = resolve((i >= 0 ? argv[i + 1] : '~/margin-crawl/run').replace(/^~(?=\/|$)/, homedir()));
const rows = [];
for (const line of readFileSync(join(OUT, 'results.jsonl'), 'utf8').split('\n')) { try { rows.push(JSON.parse(line)); } catch {} }
rows.sort((a, b) => a.rank - b.rank);

const by = (key) => rows.reduce((acc, r) => { for (const k of [].concat(key(r))) (acc[k] ??= []).push(r); return acc; }, {});
const verdicts = by((r) => r.verdict);
const flags = by((r) => (r.verdict === 'flagged' ? r.flags : []));
const marginErrors = by((r) => (r.verdict === 'margin-failed' ? (r.margin?.error ?? 'unknown').replace(/https?:\/\/\S+/g, '<url>').slice(0, 80) : []));
const loaded = rows.filter((r) => r.margin?.ok && r.plain?.ok);
const avg = (list, f) => (list.length ? Math.round(list.reduce((s, r) => s + f(r), 0) / list.length) : null);

const summary = {
  total: rows.length,
  verdicts: Object.fromEntries(Object.entries(verdicts).map(([k, v]) => [k, v.length])),
  flags: Object.fromEntries(Object.entries(flags).sort((a, b) => b[1].length - a[1].length).map(([k, v]) => [k, v.length])),
  marginFailedBy: Object.fromEntries(Object.entries(marginErrors).sort((a, b) => b[1].length - a[1].length).map(([k, v]) => [k, v.length])),
  loadMs: { margin: avg(loaded, (r) => r.margin.ms), plain: avg(loaded, (r) => r.plain.ms) },
  sites: Object.fromEntries(Object.entries(flags).map(([k, v]) => [k, v.slice(0, 200).map((r) => `${r.rank} ${r.domain}`)])),
  marginFailed: (verdicts['margin-failed'] ?? []).slice(0, 300).map((r) => `${r.rank} ${r.domain}: ${r.margin?.error ?? ''}`),
};
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));

const md = [
  `# Site crawl: ${rows.length} sites`, '',
  '## Verdicts', ...Object.entries(summary.verdicts).map(([k, v]) => `- ${k}: ${v}`), '',
  '## Flags (sites that loaded both ways)', ...Object.entries(summary.flags).map(([k, v]) => `- ${k}: ${v}`), '',
  `Average load: through Margin ${summary.loadMs.margin} ms, plain ${summary.loadMs.plain} ms.`, '',
  '## Loaded plain but not through Margin', ...summary.marginFailed.slice(0, 100).map((s) => `- ${s}`), '',
  ...Object.entries(summary.sites).flatMap(([k, v]) => [`## ${k}`, ...v.slice(0, 60).map((s) => `- ${s}`), '']),
].join('\n');
writeFileSync(join(OUT, 'summary.md'), md);
console.log(md.split('\n').slice(0, 30).join('\n'));
