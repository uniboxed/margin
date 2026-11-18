# The hosting core (design, 2026-11-17)

Asked by Tirth on 2026-11-17, after a day of app-by-app fixes: "if we keep having these issues with every
app, this is not going to work. We have to address each issue properly and generically, and create a better
framework to address these issues."

This document is the contract for two pieces built against it:

1. **The hosting core**: how Margin keeps a hosted app in the state it wants, for any app, with no app names in
   the code.
2. **The behaviour test framework**: how every way a real app has misbehaved becomes a reproducible behaviour
   of a test app, checked off screen and on the real screen.

## Why the current engine keeps breaking

`HostEngine` hosts an app as a fixed sequence: launch, find a window, full screen, reserve, move into Margin's
Space, destroy its own Space, show. Each step assumes the app behaves as the last app we tested did. Real apps
don't, and every surprise has needed its own patch:

| Seen | What the app did | What the sequence assumed |
|---|---|---|
| Safari, 2026-11-17 15:19 | restored two windows into full-screen Spaces of their own and one on the Desktop | a Safari Margin started has only the windows Margin asks for |
| Safari, 14:05 | a window opened to wake a profile stayed in Margin's Space | every window Margin opens is closed by the step that opened it |
| Maps, 07:52 | restored its window already in full screen, in a Space the Dock made before Margin looked | a new window is a normal window |
| Maps, 14:05 / 15:19 | tried to terminate while parked; later ran with a Dock icon and no window at all | an app runs with a window, or quits |
| Phone, 14:05 / 15:21 | its only window (a dialog) stayed off screen while in Margin's current Space | a window in the current Space is on screen |
| Messages, 15:20 | its shown window left every Space every few seconds; a second window at the same frame | a shown window stays where it was put |
| Mail, 14:06 | refused AX (-25200) while launching; left a 1512×88 toolbar strip after a backed-out full screen | AX answers at once; a full-screen exit leaves nothing behind |
| WhatsApp, Mail, 15:19 | restored in full screen (handled since 9c2e840c) | — |

Each row was fixed where it hurt, and the next app found the next gap.

## Principles

1. **Observe, don't assume.** Margin keeps a live model of every window of every app it hosts, from the window
   server (numbers, owners, layers, bounds, on-screen, alpha, Spaces) and Accessibility (role, subrole,
   full-screen, main, focused, minimised) plus Accessibility's notifications (window created, destroyed, moved,
   resized, miniaturized, focused, full-screen changed). Nothing is believed because a call returned.
2. **Classify generically.** Each window gets a kind from rules on role, subrole, size, position, layer and
   history (never a bundle id): `main`, `auxiliary` (settings, inspectors, small panels), `dialog` (alerts,
   sheets), `strip` (a full-screen toolbar or title band: full width, short), `leftover` (restored from an
   earlier session, or one Margin opened only to wake something), `transient` (menus, tooltips, popovers:
   above layer 0 or tiny). The rules live in one pure function with its own tests.
3. **One desired state per app,** written down as data:
   - shown: exactly one `main` window, at the page area (full screen as a member of Margin's Space, or a
     window placed in the page area), on screen, under Margin's panel; `dialog`s of that app on top of it;
     small `auxiliary` windows allowed in front of Margin only if they don't cover the sidebar; no `strip`
     visible; no `leftover` anywhere (closed, or parked until closed).
   - parked: the `main` window in a private Space, nothing of the app on any user Space, the app running.
   - given back (Margin quits or the row closes): apps Margin started quit; apps the person opened left
     running with a normal window where it was.
