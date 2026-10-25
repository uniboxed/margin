// Focus measurement harness: real Chrome (no CDP/Playwright, so no focus
// emulation), a private Xvfb display, OS-level keys via xdotool, and
// in-page probes that POST focus state + keydowns to a local server.
// Usage: node run.mjs <scenario> [<scenario> ...]   (or "all")
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const DIR = new URL('.', import.meta.url).pathname;
const OUT = join(DIR, 'out');
mkdirSync(OUT, { recursive: true });
const DISPLAY = process.env.FOCUS_DISPLAY || ':94';
const CHROME = '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';
const PORT = 8794;
const EXT = { mini: join(DIR, 'mini-ext'), margin: join(DIR, 'margin-ext'), 'margin-fix': join(DIR, 'margin-ext-fix'), 'margin-fix2': join(DIR, 'margin-ext-fix2') };

const SCENARIOS = {
  'fix2-ctrl-t': { ext: 'margin-fix2', trigger: 'ctrl+t' },
  'fix2-ctrl-t-omnibox-first': { ext: 'margin-fix2', trigger: 'ctrl+t', pre: 'omnibox' },
  'fix2-ctrl-n': { ext: 'margin-fix2', trigger: 'ctrl+n' },
  // Margin's real Chrome build, unmodified.
  'margin-ctrl-t':        { ext: 'margin', trigger: 'ctrl+t' },
  'margin-ctrl-n':        { ext: 'margin', trigger: 'ctrl+n' },
  // Scratch copy of Margin with a ~5-line newtab.js change (focus hop), see margin-ext-fix/newtab/newtab.js.
  'marginfix-ctrl-n':     { ext: 'margin-fix', trigger: 'ctrl+n' },
  'margin-ctrl-t-omnibox-first': { ext: 'margin', trigger: 'ctrl+t', pre: 'omnibox' },
  // Minimal replica of Margin's hand-off and the candidate workarounds.
  'mini-margin':          { ext: 'mini', variant: 'margin', trigger: 'ctrl+t' },
  'mini-margin-omnibox-first': { ext: 'mini', variant: 'margin', trigger: 'ctrl+t', pre: 'omnibox' },
  'mini-remove-first':    { ext: 'mini', variant: 'remove-first', trigger: 'ctrl+t' },
  'mini-winfocus':        { ext: 'mini', variant: 'winfocus', trigger: 'ctrl+t' },
  'mini-cs-window-focus': { ext: 'mini', variant: 'cs-window-focus', trigger: 'ctrl+t' },
  'mini-tabsupdate-url':  { ext: 'mini', variant: 'tabsupdate-url', trigger: 'ctrl+t' },
  'mini-location-replace':{ ext: 'mini', variant: 'location-replace', trigger: 'ctrl+t' },
  'mini-ntp-focus-input': { ext: 'mini', variant: 'ntp-focus-input', trigger: 'ctrl+t' },
  'mini-window-focus-ntp':{ ext: 'mini', variant: 'window-focus-ntp', trigger: 'ctrl+t' },
  'mini-location-replace-stay': { ext: 'mini', variant: 'location-replace-stay', trigger: 'ctrl+t' },
  'mini-location-replace-same-stay': { ext: 'mini', variant: 'location-replace-same-stay', trigger: 'ctrl+t' },
  'mini-location-href-stay':    { ext: 'mini', variant: 'location-href-stay', trigger: 'ctrl+t' },
  'mini-location-replace-other-stay': { ext: 'mini', variant: 'location-replace-other-stay', trigger: 'ctrl+t' },
  'mini-create-ext-tab':  { ext: 'mini', variant: 'create-ext-tab', trigger: 'ctrl+t' },
  'mini-create-ext-tab-ntpprefix': { ext: 'mini', variant: 'create-ext-tab-ntpprefix', trigger: 'ctrl+t' },
  // Control: omnibox focused (Ctrl+L) on an ordinary http page, then the page itself does location.replace.
  'control-http-omnibox-then-replace': { ext: 'mini', variant: 'none', trigger: null, pre: 'omnibox', startPath: '/page/A?replaceAfter=4000' },
  'mini-ctrl-n-ntp-focus-input': { ext: 'mini', variant: 'ntp-focus-input', trigger: 'ctrl+n' },
  'mini-ctrl-n-create-ext-tab':  { ext: 'mini', variant: 'create-ext-tab', trigger: 'ctrl+n' },
  'mini-ctrl-n-location-replace-other-stay': { ext: 'mini', variant: 'location-replace-other-stay', trigger: 'ctrl+n' },
  'mini-remove-first-omnibox-first': { ext: 'mini', variant: 'remove-first', trigger: 'ctrl+t', pre: 'omnibox' },
  'mini-winfocus-omnibox-first': { ext: 'mini', variant: 'winfocus', trigger: 'ctrl+t', pre: 'omnibox' },
  'mini-cs-window-focus-omnibox-first': { ext: 'mini', variant: 'cs-window-focus', trigger: 'ctrl+t', pre: 'omnibox' },
  'mini-location-replace-omnibox-first': { ext: 'mini', variant: 'location-replace', trigger: 'ctrl+t', pre: 'omnibox' },
  'mini-location-replace-other-stay-omnibox-first': { ext: 'mini', variant: 'location-replace-other-stay', trigger: 'ctrl+t', pre: 'omnibox' },
  'mini-create-ext-tab-omnibox-first': { ext: 'mini', variant: 'create-ext-tab', trigger: 'ctrl+t', pre: 'omnibox' },
};

