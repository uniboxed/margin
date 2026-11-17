// The pages tools/glass-shots/run.sh shows: a built-in theme drawn by the real runtime over the theme tests' mock
// state (tests/theme/harness.ts), each a file that stands on its own (the harness, the package and its start in it).
//   node pages.mts <out dir> [theme id]
// One file per state and space: <state>-<space>-<light|dark>.html. A stand-in for a hosted window's page shows
// through the page slot (which is a hole), so the glass has something beside it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessScript, themeForPage } from '../../tests/theme/package.ts';

const [out, id = 'liquid-glass'] = process.argv.slice(2);
if (!out) { console.error('node pages.mts <out dir> [theme id]'); process.exit(64); }
mkdirSync(out, { recursive: true });
const inline = (text: string) => text.replace(/<\/script/gi, '<\\/script');
const script = inline(harnessScript());
const pkg = inline(JSON.stringify(themeForPage(fileURLToPath(new URL(`../../extension/themes/${id}/`, import.meta.url)))));

// A quiet article where the page would be.
const MOCK = (dark: boolean) => {
  const ink = dark ? 'rgba(255,255,255,' : 'rgba(0,0,0,';
  const bar = (w: string) => `<div style="width:${w};height:10px;border-radius:5px;background:${ink}.09);margin:9px 0"></div>`;
  return `<div style="position:fixed;inset:0;z-index:-1;background:${dark ? '#1d1d20' : '#fff'};font:16px/1.5 -apple-system,system-ui,sans-serif;color:${ink}.8);overflow:hidden">
  <div style="position:absolute;left:calc(280px + (100% - 280px - 720px) / 2);top:0;width:720px;padding-top:26px">
    <div style="display:flex;align-items:center;gap:22px;font-size:13px;color:${ink}.5);padding-bottom:18px;border-bottom:1px solid ${ink}.08)"><b style="font-size:17px;color:${ink}.85)">The Lantern</b><span>Culture</span><span>Technology</span><span>Letters</span><span style="margin-left:auto">Subscribe</span></div>
    <div style="margin-top:54px;font-size:13px;font-weight:600;color:${dark ? '#ff9f6b' : '#c2410c'}">ESSAY</div>
    <div style="margin-top:10px;font:700 44px/1.1 ui-serif,Georgia,serif">The quiet return of the analog city</div>
    <div style="margin-top:16px;font-size:19px;color:${ink}.55)">Paper maps, film counters and corner shops are filling up again. A walk through what came back, and why.</div>
    <div style="margin:34px 0 30px;height:300px;border-radius:14px;background:linear-gradient(135deg,${dark ? '#3b2f4f,#1f3a4a 55%,#4a3324' : '#f3d9c4,#cfe1ee 55%,#e9d2ee'})"></div>
    ${bar('100%')}${bar('96%')}${bar('99%')}${bar('62%')}<div style="height:14px"></div>${bar('98%')}${bar('100%')}${bar('91%')}${bar('40%')}
  </div></div>`;
};

const MOUNT = `T.mountRuntime({ container: 'document', platform: { browser: 'safari', os: 'mac' }, mode: 'fullscreen' });`;
const later = 'await new Promise((r) => setTimeout(r, 300));';
// Each state: how the runtime gets there.
// (`space: false`: the state is drawn before the theme's data, so no space is switched to: one look per mode.)
const STATES: Record<string, { start: string, then?: string, page?: boolean, space?: boolean }> = {
  sidebar: { start: MOUNT },
  palette: { start: MOUNT, then: `T.rtDispatch('palette.open'); ${later} const q = document.querySelector('[m-input="palette"]'); q.value = 'li'; q.dispatchEvent(new Event('input', { bubbles: true }));` },
  menu: { start: MOUNT, then: `${later} T.rtBox('.today .tab', 1); const r = T.rtRect('.today .tab', 1); for (const type of ['mousedown', 'contextmenu']) document.elementFromPoint(r.x, r.y).dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 2, clientX: r.x, clientY: r.y }));` },
  editor: { start: MOUNT, then: `T.rtDispatch('space.edit', T.rtVmFull().space);` },
  notice: { start: MOUNT, then: `T.rtSetUi({ notice: { id: 'n', text: 'That tab is no longer open.', actions: [{ id: 'ok', label: 'OK', primary: true }] } });` },
  launcher: { start: `T.mountRuntime({ container: 'document', platform: { browser: 'safari', os: 'mac' }, mode: 'fullscreen', appWindow: true });`, page: false },
  // Margin.app's own window while an item opens: the page card opaque over the hosted window, the theme's loader in it.
  loading: { start: `T.mountRuntime({ container: 'document', platform: { browser: 'safari', os: 'mac' }, mode: 'fullscreen', hosted: true });`, then: `T.rtPageState('loading', 'Safari');` },
  // … and before its first data (the root's m-starting): the theme's skeleton, the loader's card with no words.
  starting: { start: `T.rtStartEmpty('empty');`, page: false, space: false },
};

for (const [state, { start, then = '', page = true, space: spaces = true }] of Object.entries(STATES)) {
  for (const space of ['personal', 'work', 'studio']) {
    for (const mode of ['light', 'dark']) {
      writeFileSync(join(out, `${state}-${space}-${mode}.html`), `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${page ? MOCK(mode === 'dark') : ''}<script>${script}</script><script>
(async () => {
  const loaded = await T.loadBuiltin(${pkg}, ${JSON.stringify(id)}, []);
  if (!loaded.ok) throw new Error('the theme did not load');
  ${start}
  ${space === 'personal' || !spaces ? '' : `T.rtApply('switchSpace', ${JSON.stringify(space)});`}
  ${then}
  window.shown = true;
})().catch((e) => { window.failed = String(e && e.stack || e); });
</script></body></html>`);
    }
  }
}
console.log(`pages in ${out}`);
