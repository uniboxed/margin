import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../extension/state/model.ts';
import { matchAirTrafficRule, normalizePattern, patternMatchesUrl } from '../extension/shared/air-traffic.ts';
import { menuItems } from '../extension/ui/behaviors/menu-items.ts';
import { buildViewModel } from '../extension/ui/view-model.ts';
import { checkAction, contextFromState, requestFor } from '../extension/ui/actions.ts';
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

test('M2.6 Air Traffic Control: exact host, wildcard subdomain, and path-prefix matching with ordering', () => {
  assert.equal(normalizePattern('https://Linear.App/'), 'linear.app');
  assert.equal(normalizePattern('*.Figma.com'), '*.figma.com');
  assert.equal(normalizePattern('github.com/my-org/*'), 'github.com/my-org/*');
  assert.equal(normalizePattern('not a domain'), null);
  assert.equal(normalizePattern('localhost'), null);

  assert.equal(patternMatchesUrl('linear.app', 'https://linear.app/inbox'), true);
  assert.equal(patternMatchesUrl('linear.app', 'https://sub.linear.app/inbox'), false);
  assert.equal(patternMatchesUrl('*.figma.com', 'https://www.figma.com/file/123'), true);
  assert.equal(patternMatchesUrl('*.figma.com', 'https://figma.com/'), true);
  assert.equal(patternMatchesUrl('github.com/my-org/*', 'https://github.com/my-org/repo/pull/1'), true);
  assert.equal(patternMatchesUrl('github.com/my-org/*', 'https://github.com/other-org/repo'), false);

  const rules = [
    { id: 'r1', pattern: 'github.com/my-org/*', spaceId: 'work', enabled: true, order: 0 },
    { id: 'r2', pattern: 'github.com', spaceId: 'personal', enabled: true, order: 1 },
    { id: 'r3', pattern: '*.figma.com', spaceId: 'design', enabled: false, order: 2 },
  ];
  const valid = new Set(['personal', 'work', 'design']);
  assert.equal(matchAirTrafficRule('https://github.com/my-org/app', rules, valid)?.spaceId, 'work', 'more specific earlier rule wins');
  assert.equal(matchAirTrafficRule('https://github.com/torvalds/linux', rules, valid)?.spaceId, 'personal');
  assert.equal(matchAirTrafficRule('https://www.figma.com/file/1', rules, valid), null, 'disabled rule skipped');
  assert.equal(matchAirTrafficRule('https://github.com/my-org/app', rules, new Set(['personal']))?.spaceId, 'personal', 'deleted target space skipped');
});

test('M2.6 Air Traffic Control: 1-click context menu, library persistence, newTab auto-routing, and space deletion cascade', () => {
  let values: L.Values = {
    spaces: {
      personal: { name: 'Personal', order: 0, profile: null },
      work: { name: 'Work', order: 1, profile: 's-work' },
    },
    pins: {}, favorites: {}, airTraffic: {}, folders: {}, tabs: {}, archive: {}, windows: { '1': { spaceId: 'personal' } }, imports: {},
  };
  const act = (action: string, payload: any, ids: string[] = ['1111', '2222']) => {
    const out = L.perform(values, action, payload, { now: 1000, ids });
    assert.equal(out.ok, true, `${action}: ${out.error}`);
    values = applyChanges(values, out.changes);
    return out;
  };

  const r1 = act('addAirTrafficRule', { pattern: '*.linear.app', spaceId: 'work' }, ['r001']).result;
  assert.equal(values.airTraffic[r1].pattern, '*.linear.app');

  // routeUrl returns matched space + its profile target.
  const routed = act('routeUrl', { url: 'https://app.linear.app/issue/1' }).result;
  assert.equal(routed.spaceId, 'work');
  assert.equal(routed.target.profile, 's-work');

  // newTab without explicit spaceId automatically routes into Work space & profile!
  const opened = act('newTab', { windowId: 1, url: 'https://app.linear.app/issue/1' }, ['t001']);
  assert.equal(opened.requests[0].spaceId, 'work');
  assert.equal((opened.requests[0].target as L.WebTarget | null)?.profile, 's-work');

  // Deleting Work space removes rules targeting Work.
  act('deleteSpace', { spaceId: 'work' });
  assert.equal(values.airTraffic[r1], undefined);

  // Context menu action builds addAirTrafficRule request.
  let s = M.defaultState();
  s = M.setActiveSpace(s, 1, 'personal');
  s = M.upsertTab(s, { id: 9, windowId: 1, index: 0, active: true, url: 'https://stripe.com/docs', title: 'Stripe' } as BrowserTab, 100);
  s = M.moveTab(s, 9, 'personal');
  const vm = buildViewModel({ state: s, ui: { windowId: 1, tabId: 9 } });
  const menu = menuItems({ kind: 'tab', id: 9 }, { state: s, space: vm.space });
  const entry = menu.find((i) => i.action === 'airTraffic.addHost');
  assert.equal(entry?.label, 'Always Open stripe.com in This Space');
  assert.equal(checkAction('airTraffic.addHost', 9, contextFromState(s)).ok, true);
  assert.deepEqual(requestFor('airTraffic.addHost', 9, { state: s, ui: { windowId: 1 } }), { kind: 'send', type: 'addAirTrafficRule', payload: { pattern: 'stripe.com', spaceId: 'personal' } });
});
