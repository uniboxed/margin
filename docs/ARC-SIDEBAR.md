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

Part A is the study; Part B is the plan. Built on the branch (2026-11-25): steps 1–7 (each's entry in DECISIONS.md,
"M2.10 step …"); left: the second measuring session (step 8), the tooltip's profile chip, and two of Tirth's calls
(below, "Open").

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
- **Partly followed in Arcadia** (Tirth, 2026-11-25): the page card has Arc's 6 pt corner but stays 8 pt in (not Arc's
  10 pt), and the sidebar out over the page sits in the same frame with the same corner (as tall as the card, its
  corners the card's: 6 pt), not Arc's 5 pt / 12 pt panel below. Arc's card shadow and the panel's rim and shadow are
  kept.
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

## The ends of the spaces (measured 2026-11-25, `feat/arc-sidebar-ends`)

Read from Tirth's two recordings (Arc at 1×: 1 px = 1 pt; the first at 75 fps, the second at about 25) and Arc's own
accessibility tree (its Library and its Create a Space opened through its own buttons, then closed: nothing made).

**Past the first space, the Library** (Arc's `Home` button opens the same one, on its switch spring: 6%, 71% by the
second frame, done in ≈ 200 ms):
- **It follows the fingers**, a page of its own: the sidebar widens 259 → 417 pt as the fingers go (the page beside it
  moving with it), the Library slides in from the left at the same progress (its list exactly at
  `−(1 − p) × 417`), opaque, on the space's own colour. The space under it fades over the first 55% of the way
  (`1 − p / 0.55`), shrinks about its middle (`1 − 0.1 p`) and drifts right (`27 p` pt). Let go, it settles on the
  swipe's spring (back: ≈ 12 frames at 75 fps).
- **Its layout**: 417 pt wide. A rail of six 97 × 80 pt buttons 100 pt apart, 8 pt from the left, centred down the
  window (Media, Downloads, Easels, Spaces, Boosts, Archived Tabs; the icon's middle 31 pt into each, its label's 56,
  11 pt semibold; the one shown on a lighter pill; the icons a dark shade of the space's colour). At the bottom, 32 pt
  buttons at x 8 and 73: back, and Arc's gift. The section beside it from x 112 (305 wide): a 36 pt search pill 10 pt
  down (its glass 15 pt in, the text 44 pt in, "Search Downloads…"), Filter (73 pt) beside it for Downloads and
  Archived Tabs; then the list: a day's heading (28 pt: "Today", "Yesterday", "1 day ago" (two calendar days back,
  under 48 hours), "2 days ago"…, "1 week ago") and its rows (56 pt: the icon 18–22 pt in, the title at 52 pt in,
  14 pt, the address under it at 12 pt, no scheme or www). Easels empty: its icon, "Out of ideas!", a line. Spaces is
  a whole-window manager (a card per space).
