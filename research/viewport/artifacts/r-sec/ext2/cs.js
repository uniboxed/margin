// Emulates the Margin shell: at document_start, build a same-origin iframe and report whether it loaded,
// and whether the site's own inline script ran in the top document.
(() => {
  let ok = false;
  addEventListener('message', (e) => { if (e.data && e.data.name) ok = e.data.name; });
  const go = () => {
    const f = document.createElement('iframe'); f.src = '/t/plain'; document.body.append(f);
    setTimeout(() => { document.title = JSON.stringify({ iframe: ok ? 'LOADED' : 'BLOCKED', siteInlineScriptRanInTop: document.documentElement.dataset.siteRan === '1' }); }, 2000);
  };
  if (document.body) go(); else addEventListener('DOMContentLoaded', go);
})();
