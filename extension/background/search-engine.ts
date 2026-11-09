import { platform } from '../shared/platform.ts';
import * as S from '../shared/search.ts';
import { mutate, now } from './store.ts';

// Safari has no search API: follow the engine Safari itself searches with,
// learned from its address-bar searches (shared/search.ts). Chrome uses
// chrome.search.query instead (the `search` handler).
// Margin's own searches carry Safari-style URLs too, so they'd "confirm"
// Margin's current engine: a search in a tab Margin just searched in, with
// that same engine, isn't learned from. A different engine there is Safari's
// (the user searched from the address bar) and is.
// A new tab Margin opens at its search's address (background/tabs.ts
// openBehind) has no id before it exists: that search is known by its address.
export const OWN_SEARCH_MS = 30000;
export const ownSearchTabs = new Map(); // tabId → { at, template }
export const ownSearchUrls = new Map(); // address → { at, template }
const sameAddress = (a: string, b) => {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
};
// Addresses Margin opens again from its own records: a Margin tab that wasn't
// open (one put to sleep, one lost with its window) opened as it's clicked, or
// with a space's window. A search page among them is a search made before,
// maybe with an engine since changed, not one Safari makes now (the sleep
// page's wake had the same rule: DECISIONS.md, "Sleeping tabs: the review's
// fixes"). Known by the address, for OWN_SEARCH_MS.
const reopenedUrls = new Map(); // address → when
export function noteReopened(url: unknown) {
  if (typeof url !== 'string' || !url) return;
  const at = now();
  for (const [u, t] of reopenedUrls) if (at - t >= OWN_SEARCH_MS) reopenedUrls.delete(u);
  reopenedUrls.set(url, at);
}
const reopened = (urls: string[]) => [...reopenedUrls].some(([url, at]) => now() - at < OWN_SEARCH_MS && urls.some((u) => sameAddress(u, url)));
function isOwnSearch(tabId: number | undefined, found: { id: string; name: string; template: string; }, urls: string[]) {
  const fresh = (own) => !!own && now() - own.at < OWN_SEARCH_MS && own.template === found.template;
  if (tabId != null && fresh(ownSearchTabs.get(tabId))) return true;
  for (const [url, own] of ownSearchUrls) if (fresh(own) && urls.some((u) => sameAddress(u, url))) return true;
  return false;
}
export function learnSearchEngine(urls: string[], { tabId }: { tabId?: number } = {}) {
  if (platform?.search !== 'learn') return;
  const found = urls.map(S.detectSafariSearch).find(Boolean);
  if (!found) {
    // On an engine's site but without Safari's parameters: not an address-bar
    // search (or Safari changed them). Visible in the background console.
    const engine = urls.map(S.searchEngineOf).find(Boolean);
    if (engine) console.debug(`[margin] ${engine} search not from Safari's address bar (no Safari parameters), not learned:`, urls.find(S.searchEngineOf));
    return;
  }
  if (isOwnSearch(tabId, found, urls) || reopened(urls)) return;
  return mutate((s) => (s.settings.safariSearch?.template === found.template
    ? s
    : { ...s, settings: { ...s.settings, safariSearch: { ...found, at: now() } } }));
}
