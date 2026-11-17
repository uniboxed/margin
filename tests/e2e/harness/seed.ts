// What a file seeds: the app's data set for the copy's profile, given in
// answer to its `data.hello` (the real path: background/link.ts takes it as
// its cache). The input is state-like (spaces, pins, folders, archive,
// settings: types/margin.d.ts); missing parts get Margin's defaults.
import { normalizeState } from '../../../extension/state/model.ts';
import { dataSetFrom } from '../../../extension/shared/data-set.ts';

/** @param input a state-like seed, or a data set already ({ format, items }) */
export function seedSet(input: any, { now = Date.now() } = {}) {
  if (input?.items && input?.format) return input;
  const state = normalizeState({ ...input, settings: { ...(input?.settings ?? {}) } });
  const set = dataSetFrom(state, { now });
  // Only what the seed names: a collection it leaves out stays as the copy has it.
  for (const c of Object.keys(set.items)) {
    const named = ({ spaces: 'spaces', pins: 'pins', folders: 'folders', archive: 'archive', settings: 'settings', themeSettings: 'settings', siteIcons: 'favicons', tabs: 'tabs' } as Record<string, string>)[c];
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
