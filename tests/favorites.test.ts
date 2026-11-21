import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../extension/state/model.ts';
import * as V from '../extension/shared/view.ts';
import { buildViewModel } from '../extension/ui/view-model.ts';
import { menuItems } from '../extension/ui/behaviors/menu-items.ts';
import { dropAction, dropTarget } from '../extension/ui/behaviors/drop-rules.ts';
import { checkAction, contextFromState, requestFor } from '../extension/ui/actions.ts';
import { settingsFields, saveField } from '../extension/ui/settings-form.ts';
import * as L from '../app/shared/library/library.ts';

function applyChanges(values: L.Values, changes: L.Change[]): L.Values {
  const next: L.Values = structuredClone(values);
  for (const c of changes) {
    next[c.collection] ??= {};
    if ('deleted' in c && c.deleted) delete next[c.collection][c.id];
    else next[c.collection][c.id] = (c as { value: any }).value;
  }
  return next;
}

test('M2.3 favorites: global by default across spaces, optional per-profile scope, cap 12, column layout', () => {
  let s = M.defaultState();
  s = M.createSpace(s, { id: 'work', name: 'Work', emoji: '💼', color: '#0984e3' });
  s = M.setActiveSpace(s, 1, 'personal');

  s = M.addFavorite(s, { id: 'fav-1', scope: 'global', url: 'https://mail.example/', title: 'Mail' });
  s = M.addFavorite(s, { id: 'fav-2', scope: 'global', url: 'app://com.apple.Notes', title: 'Notes', target: { kind: 'app', bundleId: 'com.apple.Notes', name: 'Notes' } });

  // Visible in Personal AND Work when favoritesScope === 'global'.
  const vmPersonal = buildViewModel({ state: s, ui: { windowId: 1 } });
  assert.equal(vmPersonal.favorites.hasItems, true);
  assert.equal(vmPersonal.favorites.columns, 2);
  assert.deepEqual(vmPersonal.favorites.items.map((f) => f.id), ['fav-1', 'fav-2']);

  s = M.setActiveSpace(s, 1, 'work');
  const vmWork = buildViewModel({ state: s, ui: { windowId: 1 } });
  assert.deepEqual(vmWork.favorites.items.map((f) => f.id), ['fav-1', 'fav-2'], 'global favorites persist across Space switches');

  // Cap at 12 per scope.
  for (let i = 3; i <= 15; i++) {
    s = M.addFavorite(s, { id: `fav-${i}`, scope: 'global', url: `https://site${i}.example/`, title: `Site ${i}` });
  }
  assert.equal((s.favorites ?? []).length, 12, 'capped at FAVORITES_CAP = 12');
  const vm12 = buildViewModel({ state: s, ui: { windowId: 1 } });
  assert.equal(vm12.favorites.columns, 4);

  // Per-profile scope isolates favorites from global.
  s = { ...s, settings: { ...s.settings, favoritesScope: 'profile' } };
  const profileScope = M.favoriteScopeOf(s, 'work');
  s = M.addFavorite(s, { id: 'fav-p1', scope: profileScope, url: 'https://work.example/', title: 'Work' });
  const vmProfile = buildViewModel({ state: s, ui: { windowId: 1 } });
  assert.deepEqual(vmProfile.favorites.items.map((f) => f.id), ['fav-p1']);
});

