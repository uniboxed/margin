// Rule installed per shell tab by the test driver via globalThis.unlock(tabId, host).
globalThis.unlock = async (tabId, host) => {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tabId],
    addRules: [{
      id: tabId,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'x-frame-options', operation: 'remove' },
          { header: 'content-security-policy', operation: 'remove' },
        ],
      },
      condition: {
        tabIds: [tabId],
        resourceTypes: ['sub_frame'],
        domainType: 'firstParty',
        requestDomains: [host],
        initiatorDomains: [host],
      },
    }],
  });
  return chrome.declarativeNetRequest.getSessionRules();
};
globalThis.activeTabId = async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
