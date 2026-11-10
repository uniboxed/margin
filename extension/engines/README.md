# The extension's engines

What differs per browser on the extension's side, by engine: WebKit (Safari), Chromium (Chrome, Edge and the rest), and later Gecko. The rest of `extension/` is what every browser shares. Margin.app's side of each engine is in `app/engines/`.

```text
extension/engines/
  webkit/safari/        Safari (WebKit's only browser, so its code is Safari's)
  chromium/             every Chromium browser; one browser's own differences later in chromium/<browser>/
```

Each engine's folder has:

| File | What it holds |
|---|---|
| `manifest.json` | its manifest changes: they replace top-level keys of `extension/manifest.json`, except `add_permissions`, appended to the shared list (`scripts/build.ts`, `MANIFESTS`) |
| `capabilities.ts` | what its browser can do (fetch site icons, sleep tabs by closing or discarding, Margin full screen, the link's socket guard, default shortcuts…) |
| `engine.ts` | its own modules, for shared code to call; `null` for what another engine has |
| `tests/` | its own unit tests (`npm test` runs `extension/engines/**/tests/*.test.ts`) |

| Engine | Its own modules | Build |
|---|---|---|
| `webkit/safari/` | `onboarding.ts` (the set-up window's messages to Margin.app), `newtab-hint.ts` (the note when ⌘T no longer reaches Margin). Its manifest: the background as a page, native messaging, its commands | `dist/webkit/` |
| `chromium/` | `fullscreen.ts` (Margin full screen). Its manifest: the service worker, `search` (`chrome.search.query`), `nativeMessaging`, and the fixed `key` that gives Margin its extension ID. Edge tells itself apart by its user agent (`capabilities.ts`) | `dist/chromium/` (Chrome, Edge and every other Chromium browser) |

**Only this folder may ask which engine or browser this is**; shared code asks what the browser can do (`extension/shared/capabilities.ts`).

**Each build takes only its own engine.** Shared code reaches an engine's modules as `engine` from `#engine` (`engine.fullscreen`, null in other builds) and its capabilities as `#engine/capabilities`. The root `package.json` `"imports"` maps both: `scripts/build.ts` builds each engine with its condition (`margin-webkit`, `margin-chromium`), so the other engine's code isn't in its bundles, and it never copies this folder into a build; unbuilt (unit tests in Node, `tsc`), `default` resolves them to `extension/shared/any-engine*.ts`, which pick either engine's by the extension's URL. A new module of one engine: put it in its folder and add it to its `engine.ts`, with `null` for it in every other engine's.

Don't edit `dist/` by hand: change `extension/`, then run `npm run build`. Load `dist/webkit/` in Safari and `dist/chromium/` in Chrome or Edge.
