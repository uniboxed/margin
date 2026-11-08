// Every site of a top-sites list (Tranco's), one by one, through Margin's page box: the real
// extension (the e2e harness's test build, Safari's profile) in headless Chromium, linked to the
// stand-in Margin.app, its overlay drawn over a full-screen window, so each site is shrunk into the
// theme's slot as in Safari. Each site is loaded twice at the same time: through Margin, and in a
// plain headless Chromium at the slot's size (no extension), and the two are compared. The plain
// load says what the site is like by itself, so a site that's down, or only an API host, or that
// throws errors of its own, isn't taken for Margin's doing.
//
//   node tools/fit-check/check.mjs --out some/folder [--list tools/fit-check/data/list.csv] [--workers 3]
//     [--until 2026-11-09T07:30] [--commit <sha>]
//   node tools/fit-check/summarize.mjs --out some/folder
//
// Run every night, it's started by nightly.mjs (`npm run fit-check`), which keeps a round per --out folder.
// --until: no new site is started after it (the ones under way finish). --commit: Margin's code tested,
// written in each row.
//
// What's stored, in --out:
// - results.jsonl: a line per site, as it's done (the run resumes from it: a site there isn't
//   loaded again, unless it ended in a crawler error: then it's tried again, up to ERROR_TRIES).
//   See `visit` below for its fields.
// - shots/<rank>-<domain>-margin.jpg and -plain.jpg: what each load looked like, for a site with
//   anything flagged, and every 100th site (a sample of the good ones).
// - progress.json: counts so far, the rate, when it should be done. log.txt: what the run did.
// - finished.txt: once every site of the list is done (not when --until stopped it).
//
// It doesn't stop for a site: each load has a hard deadline, a site that hangs its browser gets
// its Margin world made again, a world that won't start is retried with a pause, anything thrown
// is written down and the next site goes on. Headless only: nothing is shown on screen, sound is
// muted, notifications and permission prompts are refused, dialogs dismissed, pages a site opens
// closed. Domains with an adult word in them are skipped (written down as skipped).
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMargin } from '../../tests/e2e/harness/margin.js';
import { SPACES } from '../../tests/e2e/harness/seed.js';
import { ERROR_TRIES, KEY, isBlocked } from './verdicts.mjs';
import { pageBox, slot as slotOf } from '../../tests/e2e/harness/ui.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

// ---- options ----------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const expand = (p) => resolve(p.replace(/^~(?=\/|$)/, homedir()));
const LIST = expand(opt('list', fileURLToPath(new URL('./data/list.csv', import.meta.url))));
if (!opt('out', null)) { console.error('--out: the folder for the results (npm run fit-check keeps them in tools/fit-check/data)'); process.exit(2); }
const OUT = expand(opt('out', ''));
const WORKERS = Math.max(1, Math.min(6, Number(opt('workers', '3')) || 3));
const LIMIT = Number(opt('limit', '0')) || 0; // (a trial: only the first N)
const UNTIL = opt('until', null) ? new Date(opt('until', '')).getTime() : Infinity;
if (Number.isNaN(UNTIL)) throw new Error(`--until: not a time: ${opt('until', '')}`);
const COMMIT = opt('commit', null);
const NAV_MS = 30_000; // the first answer and the DOM
const LOAD_MS = 12_000; // then the load event, at most
const SETTLE_MS = 2_000; // then a moment for late content
const SITE_MS = 90_000; // a whole site, both loads, at most
const WORLD_SITES = 150; // a fresh Margin world after this many (its profile grows)
const SHOT_EVERY = 100;
const ADULT = /(porn|xxx|xvideo|xnxx|xhamster|sex|nude|naked|hentai|onlyfans|camgirl|chaturbate|stripchat|livejasmin|bongacams|brazzers|redtube|youporn|spankbang|erotic|fetish|milf|escort|adult)/i;

