# Per-browser layers

`extension/` is the one shared source. These folders hold only what differs per browser; `npm run build` combines them into ready-to-load builds:

| Folder | What it overrides | Build |
|---|---|---|
| `platform/safari/manifest.json` | Top-level manifest keys (today: `commands`, with ⌘⌥↓/↑ for tabs, which WebKit accepts) | `dist/safari/` |
| `platform/chrome/manifest.json` | Top-level manifest keys (today: `commands`, all ⌃⌘ + arrows; Chrome refuses ⌘⌥ and then won't load the extension) | `dist/chrome/` |

Behavior that differs (Safari fetches site icons since it has no `tab.favIconUrl`; default shortcuts) lives in the profiles in `extension/shared/platform.js`; the build stamps which profile a folder uses. Keep each profile's `navigation` in sync with its manifest's `commands` (a unit test checks this).

Don't edit `dist/` by hand: change `extension/` or these files, then run `npm run build` (a unit test fails if `dist/` is stale). Load `dist/safari/` in Safari and `dist/chrome/` in Chrome.
