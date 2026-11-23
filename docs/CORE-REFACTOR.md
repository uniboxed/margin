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
(PassThrough.swift:34) stays Swift (step 3's): its answer is a flag in.

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
| 7 | 4: the budgets and the full-screen ladder. **Moved 2026-11-23** (step2/parts-4-7, first commit: host/model/budget.rs, behaviour identical; the guard's count in the next) | ~45 | 1a | |
| 8 | 7: strays, off screen, exits, close, recovery's predicates | ~170 | 4 | idle-cost |
| 9 | 6: the live pump | ~120 | 3, 5 | live-resize, idle-cost |
| ~~10~~ | 8: panes active, pane clicks: left in Swift (Tirth, 2026-11-22) | 0 | | |

About 1,000 Swift lines deleted (not ~1,500: most of the "mixed" lines are macOS mechanism that stays: the waits,
Accessibility, the private calls, the logs), ~2,300 Rust lines in (half of them tests). Budgets as step 1: idle < 0.5%
CPU, < 150 MB, a switch < 16 ms of Margin's work; a drag's p95 no worse than the baseline.

**Tirth's answers (2026-11-22):** the full-screen ladder stays per host and per run; the four budgets count toward
guard.rs's 12-a-second hold (part 4's one change of behaviour, pinned by new tests); part 8 left as the Mac's policy.
So about 830 Swift lines deleted.

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