mkdirSync(join(OUT, 'shots'), { recursive: true });
const RESULTS = join(OUT, 'results.jsonl');
const LOG = join(OUT, 'log.txt');
const log = (line) => { const s = `${new Date().toISOString()} ${line}`; appendFileSync(LOG, `${s}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A promise with a deadline: rejects with `what` once it's past.
const within = (ms, what, p) => {
  let timer;
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout: ${what} (${ms} ms)`)), ms); })]).finally(() => clearTimeout(timer));
};
const short = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 300);

process.on('unhandledRejection', (e) => log(`unhandled rejection: ${short(e)}`));
process.on('uncaughtException', (e) => log(`uncaught exception: ${short(e)}`));

// ---- the list, and what's done ------------------------------------------------------------------
const sites = readFileSync(LIST, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
  .map((l) => { const [rank, domain] = l.split(','); return { rank: Number(rank), domain: String(domain ?? '').trim().toLowerCase() }; })
  .filter((s) => s.rank > 0 && /^[a-z0-9.-]+$/.test(s.domain));
// A site's last line is what it came to; a crawler error (its own trouble, not the site's) is tried again.
const last = new Map();
const errorsOf = new Map();
if (existsSync(RESULTS)) for (const l of readFileSync(RESULTS, 'utf8').split('\n')) {
  try {
    const r = JSON.parse(l);
    last.set(r.domain, r.verdict);
    if (r.verdict === 'error') errorsOf.set(r.domain, (errorsOf.get(r.domain) ?? 0) + 1);
  } catch {}
}
const doneNow = (d) => last.has(d) && (last.get(d) !== 'error' || (errorsOf.get(d) ?? 0) >= ERROR_TRIES);
const done = new Set([...last.keys()].filter(doneNow));
const queue = sites.filter((s) => !done.has(s.domain)).slice(0, LIMIT || undefined);
const counts = { done: done.size, ok: 0, flagged: 0, marginFailed: 0, blocked: 0, plainFailed: 0, skipped: 0, errors: 0 };
for (const d of done) counts[KEY[last.get(d)] ?? 'errors'] += 1;
const startedAt = Date.now();
let doneThisRun = 0;
const writeProgress = () => {
  const rate = doneThisRun / Math.max(1, (Date.now() - startedAt) / 60000);
  const left = sites.length - counts.done;
  writeFileSync(join(OUT, 'progress.json'), JSON.stringify({ ...counts, total: sites.length, left, perMinute: Math.round(rate * 10) / 10, etaHours: rate ? Math.round((left / rate / 60) * 10) / 10 : null, updatedAt: new Date().toISOString(), workers: WORKERS, pid: process.pid }, null, 2));
};
const record = (r) => {
  appendFileSync(RESULTS, `${JSON.stringify(r)}\n`);
  if (r.verdict === 'error') errorsOf.set(r.domain, (errorsOf.get(r.domain) ?? 0) + 1);
  last.set(r.domain, r.verdict);
  doneThisRun += 1;
  // Counted once it's what the site comes to (an error to be tried again isn't, yet).
  if (doneNow(r.domain)) { counts.done += 1; counts[KEY[r.verdict] ?? 'errors'] += 1; }
  if (doneThisRun % 10 === 0) writeProgress();
};

// ---- what a page is like ----------------------------------------------------------------------
// Run in the page (both loads alike; in Margin's, the page's own idea of its size: Margin's shims).
const MEASURE = () => {
  const de = document.documentElement;
  const body = document.body;
  const vw = innerWidth;
  const vh = innerHeight;
  const se = document.scrollingElement || de;
  const scrollW = Math.max(se.scrollWidth, body ? body.scrollWidth : 0);
  let visible = 0;
  let cut = 0;
  let cutRight = 0;
  const els = document.querySelectorAll('img,video,canvas,svg,iframe,p,h1,h2,h3,h4,a,button,input,li,nav,header');
  for (let i = 0; i < els.length && i < 4000; i++) {
    const el = els[i];
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > vh) continue; // the first screen only
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) continue;
    visible += 1;
    if (r.left < -2 || r.right > vw + 2) cut += 1;
    if (r.right > vw + 2) cutRight += 1;
  }
  const imgs = [...document.images];
  return {
    vw, vh, scrollW, overflowX: Math.max(0, scrollW - vw),
    text: (body?.innerText || '').length,
    visible, cut, cutRight,
    images: imgs.length,
    brokenImages: imgs.filter((i) => i.complete && i.naturalWidth === 0 && i.currentSrc).length,
    iframes: document.querySelectorAll('iframe').length,
    hasTitle: !!document.title,
    ready: document.readyState,
    bodyHeight: body ? Math.round(body.getBoundingClientRect().height) : 0,
  };
};

