// The injection probe's registered copy (shared/probe.js): registered by the
// background with scripting.registerContentScripts, the way the transplant
// shell would be. It runs after the manifest scripts, so Margin's own hosts
// are usually in <html> already ("foreign").
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const record = globalThis.Margin.probe.snapshot('registered');
  if (location.href.startsWith(api.runtime.getURL(''))) return;
  api.runtime.sendMessage({ type: 'probe', record }).catch(() => {});
})();
