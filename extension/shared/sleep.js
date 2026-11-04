// Sleeping tabs (background/sleep.js): a tab not used for a while is put to
// sleep to free its page's memory. Safari has no tabs.discard (WebKit's
// extension engine: none, 2026-11-04), so the tab goes to Margin's own small
// sleep page, at an address that carries the page's own: the page goes away
// with its process. Shown, the sleep page sends the tab back to that address.
// Chrome uses tabs.discard. No imports: the sleep page itself loads this (sleep/sleep.js).

export const SLEEP_PATH = 'sleep/sleep.html';
const TITLE_MAX = 300;

// Margin's sleep page, from any copy of Margin (an extension's address changes
// with each copy: an update, a Safari relaunch).
/** @param {unknown} url */
export function isSleepPage(url) {
  let at;
  try {
    at = new URL(String(url ?? ''));
  } catch {
    return false;
  }
  return /-extension:$/.test(at.protocol) && at.pathname === `/${SLEEP_PATH}`;
}

// The address a sleeping tab goes back to: only a web page's (http: or
// https:, as the URL parser reads it), never anything else (javascript:,
// data:, file:, another extension's page). Null otherwise.
/** @param {unknown} raw */
export function wakeTarget(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
}

// The sleep page's address for a page: `base` is the copy's own
// (runtime.getURL('')); `key` names this sleep (the background's wake says it).
/** @param {string} base @param {{ url: string, title?: string, key: string }} page */
export function sleepAddress(base, { url, title = '', key }) {
  const params = new URLSearchParams({ u: url, t: String(title ?? '').slice(0, TITLE_MAX), k: key });
  return `${base}${SLEEP_PATH}?${params}`;
}

// What a sleep page's address says: the page's address (`url`, null if it
// isn't a web page's: `raw` is what was there), its title, the sleep's key.
// Null for any other address.
/** @param {unknown} url @returns {{ url: string | null, raw: string, title: string, key: string } | null} */
export function readSleepAddress(url) {
  if (!isSleepPage(url)) return null;
  const params = new URL(String(url)).searchParams;
  const raw = params.get('u') ?? '';
  return { url: wakeTarget(raw), raw, title: params.get('t') ?? '', key: params.get('k') ?? '' };
}

// ---- sites that never sleep ----------------------------------------------------
// A list of hostnames (settings.neverSleepSites), each matching itself and its
// subdomains. What's typed is taken generously: a whole address (scheme,
// path and all), "*.example.com", a port, upper case; a leading "www." goes
// (www.example.com means example.com and its subdomains). Anything that
// isn't a hostname is left out.
const SITES_MAX = 200;
/** @param {unknown} input text (one per line, or separated by commas or spaces) or a list @returns {string[]} */
export function siteList(input) {
  const items = Array.isArray(input) ? input : String(input ?? '').split(/[\s,]+/);
  const out = [];
  for (const item of items) {
    let text = String(item ?? '').trim().toLowerCase();
    if (!text) continue;
    text = text.replace(/^\*\./, '');
    let host;
    try {
      host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `http://${text}`).hostname;
    } catch {
      continue;
    }
    host = host.replace(/\.$/, '').replace(/^www\./, '');
    if (!host || !/^[a-z0-9.[\]:-]+$/.test(host) || out.includes(host)) continue;
    out.push(host);
    if (out.length >= SITES_MAX) break;
  }
  return out;
}

// Whether a page's address is on the list (a site that never sleeps).
/** @param {unknown} url @param {unknown} sites */
export function neverSleeps(url, sites) {
  if (!Array.isArray(sites) || !sites.length) return false;
  let host;
  try {
    host = new URL(String(url ?? '')).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return false;
  }
  return siteList(sites).some((site) => host === site || host.endsWith(`.${site}`));
}

