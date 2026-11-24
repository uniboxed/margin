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
  these steps own app/platforms/macos/**, app/platforms/macos/ffi/** and margin-core's data/, protocol, link, socket,
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
  file (Margin's window's, step 3). StateMirror.swift stayed the Mac's until 1.6.
- Kept as Rust has it: lengths in characters, not grapheme clusters (a chunk's id, a key, a nonce, `socketsOff`, a
  relay's log line); the profile id's byte check (Swift's `$` let a trailing newline through); "a message before
  hello: left" (Swift's log said "closed" but left it); a connection's `.failed` read as the TCP end's
  "connection failed: …". Changed on purpose: a malformed `parkedActivity` is a plain push (the Mac's Swift passed it
  on; the Windows shell drops it, as before).
- The hosted requests' builders and readers (hostShow…, peekAnswer, newWindow's answer) overlap
  feat/hosted-windows-chromium's `hosted_browser.rs` almost wholly, so this step adds only what the link's plumbing
  needs (`land: false`, `WindowCallAnswer::Asked`, the Mac's readers through the FFI); the session's requests stay
  Swift dictionaries until step 3 takes that module.

### 1.6 Themes and the state mirror (ThemeStore.swift → data/themes.rs; StateMirror.swift → mirror.rs, link_hub.rs)
- Themes: Rust gains Swift's newer built-ins (`liquid-glass`, `material`: refused as an imported theme's id, left out
  of the index) and BuiltinThemes (the packages the app carries for its own window, Neubrutalism's earlier name, read
  once each). FFI (`ffi/src/themes.rs`): a store object (one JSON call: list, has, save, remove) with the package a
  window draws typed (its bytes as they are, never inside another JSON string: up to 4.5 MB), a built-ins object,
  and no-object calls (the id rule, the limits, what the picker chose read within caps, `chosen_ok` first).
  ThemeStore.swift keeps the folder's place and the API; ThemeFileReader and BuiltinThemes are thin wrappers;
  AtomicFile (DataSync.swift) is gone: the store's `write_atomically` is the one copy.
- Kept as Rust has it: a stored package's and the index's bytes as serde writes them (Swift's JSONSerialization
  escaped every `/`, so `bytes` in the index, and the 4.5 MB check, counted a little more; the extension's own
  limit counts as Rust does); a name, version or author cut to 60/16/80 Unicode scalars (Swift: grapheme clusters);
  a folder's files read in name order (Swift: the enumerator's), so with several problems the first by name is the
  one said; a folder that can't be listed is refused ("couldn't read a file in that folder"; Swift's enumerator
  skipped it); `Thumbs.db` and `desktop.ini` left out of a folder as `.DS_Store` is; a write that fails says the
  OS's error ("Permission denied (os error 13)", Swift: "mine.json: open: Permission denied").
- The mirror: each link's state lives in the core (`LinkHub`'s mirrors, begun at its hello, gone with it): a snapshot,
  delta or window list is applied inside the bytes' call as it's read, and the answer says only what it did
  (`do: state`: kind, outcome, the keys it carried, the windows when they changed, `hasState`, `resyncing`), never
  the values again; a value is read when the Mac needs one (`margin_link_state_value`: its JSON's bytes as kept).
  The resync moved with it: a gap is logged in the same words, the `resync` sent at once and every 2 s while the
  snapshot hasn't come (at the answer's `deadline`); Shell.swift's timer and `Options.resyncRetry` are gone.
  StateMirror.swift is a view: the flags and windows the answers said (the windows are read on every poll), values
  read from the core. LinkMessage's `.snapshot`/`.delta`/`.windows` became `.state` (what the core applied).
- Per delta the Mac now parses one small answer instead of the delta's values twice over (once as the core wrote
  them into the answer, once re-encoded by the Swift mirror); a value (openTabs on a tab change) is read once, as
  before.
- Kept as Rust has it: a `seq` at the top of the range saturates (Swift's `seq + 1` would trap).

### Not in step 1
The Mac shell's link routing (which hosted windows are `drawn`, the pushes for the preview card, the mini player and
the loading bar, `copyTabs`) is the session's: step 3.

## Between steps 1 and 2: the UI and its themes out of the extension (Tirth, 2026-11-22)

**Done (the UI move):** the folders are at `app/shared/ui/` and `app/shared/ui/themes/`, and the built output is the same
byte for byte except the themes' README (DECISIONS.md, "The UI and its themes move to app/shared/ui").

`extension/ui` and `extension/themes` are Margin's window's now (the hosted design draws them in Margin's own window on
the Mac, on Windows next); the extension's content scripts and new-tab page use neither. A pure move into
`app/shared/ui/` (themes at `app/shared/ui/themes/`; its own commit, no behaviour change: the build, the theme tests, pack-theme, the CI plan and the docs'
paths). The extension's two leftovers (the background's theme settings and package import, the model's theme settings:
its old ownership of spaces) import from there until step 4 removes them. The Windows branch touches neither folder.
In the same pass, its own commit: `app/shared/ffi` moves to `app/platforms/macos/ffi` (Tirth, 2026-11-22: only the Mac's
Swift needs the C bridge; Windows uses the core directly): the workspace, build-core.sh, safari.sh, the app tests' and
the WebKit host's run scripts, the module map, the docs.

**Done (the FFI move):** margin-ffi is at `app/platforms/macos/ffi/` (its `margin-core` path dependency
`../../../shared/core`); the crate, its C header and the static library are unchanged.

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

### Step 2 design (2026-11-22, at 3bc80f50)

Paths: **HE** app/platforms/macos/shell/HostEngine.swift; **PA** PanesActive.swift, **PC** PaneClickTap.swift, **H**
Host.swift, **WK** WindowKinds.swift, **HC** HostCore.swift, **MWC** MarginWindowController.swift (same folder);
**core/** app/shared/core/src/host/; **ffi/** app/platforms/macos/ffi/src/; **T/** app/platforms/macos/shell/tests/;
**S/** tools/screen-tests/suite/. Line numbers as of 3bc80f50.

#### What every part shares

- **One object, the engine's own.** Each HostEngine already owns one core (`private let core: HostCore`, HE:501, made
  at HE:550; Rust `HostCore`, core/api.rs:201: driver, causes, front). It gains `model: HostModel` (new core/model.rs).
  Not a new object: the model's decisions and the driver's tries and guard act together inside one call (a show resets
  the tries, HE:3119; a re-entry clears the guard, HE:1608-1609). Two exceptions: the panes-active keeper is its own
  object (part 8, it has no other state in common), and `PaneClick.decide` is a free function (it runs on the tap's
  thread, PC:100, and must never wait on the engine core's lock, HC `lock`).
- **Hosts by handle.** `margin_model_add` (rare) answers a `u32` handle; every typed call takes handles, never id
  strings. A layout names hosts that don't exist yet (`next[id]` before `hosts[id]`, HE:671-672, 684-686): the model
  gives a handle to any id a layout names, filled in when the host is made (`opened`).
- **State.** The core holds what the decisions read and is OS-neutral; Swift's `Host` (HE:253-374) keeps the OS's ids
  and the mechanism's bookkeeping. Fields that move become computed properties of `Host` that read and write the core
  by typed calls, so the engine's code and the tests' reads and writes (`engine.hosts[editHost]?.minSize = …`,
  T/multi-host-session-tests.swift:90, 108; `e.hosts[id]?.tile`, `.noTiles`, `e.visible`, `e.shown`) stay as they are.
  - **Into the core:** role, rect, slid, phase, mode, resizable, placedPage, `member` and `tiled` (facts: Swift sets
    them where it sets `member` and `tile`), noTiles, minSize, narrowestHeld, unread, strays, returns, offScreenReads,
    offPageReads, offTries/offSaid/offActedFor/offInPlaceSaid, visibleAt, reentries/reentrySaid,
    fullScreenFailures/retryFullScreen, gone/goneAt, freshFront; the window and pid as opaque `i64`s; the id and the
    app key (bundle id) with its version. The engine's: `visible`, `shown` and `shownAt`, `focusWanted`, `placement`,
    `livePage`, `applyingLayout` and the hold's snapshot, `belowSaid`, the live pump's state and `LiveStats`, the app
    minimums, `exiting`, `cutRepairs`/`cutRepairSaid`/`cutRepairsFailed`.
  - **Stay Swift:** `target` (HostTarget), `safariWindow`, `fullScreenSpace`, `privateSpace`, `tile` (the tile's id),
    `toolbars`, `windowsBeforeAsk`, `bornBefore`/`bornFrozen`/`bornSwitched`, `original`/`originalSpace`/`away`/
    `frameChanged`/`exitUnconfirmed`/`axRefused`, `taken`/`unseen`, `launchWindows`, `askedFullScreenAt`,
    `quitAskedAt`/`askingSaid`, `bundleId`/`appLaunchedAt`, `promoted`/`outsideOpens`; the engine's Space ids
    (`marginSpace`, `ownSpaces`, `retired`, `leftSpaces`, `parkedOthers`), tiles (`marginTile`, `tileHome`,
    `anchorTiles`, `goneTiles`, `tileCount`, `tilesSettled`), `woken`, `launched`, `quitAsked`, `leftWindows`,
    `leftSafariWindows`, `pollSaid`, `freezeHolds`, the marker.
- **Each decision where it's made today.** HostEngine's operations are async and read the window server between their
  awaits; a decision reads the state as it is at that point. So no up-front plan for a sequence whose later steps read
  what earlier ones did (`applyLayout`, `bringIn`, `closeNow`, `backOnScreen`): each decision point becomes one small
  call at the same place, between the same two awaits. Plans are used only where today's code also decides everything
  first and then acts without reading (window order's raises, part 2).
- **Options.** `Options` (HE:116-248) stays the Swift struct tests change after init (`e.options.privateRetire = 0`,
  T/split-real-use-tests.swift:270). `var options { didSet { core.configure(…) } }` sends what the core's decisions read
  (tolerance, toolbarRoom, returnsMax/returnsWithin, lateWatch, liveFrame, liveWait, slideTime, quitWait), one JSON call
  per change.
- **Time** is always passed in (`sys.now()`: the stand-in's clock in the tests).
- **Log lines** stay Swift's, word for word: the core answers codes and numbers. Two lines are built in Rust because
  their numbers are the core's: the live-resize line (part 6; S/LiveResize.swift:141 parses it,
  T/split-real-use-tests.swift:353 reads "each: ") and the panes-active loop warning (part 8, PA:195); each pinned by a
  Rust test with the exact text.
- **The header stays small:** scalar fields through `margin_model_get(core, h, field) -> int64_t` and
  `margin_model_set(core, h, field, int64_t)`, rects through `margin_model_get_rect/set_rect(core, h, field, MarginRect*)`
  (NULL: none), with one field enum; one family of typed calls per part.
- **No allocation on hot paths:** typed calls write into caller buffers (16 entries: a layout has at most four
  visible hosts, docs/PEEK-SPLIT.md §1); a margin-ffi test with a counting allocator asserts that the drag's tick, the
  frame, the poll's per-host call and the click decision allocate nothing.
- **Geometry semantics** differ from CGRect at edges (core geometry.rs:51-87: `union` drops an empty rect, CG keeps a
  zero-size non-null one; `inset_by` clamps to 0, CG gives null): every ported rule gets vectors with zero-size and
  touching rects run against the Swift copy before it's deleted (one commit adds them, the next deletes the Swift).

#### Part 1: the model and the layout's decisions

**Today.** `applyLayout` HE:657-766. Decision: refuse a duplicate (HE:661) and a card below its app's known minimum
before anything is made (HE:664-667); the layout `next` with each one's z (HE:671-672); `arriving` (HE:674-675);
`relaid`/`inPlace`/`deferring` (HE:680-682); `held` (HE:684-689); after the hosts came: `cameIn` (HE:722), what's no
longer in the layout (HE:733), one left of several → alone, main, at the page area (HE:745-752), the focus wanted
(HE:754-756), whether to front (HE:757). Mechanism: `openNow`/`place` per host (HE:701-707), `placeTogether`
(HE:770-777: tile rects sent in one turn, waited for), retire/backOut/park (HE:734-740), the freeze, the loader,
`announceHosted`, logs. Beside it: `alone` HE:640-642, `liveFollowers` HE:646-649, `visibleHosts` HE:4630-4633 (z,
then the focused one last, then `HostID.raw`), `mainHost` HE:4635, `isVisible` HE:4628, `pageOf` HE:4619,
`placementFor` HE:4621-4626, `rank` HE:4721 (the reconciler's order, HE:1483, 1512), `belowMinimum` HE:4638-4642,
`sayBelowMinimum`'s said-once HE:4724-4731, `before` HE:4733-4736, `pruneVisible` HE:4738-4741, `settleVisible`
HE:4748-4756, `followShown` HE:4710-4719 run by `shown`'s didSet HE:390 (with `shownAt`, `visibleAt`,
`announceHosted`), `holdLayout` HE:3273-3289 and its second copy inline in `pageRectChanged` HE:1011-1025. `bringIn`'s
tree HE:3113-3170: its decision points HE:3122 (gone → reopen), 3134 (a new app not taken → take), 3146 (window mode
after a failed full screen → full screen again), 3153 (window mode), 3156-3163 (a tile held below tiles → placed
again; a tile → sized first), 3164 (a member at its page → `switchIn`), else `placeFullScreen`. A window-mode frame:
`centredIn` HE:2932-2934, `atPageArea` HE:2937-2941, `placeWindow`'s `want` HE:2960-2966, 2976 (the Windows thread asks
for this one, docs/HOSTED-WINDOWS-CHROMIUM.md:438, `layout::inside`). `visibleHost(at:)` HE:2158-2163 (bounds read by
Swift, then frontmost whose bounds ∩ frame holds the point).

**Core.** core/model.rs:

```rust
pub type Handle = u32;
pub enum Role { Main, Pane, Card }  pub enum Phase { Preparing, Shown, Parked }  pub enum Mode { FullScreen, Window }
pub struct Visible { pub rect: Option<Rect>, pub role: Role, pub z: u32 }
pub struct HostModel { slots, visible: BTreeMap<Handle, Visible>, shown: Option<Handle>, shown_at: f64,
                       focus_wanted: Option<Handle>, placement: Placement, live_page: Option<Rect>, applying: bool,
                       hold: Option<Hold>, opts: ModelOptions, minimums: AppMinimums, budgets: Budgets, live: LivePump, exits: Exits }
impl HostModel {
    pub fn add(&mut self, id: &str, app: &str, version: Option<&str>, window: i64, pid: i64) -> Handle;
    pub fn remove(&mut self, h: Handle);
    pub fn is_visible(&self, h: Handle) -> bool;
    pub fn visible_hosts(&self, out: &mut [Handle]) -> usize;           // back to front
    pub fn main_host(&self) -> Option<Handle>;
    pub fn page_of(&self, h: Handle) -> Rect;  pub fn placement_for(&self, h: Handle) -> Placement;
    pub fn rank_order(&self, out: &mut [Handle]) -> usize;
    pub fn alone(&self, h: Option<Handle>) -> bool;
    pub fn below_minimum(&self, h: Handle, rect: Option<Rect>) -> bool;
    pub fn set_shown(&mut self, h: Option<Handle>, now: f64) -> bool;    // followShown's rule inside; true: changed
    pub fn before(&self, h: Handle) -> Option<Handle>;
    pub fn settle_visible(&mut self) -> bool;                             // prune + settle; true: tell Margin's window
    pub fn hold(&mut self, h: Handle) -> bool;  pub fn release(&mut self) -> Released;  // one hold, both copies
    pub fn layout_begin(&mut self, now: f64, ask: &LayoutAsk) -> LayoutPlan;          // refusals, order, arriving, deferring, held
    pub fn layout_came(&mut self, h: Handle, shown: bool, now: f64);
    pub fn layout_end(&mut self) -> LayoutEnd;                            // park list, alone, focus, front?
    pub fn bring_in(&self, h: Handle, at: BringInPoint, f: &BringInFacts) -> BringIn;
}
// layout.rs
pub fn inside(page: &Rect, size: Size) -> Rect;    // centredIn: whole points as Swift's rounded()
pub fn window_frame(page: &Rect, now: &Rect, resizable: bool, placed_before: bool, tol: f64) -> Option<Rect>; // None: there
```

**FFI.** JSON (rare: a layout, a hold, a show): `layoutBegin`, `layoutEnd`, `hold`, `release`, `add`. Typed (read many
times per operation and per poll): `margin_model_visible(core, uint32_t *out, size_t cap) -> size_t`,
`margin_model_is_visible`, `margin_model_page_of(core, h, MarginRect*)`, `margin_model_placement_for`,
`margin_model_alone(core, int64_t h /*-1*/)`, `margin_model_below_minimum(core, h, const MarginRect*)`,
`margin_model_set_shown(core, int64_t h, double now) -> bool`, `margin_model_bring_in(core, h, uint8_t point, uint32_t
facts) -> uint8_t`, `margin_layout_inside(MarginRect page, double w, double h) -> MarginRect`, `margin_layout_window_frame`,
`margin_model_layout_came(core, h, bool, double now)`.

**Unchanged, pinned by:** T/multi-host-tests.swift (55 checks, 46-125), T/split-tests.swift, T/peek-split-tests.swift,
T/split-real-use-tests.swift (38), T/multi-host-session-tests.swift, T/peek-session-tests.swift, the switch time in
T/host-tests.swift:1831. Ported to Rust (model.rs tests, from T/multi-host-tests.swift:85-113): duplicates and a card
below its minimum refused before anything's made, deferring only when every relaid host can be laid out in place, one
left alone at the page area after a newcomer failed, the focus falling back to main then the frontmost, the visible
order's ties. The Swift ones stay as integration tests. Screen: `core`, `behaviours-*`, `cut-panes`.

**Risks.** `shown`'s didSet (HE:390) runs on 20-odd assignments, synchronously, `announceHosted` last: the setter
keeps that order (core `set_shown`, then Swift's `announceHosted`). `applyingLayout` is held across awaits (HE:693-741,
3276-3288, 1013-1018) and read by `followShown`, `pruneVisible`, `settleVisible`, `sayHostedWindows`: one core flag set
and cleared by the same calls at the same points. Ties sort by `HostID.raw` (Swift `String <`): ids are ASCII
(H:49-73), so byte order is the same; a vector pins it. Cost: `page_of`/`placement_for`/`is_visible` are read dozens of
times an operation: typed, nothing allocated.

**Two commits:** 1a the model (state into the core, computed properties, no decision moved: proves the FFI's cost on
`idle-cost` and `live-resize`), 1b the decisions. ~190 Swift lines deleted (the layout's decisions ~60, the visible set's
helpers ~25, prune/settle/follow/hold ×2 ~60, bringIn's conditions ~15, the window-mode frame ~15, field storage ~15);
~500 Rust lines + ~350 of tests.

#### Part 2: window order

**Today.** `frontVisible` HE:800-874. Decision: the wanted order (HE:801-811: cut panes lying under others behind,
`tuckedOrder`; the others; the focused one last unless it's cut), raise or raise-over (HE:815-820: a tucked one below
that it lies over → `raiseOver`), the keys (HE:822: without a raise for a cut focused one), the pairs that need an order
(`overlapping` HE:879-894: frame ∪ bounds, `toolbarRoom` 52 above a full-screen window, overlap wider and taller than
the tolerance), `violated` (HE:827-832), in order already → keys only (HE:835), `tuckedPair` (HE:839), the focused one
in front already → only the other bad pairs not touching it (HE:841-847), else everything from the first out of place
(HE:849-850), then the confirm (`topBehind` HE:854). Mechanism: `front` HE:4319-4325, `raiseOver` HE:6170-6176,
`focusWithoutRaise`, the waits, the ladder after a failed confirm (raise again HE:866, Safari's copy HE:869-874,
`outAndBack` HE:902-917), `serverOrder`'s read HE:920-926.

**Core.** core/order.rs: `impl HostModel { fn front_wanted(&self, out: &mut [Handle]) -> usize; fn front_plan(&mut self,
bounds: &[Option<Rect>], order: Option<&[i64]>, fresh: &[Handle]) -> FrontPlan; fn top_behind(&self, order:
Option<&[i64]>) -> bool }` with `FrontPlan { raise: Vec<(Handle, Option<Handle> /*over*/)>, keys: Keys /*Raise(h) |
NoRaise(h) | None*/, confirm: Option<Confirm { top: Handle, fresh: bool }> }` (kept in the model for `top_behind`), and
`pub fn server_order(front_to_back: &[i64], windows: &[i64]) -> Option<Vec<i64>>`. The ladder after a failed confirm
stays Swift: each rung is mechanism (a raise, Safari's copy, a move between Spaces).

**FFI.** JSON `frontPlan` (a layout, a focus, a repair: not per frame; ≤ 4 hosts). Typed
`margin_model_top_behind(core, const int64_t *order, size_t n /*0 with NULL: unread*/) -> bool`: the confirm is read every
`memberEvery` (5 ms) for up to `orderWait` (150 ms), HE:865.

**Pinned by:** T/pane-fronting-tests.swift (11), T/multi-host-tests.swift:110 (a pane focused, fronted last),
T/split-real-use-tests.swift (the 14:30 "fronted twice" case), T/multi-host-tests.swift:307-317 (cut order). Ported:
the order rules (tucked ones behind, keys only when the order shows already, nothing raised over the focused one,
tucked pairs) as order.rs tests. Screen: `cut-panes`, `pane-clicks`, `core`.

**Risks.** `overlapping` reads each window's bounds (HE:883): Swift reads them between `front_wanted` and `front_plan`,
the same reads at the same moment. The plan is decided up front exactly as today (the raises run from a list made
before the first one; nothing is read between them but inside `raiseOver`'s own wait). ~55 lines deleted.

#### Part 3: cut panes

**Today.** `frame` HE:4506-4519 (window mode, card: the page; a pane: `paneFrame` at its slide while its pane is still
the one slid in; else `fit` at its minimum), `paneFrame` HE:4521-4524 (cut; held within the display unless a tile),
`entryFitted` HE:4527-4531, `livePage` HE:4534, `paneMinimum` HE:4537, `cutOf` HE:4542-4557, `hidden` HE:4559-4561,
`slideFor` HE:4564-4576, `slidFrame` HE:4578-4581, `lyingUnder` HE:4584-4588, `tucked` HE:4589, `tuckedOrder`
HE:4592-4601, `isCut` HE:4604-4608, `fitted` HE:4609-4613, `tileRect` HE:4497 and `tileRect(for:)` HE:4758. `slide`
HE:5620-5650: decision (the side allowed, its alignment, a change of `tucked` → front, HE:5622-5627) and its frames
(ease-out cubic over `slideTime`, one rect a `liveFrame`, HE:5630-5640); mechanism `sendTileRect`, the frame's sleep,
`place` with no tile. `overPaneItLiesUnder` HE:6179-6188 (a predicate over the on-screen order); the poll's look
HE:1268-1274; `repairCutOrder`'s budget is part 4.

**Core.** core/panes.rs, `impl HostModel`: `frame(h, p: Option<&Placement>) -> Rect`, `fitted`, `entry_fitted`,
`tile_rect(h, p, home) -> Option<Rect>`, `is_cut`, `cut_of(h) -> Option<Sides>` (a bit set), `slide_for(h, side) ->
Option<Slide>`, `set_slid`, `lying_under(h, frame: Option<Rect>, out) -> usize` (the frame given: `sayHostedWindows`'
live one, part 9), `tucked`, `tucked_order`, `over_pane_it_lies_under(h, front_to_back: &[i64]) -> Option<bool>`;
layout.rs `pub fn slide_rect(from: &Rect, to: &Rect, elapsed: f64, time: f64) -> (Rect, bool /*last*/)`.

**FFI.** Typed, the hottest calls of the step (`frame` per follower per drag tick through `sendLive` HE:5210; every
`tileEvery`, 2 ms, in `placeTogether`'s wait HE:773-775; in every `near` check of an operation):
`margin_model_frame(core, h, const MarginPlacement* /*NULL: its own*/, MarginRect*)`, `margin_model_tile_rect(core, h,
const MarginPlacement*, MarginRect home, MarginRect*) -> bool`, `margin_model_cut(core, h) -> int8_t` (-1 not cut, else
side bits), `margin_model_slide_for(core, h, uint8_t side, MarginSlide*) -> bool`, `margin_model_tucked(core, h)`,
`margin_model_over_under(core, h, const int64_t*, size_t) -> int8_t`, `margin_layout_slide(MarginRect, MarginRect,
double elapsed, double time, MarginRect*) -> bool`.

**Pinned by:** T/multi-host-session-tests.swift:86-110 (cut, arrows, a slide, its minimum gone), T/split-real-use-tests.swift
(a cut pane within the display, from ~288), core/layout.rs's `cut`/`within` tests, T/pane-click-tests.swift's tuck
cases. Ported: `cutOf`'s crossing rule, `slideFor`'s alignments, `tuckedOrder`'s chain and its loop fallback,
`entryFitted` within the display, a slide's rect count and ease. Screen: `cut-panes`.

**Risks.** `frame` reads `livePage`, `placement`, `tiled`/`noTiles`, the minimum and the app's minimum: all in the core
before this part (so part 5 first). The slide keeps its frame pace (Swift's sleep of one `liveFrame`, HE:5639: a
frame's pace as today, not a new wait). ~130 lines deleted.

#### Part 4: one loop guard

**Today, four guards and a ladder.** (1) A stray's returns HE:5408-5413 (within `returnsWithin` 30 s, at most
`returnsMax` 3; past it the list cleared and the host parked). (2) Full-screen re-entry HE:1598-1604 (3 within 30 s,
then said once; a re-entry resets the said). (3) Back on screen HE:5497-5503, 5519-5522 (3 within 30 s; in place once
per show, `offActedFor == visibleAt`; `offInPlaceSaid`, `offSaid` said once, `offSaid` reset when newly visible
HE:717). (4) The cut order's repair HE:6197-6214 (3 within 5 s, or 3 that didn't take in a row; then said once and held
until `cutOrderRight` HE:6218: seen right HE:1271-1272, a slide HE:5646, alone HE:749). The retry-once full-screen ladder:
`fallBack` HE:3518-3519, `bringIn` HE:3146-3151, `adopt` HE:1809, 1825, `move(.window)` HE:5123-5124. Already the core's:
`guarded` HE:5027-5038 and `relayoutGuarded` HE:5042-5060 (guard.rs), the routes HE:5063-5135.

**Why not guard.rs or the driver's tries as they are:** guard.rs stops a host for good on 3 within 5 s (guard.rs:59-93,
until its route changes) and the driver's tries start again at every show (driver.rs:93-102; HE:3119), while a stray's
returns and the off-screen tries deliberately outlive a show. Folding them in would change what Margin does.

**Core.** core/budget.rs: `pub struct Budget { limit: u32, within: f64, spent: Spent /*Clear | Hold*/, streak:
Option<u32> }`, the four as constants (`STRAY_RETURNS`, `REENTRY`, `OFF_SCREEN`, `CUT_REPAIR`; limit/within from the
options where Swift has them), `Budgets` keyed by (handle, kind) with `spend(now, h, kind) -> Spend { Go { count } |
Spent { say: bool } }`, `check` (counts after acting, as `backOnScreen`), `took(h, kind, bool)` (the streak),
`reset_said`, `clear`. Each keeps today's order of filter, check and append (pinned per kind). The ladder moves into the
model as it is, per host and per run: `full_screen_failed(h) -> bool /*tried again at the next show*/`, `retry_now(h)`,
`adopted(h)`, `moved_to_window(h)`.

**FFI.** Typed `margin_budget_spend(core, h, uint8_t kind, double now) -> int32_t` (≥ 0: go, its count; -1 spent and to
be said; -2 spent, said already), `margin_budget_took`, `margin_model_full_screen_failed`.

**Pinned by:** T/host-tests.swift:2445 (3 in 30 s, then parked), T/screen-engine-tests.swift:131-189 (out of full
screen by itself), T/host-tests.swift:2737-2757 and 4373 (off screen), T/multi-host-tests.swift:307-317 (the cut order's
repair), T/host-tests.swift:3027 (window mode → full screen once); T/loop-guard-tests.swift unchanged. Ported: each
budget's behaviour (budget.rs tests). Screen: `behaviours-*`, `cut-panes`.

**Tirth's answers (2026-11-22):** the retry-once ladder stays per host and per run (it doesn't join routes.rs: no
change of behaviour). The four budgets DO count toward guard.rs's 12-a-second hold from now on: each budget's action
is one of the guard's actions, so a loop between Margin and an app through any of them is held as the core's other
actions are. That's the one change of behaviour in step 2: new tests pin it (a budget's actions past 12 a second
held), and the screen suite's `behaviours-*`, `cut-panes` and `real-apps-loop` parts must show no hold they didn't
before. ~45 lines deleted.

#### Part 5: app minimums

**Today.** HE:4650-4708: `AppMinimum` (version, width, height), `appMinimums`, minimums.json beside routes.json
(HE:4652), `appKey` HE:4657-4662 (Safari's windows are Safari's), `version(of:)`'s cache HE:4663-4668, `appMinimum`
HE:4670-4674 (none for another version; the running app's pid read from `sys.running` when not given), `knownMinimum`
HE:4677-4680, `knownAppMinimums` HE:4682-4687, `rememberMinimum` HE:4689-4698 (saved and said only when new for the
version), `loadMinimums` HE:4699-4703 (0 ≤ w, h < 20000), `saveMinimums` HE:4704-4708 (JSONEncoder, atomic). Learning:
`learnMinimum` HE:4769-4784 (rounded up; a tile that says none keeps the one read, said once), `held` HE:4786,
`learnMinimumFromLeaving` HE:4790-4795, `shownMinimumWidth` HE:4804. Mechanism: `sys.tileMinSize`, `sys.appVersion`,
`onMinimum`/`onAppMinimums`.

**Core.** core/minimums.rs: `AppMinimums { by_app: BTreeMap<String, AppMinimum> }` with `load(&Value)` (the filter),
`to_json`, `known(app, running_version: Option<&str>) -> Option<Size>`, `remember(app, version, Size) -> bool`; the model:
`learn_min(h, read: Option<Size>) -> Learnt { Changed { tell: bool } | UnreadKept { say: bool } | Same }`,
`learn_from_leaving(h) -> Option<f64>`, `held(h, width)`, `shown_min_width()`, `known_minimum(id, app, version)`,
`known_app_minimums(versions)`. Each host's app minimum resolved at `add` and at `remember` (no map lookup per frame).

**FFI.** JSON: `loadMinimums` (the file's bytes read by Swift, as `HostCore.loadRoutes` does), `saveMinimums` (answered
JSON written by Swift atomically, as `saveRoutes`), `knownMinimum`, `knownAppMinimums`. Typed:
`margin_model_learn_min(core, h, const MarginSize* /*NULL unread*/) -> uint8_t`, `margin_model_held`.

**Pinned by:** T/split-real-use-tests.swift:268-290 (the file and its version, the next launch, another version),
T/live-resize-tests.swift's minimum checks, T/multi-host-session-tests.swift:90-110; screen `live-resize-min`,
S/MinSize.swift, `real-apps-min` (Tirth's OK). Ported: version gating, the load filter, remember-only-when-new,
rounding up, an unread minimum kept.

**Risks.** `knownMinimum` reads the running version at the time it's asked (T/split-real-use-tests.swift:284-286 flips
it between two calls): Swift reads it and passes it each call; the core never reads versions. The file's numbers as
serde writes them (`700.0`) if the core ever writes it; here Swift writes the core's JSON, readers parse either. ~70
lines deleted.

#### Part 6: the live-resize pump's scheduling

**Today.** `dragging` HE:5141-5169 (follow or not: the one shown shown and a tile, a window-mode window or other
followers; mechanism `setLiveResizing`, `learnMinimum`), `follow` HE:5179-5194 (the newest frame wins, `liveRects`,
`sayHostedWindows(live:)`), `sendLive` HE:5201-5218 (who and which rect: a visible one below its minimum skipped, a
tile's rect or a window's frame, centred when fixed; mechanism `observer.sized`, `setTileRect`, `setFrame`), `pumpLive`
HE:5226-5286 (landed or given up after `liveWait`; `owed`; free = owed, none in flight, a `liveFrame` since its last;
tiles first; held while busy, quitting, `liveHeld` or the one shown not shown; the counts; mechanism: bounds reads, the
sends, the sleeps of `tileEvery`/`liveFrame`), `liveFollowersList` HE:5289-5293, `LiveStats` HE:529-575, the forgotten
drag HE:1195, `heardSomething`'s `!liveOn` HE:6516.

**Core.** core/live.rs, `impl HostModel`: `live_start(now) -> Option<LiveStart>`, `live_end(now) -> Option<LiveStats>`,
`live_follow(now, p, rects) -> Follow { tell_rects, start_pump }`, `live_flights(out) -> usize` (in flight and exact:
the windows Swift reads), `live_tick(now, landed: &[(Handle, Option<Rect>)], gates: Gates, out: &mut [Send]) -> Tick {
n, sleep, done }` with `Send { Tile { h, tile, page } | Frame { h, page } | Centred { h, page } }`, `live_sent(h, at,
ok)`, `live_forgotten(now) -> bool`; `LiveStats::line()` the same words (quantile `sorted[min(n-1, n*q)]`, one decimal).

**FFI.** Typed: `margin_live_follow(core, double now, const MarginPlacement*, const MarginHostRect*, size_t)` (each page
frame, ≤ 120 a second), `margin_live_flights(core, uint32_t*, MarginRect*, size_t cap)`, `margin_live_tick(core, double
now, const MarginLanded*, size_t, uint8_t gates, MarginLiveSend*, size_t cap, double *sleep) -> size_t` (every
`tileEvery`, 2 ms, while anything's owed or in flight), `margin_live_sent(core, h, double at, bool ok)`; JSON
`liveEnd` (once a drag: the line and the numbers `e.lastLive` reads). Flights in a fixed array by slot, capacity taken at
`live_start`: nothing allocated per tick.

**Pinned by:** T/live-resize-tests.swift (45), T/split-real-use-tests.swift:347-362 (never in lockstep, together in a
tick), T/multi-host-tests.swift:125, T/split-tests.swift:50-61; screen `live-resize` (its p95 parsed,
S/LiveResize.swift:137-143), `live-resize-min`, `real-apps-min`. Ported: one in flight per host, the newest wins, tiles
first, the `liveWait` give-up, the `liveFrame` throttle, held frames, with a simulated clock; the line's text.

**Risks.** A window-mode send awaits `setFrame` (HE:5214): a `follow` can land meanwhile; the core keeps the pending
frame apart from the one being sent, as today. Each send's `at` is taken when it's sent (HE:5266): `live_sent(at)`. The
`%.1f` of the line: Swift's printf and Rust's `{:.1}` both round the exact binary value; a vector with ties pins it.
Measured against step 1's numbers (followed median and p95). ~120 lines deleted.

#### Part 7: strays, off screen, exits, close, recovery

**Today.** The poll's per-host counts HE:1212-1264 (process gone → `appQuit`; promoted; unread, `closedByItsApp` →
at least 2; at 2: parked and Margin's → gone, reopened at its next show; shown → gone, adopt or close; else
`windowGone`; unread → skipped; strays; in no Space → at once; queue `strayed`), overdue exits and an unanswered close
HE:1203-1210. `strayed` HE:5393-5421 (read again; both in place → nothing; Margin's window out too → parked; returns →
park only; the guard's "put back"; `bringBack` HE:5428-5468 with its in-place rule HE:5459-5466). `backOnScreen`
HE:5485-5545 (in place: once a show, the untried bring-forward rungs, then placed again; else make current and move in
flags; window mode: noted only). `leftFullScreenSign` HE:1562-1577, `leftFullScreen` HE:1582-1592, `reenterFullScreen`
HE:1597-1623, `noteOffScreen` HE:1628-1635, `noteOffPage` HE:1640-1657. `closeNow` HE:5663-5765 (asking → quit at once
HE:5670-5679; seen → freeze HE:5684; frame, out of full screen HE:5687-5697; shares its app, quits, close first
HE:5699-5704; home HE:5705-5708; where before the quit HE:5709-5724, read mid-way; Safari's close HE:5725-5745; the quit
kind HE:5749-5755; unfinished at quit HE:5756), `closesFirst` HE:5841-5843, `unfinished` HE:5805-5815. Exits: `exiting`
HE:408-409, `askQuitWatched` HE:5897-5902, `exited` HE:5905-5910, `takeBack` HE:5915-5923, `overdue` HE:5927,
`awaitExits` HE:5939-5952, `appQuit`'s second read HE:6044-6075. Recovery HE:6358-6462: mechanism over the marker; its
decisions are the same-launch predicates HE:6362-6382 and who's whose HE:6389-6391.

**Core.** core/watch.rs: `pub enum Place { Unread, Nowhere, InPage, Elsewhere }` (OS-neutral: Margin's Space is the
page's place on the Mac), `PollFacts { runs, regular, closed_by_app, bounds_read, place, margin_here }`,
`poll_host(now, h, &PollFacts) -> PollVerdict { AppQuit | Gone(GoneWhy) | Skip | Stray | Fine, promote: bool }`,
`stray(now, h, &StrayFacts) -> Stray { Nothing | Park | ParkOnly | PutBack }` (budget and the guard's key inside),
`off_screen(now, h, &OffFacts) -> OffScreen { Nothing | SayInPlace | InPlace | SayGiveUp | Act { make_current, move_in } }`,
`left_full_screen_sign(&SignFacts) -> Option<Sign>`, `note_off_screen`, `note_off_page`. core/close.rs:
`close_start(&CloseFacts, Exit) -> CloseStart { asking_quit, freeze, restore, quits, close_first }`, `home_after(closed,
window_mode, person) -> bool`, `before_quit(waits, in_margin, parked) -> BeforeQuit`, `unfinished(&UnfinishedFacts) ->
Option<bool /*member*/>`. core/exits.rs: `Exits` (asked, exited, overdue, take_back, dying) and `same_launch(then, now)
-> bool` (`SAME_LAUNCH` 2 s).

**FFI.** Typed per host per poll: `margin_model_poll_host(core, h, double now, const MarginPollFacts*) -> uint16_t`
(verdict and flags), `margin_model_stray`, `margin_model_off_screen`, `margin_model_note_off_screen/page`. JSON (rare):
`closeStart`, `exits*`; typed `margin_same_launch(double, double, bool have_then, bool have_now)`.

**Not moved:** the marker (H:195-281, `saveMarker` HE:6314-6337, `markerWindow` HE:6340-6356) and `recoverNow`'s
sequence: their fields are the Mac's (Space ids, tiles, anchors, Safari copies' ids); Windows has its own
(app/platforms/windows/src/marker.rs). Only their predicates move.

**Pinned by:** T/host-tests.swift:1888-1891, 2408-2445, 2539, 2737-2757, 3348-3433, 3629, 3674, 4373;
T/host-behaviour-tests.swift; T/screen-engine-tests.swift:131-189; T/host-reconciler-tests.swift. Ported: the poll's
counting and its order, each verdict's tree, the close predicates, the exits. Screen: `behaviours-*`, `core`,
`live-resize-crash`, S/Restore.swift, `real-apps` (Tirth's OK).

**Risks.** `strayed` reads again after the poll's read (HE:5398-5406): the verdict takes the fresh read. `closeNow`
reads `inMargin` after its first steps (HE:5712): `before_quit` is asked there. `appQuit` comes from NSWorkspace at any
moment, outside `serial`, and reads `busy` (HE:6061): passed in. ~170 lines deleted.

#### Part 8: all panes active and pane clicks

**Today.** `PanesActive.wanted` PA:66-80; `PanesActiveKeeper` PA:85-199 (`grace` 1 s, the loop's guard 60 in 10 s
PA:191-198, kept, touched, due, stopped; `step` PA:142-189, `releaseAll` PA:129-136, `gone` PA:119-126, `heardFront`
PA:116). The engine's side: `panesShown` HE:6140-6145, `frontChanged` HE:6149-6158, `queueActives` HE:6224-6234,
`stepActives` HE:6238-6268 (its closures `hosted`/`allowed`/`ending` HE:6250-6252, the due's `asyncAfter`),
`releaseActivesNow` HE:6271-6281, `sayActives` HE:6283-6297, `releaseCrashedActives` HE:6299-6310. `PaneClick.decide`
PC:100-117 (pure); `PaneClickCore.event`/`pressed` PC:217-325 (the tap's thread: `given`, claims, a cut pane's
redirect, the capped wait).

**Core.** core/actives.rs: `Keeper` (as PA, with `step(&mut self, panes: &[Pane], focused, front, margin, hosted:
&[i64], allowed: &[(i64, i64)], ending: &[i64], now, out: &mut Vec<Action>) -> Option<Stopped>`, `release_all`, `gone`,
`heard_front`, `due`, `kept`, `touched`). core/click.rs: `decide(point, cmd_or_ctrl, other_buttons, field_has_keys,
page_gets, panes: &[Pane], focused: Option<i64>) -> Click { Pass(Pass) | Hold(usize) | Tuck(usize) }`; the caller asks
the cover only for Hold or Tuck, so its order (a tucked pane's cover before ⌘/⌃, a held one's after) holds.

**FFI.** The keeper its own object (`margin_actives_new/free/step/release_all/gone/heard_front/kept/touched/due`),
typed arrays in, actions out into a buffer; a release's free-text why (Margin quits, off, Margin ends) stays Swift's.
`margin_click_decide(MarginPoint, uint8_t flags, const MarginPane*, size_t, int64_t focused, MarginClick*)`: no object,
no lock, nothing allocated (the tap's thread; macOS turns off a tap that takes ~1 s). `PassThrough.pageGets`
(PassThrough.swift:34) stays Swift (step 3's): its answer is a flag in. (Step 3 commit 2: it's the core's now, the
pure `margin_pass_page_gets` on the tap's own copy of the slot.)

**Pinned by:** T/panes-active-tests.swift's keeper part (from 123: ported to Rust, pure), its records and calls
(45-110: stay Swift); T/pane-click-tests.swift's decide part (105-128: ported), its timing tests (stay Swift). Screen:
`pane-clicks`, `panes-active`, `panes-active-crash`.

**Tirth's answer (2026-11-22): left in Swift.** Both are macOS-only (records through SLPS; WebKit's first-mouse
refusal): on Windows a first click goes through and there's no record to send. They're one copy already, so they stay
the Mac adapter's policy. Part 8 isn't done.

#### Part 9: duplicates removed

- `HostLayout.near` H:347-349, a copy of core/layout.rs:198; 42 uses in HE, `WindowKinds.near` (within 4) WK:117,
  MWC:1123 (within 2). After parts 1-7 the decisions' uses are Rust; the waits' predicates (HE:773, 3976, 4143, 4919,
  5241, 6474…) call a typed `margin_layout_near`.
- The strip rule, four copies beside core/kinds.rs:253-264: `isStrip(_:of:)` HE:3575-3577 (against `pageOf(host)`;
  differs from kinds.rs only with a zero area, which `outForGood` never sees) → `margin_kinds_is_strip` with the host's
  page; `Options.stripMaxHeight` HE:222 (WK:104 already reads the core's); `toolbarOf`'s literal 150 HE:1377 and
  `toolbarOver`'s height filter HE:1366 → `kinds::toolbar_of(b, window)` on `STRIP_MAX_HEIGHT`.
- The sidebar's least width: `sidebarRect` HE:3580-3584 (40), a copy of front.rs:146-150 (`SIDEBAR_LEAST`) → `front::sidebar`
  made public, typed; `coversSidebar` HE:3594-3599 with it as `front::covers_sidebar(b, p, share)`.
- The 0.1 s throttle HE:6516 = schedule.rs:17 `FAST` → `schedule::wake_due(now, last, live_on)`.
- The `tucked` copy in `sayHostedWindows` HE:2268 → `lying_under(h, Some(window))` (part 3).
- Not in the list, found: the same-launch 2 s rule five times (HE:6020, 6303, 6365, 6374, 6380) → `exits::same_launch`;
  `liveFollowers` HE:646-649 and `liveFollowersList` HE:5289-5293 (who follows a drag, twice) → one; the hold twice
  (part 1); `toolbarRoom` 52 HE:150 = `SAFARI_TOOLBAR` app/shared/ui/behaviors/split.ts:51 (TS: stays until the build
  writes the core's constants for the UI, as 1.1 noted for the app keys) → core `TOOLBAR_ROOM`.
- Cost, not a duplicate: `nextPoll` is a JSON call every poll (HC `nextPoll`, HE:6529-6531), as are the reconciler's
  `decide` per host (HE:1532) and the front look (HE:2114): `nextPoll` becomes typed here; the other two are noted for
  a later look (measured first, not changed in this step).

#### Order (one commit each; `npm run test:quick` each; the gate and the screen suite before the merge)

| # | Part | Swift deleted | Needs | Measured after |
| --- | --- | --- | --- | --- |
| 0 | Baseline: `idle-cost`, `idle-profile` (footprint), `live-resize` (followed median/p95), `pane-clicks` (ms a press), a switch (T/host-tests.swift:1831, the real log); the counting-allocator test in margin-ffi | 0 | | |
| 1 | 9: duplicates needing nothing new (near, strip ×4, sidebar, FAST, same launch, TOOLBAR_ROOM, typed nextPoll). **Done 2026-11-22** (step2/parts-9-1a; `tucked` left for part 3; idle-cost not measured yet: no screen suite on that branch) | ~40 | | idle-cost |
| 2 | 1a: the model (handles, fields into the core, computed properties, options). **Done 2026-11-22** for `Host`'s fields (step2/parts-9-1a); the engine's own state (`visible`, `shown`, the hold…) and `options`' configure wait for 1b, where the decisions that read them move; idle-cost and live-resize not measured yet | ~15 | | idle-cost, live-resize |
| 3 | 5: app minimums. **Done 2026-11-22** (step2/parts-5-1b; `appKey` and the per-process version read stay Swift: the OS's; `shownMinimumWidth` with 1b, it reads the visible set) | ~70 | 1a | |
| 4 | 1b: the layout's decisions. **Done 2026-11-22** (step2/parts-5-1b, two commits: the layout, the one shown, the hold and applyLayout's decisions; then `bringIn` and the window-mode frame. `visibleHost(at:)`, `livePage`, `belowSaid`, `liveCandidates` and `focus`'s card rule left for parts 3 and 6; a switch's time not measured on the real screen: no screen suite on that branch) | ~175 | 1a, 5 | a switch |
| 5 | 3: cut panes and the slide. **Done 2026-11-23** (step2/parts-3-2, two commits: the core's rules with CGRect's edge rules beside the Swift, then the Swift switched and its copies deleted; `fitted` stays a two-line Swift composition of the core's frame, `overPaneItLiesUnder`'s unread-list case reads the window server as before; the slide's 150 ms and one rect a frame unchanged, its sleep Swift's) | ~130 | 1b, 5 | |
| 6 | 2: window order. **Done 2026-11-23** (step2/parts-3-2, one commit: the order wanted, `overlapping` with the toolbar's room, the violated pairs and the raises as one plan made before the first raise, as the Swift did; the window server's order and the confirm's check typed; the ladder after a failed confirm, the raises and their waits stay Swift) | ~55 | 3 | |
| 7 | 4: the budgets and the full-screen ladder. **Done 2026-11-23** (step2/parts-4-7, two commits: host/model/budget.rs, behaviour identical; then each budget's action counted toward the guard's 12-a-second hold, the one change of step 2; a stray's returns already counted by its "put back"; screen suite not run on that branch) | ~45 | 1a | |
| 8 | 7: strays, off screen, exits, close, recovery's predicates. **Done 2026-11-23** (step2/parts-4-7, two commits: the poll's counts, strays and off screen in host/model/watch.rs; the close's tree, the exits and the recovery's launch rule in host/close.rs and exits.rs. Left in Swift: `noteOffScreen`, `noteOffPage`, the left-full-screen sign (lazy read chains), the recovery's `ours`/`safariMade` (lazy reads), the marker and `recoverNow`'s sequence; idle-cost not measured: no screen suite on that branch) | ~170 | 4 | idle-cost |
| 9 | 6: the live pump. **Done 2026-11-23** (step2/part-6, two commits: host/model/live.rs with the typed calls, then the engine switched and its copies deleted, `liveFollowers`' duplicate folded in; every write, read and sleep, the pump's task and the drag's numbers with their line stay Swift, the line word for word; live-resize and idle-cost not measured: no screen suite on that branch) | ~45 | 3, 5 | live-resize, idle-cost |
| ~~10~~ | 8: panes active, pane clicks: left in Swift (Tirth, 2026-11-22) | 0 | | |

About 1,000 Swift lines deleted (not ~1,500: most of the "mixed" lines are macOS mechanism that stays: the waits,
Accessibility, the private calls, the logs), ~2,300 Rust lines in (half of them tests). Budgets as step 1: idle < 0.5%
CPU, < 150 MB, a switch < 16 ms of Margin's work; a drag's p95 no worse than the baseline.

**Tirth's answers (2026-11-22):** the full-screen ladder stays per host and per run; the four budgets count toward
guard.rs's 12-a-second hold (part 4's one change of behaviour, pinned by new tests); part 8 left as the Mac's policy.
So about 830 Swift lines deleted.

### Step 2: done (2026-11-23)

Every part but 8 is done (parts 9, 1a, 5, 1b, 3, 2, 4, 7, 6, in that order; each part's DECISIONS.md entry has its
checks). What moved into the core (app/shared/core/src/host/, typed calls in app/platforms/macos/ffi/src/, nothing
allocated on the hot paths: ffi tests/no_alloc.rs):

- **The model** (model.rs): each host's state by a `u32` handle, `Host`'s fields computed properties over it; every
  app's window minimum per version (minimums.rs, minimums.json unchanged).
- **The layout** (model/visible.rs, layout.rs): Margin's page area's layout, the one shown, the focus, the hold (two
  kinds, one rule), `applyLayout`'s and `bringIn`'s decisions at each of their points, the window-mode frame.
- **Where each window goes** (model/panes.rs, geometry.rs `cg`): frames, cut panes, slides and their frames, "lies
  under", with CGRect's own edge rules.
- **Window order** (model/order.rs): the one plan made before the first raise, as the Swift did.
- **Margin's own corrections** (model/budget.rs, guard.rs): the four budgets and the full-screen ladder; each budgeted
  action counted toward the loop guard's 12-a-second hold (the step's one change of behaviour, Tirth's), and the
  tiles' sizing waiting for the hold's end instead of asking again and again.
- **The poll and the close** (model/watch.rs, close.rs, exits.rs): a window's reads counted, a gone window's tree,
  strays, off screen, the close's tree at each point, the apps asked to quit, the recovery's launch rule.
- **The live-resize pump's scheduling** (model/live.rs): who follows, the newest frame, one in flight per host, a
  frame's throttle, tiles first, the give-up wait, the drag held.
- **The duplicates** (part 9): near, the strip rule, the sidebar, the wake, the same launch, the toolbar's room, the
  typed `nextPoll`.

What stayed Swift, and why:

- **Mechanism, by design:** every write to the window server and Accessibility, every read, every wait and sleep (each
  at its old place and time: no new wait), the private calls, the tasks, the log lines (word for word: the core answers
  codes and numbers; the live-resize line and its `LiveStats` stay the engine's), Margin's window's tellings.
- **Lazy read chains**, which would read more (or differently) if decided up front: `noteOffScreen`, `noteOffPage`,
  the left-full-screen sign, the recovery's `ours` and `safariMade`, `overPaneItLiesUnder` without the poll's list.
- **The Mac's own:** the marker and `recoverNow`'s sequence (Space, tile and Safari ids), `appKey` and the version
  reads, `fitted`'s two-line composition, the ladder after a failed confirm, the raises and their waits.
- **Part 8** (panes active, pane clicks): the Mac adapter's policy (Tirth, 2026-11-22).

Checked part by part: the deleted Swift against the core on generated vectors before each Swift rule went (238,000
to 17 million checks a part), each harness proven by deliberate breaks; the app's checks unchanged (2040). Two
accepted differences, both in reads only: an unreadable app version is read once a call (the Swift read it at each look), and a
fronting's plan uses the state before its first raise throughout (a drag begun between two raises was mixed in
before). Still to do before the merge: the gate and the screen suite (`idle-cost`, `idle-profile`, `live-resize`,
`pane-clicks`, a switch), never run on these branches.

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

### Step 3 design (2026-11-23, at 8ffc2589)

Paths: **HS** app/platforms/macos/shell/HostedSession.swift; **HP** HostedPeek.swift, **L** Library.swift, **SH**
ShellHosted.swift, **SG** ShellHostedGlue.swift, **SW** Shell.swift, **MWC** MarginWindowController.swift, **MW**
MarginWindow.swift, **PT** PassThrough.swift, **UP** UIPush.swift, **PL** PageLayout.swift, **H** Host.swift, **HE**
HostEngine.swift (same folder); **core/** app/shared/core/src/; **ffi/** app/platforms/macos/ffi/src/; **W/**
app/platforms/windows/src/; **T/** app/platforms/macos/shell/tests/; **E/** tools/app-tests/; **S/**
tools/screen-tests/suite/; **§10** docs/HOSTED-WINDOWS-CHROMIUM.md §10. Line numbers as of 8ffc2589.

#### What every part shares

Step 2 could leave HostEngine's async operations in Swift and move decisions point by point. The session can't do
that: the Windows shell must run the session itself (§10 item 1, W/ has no Swift), so the **orchestration** moves,
not only the predicates. What stays the Mac's is what step 3's list above names: the protocols to the engine and to
Margin's window as the adapter's contract, Safari's own window mechanics, NSPasteboard, UserDefaults.

- **Two core objects.** `session::Session` (core/session/, one per app: every field of HS:385-433 and HP's state, the
  flows, the library's requests) and `page::Page` (core/page/, one per Margin window: MWC's page card, holes, ground,
  pointer slot, front watch, hello). The session never owns a Page: it talks to each Margin window through the
  `HostedWindow` contract (HS:211-274), which MWC implements over its Page and the tests' `FakeHostedWindow`
  (T/hosted-tests.swift:12) implements as today. So the 2,039 lines of T/hosted-tests.swift keep their stand-ins
  (`FakeHostedLinks` :124, `StubLaunchEngine` :202) and their reads.
- **Flows as Rust `async fn`s, run by the core's own executor.** The Swift flows have about 130 awaits (HS and HP;
  `show` alone: HS:627, 630, 634, 655, 658, 662 and `prepare`'s HS:1043-1070). A decision reads the state as it is
  between two awaits, and other inputs change that state meanwhile (`requested` by a click, `shown` by a host event).
  Written as `async fn`s the Rust is a line-by-line transliteration: each decision stays at the same point between the
  same suspensions. The executor is the core's (no runtime, no thread, no timer: `std::task::Waker::noop`, stable since
  Rust 1.85, the workspace's version, Cargo.toml:11):
  - **One serial queue** for what Swift enqueues (`enqueue`/`idle`, HS:444-455), **detached tasks** for Swift's
    `Task {}`s outside it (HS:1083, 1091, 1284, 1331, 1343, 1360, 1465, 1485, 1532, 1635, 1780, 1853, 1865; HP:116,
    385). Ready tasks run FIFO; a spawned task is first polled after the one that spawned it suspends, as a
    MainActor `Task` starts after the code that made it. So an **input never runs what it makes ready in the same
    call** (the Swift code that made the input goes on after it: a perform's other requests, the delegate's loop):
    its answer says `ready` and the facade ticks in the next main-actor turn (found in commit 4: run at once, 4 of
    the app's checks failed). Answers and ticks run what's ready, as an await resuming did.
  - **Suspension points** are exactly the Swift's awaits: an engine operation, a copy's request, a sleep. A task that
    starts an engine operation or a request ends the run: the answer hands the commands out (`start: [{ op, id, … }]`,
    a list: one poll can start two), Swift starts each at once (its synchronous prefix runs then, as `await
    engine.open` ran it: `Task.immediate`, macOS 26 and later; before, a task each and the run one turn later) and
    says so with `margin_session_tick(0)`; nothing runs in between (the core is held). It calls
    `margin_session_answer(id, …)` when one's done. Sleeps are the core's deadlines: the answer carries the earliest
    (`deadline`), Swift keeps one timer (slept with the session's `sleep`, a test's own) and calls
    `margin_session_tick(max(now, deadline))`; a sleep counts from the later of the clock and the last tick, so a
    test's frozen clock still wakes sleepers in deadline order.
  - `wait(seconds, done)` keeps HS:2478-2486's shape: steps of `every` (0.05 s), `left -= every`, the predicate read
    at each step (not a clock compare), so the same number of looks. `FirstOf` (HS:2611-2620, a request raced against a
    sleep) is a `first_of(a, b)` combinator.
  - **Re-entrance:** MWC's setters call back into the session synchronously (`setHosting` → `updatePage` →
    `setPageRect` → `onPageRect` → `pageRectChanged`, MWC:493-516, 476-486, MW:76-81, MWC:2193-2196, SG:238); the
    Library calls its delegate inside `perform` (L:217). Swift runs those at once, inside the call. Deferring them
    changes behaviour (in `prepare`, HS:1064-1065, the re-entrant `pageRectChanged` runs before `hostingWindow` is
    set and returns early; deferred, it would see it set and enqueue a placing Swift never did). So the session is
    re-entrant like the Swift class: its FFI entry points take `&Session`, the state is in `Cell`/`RefCell`, no
    borrow is held across a port call or an await (clippy `await_holding_refcell_ref` denied, and a rule: compute,
    drop the borrow, call out), and a re-entrant call while the executor is polling only changes state and queues
    tasks (the outer poll runs them, as a MainActor `Task` would start later). A Rust test adapter re-enters on every
    port call to catch a borrow held.
- **Ports (synchronous, answered during the call)** are the contract's synchronous members, called through C
  callbacks made with the object (`margin_session_new`), as `MarginDataNeed` (ffi/data.rs:16-26) and
  `MarginLinkWrite` (ffi/link.rs:36-43) are:
  - the engine's reads and quick acts (HS:59-132: `shown`, `hasHosts`, `isHosted`, `mode`, `shownWindow`,
    `fullScreenSpace`, `target(ofWindow:)`, `launchedPid`, `preparesOutOfSight`, `appRuns`, `wokenWindows`,
    `wokenParked`, `hide/stopHiding/releaseWoken`, `dragging`, `follow`, `shownFillsPage`, `showsAlone`,
    `liveFollowers`, `knownAppMinimums`, `minimum`, `visibleHost(at:)`);
  - Margin's windows (`window(id)` existing or not, the front one, `windowIds`, every `HostedWindow` member);
  - the links' reads (HS:319-334: `safariProfiles`, `windowIds`, `restoredWindowIds`, `linkEpoch`);
  - the OS's: `appName` (SG:190, 268), `marginActive`/`activateMargin` (SG:193-194).
- **Commands (asynchronous)**: the engine's operations (`open`, `show`, `close`, `pageRectChanged` with or without
  rects, `parkShown`, `activateShown`, `start`, `prepare`, `setLayout`, `focus(fronted:)`, `toolbarsRest`,
  `focusPages`, `slide`), a copy's request (`Ask { link, kind, payload }` built by core/hosted_browser.rs's `Ask`,
  hosted_browser.rs:129-338; answered `{ result }` or `{ error }` in the Swift's words: "not linked", the scrubbed
  refusal, the thrown error, SG:39-48, which `askAgain`, HS:2152-2155, matches), and the Safari waker's (part 2).
- **The library before and after step 4.** Reads go straight to the library's set in the core: the session is made
  with the `MarginLibrary` object (ffi/data.rs:255-270; Swift's `Library` outlives the session, both the Shell's),
  and a `LibraryView` trait reads items, targets, spaces, splits and windows by id from its `DataSet`
  (core/data/library.rs:30-80; `item(collection, id)` is a map lookup, never a whole collection built), the same
  values L:146-177 reads from its cache. Edits (`library.perform`: HS:504, 520, 534, 550, 1015, 1706, 2347, 2352,
  2357, 2363, HP:186, 357) are a **Perform** command answered in the same turn: Swift runs `Library.perform` (the
  rules in JavaScriptCore, LibraryRules.swift:47-69), whose delegate feeds its requests to the session
  (re-entrant as today: `requested` set and the handling queued before the flow goes on, as L:217 does inside
  `perform`), then answers `{ ok, result, error }`. Nothing else runs in between. **After step 4** the rules are
  margin-core's: `Perform` becomes a direct call inside the core with the same answer and the requests handled at
  the same point; `LibraryView` is unchanged; the Swift delegate path and the command go. Step 3 needs nothing of
  step 4, and step 4 touches no flow.
- **Options** (HS:337-358) stay the Swift struct the tests change after init (`session.options.resumesLast = false`,
  SG:187); `didSet` sends them (one JSON call per change). UserDefaults reads stay Swift (SG:184-189, 214-219).
- **Time:** the monotonic clock (`systemUptime`, HS:380) passed in; the wall clock's milliseconds for `notAfter`
  (HS:2178, 2192, HP:122) from the offset the link object already keeps (`set_wall_offset`).
- **Log lines** are the session's decisions, so built in Rust word for word (`note`, HS:457-461: the 200 kept in
  `done`, which the tests read, read through `margin_session_done`). HostID's logged form (`safari:p<djb2 % 10000>`,
  H:51-57) is ported with a vector, since HS's lines print `\(id)` (HS:716, 719, 724, 727).
- **Order of maps.** Swift's dictionaries iterate in no fixed order; Rust's `BTreeMap`s in key order. Every place
  this could show is where Swift picks the first of several and the invariant says there's one (`card(in:)`, HP:102:
  one card per window, HP:199) or sorts first (HS:573, 1851, 2015): never observable; noted in each part.
- **FFI.** One object: `margin_session_new(library, options, len, ctx, now, port)` (the ports: `now` typed, `port`
  JSON in and out, malloc'd, as `MarginDataNeed`), `_free`, `_input(json)` (the rare inputs), `_answer(id, json)`,
  `_tick(due)`, `_done`, `_idle`, `_rev(field)` (typed: a field's revision), and the typed hot calls of parts 7 and 12.
  Every answer: `{ start?, ready?, deadline, log?, reply?, error? }` (the commands to Margin's windows, the pushes and
  the ports went out during the call, in order). Panic-free as the others (a bad input is `{"error"}`, logged once a
  kind). The Swift `HostedSession` stays a facade with the same API and fields read from the core (as step 2's
  `Host`), so `session.shown[1]`, `session.open[...]`, `session.requested[w] = …` and `await session.idle()` in T/
  stay. While Swift flows still write a field the core's flows read (commit 4: `shown`, `open`, `safariWindows`, and
  `done`), the field is the core's and the facade's computed property reads it again only when its revision changed
  and writes the difference (`state` input: `put`, `del`); each part moves its fields in the same way. Swift's
  `enqueue` puts its bodies in the core's queue (a `Run` command at their turn): one queue for both while flows move.
  *As built (commit 5's follow-up, step3/typed-ports, Tirth's no-CPU-increase rule):* the ports a show asks are one
  typed callback (`MarginSessionCall`: a port's number, a window, a flag, three texts as bytes; texts and lists given
  back through `margin_port_out_text`/`_int`), the JSON `port` kept for the rare ones; `_input`, `_answer` and `_tick`
  write readiness and the deadline into a `MarginSessionStatus` and answer JSON only when there's more (commands, a
  reply); the facade's fields are read and edited as typed rows (`margin_session_rows`, `_edit_row`), not the `state`
  input. A switch's Margin-side CPU is now under the old Swift's (DECISIONS.md).
- **Windows** implements the same ports in Rust over its adapter (W/hosting.rs) and Margin's window (W/appwindow.rs),
  with no FFI: §10 item 1's `Session::handle(now, Input) -> Vec<Command>` is `_input`/`_answer`/`_tick` with the
  commands above; its `EnsureBrowserWindow` is the engine's `requestSafariWindow` (part 2) browser-keyed.

#### Part 1: the library's requests to hosting

**Today.** `library(_:wants:)` HS:465-474 (a show request's item in front at once, `cardLeaving`, then queued);
`showRequests` HS:417; `handle` HS:483-598 with `settleHosting` after each (HS:484). The four near-copies: `openPin`
HS:494-506, `resetPin` HS:507-523, `openFavorite` HS:524-536, `resetFavorite` HS:537-553. They differ only in: the
pin's `pinnedBy` vs the favourite's `favoriteId` (HS:503, 519 vs 533, 549); a reset navigates an open item's tab first
(`hostNavigate`, HS:510-512, 540-542) and isn't checked for being overtaken (an open is, HS:496, 526); an open says
"no item made" when `addItem` refuses (HS:505, 535), a reset returns silently (HS:521, 551). Then `showSplit`
HS:554-560, `closeTab`/`unloadTab` HS:561-576 (the next item in front at once, a split around it shown again),
`muteTab` HS:577-584, `mediaControl` HS:585-592, `clearToday` HS:593-594. `show` HS:604-686 (the split first,
HS:613; app HS:616-631, web HS:632-663, Margin's page HS:664-674; the rest HS:676-685), `close` HS:1728-1756,
`navigate` HS:2378-2385, `openApp` HS:2342-2370. The request type: L:55-63 (library.ts `Request`).

**Decision vs mechanism.** All of it is decision; the mechanism is the engine's operations and the copies' requests.

**Core.** core/session/requests.rs:

```rust
pub enum Request { Show(ShowAsk /*activateTab|newTab|restoreArchive|setSpace*/), Open { by: By, reset: bool, ask: ShowAsk },
                   ShowSplit { split: String, item: Option<String>, window: Option<u32> }, Close { item: String, next: Option<String>, target: Option<Target> },
                   Mute(String), Media { item: String, command: String }, ClearToday(Vec<String>), Other(String) }
