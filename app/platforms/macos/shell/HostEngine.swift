// The host engine (docs/MARGIN-APP.md phase 3, "Mission Control" in its "Not solved yet"): another app's window
// shown in Margin's page area, as the test kit proved it on the real Mac (2026-11-15, /tmp/margin-toolbar-test/mc/mc8,
// mc10: real apps, macOS 27.2.1). A state machine over HostSystem, so every step and every fallback runs in the unit
// tests against a stand-in (shell/tests/host-tests.swift).
//
// Margin's window keeps its whole width (its own full-screen Space, nothing reserved at its edges, never a tile): the
// theme draws its frame around the page area, and the hosted window sits under Margin's window, in the page area, seen
// through it there (Margin's window in front of what it hosts, 2026-11-17: MarginWindowController `keepFront`).
//
// The first open of an app whose window can go full screen (`open`): the slow path, once per app, with Margin's loading
// animation in the page area (`loading`), each step timed in the log:
//   1. launch   an app not running is started with no Dock icon (`-NSMenuEnableMenuBarAgent NO`: it never shows
//               its own title strip; Safari also `-AutoShowToolbarInFullScreen YES`). An app already running (the
//               person opened it, its Dock icon) is hosted as it is: never started again, never quit, its Dock icon
//               left; its window given back exactly as it was when Margin stops hosting it. Safari: Margin asks its
//               own extension for a new window there (`requestSafariWindow`) and hosts only that window; Safari is
//               never restarted. The one shown before is parked first, so the loading animation is what's seen.
//   2. window   its main window (Safari: the new one Margin asked for, found by the window server: a new layer-0
//               window of Safari's pid. Accessibility lists only the current Space's windows, and a normal window
//               can't open in Margin's full-screen Space, so Safari's opens on a Desktop). An app the person opened
//               whose window Accessibility can't see (on another Space): found by the window server, its frame and
//               Space recorded, then brought into Margin's Space to be read. Its frame and Space are recorded before
//               anything moves it. The person's window already full screen in a Space of its own: left alone. One of an
//               app Margin started that came up in full screen in a Space of its own (restored so): placed from there
//               (steps 5-7), never brought into Margin's Space to be read.
//   3. full screen  AXFullScreen on (Safari's window: its copy's `setWindowState fullscreen`, Accessibility can't see
//               it); done once the window is in a full-screen Space of its own, as the window server reads it. Under
//               the freeze from the ask until macOS's jump to that Space is undone (the display set back to Margin's
//               Space): the only moment macOS would visibly change Spaces; the loading animation shows otherwise.
//               First tried early (`early`), under the same freeze: the new Space reserved as soon as it's listed
//               (~40 ms), the window moved into Margin's Space and that Space destroyed once macOS has brought the
//               window into it and switched to it (~600 ms; never before: moved on its page frame alone, the window
//               ended in no Space): steps 5-7 done then. Any doubt: this slow path, from the same ask.
//               An app's ask with nothing to show for it 1.5 s on (no new full-screen Space of its app, its AXFullScreen
//               not on) was refused: asked once more on its Desktop with its app in front, then failed (window mode,
//               tried again at its next show). Asked from where it is (an accessory app's window opens in Margin's
//               Space, and goes full screen from there); first onto its Desktop when it's in another app's full-screen
//               Space, and out of full screen first when it reads full screen with no Space of its own.
//   4. sidebar  (Safari, a window Margin made or a Safari Margin started) its own sidebar hidden by its View menu,
//               only while the hosted window is surely Safari's main one; Accessibility reads it only on the current
//               Space, so its own Space is made current a moment for it, under the freeze.
//   5. place    its own Space's four edges reserved (SLSSpaceSetEdgeReservation) so its window is the page area,
//               planned from the placement Margin's window gives (HostLayout.plan, never from bounds mid-transition),
//               verified on the window's bounds within 1 pt, sent once more.
//   6. member   moved into Margin's full-screen Space as a plain member (the bridge, options 7), Margin's Space made
//               current first: it stays full screen there, at its frame, with no title bar or toolbar.
//   7. destroy  its own Space, emptied of its window (its tile stays behind), destroyed by the window manager's bridge,
//               never while it's showing: Mission Control lists Margin's Space only again.
//   8. front    its app activated (the front app, the keys); Margin's window stays in front of its window
//               (`hostedWindow`): the current Space and the windows stay as they are (proven: mc10).
// Switching to a host already opened (`show`, `open` again): the fast path, no full-screen exit or entry, no freeze:
// the target moved into Margin's Space (out of its private Space), then the one shown before moved into a private Space
// (`SLSSpaceCreate(cid, 1, nil)`, as parking does: still full screen, ready), the target activated; target: well under
// 100 ms. Web items of one Safari profile stay a tab switch (the session's, the engine isn't asked).
// Live resize (docs/HOSTING-CORE.md "Live resize: tiles in Margin's Space", 2026-11-17): with the tiles part on and its
// check passed, step 6 moves the window's own tile into Margin's Space (the window with it) instead of the window alone,
// and every tile's rect is set (Margin's own the display's, each hosted one the page area's; a tile added or taken out
// lays the first two of the layout out again, so every rect is set again after each). A hosted window's size is then
// its tile's rect: the page area changing (`pageRectChanged`: a theme, the display, a drag's end) sets the shown one's
// rect at once and the parked ones' one at a time after it (the reconciler's `sizeTile`), no full-screen change; during
// a drag of the sidebar's edge the one shown follows each page area live (`dragging`, `follow`: at most one change a
// display frame, one in flight); a switch to a parked one sizes it first, out of sight. A window-mode window follows a
// drag by Accessibility. Off (no tiles, a check that failed, a step that didn't take: `tilesOff`, said once), as before:
// the page area changing (the session asks once, when a drag is over, HostedSession.sidebarResizing): a member's frame
// can't follow a reservation any more (its own Space is gone), so the one shown is placed again: out of full screen (on
// the current Space, where Accessibility acts; Safari's through its copy, parked first so its exit isn't seen), then
// steps 3 and 5-8, with the loading animation. A parked one is placed again only when it's next shown and its frame
// isn't the page area's.
//
// Window mode (a window whose AXFullScreen isn't settable, or whose full screen or placing failed: backed out first,
// its full screen tried again at its next show, once):
// its normal window brought into Margin's full-screen Space as a window (the bridge, options 7) and placed in the page
// area by Accessibility (resizable: the page area, within its own minimum and maximum, what's left centred; fixed:
// centred), checked by the window server; shown under Margin's window the same way. Parked: its frame given back first
// (while it's on the current Space, where Accessibility sees it), then into a private Space; shown again: back into
// Margin's Space and placed again. Given back (closed, quit, a failure): its frame as it was, its Space as it was, and
// only then is an app Margin started quit, so it saves the frame it had.
//
// Margin's window leaving full screen (`parkShown`), or the shown window found outside Margin's Space by the poll:
// the one shown is parked at once (nothing of it stands alone on a Desktop or in a Space of its own); shown again when
// it's asked for in Margin's full screen.
// A failure falls back without leaving anything behind: the window out of full screen (its Space then goes), an
// emptied Space destroyed, an app Margin started for that open quit again, the one shown before shown again. A
// Safari window Margin asked for is closed by its copy at every failure after the ask; one whose close isn't
// confirmed is kept in the marker (`leftSafariWindows`) and closed later (the poll, quit, the next launch).
// A hosted window is never left in no Space. It's moved into Margin's Space only once macOS's own full-screen change
// has brought it into its own Space and switched to it (2026-11-17, the real Mac: moved earlier, macOS finished its
// change afterwards and the window ended in no Space, the display on a Space that was gone). A Space it was just moved
// out of isn't destroyed in the same breath (a private one later, its own full-screen one once the move has held); it's
// in place only once it has stayed in Margin's Space after that destroy; the poll puts the one shown back at the first
// read that finds it in none, undoes a late switch by macOS, and looks at the window server's on-screen list too.
// Mission Control: after every operation, a hosted window's own full-screen Space still listed is said (`listed`):
// outside a first open or a re-placing, it lists Margin's Space only.
//
// Safety: the only windows Accessibility moves or resizes are a window-mode host's, its frame recorded first (in the
// marker too) and given back before it leaves Margin's Space and before its app is quit; only the apps Margin hosts
// (and the Safari windows it made) are touched; never a click. A marker (hosted.json) lists them for the next launch
// after a crash (`recover`), which brings each to the current Space, takes it out of full screen, gives a window-mode
// window its frame and its Desktop back, puts the person's apps' windows back where they were, and quits only the apps
// Margin started (never leaving an app saved as in full screen or at Margin's page area). Every operation runs one at
// a time, in order; Margin's quit gives its hosts back at once inside its own, and neither it nor a row's close waits
// for an app's exit (heard in the background; an open of that app meanwhile waits for it).

// The hosting core's reconciler (HostReconciler.swift, docs/HOSTING-CORE.md stage 3) drives it: a first open and a show
// take their placement from it (`launch` → a window, `reopen` when its app runs with none, `bringForward` when its
// window isn't listed until its app is, then `placeFromOwnSpace` / `outThenAsk` / `askFullScreen` / `frameWindow`, the
// steps above), and the poll reconciles every host with what it should be (the observed model, HostModel.swift),
// applying one correction at a time in this engine's queue, each logged as `host: <app>: <observed> → <correction>
// (<budget left>)`: leftovers and strips parked (or closed), a replaced or reopened window adopted, a window-mode window
// off screen brought forward, the predictable fallback when a budget's spent. A window-mode window parked keeps the page
// area's frame (given back only with it): a switch to or from it is a move each way.

import AppKit

final class HostEngine {
    struct Options {
        var launchWait = 10.0 // the app's process after it's asked to start
        var windowWait = 12.0 // its first window (Safari restoring windows can take a while)
        var fullScreenWait = 6.0
        var fullScreenAskAgain = 4.0 // a Safari copy's full screen asked once more if no Space came by then (as the kit did)
        // An app's full-screen ask with nothing to show for it this long after (no new full-screen Space of its app, its
        // AXFullScreen not on): refused. Asked again once the proper way (on its Desktop, its app in front), then failed.
        var fullScreenRefusal = 1.5
        // The early path (under the freeze, as the slow one): its new Space listed and reserved at once, so macOS lays the
        // window out at the page area itself; moved in only once macOS has brought the window into that Space (~525 ms
        // after the ask on the real Mac) and switched to it (undone at once; `earlySwitchWait` after the window came
        // with no switch seen: moved then); then that Space destroyed. Its new Space listed at most `earlyWait` from the
        // ask, the window at the page area at most `earlyFrameWait` and in its Space at most `earlyMemberWait` from that
        // Space's reservation, read `earlyEvery`; else the slow path.
        var earlyFullScreen = true
        var earlyWait = 1.5
        var earlyFrameWait = 1.0
        var earlyMemberWait = 1.5
        var earlySwitchWait = 0.25
        var earlyEvery = 0.005
        // After a full-screen ask, macOS's own change can still finish once the engine is done: for `lateWatch` after
        // the ask, and after a show, the poll undoes a switch to a Space that wasn't listed before the ask, and acts
        // on a shown window that isn't on screen at its first read.
        var lateWatch = 3.0
        // A window of the hosted app shown in Margin's Space is let in front only once two polls at least this far apart
        // have seen it there (`lookForOthers`: a Space change's picture lasts one read).
        var otherConfirm = 0.2
        var memberWait = 0.6 // a window moved by the bridge (into Margin's Space, or parked): there by then
        var memberEvery = 0.005 // ...read this often (a switch is a move each way: well under 100 ms in all)
        var destroyWait = 1.5
        var placeWait = 1.5 // its own Space's reservation taking effect
        var windowPlaceWait = 0.6 // a window-mode host's frame set by Accessibility: at most this long for the window server's bounds
        var placeSettle = 0.1 // ...or as soon as its bounds changed and then held this long (the size it took: its own limits)
        var parkWait = 0.6 // two tries of 300 ms, as the parker
        var exitWait = 7.0 // out of full screen (an app animates it)
        // A failed open's close waits this long for the app's exit (an iPad app with a window open quits after its own
        // 5 s watchdog: seen out 6 ms after a 5 s wait). A row's close and Margin's quit never wait for an app's exit
        // (`close`, `quitAll`): a row's app still running this long after it was asked didn't quit (said, Margin's again).
        var quitWait = 6.0
        var closeWait = 0.6 // a window closed by its close button before its app's quit: gone by then (seen: 70-290 ms)
        var closePressWait = 0.3 // ...its press retried this long when the window was just brought to the current Space (listed late)
        var frameAskWait = 0.3 // a frame given back: asked again this long while Accessibility doesn't take it (listed late)
        var exitUnansweredWait = 0.5 // out of full screen: asked again this long while Accessibility neither takes nor reads it
        // A shown window found outside Margin's Space with Margin's window still in it is brought back at most this many
        // times within `returnsWithin`; past that it's parked with nothing shown (something keeps taking it out).
        var returnsMax = 3
        var returnsWithin = 30.0
        // A Space a hosted window was just moved out of is never destroyed in the same breath (2026-11-17, the real
        // Mac: destroyed as the move was asked, the window was left in no Space at all, at its frame and unseen, about a
        // second after it was shown). A private Space is destroyed `privateRetire` after the window left it (the poll,
        // Margin's quit; 0: at once, the tests' stand-in for the old way). A window's own full-screen Space (Mission
        // Control lists it, so it can't wait as long) once the move has shown for `destroyAfterMove` (out of Margin's
        // Space again before that: moved in again); the window is in place once it has then stayed in Margin's Space
        // alone for `memberSettle`, put back if it's found in none (each at most `memberReadds` times). What it costs:
        // 0.2 s per first open and per placing (the two together; 0.15 s on the slow path); nothing on a switch.
        var privateRetire = 1.0
        var destroyAfterMove = 0.05
        var memberSettle = 0.15
        var memberReadds = 3
        // The reconciler (HostReconciler.swift): its corrections' budgets count the tries of the last `budgetWithin`;
        // a reopen (a Dock-icon click) waits `reopenWait` for a window; a rung of `bringForward` waits `forwardWait` for
        // the window on screen; an app Margin started with no window at all `reopenAfter` into its open is reopened once.
        var budgetWithin = 30.0
        var reopenWait = 2.0
        var forwardWait = 0.5
        var reopenAfter = 1.5
        var every = 0.02
        var tolerance: CGFloat = 1
        var safariBundle = safariIdentifier
        // (`-NSDisableAutomaticTermination YES`: an app Margin parks has no window in any user Space, which is when AppKit
        // and UIKit may end it on their own; Maps, 2026-11-17, `isAttemptingTermination` twice while parked. The argument
        // domain only: nothing of the app's own settings is written.)
        var appArguments = ["-NSMenuEnableMenuBarAgent", "NO", "-NSDisableAutomaticTermination", "YES"]
        var safariArguments = ["-NSMenuEnableMenuBarAgent", "NO", "-AutoShowToolbarInFullScreen", "YES", "-NSDisableAutomaticTermination", "YES"]
        var personWindowWait = 2.0 // an app the person opened: its window (it has one already, or none)
        var lookWait = 2.0 // a window brought into Margin's Space to be read: Accessibility lists it (by its number)
        var lookEvery = 0.05
        var desktopLookWait = 1.0 // still unlisted: read once more with its Desktop made current (under the freeze)
        var serverAfter = 3.0 // an app Margin started whose window Accessibility doesn't list by then: the window server's
        var unhideWait = 0.5 // a hidden app unhidden: no longer hidden by then
        // A Safari Margin started (started hidden) unhidden before a window is made ready out of sight in it: its window
        // server's list settled (unchanged this long, at most `unhideSettleWait`) before the list the new window is told
        // apart from is read, so windows it orders in as it's unhidden are never taken for the new one.
        var unhideSettle = 0.15
        var unhideSettleWait = 1.0
        var enhancedLookWait = 1.0 // still unlisted in Margin's Space: read again this long with AXEnhancedUserInterface on
        // Accessibility refusing a full-screen ask or a frame while its app is still launching (kAXErrorCannotComplete:
        // Mail, 2026-11-17, 0.6 s after its window came; it went full screen anyway a moment later): asked again every
        // `axSettleEvery` for up to `axSettleWait` (done at once if the app shows it took an earlier ask).
        var axSettleWait = 3.0
        var axSettleEvery = 0.1
        // A full-screen window's toolbar strip (its own window: the display's or the page area's width, at most this
        // tall): never let in front, never left behind by a full-screen attempt backed out.
        var stripMaxHeight: CGFloat = 150
        // A hosted app's window covering at least this share of Margin's sidebar is never let in front of it, and a
        // window-mode window that couldn't be fitted is never shown over it.
        var sidebarCover: CGFloat = 0.25
        var sidebarSliver: CGFloat = 8 // ...and none reaching over it more than this, each way, is let in front of it
        // Live resize (docs/HOSTING-CORE.md "Live resize: tiles in Margin's Space"): a hosted window's tile moved into
        // Margin's Space lands within `tileMoveWait`; a tile's rect set, its window is there within `tileWait` (the kit:
        // 10-26 ms, shown or parked); Margin's Space's tile limit read back within `tileLimitWait`. During a drag of the
        // sidebar's edge the one shown follows at most once a display frame (`liveFrame`), one change in flight, each
        // waited for at most `liveWait` (its window at the page area).
        var tiles = true
        // The hosting core's loop guard (guard.rs): on. Off only for a test that shows a loop it stops.
        var loopGuard = true
        // The anchors (docs/HOSTING-CORE.md "Anchors"): Margin's own two empty tiles at its Space's front, where macOS lays
        // a tile change out again. Off: Margin's window and the first hosted one take those re-layouts (the old way).
        var anchors = true
        var tileMoveWait = 1.0
        var tileWait = 0.3
        var tileLimitWait = 0.5
        var tileEvery = 0.002
        var tileSettleWatch = 0.03 // the first switch after a tile change watched this long for the tiles laid out again
        var liveFrame = 1.0 / 120
        var liveWait = 0.05
    }

    enum Phase: Equatable { case preparing, shown, parked }

    final class Host {
        let id: HostID
        let target: HostTarget
        let pid: pid_t
        var window: Int // (an app's: chosen again just before it's first moved, HostWindowChoice)
        let launchedByMargin: Bool // its app was started by Margin (with no Dock icon)
        let madeByMargin: Bool // a Safari window Margin's extension made in a Safari Margin didn't start
        let safariWindow: Int? // a Safari window a copy made for Margin: the copy's id for it (full screen and close go through it)
        var phase = Phase.preparing
        var fullScreenSpace: UInt64? // its own full-screen Space while it has one (a first open, a re-placing)
        var privateSpace: UInt64? // while parked
        var member = false // its full-screen window is a member of Margin's Space (its own Space destroyed), shown or parked
        var placedPage: CGRect? // the page area a member's frame was reserved for
        var promoted = false
        var outsideOpens = 0
        var unread = 0 // polls in a row its window's bounds didn't read
        var strays = 0 // polls in a row it was found where it mustn't be (shown: outside Margin's Space; parked: in a user Space)
        var returns: [Double] = [] // when it was last brought back into Margin's Space after straying (`returnsMax`)
        var askedFullScreenAt: Double? // when it was last asked into full screen (for the log of a stray)
        var windowsBeforeAsk: Set<Int> = [] // its app's windows right before that ask (a toolbar strip it makes is new)
        var mode = HostMode.fullScreen
        var resizable = true
        var unseen = false // Accessibility didn't list its window (on another Space): read once it's in Margin's Space
        var taken = false // its frame and Space recorded (before anything moved it)
        var original: CGRect? // its frame before Margin moved it (top-left coordinates)
        var originalSpace: UInt64? // the Space it was in (a Desktop)
        var away = false // Margin took it out of its Space: put back when it's given back
        var frameChanged = false // Margin set its frame (window mode) and hasn't put it back yet
        var exitUnconfirmed = false // its last exit from full screen wasn't confirmed (Accessibility neither took nor read it)
        var axRefused = false // Accessibility didn't take its frame as it was given back: its close button isn't pressed either
        // In window mode only because its full screen failed (it can go full screen): tried again the next time it's
        // shown from parked, once (`fullScreenFailures` counts the failures).
        var retryFullScreen = false
        var fullScreenFailures = 0
        var bundleId: String?
        var appLaunchedAt: Double?
        // The reconciler's (HostReconciler.swift): its app's windows when its first show ended (an app Margin started:
        // restored, or made as it launched, the window it hosts aside), the corrections tried and when (a budget per
        // 30 s), the polls in a row its window-mode window was in Margin's Space and off screen, and whether its window
        // went while its app ran (reopened, or another one adopted, before it's given up).
        var launchWindows: Set<Int> = []
        var tries: [String: [Double]] = [:]
        var offScreenReads = 0
        var offPageReads = 0 // polls in a row a shown member wasn't at the page area
        var gone = false
        var goneAt: Double?
        // Its full-screen window's own toolbar windows (`ownToolbar`): left as they are while they're where it is.
        var toolbars: Set<Int> = []
        // Live resize: its window's own tile, moved into Margin's Space (its window sized by the tile's rect, shown or
        // parked; `placedPage` the page area that rect was set for and seen taken). Nil: a plain member, or window mode.
        var tile: UInt64?
        // Its route held below tiles (the hosting core's routes: its app kept fighting its tile, now or in an earlier
        // run of this version of it): a plain member from its next placing, never a tile again this run.
        var noTiles = false
        // Its window's own minimum (its tile's `SizeConstraints`' `Min`, read as its tile comes into Margin's Space or its
        // own full-screen Space is listed, again at each drag's start and each sizing): its tile never sized below it
        // (`frame`: the page area, or that minimum with its right edge the page area's). Nil: none known.
        var minSize: CGSize?
        // The narrowest its window was seen holding in its tile (a rect it followed): with no minimum said by its tile, the
        // one it's taken to have once it leaves a narrower one (the first rect it didn't take).
        var narrowestHeld: CGFloat?
        var minUnreadSaid = false
        init(id: HostID, target: HostTarget, pid: pid_t, window: Int, launchedByMargin: Bool, madeByMargin: Bool, safariWindow: Int? = nil) {
            self.id = id
            self.target = target
            self.pid = pid
            self.window = window
            self.launchedByMargin = launchedByMargin
            self.madeByMargin = madeByMargin
            self.safariWindow = safariWindow
        }
        // An app the person opened (running before Margin hosted it, its Dock icon): never quit, given back as it was.
        var personApp: Bool {
            if case .app = target { return !launchedByMargin }
            return false
        }
        var profile: String? {
            if case .safariWindow(let p) = target { return p }
            return nil
        }
    }

    var options: Options
    private let sys: HostSystem
    private let markerURL: URL?
    private let ownPid: Int32
    private(set) var hosts: [HostID: Host] = [:]
    private(set) var shown: HostID? { didSet { if shown != nil, shown != oldValue { shownAt = sys.now() }; announceHosted() } }
    private(set) var launched: [pid_t: HostApp] = [:] // apps Margin started, while they run
    private(set) var leftSpaces: Set<UInt64> = [] // hosted windows' own full-screen Spaces a destroy hasn't taken yet
    private(set) var leftSafariWindows: [HostMarker.SafariWindow] = [] // Safari windows Margin asked for, their close not confirmed
    private(set) var placement = HostPlacement.zero // the page area and the display's area (top-left coordinates)
    var pageRect: CGRect { placement.page }
    private(set) var marginWindow = 0
    private(set) var marginSpace: UInt64 = 0
    private(set) var busy = false
    private(set) var quitting = false // Margin quits: nothing is shown or activated any more
    private var quitAsked: Set<pid_t> = [] // apps asked to quit during Margin's quit
    // Apps Margin started, asked to quit by their row's close (Margin keeps running) and not gone yet: no longer
    // Margin's (`launched` doesn't have them), their exit heard in the background (`appQuit`); in the marker as asked.
    private struct Exiting { let app: HostApp; let id: HostID; let askedAt: Double }
    private var exiting: [pid_t: Exiting] = [:]
    private var leftWindows: [HostMarker.Window] = [] // windows Margin's quit couldn't finish giving back: the marker's, for the next launch
    private var ownSpaces: Set<UInt64> = [] // every full-screen Space a hosted window went into, until it's gone (Mission Control's check)
    var onEvent: ((HostEvent) -> Void)?
    // Wired by the shell to the extension's request for a new window (a profile's; nil the default one): the copy's
    // answer (its id for the window, its bounds), nil if it wasn't made.
    var requestSafariWindow: ((String?) async -> HostSafariWindow?)?
    // Wired by the shell to the copy's close of a window it made for Margin (the profile, the copy's id). True: asked.
    var closeSafariWindow: ((String?, Int) async -> Bool)?
    // Wired by the shell to the copy's `setWindowState` (the profile, the copy's id, full screen or normal): a Safari
    // window's full screen, which Accessibility can't set while it's on another Space. True: the copy asked Safari.
    var safariFullScreen: ((String?, Int, Bool) async -> Bool)?
    // Wired by the shell: waits until that profile's extension copy is linked (true), before Safari's windows are read
    // and a window asked for, so windows a Safari just started restores meanwhile are never taken for Margin's own.
    var safariLinked: ((String?) async -> Bool)?
    // Told the window of the host now shown in Margin's Space (nil: none is): Margin's window is in front of it, its
    // page area a hole over it (MarginWindowController `setHosted`).
    var hostedWindow: ((Int?) -> Void)?
    // Told when a slow step starts for a host (its first open, its placing again: Margin's page area shows a loading
    // animation for it) and when it's over (nil).
    var loading: ((HostID?) -> Void)?
    // Told the window of a new app brought into Margin's Space only to be read, or made ready out of sight (not shown
    // yet: Margin's window is in front of it and opaque meanwhile, so it's never seen), nil once that's over.
    var cover: ((Int?) -> Void)?
    // Told a normal window of the hosted app shown that's on screen in Margin's Space, reaches outside the page area and
    // came while nothing was being opened (its Settings or second document, dragged over the sidebar): Margin's window
    // lets it in front until it's gone (nil). See `lookForOthers`.
    var others: ((Int?) -> Void)?
    // Told, at each poll in steady state, what the on-screen list has of Margin's window and the one shown (`FrontRead`):
    // Margin's window checks it's in front of it (MarginWindowController `frontRead`). See `lookFront`.
    var front: ((FrontRead) -> Void)?
    private var hostedSaid: Int?
    private var otherSaid: Int?
    // Other windows seen on screen in Margin's Space (their numbers): true, one Margin lets in front; false, one that
    // came during an operation from an app Margin hosts (its toolbar's window, what a Safari Margin started restores):
    // never. When each was first seen so, in the polls in a row since. And whether an operation ran since the last look.
    private var otherSeen: [Int: Bool] = [:]
    private var otherSince: [Int: Double] = [:]
    private var ranSinceLook = true
    private var retired: [UInt64: Double] = [:] // private Spaces a window was moved out of, and when: destroyed later (`privateRetire`)
    // The last full-screen ask: when, and the full-screen Spaces listed before it (the poll's late watch, `lateWatch`).
    private var lateAsk: (at: Double, before: Set<UInt64>)?
    private var shownAt = 0.0 // when the one shown was last shown or placed
    // The poll's look at the window server's on-screen list: reads in a row something of Margin's Space wasn't on
    // screen, when it was last acted on, and whether giving up was said.
    private var offReads = 0
    private var offTries: [Double] = []
    private var offSaid = false
    private var offActedFor: Double? // the show (its `shownAt`) the look acted for with nothing to move: once per show
    private var offInPlaceSaid: Double?
    // What the poll last read of each host, said when it changes (the log of a stray names what was read before it).
    private struct PollRead: Equatable { var phase: Phase; var spaces: [UInt64]?; var marginHere: Bool; var onScreen: String }
    private var pollSaid: [HostID: PollRead] = [:]
    private var pollHeldSince: Double?
    private var coverSaid: Int?
    private var loadingSaid: HostID?
    private var freezeHolds = 0 // steps holding the freeze now (Margin's quit gives every host back at once)
    private var preparing = false // a window made ready out of sight (`prepare`): parked once it's placed, never shown

    private var tail: Task<Void, Never>?
    private var jumps = 0
    private var leftTried = -Double.infinity // the last try at closing leftSafariWindows

    // The hosting core's observed model (HostObserver.swift, docs/HOSTING-CORE.md stage 2): fed at each poll and at the
    // end of each operation, logged; nothing here reads it to decide anything. `observation`: Accessibility's
    // notifications and reads for it (nil: the window server's alone).
    let observer: HostObserver
    // The lists of an app's windows on every Space this engine read since the last poll (its own reads, kept for the
    // observer: it reads no list of its own).
    private var serverSeen: [pid_t: [ServerWindow]] = [:]
    // Windows of a hosted app's the reconciler parked out of sight (leftovers, strips), each app's in one private Space
    // of its own, given back to its Desktop as its app is given back.
    private var parkedOthers: [pid_t: (space: UInt64, windows: Set<Int>)] = [:]
    private var reconcileQueued = false
    // A person's operation (open, show, close, a page area's change, a park, the quit) runs: the tile changes it makes
    // are Margin's plan, not reactions the loop guard counts (the hosting core's guard.rs).
    private var planned = false
    // The routes held per app (the hosting core's routes.rs), saved beside the marker: routes.json.
    private var routesURL: URL? { markerURL?.deletingLastPathComponent().appendingPathComponent("routes.json") }
    // A host moved to a safer route (the loop guard stopped it, its full screen failed): for the sidebar's note.
    var onRoute: ((HostID, String) -> Void)?
    // Its own hosting core: its loop guard, its causes, its routes (never shared with another engine).
    private let core: HostCore

    // Live resize: hosted windows' tiles in Margin's Space (docs/HOSTING-CORE.md "Live resize: tiles in Margin's Space").
    // Checked once per Margin Space (`tilesReady`); off for the run once a tile step didn't take (`tilesOff`, said once):
    // the host as before (a page area's change re-fits the one shown when it's over, parked ones at their next show).
    private var tilesFor: UInt64 = 0 // the Margin Space the check was made for (0: none yet)
    private var tilesOK = false // ...passed
    private(set) var tilesOff: String? // why the tiles are off for the run
    private(set) var marginTile: UInt64? // Margin's own tile in its Space
    private var tileHome: CGRect? // ...its rect: the display's whole tile, from its top left
    private var tileCount = 0 // the tiles Margin's Space had at the last look (another count: every rect set again)
    private var tilesSettled = true // no tile came into or left Margin's Space since the last switch (its first one is watched)
    private var goneTiles: Set<UInt64> = [] // hosted tiles whose host went (its app quit or crashed, its window closed): destroyed if they stay
    private(set) var anchorTiles: [UInt64] = [] // Margin's own empty tiles, its Space's layout's first two (none: not made)
    // The sidebar's edge dragged (`dragging`): the one shown follows (`follow`), one change in flight (`livePump`).
    private(set) var liveOn = false
    private var livePending: HostPlacement?
    private var livePump: Task<Void, Never>?
    private var liveStats = LiveStats()
    private var liveLast = 0.0 // the drag's last page area: a drag never said over is over after `liveForget`
    // The one shown left its tile during this drag (found out of Margin's Space and brought back): not followed again
    // until the drag is over, so it can't happen twice in one drag; the drag's end places it once.
    private var liveHeld = false
    var liveForget = 10.0
    struct LiveStats { var asked = 0, sent = 0, followed: [Double] = [], late = 0, held = 0, since = 0.0 }

    init(system: HostSystem, marker: URL?, options: Options = Options(), pid: Int32 = ProcessInfo.processInfo.processIdentifier, observation: HostObservation? = nil) {
        sys = system
        markerURL = marker
        self.options = options
        ownPid = pid
        let core = HostCore()
        self.core = core
        observer = HostObserver(system: system, source: observation, core: core)
        observer.onHeard = { [weak self] in self?.activity(); self?.onWake?() }
        sys.onAppQuit = { [weak self] pid in self?.appQuit(pid) }
        if let routesURL { core.loadRoutes(from: routesURL) }
    }

    var hasHosts: Bool { !hosts.isEmpty || !launched.isEmpty }
    // The pid of a running app of this bundle that Margin started itself (no Dock icon), if any.
    func launchedPid(bundleId: String) -> pid_t? { launched.first { $0.value.bundleId == bundleId }?.key }
    var hasLeftSafariWindows: Bool { !leftSafariWindows.isEmpty }
    // Apps asked to quit by their row's close and still finishing (not Margin's any more).
    var exitingPids: [pid_t] { exiting.keys.sorted() }

    // ---- the API ----

    // Opens `target` (shows it again if it's hosted already) under Margin's window, at `placement`.
    func open(app target: HostTarget, in placement: HostPlacement, marginWindow: Int, marginSpace: UInt64) async -> HostResult {
        await serial(planned: true) {
            self.placement = placement
            self.marginWindow = marginWindow
            self.marginSpace = marginSpace
            let r = await self.openNow(target)
            self.checkListed("after \(target.id)'s open")
            return r
        }
    }

    // An app (the person's default browser, at Margin's launch) started with no Dock icon if it isn't running, as a
    // first open starts it (it counts as Margin's: quit at Margin's quit, its restored windows swept); running already
    // (the person's): used as it is, never started again. Nil: it couldn't be started.
    func start(bundleId: String) async -> HostApp? {
        await serial(planned: true) {
            _ = await self.awaitExits(of: bundleId)
            if let running = self.sys.running(bundleId: bundleId).first { return running }
            let arguments = bundleId == self.options.safariBundle ? self.options.safariArguments : self.options.appArguments
            guard self.sys.launchDockless(bundleId: bundleId, arguments: arguments) else { return nil }
            var found: HostApp?
            _ = await self.wait(self.options.launchWait) { found = self.sys.running(bundleId: bundleId).first; return found != nil }
            guard let found else { return nil }
            self.launched[found.pid] = found
            self.saveMarker()
            Diagnostics.note("host: \(bundleId) started with no Dock icon, to be prepared (pid \(found.pid))")
            return found
        }
    }

    var preparesOutOfSight: Bool { options.earlyFullScreen && sys.fullScreenSpaceOwners() != nil }

    // Made ready out of sight (the person's default browser's window, at Margin's launch, Tirth 2026-11-16): opened as a
    // first open is, never shown: no loading bar, covered by Margin's window (`cover`) while it's a member of Margin's
    // Space, then parked at once (a private Space), its app never activated; its next show is a switch. Only with the
    // early full screen (no Space switch to hide) and nothing shown in Margin's Space (it would come in over that);
    // else not prepared, said (its first use opens it as before). `.shown` here: prepared (parked).
    func prepare(_ target: HostTarget, in placement: HostPlacement, marginWindow: Int, marginSpace: UInt64) async -> HostResult {
        await serial(planned: true) {
            let id = target.id
            if self.hosts[id] != nil { return .shown(id, placed: true) }
            guard self.shown == nil else { return .failed(.park, "something is shown in Margin's Space: not prepared out of sight") }
            guard self.options.earlyFullScreen, self.sys.fullScreenSpaceOwners() != nil else { return .failed(.fullScreen, "the early full screen isn't available: not prepared out of sight") }
            self.placement = placement
            self.marginWindow = marginWindow
            self.marginSpace = marginSpace
            guard self.sys.spaceType(marginSpace) == ManagedSpace.fullScreenType, self.sys.spaces(window: marginWindow)?.contains(marginSpace) == true else {
                return self.fail(id, .margin, "Margin's window isn't in a full-screen Space of its own (\(marginSpace))")
            }
            self.preparing = true
            defer { self.preparing = false }
            let r = await self.openNew(target)
            self.checkListed("after \(id)'s preparing")
            return r
        }
    }

    func show(_ id: HostID) async -> HostResult {
        await serial(planned: true) {
            guard let host = self.hosts[id] else { return .failed(.window, "not hosted") }
            let r: HostResult = self.shown == id ? .shown(id, placed: await self.place(host)) : await self.bringIn(host, isNew: false)
            self.checkListed("after \(id)'s show")
            return r
        }
    }

    // A row closed (Margin keeps running): given back as Margin's quit does it (its frame first, closed first when
    // that's harmless, else home), its app (Margin's) asked to quit once and forgotten at once; the queue is released
    // without waiting for that exit (Maps holds its quit 5 s, its own watchdog), which is heard in the background.
    func close(_ id: HostID) async {
        await serial(planned: true) {
            await self.closeNow(id, why: "closed", exit: .watched)
            self.checkListed("after \(id)'s close")
        }
    }

