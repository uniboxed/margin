# Phase 6: Pixel, Neo-brutalism, and user themes

Plan, 2026-11-06, on `feat/pixel-user-themes` (from `feat/margin-app`). `PLAN.md` §3, §4, §9 and §10 say what Phase 6 is. This file says how, checked against the code as it is today. Nothing in it is built yet.

## Sources

- **Boards.** Tirth's "Browser Theme Explorations" canvas, copied into `docs/phase6/boards/`: `Pixel.dc.html` ("Sidebar · Pixel / 8-bit"), `Main.dc.html` ("Neo-brutalism"; it holds only that board, there's no Arcadia board), `WindowControls.dc.html` (four window-control sets, for Phase 4).
- **Seeing them.** `node tools/boards/render.mjs <board> <out-dir> [name='{"state":…}'[|hover]]…` renders a board headless with every request refused and the fonts from the theme packages (the canvas's own runtime isn't in the repo; `tools/boards/dc-shim.js` stands in for it).
- **Reference shots** in `docs/phase6/shots/`: the boards with their real fonts (`pixel-board*.png`, `neo-board*.png`), today's Neo-brutalism through the runtime and the mock host (`neo-now*.png`), and the two side by side at 2× (`neo-side-by-side-*.png`).

## What exists today

- **Themes.** `extension/themes/arcadia/` and `neo-brutalism/` are packages (`theme.json`, `theme.html`, `theme.css`, `first-paint.css`; Neo bundles four woff2 with `OFL-*.txt` and `SOURCES.txt`). `themes/packages.js` lists them (`PACKAGE_THEMES`, `PACKAGE_THEME_NAMES`). Arcadia also has `theme.js`, its settings for the background (the one JS file a theme folder keeps).
- **Runtime.** `ui/theme-loader.js` checks and loads a package: `checkPackage` (caps, file kinds), `sanitizeTheme` (manifest, template, CSS), fonts as `FontFace` from bytes. It can also store a user theme (`encodeStoredTheme`, `saveUserTheme`, `loadUserTheme`) in `storage.local` under `userTheme:<id>` and an index `userThemes`. Nothing calls those three yet.
- **Packages reach the app** from the extension: `background/theme-package.js` reads the active built-in theme and sends it in `theme` chunks (`app/PROTOCOL.md` "Chunks"). An unknown `settings.theme` falls back to Arcadia there, in `registered.js` (first paint) and in Settings.
- **The overlay** (`app/overlay/overlay.js`) loads whatever package the app hands it. If `loadTheme` refuses it, the overlay logs an error and draws nothing: there's no fallback, and the app never shows the overlay (it waits for `ready`).
- **The app's asks** go through `perform` (`Shell.swift perform` → `ShellProfiles.swift`, `ShellCloudTabs.swift`). That's where a file picker fits.
- **Settings** (`ui/settings-form.js`) offer a theme choice of the built-ins only. No import, no removal, no theme settings beyond the width that `m-resize` drags.
- **Data.** `DATA.md` lists a `userThemes` collection in each profile's data set, holding whole packages. A package can be 4.5 MB, more than the link's 1 MB cap, so the app leaves those out (`omitted`). `DATA.md` notes "their changes aren't queued until Phase 6 builds importing".
- **Security tests.** `tests/theme/payloads.js` (HTML, CSS, view-model and action payloads), `tests/theme/audit.js`, run in `tests/theme-sanitize.test.js` and `tests/theme-guard.test.js` (Node, `npm test`) and live in `tests/theme/browser.test.js` (WebKit and Chromium, `npm run test:theme`). They run against Neo-brutalism and hand-made payload templates. Arcadia's package goes through the same rules in `arcadia.test.js` and `theme-guard.test.js`. There's no one command, and nothing for imported packages, zips or folders.
- **The app on this branch has no switch cover.** Margin's notices (`notice` part) and the "Reconnecting to Safari…" dimming exist. The dimming is the overlay's own, not a theme's.

## 1. Pixel