pub enum By { Pin(String), Favorite(String) }       // one branch for the four (HS:494-553), the three differences as `reset`
impl Request { pub fn read(body: &Value) -> Option<Request>; pub fn shows(&self) -> Option<(&str, Option<u32>)>; } // HS:417, 469
impl Session {
    pub fn library_request(&self, r: Request);                   // HS:465-474 (sync), then queued
    async fn handle(&self, r: Request);                          // HS:483-598
    async fn open_by(&self, ask: &ShowAsk, by: &By, reset: bool);
    pub(crate) async fn show(&self, item: &str, url: Option<&str>, target: Option<Target>, window: Option<u32>);
    pub(crate) async fn close(&self, item: &str, target: Option<Target>);
}
```

`Target` is L:23-51's `ItemTarget` (web/app/margin) with its JSON rules (`marginPages`, L:28).
*As built (commit 5):* `Request` is a struct (its type and body, the Swift's `LibraryRequest`), matched by type in
`handle`, not an enum read up front; `By` and `open_by(r, by, reset)` as above. `ItemTarget(json:)`'s rules are
target.rs's (the Swift enum built from the core's answer). The design's sketch left out what the moved flows still
ask of the Swift of later parts: one `swift` port by name (the card's leaving and returning, `pinnedOrFavorite`,
`settleHosting`, `refreshLoading`, the layout's reads and clearing, the elsewhere card's) and a `Swift` command for
the async ones (`prepare`, `showSplit`), each gone as its part moves; the engine's operations are an `Engine` command,
a flow Swift calls a `call` input answered by a `Reply`. The notes go out through a `log` port as they're made (in
the answer they came after what the flow did meanwhile), and the facade holds a window the core named until nothing
is under way (the Swift flows held theirs).

**FFI.** `{"type":"library","requests":[…]}`, one per `perform` that asked something (a click: rare). `show`'s copy
requests are `Ask` commands (one or two a switch).

**Must not change:** a request's item drawn in front before its turn (`requested`, HS:469-472) and a show overtaken
before it started skipped with its line (HS:477-481); a failed show drawing the item shown before (HS:609-610);
`show`'s six `defer`s and their order (HS:610, 619, 622, 638, 644: the loader's words cleared last, and never for an
item asked for since, HS:622). Rust has no `defer`: each flow is an inner `async fn` whose every return goes through
the outer one's after-steps, in Swift's reverse order of declaration, pinned by the loader sequences the tests read
(`window.showings`, `window.loadings`).

**Pinned by:** T/hosted-tests.swift `hostedTests` (695-1155: 763-801, 824, 918-925, 970, 1001-1018),
`hostedSupersedeTests` (1947-2039), T/library-tests.swift:85-86; E/e2e-hosted.swift:136 (a pin's press). The four
pin and favourite paths have **no Swift test today**: commit 0 adds them (open and reset, each with an item or not,
`addItem` refused, overtaken) against the Swift before the move. Screen: `core` (switches, palette).

**Windows:** §10 item 1's "library's requests (show item in Margin window, close, open pin…)" as they are.

**Risks.** `closeTab`'s next item (HS:566-576) is shown in `windows.first` of a dictionary's filter: one window
shows an item at a time in practice; Rust takes the lowest id (noted). ~260 Swift lines deleted (HS:465-686,
1728-1756, 2342-2385 less the facade).

#### Part 2: choice of host and profile, overtaken picks, the cycle hold

**Today.** `resolve` HS:2471-2476 (its own, else the default profile's copy, else the first linked);
`profileFallback` HS:2031-2044 (the default profile when a space's can't be opened, its note); `DefaultBrowser`
HS:198-209; the host of an item HS:616-663 (`app:<bundle>`, `safari:<profile>`); a layout's roles HS:848-859 (a
profile's first web item main, a card its card, the next ones `#pane1`…`#pane3`, a fourth refused); `overtaken`
HS:477-481, `supersededBy` HS:692-695, the open's `wanted` HS:705-707, `host` HS:699-731 (its result's five cases); the
cycle hold HS:623-629 (`cycleWindow` 1.0 s, `cycleHold` 0.35 s, HS:355-356; `cycled` HS:689 from SG:336);
`linkWanted` HS:1994-1998 and the preparation's own `wanted` HS:1793. The engine's asks of the session (SG:130-136,
HE:481-499): `requestSafariWindow` HS:2096-2149 (its payload by role HS:2108-2114, the stale-copy retry HS:2122-2138,
`askAgain` HS:2152-2155), `closeSafariWindow` HS:2158-2171, `safariFullScreen` HS:2176-2187 (already built by
hosted_browser's `SetWindowState`), `safariFocus` HS:2191-2195, `safariLinked` HS:1913-1991.

**Decision vs mechanism.** The choices above are decisions. How a profile that has no window is woken (Safari's menu
pressed, `openProfileWindow`; the ladder of when to press, HS:1937-1982; the woken windows parked and closed,
`closeWoken` HS:2060-2081, `releaseWokenSpace` HS:2084-2093; `unopenable` HS:2004; `profileNamesChanged`'s reset
HS:2006) is Safari's own mechanics, which step 3 leaves the Mac's. It moves into a Swift `SafariWaker` (the waker's
state: `wokenByMenu`, `wokenAtLink`, `wokenLinkedAt`, `wokenHeld`, `unopenable`, `swept`), which reads the session's
predicate at each look through a typed call.

**Core.** core/session/choice.rs:

```rust
pub fn resolve(profile: Option<&str>, linked: &[&str]) -> String;                          // HS:2471
pub fn default_browser(setting: Option<&str>) -> (&'static str, &'static str, bool);        // HS:202 (bool: supported)
pub enum Linked { Yes, No, Unopenable }                                                     // the waker's answer
impl Session {
    async fn profile_fallback(&self, p: &str, space: Option<&str>) -> String;              // HS:2031-2044
    pub fn link_wanted(&self, p: &str, for_prepare: bool) -> bool;                          // HS:1994 or HS:1793
    async fn cycle_held(&self, w: u32, item: &str, app: &str) -> bool;                      // HS:626-629
    fn role_for(&self, used: &mut RoleUse, profile: &str, role: HostRole) -> Option<hosted_browser::Role>;
    pub(crate) async fn request_window(&self, browser: &str, profile: Option<&str>, role: Role) -> Option<WindowMade>;
    pub(crate) async fn close_window(&self, profile: Option<&str>, id: i64) -> bool;
}
```

**FFI.** The engine's asks become session inputs with an id, answered by a command when their task ends
(`{"type":"engineAsk","id","ask":"newWindow","profile","role"}` → `engineAnswer`): rare (a window made). The waker's
`EnsureLinked { browser, profile, prepare }` is a command answered `Linked`; while it runs the waker calls the typed
`margin_session_link_wanted(s, profile, len, bool) -> bool` every `every` (0.05 s): no allocation.
*As built (commit 5):* `margin_session_link_wanted(s, profile, len)` (HS:1994's; the preparation's own `wanted`,
HS:1793, stays Swift with `prepareBrowser` until part 6) and `margin_session_open_wanted(s, window, item, len)` (a new
app's open, read by the engine while its window is awaited). The engine's asks are `call` inputs (`requestWindow`,
`closeWindow`, `safariFullScreen`, `safariFocus`) answered by a `Reply` command; `cycle_held` is inline in `show`,
`role_for` and `request_window` as the design says, `RoleUse` part 3's.

**Must not change:** "evidence decides, time only paces" (HS:1904-1912), the at-most-two stale retries waited on the
link's epoch (HS:2122-2138), a fourth pane refused (HS:852), the default profile's fallback note (HS:2036-2042), a
cycle's pick of an app not running held 0.35 s and never started when passed over (HS:623-629).

**Pinned by:** T/hosted-tests.swift `safariWakeTests` (576-694, stay Swift against the waker),
`preparedBrowserTests` (261-575), 1115 (the fallback), `hostedSupersedeTests` 2002-2020 (the cycle). Ported:
`resolve`'s order, the roles, `askAgain`'s words, the cycle hold with a simulated clock.

**Windows:** host ids are hosted_browser's `<browser>:<profile>[#card|#paneN]` (hosted_browser.rs:93; the same as
H:47-73); `EnsureLinked` is its Chrome or Edge started with `--profile-directory` and its hello awaited (§4.4).
Chrome and Edge stay "isn't hosted yet" (HS:633, 847, 2343) until §11 step 7: one `browser == "safari"` check each.

**Risks.** The waker runs a loop the session's queue waits on (`await safariLinked`, HS:634, 1794, 2034): it's a
command like any other. ~90 Swift lines deleted, ~250 moved into `SafariWaker` (they stay).

#### Part 3: layouts and splits

**Today.** `setLayout` HS:741-745; `showSplit` HS:757-784 (panes: web pages and each app once; main the pane that
keeps its window; `paneAddress`/`paneItem` HS:773-778, 786-790, read by `requestSafariWindow` HS:2111-2114);
`paneRects` HS:795-803 (waited `pageWait` 3 s, remeasured each look); `paneHostRects` HS:806-811;
`pageAppMinimums` HS:814-820; `refreshPaneMinimums` HS:822-828; `applyLayout` HS:830-967 (the parts HS:837-864,
`showTab` HS:867-874, tabs first for windows there HS:876, `prepare` HS:878, the split's rects HS:880-888, room
HS:894-900, `panesLaying` HS:908-912, `revealHeld` HS:916-918, the engine HS:919, the tabs after HS:921-926, the
pages' focus and toolbars HS:927-934, main not shown HS:935-943, the failed panes out HS:946-955, the layout kept
HS:956-966); `paneLeast` HS:971 (220×220, Arc's), `noRoomReason`/`isNoRoom` HS:975-976, `noRoom` HS:982-996,
`leaveSplit` HS:1004-1020, `forgetInLayouts` HS:1023-1032, `prepare` HS:1036-1075 (one window hosts: the other's
item parked and pictured first, HS:1037-1051; full screen, its layout, hosting, the page area, HS:1053-1074).

**Decision vs mechanism.** All decision; the engine's `setLayout` is step 2's.

**Core.** core/session/layout.rs: `pub struct Layout` (HS:148-157), `pub const PANE_LEAST: Size`, `NO_ROOM_REASON`,
`pub fn is_no_room(why: &str) -> bool`, `pub fn no_room(panes: &[(&str, HostRole, Option<Rect>, Option<Size>)],
page: Rect, had: &BTreeSet<String>) -> Option<Vec<String>>` (pure), and the session's `async fn apply_layout(w,
main, main_rect, extras, focused, split)`, `async fn show_split`, `fn leave_split` (its `removeFromSplit` performs and
the toast push, HS:1015-1019), `fn forget_in_layouts(host)`, `async fn prepare(w, target) -> Option<(Placement,
u64)>`. The engine's failure reasons cross as the engine's strings (`isNoRoom` matches HE's "below its window's
minimum", "no room for it").

**FFI.** No new calls: a layout is the engine's `setLayout` command (rare: a split's change, a card).

**Must not change:** room checked before any window moves (HS:889-900), the newcomers leaving first and main never
(HS:990-995), the focus kept by the pane that had it when the asked one failed (HS:953), a card's rect never a pane's
(HS:887), the reveal held until the new pane's tab is in and its toolbar rests (HS:913-934).

**Pinned by:** T/split-real-use-tests.swift (`splitRoomTests` 26-45 ported to Rust; the session 46-254, minimums
258-307, drags 308-365, glue 366-384 stay), T/split-tests.swift `splitSessionTests` 94-365,
T/multi-host-session-tests.swift, T/peek-split-tests.swift, T/screen-card-tests.swift; E/e2e-split.swift
`glueSplitScenario`; S `cut-panes`.

**Windows:** §10 item 1's "the page's layouts per Margin window (page area, pane rects, card rect)", its `Show
{ visible, focused }` (the engine's `setLayout`), `PaneCut`.

*As built (commit 6):* session/layouts.rs (`show_split`, `pane_rects`, `page_app_minimums`, `refresh_pane_minimums`,
`apply_layout` with its three after-steps run only once reached, as Swift's `defer`s registered part-way, `leave_split`,
`forget_in_layouts`, `prepare`), writing commit 7's `layouts` field (the facade reads its rows; `pressedHost`'s write
goes back as its difference). The card's layouts are this flow now (card.rs calls it; commit 7's interim `applyLayout`
Swift command is gone), its parts the core's (the card's part and its hostShow payload, its window's rect in a
placing and a drag's frame, its rect kept after a placing). `paneAddress`/`paneItem` are the core's (`PaneOpens`, read
by `request_window`: the interim `paneFor`, `hasLayout`, `clearLayout`, `layoutsWith` and the `prepare`/`showSplit`
Swift commands are gone). What it still asks of later parts' Swift goes through the `swift` port by name: the
elsewhere card's (`showElsewhere`, and `pagePicture` a Swift command) and the cut panes' (`paneCuts`); the loading
bar's `panesLaying` and `revealHeld` are commit 9's core fields, written by this flow. Two things the sketch lacked:
the engine's layout results come with their Swift description (`"\(result)"`, which names the module: the layout's
line prints it), and a placement Margin's window gave the core goes back to the engine as the window's own value (a
token the port answers with it), never one made again of JSON numbers. `prepare`'s ports are typed (a show's: the
window's number, full screen, layout mode, placement, hosting, Space, every app's minimum, `MarginSessionCall` 40-47).
`HostedSession.applyLayout` stays the API `setLayout` queues (the tests'; a `call`).

**Risks.** `applyLayout` suspends at seven kinds of point and reads `layout`, `engine.isHosted` and `shown` between
them: transliterated, never planned up front. `noRoom`'s edges are float compares with 1 pt slack (HS:984-985):
vectors at the edges. ~250 Swift lines deleted.

#### Part 4: the preview card and Quick Tab

**Today.** HP: `PeekCard` 30-43, constants 46-52 (`cardIdle` 15 min, `cardRectWait` 0.3 s, `cardCoverWait` 0.05 s),
`defaultCardRect` 56-62, `pinnedOrFavorite` 67-70, `cardPart` 74-81, `cardShowPayload` 84-91, `cardLoadingStep`
95-99, `card`/`openCard` 102-103; the copy's word: `peekOpen` 111-139 (answered at once, by its `notAfter`, only from a
window Margin hosts for that profile whose Margin window shows one of its items), `peekCancel` 142-145, `cardPage`
148-156, `cardKey` 159-163; the page's: `littleArcOpened` 168-173, `littleArcGo` 176-193; `showCard` 197-209,
`placeCard` 213-240, `dropCard` 243-246, `cardLeaving` 250-265, `cardReturning` 268-277, `cardRectChanged` 280-285,
`splitOf` 289-292, `cardHostRects` 296-299, `cardPlaced` 301-305, `closeCard` 312-337, `closeCardForKey` 341-345,
`expandCard` 349-380, `cardHistory` 383-386, `cardHostGone` 392-406, `closeIdleCards` 409-419, `tellPage`/`pushPeek`
423-432, `webAddress` 434-437. Routed from SW:269-279 (pushes), HS:2563-2587 (`peek.*`, ⌘W), SG:362-365 (a hosted
card's ⌘W).

**The state machine** (one card per profile, attached to a Margin window): opened (`open`, `!ready`, `fresh`) →
laid out (`ready`, `!fresh`, `rect`) → hidden with its opener by a pick (`!open`, `hiddenBy`) → shown again when
the opener is (`cardReturning`, unless the pick was the opener itself) → closed (forgotten, its window parked, its tab
closed by `hostCardClose` after `cardCoverWait`) or expanded (a new item, its tab moved, `hostPromotePeek`) or dropped
(no room, no page area). Quick Tab's field is `littleArcs[window]`.

**Core.** core/session/card.rs: `pub struct Card` (HP:30-43's fields), `pub fn default_card_rect(page: Rect) ->
Rect` (Swift's `.rounded()` is half away from zero, as Rust's `f64::round`), `pub fn web_address(s: &str) -> bool`,
and the session's flows above, one `async fn` or `fn` each, same names.

**FFI.** The copy's pushes arrive as `{"type":"push","link","windowId","msg"}` (part 10); the page's `peek.*` as
`{"type":"ui",…}` (part 10). Rare.
*As built (commit 7):* until part 10 routes the pushes and the UI's requests in the core, the facade keeps
HostedPeek's calls and each is one `{"type":"peek","kind",…}` input (`open`, typed too as `margin_session_peek_open`,
which the Mac uses: a click's id, address and time, no JSON; `cancel`, `page`, `key`, `quickTab`,
`quickTabGo`, `close` and `closeForKey` answering whether one was closed, `expand`, `history`, `hostGone`, `idle`,
`rect`). The flows are card.rs's, the `Card` (and `cards`, `littleArcs` and the core-only `card_used_at`) state.rs's.
The design left out three things the flows need: the layout they read is part 3's, so its field (`layouts`) moved to
the core now, Swift's applyLayout still writing it through the facade and laying out through a `Swift` command
(`applyLayout`) until commit 6 (done: the card's flows call layouts.rs's `apply_layout`); Quick Tab's new tab and Expand's item are library edits made inside a synchronous call,
so a `perform` port (the delegate's requests re-entrant, as `Library.perform` ran them); and `tellPage`'s title is
Foundation's `URL.host` (card.rs `web_host`, ported with Foundation's answers as vectors; a host outside ASCII is the
OS's IDNA, a `urlHost` port). The ports: `cardRect`, `hostedPage` and the wall clock typed (a peek open's path), `idna`,
`urlHost`, `perform` JSON; `pinnedOrFavorite` a typed read (`margin_session_pinned`) and a card's address and
freshness a typed field (`cardPages`, read only, moving with `cards`) for Swift's layout.

**Must not change:** the card's page never Safari's new-tab page (HS:2111), `peekAnswer` sent before the card is laid
out (HP:137-138), the page told before the window goes (HP:322-326), one card per window (HP:199).

**Pinned by:** T/peek-session-tests.swift (12-241; `defaultCardRect` 193-199 ported), T/peek-split-tests.swift,
T/screen-card-tests.swift. Ported: the rect, `webAddress`.

**Windows:** §10 item 1's `cardPage` and `peekOpen` inputs; §4.2 "the card: its rect is a hole".

**Risks.** `webAddress` is Foundation's `URL(string:)` (HP:435: at most 2,048 Characters, a scheme of http or https):
Rust has no Foundation; a small RFC 3986 check of the scheme and the characters `URL(string:)` refuses, with vectors
run against the Swift first (spaces, Unicode, `http:` alone, 2,048 grapheme clusters vs scalars). hosted_browser's
`valid_shown_url` (hosted_browser.rs:31) is another rule (it allows `about:blank`): not merged. ~330 Swift lines
deleted. *Corrected in commit 1:* since macOS 14 `URL(string:)` percent-encodes invalid characters, so only the
authority refuses an http(s) text (a port that isn't digits, something after an IP literal, an IP literal's address,
a host outside RFC 3986's characters); a host with letters outside ASCII goes through ICU's UTS #46 IDNA, which the
core can't port: session/card.rs answers "the host's IDNA decides" and the OS answers that one question (the Mac:
`URL(string: "http://<host>/")`, SessionRules.swift). The cap counts scalars (step 1's rule).

#### Part 5: an item shown in another Margin window

**Today.** `elsewhere` HS:1409, `showElsewhere` HS:1410-1422 (its card's name: the app's, else the title, else the
address, 120 at most), `pagePicture` HS:1425-1442 (the copy's `hostPicture` raced against `pictureWait` 0.4 s,
HS:352), `prepare`'s move HS:1037-1051, `focused` HS:1444-1458, `windowClosing` HS:1462-1469, `windowClosed`
HS:1474-1490, `forgetElsewhere` HS:1493-1498; wired SG:226-231.

**Core.** core/session/elsewhere.rs, the same five functions; the race is `first_of(ask, sleep(0.4))`.

**FFI.** `{"type":"windowFocused"|"windowClosing"|"windowClosed","window"}` (rare); `windowClosing`'s `done` is a
command answered when the park is over.
*As built (commit 8):* `windowClosing` carries Swift's `then` and is answered at once (`reply`: called later, or close
now); the `Done { then }` command calls it once the park is over. `prepare`'s move (HS:1037-1051) is commit 6's: its core
`prepare` calls `page_picture`, `show_elsewhere` and `clear_elsewhere` directly. The picture's wait is a deadline on the session's clock (the Swift's was
`Task.sleep` directly: the same in the app).

**Must not change:** the card cleared only once the window hosts again (HS:1068: the card straight to the loader),
the move never held for the picture (HS:1437-1440).

**Pinned by:** T/hosted-tests.swift 1440-1553 (elsewhere, closed, picture). **Windows:** several Margin windows (⌘N)
on Windows reuse it as is; until then one window never has an elsewhere card.

**Risks.** The picture's rule: Swift accepts any `data:image/jpeg;base64,` or `…png…` prefix (HS:1435);
hosted_browser's `picture` (hosted_browser.rs:392) also caps it at 8 MiB. Default: the Swift's rule (open question 4).
~70 Swift lines deleted.

#### Part 6: the start screen, resumeLast, settleHosting, the launcher, the default browser made ready

**Today.** The state: `Startup { waiting, preparing, done }` HS:1507-1508, `startupWaiting`, `startupShown`,
`startupStuck`, `startupFailure`, `startupSkipped`, `startupRetries`, `preparedSetting` HS:1510-1520, the words
HS:1509, 1521-1522. `startupRetry` HS:1525-1533, `startupSkip` HS:1537-1541, `holdStartup` HS:1546-1567 (`startupWait`
15 s, then the words and the two choices, then `wait(.infinity)` until skip, a pick, a retry or ready),
`preparationOver` HS:1568-1572, `resumesLast` HS:1573-1574, `lastItem` HS:1578-1592, `loaderApp` HS:1595-1601,
`resumeLast` HS:1603-1652, `resumeShow` HS:1654-1676, `settleHosting` HS:1681-1695, `openLauncher` HS:1703-1715,
`leaveMarginPage` HS:1718-1724, `prepareBrowser` HS:1768-1834 (its four steps). The shell's side:
`prepareBrowserOnce` SG:209-220, `holdsMenu` SG:264, the keys' gate SG:322, the poll's sweep HS:1846-1870 (its
`closeIdleCards` and `closeIdlePaneWindows`, HS:1847-1848, 1879-1900, are the session's; the restored windows' sweep
HS:1856-1869 is the waker's, part 2).

**The state machine.** `waiting` → `preparing` (`prepareBrowser` began) → `done` (prepared, skipped for a reason, or
not possible); beside it the start screen: shown with a window's last item gated on it (`resumeLast` HS:1625-1629) →
held up (`startupStuck`, after `startupWait` or at once for `startupNoLink`) → retried (its limit anew; the
preparation run again only if it was given up, HS:1529-1532) or skipped → gone, then the last item shown if nothing
else was picked meanwhile (HS:1643-1650).

**Core.** core/session/start.rs: `pub enum Startup`, `struct StartScreen` (the seven fields), `pub fn last_item(view,
window) -> Option<(String, Target, String)>` (note its tie: `.max` with the ids compared the other way, HS:1581, so
among equal `lastUsed` the smallest id wins: a vector pins it), `pub fn loader_app(&Target) -> Option<&str>`, and the
flows `resume_last`, `resume_show`, `hold_startup`, `prepare_browser`, `settle_hosting`, `open_launcher`.

**FFI.** `{"type":"windowOpened","window"}` (`onOpen`, SG:259), `startup.retry`/`startup.skip` as `ui` inputs,
`{"type":"prepare","setting"}` (SG:219), `{"type":"poll","now"}` from `track` (SW:339, at the shell's schedule:
1.5-2 s at rest), and a typed `margin_session_start_screen(s) -> bool` read by `holdsMenu` and the keys' gate
(each key press).
*As built (commit 8):* `startupRetry`, `startupSkip`, `preparationOver` and `lastItem` (a read) are inputs; the
preparation is a flow its Swift caller awaits (`call` `prepareBrowser`), the launcher one it doesn't (`openLauncher`:
its Settings edit answered in the same turn); `settleHosting` from the Swift flows of later parts and the engine's
events is `margin_session_settle`; the waker's look for the preparation is its own typed call,
`margin_session_prepare_wanted` (the engine's `shown` read through a typed port, `engineShows`), not a flag on
`link_wanted`. The design's `poll` input isn't built: nothing of the poll's sweep is part 6's after all
(`closeIdleCards` is part 4's, `closeIdlePaneWindows` reads part 3's layouts, the restored windows' sweep is the
waker's); it comes with them. The browser's start is a command handed out when the flow next suspends and awaited
later (exec.rs `begin`: Swift's `let t = Task { … }` … `await t.value`).

**Must not change:** nothing usable before the browser is ready unless skipped (SG:322), the words said at once when
the extension didn't link (HS:1805), the last item shown behind the loader from the window's first frame
(HS:1621-1633), no launcher for a frame while a pick is next (HS:1684), Margin re-activated after a preparation that
took the focus (HS:1825).

**Pinned by:** T/hosted-tests.swift `hostedResumeTests` (1156-1576: resume 1203-1309, start 1386-1425),
`preparedBrowserTests` (448-454: the start screen); E/e2e-glue.swift `glueResumeScenario` (1502-); S `core`'s
`relaunch` (S/Scenarios.swift:186).

**Windows:** §4.6's start ("Getting you started", `startup.retry`, `startup.skip`, "as on the Mac"): the same flows.

**Risks.** `holdStartup` runs outside the queue (HS:1635) while `resumeShow` queues (HS:1655): the executor keeps
that split. Its `wait(.infinity)` (HS:1559) looks every 50 ms for as long as the start screen is held up (20 wakes a
second while it's up): kept as is (open question 5). ~230 Swift lines deleted.
*Tirth's answer 5 (commit 8's second commit):* held up, it re-checks only when what it reads changes (the start
screen's state, a window's item asked for: each changed by an input or a flow's step), nothing wakes while it's up and
idle; the first `startupWait` (15 s, before it's held up) keeps its looks.

#### Part 7: the page area moving

**Today.** `pageRectChanged` HS:2237-2254 (live: each page area to the engine at once with the panes' and the card's
rects; else one placing per burst, `placing`, the newest placement read when its turn comes), `placeAgain`
HS:2262-2288 (the rects kept in the layout; a placing that left the window out of full screen retried once after
`refitRetryAfter` 1.5 s, HS:349, behind the loader), `sidebarResizing` HS:2292-2320, `dragLine` HS:2324-2337. The
window's side: `updatePage` MWC:476-486, `setPageRect` MW:76-81, `hostedPlacement` MWC:1138-1150, the page's `layout`
op MWC:1910-1925 and `onPanes` SG:257.

**Core.** In the session: `page_rect_changed(w)`, `place_again(w)`, `sidebar_resizing(w, on, divider)`,
`drag_line(...)`. The page area itself is the Page's (part 11): `PageLayout` parsed in the core (PL:32-69 into
core/protocol.rs:51-63, which lacks `outside`, `hosted`, `fills`, `split`, `panes`), `page_rect` (MW:189-199),
`hosted_placement` (MWC:1138-1150), `idle_placement` (MWC:1154-1158).

**FFI.** The hot path of the step: during a drag the page reports its layout every frame (≤120 a second). Typed:
`margin_page_layout(page, bytes, len) -> uint8_t` (the op's JSON, as the page sends it, parsed once in Rust: its
changes as flags) and, when the page rect changed, the session's `margin_session_page_rect(s, window)` reads the
placement and the panes' rects from the window's Page in the core (no JSON), deciding `follow` and calling the
engine's typed `MarginFollow(ctx, const MarginPlacement*, const MarginHostRect*, size_t)`. Nothing allocated per frame
(the counting-allocator test, app/platforms/macos/ffi/tests/no_alloc.rs, extended).

**Must not change:** one placing per burst, the newest; nothing placed mid-drag but the live follow; a failed placing
never drops the item (HS:2256-2261).

**Pinned by:** T/hosted-tests.swift `liveSidebarResizeTests` (1696-1746), `sidebarResizeTests` (1747-1895),
`hostedFrontTests` (1577-1695, 1678 the failed placing), 1001; T/split-real-use-tests.swift drags (308-365); S
`live-resize` (its p95, S/LiveResize.swift:137-143), `core`'s `sidebarDrags`.

**Windows:** §4.2's `layout` op; W/hole.rs's `page_layout` and `PageLayout` (W/hole.rs:162-177) go for the core's
(one parser of the op).

*Commit 1 did:* the parse is protocol.rs `PageLayout::from_geometry` with the missing fields (`outside`, `hosted`,
`fills`, `split`, `panes`; `rounded` leaves them out, so the old overlay's outbox compares as before), read by the
typed `margin_page_layout_read` (the report's JSON in, numbers and the texts' places out, the texts in the caller's
buffer): 14 µs a report on the Swift side, was 10. Commit 6 keeps it in the window's Page.

*Commit 3 did:* the window's Page keeps it (`margin_page_set_layout(page, bytes, len) -> uint8_t`: bit 1 a report,
bit 2 a split's panes changed), and the page sends its report as its JSON text when its hello says `layoutText`
(host-app.ts; Margin.app's window only, the extension's overlay, Windows and the tests' dictionaries as before): the
bytes as WebKit hands them, no object made of them on either side, the Swift value built only when read. 2.5 µs a
report on the Swift side (3.7 with a split), was 6.6 (12.0) before commit 1 and 10.7 (15.0) after it, on this Mac's
same run; WebKit no longer builds an NSDictionary for it either. The parse is still serde's `Value` (it allocates,
4 µs in the core): commit 6's typed follow path can make it allocation-free.

*As built (commit 6):* the report is read straight into the Page's kept layout (page/report.rs: serde_json's own
deserializer through a seed, every value through `deserialize_any` as a `Value` is read, each key's last; the layout
and a spare taking turns, so a drag's frame allocates nothing once both have grown): 0.8 µs, was 4.1. The page area's
change is `margin_session_page_rect(s, window, page, content, display, card)`: the window's Page (MWC's `pageFrame`;
a test's window has none and is read through the ports), its content and display as MWC reads them, the preview
card's host and rect while the card is Swift's; following a drag, the placement and the panes' rects are read from the
Page and handed to the engine through the typed `MarginSessionFollow` (`margin_session_set_follow`), its ids lent for
the call; the card's window there when the core's card is in place, at the rect the window measures (`card`: Swift
hands in its `cardRect`, the core decides). 0.2 µs, nothing allocated (no_alloc.rs `a_drags_frame_allocates_nothing`, drag_cost.rs). The engine's one
shown is read after the drag's hold, not before it (a read: the same answer), so a drag not followed asks nothing per
frame either. `sidebarResizing`, `refreshPaneMinimums`, `appMinimumsChanged`, `forgetInLayouts` are inputs; `resizing`
and `following` a typed read (`margin_session_drag`).

**Risks.** Two FFI hops a frame where there were none: measured against step 2's `live-resize` numbers (followed
median and p95 no worse). ~70 Swift lines deleted.

#### Part 8: the loading bar

**Today.** `loading` HS:1119-1126 (the engine's slow step: the card's own, a split pane's own, else the page card's
loader), `paneLoadingStep` HS:1144-1160, `releaseReveal` HS:1135-1139, `copyLoading` HS:1164-1170 (the copy's
`loading` push for the window Margin hosts, routed at SW:264-269), `refreshLoading` HS:1224-1242 (the items loading
by the UI's numbers, sorted, said on change; other windows told none), `cardLoadingStep` HP:95-99; the window's
`setLoadingTabs` MWC:544-548.

**Core.** core/session/loading.rs, the same functions. The UI's numbers (`number(ofItem:)` HS:2390-2397) are given in
order of first use: the same calls in the same order give the same numbers.

**FFI.** Engine callback `{"type":"loading","host"}` (rare: a slow step's start and end); the copy's push as part 10.
*As built (commit 9):* typed calls, answered as `input` is (`margin_session_loading`, `_refresh_loading` for the Swift
flows of later parts that change what it reads, `_release_reveal`); applyLayout's `panesLaying` and `revealHeld` are
fields (22, 23) its Swift writes until part 3's flow moves; the card's loader (HostedPeek's `cardLoadingStep`) is
loading.rs's. The numbers a `refreshLoading` gives items first seen there are in their ids' order (the Swift's in its
Set's order; an item loading is numbered by its row first in practice).

**Pinned by:** T/hosted-tests.swift 763-801; the split's pane loader in T/split-real-use-tests.swift. **Windows:** the
theme's bar from the Chrome copies' `loading` pushes, the same. ~60 Swift lines deleted.

#### Part 9: which window gets the mini player, the copies' pushes for the page

**Today.** `copyPush` HS:1179-1198 (the pick: among the Margin windows showing the space of the first source's item,
the hosting one, else the front one, else the lowest; none: the hosting one, else the front one, HS:1187-1190; a
standing push taken back from the window that had it, HS:1192-1196), `standingTo` HS:1200, `uiNumber` HS:1206-1219
(the copy's tag, else the tab, else the open item at that address), `copyTabs` HS:2455-2466 (from SW:238-243).
The sanitiser: UP:25-52 (`forwarded`, `standing`, `page`, `empty`; images by
`^data:image/(png|jpeg|webp|gif);base64,…$` up to 128 KB, UP:36-37).

**Core.** core/session/push.rs: UP's table and `page`/`empty` (a rule: field caps), the pick, `ui_number`.
*As built (commit 9):* the pick, `ui_number` and `copy_tabs` in route.rs, over push.rs's rule. The push comes in as its
message's JSON text (the link object hands a push out with `msgText` and `type`, its `msg` never made a dictionary),
`margin_session_copy_message` reads and routes it by type (the loading bar's, the card's back to the Mac, the UI's) and
the page's JSON goes out through the `push` port as its text: no Swift dictionary either way.

**Pinned by:** T/hosted-tests.swift 848-852, 880-926. **Windows:** the same pushes from Chrome's and Edge's copies.

**Risks.** UP's caps count Swift `Character`s (grapheme clusters); margin-core has no grapheme crate
(app/shared/core/Cargo.toml:10-16), so a cap counts Unicode scalars: the edge difference step 1 took for the link and
the themes (1.5, 1.6: a cut text can keep fewer characters than before), pinned by a vector. ~120 Swift lines
deleted.

#### Part 10: link routing, the page's hello and messages, what the UI draws

**Today.** `tellDrawn` SW:317-330 (a copy's window drawn iff it's one the session hosts for that profile, every
role; sent on change, `drawnSent` SW:65), called after each state SW:244 and each read SW:341; the pushes' routing
SW:263-284 (`loading`, the card's four, the forwarded ones). The page: `pageHello` MWC:1824-1860 (its fields:
`windowId`, `host: "app-window"`, `mode`, `windows`, `themes`, `apps`, `pageHosted`, `marginPage`, `pageMinWidth`,
`paneMin`, `appMin`, `paneLoading`, `paneCut`, `pageState` and its opening/starting/stuck words, `pagePicture`,
`hostedFrame(s)`, `theme`), `pageSend` MWC:1862-1874, `pageSaid` MWC:1902-1988 (the ops: `ready`, `layout`,
`peekRect`, `hits`, `chrome`, `focus`, `counts`, `pointerWant`, `perform`, `log`). The UI's requests:
`LibraryWindowSource.perform` HS:2518-2592 (the tab numbers mapped back, `updateSettings` to the profile source,
`copyUrl` to the pasteboard, `app.open`, `search`, history, `startup.*`, `openLauncher`, `addFavorite`'s scope from the
settings, `peek.*`, ⌘W with no tab), `searchUrl` HS:2600-2607. What it draws: `live` HS:2404-2433, `liveTab`
HS:2439-2450, the numbers HS:2390-2400.

**Decision vs mechanism.** `drawn`, the routing, the hello's fields, the ops' routing, the UI requests' routing,
`searchUrl` and which items are open tabs with what numbers are decisions. The pasteboard, the profile source's
settings (UserDefaults keepers, SH:17-63), the WKWebView's `callAsyncJavaScript` (MWC:1781-1790) and the theme store's
file reads are the Mac's.

**Core.** core/session/route.rs: `pub fn drawn(&self, browser, profile, window_ids: &[i64]) -> Vec<(i64, bool)>` (the
diff against `drawnSent` kept in the core), `push(link, window, msg)`; *as built (commit 9): `drawn(hosted, windows,
sent)` a rule whose `sent` the link object keeps per connection (`margin_link_drawn`, sending each change itself):
a copy links before Margin's window, and so the session, is made, and its windows are told then too; the session
answers only which windows it hosts (`drawn_windows`)*; core/page/hello.rs: `Page::hello(&HelloFacts)
-> String` (the facts the Mac reads: windows, themes, apps, theme JSON as bytes, never re-parsed); `Page::said(op,
body) -> Said` (an enum: each op's route); core/session/ui.rs: `ui_request(kind, payload) -> Ui { Answer(Value) |
Perform(kind, Value) | Settings(Value) | Pasteboard(String) | Done }`, `search_url(query, template)`; `live_plan(&self)
-> LivePlan { window, front, rows: Vec<Row { item, number, index, active, visible, audible, muted }> }`.

**Before and after step 4, the snapshot:** until step 4 the snapshot is the rules' (JavaScriptCore), so `live` stays a
Swift shaping of it (~25 lines) over the core's `live_plan` (which items, their numbers, active, visible, sound: the
decisions); after step 4 the snapshot is Rust and `live` joins it there (no JSON through the FFI per draw).

**FFI.** `{"type":"push",…}` per copy push (a media change: a few a second while playing, ~1 KB); `ui` per UI
request (clicks); `live_plan` per draw (JSON, a few items); the hello once per page load.
*As built (commit 9):* the push typed (above); `live_plan` typed, no JSON: a callback asks whether the snapshot keeps
each listed item as a tab in a space (only those are numbered, as the Swift numbered them) and a sink takes the rows;
a window's layout's items (`visible`) from commit 7's `layouts` in the core. The page's ops come as their
JSON's text (the hello's `saidText`, as commit 3's `layoutText`: the page's `post` sends `{ op, json }`), read by
`Page::said` (`margin_page_said`, PointerWant's reading with it: one reader); a dictionary's body (the tests', an older
page) is made JSON first. The hello is `margin_page_hello` over the facts' texts; its head's keys (`windowId` …
`state`) were the Swift dictionary's order, a new one each launch, and are fixed now: the rest is the same bytes. The
UI's requests are a `ui` input whose reply is the route; the card's `peek.*` and ⌘W go to card.rs's flows (commit 7),
as do a copy's card pushes; the Swift flows of later parts they ask for (the start screen's, the launcher) through the
JSON `swift` port, interim.

**Pinned by:** T/tests.swift:145-147 (the drawn message), T/hosted-tests.swift 824, 834-840 (`addFavorite`'s scope, the
rows), 1909-1946 (`hostedShellTests`), T/margin-window-tests.swift (8-362); E/e2e-glue.swift `glueScenario`
(258-1391), E/e2e-hosted.swift `hostedScenario`.

**Windows:** §10 item 7 in full: requests with ids and their answers (`Ask` + `_answer`), `drawn` per hosted window,
the `app-window` hello built by the core (its `host`, `pageHosted`, `pageState`, `pageMinWidth`, `apps`, `paneCut`,
`themes`, `marginPage`).

**Risks.** `searchUrl` encodes everything but `CharacterSet.alphanumerics` and `-_.!~*'()` (HS:2604-2606).
*Corrected in commit 0:* Foundation's `addingPercentEncoding` ignores whatever of the allowed set isn't ASCII, so
"café" was always `caf%C3%A9` (encodeURIComponent's set): no Unicode table needed, and open question 8's change was
the behaviour already. The learned template's checks (`contains("%s")`, `hasPrefix("https://")`) are Swift's
characters and its replacing NSString's composed sequences: the core keeps both with three tables of the scalars that
join an ASCII character (session/unicode.rs, made from this Mac's Swift). ~200 Swift lines deleted.

#### Part 11: page states, holes and the ground

**Today.** `PageState { empty, loading, shown, elsewhere }` MWC:157; Margin's own page MWC:160-167; the setters
MWC:493-668, 805-841 (each deduped on equality); `settlePage` MWC:993-1007 (the target: not hosting → elsewhere or
empty; hosting → shown when a window is hosted and no label, else loading; the grace `loaderGrace` 0.12 s, MWC:94,
only into loading from neither loading nor elsewhere, with no `loadingLabel` and not slow; the old hole kept
meanwhile), `graceOver` MWC:1010-1015, `applyPage` MWC:1017-1036 (the label and the app, the change, the hole, the
keys let go into shown, the push, the front), `pageStateJSON` MWC:1038-1042, `setStartupStuck` MWC:1046-1051. Holes:
`placeHole` MWC:1088-1128 (one host: the hosted window's bounds ∩ the page area when shown, the page area while
following, the old hole while the grace runs; corners within 2 pt of the page's take its radii), `updateHoles`
MWC:725-769 (several: each visible host's rect ∩ its frame ∩ the page, a card's whole rect a cut, the focused one's
hole), `holeRadii` MWC:694-701, `subtract` MWC:703-709, `groundHoles` MWC:712-722, `paneScene` MWC:781-795; the
ground's colour `PageFill.color`/`common` MW:495-527 (CSS colours). The front watch: `frontRead` MWC:908-975 (`settle`
0.5 s, `missApart` 1.0 s, `probeEvery` 5.0 s, MWC:907) and `keepFront`'s choice MWC:852-873.

**Decision vs mechanism.** The states, the grace, the labels, every rect and radius, the ground's colour, the front
watch's choice are decisions (core/page/). The panel and its level or order, `WindowGroundView`'s layer (MW:377-491),
`CatchView` (PT:166-189), the keys (`letGoKeys`, `keysBack`, MWC:1361-1395), the window server's reads of the hosted
window's bounds (MWC:978, 1161) and the WKWebView push stay MWC's.

**Core.** core/page/mod.rs:

```rust
pub enum PageState { Empty, Loading, Shown, Elsewhere }
pub struct Page { state, hosting, hosted: Option<i64>, loading: Option<Label>, showing: Option<Label>, slow: bool,
                  elsewhere: Option<Label>, starting: bool, stuck: Option<String>, grace_until: Option<f64>,
                  layout: Option<PageLayout>, visible: Vec<Shown>, following: bool, hole: Option<Rect>, holes: Vec<Hole>,
                  slot: Option<Slot>, front: FrontWatch, … }
impl Page {
    pub fn set_hosting(&mut self, on: bool, now: f64, out: &mut Vec<PageOut>);      // and one fn per HostedWindow setter
    pub fn grace_over(&mut self, now: f64, out: &mut Vec<PageOut>);                  // at `grace_until`
    pub fn holes(&self, hosted_frame: Option<Rect>, frames: &[(i64, Rect)]) -> Holes; // pure: list, cuts, radii, slot holes, pane holes
    pub fn front_read(&mut self, now: f64, read: &FrontRead) -> FrontAct;
}
pub enum PageOut { Push(String), Ground { fill: Option<Rgba>, holes: Vec<Hole> }, Slot, LetGoKeys, KeepFront { up: bool, level: bool }, Note(String) }
```

A setter that needs the hosted window's bounds now (`setLoading(nil)`, `setShowing(nil)`, `setHosted`,
`hostedMoved`: MWC:520-566) asks MWC's port `read_bounds(window)` first, as `readHosted` does today, then decides.

**FFI.** One Page object per Margin window, owned by its MWC (`margin_page_new/free`); its setters typed calls
(each a session decision: a few per switch), the outs written through a callback during the call (as the link's
writes). The front watch's read is typed (every poll at rest: 1.5-2 s).

**Pinned by:** T/margin-window-tests.swift (316-346 the ground; the setters), T/hosted-tests.swift (every
`window.loadings`/`showings`/`hostings` check: those are the fake window's records of the session's calls, unchanged),
E/e2e-glue.swift `multiHoleChecks` (1392-1500) and `glueScenario`; S `page-frames`, `core`. Ported: the target state
and the grace, `holeRadii`/`subtract`/`groundHoles` with CGRect's edge rules (step 2's vectors rule), `PageFill`'s
colours, the front watch with a simulated clock.

**Windows:** §10 item 1's `PageState { window, state, label, app? }` and `Holes { window, rects, radius }`: W/hole.rs's
`region` (W/hole.rs:41) turns the core's holes into the window region; §4.2.

**Risks.** The grace timer's restart and invalidation order (MWC:996-1005) becomes a deadline the session's wake
covers: one timer on the Mac side for both. ~450 Swift lines deleted (MWC's decisions; ~1,900 of mechanism stay).

*As built (commit 3), where the design above was wrong or changed:* core/page/ (mod.rs, area.rs, holes.rs, fill.rs,
front.rs), margin-ffi page.rs's `MarginPage` the core's `Page` (with its `pointer: PagePointer`), Swift's wrapper
PageCore.swift. No `PageOut` callback: MWC's setters re-enter the session through the window's own page rect
(`setPageRect` → `onPageRect`), so each decision is a typed call at the Swift's own point, answered with what to carry
out, and MWC carries it out in the Swift's order before its next call (nothing read of the Page while a call is under
way). The hosted window's bounds are read by MWC where the Swift read them (`readHosted`, `readVisible`, the same
count) and handed in before the decision that needs them: no port callback. The grace's deadline is the core's
(`settle(now)`), kept by MWC's own timer, one a window as before (the session doesn't own the Pages); its restart and
invalidation in the Swift's order. The front watch's clock is MWC's `now`, read through a C callback at each of the
Swift's points; its log lines stay MWC's, the core answering codes and numbers. Two Mac facts found by the comparison:
NSColor's `==` compares each component as a 32-bit float (so the ground's "most of the corners" does), and Swift's
`Double(_:)` takes `snan`, a NaN's payload only as none, `0x` hex, `0` octal or decimal, and no NUL anywhere.
`margin_page_place_slot` is gone: the Page places its slot at `margin_page_place_hole`. ~180 lines of MWC's decisions
net out (346 out, 169 in), PassThrough.swift's PageCore moved into PageCore.swift with the Page's calls (323 lines).

