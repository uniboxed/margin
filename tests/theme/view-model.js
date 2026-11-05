// Margin's stored state, as pages read it (shared/stored.js fromStorage),
// for the theme tests and the benchmark: three spaces in one window, pins in
// folders and loose, sleeping and playing tabs, sites with no icon, an
// archive. Personal holds 200 rows (30 pins in two folders, 170 tabs).
// `MockState` changes it immutably, as the background's writes reach a page
// (a changed tab is a new record, the rest the same), and builds the theme
// view model from it with ui/view-model.js, passing the last model so that
// what didn't change is shared. Runs in Node and in pages.
import { buildViewModel } from '../../extension/ui/view-model.js';

// --- Tiny PNG icons, as data: URLs (Margin stores icons this way). --------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (bytes) => { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const adler32 = (bytes) => { let a = 1; let b = 0; for (const x of bytes) { a = (a + x) % 65521; b = (b + a) % 65521; } return ((b << 16) | a) >>> 0; };
const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const chunk = (type, data) => { const body = [...ascii(type), ...data]; return [...u32(data.length), ...body, ...u32(crc32(body))]; };
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=');
  }
  return out;
}
// A 16×16 icon: a colored square with a lighter corner.
export function pngIcon([r, g, b]) {
  const w = 16;
  const raw = [];
  for (let y = 0; y < w; y++) {
    raw.push(0);
    for (let x = 0; x < w; x++) {
      const light = x + y < 9;
      raw.push(light ? Math.min(255, r + 80) : r, light ? Math.min(255, g + 80) : g, light ? Math.min(255, b + 80) : b);
    }
  }
  const len = raw.length;
  const zlib = [0x78, 0x01, 0x01, len & 255, len >> 8, ~len & 255, (~len >> 8) & 255, ...raw, ...u32(adler32(raw))];
  const bytes = [137, 80, 78, 71, 13, 10, 26, 10, ...chunk('IHDR', [...u32(w), ...u32(w), 8, 2, 0, 0, 0]), ...chunk('IDAT', zlib), ...chunk('IEND', [])];
  return `data:image/png;base64,${base64(bytes)}`;
}

// --- The sites --------------------------------------------------------------

export const SITES = [
  ['The quiet return of the analog camera | The Lantern', 'thelantern.example', '/culture/analog-return', [179, 38, 30]],
  ['Sourdough Hydration Chart: Stiff to Open Crumb – Bread Notes', 'breadnotes.example', '/hydration-chart', [138, 90, 25]],
  ['Slow software — Margins', 'margins.example', '/essays/slow-software', [31, 78, 121]],
  ['Lisbon in 3 days · Trip plan · Wayfarer', 'wayfarer.example', '/trips/lisbon-3-days', [15, 118, 110]],
  ['SFO to LIS, Fri Nov 14 | Skyroute', 'skyroute.example', '/flights/sfo-lis', [10, 91, 216]],
  ['San Francisco, CA 10-Day Weather Forecast | Nimbus', 'nimbus.example', '/weather/san-francisco', [30, 79, 143]],
  ['Developing & Scanning Prices – Darkroom Lab', 'darkroomlab.example', '/prices', [38, 38, 38]],
  ['bookshops near me – Atlas Maps', 'maps.atlas.example', '/search/bookshops', [217, 48, 37]],
  ['Q4 Roadmap — Draft - Pages', 'pages.example', '/d/q4-roadmap', [47, 111, 237]],
  ['Product overview · Gauge', 'app.gauge.example', '/overview', [124, 58, 237]],
  ['Standup – Board – Taskly', 'taskly.example', '/b/standup', [12, 102, 228]],
  ['fix(sidebar): spacing on collapsed folders · Pull Request #482 · forge/app', 'forge.example', '/forge/app/pull/482', [29, 34, 40]],
  ['Liquid surfaces – Pinwall', 'pinwall.example', '/board/liquid-surfaces', [200, 16, 46]],
  ['Grotesk Typeface — Foundry North', 'foundrynorth.example', '/fonts/grotesk', [17, 17, 17]],
  ['Late-night focus set — 2 hours of ambient synth - Streamly', 'streamly.example', '/watch?v=nightfocus', [124, 77, 255]],
  ['Render queue · Cloudrender', 'cloudrender.example', '/queue', [234, 88, 12]],
];
// Two sites Margin has no icon for: their rows show a letter.
export const NO_ICON = new Set(['skyroute.example', 'pinwall.example']);

