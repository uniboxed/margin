# A press in Margin's sidebar, and its double-click (design, 2026-11-24)

Two changes, one design: a press on Margin's own UI never takes the keyboard from the hosted app (GitHub #29), and a
double-click on an empty part of the sidebar opens the command palette, as Arc's does. Built on `feat/sidebar-press`
off `refactor/hosted-only` (e5650a99). File and line references are to that commit.

## What happens today

- **The panel.** Margin's UI is drawn in `MarginPanel`, a borderless non-activating panel over Margin's full-screen
  window (app/platforms/macos/shell/MarginWindow.swift:110-180). It can be key only while `allowKey` (:143), which a
  field of Margin's sets. Its `sendEvent` (:165-179) moves the window for a drag region and calls `pressEnded` on
  every left release (:178).
- **The press.** The window server routes the press to Margin's panel and, doing so, moves the keyboard to Margin's
  process before AppKit asks the panel anything. The hosted app stays the front app, but its window resigns key: its
  unfocused look for about 0.2 s (#29: 185-193 ms on the real screen).
- **The hand-back.** `pressEnded` (MarginWindowController.swift:1224-1229) waits `pressSettle`, a fixed 80 ms (:1223),
  for the page to say whether a field took the focus, then `afterPress` (:1231-1235) calls `keysBack` (:1190-1201):
  `letGoKeys` (:1170-1175), then `NSApp.yieldActivation(to:)` and `activate(from:)` on the app shown (:1184-1188).
  A key typed before that is relayed to the app (`startKeyRelay`, :1914-1935).
- **A field.** The page says `focus` when a field of Margin's takes or lets go of the keyboard
  (app/shared/host/overlay.ts:971-987 `setKeys`, also a menu or prompt open); the core routes the op
  (app/shared/core/src/page/said.rs:148) and the controller keeps `pageWantsKeyboard`, calling `takeKeys` (:1144-1164:
  the panel made key without making Margin active) or `letGoKeys` + `keysBack` (:1725-1736).
- **The pointer's way.** Which pointer events are Margin's and which go through the page area's hole to the hosted
  window is the core's: `PassThrough::gets` (app/shared/core/src/passthrough.rs:168) and `PagePointer::passes`
  (:764, the theme's window controls while windowed), applied on each move by `PagePointer::moved` (:780) and carried
  out by the panel's `ignoresMouseEvents`; `PointerWatch` (PassThrough.swift:179-209) hears the moves and presses,
  `CatchView` (:215-238) keeps the window server from passing the pointer through Margin's see-through pixels.
- **The pane click tap.** An event tap that exists only while a split is shown (PaneClickTap.swift; made and told in
  MarginWindowController.swift:2017-2112). Its core, `PaneClickCore` (:172-353), already takes a cut pane's press and
  the drags and release after it (`redirect`, :190, :217-272) and delivers them to that window as the window server's
  own records (`PaneFronting.deliver`, PanesActive.swift:242-247; `PaneRecords.delivered`, PaneRecords.swift:32-39):
  never routed, so never raised. Proven on the real screen on 2026-11-22: a press, its drags and its release, each at
  its point, in order.
- **Windows.** Margin's window answers `MA_NOACTIVATE` to `WM_MOUSEACTIVATE` while it hosts
  (app/platforms/windows/src/appwindow.rs:420): there a press on Margin's UI never takes the keyboard already.
- **Empty spots.** The dev hook's `say: spot` (app/engines/webkit/safari/DevHooks.swift:280-297) scans the sidebar for a
  point whose element is not inside `a, button, input, …, [m-action], [m-drag], [m-resize], [m-drag-region], …`
  (:282) and not inside `<m-page>`. Nothing in the UI reads a double-click on such a point.
- **The palette's key.** ⌘T (or the palette's own key) sends `command palette`; the page closes the palette if it's
  open, else opens it as `{ newTab: appWindow || !launcher }` (overlay.ts:827-833, `openPaletteTimed` :668), through
  the runtime's `openPalette` (app/shared/ui/runtime.ts:1056).

## The design, piece by piece

| Piece | Where | Why there |
|---|---|---|
| When a press on Margin's UI must leave the keyboard where it is: hosting, a hosted window shown (`shown`), no field of Margin's wanting the keys | margin-core, `core/page/press.rs` (`keys_stay`, `Page::presses_keep_keys`); the page keeps the field's word (`Page::set_field_keys`), the Swift's `pageWantsKeyboard` reads it | A rule both platforms need: Windows' `MA_NOACTIVATE` is the same decision (today `hosting` only; it can read this once its window has a core page) |
| Which way a press at a point goes: through to what's hosted (the slot, the window's buttons while windowed), Margin's UI with the keyboard staying, Margin's UI as before, or outside the window | margin-core, `core/page/press.rs` (`press_way`), over the existing `PassThrough::gets`; `PagePointer::passes` becomes a free function both use | The pointer's own rules are the core's already; the tap's thread reads them from a copy (as `PaneClick.decide` reads `PassThrough.pageGets`) |
| The event tap: presses of every button, and the drags and release of a press it took; a press on Margin's panel taken and delivered to the panel as an event made afresh from it (`PanelEvents`: `NSEvent.mouseEvent` for the panel, `postToPid` to Margin's own process; public calls only, never the window server's own record of the press), its drags and release after it | Swift, `PaneClickTap.swift` (`PaneClickCore.event`, the tap's existing thread, mask and callback); the panels told in its scene (`PaneClickScene.panels`, from `MarginWindowController.panelScene`) | OS mechanism: CGEventTap, SkyLight's records. One tap for both jobs: a second tap would be a second round trip per press |
| Another window over the panel at the point (a hosted app's menu, a sheet, the Dock, a system dialog, a notification, Margin's quit prompt): the press as before | Swift, the tap's existing `cover` read (`AXPaneFocus.cover`, the window server's list for that press only) | The window server's own list |
| A press the tap delivered needs no hand-back: `pressEnded` skips `afterPress` for it (by its event number, as the tap's claims are known today) | Swift, MarginWindowController / MarginWindows | AppKit's keys, the panel's |
| A field focused by the press: `takeKeys` as today (the panel made key; the keyboard moves only then) | unchanged | The page's `focus` op is unchanged |
| The tap's lifetime: while a Margin window on the current Space shows a hosted app (or a split, as today), Accessibility granted; off with `defaults write com.unibox.margin MarginSidebarTap -bool NO` (today's hand-back then) | Swift, `MarginWindows.paneSceneChanged` | OS permissions and settings |
| The double-click: on an empty part of the sidebar, both clicks of it, nothing of Margin's open, the palette opens as the palette's key opens it | app/shared/ui: `ui/empty.ts` (the rule: what's empty), `behaviors/empty.ts` (the behaviour), the runtime's `openPaletteAsKey` (the key's rule, which overlay.ts's `command palette` now uses too) | The sidebar's behaviour is the shared UI's: every theme, every host, Windows' web view too |
| A theme marking an area as never empty: `m-empty="never"` | the theme contract: ui/sanitize.ts `BEHAVIORS`, themes/README.md | Only ever less empty: no theme can make a row, a button or a field "empty" |
| The dev hook's `say: spot`: the shared rule's own scan (`marginApp.devEmptySpot`), its old selector when the page has none | DevHooks.swift calls the page | One rule for the screen checks and the behaviour |

### The tap, in order

1. The scene (main thread, at each change of the holes, the page's state, a field's keys, the Space): every Margin
   window on the current Space that's on screen, with its panel's number, its content's frame (top left), its slot, its
   window controls and full screen, and the core's `presses_keep_keys`. No panel in it while the part is off or
   Accessibility isn't granted.
2. A press (any button) on the tap's thread, no press of the tap's under way:
   - with another button held: as before;
   - `press_way` for the panel whose content holds the point: anything but `ui` (keys staying): as before;
   - another window over the panel at the point (`cover`): as before;
   - else delivered to the panel as an event made afresh (`PanelEvents.queue`, AppKit's own queue in Margin: the panel's number, its
     point in the panel), the event swallowed; its number kept for `pressEnded`; said to the main thread.
3. While a press it took is under way: every mouse button's drag and release goes to the same panel the same way, and
   another button's press there too; the last button up ends it. Moves, scrolls, the trackpad's swipes and every key
   never come through the tap.
4. Delivery refused (no such process, not a mouse event): the press goes on as before, routed, and today's hand-back follows.

Order: the callback delivers each event before it returns, and the window server hands the tap its events one at a
time, so a press, its drags and its release reach the panel in the order they came. Keys typed meanwhile go to the
hosted app, which kept the keyboard: nothing to order against.

### `pressSettle`

The press the tap delivered never moved the keyboard, so nothing is handed back and nothing waits: `pressEnded` skips
`afterPress` for it at once. `pressSettle` is left only where the window server still routed the press (no tap:
Accessibility not granted, `MarginSidebarTap` off; or a press the tap
let go because another window covered the panel there) and for `menuItemRan`, a menu item of Margin's run while Margin
is the front app; both unchanged. Its comment says so.

### The cost

- At rest: nothing. The tap is a mach port on its own thread's run loop, no timer, no poll; no event reaches it while
  no mouse button changes. Mouse moves and scrolls aren't in its mask.
- Per press: one round trip to Margin's tap thread (as the split's tap has today), the core's `press_way` (a few
  comparisons), and for a press on Margin's UI the window server's list of the windows above the panel.
