# Arc's sidebar in Arcadia (M2.10, study and plan, 2026-11-25)

Branch `feat/arc-sidebar`, from `refactor/hosted-only` at `2ffe0327`. Commit scope: `m2.10`, the next of Track 2's Arc
features (M2.1–M2.9).

What Tirth asked for (2026-11-25):

- Arcadia's sidebar should be Arc's exactly: its layout, its sizes, its transitions and animations.
- Arc's details too:
  - a space whose icon was removed shows as a dot in the space switcher;
  - when the spaces' icons don't fit, the switcher shows only the active space's icon and the rest as dots;
  - the switcher's tooltips.
- The page's depth: Arc's shadow around the page card, and its border, whatever it is.
- Controls for features Margin doesn't have yet (Boost, Easel, Downloads, the media player, Little Arc) are drawn
  anyway, inert (Tirth's choice).
- Arcadia is the theme that changes (Tirth's choice); no new theme.

Part A is the study; Part B is the plan.

---

# Part A: the study

## Sources and method

- **Arc 1.174.2 (build 91442), installed and running on Tirth's Mac** (a MacBook Air: a 60 Hz Retina screen, 2 px per
  point). Tirth allowed driving it for the measurements. Everything below was read from the running app; nothing of
  Arc's (its images, icons, Lottie files, code) goes into Margin, as for M2.9.
- **Geometry**: the accessibility tree of Arc's window (every element's frame, in points, with Arc's own identifiers
  such as `SidebarDockItem-<space>`, `sidebarSpaceName`, `sidebarPlusButton`), read with the AX API. Exact to the
  half point.
- **Colours and shadows**: screenshots of the window at 2×, averaged over hundreds of rows or columns, because Arc's
  window carries a grain texture. A white page was used where an edge had to be read against white.
- **Motion**: the screen recorded losslessly at 60 frames a second while the app was driven (key presses, clicks,
  pointer moves), then read frame by frame: an edge's position, a text's position, a region's colour. Curves were
  fitted to the samples.
- **Binary**: `Arc.app/Contents/MacOS/Arc` keeps its Swift type names (`SidebarDock.SidebarDockView`,
  `SidebarDockCollectionViewLayout`, `SidebarDockCollectionViewItem`, `SidebarPlusButtonGradientBackgroundView`,
  `SidebarSpaceViewController`). Hopper's analysis of the 80 MB arm64 slice was started but not finished (its demo's
  licence dialog and session limit): no constant below comes from disassembly, all from measurement.