// One load of `url` in `page`: what came back, how long, what the page is like, its errors.
async function load(page, url) {
  const errors = [];
  const onError = (e) => { if (errors.length < 20) errors.push(short(e)); };
  page.on('pageerror', onError);
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  const t0 = Date.now();
  const out = { ok: false, status: null, finalHost: null, ms: null, error: null, errors, m: null };
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_MS });
    out.status = res?.status() ?? null;
    await page.waitForLoadState('load', { timeout: LOAD_MS }).catch(() => {});
    await sleep(SETTLE_MS);
    out.ms = Date.now() - t0;
    out.finalHost = (() => { try { return new URL(page.url()).hostname; } catch { return null; } })();
    out.m = await within(8000, 'measure', page.evaluate(MEASURE));
    out.ok = !!out.m && (out.status == null || out.status < 400);
  } catch (e) {
    out.error = short(e);
    out.ms = Date.now() - t0;
  }
  return out;
}

// ---- comparing what the two looked like (a separate page decodes the pictures) -----------------
// The plain Chromium: one per world, made and ended with it, so a stuck one (connected but not answering, as
// one was after ~3 500 sites) takes only its own worker's site with it, and only once.
// Launched as the harness launches Margin's (Chrome's new headless mode), so the two browsers are alike in what
// they tell sites (a first visit to Google came back dark in one and light in the other).
// Each tagged (a switch Chromium ignores), so one that won't close is found and ended by it.
let plains = 0;
async function plainBrowser() {
  const tag = `margin-fit-check-plain=${process.pid}x${++plains}x`; // (x…x: the 1st isn't found in the 10th's)
  const browser = await within(60_000, 'plain browser start', chromium.launch({ headless: false, args: ['--headless=new', '--mute-audio', '--disable-notifications', '--deny-permission-prompts', `--${tag}`] }));
  return Object.assign(browser, { tag });
}
async function compare(world, a, b) {
  if (!a || !b) return null;
  world.composer ??= await within(10_000, 'composer', world.plain.newContext().then((c) => c.newPage()));
  return within(10_000, 'compare', world.composer.evaluate(async ([x, y]) => {
    const grid = async (b64) => {
      const img = new Image();
      img.src = `data:image/jpeg;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = 48; c.height = 30;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, 48, 30);
      const d = g.getImageData(0, 0, 48, 30).data;
      const lum = [];
      for (let i = 0; i < d.length; i += 4) lum.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
      return lum;
    };
    const [p, q] = await Promise.all([grid(x), grid(y)]);
    const mean = (v) => v.reduce((s, n) => s + n, 0) / v.length;
    const sd = (v) => { const m = mean(v); return Math.sqrt(mean(v.map((n) => (n - m) ** 2))); };
    let diff = 0;
    for (let i = 0; i < p.length; i++) diff += Math.abs(p[i] - q[i]);
    return { diff: Math.round(diff / p.length * 10) / 10, sdMargin: Math.round(sd(p) * 10) / 10, sdPlain: Math.round(sd(q) * 10) / 10 };
  }, [a.toString('base64'), b.toString('base64')]));
}

// ---- a Margin world per worker ----------------------------------------------------------------
async function newWorld(w) {
  for (let attempt = 1; ; attempt++) {
    try {
      const m = await within(120_000, 'Margin world start', startMargin({ name: `fit-check-${w}`, web: true, seed: { spaces: SPACES, settings: { sidebarPinnedOpen: true } } }));
      const ui = await m.ui();
      const s = await within(10_000, 'the slot', m.until(() => slotOf(ui), { timeout: 8000, what: 'the slot' }));
      // The plain load in the same color scheme as Margin's browser (a dark page and a light one aren't a difference of Margin's).
      const scheme = await within(5000, 'scheme', m.context.pages()[0].evaluate(() => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))).catch(() => 'light');
      const ours = new Set(m.context.pages());
      // Pages a site opens by itself (pop-ups, new windows): closed.
      m.context.on('page', (p) => { setTimeout(() => { if (!ours.has(p) && !p.isClosed()) p.close().catch(() => {}); }, 1500); });
      const plain = await plainBrowser().catch(async (e) => { await within(30_000, 'Margin world close', m.close()).catch(() => {}); throw e; });
      log(`worker ${w}: Margin world up (slot ${JSON.stringify(s)}, ${scheme})`);
      return { m, plain, composer: null, slot: s, ours, scheme, sites: 0 };
    } catch (e) {
      log(`worker ${w}: Margin world didn't start (attempt ${attempt}): ${short(e)}`);
      await sleep(Math.min(60_000, 5000 * attempt));
    }
  }
}
async function endWorld(world) {
  if (!world) return;
  await within(30_000, 'Margin world close', world.m.close()).catch(() => {});
  const closed = await within(15_000, 'plain browser close', world.plain.close()).then(() => true, () => false);
  // Still there (not answering): its processes ended outright.
  if (!closed) await new Promise((r) => execFile('pkill', ['-9', '-f', world.plain.tag], () => r()));
}

async function visit(world, site) {
  const url = `https://${site.domain}/`;
  const { m, slot } = world;
  const width = 1440 - slot.left - slot.right;
  const height = 900 - slot.top - slot.bottom;
  const page = await m.context.newPage();
  world.ours.add(page);
  const plainCtx = await within(15_000, 'plain context', world.plain.newContext({ viewport: { width, height }, colorScheme: world.scheme, acceptDownloads: false }));
  const plain = await plainCtx.newPage();
  try {
    const [mine, theirs] = await Promise.all([load(page, url), load(plain, url)]);
    let box = null;
    let rootX = null;
    if (mine.ok) {
      box = await within(5000, 'box', pageBox(page)).catch(() => null);
      rootX = await within(5000, 'root', page.locator('html').boundingBox()).then((b) => (b ? Math.round(b.x) : null)).catch(() => null);
    }
    const shotMine = mine.ok ? await within(15_000, 'shot', page.screenshot({ type: 'jpeg', quality: 55, clip: { x: slot.left, y: slot.top, width, height } })).catch(() => null) : null;
    const shotPlain = theirs.ok ? await within(15_000, 'shot', plain.screenshot({ type: 'jpeg', quality: 55 })).catch(() => null) : null;
    const look = await compare(world, shotMine, shotPlain).catch(() => null);
    // What's wrong, if anything (only what the plain load doesn't show too).
    const flags = [];
    if (mine.ok && theirs.ok) {
      const a = mine.m;
      const b = theirs.m;
      if (!box || Math.abs(box.left - slot.left) > 1 || Math.abs(box.right - slot.right) > 1) flags.push('no-box');
      if (rootX != null && Math.abs(rootX - slot.left) > 1) flags.push('drawn-off-slot');
      if (a.vw !== width) flags.push('wrong-width');
      if (a.overflowX > 16 && b.overflowX <= 16) flags.push('sideways-overflow');
      if (a.cut - b.cut > 3) flags.push('content-cut-off');
      if (b.text > 300 && a.text < b.text * 0.5) flags.push('text-missing');
      if (b.visible > 10 && a.visible < b.visible * 0.5) flags.push('elements-missing');
      if (look && look.sdMargin < 4 && look.sdPlain > 12) flags.push('blank');
      if (look && look.diff > 40) flags.push('looks-different');
      const theirErrors = new Set(theirs.errors);
      const newErrors = mine.errors.filter((e) => !theirErrors.has(e));
      if (newErrors.length > theirs.errors.length && newErrors.length >= 2) flags.push('more-errors');
    }
    const verdict = isBlocked(theirs) ? 'blocked' : !theirs.ok ? 'plain-failed' : !mine.ok ? 'margin-failed' : flags.length ? 'flagged' : 'ok';
    const keepShots = verdict === 'flagged' || verdict === 'margin-failed' || site.rank % SHOT_EVERY === 0;
    if (keepShots) {
      const base = join(OUT, 'shots', `${site.rank}-${site.domain}`);
      if (shotMine) writeFileSync(`${base}-margin.jpg`, shotMine);
      if (shotPlain) writeFileSync(`${base}-plain.jpg`, shotPlain);
    }
    return {
      rank: site.rank, domain: site.domain, verdict, flags, at: new Date().toISOString(), commit: COMMIT,
      margin: { ok: mine.ok, status: mine.status, ms: mine.ms, error: mine.error, finalHost: mine.finalHost, errors: mine.errors, m: mine.m, box, rootX },
      plain: { ok: theirs.ok, status: theirs.status, ms: theirs.ms, error: theirs.error, finalHost: theirs.finalHost, errors: theirs.errors, m: theirs.m },
      slot: { left: slot.left, top: slot.top, right: slot.right, bottom: slot.bottom, width, height },
      look, shots: keepShots,
    };
  } finally {
    await within(10_000, 'close', page.close()).catch(() => {});
    await within(10_000, 'close', plainCtx.close()).catch(() => {});
  }
}

// ---- the workers --------------------------------------------------------------------------------
let next = 0;
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; log(`${sig}: stopping after the sites under way`); });

