const LOG = (ev, extra = {}) => fetch('http://127.0.0.1:8794/log', { method: 'POST', body: JSON.stringify({ src: 'sw', ev, ...extra }) }).catch(() => {});
async function prevTab(windowId, ntpId) {
  const tabs = await chrome.tabs.query({ windowId });
  return tabs.filter((t) => t.id !== ntpId && /^https?:/.test(t.url || '')).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
}
async function activate(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  const win = await chrome.windows.get(tab.windowId);
  LOG('after activate', { winFocused: win.focused });
  if (!win.focused) await chrome.windows.update(tab.windowId, { focused: true });
}
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m.type !== 'handoff') return;
  (async () => {
    const prev = await prevTab(m.windowId, m.ntpId);
    LOG('handoff', { order: m.order, prev: prev?.id, ntp: m.ntpId });
    if (!prev && !m.order.startsWith('create-ext-tab')) return;
    switch (m.order) {
      case 'margin': case 'cs-window-focus':
        await activate(prev.id); await chrome.tabs.remove(m.ntpId); break;
      case 'remove-first':
        await chrome.tabs.remove(m.ntpId); await activate(prev.id); break;
      case 'winfocus':
        await activate(prev.id); await chrome.tabs.remove(m.ntpId);
        await chrome.windows.update(m.windowId, { focused: true }); break;
      case 'create-ext-tab': case 'create-ext-tab-ntpprefix': {
        const ntp = await chrome.tabs.get(m.ntpId);
        const url = chrome.runtime.getURL(m.order === 'create-ext-tab' ? 'pal.html' : 'ntp.html?step2');
        await chrome.tabs.create({ windowId: m.windowId, index: ntp.index, url, active: true });
        await chrome.tabs.remove(m.ntpId);
        return; // no palette in prev
      }
    }
    await chrome.tabs.sendMessage(prev.id, { type: 'show-palette', windowFocus: m.order === 'cs-window-focus' }).catch((e) => LOG('send failed', { e: String(e) }));
  })();
  reply(true);
});
