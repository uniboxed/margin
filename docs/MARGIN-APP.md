# Margin as the app (plan, 2026-11-15)

Asked by Tirth on 2026-11-15: Margin stops being a layer drawn over Safari's
windows and becomes the app people open. It owns their spaces. Its page area
shows Safari, with no Safari toolbar, no Safari Dock icon and nothing of
Safari in Mission Control, and any other app the same way, found from the
palette like a web search.

This is a new architecture, not an option on the current one. Most of the
pieces were proven one by one in the test kit (2026-11-13 to 11-15,
`/tmp/margin-toolbar-test/`); what is proven, what is not, and what is still
unknown is listed below so nothing is claimed twice.

## What it is

```
Margin.app (a regular app: its Dock icon, its menu bar, Mission Control shows "Margin")
 ├─ Margin's window: windowed or full screen
 │    ├─ the UI (today's sidebar, palette, settings, themes: app/shared/ui, unchanged code)
 │    └─ the page area: a hole the hosted window is fitted to
 ├─ Spaces, owned by the app (its data set on disk; nothing read from Safari's storage)
 │    └─ items: a web tab (in Safari, a profile) | an app (bundle id) | pins, folders as today
 └─ Hosts: apps Margin starts itself, with no Dock icon
      ├─ Safari: one window per Safari profile in use, full screen, sized to the page area;
      │          driven by Margin's extension (which tab, open, close, back, reload)
      └─ any app: its first window, full screen, sized to the page area
```

- **Opening Margin** opens Margin's window. The first time, it asks for
  spaces (names, emoji, colour; Safari profile per space if there are several).
- **⌘T** opens the palette in Margin's window. Typed text or a URL opens a
  tab in the current space: Safari (started by Margin if needed) shows it in
  the page area. The palette also lists installed apps; picking one starts it
  the same way and adds it to the space as an item.
- **Switching** items: a web tab in the same Safari window is a tab switch
  (Safari's own, instant); another Safari profile or an app is a switch of the
  full-screen Space under Margin's frame (the kit's direct switch, 5–20 ms).
- **The page box goes.** A hosted window is sized by macOS itself (the edge
  reservation), so nothing is added to pages.

## What is proven, and where

| Piece | Status | Evidence |
|---|---|---|
| App started with no Dock icon (`_LSOpenURLsWithCompletionHandler` + UIElement option) | proven, 15 apps | kit `multi-app-test-kit` |
| **Safari (Technology Preview) with no Dock icon goes full screen** (AX `AXFullScreen`), no toolbar band with the launch arguments above | **proven 2026-11-15** | `safari-host/probe*.log`: accessory policy, full screen in 1.6 s |
| Its window sized to any rect by the edge reservation | proven (STP no-Dock: 248,41 1256×933 in < 1 s) | same |
| Margin's frame in each hosted app's Space, direct switch 5–20 ms | proven in the kit | kit margin5 |
| Margin's own menu bar on top-edge hover; app's buttons never shown | proven in the kit (TestPane), hand-tested | `no-dock-margin-menubar` |
| **Real Safari started with no Dock icon (hosted launch arguments): Margin's extension links** (both profiles, 12 s), its windows restored, still no Dock icon; quit and reopened normally after | **proven 2026-11-15** (Tirth away, his OK) | `safari-host/real1.log` |
| **Margin as the app, on screen (2026-11-15):** an app (the kit's TestPane) and a Safari web item (Safari not running: started by Margin with no Dock icon) hosted beside Margin's sidebar tile, exactly in the page area, Safari's toolbar out of sight, Mission Control one Space for Margin; quit gives everything back | **proven** (Tirth away) | `/tmp/margin-toolbar-test/hosted/check1.swift`, `check3.swift` |
| Several apps side by side in one full-screen Space | proven by numbers (3 apps) | `floating-pane-windowed` |
| Windowed Margin (hosted full-screen window as a desktop member) | proven for real apps, Stage Manager needs work | same |

## Not solved yet (must be before it ships)

1. **Safari's toolbar band: solved 2026-11-15** (Safari Technology Preview,
   no Dock icon, `safari-host/probe6`): with the launch arguments
   `-NSMenuEnableMenuBarAgent NO -AutoShowToolbarInFullScreen YES` and Safari's
   own sidebar hidden, the page fills the page area (1256×933 reported by the
   page), the toolbar window rests above it (y −11) and nothing of it shows.
   `AutoShowToolbarInFullScreen` = 1 means the toolbar hides (Tirth's Safari
   has 1; STP had 0, which is "always show" and gave the band). A Safari
   already open the normal way gets no launch arguments: its own setting
   decides. Safari's sidebar must be hidden in hosted windows (Margin
   replaces it).
