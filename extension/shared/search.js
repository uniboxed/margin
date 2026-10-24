// Pure input/search helpers shared by the new-tab launcher and the palette.
// Classic script: attaches to globalThis.Margin.
(() => {
  const Margin = (globalThis.Margin ??= {});

  const SEARCH_ENGINES = [
    { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
    { name: 'Google', url: 'https://www.google.com/search?q=%s' },
    { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
    { name: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s' },
    { name: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s' },
  ];
  const DEFAULT_ENGINE = SEARCH_ENGINES[0].url;

  const WITH_SCHEME = /^(https?|file|ftp):\/\//i;
  const OPAQUE_SCHEME = /^(about|data|mailto|view-source):/i;
  const LOCAL = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?([/?#]\S*)?$/i;
  const DOMAIN = /^([a-z0-9-]+\.)+[a-z][a-z0-9-]*\.?(:\d+)?([/?#]\S*)?$/i;

  // Text typed into the launcher or palette → { kind: 'url' | 'search', url }.
  function resolveInput(text, engine = DEFAULT_ENGINE) {
    const input = (text ?? '').trim();
    if (!input) return null;
    if (WITH_SCHEME.test(input) || OPAQUE_SCHEME.test(input)) return { kind: 'url', url: input };
    if (!/\s/.test(input)) {
      if (LOCAL.test(input)) return { kind: 'url', url: `http://${input}` };
      if (DOMAIN.test(input)) return { kind: 'url', url: `https://${input}` };
    }
    const template = engine?.includes('%s') ? engine : DEFAULT_ENGINE;
    return { kind: 'search', url: template.replace('%s', encodeURIComponent(input)) };
  }

  Margin.search = { SEARCH_ENGINES, DEFAULT_ENGINE, resolveInput };
})();