- **In Margin** (Tirth's choices, 2026-11-25): Archived Tabs is Margin's archive; Media, Downloads, Easels, Spaces and
  Boosts are drawn with words saying they aren't in Margin yet; the box button opens it as Arc's does. 417 pt where
  the page can make room; while an app is hosted (the sidebar's width fixed: each width would place the app again)
  it's the sidebar's width, the rail's icons only, the page where it is (and the space doesn't drift over it).

**Past the last space, the pull and Create a Space**:
- **The pull**: the rubber band as before (the space up to ≈ 40 pt past its end). A light along the sidebar's right
  edge (an ellipse ≈ 83 pt wide and the window's height, white at ≈ 19% at the edge's middle) slides in from the edge
  over the first 16 pt (5.2 × the distance drawn) and stays as it is; a 30 pt "+" at the window's middle comes out of
  the edge to 28 pt in (1.65 × the distance): blue (`#2124ff`) with a white "+", a white ring filling round it as it
  nears the threshold; at ≈ 24 pt drawn it turns white with a blue "+" (the blue shrinking to nothing, the "+"
  forming: ≈ 110 ms). Let go there: Create a Space at once, in place, and the "+" and the light slide out of the edge
  in about three frames. Short of it: back, the "+" going the same way.
- **Create a Space** (259 pt): three tilted cards (🌴 💻 📚) 82–124 pt down, "Create a Space" (17 pt bold) at 140, two
  lines of 13 pt ("Separate your tabs for life, work, projects, and more.") at 171, then 36 pt fields 14 pt in from
  the sidebar's sides: the name (a dashed 18 pt icon box at 22, "Space name…" at 48) at 237, Profile (its chip, an ⓘ)
  at 279, Choose a Theme at 323; Create Space (36 pt, Arc's blue, faint until there's a name) at 1308 and Cancel at
  1358. The dock shows it as the space in front. Its ground is the new space's colour (Arc picks one). A swipe toward
  the previous space takes it away (the space coming back, the "+" flashing out of the edge).
- **In Margin**: nothing is made until Create Space (the host's `createSpace` with the name, icon, colour and profile:
  Margin.app's core takes the profile); Choose a Theme makes it and opens Edit Theme Color for it (that picker needs a
  space); Cancel and Escape make nothing. Arcadia's "+" New Space opens it too, as Arc's.

## The Library's sections, as Arc draws them (2026-11-25, `feat/arc-library-ui`)

Tirth: the same icons, spaces and UI as Arc's, even where the feature isn't built.
- **Its icons**: Arc's are two-colour (a primary, the space's colour darkened, for the outline; a secondary for the
  inside), drawn as animations in its app (ARC_HomeButton.bundle's `screenshots`, `downloads`, `easels`, `spaces`,
  `boosts`, `archive`), rendered here only to look at. Margin's are drawn anew to their shapes (two photos with a sun and
  a hill, a circled arrow, a card with a filled bar and a squiggle, two cards, a tilted card with a brush and sparkles, a
  lidded box), not taken from Arc's files: unselected the outline alone, the one shown darker with its inside white, on
  a darker pill (black at about 7%), its label black (the others' grey, 11 pt bold).
- **Their words** (read from Arc's app): Archived Tabs "Nothing here yet!" / "Hover your mouse over a tab and press the
  ✕ to archive it." (its search: "No results found for “…”"); Downloads "Come back after you've found some cool stuff
  to save." (its heading not in Arc's binary as text: "Nothing here yet!", Arc's other one); Media "Save media to your
  Documents, Desktop, and Download Folders to see them here, alongside your Captures" (Arc's ends "in Arc"); Easels
  "Out of ideas!" / "Click the + sign in the Sidebar to create a new Easel."; Boosts "Nothing Boosted Yet!" / "Type
  “New Boost” in URL bar to make your own, or grab one from the Boost Gallery." (its first words not in the binary as
  text: Arc's own Boost prompt). Archived rows: Arc's restore and delete under the pointer (delete: no such request in
  Margin yet, drawn).
- **Spaces, Arc's space manager**: the panel across the window but its last 56 pt, over the page (Arc pushes its page
  to that sliver; Margin's page stays 417 pt in, under it, so a hosted app isn't placed again), a row of 240 pt cards
  24 pt apart, 48 pt from the top and bottom, each in its space's colour (its background's colours as a gradient where
  it has one): its icon, name, profile chip and pencil (Edit Space), its folders and pins and today's tabs as its
  sidebar has them (a row opens it), Arc's move handle and ••• at its foot (drawn).

## The space's colour in a switch (measured 2026-11-25, `feat/space-color-blend`)

Read from the first session's two recordings of a dock click (Work → Personal and back, 60 fps, lossless; the mean
colour of two empty parts of the sidebar, the top bar right of its buttons and a strip at its left edge, each frame;
the list's offset with `shift`):
- **It starts in the slide's first frame**, both ways: the frame the list first moves is the first that changes colour.
- **On the slide's curve**: about 90% of the way 100 ms in (six frames), all but a trace when the slide lands (≈ 200
  ms), the last of it by ≈ 280 ms. Arc's sidebar is translucent (the desktop blurred under the space's colour), so a
  channel's path isn't a straight line between the two (a dip, a slight overshoot); the average of the channels keeps
  to the list's progress within a frame or two.
- **So in Margin**: the colour follows where the space is drawn, frame by frame (a swipe's fingers, the settle's
  spring, a click's slide), not a curve or a fade of its own. The space's background (Margin's layer, M2.9) the same:
  the one coming in drawn over as far as it's come, the one shown as it lands, where it used to cross-fade 0.3 s after
  the slide.

## Measured in the second session (2026-11-25)

- **A folder**: unfolding, the rows after it on `cubic-bezier(0.5, 0.8, 0.75, 1)` over 210 ms (0.31 pt RMS), its rows
  out from under it; folding, `cubic-bezier(0.25, 0, 0.25, 1)` over 250 ms (0.27 pt).
- **"+"**: a dark popover (≈ `#140f00` over the beige space), 210 pt wide, 8 pt in, 40 pt rows, its groups apart:
  New Space, New Folder · New Easel ⌃⇧E, New Boost · New Split ⌃⇧=, New Tab ⌘T; the row under the pointer olive
  (`#625729`); an arrow down to the button, which shows × while it's open.
- **Closing a tab**: the × 26 pt, 4.5 pt in; the title ending before it; the row fading where it was as the rows after
  it slide up over it.
- **Dark** (a dark space): a row's hover, white at 10%.
- Arc also shows a round ↑ (or ↓) over the list when it's scrolled away from its top or bottom.

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

## Open (2026-11-25), answered

- **The space swipe's feel**: Dia's stays (Tirth, 2026-11-25).
- **The tooltip's profile chip**: built (step 6b; Margin.app tells the page its profiles' names).
- **The second session**: done (DECISIONS.md "M2.10 step 8"): folders, "+", closing a tab, dark. Not measured:
  favorites (a drop landed in the pinned list; undone), the media player, an iconless space's title row.
