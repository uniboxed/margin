#!/usr/bin/env node
// node scripts/scroll-bars.mts <always|overlay> <command…>: runs a command with the test browsers' scroll bars
// set, and puts back what was there after (GitHub issue #17: the page box with classic scroll bars).
// `always`: classic scroll bars, shown and taking space, as on a Mac with a mouse and no trackpad (macOS's
// "Show scroll bars: Always"); `overlay`: shown only while scrolling, over the content (a trackpad's).
//
// Only the test browsers' own preferences, never the Mac's own (the global domain): Playwright's Chrome for
// Testing (its app domain, which it reads as it starts, over the global one), and the WebKit host, which takes
// MARGIN_SCROLL_BARS (tools/webkit-host/run.sh: its argument domain, nothing written). The command sees
// MARGIN_SCROLL_BARS too: tests/e2e/box-patterns.test.ts checks the browser shows the bars asked for.
import { spawnSync } from 'node:child_process';

const DOMAINS = ['com.google.chrome.for.testing'];
const KEY = 'AppleShowScrollBars';
const VALUES: Record<string, string> = { always: 'Always', overlay: 'WhenScrolling' };
const [mode, ...command] = process.argv.slice(2);
if (!VALUES[mode] || !command.length) {
  console.error('usage: node scripts/scroll-bars.mts <always|overlay> <command…>');
  process.exit(2);
}
if (process.platform !== 'darwin') {
  console.error('scroll-bars: macOS only (its scroll bar setting)');
  process.exit(2);
}

const defaults = (...args: string[]) => spawnSync('defaults', args, { encoding: 'utf8' });
// What each domain had: its value, or null for none (then it's deleted after).
const before = new Map(DOMAINS.map((domain) => {
  const read = defaults('read', domain, KEY);
  return [domain, read.status === 0 ? read.stdout.trim() : null];
}));
function restore() {
  for (const [domain, value] of before) {
    if (value == null) defaults('delete', domain, KEY);
    else defaults('write', domain, KEY, '-string', value);
  }
}
// A ^C reaches the command too: it ends, and what was there is put back below.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => {});

let status = 1;
try {
  for (const domain of DOMAINS) {
    const wrote = defaults('write', domain, KEY, '-string', VALUES[mode]);
    if (wrote.status !== 0) throw new Error(`defaults write ${domain} ${KEY}: ${wrote.stderr.trim()}`);
  }
  const run = spawnSync(command[0], command.slice(1), { stdio: 'inherit', env: { ...process.env, MARGIN_SCROLL_BARS: mode } });
  if (run.error) throw run.error;
  status = run.status ?? 1;
} finally {
  restore();
}
process.exit(status);
