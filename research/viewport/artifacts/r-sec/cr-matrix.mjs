// Chromium DNR security matrix. usage: node cr-matrix.mjs
import { createRequire } from 'module';
const require = createRequire('/home/user/margin/package.json');
const { chromium } = require('playwright');
const ext = new URL('./ext', import.meta.url).pathname;
const P = 8871;
const V = `http://www.victim.test:${P}`, EVIL = `http://evil.victim.test:${P}`, ATT = `http://attacker.test:${P}`, AD = `http://ads.test:${P}`;
const names = ['plain', 'deny', 'same', 'fanone', 'faself', 'both'];
const tgt = names.map((n) => `${V}/t/${n}`).join(',');
const scenarios = {
  S1_shell_sameOrigin: `${V}/shell?f=${encodeURIComponent(tgt)}`,
  S2_crossSiteAttacker: `${ATT}/shell?f=${encodeURIComponent(tgt)}`,
  S3_sameSiteSubdomainAttacker: `${EVIL}/shell?f=${encodeURIComponent(tgt)}`,
  S4_malvertisingInsideVictimPage: `${V}/shell?f=${encodeURIComponent(names.map((n) => `${AD}/ad?f=${encodeURIComponent(`${V}/t/${n}`)}`).join(','))}`,
};
const base = { resourceTypes: ['sub_frame'], domainType: 'firstParty' };
const scoped = { ...base, requestDomains: ['www.victim.test'], initiatorDomains: ['www.victim.test'] };
const rx = (headers, cond) => [{ id: 1, priority: 1, action: { type: 'modifyHeaders', responseHeaders: headers }, condition: cond }];
const ruleSets = {
  R0_noRules: [],
  R1_removeXFO_firstParty: rx([{ header: 'x-frame-options', operation: 'remove' }], base),
  R2_removeXFO_firstParty_exactHostInitiator: rx([{ header: 'x-frame-options', operation: 'remove' }], scoped),
  R3_removeXFOandCSP_firstParty: rx([{ header: 'x-frame-options', operation: 'remove' }, { header: 'content-security-policy', operation: 'remove' }], base),
  R4_appendCSP_frameAncestorsStar: rx([{ header: 'x-frame-options', operation: 'remove' }, { header: 'content-security-policy', operation: 'append', value: 'frame-ancestors *' }], base),
  R6_setXFO_SAMEORIGIN_requestHost_only: rx([{ header: 'x-frame-options', operation: 'set', value: 'SAMEORIGIN' }], { resourceTypes: ['sub_frame'], requestDomains: ['www.victim.test'] }),
  R7_setXFO_SAMEORIGIN_requestHost_firstParty: rx([{ header: 'x-frame-options', operation: 'set', value: 'SAMEORIGIN' }], { resourceTypes: ['sub_frame'], requestDomains: ['www.victim.test'], domainType: 'firstParty' }),
  R5_setCSP_frameAncestorsSelf: rx([{ header: 'x-frame-options', operation: 'remove' }, { header: 'content-security-policy', operation: 'set', value: "frame-ancestors 'self'" }], base),
};
const ctx = await chromium.launchPersistentContext('', { headless: false, args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--host-resolver-rules=MAP *.test 127.0.0.1'] });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
const page = await ctx.newPage();
const out = {};
for (const [rn, rules] of Object.entries(ruleSets)) {
  try { await sw.evaluate((r) => globalThis.setRules(r), rules); } catch (e) { out[rn] = 'setRules ERROR ' + e.message; continue; }
  out[rn] = {};
  for (const [sn, url] of Object.entries(scenarios)) {
    await page.goto(url);
    await page.waitForFunction(() => document.title !== 'pending', null, { timeout: 10000 }).catch(() => {});
    out[rn][sn] = JSON.parse(await page.title());
  }
}
console.log(JSON.stringify(out, null, 1));
await ctx.close();