let variant = 'margin';
let current = null; // scenario name
let t0 = Date.now();
const logs = [];
const PAGE = (name) => `<!doctype html><meta charset="utf-8"><title>${name}</title>
<body style="margin:0;background:#fff;font:20px sans-serif"><h1>page ${name}</h1><p>probe page</p>
<script>
(() => {
  const d = (el) => !el ? null : el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');
  const L = (ev, extra = {}) => fetch('/log', { method: 'POST', keepalive: true, body: JSON.stringify({ src: 'page:${name}', ev,
    hasFocus: document.hasFocus(), active: d(document.activeElement), vis: document.visibilityState, ...extra }) }).catch(() => {});
  let last = '';
  setInterval(() => { const s = document.hasFocus() + '|' + d(document.activeElement) + '|' + document.visibilityState; if (s !== last) { last = s; L('state'); } }, 50);
  addEventListener('keydown', (e) => L('keydown', { key: e.key, target: d(e.composedPath()[0]) }), true);
  addEventListener('focus', (e) => e.target === window && L('window-focus'));
  addEventListener('blur', (e) => e.target === window && L('window-blur'));
  addEventListener('load', () => L('load'));
  const after = new URLSearchParams(location.search).get('replaceAfter');
  if (after) setTimeout(() => { L('location.replace now'); location.replace('/page/B'); }, Number(after));
})();
</script>`;

const server = createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  if (req.url === '/log' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const e = { t: Date.now() - t0, scenario: current, ...JSON.parse(body) };
        logs.push(e);
        if (process.env.VERBOSE) console.log(JSON.stringify(e));
      } catch {}
      res.end('ok');
    });
    return;
  }
  if (req.url === '/variant') return res.end(variant);
  if (req.url.startsWith('/page/')) {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.end(PAGE(req.url.slice(6).split('?')[0].replace(/\W/g, '')));
  }
  res.statusCode = 404;
  res.end();
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const x = (...args) => execFileSync('xdotool', args, { env: { ...process.env, DISPLAY } }).toString().trim();
const mark = (ev, extra = {}) => logs.push({ t: Date.now() - t0, scenario: current, src: 'runner', ev, ...extra });
const shot = (file) => execFileSync('import', ['-display', DISPLAY, '-window', 'root', file]);
const diff = (a, b) => execFileSync('python3', ['-I', join(DIR, 'diff.py'), a, b]).toString().trim();

async function waitFor(pred, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (logs.some(pred)) return true; await sleep(100); }
  return false;
}

