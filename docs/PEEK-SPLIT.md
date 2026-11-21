# The preview card, Quick Tab and split view in Margin.app (design, 2026-11-21)

Margin.app showed one hosted window per Margin window. The preview card, Quick Tab and split view need several at once, each at a
rect of its own, in one page area. This is the plan they're built from. Track 2's UI pieces (feat/arc-suite, M2.5 and
M2.7) are kept where they fit; their missing native half is this.

## Tirth's decisions (2026-11-21)

| Topic | Decision |
|---|---|
| Preview motion | Quick and light: the backdrop dims and the card fades and scales in, about 150 ms, compositor only; closing reverses it. Reduce Motion: a fade. |
| Quick Tab | A quick card from ⌥⌘N over the current space, on the preview's machinery: an address or search first, then the page; Expand into the space, or close. No default-browser change. |
| Split view | 2–4 panes, any mix of Safari tabs and hosted Mac apps, side by side or stacked, dividers dragged live. Each Safari pane is a Safari window of its own in the space's profile. |
| Mini player | Safari tabs now; hosted apps later (MediaRemote is closed to other apps since macOS 15.4). |
| Shift+click, auto-preview | On by default while this is a test branch. |

## Words

- **Visible hosts:** the hosted windows a Margin window shows now, each with its **rect** (in the page area) and its
  **role**: `main` (the item shown, as before), `pane` (a split's other panes) or `float` (the preview card, Quick Tab's too,
  above the rest).
- **Focused host:** the visible host with the keys: the card while it's open, else the pane last clicked, else main.
  Today's `shown` becomes this.
