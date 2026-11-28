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

## Step 2: drag from the sidebar into the page

Built 2026-11-28 on feat/split-drop.

### Where a row goes (split.ts `dropPlace`, pure, unit-tested)

`dropPlace(boxes, axis, x, y, canAdd)` takes the boxes shown and the pointer:

- **The page shown alone** (`axis` null, its one box): the nearest of its four edges. The dropped item goes on that
  side of the item shown, as a new split: left or right side by side, top or bottom stacked. The mark is the half
  of the page it would take (`side`).
- **A split's panes** (in order, along its axis): each pane's ends (`DROP_EDGE`, a quarter each) and the gap between
  two panes put it between them (`between`, its place among the panes; the mark a `DROP_BAR` line on that edge). A
  pane's middle puts it in that pane's place (`replace`; the mark that pane's box).
- **A split of four** (`canAdd` false): a pane's whole box is its `replace`, and the gaps take nothing.
- Only the split's own axis has edges here. A pane split across the axis waits for step 3's tree.

### What a drop runs

- **Which rows:** tab rows only (an open item, or a kept one): the rows Add to Split View is on. Only in Margin's own
  window with a window hosted in the page area. Never one of Margin's own pages, the item shown, or a pane of the
  split shown.
- **The behavior:** the sidebar's drag (drag.ts) asks the split behavior over the page when no sidebar zone is under
  the pointer (`dropAt`). The behavior draws the mark, `<m-drop-zone m-kind>`: Margin's own element on the theme's
  root, styled by the theme's CSS. A drop runs `split.drop` (behavior-only). It is refused with a toast when the
  panes wouldn't fit at their least sizes (`refusesDrop`, the same room check as an add).
- **The library:** `split.drop` asks the library's `addToSplit` with three more fields, in both copies (library.ts
  over model.ts, and margin-core's port; the shared vectors re-recorded):
  - `at`: the place among the panes.
  - `replace`: the pane's item it takes the place of. That pane's ratio is kept, and that item leaves the split but
    stays an item. The count stays the same, so a split of four takes it.
  - `axis`: a new split's axis. `at` 0 puts the dropped one first.
- **The room check is unchanged.** Folded panes are not counted at `PANE_FOLD`, as planned. With more panes than fit
  at rest, a middle pane's window would cross its neighbours (only the end panes' windows can pass the page's edge),
  so that question goes with step 3.

### The pointer over the holes

A drag that starts on Margin's sidebar stays Margin's while the button is held:
- Margin.app's pass-through changes nothing while a button is held.
- The press tap delivers a press on Margin's panel, its drags and its release to the panel.

So the page sees the drag over the hosted windows' holes. No native code changes. Two things the real screen showed:

- **A press switches** (Arc's, behaviors/press.ts): pressing a row shows its tab at once, so the page under the drag
  was the dragged tab itself, with nothing to drop beside. The first time the drag reaches the page, the press's
  switch is undone (`switchBack`): the tab or split shown before the press comes back, and the row drops beside or
  into it. A click, and a drag within the sidebar, are as before.
- **WebKit's `buttons`** reads none on the press tap's moves: it asks the window server, which the tap took the press
  from. So in Margin's own window the sidebar's drag ends at the release, not at a move with no button. Margin's own
  window always gets a press's release (from the tap, else from AppKit). Elsewhere the check stays.

### Tests

- **split.ts (unit):** `dropPlace`: a page's four edges and outside it, a pane's ends and middle, the gap, a full
  split, stacked.
- **Library (unit, both copies):** a new split's order and axis; between two panes with equal ratios; places that
  aren't places; a replace keeping the ratio; a replace in a split of four; a pane taken from another split.
- **Theme tests (both engines, every built-in theme):** the marks drawn where they go, and the requests each drop
  sends. None outside Margin's own window.
- **Screen suite (`split-drop`):** real drags from the sidebar: on the page shown alone (a new split), on a pane (in
  its place), on the gap between two (between them). 9 of 9 on the real screen, 2026-11-28.

## Step 3: a split tree

Built 2026-11-28 on feat/split-tree.

### The data (extension/shared/split-tree.ts: one copy for the state, the library and the page)

- **Flat splits are stored as before:** `axis`, `panes`, a ratio each. There's no migration, and every flat change
  runs its old path. Ratios normalized twice at 4 decimals aren't the same (0.3333 ×3 becomes 0.3334), so a flat split
  never goes through the tree's rules.
- **A nested split also stores `tree`:** `{ axis, kids, ratios }`, a kid being an item or a node. Its `panes` are its
  leaves in order, `axis` is its root's, and `ratios` is each pane's share of the whole area (a flat split's ratios are
  that too). So whatever reads `panes` and `ratios` reads them as before: the sidebar capsule, `splitForItem`, the
  hosting.
- **The canonical form:** a node has two kids or more; a kid that's a node runs across its parent; every node's ratios
  are normalized. A stored tree is read only when it's one for the stored panes (`storedTree`), copied with its axes,
  kids and ratios only. Otherwise the split reads flat.
- **The limit is 16 panes** (`MAX_SPLIT_PANES`; the native side's `MAX_PANES`). The page area is the real limit: the
  room check (`treeMin`) needs every pane at 220 both ways, with the gaps and Safari's bands.

### The library (both copies; the shared vectors re-recorded, the generator storing nested and broken trees)

- **`addToSplit`** gains `beside` (a pane's item) and `side` (left, right, top, bottom). The two share that pane's
  room, half each: in its node when the node runs that way, else that pane becomes a node across it. `at` and
  `replace` stay. An add with neither goes last among the root's kids, those made equal.
- **`resizeSplit` and `toggleSplitAxis`** take a `path`, the node's kid indexes from the root. Turning a node turns
  everything in it; a node turned to its parent's way merges into it.
- **The tree is kept canonical** through remove, settle, swap (places traded, sizes kept) and replace.

### The page (ui/behaviors/split.ts)

- **Groups:** each node below the root is an `<m-split-group m-split m-path>`. Every pane and divider sits in its
  node's group, dividers marked `m-axis`.
- **Per node:** layout, divider drag and keys (`split.resize` with its `path`), double-click, least sizes (`treeMin`),
  and bands (a column's divider above a kid with a Safari pane at its top).
- **Opening a pane** works along each node on its way from the root, the others folding (step 1's rule per node).
- **The corner masks** come from where the pane sits (`paneEdges`, `maskClip`): a half, an L of three corners, or all
  four. They're set as `--m-pane-clip` (render.ts `m-pane::before`). A flat split's are the same strings as before
  (tests/theme/pane-mask-seam).
- **Dropping a row:** any pane's four edges (DROP_EDGE each) put the row beside it on that side, marked by the half it
  would take (`m-drop-zone[m-kind="beside"]`). A gap puts it beside the nearest pane. `split.drop` is `{ tab, split,
  nextTo, pane, side }`.
- **The built-in themes'** column dividers are styled by `m-divider[m-axis="column"]`. A theme's `m-page[m-split] >
  m-divider` still matches a flat split's dividers.
- **The native side** reads up to 16 panes (the page report, the FFI's fixed arrays, Margin.app's lists). It has no
  new layout code: it places each pane's window at its box, as before.

### Asked, then decided

A split keeps only as many panes as fit at their least sizes. Holding more, with the rest folded, would put a middle
pane's window over its neighbours'. Tirth asked to finish everything; this is the conservative choice, and changing it
later is a room-check change.

### Tests

- **Unit (tests/split-tree.test.ts):** the tree rules, the library's nested changes in sequence, settle, the limit.
  Its calls are recorded into the vectors.
- **split-view.test.ts:** `dropPlace` for any side, `treeMin`, the bands, the edges and masks.
- **margin-core:** split_tree_tests.rs, and every vector answered as library.ts answers it.
- **Theme tests (both engines, every built-in theme):**
  - tests/theme/split-tree.test.ts: a pane beside a column of two; each box and the report; the cursors; the masks;
    the column's divider saving its path; a pane opened along the column, its neighbour folded.
  - split-drop: below a pane, beside the nearer one at a gap.
- **Screen suite (`split-drop`, four copies):** Chameleon 4's row dropped near Chameleon 2's bottom edge, the two
  stacked in its place, each window at its pane's box in Margin's Space. 11 of 11 on the real screen.

## Step 4

Presets from the tree, keys to move between panes and move panes, and swapping panes, with a pane dragged within the
split (a pane of the split shown takes no drop today).
