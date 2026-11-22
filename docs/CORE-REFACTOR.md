# One shared core: Margin's logic moved into Rust (plan)

Tirth, 2026-11-22: "we have to move a lot of the code into rust … to make it a core shared logic", done properly, no
mistakes, no higher CPU or memory, no lower performance. This plan covers steps 1-3; the Windows and Chrome/Edge
hosted design runs beside it (docs/HOSTED-WINDOWS-CHROMIUM.md, its own branch) and consumes what these steps put in the
core. It continues docs/ARCHITECTURE-PLAN.md ("the core decides what, each OS adapter decides how").

## Where things stand (2026-11-22, feat/arc-suite 267c1307)

The Mac app is ~26,000 lines of Swift; ~13,000 are macOS mechanism (window server, Accessibility, AppKit, Safari's
extension API) and stay. The rest is decision logic that belongs in margin-core:

| Area | Lines (Swift) | Today |
|---|---|---|
| Lasting data (store, sync, merge, profiles), the link (messages, sessions, WebSocket, relay), shortcut rules, the shell's link routing | ~2,300 | **Written twice**: Rust copies in margin-core (used only by Windows) ported 2026-11-09/10, the Swift copies changed since (to 11-21). |
| Hosting decisions (applyLayout, window order, cut panes, visible-host bookkeeping, app minimums, live-resize pump, stray/off-screen/exit decisions, all-panes-active, pane-click decision, four ad-hoc loop guards) | ~1,500 + ~1,150 mixed | Swift only (HostEngine, PanesActive, PaneClickTap). |
| The session (library items ↔ hosted windows, layouts and splits, the preview card and Quick Tab, start screen, launcher, Safari window requests, the page area moving) | ~2,400 + ~500 mixed | Swift only (HostedSession, HostedPeek, Library glue, ShellHosted). |
| Margin's window logic (page states, holes and ground, pointer pass-through for several holes, the page hello and messages) | ~600 | Swift only; margin-core's passthrough/planner/binder/shell are the OLD overlay design (Windows only). |
| Already in margin-core and used by the Mac | ~650 | host: layout, kinds, choice, reconciler, guard, causes, routes, schedule, driver, front. |

The sidebar's edit rules (`app/shared/library/library.ts` over `extension/state/model.ts`) are already one copy, in
TypeScript, run by the extension and by the Mac app (JavaScriptCore). They stay there until Windows and Chrome/Edge
are hosted and the extension no longer owns spaces; then they move into margin-core (Tirth, 2026-11-22: no
WebAssembly).

## Rules for every step

- **One copy of every rule.** A rule moves into margin-core and the Swift copy is deleted in the same step; never two
  live copies. Where a Rust copy exists, it's brought up to the Swift behaviour first (Swift is the one in use), then
  the Mac switches, then the Swift copy goes.
- **Behaviour unchanged.** Every step is a refactor: file formats, log lines that tests read, timings, messages. The
  Swift tests that pin a behaviour move with it (as Rust tests) or stay as Swift integration tests against the core.
  Shared vectors (tests/fixtures/data-merge) keep running against every implementation still alive.
