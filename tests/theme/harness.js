// The browser side of the theme tests and the benchmark, bundled into one
// script (tests/theme/package.js harnessScript) and added to a blank page.
// Node drives it with page.evaluate through `window.T`.
import { sanitizeCss } from '../../extension/ui/sanitize.js';
import { buildTemplate, View } from '../../extension/ui/render.js';
import { loadTheme, loadBuiltinTheme, sanitizeTheme } from '../../extension/ui/theme-loader.js';
import { createRuntime } from '../../extension/ui/runtime.js';
import { createMockHost } from '../../extension/ui/host.js';
import { createDispatcher, contextFromState } from '../../extension/ui/actions.js';
import { MockState } from './view-model.js';
import { auditDom } from './audit.js';
import { HTML_PAYLOADS, CSS_PAYLOADS, CSS_TARGET, EVIL_VM, wrap } from './payloads.js';

const w = /** @type {any} */ (window);

// The tripwire: every payload that runs calls one of these.
w.__tripped = [];
w.__trip = (name) => { w.__tripped.push(String(name)); };
w.alert = (m) => { w.__tripped.push(`alert:${m}`); };

const decode = (b64) => { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const unpack = (pkg) => ({ ...pkg, files: Object.fromEntries(Object.entries(pkg.files).map(([k, v]) => [k, decode(v)])) });

// A container: a shadow root on a fixed-size host, or the document itself.
function host(width, height) {
  const el = document.createElement('div');
  el.className = 'margin-host';
  el.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px;display:block`;
  document.body.appendChild(el);
  return el;
}

const state = { theme: null, views: [], log: [], actions: [], refused: [] };

const T = {
  async loadNeo(pkg) {
    const theme = await loadTheme(unpack(pkg));
    state.theme = theme;
    return {
      ok: theme.ok,
      removed: theme.report.removed,
      errors: theme.report.errors,
      fonts: ['Archivo Black', 'Space Grotesk'].map((f) => document.fonts.check(`16px "${f}"`)),
    };
  },

  // Renders Neo-brutalism with the mock view model, in a shadow root (or the
  // document), and keeps the view for the steps below.
  mountNeo({ width = 1440, height = 900, container = 'shadow', closed = false } = {}) {
    const mock = new MockState();
    let target;
    let el = null;
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
    const view = new View(target, state.theme.template, {
      sheets: [state.theme.sheet],
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
  mutate(op, ...args) {
    const { view, mock, target } = state.views[state.views.length - 1];
    const root = target.nodeType === 9 ? target.body : target;
    const mo = new MutationObserver(() => {});
    mo.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    view.update(mock[op](...args));
    const records = mo.takeRecords();
    mo.disconnect();
    const out = { text: 0, attributes: [], added: 0, removed: 0, moved: 0 };
    const added = new Set();
    const removed = new Set();
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

  count(selector) {
    const { target } = state.views[state.views.length - 1];
    return target.querySelectorAll(selector).length;
  },
  text(selector) {
    const { target } = state.views[state.views.length - 1];
    return [...target.querySelectorAll(selector)].map((e) => e.textContent.trim());
  },
  // Marks the element a selector finds, to check later that it's the same node.
  tag(selector, mark) { const { target } = state.views[state.views.length - 1]; const el = target.querySelector(selector); el.__mark = mark; return Boolean(el); },
  tagged(selector) { const { target } = state.views[state.views.length - 1]; return target.querySelector(selector)?.__mark ?? null; },
  mock() { return state.views[state.views.length - 1].mock; },
  firstTodayId() { return T.mock().space.today[0].id; },
  vmIds() { const m = T.mock(); return { today: m.space.today.slice(0, 3).map((t) => t.id), folder: m.space.folders[0].id }; },

  // --- Security ---------------------------------------------------------------

  // Sanitizes, builds and renders every HTML payload, live, in a shadow root
  // and in the document, with a hostile view model. Returns, per payload,
  // what the sanitizer said and what the DOM audit found.
  runHtmlPayloads(manifest) {
    const results = [];
    const mock = new MockState();
    const vm = { ...mock.vm, evil: EVIL_VM };
    const dispatch = createDispatcher({
      context: () => contextFromState(mock.state),
      run: (name, arg) => state.actions.push([name, arg]),
      log: (entry) => state.refused.push(entry),
    });
    for (const [name, fragment] of HTML_PAYLOADS) {
      const report = sanitizeTheme({ manifest, html: wrap(fragment), css: '', files: [] });
      const result = { name, ok: report.ok, removed: report.removed.length, errors: report.errors, violations: [] };
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
    const results = [];
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
  timeSanitize(pkg, runs = 50) {
    const p = unpack(pkg);
    const files = Object.keys(p.files);
    const times = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      const r = sanitizeTheme({ manifest: p.manifest, html: p.html, css: p.css, files });
      buildTemplate(r.tree);
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
    const theme = state.theme;
    const out = {};
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    const record = (label, js, layout) => { (out[label] ??= { js: [], layout: [] }); out[label].js.push(js / batch); out[label].layout.push(layout / batch); };

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

    const live = (options = {}) => {
      const mock = new MockState();
      const el = host(1440, 900);
      const view = new View(el.attachShadow({ mode: 'open' }), theme.template, { sheets: [theme.sheet], ...options });
      view.update(mock.vm);
      view.measure();
      return { mock, view, el };
    };
    // Alternating ops: each step's label and the vm it renders.
    const series = async (steps, options) => {
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
    await series([['change one tab title', (m, i) => m.retitle(m.space.today[50].id, `Renamed tab ${i}`)]]);
    await series([['add 10 tabs', (m) => m.addTabs(10)], ['remove 10 tabs', (m) => m.removeTabs(10)]]);
    await series([['activate another tab', (m, i) => m.activate(m.space.today[i % 2 ? 10 : 20].id)]]);
    await series([['toggle a folder (20 tabs)', (m) => m.toggleFolder('personal-f0')]]);
    await series([['move one tab (1st to 120th and back)', (m, i) => (i % 2 ? m.moveTab(119, 0) : m.moveTab(0, 119))]]);
    await series([['switch space, 200 → 8 tabs', (m) => m.switchSpace('work')], ['switch space, 8 → 200 tabs (rows reused)', (m) => m.switchSpace('personal')]]);
    await series([['switch space, 8 → 200 tabs (no row pool)', (m) => m.switchSpace('personal')], ['(back to work, no pool)', (m) => m.switchSpace('work')]], { rowPool: 0 });
    await series([['open the palette', (m) => m.openPalette('q')], ['close the palette', (m) => m.closePalette()]]);
    delete out['(back to work, no pool)'];

    const stat = (list) => {
      const s = [...list].sort((a, b) => a - b);
      const at = (q) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
      return { median: (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2, p95: at(0.95), max: s[s.length - 1], n: s.length };
    };
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { js: stat(v.js), layout: stat(v.layout) }]));
  },
};

// --- The runtime (ui/runtime.js) with a mock host -------------------------------

const rt = { runtime: null, host: null, mock: null, el: null, target: null, theme: null };

Object.assign(T, {
  // Neo-brutalism as a built-in theme: its files read through readFile (here
  // from the package handed over, in the extension from its own URL).
  async loadBuiltin(pkg, id = 'neo-brutalism') {
    const p = unpack(pkg);
    const text = { 'theme.json': p.manifest, 'theme.html': p.html, 'theme.css': p.css };
    const read = [];
    const theme = await loadBuiltinTheme(id, { readFile: async (path) => { read.push(path); return text[path] ?? p.files[path]; } });
    rt.theme = theme;
    return { ok: theme.ok, id: theme.id, read, fontErrors: theme.fontErrors, fonts: ['Archivo Black', 'Space Grotesk'].map((f) => document.fonts.check(`16px "${f}"`)) };
  },

  // `replies`: what the host answers a request of each type with (values);
  // `settings`: the stored settings changed first.
  mountRuntime({ width = 1440, height = 900, container = 'shadow', closed = true, platform = { browser: 'chrome', os: 'linux', marginFullscreen: true }, replies = {}, settings = null, mode = 'fullscreen', inNewTab = false, warnings = null } = {}) {
    T.unmountRuntime();
    const mock = new MockState();
    if (settings) mock.state = { ...mock.state, settings: { ...mock.state.settings, ...settings } };
    const answers = { createSpace: () => ({ spaceId: 'studio' }), ...Object.fromEntries(Object.entries(replies).map(([k, v]) => [k, () => v])) };
    const host = createMockHost({ state: mock.state, windowId: 1, platform, mode, inNewTab, replies: answers });
    let target;
    let el = null;
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
    const runtime = createRuntime({ host, theme: rt.theme, container: target, onWarn: (m) => rt.warnings.push(m) });
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
  rtChange(op, ...args) {
    const root = rt.target.nodeType === 9 ? rt.target.body : rt.target;
    const mo = new MutationObserver(() => {});
    mo.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    rt.mock[op](...args);
    rt.host.setState(rt.mock.state);
    const records = mo.takeRecords();
    mo.disconnect();
    return { records: records.length, text: records.filter((r) => r.type === 'characterData').length };
  },
  rtSettings(patch) {
    rt.mock.state = { ...rt.mock.state, settings: { ...rt.mock.state.settings, ...patch } };
    rt.host.setState(rt.mock.state);
  },
  rtSent() { return rt.host.sent.map((s) => [s.type, s.payload]); },
  rtSetUi(patch) { rt.runtime.setUi(patch); return true; },
  rtWarnings() { return rt.warnings.slice(); },
  rtPerformedFull() { return rt.host.performed.map((p) => [p.name, p.arg ?? null]); },
  rtAttr(selector, name, nth = 0) { return rt.target.querySelectorAll(selector)[nth]?.getAttribute(name) ?? null; },
  rtActive() { const el = rt.target.activeElement; return el ? el.getAttribute('m-input') ?? el.localName : null; },
  // Margin's renderer on its own, given a template that never went through
  // the sanitizer: a menu, a notice and a slot's own content holding the
  // theme's words. Only the bound labels may show.
  guardedRaw() {
    const el = (name, attrs, ...children) => ({ type: 'el', ns: 'html', name, attrs, children });
    const text = (value) => ({ type: 'text', value });
    const tree = { type: 'root', children: [el('div', [['class', 'g']],
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
    const warnings = [];
    const view = new View(shadow, buildTemplate(tree), { onWarn: (m) => warnings.push(m) });
    view.update({ menu: { label: 'Tab', items: [{ id: 'i0', label: 'Close Tab' }] }, notice: { text: 'Margin works in full screen.' }, prompt: { text: 'x' } });
    const shown = (sel) => { const n = shadow.querySelector(sel); return n ? n.textContent.replace(/\s+/g, ' ').trim() : null; };
    const attrs = [...shadow.querySelectorAll('*')].flatMap((n) => ['title', 'aria-label', 'alt', 'placeholder'].filter((a) => n.hasAttribute(a)).map((a) => `${n.localName}@${a}=${n.getAttribute(a)}`));
    const result = { menu: shown('m-menu'), notice: shown('m-notice'), prompt: shown('m-prompt'), attrs, paths: shadow.querySelectorAll('m-menu path').length, warnings };
    view.destroy();
    host.remove();
    return result;
  },
  rtLayouts() { return rt.host.layouts.map((l) => ({ ...l.insets, radius: l.radius, width: l.container.width, height: l.container.height, windowId: l.windowId, mode: l.mode })); },
  rtRefused() { return rt.runtime.refused.map((r) => [r.name, r.reason]); },
  rtPerformed() { return rt.host.performed.map((p) => p.name); },
  rtUi() { const { palette, sidebar, editing, menu, editor, switchingTo } = rt.runtime.ui; return { palette, sidebar, editing, menu, editor, switchingTo }; },
  // --- The behaviors (tests/theme/behaviors.test.js) ---
  rtPointer(x, y) { rt.runtime.pointer({ x, y }); },
  rtPointerLeft(x, y) { rt.runtime.pointerLeft({ x, y }); },
  rtVmFull() { const vm = rt.runtime.vm; return { sidebar: vm.window.sidebar, space: vm.space.id, query: vm.palette.query, rows: vm.palette.rows.map((r) => r.title), rowIds: vm.palette.rows.map((r) => r.id), selected: vm.palette.selected, menu: vm.menu?.items.map((i) => i.label) ?? null, editing: vm.editing, editor: vm.editor && { name: vm.editor.name, color: vm.editor.color, deleteLabel: vm.editor.deleteLabel }, settings: vm.settings, folders: vm.space.folders.map((f) => [f.id, f.name, f.open]), spaceName: vm.space.name }; },
  // What has the focus in the UI.
  rtFocus() {
    const el = rt.target.activeElement;
    if (!el) return null;
    return { tag: el.localName, cls: el.className && typeof el.className === 'string' ? el.className : '', input: el.getAttribute('m-input'), editable: el.isContentEditable, value: el.value ?? null, text: el.textContent.trim().slice(0, 60) };
  },
  rtRect(selector, nth = 0) {
    const el = rt.target.querySelectorAll(selector)[nth];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  },
  // The middle of the element of `selector` whose text is `text`.
  rtBoxText(selector, text) {
    const el = [...rt.target.querySelectorAll(selector)].find((e) => e.textContent.trim() === text);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  },
  rtClasses(selector, nth = 0) { const el = rt.target.querySelectorAll(selector)[nth]; return el ? [...el.classList] : null; },
  rtMarked() { return ['m-dragging', 'm-drop-before', 'm-drop-after', 'm-drop-into', 'm-drop-end', 'm-drag-ghost'].map((c) => [c, rt.target.querySelectorAll(`.${c}`).length]).filter(([, n]) => n); },
  rtScrollTop(selector) { return rt.target.querySelector(selector)?.scrollTop ?? null; },
  rtStyle(selector, prop) { const el = rt.target.querySelector(selector); return el ? el.style.getPropertyValue(prop) : null; },
  rtSentClear() { rt.host.sent.length = 0; rt.host.layouts.length = 0; },
  rtLayoutsAll() { return rt.host.layouts.map((l) => l.insets.left); },
  rtState() { return rt.mock.state; },
  // A trackpad's sideways scroll over an element: `count` wheel events of
  // `dx` px, 16 ms apart (Playwright's own wheel is a mouse's).
  async rtTrackpad(selector, dx, count) {
    const el = rt.target.querySelector(selector);
    for (let i = 0; i < count; i++) {
      el.dispatchEvent(new WheelEvent('wheel', { deltaX: dx, deltaY: 0, deltaMode: 0, bubbles: true, cancelable: true, composed: true }));
      await new Promise((r) => setTimeout(r, 16));
    }
  },
  // The background's answer to a request, as storage brings it back.
  rtApply(op, ...args) { rt.mock[op](...args); rt.host.setState(rt.mock.state); },
  // Every tab of the window loading, or none (Margin.app's host marks them from the copy's `loading` push).
  rtLoading(on) {
    const tabs = Object.fromEntries(Object.entries(rt.mock.state.tabs).map(([id, t]) => [id, { ...t, loading: !!on }]));
    rt.mock.state = { ...rt.mock.state, tabs };
    rt.host.setState(rt.mock.state);
    return Object.values(tabs).filter((t) => t.loading).length;
  },
  rtComputed(selector, prop) { const el = rt.target.querySelector(selector); return el ? getComputedStyle(el).getPropertyValue(prop) : null; },
  // Whether an element is drawn: in the layout, not hidden, not transparent.
  rtVisible(selector) {
    const el = rt.target.querySelector(selector);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility === 'visible' && Number(s.opacity) > 0 && s.display !== 'none';
  },
  rtFolderRename(folderId, name) { rt.mock.state = { ...rt.mock.state, folders: rt.mock.state.folders.map((f) => (f.id === folderId ? { ...f, name } : f)) }; rt.host.setState(rt.mock.state); },
  rtVm() { const vm = rt.runtime.vm; return { space: vm.space.id, sidebar: vm.window.sidebar, palette: vm.palette.open, rows: vm.palette.rows.length, today: vm.space.today.length }; },
  rtCount(selector) { return rt.target.querySelectorAll(selector).length; },
  rtText(selector) { return [...rt.target.querySelectorAll(selector)].map((e) => e.textContent.trim()); },
  rtTodayIds(n = 3) { return rt.runtime.vm.space.today.slice(0, n).map((t) => t.id); },
  rtDispatch(name, arg) { return rt.runtime.dispatch(name, arg); },
  // Where to click an element (the shadow root is closed: clicks go by
  // position), scrolled into view in its list first.
  rtBox(selector, nth = 0) {
    const el = rt.target.querySelectorAll(selector)[nth];
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  },
});

function hostElement(width, height) { return host(width, height); }

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

w.T = T;