- Per drag event of a press the tap took: one round trip and one event made and posted. Other presses' drags pass at one
  comparison.
- Measured in `app/platforms/macos/ffi/tests/press_cost.rs` (the core's part) and the report's numbers (the list read).

## The double-click's rule (`ui/empty.ts`)

A point of the theme is empty when, walking up from the element under it to the theme's root:

- nothing on the way is one of Margin's slots or parts (`m-page`, `m-page-loader`, `m-palette`, `m-menu`, `m-editor`,
  `m-notice`, `m-prompt`, `m-toast`, `m-preview`, `m-launcher`, `m-settings`, `m-window-controls`, `m-drag-region`),
  nor marked `m-empty="never"` by the theme;
- up to the nearest element that holds a control or a row, nothing:
  - runs an action, or has one of the handles `m-drag`, `m-resize`, `m-rename`, `m-input`, `m-peek`;
  - is a control: `a`, `button`, `input`, `textarea`, `select`, `label`, `[contenteditable]`, `[tabindex]` (0 or
    more), `[draggable="true"]`, an interactive ARIA role (`button`, `link`, `menuitem`, `option`, `radio`,
    `checkbox`, `switch`, `tab`, `slider`, `textbox`, `combobox`, `searchbox`, `spinbutton`, `treeitem`, `gridcell`,
    `scrollbar`);
  - is a row of one of the theme's lists (an `<m-for>`'s item: a tab, a pin, a folder, a favourite, a space's chip);
  - is a bar: an element two or more of whose children are controls or rows side by side (their boxes on one line),
    as a space switcher, a header of buttons, a favourites grid or a mini player's buttons are; the edge handles
    (`m-resize`, `m-peek`) and drag regions never count, as they lie beside everything;
