# The app's platforms

Margin.app's code for each operating system: what only that OS does. What every OS shares is in `app/shared/`
(core, the connector, the host page), and what differs per browser in `app/engines/`.

| Folder | What it holds |
|---|---|
| `macos/` | Swift: `shell/` (the link, windows, overlays, keys, data, the profile switch and handoff), `private/` (macOS's private calls, the freezer, the parker, Space reads), `startup/` (the set-up window); `swift-sources.txt` lists every folder the app compiles; each folder's checks in its `tests/` |
| `windows/` | Rust (`margin.exe`): the shell over Chrome's and Edge's windows, WebView2 for the host page; compile-checked only so far (`docs/windows/UNVERIFIED.md`) |
| `linux/` | later |
