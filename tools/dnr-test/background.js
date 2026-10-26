// Opens the test page on install and on the toolbar button.
const api = globalThis.browser ?? globalThis.chrome;
const open = () => api.tabs.create({ url: api.runtime.getURL('test.html') });
api.runtime.onInstalled.addListener(open);
api.action.onClicked.addListener(open);
