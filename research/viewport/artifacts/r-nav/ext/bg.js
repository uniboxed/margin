const idOf = (url) => { try { return new URL(url).searchParams.get('id') || 'none'; } catch (e) { return 'none'; } };
const send = (ev, d) => {
  const o = { ev, world: 'bg', frameId: d.frameId, parentFrameId: d.parentFrameId, url: d.url, error: d.error, transitionType: d.transitionType, documentLifecycle: d.documentLifecycle };
  fetch('http://localhost:8701/log?id=' + encodeURIComponent(idOf(d.url) === 'none' ? (self.__lastId || 'none') : idOf(d.url)), { method: 'POST', body: JSON.stringify(o) }).catch(() => {});
  if (idOf(d.url) !== 'none') self.__lastId = idOf(d.url);
};
for (const n of ['onBeforeNavigate', 'onCommitted', 'onErrorOccurred', 'onCompleted']) {
  chrome.webNavigation[n].addListener((d) => send('wn-' + n, d));
}
