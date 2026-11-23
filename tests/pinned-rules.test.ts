// shared/pinned-rules.ts, the pages' copy of the model's rules (state/model.ts): the same numbers and answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../extension/state/model.ts';
import * as R from '../extension/shared/pinned-rules.ts';
import { normalizeUrl } from '../extension/shared/view.ts';

test('the pages\' rules are the model\'s: the caps, a folder\'s depth, a space\'s favorites, an address\'s key', () => {
  assert.equal(R.FAVORITES_CAP, M.FAVORITES_CAP);
  assert.equal(R.MAX_FOLDER_DEPTH, M.MAX_FOLDER_DEPTH);
  let s = M.defaultState();
  s = M.createFolder(s, { id: 'a', spaceId: 'personal', name: 'A' });
  s = M.createFolder(s, { id: 'b', spaceId: 'personal', name: 'B', parentId: 'a' });
  s = M.createFolder(s, { id: 'c', spaceId: 'personal', name: 'C', parentId: 'b' });
  // A cycle in stored data.
  const cyclic = { ...s, folders: [...s.folders, { id: 'x', spaceId: 'personal', name: 'X', open: true, parentId: 'y' }, { id: 'y', spaceId: 'personal', name: 'Y', open: true, parentId: 'x' }] };
  for (const id of ['a', 'b', 'c', 'x', 'nope', null]) assert.equal(R.folderDepth(cyclic, id, 'personal'), M.folderDepth(cyclic, id, 'personal'), String(id));
  for (const settings of [s.settings, { ...s.settings, favoritesScope: 'profile' as const }]) {
    const st = { ...s, settings, spaces: [...s.spaces, { id: 'w', name: 'W', profile: 'p-1' } as any] };
    for (const space of ['personal', 'w', null]) assert.equal(R.favoriteScopeOf(st, space), M.favoriteScopeOf(st, space));
  }
  for (const url of ['https://a.example/', 'https://a.example/x?y=1#z', 'not a url', '', null]) assert.equal(normalizeUrl(url), M.normalizeUrl(url), String(url));
});