const ICONS = Object.fromEntries(SITES.filter((s) => !NO_ICON.has(s[1])).map((s) => [`https://${s[1]}`, { data: pngIcon(s[3]), href: `https://${s[1]}/favicon.ico`, at: 1 }]));

const SPACES = [
  { id: 'personal', name: 'Personal', emoji: '🙂', color: '#ffd23f', folders: [['Reading', 20], ['Lisbon', 10]], loose: 0, today: 170 },
  { id: 'work', name: 'Work', emoji: '💼', color: '#7fb3ff', folders: [['Q4', 3], ['Team', 2]], loose: 1, today: 3 },
  { id: 'studio', name: 'Studio Space', emoji: '🎨', color: '#ff8fd8', folders: [['Campaign', 3], ['Assets', 2]], loose: 0, today: 3 },
];

export const WINDOW = 1;

/**
 * The big state: every pin open in a tab of its space (so the folders' rows
 * are tabs too), tab ids from 1000, the first pin of Personal's first folder
 * the active tab.
 */
export function bigState() {
  let n = 0;
  let id = 1000;
  const tabs = {};
  const tabSpace = {};
  const pins = [];
  const folders = [];
  const makeTab = (spaceId, url, title) => {
    const k = n++;
    const t = { id: id++, windowId: WINDOW, index: k, title, url, favIconUrl: '', active: false, lastActive: k };
    if (k % 11 === 4) t.sleeping = { at: 1, how: 'page' };
    if (k % 23 === 5) t.audible = true;
    tabs[t.id] = t;
    tabSpace[t.id] = spaceId;
    return t;
  };
  const site = () => SITES[n % SITES.length];
  const page = (spaceId, extra = '') => {
    const [title, host, path] = site();
    const round = Math.floor(n / SITES.length);
    return { url: `https://${host}${path}${round || extra ? `?n=${n}${extra}` : ''}`, title: round ? `${title} (${round + 1})` : title };
  };
  for (const def of SPACES) {
    def.folders.forEach(([name, count], fi) => {
      const folderId = `${def.id}-f${fi}`;
      folders.push({ id: folderId, spaceId: def.id, name, open: true, pos: fi });
      for (let i = 0; i < count; i++) {
        const { url, title } = page(def.id);
        const t = makeTab(def.id, url, title);
        pins.push({ id: `pin-${t.id}`, spaceId: def.id, url, title, folderId, pos: i });
      }
    });
    for (let i = 0; i < def.loose; i++) {
      const { url, title } = page(def.id);
      const t = makeTab(def.id, url, title);
      pins.push({ id: `pin-${t.id}`, spaceId: def.id, url, title, pos: def.folders.length + i });
    }
    for (let i = 0; i < def.today; i++) {
      const { url, title } = page(def.id);
      makeTab(def.id, url, title);
    }
  }
  tabs[1000] = { ...tabs[1000], active: true };
  return {
    spaces: SPACES.map(({ id: sid, name, emoji, color }) => ({ id: sid, name, emoji, color })),
    activeSpaceByWindow: { [WINDOW]: 'personal' },
    tabSpace,
    tabs,
    pins,
    folders,
    archive: [
      { id: 'a1', url: 'https://old.example/', title: 'An archived page', spaceId: 'personal', favIconUrl: '', closedAt: 2 },
      { id: 'a2', url: 'https://thelantern.example/old', title: 'An older one', spaceId: 'work', favIconUrl: '', closedAt: 1 },
    ],
    settings: { sidebarPinnedOpen: true, theme: 'arcadia', themes: {} },
    favicons: ICONS,
    openTabsBy: { origin: 'safari-web-extension://margin', since: 1, synced: true },
    nextId: id,
  };
}

