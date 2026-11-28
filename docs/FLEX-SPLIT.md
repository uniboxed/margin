# Flexible split view

Tirth's ask (2026-11-28), after the prototype: three changes to the split view (docs/PEEK-SPLIT.md §4, §4b), in
this order.

1. **A pane opens to fit its app.** This replaces the cut pane's arrows. The pane under the pointer opens to at least
   its app's minimum size after a short pause. A click works too. The other panes fold into cards: the app is still
   visible behind a blur, with its icon and name over it. Hover is the default; "on click" is a setting.
2. **Drag from the sidebar into the page.** A row dropped on a pane's edge splits that pane on that side. Dropped in
   its middle, it replaces the pane. Dropped between two panes, it goes between them.
3. **A split tree.** Panes can be split in any direction (rows inside columns inside rows), with no limit of four.
4. **Extras**, once 1–3 are in: layout presets, keys to move between panes and move panes, and swapping panes.

Each step is its own branch off main, merged after the gate and an on-screen check.

## Where each part lives

The layout rules live where the split's layout already lives:

- **The page** decides pane sizes from the split's ratios. That code is `app/shared/ui/behaviors/split.ts`: one
  copy, shared by every platform and theme, next to `dragRatios` and `panesFit`.
- **margin-core** decides each window's frame from its pane's box (`layout::cut`, `host/model/panes.rs`).
- **The page core** decides the holes and where the pointer goes (`core/page`, `passthrough.rs`).

The Mac code is mechanism only. It places windows, cuts holes and draws the blur. The look is the theme's: `m-pane`
attributes and Margin's own elements, styled by CSS.

## Step 1: a pane opens to fit its app

### The rule (split.ts, pure, unit-tested)

`expandSizes(sizes, needs, floors, index, room)` returns each pane's size along the split's axis.

- `needs`: each pane's app minimum along the axis. `floors`: each pane's least size. `index`: the opened pane.
- The opened pane gets its need, capped at `room` minus the other panes' floors.
- The others share what's left by their ratios. None goes below `PANE_FOLD`.
- An opened pane that already fits changes nothing.
- When no pane is cut at the split's own ratios, there is nothing to open, so hover does nothing.

`PANE_FOLD` is 64 pt: room for an icon and a short name. The ratios are never saved. Opening a pane is a passing
view of the split. A divider dragged while a pane is open saves the sizes shown then, and that ends the open state.

### When a pane opens

The setting is `splitExpand`, `'hover'` (the default) or `'click'`. It sits in Settings next to the other split
options.

**Hover:** the pane under the pointer opens after `EXPAND_DWELL` (0.3 s, the prototype's). This pause is a choice of
intent, like Arc's hover: no state is being waited on, so the no-fixed-delays rule doesn't apply. Two sources tell
the page where the pointer is:

- At rest, a cut pane is a hole: the pointer goes to its app. Margin.app's `paneHover` says when the pointer enters
  and leaves a cut pane. This already exists, from the arrows (the core's `hover_cut`).
- Once a pane is open, the folded panes are Margin's own (no hole). The page sees the pointer over their cards
  itself, through WebKit's hover or Margin's `m-hover` marks (host/overlay.ts).

When the pointer rests on Margin's own UI outside the page (the sidebar, the frame) for `EXPAND_LEAVE` (0.45 s), the
split goes back to its ratios. The pointer leaving for the open app, or leaving the window, keeps the pane open.

**Click, and any press:** a pane that becomes the focused one through a press opens at once, in both modes. A press
on a folded card opens it and focuses its app. In click mode nothing opens on hover, and an open pane stays open until
another pane is pressed.

### The motion

The split moves from its sizes to the new ones over `EXPAND_TIME` (0.2 s, eased out), one frame each, through the
divider drag's own path: `split.resizing` on, the page measured each frame, the windows following live, then off.
Margin.app has no new motion code. The opened pane's window was cut at its minimum and now gets its box. The
folded panes' windows go to their minimums, cut and tucked, exactly as cut panes are today (`layout::cut`,
`tucked_order`).

### A folded pane

The page marks a pane `m-folded` once it opens below its app's minimum while another pane is open. Inside it, the
page adds `<m-pane-card>` with `<m-pane-icon>` (the item's icon, or its letter) and `<m-pane-name>`. These are
Margin's own elements: a theme styles them but can't write them. The pane report (`View.measure` `panes`) carries
`folded: true` for that pane.

A folded pane is not a hole:

- **The pointer:** its rect is left out of the slot, so the pointer there is Margin's. This is what lets the card see
  the hover, and what lets a press open the pane rather than reach a sliver of the app.
- **The ground:** it is cut out there, like a hole. A behind-window blur fills that cut-out (Margin.app: one
  `NSVisualEffectView` per folded rect, blending behind the window, under the web view), so the app's window shows
  through, blurred. The theme's card is drawn over it in the web view.
- **The theme's control:** a theme can tint the blur (a translucent card background) or hide it (an opaque one).
- **Why native:** no CSS can see another app's pixels. A behind-window blur is the window server's, needs no
  permission, and costs nothing per frame. It is mechanism, like the ground and the holes. It is the one native drawn
  piece, kept because Tirth asked for the blurred app. Windows: an acrylic backdrop, later.

The pane click tap and the core's `hover_cut` skip folded panes, since they're Margin's.

### The arrows go

`<m-pane-arrow>`, `m-cut-hover` and their CSS are removed from the page and themes, and `split.slide` from the
page's API. The engine's slide was removed once the on-screen check passed (2026-11-28, refactor/remove-pane-slide:
`HostEngine.slide`, `slideFor`, `slide_step`, `Slide`, the cut pane's sides). The page is told only which panes are
cut, each by its window.

### Tests, written to fail first

- **split.ts (unit):** `expandSizes` (two, three and four panes; both axes; bands; floors pushed past the room;
  already fits; nothing cut). Also the state machine with a fake clock: dwell, leave, press, click mode, a drag
  ending it.
- **Theme tests (both engines):** the card is drawn in each built-in theme. A folded pane reports `folded`. The arrows
  are gone.
- **margin-core (page):** a folded pane is no hole for the slot or the pane holes, is cut out of the ground, and is
  listed for the blur. `hover_cut` skips it.
- **App tests (glue):** the folded rects reach the blur views. The pane click tap leaves a folded pane to Margin.
- **Screen suite:** a two-pane split of test apps, one cut. Hover it: it opens, the other folds (blur view in place,
  windows at their minimums). Leave to the sidebar: the split goes back.

## Steps 2–4

These are planned once step 1 is on main.

- **Step 2 (drag and drop):** the sidebar's row drag gets drop zones over the page area. Margin's own targets, drawn
  over the holes while a drag is under way, are the page's. A drop sends `split.add` with a place. The fit check
  (`refusesAdd`) counts folded panes at `PANE_FOLD`, so a split may hold more than fits at full size.
- **Step 3 (tree):**
  - The library's `splits` becomes a tree (`{axis, kids, ratios}` with leaf items), with a migration from the flat
    list.
  - `expandSizes` runs per node. The page draws nested `<m-split>` boxes.
  - The fixed four goes from every place that holds it: the page report, `PageLayout.swift`, `PageCore.swift`, the
    model's `ROOM`, and `canAddPane`.
- **Step 4:** presets from the tree, the moves and the swap.