async function run(name) {
  const sc = SCENARIOS[name];
  current = name; t0 = Date.now(); variant = sc.variant || 'margin';
  const profile = mkdtempSync('/tmp/claude-0/-home-user-margin/0b6cb4e1-de7e-571b-8d96-9abc72d8e3bb/scratchpad/c-verify/profiles-');
  const args = [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--no-sandbox',
    '--disable-search-engine-choice-screen', '--password-store=basic', '--no-proxy-server',
    `--disable-extensions-except=${EXT[sc.ext]}`, `--load-extension=${EXT[sc.ext]}`,
    '--window-position=0,0', '--window-size=1280,900', `http://127.0.0.1:${PORT}${sc.startPath || '/page/A'}`];
  const chrome = spawn(CHROME, args, { env: { ...process.env, DISPLAY }, stdio: 'ignore', detached: true });
  try {
    if (!(await waitFor((e) => e.scenario === name && e.src === 'page:A' && e.ev === 'load'))) throw new Error('page A never loaded');
    await sleep(2500); // let the extension settle (Margin tracks tabs, injects its sidebar)
    const ids = x('search', '--onlyvisible', '--name', 'Google Chrome').split('\n').filter(Boolean);
    const win = ids[ids.length - 1];
    x('windowfocus', '--sync', win);
    if (sc.pre === 'omnibox') {
      x('mousemove', '640', '600', 'click', '1'); await sleep(400);
      x('key', 'ctrl+l'); // address bar focused in the previous tab before the new tab opens
    } else {
      x('mousemove', '640', '600', 'click', '1'); // put focus in the web page like a user reading it
    }
    await sleep(800);
    mark('pre-trigger');
    shot(join(OUT, `${name}-0-before.png`));
    if (sc.trigger) x('key', sc.trigger);
    mark('triggered', { key: sc.trigger });
    await sleep(3500);
    mark('settled');
    shot(join(OUT, `${name}-1-after.png`));
    x('type', '--delay', '80', 'qzx');
    await sleep(1000);
    mark('typed qzx');
    shot(join(OUT, `${name}-2-typed.png`));
    mark('toolbar-diff', { result: diff(join(OUT, `${name}-1-after.png`), join(OUT, `${name}-2-typed.png`)) });
  } catch (err) {
    mark('error', { err: String(err) });
  } finally {
    try { process.kill(-chrome.pid, 'SIGKILL'); } catch {}
    await sleep(500);
    rmSync(profile, { recursive: true, force: true });
  }
  const mine = logs.filter((e) => e.scenario === name);
  writeFileSync(join(OUT, `${name}.jsonl`), mine.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return summarize(name, mine);
}

function summarize(name, mine) {
  const after = mine.filter((e) => e.t >= (mine.find((m) => m.ev === 'triggered')?.t ?? 0));
  const typedT = mine.find((m) => m.ev === 'settled')?.t ?? Infinity;
  const keys = after.filter((e) => e.ev === 'keydown' && e.t >= typedT).map((e) => `${e.src}:${e.key}->${e.target}`);
  const lastState = {};
  for (const e of after) if (e.src !== 'runner' && e.src !== 'sw' && e.t <= typedT && 'hasFocus' in e) lastState[e.src] = `${e.ev} hasFocus=${e.hasFocus} active=${e.active} vis=${e.vis}`;
  const s = { scenario: name, ...SCENARIOS[name], lastStateBeforeTyping: lastState, keydownsWhileTyping: keys,
    toolbarDiff: mine.find((m) => m.ev === 'toolbar-diff')?.result, errors: mine.filter((m) => m.ev === 'error').map((m) => m.err) };
  appendFileSync(join(OUT, 'summary.jsonl'), JSON.stringify(s) + '\n');
  return s;
}

let names = process.argv.slice(2);
if (names[0] === 'all') names = Object.keys(SCENARIOS);
for (const n of names) {
  if (!SCENARIOS[n]) { console.error('unknown scenario', n); continue; }
  console.log(JSON.stringify(await run(n), null, 1));
}
server.close();
process.exit(0);