#### Part 12: pointer pass-through for several holes

**Today.** PT: `Slot` 20-30 (rect, radius, hits, `captureAll`, `holes`), `pageGets` 34-46 (no slot, capture-all, out
of the rect, on a hit, in no hole, outside a rounded corner: false), `decide` 49-51 (a held button keeps the way),
`slot(in:layout:hits:captureAll:)` 54-58, `CatchRegion` 69-92 (with holes), `PointerWant` 98-124; the window's side:
`passes` MWC:1193-1197 (windowed: over the theme's buttons too), `pointerMoved` MWC:1214-1232 (per pointer event),
`pointerAgain` MWC:1207-1212, `hoverCut` MWC:607-613, the one-host slot rule MWC:1121-1126 (radius 0 unless the hole is
near the slot's rect within 2 pt, the rect ∩ the hole). core/passthrough.rs is the old overlay's: `Slot` without
holes (passthrough.rs:27-34), `page_gets` 57, `decide` 95, `slot` 101, `CatchRegion` 126, `EdgeGuard` 291-302 (Windows'
old overlay only), used by core/shell/overlay.rs:112, 209 and so by W/host.rs:422.

**Core.** passthrough.rs brought up to the Swift: `Slot.holes: Option<Vec<Rect>>` (`None` for the old overlay: its
behaviour unchanged), the holes' test in `page_gets`, `CatchRegion::of`/`contains` with holes, the one-host rule, the
windowed buttons; `Page::pointer(point, buttons) -> Pointer { pass: bool, hover_cut: Option<…>, push: bool }` over the
Page's slot. PT keeps `CatchView` and `PointerWatch` (mechanism).
*As built (commit 2):* one rule with two edge semantics (`Plain`, the old overlay's `Rect`, unchanged; `Cg`, CGRect's
to the bit, the Mac's); the Mac's pointer is `PagePointer` (passthrough.rs), owned by margin-ffi's `MarginPage`, which
commit 3's `page::Page` becomes with a `pointer: PagePointer` field. The call takes the content's rect and `now` too
(`moved(at, content, buttons, now)`: the window's frame changes without the core being told, and the core reads no
clock), and answers whether the pointer is over the content and the push's position. PointerWant's reading of the
page's message stays Swift (a boolean `zone` is 1 there, 24 in the core's `from_json`); which positions it wants is
the core's. The slot's mirror (`slot`, read by the tap, the tests, `cardHole`) is read back only when it changed.

**FFI.** Typed, per pointer event (≤ ~120 a second, the main thread): `margin_page_pointer(page, MarginPoint at,
MarginRect content, bool buttons_down, double now, MarginPointer *out)`: no lock, nothing allocated (as built; the
design had `x, y, buttons` only). Beside it, typed and allocation-free once warm: `margin_page_place_slot` (each
change of the holes, a drag's frames; commit 3's Page places it itself at `margin_page_place_hole`, and the call
went), `_pointer_again`, `_gets`, `_ignoring`,
`_slot`, `_catch`, `_set_buttons`, `_set_want`, `_set_cuts`; and `margin_pass_*`, pure, for a slot the caller holds
(the pane click tap's thread, the facade the tests read).

**Pinned by:** T/tests.swift:218-247 (pass-through, the catch region), T/margin-window-tests.swift:88-120, the core's
passthrough tests (unchanged for the old overlay, new for holes), E/e2e-glue.swift `multiHoleChecks`; S `pane-clicks`,
`core`'s clicks.

**Windows:** the hosted design cuts holes from the window region instead (§4.2, W/hole.rs): it uses the core's holes,
not the pointer test; the old overlay's pass-through stays until §11 step 9 removes it with planner.rs and binder.rs.
~80 Swift lines deleted.

#### Part 13: `DataSetWindowSource.state` replaced by the library's snapshot

**Today.** `state` SH:140-196 rebuilds, from a profile's data set, the State shape the library's own snapshot
(library.ts `snapshot`, L:134-140) gives. It runs on every draw of every window: `LibraryWindowSource.snapshot`
(HS:2510-2516) calls `profileSource.snapshot()` (SH:99-109), which builds every collection, to take two keys
(`settings`, `favicons`, HS:2513-2514). It's also the whole source when the library's rules didn't load (SG:176-179).

**Step 3.** `DataSetWindowSource` gains `settingsAndIcons()` (the profile's `settings` with the in-memory overlays,
SH:102-108, and its `siteIcons`), which the library's snapshot takes: no State rebuilt per draw, the same values.
`state` then serves only the no-rules fallback. **Step 4** makes the snapshot margin-core's (it can't fail to load), so
`state` and the fallback go then, with one shared snapshot for the extension and the app. Default: the fallback kept
until step 4 (open question 6).

**Pinned by:** T/margin-window-tests.swift:221-261, 285-300 (the source, settings across launches). ~0 lines now
(~60 in step 4); a draw's cost measured before and after.

#### Order (one commit each; `npm run test:quick` each; the gate and the screen suite before the merge)

| # | Commit | Swift deleted | Rust in (with tests) | Measured after |
| --- | --- | --- | --- | --- |
| 0 | Baseline (`idle-cost`, `idle-profile`, `live-resize`, `page-frames`, a switch's time) and tests added against the Swift: the four pin/favourite paths, `noRoom`'s edges, `lastItem`'s tie, `webAddress`, `searchUrl`, UP's caps, HostID's logged form, holes with zero-size and touching rects, pass-through with holes. **Tests done 2026-11-23** (c0b09ce4); the baseline is the screen suite's | 0 | 0 | the baseline |
| 1 | The pure rules into the core, Swift switched, its copies deleted: `noRoom`/`paneLeast`/`isNoRoom`, `defaultCardRect`, `webAddress`, `searchUrl`, `resolve`, `loaderApp`, `dragLine`, `lastItem`, UP's sanitiser, `PageLayout`'s parse. **Done 2026-11-23** (3ed9208a; searchUrl: Tirth's question 8 was the behaviour already, its own entry) | ~180 | ~600 | |
| 2 | passthrough.rs with several holes; the pointer typed; PT's rules deleted. **Done 2026-11-23** (step3/passthrough: one commit; MWC's pointer decisions, the one-host rule and the tap's read are the core's; PointerWant's message reading, the hole lists' choice (part 11) and the mechanism stay Swift; `pane-clicks` not measured: no screen suite on that branch) | ~95 (+~220 of facade and the page object's wrapper) | ~1,000 (half tests) | `pane-clicks` |
| 3 | The Page (part 11, and the page area's placement of part 7): MWC's decisions deleted, its mechanism over the Page. **Done 2026-11-23** (step3/page, one commit: core/page/, ffi page.rs's `MarginPage` the core's `Page`, PageCore.swift; the layout report as its JSON text, the hello's `layoutText`; each decision a typed call at the Swift's point, no out-callback; the grace a deadline on the window's own timer; `page-frames` and `idle-cost` not measured: no screen suite on that branch) | ~480 (~530 in: PageCore.swift's wrapper and MWC's glue) | ~3,400 (a fifth tests and measures) | `page-frames`, `idle-cost` |
| 4 | The session's skeleton: executor, ports, commands, the facade, the re-entrance test adapter; `navigate` (HS:2378-2385) the first flow moved, as the proof; `SafariWaker` split out in Swift (no behaviour moved). **Done 2026-11-23** (step3/skeleton, three commits: SafariWaker.swift, a move only; navigate's checks against the Swift; core/session/ with exec.rs, state.rs, host_id.rs, navigate.rs, ffi session.rs and the facade, `shown`, `open`, `safariWindows` and `done` the core's, Swift's `enqueue` in the core's queue. Inputs run nothing in their call, the one finding; nothing per frame) | ~10 | ~700 | |
| 5 | Parts 1 and 2: the library's requests, `show`, `close`, `host`, the choices, the engine's window asks. **Done 2026-11-23** (step3/requests, two commits: the move, then Tirth's change 3; session/requests.rs, hosting.rs, items.rs, `ItemTarget(json:)` into target.rs, `DefaultBrowser` into choice.rs; 14 more fields the core's; the Swift of later parts through one `swift` port and a `Swift` command, interim; the notes through a `log` port; the comparison on generated sequences with overtaking, failures and re-entrance; a switch measured) | ~455 (+~335 of facade) | ~2,300 (a third tests) | a switch |
| 6 | Parts 3 and 7: layouts, splits, the page area moving, the drag's typed path. **Done 2026-11-23** (step3/layouts, one commit, over commits 7 and 9: session/layouts.rs, page_area.rs, page/report.rs; commit 7's `layouts` and commit 9's `panesLaying`/`revealHeld` written by the core's flow, the card's layouts through it and commit 7's interim `applyLayout` command gone; the drag's frame typed end to end; the comparison on generated sequences with splits, refusals, no room, minimums, drags mid-show, the retry and the re-entrant page rect against each base; `live-resize` not measured: no screen suite on this branch) | ~490 (+~230 of facade and ports) | ~3,700 (a third tests) | `live-resize` |
| 7 | Part 4: the card and Quick Tab. **Done 2026-11-23** (step3/card, one commit: card.rs's flows and `web_host`, `Card`, `cards`, `littleArcs` and part 3's `layouts` the core's fields, HostedPeek.swift the facade; the interim card entries of the `swift` port gone; a peek open measured) | ~350 (+~200: the facade, the ports, the fields' rows) | ~1,580 (a quarter tests) | a peek open |
| 8 | Parts 5 and 6: elsewhere, the start, `resumeLast`, `settleHosting`, the launcher, the preparation. **Done 2026-11-23** (step3/start, two commits: the move, then Tirth's change 5; session/elsewhere.rs and start.rs's flows, the interim `swift` calls commits 5, 6 and 9 left for these parts gone (`uiSettings` and `paneCuts` not theirs, left); the poll's sweep not part 6's; the facade's timer fixed; `idle-cost` not measured: no screen suite on this branch, the start screen's idle wakes measured in the harness) | ~265 (385 out, 122 in) | ~1,600 (a third tests) | `idle-cost` |
| 9 | Parts 8, 9, 10: the loading bar, the pushes and the mini player, `drawn`, the hello and the ops' routing, the UI's requests, `live_plan`. **Done 2026-11-23** (step3/routing, one commit: session/loading.rs, route.rs, ui.rs's requests and rows, page/said.rs, hello.rs; the push as its text from the link, `drawn`'s diff kept by the link object, the page's ops as their text; a push and a draw measured) | ~380 (~450 in: the typed facade, PageCore's said and hello) | ~2,600 (a third tests and measures) | a push, a draw |
| 10 | Part 13 and the leftovers: `settingsAndIcons`, the facade trimmed to what T/ reads. **Done 2026-11-23** (step3/finish, one commit: `settingsAndIcons` and `drawnSettings` the draw's and the UI requests' (no State built), `state` only the no-rules fallback's; `uiSettings` a `settings` port of its own, `Command::Swift` gone; the facades' fields, wrappers and JSON ports nothing reads deleted; a draw measured) | ~80 (140 out, 59 in) | ~0 (26 in, 24 out) | a draw |

About 2,400 Swift lines deleted (of HS's 2,620, HP's 438, ~450 of MWC's, PT's ~80, UP's ~90), ~700 Swift lines added
(the facade, the ports' adapter, the Page's mechanism glue) and ~250 moved into `SafariWaker`; ~7,700 Rust lines in,
about half of them tests. Budgets as before: idle < 0.5% CPU, < 150 MB, a switch < 16 ms of Margin's work, a drag's
p95 no worse than commit 0's.

#### What should not move

- `SafariWaker` (the menu's presses and their ladder, the woken windows' parking and closing, the restored windows'
  sweep, `unopenable`): Safari's own mechanics, as step 3's list says. Windows' counterpart is its Chrome start.
- `ExtWindow`, `ShellHostedLinks`' transport (SG:16-49), `NoHostEngine`/`LateHostEngine` (SG:52-124: the engine
  resolved late is a Mac start-up fact), `wire` (SG:129-164): the adapter.
- The keys: `updateHostedKeys`, `runHosted`, `runAppKey` (SG:278-384; their rules are 1.1's), `PanesActive` and
  `PaneClickTap` (Tirth, 2026-11-22: the Mac's policy).
- MWC's mechanism (the panel, its level and order, the ground's layer, the catch view, the keys, full screen, the
  window server's reads, the bar watch MWC:1440-1512, `FullScreenRetry` MWC:2364-2405: a pure struct, but of macOS's
  full-screen transitions only), `ThemeSettingsKeeper`/`SettingsKeeper` (UserDefaults, SH:17-63), NSPasteboard.
- The library's rules (step 4) and the snapshot's shaping until then.

#### Open questions for Tirth (each with the default this design takes: no change of behaviour)

**Tirth's answers (2026-11-23):** 1 async, the same shape as the Swift; 2 yes, a library edit asked of the TS rules in
the same turn until step 4; 3 **changed**: a reset (pin or favourite) still navigates back to its address when overtaken,
but isn't shown (no flash before the item clicked after it); 4 the Swift's picture rule, no 8 MiB cap; 5 **changed**:
the start screen re-checks only on events (an app, a window, a copy's link), no 50 ms looks; 6 the fallback kept until
step 4; 7 yes; 8 **changed**: searchUrl percent-encodes every non-ASCII letter (café → caf%C3%A9; already so: Foundation never kept them, see question 8); 9 Rust, same words.
The three changes come after the pure moves, each its own commit with tests pinning the new behaviour.

1. **Flows as Rust `async fn`s with the core's own executor**, or hand-written state machines (core/shell/mod.rs's
   `Pending` way, shell/mod.rs:450-460). *Default: async; a transliteration keeps every decision where it is, ~130
   awaits by hand would not.*
2. **A library edit as a step answered in the same turn** (re-entrant delegate kept) until step 4. *Default: yes.*
3. **`resetPin`/`resetFavorite` aren't skipped when overtaken** (HS:509-513 vs 495-496). *Default: kept so; say if a
   reset should be skippable like an open.* *Done (commit 5's second commit): navigated back, then skipped as an open
   is, checked after the navigate.*
4. **The page picture's rule:** the Swift's prefix check or hosted_browser's (with its 8 MiB cap). *Default: the
   Swift's.*
5. **The start screen's 50 ms looks while held up** (HS:1559): kept, or re-checked only on an input (no wakes).
   *Default: kept; it only runs while the start screen is up.*
6. **The no-rules fallback** (`DataSetWindowSource` as the whole source, SG:176-179): kept until step 4, or dropped
   now (an empty Personal space and a warning). *Default: kept.*
7. **Chrome and Edge** stay "isn't hosted yet" in the core's session though it's browser-keyed. *Default: yes, until
   §11 step 7.*
8. **`searchUrl`'s Unicode letters** left unencoded (`CharacterSet.alphanumerics`). *Default: ported exactly.* (Wrong
   premise, found in commit 0: Foundation already encoded every non-ASCII character; Tirth's answer is the behaviour.)
9. **The session's log lines built in Rust** (their words unchanged), as step 2 kept them Swift's. *Default: Rust,
   since every line is a decision's.*

### Step 3: done (2026-11-23)

Every commit of the order table is done (each one's DECISIONS.md entry has its checks: the deleted Swift against the
core on generated vectors or sequences before it went, each harness proven by deliberate breaks). What moved into the
core (app/shared/core/src/session/ and page/, typed calls in app/platforms/macos/ffi/src/session.rs and page.rs):

- **The pure rules** (commit 1): a split's room and the 220 pt least, the card's default rect, web and search
  addresses, the profile resolved, the last item, the UI pushes' caps, the page's layout report.
- **The pointer and the page** (commits 2, 3): pass-through for several holes, one typed call a pointer event; Margin's
  window's page (its states, the loader's grace, the holes and the ground, the page area), MWC's decisions deleted.
- **The session** (commits 4-9): one queue for the core's flows and the Swift's jobs, the shared state as typed rows;
  the library's requests (show, close, the palette's pick, the four pin and favourite paths made one, overtaken picks,
  the cycle hold), the engine's Safari window asks, layouts and splits, the page area moving and a drag's frame typed
  end to end, the preview card and Quick Tab, an item in another Margin window, the start screen, `resumeLast`,
  `settleHosting`, the launcher, the default browser made ready, the loading bar, the copies' pushes and the mini
  player, `drawn`, the page's hello and ops, the UI's requests and rows.
- **The draw's snapshot** (commit 10): the library's draw takes the profile's settings and site icons
  (`settingsAndIcons`), no State rebuilt per draw; the UI requests' settings a `settings` port of their own.
- Tirth's three changes, each its own commit after the moves: a reset overtaken navigates back but isn't shown; the
  start screen held up re-checks only on events (0 wakes a second, was 20); `searchUrl`'s encoding was already his
  answer.

What stayed Swift, and why:

- **The adapter's contract:** the protocols to the engine, Margin's window and the links, the ports' adapter
  (SessionCore.swift) and the facade (HostedSession.swift, HostedPeek.swift: the fields as typed rows, the calls the
  shell and the tests make, the static wrappers the tests read, `applyLayout`/`setLayout` as the tests' API).
- **The Mac's own:** Safari's window mechanics (SafariWaker: the menu's presses, the woken windows, the restored
  windows' sweep), the poll's sweep (`closeIdleCards` the core's through the facade, `closeIdlePaneWindows`, the
  restored windows), `paneCuts` (built from the engine's visible list, the one call left on the `swift` port), the
  engine's events' edits (`hostEvent`), MWC's mechanism, the keys, PanesActive and PaneClickTap, NSPasteboard,
  UserDefaults (the keepers).
- **Until step 4:** `DataSetWindowSource.state` as the no-rules fallback (Tirth: it goes at step 4's switch), `live`'s
  shaping of the core's rows into the library's kept tabs, the library's rules (TS).
- margin-ffi's JSON forms of the typed ports stay as its contract (its own tests run them); the app always gives the
  typed call, so the Swift answers only the rare ports as JSON.

Swift lines (app/platforms/macos, from 673288b9): 2,778 deleted, 2,395 added (of them 279 SessionCore.swift, 410
PageCore.swift, 199 SafariWaker.swift moved out of HostedSession, the rest the facade and the ports' adapter), so the
app's Swift is 383 lines smaller; HostedSession.swift 2,620 → 1,820, HostedPeek.swift 438 → 115. Swift tests: 523
added (the pins against the Swift before each move). Rust: ~22,200 lines in (~4,800 of them test files, more in
inline test modules). The design's ~700 added was low: the facade's typed rows and the Page's glue cost more than it
counted. A draw (release, Swift side, `LibraryWindowSource.snapshot`): 1.74 → 0.86 ms at 50 items, 17.6 → 5.1 ms at
500; a UI search request's route 1.2-13 ms → 47 µs.

Open, for later:

- Before macOS 26 a command can't start at once (`Task.immediate`): each is a task of its own and the run goes on a
  main-actor turn later than the Swift's `await` did. One extra hop for the engine's asks there; on 26 and later none.
- The loop guard's screen test (T/screen-engine-tests.swift ~229, "a re-entry held by the loop guard's hold") fails
  only under heavy load (the hold's end measured on a busy Mac); it passes idle.
- Still to do before the merge: the gate and the screen suite (`idle-cost`, `idle-profile`, `live-resize`,
  `page-frames`, `pane-clicks`, a switch, a peek open), never run on these branches.

## Step 4: the sidebar's rules into the core (Tirth, 2026-11-22)

Right after step 3, before the Windows hosted session plugs in, so Windows never runs a stopgap (no QuickJS, no hidden
web view): the library's edit rules (app/shared/library/library.ts over extension/state/model.ts: about 40 actions,
the import, the snapshot) become margin-core's, the Mac's LibraryRules (JavaScriptCore) goes, and the TS copy stays
only while Chrome's and Edge's copies still own spaces in the old design (feat/hosted-windows-chromium retires that).
The TS tests' cases are carried over as shared vectors run against both until the TS copy is deleted.

### Step 4 design (2026-11-23, at f78d6598)

Paths: **LT** app/shared/library/library.ts; **M** extension/state/model.ts; **PR** extension/shared/pinned-rules.ts;
**AT** extension/shared/air-traffic.ts; **FI** extension/shared/front-item.ts; **DS** extension/shared/data-set.ts;
**L** app/platforms/macos/shell/Library.swift, **LR** LibraryRules.swift, **SL** ShellLibrary.swift, **SH**
ShellHosted.swift, **SG** ShellHostedGlue.swift, **HS** HostedSession.swift, **MWC** MarginWindowController.swift (same
folder); **core/** app/shared/core/src/; **ffi/** app/platforms/macos/ffi/src/; **T/** app/platforms/macos/shell/tests/;
**E/** tools/app-tests/; **§10** docs/HOSTED-WINDOWS-CHROMIUM.md §10. Line numbers as of f78d6598 (refactor/core-session's
tip; step 3's parts 6–10 are still being built on step3/layouts, step3/card, step3/start, step3/routing, so the HS lines
they move are left out here and named by function).

#### Who runs the rules today (read from the code)

| Who | What it runs | After step 4 |
| --- | --- | --- |
| Margin.app (Mac) | LT through JavaScriptCore: `dist/app/library.js` (scripts/build.ts:142-163, `APP_FILES`), loaded by LR:19-43, called by L:142-151 (`snapshot`, `actions`), L:205-227 (`perform`), L:268 (`importValues`) | margin-core; LR deleted, JavaScriptCore no longer linked for it |
| The extension (Safari, Chrome, Edge copies) | **not LT**: M directly on its own state (background/store.ts `mutate`, background/handlers.ts), with PR, AT, FI, DS | unchanged (the old design's owner of spaces until feat/hosted-windows-chromium retires it) |
| app/shared/ui (Margin's window's page) | not LT: it draws LT's snapshot as stored values (host-app.ts:430 `fromStorage`), and predicts two rules of its own (ui/intents.ts `nextFront`, LT's `frontOf`; ui/behaviors/split.ts `refusesAdd` with FI) | unchanged; it draws the core's snapshot, the same shape |
| The Chromium build (`dist/chromium`) | nothing of LT (`buildApp` writes only `dist/app`) | unchanged |
| Windows (margin.exe) | nothing (no JS engine; §9 decision 2: Tirth, 2026-11-22, the rules into margin-core) | margin-core's `library` directly, no FFI |
| The tests | 10 TS files import LT (tests/library, arc-data, arc-qol, favorites, sticky-pins, nested-folders, split-model, split-view, media-player, air-traffic: ~70 tests, ~2,000 lines); 11 Swift files load `dist/app/library.js` (`MARGIN_LIBRARY_JS`, T/library-tests.swift:29, hosted-tests.swift:700, …) | the TS tests stay (LT stays as the vectors' reference); the Swift tests run the core |

So the "TS copy that stays" is M (the extension's own rules for spaces, pins, folders, favorites, splits, link rules):
LT has no runtime user once the Mac switches. LT stays, built into nothing, as the adapter that runs M against the
shared vectors (below), so a change to M that changes the library's behaviour fails a test until the Rust follows. Two
live copies of those rules (M in the browsers, Rust in the apps) is what Tirth's step 4 text allows "while Chrome's and
Edge's copies still own spaces"; the vectors are what keeps them one rule.

Size: LT 954 lines, of which the actions are 57 (LT:283-807; the plan said about 40), and the M functions it calls
(~45 of them, ~750 of M's 1,950 lines), plus PR's four rules, AT (79), FI (19) and DS's `fingerprint` (9).

#### What every part shares

- **One module, `core/library/`** (beside `core/data/library.rs`, which stays the store: `LibraryStore`, unchanged):
  `mod.rs` (the `Library` object), `js.rs` (the JavaScript semantics below), `state.rs` (LT's `stateOf`, `valuesOf`,
  `diff`, `targetOf`), `model/` (M's rules: `spaces.rs`, `order.rs` (pins and folders), `kept.rs` (items' places, the
  archive), `favorites.rs`, `links.rs` (AT and M's link rules), `splits.rs`), `actions.rs` (the 57), `import.rs`,
  `snapshot.rs`, `vectors.rs` (tests). The Rust is a transliteration, function by function, with M's and LT's names
  (`place_kept`, `write_order`, `settle_splits`…), so a reader can hold the two side by side; each Rust function's doc
  names its TS line.
- **A typed state, not JSON.** `LibState { spaces: Vec<Space>, pins: Vec<Pin>, favorites, air_traffic, splits, folders,
  archive, kept: IndexMap<Rc<str>, Item>, windows: IndexMap<Rc<str>, Rc<str>> }`, its strings `Rc<str>` so a copy of
  the state copies no text (an item's icon is up to 100,000 units, LT:120). It's built from the store's `DataSet` once
  per revision of the set and kept (`Cached { rev, state, snapshot }`); an action works on a clone (refcounts only) as
  the TS works on spread copies, and `diff` compares the typed `before` and `after` (`PartialEq`), which is what LT:168
  does with `JSON.stringify` on two values built by the same `valuesOf` (same keys in the same order; see numbers
  below for why equality is the same).
- **Exactness against JS** (`js.rs`; each rule a function with its own vectors, generated where a table is involved):

  | JS | Where | Rust |
  | --- | --- | --- |
  | `s.slice(0, max)`, `.length` count **UTF-16 units** | `str(v, max)` LT:43 (every title 2000, name 200, icon 100,000, profile 256), `FOLDER_NAME_MAX` M:1250, `CUSTOM_TITLE_MAX` M:1314, AT:22's 200, `nsId`'s 256 LT:868 | `js::slice16(s, max) -> &str`: cut at `max` units, a prefix of the input (no copy). A cut between a surrogate pair drops the pair (Tirth's answer 3: 1,999 units) |
  | `trim()`, `/\s/` (WhiteSpace + LineTerminator: U+0009, 000A–000D, 0020, 00A0, 1680, 2000–200A, 2028, 2029, 202F, 205F, 3000, **FEFF**) | M:1116, 1139, 1251, 1315, 1503, 1546; AT:21-22; M:1476 | `js::trim`, `js::is_space`: that list exactly. Rust's `str::trim` differs: it trims U+0085 and not U+FEFF |
  | `.sort()` with no comparator: UTF-16 unit order | LT:168-169 (`diff`'s ids), LT:498 (`clearToday`'s items) | `js::cmp16(a, b) = a.encode_utf16().cmp(b.encode_utf16())`; Rust's `str` order is code points, which differs past U+FFFF vs U+E000–U+FFFF |
  | `a.localeCompare(b)` (ICU collation, the default locale) | tie-breaks: spaces' and link rules' equal `order` (LT:89, 96, 885), the archive's equal `closedAt` (LT:119), `openMarginPage` (LT:394), FI:15, M:1482 (`keptOfFavorite`) | `js::Collation::new(locale)` (`compare`): ICU4X's collation for the locale JSC takes, the person's preferred language (`en-US` here; a tailored one reorders ASCII: Danish `aa` after `z`), so the app gives it (commit 6). Measured against JSC (commit 1): every ASCII pair and 70,000 id-shaped and mixed pairs the same; 2,133 Han pairs and 31 Unicode 17 characters differ (open question 1, asked again). Every id Margin makes is ASCII (`sp-`, `t-`, `a-`, `p-`, `fav-`, `atc-`, `spv-`, `f-` + `[a-z0-9]`, `t-` + hex, `<browser>:<profile>:<id>`), where it's still not byte order (`a` < `A` < `b`, `_` < `-` < `:` < digits < letters) |
  | Sort stability, comparators `x - y \|\| …` | every `.sort` | `sort_by` (stable) over `partial_cmp` of finite numbers (always finite: `finite()` first): a total order, so Rust's sort never panics on it (it may, since 1.81, on one that isn't) |
  | Numbers are doubles | `order` midpoints M:530, `TIGHT` 1e-6 M:398, ratios M:1636, `Math.max(-1, …)` M:396 | f64 throughout, the same operations in the same order (no `mul_add`, folds from `0.0` written out as LT:106 and M:1635 do, never `Iterator::sum`, whose empty sum is `-0.0`); `js::round` = JS's `Math.round` (ties toward +∞; Rust's `round` is away from zero: the same for the positive ratios, written as JS's anyway); `js::max` for `Math.max`'s `+0` over `-0` |
  | `JSON.parse` of a number, `String(n)`, `JSON.stringify(n)` | every payload number; `win(p)` LT:192 (`String(p.windowId)`) | every number read as f64 (`9007199254740993` is `…992` in JS); `js::number_string` is ECMAScript's Number::toString (shortest digits, exponent past 1e21 and under 1e-6: `1e+21`); a number written into a value goes through `protocol::number` (integral below 2^53: an integer, `5` not `5.0`), so the text is JS's for every number the library makes |
  | Truthiness, `??`, `typeof`, `Number.isFinite`, `Number.isInteger` | `!!p.front` LT:366, `g.pinned ?` LT:111, `p?.title ?? ''` LT:574, `finite` LT:44 | `js::truthy(&Value)` (false: missing, null, false, 0, -0, NaN, ""), `js::nullish`, `json::num` (a JSON number only: `"5"` isn't finite, as `Number.isFinite`) |
  | `String(x)` on a payload value, `obj[key]` with a non-string key | `M.renamePin(…, p?.title ?? '')` → `String(name)` M:1315 (`123` → `"123"`, `[1,2]` → `"1,2"`, `{}` → `"[object Object]"`); `s.keptTabs[p?.tabId]` LT:372 (a number `5` looks up `"5"`, `["t-a"]` looks up `"t-a"`) | `js::to_string(&Value)` and `js::property_key(&Value)`: ECMAScript's ToString / ToPropertyKey for JSON values. Not reproduced: the prototype's members as ids (`"constructor"`, `"toString"` find a function in JS): open question 4 |
  | A TypeError thrown inside an action | `name?.trim()` M:1116 on a non-string name (`createSpace {name: 5}`), any `.trim`/`.replace` on a payload value that isn't a string: caught at LT:825, `{ ok: false, error: "failed: <the engine's message>" }` | each throw site found by commit 0's survey (random payload types per action against LT), returned at the same point with JSC's words (open question 5) |
  | `new URL(…)` (WHATWG) | `normalizeUrl` M:594-603 (pins, favorites, archive dedupe, `keptForUrl`, `openFavorite`), AT:39-46 (`hostname`, `pathname`) | **None in Margin.app today** (found by commit 1): a bare `JSContext` has no `URL` (WebCore's), so `new URL` throws a ReferenceError that both sites catch: `normalizeUrl` gives the address as it is (`url ?? ''`) and `patternMatchesUrl` is false, so a link rule never routes in the app and `https://a.com` and `https://a.com/` are two addresses there (the browsers' copies parse). `js::normalize_url`/`rules_url` keep that (`RULES_PARSE_URLS = false`); `normalize_url_whatwg`/`url_parts` (the `url` crate: `protocol + "//" + host + path ("/" → "") + search`, as M:597) are the browsers', for open question 11 |
  | `toLowerCase` | AT:24 (a pattern's host), before an ASCII-only check (AT:16) | `str::to_lowercase` (full mapping, final sigma; only the Kelvin sign can change the ASCII outcome, to `k`, the same in both; a dotted I lowers to `i` and U+0307, still refused) |
  | JS object key order (integer-like keys first, ascending; then insertion) | `Object.values(s.keptTabs)` (LT:546, 562, 617: "the first that…"), `Object.entries(values.windows)` | `IndexMap` in the set's order (the store's `DataSet` is a `BTreeMap`: ids in byte order). Today's order is **neither**: L:207 hands JSC the values through `JSONSerialization` (Swift dictionaries: per-launch hash order), so the "first of several equal" today changes from launch to launch; Rust's is the ids' order, every time. Never visible for one match (the usual case); for two equal candidates it's a fixed pick where today's was random (noted in the parts) |
  | `fingerprint` (FNV-1a over `JSON.stringify(v)`'s UTF-16 units, DS:105-113) | `nsId`, `nsTabId` LT:866-873 (imported ids: must be the same ids, or an import run again doubles) | `js::fingerprint(&str)`: JSON.stringify's string escaping (`\"`, `\\`, `\b\f\n\r\t`, other controls `\u00xx` lowercase, everything else raw, U+2028/2029 raw), FNV over its UTF-16 units, `wrapping_mul`, `{:08x}` |
  | `Date`, time zones | none: LT takes `env.now` (L:105, `Date().timeIntervalSince1970 * 1000` rounded) and never reads a clock or a calendar; no action is per day (`clearToday` is per space) | `Env { now, ids }` given by the caller, as today |
  | `Math.random` | `idMaker` LT:182 once the given ids run out (L:107 gives 4 per action; `clearToday` of 4+ items, `createFolder` with an item and a pin…) | the given ids first (same check: `^[A-Za-z0-9]{4,30}$`), then the core's own letters (`getrandom`, Swift's `randomLetters` rule: a byte mod 36, L:280-285); open question 6 |

- **JSON key order in what's stored and what's pushed.** What's stored is each change's value, which Rust builds in
  `valuesOf`'s key order (LT:141-158), as JS does. Today's stored order is arbitrary (the values cross Swift
  dictionaries twice, L:207 and L:234), so nothing reads it and nothing compares it; DS's `fingerprint` (which is
  order-sensitive) is the copies' own queue over their own sets, never the library's. What's pushed is the snapshot (to
  Margin's window's page, parsed by JS: order of keys never read except `Object.values` iteration, where today's is
  arbitrary too) and the requests (to the session, in the core). The vectors compare objects without key order (as
  tests/fixtures/data-merge/README.md says) and arrays with it.
- **Re-entrance**, as step 3's: the library object's FFI entry points take `&MarginLibrary`, its state in
  `RefCell`s, and no borrow is held across a call out (the observers, the session's request handling), because a call
  out re-enters: a perform's observer is Margin's window redrawing (`library.observe` → `onChange` → MWC
  `stateChanged` MWC:1591 → the snapshot), and a request handled by the session reads the library. Today
  ffi/session.rs:400-403's SAFETY note says "never while a library call is under way (the library calls nothing
  back)": step 4 makes the library call back, so `LibraryRef` reads through `&` and the `RefCell`s, and the Rust test
  adapter re-enters the library on every observer and every request to catch a borrow held.
- **Log lines** the library writes (L:144, 209, 269, 274; SL:13, 18; SG:177, 199, 203) keep their words; the core
  builds them where the decision is (the import's counts line, L:273-274), Swift keeps the ones about its own start.
- **No OS calls**: the core reads no clock (the env callback), opens no file but the store's (already the core's), and
  its randomness is `getrandom`, as the link's keys already are.

#### Part 1: the JavaScript semantics (`js.rs`) and the two dependencies

**Today.** Implicit in V8/JSC: the table above. The core has two pieces already: `set.rs:37-39` counts UTF-16 units,
`protocol.rs:33-41` writes integral numbers as integers.

**Core.** `core/library/js.rs` (done, commit 1: also `Collation`, `min`, `max_of`, `num_cmp` for a comparator's `x - y`,
`rules_url`/`url_parts`/`normalize_url_whatwg` with `RULES_PARSE_URLS`, `Ids` and `random_letters`; `slice16` returns `&str`):
`pub fn slice16(s: &str, max: usize) -> Cow<str>`, `len16`, `trim`, `is_space`,
`squash_spaces` (`/\s+/g → ' '`), `cmp16`, `locale_compare`, `round`, `max`, `number_string`, `to_string`,
`property_key`, `truthy`, `nullish`, `finite`, `fingerprint`, `normalize_url`, `is_web_page` (`/^(https?|file):/i`),
`is_http` (`/^https?:/i`), `favorite_url_ok`'s `/^https?:\/\/[^\s/]/i`. All pure, `#[inline]` where hot
(`slice16` returns the input borrowed when it's short, the common case: no allocation).

**FFI.** None.

**Must not change:** every rule above, as JSC runs it on this Mac (not only as Node does: JSC is what Margin.app runs
today).

**Pinned by:** new vectors `tests/fixtures/library/js.json` (commit 0), made by a script that runs each case through
**JSC** (a one-file Swift tool in tools/, `JSContext`, as LR does) and through Node, and records JSC's answers (where
they differ from Node's, the file says so, and Rust follows JSC): `trim` over every code point that's whitespace in
either set, `slice16` over emoji at the cut, `localeCompare` over every pair of printable ASCII characters and over the
ids' shapes (with JSC's default locale on this Mac), `number_string` over ±0, 2^53 ± 1, 1e21, 1e-7, 0.1 + 0.2,
`fingerprint` over quotes, controls, emoji, `normalizeUrl` over WPT-like cases (uppercase host, IDN, default port, `..`,
backslashes, `%7e`, IPv4 in hex, empty path, `file:`).

**Windows:** the same code.

**Measured (commit 1).** Against JSC on this Mac (a `JSContext`, as LR) and Node: spaces over every code point, `\s`
the same list as `trim`; every number, round, string, key and fingerprint edge of the table the same. `localeCompare`:
all 9,025 ASCII pairs, 20,000 two-character ASCII pairs, 20,000 id pairs, 3,000 ids in JSC's sorted order and 30,000
random pairs over accents, marks, Hangul, CJK, emoji and ignorables the same; over every BMP character in JSC's order
1,880 adjacent pairs differ, and 284 in a supplementary sample, all Han (Apple's ICU orders Han by radical and stroke,
ICU4X's compiled data by code point: exact needs ICU4X data baked with `unihan` Han) but 31 characters new in Unicode 17
(ICU4X 2.1 has 16; 2.2+ needs Rust 1.86+). The `url` crate against WebKit (an off-screen WKWebView) and Node on 90
addresses: the same but `https://xn--a.com` (the browsers take it, the crate refuses it). Size (a release binary,
the workspace's profile): the collation +1.26 MB per architecture (1,618,816 against 356,976 bytes, arm64; x86_64 the
same), the WHATWG parser +0.22 MB, both +1.48 MB: over the ~1 MB, so open question 1 is asked again. Neither reaches
the app until commit 6 (margin-ffi doesn't call them; the linker drops them).

**Risks.** ICU collation and the WHATWG URL parser are the two pieces Rust can't write in a page; both are libraries
(open questions 1 and 2), checked against JSC by the vectors. ICU's and Apple's ICU's CLDR versions differ only for
non-ASCII strings; WebKit's URL parser and `url` differ only on IDNA edge cases (both pass the WPT URL tests'
common cases). ~450 Rust lines, ~300 of tests.

#### Part 2: the state from the values and back, the diff, the targets

**Today.** `targetOf` LT:51-63 (a bundle id `^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$`, its name ≤ 100 or the id; a Margin page
of `MARGIN_PAGES`; a web target's browser of `safari|chrome|edge` else Safari, its profile ≤ 256 or null), `placeOf`
LT:70-75, `stateOf` LT:87-137 (each collection read, checked, cut, sorted: spaces by `order` then id, link rules the
same, the archive newest first then id; splits' panes each once, ≤ 4, their ratios at their own places, normalised to
4 decimals, LT:101-115; items only with a `t-` id M:165), `valuesOf` LT:139-160, `diff` LT:163-172 (collections in
`COLLECTIONS`' order LT:24, ids sorted, the changes then the deletions).

**Core.** `core/library/state.rs`:

```rust
pub struct Space { id: Rc<str>, name, emoji, color: Rc<str>, browser: Rc<str>, profile: Option<Rc<str>>, theme: Option<Rc<str>> }
pub struct Item  { id, url, title, icon, space: Rc<str>, order: f64, last_active: f64, was_active: bool, kept_at: f64,
                   target: LibTarget, pinned_by, favorite_id, custom_title: Option<Rc<str>>, imported: Option<Imported> }
// Pin, Favorite, Rule, Split, Folder, ArchiveEntry likewise, each field LT's.
pub enum LibTarget { Web { browser, profile }, App { bundle_id, name }, Margin { page } }
pub fn target_of(v: &Value) -> Option<LibTarget>;                      // LT:51
pub fn state_of(set: &DataSet) -> LibState;                            // LT:87, from the live items in place
pub fn values_of(s: &LibState, imports: &Map<String, Value>) -> Values; // LT:139 (for the import and the vectors)
pub fn diff(before: &LibState, after: &LibState) -> Vec<Change>;       // LT:163, typed: only what differs is built
```

`diff` builds a change's JSON only for an item that differs (today: two `JSON.stringify` per item per action, and the
whole `valuesOf` twice), in LT's order (`COLLECTIONS`, ids by `cmp16`).

`target_of` is the library's rule (the writer's). The session's `session/target.rs` `Target::read` is ItemTarget's
lenient reader of what the library wrote (L:32-47): two rules today, kept two (the session reads only values the
library normalised); both documented as such.

**FFI.** None.

**Must not change:** every check and cut of `stateOf`; that `before` is the stored values read and written again
(LT:820), so a value stored in an older or odd shape isn't rewritten until an action touches it; the ratios' rounding.

**Pinned by:** tests/library.test.ts (`stateOf`, `targetOf`), split-model.test.ts, arc-data.test.ts; the vectors' every
step (each compares the changes).

**Windows:** the same.

**Risks.** `Number.isFinite(g.pos) ? { pos }` (LT:113) keeps a split's `pos` only when it's a number: the typed struct
keeps `Option<f64>`, not `0`. The `imported` object passes through rebuilt (LT:131). ~500 Rust lines.

**Done (commit 2, step4/state), with these lines of the design corrected.** `state.rs` (the records, `LibTarget`,
`target_of`, `place_of`, `state_of`, `JsObject`), `values.rs` (`values_of`, `diff`, `diff_values`, `Change`),
`snapshot.rs` (the text), `import.rs`'s `import_changes` (LT:932-934), `model/mod.rs` (part 3's shared rules and its
six files, see part 3). Corrected:
- `state_of<V: Values>(values: &V, compare: &dyn LocaleCompare)`: over the store's `DataSet` (no JSON built) or values
  as JSON (the import's, the vectors'), and the sorter handed in (Tirth's answer to question 1 again: the system's;
  `js::LocaleCompare`, ICU4X's `Collation` one until the platform's lands, `CodePointOrder` the tests' stand-in).
- The collections are `Rc<Vec<Rc<T>>>` and the items `Rc<JsObject<Rc<Item>>>`, not `Vec`/`IndexMap`: JS's identity is
  kept (`LibState::same` is `next === s`; a record a rule didn't change is the same `Rc`), and a copy of the state is
  nine refcounts. A field M can leave out of a record it makes (a pin's `pos`, M:1265; a favorite's or archive entry's
  `target`, M:1504, 1780) is an `Option`, so `valuesOf`'s fallbacks (`finite(p.pos, i)`, `?? webTarget`) see what JS
  sees.
- JS's key order is **not** the set's order: `Object.entries` lists array-index keys first, ascending (ECMAScript's
  OrdinaryOwnPropertyKeys), and the windows' ids are numbers (`"7"`, `"12"`). `state_of` reads every collection in that
  order and `JsObject` (`keptTabs`, `activeSpaceByWindow`) keeps it, so the snapshot's `activeSpaceByWindow` is
  `{"2":…,"10":…}` as JS writes it.
- The import's diff (LT:934) is not the typed one: it compares the values **as stored** with the rules' reading
  (`diff_values`, `JSON.stringify` equality: key order counts, numbers as doubles), so an import rewrites a stored
  value in another key order or shape and deletes what the rules don't read. `perform`'s `before` is the reading
  (LT:820), so a perform doesn't. `diff` skips a collection both states share, and an item both share (the same `Rc`).
- The snapshot's text is `snapshot_text(&LibState, imported) -> String` (part 6's `Cached` keeps it) and `write_item`
  one kept tab's row (commit 7's cached fragments); numbers as `String(n)` writes them (`1e+21`), strings as
  `JSON.stringify` escapes them.

#### Part 3: the model's rules (M's ~45 functions, PR, AT, FI)

**Today.** Spaces: `createSpace` M:1113-1122, `orderSpaces` M:1126-1131, `updateSpace` M:1135-1155, `deleteSpace`
M:1422-1455 (its cascade: items, pins (unless the first space has the address), folders after the first space's own,
archive, windows, link rules dropped, splits moved, then `settleBindings` M:635-656), `setActiveSpace` M:1087-1090,
`themeIdOk` M:1110-1111. Pins and folders: `posOf`…`folderHasAncestor` M:1161-1197, `pinOrder` M:1200-1215 (folders
first at equal places), `writeOrder` M:1218-1239 (only what moved rewritten), `placed` M:1242-1248, `uniqueName`
M:1253-1260, `addPin` M:1263-1268, `removePin` M:1270-1274, `bindTabToPin` M:1277-1288, `unbindPinTab` M:1290-1311,
`renamePin`/`renameTab` M:1314-1344, `movePin` M:1346-1358, `createFolder` M:1362-1374, `renameFolder`,
`setFolderOpen`, `moveFolder` (the cycle guard and `MAX_FOLDER_DEPTH` 4) M:1376-1407, `deleteFolder` M:1410-1419;
PR's `FAVORITES_CAP` 12, `MAX_FOLDER_DEPTH`, `favoriteScopeOf`, `folderDepth`, `boundElsewhere`. Items:
`placeKept`/`placeBeside` M:491-531 (a midpoint, `TIGHT` renumbering M:460-478), `archiveKept` M:317-322,
`archiveTab` M:1777-1784 (one entry per normalised address, newest first, `ARCHIVE_CAP` 200), `forgetKept` M:324-329,
`keptForUrl` M:349-355, `moveTab` M:1069-1083, `heldBindings` M:624-633, `removeArchived` M:1794-1796. Favorites:
M:1460-1591 (`favoriteUrlOk`, `keptOfFavorite`, `addFavorite`'s cap and duplicate check, `renumberFavorites`,
`moveFavorite`, `renameFavorite` (≤ 40), `bindTabToFavorite` (drops `pinnedBy`)). Link rules: AT (`normalizePattern`,
`patternMatchesUrl`, `matchAirTrafficRule`), M:1594-1624 (cap 100, a same pattern replaced). Splits: M:1628-1775
(`normalizeSplitRatios`, `paneKey`, `splitForItem`, `withPanes`, `createSplit`, `addToSplit`, `removeFromSplit`,
`settleSplits`, `swapSplitPanes`, `resizeSplit`, `toggleSplitAxis`). FI `frontItemOf`.

**Core.** `core/library/model/*.rs`, each a `fn(&LibState, …) -> LibState` (or `Cow`: unchanged returns the same,
which `pinTab`'s `next === s` LT:532, `createFolder` LT:791 and `addFavorite` LT:601 test). The open-tab halves of M's
functions (`state.tabs`, `tabSpace`: the extension's open tabs) aren't ported: the library's state has none (LT:136
`tabs: {}`), so each port takes the kept half only, and says so.

**Three pieces at once (laid out by commit 2).** "Unchanged returns the same" is `s.clone()` (`LibState::same`), not a
`Cow`. `model/mod.rs` holds what more than one piece needs (`has_space`, `pos_of`, `pin_of_space`, `has_favorite`,
`bound_elsewhere`, `held_bindings`, `settle_bindings`, `FOLDER_NAME_MAX`, `MAX_FOLDER_DEPTH`, `FAVORITES_CAP`; with
tests) and declares six files, each with its functions and M lines in its header; no piece calls another's: (1)
`spaces.rs` + `order.rs` (deleteSpace's cascade uses `pinOrder`, `writeOrder`, `pinForUrl`, the same piece's, and
`settle_bindings`); (2) `kept.rs` + `favorites.rs` (FI's `frontItemOf` in kept.rs; `favoriteScopeOf` answers
`DEFAULT_SETTINGS.favoritesScope`'s, as the library's state has no settings); (3) `splits.rs` + `links.rs`. Each
piece adds only to its own two files and their tests (`model/<file>_tests.rs`).

**Piece 1 done (step4/model-spaces), with these lines of the design corrected.** `spaces.rs` (`set_active_space`,
`create_space`, `order_spaces`, `update_space`, `delete_space`) and `order.rs` (`pin_for_url`, the folder lookups,
`folder_depth`, `pin_order`, `write_order`, `placed`, `folder_name`, `unique_name`, `clean_custom_title`, `add_pin`,
`remove_pin`, `bind_tab_to_pin`, `unbind_pin_tab`, `rename_pin`, `rename_tab`, `move_pin`, `create_folder`,
`rename_folder`, `set_folder_open`, `move_folder`, `delete_folder`). Corrected:
- A parameter library.ts fills straight from a payload (`p?.folderId ?? null`, `p?.name`, `p?.tabId`) is an
  `order::Arg` (undefined, a JSON value, or a string the caller has), not a `&str`: M tests it as JS does, and the tests
  differ by rule (`movePin` refuses a truthy folder id that's no string and takes a falsy one as the top level;
  `moveFolder` refuses any parent but null that isn't a folder's id, `""` and `0` too; `renameTab` with an array as
  the id, which library.ts's own check finds by its key, is an open tab's in M: unchanged). Part 4 builds each with
  `Arg::of(p.get(…))` (and `.or_null()` for `?? null`). Used by the other pieces too, it belongs in `model/mod.rs`.
- `create_space` answers `Result<LibState, &str>`: `name?.trim()` throws for a name that's neither a string nor
  nullish, the throw survey's only site; the error is JSC's words (`CREATE_SPACE_NAME_THROWS`).
- **A gap of the typed state**: `createSpace` stores a truthy emoji or colour that's no string as given (`emoji: 5`,
  `color: ["t-x"]`: 17 steps of the generated vectors), which `Space`'s `Str` can't hold. `create_space` writes `""`, what
  the next reading of it is (`str(5, 16)`), so every later state is the same and only that step's stored change
  differs. Exact needs `Space.emoji`/`color` able to hold a raw value (state.rs, values.rs), or part 4 refusing such
  a payload (a behaviour change): not decided here.
- Checked: 39,200 generated steps against model.ts in Node and 35,000 in JSC, none differ; the shared vectors' 2,304
  perform steps of the 16 actions these rules answer alone, the same; 81 deliberate breaks, 78 caught, 3 equivalent
  (DECISIONS.md, 2026-11-23).

**FFI.** None.

**Must not change:** every number (places, ratios), every refusal (a 5th pane, a 13th favorite, a 5th folder level, a
101st rule, a cycle), every cascade, and "unchanged is the same state" (it decides `result: null` vs an id).

**Pinned by:** tests/sticky-pins, nested-folders, favorites, split-model, split-view, air-traffic, arc-data, arc-qol,
front-item, model.test.ts's cases that go through LT; the vectors.

**Windows:** the same.

**Risks.** M is shared with the extension, which keeps changing it (`refactor/feature-names`, the Arc suite): a change
to M after commit 0's recording fails the TS vector run; the fix is the same change in Rust in the same commit (the
rule for the rest of the copy's life). `pinOrder`'s "folders first at equal places" relies on the stable sort.
~1,400 Rust lines.

**Done, piece 3 (step4/model-splits): `splits.rs`, `links.rs`.** M:1594-1775 and AT, function by function. Corrected
or added here:
- `matchAirTrafficRule`'s sort is `Number(order) || 0` alone, stable (the stub said ties by `localeCompare`: that's
  `stateOf`'s, which already sorted the list by `order` then id, so the match walks it as it is).
- Today's no-URL behaviour is the library's (`js::rules_url`): no link rule routes. The parsed path is written and
  tested beside it (`pattern_matches_parts`, `match_air_traffic_rule_with` over `js::url_parts`, against Node with a
  URL), so the URL commit flips `RULES_PARSE_URLS` and the tests that pin today's answer (links_tests.rs
  `no_address_matches_today`).
- `paneKey` of a number or a string of digits is none (an open tab's browser id; the library has none), so
  `split_for_item` takes a string and `split_for_value` a payload's value; `swap_split_panes` takes LT's integers as
  doubles (`-0` is 0) and refuses a fraction, which LT never gives.
- `settle_splits` (after every perform that succeeds) allocates nothing when every split holds.

#### Part 4: the 57 actions and `perform`

**Today.** `ACTIONS` LT:283-807, `ACTION_NAMES` LT:810, `perform` LT:816-832 (unknown → `unsupported`; a throw →
`failed: …`; an error → no changes, no requests; `settleSplits` after every success, LT:830), the ids LT:177-185, the
helpers LT:192-281 (`win`, `windowSpace`, `frontOf`, `lastPlace`, `spaceTarget`, `used`, `pinOfItem`, `addItem`,
`archiveItem`, `splitRefusal`'s four words, `splitShown`, `splitNext`). Swift: L:205-227 (`env` from `now()` and
`randomIds()`, the outcome, the changes applied L:231-240 with a second `now()`, the requests recorded (last 100,
L:93, 220-223), then the delegate per request L:225).

**Core.** `core/library/actions.rs` and `mod.rs`:

```rust
pub struct Env { pub now: f64, pub ids: Vec<String> }
pub struct Outcome { pub ok: bool, pub result: Value, pub error: Option<String>, pub changes: Vec<Change>, pub requests: Vec<Object> }
pub fn perform(state: &LibState, imports: &Map<String, Value>, action: &str, payload: &Value, env: Env) -> Outcome; // LT:816, pure
pub const ACTION_NAMES: [&str; 57];                                                                                 // LT:810, sorted as JS sorts

pub struct Library { store: RefCell<LibraryStore>, cache: RefCell<Option<Cached>>, requests: RefCell<VecDeque<Object>>,
                     env: Box<dyn Fn() -> Env>, now: Box<dyn Fn() -> f64>, changed: Box<dyn Fn(&BTreeSet<String>)>,
                     sink: RefCell<Option<Weak<dyn RequestSink>>> }
impl Library {
    pub fn perform(&self, action: &str, payload: &Value) -> Performed;  // L:205-227: env, rules, apply at now(), observers, log, sink
    pub fn actions(&self) -> &'static [&'static str];
}
pub trait RequestSink { fn library_request(&self, body: &Object); }     // the session (step 3's Session::library_request)
```

The order inside `Library::perform` is L's: the rules; the changes applied at a second `now()` (`LibraryStore::apply`,
unchanged); the observers told with the collections changed (only when some changed, L:236); the requests recorded;
then each request to the sink. Each request's body is LT's object as built (its `windowId` the payload's, passed
through as JS would: a number through f64).

Each action is one Rust function with LT's name, its body LT's line by line. `closeSplitPane` (LT:752) and
`mediaControl`'s `focus`/`mute` (LT:465-466) call the other actions, as LT does; `renameSpace` runs `setSpaceProfile`
on its result (LT:310).

**FFI.** `margin_library_call {"type":"perform","action","payload"}` → `{ ok, result, error, changed, requests }` (a
click: rare; the payload is small; the answer no longer carries the changed collections' whole values, which L:325
takes today to refresh its cache: part 7).

**Must not change:** every action's result, error words (`no such item`, `the last space`, `a split has 4 panes at
most`, …: the vectors hold them), request types and fields, `unsupported` for an unknown name and for `__proto__`-like
names (`Object.hasOwn`, LT:817), that a failed action changes and asks nothing, `settleSplits` after every success, the
4 ids a perform gets from Swift (tests set `library.randomIds`) and the second clock read for the times.

**Pinned by:** every TS test above (through the vectors), T/library-tests.swift:25-124 (spaces in their own files, the
requests and the delegate, the times always newer, the snapshot, kept on disk), T/hosted-tests.swift 695-1155,
peek-session, peek-split, split, split-real-use, pane-fronting, multi-host-session, screen-card, session-rules tests
(all perform through the real rules); E/e2e-glue.swift, E/e2e-hosted.swift.

**Windows:** `Library::perform` directly, `Env` from `SystemTime` and the core's letters.

**Risks.** The "first of several" picks (`openPin`'s bound item LT:546, `resetPin` LT:562, `openFavorite`'s address
match LT:617, `keptForUrl`'s equal `lastActive`): a fixed id order where today's was a per-launch hash order; the
vectors are recorded with the values in the Rust order (the recorder sorts each collection's ids by code point before
calling LT, see part 8), so both copies pick the same. ~900 Rust lines.

#### Part 5: the import

**Today.** `importValues` LT:875-935 (each set's spaces, folders, pins, items (web pages only), archive (a gone space's
entries to the profile's first), namespaced by `nsId`/`nsTabId` LT:866-873; the order: the library's own first, then the
person's, then the rest; `imports.done` with `at`, `sets`, the counts; the result normalised through `stateOf`/`valuesOf`
so the next action changes nothing, LT:933). Swift `importOnce` L:249-276: once (`imports.done`), every profile's set
the data store has (Safari first, then by name), each browser's person's order from `BrowserProfiles.resolve` (the
slots rule, already the core's: data/profiles.rs since step 1.4), the counts' log line.

**Done in commit 1** (step4/js, import.rs): `import_values(current: &Map, sets: &[ImportSet], order, now, &Collation) ->
Imported { values, counts }`, LT:875-931 (the values with the import in them), with `ImportSet::from_json` (LT:881's
filter), `ns_id`, `ns_tab_id`; LT:933-934 (`valuesOf(stateOf(next))` and `diff`) join it with part 2's state.rs.

**Core.** `core/library/import.rs`: `pub fn import_values(current: &DataSet, sets: &[ImportSet], order: &[(String,
String, String)], now: f64) -> (Vec<Change>, Counts)` (LT:875), and `Library::import_once(&self, data: &DataSync) ->
bool` (L:249-276 whole: the sets read from the core's data object, the order from `profiles.rs`, the log line in its
words). The import reads the copies' sets by their fields (`spaces`, `pins`, `folders`, `tabs`, `archive`) as LT does
and writes nothing in them (they're the copies' own files: data/<browser>/<profile>/). LT:934's `diff(current, normal)`
compares the stored values **as given** (`JSON.stringify` of each: their key order counts), not their normal form as
`perform`'s `before` does: a stored value whose keys come in another order than `valuesOf` writes them is written again,
the same value (found by commit 0: in the app today the values cross Swift dictionaries, so the first import rewrites
the library's own values; the vectors' `import` steps keep the order the TS tests gave).

**FFI.** `margin_library_import(library, data) -> answer` (typed: the `MarginData` pointer; once a launch).

**Must not change:** the ids (`nsId`/`nsTabId` must give the same ids for the same sets, or an import run again after
a crash doubles them: `fingerprint` exactly, part 1), the order, the marker's shape (an older Margin reads it and
doesn't import again), "nothing in the sets changed".

**Pinned by:** tests/library.test.ts's import cases (`nsTabId`, the order, the rerun), T/library-tests.swift:126-174
(`importChecks`: two profiles with a `personal` space and the same tab id, browser.json's order, the files byte for
byte unchanged, the marker alone when nothing to import).

**Windows:** `import_once` at each start; §10 item 9 (a marker per set, so a Chrome or Edge profile seen later is
imported once) is a behaviour change for §11 step 8, made in Rust after step 4 (open question 8).

**Risks.** None past `fingerprint`'s. ~250 Rust lines; ~30 Swift lines deleted.

#### Part 6: the snapshot and what the UI draws

**Today.** LT `snapshot` LT:839-852 (the State shape `fromStorage` reads: spaces, pins, favorites, link rules, splits,
folders, archive, `openTabs.keptTabs` and `activeSpaceByWindow`, `library: { v, imported }`). Each draw of each Margin
window (MWC `stateChanged` MWC:1591-1600, each library change, each session change, each profile-source change; and
`pageHello` MWC:1621) runs `LibraryWindowSource.snapshot` HS:2374-2380: `library.snapshot()` (L:142-148: every
collection's values through `JSONSerialization` to text, into JSC, `stateOf`, `JSON.stringify`, the text parsed back
by `JSONSerialization`), `profileSource.snapshot()` (SH:99-109, the whole State rebuilt by `SH.state`
SH:140-196, to take two keys; step 3 part 13 cuts this to `settingsAndIcons`), `session.live` HS:2269-2298 (open items
moved from `keptTabs` to `tabs` with their numbers), then MWC `jsonString` (text again) and the spaces' theme read from
the dictionary (`spaceTheme` MWC:1605-1612, SH:217). That's the library's values serialised three times and parsed
twice per draw, plus the dictionaries between: about 125 KB on Tirth's Mac today (30 items, 87 archive entries; the
icons are inline `data:` text), so ~2–4 ms a draw now (an estimate: commit 0 measures it), growing with the archive (cap
200) and the items (cap none in the library; 500 in the extension).

**Core.** `core/library/snapshot.rs`: `Library::snapshot_text(&self) -> Rc<str>`: built once per revision of the set
(the `Cached`), from the typed state; per draw nothing of it is rebuilt. With step 3 part 10's `live_plan` (which items
are open tabs, their numbers, `active`, `visible`, sound) in the core, the state a window draws is composed in the core:
`Session::state_text(window) -> String`: the cached snapshot's parts written out with each open item's row moved from
`keptTabs` to `tabs`/`tabSpace` (each item's JSON fragment cached with the snapshot, so a draw is copies of cached
text and the few open rows: no parse, no per-item allocation). `Library::space_theme(window) -> Option<&str>` is MWC's
`spaceTheme` (a window's space, else the first; a theme id ≤ 41 characters).

The profile's `settings` and `favicons` stay Swift's (UserDefaults overlays: SH:17-63, the Mac's): Swift keeps their
text cached (re-made on its own `onChange`) and splices it into the core's state text the way `pageHello` already
splices (MWC:1631: the closing brace dropped, `,"settings":…,"favicons":…}` added).

`DataSetWindowSource.state` (SH:140-196, a third copy of the snapshot) and the no-rules fallback (SG:176-179: "its rules
didn't load") go: the rules can't fail to load (step 3 open question 6's default was "kept until step 4").

**FFI.** `margin_session_state(session, window, out_len) -> *mut u8` (the state's text for a window: one call per draw,
no JSON in); `margin_library_space_theme(library, window, out_len)` (typed); `margin_library_call {"type":"snapshot"}`
kept for the tests (the snapshot as JSON).

**Must not change:** the snapshot's shape and values (`fromStorage` reads it in host-app.ts:430 and the UI tests read
its fields), the order of arrays (spaces by order, archive newest first), `library.imported`, the open rows' fields
(`liveTab` HS's, step 3 part 10's), the theme chosen per window.

**Pinned by:** tests/library.test.ts and arc-data.test.ts's snapshot cases (through the vectors' `snapshot` steps),
tests/ui-host-app.test.ts (the shape drawn), T/margin-window-tests.swift:221-261, 285-300 (the source, settings across
launches), T/hosted-tests.swift 824, 834-840 (rows); a draw's cost measured before and after (off screen: a T/ timing
over 50, 500 and 2,000 items with 2 KB icons, and the `idle-cost` screen part when the screen suite runs).

**Windows:** the same `state_text` for its WebView2 page (§10 item 7's hello and pushes).

**Risks.** The keptTabs object's key order in the text is the ids' (today's is a hash order): the UI's `nextFront`
(ui/intents.ts:48-60) takes the first of equal `lastActive` in that order; a fixed pick where today's varied. Needs step
3 part 10 merged first (or `live` stays Swift over the snapshot's dictionary for one more commit: commit 6 without 7).
~60 Swift lines deleted with the fallback (SH:134-196), ~25 of `live`, ~20 of the snapshot's glue; ~350 Rust lines.

#### Part 7: the library object, the FFI, the session's direct call

**Today.** `MarginLibrary { library: LibraryStore }` ffi/data.rs:46-48, `margin_library_new` ffi/data.rs:255-271 (the
store's root, the writer's wake), `_call` ffi/data.rs:287-318 (`values`, `apply`, `written`, `rev`), `LibraryRef`
ffi/session.rs:395-414 (`LibraryView` through `&mut`). Swift: `LibraryCore` L:290-329, `Library` L:89-286 with its
cache of every collection (L:99-100, refreshed from each apply's answer L:237), its reads (L:133-189), its observers
(L:194-200). The session's edits: `Command::Perform` core/session/mod.rs:131-133, 157-158, `Session::perform`
core/session/mod.rs:651-654 (answered in the same turn: `exec.command(…, true)`), answered by Swift's HS:608-611; the
requests come back through the Swift delegate (HostedSession `LibraryDelegate` HS:335, `library(_:wants:)` HS:904 →
the session's `library` input → `library_request` core/session/requests.rs:192).

**Core.** `MarginLibrary { library: margin_core::library::Library }`, every entry `&MarginLibrary`. The session holds
the library through `LibraryView` (unchanged: `item`, `collection`) and a new `LibraryEdit` (`perform(&self, action,
payload) -> Performed`), both implemented by `LibraryRef` over `&Library`. `Session::perform` becomes the direct call:
the library runs the action, tells Swift's observers (a C callback: Margin's window redraws, re-entrant), and gives
each request to its sink, which is the session (`margin_session_new` registers it: `library.set_sink(weak)`), so the
requests reach `library_request` inside the perform, at the point L:225 reached them, and the flow goes on after, as
step 3 made it. `Command::Perform`, HS:608-611, HostedSession's `LibraryDelegate` conformance and its
`library(_:wants:)` go.

A perform Swift makes itself (a UI request through `LibraryWindowSource.perform` HS:2382-2456, the tests) goes the same
way: Swift calls `margin_library_call perform`, the core tells the session (its sink) inside the call. Swift's
`LibraryDelegate` stays only for a library with no session (T/library-tests.swift's `RecordingLibraryDelegate`, :8): the facade calls
it with the answer's requests when no session is the sink.

The env: one C callback `MarginLibraryEnv(ctx, *mut MarginLibraryEnvOut)` the Swift facade answers from its `now` and
`randomIds` closures (so the tests' `library.now = { clock }`, `library.randomIds = { … }` stay), and `MarginLibraryNow`
for the second read (the times). The observers: `MarginLibraryChanged(ctx, collections, len)` (the names as JSON: a few
bytes), which runs Swift's `observe` closures in their order (L:238).

`Library.swift` stays a facade with the same API the app and T/ read (`perform`, `snapshot`, `spaces()`, `items()`,
`target(ofItem:)`, `split(…)`, `space(ofWindow:)`, `liveValues`, `observe`, `importOnce`, `requests`, `isImported`,
`actions`), each over a core call; its cache goes (the reads that remain in Swift after step 3 are the start's log
lines, SG:196-203, SL:18, and the tests: one JSON call each, never per frame).

**FFI.** `margin_library_new(root, len, background, ctx, wake, env, now, changed)` (three callbacks more),
`margin_library_call` gains `perform`, `snapshot`, `actions`, `item`, `requests`; typed `margin_library_import`,
`margin_library_space_theme`; `margin_session_state` (part 6). Panic-free as the others (a bad request: `{"error"}`,
logged once a kind).

**Must not change:** that a perform's requests are handled by the session before the perform returns, after its
observers ran (re-entrant, as L:215-225); the 100 requests kept (L:93); the writer's wake and `written`.

**Pinned by:** core/session/requests_tests.rs (today against a stand-in shelf answering `Command::Perform`
requests_tests.rs:33, 207, 225, 520: switched to the real library, the stand-in deleted), core/session/tests.rs:345,
589; T/hosted-tests.swift `hostedTests` and `hostedSupersedeTests` (the requests' order with re-entrance).

**Windows:** the session's sink is the same; Windows has no facade (it calls `Library` directly).

**Risks.** The re-entrant observer is new to the library object (part "Re-entrance" above). ~120 Swift lines deleted
from L (the cache, `apply`, `importOnce`'s body, the rules' calls), ~74 of LR, ~10 of HS; ~80 added (the callbacks);
~300 Rust lines (ffi), ~150 of tests.

#### Part 8: the shared vectors

**Format** (commit 0, stable: tests/fixtures/library/README.md has it whole). `tests/fixtures/library/`:
`cases/*.json` (the steps: `recorded-<test>.json` per TS test file, `generated-00…11.json`, `edges.json`, `survey.json`), `throws.json`
(the throw survey: site → `jsc` and `node` words, `where`, a payload that does it) and `js.json` (part 1's cases, JSC's
answers). A case file is `{ about, from, cases: [{ about, values, steps }] }` (a file holds many cases: the design's one
case a file would be ~350 files):

```json
{ "about": "…", "from": "recorded",
  "cases": [ { "about": "library.test.ts: library: spaces are created, …",
    "values": { "spaces": { "a": { … } }, "tabs": { … } },
    "steps": [
      { "perform": "createSpace", "payload": { "windowId": 7, "name": "  Work " }, "env": { "now": 1001, "ids": ["id1x", "id2x", "zq000001x"] },
        "expect": { "ok": true, "result": { "spaceId": "sp-id1x" }, "changes": [ … ], "requests": [] } },
      { "perform": "createSpace", "payload": { "name": 5 }, "env": { … },
        "expect": { "ok": false, "result": null, "error": { "failed": "createSpace: name?.trim is not a function" }, "changes": [], "requests": [] } },
      { "snapshot": true, "expect": { … } },
      { "import": { "sets": [ … ], "order": [ … ], "now": 5 }, "expect": { "changes": [ … ], "counts": { … } } },
      { "normal": true, "expect": { … } },
      { "target": { "kind": "app", "bundleId": "com.apple.Notes" }, "expect": { … } } ] } ] }
```

Steps run in order; after a `perform` or `import` its **expected** changes are merged into the values (a value or a
deletion, a new id in code-point order; the times are the store's, never the rules'), so one wrong step fails alone.
`values` lists each collection's ids in code-point order (the store's `BTreeMap`; the recorder hands LT that order, part
4's "first of several"; JS still iterates integer-like keys, the windows', first: no rule's outcome depends on them).
`normal` is `valuesOf(stateOf(values), values.imports)` (part 2's round trip), `target` is `targetOf(raw)`. `env.ids`
always lists enough ids (the test's own, then fixed `zq000001x`…; never the random fallback: a step that drew
`Math.random` isn't recorded). `expect.result` is null when there's none; `expect.error` only when not `ok`: a refusal's
words, or `{ "failed": "<site>" }` for a throw, the site `<action>: <Node's words>`, its JSC words in throws.json.
Flags on a step: `"url": true` (the answer differs when addresses are parsed: today's has no URL, the URL commit
re-records these), `"cut": true` (LT's answer held half an emoji: dropped, Tirth's answer 3), `"engine": "jsc"` (Node
differs: JSC's kept; none today). Comparison: JSON values, object key order ignored, numbers as doubles, arrays in
order.

**Where from** (`npm run library:vectors`, tests/library-vectors/record.ts, ~8 s). (1) **Recorded**: hooks.ts sends
the ten TS files' imports of LT to wrap.ts (the same module, its `perform`, `snapshot`, `importValues`, `stateOf`,
`targetOf` and `call` recorded with their inputs made the vectors' first: plain JSON, ids sorted, ids padded) and of
node:test to node-test.ts (the test's name kept); each file runs and must pass. The TS tests stay as they are.
(2) **Written by hand** (edges.ts → `cases/edges.json`): the ties (a Settings item, a favorite's items, a pin's, the
front item, spaces and link rules at equal orders, the archive at equal times, a clear of more items than the app's 4
ids), the cuts, JS's spaces, addresses with no URL, numbers, payload keys. **Generated** (generate.ts, seeded): 300 random libraries and sequences of 30 steps (every action and 6 names that
aren't, payloads of right and wrong types, ids that exist and don't, emoji at every cut, JS's odd spaces, equal places
and times, addresses that differ by a slash or a fragment), and the **survey**: every action with each payload field as
each of 12 wrong JSON types. (3) **js.json**: tests/library-vectors/js-cases.js over LT's own functions (bundled as the
app's library.js is). Every answer is LT's in Node with `URL` taken away (a bare JSContext has none), then every case
runs again in **JavaScriptCore** (tools/library-vectors/jsc.swift: dist/app/library.js as the app builds it) and JSC's
answer is the one kept; a throw's site is named from the stack of an instrumented copy of LT made at run time.

**Run by.** `tests/library-vectors.test.ts` (Node, LT without `URL`: part of `npm test`), `core/library/vectors.rs`
(`cargo test`: a part's test implements `vectors::Engine` for the kinds it has, the rest answer `None` and are
skipped and counted, and `vectors::run(&mut engine).assert_ok()`; `vectors::groups()`, `groups_named(prefix)`,
`data_set(&values)`, `js()`, `throw_words()`; vectors_tests.rs checks js.json against js.rs), and until the switch
(commit 6) T/library-vectors-tests.swift (`npm run test:app`): the same files through LR, since JSC is what the Mac
runs. After LT is deleted (when M's space-owning half goes, feat/hosted-windows-chromium step 9), the vectors stay,
Rust only, as data-merge's outlived DataSet.swift.

**Must not change:** a vector re-recorded only with a rule changed on purpose, in the same commit as both copies'
change.

#### Part 9: the switch-over on the Mac, and data compatibility

**No window where both run.** Commits 1–5 add Rust beside the JSC rules without the app using it; the only place both
run is the test run (T/: a shadow check that sends every perform, snapshot and import of the whole Swift suite through
both and fails on the first difference; T/ only, never in the app: built in commit 0 as T/library-vectors-tests.swift's
`LibraryShadow`, which exchanges JSValue's `call(withArguments:)` for the run, so every LibraryRules call is seen with
no change to the app's Swift, gives both engines the same text (the values' ids in code-point order, the env's ids
valid and enough), and compares; its second engine is a second JSContext until commit 5 makes it the core). Commit 6 switches in one change: `Library.open`
makes the core's library, LR and `JSContext` go, `library.js` leaves `APP_FILES` (scripts/build.ts:148; tests/ui-host-
app.test.ts:724 follows), `MARGIN_LIBRARY_JS` leaves the 11 Swift test files, `Command::Perform` goes. No runtime flag,
no fallback: a build has one copy or the other.

**Data, both ways.**
- The files are the core's store's since step 1 (data/app/set.json, items/, `FORMAT` 1, a later format refused); step
  4 doesn't touch the store.
- The values Rust writes are LT's values: same keys, same types, same numbers (integral as integers, as JS writes them;
  a fraction as its shortest round-trip digits; past 1e21 or under 1e-6 the exponent's spelling may differ, `1e21` vs
  `1e+21`, the same number). The vectors compare every change's value.
- An older Margin (JSC rules) reading what Rust wrote: the same shapes, so the same state, because every vector checks
  that Rust writes exactly LT's changes. (Corrected by commit 0: "Rust's output fed back through LT's `stateOf` gives
  no change from `valuesOf(stateOf(…))`" doesn't hold for LT itself: a change writes only what moved, so a space's
  `order` read back can differ, and a value of an odd type is written as given and read as `''`. LT:932's "no change
  on the next action" is the import's, whose values it normalises whole.)
- The marker `imports.done` keeps its shape, so neither an older Margin nor the new one imports again.
- The extension's copies never read data/app; the import reads their sets read-only (part 5). Their own data and its
  sync (data-merge, DS) are untouched by step 4.
- Downgrading after step 4 is safe (same data); key order inside a stored value is Rust's `valuesOf` order (today's is
  Swift's hash order), which no reader depends on.

**Pinned by:** commit 6's gate and screen suite; a one-off check in commit 6 that Tirth's own library (read from a copy
of data/app, off screen) gives the same snapshot through JSC and Rust.

#### Part 10: Windows

Windows runs the library with no JS engine and no FFI: `margin_core::library::Library` over `DataStore::flat`
(`data\app\`, §10 item 8: already the core's), `perform`/`import_once`/`state_text`, `Env` from `SystemTime` and the
core's letters, the session's sink as on the Mac. §9 decision 2 (QuickJS, a web view, or a Rust port) is answered by
this step. §10 items 9 (the import per set) and 10 (Windows apps as items: `{ kind: 'app', appId, path?, name }`) are
behaviour changes, not in step 4: after it, in Rust (open question 8). Nothing of step 4 is Windows-specific; the
Windows thread starts §11 step 6 on the core's library.

#### Order (one commit each; `npm run test:quick` each; the gate and the screen suite before the merge)

Branch refactor/core-library off refactor/hosted-only once step 3 is merged (step 3 part 10's `live_plan` is needed by
commit 7 only).

| # | Commit | Swift / TS deleted | Rust in (with tests) | Measured after |
| --- | --- | --- | --- | --- |
| 0 | **Done** (step4/vectors): the vectors and the edges, against the TS (Node and JSC) before any Rust: the recorder and its ~70 tests' vectors, the generated sequences, `js.json` from JSC on this Mac, the throw survey (every throw site and JSC's words), the Mac's outcome for a 2000-unit cut through an emoji (LT:43 → JSON → `JSONSerialization` → the store), the shadow harness in T/ (JSC only for now). Baselines (off screen, T/ timings): a perform, a draw's snapshot over 50/500/2,000 items, the app's binary size and footprint | 0 | 0 (~400 TS and JSON, ~150 Swift test lines) | the baselines |
| 1 | **Done** (step4/js, da34b9b4): part 1: `js.rs`, the `url` and collation dependencies (open questions 1, 2), and part 5's `import_values` up to its normalising (import.rs) | 0 | ~450 + ~300 tests | binary size: +1.26 MB a architecture (collation), +0.22 MB (URL) |
| 2 | **Done** (step4/state): part 2: the typed state, `state_of`, `values_of`, `diff`, `target_of`, the snapshot's text, the import's normalising (`import_changes`), part 3's shared rules and files; the snapshot vectors pass once commit 0's are merged (until then: 5,000 generated libraries and 5,000 imports against library.ts) | 0 | ~2,000 + ~1,000 tests | a snapshot's text 0.26 ms at 500 items (JSC 4.7 ms), a perform's diff 1-22 µs |
| 3 | Part 3: M's rules, PR, AT, FI (parallel: spaces + order; kept + archive + favorites; splits + link rules). Piece 1 (spaces + order) **done** (step4/model-spaces); **splits + link rules done** (step4/model-splits) | 0 | ~1,400 | piece 1: a rule 0.2–140 µs, with perform's diff 1–920 µs (2,000 items; JSC's perform 62 ms) |; splits + links: `settle_splits` 0.4 µs with nothing to change |
| 4 | Part 4: the 57 actions and `perform`; every perform vector and the generated sequences pass | 0 | ~900 | a perform (Rust alone) |
| 5 | Part 5 and part 7's object: `import_values`, `import_once`, `Library` with its callbacks, the FFI; the T/ shadow check runs JSC and Rust on the whole Swift suite | 0 | ~700 | |
| 6 | **The switch**: `Library.swift` over the core, LR and JavaScriptCore gone, `library.js` out of the app, `Command::Perform` and the Swift delegate path gone, the no-rules fallback gone, the Swift tests on the core, the stand-in shelf in requests_tests.rs replaced by the real library | ~250 Swift (LR 74, L ~120, HS ~10, SG ~5, SH ~60 of `state` and the fallback) (+~80 Swift of callbacks) | ~150 | a perform, a switch, `idle-cost` |
| 7 | Part 6 per draw: `state_text` with `live` joined, `space_theme` typed, the settings' text spliced, `live`'s Swift and the snapshot's dictionaries gone | ~45 Swift | ~350 | a draw, `idle-cost`, footprint |
| 8 | LT built into nothing (`buildApp`), its header saying it's the vectors' reference; DECISIONS.md "the library's rules are margin-core's" (replacing 2026-11-15's "one copy of the rules: the TypeScript model in JavaScriptCore"); this plan's step 4 marked done | ~5 TS (build) | 0 | |

About 300 Swift lines deleted (~80 added), JavaScriptCore no longer used by the app (check: `otool -L` and the
project's frameworks; WebKit's own JSC stays, the page needs it), 0 TS deleted now (LT's 954 lines stay as the
reference until M's space-owning half goes), ~4,800 Rust lines in (~1,700 of them tests), ~1–3 MB of vectors (JSON,
the generated ones the most). Commits 1–4 have no Swift change and can be split across parallel worktrees: commit 0
(vectors), part 1 (`js.rs`), part 2 (state), part 3 in three pieces, part 5's `import_values`: **6 parallel parts**,
then 4 (the actions, which need 1–3), 5, 6, 7, 8 in order. Budgets as before: idle < 0.5% CPU, < 150 MB, a switch < 16
ms of Margin's work; a perform and a draw no dearer than commit 0's (expected far cheaper: no JSON of the whole library
per call).

#### What should not move

- M itself and its other half (open tabs, sleeping, syncing the browser's tabs, the extension's settings and themes'
  normalisation): the extension's own rules, in the browser, until feat/hosted-windows-chromium retires the copies'
  spaces.
- The UI's predictions of the library (ui/intents.ts `nextFront`, ui/behaviors/split.ts `refusesAdd` with FI): they
  draw a click's result before the library answers; they read the snapshot. FI stays a TS file for them, its rule pinned
  by the vectors against the core's.
- The session's `Target::read` (session/target.rs): ItemTarget's reader, a different, lenient rule (part 2).
- The profile source's settings and site icons (SH:17-109 less `state`: UserDefaults keepers, the profile's set): the
  Mac's; the core only splices their text.
- `LibraryStore` (core/data/library.rs): the store's timing and merge, step 1's.
- The default combos' copy in extension/shared/app-keys.ts and anything else outside the library's rules.

#### Open questions for Tirth (each with the default this design takes: no change of behaviour)

1. **String order for ties** (`localeCompare`): ICU's collation in the core (the `icu_collator` crate with its compiled
   data, the locale JSC uses on the Mac: exact), or a table for ASCII generated from JSC with code-point order past
   ASCII (smaller; differs only on non-ASCII ids, which Margin never makes). *Default: ICU's (exact); commit 1 measures
   its size and asks again if it's over ~1 MB.*
2. **The `url` crate** (WHATWG, as Safari and Chrome parse addresses) for matching addresses (pins, favorites, the
   archive's duplicates) and the link rules. *Default: yes (no hand-written URL parser).*
3. **A title cut through an emoji** (2,000 UTF-16 units, LT:43): JS keeps half the pair, which Rust can't hold. *Default:
   what the Mac does today (commit 0 finds it: likely the whole action fails when Foundation reads the half); recommend
   dropping the broken half (1,999 units) instead.*
4. **Ids that are names of JavaScript's object prototype** (`constructor`, `toString`, …) in a payload: JS finds a
   function and makes a garbage edit; Rust finds nothing ("no such item"). *Default: Rust's; no value the library holds
   can have such an id (items are `t-…`, the rest prefixed), so nothing Margin does changes.*
5. **The words of an action that throws** (a payload of the wrong type: `createSpace {name: 5}`): `failed: <JSC's
   message>` today. *Default: JSC's words for each site, as the survey records them.*
6. **The ids the rules make**: today 4 from Swift's SecRandom per action, then `Math.random`. *Default: Swift's 4 kept
   (the tests give theirs), the rest from the core's random (same letters and length, a better source).*
7. **library.ts after the switch**: kept, built into nothing, as the vectors' reference while M lives (your 2026-11-22
   words), or deleted now with the vectors frozen (Rust only). *Default: kept.*
8. **§10 items 9 and 10** (the import per set; Windows apps as items): in Rust after step 4, with Rust-only vectors (LT
   doesn't get them: the extension never imports). *Default: not in step 4.*
9. **The no-rules fallback** (Margin's window drawing a profile's spaces, read only, when library.js doesn't load,
   SG:176-179): gone with JavaScriptCore. *Default: gone (it can't happen any more).*
10. **"The first of several equal"** (two items with the same address for a pin or favorite, equal places or times):
    today a per-launch hash order, after step 4 the ids' order. *Default: the ids' order (a fixed pick; today's was
    random).*

**Tirth's answers (2026-11-23):** 1 ICU's collation, exact (commit 1 measures its size: asked again only if over ~1 MB);
10 the ids' order, a fixed pick; 3 a title cut through an emoji drops the broken half (1,999 units); 9 the no-rules
fallback goes. The others take the defaults above (2 the `url` crate; 4 Rust's "no such item"; 5 JSC's words; 6
Swift's 4 ids kept, the rest from the core's random; 7 library.ts kept as the vectors' reference; 8 not in step 4).
Branch: refactor/core-library, started off refactor/core-session for the Rust-only commits 0-4 (no Swift), rebased on
step 3's merge before the switch (commit 6).

**Asked again after commit 1 (2026-11-23), each with the default commit 1 takes:**

1. (again) **The collation's size**: ICU4X's compiled collation is +1.26 MB per architecture (about 2.5 MB in the
   universal app), and still not exact for Han (radical-stroke order in Apple's ICU, code-point order in ICU4X's
   compiled data) nor for Unicode 17's new characters. Choices: (a) keep it (exact for every id Margin makes, every ASCII
   pair, the mixed texts measured and every BMP character outside Han and Unicode 17's); (b) the system's ICU, which is what JSC calls:
   libicucore's `ucol_strcoll` on the Mac (and Windows' icu.dll), given to the core by the platform as a comparator: 0
   bytes, exact on the Mac by construction, an OS call through the FFI per compare (ties only); (c) the ASCII table
   from JSC with code points past it (a few hundred bytes; exact for root and `en` on ASCII, not for a tailored locale).
   *Default: (a), as in commit 1, until you say.*
11. **Link rules and address matching in Margin.app** (found by commit 1): the app's rules run in a bare JSContext,
    which has no `URL`, so today a link rule never routes a new tab or `routeUrl`, and pins, favorites, the archive and
    `keptForUrl` match addresses as given (`https://a.com` and `https://a.com/` are two; a `#fragment` counts). Keep
    that (no behaviour change), or parse them as the browsers' copies do (the `url` crate, ready in js.rs: one constant,
    `RULES_PARSE_URLS`, and the vectors' JSC answers re-recorded; +0.22 MB)? *Default: keep today's (the constant false).*

**Tirth's answers to these (2026-11-23):** 1 **(b), the system's sorter**: the platform hands the core a comparator
(the Mac: libicucore's `ucol_strcoll` with the person's locale, the one JSC calls; Windows: its own icu.dll), ICU4X's
collation removed from the core's dependencies (0 bytes added); the core's tests use a stand-in comparator and the Mac's
vectors pin the system one. 11 **fix it, as its own commit**: the rules move first with today's behaviour exactly
(`RULES_PARSE_URLS` false), then one commit turns URL parsing on with tests (link rules route in the app; `https://a.com`
and `https://a.com/` match as the browsers' copies match them), the vectors' JSC answers re-recorded for it.

## Order and checks

1. Step 1 (1.1 → 1.5), merged after the gate and the screen suite.
2. Step 2, the same.
3. Step 3, with the Windows thread's plan read first.
4. Step 4 (the sidebar's rules); then the Windows session plugs into the core's.

Every merge: `npm run gate`, the screen suite's Chameleon parts, idle cost and live-resize numbers against the ones
before, and the log lines tests read unchanged.
