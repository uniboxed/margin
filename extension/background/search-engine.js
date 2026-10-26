import { platform } from '../shared/platform.js';
import * as S from '../shared/search.js';
import { mutate, now } from './store.js';

// Safari has no search API: follow the engine Safari itself searches with,
// learned from its address-bar searches (shared/search.js). Chrome uses
// chrome.search.query instead (the `search` handler).
// Margin's own searches carry Safari-style URLs too, so they'd "confirm"
// Margin's current engine: a search in a tab Margin just searched in, with
// that same engine, isn't learned from. A different engine there is Safari's
// (the user searched from the address bar) and is.
export const OWN_SEARCH_MS = 30000;
export const ownSearchTabs = new Map(); // tabId → { at, template }
function isOwnSearch(tabId, found) {
  const own = ownSearchTabs.get(tabId);
  return !!own && now() - own.at < OWN_SEARCH_MS && own.template === found.template;
}
/** @param {string[]} urls @param {{ tabId?: number }} [options] */
export function learnSearchEngine(urls, { tabId } = {}) {
  if (platform?.search !== 'learn') return;
  const found = urls.map(S.detectSafariSearch).find(Boolean);
  if (!found) {
    // On an engine's site but without Safari's parameters: not an address-bar
    // search (or Safari changed them). Visible in the background console.
    const engine = urls.map(S.searchEngineOf).find(Boolean);
    if (engine) console.debug(`[margin] ${engine} search not from Safari's address bar (no Safari parameters), not learned:`, urls.find(S.searchEngineOf));
    return;
  }
  if (tabId != null && isOwnSearch(tabId, found)) return;
  return mutate((s) => (s.settings.safariSearch?.template === found.template
    ? s
    : { ...s, settings: { ...s.settings, safariSearch: { ...found, at: now() } } }));
}