- Names (2026-11-21: never Arc's in the product): the card is the **preview card** (Arc's Peek), the card with an
  address field first **Quick Tab** (Arc's Little Arc). Themes see `vm.preview`, the `preview.*` and `quickTab.open`
  actions, the `<m-preview>` slot, the `preview` part and `<m-preview-page>`. "Peek" stays the sidebar's hover reveal
  (`m-peek` attribute, `window.sidebar === 'peek'`). Native code calls the card `card`; the wire names between the
  copy, the page and the app keep their first names (`peekOpen`, `peekAnswer`, `peek.*` performs, the `peek` push,
  `little-arc`), and so does this file's name.

## 1. Foundation: several visible hosts per Margin window

Behaviour with one visible host stays exactly as today (every existing test passes unchanged).

**Identity.** `HostTarget.safariWindow(profile)` gains a role: `.safariWindow(profile, SafariRole)` with
`main | card | pane(1...3)`. `HostID.raw` stays `safari:<profile>` for main (markers, routes and logs unchanged) and is
`safari:<profile>#card`, `#pane1`…`#pane3` for the others. Routes stay keyed by bundle id (a card that loops demotes
Safari as a whole: the same as today's rule for an app).

**Engine (HostEngine.swift).**
- `shown: HostID?` stays the focused host. New `visible: [HostID: Visible]` (`rect`, `role`, `z` back to front)
  holds every visible host, `shown` among them. With only main, `visible == [shown: page]`.
- `desired()`: every visible host Shown at its rect; the rest Parked as now.
- Each host's rect replaces `placement.page` wherever a tile, a member's reservation or a window-mode frame is
  computed or checked: `frame`/`fitted`/`tileRect(for:)`, `reapplyTiles`, `sizeTile`, `sendHostedRects`,
  `noteOffPage`, `tileStale`, window mode's frame. `HostLayout.fit` for a pane never puts overflow under the sidebar:
  a pane below its minimum isn't laid out (the UI clamps first, §4).
- `show(layout)` takes the whole wanted layout (main + panes + card, rects) as one change: hosts newly visible are
  brought in (opened or unparked) at their rect, hosts no longer visible are parked, the focused one fronted. Never
  "park the shown host first" for a card or a pane (`openNow`'s retire only applies to the role it replaces).
- Live resize (`dragging`/`follow`/`pumpLive`): every visible tile or window-mode host follows its rect per frame,
  one rect in flight per host; `LiveResizing` on Margin's Space as now. Rects come from the UI's measure each frame.
- `activateShown`/front: raises visible hosts back to front so their order is right, the focused one last (its app
  active, its window key). `keysBack` → `fieldClosed` → this (never raises main over the card).
- The stray rule, leftovers, strips, `lookFront`/`lookOnScreen`, `announceHosted`, `shownMinimumWidth`: per visible
  host. `is_strip` measured against the host's own rect, so a card's or pane's toolbar is its own.
- Order fallback (`FrontMechanism.order`): Margin is placed above the frontmost visible host; `frontRead` checks all.

**Session (HostedSession.swift).** `shown[w]` stays the focused item; new `layout[w]` (items + roles + rects).
`safariWindows` becomes `[SafariKey: Int]` (profile + role). `requestSafariWindow` takes the role; restored-window
sweeps and `closeWoken` spare every role's window (`made_`). `live()` marks the focused item `active` and the other
visible items `visible` (the sidebar highlights a split's panes as one capsule).

**Margin's window (MarginWindowController.swift, MarginWindow.swift, PassThrough.swift).**
- `holes: [CGRect]`: each visible host's frame ∩ its rect, once that host is in place (per-host `shown` signal). The
  ground view's even-odd path draws them all; the corners rounded only where they meet the page card's.
- The pointer's slot: a list of rects (each pane's hole), less the theme's hits; while a card is open, only the
  card's content rect (the dimmed page around it caught: a click there closes the card).
- `pressed(at)`: the press's host found by rect; a press in another pane focuses that pane (no raise of main).
- `hostedFrame` pushes the focused host's frame (theme swap unchanged) plus `hostedFrames` for all.

**Browser copy (extension/background/hosted.ts).** `hostShow {windowId, itemId, url}` shows the item's tab in that
window: a tab Margin knows in another of Margin's windows is moved there (`tabs.move`, keeps the page; ~170 ms
measured) before it's made active. Tabs in a card window aren't the space's (not in the sidebar, not archived) until
Expand.

## 2. The preview card

- **Open:** Shift+click on a link, or a click on a link to another site from a pinned tab or favorite (auto-preview), in a
  window Margin draws (the copy knows: `appDrawn`). Anywhere else, and in a dormant copy, nothing is intercepted. The
  page asks the background, which asks the app; the click is cancelled only once the app accepts (`peekOpen` answered
  `ok`). Answer late or refused: the link opens as it would have (same tab, or a new one for `_blank`).
- **Window:** one card window per profile (`safari:<profile>#card`), made at the first preview, parked while closed, closed
  after 15 minutes unused (and with its profile's main window). Opening a parked one is a switch (~25–36 ms). The
  first open goes the normal first-open path; the card shows its loader meanwhile.
- **Rect:** the theme's `preview` part has an `m-preview-page` element; the overlay measures it as it measures `<m-page>`
  and the app places the card window there. Margin's default part: centred, 8% side and 7% top/bottom margins,
  420×320 minimum, a 52 pt bar for the theme above the page (at least: the card window's Safari toolbar rests in those 52 pt) (back, forward, the address, copy, Expand, close).
- **Look:** the overlay dims the page area (translucent, so main shows through, dimmed), the card's page area is
  clear and its window is in the hole. Open: dim to its level and the card from 0.96 scale and 0 opacity, 150 ms,
  transform and opacity only; the window revealed at the end (it's under the card's loader until it's in place).
  Close: the reverse, then the window parked. Reduce Motion: opacity only.
- **Inside:** links stay in the card. A new tab in the card window becomes the card's page. Esc in the page (not
  handled by it, not in a field) closes the card; ⌘W closes the card, never the main item; a click on the dimmed area
  closes it.
- **Expand (bar button, ⌘↩):** the tab moves into the space's main window and becomes the space's tab, shown; the card
  closes. **Close:** the card's tab closes; the window stays, parked.
- **Attached to its opener:** switching away hides the card (parked, kept); coming back to the opener shows it again.
  One card per profile: a new preview elsewhere replaces it.

## 3. Quick Tab

⌥⌘N: the card opens with Margin's address field instead of a page (the theme's `preview` part, `preview.isQuickTab`, no
window yet). A search or address chosen opens the card window at it (never Safari's own empty page: its address field
keeps Safari's toolbar down). Then it's the preview card: Expand puts it in the current space. Esc or a click outside closes it.

## 4. Split view

- **Model:** the library's `splits` (items, axis, ratios) as Track 2 made it. A split is shown when one of its items is
  picked; its other items are the panes, the picked one focused.
- **Hosts:** an app pane is that app's host (an app can be in a split once). Web panes of one profile: the first uses
  the profile's main window, the others `#pane1`…`#pane3`, each tab moved into its window by `hostShow`.
- **Rects:** when the shown item is in a split, Margin's renderer puts `<m-pane>` boxes (one per pane, flex by the
  ratios) and `<m-divider>`s between them inside `<m-page>`; themes style the gap, the divider and the focused pane.
  The overlay measures each `m-pane` and sends the rects with the page's. Minimums: each pane host's minimum, known to
  the app, is sent to the page, which never lays a pane below it (a divider stops there; a pane that can't fit isn't
  added: a notice says so).
- **Dividers:** dragged in the page: the ratios change per frame, the panes are measured and sent, the windows follow
  live (tiles and window mode; a plain member re-placed at release under its loader). Release: `split.resize` saves
  the ratios. Double-click a divider: equal sizes.
- **Focus:** a click in a pane focuses it (keys, the sidebar's highlight). ⌘W closes the focused pane's tab: the split
  goes on with the rest, or ends at one.
- **Leaving:** picking an item outside the split parks the other panes' windows; the split stays for next time.
- **Sidebar drag:** every pane follows live.

## 5. Order of work

1. Foundation (§1), with tests proving one-host behaviour unchanged and two visible hosts held at their rects.
2. The preview card and Quick Tab (§2, §3), the extension's click safety first.
3. Split view (§4).
4. On the real screen with real Safari (Tirth's one-time permission, 2026-11-21): card open/close/expand, splits of
   2–4 with tabs and apps, divider drags, sidebar drags, switches in and out, ⌘W, Esc, keys after a sidebar click.
   Then the gate and the screen suite before he's asked to install.

## Tests

- Engine: the stand-in world (behaviour-world.swift) hosts two and three windows at once; desired keeps them; a park
  of one leaves the others; live resize moves all; a card never parks main; the stray rule leaves a card alone.
- Overlay (real WKWebView, tools/app-tests): several holes; slot only the card's content while a card is open; a
  press in the dim closes it; `m-pane` and `m-preview-page` measured and sent.
- Extension: click interception only after the app accepts; `hostShow` moves a tab between Margin's windows; card
  tabs out of the sidebar until Expand.
- Themes: all 5 draw the card bar, the dim, panes and dividers, in both engines.
