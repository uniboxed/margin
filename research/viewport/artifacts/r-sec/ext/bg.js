globalThis.setRules = async (rules) => {
  const old = await chrome.declarativeNetRequest.getSessionRules();
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: old.map((r) => r.id), addRules: rules });
  return (await chrome.declarativeNetRequest.getSessionRules()).length;
};
