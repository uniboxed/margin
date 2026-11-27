// The browser's own new tab, for a new tab Margin.app doesn't take (newtab/newtab.ts): Safari's start page
// (`favorites://`), Chrome's (`chrome://new-tab-page/`); none for Edge (it opens that address as an error page, and its
// own, `edge://newtab/`, is Margin's page again: the tab is left blank there). Tested headless 2026-11-27, Chrome 156
// and Edge; Safari's on the person's Safari.
export function ownNewTabUrl(browser: string | undefined, userAgent: string): string | null {
  if (browser === 'safari') return 'favorites://';
  if (browser === 'chrome') return /\bEdg\//.test(userAgent) ? null : 'chrome://new-tab-page/';
  return null;
}