// ---- the sleep page ------------------------------------------------------------
// The page a sleeping tab shows (sleep/sleep.html): its title is the page's, and
// its icon the site's (Margin's own copy of it, read once). It looks like the
// card Margin shows for a page that's loading (its switch cover). Shown
// (visible at load, once it becomes visible, back from the back/forward
// cache), it goes back to the page's address at once, by sending its tab
// there (tabs.update: WebKit lets neither an extension page navigate itself to
// a web page nor a web page to an extension page, both seen in the WebKit
// host, 2026-11-04; the browser gives the tab a web view of the page's kind).
// Never by itself while hidden (a switch of Margin's wakes a tab behind the
// page in front itself: background/tabs.js restoreTab). An address that isn't
// a web page's (missing, broken, another scheme) isn't gone to: the page says
// so and shows what was there. Nothing here listens to storage.
//
// Where the browser keeps a tab's history through such a change (the WebKit
// host makes a new web view with a history of its own: Safari unverified),
// the sleep page stays in it, before the page it went back to. Reached again
// from there (Back, or Forward after Back went past it), it isn't a sleep to
// wake from, whatever the history's length (WebKit keeps at most about 100
// entries, so a long one stops growing). It knows by its entry: marked
// (history.state, and sessionStorage by its key) before it sends its tab
// back, and woken by Margin's background (storage.session, by its key:
// wokeKey). It then goes on the way it was reached when the Navigation API
// says (Back goes back once more, Forward forward), else offers its page's
// link and does nothing by itself. Never back and forth: no loop. Its history
// longer than as it first loaded says the same (an entry after it). A
// relaunch that restores it as the tab's last page, never woken, wakes.
// `win`, `doc`, `api`: the page's window, document and extension API (tests
// pass their own). Returns what it did, for tests.
const BACK_MS = 1500;
const WOKE_READ_MS = 400;
// storage.session: this sleep was woken by Margin's background (background/tabs.js wakeAsleep).
/** @param {string} key */
export const wokeKey = (key) => `sleepWoke:${key}`;
/** @param {{ win: any, doc: any, api: any }} env */
export function startSleepPage({ win, doc, api }) {
  const info = readSleepAddress(win.location.href) ?? { url: null, raw: '', title: '', key: '' };
  const target = info.url;
  const key = info.key || String(win.location.href);
  let host = '';
  try {
    host = target ? new URL(target).host : '';
  } catch {}
  doc.title = info.title || host || 'Asleep';
  const text = (/** @type {string} */ id, /** @type {string} */ value) => {
    const node = doc.getElementById?.(id);
    if (node) node.textContent = value;
  };
  text('site', info.title || host);
  text('address', target ?? info.raw);
  if (!target) {
    doc.documentElement?.setAttribute?.('data-broken', '');
    text('note', info.raw ? 'This tab was asleep, but its address isn’t a web page’s, so Margin won’t open it.' : 'This tab was asleep, but its address is missing.');
  }
  // How long the tab's history was as this sleep page first loaded.
  const KEPT = `margin-sleep:${key}`;
  const MARK = `margin-woke:${key}`;
  /** @type {number | null} */
  let firstLength = null;
  try {
    const kept = win.sessionStorage.getItem(KEPT);
    if (kept != null && Number.isFinite(Number(kept))) firstLength = Number(kept);
    else win.sessionStorage.setItem(KEPT, String(win.history.length));
  } catch {}
  const passed = () => firstLength != null && win.history.length > firstLength;
  // This entry: woken from before (by this page, or by Margin's background).
  const marked = () => {
    try {
      if (win.history.state?.marginWoke === key) return true;
    } catch {}
    try {
      return win.sessionStorage.getItem(MARK) === '1';
    } catch {
      return false;
    }
  };
  const mark = () => {
    try {
      const state = win.history.state;
      win.history.replaceState({ ...(state && typeof state === 'object' ? state : {}), marginWoke: key }, '');
    } catch {}
    try {
      win.sessionStorage.setItem(MARK, '1');
    } catch {}
  };
  // Read as it loads, and again back from the back/forward cache.
  const readWoke = () => /** @type {Promise<boolean>} */ (new Promise((resolve) => {
    win.setTimeout(() => resolve(false), WOKE_READ_MS);
    try {
      Promise.resolve(api?.storage?.session?.get?.(wokeKey(key))).then((stored) => resolve(!!stored?.[wokeKey(key)]), () => resolve(false));
    } catch {
      resolve(false);
    }
  }));
  let wokeByMargin = readWoke();
  // How this entry was reached, when the Navigation API says: 'back',
  // 'forward', or null (not known: another site's page came before, or no API).
  const reached = () => {
    try {
      const activation = win.navigation?.activation;
      if (activation?.navigationType !== 'traverse') return null;
      const from = activation.from?.index;
      const to = activation.entry?.index;
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from === to) return null;
      return from > to ? 'back' : 'forward';
    } catch {
      return null;
    }
  };
  // Sent there from this page (the API); a page with none (Margin gone) tries
  // the page's own way, and the link is offered.
  const go = async () => {
    mark();
    try {
      const tab = await api?.tabs?.getCurrent?.();
      if (tab?.id != null && (await Promise.resolve(api.tabs.update(tab.id, { url: target })).then(() => true, () => false))) return true;
    } catch {}
    try {
      win.location.replace(target);
    } catch {}
    return false;
  };
  const offer = () => {
    doc.documentElement?.setAttribute?.('data-offer', '');
    const button = doc.getElementById?.('go');
    if (!button || button.dataset?.wired) return;
    if (button.dataset) button.dataset.wired = '1';
    button.hidden = false;
    button.addEventListener('click', () => void go());
  };
  let woke = false;
  /** @param {string} why @returns {Promise<string | false>} */
  const wake = async (why) => {
    if (woke || !target) return false;
    woke = true;
    if (marked() || passed() || (await wokeByMargin)) {
      // An old entry: on the way it was reached, or nothing by itself.
      const way = reached();
      try {
        if (way === 'back') win.history.back();
        else if (way === 'forward') win.history.forward();
      } catch {}
      if (way) win.setTimeout(offer, BACK_MS); // (gone by then if it went on)
      else offer();
      return way ?? 'offered';
    }
    void go().then((sent) => { if (!sent) win.setTimeout(offer, BACK_MS); });
    return why;
  };
  const shown = () => doc.visibilityState === 'visible' && !woke && (void wake('shown'), true);
  doc.addEventListener('visibilitychange', shown);
  win.addEventListener('pageshow', (/** @type {any} */ event) => {
    // Back from the back/forward cache: shown again, and looks again.
    if (event?.persisted) {
      woke = false;
      wokeByMargin = readWoke();
    }
    shown();
  });
  shown();
  // The site's icon, from Margin's own copy (shared/stored.js FAVICONS), once.
  if (target) {
    try {
      const origin = new URL(target).origin;
      Promise.resolve(api?.storage?.local?.get('favicons')).then((stored) => {
        const data = stored?.favicons?.[origin]?.data;
        if (typeof data !== 'string' || !/^data:image\//.test(data)) return;
        const link = doc.createElement('link');
        link.rel = 'icon';
        link.href = data;
        doc.head?.append(link);
      }, () => {});
    } catch {}
  }
  return { target, wake, woke: () => woke };
}