4. **Reconcile, don't sequence.** A single reconciler compares the observed model with the desired state
   whenever an observation changes (and at a slow heartbeat), and applies the smallest correction from a fixed
   menu, each one idempotent, bounded (tries and time per app per show), logged once with what was observed:

   | Observed vs desired | Correction |
   |---|---|
   | no `main` window, app running | ask the app to reopen (as a Dock-icon click: `kAEReopenApplication` / LaunchServices open), then wait for one |
   | app not running | launch it (no Dock icon) |
   | `main` in its own full-screen Space | place it from there (reserve, move, destroy) |
   | `main` full screen with no Space of its own | take it out, then ask again |
   | `main` not full screen and the app can go full screen | ask, from a Space where macOS takes it |
   | `main` can't go full screen | window mode: frame it into the page area |
   | `main` in no Space / another Space while shown | put it back in Margin's Space (after macOS's transition is over) |
   | `main` in Margin's current Space but off screen | bring the app forward (activate, raise), then look again |
   | `main` replaced (a new `main`-kind window appeared, the old one went or is ordered out) | adopt the new one; never fight the app |
   | `leftover` anywhere | close it (its app's own close; a Safari window through its copy), parked until closed |
   | `strip` visible | take its window fully out of full screen / wait for it to go; never let it in front |
   | AX busy (-25200, refusals) during launch | retry with backoff up to a bound |
   | correction budget used up | the fallback below |

5. **Fallback is predictable.** If an app can't reach the desired state within its budget (a few seconds), it
   is shown in window mode if it can be framed, else the page card says so in Margin's words and keeps the item.
   It never flickers, jumps between Spaces, covers the sidebar or vanishes.
6. **One way in.** `host(app)` first normalises whatever the app is doing (not running, running with windows,
   running with none, restored its own state, hidden, full screen elsewhere) through the same reconciler. There
   is no separate path for "an app the person opened" beyond what the desired state says about giving back.
7. **No app names.** No bundle id appears in the core's rules. An app-specific need is a new behaviour class
   (below) with a generic rule.

## Shape in the code

- `HostModel` (new): the observed model, per app: its windows with their attributes and kinds, its process
  state, its Spaces. Fed by `HostObserver` (window-server reads at the poll + AX notifications per hosted pid,
  coalesced). Pure value types; testable without a screen.
- `WindowKinds.classify(_:)` (new, pure): the classification rules.
- `HostDesired` (new): what each hosted app should be now (shown in which Margin window and page area, parked,
  given back).
- `HostReconciler` (new): `step(model, desired) -> [Correction]`, pure; the engine applies the corrections
  through the existing `HostSystem` calls, one at a time, serialised, with budgets and logging.
- `HostEngine` keeps its public API (`open`, `show`, `close`, `pageRectChanged`, `parkShown`, `quitAll`, the
  events) so `HostedSession`, the shell and the UI don't change; its internals become: update desired →
  reconcile until settled or budget spent → emit events. The existing primitives (early path, freeze, edge
  reservation, bridged moves, private Spaces, AX framing) stay as the corrections' building blocks.
- Logging: one line per correction (`host: <app>: <observed> → <correction> (<budget left>)`) and one per
  settle/fallback, so a real session's log reads as a story.

## Behaviour classes and the test framework

Every behaviour a real app has shown becomes a **behaviour class** with:

1. a switch in the **behaviour test app** (`tools/screen-tests/apps/Chameleon`, built from source in the repo;
   two or more copies with their own bundle ids so they can run side by side): one per class, set through the
   app's own defaults before it launches;
2. a model of it in the **stand-in world** used by `tools/app-tests` (so the reconciler is tested off screen
   against the same behaviour);
3. a **scenario** in the real-screen suite.

Classes from the table above, to start:

| Class | Chameleon switch | Seen in |
|---|---|---|
| restores windows (normal / full screen / both, n of them) | `restore` | Safari, Maps, WhatsApp, Mail |
| outlives its window (runs with none after its window closes) | `windowless` | Maps |
| attempts automatic termination when hidden | `autoTerminate` | Maps |
| main window is a dialog-role window | `dialogMain` | Phone |
| orders its window out / never orders it in until activated | `ordersOut` | Phone |
| replaces its main window periodically / keeps a twin | `replacesWindow` | Messages |
| AX busy for N s after launch | `axBusy` | Mail |
| leaves a toolbar strip after full screen | `strip` | Mail |
| extra auxiliary window (settings) / over the sidebar | `auxiliary` | Mail |
| can't go full screen / fixed size | `noFullScreen`, `fixedSize` | Calculator, Phone |
| opens extra windows on demand (like a profile wake) | `extraWindow` | Safari |

The **real-screen suite** moves from `/tmp/margin-toolbar-test/hosted/check10.swift` into the repo as
`tools/screen-tests/` (`npm run test:screen`):

- scenarios as data: a list of steps (launch Margin from a given Space, host a Chameleon with given switches,
  switch, resize, swipe, quit, relaunch) and assertions read from the window server, Margin's dev hook and the
  test app's own log;
- the safety rules of check10, kept: an idle gate, own test apps only, a watchdog with a full restore on any
  exit or signal, the starting Space put back, no modifier keys left held;
- required before every install; never in CI (it needs a real screen); a later stage runs it inside a macOS VM
  so it doesn't need the person away.

Rule from now on: **a real-screen bug isn't fixed until its behaviour class exists in Chameleon, the stand-in
world and the suite, and the suite fails without the fix.**

## A smoke run on the person's own apps

Some behaviours will only ever show with real apps. With Tirth's OK (not given yet), a separate, opt-in run
hosts a fixed list of his apps while he's away, after recording each app's saved window state
(`defaults read <id>`) and puts it back after. Until he says yes, only Chameleon is used.

## Stages (each ends green: gate + the real-screen suite)

1. **Framework first:** Chameleon with the classes above, the stand-in world's models of them, the suite in
   the repo with check10's scenarios ported. The suite run against today's engine should fail on exactly the
   known-broken classes (that's the baseline).
2. **Observer + classifier**, logging only, no behaviour change: real sessions start telling us each window's
   kind.
3. **Reconciler** for shown/parked/given back, replacing the sequence inside `HostEngine` behind the same API;
   the suite's known-broken classes turn green.
4. Delete the special cases the reconciler made redundant (woken-window parking, the restored-window sweep,
   the various "found out of Margin's Space" paths), one at a time, the suite green after each.

## Stage 3 as built (2026-11-17), and where it differs from the above

`HostReconciler.swift` (pure, `tests/host-reconciler-tests.swift`: a table row per baseline case) and HostEngine applying
it (`tests/host-behaviour-tests.swift`: every behaviour class hosted end to end in the stand-in world, the desired state
read as the suite reads it). DECISIONS.md, "The hosting core, stage 3", has the why of each point.

- **Desired:** `shown(placement)` (the one shown), `parked` (every other host), `givenBack` (Margin's quit, a row's
  close): the last isn't reconciled, it's `HostEngine.closeNow`'s own sequence of give-back steps, as before.
- **Not one loop for everything.** A first open and a show still run the engine's steps (`openNew`, `bringIn`), but their
  decisions are the reconciler's: `launch`, `reopen` and `unhide` while there's no window (an app the person opened
  running with none is reopened, never refused), `bringForward` when its window isn't listed until its app is, then the
  placement from where the window is (`HostReconciler.firstPlacement`: `placeFromOwnSpace`, `outThenAsk`,
  `askFullScreen`, `frameWindow`), done by the primitives (early path under the freeze, edge reservation, bridged moves).
  The poll reconciles every host in steady state and applies one correction at a time in the engine's queue.
- **The menu as built** (budget per show, or per 30 s for what's not tied to a show): `launch` 1, `reopen` 2, `unhide` 2,
  `adopt` 20, `putBack` 3, `parkAgain` 3, a leftover's `closeLeftover`/`parkLeftover` 2, `parkStrip` 3, `frameWindow`
  2 a show (a window-mode window not where it was framed), `bringForward` one try a rung (`activate`, `reopen`), then
  `fallback`; `closeItem` once its window has been gone `goneGrace` (1 s) with no other main window; `placeAgain` 1 per
  30 s. One log line each: `host: <app>: <observed> → <correction> (<budget left>)`.
- **Off screen in Margin's Space:** `bringForward` is for a window-mode window, and for a member once its show's late
  watch is over (its app ordered it out: ordersOut after, in Margin's Space off screen for good, 19:08); within the late
  watch the member's `backOnScreen` tries the same rungs before it places the window again; never a Space made current or a
  window moved for it (his 14:05 session: each was a jump), so no "re-add" rung. A full-screen member off screen in
  place within the late watch is still placed again (`backOnScreen`) if the rungs don't bring it. Fallback: parked, nothing shown, the item kept, the show said failed.
  *Why it was off screen* (the run of 17:32, macOS's own log): every app Margin starts is started hidden
  (LaunchServices' hide option, `hideAfter=1`); its window, ordered in while it was hidden, comes on screen only once its
  app is the front app (the Phone's came on screen the moment its own reopen made it the front process). A full-screen
  app gets there by its full-screen entry; a window-mode one never did, because `NSRunningApplication.activate(from:)`
  is refused while Margin isn't the active app (macOS 14's cooperative activation), and since Margin's UI is a panel it
  never is. On 11-15, when window mode worked, Margin was active. Now every "its app in front" (`front`: each show,
  each switch, the `activate` rung, a press around the window) sets Accessibility's `AXFrontmost` on the app first (the
  app activates itself, as at a Dock-icon click), then raises the window; the rung's line says whether the app is the
  front app after.
- **Its app in front after the switch:** a show or a switch is said (and emitted) once its window is in place and the
  one before is out; its app's activation and raise come after and aren't counted (Messages' 79 ms of 142 was its
  app's late answer to the raise).
- **Out of Margin's Space while shown** (`putBack`) is still the poll's `strayed`/`bringBack` (not moved into the
  reconciler yet: timing-sensitive, the last day's fixes; listed for later).
- **Leftovers** are also the windows there as the first show of an app Margin started ended (`launchWindows`, the
  kinds' rule 8b: Chameleon's restored windows had higher numbers than the one Margin chose). Closed by their own close
  button only when surely harmless: made before the hosted window, its app discards windows at quit, Accessibility reads
  it in Margin's Space; any other is parked (one private Space per app, its emptied full-screen Space destroyed) and
  moved to its Desktop before its app is asked to quit. No `spare` kind was needed (transient stays nothing to do).
- **Strips** are parked, not taken out of full screen. A hosted full-screen window's own toolbar window is the app's
  and is never parked, moved or reordered: a strip of its app's in exactly the same user Spaces as the hosted window,
  at its width and at its top edge (inside it: Chameleon's 1154×52; or resting just above it: Safari's with its
  toolbar hidden, its bottom at the page's top), and once seen so, wherever it is while it's where its window is (the
  window server moves the two together: parking Safari's 74772 took its window 74770 out of Margin's Space each time,
  19:17). Only strips of its other windows (another Space, not at its frame: Mail's 1512×88) are parked.
- **Replaced:** adopted as a window-mode window (fast, no full-screen change), its full screen tried again at its next
  show from parked. A replacement is a window at the hosted one's frame (in it in no Space, or Accessibility's main
  window), or, off its frame, a newer window on screen that's Accessibility's main window while the hosted one is off
  screen in Margin's Space (closed by its app; the window server lists a closed window a while).
- **A closed window** is known by Accessibility's destroyed notification (the observer follows every window it reads),
  not only by its bounds: an NSWindow its app keeps after its close stays listed by the window server at its last
  frame, in no Space or off screen (Chameleon's windowless close, 19:04, was taken for a stray, brought back, placed
  again, refused, and reopened). Destroyed and in no Space or off screen: gone at once (the model's kind `transient`),
  never brought back; listed again by Accessibility (created, read): not closed.
- **Its window closed while shown** (the person's ⌘W or close button, or its app's own close): another main window of
  its app's within `goneGrace` (1 s) is adopted, else its item closes (`closeItem`: the row's page goes, its app left
  running), as before stage 3. Never a window reopened for it (Tirth, 2026-11-17). `reopen` (a Dock-icon click,
  `kAEReopenApplication` straight to its process, never through LaunchServices, which would give it a Dock icon) stays
  only for an item shown whose app runs with no window (Maps windowless at its show; a window gone while parked, at
  its next show, behind the loader). Its answer is logged: delivered and answered, not answered in time, refused
  (-1743), not delivered.
- **A member off the page area** (its app re-laid it out: restore-code's second window going full screen made the first
  the display's size) for two reads after the show's late watch: placed again (`placeAgain`, out of full screen and
  asked again), once per 30 s.
- **A leftover parked that its app takes back out** into a user Space (a full-screen ask of its own landing after the
  park) is parked again; a strip counts as a member's own toolbar only in the member's own Space.
- **In front of Margin's window:** never a leftover, a strip or a transient (the model's kinds), nor anything over the
  sidebar by more than 8 pt (was: a quarter of it).
- **Window mode parked keeps the page area's frame**; it's given back only with the window (close, quit, a crash's
  recovery from the marker): a switch to or from it is a move each way, no frame set, no freeze.
- **Stage 4 so far:** the parked-in-a-user-Space path (now `parkAgain`) and the window-mode branch of the poll's
  "not on screen" look (now `bringForward`). Left for later: `putBack` (above), the woken-window parking (Safari's woken
  window may belong to an app Margin doesn't follow yet), the restored-window sweep (still the close half for Safari's
  restored windows: its copy closes them).

**The suite after the run of 18:57** (DECISIONS.md, "the real-screen run of 18:57"): Space numbers change with every
part (Margin's Space is a new one each launch), so "in [9202]" was Margin's own Space, not another; the leftovers line
now says "(Margin's)". Window mode of a resizable window that can't go full screen is *inside* the page area, not at
it: AppKit keeps such a window to the screen's visible frame (the menu bar's and the Dock's bands out: 1154×869 for a
1154×933 page area) and Margin centres it, as the real window-mode apps are checked. The restore scenarios prime with
a plain launch whose Restorer restores nothing (with `-ApplePersistenceIgnoreState YES` AppKit saved only the windows
that went full screen); AppKit does restore for a copy Margin launches with no Dock icon (the baseline restored both
normal windows). A hold that starts while a correction of Margin's is under way (the page card loading) may end shown.

**After the run of 20:20** (DECISIONS.md, "the real-screen run of 20:20"):

- **A Safari profile's link is waited for on evidence, not times** (Tirth: "time only paces retries and drives feedback;
  evidence decides"). `HostedSession.safariLinked`: the link is taken the moment it comes; Safari's own copies have their
  turn first (a copy of a window it restored links by itself); Safari's menu is pressed for the item's profile once one
  copy has linked and it isn't that profile's (or after `firstCopiesPace` with none), and pressed again only while no
  window came of a press (the engine's `wokenWindows`, which also parks a woken window out of sight at once: the poll is
  held off during an open, and the woken window sat in Margin's Space for the 15 s the link took). Given up only on
  evidence: what it was for isn't wanted any more (`linkWanted`: the show waiting on it overtaken by another pick; the
  launch's preparation by any request), Safari quit, or `wakePresses` presses opened nothing. A stale copy's window ask
  is asked again once the profile's link is replaced, however long that takes, while wanted. The wait is said every
  `linkSayEvery`. The profile woken on 2026-11-17 was the item's own (`safari:p646` is Personal's copy): Margin never woke
  one it didn't need.
- **Two Margin builds' extensions in one Safari** (the person's installed Margin beside the build under test): Safari runs
  one build's extension handler at a time and refuses the other's native messages meanwhile (`Other version in use`,
  PlugInKit code 16), and the two builds' copies in a profile share its storage, so one of them is "not in charge". The
  extension now asks again every second while refused (`BUSY_ASK_MS`, 20 times, then as any other time), and a copy no
  longer in charge stops its link (it reconnected every ~470 ms, each hello closed by the app). The suite says when
  another build is registered (`pluginkit -mDAvvv`) and counts Safari's refusals in the step: the definitive Safari
  check is a run against the installed build.
- **The suite's verdicts** (`tools/screen-tests/suite/Verdicts.swift`, checked by `--self-check` against the run's lines):
  a Chameleon window its app closed (its own log's `closed N`) isn't a leftover (the window server lists it off screen in
  Margin's Space for good: replacesWindow-every's "leftover" was each window its app replaced, Margin having adopted the
  new one in ~180 ms); a single desired-state read taken while Margin's page card is loading (a correction under way,
  under its freeze) waits for it (restore-code's "over the sidebar" was AppKit's full-screen transition window, in the
  member's new full-screen Space, during Margin's placing again under the freeze; never on the glass); Safari's host
  waits for Margin's own verdict (90 s bound) and reports its parts (first copy, the profile's link and presses, its
  window, shown); a show of Safari whose first open failed is reported as a first open.

Not in scope here: the sidebar click's brief key flicker. (Live resize and the privileged route: the next section.)

## Live resize: tiles in Margin's Space (design, 2026-11-17)

Asked by Tirth on 2026-11-17, after the kit's second round (`/tmp/margin-toolbar-test/live-resize/opt4/FINDINGS.md`):
the shown app follows a drag of the sidebar's edge live, every frame, "properly without causing any issues or errors
and without reducing efficiency or performance", on the privileged route (the window manager's bridged operations,
which Margin already uses for every move and destroy). Until now a hosted full-screen window was a plain member of
Margin's Space with its own Space destroyed: nothing could resize it, so a drag re-fitted it once at its end (out of
full screen and in, about 0.9 s, behind the loader) and a parked one was re-fitted only when next shown.

**The one rule:** a hosted window's size is its tile's rect, and that rect is the hosting core's desired page area.
Every page area change (a drag's end, a theme, the display, anything) goes the same way: Margin's page area is the
desired state, the reconciler converges every host's tile to it, the one shown first. A drag is the only thing that
moves faster than the reconciler: the one shown follows it frame by frame, and the drag's end is an ordinary change.

### What the kit proved (own test panes, Stage Manager on, macOS 27.2.1)

- A full-screen window lives in a **tile** of its full-screen Space. Bridged `SpaceSetValues(M, {"Max Tile Config":
  {Width: N, Height: 1}})` raises Margin's Space's tile limit (2 by default; a move past it isn't taken); bridged
  `SpaceTileMoveToSpaceAtIndex(tile, M, index)` moves a window's own tile (with its window, still full screen) into
  Margin's Space; its emptied own Space is destroyed as before: Mission Control lists Margin's Space only.
- Bridged `SpaceSetValues(tile, {"TileRect": {X, Y, Width, Height}})` sizes the window: it follows in 10-26 ms, shown
  or parked in a private Space. Tiles may overlap (every hosted tile at the page area). The rect is in the display's
  points from its top left, the menu bar's band included (a full-screen window sits that band below its tile's top):
  Margin's own tile is the display's whole, a hosted one is Margin's less the page's distances from the full-screen
  area's edges (`HostLayout.tile`: 248,41 1256×933 in 0,33 1512×949 → tile 248,8 1256×966).
- A 120 Hz drag (240 steps): median 3.8-6.1 ms from the write to the window at its new size, p95 7.3-8.4 ms; CPU as
  the reservation route's. With `SetValues(M, {LiveResizing: true})` before and `{LiveResizing: false}` after (never
  the key removed: that never ends it) the app gets one live-resize start and end, not one per frame: its CPU 899 →
  707 ms over the drag.
- A switch to a parked one: 24-36 ms, its first frame already at its tile's size.
- **The quirk:** any tile added to or taken out of Margin's Space, or any reservation on it, lays the first two
  entries of its layout out again as a split's halves (Margin's own tile and the first hosted one), whatever their
  rects were.
- Direct (unbridged) `SLSSpaceSetValues` is ignored for another process's tiles.
- A hosted app killed leaves a placeholder tile (its id kept, a window number of its own); bridged destroy takes it.
  Margin killed leaves its Space with no owner and the hosted tiles: the first two fall into a visible split; a new
  Margin Space can raise its limit, take the tiles (their ids kept, 360 ms for three) and set their rects; the old one
  is then empty and destroyed.

### The design, step by step (HostEngine.swift "live resize: tiles in Margin's Space")

- **Check, once per Margin Space** (`tilesReady`, at the first open or preparing there): the tiles part of the private
  calls passed its launch check (HostCalls.swift: `SLSSpaceCopyTileSpaces`, `SLSSpaceCopyValues`, both bridged classes
  and their four selectors at their recorded encodings); Margin's own tile found (the tile whose window is Margin's);
  its rect the display's while it's alone; Margin's Space's tile limit raised to what the next tile needs and read
  back. Any of it fails: the fallback (below) for the run, said once.
- **Host** (a first open): as before up to its own full-screen Space at the page area (the early path's reservation of
  its own Space still sizes it there; never one on Margin's). Then, instead of the window alone as a member: the limit
  raised to the tiles there plus one, its tile moved to the end of Margin's layout, landed (Margin's Space lists it and
  the window server has the window in Margin's Space), every rect set again (`reapplyTiles`: Margin's own the display's,
  this one's the page area's, then the others'), its window seen at the page area and Margin's window at its whole
  width; its own Space destroyed as before (never in the same breath as the move), settled. All of it under the freeze
  (the early path's, or one of its own on the slow path): Margin's own window is a split's half for that moment.
  Margin's window never takes a page area from that moment (`hostedPlacement` is nil while it's narrower than its
  screen).
- **Show and park:** as before (the bridged member moves: into Margin's Space, into a private Space); the tile stays in
  Margin's Space either way, so a parked window keeps following its tile's rect.
- **Drag:** the session asks the engine (`dragging(true)`): if the one shown is a tile (or a window-mode window), it
  follows; Margin's Space is told (`LiveResizing` true). Each page layout of the drag (the page's own, once a frame) goes
  to the engine (`follow`): at most one write a display frame, one in flight (the newest page area kept, older ones
  dropped), each waited for until the window is there (at most 50 ms); the hole in Margin's window is the page area
  meanwhile (`followsPage`). Nothing else is sized during a drag, and Margin's desired page area doesn't change. Over:
  `LiveResizing` false, then the drag's last page area is an ordinary change.
- **Background:** a change of the page area (`pageRectChanged`) sets the one shown's rect and waits for it (no loader,
  no full-screen change), then the reconciler's `sizeTile` for every other tile not at the page area, one at a time,
  each its own turn in the engine's queue (about 25 ms each), asked at once after the previous one rather than at the
  next poll. A show asked meanwhile goes between them and sizes its own tile first, out of sight: a switch never shows
  the old size. A tile found off the page area twice at rest (a tile change laid it out again) is sized the same way.
  Budget: 3 per 30 s; the one shown then is placed again the old way (`placeAgain`), a parked one at its next show.
- **Tile changes:** after every one (a host in, a host given back, an app gone, a window closed), every rect set again.
  Margin's own changes do it under the freeze. Changes nobody asked for (an app quit or crashed, its window closed by
  the person) are found at the next poll (`lookAtTiles`: another count of tiles, a host's tile left behind, Margin's own
  rect not the display's): every rect set again then (a placeholder destroyed first, under the freeze). Margin's window
  is a split's half until that poll (at most 0.25 s): **seen** (nothing can freeze ahead of a change Margin didn't make).
