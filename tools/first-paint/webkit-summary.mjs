// Reads the WebKit host's output of fp-* scenarios (tools/webkit-host
// scenarios.mjs) and judges each page as chromium.mjs does (pages.mjs judge),
// with WebKit's own paint milestone: the first visually non-empty layout
// (host.swift renderingProgressDidChange, bit 2), after which WebKit draws at
// its next rendering update. `afterMilestone`: the probe's first frame came
// after it, so that frame is the first one drawn.
// Usage: node tools/first-paint/webkit-summary.mjs <run.sh output>...
import { readFileSync } from 'node:fs';
import { judge } from './pages.mjs';

const VW = 1200;
const VH = 800;
const rows = new Map();
for (const file of process.argv.slice(2)) {
  let scenario = null;
  const paints = new Map(); // tab → wall-clock ms of its first visually non-empty layout
  const pages = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const name = /^=== (\S+)/.exec(line);
    if (name) scenario = name[1];
    const paint = /\] paint (\w+) events (\d+) at ([\d.]+)/.exec(line);
    if (paint && Number(paint[2]) & 2 && !paints.has(paint[1])) paints.set(paint[1], Number(paint[3]));
    const page = /\] page (\w+): FP (\{.*\})$/.exec(line);
    if (page) pages.push([page[1], JSON.parse(page[2])]);
  }
  for (const [tab, { layout, fp, head }] of pages) {
    const result = judge({ ...fp, head }, layout, VW, VH);
    const frames = (fp?.frames ?? []).filter((f) => f.kind === 'frame');
    const painted = paints.has(tab) ? paints.get(tab) - fp.origin : null;
    const key = `${scenario.replace(/^fp-/, '')} · ${tab.startsWith('H') ? 'heavy' : 'light'}`;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push({ ...result, painted, afterMilestone: painted != null && !!frames[0] && frames[0].t >= painted - 1 });
  }
}
const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? Math.round(s[Math.floor(s.length / 2)]) : null; };
for (const [key, list] of rows) {
  const count = (f) => list.filter(f).length;
  console.log(JSON.stringify({
    key, n: list.length,
    firstFrameOk: count((r) => r.firstOk), noMove: count((r) => r.moves === 0), endOk: count((r) => r.lastOk), afterMilestone: count((r) => r.afterMilestone),
    pageStartVars: count((r) => r.pageStart?.vars), pageStartOk: count((r) => r.pageStartOk), headOk: count((r) => r.headOk),
    ownAtHead: count((r) => r.ownAtHead), ownAtFirst: count((r) => r.ownAtFirst), selfFixed: count((r) => r.selfAt != null),
    ms: { milestone: median(list.map((r) => r.painted)), firstFrame: median(list.map((r) => r.firstFrameAt)), self: median(list.map((r) => r.selfAt)), own: median(list.map((r) => r.ownAt)), box: median(list.map((r) => r.boxAt)), ok: median(list.map((r) => r.okAt)) },
    bad: list.filter((r) => !r.firstOk || r.moves).slice(0, 2).map((r) => ({ first: r.first, okFrom: r.okFrom, moves: r.moves, pageStart: r.pageStart })),
  }));
}
