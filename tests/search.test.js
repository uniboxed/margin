import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../extension/shared/search.js';
import { DEFAULT_SETTINGS } from '../extension/state/model.js';

const { resolveInput, DEFAULT_ENGINE } = globalThis.Margin.search;

test('default engine matches the model default setting', () => {
  assert.equal(DEFAULT_ENGINE, DEFAULT_SETTINGS.searchEngine);
});

test('URLs pass through or get a scheme', () => {
  assert.deepEqual(resolveInput('https://a.com/x'), { kind: 'url', url: 'https://a.com/x' });
  assert.deepEqual(resolveInput('  example.com  '), { kind: 'url', url: 'https://example.com' });
  assert.deepEqual(resolveInput('news.ycombinator.com/item?id=1'), { kind: 'url', url: 'https://news.ycombinator.com/item?id=1' });
  assert.deepEqual(resolveInput('localhost:3000/app'), { kind: 'url', url: 'http://localhost:3000/app' });
  assert.deepEqual(resolveInput('192.168.1.1'), { kind: 'url', url: 'http://192.168.1.1' });
  assert.deepEqual(resolveInput('about:blank'), { kind: 'url', url: 'about:blank' });
});

test('everything else is a search on the configured engine', () => {
  assert.equal(resolveInput('hello world').url, 'https://duckduckgo.com/?q=hello%20world');
  assert.equal(resolveInput('c++').url, 'https://duckduckgo.com/?q=c%2B%2B');
  assert.equal(resolveInput('node.js tutorial').kind, 'search');
  assert.equal(resolveInput('margin', 'https://www.google.com/search?q=%s').url, 'https://www.google.com/search?q=margin');
  assert.equal(resolveInput('x', 'garbage').url, 'https://duckduckgo.com/?q=x');
  assert.equal(resolveInput('   '), null);
});