- and that nearest holder is one of the sidebar's own surfaces: its column (the space's part a swipe moves,
  `m-swipe`) or a list (`m-scroll`, `m-drop`: the room below its last row). A widget's background (the mini
  player's, the space's title beside its name), the frame around the page card and anything else holding controls
  aren't.

The double-click opens the palette only when both its clicks were on empty points, with the main button and no
modifier, a real press (`isTrusted`, as the theme's actions take), nothing of Margin's open (the palette, a menu, the
space editor, a name being edited, a prompt, the preview card) and nothing under way (a drag, a resize, a swipe). It
opens it as the palette's key does (`openPaletteAsKey`: in Margin's own window the new-tab palette), said in Margin's
log as the key's is ("palette opened (a double-click on the sidebar)"), and never closes it.

A theme can't break it by accident: anything it draws that does something is one of the above (Margin's own actions,
handles and fields are the only ways a theme's element does anything: themes run no script), a row is a row wherever
its parts are drawn, a gap between two controls on one line is a bar's, and a widget's background belongs to the
widget. What's left is decoration and the sidebar's own background. A theme that wants a decoration left alone (a
heading drawn as a button would be) marks it `m-empty="never"`, the attribute's only value: nothing can be made empty.
A theme with no `m-swipe` column has only its lists' empty room (`m-scroll`, `m-drop`).

## Tests, each failing first

- core: `page/press.rs`'s own tests (the rule's every case, the field's word kept by `said`), `passthrough.rs`
  (`passes` unchanged), the FFI's (`press_way` over the C interface, no allocation).
- Swift unit (`pane-click-tests.swift`): a panel press delivered, its drags and release after it, in order; covered,
  through the hole, a field's, nothing shown, another button held: as before; delivery refused: as before.