A new package, `extension/themes/pixel/`, from `Pixel.dc.html`. Dark only: the board has no light version, and Pixel looks the same in both system modes (as Arcadia's palette does).

### Files

```text
pixel/
  theme.json  theme.html  theme.css  first-paint.css
  fonts/press-start-2p-latin.woff2  fonts/press-start-2p-latin-ext.woff2
  fonts/pixelify-sans-latin.woff2   fonts/pixelify-sans-latin-ext.woff2   (variable, 400–700)
  fonts/OFL-PressStart2P.txt  fonts/OFL-PixelifySans.txt  fonts/SOURCES.txt
```

- Fonts fetched once from Google Fonts' css2 files (latin and latin-ext subsets), as Neo's were. `SOURCES.txt` names the URLs, the date and the licence. Both are SIL OFL 1.1 (bundling approved, `PLAN.md` §11).
- `themes/packages.js` gets `pixel` and its name "Pixel". `scripts/build.js` then writes its first-paint file.

### Look (from the board)

- **Colours** (the PICO-8 palette): ground `#1d1b33` with `#3a3766` 1 px dots every 16 px; sidebar `#2a2850`; hover and the active row `#3b3870`; deep `#0b0a1a`; text `#f1f1f1`, muted `#c2c3c7`; yellow `#ffec27` (active text, cursor, focus), green `#00e436` (prompt `>`, New tab), red `#ff004d` (CLEAR, danger), blue `#29adff`; field border `#5f5aa8`. The space's colour is the accent (WORLD label, folder arrows, chip).
- **Type:** Press Start 2P for labels and headings (8–13 px: WORLD, space name, folder names, TODAY, CLEAR, chips, the palette title), Pixelify Sans for everything else (17 px base, 16 px rows, 19 px in the palette field).
- **Pixel borders:** four hard box-shadows, no blur, no radius (`0 -3px 0 c, 0 3px 0 c, -3px 0 0 c, 3px 0 0 c`), so corners are notched. 3 px light (`.px`) on the sidebar, page and dialogs; 3 px dark (`.pxd`) on tiles; 2 px dark around favicons.
- **Motion:** `steps()` only. The cursor blinks at 1 s. Buttons press down 2 px on `:active`. `prefers-reduced-motion` stops blinking and marching. Svg icons use `shape-rendering: crispEdges`; favicons `image-rendering: pixelated`.

### Layout

- 16 px padding, 18 px gap, sidebar 252 px (12 px × 10 px padding, 12 px gaps), the page card beside it with the light pixel border and radius 0.
- `<m-page>` is the card's content box. Its pixel border is a box-shadow outside the box, so nothing paints under the page. The dotted ground is masked around the card as Neo's is (`PLAN.md` §3: never paint under `<m-page>`).
- **Hidden:** sidebar width 0, the page from the 16 px gutter. **Peek:** the sidebar as a floating card at 14 px from the edges, z-index over the page.
- `theme.json` `layout`: `reveal: left`, `sidebarMin: 200`, `sidebarMax: 360`, `sidebarDefault: 252`.
- **Settings:** `sidebarWidth` (length, 200–360, step 4, 252 px), `blink` (toggle, on: the cursor blinks).

### Parts, each the board's or in its style

| Part | Pixel |
|---|---|
| Toolbar | sidebar toggle, back, forward, reload as 12×12 pixel svgs, 34 px hit boxes, `#3b3870` hover |
| Address | `> host` on `#0b0a1a` with a `#5f5aa8` inset border and a blinking 8×16 green block; opens the palette |
| Space header | `WORLD {n}-1` in the space colour, the name in capitals, `×{tabCount}` muted |
| Folders | `▼`/`▶` in the space colour (text in the template: the sidebar isn't guarded), name, count; drop target lights `#3b3870` with a yellow inset |
| Rows | 32 px; a yellow `▶` cursor before the active row (blinking), 18 px favicon box with a 2 px dark border, the letter in Press Start 2P on the site colour when there's no icon; hover `#3b3870` |
| Row states | active: yellow text on `#3b3870`; loading: the icon box blinks (steps); asleep: title at 55 % and a small "z" svg; not open: icon dashed, title dimmed; audible: three green EQ bars (the board's BGM bars); behind: a dim static `▷`; close: a pixel `×` on hover (tabs and open pins) |
| Today | dotted `#5f5aa8` rule, `TODAY`, red `CLEAR`; green `+ New tab ⌘T`; empty: `STAGE CLEAR! NEW TABS LAND HERE.` |
| Spaces | archive chest svg, numbered chips (`1`, `2`, `3`) on the space colour, the active one with a yellow pixel border, others at 55 %; `+` opens the add menu; profile marks, foreign chips dimmed, a switching chip blinking |
| Palette | dimmed `rgba(11,10,26,.7)` scrim, 660 px dialog at 140 px, `SELECT DESTINATION` in yellow, `> ` field, 40 px rows with the `▶` cursor on the selected one, the row's icon, title; at most 8 rows, then it scrolls (`m-scroll="palette"`); section headings for iCloud Tabs; the footer `↑↓ MOVE · ↵ GO · ESC BACK` |
| Menu, space editor, notice, prompt | dark `#1d1b33` boxes with the light pixel border; menu items with hover `#3b3870` and yellow text, danger red; the notice and prompt as the board's RPG text box, a blinking `▼` as an svg. All words are Margin's (below) |
| Launcher (new-tab page) | a "title screen": the `>` field, pinned tiles with the dark pixel border, the recent archive as a list |
| Settings | Margin's inputs styled: dark fields with the `#5f5aa8` border, toggles as pixel boxes with a check, the choice as a dark select, buttons as press buttons |
| iCloud Tabs | a folder in the same style, device names as tags in Press Start 2P 8 px, `▼`/`▶` as svg (a guarded part), stale devices dimmed |
| Gestures | pixel arrow and reload badges over the page that fill with `--gesture` |
| Drag and drop | yellow 3 px before/after lines, the ghost with the light pixel border, the resize handle a dotted line on hover |
| Loading | a stepped bar marching along the page card's top border (`tab.loading`), seen with the sidebar hidden too |
| Windowed mode (Phase 4) | `<m-window-controls>` as three square dots with a 2 px dark border, after the board's "Glass on dark" set; `<m-drag-region>` across the toolbar |
| `first-paint.css` | the card's light pixel border and the `#1d1b33` ground spread around it, under `html[data-margin-at="pixel"]` only |

Left out, as `PLAN.md` §9 says: the favorites tiles, the `?` Ask button and the Ask box, the BGM mini player. The address takes the full width.

### What Pixel needs from the runtime

- **A number for spaces.** "WORLD 2-1" and the numbered chips need the space's place counted from 1. The view model has `index` from 0, and templates have no arithmetic. Add `number` (index + 1) to `space` and to each `spaces[]` chip (`ui/view-model.js`), and document it in the README.
- **Guarded parts take no theme text,** not even a glyph: `▶` and `▼` inside menus, notices, prompts, the editor, Settings and iCloud Tabs must be svg. Outside them (the sidebar, the palette, the launcher) text is fine, so `SELECT DESTINATION` and `STAGE CLEAR!` stay text.
- Nothing else: every other binding, part, action and behavior exists.

## 2. Neo-brutalism against its board

Compared side by side (`docs/phase6/shots/neo-side-by-side-*.png`: the board's Work space against Neo's mock Work space, at 2×). Colours, type, borders, shadows, spacing, the toolbar, folder cards, the New Tab button, the divider and CLEAR, the chips and the page card match the board to the pixel where the data matches.

### Visible differences

1. **Favorites, Ask, mini player:** on the board, missing in Neo (future, `PLAN.md` §13). Neo closes the gap: the space header moves up 56 px and the address takes the full width. Fine as it is.
2. **The palette has no cap.** With many matches its rows run past the window's bottom (`neo-now-palette.png`). The board's dialog fits its rows. Fix: at most 8 rows, then the list scrolls (`m-scroll="palette"`), as Arcadia caps with `--rows`.
3. **Palette tags.** The board tags rows by kind (`TAB` yellow, `ASK` green, bordered). Neo shows the row's `badge` (the space's name for tabs) on the row's colour. Keep Margin's badge (it's what the view model has), drawn in the board's tag style: yellow fill, 2 px ink border, capitals.
4. **The palette label** says "SEARCH OR TYPE A URL"; the board's says "…, OR ASK". Right until Ask exists.
5. **The palette's selected row** has an 8 % ink fill; the board shows none (it has no keyboard selection). Keep it: the keyboard needs it.
6. **Folder heads** show a count on the right; the board's don't. Drop it to match the board? Arcadia shows none either. Proposed: drop it.
7. **Favicons.** The board draws letter tiles on the site colour (white letter, 1.5 px ink border, some round). Neo draws the site's own icon in a 2 px bordered square, and the letter only without one. Keep: real icons beat letters. Round tiles aren't data Margin has.
8. **Loose pins** (outside folders) draw as plain rows between the folders and the divider. The board has none. Draw them as the board's folder rows inside a borderless card, so they read as pinned.
9. Text, counts and abbreviations differ only through the mock data (`200 TABS`, `PE`/`WO`/`SS`).

### Parts Neo lacks, against Arcadia (from both templates' bindings and actions)

| Missing in Neo | Arcadia has | Plan |
|---|---|---|
| Close button on rows (`tab.close`) | × on hover, tabs and open pins | add, an ink × in a 20 px bordered box |
| Playing (`audible`) | speaker | add, a speaker svg after the title |
| `behind` (in front in another window) | marked | add, a dashed outline on the icon box |
| Open state of loose pins (`g.open`) | yes | bind `m-class:open` |
| "Keep the frame when hidden" (`window.frameWhenHidden`) | page fills the window when off | honour it: off, the card goes edge to edge, radius 0, no border |
| Palette row icons (`r.icon`, `r.letter`, `r.emoji`) | yes | add the icon box before the title |
| Dark mode for the launcher and Settings | follows the system | none: the board is light only; keep light (decision below) |

Everything else is there in both: the cloud-tabs part, notices, prompts, editor, launcher, Settings, gestures, loading, profile marks, drag and drop, resize, peek, swipe, window controls, first paint.

### The first paint before Margin.app has measured

`registered.js layoutFromSettings` uses Arcadia's geometry for every theme (8 px frame, radius 6.25, Arcadia's width) until the app's first `setLayout`. With Neo or Pixel, a page that loads before that gets Arcadia's box for a moment. Fix: `theme.json` `layout` gains the docked and hidden box (`dockedInsets`, `hiddenInsets`, `radius`), read by the background for built-in themes. Neo: 16 px gutters, the card at `16 + width + 16`, radius 18. Pixel: 16 px and 18 px, radius 0.

## 3. User themes

### The package a person writes

The same as a built-in theme (the README's "The files"):

```text
my-theme/
  theme.json  theme.html  theme.css
  fonts/*.woff2  images/*.{png,jpg,gif,webp,avif,svg}  *.txt|*.md (licences, notes)
```

Accepted two ways:

- **A folder.** Chosen in the file picker.
- **A `.margintheme` file:** a zip of that folder. Finder's Compress, renamed, works, and so does `npm run theme:pack <folder>` (new, `scripts/pack-theme.js`). If everything sits under one top folder (`my-theme/theme.json`), that folder is taken as the root. `__MACOSX/` and `.DS_Store` are skipped.

Today nothing reads either: `scripts/build.js` copies the built-in folders as they are, `background/theme-package.js` and `readBuiltinTheme` read a built-in by the files its `theme.json` names, `tests/theme/package.js` reads a folder from disk, and `loadTheme` takes `{ manifest, html, css, files }`. Phase 6 adds a reader for both forms that gives that same object (`ui/theme-import.js`).

### Where it's stored

- **By Margin.app, for the whole Mac, not per profile.** A theme is the person's look, the same in every browser and profile. `~/Library/Application Support/Margin/themes/<id>.json` holds the stored package in `encodeStoredTheme`'s format (format 2, files as base64), written as `DataStore` writes (a temporary file, `fsync`, `.bak`, rename). `themes/index.json` is the short list: `id`, `name`, `version`, `author`, `bytes`, `savedAt`.
- **The extension gets only the index,** never a package. It goes in each profile's data set as the `userThemes` collection, with the index entry as the item's value (a few hundred bytes, so no `omitted`), and the copy keeps it in `storage.local` `userThemes`. That's the key `handlers.js updatePackageThemeSettings` already reads. `updateSettings` then accepts a `theme` that's in the index. `DATA.md`'s `userThemes` row changes from "the stored package" to "the index entry". The `userTheme:<id>` storage keys go, unused: import was never built, so no copy has any.
- **Which package an overlay draws:** the app's own when the profile's `settings.theme` is in its index. Otherwise the built-in the copy sends (the copy sends Arcadia for an id it doesn't ship).
- **First paint:** a user theme has no `first-paint.css` (registrations are build files). Pages get a plain one: the box at the layout, nothing around it (`content/layout/theme-plain.css`, built like the others). Not Arcadia's frame, which would flash a different look.

### Import, step by step

1. **Settings › Theme › Import Theme…** (a button field, `settings.run themeImport`). In Margin.app the host turns it into `perform theme.import`. The overlay can't open a picker: it's a non-activating panel over another app's window, with a policy that allows nothing.
2. **The app shows `NSOpenPanel`** (new `app/shell/ShellThemes.swift`): folders and `.margintheme` files, one at a time. It activates Margin.app and gives the panel `.fullScreenAuxiliary` and `.moveToActiveSpace`, so it opens over full-screen Safari. Cancelled: nothing happens.
3. **The app reads what was chosen, with caps before reading:**
   - A folder: regular files only, symlinks refused (and anything that resolves outside the folder), two levels deep at most, at most 70 files, paths matching the package's path rule, each file and the whole within `PACKAGE_LIMITS` (checked from file sizes first).
   - A zip: at most 4 MB, read as bytes.
   - Then it pushes `{ type: 'themeFile', kind: 'folder' | 'zip', files }` or `{ type: 'themeFile', error }` (Margin's words) to that overlay only. Nothing goes to the extension. The log says the kind and byte counts, never names, paths or content.
4. **The overlay checks it,** with the same code as every load:
   - zip entries read in JS (`ui/theme-import.js`, inflating with `DecompressionStream('deflate-raw')`, which WebKit and Node both have), counting bytes as they inflate and stopping at the caps;
   - `checkPackage` (caps, file kinds, and new: each file's first bytes match its kind: `wOF2`, the PNG, JPEG, GIF, WebP and AVIF signatures, SVG as text);
   - `sanitizeTheme`;
   - the id isn't a built-in's.
   A refusal shows Margin's words and the first reasons. What was removed is listed by count and kind ("3 rules removed from theme.css: url() to a file outside the package").
5. **Preview.** The overlay draws the imported theme over the live window, with the window's real state, and its layout goes to the extension, so pages fit it. A bar of Margin's own sits over it: "Previewing “Name” 1.0.0 by Author. Use this theme? [Use Theme] [Cancel]", with "Replaces version 0.9.0" when the id is installed. The bar is in the top layer (`popover="manual"`), in its own closed shadow root, so the theme's stylesheet (adopted by the overlay's document) can't style it, and no z-index can cover it. The name and author are bound text, with bidi controls stripped. Escape cancels. Without an answer in 30 s it cancels by itself, so a theme that hides everything can't trap anyone. Cancel puts the theme from before back.
6. **Use Theme:** `perform theme.save { value }`. The app checks the value's shape, the id rule and the size again, stores it, writes the index, sends the index to every linked copy (`data.changes userThemes`) and to every overlay (`{ type: 'themes', list }`), then sets `settings.theme` for that profile (`updateSettings` to its copy). Other profiles keep their theme until chosen there.

### Removal

- Settings lists each imported theme: name, version, author (Margin's words around bound values), and a Remove button.
- Remove asks first in Margin's prompt part (guarded words: "Remove “Name”? Windows using it go back to Arcadia."), then `perform theme.remove { id }`.
- The app deletes the file and the index entry. Every profile whose `settings.theme` named it gets `arcadia`: through `updateSettings` on its link, or a change in its data set when it isn't linked. `settings.themes[id]` is dropped the same way. Overlays drawing it switch to Arcadia at once.

### When a theme fails to load

- **The app bundles Arcadia** for the overlay: `buildApp` writes `dist/app/arcadia.json` (the package in the `theme` message's shape), served from `margin-app://app/`. It's always there, even if the copy's package never comes.
- **The overlay falls back** to it when the package it's given is refused (`loadTheme` not ok), a user theme's file is missing or broken, or the theme's layout leaves no usable page (`<m-page>` under 200×150 or outside the window). It then draws Arcadia, says it's ready as usual, and shows a notice of a new kind, `theme-failed`: "“Name” couldn't be drawn, so Margin is using Arcadia." with Settings and OK.
- `settings.theme` stays as it was, so a fixed file works again at the next load. The log says the theme's id and the reasons' kinds, nothing from its files.
- **Escape hatch:** the set-up window (`app/safari/`) gets "Use Arcadia in every profile", for a theme that loads fine but is unusable.

### Settings, in each built-in theme

The form stays `ui/settings-form.js` fields (guarded part, Margin's words, Margin's inputs). New fields:

- **Theme** (choice): the built-ins, then the imported themes by name.
- **Import Theme…** (button), with the last import's status under it.
- **Per imported theme:** an info line ("Name 1.0.0 · by Author") and **Remove** (button).
- **The active theme's own settings,** from its `theme.json` `settings` (number, length, toggle, choice, colour), under a heading "Name’s settings". A theme's label is its own text inside Margin's form, so it's capped at 40 characters, bidi controls stripped, and drawn in a style that marks it as the theme's. These inputs only ever save `updateThemeSettings` for that theme.
- **Colour fields** need a new input, `m-input="setting-color"`, a colour well. Margin sets its value; the theme only styles it.

Arcadia, Neo-brutalism and Pixel each already draw `isInfo`, `isButton`, `isGroup`, `isChoice`, `isToggle` and `isNumber` fields generically. Each gets `setting-color` and a check that the new rows look right.

### The guide (for `extension/themes/README.md`, written with the import commit)

> **Making and importing a theme.** Start from a copy of `neo-brutalism/` (it uses everything). Keep the folder's layout: `theme.json`, `theme.html` and `theme.css` at the top, fonts in `fonts/`, images in `images/`, licences as `.txt` or `.md`. Give it your own `id` (lower-case letters, digits and dashes) and bump `version` when you change it. Fonts: woff2 only, with their licence; no font services. To share it, zip the folder and name the file `something.margintheme` (`npm run theme:pack my-theme/` does it). In Margin: Settings › Theme › Import Theme…, pick the folder or the file, look at the preview, and choose Use Theme. Importing the same `id` again replaces it. If Margin can't draw your theme, it uses Arcadia and says so; Settings shows why. Margin checks every theme when it's imported and every time it loads; the rules are under "Security rules" below.

## 4. The security suite

### One command

`npm run test:security`. It runs, in order:

1. The sanitizer and guard payloads in Node: `tests/theme-sanitize.test.js`, `tests/theme-guard.test.js`.
2. New `tests/security/packages.test.js`: every built-in package (`PACKAGE_THEMES`) through the import path, as a user's would go:
   - `checkPackage` clean, magic bytes included;
   - `sanitizeTheme` with nothing removed and no errors;
   - `auditTree` empty;
   - fonts woff2 with an OFL text and `SOURCES.txt`;
   - no font-service or other address strings in any file;
   - `first-paint.css` only under `html[data-margin-at="<id>"]`, with no `url(` and no text.
3. The same for every package named in `MARGIN_THEMES` (folders or `.margintheme` files, colon-separated), so a theme can be checked before it's shared: `MARGIN_THEMES=~/my-theme npm run test:security`.
4. New `tests/security/import.test.js`: the zip and folder payloads below.
5. The live run, in WebKit and Chromium with every request refused: `tests/theme/browser.test.js` payloads, and every built-in and `MARGIN_THEMES` package rendered with the hostile view model (`EVIL_VM`). The tripwire stays unset, no request is made, no page error.

The Node parts stay in `npm test`, the browser part in `npm run test:theme`. `test:security` only gathers them, with the packages added.

### Payloads to add (missing from `payloads.js`, by `PLAN.md` §4's rules)

Template:
- A `<symbol>` with svg `<text>` outside a guarded part, `<use href="#…">`'d inside one: theme words shown in a menu. The guard must refuse `use` inside guarded parts, or check what it points at.
- Ids named like the overlay's globals (`webkit`, `marginApp`, `T`): DOM clobbering, since the overlay's container is its document.
- The caps not tested yet: 48 levels deep, 48 attributes an element, a 4 KB attribute value, `m-for` nested 4 deep.
- `m-part` twice with one name, an unknown part name, `<m-page>` inside a part.

CSS:
- `url()` in `clip-path`, `offset-path`, `marker-start`, `mask-border-source`, `list-style-image`, `-webkit-box-reflect`.
- `url()` inside `@scope`, `@starting-style` and `@layer` blocks.
- A data: font in `@font-face`.
- `\62 ackground` (an escaped property name).
- `@counter-style` spelling words (must be refused; it isn't in `AT_RULES` today: a test keeps it so).
- A theme covering the preview bar: `position: fixed; z-index: 2147483647` and `:root` rules. Checked in the browser: the bar stays on top and clickable.

Package and import:
- Paths: `../`, absolute, backslashes, a drive letter, `.` segments, NUL, `Theme.json` beside `theme.json`, look-alike Unicode.
- Zip: symlink entries, encrypted entries, zip64, a method other than stored or deflate, duplicate entries, a bomb (small declared, large inflated), too many entries, a lying central directory, overlapping entries, data before the zip.
- Folder: a symlink to a file outside, a too-deep tree, a hidden `.git/`.
- Files: a "font" that isn't one, an image that's a script, an SVG image with script and remote references (kept inert: images never run script or load), a note over the cap.
- Manifest: `__proto__` keys, duplicate keys, deep nesting, a built-in's id, an id that differs from the stored one, a name or author with bidi overrides.

Run time:
- The overlay's policy, tested on its own: a page served with `OverlaySchemeHandler.policy` and a theme tree that skips the sanitizer (`buildTemplate` on a raw tree). No script runs, no request leaves.
- An app test that the content rules compile and that the policy string is `PLAN.md` §4's.

### CI later (not added now)

There's no CI in the repo, and none is added. When there is, a macOS runner can run `npm ci`, Playwright's WebKit and Chromium, `npm test` and `npm run test:security`, on every push that touches `extension/ui/`, `extension/themes/` or `tests/`. `test:app` needs Xcode and the Swift toolchain, so it'd be a second job on the same runner. Until then, the gate below runs it before every commit.

## 5. Work items, in order

Each one is a commit (`…(themes): …`), with `npm test`, `npm run test:theme` and `npm run test:app` passing, and `MARGIN_HOST_PORT=47921 tools/webkit-host/run.sh all` when it touches `extension/`. A first-paint W0/W1 failure is the known race: rerun that scenario alone and report it. `npm run build` after every extension change.

1. **This plan** (`docs: …`), the board renderer and the reference shots.
2. **The security suite as one command.** `npm run test:security`, `tests/security/packages.test.js` (every built-in, `MARGIN_THEMES`), the template, CSS and run-time payloads above, magic-byte checks in `checkPackage`, the guard against `use` in guarded parts. *Tests:* the new suite; the existing ones still pass with nothing removed from Arcadia and Neo.
3. **Pixel, the sidebar and the page.** The package with fonts, licences and `SOURCES.txt`; `theme.json`, layout, the two settings, `first-paint.css`; toolbar, address, header, folders, rows and their states, today, chips, palette, hidden and peek, loading bar; `space.number` and `spaces[].number` in the view model; `packages.js`. *Tests:* `tests/theme/pixel.test.js` (both engines: loads with nothing removed, fonts from bytes, rows and states, layout insets docked, hidden and peek, palette capped and keyboard-driven, no requests); unit tests for `number`, the build's first-paint file and the theme choice; the board side by side, checked by eye with `tools/boards/render.mjs`.
4. **Pixel, every other part.** Menu, editor, notice, prompt, launcher, Settings, iCloud Tabs, gestures, drag and drop, resize, profile marks, windowed controls. *Tests:* `pixel.test.js` grows a test for each part; `theme-guard.test.js` covers Pixel with nothing removed; `tests/theme/cloud.test.js` and `behaviors.test.js` run against all three themes.
5. **Neo-brutalism to its board and to Arcadia's parts.** Palette cap and scroll, board-style tags, row icons in the palette, close buttons, audible, behind, loose pins' open state and card, `frameWhenHidden`, no folder count. *Tests:* `tests/theme/browser.test.js` and `cloud.test.js` cases for each; the palette within the window with 200 rows.
6. **Each theme's own first-paint geometry.** `theme.json` `layout` box hints, read by `registered.js layoutFromSettings`. *Tests:* `registered.test.js` for Arcadia, Neo and Pixel, docked and hidden; schema tests.
7. **Fallback to Arcadia.** `dist/app/arcadia.json` from `buildApp`; the overlay's fallback on refusal, a missing package or an unusable layout; the `theme-failed` notice. *Tests:* unit (the choice of package, the notice's words); `test:app` end-to-end: a broken theme in the real overlay draws Arcadia and says so; `build.test.js` for the new file.
8. **The package reader.** `ui/theme-import.js` (folder file map or zip bytes to a package: root folder, skipped files, path rules, caps, inflating with counts); `scripts/pack-theme.js` (`npm run theme:pack`); the README guide. *Tests:* `tests/theme-import.test.js` with every zip, folder and path payload; a round trip of all three built-ins through `theme:pack` and the reader.
9. **Margin.app stores user themes.** `app/shell/ThemeStore.swift` (the themes folder, the index, atomic writes, reads that refuse a later format) and `ShellThemes.swift` (`theme.import` with `NSOpenPanel` and the folder rules, `theme.save`, `theme.remove`, the `themes` push, picking the user package for overlays, the index to copies). In the extension: `userThemes` as the index (`data-set.js`, `stateFromDataSet`), `updateSettings` accepting indexed ids, the plain first paint. Updates to `DATA.md` and `app/PROTOCOL.md`. `Shell.swift` gets only a `case` in `perform` and one hook where the overlay's theme is chosen, so the merge with the profile handoff stays easy. *Tests:* `tools/app-tests/theme-tests.swift` (store, index, caps, ids, a tampered file refused at load, the harness's picker path instead of the panel); `e2e-data.swift` (the index reaching a copy); unit `data-set.test.js`, `link.test.js`, `registered.test.js`.
10. **Settings for themes, and the preview.** The new fields in `settings-form.js`; host and overlay wiring (`theme.import` → `themeFile` → check → preview bar → `theme.save`); Remove with its prompt; the theme's own settings and `setting-color` in all three themes. *Tests:* `settings-form.test.js`; browser tests that the preview bar sits in the top layer and a hostile theme can't cover or restyle it, and that it cancels after 30 s; `test:app` end-to-end: import a folder and a zip, preview, use, remove the active theme → Arcadia in every profile.
11. **Tirth's checks and the record.** `TESTING.md` "Margin 2 Phase 6" (Pixel and Neo in full-screen Safari, light and dark system modes, an import from Finder over full screen, preview and revert, remove while in use), and `DECISIONS.md` entries for what changed on the way.

## Open questions for Tirth

- Neo's folder count (difference 6): drop it to match the board? The plan says yes.
- Pixel's and Neo's dark mode: the boards have one look each (Pixel dark, Neo light), and the plan keeps that in both system modes. Arcadia's launcher follows the system.
- A theme's own setting labels in Margin's Settings: shown, capped and marked as the theme's (above), or only Margin's generic words ("Setting 1")?
