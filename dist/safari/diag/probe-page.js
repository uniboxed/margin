// Shows the injection probe's records (shared/probe.js), newest first.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const P = globalThis.Margin.probe;
  const $ = (id) => document.getElementById(id);
  let entries = [];

  function cell(text, cls) {
    const td = document.createElement('td');
    td.textContent = text;
    if (cls) td.className = cls;
    return td;
  }
  const ms = (n) => (Number.isFinite(n) ? `${Math.round(n)} ms` : '–');

  function render() {
    const para = (text) => Object.assign(document.createElement('p'), { textContent: text });
    $('summary').replaceChildren(...(entries.length ? P.SOURCES.map((s) => para(P.summaryLine(entries, s))) : [para('No records yet. Load some pages.')]));
    $('rows').replaceChildren(
      ...entries
        .slice()
        .reverse()
        .map((e) => {
          const tr = document.createElement('tr');
          tr.append(
            cell(e.source ?? 'manifest'),
            cell(e.verdict, e.verdict.replace('/', '')),
            cell(e.verdict === 'bfcache' ? '' : e.kids?.join(', ') || '(empty)'),
            cell(e.ready ?? ''),
            cell(ms(e.injected), 'num'),
            cell(Number.isFinite(e.afterFirstByte) ? `${ms(e.responseStart)} (+${e.afterFirstByte})` : ms(e.responseStart), 'num'),
            cell(e.nav ?? ''),
            cell(e.url ?? '', 'url'),
          );
          return tr;
        }),
    );
  }

  async function load() {
    if (!api.storage.session) {
      $('summary').textContent = 'storage.session is unavailable here: see the background console ([margin] probe lines).';
      return;
    }
    ({ probe: entries = [] } = await api.storage.session.get('probe'));
    render();
  }

  $('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(P.report(entries, { userAgent: navigator.userAgent }));
      $('status').textContent = 'Copied.';
    } catch (err) {
      $('status').textContent = `Copy failed: ${err.message}`;
    }
  });
  $('clear').addEventListener('click', () => api.storage.session?.remove('probe'));
  api.storage.onChanged.addListener((changes, area) => area === 'session' && changes.probe && load());
  load();
})();