- **App quit or crash, a window closed or replaced:** its host goes (or adopts the new window) as before; its tile stays
  behind with a placeholder window of its own (a killed app's; and, on the real Mac 2026-11-18, a window its app closed:
  a window of its app's at the tile's rect, on screen in Margin's Space), never taken for a replacement, destroyed at
  once, then every rect set again. A window out of full screen leaves its tile empty until its app quits: Margin's quit
  destroys those before its window goes.
- **Margin quit:** each host given back as before (out of full screen on the current Space: its tile leaves Margin's
  Space with it), under the freeze; no rects set again while quitting (Margin's window goes).
- **Margin crash and recovery:** the marker (hosted.json) records Margin's Space, Margin's own tile, each host's tile
  and the tiles of hosts that went but weren't destroyed yet. At the next launch the recovery gives everything back as
  it always has (each window out of full screen on the current Space: a window in Margin's old Space is taken out of
  full screen there, or brought to the current Space first; window-mode frames given back; apps Margin started quit),
  then destroys the recorded tiles still in Margin's old Space, Margin's own dead one too (never one a window of the
  marker's is still in), and the old Space with them once nothing is left in it. The new Margin doesn't take the tiles over: what was hosted is
  hosted again by its next show, as after any crash.
- **Margin's window in another Space** (it left full screen and came back): its hosts' tiles moved into the new Space
  (the kit's recovery move, ids kept), every rect set again, the old Space destroyed once empty (`adoptTiles`).
- **Mission Control and swipes:** only Margin's Space is listed (the hosts' own Spaces destroyed as before); a swipe
  or ⌃← lands on Margin's Space as one Space with its tiles in it.

### The fallback

No tiles part (a symbol or class missing, an encoding changed), the launch-time check failing (Margin's own tile not
found or not the display's, its tile limit not taking), or a tile step that doesn't take during a host (its tile not
moved: the window goes in alone, as a member; its rect not taken: backed out and asked again, as a member): the tiles
are off for the run, said once, and everything is today's re-fit-on-release path, unchanged (a drag held until it's
over, one placing out of full screen and in behind the loader; parked members re-fitted at their next show). Hosts
already in tiles keep working as tiles.

**Window mode** stays as it is (its frame set by Accessibility in the page area, kept while parked), and follows a
drag by Accessibility: one `setFrame` in flight at a time, the newest page area kept. Cheap for Margin (one
Accessibility call a frame on its own queue); the app does what a person's drag of its window's edge would make it do.
Parked window-mode windows are re-placed when shown, as before (Accessibility can't reach them in a private Space).

### A window's minimum size (2026-11-18)

**The bug (Tirth's real use, 09:08):** a fast drag of the sidebar's edge with Weather shown sent Weather's window out of
Margin's Space into a full-screen Space of its own, three times; each time Margin brought it back by leaving and
entering full screen again (2-3 s, the loader).

**The cause, measured on the real screen (the suite's `min-drag` steps, every window's bounds and Spaces read every
millisecond, the build before the fix):** a hosted tile was sent a rect narrower than its window's own minimum.
- The minimum is readable before it's hit, from the same tile values Margin reads its rects from: `SizeConstraints`'
  `Min` (AppKit's, what Split View's divider stops at). Chameleon with `contentMinSize` 1100×500: its tile said
  1100×500 exactly; Weather's said 1048×640.
- Weather: its tile first sent 1046 wide (a slow drag, 240 frames), its window was out of Margin's Space 24 ms later, in
  a new full-screen Space of its own. Speed isn't the cause: it's the width (the real use's fast drags reached it in
  fewer frames).
- Chameleon (AppKit, no Catalyst): its window followed its tile below its minimum (to 1024), but AppKit drew a second
  window of its own at its minimum width and the tile's height (1099×966, right-aligned) in Margin's Space, on screen,
  which Margin let in front of its own window; at the next drag's start (the tile still below its minimum) it left full
  screen (Margin then placed it again, 824 ms behind the loader). 2 of 2 slow drags, and a 600-frame one.
- Fast drags above the minimum (130 pt in 8 frames, 140 pt in 3, back and forth, 6 drags): followed, nothing left.

**The rule:** Margin never sends a tile a rect smaller than its window's minimum.
- **Read:** the minimum from its tile (`HostSystem.tileMinSize`) as its tile comes into Margin's Space, as its own
  full-screen Space is listed on a first open (its reservation is made for no less), at each drag's start and at each
  sizing; never per frame. No minimum said and it leaves a tile anyway: the narrowest width it was seen holding is taken
  for its minimum.
- **Where it goes** (`HostLayout.fit`): the page area; narrower than its minimum, that minimum with its right edge and
  top the page area's: what's wider lies under Margin's sidebar (Margin's window is in front of it; a translucent theme
  shows it through).
- **The one shown:** the sidebar's edge stops where the page area would be narrower than its minimum, in the UI's own
  drag (ui/behaviors/resize.ts: the widest the sidebar gets is its width at the press plus what the page area had above
  the floor then; a reset to the default too), so the edge and the app always agree, fast or slow. Let go, the width
  snaps to the theme's step (Arcadia's 10) without crossing the floor: on the real Mac the edge stood with the window
  exactly 1100 wide (Chameleon) and 1048 (Weather), and let go at 1104 and 1048. The engine tells
  Margin's window the shown one's minimum width (`onMinimum` → `setPageMinimum` → `{ type: 'pageMin', width }` and the
  hello's `pageMinWidth`, host-app.ts `pageMinWidth`). The engine's own sizing holds the rule too (a minimum learnt
  mid-drag, the dev hook's `sidebar`, a theme or a display): one comparison a frame, nothing read.
- **Parked ones** with a minimum wider than the page area: sized at their minimum, right edge aligned, out of sight;
  shown so (their first frame at it, the overflow under the sidebar); dragged wider again, at the page area.
- **One that leaves its tile anyway** (into a full-screen Space of its own): its tile there moved back into Margin's
  Space and sized (`tileBack`: the first open's tile move, its minimum read from that tile first), that Space
  destroyed, under the freeze: still shown, no full-screen exit or entry, no loader. During a drag it isn't followed
  again until the drag is over (never twice in one drag); the drag's end places it once.

### Anchors (2026-11-18)

macOS lays the first two tiles of a Space out again, as a split's halves, whenever a tile comes into it or leaves it
(and when the layout's second comes back from a private Space). Those two were Margin's own window and the first hosted
one, so every such change made Margin's window narrower for a moment (the line, the black page) and wiped the first
hosted one's rect; setting them back asked that app to lay out again, and an app that answers a resize with a window of
its own (Weather, 2026-11-18 13:30: a 1264×966 window for 0.2 s after each resize) closed that window, which laid the
tiles out again: 54 rounds in 18 s. The loop guard (docs/ARCHITECTURE-PLAN.md) stops any such loop at its third round;
the anchors keep it from starting.

- **What they are:** two tiles made through the bridge with no window (`SLSBridgedSpaceCreateTileOperation`,
  synchronous, `initWithSpaceID:values:` with no values), moved to the front of Margin's Space within it
  (`SLSBridgedSpaceTileMoveToSpaceAtIndexOperation` to index 0 and 1). They draw nothing. Margin's own tile is third,
  the hosted ones after.
- **The kit (opt5 a1, a2):** made in 5 ms each; moved to the front within the Space; a tile added, one destroyed, a
  hosted window parked and back: only the anchors' rects changed, the stage window and the hosted ones never. No window
  appeared at their rects.
- **In the engine (HostEngine "the anchors"):** made once the tiles are checked for Margin's Space (`tilesReady`),
  under the freeze (Margin's window is laid out once as they're made), its tile limit raised for them; recreated when
  Margin's window comes into a new Space (`adoptTiles`, the old ones destroyed first or the old Space keeps tiles and
  isn't destroyed); destroyed at Margin's quit before its window goes; in the crash marker (`anchors`), destroyed by the
  next launch's recovery. Not made (the call missing, its encoding changed, nothing made): said once, the tiles as
  before (Margin's window and the first hosted one set back after each change, the loop guard over it).
- **On the real screen (18:11-18:20):** "anchors ok" at launch; made 34 ms into the first open; live-resize 31 of 31
  (the first switch to the layout's second tile, the one miss before, at the page area every frame); live-resize-crash
  10 of 10 (the killed Margin's anchors destroyed with its old Space); real-apps-loop with Weather and Maps: no
  re-layout Margin didn't make, Weather at the page area.

### Not proven (before it's called working in real use)

The kit's own panes only: real apps (Safari, Mail, a Catalyst app) in a tile; Margin's real window and its panel over
tiles; a switch's timing with Margin's panel in front; the recovery's out-of-full-screen from an ownerless Margin
Space; real Mission Control and swipes; Stage Manager off; two displays (the tile rect's origin on a second display:
taken as display-local, verified at each sizing by the window's bounds). The real-screen suite's `live-resize` part
(tools/screen-tests) checks the first five on Chameleon and, with `--real-apps`, the person's own apps.