- Measured with the sidebar at Tirth's width, 259 pt, and with his settings: tab rows with Arc's top toolbar shown
  (View › Hide Toolbar puts the address in the sidebar, Arc's default; both were measured).

## The window and the page card

- The page card sits **10 pt** inside the window's top, right and bottom edges, and starts at the sidebar's edge
  (x = the sidebar's width). With the toolbar shown, the toolbar is inside the card.
- **No border.** On a white page the card's edge pixel is pure white and the shade outside it falls off smoothly: no
  hairline, inside or out. (Arcadia today draws a 0.5 px hairline, `0 0 0 0.5px rgba(0,0,0,.14)`.)
- **The shadow**: one shadow fits the measured falloff on all four sides to within 0.002 (RMS of the darkening):
  black at 25%, 1 pt down, a Gaussian of σ = 3 pt (`0 1px 6px` in CSS terms). At the card's edge the background is
  11% darker at the sides, 9% at the top, 15% at the bottom. WebKit draws a CSS blur a little tighter than a Gaussian:
  rendered at 2×, `box-shadow: 0 1px 7px rgba(0, 0, 0, 0.25)` matches Arc's falloff within 0.5% at every pixel (RMS
  0.005, the measurement's own noise; 6 px gives 0.009).
- **The corner**: 6 pt. The half-coverage contour of the bottom-left corner on a white page, row by row, fits a plain
  circle of radius 12 px (6 pt) within 0.2 px except its last two rows (Arc's continuous corner eases in a hair
  longer): `border-radius: 6px`.
- **The sidebar is translucent**: the window's colour is the desktop behind it, blurred, under the space's colour and a
  grain image (the AX tree has an image named `grain` over the window). Margin draws the space's own colour and
  texture (M2.9), so the sidebar's colour is Margin's, not measured here.
- **The sidebar out over the page (the peek)**: a floating panel 5 pt from the window's left, top and bottom, the
  sidebar's width; its corner about 12 pt (its inner contour fits a 23–24 px circle); a 1 pt rim just inside its edge,
  white at 30% (luma 188 over 160); a soft shadow over the page, black at about 16.5%, σ ≈ 4 pt (read on its right
  side, over a white page).
- **The window out of focus** pales the sidebar (to about `#ECEBE5` over a light desktop) and greys the traffic lights.

## The sidebar, top to bottom (259 pt wide)

### The top bar (Arc's default: no toolbar)

| What | Frame (x, y, w × h) |
|---|---|
| traffic lights | 12, 16 / 35, 16 / 58, 16, each 16 × 16 |
| Hide sidebar | 77, 7.5, 32 × 32 |
| Back, Forward, Reload | 153, 187, 221 (y 7.5), each 32 × 32 |
| the address | text at 20, 55, 227 × 18, in a pill from x 8 to 251, about 36 tall, radius 10 |

- On hover the pill shows three 20 pt icons at its right: a pinned extension, **Copy URL** (a link), and **site
  controls** (sliders). Margin has Copy URL; site controls is one of the inert ones.
- Back and Forward are dimmed when there's nowhere to go.

### The space's title row

- With the toolbar shown it's at y 49 (95 without): the icon 26 × 26 at x 13, the name at x 41 (18 tall), the More
  button at the right (x 244).
- The name is drawn in a muted colour (secondary text), semibold, about 32 pt for "Work".
- **Hover**: a pill the width of the list (x 8 to 251) in the hover colour; the icon turns into a chevron (collapse
  the pinned tabs) and `•••` (the space's menu) shows at the right.

### Rows

- A row is **40 pt tall, 41 pt apart** (a 1 pt gap). A folder's rows are indented 16 pt (button from x 16), loose
  rows from x 0.
- Inside a row: the favicon 18 × 18 at row x + 17 (33 in a folder), the title at row x + 43 (59 or 61), 19 pt tall;
  a second line (the subtitle, e.g. "Back to Pinned URL", `localhost:4028`) 16 pt tall under it.
- **Font**: the system font at **13.5 px, weight ≈ 450** (fitted in WebKit against seven measured words: RMS 0.6 pt).
  Folders' names are bold (semibold).
- **Hover**: a fill **36 pt tall**, 2 pt inside the row's top and bottom, from 8 pt inside the row's left (24 in a
  folder) to 8.5 pt inside the sidebar's right; corner radius **≈ 11 px**; **black at 5%** (every channel × 0.949).
  It appears and goes **at once** (one frame: no fade either way). A **×** (close) shows at the right on hover.
- **Selected**: the same 36 pt shape, a near-white card (≈ `#EEEBE9` over a beige sidebar, `#F1F1F0` over a light
  one; no grain: it's opaque, mixed from the background, not white at an alpha), a brighter rim along its top edge
  (about 4 levels over 3 px) and a short, crisp shadow under it (16% at the first pixel, gone in 3 px: ≈
  `0 1px 1.5px rgba(0,0,0,.16)`).
- **A pinned tab that left its URL** shows a `/` after its favicon and "Back to Pinned URL" under its title.
- **Folders**: a folder icon (an open or closed folder) in the favicon's place and a bold name.
- **The Today divider**: a hairline, and **"↓ Clear"** at its right whenever the pointer is anywhere in the sidebar
  (not only on the divider).
- **New Tab**: a row with `+` (18 pt at x 17) and "New Tab" in the muted colour.

### The bottom bar

| What | Frame |
|---|---|
| the hairline above it | across the sidebar, where the list scrolls under |
| Home (Arc's library; Margin's archive) | 8, (bar), 32 × 32 |
| the spaces | from x 41 to the `+`'s left; 34 tall |
| `+` | sidebar width − 40, 32 × 32 |

- Home's hover shows a rounded-square fill and Arc's latest download (a file's icon, name and age) above it: Margin
  has no downloads, so the preview is one of the inert parts.
- `+`'s hover: the same rounded-square fill.

## The space switcher (Arc's "dock")

Measured by dragging the sidebar from 500 to 260 pt with 10 spaces, reading every item's frame at each width.

- **Items overlap by 2 pt.** Each is a slot; the slots fill the room between Home and `+` (x 41 to width − 39):
  `slot = min(36, (room − 2) / n + 2)`, centred when they're at 36.
- **Icons or dots**: while every slot would be **at least 24 pt** (`n × 22 + 2 ≤ room`), every space shows its icon.
  Below that, **only the active space shows its icon** (its slot kept at 24 pt) and every other space is a **dot**,
  the rest of the room shared between them (`(room − 24) / (n − 1) + 2` each; 19 pt with 10 spaces at 259). With 10
  spaces the change happens between a 302 pt sidebar (icons) and 300 (dots).
- **A space without an icon is a dot**, in either mode (Tirth's report; Arc's "Change Icon…" can remove it).
- **Icons**: the active space's in full colour; the others desaturated and faded (grey). Hovering an inactive icon
  shows a rounded-square fill behind it and its own colour.
- **Dots**: small round dots in the sidebar's foreground colour, faded.
- **Hovering a dot** (dots mode): that space's icon grows out of the dot in its place while the active space's icon
  shrinks to a dot: **≈ 230 ms, eased in and out**. Leaving the dock brings it back.
- **The tooltip** (dots mode; none appeared over an icon within 1.2 s): **≈ 470 ms** after the pointer arrives, all at
  once (no fade), above the dock: a dark pill (`≈ #2B2410` on the beige space: the space's colour, very dark) holding
  the space's **name** (white, semibold), a **chip** with the space's profile (its icon and name, on a light
  tinted pill) and the **shortcut** as two key caps (`⌃` `2`).

## Motion

| What | Measured | As CSS |
|---|---|---|
| a row's hover | at once, on and off | `transition: none` |
| the dock's hover swap | ≈ 230 ms, ease in and out | `230ms cubic-bezier(.42, 0, .58, 1)` (to verify side by side) |
| the tooltip | 470 ms delay, no fade | `transition: visibility 0s 470ms` |
| switching spaces (a key, a dock click) | the pages side by side one sidebar width apart, sliding; a spring with a fast start: response 130 ms, damping 1.35, initial velocity 72 widths/s (RMS 2.5 pt over 15 frames) | a `linear()` easing sampled from that spring, ≈ 200 ms; `cubic-bezier(.1, .7, 0, 1) 200ms` is within 3.4 pt |
| hiding the sidebar | the page's left edge 259 → 10 pt in ≈ 70 ms | Margin.app's (native) |
| showing it | ≈ 70 ms, a steep ease-out (61%, 83%, 95%, 99.6% of the way at each frame) | Margin.app's |
| the peek (pointer at the window's left edge, sidebar hidden) | a spring with a slight overshoot: response ≈ 205 ms, damping ≈ 0.79 (from 10 to 274 pt, back to 270) | `linear()` from that spring |

The pages of a space switch: the outgoing one moves out as the incoming one comes in, both at the same speed; the space's
colour changes with it (M2.9 draws that).

## Still to measure (a second, shorter session)

- A folder opening and closing (the attempt hit a stuck modifier key and opened the folder's menu instead; nothing
  was changed in Arc).
- Favorites (Tirth has none in Arc; one can be added and removed).
- The media player, a tab being closed and dropped in, a drag.
- The New Tab row's hover; the close button's frame and hover.

---

# Part B: the plan

## What the code says (at `2ffe0327`)

- Arcadia (`app/shared/ui/themes/arcadia/`) already has Arc's structure: the top bar with window controls, the
  sidebar toggle and back/forward/reload; the address pill; favorites; the space's title; pins and folders; the Today
  divider with Clear; the media player; the bottom bar (archive, the space chips, `+`). Its sizes and its look are
  its own approximation; its chips are emoji only.
- The page's frame is the `.page` box's huge spread shadow (`--frame`), its depth `.card-edge`'s shadow (a 0.5 px
  hairline and `0 1px 3px rgba(0,0,0,.08)`), its corner `--card-radius`; with a space's background (M2.9) Margin's
  layer draws the frame.
- Themes run no JavaScript (SPEC). What needs measuring is a behavior in `app/shared/ui/behaviors/`, opted into by an
  attribute (`sanitize.ts` `BEHAVIORS`). Whether the dock's icons fit is one of those: CSS can't count a list against
  its width.
- The swipe already offers Arc's feel (`--m-swipe-feel: arc`); Arcadia uses Dia's.
- A space's emoji can't be removed today: `updateSpace` ignores an empty one, and a new space gets `✨`. The library's
  rules are margin-core's (step 4 of the core refactor); `extension/state/model.ts` is the reference the shared
  vectors check.
- A space knows its browser and profile (margin-core `library/actions.rs`), and Margin.app has `space-1`…`space-9`
  commands (`Shortcuts.swift`): the tooltip's chip and key caps have real data to show, once the view model carries
  them.

## Order (one commit each; `npm run test:quick -- --base refactor/hosted-only` before each; `npm run gate` once before merging)

1. **This study and plan** (docs).
2. **The page card**: Arc's inset, corner and shadow, no hairline; the window out of focus paled.
3. **The sidebar's rows and bars**: every size above (top bar, address pill and its hover icons, the title row and its
   hover, rows, hover, selected card, folders, the Today divider's Clear on sidebar hover, New Tab, the bottom bar and
   its hairline), the fonts; the inert controls (site controls, Home's downloads preview).
4. **The dock**: Arc's slots and overlap; icons, greyed when inactive; a new behavior that says when the icons don't
   fit (`m-fit` on the dock: Margin sets `m-crowded` while each item at its least roomy size wouldn't fit), dots then,
   the hovered dot's icon swapping with the active one's.
5. **A space without an icon**: the model allows removing a space's emoji (margin-core first, the reference and the
   vectors with it); the editor and the space's menu offer it; its chip is a dot.
6. **The dock's tooltip**: the view model gives each chip its profile's name and icon and its shortcut's text;
   Arcadia draws Arc's tooltip after 470 ms, in dots mode.
7. **Motion**: switching spaces on Arc's spring, the swipe on Arc's feel, the peek's spring, the dock's swap.
8. **The rest, measured in a second session**: folders opening and closing, favorites, the media player, closing a
   tab.
9. **Docs**: where it stands, the manual checks.

Each step is checked side by side: Arcadia rendered in WebKit at 2× with the same tabs, folders and spaces as the
measured window, against Arc's screenshot.
