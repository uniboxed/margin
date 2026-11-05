// The browser side of the theme tests and the benchmark, bundled into one
// script (tests/theme/package.js harnessScript) and added to a blank page.
// Node drives it with page.evaluate through `window.T`.
import { sanitizeTheme, sanitizeCss } from '../../extension/ui/sanitize.js';
import { buildTemplate, View, loadTheme } from '../../extension/ui/render.js';
import { createDispatcher, contextFromViewModel } from '../../extension/ui/actions.js';
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
      context: () => contextFromViewModel(mock.vm),
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
      context: () => contextFromViewModel(vm),
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