    // The placement moved (another theme, the display): the one shown placed again (window mode: by Accessibility; full
    // screen: out of it and in again, its own Space reserved for the new page area); parked ones when they're shown.
    func pageRectChanged(_ placement: HostPlacement) async -> Bool {
        await serial(planned: true) {
            self.placement = placement
            // (Live resize: the parked ones' tiles then, one at a time, by the reconciler: `sizeTile`.)
            defer { self.sizeTilesSoon() }
            guard let id = self.shown, let host = self.hosts[id] else { return true }
            let placed = await self.place(host)
            self.checkListed("after placing \(id) again")
            return placed
        }
    }

    // The one shown parked at once, nothing in its place (Margin's window leaving full screen: the hosted window must
    // never be left on a Desktop or in a full-screen Space of its own). Shown again by the next open or show.
    func parkShown(why: String) async {
        await serial(planned: true) { await self.parkShownNow(why: why) }
    }

    // Margin quits: every host given back at once (each one's own steps in order: its frame and Space back, out of
    // full screen, its window closed first or taken home, Safari's closed by its copy), every app Margin started asked
    // to quit, the Safari windows it made closed, its Spaces given back. Margin never waits for an app's exit (Maps
    // took 5 s, its own watchdog, 2026-11-16): once every window is where it belongs and each app is asked, the quit
    // is done; the apps finish on their own. What isn't done stays in the marker for the next launch's recovery: a
    // window not given back (`leftWindows`), an app asked to quit and still running then (asked again if it still runs).
    func quitAll() async {
        quitting = true
        if liveOn { dragging(false) }
        await serial {
            let started = self.sys.now()
            self.quitAsked = []
            self.leftWindows = []
            let order = (self.shown.map { [$0] } ?? []) + self.hosts.keys.filter { $0 != self.shown }.sorted { $0.raw < $1.raw }
            await self.closeAtOnce(order)
            // (Live resize: a window out of full screen leaves its tile in Margin's Space, empty, until its app quits (the
            // real Mac, 2026-11-17 23:32): destroyed now, under the freeze, or Margin's Space outlives Margin's window, listed
            // with nothing in it.)
            if !self.goneTiles.isEmpty || !self.anchorTiles.isEmpty {
                let frozen = self.holdFreeze()
                await self.dropGoneTiles()
                await self.dropAnchors()
                self.releaseFreeze(frozen)
            }
            await self.closeLeftSafariWindows()
            // (An app a row's close asked to quit and still running `quitWait` later didn't quit: Margin's again, asked
            // again below; one still finishing isn't asked twice, kept in the marker as asked.)
            for pid in self.overdue() { if let back = self.takeBack(pid) { await self.sayNotQuit(back) } }
            // (An app asked already by its window's close isn't asked again: one polite quit each, never waited for.)
            for (pid, app) in self.launched.sorted(by: { $0.key < $1.key }) where !self.quitAsked.contains(pid) { self.askQuit(pid, bundle: app.bundleId) }
            // (A reservation on Margin's own Space is never made now; one left by an older build is given back.)
            if self.marginSpace > 0, let r = self.sys.reserved(space: self.marginSpace), !r.isZero { _ = self.sys.reserve(.zero, space: self.marginSpace) }
            await self.destroyLeftSpaces()
            for bundle in self.woken.keys.sorted() { self.releaseWoken(bundleId: bundle) }
            await self.destroyRetired(all: true)
            self.checkOrphans("at quit")
            self.checkListed("at quit")
            self.saveMarker()
            let finishing = (self.launched.values.filter { self.quitAsked.contains($0.pid) } + self.exiting.values.map(\.app)).map(\.bundleId).sorted()
            let left = self.leftWindows.count
            Diagnostics.note("host: quit: everything given back in \(self.ms(since: started)) ms (\(order.count) host\(order.count == 1 ? "" : "s") at once"
                             + (finishing.isEmpty ? "" : "; still quitting on their own, not waited for: \(finishing.joined(separator: ", "))")
                             + (left == 0 ? "" : "; \(left) window\(left == 1 ? "" : "s") not given back: in the marker for the next launch") + ")")
        }
    }

    // Each host given back in a task of its own, all at once (their waits overlap: the quit takes the slowest one's
    // time, not their sum), every one finished before this returns.
    private func closeAtOnce(_ ids: [HostID]) async {
        let tasks = ids.map { id in Task { await self.closeNow(id, why: "Margin quits", exit: .atQuit) } }
        for task in tasks { await task.value }
    }

    // ---- windows opened only to wake something ----

