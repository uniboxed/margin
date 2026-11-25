// The browser side of the theme tests and the benchmark, bundled into one
// script (tests/theme/package.ts harnessScript) and added to a blank page.
// Node drives it with page.evaluate through `window.T`.
import { sanitizeCss } from '../../app/shared/ui/sanitize.ts';
import { buildTemplate, View } from '../../app/shared/ui/render.ts';
import { loadTheme, loadBuiltinTheme, sanitizeTheme } from '../../app/shared/ui/theme-loader.ts';
import { createRuntime } from '../../app/shared/ui/runtime.ts';
import { createMockHost } from '../../app/shared/ui/host.ts';
import { cornerFill, hitRects, sidebarFixed } from '../../app/shared/ui/host-app.ts';
import { createDispatcher, contextFromState } from '../../app/shared/ui/actions.ts';
import { MockState } from './view-model.ts';
import { auditDom } from './audit.ts';
import { HTML_PAYLOADS, CSS_PAYLOADS, CSS_TARGET, EVIL_VM, wrap } from './payloads.ts';
import type { LoadedTheme, ThemePackage } from '../../app/shared/ui/theme-loader.ts';
import type { Layout } from '../../app/shared/ui/render.ts';
import type { CleanNode } from '../../app/shared/ui/sanitize.ts';
import type { UiState, ViewModel } from '../../app/shared/ui/view-model.ts';
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
const rt: { runtime: Runtime | null, host: MockHost, mock: MockState, el: HTMLElement | null, target: Target, theme: ThemeResult, warnings?: string[], resizing: [boolean, number | null][], notes: string[], materials: boolean[] } = { runtime: null, host: null!, mock: null!, el: null, target: null!, theme: null!, resizing: [], notes: [], materials: [] };

