// Sleeping tabs (background/sleep.ts): a tab not used for a while is put to
// sleep to free its page's memory. Safari has no tabs.discard (WebKit's
// extension engine: none, 2026-11-04), so Margin closes the browser tab and
// keeps its Margin tab, not open, in its space (Margin 2: PLAN.md §6); Chrome
// and Edge use tabs.discard. No imports: pure helpers.

// ---- a tab an earlier build left on Margin's sleep page --------------------------
// Builds before Margin 2 Phase 2 step 1 sent a sleeping tab to Margin's own
// sleep page, at an address carrying the page's (`sleep/sleep.html?u=…&t=…`).
// That page is gone (Phase 3): such a tab is found once, as Margin starts after
// the update (background/tabs.ts leftOnSleepPage), and kept as its Margin tab,
// not open, or loaded at its page's address if it's in front. Until then Margin
// knows it by its page (state/model.ts seenTab). Any copy's address (it
// changes with each copy of Margin), by its path. Remove with that handling, a
// release or two after Phase 3.
const OLD_SLEEP_PATH = '/sleep/sleep.html';
/** The page a tab on an earlier build's sleep page was: its address (a web page's only: http: or https:, as the URL parser reads it, else null) and title. Null for any other address. */
export function oldSleepPage(url: unknown): { url: string | null, title: string } | null {
  let at;
  try {
    at = new URL(String(url ?? ''));
  } catch {
    return null;
  }
  if (!/-extension:$/.test(at.protocol) || at.pathname !== OLD_SLEEP_PATH) return null;
  let page = null;
  try {
    const u = new URL(at.searchParams.get('u') ?? '');
    if (u.protocol === 'http:' || u.protocol === 'https:') page = u.href;
  } catch {}
  return { url: page, title: at.searchParams.get('t') ?? '' };
}

// ---- sites that never sleep ----------------------------------------------------
// A list of hostnames (settings.neverSleepSites), each matching itself and its
// subdomains. What's typed is taken generously: a whole address (scheme,
// path and all), "*.example.com", a port, upper case; a leading "www." goes
// (www.example.com means example.com and its subdomains). Anything that
// isn't a hostname is left out.
const SITES_MAX = 200;
/** @param input text (one per line, or separated by commas or spaces) or a list */
export function siteList(input: unknown): string[] {
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
export function neverSleeps(url: unknown, sites: unknown) {
  if (!Array.isArray(sites) || !sites.length) return false;
  let host;
  try {
    host = new URL(String(url ?? '')).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return false;
  }
  return siteList(sites).some((site) => host === site || host.endsWith(`.${site}`));
}
