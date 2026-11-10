// The browser side of the theme tests and the benchmark, bundled into one
// script (tests/theme/package.ts harnessScript) and added to a blank page.
// Node drives it with page.evaluate through `window.T`.
import { sanitizeCss } from '../../extension/ui/sanitize.ts';
import { buildTemplate, View } from '../../extension/ui/render.ts';
import { loadTheme, loadBuiltinTheme, sanitizeTheme } from '../../extension/ui/theme-loader.ts';
import { createRuntime } from '../../extension/ui/runtime.ts';
import { createMockHost } from '../../extension/ui/host.ts';
import { createDispatcher, contextFromState } from '../../extension/ui/actions.ts';
import { MockState } from './view-model.ts';
import { auditDom } from './audit.ts';
import { HTML_PAYLOADS, CSS_PAYLOADS, CSS_TARGET, EVIL_VM, wrap } from './payloads.ts';
import { cloudOf } from '../../extension/shared/cloud-tabs.ts';
import { acrossOf } from '../../extension/shared/across.ts';
import { cloudFixture } from '../fixtures/cloud-tabs.ts';
import type { LoadedTheme, ThemePackage } from '../../extension/ui/theme-loader.ts';
import type { Layout } from '../../extension/ui/render.ts';
import type { CleanNode } from '../../extension/ui/sanitize.ts';
import type { UiState, ViewModel } from '../../extension/ui/view-model.ts';
import type { MockTab } from './view-model.ts';

// A theme package as Node hands it over (tests/theme/package.ts themeForPage): its files in base64.
type PagePackage = Omit<ThemePackage, 'files'> & { files: Record<string, string> };
// Where a view draws: a shadow root, or the document itself.
type Target = ShadowRoot | Document;
type Handle = { view: View, mock: MockState, el: HTMLElement | null, target: Target };
type Runtime = ReturnType<typeof createRuntime>;
type MockHost = ReturnType<typeof createMockHost>;
type ThemeResult = Awaited<ReturnType<typeof loadTheme>>; // loaded, or not (ok: false)
// MockState's updates, by name (Node names them).
type MockOp = { [K in keyof MockState]: MockState[K] extends Function ? K : never }[keyof MockState];
type Marked = HTMLElement & { __mark?: unknown };

// The page's window, with what the harness puts on it.
type HarnessWindow = Window & typeof globalThis & {
  __tripped: string[], __trip: (name: unknown) => void, __neo?: Handle, __rt?: typeof rt, T?: typeof T,
};
const w = window as HarnessWindow;

// The tripwire: every payload that runs calls one of these.
w.__tripped = [];
w.__trip = (name) => { w.__tripped.push(String(name)); };
w.alert = (m) => { w.__tripped.push(`alert:${m}`); };

