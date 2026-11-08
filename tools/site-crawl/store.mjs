// The crawl's data folder, made readable: from each round's raw results (rounds/NNNN/results.jsonl, written
// by crawl.mjs as it goes) it writes
// - sites/<domain>.json: that site's latest result in full, and its history (a line per round: verdict,
//   flags, Margin's commit, load times, its pictures), and whether it changed since the round before;
// - all-sites.csv: a row per site, its latest (opens in Numbers or a spreadsheet);
// - summary.md and summary.json: the latest of every site counted, and what got worse or better since the
//   round before.
// It's all made again from the rounds' results, every time, so it can't drift from them.
//
//   node tools/site-crawl/store.mjs [--data tools/site-crawl/data]
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERDICTS, verdictOf } from './verdicts.mjs';

export const DEFAULT_DATA = join(dirname(fileURLToPath(import.meta.url)), 'data');
export const roundName = (n) => String(n).padStart(4, '0');
export const roundsOf = (data) => {
  const dir = join(data, 'rounds');
  return existsSync(dir) ? readdirSync(dir).filter((d) => /^\d{4}$/.test(d)).map(Number).sort((a, b) => a - b) : [];
};

// Written whole or not at all (a reader never sees half a file).
export const writeAtomic = (file, text) => { writeFileSync(`${file}.tmp`, text); renameSync(`${file}.tmp`, file); };

// Each round's last line per site (the crawl writes a site again when it retries a crawler error).
export function readRound(data, round) {
  const file = join(data, 'rounds', roundName(round), 'results.jsonl');
  const rows = new Map();
  if (!existsSync(file)) return rows;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    try { const r = JSON.parse(line); rows.set(r.domain, { ...r, verdict: verdictOf(r) }); } catch {}
  }
  return rows;
}

