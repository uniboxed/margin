// What a file seeds: the app's data set for the copy's profile, given in
// answer to its `data.hello` (the real path: background/link.ts takes it as
// its cache). The input is state-like (spaces, pins, folders, archive,
// settings: types/margin.d.ts); missing parts get Margin's defaults.
import { normalizeState } from '../../../extension/state/model.ts';
import { dataSetFrom } from '../../../extension/shared/data-set.ts';
import { cloudFixture } from '../../fixtures/cloud-tabs.ts';

/** @param input a state-like seed, or a data set already ({ format, items }) */
export function seedSet(input: any, { now = Date.now() } = {}) {
  if (input?.items && input?.format) return input;
  const state = normalizeState({ ...input, settings: { ...(input?.settings ?? {}) } });
  const set = dataSetFrom(state, { now });
  // Only what the seed names: a collection it leaves out stays as the copy has it.
  for (const c of Object.keys(set.items)) {
    const named = { spaces: 'spaces', pins: 'pins', folders: 'folders', archive: 'archive', settings: 'settings', themeSettings: 'settings', siteIcons: 'favicons', tabs: 'tabs' }[c];
    if (!named || !(named in (input ?? {}))) delete set.items[c];
  }
  return set;
}

// A few spaces that look like a person's.
export const SPACES = [
  { id: 'sp-home', name: 'Home', emoji: '🏡', color: '#7c9cff' },
  { id: 'sp-work', name: 'Work', emoji: '💼', color: '#f2a65a' },
  { id: 'sp-trips', name: 'Trips', emoji: '🧭', color: '#5bc0a8' },
];

// iCloud Tabs as the app sends them (tests/fixtures/cloud-tabs.ts: made-up
// devices), with this test site's pages for their tabs. @param {(host: string, path?: string) => string} url
export function cloudTabsOf(url, now = Date.now()) {
  const cloud = cloudFixture(now);
  const pages = {
    'T-PHONE-1': ['Harbor — Quiet places by the sea', url('harbor.test', '/')],
    'T-PHONE-2': ['The Quiet City | The Dispatch', url('dispatch.test', '/2026/11/the-quiet-city')],
    'T-PHONE-3': ['Canvas Tote — Common Goods', url('shop.test', '/p/canvas-tote')],
    'T-AIR-1': ['Q3 2026 Field Report · Almanac', url('slow.test', '/report')],
    'T-AIR-2': ['Installation · Lattice docs', url('docs.test', '/guide/installation')],
    'T-PAD-1': ['The sound of low tide · Radio Field', url('radio.test', '/')],
  };
  for (const d of cloud.devices) for (const t of d.tabs) if (pages[t.id]) [t.title, t.url] = pages[t.id];
  return cloud;
}