- app e2e (tools/app-tests): the scene carries the panel while an app is shown; a press the tap delivered: no
  hand-back; one it didn't: the hand-back as today; a real double-click (clickCount 2) on an empty spot of the real
  page opens the palette, on the page area it doesn't.
- UI and theme (tests/theme, every built-in theme, WebKit and Chromium): an empty spot's double-click opens the palette
  as its key does; a row's, a folder's, a pin's, the space's name's, the address field's, the space switcher's (a chip
  and the gap between chips), a drag region's, the resize handle's, the mini player's, the decoration beside the
  space's name, the frame's, a field's don't; one click of the two on a row doesn't; nothing while a menu is open;
  `m-empty="never"` honoured, any other value refused by the sanitizer.
- Screen suite (run by Tirth): k1 tightened back to "the pane's window never resigned key"; k2, a double-click on an
  empty spot opens the palette with the pane still the front app; k3, a double-click in the pane's content doesn't.

## Delivered afresh, never as the window server's record (2026-11-24, after the first screen run)

The first build delivered each sidebar press as the window server's own record of it (as a cut pane's press). On the
real screen (the core part's k1) the pane never resigned key, but AppKit in Margin then keyed the panel, whose
`canBecomeKey` was false, and took Margin for active (`appkit active true`, `panel … key true`, `allow key false`),
while the window server kept the pane the front app; the next key went to Margin, which relayed it and handed the keys
back. The same delivery of a press made afresh, to an off-screen non-activating panel with a web view in a process of
its own, left AppKit inactive and the panel not key, whether posted as a record made from a fresh event, put in
AppKit's queue or posted to the process (`postToPid`); the page got its mousedown and double-click each time (the lab
in the report). The posting, the panel and WebKit are ruled out; what's left is the real press's own record, which no
lab here can read (a real press through an event tap on the real screen). The likely field is the window server's
word on a click (a click on a window that isn't key makes it key: the make-key flag yabai and AltTab set, 0x3a = 0x10),
which AppKit would honour over `canBecomeKey`; the next screen run's log line says the bytes.
The tap now makes the event afresh from the press's public fields (`PanelEvents`) and posts it to Margin's own process;
the first press's own record was read only to be said in the log (its bytes 0x38-0x3b), so the next screen run showed
the field (that read went on 2026-11-25, its question answered). No record is posted for the panel any more, and the panel part no longer needs the records' layout check.

## The second screen run (2026-11-25)

The first press's record had 0x3a = 0, so the record wasn't it: a press made afresh and posted through the window server
keyed the panel too, on the real screen only (off every display, the lab and the e2e never did). The tap now puts
Margin's own presses in AppKit's queue in Margin (`PanelEvents.queue`), the window server never told of them;
Temporary `DIAG` lines (MarginWindow.swift's MarginPanel, MarginWindowController.swift; removed after the fourth run)
logged who keys the panel and who activates AppKit, with their callers.

## The third screen run (2026-11-25): who keyed the panel

cut-panes passed with the queue. k1 still failed, and the DIAG lines named the caller: AppKit's own left-mouse-down
handling of a non-activating panel (`-[NSWindow _handleLeftMouseDownEvent:isDelayedEvent:]` →
`_NSShowNonActivatingKeyWindow` → `-[MarginPanel becomeKey]`), before it asked `canBecomeKey`; a key non-activating
panel then makes AppKit say the app is active. The panel becomes key only if needed (`becomesKeyOnlyIfNeeded`, set
since 2026-11-17), and what's "needed" is the hit view's `needsPanelToBecomeKey`: Margin's web view, which WebKit
answers yes. OverlayWebView now answers from its window (`needsKeyForPress`): no while the core's `keys_stay` holds (an
app shown, no field of Margin's), yes otherwise, as before. A field the press focuses takes the keys by the page's
`focus` (`takeKeys`, an explicit `makeKey`), as the palette's does. The `postToPid` way is gone.

## The fourth screen run (2026-11-25)

k1, k2 and k3 pass on the real screen: after a press on an empty spot of the sidebar the panel took the press and
stayed non-key, AppKit inactive, no key window, the pane's window never resigned key (the DIAG lines' `took 1`,
before and after the same). core 36 passed, cut-panes 14. The DIAG lines are removed.
