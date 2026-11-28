// Site search in the command bar, as Arc's (docs/ARC-COMMAND-BAR.md, Part 2 "Site search"): typing a site's name or
// domain offers "Search <site>" with Tab; Tab puts the site's pill in the field, its colour on the bar, and what's
// typed then is searched on that site. Arc's built-in sites (its `ADK.Engine` table: keyword, search address, brand
// colour) and Google, Chromium's own default. Each address has `%s` for the encoded query. Pure: the view model and the
// palette's behaviour use it.

export type Site = { id: string, name: string, keyword: string, url: string, color: string };

export const SITES: readonly Site[] = Object.freeze([
  { id: 'google', name: 'Google', keyword: 'google.com', url: 'https://www.google.com/search?q=%s', color: '#4285F4' },
  { id: 'youtube', name: 'YouTube', keyword: 'youtube.com', url: 'https://www.youtube.com/results?search_query=%s', color: '#FF0000' },
  { id: 'github', name: 'GitHub', keyword: 'github.com', url: 'https://github.com/search?q=%s', color: '#743FC7' },
  { id: 'x', name: 'X', keyword: 'x.com', url: 'https://x.com/search?q=%s', color: '#000000' },
  { id: 'twitter', name: 'X', keyword: 'twitter.com', url: 'https://twitter.com/search?q=%s', color: '#000000' },
  { id: 'reddit', name: 'Reddit', keyword: 'reddit.com', url: 'https://www.reddit.com/search/?q=%s', color: '#FF4500' },
  { id: 'wikipedia', name: 'Wikipedia', keyword: 'wikipedia.org', url: 'https://wikipedia.org/w/index.php?search=%s', color: '#636466' },
  { id: 'amazon', name: 'Amazon', keyword: 'amazon.com', url: 'https://www.amazon.com/s?k=%s', color: '#FF9900' },
  { id: 'drive', name: 'Google Drive', keyword: 'drive.google.com', url: 'https://drive.google.com/drive/search?q=%s', color: '#0F9D58' },
  { id: 'gmail', name: 'Gmail', keyword: 'mail.google.com', url: 'https://mail.google.com/mail/ca/u/0/#apps/%s', color: '#D44638' },
  { id: 'maps', name: 'Google Maps', keyword: 'maps.google.com', url: 'https://www.google.com/maps/search/%s', color: '#FBBC05' },
  { id: 'calendar', name: 'Google Calendar', keyword: 'calendar.google.com', url: 'https://calendar.google.com/calendar/u/0/r/search?q=%s', color: '#9C27B0' },
  { id: 'docs', name: 'Google Docs', keyword: 'docs.google.com', url: 'https://docs.google.com/document/u/0/?q=%s', color: '#4285F4' },
  { id: 'dropbox', name: 'Dropbox', keyword: 'dropbox.com', url: 'https://www.dropbox.com/search/personal?&query=%s', color: '#007EE5' },
  { id: 'figma', name: 'Figma', keyword: 'figma.com', url: 'https://www.figma.com/files/search?q=%s', color: '#F24E1E' },
  { id: 'soundcloud', name: 'SoundCloud', keyword: 'soundcloud.com', url: 'https://soundcloud.com/search?q=%s', color: '#F85216' },
  { id: 'asana', name: 'Asana', keyword: 'asana.com', url: 'https://app.asana.com/0/search?q=%s', color: '#F06A6A' },
  { id: 'linkedin', name: 'LinkedIn', keyword: 'linkedin.com', url: 'https://linkedin.com/search/results/all/?keywords=%s', color: '#0B66C2' },
  { id: 'applemusic', name: 'Apple Music', keyword: 'music.apple.com', url: 'https://music.apple.com/us/search?term=%s', color: '#FA2A44' },
  { id: 'spotify', name: 'Spotify', keyword: 'spotify.com', url: 'https://open.spotify.com/search/%s', color: '#1DB954' },
]);

/** A site by its id (null: none such). */
export const siteById = (id: unknown) => SITES.find((s) => s.id === id) ?? null;

/**
 * The site what's typed names, for "Search <site>" (Tab): at least two characters, one word, the start of a site's
 * domain ("youtu" → youtube.com; "www." left off) or of its name with its spaces left out ("googlem" → Google Maps).
 * The first in the table wins; null: none.
 */
export function siteFor(typed: string): Site | null {
  const q = String(typed ?? '').trim().toLowerCase().replace(/^www\./, '');
  if (q.length < 2 || /\s/.test(q)) return null;
  return SITES.find((s) => s.keyword.startsWith(q) || s.name.toLowerCase().replace(/\s+/g, '').startsWith(q)) ?? null;
}

/** The address of `query` searched on `site` (null: nothing to search). */
export function siteUrl(site: Site, query: string): string | null {
  const q = String(query ?? '').trim();
  if (!q) return null;
  return site.url.replace('%s', encodeURIComponent(q));
}
