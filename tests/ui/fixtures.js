// A small stored state, shaped as pages read it (shared/stored.js
// fromStorage after readForPage): three spaces, two windows, a folder open
// and one closed holding the tab in front, a loose pin between them, a pin
// not open, a sleeping tab, a playing one, a site with no icon, a tab with
// no title, an archive.
import { pngIcon } from '../theme/view-model.js';

const icon = (rgb, at = 1) => ({ data: pngIcon(rgb), href: 'https://x.example/favicon.ico', at });

export const W = 7; // the window drawn
export const OTHER_WINDOW = 8;

export function smallState() {
  const tab = (id, windowId, index, url, title, extra = {}) => ({ id, windowId, index, url, title, favIconUrl: '', active: false, lastActive: index, ...extra });
  const tabs = {
    11: tab(11, W, 0, 'https://news.example/a', 'News A', { sleeping: { at: 5, how: 'page' } }),
    12: tab(12, W, 1, 'https://mail.example/', 'Mail', { audible: true }),
    13: tab(13, W, 2, 'https://docs.example/x', 'Docs', { active: true }),
    14: tab(14, W, 3, 'https://nofav.example/page', 'No icon here'),
    15: tab(15, W, 4, 'https://shop.example/', ''),
    21: tab(21, W, 5, 'https://work.example/', 'Work board'),
    16: tab(16, OTHER_WINDOW, 0, 'https://elsewhere.example/', 'In the other window', { active: true }),
  };
  return {
    spaces: [
      { id: 'home', name: 'Home', emoji: '🏠', color: '#6c5ce7' },
      { id: 'work', name: 'Deep Work', emoji: '💼', color: '#0984e3' },
      { id: 'side', name: 'Side', emoji: '🎨', color: '#00b894' },
    ],
    activeSpaceByWindow: { [W]: 'home', [OTHER_WINDOW]: 'home' },
    tabSpace: { 11: 'home', 12: 'home', 13: 'home', 14: 'home', 15: 'home', 16: 'home', 21: 'work' },
    tabs,
    pins: [
      { id: 'pa', spaceId: 'home', url: 'https://news.example/a', title: 'News (pinned)', folderId: 'f1', pos: 0 },
      { id: 'pb', spaceId: 'home', url: 'https://blog.example/p', title: 'Blog', folderId: 'f1', pos: 1 },
      { id: 'pc', spaceId: 'home', url: 'https://docs.example/x', title: 'Docs (pinned)', folderId: 'f2', pos: 0 },
      { id: 'pd', spaceId: 'home', url: 'https://cal.example/', title: 'Calendar', pos: 1 },
      { id: 'pw', spaceId: 'work', url: 'https://work.example/wiki', title: 'Wiki', pos: 0 },
    ],
    folders: [
      { id: 'f1', spaceId: 'home', name: 'Reading', open: true, pos: 0 },
      { id: 'f2', spaceId: 'home', name: 'Projects', open: false, pos: 2 },
    ],
    archive: [
      { id: 'ar1', url: 'https://gone.example/', title: 'Gone page', spaceId: 'home', favIconUrl: '', closedAt: 20 },
      { id: 'ar2', url: 'https://news.example/b', title: '', spaceId: 'work', favIconUrl: '', closedAt: 10 },
    ],
    settings: { sidebarPinnedOpen: false, theme: 'arcadia', themes: { arcadia: { sidebarWidth: 260 } } },
    favicons: {
      'https://news.example': icon([200, 30, 30]),
      'https://mail.example': icon([30, 200, 30]),
      'https://docs.example': icon([30, 30, 200]),
      'https://blog.example': icon([90, 90, 90]),
      'https://cal.example': icon([200, 200, 30]),
      'https://shop.example': icon([200, 30, 200]),
      'https://work.example': icon([30, 200, 200]),
      'https://gone.example': icon([10, 10, 10]),
    },
    faviconsMark: '8:8',
    openTabsBy: { origin: 'safari-web-extension://margin', since: 1, synced: true },
    owner: null,
  };
}

export { icon };
