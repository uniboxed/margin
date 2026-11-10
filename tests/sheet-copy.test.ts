// The copy of a style sheet the page's world can't read (shared/sheet-copy.ts,
// made by content/page-link.ts): its addresses absolute, `@import` written with
// a space or not (anu.edu.au's minified `@import"../grid.css"` stayed relative
// and resolved against the page, its grid lost), and what it imports put in it,
// inside its media list, so all of it is readable; or, if one can't go in, the
// imports kept as they are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { absolute, inlineImports } from '../extension/shared/sheet-copy.ts';

const BASE = 'https://cdn.example/styles/css/export.css';

test('addresses made absolute: url() and @import, with a space or not, the absolute ones and data: left alone', () => {
  const css = '@import"../../libs/grid.css";@import \'fonts.css\';@import url(a.css);.x{background:url(img/a.png)}.y{background:url("data:image/png;base64,AA")}.z{background:url(https://other.example/b.png)}@import "//cdn2.example/c.css";';
  const out = absolute(css, BASE);
  assert.match(out, /@import "https:\/\/cdn\.example\/libs\/grid\.css"/);
  assert.match(out, /@import 'https:\/\/cdn\.example\/styles\/css\/fonts\.css'/);
  assert.match(out, /url\(https:\/\/cdn\.example\/styles\/css\/a\.css\)/);
  assert.match(out, /url\(https:\/\/cdn\.example\/styles\/css\/img\/a\.png\)/);
  assert.match(out, /url\("data:image\/png;base64,AA"\)/);
  assert.match(out, /url\(https:\/\/other\.example\/b\.png\)/);
  assert.match(out, /@import "\/\/cdn2\.example\/c\.css"/);
});

// A fetch over a map of addresses to texts, counting what it was asked.
const fetcher = (files: Record<string, string>) => {
  const asked: string[] = [];
  const fetchText = async (url: string) => { asked.push(url); return files[url] ?? null; };
  return { fetchText, asked };
};

test('imports put in the copy where they were, inside their media list, their own addresses absolute', async () => {
  const { fetchText, asked } = fetcher({
    'https://cdn.example/libs/grid.css': '@charset "utf-8";.container{width:100%}@media (min-width:992px){.container{max-width:960px}}.bg{background:url(grid.png)}',
    'https://fonts.example/css?family=A': '@font-face{font-family:A;src:url(https://fonts.example/a.woff2)}',
  });
  const css = absolute('@import"../../libs/grid.css" screen;@import "https://fonts.example/css?family=A";.page{color:red}', BASE);
  const out = await inlineImports(css, BASE, fetchText);
  assert.deepEqual(asked, ['https://cdn.example/libs/grid.css', 'https://fonts.example/css?family=A']);
  assert.doesNotMatch(out, /@import/);
  assert.doesNotMatch(out, /@charset/, 'only allowed at the very start: dropped from an inlined sheet');
  assert.match(out, /^@media screen \{\n\.container\{width:100%\}@media \(min-width:992px\)/);
  assert.match(out, /url\(https:\/\/cdn\.example\/libs\/grid\.png\)/, 'an inlined sheet\'s addresses against its own');
  assert.match(out, /@font-face\{font-family:A/);
  assert.ok(out.endsWith('.page{color:red}'), 'the sheet\'s own rules after');
});

test('imports of imports go in too, to a depth', async () => {
  const { fetchText } = fetcher({
    'https://cdn.example/a.css': '@import "b.css";.a{}',
    'https://cdn.example/b.css': '@import "c.css";.b{}',
    'https://cdn.example/c.css': '.c{}',
  });
  const out = await inlineImports('@import "https://cdn.example/a.css";.top{}', BASE, fetchText);
  assert.equal(out, '.c{}.b{}.a{}.top{}');
  const shallow = await inlineImports('@import "https://cdn.example/a.css";.top{}', BASE, fetchText, { depth: 2 });
  assert.equal(shallow, '@import "https://cdn.example/a.css";.top{}', 'past the depth: kept as it was');
});

test('if one import can\'t go in, none does: one that can\'t be fetched, one in a layer, one under supports()', async () => {
  const { fetchText } = fetcher({ 'https://cdn.example/ok.css': '.ok{}' });
  for (const second of ['@import "https://cdn.example/missing.css";', '@import "https://cdn.example/ok.css" layer(base);', '@import "https://cdn.example/ok.css" supports(display: grid);']) {
    const css = `@import "https://cdn.example/ok.css";${second}.top{}`;
    assert.equal(await inlineImports(css, BASE, fetchText), css, second);
  }
});

test('a sheet with no imports comes back as it was, and too many imports are left as they are', async () => {
  const { fetchText, asked } = fetcher({});
  assert.equal(await inlineImports('.a{}', BASE, fetchText), '.a{}');
  assert.equal(asked.length, 0);
  const many = Array.from({ length: 3 }, (_, i) => `@import "https://cdn.example/${i}.css";`).join('') + '.top{}';
  assert.equal(await inlineImports(many, BASE, fetchText, { max: 2 }), many);
});

test('imports are fetched all at once, not one after another', async () => {
  let inFlight = 0;
  let most = 0;
  const fetchText = async (url: string) => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight -= 1;
    return `.${url.split('/').pop()!.replace('.css', '')}{}`;
  };
  const css = ['a', 'b', 'c'].map((n) => `@import "https://cdn.example/${n}.css";`).join('') + '.top{}';
  assert.equal(await inlineImports(css, BASE, fetchText), '.a{}.b{}.c{}.top{}');
  assert.equal(most, 3);
});
