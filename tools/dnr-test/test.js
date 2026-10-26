// Reports the rules Safari has, then response-header rule 3 on a fetch
// (a header that isn't about framing), then draws the frames.
const api = globalThis.browser ?? globalThis.chrome;
const dnr = api.declarativeNetRequest;
const lines = [`${navigator.userAgent}`];
const out = () => (document.getElementById('report').textContent = lines.join('\n'));
const tryLine = async (label, fn) => {
  try { lines.push(`${label}: ${JSON.stringify(await fn())}`); } catch (e) { lines.push(`${label}: ERROR ${e}`); }
  out();
};
document.getElementById('frames').append(dnrGrid(document));
// Safari applies header rules only on sites the extension may access.
const ORIGINS = ['https://httpbin.org/*', 'https://github.com/*', 'https://www.google.com/*', 'https://developer.mozilla.org/*'];
document.getElementById('grant').addEventListener('click', async () => {
  for (const origins of [ORIGINS, ['<all_urls>']]) {
    try { lines.push(`grant ${origins.join(' ')}: ${await api.permissions.request({ origins })}`); } catch (e) { lines.push(`grant ${origins.join(' ')}: ERROR ${e}`); }
    out();
  }
  lines.push('Now reload this page (⌘R).');
  out();
});
(async () => {
  await tryLine('access: <all_urls>', () => api.permissions.contains({ origins: ['<all_urls>'] }));
  for (const o of ORIGINS) await tryLine(`access: ${o}`, () => api.permissions.contains({ origins: [o] }));
  await tryLine('enabled rulesets', () => dnr.getEnabledRulesets());
  await tryLine('available static rule count (Chrome only)', async () => (dnr.getAvailableStaticRuleCount ? dnr.getAvailableStaticRuleCount() : 'not in this browser'));
  await tryLine('rule 3 (fetch: content-language set to xx-DNR-WORKS if response rules work)', async () => {
    const res = await fetch('https://httpbin.org/response-headers?Content-Language=en', { cache: 'no-store' });
    return res.headers.get('content-language');
  });
  await new Promise((r) => setTimeout(r, 4000)); // let the frames load first
  await tryLine('matched rules', async () => (await dnr.getMatchedRules?.())?.rulesMatchedInfo?.map((m) => m.rule?.ruleId ?? m.ruleId ?? m));
})();
