# Margin

Arc's way of browsing, in the browser you already use. Margin puts a sidebar of spaces, pinned tabs and folders
beside your pages, with a command palette, sleeping tabs and an archive, in Safari, and in Chrome and Edge on the
Mac. A Windows version is on the way.

> **Status: early.** Margin is under active development and not yet released. Expect rough edges, and expect things to
> change. [Releases](../../releases) will carry ready-to-install builds once there are some.

## What it does

- **A sidebar beside every window**, drawn by Margin's Mac app over full-screen browser windows, so pages stay
  untouched and the sidebar never reloads with them.
- **Spaces**: separate sets of tabs, pins and folders, switched with a click, a swipe or a key, and spanning your
  browser profiles.
- **Pinned tabs and folders** per space, and keys for the next tab and space (⌥⌘ + arrows in Safari, ⌃⌘ + arrows
  in Chrome and Edge; changeable in Settings).
- **A command palette** on ⌘T: open, search, switch tabs and spaces, run actions.
- **Sleeping tabs** that free memory while they're not used, and an **archive** of tabs closed for being idle.
- **iCloud Tabs** from your other devices, in Safari.
- **Themes**: Arcadia, Neo-brutalism and Pixel built in, and themes of your own (sandboxed HTML and CSS).
- **Private by design**: no accounts, no analytics, no servers. The only requests Margin makes are for sites' icons
  in Safari, which gives extensions none.

## Browsers and systems

| | macOS | Windows | Linux |
|---|---|---|---|
| Safari | ✓ | | |
| Chrome, Edge (and other Chromium browsers) | ✓ | in progress | later |
| Firefox | later | later | later |

macOS 14 or later.

## Install

There's no release yet. To build and install Margin from source on a Mac (Xcode, Node 26 and Rust):

```sh
npm ci
npm run safari       # builds Margin.app with Safari's extension and installs it in ~/Applications
```

Then turn Margin on in Safari → Settings → Extensions. For Chrome or Edge, load `dist/chromium/` as an unpacked
extension (`chrome://extensions`, Developer mode). [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) has the details,
including a development build without Xcode.

## How it's built

```text
extension/          the browser extension every browser shares (TypeScript)
  engines/          what differs per browser: webkit/safari, chromium
app/                Margin's app
  shared/           core (Rust), the connector for Chrome and Edge (Rust), the page drawn over each window
  engines/          the app's per-browser side
  platforms/        macos (Swift), windows (Rust), linux (later)
docs/               the link's protocol, the data, the profile handoff, the Windows notes
```

The extension owns the tabs and their state; the app draws Margin's UI around the browser's windows and keeps the
lasting data. They talk over a local, token-protected link ([docs/PROTOCOL.md](docs/PROTOCOL.md)).
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) goes further.

## Contributing

Issues and pull requests are welcome: [CONTRIBUTING.md](CONTRIBUTING.md) covers building, testing and the commit
style. Please report security problems privately ([SECURITY.md](SECURITY.md)), and follow the
[code of conduct](CODE_OF_CONDUCT.md).

## License

Margin is free software: you can use, study, share and change it under the
[GNU General Public License, version 3 or later](LICENSE). Anything built from Margin and shared with others must be
shared under the same license, with its source. Its themes' fonts are under the SIL Open Font License, each beside
its font.
