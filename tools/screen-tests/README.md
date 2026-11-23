# The real-screen suite

The behaviour test framework of [docs/HOSTING-CORE.md](../../docs/HOSTING-CORE.md) ("Behaviour classes and the test
framework", stage 1): Margin hosting test apps on the real window server, while nobody is at the Mac. It replaces
`/tmp/margin-toolbar-test/hosted/check10.swift` (its steps are the `core` part) and adds one scenario per behaviour class.
Never in CI: it needs the real screen.

```sh
npm run test:screen -- --dry-run              # the plan: every part, scenario and step, what it touches. Touches nothing.
npm run test:screen                           # every Chameleon part (about 30 min), each part its own process
npm run test:screen -- --part behaviours-2    # one part
npm run test:screen -- --real-apps            # adds the part with the person's own apps (opt-in)
npm run test:screen -- --margin /path/Margin.app   # default: xcode/build/Build/Products/Release/Margin.app (npm run safari's build)
npm run test:screen -- --restore              # put the Mac back after a part that was killed (from build/state.json)
npm run test:screen -- --self-check           # the verdict rules that need no screen (suite/Verdicts.swift). Touches nothing.
```

`run.sh` builds the Chameleon copies and the suite, prints the whole plan, then runs each part with a hard 10-minute
limit. Logs: `build/logs/<time>-<part>.log` (PASS/FAIL/SKIP per step with numbers, then the summary per scenario and
Margin's own log lines); the run's summary at the end. Many behaviour scenarios are **expected to fail** against
today's engine: that's the baseline stage 3 (the reconciler) turns green.

## Safety (check10's rules, all kept)

- **Idle gate:** a part starts only if the Mac has been idle for 180 s and isn't locked (refused, exit 3, nothing
  done); before each step it checks 60 s of idle (the suite's own posted events left out, also across parts through
  `build/handoff.json`); at the first sign of the person it stops and puts everything back (exit 6).
- **Own test apps only** in the Chameleon parts: clicks and plain keys go only to a Chameleon copy or Margin's own
  window, after the window list says the point is theirs. ⌃←/⌃→ only if Mission Control's keys are the default and only
  Desktops lie between; Control and Fn checked released after every press (else stop and restore, exit 11).
- **Watchdog:** no word for 5 minutes, or 9¼ minutes in all, and the part restores and exits (12); SIGTERM, SIGINT and
  SIGHUP do the same (13); `run.sh` stops a part still running at 10 minutes and, if it doesn't end, kills it and runs
  `--restore` from the state file the part wrote before touching anything.
- **Full restore**, every exit: the test items removed from Margin's library (dev hook `forget`), Margin quit, the
  copies quit and removed from `~/Applications` with their saved state and defaults, Margin's defaults
  (MarginDevHooks, MarginPrepareBrowser, MarginResumeLast, MarginFront, the theme's settings) as they were, Margin
  opened again with `--background` if it was running, the starting Space made current and read back (three tries),
  the pointer back, the modifiers checked released.
- Only window-server write: making Margin's Space or the starting Space current again.

## Chameleon (`apps/Chameleon`)

The behaviour test app (from the kit's TestPane: toolbar, text field, button, grid; a menu bar). `apps/Chameleon/build.sh
[N] [folder]` builds the binary and N copies (`Margin Chameleon N.app`, `test.margin.chameleon.N`, ad hoc signed) into
`build/apps.noindex` (a `.noindex` folder: Spotlight never lists them), never into an Applications folder, then checks each switch is read (`Chameleon --describe` with the switch
as a launch argument: no window, no window-server connection). Switches are its own defaults, read at launch
(`defaults write test.margin.chameleon.3 ChameleonAxBusy 2.5`), described in `Switches.swift`:

| Switch | What it does |
|---|---|
| `restore` | n windows (1-4) back at launch, none / all / the first in full screen; `system` (default): AppKit's state restoration after a priming run (the copy alone, quitting with NSQuitAlwaysKeepsWindows), so macOS restores full screen the way it does real apps'; `code`: made and asked into full screen at launch |
| `windowless` | runs on with no window (default: quits after its last); `close:<s>` also closes its own window |
| `autoTerminate` | `system` AppKit's automatic termination; `attempt:<s>` with no window on screen it attempts to terminate and stays (background-only meanwhile); `quit:<s>` really quits |
| `dialogMain` | its main window's subrole AXDialog |
| `ordersOut` | `untilActive`, `after:<s>`, `every:<s>` |
| `replacesWindow` | `every:<s>` closes and remakes its main window at the same frame; `twin` a second one behind it |
| `axBusy` | its main thread blocked <s> as its window first shows (Accessibility answers -25200) |
| `strip` | a full-width 88-tall window across the top while in full screen (`linger`: left after the exit), or `at:<s>,for:<s>` |
| `auxiliary` | a settings-like window (`settings`, `sidebar` over Margin's sidebar, or `WxH+X+Y`), `at`/`for`/`borderless` |
| `noFullScreen`, `fixedSize` | no full-screen button; not resizable (400×300 or `WxH`) |
| `minSize` | its main window's own minimum content size `WxH` (a full-screen tile narrower than it can't hold it: Weather's) |
| `extraWindow` | another window on File › New Window, on its `test.margin.chameleon.extraWindow` notification, or `at:<s>` |

It logs every window event it makes and gets (made, ordered in/out, closed, key/main, full screen, occlusion, Space
changes, reopen and terminate asks, key codes, clicks with their count, its grid's drags and releases, the field's
length) to `/tmp/margin-screen-tests/<id>.log`.
The stand-in world plays the same switches off screen: `app/platforms/macos/shell/tests/behaviour-world.swift`
(`tools/app-tests/run.sh unit`).

## Scenarios (`suite/Scenarios.swift`, as data)

- `core`: check10's steps L, 0, d1-d4, a1-a4, m1-m2, b1-b2, k1, c1-c2, e1-e6, f, s0-s5, w, x1-x2, R, with Chameleon 1
  and 2 as its two test panes.
- `behaviours-1…4`: each part opens Margin and hosts Chameleon 1 plain, then one scenario per behaviour class with
  Chameleon 3: set its switches (prime it for `restore`), host it, check it read them, check the design's desired
  state, any class-specific steps (park and back, its own window closed, an extra window asked), then the desired
  state held for 30 s, then its item removed. Desired state (read from the window server): exactly one main window at
  the page area (inside it for a fixed size), on screen, in Margin's Space only, under Margin's panel; no other
  window of the app in any user Space (leftovers); no strip on screen; nothing of the app over the sidebar in front
  of Margin's panel; the same state all along (no flicker, no Space jump).
- `live-resize` and `live-resize-crash` (docs/HOSTING-CORE.md "Live resize: tiles in Margin's Space"): Chameleon 1-3
  hosted; Mission Control lists Margin's Space only; drags of the sidebar's edge through Margin's dev hook `drag` (the
  page's own handle, pointer events dispatched in the page, one move a display frame: nothing posted to the system),
  the shown window's model bounds read every millisecond (it follows each step; Margin's own line says how closely),
  every parked window at the new page area within 1 s of the release; a switch after it (its first frame on screen at
  the new size, 99 ms or less); switch times, the drag's CPU (Margin, WindowServer, the copies) and resident memory
  said for comparison with another build; a parked copy killed (SIGKILL: its placeholder tile destroyed, Margin's window
  whole again); Margin's quit with tiles in its Space (everything given back); then, from a launch of its own, Margin
  killed (SIGKILL) with two copies in tiles and opened again (its recovery gives them back, its old Space destroyed).
- `live-resize-min` (docs/HOSTING-CORE.md "A window's minimum size"): Chameleon 1 plain, Chameleon 3 with `minSize`
  1100×500; its tile says that minimum (`SizeConstraints`); slow (240 frames), fast (12, 4, 3 frames) drags past it and
  above it: never out of Margin's Space, never narrower than its minimum, the edge stopped at it (the page area 1100
  wide), nothing placed again or behind the loader; Chameleon 3 parked while the page area goes narrower than it (sized
  at its minimum, its right edge the page area's, never in a user Space), shown so for 5 s, dragged wider again.
  `real-apps-min` (opt-in, `--real-apps`): the same drags with the person's Weather (minimum 1048 wide), nothing posted.
- `pane-clicks` (Margin's `PaneClickTap.swift`: the first click in another pane goes through): Chameleon 1 and 2 hosted,
  made a split through the dev hook (`say: layout` for each one's item, then `ui split.add`); clicks posted only where
  the window list says Margin's panel then that copy are under the point, each in the pane WITHOUT the keys: its grid
  (an NSView that refuses the first mouse, as WebKit does: before the tap such a click only made its window key), its
  button, its field then a plain key (only with the copy the front app and no field of Margin's focused), a
  double-click (counts 1 and 2), a drag from it (press, drags, release in order); each needs Margin's `host:
  app:test.margin.chameleon.N: a click in its pane … the click delivered` line, the copy's window key and Margin's focus
  on it. Then 8 timed clicks back and forth (Margin's key time under the 120 ms cap; the press's post to the copy's
  click), a click in the pane with the keys (straight through, nothing said), Margin's idle cost with the tap on, and
  Margin's quit.
- `panes-active` and `panes-active-crash` (Margin's `PanesActive.swift`: every pane of a split draws active): Chameleon
  1 and 2 made a split as pane-clicks does; each copy's own word asked by its notification (`test.margin.chameleon.state`:
  Chameleon logs `state active … key … main … editing …`, AppKit's own state): both active, each its pane's window key,
  the focused one the front app; a grid click and a field click (its key typed reaches only it) with both active after
  each; 6 clicks back and forth, the inactive moment of the one that had the keys timed from its own log; Margin's idle
  cost with both active; the split hidden (Chameleon 3 shown alone): the kept one let go after the 1 s grace; Margin's
  quit: its `let go (Margin quits` line, the kept copy's resign logged before it's quit. The crash part, from a launch of
  its own: Margin killed (SIGKILL) with the split up, the kept copy still active, Margin opened again: `a crashed Margin
  kept 1 app active: 1 let go`, the copy's resign logged before its quit. Clicks and keys only where pane-clicks posts
  them. Written 2026-11-21 and dry-run only so far.
- `cut-panes` (docs/PEEK-SPLIT.md §4b: a pane narrower than its window, `suite/CutPanes.swift`): Chameleon 1 (its
  `minSize` 800×300) added beside Chameleon 2 as pane-clicks does, at the page area's end: its window 800 wide from its
  pane's start, the rest past the display's edge, read every 0.5 s for 6 s (never moved, never out of its tile, nothing
  of it over Chameleon 2's pane, Margin's `cut panes` saying only its right arrow); the pointer into its pane, its right
  arrow pressed on Margin's own window (only where the window list says Margin's then the copy's): slid (Margin's line,
  its window at its end alignment, behind Chameleon 2's window, its left arrow now, the press never the copy's); a first
  click into it under Chameleon 2's pane (pane-clicks' step) and its window still behind; its left arrow: back past the
  edge, held 4 s; Margin's idle cost with it up. 14 passed on the real screen, 2026-11-22 (slides 152-159 ms, 0.36% CPU
  idle, 0 wakeups/s).
- `real-apps` (opt-in, `--real-apps`): Maps, Phone, Messages, Mail, WhatsApp, Safari, Notes, Calculator (the list at the
  top of `suite/RealApps.swift`; skipped if not installed). Recorded first (running, pid, windows, saved-state defaults
  keys, Margin's library items); each hosted through the dev hook only and its desired state held 30 s; a switch to
  each (99 ms or less); Margin quit: those it started quit, those that were running still running with a normal window
  and a Dock icon. **No click or key is posted in this part.** After: changed saved-state keys written back and read
  again (any left different is reported), apps that weren't running quit politely, items removed only for apps that
  had none in Margin's library before (else reported for removal by hand).
