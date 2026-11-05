// A mock theme view model, shaped like PLAN.md §3 ("What a theme can read"):
// window, space (folders with tabs, pins, today), spaces, tab, archive,
// palette, notice, settings, platform. Three spaces; Personal holds 200 tabs.
// Updates are immutable, as a state mirror applying deltas would make them:
// a changed tab is a new object, its lists and space are new, everything
// else is the same object as before (the renderer skips rows whose item is).
// Runs in Node and in pages.

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

// --- The data ---------------------------------------------------------------

const SITES = [
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
const ICONS = SITES.map((s) => pngIcon(s[3]));
const hex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

let nextId = 1000;
function makeTab(n, { active = false } = {}) {
  const [title, host, path, rgb] = SITES[n % SITES.length];
  const id = nextId++;
  const noIcon = n % 7 === 3; // some sites have no icon: a letter avatar
  return Object.freeze({
    id,
    title: n < SITES.length ? title : `${title} (${Math.floor(n / SITES.length) + 1})`,
    host,
    url: `https://${host}${path}`,
    icon: noIcon ? null : ICONS[n % ICONS.length],
    letter: host[0].toUpperCase(),
    color: hex(rgb),
    active,
    audible: n % 23 === 5,
    asleep: n % 11 === 4,
    pinned: false,
  });
}

const SPACES = [
  { id: 'personal', name: 'Personal', abbr: 'ME', emoji: '🙂', color: '#ffd23f', folders: [['Reading', 20], ['Lisbon', 10]], today: 170 },
  { id: 'work', name: 'Work', abbr: 'WK', emoji: '💼', color: '#7fb3ff', folders: [['Q4', 3], ['Team', 2]], today: 3 },
  { id: 'studio', name: 'Studio', abbr: 'ST', emoji: '🎨', color: '#ff8fd8', folders: [['Campaign', 3], ['Assets', 2]], today: 3 },
];

const countTabs = (s) => s.folders.reduce((n, f) => n + f.tabs.length, 0) + s.pins.length + s.today.length;
const freezeSpace = (s) => Object.freeze({ ...s, tabCount: countTabs(s), hasToday: s.today.length > 0 });

export class MockState {
  constructor() {
    nextId = 1000;
    let n = 0;
    this.spaces = new Map();
    SPACES.forEach((def, index) => {
      const folders = def.folders.map(([name, count], fi) => Object.freeze({
        id: `${def.id}-f${fi}`, name, open: true,
        tabs: Object.freeze(Array.from({ length: count }, () => makeTab(n++, { active: false }))),
      }));
      const today = Array.from({ length: def.today }, () => makeTab(n++));
      this.spaces.set(def.id, freezeSpace({
        id: def.id, name: def.name, abbr: def.abbr, emoji: def.emoji, color: def.color, index,
        folders: Object.freeze(folders), pins: Object.freeze([]), today: Object.freeze(today),
      }));
    });
    this.tabCounter = n;
    this.spaceId = 'personal';
    this.sidebar = 'open';
    this.mode = 'fullscreen';
    this.palette = Object.freeze({ open: false, query: '', rows: Object.freeze([]) });
    // The first tab of the first folder is the active one.
    this.activeId = this.space.folders[0].tabs[0].id;
    this.setActive(this.activeId);
    this.build();
  }

  get space() { return this.spaces.get(this.spaceId); }

  build() {
    const space = this.space;
    let active = null;
    for (const f of space.folders) for (const t of f.tabs) if (t.active) active = t;
    for (const t of space.today) if (t.active) active = t;
    active ??= space.folders[0]?.tabs[0] ?? space.today[0];
    this.chips ??= new Map();
    const spaces = [...this.spaces.values()].map((s) => {
      const on = s.id === this.spaceId;
      const key = `${s.id}:${on}`;
      if (!this.chips.has(key)) this.chips.set(key, Object.freeze({ id: s.id, name: s.name, abbr: s.abbr, emoji: s.emoji, color: s.color, index: s.index, active: on }));
      return this.chips.get(key);
    });
    this.vm = Object.freeze({
      window: Object.freeze({ mode: this.mode, focused: true, sidebar: this.sidebar, sidebarOpen: this.sidebar === 'open' }),
      space,
      spaces: Object.freeze(spaces),
      tab: Object.freeze({ id: active.id, title: active.title, host: active.host, url: active.url, loading: false, audible: active.audible, asleep: false }),
      archive: Object.freeze([{ id: 'a1', title: 'An archived page', host: 'old.example', url: 'https://old.example/', closedAt: 0 }]),
      palette: this.palette,
      notice: null,
      settings: Object.freeze({}),
      platform: Object.freeze({ browser: 'safari', os: 'mac' }),
      // Not for themes: lets the action checks see every space's tabs.
      allSpaces: Object.freeze([...this.spaces.values()]),
    });
    return this.vm;
  }

  // Replaces one tab (by id) in the current space, wherever it is.
  mapTab(id, fn) {
    const s = this.space;
    let folders = s.folders;
    let today = s.today;
    const fi = folders.findIndex((f) => f.tabs.some((t) => t.id === id));
    if (fi >= 0) {
      const f = folders[fi];
      const tabs = Object.freeze(f.tabs.map((t) => (t.id === id ? Object.freeze(fn(t)) : t)));
      folders = Object.freeze(folders.map((x, i) => (i === fi ? Object.freeze({ ...f, tabs }) : x)));
    } else if (today.some((t) => t.id === id)) {
      today = Object.freeze(today.map((t) => (t.id === id ? Object.freeze(fn(t)) : t)));
    } else return;
    this.spaces.set(s.id, freezeSpace({ ...s, folders, today }));
  }

  setActive(id) {
    for (const space of this.spaces.values()) {
      const was = [...space.folders.flatMap((f) => f.tabs), ...space.today].find((t) => t.active);
      if (was && was.id !== id) { const keep = this.spaceId; this.spaceId = space.id; this.mapTab(was.id, (t) => ({ ...t, active: false })); this.spaceId = keep; }
    }
    this.mapTab(id, (t) => ({ ...t, active: true }));
    this.activeId = id;
  }

  // --- The updates the benchmark and tests make. Each returns the new vm.

  retitle(id, title) { this.mapTab(id, (t) => ({ ...t, title })); return this.build(); }
  activate(id) { this.setActive(id); return this.build(); }
  addTabs(count) {
    const s = this.space;
    const fresh = Array.from({ length: count }, () => makeTab(this.tabCounter++));
    this.spaces.set(s.id, freezeSpace({ ...s, today: Object.freeze([...fresh, ...s.today]) }));
    return this.build();
  }
  removeTabs(count) {
    const s = this.space;
    this.spaces.set(s.id, freezeSpace({ ...s, today: Object.freeze(s.today.slice(count)) }));
    return this.build();
  }
  moveTab(from, to) {
    const s = this.space;
    const today = [...s.today];
    const [t] = today.splice(from, 1);
    today.splice(to, 0, t);
    this.spaces.set(s.id, freezeSpace({ ...s, today: Object.freeze(today) }));
    return this.build();
  }
  clearToday() { const s = this.space; this.spaces.set(s.id, freezeSpace({ ...s, today: Object.freeze([]) })); return this.build(); }
  toggleFolder(id) {
    const s = this.space;
    const folders = Object.freeze(s.folders.map((f) => (f.id === id ? Object.freeze({ ...f, open: !f.open }) : f)));
    this.spaces.set(s.id, freezeSpace({ ...s, folders }));
    return this.build();
  }
  switchSpace(id) { if (this.spaces.has(id)) this.spaceId = id; return this.build(); }
  setSidebar(state) { this.sidebar = state; return this.build(); }
  setMode(mode) { this.mode = mode; return this.build(); }
  openPalette(query = '') {
    const s = this.space;
    const tabs = [...s.folders.flatMap((f) => f.tabs), ...s.today].slice(0, 4);
    const rows = tabs.map((t, i) => Object.freeze({ id: `row-${t.id}`, tag: 'TAB', text: t.title, color: s.color, selected: i === 0 }));
    rows.push(Object.freeze({ id: 'row-search', tag: 'SEARCH', text: query || 'Search the web', color: '#5cf0a8', selected: false }));
    this.palette = Object.freeze({ open: true, query, rows: Object.freeze(rows) });
    return this.build();
  }
  closePalette() { this.palette = Object.freeze({ open: false, query: '', rows: Object.freeze([]) }); return this.build(); }

  // A tab row in today, by position.
  todayTab(i) { return this.space.today[i]; }
}
