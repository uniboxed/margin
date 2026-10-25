# Per-browser layers

`extension/` is the one shared source. These folders hold only what differs per browser; `npm run build` combines them into ready-to-load builds:

| Folder | What it overrides | Build |
|---|---|---|
| `platform/safari/manifest.json` | Top-level manifest keys (today: none) | `dist/safari/` |
| `platform/chrome/manifest.json` | Top-level manifest keys, plus `add_permissions` (appended to the shared list). Today: the `search` permission (`chrome.search.query`: searches use Chrome's default engine; Safari has no such API) | `dist/chrome/` |

The shortcut `commands` are ⌃⌘ + arrows in both (in `extension/manifest.json`). Safari's build once had ⌥⌘↓/↑ commands for tabs; they didn't respond in Safari, while ⌃⌘ does, and Chrome refuses ⌘⌥ commands outright.

Behavior that differs (Safari fetches site icons since it has no `tab.favIconUrl`; default shortcuts) lives in the profiles in `extension/shared/platform.js`; the build stamps which profile a folder uses. Safari's default *page* shortcuts for tabs are ⌥⌘↓/↑ (on top of the ⌃⌘ commands).

Don't edit `dist/` by hand: change `extension/` or these files, then run `npm run build` (a unit test fails if `dist/` is stale). Load `dist/safari/` in Safari and `dist/chrome/` in Chrome.
