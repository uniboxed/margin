// Minimal "palette": an overlay with an input, focused on 'show-palette'.
const LOGC = (ev, extra = {}) => fetch('http://127.0.0.1:8794/log', { method: 'POST', body: JSON.stringify({ src: 'cs', ev, hasFocus: document.hasFocus(), active: document.activeElement?.tagName + '#' + (document.activeElement?.id || ''), vis: document.visibilityState, ...extra }) }).catch(() => {});
chrome.runtime.onMessage.addListener((m) => {
  if (m.type !== 'show-palette') return;
  let box = document.getElementById('mp');
  if (!box) {
    box = document.createElement('div');
    box.id = 'mp';
    box.style.cssText = 'position:fixed;top:120px;left:200px;width:700px;padding:20px;background:#222;z-index:99999';
    box.innerHTML = '<input id="mp-input" style="font:24px sans-serif;width:100%" placeholder="mini palette">';
    document.documentElement.append(box);
  }
  if (m.windowFocus) window.focus();
  box.querySelector('input').focus();
  LOGC('palette focus() called');
  setTimeout(() => LOGC('palette +500ms'), 500);
});
