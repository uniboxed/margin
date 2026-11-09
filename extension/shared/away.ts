// The stand-in page (away/away.html, app/WINDOWS.md §9): what a window shows in front while the tab it has
// chosen is live in another window of the profile (the tab follows the window in front, as Arc's). It's Margin's
// own page, never a Margin tab: not recorded among the tabs (state/model.ts upsertTab, syncTabs), so never
// listed, kept, synced, slept, counted or followed. Pure.

const AWAY_PAGE = /^[a-z-]+-extension:\/\/[^/]+\/away\/away\.html(\?[^#]*)?(#.*)?$/i;

/** Whether this address is the stand-in page. */
export const isAwayPage = (url: unknown) => AWAY_PAGE.test(String(url ?? ''));

/** The stand-in's path, for runtime.getURL. */
export const AWAY_PATH = 'away/away.html';
