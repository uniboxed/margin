# Store listings

The texts for the Chrome Web Store (and, later, Edge Add-ons). Screenshots: `node tools/store-shots.mts`, then scale to 1280 × 800.

## Listing

**Name:** Margin

**Summary** (the manifest's description, 132 characters at most):
A new interface for the browser you already use: spaces, pinned tabs, folders and a command palette.

**Category:** Productivity (Workflow & Planning)

**Language:** English

**Description:**

Margin is a new interface for the browser you already use. It's not a new browser, and it's not another sidebar: it draws its own interface around your pages, and your browser, its profiles, extensions and passwords stay as they are.

• Spaces: separate sets of tabs, pins and folders for home, work or a trip, switched with a click, a swipe or a key.
• Pinned tabs and folders in each space, kept between sessions.
• A command palette on ⌘T: open a page, search, jump to any tab or space, or run any action.
• Sleeping tabs that free their memory, and an archive of tabs closed for being idle, so a long day doesn't pile up.
• Themes: Arcadia, Neubrutalism and Pixel built in, and themes of your own (HTML and CSS, sandboxed: no scripts, no network).
• Private: no accounts, no analytics, no servers. Everything stays on your Mac.

Margin needs its free companion app, Margin.app, for macOS 14 or later: it draws the interface around the browser window. Download it from https://github.com/uniboxed/margin/releases.

Margin is free software under the GNU GPL, version 3 or later: https://github.com/uniboxed/margin

**Homepage:** https://github.com/uniboxed/margin
**Support:** https://github.com/uniboxed/margin/issues

## Privacy practices

**Single purpose:**
Margin replaces the browser's tab interface with its own: a sidebar of spaces, pinned tabs and folders, and a command palette, drawn around the pages by its companion Mac app.

**Permission justifications:**

- `tabs`: To show the window's tabs (titles, addresses, icons) in Margin's sidebar and palette, and to switch, open, move, close and reorder them when the user asks, keeping each tab in its space.
- `storage`: To keep the user's spaces, pinned tabs, folders, archive and settings on the device.
- `alarms`: A check every 15 minutes that archives tabs left unused longer than the user's setting and puts idle tabs to sleep to free memory.
- `scripting`: To lay out an open page beside Margin's sidebar when it's installed or updated (tabs that were open before the content script could run), and to check whether a tab is asleep before switching to it.
- `webNavigation`: To know when a tab moves to a new page, so its row in the sidebar and its layout beside the sidebar follow at once.
- `search`: The palette's "Search for …" runs the search with the user's own default search engine.
- `nativeMessaging`: To talk to Margin.app, the companion app on the same Mac that draws Margin's interface around the browser window. Nothing leaves the computer.
- Host permission (all sites): Margin's content script lays each page out beside the sidebar, on every site the user visits; that's the extension's purpose. To fit a page, it may fetch that page's own style sheets again, without cookies.
- New tab page: Margin's new tab is its launcher: a search field, the space's pinned tabs and recently archived tabs.

**Remote code:** No, I am not using remote code. (All scripts are in the package. Themes are HTML and CSS only, shown sandboxed with no scripts.)

**Data usage** (Chrome counts data handled on the device too):

- Tick **Web history** (the addresses of open, pinned and archived tabs) and **Website content** (their titles and icons). Both stay on the user's Mac: in the extension's storage and in Margin.app, over native messaging. Nothing is sent to any server.
- Tick all three certifications: not sold or transferred to third parties (outside the approved use cases), not used for purposes unrelated to the single purpose, not used for creditworthiness or lending.

**Privacy policy:** https://github.com/uniboxed/margin/blob/main/PRIVACY.md

## Notes for the reviewer

Margin's interface is drawn by its companion app, Margin.app (macOS 14 or later, signed and notarized): https://github.com/uniboxed/margin/releases/latest. To try it: install Margin.app, open it once, install this extension, and put a Chrome window in full screen. The sidebar appears around the page; ⌘T opens the palette. Without Margin.app, the new tab page says Margin.app isn't running and keeps an address field, so a new tab still works.

## Distribution

Public, all regions. Free.

## The first upload

The first upload keeps the extension's ID (`njeebbcmlenfopaecfbphgcfihbdmkec`, the one Margin.app's connector allows): the zip has no `key` in its manifest and the private key as `key.pem` at its root, in PKCS#8 (`BEGIN PRIVATE KEY`, as Chrome writes it; the store can't read `BEGIN RSA PRIVATE KEY`: `openssl pkcs8 -topk8 -nocrypt` converts it, same key, same ID). Later uploads need neither: the store keeps the ID.