2. **Mission Control.** A hosted app's full-screen Space is listed by Mission
   Control (`SLSCopyManagedDisplaySpaces`). **Found 2026-11-15 (own test
   windows, `/tmp/margin-toolbar-test/mc/mc1–4`):** move the hosted window's
   tile into Margin's own full-screen Space
   (`SLSSpaceTileMoveToSpaceAtIndex`, index 1), then destroy its emptied Space
   with the window manager's bridged `SLSBridgedSpaceDestroyOperation
   initWithSpaceID:` → Mission Control lists ONE Space (Margin's, 2 tiles);
   the hosted window stays full screen in it; cleanup leaves no orphan Space.
   Margin's own window with a content max width of 260 gets a 260-wide tile on
   the left and the hosted window the rest (272,0 1240×949, 12 pt spacing by
   default, settable). A tiled window parked in a private Space leaves the list
   but keeps its tile (the other tile doesn't grow), so only the app on screen
   is a tile; apps not shown leave full screen and are parked (not listed,
   proven by parking). Open: what Mission Control's label shows for Margin's
   2-tile Space (both names?), the cost of switching between apps that way
   (a full-screen entry each time, about 1 s for Safari, under the freeze),
   and a faster swap of the second tile; destroying the current Space drops
   the screen to the desktop, so switch to Margin's Space first.
   **Replaced 2026-11-15 (real apps, `mc/mc8`, `mc10`):** no tiles. The hosted
   window goes full screen in its own Space, that Space's edges are reserved
   so the window is the page area, then it's moved into Margin's Space as a
   plain member (bridged add/remove, options 7) and its own Space destroyed:
   Mission Control lists Margin's Space only, several apps can be members,
   Margin's window keeps its whole width (the theme's frame around the page
   area), and a switch is a move each way (parked in a private Space, still
   full screen), no full-screen exit. Built on `feat/hosted-apps` (DECISIONS.md
   "Hosted apps as members of Margin's Space").
3. **Safari already running** (decided by Tirth, 2026-11-15): Margin never
   restarts it. If Safari is open the normal way, Margin opens its own new
   window in it, and Safari's Dock icon stays; Mission Control must still show
   only the windows he opened, never Margin's. When Safari isn't running,
   Margin starts it with no Dock icon. So hiding Margin's hosted windows from
   Mission Control (item 2) is needed for a regular Safari too.
4. **Opening an app from outside** (Dock, Finder, a link) promotes the hosted
   instance to a normal app with a Dock icon; the detection signal is known
   (LaunchServices notifications 659/561). What Margin does then is open.
5. **AppKit apps that can't go full screen without a Dock icon** (Dictionary,
   Calculator, Music, Reminders, …): *built 2026-11-15 (`feat/hosted-apps`,
   DECISIONS.md "Almost every app in Margin")*: window mode, their normal window
   in Margin's full-screen Space, placed in the page area by Accessibility, its
   frame given back before it leaves; apps already open the normal way (Phone)
   hosted as they are and given back. On-screen checks pending.
6. **Accessibility** is needed to put a non-browser app into full screen;
   Safari can be put there by Margin's extension (`windows.update`), untested
   from a no-Dock Safari.

## Decided by Tirth (2026-11-15)

- Safari already open: a new window in it, never a restart (item 3).
- Today's spaces, pins, folders and saved tabs are imported on first run.
- Build now; Mission Control hiding is researched in parallel and must be
  solved before this ships.
- The real-Safari test (quit his Safari, start it with no Dock icon from a
  test, check the extension links) only while he's away; Safari reopened
  normally after.

## Phases (each ends green, on a branch, nothing merged without the gate)

0. **Research runs** (kit, off main): items 1, 2, 5 above, and the extension
   link from a no-Dock Safari (real Safari, with Tirth's OK, since it means
   quitting his Safari).
1. **Spaces owned by the app.** The edit rules of `extension/state/model.ts`
   for spaces, pins, folders and tabs run in the app (same TypeScript, in a
   JavaScriptCore context, so there is one copy of the rules). The app's data
   set becomes the source; an item gets a target (`web`: Safari profile, or
   `app`: bundle id). First run: today's spaces imported, then the
   create-spaces step for anything new. The extension keeps only the live tab mapping.
2. **Margin's window.** A real `NSWindow` (windowed and full screen) hosting
   the existing UI web view; the page area reported by the UI's own
   `measure()`. Its own menu bar and keys (⌘T etc. are Margin's menu items;
   while hosting, Margin's keys are its hot keys whenever Margin or an app it
   hosts is in front, let go otherwise: DECISIONS.md "Hosting: Dictionary,
   the loading bar, Margin's keys and the page card's corners").
3. **The host.** A `HostedApp` engine in the app from the kit: start with no
   Dock icon, wait for the window, full screen under the freeze, reserve the
   page area, Margin's frame into its Space, switch, park the ones not shown,
   quit, crash recovery (the slot keeper and its marker from feat/native-slot
   are reused). Safari through its extension for tabs.
4. **The palette.** Installed apps as a source (LaunchServices / Spotlight
   metadata, icons), web search and URLs as today, both opening in the page area.
5. **Menu bar.** Margin's menus, hosted app's menus mirrored (Accessibility),
   top-edge hover only.
   *Joined 2026-11-15 (`feat/hosted-glue`, DECISIONS.md "Margin as the app: the parts joined"):* the library drawn in
   Margin's window, its items hosted by the engine (apps, and Safari windows per profile driven by `hostShow`),
   palette picks as items; Margin's window full screen and the sidebar's tile while hosting. On-screen checks pending.
6. **Removal.** The overlay-over-Safari path, the page box (removed 2026-11-16, for every browser: `DECISIONS.md` "Hosted only"), the edge stop,
   the handoff covers: removed once 1–5 hold up in daily use.
   *Done 2026-11-16 (decided by Tirth: hosted only; DECISIONS.md "Hosted only: the overlay over Safari removed"):*
   Margin.app's side (`refactor/hosted-only-app`): the `MarginHosted` option is gone and hosting is the only mode;
   the overlays and everything that placed them, the handoff, parking, covers, the slot, the edge stop and the
   startup splash removed. The extension's page box goes in its own change.
   *Cleanup 2026-11-17 (DECISIONS.md "Hosted only: the cleanup"):* what the removals left unused is gone: iCloud Tabs
   (for now), the cross-profile order and UI, the overlay's and the handoff's words between the copies and the app,
   the unused private-call checks; and Margin no longer quits itself once the person has opened it.

   *In front 2026-11-17 (DECISIONS.md "Margin's window in front of what it hosts"):* Margin's window is in front of
   what it hosts, the page area a hole in it while a hosted window is shown, the page card opaque with a loader
   while one opens; the corner panels, the lift and "kept below the hosted window" are gone. On-screen check:
   `/tmp/margin-toolbar-test/hosted/check10.swift`.

Chrome and Edge: the same host (Chrome keeps its window buttons visible: hide
its toolbar via its own setting, as decided on 2026-11-14), after Safari.
Windows: unchanged for now (its own shell).
