const step2 = location.search.includes('step2');
const src = step2 ? 'ntp2' : 'ntp';
watchFocus(src);
const v = await (await fetch('http://127.0.0.1:8794/variant')).text();
const self = await chrome.tabs.getCurrent();
LOG(src, 'loaded', { v, tabId: self.id });
const handoff = (order = 'margin') => chrome.runtime.sendMessage({ type: 'handoff', order, ntpId: self.id, windowId: self.windowId });
const focusQ = () => { document.getElementById('q').focus(); LOG(src, 'q.focus() called'); setTimeout(() => LOG(src, 'q +500ms'), 500); };
const next = chrome.runtime.getURL('ntp.html?step2');
if (!step2) {
  switch (v) {
    case 'margin': case 'remove-first': case 'winfocus': case 'create-ext-tab': case 'create-ext-tab-ntpprefix': case 'cs-window-focus':
      handoff(v); break;
    case 'ntp-focus-input': focusQ(); break;            // Margin's ⌘N path: palette on the new-tab page itself
    case 'tabsupdate-url': chrome.tabs.update(self.id, { url: next }); break;
    case 'location-replace': case 'location-replace-stay': location.replace(next); break;
    case 'location-href-stay': location.href = next; break;
    case 'location-replace-same-stay': if (!sessionStorage.done) { sessionStorage.done = 1; location.replace(chrome.runtime.getURL('ntp.html')); } else { LOG(src, 'second load (same URL)'); focusQ(); } break;
    case 'location-replace-other-stay': location.replace(chrome.runtime.getURL('pal.html?fromntp')); break;
    case 'window-focus-ntp': window.focus(); focusQ(); break;
  }
} else {
  switch (v) {
    case 'tabsupdate-url': case 'location-replace': handoff('margin'); break;
    default: focusQ();
  }
}
