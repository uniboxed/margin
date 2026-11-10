# Engines and their browsers

What differs per browser lives here, by engine: WebKit, Chromium, and later Gecko. `extension/` (what runs in the browser) and `app/` (Margin's app on each OS) hold only what every browser shares.

```text
engines/<engine>/
  extension/            the engine's defaults for the extension (its manifest changes, its own modules)
  app/                  the engine's defaults for the app (where its files are, how to find its windows)
  browsers/<browser>/
    extension/          one browser's own differences, on the extension side
    app/                one browser's own differences, on the app side
```

A browser that behaves like its engine needs nothing of its own. Only this folder may ask which engine or browser this is; everything else asks what the browser can do.

| Folder | What it holds | Build |
|---|---|---|
| `webkit/browsers/safari/extension/` | Safari's manifest changes (`manifest.json`: the background as a page, native messaging, its commands); its profile (`profile.ts`); its own modules (`engine.ts`: `onboarding.ts`, the set-up window's messages to Margin.app; `newtab-hint.ts`, the note when ⌘T no longer reaches Margin) | `dist/webkit/` |
| `webkit/browsers/safari/app/` | Safari's side of Margin.app (Swift): its Accessibility tree, its files and profile names, iCloud Tabs, the startup covers, keeping its sidebar closed, the edge stop, the dev hooks; `handler/`, its extension handler (the extension's target, copied by `scripts/make-xcode.sh`) | Margin.app |
| `chromium/extension/` | Chromium's manifest changes (`manifest.json`: the service worker, `search` (`chrome.search.query`), `nativeMessaging`, and the fixed `key` that gives Margin its extension ID); its profile (`profile.ts`: Edge tells itself apart by its user agent); its own modules (`engine.ts`: `fullscreen.ts`, Margin full screen) | `dist/chromium/` (Chrome, Edge and every other Chromium browser) |
| `chromium/app/` | Chromium's side of the app, every OS (Rust, crate `margin-chromium`): its browsers, where their native-messaging host files go and what they say; the connector (`app/shared/connector/`) writes them | the connector |

Overrides replace top-level manifest keys, except `add_permissions`, which is appended to the shared list (`scripts/build.ts`, `MANIFESTS` names each build's file). The Mac app compiles every `*.swift` of the folders `app/macos/swift-sources.txt` lists (Safari's `app/` among them); the Rust ones are crates of the root `Cargo.toml`.

**Each build takes only its own engine.** A profile (`profile.ts`) says what its browser can do (fetch site icons, sleep tabs by closing or discarding, Margin full screen, the link's socket guard, default shortcuts…), and shared code asks `extension/shared/platform.ts`, never which browser it is. Shared code reaches an engine's own modules as `engine` from `#engine` (`engine.fullscreen`, null in other builds) and its profile as `#engine/profile`. The root `package.json` `"imports"` maps both: `scripts/build.ts` builds each engine with its condition (`margin-webkit`, `margin-chromium`), so the other engine's code isn't in its bundles; unbuilt (unit tests in Node, `tsc`), `default` resolves them to `extension/shared/any-engine*.ts`, which pick either engine's by the extension's URL. A new module of one engine: put it in its folder and add it to its `engine.ts` (and `null` for it in every other engine's).

Don't edit `dist/` by hand: change `extension/` or these files, then run `npm run build`. Load `dist/webkit/` in Safari and `dist/chromium/` in Chrome or Edge.
