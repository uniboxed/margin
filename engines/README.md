# Engines and their browsers

What differs per browser lives here, by engine: WebKit, Chromium, and later Gecko. `extension/` (what runs in the browser) and `app/` (Margin's app on each OS) hold only what every browser shares.

```
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
| `webkit/browsers/safari/extension/manifest.json` | Safari's manifest changes: the background as a page, native messaging, its commands | `dist/safari/` |
| `webkit/browsers/safari/app/` | Safari's side of Margin.app (Swift): its Accessibility tree, its files and profile names, iCloud Tabs, the startup covers, keeping its sidebar closed, the edge stop, the dev hooks; `handler/`, its extension handler (the extension's target, copied by `scripts/make-xcode.sh`) | Margin.app |
| `chromium/extension/manifest.json` | Chromium's manifest changes: the service worker, `search` (`chrome.search.query`), `nativeMessaging`, and the fixed `key` that gives Margin its extension ID | `dist/chrome/` (Chrome, Edge and every other Chromium browser) |
| `chromium/app/` | Chromium's side of Margin.app on the Mac (Swift): the native-messaging host files (`ChromiumHosts.swift`) | Margin.app |

Overrides replace top-level manifest keys, except `add_permissions`, which is appended to the shared list (`scripts/build.ts`, `MANIFESTS` names each build's file). The Mac app compiles every `*.swift` of the folders `app/macos/swift-sources.txt` lists, these engines' `app/` folders among them.

Behavior that differs (Safari fetches site icons since it has no `tab.favIconUrl`; default shortcuts) still lives in the profiles in `extension/shared/platform.ts`, which the build stamps for each build; it moves into each engine's `extension/` next.

Don't edit `dist/` by hand: change `extension/` or these files, then run `npm run build`. Load `dist/safari/` in Safari and `dist/chrome/` in Chrome or Edge.