// Better or worse, for Margin: only these three say anything about it (a blocked or down site says nothing).
const SCORE = { ok: 2, flagged: 1, 'margin-failed': 0 };
const csv = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function rebuild(data = DEFAULT_DATA) {
  const rounds = roundsOf(data);
  const sites = new Map(); // domain → { rank, history: [row per round] }
  for (const round of rounds) {
    for (const [domain, r] of readRound(data, round)) {
      const site = sites.get(domain) ?? { rank: r.rank, history: [] };
      site.rank = r.rank;
      site.history.push({ ...r, round });
      sites.set(domain, site);
    }
  }
  mkdirSync(join(data, 'sites'), { recursive: true });
  const latestRound = rounds.at(-1) ?? null;
  const table = [];
  const changes = { worse: [], better: [] };
  for (const [domain, site] of sites) {
    const latest = site.history.at(-1);
    const before = site.history.at(-2) ?? null;
    const shots = (r) => {
      if (!r.shots) return null;
      const base = `rounds/${roundName(r.round)}/shots/${r.rank}-${domain}`;
      return { margin: existsSync(join(data, `${base}-margin.jpg`)) ? `${base}-margin.jpg` : null, plain: existsSync(join(data, `${base}-plain.jpg`)) ? `${base}-plain.jpg` : null };
    };
    let change = null;
    if (before && before.verdict !== latest.verdict) {
      change = { from: before.verdict, to: latest.verdict, round: latest.round };
      if (latest.verdict in SCORE && before.verdict in SCORE) (SCORE[latest.verdict] < SCORE[before.verdict] ? changes.worse : changes.better).push({ rank: site.rank, domain, ...change });
    }
    // The last time its verdict changed, whenever that was (`change` is only since the round before).
    let lastChange = null;
    for (let k = site.history.length - 1; k > 0 && !lastChange; k--) {
      const [a, b] = [site.history[k - 1], site.history[k]];
      if (a.verdict !== b.verdict) lastChange = { from: a.verdict, to: b.verdict, round: b.round, at: b.at, commitBefore: a.commit ?? null, commit: b.commit ?? null };
    }
    const file = {
      domain, rank: site.rank, verdict: latest.verdict, flags: latest.flags ?? [], round: latest.round, at: latest.at, commit: latest.commit ?? null,
      change, lastChange,
      latest: { ...latest, pictures: shots(latest) },
      history: site.history.map((r) => ({
        round: r.round, at: r.at, commit: r.commit ?? null, verdict: r.verdict, flags: r.flags ?? [],
        margin: { status: r.margin?.status ?? null, ms: r.margin?.ms ?? null, error: r.margin?.error ?? null },
        plain: { status: r.plain?.status ?? null, ms: r.plain?.ms ?? null, error: r.plain?.error ?? null },
        look: r.look ?? null, error: r.error ?? null, pictures: shots(r),
      })),
    };
    writeAtomic(join(data, 'sites', `${domain}.json`), `${JSON.stringify(file, null, 2)}\n`);
    table.push({ rank: site.rank, domain, verdict: latest.verdict, flags: (latest.flags ?? []).join(' '), round: latest.round, at: latest.at, commit: latest.commit ?? '', marginMs: latest.margin?.ms ?? '', plainMs: latest.plain?.ms ?? '', status: latest.plain?.status ?? '', before: before?.verdict ?? '' });
  }
  table.sort((a, b) => a.rank - b.rank);
  const cols = ['rank', 'domain', 'verdict', 'flags', 'round', 'at', 'commit', 'marginMs', 'plainMs', 'status', 'before'];
  writeAtomic(join(data, 'all-sites.csv'), `${cols.join(',')}\n${table.map((r) => cols.map((c) => csv(r[c])).join(',')).join('\n')}\n`);

  // The summary: every site's latest.
  const count = (key) => table.reduce((acc, r) => { for (const k of [].concat(key(r))) if (k) acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
  const verdicts = count((r) => r.verdict);
  const flags = count((r) => (r.verdict === 'flagged' ? r.flags.split(' ') : []));
  const list = (v, n = 200) => table.filter((r) => r.verdict === v).slice(0, n).map((r) => `${r.rank} ${r.domain}${r.flags ? ` (${r.flags})` : ''}`);
  // Flagged for something more than a different first screen (that alone is often an ad or an A/B test).
  const flaggedReal = table.filter((r) => r.verdict === 'flagged' && r.flags.split(' ').some((f) => f !== 'looks-different'));
  const byRank = (a, b) => a.rank - b.rank;
  changes.worse.sort(byRank); changes.better.sort(byRank);
  const progress = latestRound ? (() => { try { return JSON.parse(readFileSync(join(data, 'rounds', roundName(latestRound), 'progress.json'), 'utf8')); } catch { return null; } })() : null;
  const finished = latestRound != null && existsSync(join(data, 'rounds', roundName(latestRound), 'finished.txt'));
  const summary = {
    at: new Date().toISOString(), sites: table.length, round: latestRound, roundFinished: finished, roundProgress: progress,
    verdicts: Object.fromEntries(VERDICTS.filter((v) => verdicts[v]).map((v) => [v, verdicts[v]])),
    flags: Object.fromEntries(Object.entries(flags).sort((a, b) => b[1] - a[1])),
    worse: changes.worse.map((c) => `${c.rank} ${c.domain}: ${c.from} → ${c.to} (round ${c.round})`),
    better: changes.better.map((c) => `${c.rank} ${c.domain}: ${c.from} → ${c.to} (round ${c.round})`),
    marginFailed: list('margin-failed', 1000),
    flagged: flaggedReal.slice(0, 1000).map((r) => `${r.rank} ${r.domain} (${r.flags})`),
  };
  writeAtomic(join(data, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const md = [
    `# Site crawl`, '',
    `${table.length} sites, each at its latest. Round ${latestRound ?? '–'}: ${finished ? 'finished' : progress ? `${progress.done} of ${progress.total} done` : 'not started'}. Made ${summary.at}.`, '',
    '## Verdicts', ...Object.entries(summary.verdicts).map(([k, v]) => `- ${k}: ${v}`), '',
    '`blocked`: the site turned the plain browser away too (bot protection, a captcha): it says nothing about Margin.', '',
    '## Flags', ...Object.entries(summary.flags).map(([k, v]) => `- ${k}: ${v}`), '',
    `## Worse since the round before (${summary.worse.length})`, ...summary.worse.slice(0, 200).map((s) => `- ${s}`), '',
    `## Better since the round before (${summary.better.length})`, ...summary.better.slice(0, 200).map((s) => `- ${s}`), '',
    `## Loaded plain but not through Margin (${summary.marginFailed.length})`, ...summary.marginFailed.slice(0, 200).map((s) => `- ${s}`), '',
    `## Flagged for more than looking different (${flaggedReal.length})`, ...summary.flagged.slice(0, 200).map((s) => `- ${s}`), '',
    `Each site in full: sites/<domain>.json. All of them: all-sites.csv.`, '',
  ].join('\n');
  writeAtomic(join(data, 'summary.md'), md);
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--data');
  const data = i >= 0 ? resolve(argv[i + 1].replace(/^~(?=\/|$)/, homedir())) : DEFAULT_DATA;
  const s = rebuild(data);
  console.log(`${s.sites} sites; round ${s.round}${s.roundFinished ? ' finished' : ''}; ${JSON.stringify(s.verdicts)}; worse ${s.worse.length}, better ${s.better.length}`);
}
