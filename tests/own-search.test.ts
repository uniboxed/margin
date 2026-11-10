// background/search-engine.ts: Margin's own searches don't teach it an engine,
// also when the tab was opened at the search's address (tabs.ts openBehind).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeBrowser } from './fake-browser.ts';

const local: Record<string, any> = {}; // stored JSON
globalThis.chrome = fakeBrowser({
  runtime: { getURL: (path) => `safari-web-extension://test/${path}` },
  storage: {
    local: {
      get: async (keys) => (keys == null ? { ...local } : Object.fromEntries(([] as string[]).concat(keys).filter((k) => k in local).map((k) => [k, structuredClone(local[k])]))),
      set: async (items) => { Object.assign(local, structuredClone(items)); },
      remove: async () => {},
    },
    session: { get: async () => ({}), set: async () => {} },
  },
});
const { learnSearchEngine, noteReopened, ownSearchUrls, ownSearchTabs } = await import('../extension/background/search-engine.ts');
const S = await import('../extension/shared/search.ts');
const { load } = await import('../extension/background/store.ts');

const searchUrl = (q: string) => S.SAFARI_DEFAULT.template.replace('%s', encodeURIComponent(q));
const learned = async () => (await load()).settings.safariSearch ?? null;

test('own search: a new tab opened at Margin\'s own search address isn\'t learned from', async () => {
  const url = searchUrl('two words');
  ownSearchUrls.set(url, { at: Date.now(), template: S.detectSafariSearch(url)!.template });
  await learnSearchEngine([url], { tabId: 42 });
  assert.equal(await learned(), null);
});

test('own search: Safari\'s own search (another address) still is', async () => {
  const url = searchUrl('from the address bar');
  await learnSearchEngine([url], { tabId: 43 });
  assert.equal((await learned())?.template, S.detectSafariSearch(url)!.template);
  assert.equal(ownSearchTabs.size, 0);
});

// Margin 2 Phase 3 (the sleep page's wake had this rule; a sleeping tab is
// closed and kept now, and opens again from its record).
test('a Margin tab opened again from its record (one put to sleep, one lost with its window): a search page there was made before, maybe with another engine, and isn\'t learned from', async () => {
  const before = await learned();
  const url = 'https://duckduckgo.com/?q=asleep&t=osx';
  noteReopened(url);
  await learnSearchEngine([url], { tabId: 44 });
  assert.deepEqual(await learned(), before, 'not learned');
  const fresh = 'https://duckduckgo.com/?q=typed+now&t=osx';
  await learnSearchEngine([fresh], { tabId: 44 });
  assert.equal((await learned())?.template, S.detectSafariSearch(fresh)?.template, 'another search in that tab is');
});
