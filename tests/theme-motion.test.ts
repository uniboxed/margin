// The theme packer's motion notes (scripts/theme-motion.ts): animation that re-runs layout each frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { motionAdvice, motionNotes } from '../scripts/theme-motion.ts';

test('motion: transitions and keyframes of layout properties are noted, with their lines', () => {
  const css = [
    '.a { transition: left 200ms ease; }', // 1
    '.b { transition: opacity 1s, transform 1s, translate 1s; }', // 2
    '.c { transition-property: width, opacity; }', // 3
    '.d { transition: all .2s; }', // 4
    '@keyframes grow { 0% { height: 4px; } 100% { height: 12px; margin-left: 2px; } }', // 5
    '@keyframes fade { from { opacity: 0; } to { opacity: 1; transform: scale(1.1); } }', // 6
    '/* .e { transition: top 1s; } */', // 7: a comment
    '.f { transition: background-color .2s, box-shadow .2s; }', // 8: paints, doesn't lay out
  ].join('\n');
  assert.deepEqual(motionNotes(css).map((n) => [n.line, n.what, n.property]), [
    [1, 'transition', 'left'],
    [3, 'transition', 'width'],
    [4, 'transition', 'all'],
    [5, 'animation', 'height'],
    [5, 'animation', 'margin-left'],
  ]);
  assert.match(motionAdvice(motionNotes(css))[0], /^ {2}theme\.css:1: a transition of `left`: .*`transform`/);
});

test('motion: the built-in themes animate layout only where it\'s deliberate', () => {
  const notes = (id: string) => motionNotes(readFileSync(new URL(`../extension/themes/${id}/theme.css`, import.meta.url), 'utf8'));
  assert.deepEqual(notes('neubrutalism'), []);
  assert.deepEqual(notes('pixel'), [], 'the playing bars scale, not grow');
  // Arcadia's card edge follows the sidebar by its left side while its right one stays: a width change, which a
  // transform can't make without stretching its shadow (one empty element, out of the flow).
  assert.deepEqual(notes('arcadia').map((n) => n.property), ['left']);
});