    // A window an app opens only so something links (a Safari profile with no window: one opened from Safari's own
    // menu so its copy starts, HostedSession.safariLinked), parked out of sight the moment the window server lists it,
    // never seen (2026-11-17 14:05: one opened in Margin's Space, the current one, at the normal level, and showed through
    // the page area over Maps; the preparation it was for was given up and the window was never closed). From now until
    // `releaseWoken` (its close): the first new layer-0 window of that app's (one per press, `wakeHideFor` at most after
    // it), in a user Space, not hosted and not there at the press, goes into a private Space of its own (the poll, and
    // the end of every operation). Never more windows than presses: a window the person opens in that app after it is
    // theirs. `stopHidingWoken`: one last look, then no more new ones (a window Margin asks of it next is its own).
    private struct Woken { var pid: pid_t; var known: Set<Int>; var until: Double; var space: UInt64?; var parked: [Int] = []; var budget = 0; var seen = 0 }
    private var woken: [String: Woken] = [:]
    var wakeHideFor = 10.0
    func hideWoken(bundleId: String) {
        guard let app = sys.running(bundleId: bundleId).first else { return }
        let known = Set((serverList(pid: app.pid) ?? []).map(\.number))
        var w = woken[bundleId].flatMap { $0.pid == app.pid ? $0 : nil } ?? Woken(pid: app.pid, known: [], until: 0, space: nil)
        w.known.formUnion(known)
        w.until = sys.now() + wakeHideFor
        w.budget += 1
        woken[bundleId] = w
    }
    func stopHidingWoken(bundleId: String) {
        parkWoken()
        woken[bundleId]?.budget = 0
    }
    // Its windows closed (or given up): the private Space they were in retired.
    func releaseWoken(bundleId: String) {
        guard let w = woken.removeValue(forKey: bundleId) else { return }
        if let space = w.space { retirePrivate(space) }
    }
    // Windows parked so, still open (their close not confirmed yet).
    func wokenParked(bundleId: String) -> [Int] { woken[bundleId]?.parked.filter { sys.bounds(window: $0) != nil } ?? [] }
    // The windows the presses opened so far, looked for now (out of sight at once: HostedSession.safariLinked asks while
    // an open waits for the link, when the poll is held off by that open; the woken window sat in Margin's Space, over
    // the page area, for the 15 s the link took, 2026-11-17 20:47).
    func wokenWindows(bundleId: String) -> Int {
        parkWoken()
        return woken[bundleId]?.seen ?? 0
    }
    func appRuns(bundleId: String) -> Bool? { !sys.running(bundleId: bundleId).isEmpty }
    private func parkWoken() {
        guard !woken.isEmpty, !quitting else { return }
        for bundle in woken.keys.sorted() {
            guard var w = woken[bundle] else { continue }
            if sys.now() > w.until { w.budget = 0 }
            guard w.budget > 0, sys.processRuns(pid: w.pid) else { woken[bundle] = w; continue }
            for win in serverList(pid: w.pid) ?? [] where w.budget > 0 && !w.known.contains(win.number) && win.layer == 0 && win.bounds.width >= 100 && win.bounds.height >= 100 && !isHosted(window: win.number) {
                guard !(sys.spaces(window: win.number) ?? []).isEmpty else { continue } // (not ordered in yet: looked at again)
                w.known.insert(win.number)
                w.seen += 1
                if w.space == nil { w.space = sys.createPrivateSpace() }
                guard let space = w.space, sys.move(window: win.number, to: space) else {
                    Diagnostics.warn("host: \(bundle): the window \(win.number) it opened only to wake a profile couldn't be parked out of sight")
                    continue
                }
                w.parked.append(win.number)
                w.budget -= 1
                Diagnostics.note("host: \(bundle): the window \(win.number) it opened only to wake a profile parked out of sight (it was in \(sys.currentSpace(onDisplayOf: marginSpace) == marginSpace ? "Margin's Space" : "a user Space"))")
            }
            woken[bundle] = w
        }
    }

    // The shell's poll: a hosted app quit or promoted, its window gone, a left Space destroyed. Skipped while an
    // operation runs (it reads the same things); held off that way for over a second, it's said once.
    // (One poll's reads in one batch: the Space list read once for all of them.)
    func poll() { sys.batch { pollNow() } }

    private func pollNow() {
        if busy {
            if let since = pollHeldSince {
                if since >= 0, sys.now() - since > 1 { Diagnostics.note("host: poll held off by an operation for over \(ms(since: since)) ms"); pollHeldSince = -1 }
            } else { pollHeldSince = sys.now() }
            return
        }
        pollHeldSince = nil
        // (A drag of the sidebar's edge never said over, no page area of it for `liveForget`: over.)
        if liveOn, sys.now() - liveLast > liveForget { Diagnostics.note("host: live resize: no page area of the drag for \(Int(liveForget)) s and never said over: over"); dragging(false) }
        parkWoken()
        pollScreen = nil
        pollCurrentBefore = nil
        pollSteady = nil
        polls += 1
        polledAt = sys.now()
        // (An app a row's close asked to quit, still running `quitWait` later: it didn't quit, Margin's again.)
        for pid in overdue() { if let back = takeBack(pid) { Task { await self.sayNotQuit(back) } } }
        // (Margin's window out of its Space, macOS took it out of full screen: the one shown is a stray too.)
        let marginHere = marginWindow == 0 || sys.spaces(window: marginWindow).map { $0.contains(marginSpace) } ?? true
        for host in hosts.values {
            if sys.app(pid: host.pid) == nil, !sys.processRuns(pid: host.pid) { appQuit(host.pid); continue }
            if host.launchedByMargin, !host.promoted, sys.policy(pid: host.pid) == .regular { promote(host, why: "its policy reads regular") }
            // (Closed and still listed by the window server, in no Space or off screen: gone at once, as two reads that missed.)
            if closedByItsApp(host) { host.unread = max(2, host.unread + 1) } else if sys.bounds(window: host.window) == nil { host.unread += 1 } else { host.unread = 0; host.gone = false }
            if host.unread >= 2 { // twice in a row: one read can miss mid-transition
                // (Shown, its app still running: the reconciler adopts another main window of its app's that comes within
                // the grace, else closes its item (Tirth, 2026-11-17: a window the person closes closes its item, never
                // reopened). Parked, an app Margin started: reopened at its next show, behind the loader. Else, the
                // window's gone as before.)
                if !host.gone, host.phase != .preparing, sys.processRuns(pid: host.pid) {
                    let parkedOwn: Bool = { if case .app = host.target { return host.launchedByMargin && host.phase == .parked }; return false }()
                    if parkedOwn {
                        // (Parked: reopened at its next show, behind the loader; a window its app opened now would come
                        // up in the current Space, over what's shown.)
                        host.gone = true
                        host.goneAt = sys.now()
                        Diagnostics.note("host: \(host.id): its window \(host.window) gone while parked, its app running → reopen at its next show")
                    } else if host.phase == .shown {
                        host.gone = true
                        host.goneAt = sys.now()
                        let other = situation(host).replacement
                        Diagnostics.note("host: \(host.id): shown, window \(host.window) gone, its app running → \(other.map { "another of its app's its main window now (\($0)): adopt" } ?? "its item closed unless another main window of its app's comes within \(Int(HostReconciler.goneGrace * 1000)) ms")")
                    } else {
                        windowGone(host)
                    }
                } else if !host.gone {
                    windowGone(host)
                }
                continue
            }
            // (Its bounds unread this poll: gone or mid-transition, never taken for a stray: a window the person just closed
            // would be "in no Space", brought back, fail and be parked before the reconciler's grace could close its item.)
            if host.unread > 0 { continue }
            // Where it mustn't be, twice in a row (one read can miss mid-transition): the one shown outside Margin's
            // Space (Margin's window left full screen), a parked one in a user Space.
            let spaces = sys.spaces(window: host.window)
            sayRead(host, spaces: spaces, marginHere: marginHere)
            let strayed = host.phase == .shown ? (!marginHere || (spaces.map { $0 != [marginSpace] } ?? false)) : host.phase == .parked && !(spaces ?? []).isEmpty
            host.strays = strayed ? host.strays + 1 : 0
            // (The one shown in no Space at all is never a read that missed mid-transition: nothing puts a window there
            // but a Space destroyed under it. Brought back at the first read.)
            let nowhere = host.phase == .shown && marginHere && spaces == []
            // (A parked one found in a user Space: the reconciler's `parkAgain`, at the second read in a row.)
            if host.phase == .shown, host.strays >= 2 || nowhere {
                host.strays = 0
                let id = host.id
                Task { await serial { await self.strayed(id, marginHere: marginHere) } }
            }
        }
        keepCurrentLate()
        lookOnScreen()
        lookForOthers()
        lookFront()
        lookAtTiles()
        if !retired.isEmpty { Task { await serial { await self.destroyRetired() } } }
        if !leftSpaces.isEmpty, marginSpace > 0, sys.currentSpace(onDisplayOf: marginSpace) == marginSpace {
            Task { await serial { await self.destroyLeftSpaces() } }
        }
        // Safari windows asked for whose close wasn't confirmed: tried again every 2 s (their copy may link later).
        if !leftSafariWindows.isEmpty, closeSafariWindow != nil, sys.now() - leftTried >= 2 {
            leftTried = sys.now()
            Task { await serial { await self.closeLeftSafariWindows() } }
        }
        observe()
        reconcile()
    }

    // ---- the reconciler (HostReconciler.swift, docs/HOSTING-CORE.md stage 3) ----

    // What each host should be now: the one shown, at the page area; the others parked.
    private func desired(_ host: Host) -> HostDesired { host.phase == .shown && shown == host.id ? .shown(placement) : .parked }

    // What Margin sees of a host now, from its own record and the observed model (fed by this poll).
    func situation(of id: HostID) -> HostSituation? { hosts[id].map(situation) }
    private func situation(_ host: Host) -> HostSituation {
        var s = HostSituation()
        s.running = sys.processRuns(pid: host.pid)
        s.hidden = sys.isHidden(pid: host.pid)
        s.launchedByMargin = host.launchedByMargin
        s.phase = host.phase == .shown ? .shown : host.phase == .parked ? .parked : .preparing
        s.mode = host.mode
        s.member = host.member
        s.window = host.window
        s.windowGone = host.gone
        s.goneFor = host.gone ? host.goneAt.map { sys.now() - $0 } : nil
        s.offPageReads = host.offPageReads
        s.marginCurrent = marginWindow == 0 || (sys.spaces(window: marginWindow)?.contains(marginSpace) != false && sys.currentSpace(onDisplayOf: marginSpace) == marginSpace)
        s.offScreenReads = host.offScreenReads
        s.strayReads = host.strays
        if host.mode == .window, host.phase == .shown { s.atPage = atPageArea(host) }
        // (Live resize: its tile not at the page area: placed for another one, or found off it twice in a row.)
        s.tile = host.tile != nil
        s.tileStale = host.tile != nil && (!(host.placedPage.map { HostLayout.near($0, placement.page, within: options.tolerance) } ?? false) || host.offPageReads >= HostReconciler.offPageAfter)
        s.dragging = liveOn
        let now = sys.now()
        // (Tries within `budgetWithin`; a window-mode window's framing, per show: never again and again for one that can't be.)
        s.tries = host.tries.reduce(into: [:]) { out, e in out[e.key] = e.key == HostCorrection.frameWindow.key ? e.value.count : e.value.filter { now - $0 < options.budgetWithin }.count }
        guard let app = observer.model.apps[host.pid] else { return s }
        let mine = app.windows[host.window]
        s.place = mine?.place ?? .unread
        s.onScreen = mine?.onScreen
        // (Replaced: the model's main window is another, the hosted one replaced or gone. Never a window another host has.)
        var others = Set(hosts.values.filter { $0 !== host }.map(\.window))
        // (Live resize: a tile whose window closed keeps a placeholder window of its own, its app's, at the tile's rect
        // (the real Mac, 2026-11-18 01:19: Chameleon's windowless close, its placeholder 83816 at 260,8 1244×966 taken
        // for a replacement and adopted): never a replacement; the tile goes with its host.)
        for h in hosts.values { if let t = h.tile, let w = sys.tileWindow(t), w != h.window { others.insert(w) } }
        if mine?.kind != .main || host.gone, let m = app.mains.first(where: { $0 != host.window && !others.contains($0) }), let w = app.windows[m], w.place.placed || w.onScreen == true {
            s.replacement = m
        }
        let parked = parkedOthers[host.pid]?.windows ?? []
        // (Only one host of an app speaks for its leftovers and strips: the one shown, else the first.)
        let sameApp = hosts.values.filter { $0.pid == host.pid }
        let speaker = sameApp.first { $0.phase == .shown && shown == $0.id } ?? sameApp.min { $0.id.raw < $1.id.raw }
        guard speaker === host else { return s }
        var keepsRead: Bool?
        func keeps() -> Bool { if let k = keepsRead { return k }; let k = sys.keepsWindowsAtQuit(pid: host.pid); keepsRead = k; return k } // (read only for a leftover)
        // (A leftover or strip parked already is left alone while it stays parked; one its app took back out into a user
        // Space (restore-code, 2026-11-17: a leftover parked mid-way into its own full screen landed in that Space a
        // second later) is acted on again.)
        func stillParked(_ w: HostModelWindow) -> Bool { parked.contains(w.number) && [.parked, .nowhere, .unread].contains(w.place) }
        for w in app.windows.values.sorted(by: { $0.number < $1.number }) where !stillParked(w) && !others.contains(w.number) && w.number != host.window {
            switch w.kind {
            case .leftover:
                // (One Margin opened only to wake its app is its own close's: HostedSession closes it, parkWoken parks it.)
                guard !app.woken.contains(w.number) else { continue }
                // (Closed only when that's harmless and surely not the window the person wants: made before the one
                // Margin hosts (restored), its app discarding windows at quit, read by Accessibility on the current Space.
                // Any other is parked: a twin, a launch window, one that may be the app's real main window.)
                s.leftovers.append(HostOther(number: w.number, place: w.place, onScreen: w.onScreen,
                                             closable: w.number < host.window && w.place == .margin && s.marginCurrent && w.ax != nil && !keeps()))
            case .strip:
                // (Its full-screen window's own toolbar is the app's: never parked, moved or reordered.)
                guard !ownToolbar(w, of: host, mine: mine) else { continue }
                s.strips.append(HostOther(number: w.number, place: w.place, onScreen: w.onScreen))
            default: break
            }
        }
        return s
    }

    // A strip of a hosted full-screen window's app that is that window's own toolbar: in exactly the same user Spaces as
    // it, and at its top edge (its width, from its frame's top inward: Chameleon's 1154×52 inside it; or resting just
    // above it: Safari's toolbar window with its toolbar hidden in full screen, its bottom at the page's top, y −11),
    // or once seen so, wherever it is as long as it's where its window is (the window server moves the two together).
    // Never parked, moved or reordered (the real-apps run of 2026-11-17 19:17: Safari's 74772, parked as a strip, took
    // its window 74770 out of Margin's Space each time, until its show was given up; the person's Safari on 2026-11-07:
    // its full-screen toolbar window moved broke the full-screen window, a blank Space). A strip of another window of
    // its app's (left by a backed-out full screen, in another Space, not at its frame: Mail's 1512×88) is parked.
    private func ownToolbar(_ w: HostModelWindow, of host: Host, mine: HostModelWindow?) -> Bool {
        guard host.mode == .fullScreen, let mine, let spaces = mine.spaces, !spaces.isEmpty, w.spaces == spaces else { return false }
        if host.toolbars.contains(w.number) { return true }
        let f = mine.bounds, b = w.bounds, e: CGFloat = 2
        guard f.width > 0, abs(b.minX - f.minX) <= e, abs(b.width - f.width) <= e, b.minY <= f.minY + e, b.maxY >= f.minY - e else { return false }
        host.toolbars.insert(w.number)
        return true
    }

    // The poll's: each host's situation reconciled with what it should be, one correction applied at a time (in the
    // engine's queue), the most urgent first. Only the steady-state corrections here: a first open and a show are the
    // API's own (they run the same reconciler's placement through `bringIn`).
    private func reconcile() {
        guard !quitting, !reconcileQueued, marginSpace > 0 else { return }
        // (The one shown first: its corrections are the ones seen.)
        for id in hosts.keys.sorted(by: { ($0 == shown ? 0 : 1, $0.raw) < ($1 == shown ? 0 : 1, $1.raw) }) {
            guard let host = hosts[id], host.phase != .preparing else { continue }
            // (A member too once the show's late watch is over: right after a show, a member off screen is placed again,
            // `backOnScreen`; later, its app ordered it out (ordersOut after, 2026-11-17 19:08: in Margin's Space, off
            // screen, for good): brought forward like a window-mode one, its app's own reopen the rung that brings it.)
            if host.phase == .shown, shown == id, host.mode == .window || sys.now() - shownAt >= options.lateWatch { noteOffScreen(host) } else { host.offScreenReads = 0 }
            if host.member, host.phase == .shown, shown == id || host.tile != nil { noteOffPage(host) } else if host.tile != nil, host.phase == .parked { noteOffPage(host) } else { host.offPageReads = 0 }
            let s = situation(host)
            let d = desired(host)
            guard let c = HostReconciler.step(s, d).first(where: steady) else { continue }
            reconcileQueued = true
            Task { await serial {
                self.reconcileQueued = false
                guard let host = self.hosts[id] else { return }
                // (Read again in its turn: an operation in between may have settled it.)
                let now = self.situation(host)
                guard HostReconciler.step(now, self.desired(host)).first(where: self.steady) == c else { return }
                guard self.guarded(host, c.key) else { return }
                await self.apply(c, host, now)
            } }
            return
        }
    }

    // Live resize: the reconciler's `sizeTile` for the next host whose tile isn't at the page area (the one shown first),
    // asked at once rather than at the next poll, each its own turn in the queue (a show asked meanwhile goes between
    // them; it sizes its own tile first). Nothing while a drag is under way.
    private func sizeTilesSoon() {
        guard !quitting, !liveOn, tilesOK, !reconcileQueued else { return }
        for id in hosts.keys.sorted(by: { ($0 == shown ? 0 : 1, $0.raw) < ($1 == shown ? 0 : 1, $1.raw) }) {
            guard let host = hosts[id], host.tile != nil, host.phase != .preparing else { continue }
            let s = situation(host)
            guard HostReconciler.step(s, desired(host)).first(where: steady) == .sizeTile else { continue }
            reconcileQueued = true
            Task { await serial {
                self.reconcileQueued = false
                guard let host = self.hosts[id] else { return self.sizeTilesSoon() }
                let now = self.situation(host)
                guard HostReconciler.step(now, self.desired(host)).first(where: self.steady) == .sizeTile else { return self.sizeTilesSoon() }
                guard self.guarded(host, HostCorrection.sizeTile.key) else { return self.sizeTilesSoon() }
                await self.apply(.sizeTile, host, now)
            } }
            return
        }
    }

    // The corrections the poll applies (the first open's placement is `bringIn`'s; a window out of Margin's Space is
    // `strayed`'s, a member off screen `backOnScreen`'s).
    private func steady(_ c: HostCorrection) -> Bool {
        switch c {
        case .adopt, .reopen, .unhide, .bringForward, .closeLeftover, .parkLeftover, .parkStrip, .parkAgain, .frameWindow, .closeItem, .placeAgain, .sizeTile, .fallback: return true
        default: return false
        }
    }

    // A window shown in Margin's Space (window mode, or a member after the show's late watch), the current one at rest,
    // missing from the on-screen list and off screen by its own read: counted (the reconciler brings it forward at the
    // second read in a row).
    private func noteOffScreen(_ host: Host) {
        guard let list = steadyScreen(), sys.spaces(window: host.window) == [marginSpace], !sys.screenAway(), sys.isHidden(pid: ownPid) != true else { host.offScreenReads = 0; return }
        if list.contains(where: { $0.number == host.window }) { host.offScreenReads = 0; return }
        if let own = sys.windowOnScreen(host.window), own.onScreen, own.alpha > 0 { host.offScreenReads = 0; return }
        // (Minimized, by Accessibility: the person's doing, left as it is.)
        if observer.model.apps[host.pid]?.windows[host.window]?.ax?.minimized == true { host.offScreenReads = 0; return }
        host.offScreenReads += 1
    }

    // A member shown in Margin's Space, the current one at rest, whose bounds aren't the page area it was placed for
    // (its app re-laid it out: restore-code's second window going full screen made the first the display's size):
    // counted (the reconciler places it again at the second read in a row). Not while macOS's own change may still land.
    private func noteOffPage(_ host: Host) {
        // (Live resize: a tile's window, shown or parked, off the page area its rect was set for: a tile change laid it
        // out again. Not during a drag: the one shown follows it, the others wait for its end.)
        if host.tile != nil {
            // (Parked: never counted. Its tile laid out again by a tile change Margin didn't make is left as it is
            // until it's shown (sized then, out of sight): sizing a parked tile makes its app draw a window in Margin's
            // Space, whose close lays the first two tiles out again: a loop, seen as blinking (Weather, 2026-11-18).)
            if host.phase == .parked { host.offPageReads = 0; return }
            guard !liveOn, let placed = host.placedPage, HostLayout.near(placed, placement.page, within: options.tolerance), let b = sys.bounds(window: host.window),
                  host.phase == .parked ? sys.spaces(window: host.window) == [] : sys.spaces(window: host.window) == [marginSpace] else { host.offPageReads = 0; return }
            host.offPageReads = HostLayout.near(b, frame(host), within: options.tolerance) ? 0 : host.offPageReads + 1
            return
        }
        guard sys.now() - shownAt > options.lateWatch, sys.spaces(window: host.window) == [marginSpace],
              sys.currentSpace(onDisplayOf: marginSpace) == marginSpace, let b = sys.bounds(window: host.window),
              let placed = host.placedPage, HostLayout.near(placed, placement.page, within: options.tolerance) else { host.offPageReads = 0; return }
        host.offPageReads = HostLayout.near(b, placement.page, within: options.tolerance) ? 0 : host.offPageReads + 1
    }

    // One correction, through the engine's own steps, its line in the log (what was observed, what's done, the budget
    // left of it).
    private func apply(_ c: HostCorrection, _ host: Host, _ s: HostSituation) async {
        host.tries[c.key, default: []].append(sys.now())
        let left = HostReconciler.budget(of: c) - (s.tried(c) + 1)
        Diagnostics.note("host: \(host.id): \(s.text) → \(c.text) (\(left) left)")
        switch c {
        case .parkLeftover(let n), .parkStrip(let n):
            await parkOther(n, of: host)
        case .closeLeftover(let n):
            if await !closeOther(n, of: host) { await parkOther(n, of: host) }
        case .parkAgain:
            await parkAgain(host)
        case .unhide:
            _ = sys.unhide(pid: host.pid)
        case .reopen:
            await reopen(host)
        case .adopt(let n):
            await adopt(host, n)
        case .bringForward(let rung):
            await bringForward(host, rung)
        case .frameWindow:
            if host.mode == .window, host.phase == .shown { _ = await placeWindow(host) }
        case .fallback(let why):
            await fallBackNow(host, why)
        case .closeItem:
            if host.gone, host.phase == .shown { windowGone(host) }
        case .placeAgain:
            host.offPageReads = 0
            if host.phase == .shown, host.member {
                host.placedPage = nil
                // (A tile whose rect didn't take: placed again out of full screen and in, the old way; its tile leaves
                // Margin's Space with its full screen, a new one comes in with the next.)
                if host.tile != nil {
                    Diagnostics.note("host: \(host.id): its tile's rect didn't take: placed again out of full screen and in")
                    _ = await placeFullScreen(host, isNew: false, retrying: false)
                } else {
                    _ = await place(host)
                }
            }
        case .sizeTile:
            if await sizeTile(host), host.phase == .shown, shown == host.id { hostedSaid = nil; announceHosted() }
            sizeTilesSoon()
        default:
            break
        }
    }

    // A leftover or a strip of a hosted app's out of sight in a private Space of its app's (one for all of them), and a
    // full-screen Space of its own it leaves behind destroyed (owned by its app: never one of the person's).
    private func parkOther(_ n: Int, of host: Host) async {
        let spaces = sys.spaces(window: n) ?? []
        let owners = sys.fullScreenSpaceOwners() ?? [:]
        let own = spaces.filter { $0 != marginSpace && sys.spaceType($0) == ManagedSpace.fullScreenType && owners[$0] == host.pid }
        var entry = parkedOthers[host.pid]
        if entry == nil, let space = sys.createPrivateSpace() { entry = (space, []) }
        guard var e = entry else { return Diagnostics.note("host: \(host.id): no private Space for its window \(n)") }
        guard sys.move(window: n, to: e.space), await wait(options.parkWait, every: options.memberEvery, { self.sys.spaces(window: n) == [] }) else {
            parkedOthers[host.pid] = e.windows.isEmpty ? nil : e
            if e.windows.isEmpty { retirePrivate(e.space) }
            return Diagnostics.note("host: \(host.id): its window \(n) didn't go out of sight")
        }
        e.windows.insert(n)
        parkedOthers[host.pid] = e
        for space in own where sys.spaceExists(space) == true {
            ownSpaces.insert(space)
            if await !destroyOwn(space) { leftSpaces.insert(space) }
        }
        saveMarker()
    }

    // A leftover Margin may close (`HostOther.closable`): its own close button (Accessibility, on the current Space). True:
    // gone. Not gone (its app asked about unsaved work, or the press wasn't taken): parked by the caller, said.
    private func closeOther(_ n: Int, of host: Host) async -> Bool {
        let pressed = await sys.close(pid: host.pid, window: n)
        let gone = pressed ? await wait(options.closeWait, every: options.lookEvery) { self.sys.bounds(window: n) == nil } : false
        if !gone { Diagnostics.note("host: \(host.id): its leftover \(n) \(pressed ? "didn't close (its app may be asking about unsaved work)" : "wasn't closed (its close button wasn't pressed)"): parked instead") }
        return gone
    }

    // The leftovers and strips parked for an app given back to its Desktop (before its app quits: one that doesn't
    // quit keeps them where the person can find them), their private Space retired.
    private func releaseOthers(_ pid: pid_t) async {
        guard let e = parkedOthers.removeValue(forKey: pid) else { return }
        if let desktop = sys.desktop(onDisplayOf: marginSpace) {
            for n in e.windows.sorted() where sys.bounds(window: n) != nil { _ = sys.move(window: n, to: desktop) }
        }
        retirePrivate(e.space)
        saveMarker()
    }

    // Parked, found in a user Space (macOS put it on a Desktop, its app took it to full screen): parked again.
    private func parkAgain(_ host: Host) async {
        guard host.phase == .parked, let spaces = sys.spaces(window: host.window), !spaces.isEmpty else { return }
        let own = spaces.filter { $0 != marginSpace && sys.spaceType($0) == ManagedSpace.fullScreenType }
        if !host.member, !own.isEmpty {
            let frozen = holdFreeze()
            await backOut(host)
            releaseFreeze(frozen)
        }
        if let priv = host.privateSpace, sys.move(window: host.window, to: priv) {
            _ = await wait(options.parkWait) { self.sys.spaces(window: host.window) == [] }
        } else {
            host.privateSpace = nil
            _ = await parkMember(host, emitting: false)
        }
        host.strays = 0
        for space in own where sys.spaceExists(space) == true && ownSpaces.contains(space) {
            if await !destroyOwn(space) { leftSpaces.insert(space) }
        }
        saveMarker()
    }

    // Its window gone (or none yet) while its app runs: a Dock-icon click, then the window it orders in or makes, adopted.
    private func reopen(_ host: Host) async {
        let before = Set((serverList(pid: host.pid) ?? []).map(\.number))
        guard sys.reopen(pid: host.pid) else {
            if host.gone { return windowGone(host) }
            return Diagnostics.note("host: \(host.id): its reopen wasn't sent")
        }
        var found: Int?
        _ = await wait(options.reopenWait, every: options.lookEvery) {
            let fresh = HostWindowChoice.candidates(self.serverList(pid: host.pid) ?? [], pid: host.pid) { self.isHosted(window: $0) && $0 != host.window }
            // (A window it ordered in again, or a new one; the one it hosts if it's back.)
            found = fresh.first { !before.contains($0.number) && !(self.sys.spaces(window: $0.number) ?? []).isEmpty }?.number
                ?? (self.sys.bounds(window: host.window) != nil && !(self.sys.spaces(window: host.window) ?? []).isEmpty ? host.window : nil)
            return found != nil
        }
        guard let n = found else { return Diagnostics.note("host: \(host.id): no window came within \(Int(options.reopenWait * 1000)) ms of its reopen") }
        if n == host.window { host.gone = false; host.unread = 0; return }
        await adopt(host, n)
    }

    // A new window of its app's hosted in place of the one it replaced (or that went): as a window in the page area
    // (fast: no full-screen change), its full screen tried again the next time it's shown from parked (if it can go
    // full screen). Shown: into Margin's Space, framed, its app in front; parked: into its private Space.
    private func adopt(_ host: Host, _ n: Int) async {
        let old = host.window
        let t0 = sys.now()
        // (Live resize: its tile, left with a placeholder window of its app's at the tile's rect, on screen in Margin's
        // Space (the real Mac, 2026-11-18 01:25: replacesWindow's), destroyed with it, under the freeze; every rect again.)
        if let t = host.tile {
            host.tile = nil
            goneTiles.insert(t)
            tilesSettled = false
            let frozen = holdFreeze()
            await dropGoneTiles()
            await reapplyTiles()
            releaseFreeze(frozen)
        }
        let info = await sys.window(pid: host.pid, number: n)
        if host.phase == .shown, host.member { host.fullScreenFailures = 0 } // (not a failure: its app's own doing)
        host.window = n
        host.unread = 0
        host.gone = false
        host.offScreenReads = 0
        host.member = false
        host.placedPage = nil
        host.fullScreenSpace = nil
        host.unseen = false
        host.taken = true
        host.away = true
        host.frameChanged = false
        host.original = info?.fullScreen == true ? nil : sys.bounds(window: n)
        host.originalSpace = (sys.spaces(window: n) ?? []).first { sys.spaceType($0) == ManagedSpace.desktopType } ?? sys.desktop(onDisplayOf: marginSpace)
        host.resizable = info?.resizable ?? true
        host.mode = .window
        host.retryFullScreen = (info?.canFullScreen ?? true) && host.fullScreenFailures == 0
        saveMarker()
        switch host.phase {
        case .shown:
            if sys.spaces(window: n) != [marginSpace] {
                _ = sys.move(window: n, to: marginSpace)
                _ = await wait(options.parkWait, every: options.memberEvery) { self.sys.spaces(window: n) == [self.marginSpace] }
            }
            let placed = await placeWindow(host)
            hostedSaid = nil
            announceHosted()
            _ = await front(host)
            Diagnostics.note("host: \(host.id): its app's window \(n) adopted in place of \(old) in \(ms(since: t0)) ms (window mode\(placed ? "" : ", NOT fitted")\(host.retryFullScreen ? "; full screen tried again at its next show" : ""))")
        case .parked:
            if host.privateSpace == nil { host.privateSpace = sys.createPrivateSpace() }
            if let priv = host.privateSpace { _ = sys.move(window: n, to: priv) }
            Diagnostics.note("host: \(host.id): its app's window \(n) adopted in place of \(old) (parked)")
        case .preparing:
            break
        }
        saveMarker()
    }

    // A rung of `bringForward`: its app forward (unhidden, activated, its window raised), or a Dock-icon click; then the
    // window looked at on screen for `forwardWait`. Nothing moved, no Space made current.
    private func bringForward(_ host: Host, _ rung: HostForward) async {
        let t0 = sys.now()
        switch rung {
        case .activate:
            _ = sys.unhide(pid: host.pid)
            _ = await front(host)
        case .reopen:
            _ = sys.reopen(pid: host.pid)
        }
        let on = await wait(options.forwardWait, every: options.lookEvery) { self.sys.windowOnScreen(host.window).map { $0.onScreen && $0.alpha > 0 } ?? false }
        if on { host.offScreenReads = 0 }
        let fronted = sys.frontApp().map { $0 == host.pid ? "the front app" : "not the front app (pid \($0) is)" } ?? "the front app unread"
        Diagnostics.note("host: \(host.id): its window \(on ? "on screen" : "still off screen") \(ms(since: t0)) ms after \(rung.rawValue); its app \(fronted)")
    }

    // A correction's budget used up: shown in window mode if it can be framed (it is already, or its app has no window
    // left), else parked with nothing shown, the item kept and the show failed (the page card says so); its window gone
    // and nothing came: given up as a closed window.
    private func fallBackNow(_ host: Host, _ why: String) async {
        if host.gone { return windowGone(host) }
        guard host.phase == .shown, shown == host.id else { return }
        emit(.failed(host.id, .windowMode, why))
        _ = await retire(host)
        if shown == host.id { shown = nil }
        host.offScreenReads = 0
        Diagnostics.note("host: \(host.id): \(why): parked, nothing shown (its item kept; its next show tries again)")
        emit(.unshown(host.id))
    }

    // ---- the observed model ----

    // The window server's list of one app's windows on every Space, as the engine reads it, kept for the observer.
    private func serverList(pid: pid_t) -> [ServerWindow]? {
        let list = sys.serverWindows(pid: pid)
        if let list { serverSeen[pid] = list }
        return list
    }

    // What the observer follows: every app Margin hosts a window of or started, its hosted windows, the ones parked in a
    // private Space Margin made, the ones it opened only to wake it.
    func observed() -> [HostObserver.Tracked] {
        var out: [pid_t: HostObserver.Tracked] = [:]
        func bundle(of host: Host) -> String {
            if let b = host.bundleId { return b }
            if case .app(let b) = host.target { return b }
            return options.safariBundle
        }
        for host in hosts.values.sorted(by: { $0.id.raw < $1.id.raw }) {
            var t = out[host.pid] ?? HostObserver.Tracked(pid: host.pid, bundleId: launched[host.pid]?.bundleId ?? bundle(of: host), launchedByMargin: launched[host.pid] != nil || host.launchedByMargin)
            t.hosted[host.window] = host.id.description
            if host.phase == .parked, let priv = host.privateSpace { t.parked[host.window] = priv }
            t.launchWindows.formUnion(host.launchWindows)
            out[host.pid] = t
        }
        for (pid, app) in launched where out[pid] == nil {
            out[pid] = HostObserver.Tracked(pid: pid, bundleId: app.bundleId, launchedByMargin: true)
        }
        for (pid, p) in parkedOthers {
            guard var t = out[pid] else { continue }
            for n in p.windows { t.parked[n] = p.space }
            out[pid] = t
        }
        for w in woken.values {
            guard var t = out[w.pid] else { continue }
            t.woken.formUnion(w.parked)
            if let space = w.space { for n in w.parked { t.parked[n] = space } }
            out[w.pid] = t
        }
        return out.keys.sorted().compactMap { out[$0] }
    }

    // The poll's reads given to the observer: its on-screen list if it read one, the engine's lists since the last.
    private func observe() {
        var screen: [ServerWindow]?
        if case .some(.some(let list)) = pollScreen { screen = list }
        observer.update(observed(), onScreen: screen, seen: serverSeen, placement: placement, marginSpace: marginSpace)
        serverSeen = [:]
    }

    // What the engine reads of the one shown, right now, in one line of numbers (the dev hook's `front` line carries it:
    // a check's own process reads the same things of the window server at the same moment, and on 2026-11-17 the two
    // differed), with how many polls have read and how long ago the last did.
    private(set) var polls = 0
    private var polledAt = 0.0
    func readShown() -> String {
        func on(_ n: Int, _ list: [ServerWindow]?) -> String { list.map { l in l.contains { $0.number == n } ? "on screen" : "off screen" } ?? "the on-screen list unread" }
        let polled = "polls \(polls)" + (polls > 0 ? " (the last \(ms(since: polledAt)) ms ago\(busy ? ", an operation running" : ""))" : "")
        // (The observed model: how many apps and windows, its cost a poll, and the shown app's main and other kinds.)
        let model = "; model: \(observer.summary)"
        guard let id = shown, let host = hosts[id] else { return "\(polled), nothing shown\(model)" }
        let list = sys.onScreenWindows()
        return "\(polled), \(id) window \(host.window) in \(sys.spaces(window: host.window).map { "\($0)" } ?? "unread") and \(on(host.window, list))"
            + ", Margin's window \(marginWindow) in \(sys.spaces(window: marginWindow).map { "\($0)" } ?? "unread") and \(on(marginWindow, list))"
            + ", Margin's Space \(marginSpace), its display on \(sys.currentSpace(onDisplayOf: marginSpace).map { "\($0)" } ?? "unread")"
            + model + (observer.summary(of: host.pid).map { "; \($0)" } ?? "")
    }

    // The window server's on-screen list, read once per poll (the look for others and the on-screen look share it),
    // with the display's current Space read right before it (`steadyScreen`).
    private var pollScreen: [ServerWindow]??
    private var pollCurrentBefore: UInt64?
    private var pollSteady: Bool?
    private func screenList() -> [ServerWindow]? {
        if let read = pollScreen { return read }
        pollCurrentBefore = marginSpace > 0 ? sys.currentSpace(onDisplayOf: marginSpace) : nil
        let list = sys.onScreenWindows()
        pollScreen = .some(list)
        return list
    }

    // The poll's on-screen list, only when it's a picture of Margin's Space at rest: that Space the current one of its
    // display both right before the list was read and after it (once per poll). During a Space change (a swipe, Mission
    // Control, ⌘-Tab to an app in another full-screen Space) the list already has windows of the Space being shown
    // while the display still says Margin's (2026-11-17, his log: his own Claude app's and Arc's full-screen windows
    // taken for windows in Margin's Space). Nil: not at rest, or no list.
    private func steadyScreen() -> [ServerWindow]? {
        guard marginWindow != 0, marginSpace > 0, let list = screenList() else { return nil }
        if pollSteady == nil {
            pollSteady = pollCurrentBefore == marginSpace && sys.currentSpace(onDisplayOf: marginSpace) == marginSpace
        }
        return pollSteady == true ? list : nil
    }

    // What the poll read of a host, said when it isn't what it should be (shown: in Margin's Space alone, Margin's window
    // in it, both on screen; parked: in no user Space) and when that changes: the log of a stray then has what was read
    // before it, and a read that differs from another process's shows (2026-11-17: the window server gave a check's
    // process no Space for the shown window while nothing here was logged). Nothing is said while all is as it should be.
    private func sayRead(_ host: Host, spaces: [UInt64]?, marginHere: Bool) {
        var screen = ""
        if host.phase == .shown, shown == host.id, let look = screenLook(screenList()) {
            screen = "Margin's window \(look.margin ? "on" : "off") screen, its window \(look.host ? "on" : "off") screen"
            if look.margin, look.host { screen = "" }
        }
        let fine = host.phase == .preparing || (host.phase == .shown ? spaces == [marginSpace] && marginHere && screen.isEmpty : spaces == [])
        let read = PollRead(phase: host.phase, spaces: spaces, marginHere: marginHere, onScreen: screen)
        guard pollSaid[host.id] != read else { return }
        let was = pollSaid[host.id]
        pollSaid[host.id] = fine ? nil : read
        if pollSaid.count > hosts.count { pollSaid = pollSaid.filter { hosts[$0.key] != nil } }
        guard !fine else {
            if was != nil { Diagnostics.note("host: poll: \(host.id): as it should be again (\(host.phase), its window \(host.window) in \(spaces.map { "\($0)" } ?? "Spaces that don't read"))") }
            return
        }
        Diagnostics.note("host: poll: \(host.id): \(host.phase), its window \(host.window) in \(spaces.map { "\($0)" } ?? "Spaces that don't read"), Margin's Space \(marginSpace)\(marginHere ? "" : ", Margin's window out of it")"
                         + (screen.isEmpty ? "" : ", \(screen)") + (host.askedFullScreenAt.map { ", \(ms(since: $0)) ms after it was last asked into full screen" } ?? ""))
    }

    // macOS finishing its own full-screen change after the engine is done with it (2026-11-17): for `lateWatch` after a
    // full-screen ask, a Space made current on Margin's display that wasn't listed before the ask is undone at the
    // poll's read (said). A Space the person had (listed before, or any Desktop) is never touched.
    private func keepCurrentLate() {
        guard let ask = lateAsk else { return }
        guard sys.now() - ask.at < options.lateWatch else { lateAsk = nil; return }
        guard marginSpace > 0, !quitting, let now = sys.currentSpace(onDisplayOf: marginSpace), now != marginSpace, !ask.before.contains(now),
              sys.spaceType(now) != ManagedSpace.desktopType else { return }
        let done = sys.setCurrentSpace(marginSpace)
        Diagnostics.note("host: macOS made Space \(now) current \(ms(since: ask.at)) ms after a full-screen ask, once the engine was done: Margin's Space \(done ? "made current again" : "couldn't be made current again")")
    }

    // What the window server's on-screen list has of Margin's own window and of the one shown, when it should have
    // both: something shown, Margin's window in its Space, that Space the current one of its display by the window
    // server's list of displays (or the current one a Space that isn't listed at all: never the person's doing), the
    // screen not locked or asleep, neither app hidden. Nil: it doesn't apply (the person is on another Space), or no list.
    private func screenLook(_ list: [ServerWindow]?) -> (margin: Bool, host: Bool)? {
        guard let id = shown, let host = hosts[id], host.phase == .shown, marginWindow != 0, marginSpace > 0, !quitting,
              sys.spaces(window: marginWindow)?.contains(marginSpace) != false,
              let current = sys.currentSpace(onDisplayOf: marginSpace), current == marginSpace || sys.spaceExists(current) == false,
              !sys.screenAway(), sys.isHidden(pid: ownPid) != true, sys.isHidden(pid: host.pid) != true, let list else { return nil }
        return (list.contains { $0.number == marginWindow }, list.contains { $0.number == host.window })
    }

    // The Spaces reads can all look right while nothing of Margin's Space is on screen (2026-11-17, the real Mac, after
    // macOS finished a full-screen change into a Space that was gone: the shown window in Margin's Space by Margin's
    // read, in none by another process's, and neither it nor Margin's own window in the on-screen list). So the poll
    // looks there too. Acted on only at the second read in a row that finds something missing, whatever it is (a
    // transition, or the list itself, can miss one: 2026-11-17 14:05, the Phone's window-mode window, acted on 11 ms after
    // its show). The hosted window alone missing is asked of the window server once more by its own read (its on-screen
    // flag and alpha, `windowOnScreen`): on screen by that, nothing. Later than `lateWatch` after its show, with Margin's
    // window on screen, a missing hosted window is its app's own doing (minimized): said by the poll's read, left alone.
    private func lookOnScreen() {
        // (A window-mode window off screen in Margin's Space, at rest: the reconciler's `bringForward`, `noteOffScreen`.)
        if let id = shown, let host = hosts[id], host.mode == .window, sys.spaces(window: host.window) == [marginSpace],
           sys.currentSpace(onDisplayOf: marginSpace) == marginSpace, screenLook(screenList())?.margin == true {
            offReads = 0
            return
        }
        // (Not a window gone or unread: its item's grace is the reconciler's; placed again, it would fail and be parked.)
        guard let id = shown, let host = hosts[id], !host.gone, host.unread == 0, let look = screenLook(screenList()), !(look.margin && look.host) else {
            offReads = 0
            if shown == nil || screenLook(screenList()) != nil { offSaid = false }
            return
        }
        if look.margin, let own = sys.windowOnScreen(host.window), own.onScreen, own.alpha > 0 { offReads = 0; return }
        offReads += 1
        let fresh = sys.now() - shownAt < options.lateWatch
        guard offReads >= 2, look.margin ? fresh : true else { return }
        offReads = 0
        Task { await serial { await self.backOnScreen(id) } }
    }

    // A window of the hosted app shown that the person opened in Margin's Space (the poll; one window-server read):
    // layer 0, visible, not a hosted window, on Margin's display and reaching outside the page area (one inside it shows
    // through the hole and takes its clicks as it is: a sheet, a small Settings window). Margin's window lets the front
    // one in front until it's gone. Only when all of these hold (2026-11-17, his log: Margin let his own Claude app's and
    // Arc's full-screen windows of other Spaces in front as he swiped, again and again):
    // - the list is a picture of Margin's Space at rest (`steadyScreen`: Margin's Space current before and after it);
    // - the window server's Space read for that window, in the same poll, is Margin's Space and nothing else;
    // - it was seen so at two polls in a row at least `otherConfirm` apart;
    // - its app is the one shown. Never a window of an app Margin doesn't host: such an app can't put a normal window in
    //   another app's full-screen Space; what it shows there is a Space change's picture or a panel at a higher layer.
    //   Never one of a hosted app that isn't the one shown (the person can't have opened it: its app is out of sight),
    //   nor one first seen right after an operation (it came with it: the window of a full-screen window's toolbar, the
    //   windows a Safari Margin started restores before they're swept): those stay behind Margin's window, as
    //   everything of an opening does. No per-app rules.
    // Margin's Space not current, or changing: nothing is said either way (Margin's window is left as it is until the
    // next look at rest).
    private func lookForOthers() {
        guard others != nil else { return }
        let fresh = ranSinceLook
        ranSinceLook = false
        guard marginWindow != 0, marginSpace > 0, hasHosts else {
            otherSeen = [:]
            otherSince = [:]
            return say(other: nil)
        }
        guard let list = steadyScreen() else {
            otherSince = [:] // (seen again from the start at the next look at rest)
            return
        }
        let hosted = Set(hosts.values.map(\.window))
        let shownPid = shown.flatMap { hosts[$0] }.flatMap { $0.phase == .shown ? $0.pid : nil }
        let page = placement.page.insetBy(dx: -1, dy: -1)
        let now = sys.now()
        var front: Int?
        var seen: [Int: Bool] = [:]
        var since: [Int: Double] = [:]
        for w in list where w.layer == 0 && w.pid != ownPid && w.number != marginWindow && w.alpha > 0 && !hosted.contains(w.number) {
            guard w.bounds.width >= 80, w.bounds.height >= 80, w.bounds.intersects(placement.area), !page.contains(w.bounds) else { continue }
            let lets = otherSeen[w.number] ?? (!fresh && w.pid == shownPid)
            seen[w.number] = lets
            // (Never a full-screen window's toolbar strip, nor one over Margin's sidebar: Mail's strip, 2026-11-17, was let
            // in front again and again, and Margin's window with it went below Mail's unfitted window, over the sidebar.)
            guard lets, w.pid == shownPid, !isStrip(w.bounds), !overSidebar(w.bounds), !keptBehind(w), sys.spaces(window: w.number) == [marginSpace] else { continue }
            let first = otherSince[w.number] ?? now
            since[w.number] = first
            if front == nil, now - first >= options.otherConfirm - 1e-9 { front = w.number }
        }
        otherSeen = seen
        otherSince = since
        // (The one let in front still there, still in Margin's Space alone: kept until it's gone.)
        if front == nil, let was = otherSaid, since[was] != nil { front = was }
        say(other: front)
    }

    // What Margin's window checks at each poll at rest (`front`): the poll's on-screen list (front to back) has both
    // Margin's window and the one shown, Margin's Space current before and after it, nothing running, the screen not
    // away. Margin's window's layer by the window server, and whether it's above the hosted window in that order.
    struct FrontRead: Equatable {
        var hosted: Int
        var marginLayer: Int
        var marginAbove: Bool
    }
    private func lookFront() {
        guard let front, !busy, !quitting, let id = shown, let host = hosts[id], host.phase == .shown, !sys.screenAway(),
              sys.isHidden(pid: ownPid) != true, sys.isHidden(pid: host.pid) != true, let list = steadyScreen(),
              let m = list.firstIndex(where: { $0.number == marginWindow }), let h = list.firstIndex(where: { $0.number == host.window }) else { return }
        front(FrontRead(hosted: host.window, marginLayer: list[m].layer, marginAbove: m < h))
    }

    private func say(other number: Int?) {
        guard number != otherSaid else { return }
        otherSaid = number
        others?(number)
    }

    // At launch, before anything is hosted: a crashed Margin's windows given back, its apps quit, its Spaces given back.
    func recover() async {
        await serial { await self.recoverNow() }
    }

    // The host shown, its app in front and its window raised (a press in Margin's page area around it: the app keeps
    // the keyboard). Nothing for a press on the hosted window itself (the app has that press already); nothing while an
    // operation runs (a switch, a close, Margin's quit: a window being given back is never activated) or once Margin is
    // quitting.
    func activateShown(at point: CGPoint? = nil) async {
        guard !busy, !quitting, let id = shown, let host = hosts[id], host.phase == .shown else { return }
        if let point, let b = sys.bounds(window: host.window), b.contains(point) { return }
        _ = await front(host)
    }

    // A private Space a window was just moved out of: destroyed later, never in the same breath as the move.
    private func retirePrivate(_ space: UInt64) {
        guard options.privateRetire > 0 else { _ = sys.destroyPrivateSpace(space); return }
        retired[space] = sys.now()
    }

    // The retired private Spaces old enough, destroyed (the poll); `all`: every one, the youngest's settle waited out
    // first (Margin's quit: 0.3 s at most, so a window just given back to its Desktop isn't taken with its Space).
    private func destroyRetired(all: Bool = false) async {
        if all, let youngest = retired.values.max() {
            let left = min(options.privateRetire, 0.3) - (sys.now() - youngest)
            if left > 0 { await sys.sleep(left) }
        }
        for (space, at) in retired where all || sys.now() - at >= options.privateRetire {
            _ = sys.destroyPrivateSpace(space)
            retired[space] = nil
        }
    }

    // A window just moved into Margin's Space, the Space it came from destroyed: in place only once it has stayed in
    // Margin's Space alone, where it should be, for `memberSettle` (the read right after the destroy said so on the real
    // Mac and the window was in no Space a moment later). Found in no Space meanwhile: put back into Margin's Space
    // (`memberReadds` times at most), the clock started again. (in place, how many times it was put back)
    private func settleMember(_ host: Host, at ok: () -> Bool = { true }, each: () -> Void = {}) async -> (Bool, Int) {
        var since: Double?
        var readds = 0
        let settled = await wait(options.memberWait + options.memberSettle * Double(options.memberReadds + 1), every: options.memberEvery) {
            each()
            let spaces = self.sys.spaces(window: host.window)
            if spaces == [], readds < self.options.memberReadds {
                readds += 1
                since = nil
                _ = self.sys.move(window: host.window, to: self.marginSpace)
                return false
            }
            guard spaces == [self.marginSpace], ok() else { since = nil; return false }
            let from = since ?? self.sys.now()
            since = from
            return self.sys.now() - from >= self.options.memberSettle
        }
        if readds > 0 { Diagnostics.note("host: \(host.id): its window was in no Space after its move into Margin's (\(readds) time\(readds == 1 ? "" : "s")): put back\(settled ? ", there now" : ", still not there")") }
        return (settled, readds)
    }

    // ---- what the hosting reads ----

    // Whether `id` is hosted now (opened, shown or parked).
    func isHosted(_ id: HostID) -> Bool { hosts[id] != nil }

    // How `id` is shown (nil: not hosted).
    func mode(of id: HostID) -> HostMode? { hosts[id]?.mode }

    // The window of the host shown in Margin's Space, nil if none (Margin's window is in front of it).
    var shownWindow: Int? { shown.flatMap { hosts[$0] }.flatMap { $0.phase == .shown ? $0.window : nil } }

    private func announceHosted() {
        sayMinimum()
        let now = shownWindow
        guard now != hostedSaid else { return }
        hostedSaid = now
        hostedWindow?(now)
    }

    private func say(cover number: Int?) {
        guard number != coverSaid else { return }
        coverSaid = number
        cover?(number)
    }

    private func say(loading id: HostID?) {
        guard id != loadingSaid else { return }
        loadingSaid = id
        loading?(id)
    }

    // One freeze for every step holding it: a step that freezes inside another's (a give-up's close), or beside it (the
    // hosts given back at once at Margin's quit), doesn't freeze again; the screen is revealed once the last lets go.
    private func holdFreeze() -> Bool {
        if freezeHolds > 0 { freezeHolds += 1; return true }
        guard sys.freeze() else { return false }
        freezeHolds = 1
        return true
    }
    private func releaseFreeze(_ mine: Bool) {
        guard mine, freezeHolds > 0 else { return }
        freezeHolds -= 1
        if freezeHolds == 0 { sys.reveal() }
    }

    // The host whose window is `number` (a Safari window the extension made: closed by its copy).
    func target(ofWindow number: Int) -> HostTarget? { hosts.values.first { $0.window == number }?.target }

    // The full-screen Space `number` (Margin's window) is in, nil if it's in none.
    func fullScreenSpace(ofWindow number: Int) -> UInt64? {
        sys.spaces(window: number)?.first { sys.spaceType($0) == ManagedSpace.fullScreenType }
    }

    // ---- one at a time ----

    private func serial<T: Sendable>(planned: Bool = false, _ body: @escaping () async -> T) async -> T {
        let previous = tail
        let task = Task { () -> T in
            _ = await previous?.value
            self.busy = true
            self.ranSinceLook = true
            // (A person's operation: what it changes is Margin's plan; the guard's counts start again.)
            if planned { self.core.person(now: self.sys.now()) }
            self.planned = planned
            let value = await body()
            self.planned = false
            self.activity()
            self.parkWoken() // (a window opened to wake a profile during it: out of sight before anything else is seen)
            self.observer.sync(self.observed()) // (an app hosted or given back: followed, or not, from now)
            self.busy = false
            return value
        }
        tail = Task { _ = await task.value }
        return await task.value
    }

    // ---- open ----

    private func openNow(_ target: HostTarget) async -> HostResult {
        let id = target.id
        guard sys.spaceType(marginSpace) == ManagedSpace.fullScreenType, sys.spaces(window: marginWindow)?.contains(marginSpace) == true else {
            return fail(id, .margin, "Margin's window isn't in a full-screen Space of its own (\(marginSpace))")
        }
        // (Live resize: Margin's window in another full-screen Space now: its hosts' tiles taken over from the old one.)
        if tilesFor != 0, tilesFor != marginSpace, hosts.values.contains(where: { $0.tile != nil }) { await adoptTiles(from: tilesFor) }
        if let host = hosts[id] {
            if shown == id { return .shown(id, placed: await place(host)) }
            return await bringIn(host, isNew: false)
        }
        // A first open: the loading animation in the page area from now, the one shown before parked first so it's
        // seen (shown again if this open fails).
        say(loading: id)
        defer { say(loading: nil) }
        var previous: Host?
        if let was = shown.flatMap({ hosts[$0] }) {
            let t0 = sys.now()
            let parked = await retire(was) // (a window-mode one as it is: its frame is given back only with it)
            guard parked else { return fail(id, .park, "the one shown before (\(was.id)) couldn't leave Margin's Space") }
            Diagnostics.note("host: \(was.id) parked in \(ms(since: t0)) ms for \(id)'s first open")
            previous = was
        }
        let result = await openNew(target)
        if case .failed = result, let previous, previous.phase == .parked, shown == nil, hosts[previous.id] != nil {
            Diagnostics.note("host: \(previous.id) shown again after \(id)'s open failed")
            _ = await bringIn(previous, isNew: false, retrying: true)
        }
        return result
    }

    private func openNew(_ target: HostTarget) async -> HostResult {
        let id = target.id
        let started = sys.now()
        var times: [String] = []
        // 1-2. the app, and its window.
        let bundle: String
        switch target {
        case .app(let b): bundle = b
        case .safariWindow: bundle = options.safariBundle
        }
        // (Its last instance asked to quit by a row's close and still finishing: its exit waited for, never hosting it.)
        if let waited = await awaitExits(of: bundle) { times.append("its last instance's exit waited for \(waited) ms") }
        let running = sys.running(bundleId: bundle)
        var app: HostApp
        var startedNow = false
        if let first = running.first {
            // (An app the person opened is hosted as it is: never started again or quit, its Dock icon left.)
            app = first
        } else {
            let arguments = bundle == options.safariBundle ? options.safariArguments : options.appArguments
            guard sys.launchDockless(bundleId: bundle, arguments: arguments) else { return fail(id, .launch, "\(bundle) couldn't be started with no Dock icon") }
            var found: HostApp?
            _ = await wait(options.launchWait) { found = self.sys.running(bundleId: bundle).first; return found != nil }
            guard let found else { return fail(id, .launch, "\(bundle) didn't start within \(Int(options.launchWait)) s") }
            app = found
            startedNow = true
            launched[app.pid] = app
            saveMarker()
            let policy = sys.policy(pid: app.pid)
            times.append("launch \(ms(since: started)) (\(policy == .accessory ? "no Dock icon" : "policy \(policy.map { "\($0)" } ?? "unknown")"))")
        }

        let windowStarted = sys.now()
        let launchedByMargin = launched[app.pid] != nil
        var number: Int?
        if case .safariWindow(let profile) = target, !launchedByMargin || profile != nil || hosts.values.contains(where: { $0.pid == app.pid }) {
            // A window of Margin's own in Safari: asked of its extension, known as the window that wasn't there before.
            if !launchedByMargin {
                switch sys.safariAutoShowsToolbar() {
                case false?: Diagnostics.note("host: Safari's own AutoShowToolbarInFullScreen is off: its toolbar shows over the page in full screen (known gap; its setting is left as it is)")
                case nil: Diagnostics.note("host: Safari's AutoShowToolbarInFullScreen didn't read: its own setting decides whether its toolbar shows")
                default: break
                }
            }
            if let linked = safariLinked, await !linked(profile) {
                if startedNow { await quitApp(app.pid, bundle: bundle) }
                return fail(id, .window, "Safari's extension didn't link")
            }
            // A window made ready out of sight in a Safari started hidden (LaunchServices' hide option, as every app Margin
            // starts with no Dock icon): unhidden first, never activated. Seen on the real Mac 2026-11-16: a hidden
            // Safari asked for an unfocused window answers its id but orders nothing in, so the window server never
            // lists it. It's asked focused (as every other window Margin asks of Safari), so Safari unhides and orders
            // it in anyway; unhidden first, the windows it orders in as it's unhidden come before the list below.
            if preparing, sys.isHidden(pid: app.pid) == true {
                let t = sys.now()
                if sys.unhide(pid: app.pid) {
                    var last = Set((serverList(pid: app.pid) ?? []).map(\.number)), since = sys.now()
                    _ = await wait(options.unhideSettleWait, every: options.memberEvery) {
                        let now = Set((self.serverList(pid: app.pid) ?? []).map(\.number))
                        if now != last { last = now; since = self.sys.now() }
                        return self.sys.isHidden(pid: app.pid) != true && self.sys.now() - since >= self.options.unhideSettle
                    }
                    times.append("unhidden \(ms(since: t))")
                } else {
                    Diagnostics.note("host: \(id): Safari is hidden and didn't take the unhide: its window asked anyway")
                }
            }
            // Every window Safari has now, on every Space (the window server's), and the ones Accessibility lists: read
            // before the ask, so the window it makes is the one that wasn't there.
            let before = Set((serverList(pid: app.pid) ?? []).map(\.number)).union((await sys.windows(pid: app.pid) ?? []).map(\.number))
            // Out of sight: Margin's Space kept current while Safari makes its window (asked focused, Safari comes to the
            // front and macOS may switch to the Space its new window opens in, the Desktop): undone at once.
            let keepSpace = preparing && sys.currentSpace(onDisplayOf: marginSpace) == marginSpace
            var undone = 0
            func keepMarginCurrent() {
                guard keepSpace, let now = sys.currentSpace(onDisplayOf: marginSpace), now != marginSpace else { return }
                if sys.setCurrentSpace(marginSpace) { undone += 1 }
            }
            guard let request = requestSafariWindow, let asked = await request(profile) else {
                if startedNow { await quitApp(app.pid, bundle: bundle) }
                return fail(id, .window, "Safari's extension wasn't asked for a window (no link)")
            }
            keepMarginCurrent()
            var seen = 0
            _ = await wait(options.windowWait) {
                keepMarginCurrent()
                (number, seen) = self.newSafariWindow(pid: app.pid, before: before, near: asked.bounds)
                return number != nil
            }
            if undone > 0 { times.append("\(undone) Space change\(undone == 1 ? "" : "s") undone") }
            guard let window = number else {
                await closeAskedSafariWindow(asked.id, profile: profile, pid: app.pid, number: nil, why: "its window wasn't found")
                if startedNow { await quitApp(app.pid, bundle: bundle) }
                return fail(id, .window, seen > 1 ? "\(seen) new Safari windows within \(Int(options.windowWait)) s, none told apart by the copy's bounds"
                                                  : "no new Safari window in the window server's list within \(Int(options.windowWait)) s")
            }
            times.append("window \(ms(since: windowStarted)) (by the window server)")
            let host = Host(id: id, target: target, pid: app.pid, window: window, launchedByMargin: launchedByMargin, madeByMargin: !launchedByMargin, safariWindow: asked.id)
            return await opened(host, started: started, times: times)
        }
        // Its main window as Accessibility lists it (the current Space's), else its front window by the window server
        // (on another Space, where Accessibility can't see it): at once for an app the person opened, after a moment for
        // one Margin started (its window may still be coming). Never a minimized one.
        let personal = !launchedByMargin
        var isApp = false
        if case .app = target { isApp = true }
        var info: HostWindow?
        var minimizedOnly = false
        var unhidden = false
        var rule: HostWindowChoice.Rule?
        var looking = sys.now()
        var reopened = 0
        func lookForWindow(_ seconds: Double) async -> Bool {
            await wait(seconds) {
                let listed = (await self.sys.windows(pid: app.pid) ?? []).filter { !self.isHosted(window: $0.number) }
                let usable = listed.filter { !$0.minimized }
                minimizedOnly = !listed.isEmpty && usable.isEmpty
                // (An app Margin started that's still hidden lists nothing to Accessibility: the window server's window at
                // once, unhidden in `take`. One with no window at all while hidden, unhidden now: some make theirs only then.)
                let hidden = !personal && (unhidden || self.sys.isHidden(pid: app.pid) == true)
                var serverAllowed = isApp && !minimizedOnly && (personal || hidden || self.sys.now() - looking >= self.options.serverAfter)
                // (None Accessibility lists as a standard window, and the window server has one in a Space or on screen that
                // Accessibility finds by its number, whatever its subrole: that one, at once. A window that can't go full
                // screen in an app with no Dock icon reads AXDialog and was found only 3 s on: Calculator, the Phone,
                // Chameleon's noFullScreen, 2026-11-17.)
                var found: HostWindow?
                if isApp, !serverAllowed, usable.isEmpty, !minimizedOnly {
                    let placed = HostWindowChoice.candidates(self.serverList(pid: app.pid) ?? [], pid: app.pid) { self.isHosted(window: $0) }
                        .filter { $0.onScreen || !(self.sys.spaces(window: $0.number) ?? []).isEmpty }
                    if placed.count == 1, let w = await self.sys.window(pid: app.pid, number: placed[0].number), !w.minimized {
                        found = w
                        serverAllowed = true
                    }
                }
                if let chosen = await self.chooseWindow(pid: app.pid, listed: listed, serverAllowed: serverAllowed) {
                    number = chosen.number
                    rule = chosen.rule
                    info = usable.first { $0.number == chosen.number } ?? (found?.number == chosen.number ? found : nil)
                    return true
                }
                if isApp, hidden, !unhidden, self.sys.now() - looking >= self.options.unhideWait, self.sys.unhide(pid: app.pid) {
                    unhidden = true
                    Diagnostics.note("host: \(id): its app hidden with no window yet: unhidden")
                }
                // (No window at all `reopenAfter` into an app Margin started: a Dock-icon click, once.)
                if isApp, !personal, reopened == 0, self.sys.now() - looking >= self.options.reopenAfter,
                   HostWindowChoice.candidates(self.serverList(pid: app.pid) ?? [], pid: app.pid, excluded: { self.isHosted(window: $0) }).isEmpty {
                    reopened += 1
                    let sent = self.sys.reopen(pid: app.pid)
                    Diagnostics.note("host: \(id): running with no window \(self.ms(since: looking)) ms into its open → reopen\(sent ? "" : " (not sent)") (\(HostReconciler.budget(of: .reopen) - reopened) left)")
                }
                return false
            }
        }
        _ = await lookForWindow(personal ? options.personWindowWait : options.windowWait)
        // Running with no window Margin can host (the person's app with none, its Dock icon there: Maps, 2026-11-17 15:19;
        // one of Margin's that made none): reopened as a Dock-icon click would, then looked at again, within the budget.
        while number == nil, isApp, !minimizedOnly, sys.processRuns(pid: app.pid), reopened < HostReconciler.budget(of: .reopen) {
            var s = HostSituation()
            s.hidden = sys.isHidden(pid: app.pid)
            s.launchedByMargin = !personal
            s.tries = ["reopen": reopened]
            guard let c = HostReconciler.step(s, .shown(placement)).first, c == .reopen || c == .unhide else { break }
            reopened += 1
            let sent = c == .unhide ? sys.unhide(pid: app.pid) : sys.reopen(pid: app.pid)
            Diagnostics.note("host: \(id): \(s.text) → \(c.text)\(sent ? "" : " (not sent)") (\(HostReconciler.budget(of: c) - reopened) left)")
            guard sent else { break }
            looking = sys.now() - options.serverAfter // (the window server's word at once from here: it was asked)
            if await lookForWindow(options.reopenWait) { break }
        }
        guard let window = number else {
            if startedNow { await quitApp(app.pid, bundle: bundle) }
            if personal { return fail(id, .window, minimizedOnly ? "\(bundle) has only minimized windows: left as they are" : "\(bundle) is open with no window Margin can host") }
            return fail(id, .window, "no window within \(Int(options.windowWait)) s")
        }
        times.append("window \(ms(since: windowStarted))\(info == nil ? " (by the window server: on another Space)" : "")\(personal ? ", an app the person opened" : "")")
        if let rule { Diagnostics.note("host: \(id): its window \(window) chosen as \(rule.rawValue)") }
        let host = Host(id: id, target: target, pid: app.pid, window: window, launchedByMargin: launchedByMargin, madeByMargin: false)
        host.bundleId = bundle
        host.appLaunchedAt = app.launchedAt
        if case .app = target {
            if let info { host.mode = info.canFullScreen ? .fullScreen : .window; host.resizable = info.resizable } else { host.unseen = true }
        }
        return await opened(host, started: started, times: times)
    }

    private func opened(_ host: Host, started: Double, times: [String]) async -> HostResult {
        let id = host.id, pid = host.pid
        hosts[id] = host
        applyHeldRoute(host)
        saveMarker()
        if !sys.watchOpens(pid: pid, { [weak self] code in self?.heard(code, pid: pid) }) {
            Diagnostics.note("host: \(id): LaunchServices' notifications aren't heard: an open from outside isn't noticed")
        }
        emit(.opened(id, ms: ms(since: started)))
        Diagnostics.note("host: \(id) opened (pid \(pid), window \(host.window)\(host.safariWindow.map { ", the copy's \($0)" } ?? "")): \(times.joined(separator: ", "))")
        let result = await bringIn(host, isNew: true)
        // (Its app's windows as its first show ends, an app Margin started: what it restored or made as it launched, the
        // window it hosts aside. The model's leftovers: HostModel's launchWindows, WindowKinds rule 8b.)
        if hosts[id] === host, host.launchedByMargin, case .app = host.target {
            let others = Set(hosts.values.map(\.window))
            host.launchWindows = Set(HostWindowChoice.candidates(serverList(pid: pid) ?? [], pid: pid) { others.contains($0) }.map(\.number))
        }
        return result
    }

    // The window a copy made, by the window server (every Space): a layer-0 window of Safari's pid, at least 200×200,
    // that wasn't there before the ask and isn't hosted; of several, the one at the copy's bounds. (window, how many new)
    private func newSafariWindow(pid: pid_t, before: Set<Int>, near: CGRect?) -> (Int?, Int) {
        let fresh = (serverList(pid: pid) ?? []).filter {
            $0.pid == pid && $0.layer == 0 && $0.bounds.width >= 200 && $0.bounds.height >= 200 && !before.contains($0.number) && !isHosted(window: $0.number)
        }
        if let near {
            let at = fresh.filter { HostLayout.near($0.bounds, near, within: 4) }
            if at.count == 1 { return (at[0].number, fresh.count) }
        }
        return (fresh.count == 1 ? fresh[0].number : nil, fresh.count)
    }

    // Which of an app's windows to host (HostWindowChoice: Accessibility's main or focused window, else the window
    // server's on screen, else a standard one Accessibility lists, else one in a Space, else its front one), from what
    // Accessibility lists now (`listed`; its minimized ones never) and the window server's windows on every Space.
    private func chooseWindow(pid: pid_t, listed: [HostWindow], serverAllowed: Bool, for host: Host? = nil) async -> (number: Int, rule: HostWindowChoice.Rule)? {
        let minimized = Set(listed.filter(\.minimized).map(\.number))
        let taken = Set(hosts.values.filter { $0 !== host }.map(\.window)) // (hosted by another)
        let candidates = HostWindowChoice.candidates(serverList(pid: pid) ?? [], pid: pid) { taken.contains($0) || minimized.contains($0) }
        let main = await sys.mainWindow(pid: pid)
        let focused = main == nil ? await sys.focusedWindow(pid: pid) : nil
        let standard = listed.filter { !$0.minimized }.map(\.number)
        return HostWindowChoice.choose(candidates: candidates, inSpace: { !(self.sys.spaces(window: $0) ?? []).isEmpty }, main: main.flatMap { minimized.contains($0) ? nil : $0 },
                                       focused: focused.flatMap { minimized.contains($0) ? nil : $0 }, standard: standard, serverAllowed: serverAllowed)
    }

    // An app's window Accessibility didn't list, chosen again right before it's first moved (its app unhidden by then: a
    // hidden app's windows may all be ordered out, the real one ordered in only once it's unhidden). Another chosen:
    // that one's hosted, said.
    private func chooseAgain(_ host: Host) async {
        guard case .app = host.target, host.unseen else { return }
        let others = Set(hosts.values.filter { $0 !== host }.map(\.window))
        let listed = (await sys.windows(pid: host.pid) ?? []).filter { !others.contains($0.number) }
        guard let chosen = await chooseWindow(pid: host.pid, listed: listed, serverAllowed: true, for: host) else { return }
        guard chosen.number != host.window else { return }
        Diagnostics.note("host: \(host.id): its window chosen again before it's moved: \(chosen.number) (\(chosen.rule.rawValue)), not \(host.window)")
        host.window = chosen.number
        if let info = listed.first(where: { $0.number == chosen.number && !$0.minimized }) {
            host.unseen = false
            host.mode = info.canFullScreen ? .fullScreen : .window
            host.resizable = info.resizable
        }
        saveMarker()
    }

    // ---- a new app's window, taken as it is ----

    // Its frame and its Space recorded before anything moves it. The person's window already full screen in a Space of
    // its own: left alone (Margin doesn't move other people's full-screen windows). One Accessibility didn't list (on
    // another Space): brought into Margin's Space (current), where it's read (`look`); still unread: not hosted.
    private func take(_ host: Host) async -> (HostStep, String)? {
        if host.unseen {
            // Unhidden first (as the kit found: a hidden app's window isn't listed, and may not be ordered in at all), then
            // its window chosen again, before anything records or moves it.
            await unhideIfHidden(host)
            await chooseAgain(host)
        }
        let spaces = sys.spaces(window: host.window) ?? []
        let owners = sys.fullScreenSpaceOwners()
        let fullScreenSpaces = spaces.filter { sys.spaceType($0) == ManagedSpace.fullScreenType && $0 != marginSpace }
        // (Its app's own: owned by its app, or by none.)
        let ownFull = fullScreenSpaces.first { s in owners.map { [host.pid, 0].contains($0[s] ?? host.pid) } ?? true }
        if host.personApp, !fullScreenSpaces.isEmpty {
            return (.fullScreen, "its window is already in full screen in a Space of its own (the person's): left alone")
        }
        // (A full-screen window's bounds are its Space's, not a frame it can be given back: Maps', 2026-11-17, was asked
        // for the display's whole area at every park and kept "not given back" at its own frame. Window mode records the
        // frame it has once it's a window, before it sets one.)
        var fullElsewhere = false
        if ownFull == nil, !host.unseen, spaces.contains(where: { sys.spaceType($0) == ManagedSpace.fullScreenType }) {
            fullElsewhere = await sys.isFullScreen(pid: host.pid, window: host.window) == true
        }
        host.original = ownFull == nil && !fullElsewhere ? sys.bounds(window: host.window) : nil
        host.originalSpace = spaces.first { sys.spaceType($0) != ManagedSpace.fullScreenType }
        host.taken = true
        host.away = true // (from here on, it's put back where it was when it's given back)
        saveMarker()
        // Already in full screen in a Space of its own (an app Margin started that restored its window so: Maps,
        // 2026-11-17, its own log `windowIsFullScreen=1 appIsHidden=1`, the Dock adding its Space before Margin found the
        // window): that is where a full-screen ask would have brought it, so it's placed from there (its Space reserved,
        // the window moved in, that Space destroyed), never brought into Margin's Space to be read first. Brought in, it
        // read full screen with no Space of its own: nothing was asked, nothing came, 6 s, then window mode.
        if host.unseen, case .app = host.target, let own = ownFull {
            host.unseen = false
            host.mode = .fullScreen
            host.fullScreenSpace = own
            ownSpaces.insert(own)
            saveMarker()
            Diagnostics.note("host: \(host.id): its window came up in full screen in a Space of its own (\(own), its app restored it so): placed from there, never moved into Margin's Space to be read")
            return nil
        }
        guard host.unseen else { return nil }
        // Covered by Margin's window while it's in Margin's Space to be read (its app unhidden above).
        say(cover: host.window)
        guard sys.move(window: host.window, to: marginSpace), await wait(options.parkWait, { self.sys.spaces(window: host.window) == [self.marginSpace] }) else {
            return (.windowMode, "its window didn't come into Margin's Space to be read")
        }
        var read = await look(host)
        // Still unlisted: a window never ordered in until its app is brought forward (the Phone's, 2026-11-17; Chameleon's
        // ordersOut untilActive): the reconciler's `bringForward`, a rung at a time (its app activated, then a Dock-icon
        // click), looked at again after each. Never while it's made ready out of sight, nor as Margin quits.
        if read == nil, !preparing, !quitting {
            for (i, rung) in [HostForward.activate, .reopen].enumerated() {
                Diagnostics.note("host: \(host.id): first open, window \(host.window) in Margin's Space, not listed by Accessibility (never ordered in?) → bring forward (\(rung.rawValue)) (\(1 - i) left)")
                switch rung {
                case .activate:
                    _ = sys.unhide(pid: host.pid)
                    _ = await front(host)
                default:
                    _ = sys.reopen(pid: host.pid)
                }
                // (Ordered in where its app put it: brought into Margin's Space again if that isn't it.)
                if sys.spaces(window: host.window) != [marginSpace] {
                    _ = sys.move(window: host.window, to: marginSpace)
                    _ = await wait(options.parkWait, every: options.memberEvery) { self.sys.spaces(window: host.window) == [self.marginSpace] }
                }
                if await wait(options.lookWait / 2, every: options.lookEvery, { read = await self.sys.window(pid: host.pid, number: host.window); return read != nil }) {
                    Diagnostics.note("host: \(host.id): Accessibility found its window after \(rung.rawValue)")
                    break
                }
            }
        }
        guard let info = read else {
            return (.window, "Accessibility doesn't list its window, even on the current Space or with its Desktop current, nor once its app was brought forward")
        }
        if info.minimized { return (.window, "its window is minimized: left as it is") }
        host.unseen = false
        host.mode = info.canFullScreen ? .fullScreen : .window
        host.resizable = info.resizable
        saveMarker()
        Diagnostics.note("host: \(host.id): its window read in Margin's Space: \(host.mode.rawValue)\(host.mode == .window ? (host.resizable ? ", resizable" : ", a fixed size") : "")")
        return nil
    }

    // A window the window server found (on another Space), now in Margin's Space, read by Accessibility. Accessibility
    // lists a window only on the current Space and only once the window server has moved it there (seen 2026-11-15:
    // Calculator, started while Margin's Space was current, opened on the Desktop; brought in, it wasn't listed within
    // a second), so it's asked every 50 ms for up to 2 s for the element whose window number is the server's, whatever
    // its role or subrole (Calculator's needn't be a standard window). Still nothing: once more with its Desktop made
    // current (where a stand-alone test saw Calculator's window at once), under the freeze, then back into Margin's
    // Space; Accessibility keeps the element it found. Nil: not read.
    private func look(_ host: Host) async -> HostWindow? {
        let t0 = sys.now()
        var info: HostWindow?
        func found() async -> Bool {
            info = await sys.window(pid: host.pid, number: host.window)
            return info != nil
        }
        if await wait(options.lookWait, every: options.lookEvery, found) {
            Diagnostics.note("host: \(host.id): Accessibility found its window in Margin's Space after \(ms(since: t0)) ms (by its number\(info?.role.map { ", \($0)" } ?? ""))")
            return info
        }
        // Still unlisted: its app unhidden if it hid again, and asked once with AXEnhancedUserInterface on (what assistive
        // apps set: some apps expose their windows only then), set back as it was after.
        let unhid = await unhideIfHidden(host)
        let enhancedBefore = await sys.enhancedUserInterface(pid: host.pid)
        var enhanced = false
        if enhancedBefore != true { enhanced = await sys.setEnhancedUserInterface(pid: host.pid, true) }
        let t2 = sys.now()
        var seenEnhanced = false
        if unhid || enhanced { seenEnhanced = await wait(options.enhancedLookWait, every: options.lookEvery, found) }
        if enhanced { _ = await sys.setEnhancedUserInterface(pid: host.pid, false) }
        if seenEnhanced {
            Diagnostics.note("host: \(host.id): Accessibility found its window in Margin's Space after \(ms(since: t0)) ms, \(ms(since: t2)) ms after \([unhid ? "its app was unhidden" : nil, enhanced ? "AXEnhancedUserInterface was on" : nil].compactMap { $0 }.joined(separator: " and ")) (by its number\(info?.role.map { ", \($0)" } ?? ""))")
            return info
        }
        if !unhid, !enhanced { Diagnostics.note("host: \(host.id): AXEnhancedUserInterface \(enhancedBefore == true ? "was on already" : "wasn't taken")") }
        let frozen = holdFreeze()
        defer { releaseFreeze(frozen) }
        guard freezeHolds > 0, let desktop = home(host.originalSpace, display: host.originalSpace ?? marginSpace), desktop != marginSpace else {
            Diagnostics.note("host: \(host.id): Accessibility didn't list its window in Margin's Space within \(ms(since: t0)) ms\(freezeHolds > 0 ? "" : " (no freeze: its Desktop isn't made current)")")
            return nil
        }
        let t1 = sys.now()
        if sys.move(window: host.window, to: desktop) { _ = await wait(options.parkWait) { self.sys.spaces(window: host.window)?.contains(desktop) == true } }
        let wentThere = sys.setCurrentSpace(desktop)
        if wentThere { _ = await wait(0.5) { self.sys.currentSpace(onDisplayOf: self.marginSpace) == desktop } }
        var seen = false
        if wentThere { seen = await wait(options.desktopLookWait, every: options.lookEvery, found) }
        // (Back: Margin's Space current again, the window in it.)
        if sys.currentSpace(onDisplayOf: marginSpace) != marginSpace {
            _ = sys.setCurrentSpace(marginSpace)
            _ = await wait(0.5) { self.sys.currentSpace(onDisplayOf: self.marginSpace) == self.marginSpace }
        }
        var back = sys.move(window: host.window, to: marginSpace)
        if back { back = await wait(options.parkWait) { self.sys.spaces(window: host.window) == [self.marginSpace] } }
        Diagnostics.note("host: \(host.id): Accessibility didn't list its window in Margin's Space within \(ms(since: t0)) ms; with its Desktop current \(seen ? "it found it (by its number\(info?.role.map { ", \($0)" } ?? ""))" : wentThere ? "it didn't either" : "(not made current)") in \(ms(since: t1)) ms\(back ? "" : "; its window didn't come back into Margin's Space")")
        return seen && back ? info : nil
    }

    // An app hidden (started so: LaunchServices' hide option) unhidden, never activated: a hidden app's windows aren't in
    // Accessibility's list (seen 2026-11-15: Dictionary's window, read by the window server only, never listed in
    // Margin's Space or on its Desktop). Waited for at most `unhideWait`. True: it was hidden and isn't now.
    @discardableResult private func unhideIfHidden(_ host: Host) async -> Bool {
        guard sys.isHidden(pid: host.pid) == true else { return false }
        let t0 = sys.now()
        guard sys.unhide(pid: host.pid) else {
            Diagnostics.note("host: \(host.id): its app is hidden and wasn't unhidden")
            return false
        }
        let done = await wait(options.unhideWait) { self.sys.isHidden(pid: host.pid) == false }
        Diagnostics.note("host: \(host.id): its app was hidden: \(done ? "unhidden in \(ms(since: t0)) ms" : "asked to unhide, still hidden after \(ms(since: t0)) ms")")
        return done
    }

    // ---- window mode ----

    // A window-mode host shown: the one shown before out of Margin's Space first (a member parked, still full screen;
    // a window its frame given back, then parked), then its window into Margin's Space (out of its private Space, or off
    // its Desktop) and placed in the page area, under Margin's window, its app in front. Under the freeze.
    private func bringInWindow(_ host: Host, isNew: Bool, retrying: Bool) async -> HostResult {
        let started = sys.now()
        var times: [String] = []
        func step(_ name: String, _ t0: Double) { times.append("\(name) \(ms(since: t0))") }
        // (Under the freeze only when its frame is set: a window parked at the page area's frame comes in as it is.)
        let atPage = !isNew && host.frameChanged && atPageArea(host)
        let frozen = atPage ? false : holdFreeze()
        defer { releaseFreeze(frozen) }
        let previous = shown.flatMap { $0 == host.id ? nil : hosts[$0] }
        var t0 = sys.now()
        if let previous {
            guard await retire(previous) else {
                return await giveUp(host, isNew: isNew, .park, "the one shown before (\(previous.id)) couldn't leave Margin's Space", previous: nil)
            }
            step("park \(previous.id)", t0)
        }
        // Into Margin's Space, as a window (the bridge, options 7: out of every other Space).
        t0 = sys.now()
        if sys.spaces(window: host.window) != [marginSpace] {
            host.away = true
            guard sys.move(window: host.window, to: marginSpace), await wait(options.parkWait, { self.sys.spaces(window: host.window) == [self.marginSpace] }) else {
                return await giveUp(host, isNew: isNew, .windowMode, "its window didn't come into Margin's Space", previous: retrying ? nil : previous)
            }
        }
        if let priv = host.privateSpace {
            retirePrivate(priv)
            host.privateSpace = nil
        }
        step("into Margin's Space", t0)
        host.phase = .shown
        shown = host.id // (Margin's window in front of it from now: hostedWindow)
        saveMarker()
        t0 = sys.now()
        let placed = await placeWindow(host)
        step("place", t0)
        // (Not fitted and over Margin's sidebar, larger than the page area: never shown so. Its frame given back and
        // parked out of sight, still hosted, behind the loader; the item is kept and its next show tries again.)
        if !placed, let b = sys.bounds(window: host.window), coversSidebar(b) {
            let reason = "its window couldn't be fitted to the page area (it's at \(r(b)), over Margin's sidebar): kept out of sight, tried again at its next show"
            Diagnostics.note("host: \(host.id): \(reason)")
            if await !retireWindow(host) {
                await restoreFrame(host)
                _ = await parkMember(host, emitting: false)
            }
            if shown == host.id { shown = nil }
            host.phase = .parked
            saveMarker()
            let result = fail(host.id, .place, reason)
            if let previous, !retrying, previous.phase == .parked, shown == nil, hosts[previous.id] != nil {
                Diagnostics.note("host: \(previous.id) shown again after \(host.id)'s show failed")
                _ = await bringIn(previous, isNew: false, retrying: true)
            }
            return result
        }
        // (Shown once it's in place: its app in front after, not counted in the switch, which the person sees done by then.)
        let total = ms(since: started)
        emit(.shown(host.id, ms: total))
        t0 = sys.now()
        let fronted = await front(host)
        // (Shown again from parked: a switch, said as one.)
        Diagnostics.note("host: \(host.id) \(isNew ? "shown in window mode" : "switched in") \(total) ms (\(isNew ? "" : "window mode: ")\(times.joined(separator: ", "))\(frozen ? "; under the freeze" : ""))\(placed ? "" : "; NOT fitted to the page area")\(fronted ? "; its app in front \(ms(since: t0)) ms after" : "")")
        return .shown(host.id, placed: placed)
    }

    // The page area for a window-mode host (Margin's own layout's, its window its whole width).
    private var windowArea: CGRect { placement.page }

    private func centredIn(_ page: CGRect, _ size: CGSize) -> CGRect {
        CGRect(x: (page.minX + max(0, (page.width - size.width) / 2)).rounded(), y: (page.minY + max(0, (page.height - size.height) / 2)).rounded(), width: size.width, height: size.height)
    }
    // Whether a window-mode host's window is where `placeWindow` puts it: the page area, or its own size centred in it
    // (a fixed size, or a resizable one at its own limits).
    private func atPageArea(_ host: Host) -> Bool {
        guard let b = sys.bounds(window: host.window), b.width <= windowArea.width + options.tolerance, b.height <= windowArea.height + options.tolerance else { return false }
        return HostLayout.near(b, windowArea, within: options.tolerance) || HostLayout.near(b, centredIn(windowArea, b.size), within: options.tolerance)
    }


    // A window-mode host's window in the page area, through Accessibility (it's on the current Space, Margin's):
    // resizable, the page area (an app's own minimum or maximum size kept: the size it took, centred in what's left,
    // its top left in the page area when it's bigger); a fixed size, centred. Checked by the window server's bounds.
    // Its frame is recorded (and `frameChanged` saved) before anything is set.
    @discardableResult private func placeWindow(_ host: Host) async -> Bool {
        guard host.phase == .shown, host.mode == .window else { return false }
        let page = windowArea
        guard page.width >= 1, page.height >= 1 else {
            emit(.failed(host.id, .place, "no page area"))
            return false
        }
        guard let now = sys.bounds(window: host.window) else {
            emit(.failed(host.id, .place, "its window's bounds didn't read"))
            return false
        }
        func centred(_ size: CGSize) -> CGRect { centredIn(page, size) }
        var want = host.resizable ? page : centred(now.size)
        if HostLayout.near(now, want, within: options.tolerance) { return true }
        // (Placed by Margin before and still there: at its own limits, centred. A switch to it sets nothing.)
        if host.frameChanged, now.width <= page.width + options.tolerance, now.height <= page.height + options.tolerance,
           HostLayout.near(now, centred(now.size), within: options.tolerance) { return true }
        if host.original == nil { host.original = now }
        host.frameChanged = true
        saveMarker()
        var got = now
        var refresh = true
        for attempt in 1...2 {
            _ = await setFrame(host, want, size: host.resizable && attempt == 1, refresh: &refresh)
            got = await settled(host, at: want, from: got)
            if HostLayout.near(got, want, within: options.tolerance) { return true }
            // Its own size limits (or a position it adjusted): the size it took, centred, set once more (position only).
            want = centred(got.size)
            if HostLayout.near(got, want, within: options.tolerance) { return true }
        }
        func r(_ c: CGRect) -> String { "\(Int(c.minX)),\(Int(c.minY)) \(Int(c.width))×\(Int(c.height))" }
        Diagnostics.note("host: place \(host.id) (window mode): wanted \(r(want)) in \(r(page)), it's at \(r(got))")
        emit(.failed(host.id, .place, "its window didn't take its place in the page area"))
        return false
    }

    // The window server's bounds of a window Accessibility was just asked to move or resize: as soon as they're `want`
    // within 1 pt, or once they've changed from `from` and held still for `placeSettle` (the size it took: an app's own
    // limits; seen 2026-11-15: FaceTime at its own maximum waited out a fixed 1.5 s before it was centred), at most
    // `windowPlaceWait` (no change at all).
    private func settled(_ host: Host, at want: CGRect, from: CGRect) async -> CGRect {
        var got = from, last = from
        var still = sys.now()
        _ = await wait(options.windowPlaceWait) {
            got = self.sys.bounds(window: host.window) ?? got
            if HostLayout.near(got, want, within: self.options.tolerance) { return true }
            if !HostLayout.near(got, last, within: 0.5) { last = got; still = self.sys.now() }
            return !HostLayout.near(got, from, within: 0.5) && self.sys.now() - still >= self.options.placeSettle
        }
        return got
    }

    // A window-mode host's frame given back as it was recorded, through Accessibility, which sees only the current
    // Space's windows: one that isn't on it (parked, or left elsewhere) is brought there first. Checked by the window
    // server, with no fixed wait: done once it's at its frame, or once it moved and held still elsewhere (the app's own
    // limits: asking again gets the same); Accessibility not taking it is asked again only `frameAskWait` (a window just
    // brought here is listed a moment late), then given up (kept in the marker). True: it's at its recorded frame (or
    // Margin never changed it).
    @discardableResult private func restoreFrame(_ host: Host) async -> Bool {
        guard host.frameChanged else { return true }
        guard let original = host.original else { host.frameChanged = false; return true }
        if let b = sys.bounds(window: host.window), HostLayout.near(b, original, within: options.tolerance) {
            host.frameChanged = false
            saveMarker()
            return true
        }
        let display = host.originalSpace ?? marginSpace
        if let current = sys.currentSpace(onDisplayOf: display), sys.spaces(window: host.window)?.contains(current) != true {
            host.away = true
            if sys.move(window: host.window, to: current) {
                _ = await wait(options.parkWait) { self.sys.spaces(window: host.window)?.contains(current) == true }
                if let priv = host.privateSpace { retirePrivate(priv); host.privateSpace = nil }
            }
        }
        let from = sys.bounds(window: host.window) ?? original
        var refresh = true
        let took = await wait(options.frameAskWait, every: options.lookEvery) { await self.setFrame(host, original, size: host.resizable, refresh: &refresh) }
        let got = took ? await settled(host, at: original, from: from) : from
        let ok = took && HostLayout.near(got, original, within: options.tolerance)
        host.axRefused = !took
        if ok { host.frameChanged = false } else {
            Diagnostics.warn("host: \(host.id): its frame wasn't given back (\(took ? "Accessibility took it, the window is at \(r(got))" : "Accessibility didn't take it")): kept in the marker")
        }
        saveMarker()
        return ok
    }

    // A window-mode host's frame set through Accessibility. Refused: Accessibility's error said and, once per placing or
    // give-back (`refresh`), its kept element dropped and found again by its number, then the frame set once more. (The
    // Phone, 2026-11-17: placed once, then from its first park on every set refused and the window never moved, while
    // the window server moved it between Spaces as asked: the element kept since it was found, gone stale.)
    private func setFrame(_ host: Host, _ frame: CGRect, size: Bool, refresh: inout Bool) async -> Bool {
        if await sys.setFrame(pid: host.pid, window: host.window, frame, size: size) { return true }
        guard refresh else { return false }
        refresh = false
        let code = sys.frameError(window: host.window)
        if code == Self.axCannotComplete {
            // (Its app busy, still launching: asked again a moment, as a full-screen ask is.)
            let t0 = sys.now()
            var tries = 1
            let ok = await wait(options.axSettleWait, every: options.axSettleEvery) {
                tries += 1
                return await self.sys.setFrame(pid: host.pid, window: host.window, frame, size: size)
            }
            Diagnostics.note("host: \(host.id): Accessibility refused its frame (error \(Self.axCannotComplete): its app busy): asked again for \(ms(since: t0)) ms, \(ok ? "taken at try \(tries)" : "refused \(tries) times")")
            if ok { return true }
        }
        let found = await sys.refreshWindow(pid: host.pid, window: host.window)
        let ok = found ? await sys.setFrame(pid: host.pid, window: host.window, frame, size: size) : false
        let again = ok ? "taken" : "refused again (error \(sys.frameError(window: host.window).map { "\($0)" } ?? "unknown"))"
        Diagnostics.note("host: \(host.id): Accessibility refused its frame (error \(code.map { "\($0)" } ?? "unknown")): its element \(found ? "found again by its number, the frame \(again)" : "not found again")")
        return ok
    }

    static let axCannotComplete: Int32 = -25200 // kAXErrorCannotComplete

    // Where a host's window goes back to: the Space it was in when it's still a Desktop, else its display's Desktop.
    private func home(_ original: UInt64?, display: UInt64?) -> UInt64? {
        if let o = original, sys.spaceExists(o) == true, sys.spaceType(o) == ManagedSpace.desktopType { return o }
        return sys.desktop(onDisplayOf: display ?? original ?? marginSpace) ?? sys.desktop(onDisplayOf: marginSpace)
    }

    // A window Margin took out of its Space (window mode, the person's own app) back in it, out of any private Space.
    private func returnHome(_ host: Host) async {
        guard host.away || host.privateSpace != nil else { return }
        if let dest = home(host.originalSpace, display: host.originalSpace ?? marginSpace), sys.spaces(window: host.window) != [dest] {
            if sys.move(window: host.window, to: dest) {
                _ = await wait(options.parkWait) { self.sys.spaces(window: host.window)?.contains(dest) == true }
            } else {
                Diagnostics.warn("host: \(host.id): its window didn't go back to its Space")
            }
        }
        if let priv = host.privateSpace { retirePrivate(priv); host.privateSpace = nil }
        host.away = false
        // (The person's window macOS took out of full screen: its frame as it was, if it's not and Accessibility sees it.)
        if host.personApp, host.mode == .fullScreen, let o = host.original, let b = sys.bounds(window: host.window), !HostLayout.near(b, o, within: options.tolerance) {
            _ = await sys.setFrame(pid: host.pid, window: host.window, o, size: host.resizable)
        }
        saveMarker()
    }

    // A window-mode host out of Margin's Space, into a private Space as it is (no full-screen exit: it's a window), at the
    // page area's frame: its frame is given back only when it's given back (its row closed, Margin's quit, a crash's
    // recovery: the marker has it), so a switch to it and away from it is a move each way, with no frame set and no
    // freeze (2026-11-17's real apps: 214-519 ms a switch, its frame given back and set again under the freeze).
    private func retireWindow(_ host: Host) async -> Bool {
        guard let priv = sys.createPrivateSpace() else { return false }
        guard sys.move(window: host.window, to: priv), await wait(options.parkWait, { self.sys.spaces(window: host.window) == [] }) else {
            retirePrivate(priv)
            // (Still shown in Margin's Space: in the page area again.)
            if sys.spaces(window: host.window) == [marginSpace] { await placeWindow(host) }
            return false
        }
        host.away = true
        host.privateSpace = priv
        host.phase = .parked
        if shown == host.id { shown = nil }
        saveMarker()
        emit(.parked(host.id))
        return true
    }


    // ---- showing ----

    private func bringIn(_ host: Host, isNew: Bool, retrying: Bool = false) async -> HostResult {
        jumps = 0
        // (A show: the reconciler's budgets anew.)
        host.tries = [:]
        host.offScreenReads = 0
        // (Its window went while it was parked, its app still running: a Dock-icon click first, the window it makes
        // adopted, behind the loader; nothing came: gone as a closed window.)
        if host.gone {
            say(loading: host.id)
            await reopen(host)
            say(loading: nil)
            if host.gone || hosts[host.id] !== host {
                if hosts[host.id] === host { windowGone(host) }
                return fail(host.id, .window, "its window went and its app made no other")
            }
            if host.phase == .shown { return .shown(host.id, placed: true) }
        }
        // A new app's window as it was (its frame, its Space) before anything moves it; then how it's shown.
        defer { say(cover: nil) } // (the window taken in to be read: shown by now, or given back)
        if isNew, case .app = host.target, !host.taken, let (failed, why) = await take(host) {
            guard host.taken else {
                // (Nothing of it was touched: forgotten, never backed out of a full screen that's the person's.)
                hosts[host.id] = nil
                if !hosts.values.contains(where: { $0.pid == host.pid }) { sys.stopWatchingOpens(pid: host.pid) }
                saveMarker()
                return fail(host.id, failed, why)
            }
            return await giveUp(host, isNew: isNew, failed, why, previous: nil)
        }
        if host.mode == .window, host.retryFullScreen, !isNew, !retrying, !preparing {
            // (Window mode only after its full screen failed: full screen tried again as it's shown, behind the loader.)
            host.retryFullScreen = false
            host.mode = .fullScreen
            saveMarker()
            Diagnostics.note("host: \(host.id): in window mode since its full screen failed (it can go full screen): full screen tried again as it's shown")
            return await placeFullScreen(host, isNew: false, retrying: false)
        }
        if host.mode == .window { return await bringInWindow(host, isNew: isNew, retrying: retrying) }
        // (Live resize: a tile placed for another page area sized first, out of sight (a switch never shows the old size:
        // the target ahead of any other tile's sizing); one whose rect doesn't take is placed again the old way.)
        if host.member, host.tile != nil, host.noTiles {
            // (Held below tiles since it was parked: out of its tile, placed again as a plain member, behind the loader.)
            host.placedPage = nil
        } else if host.member, host.tile != nil {
            // (Its rect read, not only the page area it was sized for: a parked tile laid out again meanwhile is left so.)
            let stale = !tileAtPage(host)
            if await sizeTile(host), stale { Diagnostics.note("host: \(host.id): its tile sized to the page area before it's shown") }
        }
        if host.member, let placed = host.placedPage, HostLayout.near(placed, placement.page, within: options.tolerance) {
            return await switchIn(host)
        }
        if host.member { Diagnostics.note("host: \(host.id): placed for another page area (\(host.placedPage.map(r) ?? "none")): placed again as it's shown") }
        return await placeFullScreen(host, isNew: isNew, retrying: retrying)
    }

    // A member shown again (the fast path, no full-screen exit or entry): into Margin's Space out of its private Space,
    // then the one shown before out of it (a member parked as it is; a window its frame given back first, under the
    // freeze), then its app in front. The new one comes in before the old one leaves: Margin's page area isn't seen
    // between the two.
    private func switchIn(_ host: Host) async -> HostResult {
        let started = sys.now()
        var times: [String] = []
        func step(_ name: String, _ t0: Double) { times.append("\(name) \(ms(since: t0))") }
        let previous = shown.flatMap { $0 == host.id ? nil : hosts[$0] } // (a window-mode one leaves as it is, at the page area's frame: no freeze)
        // (Live resize: the first switch after a tile came into or left Margin's Space can lay the first two tiles out again
        // as its window comes in or the one before leaves (the real Mac, 2026-11-17 23:52:23: the second tile's window at a
        // quarter's width for 21 ms, Margin's own window with it): that switch under the freeze, watched `tileSettleWatch`
        // after its moves, every rect set again if it was, then revealed.)
        let settling = (host.tile != nil || previous?.tile != nil) && !tilesSettled && tilesOK
        let frozen = settling ? holdFreeze() : false
        var t0 = sys.now()
        if sys.spaces(window: host.window) != [marginSpace] {
            guard sys.move(window: host.window, to: marginSpace),
                  await wait(options.memberWait, every: options.memberEvery, { self.sys.spaces(window: host.window) == [self.marginSpace] }) else {
                if let priv = host.privateSpace, sys.spaces(window: host.window) != [] { _ = sys.move(window: host.window, to: priv) } // (back out of sight)
                releaseFreeze(frozen)
                return fail(host.id, .unpark, "its window didn't come into Margin's Space")
            }
        }
        step("in", t0)
        if let previous {
            t0 = sys.now()
            guard await retire(previous) else {
                // (The one before stays shown: this one back out of sight, in the private Space it came from.)
                if let priv = host.privateSpace, sys.move(window: host.window, to: priv) {
                    _ = await wait(options.parkWait, every: options.memberEvery) { self.sys.spaces(window: host.window) == [] }
                } else { host.privateSpace = nil; _ = await parkMember(host, emitting: false) }
                releaseFreeze(frozen)
                return fail(host.id, .park, "the one shown before (\(previous.id)) couldn't leave Margin's Space")
            }
            step("park \(previous.id)", t0)
        }
        if settling {
            t0 = sys.now()
            let page = frame(host), area = placement.area
            var relaid = false
            _ = await wait(options.tileSettleWatch, every: options.tileEvery) {
                let marginOff = self.sys.bounds(window: self.marginWindow).map { $0.width < area.width - 1 } ?? false
                let hostOff = host.tile != nil && (self.sys.bounds(window: host.window).map { !HostLayout.near($0, page, within: self.options.tolerance) } ?? false)
                if marginOff || hostOff { relaid = true; return true }
                return false
            }
            if relaid { await reapplyTiles(first: host.tile != nil ? host : nil) }
            tilesSettled = true
            releaseFreeze(frozen)
            step(relaid ? "its tiles laid out again: every rect set again, under the freeze" : "the tiles watched, under the freeze", t0)
        }
        if let priv = host.privateSpace {
            retirePrivate(priv)
            host.privateSpace = nil
        }
        host.phase = .shown
        shown = host.id // (Margin's window in front of it from now: hostedWindow)
        saveMarker()
        // (Switched once it's in and the one before is out: its app in front after, not counted in the switch (2026-11-17,
        // Messages: front 79 of 142 ms, Accessibility's raise answered late by the app).)
        let total = ms(since: started)
        emit(.shown(host.id, ms: total))
        t0 = sys.now()
        let fronted = await front(host)
        Diagnostics.note("host: \(host.id) switched in \(total) ms (\(times.joined(separator: ", ")))\(fronted ? "; its app in front \(ms(since: t0)) ms after" : "")")
        return .shown(host.id, placed: true)
    }

    // A full-screen host's slow path: its first open, or a member placed for another page area (out of full screen
    // first). Margin's page area shows the loading animation meanwhile; the freeze holds only from the full-screen ask
    // until macOS's jump to the new Space is undone (and, for an app's member placed again, its exit before it, which is
    // seen on the current Space).
    private func placeFullScreen(_ host: Host, isNew: Bool, retrying: Bool) async -> HostResult {
        let started = sys.now()
        var times: [String] = []
        func step(_ name: String, _ t0: Double) { times.append("\(name) \(ms(since: t0))") }
        let prepared = preparing && !host.member
        if prepared {
            say(cover: host.window) // (Margin's window above it while it's in Margin's Space: never seen)
        } else {
            say(loading: host.id)
        }
        defer { if !prepared { say(loading: nil) } }
        let again = host.member
        let previous = shown.flatMap { $0 == host.id ? nil : hosts[$0] }
        // 1. the one shown before out (parked), so the loading animation is what's seen.
        var t0 = sys.now()
        if let previous {
            let parked = await retire(previous)
            guard parked else { return await giveUp(host, isNew: isNew, .park, "the one shown before (\(previous.id)) couldn't leave Margin's Space", previous: nil) }
            step("park \(previous.id)", t0)
        }
        // 2. a member placed again: out of full screen first. Safari's through its copy wherever it is: parked first, its
        // exit isn't seen. An app's on the current Space (Accessibility acts only there): seen, so under the freeze, which
        // holds on through its full screen below.
        var frozen = false
        if again {
            t0 = sys.now()
            if viaCopy(host) {
                if host.phase == .shown { _ = await parkMember(host, emitting: false) }
            } else {
                frozen = holdFreeze()
            }
            guard await leaveMember(host) else {
                releaseFreeze(frozen)
                // (Still the full-screen member it was: never torn down for a placing that didn't start.)
                return await keepAsPlaced(host, "it didn't leave full screen to be placed again")
            }
            if shown == host.id { shown = nil }
            host.phase = .preparing
            step("out of full screen", t0)
        }
        // A window parked out of full screen (Safari's placed again, one shown again after a failure): on its display's
        // Desktop (not showing), to go full screen from there.
        if host.privateSpace != nil, sys.spaces(window: host.window) == [] {
            t0 = sys.now()
            guard await unpark(host) else {
                releaseFreeze(frozen)
                return await giveUp(host, isNew: isNew, .unpark, "its window didn't come out of its private Space", previous: previous)
            }
            step("unpark", t0)
        }
        // 3. full screen, under the freeze (held on from a seen exit above). The early path first: its new Space reserved
        // to the page area as soon as it's listed, its window moved into Margin's Space and that Space destroyed once
        // macOS has brought the window into it and switched to it (undone: Margin's Space kept current). Else the slow
        // path: in a Space of its own, macOS's jump there undone, then steps 5-7.
        t0 = sys.now()
        jumps = 0
        let entry = await enterFullScreen(host, frozen: &frozen)
        releaseFreeze(frozen)
        let early: Bool
        switch entry {
        case .failed(let reason):
            return await fallBack(host, isNew: isNew, retrying: retrying, .fullScreen, reason, previous: previous)
        case .own:
            early = false
            step("full screen\(jumps > 0 ? " (\(jumps) jump\(jumps == 1 ? "" : "s") undone\(frozen ? " under the freeze" : ", the freeze not taken"))" : "")", t0)
        case .member(let how):
            early = true
            step("full screen, at the page area and in Margin's Space early (\(how)\(frozen ? "; under the freeze" : "; the freeze not taken"))", t0)
        }

        // 4. Safari's own sidebar hidden, in a window Margin may touch (early: read in Margin's Space, the current one).
        let sidebarOurs = isSafari(host) && (host.launchedByMargin || host.madeByMargin)
        var sidebar = HostSidebar.closed
        var mainOurs = false
        if sidebarOurs {
            t0 = sys.now()
            (sidebar, mainOurs) = await settleSidebar(host)
            step("sidebar", t0)
        }

        if !early {
            // 5. its own Space's edges reserved: its window the page area.
            t0 = sys.now()
            var placed = await reserve(host)
            if !placed, sidebarOurs, mainOurs, sidebar == .unknown {
                // Its sidebar's state didn't read (another language, its closed title not learned yet): pressed once, and
                // back if the window still doesn't fit.
                if await withOwnSpaceCurrent(host, { await self.sys.pressSafariSidebar(pid: host.pid) }) == true {
                    placed = await reserve(host)
                    if !placed { _ = await withOwnSpaceCurrent(host, { await self.sys.pressSafariSidebar(pid: host.pid) }) }
                    Diagnostics.note("host: \(host.id): its window didn't fit with its sidebar unread: pressed once, \(placed ? "it fits" : "pressed back")")
                }
            }
            step("place", t0)
            guard placed else {
                // (A member that doesn't fit would cover Margin's sidebar: never shown so.)
                return await fallBack(host, isNew: isNew, retrying: retrying, .place, "its window didn't take the page area's size in its own Space", previous: previous)
            }

            // 6. into Margin's Space, a plain member (still full screen, at its frame); live resize: its tile, under the
            // freeze (Margin's own window is laid out as a split's half while the tile comes in), its rect the page area.
            t0 = sys.now()
            var tiled = false
            if let own = host.fullScreenSpace, await tilesReady(for: host) {
                if sys.currentSpace(onDisplayOf: marginSpace) != marginSpace {
                    _ = sys.setCurrentSpace(marginSpace)
                    _ = await wait(0.5) { self.sys.currentSpace(onDisplayOf: self.marginSpace) == self.marginSpace }
                }
                let frozen = holdFreeze()
                let result = await tileIn(host, from: own)
                releaseFreeze(frozen)
                switch result {
                case .placed: tiled = true
                case .notMoved(let why): turnOffTiles("a tile didn't move into Margin's Space (\(why))")
                case .notSized(let why):
                    turnOffTiles("a tile's rect didn't take (\(why))")
                    return await fallBack(host, isNew: isNew, retrying: retrying, .place, "its tile's rect didn't take in Margin's Space", previous: previous)
                }
            }
            var entered = tiled
            if !tiled { entered = await enterMargin(host) }
            guard entered else {
                return await giveUp(host, isNew: isNew, .member, "its window didn't come into Margin's Space", previous: previous)
            }
            step(tiled ? "its tile into Margin's Space" : "into Margin's Space", t0)

            // 7. its own Space, emptied of its window, destroyed: Mission Control lists Margin's Space only.
            if let own = host.fullScreenSpace {
                t0 = sys.now()
                host.fullScreenSpace = nil
                if await destroyOwn(own) { step("destroy", t0) } else {
                    leftSpaces.insert(own)
                    emit(.failed(host.id, .destroy, "its own Space \(own) didn't go: tried again later"))
                }
                // (In Margin's Space for good only once it has stayed there after that destroy: put back if it's in none.)
                t0 = sys.now()
                guard await settleMember(host).0 else {
                    return await giveUp(host, isNew: isNew, .member, "its window didn't stay in Margin's Space once its own Space was destroyed", previous: previous)
                }
                step("settled", t0)
            }
        }
        host.member = true
        host.placedPage = placement.page
        if prepared {
            // 8. made ready out of sight: parked at once, its app not activated.
            t0 = sys.now()
            cover?(host.window) // (Margin's window in front of it now it's in Margin's Space: the ordering way orders it there)
            guard await parkMember(host) else {
                return await giveUp(host, isNew: isNew, .park, "prepared, but its window couldn't leave Margin's Space", previous: nil)
            }
            step("parked", t0)
            let total = ms(since: started)
            Diagnostics.note("host: \(host.id) prepared out of sight in \(total) ms (\(times.joined(separator: ", ")))")
            return .shown(host.id, placed: true)
        }
        host.phase = .shown
        shown = host.id // (Margin's window in front of it from now: hostedWindow)
        saveMarker()

        // 8. its app in front (after it's shown: not counted in its time).
        let total = ms(since: started)
        emit(.shown(host.id, ms: total))
        t0 = sys.now()
        let fronted = await front(host)
        Diagnostics.note("host: \(host.id) \(again ? "placed again" : "shown") in \(total) ms (\(times.joined(separator: ", ")))\(fronted ? "; its app in front \(ms(since: t0)) ms after" : "")")
        return .shown(host.id, placed: true)
    }

    // A member whose placing again didn't start (its exit from full screen wasn't confirmed by the window server): kept
    // hosted as it is, at the frame it had. Back into Margin's Space (Safari's was parked for its exit), shown, its app
    // in front, `placedPage` unchanged: Margin's window draws its hole at the window's own bounds (the theme's frame
    // colour in any gap, the sidebar over what it covers), and the next show or change of the page area tries again.
    // The item is never closed for it (2026-11-17: a failed second placing lost the Safari window).
    private func keepAsPlaced(_ host: Host, _ reason: String) async -> HostResult {
        emit(.failed(host.id, .exitFullScreen, reason))
        Diagnostics.note("host: \(host.id): \(reason): kept as it was (\(host.placedPage.map(r) ?? "its frame"); the page area is \(r(placement.page)))")
        if sys.spaces(window: host.window) != [marginSpace] {
            guard sys.move(window: host.window, to: marginSpace),
                  await wait(options.memberWait, every: options.memberEvery, { self.sys.spaces(window: host.window) == [self.marginSpace] }) else {
                await park(host)
                return .failed(.unpark, "its window didn't come back into Margin's Space after \(reason)")
            }
        }
        if let priv = host.privateSpace {
            retirePrivate(priv)
            host.privateSpace = nil
        }
        host.phase = .shown
        shown = host.id
        saveMarker()
        _ = await front(host)
        return .shown(host.id, placed: false)
    }

    // Full screen failed, or its window didn't take the page area's size that way: an app's window backed out of
    // whatever it reached and shown in window mode (many AppKit apps refuse full screen with no Dock icon); Safari's
    // fails (its window is Margin's own).
    private func fallBack(_ host: Host, isNew: Bool, retrying: Bool, _ step: HostStep, _ reason: String, previous: Host?) async -> HostResult {
        // (Being prepared out of sight: never shown as a window instead.)
        guard case .app = host.target, !preparing else { return await giveUp(host, isNew: isNew, step, reason, previous: previous) }
        // (It can go full screen: tried again at its next show, once; window mode for the rest of the session after that.)
        host.fullScreenFailures += 1
        host.retryFullScreen = host.fullScreenFailures == 1
        Diagnostics.note("host: \(host.id): \(step.rawValue) failed (\(reason)): backed out, shown in window mode (it can go full screen: \(host.retryFullScreen ? "tried again the next time it's shown" : "failed again, window mode from now on"))")
        let frozen = holdFreeze()
        await backOut(host)
        await outForGood(host)
        releaseFreeze(frozen)
        host.mode = .window
        saveMarker()
        return await bringInWindow(host, isNew: isNew, retrying: retrying)
    }

    // A full-screen attempt backed out, before its window is shown as a window: nothing of full screen left (2026-11-17,
    // Mail: its ask taken late, after Margin had given up on it; backed out, it was still in full screen, its frame
    // refused (kAXErrorCannotComplete), and its toolbar strip, a window of its own across the display's top, was let in
    // front of Margin's window). Its AXFullScreen still on (or still in a full-screen Space of its own): taken out of
    // full screen again on the current Space, as a member is. Then the strips its app made since the ask (`isStrip`, new
    // since `windowsBeforeAsk`, in a user Space) waited for to go, `memberWait`; still there: asked out once more, said.
    private func outForGood(_ host: Host) async {
        let ownFull = (sys.spaces(window: host.window) ?? []).contains { $0 != marginSpace && sys.spaceType($0) == ManagedSpace.fullScreenType }
        if await sys.isFullScreen(pid: host.pid, window: host.window) == true || ownFull {
            Diagnostics.note("host: \(host.id): still in full screen after it was backed out (an ask taken late): taken out of it again")
            _ = await leaveMember(host)
            // (A full-screen Space its app was given for that late ask, emptied: destroyed.)
            if let ask = lateAsk, let owners = sys.fullScreenSpaceOwners() {
                for (space, owner) in owners where owner == host.pid && space != marginSpace && !ask.before.contains(space) && sys.spaceExists(space) == true {
                    ownSpaces.insert(space)
                    if await !destroyOwn(space) { leftSpaces.insert(space) }
                }
            }
        }
        func strips() -> [ServerWindow] {
            (serverList(pid: host.pid) ?? []).filter { w in
                w.number != host.window && !host.windowsBeforeAsk.contains(w.number) && !isHosted(window: w.number) && w.layer == 0 && isStrip(w.bounds)
                    && !(sys.spaces(window: w.number) ?? []).isEmpty
            }
        }
        guard !strips().isEmpty else { return }
        if await wait(options.memberWait, every: options.memberEvery, { strips().isEmpty }) { return }
        _ = await sys.setFullScreen(pid: host.pid, window: host.window, false)
        let gone = await wait(options.memberWait, every: options.memberEvery) { strips().isEmpty }
        Diagnostics.note("host: \(host.id): its full screen's toolbar strip (\(strips().map { "\($0.number) at \(r($0.bounds))" }.joined(separator: ", "))) stayed after it was backed out: asked out of full screen once more, \(gone ? "gone" : "still there (never let in front of Margin's window)")")
    }

    // A full-screen window's toolbar strip: as wide as the page area at least (the display's whole width for one that
    // went full screen on its own), at most `stripMaxHeight` tall.
    private func isStrip(_ b: CGRect) -> Bool {
        b.height > 0 && b.height <= options.stripMaxHeight && b.width >= min(placement.area.width * 0.9, placement.page.width - 2) && b.width > 0
    }

    // Margin's sidebar: the display's area left of the page area (none narrower than 40 pt: the sidebar hidden).
    private var sidebarRect: CGRect? {
        let width = placement.page.minX - placement.area.minX
        guard width >= 40, placement.area.height > 0 else { return nil }
        return CGRect(x: placement.area.minX, y: placement.area.minY, width: width, height: placement.area.height)
    }

    // A window the observed model says is never let in front of Margin's window: a leftover, a strip, a transient one
    // (a spare, a twin, a replaced window).
    private func keptBehind(_ w: ServerWindow) -> Bool {
        guard let k = observer.model.apps[w.pid]?.windows[w.number]?.kind else { return false }
        return k.keptBehind
    }

    // Whether a window at `b` reaches over Margin's sidebar at all (more than `sidebarSliver` each way): never let in
    // front of Margin's window (docs/HOSTING-CORE.md, principle 3: an auxiliary window in front only if it doesn't cover
    // the sidebar; the real-screen suite's extraWindow, 2026-11-17: a 900×560 window 60 pt over it was let in front).
    private func overSidebar(_ b: CGRect) -> Bool {
        guard let side = sidebarRect else { return false }
        let i = b.intersection(side)
        return !i.isNull && i.width > options.sidebarSliver && i.height > options.sidebarSliver
    }

    // Whether a window at `b` covers at least `sidebarCover` of Margin's sidebar.
    private func coversSidebar(_ b: CGRect) -> Bool {
        guard let side = sidebarRect else { return false }
        let i = b.intersection(side)
        guard !i.isNull, i.width > 0, i.height > 0 else { return false }
        return i.width * i.height >= side.width * side.height * options.sidebarCover
    }

    // Safari's sidebar read from its View menu and hidden if open, in its hosted window when that's Safari's main one.
    // Accessibility reads Safari's main window only on the current Space: unread where it is (its own Space, Margin's
    // current), it's read with its own Space current for a moment, under the freeze. (state, the window is Safari's main one)
    private func settleSidebar(_ host: Host) async -> (HostSidebar, Bool) {
        func here() async -> (HostSidebar, Bool)? {
            guard let main = await sys.mainWindow(pid: host.pid) else { return nil }
            guard main == host.window else { return (.unknown, false) }
            return (await hideSidebar(host), true)
        }
        if let read = await here() {
            if !read.1 { Diagnostics.note("host: \(host.id): its window isn't Safari's main window: its sidebar is left as it is") }
            return read
        }
        Diagnostics.note("host: \(host.id): Safari's main window doesn't read (Accessibility lists only the current Space's windows): read with its own Space current a moment")
        if let read = await withOwnSpaceCurrent(host, here), let read {
            if !read.1 { Diagnostics.note("host: \(host.id): its window isn't Safari's main window: its sidebar is left as it is") }
            return read
        }
        Diagnostics.note("host: \(host.id): Safari's main window still doesn't read: it can't be known to be the hosted one, its sidebar is left as it is")
        return (.unknown, false)
    }

    // `body` run with the host's own full-screen Space current for a moment (Accessibility reads only the current
    // Space's windows), under the freeze, then Margin's Space current again. Nil: its Space couldn't be made current.
    private func withOwnSpaceCurrent<T>(_ host: Host, _ body: () async -> T) async -> T? {
        guard let own = host.fullScreenSpace else { return nil }
        let frozen = holdFreeze()
        defer { releaseFreeze(frozen) }
        var value: T?
        if sys.setCurrentSpace(own), await wait(0.5, { self.sys.currentSpace(onDisplayOf: self.marginSpace) == own }) {
            value = await body()
        }
        if sys.currentSpace(onDisplayOf: marginSpace) != marginSpace {
            _ = sys.setCurrentSpace(marginSpace)
            _ = await wait(0.5) { self.sys.currentSpace(onDisplayOf: self.marginSpace) == self.marginSpace }
        }
        return value
    }

    // Safari's sidebar read from its View menu and hidden if open (the hosted window is Safari's main one).
    private func hideSidebar(_ host: Host) async -> HostSidebar {
        let sidebar = await sys.safariSidebar(pid: host.pid)
        guard sidebar == .open else { return sidebar }
        let pressed = await sys.pressSafariSidebar(pid: host.pid)
        Diagnostics.note("host: \(host.id): Safari's sidebar \(pressed ? "hidden by its View menu" : "open, and its menu item didn't press")")
        return pressed ? .closed : .open
    }

    // A Safari window a copy made: full screen and back through that copy (`setWindowState`), read by the window
    // server. Accessibility sees only the current Space's windows, and this one is on another (a Desktop, its own
    // full-screen Space, a private Space). Apps' windows: Accessibility, as before.
    private func viaCopy(_ host: Host) -> Bool { host.safariWindow != nil && safariFullScreen != nil }

    private func setFullScreen(_ host: Host, _ on: Bool) async -> Bool {
        if let ext = host.safariWindow, let ask = safariFullScreen { return await ask(host.profile, ext, on) }
        return await sys.setFullScreen(pid: host.pid, window: host.window, on)
    }

    // Whether its window is in full screen. Through the copy: in a full-screen Space by the window server (nil: in no
    // user Space, a private one, so it doesn't read); else Accessibility's AXFullScreen.
    private func isFullScreen(_ host: Host) async -> Bool? {
        guard viaCopy(host) else { return await sys.isFullScreen(pid: host.pid, window: host.window) }
        guard let list = sys.spaces(window: host.window), !list.isEmpty else { return nil }
        return list.contains { sys.spaceType($0) == ManagedSpace.fullScreenType }
    }

    // How a window went into full screen: in a Space of its own (the slow path: steps 5-7 to come), already a member of
    // Margin's Space at the page area (the early path), or not at all.
    private enum Entry { case own, member(String), failed(String) }

    // Full screen asked (Accessibility's AXFullScreen; a Safari window Margin's copy made: its copy's setWindowState),
    // the early path tried first; failing it, the slow path. Both under the freeze, from the ask on (`frozen`: taken
    // here if it isn't held yet, released by the caller as this returns, whatever it returns; the freezer's own
    // watchdog reveals 1.7 s after it was taken, whatever happens): macOS switches to the window's new Space on its
    // way, which showed as a flash of that Space on a first open (2026-11-17: `1 Space change undone … no freeze`).
    // What's frozen is Margin's window with its loader.
    private func enterFullScreen(_ host: Host, frozen: inout Bool) async -> Entry {
        func ownSpace() -> UInt64? {
            guard let list = sys.spaces(window: host.window) else { return nil }
            return list.first { $0 != marginSpace && sys.spaceType($0) == ManagedSpace.fullScreenType }
        }
        let copy = viaCopy(host)
        // Through the copy, its answer comes once Safari says the window is in full screen (up to 3 s): asked beside
        // the wait, so macOS's jump to the new Space is undone as soon as the window server shows the Space.
        final class Ask { var answer: Bool? }
        var ask: Ask?
        func askCopy() {
            let a = Ask()
            ask = a
            Task { a.answer = await self.setFullScreen(host, true) }
        }
        // Already in full screen in a Space of its own by the window server (a window that came up so: `take`): nothing
        // to ask, and Accessibility may not read it there (that Space isn't current): the window server's word is enough.
        // In a full-screen Space that isn't its app's (another app's: it opened while that one was current), or one it
        // isn't full screen in: onto its display's Desktop first, where macOS takes the ask.
        var had: UInt64?
        if !frozen { frozen = holdFreeze() }
        if !copy, let s = ownSpace() {
            let its = sys.fullScreenSpaceOwners().map { [host.pid, 0].contains($0[s] ?? host.pid) } ?? true
            if its, await sys.isFullScreen(pid: host.pid, window: host.window) != false {
                had = s
            } else if let desk = sys.desktop(onDisplayOf: marginSpace), sys.move(window: host.window, to: desk) {
                let there = await wait(options.parkWait, every: options.memberEvery) { self.sys.spaces(window: host.window) == [desk] }
                host.away = true
                saveMarker()
                Diagnostics.note("host: \(host.id): its window was in a full-screen Space \(its ? "it isn't full screen in" : "of another app's") (\(s)): moved onto its Desktop first\(there ? "" : " (not seen there)"), then asked")
            }
        }
        // The full-screen Spaces listed before the ask: the early path watches for a new one (nil: not tried, as when
        // its window already has a Space of its own, or the list doesn't read).
        var before: Set<UInt64>?
        if options.earlyFullScreen, ownSpace() == nil, let owners = sys.fullScreenSpaceOwners() { before = Set(owners.keys) }
        let listed = before ?? Set(sys.listedFullScreenSpaces() ?? [])
        var axBefore: Bool? // its AXFullScreen right before the last ask (true after false: macOS took the ask)
        if copy {
            if ownSpace() == nil { askCopy() }
        } else if had != nil {
            before = nil // (its Space is the slow path's to read)
        } else {
            axBefore = await sys.isFullScreen(pid: host.pid, window: host.window)
            if axBefore == true {
                // Full screen by Accessibility with no full-screen Space of its own (a full-screen window moved into another
                // Space): an ask changes nothing and no Space of its own would ever come (2026-11-17: Maps, 6 s, then
                // window mode). Out of full screen where it is first (on the current Space, where Accessibility acts),
                // then asked as a window.
                Diagnostics.note("host: \(host.id): its window reads full screen with no full-screen Space of its own (in \(sys.spaces(window: host.window).map { "\($0)" } ?? "?")): out of full screen first, then asked")
                guard await leaveMember(host) else { return .failed("it read full screen with no full-screen Space of its own and didn't leave it") }
                axBefore = await sys.isFullScreen(pid: host.pid, window: host.window)
            }
            host.windowsBeforeAsk = Set((serverList(pid: host.pid) ?? []).map(\.number))
            guard await askFullScreenSettling(host, listed: listed, axBefore: axBefore) else { return .failed("AXFullScreen couldn't be set (refused for \(String(format: "%.1f", options.axSettleWait)) s)") }
        }
        var asked = sys.now()
        host.askedFullScreenAt = asked
        lateAsk = (asked, listed)
        if let before {
            let t = sys.now()
            switch await early(host, before: before, refused: { copy && ask?.answer == false }) {
            case .placed(let how):
                Diagnostics.note("host: \(host.id): full screen by the early path in \(ms(since: t)) ms (\(how)), \(frozen ? "under the freeze" : "the freeze not taken")")
                return .member(how)
            case .slow(let why):
                Diagnostics.note("host: \(host.id): the early full screen fell back after \(ms(since: t)) ms (\(why)): the slow path")
            case .again(let why):
                Diagnostics.note("host: \(host.id): the early full screen fell back after \(ms(since: t)) ms (\(why)): backed out and asked again, the slow path")
                await backOut(host)
                if copy {
                    askCopy()
                } else {
                    axBefore = await sys.isFullScreen(pid: host.pid, window: host.window)
                    if axBefore != true {
                        guard await askFullScreenSettling(host, listed: listed, axBefore: axBefore) else { return .failed("AXFullScreen couldn't be set again") }
                    }
                }
                asked = sys.now()
                host.askedFullScreenAt = asked
                lateAsk = (asked, listed)
            }
        }
        // An ask macOS took shows within ~40 ms (its new Space listed, owned by its app; or its AXFullScreen on, from
        // off): an app's window with neither `fullScreenRefusal` after the ask was refused, and waiting on can't change
        // that (2026-11-17: 6 s for Maps). Asked once more the proper way (`askAgainProperly`: on its Desktop, its app in
        // front); refused again as soon: failed now. Taken, it has up to `fullScreenWait` to come into its Space.
        func progressed() async -> Bool {
            if let owners = sys.fullScreenSpaceOwners() {
                if owners.contains(where: { !listed.contains($0.key) && $0.key != marginSpace && $0.value == host.pid }) { return true }
            } else if !Set(sys.listedFullScreenSpaces() ?? []).subtracting(listed).subtracting([marginSpace]).isEmpty {
                return true
            }
            guard axBefore == false else { return false }
            return await sys.isFullScreen(pid: host.pid, window: host.window) == true
        }
        var askedAgain = false
        var progress = false, retried = false, refused = false
        var desk: UInt64? // (the Desktop its window was on for the ask again)
        var space: UInt64?
        let came = await wait(options.fullScreenWait) {
            space = ownSpace()
            if let s = space {
                self.undoJump(to: s)
                if copy { return true }
                let full = await self.sys.isFullScreen(pid: host.pid, window: host.window)
                return full == true || (full == nil && had != nil)
            }
            if copy {
                if ask?.answer == false {
                    // The copy didn't ask Safari (not linked, busy): once more at once, then no more waiting.
                    if askedAgain { return true }
                    askedAgain = true
                    askCopy()
                    return false
                }
                if !askedAgain, self.sys.now() - asked >= self.options.fullScreenAskAgain {
                    askedAgain = true
                    if !self.preparing, !self.quitting { _ = await self.sys.activate(pid: host.pid, window: host.window) }
                    if ask?.answer != nil { askCopy() }
                }
                return false
            }
            if !progress { progress = await progressed() }
            if !progress, self.sys.now() - asked >= self.options.fullScreenRefusal {
                if retried { refused = true; return true }
                retried = true
                (desk, axBefore) = await self.askAgainProperly(host)
                asked = self.sys.now()
                host.askedFullScreenAt = asked
                self.lateAsk = (asked, listed)
            }
            return false
        }
        // (Its Desktop made current by its app's activation for the ask again, and still current: Margin's again, whether
        // the window was moved there for it or was there already, as one unparked onto it to be tried again.)
        if let d = desk, sys.currentSpace(onDisplayOf: marginSpace) == d, sys.setCurrentSpace(marginSpace) { jumps += 1 }
        guard came, !refused, let space else {
            if copy, ask?.answer == false { return .failed("its copy didn't ask Safari for full screen (setWindowState)") }
            if refused { return .failed("refused: no full-screen Space of its own within \(String(format: "%.1f", options.fullScreenRefusal)) s of the ask, nor of the ask again from its Desktop with its app in front") }
            return .failed("no full-screen Space of its own within \(Int(options.fullScreenWait)) s")
        }
        host.fullScreenSpace = space
        ownSpaces.insert(space)
        saveMarker()
        undoJump(to: space)
        return .own
    }

    // An app's full-screen ask through Accessibility. Refused (an app still launching answers kAXErrorCannotComplete for a
    // moment: Mail, 2026-11-17 14:06:04, "AXFullScreen couldn't be set" 0.6 s after its window came, then it went into
    // full screen all the same, with its toolbar strip, while Margin had backed out to window mode): asked again every
    // `axSettleEvery` for up to `axSettleWait`, done as soon as one is taken or the app shows it took an earlier one (a new
    // full-screen Space of its own listed, its AXFullScreen on after off). Said once. False: refused all that time.
    private func askFullScreenSettling(_ host: Host, listed: Set<UInt64>, axBefore: Bool?) async -> Bool {
        if await sys.setFullScreen(pid: host.pid, window: host.window, true) { return true }
        let t0 = sys.now()
        var tries = 1
        var how = ""
        let ok = await wait(options.axSettleWait, every: options.axSettleEvery) {
            if let owners = self.sys.fullScreenSpaceOwners(), owners.contains(where: { !listed.contains($0.key) && $0.key != self.marginSpace && $0.value == host.pid }) {
                how = "it went into full screen all the same (its new Space listed)"
                return true
            }
            if axBefore != true, await self.sys.isFullScreen(pid: host.pid, window: host.window) == true {
                how = "it went into full screen all the same (its AXFullScreen on)"
                return true
            }
            tries += 1
            if await self.sys.setFullScreen(pid: host.pid, window: host.window, true) { how = "taken at try \(tries)"; return true }
            return false
        }
        Diagnostics.note("host: \(host.id): Accessibility didn't take its full screen at first (its app may still be launching): \(ok ? how : "refused \(tries) times") in \(ms(since: t0)) ms")
        return ok
    }

    // A full-screen ask macOS refused (neither a full-screen Space of its own nor its AXFullScreen came), asked once
    // more the way a person's would be: its window on its display's Desktop if it's in a full-screen Space (Margin's,
    // or another's), its app in front (not while it's made ready out of sight, nor as Margin quits), then the ask.
    // Under a freeze taken anew (the freezer reveals 1.7 s after it was taken: till now it held Margin's loader, all
    // there is to see). (The Desktop it's on for the ask, moved there or there already; its AXFullScreen read before the
    // ask.)
    private func askAgainProperly(_ host: Host) async -> (UInt64?, Bool?) {
        if freezeHolds > 0 { sys.reveal(); _ = sys.freeze() }
        let t0 = sys.now()
        var moved: UInt64?
        let spaces = sys.spaces(window: host.window) ?? []
        let from = spaces == [marginSpace] ? "Margin's Space" : "a full-screen Space"
        if spaces.contains(where: { sys.spaceType($0) == ManagedSpace.fullScreenType }), let desk = sys.desktop(onDisplayOf: marginSpace), sys.move(window: host.window, to: desk),
           await wait(options.parkWait, every: options.memberEvery, { self.sys.spaces(window: host.window) == [desk] }) {
            moved = desk
            host.away = true
            saveMarker()
        }
        var activated = false
        if !preparing, !quitting { activated = await sys.activate(pid: host.pid, window: host.window) }
        let axNow = await sys.isFullScreen(pid: host.pid, window: host.window)
        let taken = await sys.setFullScreen(pid: host.pid, window: host.window, true)
        Diagnostics.note("host: \(host.id): its full screen refused (no full-screen Space of its own within \(String(format: "%.1f", options.fullScreenRefusal)) s of the ask): \(moved != nil ? "moved out of \(from) onto its Desktop first, " : "")\(activated ? "its app in front, " : "")asked again\(taken ? "" : " (Accessibility didn't take it)") in \(ms(since: t0)) ms")
        let on = moved ?? sys.spaces(window: host.window)?.first { sys.spaceType($0) == ManagedSpace.desktopType }
        return (on, axNow)
    }

    private enum Early { case placed(String), slow(String), again(String) }

    // The early full screen. Measured on the real Mac (2026-11-16, /tmp/margin-toolbar-test/fsopen/early2.swift): a
    // window asked into full screen has its new Space listed, owned by its app, at ~40 ms; that Space's edges reserved
    // at once make macOS lay the window out at the page area itself (at ~35 ms in some runs, only after the window is in
    // its Space, ~585 ms, in others). The window server says the window is in its Space at ~525 ms, and macOS switches
    // to that Space at ~600 ms.
    // The window is moved into Margin's Space only after both (2026-11-17, check10e/f on the real Mac: every placing
    // that moved it as soon as it had the page frame, at ~90 ms, ended with the window in no Space and neither window
    // on screen about a second later, 4 of 4; every one that moved it after "in its Space" held, 10 of 10: macOS
    // finishes its own change afterwards whatever the bridge did meanwhile, into a Space that's gone by then). So:
    // 1. its new Space listed, reserved at once (preparation only); 2. the window at the page area AND in its own Space
    // by the window server AND macOS's switch to that Space seen and undone (or `earlySwitchWait` with none): macOS's
    // change is over; 3. moved in, held, its Space destroyed, settled (`settleMember`). Margin's Space is kept current
    // all along, under the freeze the caller holds (macOS's switch would be seen). `.slow`: nothing undone, the ask
    // still running (the slow path takes it from there, its Space as the one found); `.again`: the window isn't where it
    // should be after the move and destroy (backed out and asked again by the caller).
    private func early(_ host: Host, before: Set<UInt64>, refused: () -> Bool) async -> Early {
        guard var edges = HostLayout.plan(fitted(host)) else { return .slow("no plan for the page area (\(placement.text))") }
        // (Live resize: its tile moved into Margin's Space in place of the window alone, below.)
        let tiling = await tilesReady(for: host)
        let t0 = sys.now()
        var page = frame(host)
        var space: UInt64?
        var reservedAt = t0
        var memberAt: Double? // when the window server first had the window in its own Space: macOS's change brought it there
        var switched = false // macOS made a Space current that wasn't listed before the ask (undone): the last step of its change
        var sized = false
        var times: [String] = []
        func mark(_ what: String) { times.append("\(what) \(ms(since: t0))") }
        func said() -> String { times.joined(separator: ", ") + (jumps > 0 ? "; \(jumps) Space change\(jumps == 1 ? "" : "s") undone" : "") }
        func there() -> Bool { sys.bounds(window: host.window).map { HostLayout.near($0, page, within: options.tolerance) } ?? false }
        func inOwn(_ s: UInt64) -> Bool { sys.spaces(window: host.window)?.contains(s) == true }
        // Margin's Space kept current: a Space made current that wasn't listed before the ask (macOS's switch to the new
        // one) is undone at once. A Space the person went to meanwhile (a full-screen one listed before, any Desktop) is
        // left alone, and is the one gone back to when macOS's switch takes them from it.
        var home = marginSpace
        func keepCurrent() {
            guard let now = sys.currentSpace(onDisplayOf: marginSpace) else { return }
            if now == marginSpace || before.contains(now) || sys.spaceType(now) == ManagedSpace.desktopType { home = now; return }
            if !switched { switched = true; mark("macOS's switch undone") }
            if sys.setCurrentSpace(home) { jumps += 1 }
        }
        // 1. its new Space listed (owned by its app, or holding its window), its edges reserved to the page area at once;
        // 2. its window at the page area, in its own Space, and macOS's switch to that Space seen (or waited for).
        while true {
            if refused() { return .slow("its copy didn't ask Safari for full screen") }
            if let s = space, memberAt == nil, inOwn(s) { memberAt = sys.now(); mark("in its Space") }
            if space == nil, let owners = sys.fullScreenSpaceOwners() {
                let new = owners.keys.filter { s in !before.contains(s) && s != marginSpace && (owners[s] == host.pid || inOwn(s)) }.sorted()
                if new.count > 1 { return .slow("\(new.count) new full-screen Spaces of its app: which is its window's isn't known") }
                if let s = new.first {
                    mark("listed")
                    space = s
                    host.fullScreenSpace = s
                    ownSpaces.insert(s)
                    saveMarker()
                    if inOwn(s) { memberAt = sys.now(); mark("in its Space") }
                    // (Its window's own minimum, from its new Space's tile: reserved for no less, never a size it can't take.)
                    if let t = ownTile(host, in: s), learnMinimum(host, tile: t), let e = HostLayout.plan(fitted(host)) { edges = e; page = frame(host); mark("its minimum \(Int(host.minSize?.width ?? 0)) wide") }
                    _ = sys.reserve(edges, space: s)
                    reservedAt = sys.now()
                    mark("reserved \(edges.text)")
                }
            }
            keepCurrent()
            let here = space != nil && there()
            if here, !sized { sized = true; mark("page-sized") }
            // (Never moved before macOS has brought it into its own Space: page-sized earlier is preparation only.)
            if here, let at = memberAt, switched || sys.now() - at >= options.earlySwitchWait { break }
            if space == nil, sys.now() - t0 >= options.earlyWait {
                return .slow("no new full-screen Space listed within \(ms(since: t0)) ms")
            }
            if space != nil, memberAt == nil, sys.now() - reservedAt >= options.earlyMemberWait {
                return .slow("macOS didn't bring its window into its own Space within \(ms(since: reservedAt)) ms of the reservation (\(said()))")
            }
            if space != nil, !here, sys.now() - reservedAt >= options.earlyFrameWait {
                let b = sys.bounds(window: host.window).map(r) ?? "?"
                return .slow("its window didn't take the page area \(r(page)) within \(ms(since: reservedAt)) ms of the reservation, at \(b) (\(said()))")
            }
            await sys.sleep(options.earlyEvery)
        }
        guard let own = space else { return .slow("no Space") }
        if !switched { mark("no switch by macOS") }
        // 3. into Margin's Space, then its own Space destroyed (Margin's current), then checked: in Margin's Space only, at
        // the page area, its Space no longer listed, still full screen. Live resize: its tile moved in (its window with
        // it), every rect set again, under the freeze held; a tile that didn't move: the window alone, as a member.
        keepCurrent()
        var tiled = false
        if tiling {
            switch await tileIn(host, from: own, each: keepCurrent) {
            case .placed:
                tiled = true
                mark("its tile in Margin's Space at the page area")
            case .notMoved(let why):
                turnOffTiles("a tile didn't move into Margin's Space (\(why))")
            case .notSized(let why):
                turnOffTiles("a tile's rect didn't take (\(why))")
                return .again("its tile's rect didn't take in Margin's Space: \(why)")
            }
        }
        guard tiled || sys.move(window: host.window, to: marginSpace) else { return .slow("the bridge didn't take its move into Margin's Space") }
        // Its own Space destroyed only once the move shows and has held `destroyAfterMove` (asked in the same instant,
        // the destroy took the window with it: in no Space at all, seen on the real Mac 2026-11-17, check10); then in
        // place only once it has stayed in Margin's Space for `memberSettle`, put back if it's found in none.
        // Seen there and out of it again before the destroy (macOS finishing its own full-screen change puts the window
        // back in its Space), or in none: moved in again, `memberReadds` times at most.
        var landed: Double? = tiled ? sys.now() - options.destroyAfterMove : nil
        var seen = tiled
        var again = 0
        let moved = await wait(options.memberWait, every: options.earlyEvery) {
            keepCurrent()
            let spaces = self.sys.spaces(window: host.window)
            if spaces == [self.marginSpace] {
                landed = landed ?? self.sys.now()
                seen = true
            } else {
                landed = nil
                if seen || spaces == [], again < self.options.memberReadds {
                    again += 1
                    seen = false
                    _ = self.sys.move(window: host.window, to: self.marginSpace)
                }
            }
            return landed.map { self.sys.now() - $0 >= self.options.destroyAfterMove } ?? false
        }
        mark((moved ? "moved in" : "its move into Margin's Space not seen") + (again > 0 ? " (moved in again \(again)×)" : ""))
        let destroyed = moved && sys.currentSpace(onDisplayOf: marginSpace) != own && sys.destroyFullScreenSpace(own)
        if destroyed { mark("its Space destroyed") }
        var inPlace = false, gone = false
        if moved {
            // (Its Space gone from the list first, the destroy really done; then the membership, read after it.)
            if destroyed { gone = await wait(options.memberWait, every: options.earlyEvery) { keepCurrent(); return self.sys.spaceExists(own) == false } }
            let (settled, readds) = await settleMember(host, at: there, each: keepCurrent)
            inPlace = settled
            if readds > 0 { mark("put back into Margin's Space \(readds)×") }
            if !gone { gone = sys.spaceExists(own) == false }
        }
        var full = false
        if inPlace { full = await isFullScreen(host) == true }
        if inPlace, full {
            host.fullScreenSpace = nil
            if gone {
                ownSpaces.remove(own)
            } else {
                leftSpaces.insert(own)
                emit(.failed(host.id, .destroy, "its own Space \(own) didn't go: tried again later"))
            }
            mark(gone ? "in place, its Space gone" : "in place, its Space still listed")
            return .placed(said())
        }
        let where_ = "\(sys.bounds(window: host.window).map(r) ?? "?") in \(sys.spaces(window: host.window).map { "\($0)" } ?? "?"), full screen \(inPlace ? "\(full)" : "unread")"
        if inOwn(own), sys.spaceExists(own) == true { return .slow("its window went into its own Space instead: \(where_) (\(said()))") }
        if gone { host.fullScreenSpace = nil; ownSpaces.remove(own) }
        let stillFull = await isFullScreen(host) == true
        host.member = sys.spaces(window: host.window) == [marginSpace] && stillFull
        saveMarker()
        return .again("not in place after its move and destroy: \(where_) (\(said()))")
    }

    // macOS shows a window's new full-screen Space: the display set back to Margin's at once (under the freeze it
    // isn't seen). Only that Space: a Space the person went to is left alone.
    private func undoJump(to space: UInt64) {
        guard sys.currentSpace(onDisplayOf: marginSpace) == space else { return }
        if sys.setCurrentSpace(marginSpace) { jumps += 1 }
    }

    // ---- members of Margin's Space ----

    // Its own full-screen Space's four edges reserved from the placement (HostLayout.plan), until its window's bounds
    // are the page area within 1 pt; sent once more. Its own Space is laid out like Margin's (the display's full-screen
    // area), so the page area is the same rect there.
    private func reserve(_ host: Host) async -> Bool {
        guard let own = host.fullScreenSpace else { return false }
        // (Its window's own minimum, from its own Space's tile: reserved for no less.)
        if let t = ownTile(host, in: own) { learnMinimum(host, tile: t) }
        guard let edges = HostLayout.plan(fitted(host)) else {
            Diagnostics.note("host: place \(host.id): no plan (\(placement.text))")
            return false
        }
        let page = frame(host)
        func there() -> Bool { sys.bounds(window: host.window).map { HostLayout.near($0, page, within: options.tolerance) } ?? false }
        for attempt in 1...2 {
            // (At the page area with its Space reserved for it: a window at the page area's frame as a window, mid-way into
            // full screen, isn't placed until its Space is reserved: a window-mode window parked at that frame, 2026-11-17.)
            if there(), sys.reserved(space: own) == edges { return true }
            let reserved = sys.reserved(space: own) ?? .zero
            Diagnostics.note("host: place \(host.id) attempt \(attempt): its window \(sys.bounds(window: host.window).map(r) ?? "?"), its Space reserving \(reserved.text), \(placement.text) → reserving \(edges.text)")
            if reserved != edges || attempt == 2 { _ = sys.reserve(edges, space: own) }
            // (At the page area and held there `placeSettle`: mid-way in, a window's bounds can still be the frame it had
            // as a window, which may be the page area's.)
            var since: Double?
            if await wait(options.placeWait, {
                guard there() else { since = nil; return false }
                let from = since ?? self.sys.now()
                since = from
                return self.sys.now() - from >= self.options.placeSettle - 1e-9
            }) { return true }
        }
        return false
    }

    // Its full-screen window into Margin's Space as a plain member (the bridge, options 7), Margin's Space current first.
    private func enterMargin(_ host: Host) async -> Bool {
        if sys.currentSpace(onDisplayOf: marginSpace) != marginSpace {
            _ = sys.setCurrentSpace(marginSpace)
            _ = await wait(0.5) { self.sys.currentSpace(onDisplayOf: self.marginSpace) == self.marginSpace }
        }
        guard sys.move(window: host.window, to: marginSpace) else { return false }
        return await wait(options.memberWait, every: options.memberEvery) { self.sys.spaces(window: host.window) == [self.marginSpace] }
    }

    // A window out of sight in a private Space, as it is (a member stays full screen there, ready to come back).
    @discardableResult private func parkMember(_ host: Host, emitting: Bool = true) async -> Bool {
        guard let priv = sys.createPrivateSpace() else { return false }
        guard sys.move(window: host.window, to: priv), await wait(options.parkWait, every: options.memberEvery, { self.sys.spaces(window: host.window) == [] }) else {
            retirePrivate(priv)
            return false
        }
        if let old = host.privateSpace, old != priv { retirePrivate(old) }
        host.privateSpace = priv
        host.away = true
        host.phase = .parked
        if shown == host.id { shown = nil }
        saveMarker()
        if emitting { emit(.parked(host.id)) }
        return true
    }

    // A parked window onto its display's Desktop (not the one showing), out of its private Space.
    private func unpark(_ host: Host) async -> Bool {
        guard let priv = host.privateSpace, let desktop = sys.desktop(onDisplayOf: marginSpace), sys.move(window: host.window, to: desktop),
              await wait(options.parkWait, { self.sys.spaces(window: host.window)?.contains(desktop) == true }) else { return false }
        retirePrivate(priv)
        host.privateSpace = nil
        saveMarker()
        return true
    }

    // The Space showing on the host's display (Margin's, when it's current).
    private func currentSpace(for host: Host) -> UInt64? {
        for s in [marginSpace, host.originalSpace ?? 0] where s > 0 {
            if let c = sys.currentSpace(onDisplayOf: s) { return c }
        }
        return nil
    }

    // A member out of full screen. Accessibility acts only on the current Space's windows (proven: AXFullScreen false on
    // a member in the current Space leaves no Space behind), so an app's window is brought there first; Safari's leaves
    // through its copy wherever it is. After: a normal window where it was (the current Space, or its private Space).
    // True: out, as the window server (or Accessibility) shows it, never on the copy's word.
    private func leaveMember(_ host: Host) async -> Bool {
        let copy = viaCopy(host)
        if !copy, let current = currentSpace(for: host), sys.spaces(window: host.window)?.contains(current) != true {
            host.away = true
            guard sys.move(window: host.window, to: current),
                  await wait(options.parkWait, every: options.memberEvery, { self.sys.spaces(window: host.window)?.contains(current) == true }) else {
                Diagnostics.note("host: \(host.id): its window didn't come to the current Space to leave full screen")
                return false
            }
            if let priv = host.privateSpace { retirePrivate(priv); host.privateSpace = nil }
            saveMarker()
        }
        // Done once Accessibility reads it out; otherwise by the window server alone: its window off the frame it had
        // as a member and still (macOS put it back as a window). Safari's too: its copy's answer says only that Safari
        // was asked (seen 2026-11-17: the copy said "normal" 64 ms after the ask, Safari was asked into full screen again
        // 50 ms later, mid-exit, and never made a full-screen Space; the window was lost). Not taken (Accessibility
        // neither taking nor reading it; the copy busy or not linked): asked again `exitUnansweredWait`, then given up
        // (it won't leave by itself; no fixed wait for it).
        let member = sys.bounds(window: host.window) // (its frame as a member, before it's asked)
        let asked = sys.now()
        var answered = await setFullScreen(host, false)
        var moved: (CGRect, Double)?
        var unanswered = false
        let out = await wait(options.exitWait) {
            let full = await self.sys.isFullScreen(pid: host.pid, window: host.window)
            if full == false { return true }
            if !answered {
                answered = await self.setFullScreen(host, false)
                if !answered, self.sys.now() - asked >= self.options.exitUnansweredWait { unanswered = true; return true }
                return false
            }
            if full == true, !copy { return false } // (asked, still leaving: an app animates it)
            guard let b = self.sys.bounds(window: host.window), let m = member, !HostLayout.near(b, m, within: 0.5) else { moved = nil; return false }
            if let (last, since) = moved, HostLayout.near(b, last, within: 0.5) { return self.sys.now() - since >= self.options.placeSettle }
            moved = (b, self.sys.now())
            return false
        } && !unanswered
        host.exitUnconfirmed = !out
        if out, host.tile != nil { await tileLeft(host) }
        if !out { Diagnostics.note("host: \(host.id): out of full screen not confirmed in \(ms(since: asked)) ms (\(unanswered ? (copy ? "its copy didn't ask Safari" : "Accessibility neither took nor read it") : "still at the frame it had as a member: \(sys.bounds(window: host.window).map(r) ?? "unread")"))") }
        if out {
            host.member = false
            host.placedPage = nil
            saveMarker()
        }
        return out
    }

    // A hosted window's own full-screen Space, once its window has left it, destroyed by the window manager: Margin's
    // Space showing first (destroying the one showing drops the display to the Desktop); never one a hosted window is in.
    private func destroyOwn(_ space: UInt64) async -> Bool {
        if sys.spaceExists(space) == false { ownSpaces.remove(space); return true }
        if sys.currentSpace(onDisplayOf: space) == space, marginSpace != space {
            _ = sys.setCurrentSpace(marginSpace)
            _ = await wait(0.5) { self.sys.currentSpace(onDisplayOf: space) != space }
        }
        guard sys.currentSpace(onDisplayOf: space) != space, !hosts.values.contains(where: { sys.spaces(window: $0.window)?.contains(space) == true }) else { return false }
        guard sys.destroyFullScreenSpace(space) else { return false }
        let gone = await wait(options.destroyWait) { self.sys.spaceExists(space) == false }
        if gone { ownSpaces.remove(space) }
        return gone
    }

    private func destroyLeftSpaces() async {
        for space in leftSpaces.sorted() {
            if sys.spaceExists(space) == false { leftSpaces.remove(space); ownSpaces.remove(space); continue }
            if await destroyOwn(space) { leftSpaces.remove(space) }
        }
        saveMarker()
    }

    // The one shown in the page area as it is now: a window by Accessibility; a member placed for another page area
    // placed again (out of full screen and in, with the loading animation).
    @discardableResult private func place(_ host: Host) async -> Bool {
        guard host.phase == .shown else { return false }
        if host.mode == .window { return await placeWindow(host) }
        if let placed = host.placedPage, HostLayout.near(placed, placement.page, within: options.tolerance), host.tile == nil || sys.bounds(window: host.window).map({ HostLayout.near($0, frame(host), within: options.tolerance) }) == true { return true }
        // (Live resize: its tile's rect, no full-screen change; failing that, placed again the old way. Its window gone (closed,
        // its item about to close): nothing placed.)
        if host.tile != nil, sys.bounds(window: host.window) == nil || host.gone { return false }
        if host.tile != nil {
            let t0 = sys.now()
            if await sizeTile(host) {
                hostedSaid = nil
                announceHosted()
                Diagnostics.note("host: \(host.id): its tile sized to the page area \(r(placement.page)) in \(ms(since: t0)) ms")
                return true
            }
            Diagnostics.note("host: \(host.id): its tile's rect didn't take: placed again out of full screen and in")
        }
        Diagnostics.note("host: \(host.id): the page area moved (\(host.placedPage.map(r) ?? "none") → \(r(placement.page))): placed again")
        if case .shown(_, let placed) = await placeFullScreen(host, isNew: false, retrying: false) { return placed && shown == host.id }
        return false
    }

    // Its app in front (the keys) and its window raised; never once Margin quits. True: asked.
    // AXFrontmost first (the app activates itself: Margin, never the active app since its UI is a panel, can't hand it
    // the activation; 2026-11-17, a window-mode app started hidden stayed off screen until it was the front app), then
    // the window raised (and NSRunningApplication's activation, which macOS takes only while Margin is active).
    private func front(_ host: Host) async -> Bool {
        guard !quitting else { return false }
        let asked = await sys.frontmost(pid: host.pid)
        return await sys.activate(pid: host.pid, window: host.window) || asked
    }

    // ---- live resize: tiles in Margin's Space (docs/HOSTING-CORE.md) ----
    // A hosted full-screen window's own tile is moved into Margin's Space (instead of the window alone, as a member), its
    // own Space destroyed as before (Mission Control lists Margin's Space only), and the tile's rect (`TileRect`) set to
    // the page area: the window follows in 10-26 ms, shown or parked in a private Space (the kit, 2026-11-17,
    // /tmp/margin-toolbar-test/live-resize/opt4). Tiles may overlap. Margin's own tile is the display's. A tile added to
    // or taken out of Margin's Space lays the first two of its layout out again (a split's halves: Margin's own window
    // and the first hosted one), so every rect is set again after each (`reapplyTiles`), under the freeze for Margin's
    // own changes. Never a reservation on Margin's Space (it would lay them out again too).

    private enum TileIn { case placed, notMoved(String), notSized(String) }

    // Whether hosted windows go into tiles of Margin's Space now. Checked once per Margin Space (at the first open or
    // preparing there): the tiles part on, Margin's own tile found (its window's), its rect the display's while it's
    // alone, and a bridged write that takes: Margin's Space's tile limit raised to what the next tile needs, read back.
    // ...for this host: never one held below tiles (`noTiles`).
    private func tilesReady(for host: Host) async -> Bool {
        if host.noTiles { return false }
        return await tilesReady()
    }

    private func tilesReady() async -> Bool {
        guard options.tiles, sys.tilesAvailable, tilesOff == nil, marginSpace > 0 else { return false }
        if tilesFor == marginSpace { return tilesOK }
        tilesFor = marginSpace
        tilesOK = false
        let t0 = sys.now()
        guard let list = sys.tiles(of: marginSpace), let mine = list.first(where: { sys.tileWindow($0) == marginWindow }) else {
            return turnOffTiles("Margin's own tile wasn't found in its Space \(marginSpace)")
        }
        let read = sys.tileRect(mine)
        guard let home = HostLayout.home(placement) ?? read else { return turnOffTiles("Margin's own tile's rect didn't read") }
        // (With hosted tiles in it already, Margin's own rect may be laid out as a split's half: set back below.)
        if list.count == 1, let read, !HostLayout.near(read, home, within: 1) {
            return turnOffTiles("Margin's own tile is at \(r(read)), not the display's \(r(home))")
        }
        guard HostLayout.tile(placement, home: home) != nil else { return turnOffTiles("no tile rect for \(placement.text) in \(r(home))") }
        marginTile = mine
        tileHome = home
        tileCount = list.count
        guard await raiseTileLimit(to: list.count + 1) else { return turnOffTiles("Margin's Space's tile limit didn't take (\(sys.maxTiles(of: marginSpace).map(String.init) ?? "unread"))") }
        tilesOK = true
        Diagnostics.note("host: live resize: hosted windows go into tiles of Margin's Space \(marginSpace) (its own tile \(mine), \(r(home)); tile limit \(sys.maxTiles(of: marginSpace).map(String.init) ?? "?")), checked in \(ms(since: t0)) ms")
        await placeAnchors()
        return true
    }

    // Margin's window in another full-screen Space than its hosts' tiles (it left full screen and came back): each tile
    // moved into the new one (its id kept, its window with it: the kit's recovery, 2026-11-17, 360 ms for three), every
    // rect set again, the old Space destroyed once it's empty and nothing owns it. A tile that doesn't move: that host a
    // plain member from now (placed again the old way at its next show), the tiles off for the run.
    private func adoptTiles(from old: UInt64) async {
        let moving = hosts.values.filter { $0.tile != nil }.sorted { $0.id.raw < $1.id.raw }
        let t0 = sys.now()
        guard await tilesReady() else {
            for h in moving { h.tile = nil; h.placedPage = nil }
            return
        }
        let frozen = holdFreeze()
        defer { releaseFreeze(frozen) }
        var moved = 0
        for h in moving {
            guard let tile = h.tile else { continue }
            let list = sys.tiles(of: marginSpace) ?? []
            if list.contains(tile) { moved += 1; continue }
            guard await raiseTileLimit(to: list.count + 1), sys.moveTile(tile, to: marginSpace, index: list.count),
                  await wait(options.tileMoveWait, every: options.tileEvery, { self.sys.tiles(of: self.marginSpace)?.contains(tile) == true }) else {
                h.tile = nil
                h.placedPage = nil
                turnOffTiles("a hosted tile didn't move into Margin's new Space")
                continue
            }
            moved += 1
        }
        // (The anchors in the old Space: destroyed, or it keeps its tiles and isn't destroyed; new ones at the new one's front.)
        await dropAnchors(in: old)
        await placeAnchors()
        await reapplyTiles()
        if sys.spaceExists(old) == true, sys.tiles(of: old)?.isEmpty != false, sys.fullScreenSpaceOwners()?[old] ?? 0 == 0 {
            if await destroyOwn(old) { Diagnostics.note("host: Margin's old Space \(old) destroyed (its hosted tiles moved out)") }
        }
        saveMarker()
        Diagnostics.note("host: live resize: \(moved) of \(moving.count) hosted tile\(moving.count == 1 ? "" : "s") moved from Margin's old Space \(old) into \(marginSpace) in \(ms(since: t0)) ms")
    }

    // ---- the anchors (docs/HOSTING-CORE.md "Anchors") ----

    // Margin's own two empty tiles (no window: they draw nothing) made at its Space's layout's front, so a tile change
    // macOS lays out again (a tile added or taken out: the first two of the layout, as a split's halves) lays only them
    // out, never Margin's window or a hosted one: no flash, no re-layout to undo, nothing for an app to answer (the
    // loop Weather made, 2026-11-18 13:30, as the layout's second tile). The kit (2026-11-18, opt5 a2): made in 5 ms,
    // moved to the front within the Space; a tile added, one destroyed, a window parked and back: only the anchors'
    // rects changed. Under the freeze: Margin's own window is laid out once as they're made. Not made: as before.
    @discardableResult private func placeAnchors() async -> Bool {
        guard options.anchors, sys.anchorsAvailable, tilesOK, marginSpace > 0 else { return false }
        let space = marginSpace
        var list = sys.tiles(of: space) ?? []
        if anchorTiles.count == 2, Array(list.prefix(2)) == anchorTiles { return true }
        let t0 = sys.now()
        guard await raiseTileLimit(to: list.count + 3) else { return saidNoAnchors("Margin's Space's tile limit didn't take") }
        let frozen = holdFreeze()
        defer { releaseFreeze(frozen) }
        var made = anchorTiles.filter { list.contains($0) }
        while made.count < 2 {
            let before = Set(list)
            guard let said = sys.createTile(in: space) else { break }
            var new: UInt64?
            _ = await wait(options.tileMoveWait, every: options.tileEvery) {
                let now = self.sys.tiles(of: space) ?? []
                new = said > 0 && now.contains(said) ? said : Set(now).subtracting(before).subtracting(made).first
                return new != nil
            }
            guard let t = new else { break }
            made.append(t)
            list = sys.tiles(of: space) ?? list
        }
        guard made.count == 2 else {
            for t in made { _ = sys.destroyTile(t) }
            anchorTiles = []
            return saidNoAnchors("\(made.count) of 2 empty tiles made")
        }
        for (i, t) in made.enumerated() { _ = sys.moveTile(t, to: space, index: i) }
        let front = await wait(options.tileMoveWait, every: options.tileEvery) { Array((self.sys.tiles(of: space) ?? []).prefix(2)) == made }
        guard front else {
            for t in made { _ = sys.destroyTile(t) }
            anchorTiles = []
            return saidNoAnchors("the empty tiles didn't go to the front (\(sys.tiles(of: space).map { "\($0)" } ?? "?"))")
        }
        anchorTiles = made
        tilesSettled = false
        saveMarker()
        await reapplyTiles()
        tileCount = sys.tiles(of: space)?.count ?? tileCount
        Diagnostics.note("host: anchors: Margin's own empty tiles \(made.map(String.init).joined(separator: ", ")) at its Space's front in \(ms(since: t0)) ms: tile changes lay only them out again")
        return true
    }
    private var anchorsSaid = false
    private func saidNoAnchors(_ why: String) -> Bool {
        if !anchorsSaid { anchorsSaid = true; Diagnostics.note("host: anchors not made (\(why)): tile changes lay Margin's window and the first hosted one out again, set back as before") }
        return false
    }

    // The anchors destroyed (Margin quits, its window moved to another Space): their Space empty of Margin's tiles.
    private func dropAnchors(in space: UInt64? = nil) async {
        guard !anchorTiles.isEmpty else { return }
        let from = space ?? marginSpace
        let dead = anchorTiles
        for t in dead { _ = sys.destroyTile(t) }
        _ = await wait(options.destroyWait, every: options.tileEvery) { !(self.sys.tiles(of: from) ?? []).contains(where: { dead.contains($0) }) }
        anchorTiles = []
        saveMarker()
    }

    // Off for the run, said once: every later open is a member's (today's way), a page area's change re-fits on release.
    @discardableResult private func turnOffTiles(_ why: String) -> Bool {
        tilesOK = false
        if tilesOff == nil {
            tilesOff = why
            Diagnostics.warn("host: live resize off for this run: \(why); a change of the page area places the one shown again when it's over, as before")
        }
        return false
    }

    // Margin's Space's tile limit at least `count` (a tile moved in past it isn't taken), read back.
    private func raiseTileLimit(to count: Int) async -> Bool {
        if (sys.maxTiles(of: marginSpace) ?? 0) >= count { return true }
        guard sys.setMaxTiles(marginSpace, count) else { return false }
        return await wait(options.tileLimitWait, every: options.tileEvery) { (self.sys.maxTiles(of: self.marginSpace) ?? 0) >= count }
    }

    // The tile rect that puts a full-screen window at the page area (nil: none, or the tiles aren't checked).
    private func tileRect(_ p: HostPlacement? = nil) -> CGRect? { tileHome.flatMap { HostLayout.tile(p ?? placement, home: $0) } }

    // ---- a window's own minimum (docs/HOSTING-CORE.md "A window's minimum size") ----

    // Where a full-screen host's window goes for a page area (`p`, else Margin's): the page area, or (its own minimum
    // wider or taller) that minimum, its right edge and top the page area's (HostLayout.fit). A window-mode one: the
    // page area (Accessibility keeps its own limits, centred).
    private func frame(_ host: Host, _ p: HostPlacement? = nil) -> CGRect {
        let pl = p ?? placement
        return host.mode == .window ? pl.page : HostLayout.fit(pl.page, min: host.minSize, in: pl.area)
    }
    private func fitted(_ host: Host, _ p: HostPlacement? = nil) -> HostPlacement {
        var pl = p ?? placement
        pl.page = frame(host, pl)
        return pl
    }
    // Its tile's rect for a page area: never narrower than its window's minimum.
    private func tileRect(for host: Host, _ p: HostPlacement? = nil) -> CGRect? { tileHome.flatMap { HostLayout.tile(fitted(host, p), home: $0) } }

    // Its window's tile in a full-screen Space of its own (by its window; the only one there).
    private func ownTile(_ host: Host, in space: UInt64) -> UInt64? {
        guard let list = sys.tiles(of: space) else { return nil }
        return list.first { sys.tileWindow($0) == host.window } ?? (list.count == 1 ? list.first : nil)
    }

    // Its window's minimum read from a tile (its own in Margin's Space, or the one of its own full-screen Space): a
    // change said once, and told to Margin's window while it's the one shown (the sidebar's edge stops there). One read
    // of the tile's values: never per frame of a drag. True: it changed.
    @discardableResult private func learnMinimum(_ host: Host, tile: UInt64? = nil) -> Bool {
        guard host.mode != .window, let t = tile ?? host.tile else { return false }
        // (A tile that says none now, its minimum read before: kept (an app's minimum doesn't go), said once.)
        guard let read = sys.tileMinSize(t) else {
            if host.minSize != nil, !host.minUnreadSaid { host.minUnreadSaid = true; Diagnostics.note("host: \(host.id): its tile \(t) says no minimum now (\(host.phase == .parked ? "parked" : "shown")): its minimum as read before kept") }
            return false
        }
        let m = CGSize(width: read.width.rounded(.up), height: read.height.rounded(.up))
        guard m != host.minSize else { return false }
        host.minSize = m
        Diagnostics.note("host: \(host.id): its window's own minimum \(Int(m.width))×\(Int(m.height)) (its tile's): never sized smaller, the sidebar's edge stops there while it's shown")
        if shown == host.id { sayMinimum() }
        return true
    }

    private func held(_ host: Host, _ width: CGFloat) { host.narrowestHeld = min(host.narrowestHeld ?? width, width) }

    // No minimum said by its tile, and it left one (`tileBack`): the narrowest it held is taken for its minimum (it took
    // that, and not the rect that made it leave): said once, told like a read one.
    private func learnMinimumFromLeaving(_ host: Host) {
        guard host.mode != .window, host.minSize == nil, let w = host.narrowestHeld else { return }
        host.minSize = CGSize(width: w.rounded(.up), height: 0)
        Diagnostics.note("host: \(host.id): its tile says no minimum and it left one narrower than \(Int(w)): \(Int(w)) taken for its minimum width (never sized narrower)")
        if shown == host.id { sayMinimum() }
    }

    // The one shown's own minimum width, told to Margin's window (nil: none, or nothing shown) whenever the one shown
    // or its minimum changes (the window says it to its page only when it's another: MarginWindowController
    // `setPageMinimum`; a host moved to another Margin window is told there too): its sidebar's edge stops where the
    // page area would be narrower (ui/behaviors/resize.ts), like Split View's divider.
    var onMinimum: ((CGFloat?) -> Void)?
    private func sayMinimum() { onMinimum?(shownMinimumWidth) }
    var shownMinimumWidth: CGFloat? { shown.flatMap { hosts[$0] }.flatMap { $0.phase == .shown && $0.mode != .window ? $0.minSize?.width : nil } }

    // Its window's own tile (in its own full-screen Space `own`) into Margin's Space at the end of its layout (its window
    // with it, still full screen), the tile limit raised first, then every rect set again, its own to the page area.
    // Under the freeze the caller holds: Margin's own window is laid out as a split's half for that moment. `.placed`:
    // its window in Margin's Space at the page area; `.notMoved`: nothing moved, the window still in its own Space (a
    // member's way from there); `.notSized`: in Margin's Space, its rect not taken (backed out by the caller).
    private func tileIn(_ host: Host, from own: UInt64, each: () -> Void = {}) async -> TileIn {
        let t0 = sys.now()
        guard let ownTiles = sys.tiles(of: own), let tile = ownTiles.first(where: { sys.tileWindow($0) == host.window }) ?? (ownTiles.count == 1 ? ownTiles.first : nil) else {
            return .notMoved("its own Space's tile didn't read")
        }
        let list = sys.tiles(of: marginSpace) ?? []
        guard await raiseTileLimit(to: list.count + 1) else { return .notMoved("Margin's Space's tile limit didn't take") }
        each()
        guard sys.moveTile(tile, to: marginSpace, index: list.count) else { return .notMoved("the bridge didn't take its tile's move") }
        let landed = await wait(options.tileMoveWait, every: options.tileEvery) {
            each()
            return self.sys.tiles(of: self.marginSpace)?.contains(tile) == true && self.sys.spaces(window: host.window) == [self.marginSpace]
        }
        let inMargin = sys.tiles(of: marginSpace)?.contains(tile) == true
        guard landed || inMargin else {
            return .notMoved("its tile didn't come into Margin's Space within \(ms(since: t0)) ms (its window in \(sys.spaces(window: host.window).map { "\($0)" } ?? "?"))")
        }
        host.tile = tile
        host.member = true
        tilesSettled = false
        tileCount = sys.tiles(of: marginSpace)?.count ?? list.count + 1
        saveMarker()
        learnMinimum(host)
        let sized = await reapplyTiles(first: host, each: each)
        guard landed, sized else {
            return .notSized("its tile \(tile) \(landed ? "came in" : "came in without its window") and its window is at \(sys.bounds(window: host.window).map(r) ?? "?"), not \(r(frame(host)))")
        }
        Diagnostics.note("host: \(host.id): its tile \(tile) moved into Margin's Space and sized to the page area in \(ms(since: t0)) ms (\(tileCount) tiles there)")
        return .placed
    }

    // Every rect in Margin's Space set as it should be: Margin's own tile the display's, each hosted tile the page
    // area's (`first`, then the one shown, then the others). Waits for Margin's own window and `first`'s (or the one
    // shown) at their places; the others' are set, and seen taken by the reconciler (`sizeTile`) when they aren't.
    // True: the ones waited for are there.
    @discardableResult private func reapplyTiles(first: Host? = nil, each: () -> Void = {}) async -> Bool {
        guard let mine = marginTile, let home = tileHome, tileRect() != nil else { return false }
        let page = placement.page
        setTileRectIfNeeded(mine, home)
        let lead = first ?? shown.flatMap { hosts[$0] }.flatMap { $0.tile != nil ? $0 : nil }
        var order = hosts.values.filter { $0.tile != nil && $0 !== lead }.sorted { $0.id.raw < $1.id.raw }
        if let lead { order.insert(lead, at: 0) }
        // (A host held below tiles, on its way out of its tile: its rect never sent again.)
        for h in order where (h === lead || !parkedAtPage(h)) && !h.noTiles { if let t = h.tile, let rect = tileRect(for: h) { sendTileRect(h, t, rect) } }
        let area = placement.area
        let leadFrame = lead.map { frame($0) }
        let ok = await wait(options.tileWait, every: options.tileEvery) {
            each()
            let marginBack = self.sys.bounds(window: self.marginWindow).map { $0.width >= area.width - 1 } ?? true
            let leadThere = lead.map { h in self.sys.bounds(window: h.window).map { HostLayout.near($0, leadFrame ?? page, within: self.options.tolerance) } ?? false } ?? true
            return marginBack && leadThere
        }
        for h in order where h === lead || !parkedAtPage(h) {
            if h === lead, ok { h.placedPage = page; h.offPageReads = 0; held(h, frame(h).width) } else if h !== lead { h.placedPage = sys.bounds(window: h.window).map { HostLayout.near($0, frame(h), within: options.tolerance) } == true ? page : nil }
        }
        tileCount = sys.tiles(of: marginSpace)?.count ?? tileCount
        return ok
    }

    // A hosted tile's rect sent (only if it isn't that already), Margin's sizing told to the observer (a window its app
    // makes at that size right after is its answer: a helper, never one of its own) and to the causes.
    private func sendTileRect(_ h: Host, _ tile: UInt64, _ rect: CGRect) {
        if sys.tileRect(tile).map({ HostLayout.near($0, rect, within: 0.5) }) == true { return }
        sized(h, [rect, frame(h)])
        _ = sys.setTileRect(tile, rect)
    }
    private func sized(_ h: Host, _ rects: [CGRect]) {
        observer.sized(pid: h.pid, rects: rects)
        core.noteSized(now: sys.now(), host: h.id.raw)
    }

    // A tile's rect sent only when it isn't that already (a rect sent again makes its app lay its window out again).
    private func setTileRectIfNeeded(_ tile: UInt64, _ rect: CGRect) {
        if sys.tileRect(tile).map({ HostLayout.near($0, rect, within: 0.5) }) == true { return }
        _ = sys.setTileRect(tile, rect)
    }

    // A parked host's tile sized for the page area as it is now (whatever a tile change Margin didn't make did to it
    // since: left so until it's shown).
    private func parkedAtPage(_ h: Host) -> Bool {
        h.phase == .parked && h.placedPage.map { HostLayout.near($0, placement.page, within: options.tolerance) } == true
    }

    // Its tile's rect the page area's, and its window there.
    private func tileAtPage(_ host: Host) -> Bool {
        guard let tile = host.tile, let rect = tileRect(for: host) else { return false }
        let want = frame(host)
        return sys.tileRect(tile).map { HostLayout.near($0, rect, within: 0.5) } == true
            && sys.bounds(window: host.window).map { HostLayout.near($0, want, within: options.tolerance) } == true
    }

    // One hosted tile set to the page area's rect, its window seen there (`tileWait`), shown or parked. True: there.
    @discardableResult private func sizeTile(_ host: Host) async -> Bool {
        guard let tile = host.tile else { return false }
        learnMinimum(host)
        guard let rect = tileRect(for: host) else { return false }
        let page = placement.page, want = frame(host)
        func there() -> Bool { sys.bounds(window: host.window).map { HostLayout.near($0, want, within: options.tolerance) } ?? false }
        if there(), sys.tileRect(tile).map({ HostLayout.near($0, rect, within: 0.5) }) == true { host.placedPage = page; host.offPageReads = 0; return true }
        let t0 = sys.now()
        sized(host, [rect, want])
        guard sys.setTileRect(tile, rect) else { return false }
        let ok = await wait(options.tileWait, every: options.tileEvery) { there() }
        if ok {
            host.placedPage = page
            host.offPageReads = 0
            held(host, want.width)
        } else {
            Diagnostics.note("host: \(host.id): its tile \(tile) set to \(r(rect)), its window still at \(sys.bounds(window: host.window).map(r) ?? "?") after \(ms(since: t0)) ms")
        }
        return ok
    }

    // A host's tile taken out of Margin's Space (its window out of full screen, given back): every rect set again (the
    // first two of the layout are laid out again), under the freeze (Margin's own window is seen otherwise).
    private func tileLeft(_ host: Host) async {
        guard let tile = host.tile else { return }
        host.tile = nil
        tilesSettled = false
        // (Still in Margin's Space with no window of the host's: a tile its window left; gone with the next look.)
        if sys.tiles(of: marginSpace)?.contains(tile) == true { goneTiles.insert(tile) }
        guard !quitting, tilesOK else { return }
        let frozen = holdFreeze()
        await dropGoneTiles()
        await reapplyTiles()
        releaseFreeze(frozen)
    }

    // Hosted tiles whose host went and that stayed in Margin's Space (a placeholder its app left as it crashed; a tile its
    // window left) destroyed through the bridge. The caller sets every rect again after (a tile taken out lays the first
    // two out again).
    private func dropGoneTiles() async {
        guard !goneTiles.isEmpty, let list = sys.tiles(of: marginSpace) else { return }
        let live = Set(hosts.values.compactMap(\.tile))
        let dead = goneTiles.filter { list.contains($0) && !live.contains($0) }
        goneTiles.subtract(goneTiles.filter { !list.contains($0) })
        guard !dead.isEmpty else { return }
        tilesSettled = false
        for t in dead.sorted() { _ = sys.destroyTile(t) }
        let gone = await wait(options.destroyWait, every: options.tileEvery) { !(self.sys.tiles(of: self.marginSpace) ?? []).contains(where: { dead.contains($0) }) }
        if gone { goneTiles.subtract(dead) }
        Diagnostics.note("host: \(dead.count) tile\(dead.count == 1 ? "" : "s") of a host that went (\(dead.sorted().map(String.init).joined(separator: ", "))) \(gone ? "destroyed" : "NOT destroyed (tried again at the next look)")")
    }

    // The poll's look at Margin's Space's tiles: another count (a tile added or taken out by anything: an app quit or
    // crashed, a window closed), a host's tile left behind by its host, or Margin's own tile not the display's: every
    // rect set again (in the engine's queue).
    private func lookAtTiles(force: Bool = false) {
        guard tilesOK, tilesFor == marginSpace, !quitting, let mine = marginTile, let home = tileHome, let list = sys.tiles(of: marginSpace) else { return }
        let left = goneTiles.contains { list.contains($0) }
        let homeOff = sys.tileRect(mine).map { !HostLayout.near($0, home, within: 1) } ?? false
        guard force || left || homeOff || list.count != tileCount else { return }
        let why = left ? "a tile of a host that went is still there" : homeOff ? "Margin's own tile isn't the display's" : list.count != tileCount ? "\(tileCount) tiles → \(list.count)" : "Margin's window laid out as a split's half"
        tileCount = list.count
        // (The poll's own find: a reaction, guarded like marginNarrowed's; from marginNarrowed: counted there.)
        if !force, homeOff, !left, !planned, !relayoutGuarded(core.explainRelayout(now: sys.now())) { return }
        Task { await serial {
            guard self.tilesOK, !self.quitting else { return }
            Diagnostics.note("host: Margin's Space's tiles changed (\(why)): every rect set again")
            let frozen = left ? self.holdFreeze() : false
            await self.dropGoneTiles()
            await self.reapplyTiles()
            self.releaseFreeze(frozen)
        } }
    }

    // Margin's window laid out as a split's half while it hosts (a tile change in its Space Margin didn't make: an app
    // quit or crashed, its window closed by the person): its tiles looked at now rather than at the next poll. Margin's
    // own operations set every rect again themselves.
    // Every rect is sent again at once, whatever runs (the same rects the running operation sets: harmless), so the split
    // is seen for as short a moment as the window manager takes (the real Mac, 2026-11-17 23:31:42: a switch laid Margin's
    // window and the one shown out as a split's thirds; the poll set them back 120 ms later); checked by the next look.
    //
    // A tile change of Margin's own operation is its plan (`planned`): every rect sent again, nothing counted. Any other is a
    // reaction: its cause worked out first (the hosting core's causes: a window that came or went just before, and whose),
    // and counted against that host by the loop guard. Margin's own tile is always put back (no app answers it); the
    // hosted rects are sent only while the guard lets them. Stopped (the same re-layout three times within 5 s: Weather,
    // 2026-11-18 13:30, answered each of its tile's resizes with a window whose close laid the tiles out again, 54 rounds
    // in 18 s): that host moved to a safer route; with no cause seen, the tiles off for the run.
    func marginNarrowed() {
        guard tilesOK, tilesFor == marginSpace, !quitting, let mine = marginTile, let home = tileHome else { return }
        setTileRectIfNeeded(mine, home)
        let now = sys.now()
        if !planned {
            let cause = core.explainRelayout(now: now)
            guard relayoutGuarded(cause) else { return }
            Diagnostics.note("host: Margin's window laid out as a split's part by a tile change (\(cause.text)): every rect sent again at once")
        } else {
            Diagnostics.note("host: Margin's window laid out as a split's part by its own tile change: every rect sent again at once")
        }
        sendHostedRects()
        if !busy { lookAtTiles(force: true) }
    }

    // Every hosted tile's rect at once (the one shown first), each only if it isn't that already.
    private func sendHostedRects() {
        guard tileRect() != nil else { return }
        let order = hosts.values.filter { $0.tile != nil }.sorted { ($0.id == shown ? 0 : 1, $0.id.raw) < ($1.id == shown ? 0 : 1, $1.id.raw) }
        for h in order where !parkedAtPage(h) && !h.noTiles { if let t = h.tile, let rect = tileRect(for: h) { sendTileRect(h, t, rect) } }
    }

    // ---- the loop guard (the hosting core's guard.rs) and the routes (routes.rs) ----

    // A reaction about to be applied for `host` (`key`: what it is): true, go. Stopped: the host moved to a safer route
    // (said), false. Held (too many reactions across every host this second): false, nothing more this time.
    private func guarded(_ host: Host, _ key: String) -> Bool {
        guard !planned, options.loopGuard else { return true }
        switch core.react(now: sys.now(), host: host.id.raw, key: key) {
        case .go: return true
        case .hold(let until):
            Diagnostics.note("host: \(host.id): \(key) held: too many reactions this second across every host (\(Int(max(0, until - sys.now()) * 1000)) ms more)")
            return false
        case .stop(_, let k, let count):
            stepDown(host, why: "\(k) \(count) times within \(Int(core.constant("guardWithin") ?? 5)) s")
            return false
        }
    }

    // The same for a re-layout of Margin's Space's tiles: counted against the host whose window caused it, else
    // Margin's own window (no cause seen).
    private func relayoutGuarded(_ cause: HostCause) -> Bool {
        if cause.person || !options.loopGuard { return true }
        let blamed = hosts.values.first { $0.id.raw == cause.host }
        switch core.react(now: sys.now(), host: blamed?.id.raw ?? "margin", key: "tiles laid out again") {
        case .go: return true
        case .hold: return false
        case .stop(_, _, let count):
            let why = "Margin's Space's tiles laid out again \(count) times within \(Int(core.constant("guardWithin") ?? 5)) s (\(cause.text))"
            if let blamed {
                stepDown(blamed, why: why)
            } else {
                // (No host to blame: every tiled host a plain member from its next placing, the tiles off for the run.)
                turnOffTiles(why)
                for h in hosts.values where h.tile != nil { h.noTiles = true; h.placedPage = nil }
                if let id = shown, let h = hosts[id], h.phase == .shown { Task { await self.serial(planned: true) { _ = await self.placeFullScreen(h, isNew: false, retrying: false) } } }
            }
            return false
        }
    }

    // The routes this host could take now (tiles only where they work here; full screen only for a window that can).
    private func availableRoutes(_ host: Host) -> [HostRoute] {
        var out: [HostRoute] = []
        if options.tiles, sys.tilesAvailable, tilesOff == nil { out.append(.tiles) }
        if case .app = host.target, observer.model.apps[host.pid]?.windows[host.window]?.ax?.canFullScreen == false { return out.filter { $0 == .window } + [.window] }
        out.append(.members)
        if case .app = host.target { out.append(.window) } // (Safari's window is Margin's own: always full screen)
        return out
    }

    private func routeOf(_ host: Host) -> HostRoute { host.mode == .window ? .window : host.tile != nil ? .tiles : .members }

    // Its app's identity for the routes: bundle id and version (a new version tries the better route again).
    private func identity(_ host: Host) -> (bundle: String, version: String) {
        (host.bundleId ?? host.id.raw, sys.appVersion(pid: host.pid) ?? "?")
    }

    // The route a host opens on, the routes held (an app that fought its tile in an earlier run of this version: a
    // member from the start).
    private func applyHeldRoute(_ host: Host) {
        let (bundle, version) = identity(host)
        let (route, why) = core.route(bundle: bundle, version: version, available: availableRoutes(host))
        guard let route, route != .tiles, why != nil else { return }
        host.noTiles = true
        Diagnostics.note("host: \(host.id): held at \(route.text) for this version of its app (\(why ?? "")): no tile for it")
    }

    // The loop guard stopped `host`: moved one rung down (tiles → members → window mode), remembered for this version of
    // its app (tried again after an update), said in the log and in the sidebar (`onRoute`).
    private func stepDown(_ host: Host, why: String) {
        let from = routeOf(host)
        let (bundle, version) = identity(host)
        let next = core.stepDown(now: sys.now(), bundle: bundle, version: version, from: from, available: availableRoutes(host), why: why)
        core.cleared(host: host.id.raw)
        if let routesURL { core.saveRoutes(to: routesURL) }
        guard let next else {
            Diagnostics.warn("host: \(host.id): \(why), on \(from.text), nothing safer below: left as it is")
            return
        }
        Diagnostics.warn("host: \(host.id): \(why): moved from \(from.text) to \(next.text) for this version of its app (\(version)), tried again after an update")
        onRoute?(host.id, next.text)
        // (Margin's own operation from here: what it changes is its plan, not a reaction.)
        Task { await serial(planned: true) { await self.move(host, to: next) } }
    }

    private func move(_ host: Host, to route: HostRoute) async {
        guard hosts[host.id] === host else { return }
        switch route {
        case .tiles: return
        case .members:
            host.noTiles = true
            guard host.tile != nil else { return }
            host.placedPage = nil
            // (Shown: out of its tile and in again as a plain member now, behind the loader. Parked: at its next show.)
            if shown == host.id, host.phase == .shown { _ = await placeFullScreen(host, isNew: false, retrying: false) }
        case .window:
            host.retryFullScreen = false
            host.fullScreenFailures = max(host.fullScreenFailures, 2)
            if shown == host.id, host.phase == .shown {
                _ = await fallBack(host, isNew: false, retrying: true, .place, "the loop guard moved it to window mode", previous: nil)
            } else {
                host.mode = .window
                host.placedPage = nil
            }
        }
        saveMarker()
    }

    // ---- the sidebar's edge dragged: the one shown follows live ----

    // A drag of the sidebar's edge began (true) or is over (false). True back: the one shown follows it live (a tile's
    // window, or a window-mode window by Accessibility); false: it doesn't (the session holds the page area's changes
    // until the drag is over, as before). Margin's Space is told a live resize is under way (`LiveResizing`, set false
    // after: the hosted app gets one live-resize start and end, not one per frame: the kit's lead 4).
    @discardableResult func dragging(_ on: Bool) -> Bool {
        if on {
            guard !liveOn, !quitting, let id = shown, let host = hosts[id], host.phase == .shown, host.tile != nil || host.mode == .window else { return false }
            liveOn = true
            liveHeld = false
            liveLast = sys.now()
            liveStats = LiveStats(since: sys.now())
            // (Its minimum read once more as the drag begins (one read, none per frame): the page's edge stops there.)
            if host.tile != nil { learnMinimum(host); _ = sys.setLiveResizing(marginSpace, true) }
            return true
        }
        guard liveOn else { return false }
        liveOn = false
        liveHeld = false
        livePending = nil
        if tilesOK { _ = sys.setLiveResizing(marginSpace, false) }
        let s = liveStats
        let sorted = s.followed.sorted()
        func at(_ q: Double) -> String { sorted.isEmpty ? "-" : String(format: "%.1f", sorted[min(sorted.count - 1, Int(Double(sorted.count) * q))] * 1000) }
        Diagnostics.note("host: live resize: \(s.asked) page area changes in \(ms(since: s.since)) ms, \(s.sent) sent (\(s.asked - s.sent) coalesced), followed \(s.followed.count) (median \(at(0.5)) ms, p95 \(at(0.95)) ms), \(s.late) not followed within \(Int(options.liveWait * 1000)) ms, \(s.held) frames held by an operation")
        return true
    }

    // The one shown is a tile: it fills the page area as it follows a drag (a window-mode one may be smaller, centred).
    var shownFillsPage: Bool { shown.flatMap { hosts[$0] }?.tile != nil }

    // The page area during a drag (each of the page's layouts): the one shown follows, at most one change a display frame
    // and one in flight; the newest wins. Not Margin's desired page area yet: that's the drag's end (`pageRectChanged`).
    func follow(_ p: HostPlacement) {
        guard liveOn else { return }
        liveLast = sys.now()
        liveStats.asked += 1
        livePending = p
        if livePump == nil { livePump = Task { await self.pumpLive() } }
    }

    private func pumpLive() async {
        defer { livePump = nil }
        while liveOn, let p = livePending {
            let t0 = sys.now()
            // (An operation running, or the one shown left its tile in this drag: held a frame, the newest kept.)
            guard !busy, !quitting, !liveHeld, let id = shown, let host = hosts[id], host.phase == .shown else {
                liveStats.held += 1
                await sys.sleep(options.liveFrame)
                continue
            }
            livePending = nil
            // (Never narrower than its window's own minimum: a comparison, nothing read. The sidebar's edge stops there
            // in the page already; this holds for a minimum learnt mid-drag too.)
            let page = host.tile != nil ? frame(host, p) : p.page
            if let tile = host.tile, let rect = tileRect(for: host, p) {
                observer.sized(pid: host.pid, rects: [rect, page]) // (no cause noted a frame: a drag is the person's)
                guard sys.setTileRect(tile, rect) else { break }
            } else if host.mode == .window {
                let want = host.resizable ? page : centredIn(page, sys.bounds(window: host.window)?.size ?? page.size)
                guard await sys.setFrame(pid: host.pid, window: host.window, want, size: host.resizable) else { break }
                host.frameChanged = true
            } else { break }
            liveStats.sent += 1
            let followed = await wait(options.liveWait, every: options.tileEvery) {
                self.sys.bounds(window: host.window).map { HostLayout.near($0, page, within: self.options.tolerance) || (host.mode == .window && !host.resizable) } ?? false
            }
            if followed { liveStats.followed.append(sys.now() - t0); if host.tile != nil { held(host, page.width) } } else { liveStats.late += 1 }
            // (A window-mode window's hole is its bounds: Margin's window reads them again now it's moved.)
            if host.mode == .window { hostedWindow?(host.window) }
            let left = options.liveFrame - (sys.now() - t0)
            if left > 0 { await sys.sleep(left) }
        }
    }

    // Live resize: the one shown left its tile for a full-screen Space of its own (its app's answer to a tile it
    // couldn't take: Weather on the real Mac, 2026-11-18 09:08, its tile sent narrower than its minimum): its tile there
    // moved back into Margin's Space and sized (never below its minimum, read from that tile first), that Space
    // destroyed, under the freeze: still shown, no full-screen exit or entry, no loader (was: the window moved in alone,
    // then placed again out of full screen and in, 2-3 s behind the loader, each time). False: not that case, or its
    // tile didn't come back (the old way from there).
    private func tileBack(_ host: Host, from own: [UInt64], since t0: Double) async -> Bool {
        guard tilesOK, tilesFor == marginSpace, !quitting, host.mode != .window, host.tile != nil, own.count == 1, let space = own.first,
              let tile = ownTile(host, in: space) else { return false }
        if !learnMinimum(host, tile: tile), host.minSize == nil { learnMinimumFromLeaving(host) }
        // (Its old tile, if it's still in Margin's Space with a placeholder: destroyed with the next look.)
        if let old = host.tile, old != tile, sys.tiles(of: marginSpace)?.contains(old) == true { goneTiles.insert(old) }
        let frozen = holdFreeze()
        defer { releaseFreeze(frozen) }
        ownSpaces.insert(space)
        guard case .placed = await tileIn(host, from: space) else {
            Diagnostics.note("host: \(host.id): its tile in its own Space \(space) didn't come back into Margin's Space: brought back the old way")
            return false
        }
        if await !destroyOwn(space) { leftSpaces.insert(space) }
        _ = await settleMember(host)
        await dropGoneTiles()
        await reapplyTiles(first: host)
        saveMarker()
        hostedSaid = nil
        announceHosted()
        Diagnostics.note("host: \(host.id) back in its tile in Margin's Space in \(ms(since: t0)) ms, still shown, at \(sys.bounds(window: host.window).map(r) ?? "?") (no full-screen exit or entry)")
        return true
    }

    // ---- parking ----

    // The one shown parked with nothing in its place (Margin's window leaving full screen, its window strayed): a
    // member as it is, a window its frame given back first; failing that, out of full screen wherever it is, then
    // parked. Margin's old Space, left with no window of Margin's, destroyed (Mission Control would list it).
    private func parkShownNow(why: String) async {
        guard let id = shown, let host = hosts[id] else { return }
        let t0 = sys.now()
        // (Strayed, it may be in a full-screen Space of its own by now: given back once it's left.)
        let was = (sys.spaces(window: host.window) ?? []).filter { $0 != marginSpace && sys.spaceType($0) == ManagedSpace.fullScreenType && ownSpaces.contains($0) }
        if await !retire(host) {
            let frozen = holdFreeze()
            await backOut(host)
            releaseFreeze(frozen)
            await park(host)
            emit(.parked(id))
        }
        shown = nil
        for space in was where sys.spaceExists(space) == true {
            if await !destroyOwn(space) { leftSpaces.insert(space) }
        }
        if marginSpace > 0, sys.spaceExists(marginSpace) == true, sys.spaces(window: marginWindow)?.contains(marginSpace) == false {
            ownSpaces.insert(marginSpace)
            if await destroyOwn(marginSpace) { Diagnostics.note("host: Margin's old Space, left with no window of Margin's, destroyed") }
        }
        saveMarker()
        Diagnostics.note("host: \(id) parked, nothing shown (\(why)) in \(ms(since: t0)) ms")
        emit(.unshown(id))
        checkListed("after \(id) was parked")
    }

    // A hosted window its app closed (the person's ⌘W, its close button, its app's own close) that the window server still
    // lists: Accessibility said its element was destroyed, and it's in no Space or off screen (an NSWindow its app keeps
    // after its close stays listed at its last frame, off screen: Chameleon's windowless close, 2026-11-17 19:04, was
    // taken for a stray, brought back, placed again, refused, and reopened: a window the person closed came back). A
    // window on screen isn't taken for closed whatever was said (one Accessibility lists again is taken off by the
    // observer).
    private func closedByItsApp(_ host: Host) -> Bool {
        guard observer.model.apps[host.pid]?.closed.contains(host.window) == true else { return false }
        if (sys.spaces(window: host.window) ?? []).isEmpty { return true }
        // (Or off screen by its own read: a closed window-mode window stays listed in Margin's Space, off screen.)
        return sys.windowOnScreen(host.window).map { !$0.onScreen } ?? false
    }

    // The poll found a host where it mustn't be. The one shown, outside Margin's Space: with Margin's window out of its
    // Space too (macOS took it out of full screen), parked with nothing in its place. With Margin's window still there
    // (seen 2026-11-17, 0.4-0.7 s after the first show of a Safari window made ready at launch: "parked, nothing shown",
    // the launcher again, a second click needed), something else moved the hosted window (its app finishing its own
    // full-screen change late, macOS on its first activation): brought back into Margin's Space as it is and kept shown
    // (`bringBack`), what the poll saw said in the log. (A parked one in a user Space: the reconciler's `parkAgain`.)
    private func strayed(_ id: HostID, marginHere: Bool) async {
        // (Closed meanwhile, its close told after the poll's read: the poll's gone path and the reconciler's grace, never
        // brought back: a closed window put back in Margin's Space was placed again, refused, and reopened, 19:04.)
        guard let host = hosts[id], !closedByItsApp(host) else { return }
        if host.phase == .shown, shown == id {
            let spaces = sys.spaces(window: host.window)
            // (Mid-drag: not followed again until it's over, whatever comes of it; never twice in one drag.)
            if liveOn, spaces != [marginSpace] { liveHeld = true }
            let seen = "its window in \(spaces.map { $0.isEmpty ? "no user Space" : $0.map { "\($0) (type \(sys.spaceType($0).map(String.init) ?? "?"))" }.joined(separator: ", ") } ?? "Spaces that don't read"), Margin's Space \(marginSpace), Margin's window \(marginHere ? "in it" : "out of it")"
                + ", its bounds \(sys.bounds(window: host.window).map(r) ?? "unread")" + (host.askedFullScreenAt.map { ", \(ms(since: $0)) ms after it was last asked into full screen" } ?? "")
            // (Read again now, after whatever ran since the poll's read: both where they should be, nothing to do. An
            // operation in between put it right, or the poll's one read of it in no Space was the bridge's move landing.)
            let marginNow = marginWindow == 0 || sys.spaces(window: marginWindow).map { $0.contains(marginSpace) } ?? true
            if marginNow, spaces == [marginSpace] { return }
            guard marginHere, marginNow else {
                Diagnostics.note("host: \(id): shown, found where it mustn't be (\(seen))")
                return await parkShownNow(why: "its window left Margin's Space, or Margin's window did")
            }
            host.returns = host.returns.filter { sys.now() - $0 < options.returnsWithin } + [sys.now()]
            guard host.returns.count <= options.returnsMax else {
                Diagnostics.note("host: \(id): shown, out of Margin's Space again (\(seen)), \(host.returns.count) times in \(Int(options.returnsWithin)) s: parked")
                host.returns = []
                return await parkShownNow(why: "its window keeps leaving Margin's Space")
            }
            guard guarded(host, "put back") else { return }
            Diagnostics.note("host: \(id): shown, found out of Margin's Space (\(seen)): brought back")
            await bringBack(host, from: spaces ?? [])
        }
    }

    // The one shown, found outside Margin's Space while Margin's window is in it: moved back in (the bridge, as a
    // switch does), a full-screen Space of its own it was found in destroyed (never one of the person's: only one its
    // app owns or the engine made), and kept shown, with no unshown and no launcher in between. No longer at the frame
    // it was placed at (it left full screen on its own): placed again behind the loader, as a moved page area does.
    // Not back in Margin's Space: parked with nothing shown, as before.
    private func bringBack(_ host: Host, from spaces: [UInt64]) async {
        let t0 = sys.now()
        let owners = sys.fullScreenSpaceOwners() ?? [:]
        let own = spaces.filter { $0 != marginSpace && sys.spaceType($0) == ManagedSpace.fullScreenType && (ownSpaces.contains($0) || owners[$0] == host.pid) }
        if sys.currentSpace(onDisplayOf: marginSpace) != marginSpace, own.contains(where: { sys.currentSpace(onDisplayOf: marginSpace) == $0 }) { _ = sys.setCurrentSpace(marginSpace) }
        if await tileBack(host, from: own, since: t0) { return }
        guard sys.move(window: host.window, to: marginSpace),
              await wait(options.memberWait, every: options.memberEvery, { self.sys.spaces(window: host.window) == [self.marginSpace] }) else {
            // In no Space at all and the bridge doesn't put it back: out of full screen and placed again (what the early
            // path's own fallback did on the real Mac, 2026-11-17), behind the loader. Else parked, nothing shown.
            guard spaces.isEmpty, host.mode != .window else { return await parkShownNow(why: "its window left Margin's Space and didn't come back into it") }
            Diagnostics.note("host: \(host.id): in no Space and not put back by a move: out of full screen and placed again")
            let frozen = holdFreeze()
            await backOut(host)
            releaseFreeze(frozen)
            host.phase = .preparing
            if case .failed = await placeFullScreen(host, isNew: false, retrying: false), shown != host.id { emit(.unshown(host.id)) }
            return
        }
        for space in own where sys.spaceExists(space) == true {
            ownSpaces.insert(space)
            if await !destroyOwn(space) { leftSpaces.insert(space) }
        }
        if !own.isEmpty { _ = await settleMember(host) }
        saveMarker()
        let bounds = sys.bounds(window: host.window)
        let inPlace = host.mode == .window || (host.placedPage.flatMap { p in bounds.map { HostLayout.near($0, p, within: options.tolerance) } } ?? false)
        Diagnostics.note("host: \(host.id) back in Margin's Space in \(ms(since: t0)) ms, still shown\(inPlace ? "" : " (its bounds \(bounds.map(r) ?? "unread"), not the frame it was placed at: placed again)")")
        // (Margin's window told again: the hole follows its bounds as they are now.)
        hostedSaid = nil
        announceHosted()
        if !inPlace, host.mode != .window {
            // (No longer the full-screen member it was: placed as a window that isn't in full screen yet.)
            host.member = false
            host.placedPage = nil
            if shown == host.id { shown = nil }
            host.phase = .preparing
            if case .failed = await placeFullScreen(host, isNew: false, retrying: false), shown != host.id { emit(.unshown(host.id)) }
        }
        checkListed("after \(host.id) was brought back")
    }

    // The poll's on-screen look found the one shown, or Margin's own window, missing from the window server's on-screen
    // list though Margin's Space reads as the current one (`lookOnScreen`). Read again now (the list, and the hosted
    // window's own read); still missing: what the window server says is logged (each display's current Space, both
    // windows' Spaces, the hosted window's own flag and alpha), then:
    // - Margin's own window on screen, Margin's Space the current one and the hosted window in it alone: it's in the
    //   Space that's showing, so neither a Space made current nor a move can bring it (2026-11-17 14:05: the Phone's
    //   window-mode window, ordered out by its app, and Margin made its own, current Space current again and moved the
    //   window into the Space it was in, three times in 2 s). Nothing is moved and no Space changed: a window-mode window
    //   is raised once (its app's own order), a full-screen member is placed again behind the loader. Once per show.
    // - otherwise (Margin's own window off screen too, or the display on another Space, or the window out of Margin's
    //   Space): Margin's Space made current again only if it isn't (or Margin's window isn't on screen: the display shows
    //   a Space that's gone though it reads Margin's), the hosted window moved into it only if it isn't there alone (or
    //   Margin's window isn't on screen). Not on screen by that: out of full screen and placed again behind the loader
    //   (what brought it back on the real Mac, 2026-11-17). `returnsMax` times in `returnsWithin` at most, then left as it
    //   is, said once.
    private func backOnScreen(_ id: HostID) async {
        guard let host = hosts[id], host.phase == .shown, shown == id, let look = screenLook(sys.onScreenWindows()), !(look.margin && look.host) else { return }
        let own = sys.windowOnScreen(host.window)
        if look.margin, let own, own.onScreen, own.alpha > 0 { return }
        let spaces = sys.spaces(window: host.window)
        let current = sys.currentSpace(onDisplayOf: marginSpace)
        let seen = "Margin's window \(look.margin ? "on" : "off") screen, its window \(host.window) \(look.host ? "on" : "off") screen and in \(spaces.map { "\($0)" } ?? "Spaces that don't read")"
            + (own.map { ", by its own read \($0.onScreen ? "on" : "off") screen at alpha \(String(format: "%.2f", $0.alpha))" } ?? "")
            + ", Margin's Space \(marginSpace), its window in \(sys.spaces(window: marginWindow).map { "\($0)" } ?? "Spaces that don't read")"
            + ", the displays' current Spaces \(sys.currentSpaces().map { $0.joined(separator: ", ") } ?? "unread")"
            + (host.askedFullScreenAt.map { ", \(ms(since: $0)) ms after it was last asked into full screen" } ?? "")
        offTries = offTries.filter { sys.now() - $0 < options.returnsWithin }
        if look.margin, current == marginSpace, spaces == [marginSpace] {
            guard offActedFor != shownAt, offTries.count < options.returnsMax else {
                if offInPlaceSaid != shownAt { offInPlaceSaid = shownAt; Diagnostics.note("host: \(id): shown, still not on screen in Margin's Space (\(seen)): left as it is until it's shown again") }
                return
            }
            offActedFor = shownAt
            offTries.append(sys.now())
            // (Its app's own first, the reconciler's rungs not tried yet this show: an app that ordered its window out
            // orders it in again at its activation or its reopen (ordersOut after: placing it again only took it out of
            // full screen and back, again and again). Then placed again: macOS's own change that left it undrawn.)
            Diagnostics.note("host: \(id): shown, not on screen though it's in Margin's Space, the current one (\(seen)): no Space made current, nothing moved; its app brought forward first, out of full screen and placed again if that doesn't bring it")
            for rung in HostForward.allCases where (host.tries[HostCorrection.bringForward(rung).key] ?? []).filter({ sys.now() - $0 < options.budgetWithin }).isEmpty {
                host.tries[HostCorrection.bringForward(rung).key, default: []].append(sys.now())
                await bringForward(host, rung)
                if sys.windowOnScreen(host.window).map({ $0.onScreen && $0.alpha > 0 }) == true { hostedSaid = nil; return announceHosted() }
            }
            let frozen = holdFreeze()
            await backOut(host)
            releaseFreeze(frozen)
            host.phase = .preparing
            if case .failed = await placeFullScreen(host, isNew: false, retrying: false), shown != host.id { emit(.unshown(host.id)) }
            return
        }
        guard offTries.count < options.returnsMax else {
            if !offSaid { offSaid = true; Diagnostics.warn("host: \(id): shown, not on screen (\(seen)), \(offTries.count) times in \(Int(options.returnsWithin)) s: left as it is") }
            return
        }
        offTries.append(sys.now())
        let t0 = sys.now()
        let makeCurrent = current != marginSpace || !look.margin
        let moveIn = !look.host && (spaces != [marginSpace] || !look.margin)
        Diagnostics.note("host: \(id): shown, not on screen (\(seen)): \([makeCurrent ? "Margin's Space made current again" : nil, moveIn ? "its window moved into it again" : nil].compactMap { $0 }.joined(separator: ", "))")
        if makeCurrent { _ = sys.setCurrentSpace(marginSpace) }
        if moveIn { _ = sys.move(window: host.window, to: marginSpace) }
        let back = await wait(options.memberWait, every: options.memberEvery) { self.screenLook(self.sys.onScreenWindows()).map { $0.margin && $0.host } ?? true }
        if back {
            Diagnostics.note("host: \(id) on screen again in \(ms(since: t0)) ms, still shown")
            hostedSaid = nil
            return announceHosted()
        }
        guard host.mode != .window else { return Diagnostics.note("host: \(id): still not on screen after that") }
        Diagnostics.note("host: \(id): still not on screen after that: out of full screen and placed again")
        let frozen = holdFreeze()
        await backOut(host)
        releaseFreeze(frozen)
        host.phase = .preparing
        if case .failed = await placeFullScreen(host, isNew: false, retrying: false), shown != host.id { emit(.unshown(host.id)) }
    }

    // The one shown before, out of Margin's Space: a member parked as it is (still full screen); a window its frame
    // given back first, then parked.
    private func retire(_ host: Host) async -> Bool {
        if host.mode == .window { return await retireWindow(host) }
        if host.member { return await parkMember(host) }
        await backOut(host) // (not a member yet: nothing of it in Margin's Space)
        await park(host)
        return true
    }

    // A step failed while showing `host`: it leaves full screen (its Space goes with it), an emptied Space of its is
    // destroyed; a new one is closed again, one shown before is parked again. `previous`: the one shown before, already
    // parked by this show: shown again.
    private func giveUp(_ host: Host, isNew: Bool, _ step: HostStep, _ reason: String, previous: Host?) async -> HostResult {
        let result = fail(host.id, step, reason)
        let frozen = host.member && !viaCopy(host) ? holdFreeze() : false
        await backOut(host)
        releaseFreeze(frozen)
        if isNew { await closeNow(host.id, why: "its open failed") } else { await park(host) }
        if let previous, previous.phase == .parked, shown == nil, hosts[previous.id] != nil {
            Diagnostics.note("host: \(previous.id) shown again after \(host.id)'s show failed")
            _ = await bringIn(previous, isNew: false, retrying: true)
        }
        return result
    }

    // Out of full screen, wherever it is (a member on the current Space by Accessibility, or anywhere through its
    // copy), and no Space of its left behind.
    private func backOut(_ host: Host) async {
        let own = host.fullScreenSpace
        let copy = viaCopy(host)
        if host.member {
            _ = await leaveMember(host)
        } else if !copy, let own, sys.spaces(window: host.window)?.contains(own) == true, await isFullScreen(host) == nil {
            // (In its own full-screen Space, not the current one, never read there by Accessibility: a window that came up
            // full screen. Out of it on the current Space, where Accessibility acts, as a member would be.)
            _ = await leaveMember(host)
        } else if await isFullScreen(host) == true || (copy && own != nil) {
            _ = await setFullScreen(host, false)
            _ = await wait(options.exitWait) {
                let full = await self.isFullScreen(host)
                // (Through the copy, out of a private Space: in no Space at all it doesn't read; a normal window is one on
                // a Desktop, read by the window server.)
                return copy && host.privateSpace != nil ? full != true : full == false
            }
        }
        if let own, sys.spaceExists(own) == true, await !destroyOwn(own) { leftSpaces.insert(own) }
        host.fullScreenSpace = nil
        host.member = false
        host.placedPage = nil
        if shown == host.id { shown = nil }
        saveMarker()
    }

    // Out of sight in a private Space (not in Mission Control); a window-mode one's frame given back first (while it's
    // on the current Space).
    private func park(_ host: Host) async {
        if host.mode == .window { await restoreFrame(host) }
        if host.privateSpace == nil { _ = await parkMember(host, emitting: false) }
        host.phase = .parked
        if shown == host.id { shown = nil }
        saveMarker()
    }

    // ---- closing ----

    // Given back: out of full screen (a member on the current Space by Accessibility, under the freeze: it's seen; a
    // Safari window parked first and out through its copy, unseen), a window-mode one its frame as it was, the windows
    // of the person's apps and window-mode ones back in their Space, then an app Margin started quit (after its frame
    // is back, so it saves that one; its window closed first when that's harmless: `closesFirst`); an app the person
    // opened is never quit. Not waiting for its exit (`.watched`: a row closed; `.atQuit`: Margin quits, every host at
    // once): the app is asked to quit once, so its window is never left in a private Space (no one takes it out if the
    // app doesn't quit) but on its Desktop; at Margin's quit what isn't done is kept for the marker (`leftWindows`).
    // `.waited` (a failed open): its exit waited for. Each step's time is in the log line.
    enum CloseExit { case waited, watched, atQuit }
    private func closeNow(_ id: HostID, why: String, exit: CloseExit = .waited) async {
        guard let host = hosts[id] else { return }
        let atQuit = exit == .atQuit, waits = exit == .waited
        let started = sys.now()
        var times: [String] = []
        var t0 = started
        func step(_ name: String) { times.append("\(name) \(ms(since: t0))"); t0 = sys.now() }
        let seen = (host.phase == .shown && host.mode == .window) || (host.mode == .window && host.frameChanged) || (host.member && !viaCopy(host))
        let frozen = seen ? holdFreeze() : false
        defer { releaseFreeze(frozen) }
        if host.mode == .window {
            await restoreFrame(host)
            step("frame")
            if shown == id { shown = nil }
        } else if !viaCopy(host), host.member || host.phase == .shown || host.fullScreenSpace != nil {
            await backOut(host)
            step("out of full screen")
        } else if viaCopy(host), host.fullScreenSpace != nil {
            await backOut(host) // (a Safari window Margin asked for, mid-way in its own Space; a member: toNormal below)
            step("out of full screen")
        }
        if shown == id { shown = nil }
        let sharesApp = hosts.values.contains { $0.id != id && $0.pid == host.pid }
        let quits = host.launchedByMargin && !sharesApp
        let anApp: Bool = { if case .app = host.target { return true }; return false }()
        // Its window closed first (its frame back already), when that's harmless (`closesFirst`). Closed, there's nothing
        // to take home; not closed, it goes home as any.
        let tries = quits && anApp && host.safariWindow == nil && closesFirst(host)
        let closed = tries ? await closeBeforeQuit(host) : false
        if tries { step(closed ? "closed" : "close tried") }
        if !closed, host.mode == .window || host.personApp {
            await returnHome(host)
            step("home")
        }
        if quits, !closed, anApp, host.safariWindow == nil {
            let inMargin = sys.spaces(window: host.window)?.contains(marginSpace) == true
            if !waits, inMargin || host.privateSpace != nil {
                // Not waiting for the app (a row closed, Margin quits): on its Desktop before it's asked, out of Margin's
                // Spaces; one that doesn't quit (unsaved work) is the person's there. (A private Space is destroyed below, or
                // goes with Margin, and its window with it.)
                host.away = true
                await returnHome(host)
                step("home")
            } else if waits, inMargin, host.privateSpace == nil {
                // An app Margin quits whose window is still in Margin's Space (taken in to be read, its open failed): out of
                // sight in a private Space until its quit is done, never standing on its own over Margin meanwhile (seen
                // 2026-11-15: Dictionary's window over Margin while it quit). One that doesn't quit goes to the Desktop then.
                if await parkMember(host, emitting: false) { Diagnostics.note("host: \(id): its window out of sight before its quit") }
            }
        }
        if let ext = host.safariWindow {
            // A window a copy made for Margin: a normal window first (a member parked and out of full screen through its
            // copy, then out of its private Space onto the Desktop), then closed by that copy and confirmed (before its
            // Safari is quit, if Margin started it: a window closed isn't one Safari restores). Seen 2026-11-15: asked to
            // close while still parked or full screen, it wasn't.
            await toNormal(host)
            step("normal")
            let closed = await closeAskedSafariWindow(ext, profile: host.profile, pid: host.pid, number: host.window, why: why)
            step(closed ? "closed by its copy" : "not closed by its copy")
            if !closed, !quits || !waits, host.privateSpace != nil, let desktop = sys.desktop(onDisplayOf: marginSpace) {
                _ = sys.move(window: host.window, to: desktop) // not closed yet: on the Desktop meanwhile, closed later
                Diagnostics.note("host: \(id): Safari's window wasn't closed by its extension: on the Desktop until its copy closes it")
            }
        } else if host.madeByMargin || (isSafari(host) && sharesApp) {
            if host.privateSpace != nil, let desktop = sys.desktop(onDisplayOf: marginSpace) {
                _ = sys.move(window: host.window, to: desktop) // not Margin's to close: left to the person, on the Desktop
                Diagnostics.note("host: \(id): Safari's window isn't one a copy made for Margin: left on the Desktop")
            }
        }
        // (Its app's leftovers and strips the reconciler parked: on its Desktop before its app is asked to quit, so one that
        // doesn't quit leaves them where the person finds them.)
        if !sharesApp { await releaseOthers(host.pid) }
        if quits {
            let bundle = sys.app(pid: host.pid)?.bundleId ?? id.raw
            switch exit {
            case .atQuit: askQuit(host.pid, bundle: bundle); step("asked to quit")
            case .watched: askQuitWatched(host.pid, bundle: bundle, id: id); step("asked to quit")
            case .waited: await quitApp(host.pid, bundle: bundle, parked: host); step("quit")
            }
        }
        if atQuit, let left = unfinished(host) { leftWindows.append(left) }
        if let priv = host.privateSpace { retirePrivate(priv) }
        hosts[id] = nil
        if !hosts.values.contains(where: { $0.pid == host.pid }) { sys.stopWatchingOpens(pid: host.pid) }
        saveMarker()
        Diagnostics.note("host: \(id) closed (\(why)) in \(ms(since: started)) ms\(times.isEmpty ? "" : " (" + times.joined(separator: ", ") + ")")")
        emit(.closed(id))
    }

    // What Margin's quit couldn't finish for this host, for the marker (nil: done): its frame not given back, its exit
    // from full screen not confirmed, or its window (still open) left in Margin's Space or a private Space. The next launch's recovery finishes it while that
    // app (the person's, or one of Margin's that didn't quit) still runs.
    private func unfinished(_ host: Host) -> HostMarker.Window? {
        guard sys.bounds(window: host.window) != nil else { return nil } // (closed, or gone with its app)
        let spaces = sys.spaces(window: host.window)
        let stranded = host.privateSpace != nil || spaces?.contains(marginSpace) == true
        let stillFull = host.exitUnconfirmed && !viaCopy(host)
        guard (host.frameChanged && (host.mode == .window || host.personApp)) || ((stranded || stillFull) && host.safariWindow == nil) else { return nil }
        var w = markerWindow(host)
        w.privateSpace = nil // (destroyed as Margin quits)
        if stillFull { w.member = true } // (the next launch takes it out of full screen on the current Space)
        return w
    }

    // A Safari window Margin made, back to a normal window before its copy closes it: a member parked first (its exit
    // isn't seen) and taken out of full screen by its copy there, then out of its private Space onto its display's
    // Desktop; one still in full screen elsewhere out of it there, waited for until the window server has it on a Desktop.
    private func toNormal(_ host: Host) async {
        if host.member {
            if host.phase == .shown { _ = await parkMember(host, emitting: false) }
            _ = await leaveMember(host)
        }
        if host.privateSpace != nil { _ = await unpark(host) }
        guard await isFullScreen(host) == true else { return }
        _ = await setFullScreen(host, false)
        _ = await wait(options.exitWait) { await self.isFullScreen(host) == false }
    }

    // Whether an app Margin started has its hosted window closed (its close button) before it's asked to quit: whenever
    // that's harmless for its next launch, decided by what the app does, not by what kind of app it is: an app that
    // doesn't keep its windows across a quit (macOS's default, "Close windows when quitting an application") discards
    // that window at the quit anyway, so closing it first changes nothing it reopens; one that keeps them (the person's
    // setting, or the app's own) would lose the window it reopens: never closed, taken home instead. Closing first is
    // what makes an iPad (UIKit) app's quit fast: its quit hides its windows first and, started with no Dock icon, waits
    // out its own 5 s watchdog while one is ordered in on any Space (FaceTime, 2026-11-15; Phone closed first: out in
    // 0.75 s, 2026-11-15 21:25). Not for a window Accessibility didn't take a frame for (it wouldn't press its button).
    private func closesFirst(_ host: Host) -> Bool {
        !host.axRefused && !sys.keepsWindowsAtQuit(pid: host.pid)
    }

    // A window of an app Margin started (never the person's) closed before Margin quits that app, its frame back first
    // (closing saves it as it is). Accessibility presses its close button on the current Space (where it reads windows):
    // a window elsewhere is brought there first, under the freeze, and pressed again a moment (`closePressWait`: listed
    // late); one already there is pressed once. Gone by the window server's reading within `closeWait`: true.
    private func closeBeforeQuit(_ host: Host) async -> Bool {
        let t0 = sys.now()
        let frozen = holdFreeze()
        defer { releaseFreeze(frozen) }
        guard let current = sys.currentSpace(onDisplayOf: host.originalSpace ?? marginSpace) else { return false }
        var brought = false
        if sys.spaces(window: host.window)?.contains(current) != true {
            host.away = true
            guard sys.move(window: host.window, to: current), await wait(options.parkWait, every: options.memberEvery, { self.sys.spaces(window: host.window)?.contains(current) == true }) else {
                Diagnostics.note("host: \(host.id): its window didn't come to the current Space to be closed: quit with it open")
                return false
            }
            if let priv = host.privateSpace { retirePrivate(priv); host.privateSpace = nil }
            brought = true
            saveMarker()
        }
        let pressed = await wait(brought ? options.closePressWait : 0, every: options.lookEvery) { await self.sys.close(pid: host.pid, window: host.window) }
        guard pressed, await wait(options.closeWait, every: options.lookEvery, { self.sys.bounds(window: host.window) == nil }) else {
            Diagnostics.note("host: \(host.id): its window didn't close by its close button in \(ms(since: t0)) ms (\(pressed ? "pressed" : "not pressed")): quit with it open")
            return false
        }
        host.away = false
        saveMarker()
        Diagnostics.note("host: \(host.id): its window closed before its quit in \(ms(since: t0)) ms")
        return true
    }

    // Margin quits: an app Margin started asked to quit (politely, once), not waited for: it finishes on its own (an iPad
    // app's own watchdog can take 5 s). Its window is where it belongs already. Still running as Margin's quit ends: in
    // the marker (`quitAsked`), asked again by the next launch if that same launch still runs.
    private func askQuit(_ pid: pid_t, bundle: String) {
        guard sys.app(pid: pid) != nil else {
            // (2026-11-17 real-apps: the Safari Margin started got no quit Apple event at Margin's quit and ran on, and
            // the quit's "still quitting" list didn't name it: its ask was skipped here or its entry gone before.)
            if sys.processRuns(pid: pid) { Diagnostics.warn("host: \(bundle) (pid \(pid)) not asked to quit: its process runs, NSWorkspace lists no app for it") }
            launched[pid] = nil; saveMarker(); return
        }
        quitAsked.insert(pid)
        if !sys.terminate(pid: pid) { Diagnostics.warn("host: \(bundle) (pid \(pid)) wasn't asked to quit (the system refused the ask)") }
        saveMarker()
    }

    // A row closed (Margin keeps running): an app Margin started asked to quit once (never forced) and forgotten at
    // once, so the close and whatever comes after it never wait for its exit (Maps holds its quit 5 s, its own watchdog).
    // Its exit is heard in the background (`appQuit`, NSWorkspace's termination notice), which takes it out of the
    // marker. One still running `quitWait` after the ask didn't quit (unsaved work): Margin's again (`takeBack`), seen
    // by the poll, an open of that app, or Margin's quit, whichever comes first. An open of the same app meanwhile
    // waits for that exit (`awaitExits`): the dying instance is never hosted.
    private func askQuitWatched(_ pid: pid_t, bundle: String, id: HostID) {
        guard let now = sys.app(pid: pid) else { launched[pid] = nil; leftSafariWindows.removeAll { $0.pid == pid }; saveMarker(); return }
        exiting[pid] = Exiting(app: launched.removeValue(forKey: pid) ?? now, id: id, askedAt: sys.now())
        if !sys.terminate(pid: pid) { Diagnostics.warn("host: \(bundle) (pid \(pid)) wasn't asked to quit (the system refused the ask)") }
        saveMarker()
    }

    // Heard: an app asked to quit by its row's close is gone. Out of the marker.
    private func exited(_ pid: pid_t) {
        guard let entry = exiting.removeValue(forKey: pid) else { return }
        leftSafariWindows.removeAll { $0.pid == pid } // its windows went with it
        Diagnostics.note("host: \(entry.app.bundleId) (pid \(pid)) quit \(ms(since: entry.askedAt)) ms after its row's close asked it")
        saveMarker()
    }

    // An app a row's close asked to quit, `quitWait` later: still that same launch running, it didn't quit: Margin's
    // again (an open reuses it, Margin's quit asks it again), said with what can be read of why. Gone unheard: forgotten.
    // Nil: nothing taken back.
    private func takeBack(_ pid: pid_t) -> Exiting? {
        guard let entry = exiting[pid] else { return nil }
        guard let now = sys.app(pid: pid), now.bundleId == entry.app.bundleId, now.launchedAt == entry.app.launchedAt else { exited(pid); return nil }
        exiting[pid] = nil
        launched[pid] = entry.app
        saveMarker()
        emit(.failed(entry.id, .quit, "didn't quit"))
        return entry
    }
    private func sayNotQuit(_ entry: Exiting) async {
        Diagnostics.warn("host: \(entry.app.bundleId) (pid \(entry.app.pid)) didn't quit within \(Int(options.quitWait)) s (\(await whyNotQuit(entry.app.pid, hosted: nil))): left running, its window on the Desktop")
    }
    private func overdue() -> [pid_t] { exiting.filter { sys.now() - $0.value.askedAt >= options.quitWait }.map(\.key).sorted() }

    // An open (or start) of an app whose last instance a row's close asked to quit and is still finishing: waits for
    // that exit (heard, or until `quitWait` after the ask: then it's Margin's again, reused), so the dying instance is
    // never hosted, nor taken for the person's. Nil: nothing to wait for; else the ms waited.
    private func awaitExits(of bundle: String) async -> Int? {
        let dying = exiting.filter { $0.value.app.bundleId == bundle }.map(\.key).sorted()
        guard !dying.isEmpty else { return nil }
        let t0 = sys.now()
        for pid in dying {
            guard let entry = exiting[pid] else { continue }
            _ = await wait(max(0, entry.askedAt + options.quitWait - sys.now())) {
                if self.exiting[pid] != nil, !self.sys.processRuns(pid: pid) { self.exited(pid) } // (its notice not heard yet)
                return self.exiting[pid] == nil
            }
            if let back = takeBack(pid) { await sayNotQuit(back) }
        }
        return ms(since: t0)
    }

    // An app Margin started, quit (politely): once gone it's forgotten. One that doesn't quit (it may be asking about
    // unsaved work) has its window put on the Desktop for the person.
    private func quitApp(_ pid: pid_t, bundle: String, parked: Host? = nil) async {
        guard sys.app(pid: pid) != nil else { launched[pid] = nil; saveMarker(); return }
        quitAsked.insert(pid)
        _ = sys.terminate(pid: pid)
        if await wait(options.quitWait, { !self.sys.processRuns(pid: pid) }) {
            launched[pid] = nil
            leftSafariWindows.removeAll { $0.pid == pid } // its windows went with it
        } else {
            if let parked, parked.privateSpace != nil, let desktop = sys.desktop(onDisplayOf: marginSpace) { _ = sys.move(window: parked.window, to: desktop) }
            Diagnostics.warn("host: \(bundle) (pid \(pid)) didn't quit within \(Int(options.quitWait)) s (\(await whyNotQuit(pid, hosted: parked))): left running, its window on the Desktop")
            emit(.failed(parked?.id ?? HostID(raw: "app:" + bundle), .quit, "didn't quit"))
        }
        saveMarker()
    }

    // Why an app asked to quit is still running, as far as can be read (numbers and kinds only): its type now (promoted
    // to a Dock app, or still none), windows of its own on screen that aren't the hosted one (a sheet or an alert: it may
    // be asking about unsaved work), and whether Accessibility still answers for it (no: it's busy or hung).
    private func whyNotQuit(_ pid: pid_t, hosted: Host?) async -> String {
        var parts: [String] = []
        switch sys.policy(pid: pid) {
        case .regular?: parts.append("a normal app with a Dock icon now\(hosted?.promoted == true ? " (promoted while hosted)" : "")")
        case .accessory?: parts.append("still no Dock icon")
        case .prohibited?: parts.append("a background app")
        case nil: parts.append("its type doesn't read")
        }
        let others = (serverList(pid: pid) ?? []).filter { $0.alpha > 0 && $0.number != hosted?.window && $0.onScreen }
        parts.append(others.isEmpty ? "no other window of its own on screen" : "\(others.count) other window\(others.count == 1 ? "" : "s") of its own on screen (it may be asking something)")
        parts.append(await sys.windows(pid: pid) == nil ? "Accessibility doesn't answer for it (busy, or quitting slowly)" : "Accessibility still answers for it")
        return parts.joined(separator: "; ")
    }

    // ---- Safari windows Margin asked for ----

    // A Safari window a copy made for Margin, closed by that copy; confirmed by the window server when its number is
    // known. Not confirmed: kept in the marker (`leftSafariWindows`) and closed later. True: closed.
    @discardableResult private func closeAskedSafariWindow(_ ext: Int, profile: String?, pid: pid_t, number: Int?, why: String) async -> Bool {
        var closed = false
        // The copy's word that it's gone from Safari's windows is the confirmation (HostedSession.closeSafariWindow): the
        // window server keeps a closed Safari window's number for a while, so it can't confirm it.
        if let closer = closeSafariWindow, await closer(profile, ext) {
            closed = true
        }
        leftSafariWindows.removeAll { $0.pid == pid && $0.safariWindow == ext }
        if !closed {
            leftSafariWindows.append(HostMarker.SafariWindow(safariWindow: ext, profile: profile, pid: pid, appLaunchedAt: sys.app(pid: pid)?.launchedAt, number: number))
            Diagnostics.warn("host: Safari window (the copy's \(ext)\(number.map { ", window \($0)" } ?? "")) Margin asked for wasn't closed (\(why)): kept in the marker, closed later")
        } else {
            Diagnostics.note("host: Safari window (the copy's \(ext)) Margin asked for closed by its copy (\(why))")
        }
        saveMarker()
        return closed
    }

    // A window closed: gone from the window server within quitWait (its number unknown: the copy's answer is all).
    private func gone(_ number: Int?) async -> Bool {
        guard let number else { return true }
        return await wait(options.quitWait) { self.sys.bounds(window: number) == nil }
    }

    // The Safari windows whose close wasn't confirmed: each closed by its copy, while it's still that Safari's (the
    // same pid and launch) and its window is there.
    private func closeLeftSafariWindows() async {
        for entry in leftSafariWindows {
            guard let now = sys.app(pid: entry.pid), now.bundleId == options.safariBundle, entry.appLaunchedAt == nil || now.launchedAt == nil || abs((entry.appLaunchedAt ?? 0) - (now.launchedAt ?? 0)) < 2,
                  entry.number.map({ sys.bounds(window: $0) != nil }) ?? true else {
                leftSafariWindows.removeAll { $0 == entry } // gone (with its Safari, or closed by the person)
                continue
            }
            // (A normal window first: Safari doesn't close one in full screen, seen 2026-11-15; a no-op for one that's normal.)
            if let ask = safariFullScreen { _ = await ask(entry.profile, entry.safariWindow, false) }
            guard let closer = closeSafariWindow, await closer(entry.profile, entry.safariWindow) else { continue }
            do { // (the copy's word is the confirmation: closeAskedSafariWindow)
                leftSafariWindows.removeAll { $0 == entry }
                Diagnostics.note("host: a Safari window Margin asked for (the copy's \(entry.safariWindow)) closed later by its copy")
            }
        }
        saveMarker()
    }

    // ---- what the system says ----

    // An app heard as quit (NSWorkspace's termination notice, or its NSRunningApplication gone at a poll): quit only once
    // its process is gone by a second, independent read (`processRuns`: kill(pid, 0)). 2026-11-17, Maps (UIKit's), parked
    // with no window in any user Space, attempted termination and went on running; Margin took it for quit by the person,
    // forgot it had started it, and at its next open hosted the same process as "an app the person opened". Its process
    // still running: nothing changes (still hosted, still Margin's), said once.
    private var quitDoubted: Set<pid_t> = []
    private func appQuit(_ pid: pid_t) {
        if sys.processRuns(pid: pid) {
            let ids = hosts.values.filter { $0.pid == pid }.map(\.id.description).sorted()
            if (!ids.isEmpty || launched[pid] != nil), quitDoubted.insert(pid).inserted {
                Diagnostics.note("host: \(ids.isEmpty ? "pid \(pid)" : ids.joined(separator: ", ")): its app was said to have quit, its process \(pid) still runs: kept\(launched[pid] != nil ? ", still Margin's" : "")")
            }
            return
        }
        quitDoubted.remove(pid)
        exited(pid)
        let gone = hosts.values.filter { $0.pid == pid }
        let wasLaunched = launched.removeValue(forKey: pid) != nil
        guard !gone.isEmpty || wasLaunched else { return }
        if let e = parkedOthers.removeValue(forKey: pid) { retirePrivate(e.space) }
        for host in gone {
            if busy { continue } // the operation running decides (it quit it, or its waits fail)
            if let tile = host.tile { goneTiles.insert(tile) } // (its tile, a placeholder now: destroyed at the next look)
            if let priv = host.privateSpace { retirePrivate(priv) }
            if let own = host.fullScreenSpace, sys.spaceExists(own) == true { leftSpaces.insert(own) }
            hosts[host.id] = nil
            if shown == host.id { shown = nil }
            sys.stopWatchingOpens(pid: pid)
            Diagnostics.note("host: \(host.id) quit, not by Margin")
            emit(.quitByUser(host.id))
        }
        saveMarker()
        if gone.contains(where: { $0.tile != nil }) { lookAtTiles(force: true) } // (its tile out of Margin's Space, or a placeholder: every rect again now)
        checkOrphans("after an app quit")
    }

    private func windowGone(_ host: Host) {
        if let tile = host.tile { goneTiles.insert(tile); host.tile = nil; lookAtTiles(force: true) } // (its placeholder: destroyed now)
        if let priv = host.privateSpace { retirePrivate(priv) }
        if let own = host.fullScreenSpace, sys.spaceExists(own) == true { leftSpaces.insert(own) }
        hosts[host.id] = nil
        if shown == host.id { shown = nil }
        saveMarker()
        Diagnostics.note("host: \(host.id): its window closed (its app still runs)")
        emit(.windowClosed(host.id))
        checkOrphans("after a window closed")
    }

    private func heard(_ code: Int32, pid: pid_t) {
        for host in hosts.values where host.pid == pid {
            switch code {
            case HostCalls.openRequestCode:
                host.outsideOpens += 1
                Diagnostics.note("host: \(host.id): opened from outside (LaunchServices \(code)): kept hosted")
                emit(.outsideOpen(host.id))
            case HostCalls.promotedCode where host.launchedByMargin && !host.promoted:
                // (LaunchServices' 561 says its type changed, not to what: an iPad app quitting makes itself a background
                // app first, seen 2026-11-15 with FaceTime, the Dock saying "App background type did not change". A
                // promotion whose policy reads regular only later is the poll's.)
                switch sys.policy(pid: pid) {
                case .regular?: promote(host, why: "LaunchServices \(code)")
                case let p: Diagnostics.note("host: \(host.id): its type changed (LaunchServices \(code)), now \(p == .prohibited ? "a background app" : p == .accessory ? "still no Dock icon" : "unread")\(quitAsked.contains(pid) ? ", as it quits" : ""): not a Dock app")
                }
            default: break
            }
        }
    }

    private func promote(_ host: Host, why: String) {
        host.promoted = true
        Diagnostics.note("host: \(host.id): now a normal app with a Dock icon (\(why)): kept hosted")
        emit(.promoted(host.id))
    }

    private func checkOrphans(_ when: String) {
        guard let list = sys.ownerlessFullScreenSpaces(), !list.isEmpty else { return }
        Diagnostics.warn("host: \(list.count) ownerless full-screen Space\(list.count == 1 ? "" : "s") \(when): \(list.map(String.init).joined(separator: ", "))")
        emit(.orphans(list))
    }

    // ---- Mission Control ----

    // Outside a first open or a placing again, Mission Control lists Margin's Space only: a hosted window's own
    // full-screen Space still listed after an operation is said (a destroy that didn't take is tried again: leftSpaces).
    private func checkListed(_ when: String) {
        guard let listed = sys.listedFullScreenSpaces() else { return }
        for s in ownSpaces where !listed.contains(s) { ownSpaces.remove(s) }
        let still = listed.filter { ownSpaces.contains($0) && $0 != marginSpace }.sorted()
        guard !still.isEmpty else { return }
        Diagnostics.warn("host: Mission Control still lists \(still.count) Space\(still.count == 1 ? "" : "s") of a hosted window's \(when): \(still.map(String.init).joined(separator: ", "))")
        emit(.listed(still))
    }

    // ---- the crash marker ----

    private func saveMarker() {
        announceHosted()
        guard let markerURL else { return }
        var m = HostMarker(pid: ownPid, marginSpace: hosts.isEmpty && leftWindows.isEmpty && goneTiles.isEmpty && anchorTiles.isEmpty ? nil : marginSpace)
        m.apps = launched.values.sorted { $0.pid < $1.pid }.map {
            HostMarker.App(pid: $0.pid, bundleId: $0.bundleId, launchedAt: $0.launchedAt, quitAsked: quitting && quitAsked.contains($0.pid) ? true : nil)
        } + exiting.values.sorted { $0.app.pid < $1.app.pid }.map { HostMarker.App(pid: $0.app.pid, bundleId: $0.app.bundleId, launchedAt: $0.app.launchedAt, quitAsked: true) }
        m.windows = hosts.values.sorted { $0.window < $1.window }.map(markerWindow) + leftWindows
        m.leftSpaces = leftSpaces.sorted()
        m.leftSafariWindows = leftSafariWindows.isEmpty ? nil : leftSafariWindows
        // (Live resize: Margin's own tile, and tiles of hosts that went still to destroy: the next launch's after a crash.)
        if !hosts.isEmpty || !goneTiles.isEmpty { m.marginTile = marginTile; m.goneTiles = goneTiles.isEmpty ? nil : goneTiles.sorted() }
        // (The anchors: a killed Margin's stay in its Space and keep it listed; its next launch destroys them.)
        if !anchorTiles.isEmpty { m.anchors = anchorTiles; m.marginTile = marginTile }
        if m.isEmpty { try? FileManager.default.removeItem(at: markerURL); return }
        if !m.write(markerURL) { Diagnostics.warn("host: the crash marker wasn't written") }
    }

    // A host as the marker has it: what giving its window back needs after a crash.
    private func markerWindow(_ h: Host) -> HostMarker.Window {
        var w = HostMarker.Window(number: h.window, pid: h.pid, ownSafariWindow: h.madeByMargin, privateSpace: h.privateSpace, fullScreenSpace: h.fullScreenSpace,
                                  safariWindow: h.safariWindow, profile: h.profile, appLaunchedAt: h.safariWindow == nil ? nil : sys.app(pid: h.pid)?.launchedAt)
        if h.mode == .window || h.personApp {
            w.mode = h.mode
            w.bundleId = h.bundleId
            w.personApp = h.personApp
            w.appLaunchedAt = h.appLaunchedAt
            w.frame = h.original
            w.frameChanged = h.frameChanged
            w.resizable = h.resizable
        }
        if h.mode == .window || h.personApp || h.member { w.originalSpace = h.originalSpace }
        if h.member { w.member = true }
        w.tile = h.tile
        return w
    }

    private func recoverNow() async {
        guard let markerURL, let m = HostMarker.read(markerURL) else { return }
        if m.pid != ownPid, let other = sys.app(pid: m.pid), other.bundleId == Bundle.main.bundleIdentifier { return } // another Margin's, running
        let started = sys.now()
        func same(_ a: HostMarker.App) -> Bool {
            guard let now = sys.app(pid: a.pid), now.bundleId == a.bundleId else { return false }
            guard let then = a.launchedAt, let at = now.launchedAt else { return a.launchedAt == nil }
            return abs(then - at) < 2
        }
        let alive = m.apps.filter(same)
        let alivePids = Set(alive.map(\.pid))
        // That Safari still running, the same launch (a pid used again by another Safari isn't it).
        func sameSafari(_ pid: Int32, _ launchedAt: Double?) -> Bool {
            guard let now = sys.app(pid: pid), now.bundleId == options.safariBundle else { return false }
            guard let then = launchedAt, let at = now.launchedAt else { return true }
            return abs(then - at) < 2
        }
        // An app the person opened, still that launch (a pid used again by another app or launch isn't it).
        func samePerson(_ w: HostMarker.Window) -> Bool {
            guard w.personApp == true, let bundle = w.bundleId, let now = sys.app(pid: w.pid), now.bundleId == bundle else { return false }
            guard let then = w.appLaunchedAt, let at = now.launchedAt else { return true }
            return abs(then - at) < 2
        }
        // The Space showing on that window's display (Accessibility acts only there).
        func current(_ w: HostMarker.Window) -> UInt64? {
            for s in [m.marginSpace, w.originalSpace, w.fullScreenSpace].compactMap({ $0 }) {
                if let c = sys.currentSpace(onDisplayOf: s) { return c }
            }
            return nil
        }
        var outOfFullScreen = 0, givenBack = 0
        for w in m.windows {
            let person = samePerson(w)
            let safariMade = w.safariWindow != nil && !alivePids.contains(w.pid) && sameSafari(w.pid, w.appLaunchedAt)
            let ours = alivePids.contains(w.pid) || (w.ownSafariWindow && sameSafari(w.pid, w.appLaunchedAt)) || person
            if ours, w.mode != .window, !safariMade {
                // A member (or a window mid-way in its own Space): on the current Space first, where Accessibility acts.
                if let cur = current(w), sys.spaces(window: w.number)?.contains(cur) != true, w.member == true || w.privateSpace != nil || sys.spaces(window: w.number) == [] {
                    if sys.move(window: w.number, to: cur) { _ = await wait(options.parkWait) { self.sys.spaces(window: w.number)?.contains(cur) == true } }
                }
                if await sys.isFullScreen(pid: w.pid, window: w.number) == true {
                    _ = await sys.setFullScreen(pid: w.pid, window: w.number, false)
                    if await wait(options.exitWait, { await self.sys.isFullScreen(pid: w.pid, window: w.number) == false }) { outOfFullScreen += 1 }
                }
            }
            // A window-mode window, or the person's own: back in its Space, its frame as it was (before its app is quit
            // below, if Margin started it, so the app saves that frame).
            if ours, w.mode == .window || person, await giveBack(w, marginSpace: m.marginSpace) { givenBack += 1 }
            if w.ownSafariWindow, sameSafari(w.pid, w.appLaunchedAt), w.privateSpace != nil || sys.spaces(window: w.number) == [],
               let space = m.marginSpace ?? w.fullScreenSpace ?? m.leftSpaces.first, let desktop = sys.desktop(onDisplayOf: space) {
                _ = sys.move(window: w.number, to: desktop) // in no Space: on the Desktop until its copy closes it (normal first)
            }
            // A window a copy made for Margin in a Safari that keeps running: made normal and closed by that copy once it links.
            if let ext = w.safariWindow, safariMade {
                leftSafariWindows.append(HostMarker.SafariWindow(safariWindow: ext, profile: w.profile, pid: w.pid, appLaunchedAt: w.appLaunchedAt, number: w.number))
            }
        }
        for entry in m.leftSafariWindows ?? [] where !alivePids.contains(entry.pid) && sameSafari(entry.pid, entry.appLaunchedAt) && !leftSafariWindows.contains(entry) {
            leftSafariWindows.append(entry)
        }
        // Asked all at once, then their exits waited for together (one wait, not one per app).
        for a in alive { _ = sys.terminate(pid: a.pid) }
        _ = await wait(options.quitWait) { alive.allSatisfy { self.sys.app(pid: $0.pid) == nil } }
        let quit = alive.filter { sys.app(pid: $0.pid) == nil }.count
        for w in m.windows { if let p = w.privateSpace { _ = sys.destroyPrivateSpace(p) } }
        // Live resize: hosted tiles left in Margin's old Space destroyed (a placeholder of an app that went with Margin, a
        // tile its window left), never one a window of the marker's is still in (its exit not confirmed: the person's to
        // see), so that Space is empty and goes below. Margin's own tile went with its process.
        // (Margin's own tile too: a killed Margin's stays in its old Space with no window, which keeps that Space from being
        // empty and ownerless: the real Mac, 2026-11-18 01:15, its old Space left listed.)
        let tileIds = Set(m.windows.compactMap(\.tile) + (m.goneTiles ?? []) + (m.anchors ?? []) + [m.marginTile].compactMap { $0 })
        var tilesDestroyed = 0
        if let old = m.marginSpace, !tileIds.isEmpty, sys.spaceExists(old) == true {
            let stillIn = Set(m.windows.filter { sys.bounds(window: $0.number) != nil && sys.spaces(window: $0.number)?.contains(old) == true }.map(\.number))
            let left = (sys.tiles(of: old) ?? []).filter { t in tileIds.contains(t) && !(sys.tileWindow(t).map { stillIn.contains($0) } ?? false) }
            for t in left where sys.destroyTile(t) { tilesDestroyed += 1 }
            if !left.isEmpty { _ = await wait(options.destroyWait) { !(self.sys.tiles(of: old) ?? []).contains(where: { left.contains($0) }) } }
        }
        // The hosted windows' own Spaces left, and Margin's old Space if nothing owns it any more.
        let ownerless = Set(sys.ownerlessFullScreenSpaces() ?? [])
        var destroyed = 0
        for space in Set(m.leftSpaces + m.windows.compactMap(\.fullScreenSpace) + [m.marginSpace].compactMap { $0 }).sorted()
        where ownerless.contains(space) || (space != m.marginSpace && sys.spaceExists(space) == true && !m.windows.contains { sys.spaces(window: $0.number)?.contains(space) == true }) {
            if let desktop = sys.desktop(onDisplayOf: space), sys.currentSpace(onDisplayOf: space) == space { _ = sys.setCurrentSpace(desktop) }
            if sys.destroyFullScreenSpace(space), await wait(options.destroyWait, { self.sys.spaceExists(space) == false }) { destroyed += 1 }
        }
        if let s = m.marginSpace, sys.spaceExists(s) == true, let r = sys.reserved(space: s), !r.isZero { _ = sys.reserve(.zero, space: s) }
        try? FileManager.default.removeItem(at: markerURL)
        // Safari windows Margin asked for: closed by their copies now if linked, else kept in the marker for the poll.
        if !leftSafariWindows.isEmpty { await closeLeftSafariWindows() }
        // (Only apps asked to quit at Margin's last quit, nothing else left: that quit was clean, they were still finishing.)
        let asked = m.apps.filter { $0.quitAsked == true }
        if asked.count == m.apps.count, m.windows.isEmpty, m.leftSpaces.isEmpty, (m.leftSafariWindows ?? []).isEmpty, tileIds.isEmpty {
            Diagnostics.note("host: \(asked.count) app\(asked.count == 1 ? "" : "s") asked to quit at Margin's last quit: \(alive.count) still running (asked again, \(quit) quit), in \(ms(since: started)) ms")
            checkOrphans("after recovery")
            return
        }
        Diagnostics.note("host: a marker from a Margin that didn't quit cleanly: \(m.apps.count) app\(m.apps.count == 1 ? "" : "s") (\(alive.count) still running, \(quit) quit), "
                         + "\(m.windows.count) window\(m.windows.count == 1 ? "" : "s") (\(outOfFullScreen) out of full screen, \(givenBack) given back where they were), \(destroyed) Space\(destroyed == 1 ? "" : "s") destroyed, "
                         + (tileIds.isEmpty ? "" : "\(tilesDestroyed) of \(tileIds.count) hosted tile\(tileIds.count == 1 ? "" : "s") destroyed, ")
                         + "\(leftSafariWindows.count) Safari window\(leftSafariWindows.count == 1 ? "" : "s") Margin asked for still to close, in \(ms(since: started)) ms")
        checkOrphans("after recovery")
    }

    // A crashed run's window-mode window (or the person's own) back in its Space and at its recorded frame. Accessibility
    // sees only the current Space's windows: when its Space isn't current and the current one is a Desktop, it's set
    // there and then put back. True: in its Space, at its frame (or its frame never changed).
    private func giveBack(_ w: HostMarker.Window, marginSpace: UInt64?) async -> Bool {
        let display = w.originalSpace ?? marginSpace ?? w.fullScreenSpace
        guard let dest = home(w.originalSpace, display: display) else { return false }
        if sys.spaces(window: w.number) != [dest], sys.move(window: w.number, to: dest) {
            _ = await wait(options.parkWait) { self.sys.spaces(window: w.number)?.contains(dest) == true }
        }
        guard w.mode == .window, w.frameChanged != false, let original = w.frame else { return true }
        func there() -> Bool { sys.bounds(window: w.number).map { HostLayout.near($0, original, within: options.tolerance) } ?? false }
        if there() { return true }
        let resizable = w.resizable ?? true
        if await sys.setFrame(pid: w.pid, window: w.number, original, size: resizable), await wait(options.windowPlaceWait, { there() }) { return true }
        guard let current = sys.currentSpace(onDisplayOf: dest), current != dest, sys.spaceType(current) == ManagedSpace.desktopType, sys.move(window: w.number, to: current) else {
            Diagnostics.warn("host: recovery: a window-mode window's frame wasn't given back (Accessibility doesn't see it)")
            return false
        }
        _ = await wait(options.parkWait) { self.sys.spaces(window: w.number)?.contains(current) == true }
        _ = await sys.setFrame(pid: w.pid, window: w.number, original, size: resizable)
        let ok = await wait(options.windowPlaceWait) { there() }
        _ = sys.move(window: w.number, to: dest)
        return ok
    }

    // ---- helpers ----

    private func r(_ c: CGRect) -> String { "\(Int(c.minX)),\(Int(c.minY)) \(Int(c.width))×\(Int(c.height))" }

    private func isSafari(_ host: Host) -> Bool {
        if case .safariWindow = host.target { return true }
        return false
    }

    private func isHosted(window: Int) -> Bool { hosts.values.contains { $0.window == window } }

    private func emit(_ event: HostEvent) { activity(); onEvent?(event) }

    // ---- when it looks again (the hosting core's schedule.rs) ----

    // The last activity: an event, an operation's end, a correction, a notification heard (its next looks come fast for
    // a while: macOS's own changes land late).
    private(set) var lastActivity: Double?
    // Its next look wanted at once (a notification heard): the shell's read, now.
    var onWake: (() -> Void)?
    private func activity() { lastActivity = sys.now() }
    // Something not settled: a read to confirm, an exit or a retry due, a drag, an operation running or queued, the late
    // watch after a show. The poll comes every 0.25 s until it is.
    var pollPending: Bool {
        if busy || liveOn || reconcileQueued || preparing || quitting { return true }
        if !exiting.isEmpty || !woken.isEmpty || !leftSafariWindows.isEmpty || !leftSpaces.isEmpty || !goneTiles.isEmpty || !retired.isEmpty { return true }
        if shown != nil, sys.now() - shownAt < options.lateWatch { return true }
        return hosts.values.contains { $0.unread > 0 || $0.strays > 0 || $0.offScreenReads > 0 || $0.offPageReads > 0 || $0.gone || $0.phase == .preparing }
    }
    // Seconds until its next look (nil: none until an event), with `links` (a browser copy linked: the shell's keys).
    func nextPoll(links: Bool) -> Double? {
        core.nextPoll(hosting: hasHosts || hasLeftSafariWindows, links: links, pending: pollPending, activeFor: lastActivity.map { sys.now() - $0 })
    }

    private func fail(_ id: HostID, _ step: HostStep, _ reason: String) -> HostResult {
        Diagnostics.note("host: \(id): \(step.rawValue) failed: \(reason)")
        emit(.failed(id, step, reason))
        return .failed(step, reason)
    }

    private func ms(since t: Double) -> Int { Int(((sys.now() - t) * 1000).rounded()) }

    private func wait(_ seconds: Double, every: Double? = nil, _ done: () async -> Bool) async -> Bool {
        let until = sys.now() + seconds
        while true {
            if await done() { return true }
            if sys.now() >= until { return false }
            await sys.sleep(every ?? options.every)
        }
    }
}
