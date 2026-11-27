// The palette's search suggestions in Margin.app's own window (ui/host-app.ts `suggest`, the `suggestions` push; the
// core's rules: core/session/suggest.rs): asked as the palette is typed in, kept as the state's `search`, drawn as
// search rows (shared/search.ts rankPalette), and a push for an older query dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAppHost, suggestionsOf } from '../app/shared/ui/host-app.ts';
import { buildViewModel, type UiState } from '../app/shared/ui/view-model.ts';
import { settingsFields } from '../app/shared/ui/settings-form.ts';
import { toStorage } from '../extension/shared/stored.ts';
import { smallState, W } from './ui/fixtures.ts';
import type { State } from '../types/margin.d.ts';

const ENGINE = { id: 'duckduckgo', name: 'DuckDuckGo' };

function appHost(answer: (payload: Record<string, any>) => unknown, appWindow = true) {
  const posts: Record<string, any>[] = [];
  const post = async (op: string, body: Record<string, any> = {}) => {
    posts.push({ op, ...body });
    return op === 'send' && body.type === 'search.suggest' ? JSON.stringify(answer(body.payload)) : null;
  };
  const stored = toStorage(smallState(), ['spaces', 'pins', 'folders', 'archive', 'settings', 'tabs', 'tabSpace', 'activeSpaceByWindow', 'favicons'], { origin: 'safari-web-extension://margin', since: 1, synced: true });
  const hello = { windowId: W, profile: 'P1', browser: 'safari', mode: 'fullscreen', platform: { browser: 'safari', os: 'mac', app: true }, state: stored, windows: [], theme: null, ...(appWindow ? { host: 'app-window' } : {}) };
  return { host: createAppHost({ hello, post }), posts };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test('the app host: each change typed asks the app; a known answer is drawn at once, a fetched one when pushed', async () => {
  const { host, posts } = appHost((p) => (p.query === 'we' ? { ok: true, result: { engine: ENGINE, on: true, query: 'we', items: ['web', 'weather'] } } : { ok: true, result: { engine: ENGINE, on: true } }));
  const drawn: any[] = [];
  host.onState((s) => drawn.push(s));
  host.suggest!('we');
  await settle();
  assert.deepEqual(posts.at(-1), { op: 'send', type: 'search.suggest', payload: { query: 'we', windowId: W } });
  assert.deepEqual(host.getState()!.search, { query: 'we', items: ['web', 'weather'], engine: ENGINE });
  assert.equal(drawn.length, 1);
  // Asked of the engine: nothing new drawn until the push; an older query's push dropped, this one's drawn.
  host.suggest!('weat');
  await settle();
  assert.equal(drawn.length, 1, 'the engine kept, nothing else changed');
  host.receive({ type: 'suggestions', query: 'we', items: ['old'], engine: ENGINE });
  assert.equal(drawn.length, 1, 'not what is typed now');
  host.receive({ type: 'suggestions', query: 'WEAT', items: ['weather', 'weather nyc', 7, 'x'.repeat(201), 'a\u0007b'], engine: ENGINE });
  assert.deepEqual(host.getState()!.search, { query: 'WEAT', items: ['weather', 'weather nyc'], engine: ENGINE }, 'checked: strings only, short, no control characters');
  // Its rows: "Search for" first (the engine's name), the suggestions after it as searches.
  const vm = buildViewModel({ state: host.getState() as State, now: 0, ui: { windowId: W, mode: 'fullscreen', palette: { open: true, query: 'weat', selected: 0 } } as UiState, platform: { browser: 'safari', os: 'mac' } }, null);
  assert.deepEqual(vm.palette.rows.slice(0, 3).map((r) => [r.kind, r.title, r.subtitle, r.isSearch]), [
    ['go', 'Search for “weat”', 'DuckDuckGo', true], ['suggestion', 'weather', '', true], ['suggestion', 'weather nyc', '', true],
  ]);
});

test('the app host: nothing asked outside Margin\'s own window; a bad answer ignored', async () => {
  const over = appHost(() => ({ ok: true, result: { items: ['x'] } }), false);
  over.host.suggest!('a');
  await settle();
  assert.equal(over.posts.length, 0);
  const bad = appHost(() => ({ ok: false, error: 'no' }));
  bad.host.suggest!('a');
  await settle();
  assert.equal(bad.host.getState()!.search, undefined);
  assert.equal(suggestionsOf(null), null);
  assert.equal(suggestionsOf({ query: 1, items: [] }), null);
  assert.deepEqual(suggestionsOf({ query: 'a', items: ['b'], engine: { id: 'Bad Id', name: 'x' } }), { query: 'a', items: ['b'], engine: null });
});

test('Settings: the suggestions switch in Margin.app\'s window, on unless turned off; the engine followed from Safari', () => {
  const field = (settings: any, features: any) => settingsFields(settings, features).find((f) => f.id === 'searchSuggestions');
  assert.equal(field({}, { appSearch: true })!.checked, true);
  assert.equal(field({ searchSuggestions: false }, { appSearch: true })!.checked, false);
  assert.equal(field({}, {}), undefined, 'not over a browser');
  const engine = (features: any) => settingsFields({}, features).find((f) => f.id === 'engine')!.label;
  assert.match(engine({ appSearch: true }), /chosen in Safari/);
  assert.match(engine({ search: 'browser' }), /Chrome/);
  assert.equal(engine({}), 'Searches use Google.');
});
