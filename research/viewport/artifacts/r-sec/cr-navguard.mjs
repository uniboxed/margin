// Chromium: does a meta CSP "frame-src 'self'" placed in the shell (top) document stop the shell iframe from
// navigating cross-origin (link/JS navigation and server redirect), while leaving grandchild 3p embeds alone?
import { createRequire } from 'module';
const require = createRequire('/home/user/margin/package.json');
const { chromium } = require('playwright');
const P = 8871;
const V = `http://www.victim.test:${P}`, ATT = `http://attacker.test:${P}`, EVIL = `http://evil.victim.test:${P}`, AD = `http://ads.test:${P}`;
const frames = [
  `${V}/t/hop?to=${encodeURIComponent(`${ATT}/t/plain`)}`,
  `${V}/t/redir?to=${encodeURIComponent(`${EVIL}/t/same`)}`,
  `${V}/t/embeds3p?g=${encodeURIComponent(`${AD}/t/plain`)}`,
  `${V}/t/deny`,
];
const b = await chromium.launch({ args: ['--host-resolver-rules=MAP *.test 127.0.0.1'] });
const p = await b.newPage();
p.on('console', (m) => console.log('console:', m.text()));
await p.goto(`${V}/navshell?f=${encodeURIComponent(frames.join(','))}`);
await p.waitForFunction(() => document.title !== 'pending', null, { timeout: 10000 }).catch(() => {});
console.log(JSON.stringify(JSON.parse(await p.title()), null, 1));
console.log('frames:', p.frames().map((f) => f.url()));
await b.close();