const starting = () => rt.runtime!.view.rootElement()?.hasAttribute('m-starting') ?? false;
function startEmpty(pageState: 'empty' | 'loading' | 'shown', name: string | null) {
  (T as typeof T & { unmountRuntime(): void }).unmountRuntime();
  const mock = new MockState();
  const hosted = pageState !== 'empty';
  const host = Object.assign(createMockHost({ state: null as any, windowId: 1, platform: { browser: 'safari', os: 'mac' }, mode: 'fullscreen' }),
    { appWindow: true, launcher: !hosted, pageHosted: hosted, sidebarDocked: hosted, inNewTab: false, pageState, pageOpening: pageState === 'loading' ? name : null });
  document.documentElement.style.cssText = 'margin:0;height:100%';
  document.body.style.cssText = 'margin:0;height:100%';
  const runtime = createRuntime({ host, theme: rt.theme as LoadedTheme, container: document });
  Object.assign(rt, { runtime, host, mock, el: null, target: document });
  w.__rt = rt;
  return starting();
}
function arrive() {
  rt.host.setState(rt.mock.state);
  return starting();
}

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
  mountRuntime({ width = 1440, height = 900, container = 'shadow', closed = true, platform = { browser: 'chrome', os: 'linux', marginFullscreen: true }, replies = {}, settings = null, mode = 'fullscreen', inNewTab = false, focusLauncherAtMount = undefined, warnings = null, staysOnScreen = false, appWindow = false, hosted = false, materials = null, pictures = false }: {
    width?: number, height?: number, container?: 'shadow' | 'document', closed?: boolean,
    platform?: { browser: string, os: string, marginFullscreen?: boolean }, replies?: Record<string, unknown>,
    settings?: Record<string, unknown> | null, mode?: 'fullscreen' | 'windowed' | 'inpage', inNewTab?: boolean,
    focusLauncherAtMount?: boolean, warnings?: unknown,
    staysOnScreen?: boolean,
    // Margin.app's own window with nothing hosted beside it (ui/host-app.ts): its page area is the launcher.
    appWindow?: boolean,
    // Margin.app's own window hosting another app's window in its page area (`pageHosted`): the sidebar docked, no
    // launcher, the theme's root marked as the app's page marks it (app/shared/host/overlay.ts followOutside), the
    // page card `shown` (ui/host-app.ts pageState: `rtPageState` changes it).
    hosted?: boolean,
    // A host with the system's materials (Margin.app's, for Edit Theme Color's glass): it answers each ask after this
    // many ms (no glass here: Playwright's browsers don't know the property); the asks, in order: `rtMaterials`.
    materials?: number | null,
    // A host that serves spaces' pictures (Margin.app's, M2.9 step 7): every id is the page's `__testPicture` (a data:
    // URL the test made); without, none is served (a browser's extension).
    pictures?: boolean,
  } = {}) {
    (T as typeof T & { unmountRuntime(): void }).unmountRuntime(); // (added with these steps)
    const mock = new MockState();
    if (settings) mock.state = { ...mock.state, settings: { ...mock.state.settings, ...settings } };
    const answers = { createSpace: () => ({ spaceId: 'studio' }), ...Object.fromEntries(Object.entries(replies).map(([k, v]) => [k, () => v])) };
    const host = Object.assign(createMockHost({ state: mock.state, windowId: 1, platform, mode, inNewTab, focusLauncherAtMount, replies: answers }), { staysOnScreen }, hosted ? { appWindow: true, pageHosted: true, pageOutside: false, sidebarDocked: true, launcher: false, inNewTab: false, pageState: 'shown' as const, pageOpening: null }
      : appWindow ? { appWindow: true, launcher: true, inNewTab: false, pageState: 'empty' as const, pageOpening: null } : {});
    // (Each word of a width change to the host, with the page's left inset it had last been told by then.)
    const perform = host.perform;
    host.perform = (name: string, arg?: any) => { if (name === 'sidebar.resizing') rt.resizing.push([arg?.on === true, host.layouts.at(-1)?.insets.left ?? null]); return perform(name, arg); };
    rt.resizing = [];
    // (Margin.app's log lines from the page, `note`: as said, in order.)
    rt.notes = [];
    Object.assign(host, { note: (text: string) => { rt.notes.push(text); } });
    if (pictures) Object.assign(host, { pictureUrl: () => ((window as unknown as { __testPicture?: string }).__testPicture ?? null) });
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
    rt.materials = [];
    const runtime = createRuntime({
      host, theme: rt.theme as LoadedTheme, container: target, onWarn: (m) => rt.warnings!.push(m),
      ...(materials == null ? {} : { materials: (on: boolean) => { rt.materials.push(on); return new Promise<void>((done) => setTimeout(done, materials)); } }),
    });
    Object.assign(rt, { runtime, host, mock, el, target });
    if (hosted) runtime.view.rootElement()?.toggleAttribute('m-sidebar-fixed', sidebarFixed(host as { pageOutside?: boolean }));
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
  // What's drawn at a point of the window: the element's classes, and its ancestors'.
  rtHitClasses(x: number, y: number) {
    let el = rt.target.elementFromPoint(x, y);
    const out: string[] = [];
    for (; el && out.length < 12; el = el.parentElement ?? (el.getRootNode() as Partial<ShadowRoot>)?.host ?? null) out.push(el.localName + (el.className && typeof el.className === 'string' ? `.${el.className.split(/\s+/).join('.')}` : ''));
    return out;
  },
  // Every element at a point that takes it (elementsFromPoint: what paints there and isn't pointer-events: none), by name.
  rtElementsAt(x: number, y: number) { return (rt.target as Document | ShadowRoot).elementsFromPoint(x, y).map((e) => e.localName); },
  // `<m-page>` (and so all it draws: a split's dividers and bands, a pane's loader) hidden or shown again, for a picture
  // of what the rest of the page paints.
  rtPageHidden(on: boolean) { const p = rt.target.querySelector('m-page') as HTMLElement | null; if (p) { if (on) p.style.setProperty('visibility', 'hidden'); else p.style.removeProperty('visibility'); } },
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
  // Margin.app's own window: what's drawn around <m-page>'s rounded corners (ui/host-app.ts cornerFill), and each corner's inner radius.
  rtCornerFill() { return cornerFill(rt.target.querySelector('m-page')); },
  // A space's background (M2.9): what Margin's layer has drawn, the page's corners as Margin.app is told them (with
  // its ground), the variables as the theme's root computes them.
  rtBackground() { return rt.runtime!.backgroundDrawn(); },
  rtCornerFillGround() { return cornerFill(rt.target.querySelector('m-page'), { ground: rt.runtime!.backgroundAt }); },
  rtBackgroundAt(x: number, y: number) { return rt.runtime!.backgroundAt(x, y); },
  // Edit Theme Color (M2.9 step 4): its parts (boxes and states: its content is closed), whether it's open and where.
  rtPicker() { return rt.runtime!.pickerParts(); },
  // … and what it asked of a host with the system's materials (mountRuntime's `materials`): true on, false off, in order.
  rtMaterials() { return [...rt.materials]; },
  rtPanel() { return { open: rt.runtime!.panelOpen, rect: rt.runtime!.panelRect() }; },
  rtVars(names: string[]) {
    const root = rt.runtime!.view.rootElement();
    if (!root) return null;
    const cs = getComputedStyle(root);
    return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]));
  },
  // Margin.app's own window: the page card's state as the app says it (ui/host-app.ts pageState), drawn again.
  // `empty`: nothing hosted (the launcher); `loading`: an item opening (`name`; `bundleId`: the app whose icon the
  // loader shows, looked up in the state's `apps`: rtApps); `shown`: a hosted window shows through.
  rtPageState(state: 'empty' | 'loading' | 'shown' | 'elsewhere', name: string | null = null, bundleId: string | null = null) {
    const named = state === 'loading' || state === 'elsewhere';
    // (`elsewhere`: not hosting, its item in another Margin window: its card, the sidebar still docked, no launcher.)
    Object.assign(rt.host, { pageState: state, pageOpening: named ? name : null, pageOpeningBundleId: named ? bundleId : null, pageHosted: state !== 'empty', sidebarDocked: state !== 'empty', launcher: state === 'empty' });
    rt.runtime!.render();
    const root = rt.runtime!.view.rootElement();
    const loader = root?.querySelector('m-page-loader');
    return { attr: root?.getAttribute('m-page-state') ?? null, starting: root?.hasAttribute('m-starting') ?? null, loader: loader ? { own: !loader.hasAttribute('m-default'), text: loader.textContent ?? '' } : null };
  },
  // Margin's start screen (ui/runtime.ts followStartup): the page `loading` as Margin starts (host.pageStarting), held
  // up with `stuck` (host.pageStuck; null: not), drawn again. Answers `<m-startup>`'s box, what's on top at a few points
  // (whether each is it or inside it), its words, its buttons' labels and boxes, the root's `m-startup`, its own
  // spinner's display, and whether its `::before` and `::after` draw (a theme's marks); null for the element if none.
  rtStartup(stuck: string | null) {
    Object.assign(rt.host, { pageState: 'loading', pageOpening: 'Getting you started', pageOpeningBundleId: 'com.apple.Safari', pageStarting: true, pageStuck: stuck, pageHosted: true, sidebarDocked: true, launcher: false });
    rt.runtime!.render();
    const root = rt.runtime!.view.rootElement() as HTMLElement | null;
    const el = root?.querySelector(':scope > m-startup') as HTMLElement | null;
    if (!el) return { el: null, attr: root?.hasAttribute('m-startup') ?? null };
    const r = el.getBoundingClientRect();
    const doc = el.ownerDocument;
    const at = (x: number, y: number) => { const top = (doc.elementFromPoint(x, y) as Element | null); return !!top && (top === el || el.contains(top)); };
    const w = doc.documentElement.clientWidth, h = doc.documentElement.clientHeight;
    const draws = (pseudo: string) => { const c = getComputedStyle(el, pseudo); return c.content !== 'none' && c.content !== 'normal' && c.display !== 'none'; };
    const spin = el.querySelector('[m-startup-spin]');
    return {
      el: { left: r.left, top: r.top, width: r.width, height: r.height },
      attr: root?.hasAttribute('m-startup') ?? null,
      onTop: [[40, h / 2], [w / 2, h / 2], [w - 10, 10], [10, h - 10], [w - 10, h - 10]].map(([x, y]) => at(x, y)),
      text: (el.querySelector('[m-startup-text]')?.textContent ?? '').trim(),
      allText: (el.textContent ?? '').trim(),
      buttons: [...el.querySelectorAll('[m-startup-action]')].map((b) => { const br = b.getBoundingClientRect(); return { label: (b.textContent ?? '').trim(), action: b.getAttribute('m-startup-action'), x: br.left + br.width / 2, y: br.top + br.height / 2, inside: br.left >= 0 && br.top >= 0 && br.right <= w && br.bottom <= h && br.width > 0 && br.height > 0 }; }),
      spin: spin ? getComputedStyle(spin).display : null,
      before: draws('::before'),
      after: draws('::after'),
    };
  },
  // `elsewhere` with a web item's picture (host.pagePicture, ui/host-app.ts): a solid red picture (made here, a PNG
  // data URL; null: none), drawn again. Answers Margin's <m-page-picture>: its box, how it's drawn, its image's and its
  // words', and whether the root says `m-page-picture`; null for the element when there's none.
  async rtPagePicture(on: boolean) {
    let data: string | null = null;
    if (on) {
      const c = document.createElement('canvas');
      c.width = 160; c.height = 100;
      const g = c.getContext('2d')!;
      g.fillStyle = '#e00000';
      g.fillRect(0, 0, c.width, c.height);
      data = c.toDataURL('image/png');
    }
    Object.assign(rt.host, { pagePicture: data });
    rt.runtime!.render();
    const root = rt.runtime!.view.rootElement() as HTMLElement | null;
    const el = root?.querySelector('m-page-picture') as HTMLElement | null;
    const img = el?.querySelector('img') as HTMLImageElement | null;
    await img?.decode().catch(() => undefined);
    const label = el?.querySelector('[m-picture-label]') as HTMLElement | null;
    const box = (n: Element) => { const b = n.getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; };
    return {
      attr: root?.hasAttribute('m-page-picture') ?? false,
      el: el ? {
        box: box(el), zIndex: getComputedStyle(el).zIndex, pointer: getComputedStyle(el).pointerEvents, last: root?.lastElementChild === el,
        img: img ? { src: img.getAttribute('src') === data, complete: img.complete, opacity: Number(getComputedStyle(img).opacity), box: box(img) } : null,
        label: label ? { text: label.textContent ?? '', font: getComputedStyle(label).fontFamily, visible: getComputedStyle(label).display !== 'none' && label.getBoundingClientRect().width > 0, box: box(label) } : null,
        moving: el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length,
      } : null,
    };
  },
  // A runtime mounted in the whole window with no state yet (a hello without one): the root says `m-starting`, and
  // the theme draws its skeleton. `pageState`: the page card's then (`empty`: nothing hosted yet). `rtArrive` gives
  // it its state. Both answer whether the root says `m-starting`.
  rtStartEmpty(pageState: 'empty' | 'loading' | 'shown' = 'empty', name: string | null = null) { return startEmpty(pageState, name); },
  rtArrive() { return arrive(); },
  // … then the state: whether the root says `m-starting` before the data, in the frame it's drawn, and a frame after.
  async rtStartLate() {
    const before = startEmpty('empty', null);
    const drawn = arrive();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 150));
    return { before, drawn, after: starting() };
  },
  // The default loader's box and how it's drawn now (null: none in the tree).
  // Margin.app's installed apps, as its hello gives them (ui/host-app.ts: the state's `apps`), drawn again.
  rtApps(apps: { bundleId: string, name: string, icon: string | null }[] | null) {
    rt.mock.state = { ...rt.mock.state, apps } as MockState['state'];
    rt.host.setState(rt.mock.state);
    rt.runtime!.render();
    return true;
  },
  // The images in the page loader, once each is decoded: its address, its natural and drawn size, how it's scaled, and
  // whether it or anything around it in the loader moves.
  async rtLoaderIcons() {
    const loader = rt.runtime!.view.rootElement()?.querySelector('m-page-loader');
    const imgs = [...(loader?.querySelectorAll('img') ?? [])] as HTMLImageElement[];
    await Promise.all(imgs.map((i) => i.decode().catch(() => undefined)));
    return imgs.map((i) => {
      const b = i.getBoundingClientRect(), cs = getComputedStyle(i);
      return { src: i.getAttribute('src'), complete: i.complete, natural: [i.naturalWidth, i.naturalHeight], size: [b.width, b.height], rendering: cs.imageRendering, visible: cs.visibility === 'visible' && Number(cs.opacity) > 0 && b.width > 0, at: [b.left, b.top, b.right, b.bottom] };
    });
  },
  rtLoader() {
    const el = rt.runtime!.view.rootElement()?.querySelector('m-page-loader') as HTMLElement | null;
    if (!el) return null;
    const b = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return { left: b.left, top: b.top, width: b.width, height: b.height, opacity: Number(cs.opacity), visibility: cs.visibility, pointer: cs.pointerEvents, background: cs.backgroundColor, radius: cs.borderTopLeftRadius, transition: cs.transitionDuration, own: !el.hasAttribute('m-default'), text: el.textContent ?? '' };
  },
  rtRadii() { return rt.host.layouts.at(-1)?.radii ?? null; },
  // The animations and transitions under way in the document: each one's name (a transition's: its property), whether
  // its element is the page loader's slot or in it (`pseudo`: one of the element's own boxes), what it changes, and
  // whether it's running.
  rtAnimations() {
    const meta = new Set(['offset', 'easing', 'composite', 'computedOffset']);
    return document.getAnimations().map((a) => {
      const effect = a.effect as KeyframeEffect | null;
      const css = a as Animation & { animationName?: string, transitionProperty?: string };
      return {
        name: css.animationName ?? `transition:${css.transitionProperty ?? ''}`,
        loader: !!effect?.target?.closest('m-page-loader'),
        pseudo: effect?.pseudoElement ?? null,
        props: [...new Set((effect?.getKeyframes() ?? []).flatMap((k) => Object.keys(k)))].filter((k) => !meta.has(k)).sort(),
        running: a.playState === 'running',
      };
    });
  },
  // One of an element's own boxes (`::before`, `::after`): whether it's drawn (its `content`), its size and its animation.
  rtPseudo(selector: string, pseudo: string) {
    const el = rt.target.querySelector(selector);
    if (!el) return null;
    const cs = getComputedStyle(el, pseudo);
    return { content: cs.content, width: parseFloat(cs.width) || 0, height: parseFloat(cs.height) || 0, animation: cs.animationName, background: cs.backgroundColor };
  },
  rtRefused() { return rt.runtime!.refused.map((r) => [r.name, r.reason]); },
  rtPerformed() { return rt.host.performed.map((p) => p.name); },
  // A trackpad's phase told while reading the swipe's moving part just before and just after, in one task (the browser's
  // animation time is the same for both reads): where it's drawn, whether it's settling, and the space shown.
  // The phase sent `frames` frames from now (in that frame's callback), read before and after, each read with its time
  // (`at`, ms); `prev`, the same read a frame earlier. WebKit reads a running transition at the moment it's read, so
  // the behavior's own read (inside the dispatch) is a little further on than `before` on a busy machine (1.65 px in
  // the gate of 2026-11-22): a test allows the settle's speed (prev to before) over the time the dispatch took.
  rtPhaseRead(selector: string, phase: string, frames = 1) {
    const el = rt.target.querySelector(selector) as HTMLElement;
    const read = () => {
      const pane = el.querySelector('.space-pane:not(.m-swipe-ghost)');
      const m = pane ? /matrix\(([^)]+)\)/.exec(getComputedStyle(pane).transform) : null;
      return { drawn: m ? parseFloat(m[1].split(',')[4]) : 0, at: performance.now(), settling: el.classList.contains('m-settling'), swiping: el.classList.contains('m-swiping'), space: (rt.runtime!.vm as any)?.space?.id as string };
    };
    type Read = ReturnType<typeof read>;
    return new Promise<{ prev: Read, before: Read, after: Read }>((done) => {
      let prev = read();
      const frame = (k: number) => requestAnimationFrame(() => {
        if (k > 1) { prev = read(); return frame(k - 1); }
        const before = read();
        document.dispatchEvent(new CustomEvent('m-wheel-phase', { detail: { phase } }));
        done({ prev, before, after: read() });
      });
      frame(Math.max(1, frames));
    });
  },
  // Wheel events over `selector` all in one task (no frame between them), the haptic ticks asked for by its end.
  rtTrackpadNow(selector: string, deltas: number[]) {
    const el = rt.target.querySelector(selector)!;
    const t0 = performance.now();
    for (const dx of deltas) el.dispatchEvent(new WheelEvent('wheel', { deltaX: dx, deltaY: 0, deltaMode: 0, bubbles: true, cancelable: true, composed: true }));
    return { ticks: rt.host.performed.filter((p) => p.name === 'haptic.alignment').length, ms: performance.now() - t0 };
  },
  rtFrames(n: number) { return new Promise<void>((done) => { const f = (k: number) => (k ? requestAnimationFrame(() => f(k - 1)) : done()); f(n); }); },
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
  // The host told a change of the sidebar's width began (true) or is over (false), each with the last left inset reported by then.
  rtResizing() { return rt.resizing.slice(); },
  rtDisplay(selector: string) { const el = rt.target.querySelector(selector); return el ? getComputedStyle(el).display : null; },
  rtState() { return rt.mock.state; },
  // A trackpad's sideways scroll over an element: `count` wheel events of
  // `dx` px, 16 ms apart (Playwright's own wheel is a mouse's).
  // A trackpad's phase as Margin.app tells it (app/shared/host/overlay.ts `m-wheel-phase`).
  rtWheelPhase(phase: string) { document.dispatchEvent(new CustomEvent('m-wheel-phase', { detail: { phase } })); },
  // Wheel events of these deltas over `selector`, `gap` ms apart.
  async rtTrackpadRun(selector: string, deltas: number[], gap = 16) {
    const el = rt.target.querySelector(selector)!;
    for (const dx of deltas) {
      el.dispatchEvent(new WheelEvent('wheel', { deltaX: dx, deltaY: 0, deltaMode: 0, bubbles: true, cancelable: true, composed: true }));
      await new Promise((r) => setTimeout(r, gap));
    }
  },
  // The swipe's part each frame for `ms`: its offset (px) and whether it's settling, and the moving part's transition.
  async rtSwipeTrace(selector: string, ms: number) {
    const el = rt.target.querySelector(selector) as HTMLElement;
    // `drawn`: where the moving part is on screen (its computed transform's x: mid-transition, the browser's own value).
    const out: { t: number, offset: number | null, drawn: number | null, transition: string, settling: boolean, swiping: boolean }[] = [];
    const t0 = performance.now();
    await new Promise<void>((done) => {
      const frame = () => {
        const v = el.style.getPropertyValue('--m-swipe-offset');
        const pane = el.querySelector('.space-pane:not(.m-swipe-ghost)');
        const m = pane ? /matrix\(([^)]+)\)/.exec(getComputedStyle(pane).transform) : null;
        out.push({ t: performance.now() - t0, offset: v ? parseFloat(v) : null, drawn: m ? parseFloat(m[1].split(',')[4]) : null, transition: el.style.getPropertyValue('--m-swipe-transition'), settling: el.classList.contains('m-settling'), swiping: el.classList.contains('m-swiping') });
        if (performance.now() - t0 < ms) requestAnimationFrame(frame); else done();
      };
      requestAnimationFrame(frame);
    });
    return out;
  },
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
  // The tab in front, the space's tabs, and the mini player the view model has (mini-player.test.ts).
  // The preview card (ui/behaviors/card.ts): the app's word on it, as the overlay passes it on; where its page is measured.
  rtCard(peek: unknown) { return rt.runtime!.card.show(peek); },
  rtPeekPage() { return rt.runtime!.measurePeekPage(); },
  rtPeekVm() { const p = rt.runtime!.vm!.preview; return p ? { loading: p.loading, ready: p.ready, closing: p.closing, quickTab: p.quickTab, host: p.host, url: p.url } : null; },
  rtMedia() { const vm = rt.runtime!.vm!; return { front: vm.tab?.id ?? null, today: vm.space.today.map((t) => t.id), media: vm.media ? { tabId: vm.media.tabId, title: vm.media.title, paused: vm.media.paused } : null }; },
  // No tab audible (as Margin.app's state has none: its mini player is the copies' `media` push only).
  rtSilence() {
    rt.mock.state = { ...rt.mock.state, tabs: Object.fromEntries(Object.entries(rt.mock.state.tabs).map(([k, t]) => [k, { ...t, audible: false }])) };
    rt.host.setState(rt.mock.state);
  },
  // Split View (split-view.test.ts): a split of these tabs (the browser's ids, as a pane can be named), the first in
  // front; what Margin laid out in <m-page> (its panes, by id, with their boxes; the dividers) and the last layout's
  // panes as the host was told them; the panes' windows' minimums as Margin.app says them (`paneMin`).
  rtSplit(tabs: number[], { axis = 'horizontal', ratios = null as number[] | null, id = 'spv-1' } = {}) {
    const front = tabs[0];
    rt.mock.state = {
      ...rt.mock.state,
      tabs: Object.fromEntries(Object.entries(rt.mock.state.tabs).map(([k, t]) => [k, { ...t, active: Number(k) === front ? true : (t.windowId === 1 ? false : t.active) }])),
      splits: [{ id, spaceId: rt.mock.state.tabSpace[front], axis, panes: tabs.map(String), ratios: ratios ?? tabs.map(() => 1 / tabs.length) }],
    } as typeof rt.mock.state;
    rt.host.setState(rt.mock.state);
    return rt.runtime!.vm!.split ? { id: rt.runtime!.vm!.split.id, panes: rt.runtime!.vm!.split.panes.map((p) => p.id) } : null;
  },
  rtNoSplit() { rt.mock.state = { ...rt.mock.state, splits: [] } as typeof rt.mock.state; rt.host.setState(rt.mock.state); },
  rtPanes() {
    const page = rt.target.querySelector('m-page');
    const box = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
    return {
      axis: page?.getAttribute('m-split') ?? null,
      split: page?.getAttribute('m-split-id') ?? null,
      panes: [...(page?.querySelectorAll(':scope > m-pane') ?? [])].map((p) => ({ id: p.getAttribute('m-pane-id'), focused: p.hasAttribute('m-focused'), ...box(p), ring: getComputedStyle(p).boxShadow })),
      dividers: [...(page?.querySelectorAll(':scope > m-divider') ?? [])].map((d) => ({ ...box(d), background: getComputedStyle(d).backgroundColor, cursor: getComputedStyle(d).cursor, grip: `${getComputedStyle(d, '::after').backgroundColor}|${getComputedStyle(d, '::after').backgroundImage}`, role: d.getAttribute('role'),
        band: d.hasAttribute('m-band'), label: d.querySelector('m-band-title')?.textContent ?? null, labelBox: (() => { const l = d.querySelector('m-band-title'); return l ? box(l) : null; })(), labelColor: (() => { const l = d.querySelector('m-band-title'); return l ? getComputedStyle(l).color : null; })() })),
      layout: (rt.host.layouts.at(-1) as { split?: string, panes?: { id: string, rect: number[] }[] } | undefined)?.panes ?? null,
      layoutSplit: (rt.host.layouts.at(-1) as { split?: string } | undefined)?.split ?? null,
    };
  },
  rtPaneMin(items: Record<string, readonly [number, number]>) { Object.assign(rt.host, { paneMinimums: items }); rt.host.setState(rt.mock.state); },
  // Every app's windows' known minimum as Margin.app says them (`appMin`: `web` for the web pages Safari hosts), whether
  // a window of it is open or not.
  rtAppMin(apps: Record<string, readonly [number, number]>) { Object.assign(rt.host, { appMinimums: apps }); rt.host.setState(rt.mock.state); },
  // Stacked ⇄ side by side (the UI's `split.toggleAxis`) with the page area as Margin.app last measured it: what was sent,
  // and the toast shown.
  rtSplitAxis(splitId: string, width: number, height = 800) {
    Object.assign(rt.host, { layout: { container: { width, height }, insets: { left: 0, top: 0, right: 0, bottom: 0 } } });
    rt.host.sent.length = 0;
    rt.runtime!.dispatch('split.toggleAxis', splitId, 'behavior');
    return { sent: rt.host.sent.map((s) => s.type), toast: rt.runtime!.vm?.toast?.text ?? null };
  },
  // A split pane's window opening (Margin.app's `paneLoading`): its item (the pane's id) and name; null: none. What each
  // pane draws then: whether it's loading, its loader's box, words and spinner.
  // A split's cut panes as Margin.app says them (`paneCut`: docs/PEEK-SPLIT.md §4b), and the one the pointer is over
  // (`paneHover`: its window, null: none).
  rtPaneCuts(cuts: Record<string, any>) { Object.assign(rt.host, { paneCuts: cuts }); rt.host.setState(rt.mock.state); },
  // What takes the pointer over the page's place, as Margin.app is told it (host-app.ts hitRects over m-page's box).
  rtPageHits() {
    const root = rt.target.querySelector('m-page')?.closest('[m-theme-root], .m-root') ?? rt.target.firstElementChild ?? rt.target;
    const p = rt.target.querySelector('m-page')!.getBoundingClientRect();
    return hitRects(root as Element, { left: p.left, top: p.top, right: p.right, bottom: p.bottom }).rects;
  },
  rtPaneHover(window: number | null) { Object.assign(rt.host, { paneHover: window }); rt.host.setState(rt.mock.state); },
  // Each pane's arrows: side, mode, label, whether it's shown and takes the pointer, its box and colours.
  rtPaneArrows() {
    return [...rt.target.querySelectorAll('m-page > m-pane')].map((p) => ({
      id: p.getAttribute('m-pane-id'), lit: p.hasAttribute('m-cut-hover'),
      arrows: [...p.querySelectorAll(':scope > m-pane-arrow')].map((a) => {
        const st = getComputedStyle(a), b = a.getBoundingClientRect(), pb = p.getBoundingClientRect();
        return { side: a.getAttribute('m-side'), mode: a.getAttribute('m-mode'), label: a.getAttribute('aria-label'), shown: st.visibility === 'visible' && Number(st.opacity) > 0.5,
          pointer: st.pointerEvents, inside: b.left >= pb.left && b.right <= pb.right && b.top >= pb.top && b.bottom <= pb.bottom, x: b.left + b.width / 2, y: b.top + b.height / 2,
          left: b.left - pb.left, right: pb.right - b.right, color: st.color, background: st.backgroundColor };
      }),
    }));
  },
  rtPaneLoading(pane: { item: string, name: string } | null) { Object.assign(rt.host, { paneLoading: pane ? { ...pane, bundleId: null } : null }); rt.host.setState(rt.mock.state); },
  rtPaneLoaders() {
    const page = rt.target.querySelector('m-page');
    return [...(page?.querySelectorAll(':scope > m-pane') ?? [])].map((p) => {
      const l = p.querySelector('m-pane-loader');
      const b = (l ?? p).getBoundingClientRect(), pb = p.getBoundingClientRect();
      const spin = l?.querySelector('m-pane-spinner');
      return { id: p.getAttribute('m-pane-id'), loading: p.hasAttribute('m-loading'), text: l?.textContent ?? null, inside: !!l && b.left >= pb.left - 0.5 && b.right <= pb.right + 0.5 && b.top >= pb.top - 0.5 && b.bottom <= pb.bottom + 0.5,
        visible: !!l && b.width > 0 && b.height > 0 && getComputedStyle(l).visibility !== 'hidden' && getComputedStyle(l).display !== 'none', spinning: !!spin && getComputedStyle(spin).animationName !== 'none', color: l ? getComputedStyle(l).color : null, background: l ? getComputedStyle(l).backgroundColor : null };
    });
  },
  // Add to Split View (the UI's `split.add`) with the page area `width` wide as Margin.app last measured it: what was
  // sent, and the toast shown.
  rtSplitAdd(tabId: number | string, width: number, height = 800) {
    Object.assign(rt.host, { layout: { container: { width, height }, insets: { left: 0, top: 0, right: 0, bottom: 0 } } });
    rt.host.sent.length = 0;
    rt.notes.length = 0;
    rt.runtime!.dispatch('split.add', tabId, 'behavior');
    return { sent: rt.host.sent.map((s) => s.type), toast: rt.runtime!.vm?.toast?.text ?? null, note: rt.notes.at(-1) ?? null };
  },
  // A kept item (Margin.app's library: a web page's, or an app's `app://<bundle id>`) in the state, in the front tab's
  // space, used last at `lastActive` (the selected one: `wasActive`).
  // `row`: open in Margin's window, as a row of that number (`tabs[row]`, its `mid` the item) instead.
  rtKept(id: string, url: string, { lastActive = 0, wasActive = false, name = '', row = null as number | null } = {}) {
    const s = rt.mock.state as any;
    const front = Object.values(s.tabs as Record<string, any>).find((t) => t.active)?.id;
    const app = /^app:\/\/([^/?#]+)/.exec(url)?.[1];
    // (Open: a row, no longer among the kept ones, as Margin.app puts it (HostedSession `liveTab`).)
    if (row == null) s.keptTabs = { ...(s.keptTabs ?? {}), [id]: { id, url, title: name || url, spaceId: s.tabSpace[front], lastActive, wasActive, target: app ? { kind: 'app', bundleId: app, name } : { kind: 'web', browser: 'safari', profile: null } } };
    else {
      s.tabs = { ...s.tabs, [row]: { ...(s.tabs[front] ?? {}), id: row, url, title: name || url, active: wasActive, lastActive, mid: id } };
      s.tabSpace = { ...s.tabSpace, [row]: s.tabSpace[front] };
    }
    rt.host.setState(rt.mock.state);
  },
  rtVm() { const vm = rt.runtime!.vm!; return { space: vm.space.id, sidebar: vm.window.sidebar, palette: vm.palette.open, rows: vm.palette.rows.length, today: vm.space.today.length }; },
  rtCount(selector: string) { return rt.target.querySelectorAll(selector).length; },
  // The page's box (<m-page>) and the launcher's, with the launcher's background (Margin.app's empty window).
  rtEmptyPage() {
    const box = (el: Element | null) => { const r = el?.getBoundingClientRect(); return r ? [r.left, r.top, r.width, r.height] : null; };
    const launcher = rt.target.querySelector('.launcher');
    return { page: box(rt.target.querySelector('m-page')), launcher: box(launcher), background: launcher ? getComputedStyle(launcher).backgroundColor : null };
  },
  rtText(selector: string) { return [...rt.target.querySelectorAll(selector)].map((e) => e.textContent!.trim()); },
  rtTodayIds(n = 3) { return rt.runtime!.vm!.space.today.slice(0, n).map((t) => t.id); },
  rtDispatch(name: string, arg?: unknown) { return rt.runtime!.dispatch(name, arg); },
  // As Margin's own behaviors run it (the overlay's keys): its answer, awaited when it's a request's.
  rtBehavior(name: string, arg?: unknown) { return rt.runtime!.dispatch(name, arg, 'behavior'); },
  // --- Rows by what they are (every theme: their classes differ), for the pending intents and the rows' motion ----
  // A tab's or a pin's row: the element whose click activates or opens it (tab.activate, pin.open) with this id.
  rtRow(id: number | string) { return rowEl(id); },
  rtRowActive(id: number | string) { const el = rowEl(id); return el ? el.classList.contains('active') || el.classList.contains('on') : null; },
  // Where to click a row (scrolled to the middle of its list first), and its close button (shown under the pointer).
  rtRowBox(id: number | string) {
    const el = rowEl(id);
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const close = el.querySelector('[aria-label^="Close"], .close');
    const c = close?.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, height: r.height, close: c && c.width ? { x: c.left + c.width / 2, y: c.top + c.height / 2 } : { x: r.right - 14, y: r.top + r.height / 2 } };
  },
  // Each row's top, by id, in the order drawn (today's tabs).
  rtTodayTops() { return rt.runtime!.vm!.space.today.map((t) => [t.id, rowEl(t.id)?.getBoundingClientRect().top ?? null] as const); },
  // Today's rows' transform this instant (a slide under way: not 'none').
  rtTodayTransforms(from = 0, count = 10) { return rt.runtime!.vm!.space.today.slice(from, from + count).map((t) => { const el = rowEl(t.id); return el ? getComputedStyle(el).transform : null; }); },
  // The host answering the switch, open and close requests `ms` later, with the state of what they did (as
  // Margin.app does: the state, then the answer); `fail`: those requests' types answered undefined, nothing done.
  // Every request's time is kept (`rtSlowSent`).
  rtSlowHost(ms: number, { fail = [] as string[] } = {}) {
    const host = rt.host;
    const sent: [string, any, number][] = [];
    (T as any).__slowSent = sent;
    host.send = (type: string, payload: any = {}) => {
      host.sent.push({ type, payload });
      sent.push([type, payload, performance.now()]);
      return new Promise((resolve) => setTimeout(() => {
        if (fail.includes(type)) return resolve(undefined);
        const m = rt.mock;
        if (type === 'activateTab') { m.activate(payload.tabId); host.setState(m.state); return resolve({ shown: payload.tabId }); }
        if (type === 'closeTab') { m.tabs((tabs) => { delete tabs[payload.tabId]; return tabs; }); m.build(); host.setState(m.state); return resolve(null); }
        if (type === 'openPin') {
          const pin = m.state.pins.find((p) => p.id === payload.pinId)!;
          const id = m.nextId++;
          const tabs = { ...m.state.tabs };
          for (const t of Object.values(tabs)) if (t.active) tabs[t.id] = { ...t, active: false };
          tabs[id] = { id, windowId: 1, index: 9999, title: pin.title, url: pin.url, favIconUrl: '', active: true, lastActive: 99999 };
          m.state = { ...m.state, tabs, tabSpace: { ...m.state.tabSpace, [id]: pin.spaceId } };
          m.build();
          host.setState(m.state);
          return resolve({ shown: id });
        }
        resolve(true);
      }, ms));
    };
    return true;
  },
  // From the next `event` (pointerdown, click) on the theme: how many frames, and ms, until row `id` is drawn `want`
  // (active, gone); every frame's answer is kept too, up to `ms` (a flicker shows as a change back). `rtWatched` waits.
  rtWatch(event: string, id: number | string, want: 'active' | 'gone', ms = 1500) {
    const test = () => { const el = rowEl(id); return want === 'gone' ? el == null : !!el && (el.classList.contains('active') || el.classList.contains('on')); };
    let t0 = 0;
    const seen: boolean[] = [];
    (T as any).__watched = new Promise((done) => {
      let frames = 0;
      let at: { frames: number, ms: number } | null = null;
      const tick = () => {
        if (t0) {
          frames++;
          const ok = test();
          seen.push(ok);
          if (ok && !at) at = { frames, ms: performance.now() - t0 };
          if (performance.now() - t0 > ms) return done({ ...(at ?? { frames: -1, ms: -1 }), seen });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    rt.target.addEventListener(event, () => { t0 = performance.now(); }, { capture: true, once: true });
    return true;
  },
  rtWatched() { return (T as any).__watched as Promise<{ frames: number, ms: number, seen: boolean[] }>; },
  // How long one action takes to run and draw (its click's work, the rows' slide set up included), in ms.
  rtTimed(name: string, arg?: unknown) { const t = performance.now(); rt.runtime!.dispatch(name, arg); return performance.now() - t; },
  // The frames drawn over the next `ms`: each one's time since the last.
  rtFrameGaps(ms: number) {
    return new Promise<number[]>((done) => {
      const gaps: number[] = [];
      const start = performance.now();
      let last = start;
      const tick = (t: number) => { gaps.push(t - last); last = t; if (t - start > ms) done(gaps.slice(1)); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
  },
  rtSlowSent() { return ((T as any).__slowSent as [string, any, number][]).map(([type, payload, at]) => ({ type, payload, at })); },
  // A pin's tab closed (the pin stays, not open), in the stored state: the pin's id.
  rtUnopenPin(nth = 1) {
    const m = rt.mock;
    const pin = m.state.pins.filter((p) => p.spaceId === 'personal')[nth];
    const tab = Object.values(m.state.tabs).find((t) => t.url === pin.url)!;
    m.tabs((tabs) => { delete tabs[tab.id]; return tabs; });
    m.build();
    rt.host.setState(m.state);
    return pin.id;
  },
  // Some rows made installed apps' items (Margin.app): today's 2nd and 4th tabs and the first folder's 2nd pin, with
  // an icon drawn as macOS draws app icons (its glyph 52 of 64 px, transparent room around it). Their ids, and a
  // site's row beside them.
  rtAppRows() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#2f7cf6';
    g.beginPath(); g.roundRect(6, 5, 52, 52, 12); g.fill();
    const icon = canvas.toDataURL('image/png');
    const apps = ['Notes', 'Music', 'Maps'].map((n) => ({ bundleId: `com.example.${n}`, name: n, icon }));
    const m = rt.mock;
    const today = rt.runtime!.vm!.space.today.map((t) => t.id as number);
    const tabs = { ...m.state.tabs };
    tabs[today[1]] = { ...tabs[today[1]], url: 'app://com.example.Notes', title: 'Notes' };
    tabs[today[3]] = { ...tabs[today[3]], url: 'app://com.example.Music', title: 'Music' };
    const pin = m.state.pins.filter((p) => p.folderId === 'personal-f0')[1];
    const pinTab = Object.values(tabs).find((t) => t.url === pin.url)!;
    tabs[pinTab.id] = { ...pinTab, url: 'app://com.example.Maps', title: 'Maps' };
    const pins = m.state.pins.map((p) => (p === pin ? { ...p, url: 'app://com.example.Maps', title: 'Maps' } : p));
    m.state = { ...m.state, tabs, pins, apps } as typeof m.state;
    m.build();
    rt.host.setState(m.state);
    return { apps: [today[1], today[3]], site: today[2], pin: pin.id };
  },
  // A row's icon, its title's left edge and the row's height.
  rtRowParts(id: number | string) {
    const el = rowEl(id);
    if (!el) return null;
    const icon = el.querySelector('img, .letter');
    const title = [...el.querySelectorAll('span, div')].find((e) => e.childElementCount === 0 && /\S/.test(e.textContent ?? '') && !e.classList.contains('letter'));
    const r = (x: Element | null | undefined) => { const b = x?.getBoundingClientRect(); return b ? { left: b.left, top: b.top, width: b.width, height: b.height } : null; };
    // (The icon's drawn size: its computed width, inside any padding a theme gives it.)
    return { row: r(el), icon: r(icon), size: icon ? parseFloat(getComputedStyle(icon).width) : null, app: !!icon?.classList.contains('app'), title: r(title) };
  },
  // A folder's row (its folder.toggle control), its glyph and its name: where each is drawn.
  rtFolderParts(id: string) {
    const view = rt.runtime!.view;
    const el = [...rt.target.querySelectorAll<HTMLElement>('[m-drag], a, button')].find((e) => { const a = view.actionOf(e); return a?.name === 'folder.toggle' && a.arg === id; });
    if (!el) return null;
    const icon = el.querySelector('svg:not(.chev):not(.arrow), .folder-icon, .folder-ico') ?? el.querySelector('svg');
    const title = [...el.querySelectorAll('span, div')].find((e) => e.childElementCount === 0 && /\S/.test(e.textContent ?? ''));
    const r = (x: Element | null | undefined) => { const b = x?.getBoundingClientRect(); return b ? { left: b.left, top: b.top, width: b.width, height: b.height } : null; };
    return { row: r(el), icon: r(icon), title: r(title) };
  },
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

// The row whose click activates the tab or opens the pin `id` (its <a>, or the element with the action).
function rowEl(id: number | string): HTMLElement | null {
  const view = rt.runtime!.view;
  for (const el of rt.target.querySelectorAll<HTMLElement>('[m-drag], a, button')) {
    const a = view.actionOf(el);
    if (a && (a.name === 'tab.activate' || a.name === 'pin.open') && a.arg === id && el.closest('.launcher, .tile') == null) return el;
  }
  return null;
}

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
