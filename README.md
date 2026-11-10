# Margin

**It's not a browser. It's not a sidebar. It's a new interface for the browser you already use.**

Margin draws its own interface around your pages, with spaces, pinned tabs, folders and a command palette, on top of
Safari, Chrome and Edge. The browser stays yours: its engine, logins, passwords, sync and extensions all keep working
as they are. And the interface is yours too: a theme in Margin isn't a color scheme, it's the whole UI around the
page, and you can pick one, change one or write your own.

> **Status: early.** Margin is under active development and has no release yet. Expect rough edges and changes.
> Ready-to-install builds will appear under [Releases](../../releases).

## What makes it different

- **Your browser, not a new one.** Margin works with the browser you already trust instead of replacing it, so
  nothing has to move: not your accounts, not your passwords, not your extensions.
- **An interface you can redesign.** Everything Margin shows (the tabs and spaces, the palette, menus, notices, the
  new-tab page) is drawn by a theme: an HTML template with a slot for the page, and its CSS. A theme decides where the
  page sits and what surrounds it. Three come built in, and themes of your own can be imported.
- **Never inside your pages.** Margin.app draws its interface in its own windows around the browser's, so websites
  are left untouched and the interface doesn't reload or flicker as pages change.
- **Private by design.** No accounts, no analytics, no servers. In Safari, which gives extensions no tab icons, Margin
  fetches each site's own icon; it requests nothing else.

## Features

- **Spaces**: separate sets of tabs, pins and folders for work, home or a project, switched with a click, a swipe or a
  key, and spanning your browser's profiles.
- **Pinned tabs and folders** in each space, kept between sessions.
- **A command palette** on ⌘T: open a page, search, jump to any tab or space, run any action.
- **Sleeping tabs** that free their memory when they haven't been used for a while, and an **archive** of tabs closed
  for being idle, to bring back.
- **iCloud Tabs** from your other devices, in Safari.
- **Keyboard first**: next tab and space on ⌥⌘ + arrows in Safari and ⌃⌘ + arrows in Chrome and Edge, all changeable
  in Settings.

## Themes

| Theme | Its look |
|---|---|
| **Arcadia** (the default) | a gray frame around the page as a rounded card, space chips, pins and tabs, a dark command bar; inspired by Arc |
| **Neubrutalism** | a dotted ground in the space's color, bordered cards with hard offset shadows |
| **Pixel** | an 8-bit game: the PICO-8 palette on a dotted night ground, notched pixel borders, pixel type |

A theme is HTML and CSS only, no JavaScript. Margin renders it from its own data, runs its buttons as checked
actions, and gives it behaviors like drag and drop, resizing and menus through attributes. Imported themes are
sanitized and drawn in a page that can't run scripts or reach the network, and a security suite attacks that page on
every change. [Writing a theme](extension/themes/README.md) explains the files, the bindings and how to import one.

## Browsers and systems

| | macOS | Windows | Linux |
|---|---|---|---|
| Safari | ✓ | — | — |
| Chrome, Edge and other Chromium browsers | ✓ | in progress | coming soon |
| Firefox | coming soon | coming soon | coming soon |

Safari only runs on Apple's systems, so there's no Safari to work with on Windows or Linux (— in the table).

On the Mac, Margin needs macOS 14 or later, on Apple silicon or Intel, and today it draws around full-screen browser windows.

## Install

There's no release yet. To build and install Margin from source on a Mac, with Xcode, Node 26 and Rust:

```sh
npm ci
npm run safari    # builds Margin.app with Safari's extension and installs it in ~/Applications
```

Then turn Margin on in Safari → Settings → Extensions. For Chrome or Edge, load `dist/chromium/` as an unpacked
extension (`chrome://extensions`, Developer mode). [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) has the details,
including a development build without Xcode.

## How it works

Margin has two halves. The **extension** lives in the browser and owns the tabs and their state. **Margin.app** draws
the interface around the browser's windows and keeps your spaces, pins and settings. They talk over a local,
token-protected link that never leaves your computer ([docs/PROTOCOL.md](docs/PROTOCOL.md)).

```text
extension/          the browser extension every browser shares (TypeScript)
  engines/          what differs per browser: webkit/safari, chromium
  themes/           the built-in themes, and how to write one
  ui/               the runtime that renders themes
app/                Margin.app
  shared/           core (Rust), the connector for Chrome and Edge (Rust), the page drawn over each window
  engines/          the app's per-browser side
  platforms/        macos (Swift), windows (Rust), linux (later)
docs/               the protocol, the data, the profile switch, the Windows notes
```

## Contributing

Issues, ideas and pull requests are welcome, and so are themes. [CONTRIBUTING.md](CONTRIBUTING.md) covers building,
testing and the commit style. Please report security problems privately ([SECURITY.md](SECURITY.md)), and follow the
[code of conduct](CODE_OF_CONDUCT.md).

## License

Margin is free software: you can use, study, share and change it under the
[GNU General Public License, version 3 or later](LICENSE). Anything built from Margin and shared with others must be
shared under the same license, with its source. The built-in themes' fonts are under the SIL Open Font License, each
beside its font.
