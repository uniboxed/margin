// Margin iframe-shell prototype: background service worker.
// Only job: the "narrow" header-removal mode. The shell asks to be armed before it sets the
// iframe's src; we add a SESSION rule that strips framing headers only for sub_frame
// responses in that one tab, from that one host, initiated by that host.
const XFO = { header: 'x-frame-options', operation: 'remove' };
const CSP = { header: 'content-security-policy', operation: 'remove' };
let narrowHeaders = [XFO, CSP];

// Test hooks (called from Playwright via worker.evaluate).
self.setNarrowHeaders = (xfoOnly) => { narrowHeaders = xfoOnly ? [XFO] : [XFO, CSP]; return narrowHeaders.map((h) => h.header); };
self.setStaticRuleset = (on) => chrome.declarativeNetRequest.updateEnabledRulesets(on ? { enableRulesetIds: ['framing'] } : { disableRulesetIds: ['framing'] });
self.state = async () => ({
  enabled: await chrome.declarativeNetRequest.getEnabledRulesets(),
  session: await chrome.declarativeNetRequest.getSessionRules(),
});
self.clearSession = async () => {
  const ids = (await chrome.declarativeNetRequest.getSessionRules()).map((r) => r.id);
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
  return ids.length;
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'arm' || !sender.tab) return;
  const t = performance.now();
  const tabId = sender.tab.id;
  const host = new URL(sender.url).hostname;
  const id = 1000 + tabId;
  chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [{
      id,
      priority: 2,
      action: { type: 'modifyHeaders', responseHeaders: narrowHeaders },
      condition: { tabIds: [tabId], resourceTypes: ['sub_frame'], requestDomains: [host], initiatorDomains: [host] },
    }],
  }).then(
    () => sendResponse({ armed: true, id, host, ms: +(performance.now() - t).toFixed(2) }),
    (err) => sendResponse({ armed: false, err: String(err) }),
  );
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1000 + tabId] }).catch(() => {});
});
