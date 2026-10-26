// Sets up the rules as one kind (?mode=static|session|dynamic: built in,
// added for this browser session, or added and saved, as Framer does), then
// reports what Safari has, response-header rule 3 on a fetch (a header that
// isn't about framing), and draws the frames.
const api = globalThis.browser ?? globalThis.chrome;
const dnr = api.declarativeNetRequest;
const lines = [`${navigator.userAgent}`];
const out = () => (document.getElementById('report').textContent = lines.join('\n'));
const tryLine = async (label, fn) => {
  try { lines.push(`${label}: ${JSON.stringify(await fn())}`); } catch (e) { lines.push(`${label}: ERROR ${e}`); }
  out();
};
const MODES = ['static', 'session', 'dynamic'];
const mode = MODES.includes(new URLSearchParams(location.search).get('mode')) ? new URLSearchParams(location.search).get('mode') : 'static';
// The same rules.json, as only the chosen kind.
async function useMode() {
  const rules = await (await fetch('rules.json')).json();
  const ids = rules.map((r) => r.id);
  await dnr.updateEnabledRulesets(mode === 'static' ? { enableRulesetIds: ['rules'] } : { disableRulesetIds: ['rules'] });
  await dnr.updateSessionRules({ removeRuleIds: ids, addRules: mode === 'session' ? rules : [] });
  await dnr.updateDynamicRules({ removeRuleIds: ids, addRules: mode === 'dynamic' ? rules : [] });
}
document.getElementById('modes').append(...MODES.map((m) => Object.assign(document.createElement('a'), { href: `?mode=${m}`, textContent: m === mode ? `[${m}]` : m, style: 'margin-right:12px' })));
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
  await tryLine(`rules as: ${mode}`, async () => (await useMode(), 'set up'));
  document.getElementById('frames').append(dnrGrid(document)); // only once the rules are in place
  await tryLine('access: <all_urls>', () => api.permissions.contains({ origins: ['<all_urls>'] }));
  for (const o of ORIGINS) await tryLine(`access: ${o}`, () => api.permissions.contains({ origins: [o] }));
  await tryLine('enabled rulesets', () => dnr.getEnabledRulesets());
  await tryLine('session rules', async () => (await dnr.getSessionRules()).map((r) => r.id));
  await tryLine('dynamic rules', async () => (await dnr.getDynamicRules()).map((r) => r.id));
  await tryLine('available static rule count (Chrome only)', async () => (dnr.getAvailableStaticRuleCount ? dnr.getAvailableStaticRuleCount() : 'not in this browser'));
  await tryLine('rule 4, control (fetch: request accept-language, xx-DNR-WORKS if the rules apply)', async () =>
    (await (await fetch('https://httpbin.org/headers', { cache: 'no-store' })).json()).headers['Accept-Language']);
  await tryLine('rule 3 (fetch: content-language set to xx-DNR-WORKS if response rules work)', async () => {
    const res = await fetch('https://httpbin.org/response-headers?Content-Language=en', { cache: 'no-store' });
    return res.headers.get('content-language');
  });
  await new Promise((r) => setTimeout(r, 4000)); // let the frames load first
  await tryLine('matched rules', async () => (await dnr.getMatchedRules?.())?.rulesMatchedInfo?.map((m) => m.rule?.ruleId ?? m.ruleId ?? m));
})();