const decode = (b64: string) => { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const unpack = (pkg: PagePackage): ThemePackage => ({ ...pkg, files: Object.fromEntries(Object.entries(pkg.files).map(([k, v]) => [k, decode(v)])) });

// A container: a shadow root on a fixed-size host, or the document itself.
function host(width: number, height: number) {
  const el = document.createElement('div');
  el.className = 'margin-host';
  el.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px;display:block`;
  document.body.appendChild(el);
  return el;
}

const state: { theme: ThemeResult | null, views: Handle[], log: Layout[], actions: [string, unknown][], refused: { name: string, arg: unknown, reason: string }[] } = { theme: null, views: [], log: [], actions: [], refused: [] };

const T = {
  async loadNeo(pkg: PagePackage) {
    const theme = await loadTheme(unpack(pkg));
    state.theme = theme;
    return {
      ok: theme.ok,
      removed: theme.report.removed,
      errors: theme.report.errors,
      fonts: ['Archivo Black', 'Space Grotesk'].map((f) => document.fonts.check(`16px "${f}"`)),
    };
  },

  // Renders Neubrutalism with the mock view model, in a shadow root (or the
  // document), and keeps the view for the steps below.
  mountNeo({ width = 1440, height = 900, container = 'shadow', closed = false } = {}) {
    const mock = new MockState();
    let target: Target;
    let el: HTMLElement | null = null;
    if (container === 'document') {
      document.documentElement.style.cssText = 'margin:0;height:100%';
      document.body.style.cssText = `margin:0;width:${width}px;height:${height}px`;
      target = document;
    } else {
      el = host(width, height);
      target = el.attachShadow({ mode: closed ? 'closed' : 'open' });
    }
    const dispatch = createDispatcher({
      context: () => contextFromState(mock.state),
      run: (name, arg) => state.actions.push([name, arg]),
      log: (entry) => state.refused.push(entry),
    });
    // (loadNeo first, with a package that loads)
    const view = new View(target, (state.theme as LoadedTheme).template, {
      sheets: [(state.theme as LoadedTheme).sheet],
      onAction: (name, arg) => dispatch(name, arg),
      onLayout: (layout) => state.log.push(layout),
    });
    view.update(mock.vm);
    const handle = { view, mock, el, target };
    state.views.push(handle);
    w.__neo = handle;
    return state.views.length - 1;
  },

  unmountAll() {
    for (const { view, el } of state.views) { view.destroy(); el?.remove(); }
    state.views = [];
    document.documentElement.style.cssText = '';
    document.body.style.cssText = '';
  },

  layout(i = state.views.length - 1) { return state.views[i].view.measure(); },
  layoutLog() { return state.log.slice(); },
  actions() { return { ran: state.actions.slice(), refused: state.refused.slice() }; },

  // Runs one update on the last view and reports every DOM mutation it made.
  mutate(op: MockOp, ...args: unknown[]) {
    const { view, mock, target } = state.views[state.views.length - 1];
    const root = target.nodeType === 9 ? (target as Document).body : target;
    const mo = new MutationObserver(() => {});
    mo.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    view.update((mock[op] as (...a: unknown[]) => unknown)(...args));
    const records = mo.takeRecords();
    mo.disconnect();
    const out = { text: 0, attributes: [] as (string | null)[], added: 0, removed: 0, moved: 0 };
    const added = new Set<Node>();
    const removed = new Set<Node>();
    for (const r of records) {
      if (r.type === 'characterData') out.text++;
      else if (r.type === 'attributes') out.attributes.push(r.attributeName);
      else { for (const n of r.addedNodes) added.add(n); for (const n of r.removedNodes) removed.add(n); }
    }
    for (const n of added) if (removed.has(n)) out.moved++;
    out.added = [...added].filter((n) => !removed.has(n)).length;
    out.removed = [...removed].filter((n) => !added.has(n)).length;
    return out;
  },

  count(selector: string) {
    const { target } = state.views[state.views.length - 1];
    return target.querySelectorAll(selector).length;
  },
  text(selector: string) {
    const { target } = state.views[state.views.length - 1];
    return [...target.querySelectorAll(selector)].map((e) => e.textContent!.trim());
  },
  // Marks the element a selector finds, to check later that it's the same node.
  tag(selector: string, mark: unknown) { const { target } = state.views[state.views.length - 1]; const el = target.querySelector<Marked>(selector)!; el.__mark = mark; return Boolean(el); },
  tagged(selector: string) { const { target } = state.views[state.views.length - 1]; return target.querySelector<Marked>(selector)?.__mark ?? null; },
  mock() { return state.views[state.views.length - 1].mock; },
  firstTodayId() { return T.mock().space.today[0].id; },
  vmIds() { const m = T.mock(); return { today: m.space.today.slice(0, 3).map((t) => t.id), folder: m.space.folders[0].id }; },

  // --- Security ---------------------------------------------------------------

  // Sanitizes, builds and renders every HTML payload, live, in a shadow root
  // and in the document, with a hostile view model. Returns, per payload,
  // what the sanitizer said and what the DOM audit found.
  runHtmlPayloads(manifest: string) {
    const results: { name: string, ok: boolean, removed: number, errors: string[], violations: string[] }[] = [];
    const mock = new MockState();
    const vm = { ...mock.vm, evil: EVIL_VM };
    const dispatch = createDispatcher({
      context: () => contextFromState(mock.state),
      run: (name, arg) => state.actions.push([name, arg]),
      log: (entry) => state.refused.push(entry),
    });
    for (const [name, fragment] of HTML_PAYLOADS) {
      const report = sanitizeTheme({ manifest, html: wrap(fragment), css: '', files: [] });
      const result = { name, ok: report.ok, removed: report.removed.length, errors: report.errors, violations: [] as string[] };
      if (report.tree) {
        const template = buildTemplate(report.tree);
        const el = host(400, 200);
        el.dataset.payload = name;
        const shadow = el.attachShadow({ mode: 'open' });
        const view = new View(shadow, template, { onAction: dispatch });
        view.update(vm);
        result.violations.push(...auditDom(shadow));
        state.views.push({ view, mock, el, target: shadow });
        // And in the document itself (where ids, forms and fonts are live).
        const inDoc = new View(document, buildTemplate(report.tree), { onAction: dispatch });
        inDoc.update(vm);
        state.views.push({ view: inDoc, mock, el: null, target: document });
      }
      results.push(result);
    }
    results.push({ name: '(every payload, in the document)', ok: true, removed: 0, errors: [], violations: auditDom(document.body) });
    return results;
  },

  // Each CSS payload, sanitized, adopted in a shadow root and in the
  // document, over elements its selectors aim at.
  runCssPayloads() {
    const results: { name: string, removed: number, errors: string[], css: string }[] = [];
    for (const [name, css] of CSS_PAYLOADS) {
      const r = sanitizeCss(css, { files: [] });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(r.css);
      const el = host(300, 100);
      el.dataset.payload = name;
      const shadow = el.attachShadow({ mode: 'open' });
      shadow.adoptedStyleSheets = [sheet];
      shadow.appendChild(target());
      document.body.appendChild(target());
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      results.push({ name, removed: r.removed.length, errors: r.errors, css: r.css.slice(0, 300) });
    }
    return results;
  },

  // Controls: prove the tripwire and the request watch see what they should.
  controlScript() {
    const div = document.createElement('div');
    div.innerHTML = `<img src="x" onerror="__trip('control')">`; // the control, deliberately unsanitized
    document.body.appendChild(div);
  },
  controlNetwork() {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('.control-net{background:url(https://evil.test/control.png)}');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    const d = document.createElement('div');
    d.className = 'control-net';
    d.style.cssText = 'width:10px;height:10px';
    document.body.appendChild(d);
  },
  tripped() { return w.__tripped.slice(); },

  // --- Timing -------------------------------------------------------------------

  // Sanitizing the package (no fonts, no DOM): median of `runs`, in ms.
  timeSanitize(pkg: PagePackage, runs = 50) {
    const p = unpack(pkg);
    const files = Object.keys(p.files);
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      const r = sanitizeTheme({ manifest: p.manifest, html: p.html, css: p.css, files });
      buildTemplate(r.tree!); // (the package is a good one: it has a tree)
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return times[runs >> 1];
  },

  // The smallest step performance.now() takes here.
  resolution() {
    let best = Infinity;
    for (let i = 0; i < 2000; i++) {
      const a = performance.now();
      let b = performance.now();
      while (b === a) b = performance.now();
      best = Math.min(best, b - a);
    }
    return { resolution: best, crossOriginIsolated: w.crossOriginIsolated === true };
  },

  // Times the renderer. `js`: the update call (all DOM writes); `layout`: the
  // update plus a forced style and layout (measuring <m-page>). One sample a
  // frame, after `warm` unrecorded ones. The view model is made before the
  // clock starts: that's the state mirror's work, not the renderer's. Where
  // the clock is coarse (WebKit's is 1 ms), a sample is `batch` views given
  // the same update back to back, and the time divided by `batch`.
  async bench({ runs = 50, warm = 5, batch = 1 } = {}) {
    const theme = state.theme as LoadedTheme; // (loadNeo first, with a package that loads)
    const out: Record<string, { js: number[], layout: number[] }> = {};
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    const record = (label: string, js: number, layout: number) => { (out[label] ??= { js: [], layout: [] }); out[label].js.push(js / batch); out[label].layout.push(layout / batch); };

    for (let i = 0; i < warm + runs; i++) {
      const mocks = Array.from({ length: batch }, () => new MockState());
      const els = mocks.map(() => host(1440, 900));
      const shadows = els.map((el) => el.attachShadow({ mode: 'open' }));
      await frame();
      const t0 = performance.now();
      const views = shadows.map((shadow, k) => { const view = new View(shadow, theme.template, { sheets: [theme.sheet] }); view.update(mocks[k].vm); return view; });
      const t1 = performance.now();
      for (const view of views) view.measure();
      const t2 = performance.now();
      if (i >= warm) record('first render, 200 tabs (compile + build)', t1 - t0, t2 - t0);
      views.forEach((view, k) => { view.destroy(); els[k].remove(); });
    }

    const live = (options: { rowPool?: number } = {}) => {
      const mock = new MockState();
      const el = host(1440, 900);
      const view = new View(el.attachShadow({ mode: 'open' }), theme.template, { sheets: [theme.sheet], ...options });
      view.update(mock.vm);
      view.measure();
      return { mock, view, el };
    };
    // Alternating ops: each step's label and the vm it renders.
    const series = async (steps: [label: string, make: (m: MockState, i: number) => ViewModel][], options?: { rowPool?: number }) => {
      const views = Array.from({ length: batch }, () => live(options));
      for (let i = 0; i < (warm + runs) * steps.length; i++) {
        const [label, make] = steps[i % steps.length];
        const vms = views.map((v) => make(v.mock, i));
        await frame();
        const t0 = performance.now();
        views.forEach((v, k) => v.view.update(vms[k]));
        const t1 = performance.now();
        for (const v of views) v.view.measure();
        const t2 = performance.now();
        if (i >= warm * steps.length) record(label, t1 - t0, t2 - t0);
      }
      for (const v of views) { v.view.destroy(); v.el.remove(); }
    };
    await series([['change one tab title', (m, i) => m.retitle(m.space.today[50].id as number, `Renamed tab ${i}`)]]);
    await series([['add 10 tabs', (m) => m.addTabs(10)], ['remove 10 tabs', (m) => m.removeTabs(10)]]);
    await series([['activate another tab', (m, i) => m.activate(m.space.today[i % 2 ? 10 : 20].id as number)]]);
    await series([['toggle a folder (20 tabs)', (m) => m.toggleFolder('personal-f0')]]);
    await series([['move one tab (1st to 120th and back)', (m, i) => (i % 2 ? m.moveTab(119, 0) : m.moveTab(0, 119))]]);
    await series([['switch space, 200 → 8 tabs', (m) => m.switchSpace('work')], ['switch space, 8 → 200 tabs (rows reused)', (m) => m.switchSpace('personal')]]);
    await series([['switch space, 8 → 200 tabs (no row pool)', (m) => m.switchSpace('personal')], ['(back to work, no pool)', (m) => m.switchSpace('work')]], { rowPool: 0 });
    await series([['open the palette', (m) => m.openPalette('q')], ['close the palette', (m) => m.closePalette()]]);
    delete out['(back to work, no pool)'];

    const stat = (list: number[]) => {
      const s = [...list].sort((a, b) => a - b);
      const at = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
      return { median: (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2, p95: at(0.95), max: s[s.length - 1], n: s.length };
    };
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { js: stat(v.js), layout: stat(v.layout) }]));
  },
};

// --- The runtime (ui/runtime.ts) with a mock host -------------------------------

// `host`, `mock`, `target` and `warnings` are set by mountRuntime and `theme` by loadBuiltin or loadPackage,
// before any step that reads them (null until then); `runtime` is null again once unmounted.
const rt: { runtime: Runtime | null, host: MockHost, mock: MockState, el: HTMLElement | null, target: Target, theme: ThemeResult, warnings?: string[] } = { runtime: null, host: null!, mock: null!, el: null, target: null!, theme: null! };

// (Named, the same object as T, for its type: Harness below.)
const withRuntime = Object.assign(T, {
  // Neubrutalism (or another built-in theme, with its font families) as a
  // built-in theme: its files read through readFile (here from the package
  // handed over, in the extension from its own URL).
  async loadBuiltin(pkg: PagePackage, id = 'neubrutalism', families = ['Archivo Black', 'Space Grotesk']) {
    const p = unpack(pkg);
    const text: Record<string, string> = { 'theme.json': p.manifest, 'theme.html': p.html, 'theme.css': p.css };
    const read: string[] = [];
    const theme = await loadBuiltinTheme(id, { readFile: async (path) => { read.push(path); return text[path] ?? p.files[path]; } });
    rt.theme = theme;
    return { ok: theme.ok, id: theme.ok ? theme.id : undefined, read, fontErrors: theme.ok ? theme.fontErrors : undefined, fonts: families.map((f) => document.fonts.check(`16px "${f}"`)) };
  },

  // `replies`: what the host answers a request of each type with (values);
  // `settings`: the stored settings changed first.
  mountRuntime({ width = 1440, height = 900, container = 'shadow', closed = true, platform = { browser: 'chrome', os: 'linux', marginFullscreen: true }, replies = {}, settings = null, mode = 'fullscreen', inNewTab = false, focusLauncherAtMount = undefined, warnings = null, staysOnScreen = false }: {
    width?: number, height?: number, container?: 'shadow' | 'document', closed?: boolean,
    platform?: { browser: string, os: string, marginFullscreen?: boolean }, replies?: Record<string, unknown>,
    settings?: Record<string, unknown> | null, mode?: 'fullscreen' | 'windowed' | 'inpage', inNewTab?: boolean,
    focusLauncherAtMount?: boolean, warnings?: unknown,
    staysOnScreen?: boolean,
  } = {}) {
    (T as typeof T & { unmountRuntime(): void }).unmountRuntime(); // (added with these steps)
    const mock = new MockState();
    if (settings) mock.state = { ...mock.state, settings: { ...mock.state.settings, ...settings } };
    const answers = { createSpace: () => ({ spaceId: 'studio' }), ...Object.fromEntries(Object.entries(replies).map(([k, v]) => [k, () => v])) };
    const host = Object.assign(createMockHost({ state: mock.state, windowId: 1, platform, mode, inNewTab, focusLauncherAtMount, replies: answers }), { staysOnScreen });
    let target: Target;
    let el: HTMLElement | null = null;
    if (container === 'document') {
      // The whole window, following its size (Margin.app's web view).
      document.documentElement.style.cssText = 'margin:0;height:100%';
      document.body.style.cssText = 'margin:0;height:100%';
      target = document;
    } else {
      el = hostElement(width, height);
      target = el.attachShadow({ mode: closed ? 'closed' : 'open' });
    }
    rt.warnings = [];
    // (A theme that loaded: the tests check that first.)
    const runtime = createRuntime({ host, theme: rt.theme as LoadedTheme, container: target, onWarn: (m) => rt.warnings!.push(m) });
    Object.assign(rt, { runtime, host, mock, el, target });
    w.__rt = rt;
    return true;
  },
  unmountRuntime() {
    if (!rt.runtime) return;
    rt.runtime.destroy();
    rt.el?.remove();
    rt.runtime = null;
    document.documentElement.style.cssText = '';
    document.body.style.cssText = '';
  },
  // A change to the stored state (a MockState op), handed to the host, with
  // every DOM mutation it made.
  rtChange(op: MockOp, ...args: unknown[]) {
    const root = rt.target.nodeType === 9 ? (rt.target as Document).body : rt.target;
    const mo = new MutationObserver(() => {});
    mo.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    (rt.mock[op] as (...a: unknown[]) => unknown)(...args);
    rt.host.setState(rt.mock.state);
    const records = mo.takeRecords();
    mo.disconnect();
    return { records: records.length, text: records.filter((r) => r.type === 'characterData').length };
  },
  rtSettings(patch: Record<string, unknown>) {
    rt.mock.state = { ...rt.mock.state, settings: { ...rt.mock.state.settings, ...patch } };
    rt.host.setState(rt.mock.state);
  },
  rtSent() { return rt.host.sent.map((s): [string, any] => [s.type, s.payload]); }, // (a request's type and payload, as the host has it)
  // iCloud Tabs as Margin.app's host keeps them (shared/cloud-tabs.ts cloudOf):
  // the fixture's (tests/fixtures/cloud-tabs.ts), or `raw`; with every DOM
  // mutation the change made. `edit(raw)` changes the fixture first.
  rtCloud(raw: unknown = null, edit: string | null = null) {
    const data = raw ?? cloudFixture(Date.now());
    if (edit) new Function('raw', edit)(data);
    const root = rt.target.nodeType === 9 ? (rt.target as Document).body : rt.target;
    const mo = new MutationObserver(() => {});
    mo.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    rt.mock.state = { ...rt.mock.state, cloudTabs: cloudOf(data) };
    rt.host.setState(rt.mock.state);
    const records = mo.takeRecords();
    mo.disconnect();
    return { records: records.length, added: records.reduce((n, r) => n + r.addedNodes.length, 0), text: records.filter((r) => r.type === 'characterData').length };
  },
  // Spaces across profiles as Margin.app's host keeps them (shared/across.ts acrossOf), or none.
  rtAcross(raw: unknown) {
    rt.mock.state = { ...rt.mock.state, across: raw ? acrossOf(raw) : null };
    rt.host.setState(rt.mock.state);
    return !!rt.mock.state.across;
  },
  // What's drawn at a point of the window: the element's classes, and its ancestors'.
  rtHitClasses(x: number, y: number) {
    let el = rt.target.elementFromPoint(x, y);
    const out: string[] = [];
    for (; el && out.length < 12; el = el.parentElement ?? (el.getRootNode() as Partial<ShadowRoot>)?.host ?? null) out.push(el.localName + (el.className && typeof el.className === 'string' ? `.${el.className.split(/\s+/).join('.')}` : ''));
    return out;
  },
  rtOrder(a: string, b: string) { const x = rt.target.querySelector(a); const y = rt.target.querySelector(b); return x && y ? x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? 'before' : 'after' : null; },
  rtClosest(selector: string, ancestor: string) { return [...rt.target.querySelectorAll(selector)].some((el) => el.closest(ancestor)); },
  rtSetScroll(selector: string, px: number) { const el = rt.target.querySelector(selector)!; el.scrollTop = px; return el.scrollTop; },
  rtSetUi(patch: Partial<UiState>) { rt.runtime!.setUi(patch); return true; },
  rtWarnings() { return rt.warnings!.slice(); },
  rtPerformedFull() { return rt.host.performed.map((p) => [p.name, p.arg ?? null]); },
  rtAttr(selector: string, name: string, nth = 0) { return rt.target.querySelectorAll(selector)[nth]?.getAttribute(name) ?? null; },
  rtActive() { const el = rt.target.activeElement; return el ? el.getAttribute('m-input') ?? el.localName : null; },
  // Margin's renderer on its own, given a template that never went through
  // the sanitizer: a menu, a notice and a slot's own content holding the
  // theme's words. Only the bound labels may show.
  guardedRaw() {
    const el = (name: string, attrs: [string, string][], ...children: CleanNode[]): CleanNode => ({ type: 'el', ns: 'html', name, attrs, children });
    const text = (value: string): CleanNode => ({ type: 'text', value });
    const tree: { type: 'root', children: CleanNode[] } = { type: 'root', children: [el('div', [['class', 'g']],
      el('m-page', []),
      el('m-menu', [['title', 'Delete']]),
      el('m-notice', []),
      el('m-prompt', [['aria-label', 'Install now']], el('b', [], text('Install Margin.app now'))),
      el('template', [['m-part', 'menu']], el('div', [['class', 'menu'], ['aria-label', 'Delete everything']],
        el('button', [['class', 'fake'], ['title', 'Deletes all your tabs']], text('Delete')),
        el('m-for', [['each', 'menu.items'], ['as', 'i']], el('button', [['class', 'item'], ['m-action', 'menu.run'], ['m-arg', '{{i.id}}']], text('Remove: {{i.label}}'))),
        el('svg', [['viewBox', '0 0 10 10']], { type: 'el', ns: 'svg', name: 'path', attrs: [['d', 'M1 1h8']], children: [] }))),
      el('template', [['m-part', 'notice']], el('div', [['class', 'notice'], ['title', 'Margin needs your password']], text('Update required. {{notice.text}}'))),
    )] };
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:300px';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const warnings: string[] = [];
    const view = new View(shadow, buildTemplate(tree), { onWarn: (m) => warnings.push(m) });
    view.update({ menu: { label: 'Tab', items: [{ id: 'i0', label: 'Close Tab' }] }, notice: { text: 'Margin works in full screen.' }, prompt: { text: 'x' } });
    const shown = (sel: string) => { const n = shadow.querySelector(sel); return n ? n.textContent!.replace(/\s+/g, ' ').trim() : null; };
    const attrs = [...shadow.querySelectorAll('*')].flatMap((n) => ['title', 'aria-label', 'alt', 'placeholder'].filter((a) => n.hasAttribute(a)).map((a) => `${n.localName}@${a}=${n.getAttribute(a)}`));
    const result = { menu: shown('m-menu'), notice: shown('m-notice'), prompt: shown('m-prompt'), attrs, paths: shadow.querySelectorAll('m-menu path').length, warnings };
    view.destroy();
    host.remove();
    return result;
  },
  rtLayouts() { return rt.host.layouts.map((l) => ({ ...l.insets, radius: l.radius, width: l.container.width, height: l.container.height, windowId: l.windowId, mode: l.mode })); },
  rtRefused() { return rt.runtime!.refused.map((r) => [r.name, r.reason]); },
  rtPerformed() { return rt.host.performed.map((p) => p.name); },
  rtUi() { const { palette, sidebar, editing, menu, editor, switchingTo } = rt.runtime!.ui; return { palette, sidebar, editing, menu, editor, switchingTo }; },
  // --- The behaviors (tests/theme/behaviors.test.ts) ---
  rtPointer(x: number, y: number) { rt.runtime!.pointer({ x, y }); },
  rtPointerLeft(x: number, y: number) { rt.runtime!.pointerLeft({ x, y }); },
  rtVmFull() { const vm = rt.runtime!.vm!; return { sidebar: vm.window.sidebar, space: vm.space.id, query: vm.palette.query, rows: vm.palette.rows.map((r) => r.title), rowIds: vm.palette.rows.map((r) => r.id), selected: vm.palette.selected, menu: vm.menu?.items.map((i) => i.label) ?? null, editing: vm.editing, editor: vm.editor && { name: vm.editor.name, color: vm.editor.color, deleteLabel: vm.editor.deleteLabel }, settings: vm.settings, folders: vm.space.folders.map((f) => [f.id, f.name, f.open]), spaceName: vm.space.name }; },
  // What has the focus in the UI.
  rtFocus() {
    const el = rt.target.activeElement as (HTMLElement & { value?: string }) | null;
    if (!el) return null;
    return { tag: el.localName, cls: el.className && typeof el.className === 'string' ? el.className : '', input: el.getAttribute('m-input'), editable: el.isContentEditable, value: el.value ?? null, text: el.textContent.trim().slice(0, 60) };
  },
  rtRect(selector: string, nth = 0) {
    const el = rt.target.querySelectorAll(selector)[nth];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  },
  // The middle of the element of `selector` whose text is `text`.
  rtBoxText(selector: string, text: string) {
    const el = [...rt.target.querySelectorAll(selector)].find((e) => e.textContent!.trim() === text);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  },
  // What's under a point of the window (inside the runtime's root, past the host page), for a test's message: the
  // element's tag and classes, and those of the nearest space chip, row or folder it's in.
  rtAt(x: number, y: number) {
    const el = (rt.target.elementFromPoint ? rt.target.elementFromPoint(x, y) : document.elementFromPoint(x, y)) ?? null;
    const describe = (e: Element | null) => (e ? `${e.localName}${e.classList?.length ? `.${[...e.classList].join('.')}` : ''}` : null);
    return { at: describe(el), in: describe(el?.closest?.('.chip, .tab, .folder-head') ?? null), viewport: [innerWidth, innerHeight] };
  },
  rtClasses(selector: string, nth = 0) { const el = rt.target.querySelectorAll(selector)[nth]; return el ? [...el.classList] : null; },
  rtMarked() { return ['m-dragging', 'm-drop-before', 'm-drop-after', 'm-drop-into', 'm-drop-end', 'm-drag-ghost'].map((c) => [c, rt.target.querySelectorAll(`.${c}`).length]).filter(([, n]) => n); },
  rtScrollTop(selector: string) { return rt.target.querySelector(selector)?.scrollTop ?? null; },
  rtStyle(selector: string, prop: string) { const el = rt.target.querySelector<HTMLElement>(selector); return el ? el.style.getPropertyValue(prop) : null; },
  rtSentClear() { rt.host.sent.length = 0; rt.host.layouts.length = 0; },
  rtLayoutsAll() { return rt.host.layouts.map((l) => l.insets.left); },
  rtState() { return rt.mock.state; },
  // A trackpad's sideways scroll over an element: `count` wheel events of
  // `dx` px, 16 ms apart (Playwright's own wheel is a mouse's).
  async rtTrackpad(selector: string, dx: number, count: number) {
    const el = rt.target.querySelector(selector)!;
    for (let i = 0; i < count; i++) {
      el.dispatchEvent(new WheelEvent('wheel', { deltaX: dx, deltaY: 0, deltaMode: 0, bubbles: true, cancelable: true, composed: true }));
      await new Promise((r) => setTimeout(r, 16));
    }
  },
  // The background's answer to a request, as storage brings it back.
  rtApply(op: MockOp, ...args: unknown[]) { (rt.mock[op] as (...a: unknown[]) => unknown)(...args); rt.host.setState(rt.mock.state); },
  // Every tab of the window loading, or none (Margin.app's host marks them from the copy's `loading` push).
  rtLoading(on: boolean) {
    const tabs: Record<number, MockTab> = Object.fromEntries(Object.entries(rt.mock.state.tabs).map(([id, t]) => [id, { ...t, loading: !!on }]));
    rt.mock.state = { ...rt.mock.state, tabs };
    rt.host.setState(rt.mock.state);
    return Object.values(tabs).filter((t) => t.loading).length;
  },
  rtComputed(selector: string, prop: string) { const el = rt.target.querySelector(selector); return el ? getComputedStyle(el).getPropertyValue(prop) : null; },
  // Whether an element is drawn: in the layout, not hidden, not transparent.
  // Drawn, whatever its opacity this instant: for what blinks (Pixel's cursors), which rtVisible would call hidden
  // in the half of the blink it's faded out.
  rtShown(selector: string) {
    const el = rt.target.querySelector(selector);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility === 'visible' && s.display !== 'none';
  },
  rtVisible(selector: string) {
    const el = rt.target.querySelector(selector);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility === 'visible' && Number(s.opacity) > 0 && s.display !== 'none';
  },
  rtFolderRename(folderId: string, name: string) { rt.mock.state = { ...rt.mock.state, folders: rt.mock.state.folders.map((f) => (f.id === folderId ? { ...f, name } : f)) }; rt.host.setState(rt.mock.state); },
  rtVm() { const vm = rt.runtime!.vm!; return { space: vm.space.id, sidebar: vm.window.sidebar, palette: vm.palette.open, rows: vm.palette.rows.length, today: vm.space.today.length }; },
  rtCount(selector: string) { return rt.target.querySelectorAll(selector).length; },
  rtText(selector: string) { return [...rt.target.querySelectorAll(selector)].map((e) => e.textContent!.trim()); },
  rtTodayIds(n = 3) { return rt.runtime!.vm!.space.today.slice(0, n).map((t) => t.id); },
  rtDispatch(name: string, arg?: unknown) { return rt.runtime!.dispatch(name, arg); },
  // Where to click an element (the shadow root is closed: clicks go by
  // position), scrolled into view in its list first.
  rtBox(selector: string, nth = 0) {
    const el = rt.target.querySelectorAll(selector)[nth];
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  },
});

function hostElement(width: number, height: number) { return host(width, height); }

// The CSS payloads' target, built with DOM APIs.
function target() {
  const div = document.createElement('div');
  div.className = 'a b tab';
  div.title = 'a secret title';
  div.dataset.url = 'https://bank.example/account';
  div.append('text');
  for (const v of ['a', 'b']) { const i = document.createElement('input'); i.className = 'a'; i.value = v; i.setAttribute('value', v); div.appendChild(i); }
  void CSS_TARGET;
  return div;
}

// --- The security suite (tests/theme/security.test.ts) ------------------------

const withSecurity = Object.assign(withRuntime, {
  // Any package (a built-in's or a user's) loaded as the overlay loads one.
  async loadPackage(pkg: PagePackage) {
    const theme = await loadTheme(unpack(pkg));
    if (theme.ok) rt.theme = theme;
    return { ok: theme.ok, id: theme.ok ? theme.id : null, errors: theme.report.errors, removed: theme.report.removed.length, fontErrors: theme.ok ? theme.fontErrors : [] };
  },
  // The mounted theme fed hostile data where the view model's text, links
  // and icons come from: titles that are markup, addresses that are scripts,
  // icons from elsewhere; the palette open on such a query, Settings open.
  rtHostile() {
    const ids = rt.runtime!.vm!.space.today.slice(0, 5).map((t) => t.id as number); // (open tabs: the browser's ids)
    const [a, b, c] = ids;
    rt.mock.tabs((tabs) => {
      for (const id of ids) tabs[id] = { ...tabs[id], title: EVIL_VM.html, url: EVIL_VM.url, favIconUrl: EVIL_VM.remote };
      if (b) tabs[b] = { ...tabs[b], url: 'https://evil.test/{{tab.url}}', title: EVIL_VM.moustache };
      if (c) tabs[c] = { ...tabs[c], title: `${EVIL_VM.cls}\u202E${EVIL_VM.js}` };
      return tabs;
    });
    void a;
    rt.host.setState(rt.mock.state);
    rt.runtime!.openPalette({ newTab: false });
    rt.runtime!.setUi({ palette: { ...rt.runtime!.ui.palette, query: EVIL_VM.html } });
    return { audit: auditDom(rt.target.nodeType === 9 ? (rt.target as Document).body : rt.target), tripped: w.__tripped.slice() };
  },
  // Template and stylesheet payloads handed in from Node ([name, text] pairs),
  // sanitized and rendered in the document (where ids are the window's) with
  // the hostile view model, as runHtmlPayloads and runCssPayloads do.
  runPayloads(manifest: string, templates: [name: string, fragment: string][], sheets: [name: string, css: string][]) {
    const mock = new MockState();
    const vm = { ...mock.vm, evil: EVIL_VM };
    const out: ({ name: string, violations: string[] } | { name: string, css: string })[] = [];
    for (const [name, fragment] of templates) {
      const report = sanitizeTheme({ manifest, html: wrap(fragment), css: '', files: [] });
      if (report.tree) {
        const view = new View(document, buildTemplate(report.tree), { onAction: () => false });
        view.update(vm);
        state.views.push({ view, mock, el: null, target: document });
      }
      out.push({ name, violations: auditDom(document.body) });
    }
    for (const [name, css] of sheets) {
      const r = sanitizeCss(css, { files: [] });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(r.css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      const el = target();
      el.innerHTML += '<ul class="a"><li>x</li></ul>';
      document.body.appendChild(el);
      out.push({ name, css: r.css.slice(0, 300) });
    }
    return out;
  },
  // The page's own globals, as the overlay reads them (a theme's ids mustn't change them).
  globals() { const named = w as unknown as Record<string, unknown>; return ['webkit', 'marginApp', 'browser', 'chrome', 'safari', 'Margin', 'T'].map((n) => [n, typeof named[n] === 'object' && named[n] instanceof Element ? 'element' : typeof named[n]]); },
});

w.T = T;

// What the tests' page functions see on the window (declared in each test file that reads them).
export type Harness = typeof withSecurity;
// (`__rt` as the tests read it: once mounted and drawn, its runtime and view model there.)
export type HarnessRt = Omit<typeof rt, 'runtime'> & { runtime: Runtime & { readonly vm: NonNullable<Runtime['vm']> } };