- **No OS calls in the core.** The core never opens a socket, starts a timer or calls an OS API: the OS side passes in
  bytes and `now`, schedules the core's next wake, and carries out what it answers (as the Windows shell does with
  `margin_core::shell`). Portable file access (`std::fs`, the data store's atomic writes) is the core's on every OS.
  Swift keeps NWListener/NWConnection, the Unix socket and its code-signing check, SFSafariApplication, Carbon hot
  keys, timers.
- **Cost.** The core is in-process (a static library). JSON over the FFI is fine for rare calls (a layout, a file
  load, a message); the hot paths get typed calls or keep their state in the core so nothing is re-sent: every frame
  of a drag, every key press, every poll, every pointer move. Measured before and after each step: idle CPU and
  wakeups (`idle-cost` screen part), footprint, a switch's time, a drag's frame times (live-resize part), key latency.
  Budgets: idle < 0.5% CPU, < 150 MB, a switch < 16 ms of Margin's work.
- **Each step leaves Margin installable.** One branch per step off feat/arc-suite (refactor/core-shared, then
  refactor/core-hosting, refactor/core-session), `npm run test:quick` per commit, `npm run gate` and the screen suite
  (Chameleon parts; `--real-apps` when Tirth is away and says so) before each merge.
- **The Windows thread** owns app/platforms/windows/**, the chromium extension side and docs/HOSTED-WINDOWS-CHROMIUM.md;
  these steps own app/platforms/macos/**, app/shared/ffi/** and margin-core's data/, protocol, link, socket,
  websocket, relay, shortcuts, shell/, host/. Its "Needs from the core" list is input to steps 2-3.

## The FFI

One pattern, already proven by `HostCore`: a core object per owner (`margin_*_new`/`_free`), one JSON call for rare
requests (`margin_*_call`), typed calls for hot paths, buffers freed by `margin_buffer_free`. The C header stays small
and stable; each new area adds its own object rather than growing one god object. Every call is panic-free (a bad
request is an `{"error": …}` answer, logged once).

## Step 1: one copy of the shared services

From a line-by-line comparison of every Swift and Rust pair (2026-11-22). The Rust copies stopped on 11-09/10; every
Swift change since is missing from them. Branch refactor/core-shared. In this order, smallest risk first; each part
ends with the Swift copy deleted and the Swift tests that pinned it either moved to Rust or kept as integration tests
against the core.

### 1.1 Shortcut rules (Shortcuts.swift lines 21-255 → shortcuts.rs)
- Rust gains Swift's 24 newer commands (copy-url, focus-address, toggle-pin, reopen-archived, Quick Tab, add-split,
  space-1…9, item-1…9) with `browserOnly`, `spaceNumber`, `itemNumber`; the guards (`hostedActive`, `guardsQuit` with
  7952b652's meaning, `guardsAppKeys`, the seven `AppKey`s, the quit combos), `held` (a hosted app that isn't a browser
  loses the sidebar key and the browser-only keys; numbered keys past the window's row counts aren't held), and a Mac
  key-code table (Carbon kVK, checked against Carbon's constants by the app's tests). The newer commands have **no
  Windows default** yet and are never bound on Windows, whatever a copy sends: the Windows shell's old design keeps its
  seven keys exactly; the Windows hosted design decides the rest.
- The old overlay's gate (`active`, `keys_held`, `KeysFront`, `route`, the ⇧⌘L Safari sidebar key) stays for the
  Windows shell until it's hosted, then goes.
- FFI (`ffi/src/keys.rs`): the rare calls answer JSON (the copy's keys, what's held, a guard held or let go); a
  press, a release and a repeat's tick are typed calls, nothing allocated; the core's holder registers through the
  Swift side's Carbon by two C callbacks. Swift keeps the command → action table (runHosted), Carbon and the timer.
  Done 2026-11-22: Shortcuts.swift's rules deleted, the app's 2156 checks pass, the core's and the FFI's tests cover
  the rules, the gates, the guards and the repeat.
- Later (noted, not this step): the default combos also live in extension/shared/app-keys.ts; once the core is the
  source, the build writes them out for the extension instead of a hand copy.

### 1.2 The data set and store (DataSet.swift, DataStore.swift → set.rs, store.rs)
- Rust gains the `flat` store (the app's library: data/app/set.json and items/), the three newer collections
  (`favorites`, `airTraffic`, `splits`; `windows` and `imports` stay unknown-collection files on both sides), and
  Swift's write model: memory updated at once, files written in order on one background writer, the caller told after
  (a thread in the core, so Windows gets it too); `waitForWrites` before a load or an archive.
- Kept as Rust has it (Swift bugs the Rust copy already fixes): a save onto a set written by a later format refuses
  ("LaterFormat") instead of writing over it.
- Edge differences the move changes, on purpose: names that differ only by Unicode normalisation (NFC vs NFD) are
  two names in Rust, as in the extension's own merge (Swift's dictionaries made them one).
- The shared vectors (tests/fixtures/data-merge) keep running against TS and Rust; the Swift vector run is replaced by
  the same vectors through the FFI.

### 1.3 Sync (DataSync.swift → sync.rs)
- Rust drops `margin_tabs` (gone from Swift on 11-17); its links are told up and down by the Mac's link events;
  the hold timer becomes the caller's wake at `next_hold_deadline`; sends come back as effects. Log lines take
  Swift's words ("no Safari profile maps it yet" stays for Safari).
- Kept as Rust has it: a save that fails mid-carry lets the held hello fall back to `data.need` (Swift stayed stuck).
- Part sizes are measured as Rust's JSON writes them (Swift's escaped `/` counted larger): a part can split at a
  slightly different item; the limits (900 KB a part, 10,000 parts, 1 MB a message) hold either way.

### 1.2 + 1.3 design (one change: the sync drives the store)

- **The store writes in the background, in order** (as DataStore.swift does): `save` updates memory at once, builds
  the files and hands them to one writer thread (inline in tests: `DataStore::new_inline`); it returns a ticket. The
  writer runs the jobs in order (atomic writes, fsync, the directories synced), and each result waits in a done queue
  the owner drains (`take_done`), told by a waker (the Mac: a C callback that hops to the main thread; Windows: a
  message to its window). A failed write forgets the profile's cached set (read again from disk next time), as
  Swift's did. `wait_for_writes` blocks for the writer before a load from disk or an archive.
- **The sync acts on a save only once it's written** (as DataSync.swift's callbacks): each of its five saves keeps its
  follow-up keyed by the ticket, with the link's epoch it was made for: an app-side change (send the changes if linked
  and not awaiting), a hello (answer the lost or send the set, then the ack), a snapshot (send the set back if the app
  had one, the ack, the first-set effect), the copy's changes (answer the lost, the ack), a carry (archive the old set,
  the carried effect, the held hello answered or the set sent, the held changes taken). `written()` drains the done
  queue and runs them; a link whose epoch changed since gets nothing (counted unsent, as Swift's weak peer). The
  `changed` effect comes before the follow-up, as Swift's `onChange` did. A failed save: "not stored: nothing
  confirmed to the copy"; a carry's resets `carrying` and lets the held hello fall back to `data.need`.
- **One data object over the FFI** (`margin_data_*`): the profiles' sync (link up and down, a message, an app-side
  change, values, sets, profiles, hold and release, carry, the hold deadline, `written`) answering effects (sends
  with their browser, profile and epoch, changed, first set, carried, log lines), and the library's flat store (load,
  merge and save, live values) beside it. Swift routes each send to its link's connection and runs the callbacks the
  rest of the app had (`onChange`, `onFirstSet`, `onCarried`, `beforeNeed`'s choice).
- **The choice for a profile with no set** (ShellProfiles' `needChoice`: carry over, hold, or ask) stays the Mac's
  (it's about Safari's profile folders), asked by the core through a C callback with everything it needs in the
  question (the profile, and which profiles of its browser have a set), so the Swift side never calls back into the
  data object mid-call. The answer (`ask`, `hold`, or `carry` from a profile with its reason) comes back as JSON the
  core frees.
- **The library's reads stay cheap:** the library keeps its collections' live values as the core last gave them,
  refreshed only for the collections a change of its own touched (one answer per change); its lookups (an item's
  target, space, a split) read that, as they read Swift's dictionaries before. The "newer than what's there" rule for
  its entries (`max(at, updatedAt + 1)`, deletions as tombstones) moves into the core with the merge and the save.
- Effects come back as JSON: sends (browser, profile, epoch, the message with its `k`), changed, first set, carried,
  log lines (note or warn); the Mac sends each on the link with that epoch, schedules a tick at the hold's deadline,
  and drains `written` when the writer's wake hops to the main thread.
- Done 2026-11-22: the Rust store's writer, flat mode and collections (7ce551f8); the sync's follow-ups once written
  (fd209ca8); every Rust data test unchanged and green, the background path tested.
- **Order of commits:** the Rust store and sync changes with their tests (Mac untouched); the FFI and its tests; the
  Mac switched (DataStore.swift, DataSync.swift, DataSet.swift deleted, the Swift data tests kept against the FFI);
  measured (a 1,000-item set's save, the main thread never blocked on a write).
- Before the first install with it, Margin's data folder is copied aside once (it holds the person's library).

### 1.4 Browser profiles (BrowserProfiles.swift → profiles.rs)
- Rust gains Swift's Safari name mapping (`useBrowserNames`, keeping a deleted profile's last name as typed, at most 40
  characters, `associate` on refresh and carry, `checkMapped`, `browserRead`, `carrySource`, `mightCarry`).
- The cross-profile order, `switching.closeWindows`, emoji and colour (removed from the Mac on 11-17) stay in Rust only
  for the Windows shell's old design and are never written to the Mac's browser.json (Swift's test pins their absence).
- A stored `1` for `named`/`hidden` reads as true, as Swift did.
- Done 2026-11-22: profiles.rs is the one copy (two shapes of the file: `BrowserProfiles::new`, the Mac's, never
  reads or writes `emoji`, `color` or `switching`; `BrowserProfiles::overlay`, the Windows shell's old design, keeps
  them, its `order` dropping a forgotten profile at once). FFI (`ffi/src/profiles.rs`): one object per browser, one
  JSON call with `now` passed in and the log lines in each answer, the slots rule on its own; Safari's profiles cross
  as `{ serverId, name, margin }`, and `carrySource`/`mightCarry` take the profiles with a set (`withSets`) instead of
  a callback. BrowserProfiles.swift is a thin wrapper; the unused `across`, `neighbour`, `space_step`,
  `profiles_shown`, `set_browser_link`, `set_browser_names` and `BrowserName.symbol` are gone from Rust (across.rs has
  its own). Kept as Rust had it: a browser.json that doesn't parse falls back to its `.bak` (Swift only when it
  couldn't be read); a kept name's 40 characters are Unicode scalars (Swift: grapheme clusters, which can keep more).

### 1.5 The link (LinkMessage.swift, ExtensionLink.swift, RelayLink.swift → protocol.rs, link.rs, socket.rs, websocket.rs, relay.rs)
- Rust gains what the Mac uses: `setWindowState`'s `land: false`, `WindowCallAnswer.asked`, typed builders and
  readers for the hosted requests and pushes (hostShow, hostClose, hostPicture, hostMedia, hostFocusWindow,
  hostPromotePeek, hostCardClose, peekAnswer, newWindow, closeWindow, userThemes, updateSettings; peekOpen, peekCancel,
  cardPage, cardKey, media, toast), a Safari dispatch target beside the relays, `appUp`, and an out for the port and
  secret changing (the Mac writes its LinkNote from it). Booleans read as Swift read them (1 and 0 too).
- Swift keeps the transport only: NWListener/NWConnection (1 s retry, 5 s to a new port, 127.0.0.1, no delay), the
  Unix socket with its peer pid and code-signing check, SFSafariApplication's dispatch and its refusals, the setup
  notification, the LinkNote file, the connector's host files. It feeds bytes and events in and carries out the
  core's actions, as the Windows shell's tcp.rs and pipe.rs do.
- The old overlay's messages (setLayout, parked, the handoff's probes) stay for the Windows shell until it's hosted.
- Tests the Rust side has and Swift never had (takeover, owner refusal, the hello timeout, rotation, 40 s of
  silence) then cover the Mac too. docs/PROTOCOL.md's stale rows fixed on the way.
- Done 2026-11-22 (uncommitted, for review): `link_hub.rs` joins SocketLink, RelayHub and Safari's way in as the
  Swift joined them (a Safari target, `Via::safari`, beside the relays; `woken`, `say_app_up`, `Out::Note`, a theme's
  pieces put together per link); the FFI's link object (`ffi/src/link.rs`): bytes in typed, bytes out through a
  write callback during the call, everything else one JSON call; `now` is the Mac's monotonic clock and the `at`s
  the wall clock's (`set_wall_offset`), so a sleep never reads as 40 s of silence. LinkSocket.swift and Chunks.swift
  are gone; LinkMessage.swift maps what the core read (and keeps the window requests' Swift API over
  `margin_link_protocol`); ExtensionLink.swift and RelayLink.swift are the transport only. PageLayout moved to its own
  file (Margin's window's, step 3). StateMirror.swift stays the Mac's for now (mirror.rs is Windows').
- Kept as Rust has it: lengths in characters, not grapheme clusters (a chunk's id, a key, a nonce, `socketsOff`, a
  relay's log line); the profile id's byte check (Swift's `$` let a trailing newline through); "a message before
  hello: left" (Swift's log said "closed" but left it); a connection's `.failed` read as the TCP end's
  "connection failed: …". Changed on purpose: a malformed `parkedActivity` is a plain push (the Mac's Swift passed it
  on; the Windows shell drops it, as before).
- The hosted requests' builders and readers (hostShow…, peekAnswer, newWindow's answer) overlap
  feat/hosted-windows-chromium's `hosted_browser.rs` almost wholly, so this step adds only what the link's plumbing
  needs (`land: false`, `WindowCallAnswer::Asked`, the Mac's readers through the FFI); the session's requests stay
  Swift dictionaries until step 3 takes that module.

### Not in step 1
The Mac shell's link routing (which hosted windows are `drawn`, the pushes for the preview card, the mini player and
the loading bar, `copyTabs`) is the session's: step 3.

## Step 2: hosting decisions into the core

Branch refactor/core-hosting, after step 1 merges. The engine (HostEngine.swift) keeps every macOS operation (full
screen, tiles, anchors, members, parking, window mode, Accessibility, the private calls) and asks the core what to do.
A host's model state (role, rect, slid, strays, unread, returns, offTries, reentries, minSize, failures, noTiles) moves
into the core's host model; Space ids, tiles, toolbars and Safari window ids stay on the Swift side.

1. **The model and the layout's decisions:** `applyLayout` (duplicates, a card below its minimum, z order, held hosts,
   one left alone at the page area, the focus), `visibleHosts` ordering, `pageOf`/`placementFor`, `belowMinimum`,
   `pruneVisible`/`settleVisible`, `bringIn`'s decision tree, `holdLayout`.
2. **Window order:** `frontVisible`'s wanted order, `overlapping` (with the toolbar's room), the violated pairs and
   which hosts to raise in what order (the engine raises them); one shared rule for "lies under".
3. **Cut panes:** `frame`/`paneFrame`/`entryFitted`, `cutOf`, `slideFor`, `lyingUnder`, `tucked`, `tuckedOrder`, the
   slide's frames (ease, 150 ms, one rect a frame: the core says each frame's rect, the engine sends it).
4. **One loop guard:** the four Swift guards (strays' returns, full-screen re-entry, back on screen, the cut order's
   repair) become the core's guard.rs/driver budgets; the retry-once full-screen ladder joins routes.rs's step down.
5. **App minimums:** the version-keyed store beside routes.json, in the core as routes are.
6. **The live-resize pump's scheduling** (one in flight per host, a frame's throttle, the newest wins, tiles first, the
   give-up wait): the core schedules, the engine writes.
7. **Strays, off screen, exits, close, recovery:** each budget and choice (`strayed`, `backOnScreen`,
   `reenterFullScreen`, `closeNow`'s tree, the exit tracking, what the marker keeps).
8. **All panes active and pane clicks:** `PanesActive.wanted` and the keeper's `step` (grace, guard, crash marker);
   `PaneClick.decide` with modifiers as plain flags. The records and the tap stay Swift.
9. **Duplicates removed:** `HostLayout.near`, the strip rule (four Swift copies of kinds::is_strip), the sidebar's
   least width, the 0.1 s "heard something" throttle (schedule.rs's), the `tucked` copy in `sayHostedWindows`.

Hot paths stay typed (a drag's frame, a poll's facts, a slide's frames); the poll still reads the window server once.
Measured as step 1. Expected to delete ~1,500 lines of Swift decisions and leave HostEngine as the Mac adapter.

## Step 3: the session into the core

Branch refactor/core-session, after step 2. What HostedSession, HostedPeek, Library's glue and ShellHosted decide
moves into a core `session` module the Windows shell also runs (its "Needs from the core" list is checked against
this step before it starts):

- The library's requests to hosting (open, show, close, reset a pin or favourite: four near-copies made one), the
  choice of host and profile, overtaken picks, the cycle hold.
- Layouts and splits (`applyLayout`, `showSplit`, `noRoom` with the 220 pt least, `leaveSplit`, layouts forgotten),
  the preview card and Quick Tab (their state machine and rects), an item shown in another Margin window (its card).
- The start screen's state machine, `resumeLast`, `settleHosting`, the launcher, the default browser made ready.
- The page area moving (coalescing, the retry), the loading bar, which window gets the mini player, the shell's link
  routing (`drawn`, the pushes), the page hello and its messages, the page states (empty, loading, shown, elsewhere,
  the loader's grace), the holes and the ground, the pointer's pass-through for several holes (the core's
  passthrough.rs brought up to Swift's several holes; the old overlay's planner and binder go once Windows is hosted).
- `DataSetWindowSource.state`, which re-builds what the TS library's snapshot already gives, is replaced by that one
  copy.
- Swift keeps: the protocols to the engine and to Margin's window (as the adapter's contract), Safari's own window
  mechanics (waking a profile through Safari's menu, the restored-window sweep), NSPasteboard, UserDefaults.

## Step 4: the sidebar's rules into the core (Tirth, 2026-11-22)

Right after step 3, before the Windows hosted session plugs in, so Windows never runs a stopgap (no QuickJS, no hidden
web view): the library's edit rules (app/shared/library/library.ts over extension/state/model.ts: about 40 actions,
the import, the snapshot) become margin-core's, the Mac's LibraryRules (JavaScriptCore) goes, and the TS copy stays
only while Chrome's and Edge's copies still own spaces in the old design (feat/hosted-windows-chromium retires that).
The TS tests' cases are carried over as shared vectors run against both until the TS copy is deleted.

## Order and checks

1. Step 1 (1.1 → 1.5), merged after the gate and the screen suite.
2. Step 2, the same.
3. Step 3, with the Windows thread's plan read first.
4. Step 4 (the sidebar's rules); then the Windows session plugs into the core's.

Every merge: `npm run gate`, the screen suite's Chameleon parts, idle cost and live-resize numbers against the ones
before, and the log lines tests read unchanged.