test('M2.3 favorites: sticky binding survives sub-navigation, marks drifted, excludes from Today, and resets cleanly', () => {
  let s = M.defaultState();
  s = M.setActiveSpace(s, 1, 'personal');
  s = M.addFavorite(s, { id: 'fav-gh', scope: 'global', url: 'https://github.com/', title: 'GitHub' });
  s = M.upsertTab(s, { id: 20, windowId: 1, index: 0, active: true, url: 'https://github.com/pulls', title: 'Pull Requests' } as BrowserTab, 100);
  s = M.moveTab(s, 20, 'personal');
  s = M.bindTabToFavorite(s, 20, 'fav-gh');

  const sb = V.sidebar(s, 1);
  assert.equal(sb.tabs.length, 0, 'favorite-bound tab never leaks into Today');
  assert.equal(sb.favorites[0].tabId, 20);
  assert.equal(sb.favorites[0].drifted, true);
  assert.equal(sb.favorites[0].rootUrl, 'https://github.com/');

  const vm = buildViewModel({ state: s, ui: { windowId: 1, tabId: 20 } });
  const menu = menuItems({ kind: 'favorite', id: 'fav-gh' }, { state: s, space: vm.space, favorites: vm.favorites });
  assert.equal(menu[0].label, 'Reset to Favorite URL');
  assert.equal(menu[0].action, 'favorite.reset');
  assert.equal(checkAction('favorite.reset', 'fav-gh', contextFromState(s)).ok, true);
  assert.deepEqual(requestFor('favorite.reset', 'fav-gh', { state: s, ui: { windowId: 1 } }), { kind: 'send', type: 'resetFavorite', payload: { favoriteId: 'fav-gh', windowId: 1 } });
});

test('M2.3 favorites: library supports web + app favorites, sticky close without archiving, reorder and rename', () => {
  let values: L.Values = { spaces: { a: { name: 'A', order: 0 } }, pins: {}, favorites: {}, folders: {}, tabs: {}, archive: {}, windows: { '1': { spaceId: 'a' } }, imports: {} };
  const act = (action: string, payload: any, ids: string[] = ['1111', '2222']) => {
    const out = L.perform(values, action, payload, { now: 1000, ids });
    assert.equal(out.ok, true, `${action}: ${out.error}`);
    values = applyChanges(values, out.changes);
    return out;
  };

  const t1 = act('newTab', { windowId: 1, url: 'https://calendar.example/', title: 'Calendar' }, ['t001']).result.tabId;
  const f1 = act('addFavorite', { tabId: t1 }, ['f001']).result;
  assert.equal(values.tabs[t1].favoriteId, f1);

  const appItem = act('addItem', { spaceId: 'a', target: { kind: 'app', bundleId: 'com.apple.Music', name: 'Music' } }, ['t002']).result.tabId;
  const f2 = act('addFavorite', { tabId: appItem }, ['f002']).result;
  assert.equal(values.favorites[f2].target.kind, 'app');

  act('moveFavorite', { favoriteId: f2, beforeId: f1 });
  assert.ok(values.favorites[f2].pos < values.favorites[f1].pos);

  act('renameFavorite', { favoriteId: f1, title: 'Cal' });
  assert.equal(values.favorites[f1].customTitle, 'Cal');

  // Closing a favorite's live tab unloads without archiving.
  act('closeTab', { tabId: t1 });
  assert.equal(values.tabs[t1], undefined);
  assert.equal(Object.keys(values.archive).length, 0);
  assert.ok(values.favorites[f1]);

  // Settings form exposes favoritesScope toggle.
  const fields = settingsFields({ favoritesScope: 'global' }, {});
  const scopeField = fields.find((f) => f.id === 'favoritesScope');
  assert.ok(scopeField);
  assert.deepEqual(saveField(scopeField, 'profile', {}), { type: 'updateSettings', payload: { patch: { favoritesScope: 'profile' } } });

  // Drag rules for favorites.
  assert.deepEqual(dropAction({ kind: 'tab', id: 5 }, dropTarget({ kind: 'tab', id: 5 }, { zone: 'favorites', rows: [f2, f1], favorite: null, x: 0 }, null)!), { name: 'favorite.add', arg: 5 });
  assert.deepEqual(dropAction({ kind: 'favorite', id: f1 }, dropTarget({ kind: 'favorite', id: f1 }, { zone: 'favorites', rows: [f2, f1], favorite: f2, x: 0.2 }, null)!), { name: 'favorite.move', arg: { favorite: f1, before: f2 } });
  assert.deepEqual(dropAction({ kind: 'favorite', id: f1 }, dropTarget({ kind: 'favorite', id: f1 }, { zone: 'tabs', rows: [], tab: null, y: 0 }, null)!), { name: 'favorite.remove', arg: f1 });
});