const freeze = (o) => Object.freeze(o);

export class MockState {
  constructor() {
    const { nextId, ...state } = bigState();
    this.nextId = nextId;
    this.state = state;
    this.ui = { windowId: WINDOW, tabId: null, mode: 'fullscreen', sidebar: 'open', palette: freeze({ open: false, query: '', selected: 0, newTab: false }) };
    this.vm = null;
    this.build();
  }

  get space() { return this.vm.space; }

  build() {
    this.vm = buildViewModel({ state: this.state, ui: this.ui, platform: { browser: 'safari', os: 'mac' }, settings: {} }, this.vm);
    return this.vm;
  }

  /** @param {(tabs: any) => any} fn */
  tabs(fn) { this.state = { ...this.state, tabs: fn({ ...this.state.tabs }) }; }

  // --- The updates the benchmark and tests make. Each returns the new vm.

  retitle(id, title) { this.tabs((tabs) => ({ ...tabs, [id]: { ...tabs[id], title } })); return this.build(); }
  activate(id) {
    this.tabs((tabs) => {
      for (const t of Object.values(tabs)) if (t.active && t.id !== id) tabs[t.id] = { ...t, active: false };
      tabs[id] = { ...tabs[id], active: true };
      return tabs;
    });
    return this.build();
  }
  // New tabs at the end of the window: the top of the list (newest first).
  addTabs(count) {
    const space = this.space.id;
    const top = Math.max(...Object.values(this.state.tabs).map((t) => t.index)) + 1;
    const tabSpace = { ...this.state.tabSpace };
    this.tabs((tabs) => {
      for (let i = 0; i < count; i++) {
        const [title, host, path] = SITES[(top + i) % SITES.length];
        const t = { id: this.nextId++, windowId: WINDOW, index: top + i, title: `${title} (new ${i})`, url: `https://${host}${path}?new=${this.nextId}`, favIconUrl: '', active: false, lastActive: 0 };
        tabs[t.id] = t;
        tabSpace[t.id] = space;
      }
      return tabs;
    });
    this.state = { ...this.state, tabSpace };
    return this.build();
  }
  removeTabs(count) {
    const gone = this.space.today.slice(0, count).map((t) => t.id);
    this.tabs((tabs) => { for (const id of gone) delete tabs[id]; return tabs; });
    return this.build();
  }
  // A tab moved in the list (as the sidebar shows it: newest first): the
  // window's order changes, nothing else.
  moveTab(from, to) {
    const ids = this.space.today.map((t) => t.id);
    const slots = ids.map((id) => this.state.tabs[id].index).sort((a, b) => b - a);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    this.tabs((tabs) => { ids.forEach((id, k) => { if (tabs[id].index !== slots[k]) tabs[id] = { ...tabs[id], index: slots[k] }; }); return tabs; });
    return this.build();
  }
  clearToday() {
    const gone = this.space.today.map((t) => t.id);
    this.tabs((tabs) => { for (const id of gone) delete tabs[id]; return tabs; });
    return this.build();
  }
  toggleFolder(id) {
    this.state = { ...this.state, folders: this.state.folders.map((f) => (f.id === id ? { ...f, open: !f.open } : f)) };
    return this.build();
  }
  switchSpace(id) {
    this.state = { ...this.state, activeSpaceByWindow: { ...this.state.activeSpaceByWindow, [WINDOW]: id } };
    return this.build();
  }
  setSidebar(sidebar) { this.ui = { ...this.ui, sidebar }; return this.build(); }
  setMode(mode) { this.ui = { ...this.ui, mode }; return this.build(); }
  openPalette(query = '') { this.ui = { ...this.ui, palette: freeze({ open: true, query, selected: 0, newTab: false }) }; return this.build(); }
  closePalette() { this.ui = { ...this.ui, palette: freeze({ open: false, query: '', selected: 0, newTab: false }) }; return this.build(); }
}
