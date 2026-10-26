// The same frames in a normal web page: https://example.com/#dnr-test
if (location.hash === '#dnr-test' && window === top) {
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = (globalThis.browser ?? globalThis.chrome).runtime.getURL('grid.css');
  document.head.append(css);
  document.body.replaceChildren(Object.assign(document.createElement('h1'), { textContent: 'DNR header test, in a web page' }), dnrGrid(document));
}
