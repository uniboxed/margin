// The item a split is made with when another is added (extension/shared/front-item.ts): one rule for Margin.app's library
// (app/shared/library/library.ts `addToSplit`) and the page's room check (ui/behaviors/split.ts `refusesAdd`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frontItemOf } from '../extension/shared/front-item.ts';

test('the item used last in the space, never the one excepted, never another space\'s', () => {
  const items = [
    { id: 'notes', spaceId: 's1', lastActive: 1000 },
    { id: 'web', spaceId: 's1', lastActive: 2000, wasActive: true },
    { id: 'other', spaceId: 's2', lastActive: 9000 },
  ];
  assert.equal(frontItemOf(items, 's1')?.id, 'web');
  assert.equal(frontItemOf(items, 's1', 'web')?.id, 'notes', 'the front tab\'s own row: split with the one used before it (the real screen, 2026-11-21 19:32)');
  assert.equal(frontItemOf(items, 's2', 'other'), null, 'nothing else in its space');
});

test('ties: the selected one, then the smaller id (the library\'s order before it was shared)', () => {
  assert.equal(frontItemOf([{ id: 'b', spaceId: 's', lastActive: 5 }, { id: 'a', spaceId: 's', lastActive: 5, wasActive: true }, { id: 'c', spaceId: 's', lastActive: 5 }], 's')?.id, 'a');
  assert.equal(frontItemOf([{ id: 'c', spaceId: 's', lastActive: 5 }, { id: 'b', spaceId: 's', lastActive: 5 }], 's')?.id, 'b');
  assert.equal(frontItemOf([{ id: 'x', spaceId: 's', lastActive: Number.NaN }, { id: 'y', spaceId: 's', lastActive: 1 }], 's')?.id, 'y', 'a value that isn\'t a number counts as 0');
});