async function worker(w) {
  let world = null;
  while (!stopping) {
    const site = queue[next++];
    if (!site) break;
    if (Date.now() >= UNTIL) { if (!stopping) log(`--until reached: stopping after the sites under way`); stopping = true; next -= 1; break; }
    if (ADULT.test(site.domain)) { record({ rank: site.rank, domain: site.domain, verdict: 'skipped', flags: ['adult-word'], at: new Date().toISOString(), commit: COMMIT }); continue; }
    if (!world || world.sites >= WORLD_SITES) { await endWorld(world); world = await newWorld(w); }
    world.sites += 1;
    try {
      record(await within(SITE_MS, `site ${site.domain}`, visit(world, site)));
    } catch (e) {
      // Hung or broken: written down, and the world made again (the browser may be stuck).
      record({ rank: site.rank, domain: site.domain, verdict: 'error', flags: ['crawler-error'], error: short(e), at: new Date().toISOString(), commit: COMMIT });
      log(`worker ${w}: ${site.rank} ${site.domain}: ${short(e)}; a fresh Margin world`);
      await endWorld(world);
      world = null;
    }
  }
  await endWorld(world);
}

log(`start: ${queue.length} sites to go of ${sites.length} (${done.size} done before), ${WORKERS} workers, out ${OUT}`);
writeProgress();
await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i + 1).catch((e) => log(`worker ${i + 1} ended: ${short(e)}`))));
writeProgress();
log(`end: ${counts.done} of ${sites.length} done`);
// The round's finished once nothing's left to do: every site done, or tried ERROR_TRIES times.
if (!stopping && !LIMIT && sites.every((s) => doneNow(s.domain))) writeFileSync(join(OUT, 'finished.txt'), `${new Date().toISOString()}\n${JSON.stringify(counts)}\n`);
process.exit(0);
