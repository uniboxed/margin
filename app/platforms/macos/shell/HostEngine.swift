// The host engine (docs/MARGIN-APP.md phase 3, "Mission Control" in its "Not solved yet"): another app's window
// shown in Margin's page area, as the test kit proved it on the real Mac (2026-11-15, /tmp/margin-toolbar-test/mc/mc8,
// mc10: real apps, macOS 27.2.1). A state machine over HostSystem, so every step and every fallback runs in the unit
// tests against a stand-in (shell/tests/host-tests.swift).
//
// Margin's window keeps its whole width (its own full-screen Space, nothing reserved at its edges, never a tile): the
// theme draws its frame around the page area, and the hosted window sits above Margin's window, inside the page area.
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
//               anything moves it. The person's window already full screen in a Space of its own: left alone.
//   3. full screen  AXFullScreen on (Safari's window: its copy's `setWindowState fullscreen`, Accessibility can't see
//               it); done once the window is in a full-screen Space of its own, as the window server reads it. Under
//               the freeze from the ask until macOS's jump to that Space is undone (the display set back to Margin's
//               Space): the only moment macOS would visibly change Spaces; the loading animation shows otherwise.
//               First tried early, with no freeze (`early`): the new Space reserved as soon as it's listed (~40 ms),
//               the window moved into Margin's Space and that Space destroyed once it has the page frame (~110 ms),
//               before macOS's Space switch (~600 ms): steps 5-7 done then. Any doubt: this slow path, from the same ask.
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
//   8. front    its app activated (the front app, the keys) and Margin's window kept right below its window
//               (`keepAbove`): the current Space and the windows stay as they are (proven: mc10).
// Switching to a host already opened (`show`, `open` again): the fast path, no full-screen exit or entry, no freeze:
// the target moved into Margin's Space (out of its private Space), then the one shown before moved into a private Space
// (`SLSSpaceCreate(cid, 1, nil)`, as parking does: still full screen, ready), the target activated; target: well under
// 100 ms. Web items of one Safari profile stay a tab switch (the session's, the engine isn't asked).
// The page area changing (`pageRectChanged`: a theme, the display, the sidebar's edge dragged: the session asks once,
// when the drag is over, HostedSession.sidebarResizing): a member's frame can't follow a reservation any more
// (its own Space is gone), so the one shown is placed again: out of full screen (on the current Space, where
// Accessibility acts; Safari's through its copy, parked first so its exit isn't seen), then steps 3 and 5-8, with the
// loading animation. A parked one is placed again only when it's next shown and its frame isn't the page area's.
// (No way to resize a full-screen member without leaving full screen is known: DECISIONS.md.)
//
// Window mode (a window whose AXFullScreen isn't settable, or whose full screen or placing failed: backed out first):
// its normal window brought into Margin's full-screen Space as a window (the bridge, options 7) and placed in the page
// area by Accessibility (resizable: the page area, within its own minimum and maximum, what's left centred; fixed:
// centred), checked by the window server; kept above Margin's window the same way. Parked: its frame given back first
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

import AppKit

final class HostEngine {
    struct Options {
        var launchWait = 10.0 // the app's process after it's asked to start
        var windowWait = 12.0 // its first window (Safari restoring windows can take a while)
        var fullScreenWait = 6.0
        var fullScreenAskAgain = 4.0 // AXFullScreen asked once more if no Space came by then (as the kit did)
        // The early path (no freeze): its new Space listed, reserved, the window at the page area, moved in and the Space
        // destroyed. Its new Space listed at most `earlyWait` from the ask, the window at the page area at most
        // `earlyFrameWait` from that Space's reservation (measured: the Space at ~40 ms, the page frame at ~110 ms, in
        // place at ~130 ms; the window may be reported in its own Space before it has the frame: not a failure), read
        // `earlyEvery`; else the slow path, under the freeze.
        var earlyFullScreen = true
        var earlyWait = 1.5
        var earlyFrameWait = 1.0
        var earlyEvery = 0.005
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
        var every = 0.02
        var tolerance: CGFloat = 1
        var safariBundle = safariIdentifier
        var appArguments = ["-NSMenuEnableMenuBarAgent", "NO"]
        var safariArguments = ["-NSMenuEnableMenuBarAgent", "NO", "-AutoShowToolbarInFullScreen", "YES"]
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
        var bundleId: String?
        var appLaunchedAt: Double?
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
    private(set) var shown: HostID? { didSet { announceAbove() } }
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
    // Told the window of the host now shown in Margin's Space (nil: none is): Margin's window is kept right below it
    // (whenever Margin's window comes to the front, it's ordered below that window again).
    var keepAbove: ((Int?) -> Void)?
    // Told when a slow step starts for a host (its first open, its placing again: Margin's page area shows a loading
    // animation for it) and when it's over (nil).
    var loading: ((HostID?) -> Void)?
    // Told the window of a new app brought into Margin's Space only to be read (not placed or shown yet: Margin's window
    // is ordered above it meanwhile, so it's never seen standing on its own over Margin), nil once that's over.
    var cover: ((Int?) -> Void)?
    private var aboveSaid: Int?
    private var coverSaid: Int?
    private var loadingSaid: HostID?
    private var freezeHolds = 0 // steps holding the freeze now (Margin's quit gives every host back at once)
    private var preparing = false // a window made ready out of sight (`prepare`): parked once it's placed, never shown

    private var tail: Task<Void, Never>?
    private var jumps = 0
    private var leftTried = -Double.infinity // the last try at closing leftSafariWindows

    init(system: HostSystem, marker: URL?, options: Options = Options(), pid: Int32 = ProcessInfo.processInfo.processIdentifier) {
        sys = system
        markerURL = marker
        self.options = options
        ownPid = pid
        sys.onAppQuit = { [weak self] pid in self?.appQuit(pid) }
    }

    var hasHosts: Bool { !hosts.isEmpty || !launched.isEmpty }
    // The pid of a running app of this bundle that Margin started itself (no Dock icon), if any.
    func launchedPid(bundleId: String) -> pid_t? { launched.first { $0.value.bundleId == bundleId }?.key }
    var hasLeftSafariWindows: Bool { !leftSafariWindows.isEmpty }
    // Apps asked to quit by their row's close and still finishing (not Margin's any more).
    var exitingPids: [pid_t] { exiting.keys.sorted() }

    // ---- the API ----

    // Opens `target` (shows it again if it's hosted already) above Margin's window, at `placement`.
    func open(app target: HostTarget, in placement: HostPlacement, marginWindow: Int, marginSpace: UInt64) async -> HostResult {
        await serial {
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
        await serial {
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
        await serial {
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
        await serial {
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
        await serial {
            await self.closeNow(id, why: "closed", exit: .watched)
            self.checkListed("after \(id)'s close")
        }
    }

    // The placement moved (another theme, the display): the one shown placed again (window mode: by Accessibility; full
    // screen: out of it and in again, its own Space reserved for the new page area); parked ones when they're shown.
    func pageRectChanged(_ placement: HostPlacement) async -> Bool {
        await serial {
            self.placement = placement
            guard let id = self.shown, let host = self.hosts[id] else { return true }
            let placed = await self.place(host)
            self.checkListed("after placing \(id) again")
            return placed
        }
    }

    // The one shown parked at once, nothing in its place (Margin's window leaving full screen: the hosted window must
    // never be left on a Desktop or in a full-screen Space of its own). Shown again by the next open or show.
    func parkShown(why: String) async {
        await serial { await self.parkShownNow(why: why) }
    }

    // Margin quits: every host given back at once (each one's own steps in order: its frame and Space back, out of
    // full screen, its window closed first or taken home, Safari's closed by its copy), every app Margin started asked
    // to quit, the Safari windows it made closed, its Spaces given back. Margin never waits for an app's exit (Maps
    // took 5 s, its own watchdog, 2026-11-16): once every window is where it belongs and each app is asked, the quit
    // is done; the apps finish on their own. What isn't done stays in the marker for the next launch's recovery: a
    // window not given back (`leftWindows`), an app asked to quit and still running then (asked again if it still runs).
    func quitAll() async {
        quitting = true
        await serial {
            let started = self.sys.now()
            self.quitAsked = []
            self.leftWindows = []
            let order = (self.shown.map { [$0] } ?? []) + self.hosts.keys.filter { $0 != self.shown }.sorted { $0.raw < $1.raw }
            await self.closeAtOnce(order)
            await self.closeLeftSafariWindows()
            // (An app a row's close asked to quit and still running `quitWait` later didn't quit: Margin's again, asked
            // again below; one still finishing isn't asked twice, kept in the marker as asked.)
            for pid in self.overdue() { if let back = self.takeBack(pid) { await self.sayNotQuit(back) } }
            // (An app asked already by its window's close isn't asked again: one polite quit each, never waited for.)
            for (pid, app) in self.launched.sorted(by: { $0.key < $1.key }) where !self.quitAsked.contains(pid) { self.askQuit(pid, bundle: app.bundleId) }
            // (A reservation on Margin's own Space is never made now; one left by an older build is given back.)
            if self.marginSpace > 0, let r = self.sys.reserved(space: self.marginSpace), !r.isZero { _ = self.sys.reserve(.zero, space: self.marginSpace) }
            await self.destroyLeftSpaces()
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

    // The shell's poll: a hosted app quit or promoted, its window gone, a left Space destroyed. Skipped while an
    // operation runs (it reads the same things).
    func poll() {
        guard !busy else { return }
        // (An app a row's close asked to quit, still running `quitWait` later: it didn't quit, Margin's again.)
        for pid in overdue() { if let back = takeBack(pid) { Task { await self.sayNotQuit(back) } } }
        // (Margin's window out of its Space, macOS took it out of full screen: the one shown is a stray too.)
        let marginHere = marginWindow == 0 || sys.spaces(window: marginWindow).map { $0.contains(marginSpace) } ?? true
        for host in hosts.values {
            if sys.app(pid: host.pid) == nil { appQuit(host.pid); continue }
            if host.launchedByMargin, !host.promoted, sys.policy(pid: host.pid) == .regular { promote(host, why: "its policy reads regular") }
            if sys.bounds(window: host.window) == nil { host.unread += 1 } else { host.unread = 0 }
            if host.unread >= 2 { windowGone(host); continue } // twice in a row: one read can miss mid-transition
            // Where it mustn't be, twice in a row (one read can miss mid-transition): the one shown outside Margin's
            // Space (Margin's window left full screen), a parked one in a user Space.
            let spaces = sys.spaces(window: host.window)
            let strayed = host.phase == .shown ? (!marginHere || (spaces.map { $0 != [marginSpace] } ?? false)) : host.phase == .parked && !(spaces ?? []).isEmpty
            host.strays = strayed ? host.strays + 1 : 0
            if host.strays >= 2 {
                host.strays = 0
                let id = host.id
                Task { await serial { await self.strayed(id) } }
            }
        }
        if !leftSpaces.isEmpty, marginSpace > 0, sys.currentSpace(onDisplayOf: marginSpace) == marginSpace {
            Task { await serial { await self.destroyLeftSpaces() } }
        }
        // Safari windows asked for whose close wasn't confirmed: tried again every 2 s (their copy may link later).
        if !leftSafariWindows.isEmpty, closeSafariWindow != nil, sys.now() - leftTried >= 2 {
            leftTried = sys.now()
            Task { await serial { await self.closeLeftSafariWindows() } }
        }
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
        _ = await sys.activate(pid: host.pid, window: host.window)
    }

    // ---- what the hosting reads ----

    // Whether `id` is hosted now (opened, shown or parked).
    func isHosted(_ id: HostID) -> Bool { hosts[id] != nil }

    // How `id` is shown (nil: not hosted).
    func mode(of id: HostID) -> HostMode? { hosts[id]?.mode }

    // The window of the host shown in Margin's Space, nil if none (Margin's window is kept below it).
    var shownAbove: Int? { shown.flatMap { hosts[$0] }.flatMap { $0.phase == .shown ? $0.window : nil } }

    private func announceAbove() {
        let now = shownAbove
        guard now != aboveSaid else { return }
        aboveSaid = now
        keepAbove?(now)
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

    private func serial<T: Sendable>(_ body: @escaping () async -> T) async -> T {
        let previous = tail
        let task = Task { () -> T in
            _ = await previous?.value
            self.busy = true
            let value = await body()
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
            let frozen = was.mode == .window ? holdFreeze() : false // (a window's frame given back as it leaves: seen)
            let parked = await retire(was)
            releaseFreeze(frozen)
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
                    var last = Set((sys.serverWindows(pid: app.pid) ?? []).map(\.number)), since = sys.now()
                    _ = await wait(options.unhideSettleWait, every: options.memberEvery) {
                        let now = Set((self.sys.serverWindows(pid: app.pid) ?? []).map(\.number))
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
            let before = Set((sys.serverWindows(pid: app.pid) ?? []).map(\.number)).union((await sys.windows(pid: app.pid) ?? []).map(\.number))
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
        let looking = sys.now()
        _ = await wait(personal ? options.personWindowWait : options.windowWait) {
            let listed = (await self.sys.windows(pid: app.pid) ?? []).filter { !self.isHosted(window: $0.number) }
            let usable = listed.filter { !$0.minimized }
            minimizedOnly = !listed.isEmpty && usable.isEmpty
            // (An app Margin started that's still hidden lists nothing to Accessibility: the window server's window at once,
            // unhidden in `take`. One with no window at all while hidden, unhidden now: some make theirs only then.)
            let hidden = !personal && (unhidden || self.sys.isHidden(pid: app.pid) == true)
            let serverAllowed = isApp && !minimizedOnly && (personal || hidden || self.sys.now() - looking >= self.options.serverAfter)
            if let chosen = await self.chooseWindow(pid: app.pid, listed: listed, serverAllowed: serverAllowed) {
                number = chosen.number
                rule = chosen.rule
                info = usable.first { $0.number == chosen.number }
                return true
            }
            if isApp, hidden, !unhidden, self.sys.now() - looking >= self.options.unhideWait, self.sys.unhide(pid: app.pid) {
                unhidden = true
                Diagnostics.note("host: \(id): its app hidden with no window yet: unhidden")
            }
            return false
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
        saveMarker()
        if !sys.watchOpens(pid: pid, { [weak self] code in self?.heard(code, pid: pid) }) {
            Diagnostics.note("host: \(id): LaunchServices' notifications aren't heard: an open from outside isn't noticed")
        }
        emit(.opened(id, ms: ms(since: started)))
        Diagnostics.note("host: \(id) opened (pid \(pid), window \(host.window)\(host.safariWindow.map { ", the copy's \($0)" } ?? "")): \(times.joined(separator: ", "))")
        return await bringIn(host, isNew: true)
    }

    // The window a copy made, by the window server (every Space): a layer-0 window of Safari's pid, at least 200×200,
    // that wasn't there before the ask and isn't hosted; of several, the one at the copy's bounds. (window, how many new)
    private func newSafariWindow(pid: pid_t, before: Set<Int>, near: CGRect?) -> (Int?, Int) {
        let fresh = (sys.serverWindows(pid: pid) ?? []).filter {
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
        let candidates = HostWindowChoice.candidates(sys.serverWindows(pid: pid) ?? [], pid: pid) { taken.contains($0) || minimized.contains($0) }
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
        if host.personApp, spaces.contains(where: { sys.spaceType($0) == ManagedSpace.fullScreenType && $0 != marginSpace }) {
            return (.fullScreen, "its window is already in full screen in a Space of its own (the person's): left alone")
        }
        host.original = sys.bounds(window: host.window)
        host.originalSpace = spaces.first { sys.spaceType($0) != ManagedSpace.fullScreenType }
        host.taken = true
        host.away = true // (from here on, it's put back where it was when it's given back)
        saveMarker()
        guard host.unseen else { return nil }
        // Covered by Margin's window while it's in Margin's Space to be read (its app unhidden above).
        say(cover: host.window)
        guard sys.move(window: host.window, to: marginSpace), await wait(options.parkWait, { self.sys.spaces(window: host.window) == [self.marginSpace] }) else {
            return (.windowMode, "its window didn't come into Margin's Space to be read")
        }
        guard let info = await look(host) else {
            return (.window, "Accessibility doesn't list its window, even on the current Space or with its Desktop current")
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
    // its Desktop) and placed in the page area, kept above Margin's window, its app in front. Under the freeze.
    private func bringInWindow(_ host: Host, isNew: Bool, retrying: Bool) async -> HostResult {
        let started = sys.now()
        var times: [String] = []
        func step(_ name: String, _ t0: Double) { times.append("\(name) \(ms(since: t0))") }
        let frozen = holdFreeze()
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
            _ = sys.destroyPrivateSpace(priv)
            host.privateSpace = nil
        }
        step("into Margin's Space", t0)
        host.phase = .shown
        shown = host.id // (Margin's window kept below it from now: keepAbove)
        saveMarker()
        t0 = sys.now()
        let placed = await placeWindow(host)
        step("place", t0)
        t0 = sys.now()
        if await front(host) { step("front", t0) }
        let total = ms(since: started)
        Diagnostics.note("host: \(host.id) shown in window mode in \(total) ms (\(times.joined(separator: ", "))\(frozen ? "; under the freeze" : ""))\(placed ? "" : "; NOT fitted to the page area")")
        emit(.shown(host.id, ms: total))
        return .shown(host.id, placed: placed)
    }

    // The page area for a window-mode host (Margin's own layout's, its window its whole width).
    private var windowArea: CGRect { placement.page }


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
        func centred(_ size: CGSize) -> CGRect {
            CGRect(x: (page.minX + max(0, (page.width - size.width) / 2)).rounded(), y: (page.minY + max(0, (page.height - size.height) / 2)).rounded(), width: size.width, height: size.height)
        }
        var want = host.resizable ? page : centred(now.size)
        if HostLayout.near(now, want, within: options.tolerance) { return true }
        if host.original == nil { host.original = now }
        host.frameChanged = true
        saveMarker()
        var got = now
        for attempt in 1...2 {
            _ = await sys.setFrame(pid: host.pid, window: host.window, want, size: host.resizable && attempt == 1)
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
                if let priv = host.privateSpace { _ = sys.destroyPrivateSpace(priv); host.privateSpace = nil }
            }
        }
        let from = sys.bounds(window: host.window) ?? original
        let took = await wait(options.frameAskWait, every: options.lookEvery) { await self.sys.setFrame(pid: host.pid, window: host.window, original, size: host.resizable) }
        let got = took ? await settled(host, at: original, from: from) : from
        let ok = took && HostLayout.near(got, original, within: options.tolerance)
        host.axRefused = !took
        if ok { host.frameChanged = false } else {
            Diagnostics.warn("host: \(host.id): its frame wasn't given back (\(took ? "Accessibility took it, the window is at \(r(got))" : "Accessibility didn't take it")): kept in the marker")
        }
        saveMarker()
        return ok
    }

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
        if let priv = host.privateSpace { _ = sys.destroyPrivateSpace(priv); host.privateSpace = nil }
        host.away = false
        // (The person's window macOS took out of full screen: its frame as it was, if it's not and Accessibility sees it.)
        if host.personApp, host.mode == .fullScreen, let o = host.original, let b = sys.bounds(window: host.window), !HostLayout.near(b, o, within: options.tolerance) {
            _ = await sys.setFrame(pid: host.pid, window: host.window, o, size: host.resizable)
        }
        saveMarker()
    }

    // A window-mode host out of Margin's Space: its frame given back first (it's on the current Space now), then into a
    // private Space (no full-screen exit: it's a window).
    private func retireWindow(_ host: Host) async -> Bool {
        await restoreFrame(host)
        guard let priv = sys.createPrivateSpace() else { return false }
        guard sys.move(window: host.window, to: priv), await wait(options.parkWait, { self.sys.spaces(window: host.window) == [] }) else {
            _ = sys.destroyPrivateSpace(priv)
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
        if host.mode == .window { return await bringInWindow(host, isNew: isNew, retrying: retrying) }
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
        let previous = shown.flatMap { $0 == host.id ? nil : hosts[$0] }
        let frozen = previous?.mode == .window ? holdFreeze() : false
        defer { releaseFreeze(frozen) }
        var t0 = sys.now()
        if sys.spaces(window: host.window) != [marginSpace] {
            guard sys.move(window: host.window, to: marginSpace),
                  await wait(options.memberWait, every: options.memberEvery, { self.sys.spaces(window: host.window) == [self.marginSpace] }) else {
                if let priv = host.privateSpace, sys.spaces(window: host.window) != [] { _ = sys.move(window: host.window, to: priv) } // (back out of sight)
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
                return fail(host.id, .park, "the one shown before (\(previous.id)) couldn't leave Margin's Space")
            }
            step("park \(previous.id)", t0)
        }
        if let priv = host.privateSpace {
            _ = sys.destroyPrivateSpace(priv)
            host.privateSpace = nil
        }
        host.phase = .shown
        shown = host.id // (Margin's window kept below it from now: keepAbove)
        saveMarker()
        t0 = sys.now()
        if await front(host) { step("front", t0) }
        let total = ms(since: started)
        Diagnostics.note("host: \(host.id) switched in \(total) ms (\(times.joined(separator: ", "))\(frozen ? "; under the freeze" : ""))")
        emit(.shown(host.id, ms: total))
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
            let frozen = previous.mode == .window ? holdFreeze() : false
            let parked = await retire(previous)
            releaseFreeze(frozen)
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
                return await giveUp(host, isNew: false, .exitFullScreen, "it didn't leave full screen to be placed again", previous: previous)
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
        // 3. full screen. The early path first, with no freeze: its new Space reserved to the page area as soon as it's
        // listed, its window moved into Margin's Space and that Space destroyed once the window has the page frame, all
        // before macOS's Space switch (Margin's Space kept current meanwhile). Else the slow path: in a Space of its own,
        // macOS's jump there undone, under the freeze (held on from a seen exit above), then steps 5-7.
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
            step("full screen\(jumps > 0 ? " (\(jumps) jump\(jumps == 1 ? "" : "s") undone\(frozen ? " under the freeze" : ", no freeze"))" : "")", t0)
        case .member(let how):
            early = true
            step("full screen, at the page area and in Margin's Space early (\(how)\(frozen ? "; under the freeze of its exit" : "; no freeze"))", t0)
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

            // 6. into Margin's Space, a plain member (still full screen, at its frame).
            t0 = sys.now()
            guard await enterMargin(host) else {
                return await giveUp(host, isNew: isNew, .member, "its window didn't come into Margin's Space", previous: previous)
            }
            step("into Margin's Space", t0)

            // 7. its own Space, emptied of its window, destroyed: Mission Control lists Margin's Space only.
            if let own = host.fullScreenSpace {
                t0 = sys.now()
                host.fullScreenSpace = nil
                if await destroyOwn(own) { step("destroy", t0) } else {
                    leftSpaces.insert(own)
                    emit(.failed(host.id, .destroy, "its own Space \(own) didn't go: tried again later"))
                }
            }
        }
        host.member = true
        host.placedPage = placement.page
        if prepared {
            // 8. made ready out of sight: parked at once, its app not activated.
            t0 = sys.now()
            cover?(host.window) // (ordered above it again now it's in Margin's Space)
            guard await parkMember(host) else {
                return await giveUp(host, isNew: isNew, .park, "prepared, but its window couldn't leave Margin's Space", previous: nil)
            }
            step("parked", t0)
            let total = ms(since: started)
            Diagnostics.note("host: \(host.id) prepared out of sight in \(total) ms (\(times.joined(separator: ", ")))")
            return .shown(host.id, placed: true)
        }
        host.phase = .shown
        shown = host.id // (Margin's window kept below it from now: keepAbove)
        saveMarker()

        // 8. its app in front.
        t0 = sys.now()
        if await front(host) { step("front", t0) }
        let total = ms(since: started)
        Diagnostics.note("host: \(host.id) \(again ? "placed again" : "shown") in \(total) ms (\(times.joined(separator: ", ")))")
        emit(.shown(host.id, ms: total))
        return .shown(host.id, placed: true)
    }

    // Full screen failed, or its window didn't take the page area's size that way: an app's window backed out of
    // whatever it reached and shown in window mode (many AppKit apps refuse full screen with no Dock icon); Safari's
    // fails (its window is Margin's own).
    private func fallBack(_ host: Host, isNew: Bool, retrying: Bool, _ step: HostStep, _ reason: String, previous: Host?) async -> HostResult {
        // (Being prepared out of sight: never shown as a window instead.)
        guard case .app = host.target, !preparing else { return await giveUp(host, isNew: isNew, step, reason, previous: previous) }
        Diagnostics.note("host: \(host.id): \(step.rawValue) failed (\(reason)): backed out, shown in window mode")
        let frozen = holdFreeze()
        await backOut(host)
        releaseFreeze(frozen)
        host.mode = .window
        saveMarker()
        return await bringInWindow(host, isNew: isNew, retrying: retrying)
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
    // the early path tried first with no freeze; failing it, the slow path under the freeze (`frozen`: taken here if
    // it isn't held yet, released by the caller).
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
        // The full-screen Spaces listed before the ask: the early path watches for a new one (nil: not tried, as when
        // its window already has a Space of its own, or the list doesn't read).
        var before: Set<UInt64>?
        if options.earlyFullScreen, ownSpace() == nil, let owners = sys.fullScreenSpaceOwners() { before = Set(owners.keys) }
        if copy {
            if ownSpace() == nil { askCopy() }
        } else if await sys.isFullScreen(pid: host.pid, window: host.window) != true {
            guard await sys.setFullScreen(pid: host.pid, window: host.window, true) else { return .failed("AXFullScreen couldn't be set") }
        } else {
            before = nil // (already full screen: its Space is the slow path's to read)
        }
        var asked = sys.now()
        if let before {
            let t = sys.now()
            switch await early(host, before: before, refused: { copy && ask?.answer == false }) {
            case .placed(let how):
                Diagnostics.note("host: \(host.id): full screen by the early path in \(ms(since: t)) ms (\(how)), no freeze")
                return .member(how)
            case .slow(let why):
                Diagnostics.note("host: \(host.id): the early full screen fell back after \(ms(since: t)) ms (\(why)): the slow path, under the freeze")
            case .again(let why):
                Diagnostics.note("host: \(host.id): the early full screen fell back after \(ms(since: t)) ms (\(why)): backed out and asked again, the slow path, under the freeze")
                if !frozen { frozen = holdFreeze() }
                await backOut(host)
                if copy {
                    askCopy()
                } else if await sys.isFullScreen(pid: host.pid, window: host.window) != true {
                    guard await sys.setFullScreen(pid: host.pid, window: host.window, true) else { return .failed("AXFullScreen couldn't be set again") }
                }
                asked = sys.now()
            }
        }
        if !frozen { frozen = holdFreeze() }
        var askedAgain = false
        var space: UInt64?
        let came = await wait(options.fullScreenWait) {
            space = ownSpace()
            if let s = space {
                self.undoJump(to: s)
                return copy ? true : await self.sys.isFullScreen(pid: host.pid, window: host.window) == true
            }
            if copy, ask?.answer == false {
                // The copy didn't ask Safari (not linked, busy): once more at once, then no more waiting.
                if askedAgain { return true }
                askedAgain = true
                askCopy()
                return false
            }
            if !askedAgain, self.sys.now() - asked >= self.options.fullScreenAskAgain {
                askedAgain = true
                if copy { if ask?.answer != nil { askCopy() } } else { _ = await self.sys.setFullScreen(pid: host.pid, window: host.window, true) }
            }
            return false
        }
        guard came, let space else {
            if copy, ask?.answer == false { return .failed("its copy didn't ask Safari for full screen (setWindowState)") }
            return .failed("no full-screen Space of its own within \(Int(options.fullScreenWait)) s")
        }
        host.fullScreenSpace = space
        ownSpaces.insert(space)
        saveMarker()
        undoJump(to: space)
        return .own
    }

    private enum Early { case placed(String), slow(String), again(String) }

    // The early full screen (measured on the real Mac 2026-11-16, /tmp/margin-toolbar-test/fsopen/early2.swift, a test
    // app with a stand-in Margin's Space current): a window asked into full screen has its new Space listed, owned by
    // its app, at ~40 ms, well before the window server says the window is in it (~600 ms, with macOS's Space switch).
    // That Space's edges reserved at once give the window the page frame at ~110 ms though it isn't a member yet; moved
    // into Margin's Space then and its own Space destroyed, it's in place at ~130 ms, still full screen, and with Margin's
    // Space kept current the screen never left it: no slide to hide, so no freeze. Never destroyed before the window has
    // the page frame (destroyed earlier, the window keeps the display's whole size). The window reported in its own Space
    // before it has the page frame is normal (macOS adds it to that Space as it lays it out, seen on the real Mac
    // 2026-11-16: every first open fell back on that rule): waited past, Margin's Space kept current all along (macOS's
    // switch to the new Space undone at once), until the page frame or `earlyFrameWait`. `.slow`: nothing undone, the ask
    // still running (the slow path takes it from there, its Space as the one found); `.again`: the window isn't where it
    // should be after the move and destroy (backed out and asked again by the caller).
    private func early(_ host: Host, before: Set<UInt64>, refused: () -> Bool) async -> Early {
        guard let edges = HostLayout.plan(placement) else { return .slow("no plan for the page area (\(placement.text))") }
        let t0 = sys.now()
        let page = placement.page
        var space: UInt64?
        var reservedAt = t0
        var memberSeen = false
        var times: [String] = []
        func mark(_ what: String) { times.append("\(what) \(ms(since: t0))") }
        func said() -> String { times.joined(separator: ", ") + (jumps > 0 ? "; \(jumps) Space change\(jumps == 1 ? "" : "s") undone" : "") }
        func there() -> Bool { sys.bounds(window: host.window).map { HostLayout.near($0, page, within: options.tolerance) } ?? false }
        func inOwn(_ s: UInt64) -> Bool { sys.spaces(window: host.window)?.contains(s) == true }
        // Margin's Space kept current: a Space made current that wasn't listed before the ask (macOS's switch to the new
        // one) is undone at once; a Space the person had is left alone.
        func keepCurrent() {
            guard let now = sys.currentSpace(onDisplayOf: marginSpace), now != marginSpace, !before.contains(now) else { return }
            if sys.setCurrentSpace(marginSpace) { jumps += 1 }
        }
        // 1. its new Space listed (owned by its app, or holding its window), its edges reserved to the page area at once;
        // 2. its window at the page area (that Space lays it out; the window may be reported in it before or after).
        while true {
            if refused() { return .slow("its copy didn't ask Safari for full screen") }
            if let s = space, !memberSeen, inOwn(s) { memberSeen = true; mark("in its Space") }
            if space == nil, let owners = sys.fullScreenSpaceOwners() {
                let new = owners.keys.filter { s in !before.contains(s) && s != marginSpace && (owners[s] == host.pid || inOwn(s)) }.sorted()
                if new.count > 1 { return .slow("\(new.count) new full-screen Spaces of its app: which is its window's isn't known") }
                if let s = new.first {
                    mark("listed")
                    space = s
                    host.fullScreenSpace = s
                    ownSpaces.insert(s)
                    saveMarker()
                    if inOwn(s) { memberSeen = true; mark("in its Space") }
                    _ = sys.reserve(edges, space: s)
                    reservedAt = sys.now()
                    mark("reserved \(edges.text)")
                }
            }
            keepCurrent()
            if space != nil, there() { break }
            if space == nil, sys.now() - t0 >= options.earlyWait {
                return .slow("no new full-screen Space listed within \(ms(since: t0)) ms")
            }
            if space != nil, sys.now() - reservedAt >= options.earlyFrameWait {
                let b = sys.bounds(window: host.window).map(r) ?? "?"
                return .slow("its window didn't take the page area \(r(page)) within \(ms(since: reservedAt)) ms of the reservation, at \(b) (\(said()))")
            }
            await sys.sleep(options.earlyEvery)
        }
        guard let own = space else { return .slow("no Space") }
        mark("page-sized")
        // 3. into Margin's Space, then its own Space destroyed (Margin's current), then checked: in Margin's Space only, at
        // the page area, its Space no longer listed, still full screen.
        keepCurrent()
        guard sys.move(window: host.window, to: marginSpace) else { return .slow("the bridge didn't take its move into Margin's Space") }
        let destroyed = sys.currentSpace(onDisplayOf: marginSpace) != own && sys.destroyFullScreenSpace(own)
        mark(destroyed ? "moved in, its Space destroyed" : "moved in")
        var inPlace = false, gone = false
        _ = await wait(options.memberWait, every: options.earlyEvery) {
            keepCurrent()
            inPlace = self.sys.spaces(window: host.window) == [self.marginSpace] && there()
            gone = self.sys.spaceExists(own) == false
            return inPlace && gone
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
        guard let edges = HostLayout.plan(placement) else {
            Diagnostics.note("host: place \(host.id): no plan (\(placement.text))")
            return false
        }
        let page = placement.page
        func there() -> Bool { sys.bounds(window: host.window).map { HostLayout.near($0, page, within: options.tolerance) } ?? false }
        for attempt in 1...2 {
            if there() { return true }
            let reserved = sys.reserved(space: own) ?? .zero
            Diagnostics.note("host: place \(host.id) attempt \(attempt): its window \(sys.bounds(window: host.window).map(r) ?? "?"), its Space reserving \(reserved.text), \(placement.text) → reserving \(edges.text)")
            if reserved != edges || attempt == 2 { _ = sys.reserve(edges, space: own) }
            if await wait(options.placeWait, there) { return true }
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
            _ = sys.destroyPrivateSpace(priv)
            return false
        }
        if let old = host.privateSpace, old != priv { _ = sys.destroyPrivateSpace(old) }
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
        _ = sys.destroyPrivateSpace(priv)
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
    // True: out.
    private func leaveMember(_ host: Host) async -> Bool {
        let copy = viaCopy(host)
        if !copy, let current = currentSpace(for: host), sys.spaces(window: host.window)?.contains(current) != true {
            host.away = true
            guard sys.move(window: host.window, to: current),
                  await wait(options.parkWait, every: options.memberEvery, { self.sys.spaces(window: host.window)?.contains(current) == true }) else {
                Diagnostics.note("host: \(host.id): its window didn't come to the current Space to leave full screen")
                return false
            }
            if let priv = host.privateSpace { _ = sys.destroyPrivateSpace(priv); host.privateSpace = nil }
            saveMarker()
        }
        // Done once Accessibility reads it out; Safari's through its copy, once the copy says Safari did; an app's whose
        // AXFullScreen doesn't read, once the window server has it off the page frame it had as a member and still
        // (macOS put it back as a window). Accessibility neither taking nor reading it: asked again `exitUnansweredWait`,
        // then given up (it won't leave by itself; no fixed wait for it).
        let member = sys.bounds(window: host.window) // (its frame as a member, before it's asked)
        let asked = sys.now()
        var answered = await setFullScreen(host, false)
        var moved: (CGRect, Double)?
        var unanswered = false
        let out = await wait(options.exitWait) {
            let full = await self.sys.isFullScreen(pid: host.pid, window: host.window)
            if full == false { return true }
            if copy { return full == nil && answered } // (Safari's in its private Space, unread there: its copy's word, given once Safari says)
            if !answered {
                answered = await self.setFullScreen(host, false)
                if !answered, self.sys.now() - asked >= self.options.exitUnansweredWait { unanswered = true; return true }
                return false
            }
            if full == true { return false } // (asked, still leaving: an app animates it)
            guard let b = self.sys.bounds(window: host.window), let m = member, !HostLayout.near(b, m, within: 0.5) else { moved = nil; return false }
            if let (last, since) = moved, HostLayout.near(b, last, within: 0.5) { return self.sys.now() - since >= self.options.placeSettle }
            moved = (b, self.sys.now())
            return false
        } && !unanswered
        host.exitUnconfirmed = !out
        if !out { Diagnostics.note("host: \(host.id): out of full screen not confirmed in \(ms(since: asked)) ms (\(unanswered ? "Accessibility neither took nor read it" : "still full screen"))") }
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
        if let placed = host.placedPage, HostLayout.near(placed, placement.page, within: options.tolerance) { return true }
        Diagnostics.note("host: \(host.id): the page area moved (\(host.placedPage.map(r) ?? "none") → \(r(placement.page))): placed again")
        if case .shown(_, let placed) = await placeFullScreen(host, isNew: false, retrying: false) { return placed && shown == host.id }
        return false
    }

    // Its app in front (the keys) and its window raised; never once Margin quits. True: asked.
    private func front(_ host: Host) async -> Bool {
        guard !quitting else { return false }
        return await sys.activate(pid: host.pid, window: host.window)
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

    // The poll found a host where it mustn't be: the one shown outside Margin's Space (or Margin's window out of it)
    // parked with nothing in its place; a parked one in a user Space (macOS put it on a Desktop, its app took it to
    // full screen) parked again.
    private func strayed(_ id: HostID) async {
        guard let host = hosts[id] else { return }
        if host.phase == .shown, shown == id {
            await parkShownNow(why: "its window left Margin's Space, or Margin's window did")
        } else if host.phase == .parked, let spaces = sys.spaces(window: host.window), !spaces.isEmpty {
            Diagnostics.note("host: \(id): parked, found in a user Space: parked again")
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
            for space in own where sys.spaceExists(space) == true && ownSpaces.contains(space) {
                if await !destroyOwn(space) { leftSpaces.insert(space) }
            }
            saveMarker()
        }
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
        let seen = (host.phase == .shown && host.mode == .window) || (host.member && !viaCopy(host))
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
        if quits {
            let bundle = sys.app(pid: host.pid)?.bundleId ?? id.raw
            switch exit {
            case .atQuit: askQuit(host.pid, bundle: bundle); step("asked to quit")
            case .watched: askQuitWatched(host.pid, bundle: bundle, id: id); step("asked to quit")
            case .waited: await quitApp(host.pid, bundle: bundle, parked: host); step("quit")
            }
        }
        if atQuit, let left = unfinished(host) { leftWindows.append(left) }
        if let priv = host.privateSpace { _ = sys.destroyPrivateSpace(priv) }
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
            if let priv = host.privateSpace { _ = sys.destroyPrivateSpace(priv); host.privateSpace = nil }
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
        guard sys.app(pid: pid) != nil else { launched[pid] = nil; saveMarker(); return }
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
                if self.exiting[pid] != nil, self.sys.app(pid: pid) == nil { self.exited(pid) } // (its notice not heard yet)
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
        if await wait(options.quitWait, { self.sys.app(pid: pid) == nil }) {
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
        let others = (sys.serverWindows(pid: pid) ?? []).filter { $0.alpha > 0 && $0.number != hosted?.window && $0.onScreen }
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

    private func appQuit(_ pid: pid_t) {
        exited(pid)
        let gone = hosts.values.filter { $0.pid == pid }
        let wasLaunched = launched.removeValue(forKey: pid) != nil
        guard !gone.isEmpty || wasLaunched else { return }
        for host in gone {
            if busy { continue } // the operation running decides (it quit it, or its waits fail)
            if let priv = host.privateSpace { _ = sys.destroyPrivateSpace(priv) }
            if let own = host.fullScreenSpace, sys.spaceExists(own) == true { leftSpaces.insert(own) }
            hosts[host.id] = nil
            if shown == host.id { shown = nil }
            sys.stopWatchingOpens(pid: pid)
            Diagnostics.note("host: \(host.id) quit, not by Margin")
            emit(.quitByUser(host.id))
        }
        saveMarker()
        checkOrphans("after an app quit")
    }

    private func windowGone(_ host: Host) {
        if let priv = host.privateSpace { _ = sys.destroyPrivateSpace(priv) }
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
        announceAbove()
        guard let markerURL else { return }
        var m = HostMarker(pid: ownPid, marginSpace: hosts.isEmpty && leftWindows.isEmpty ? nil : marginSpace)
        m.apps = launched.values.sorted { $0.pid < $1.pid }.map {
            HostMarker.App(pid: $0.pid, bundleId: $0.bundleId, launchedAt: $0.launchedAt, quitAsked: quitting && quitAsked.contains($0.pid) ? true : nil)
        } + exiting.values.sorted { $0.app.pid < $1.app.pid }.map { HostMarker.App(pid: $0.app.pid, bundleId: $0.app.bundleId, launchedAt: $0.app.launchedAt, quitAsked: true) }
        m.windows = hosts.values.sorted { $0.window < $1.window }.map(markerWindow) + leftWindows
        m.leftSpaces = leftSpaces.sorted()
        m.leftSafariWindows = leftSafariWindows.isEmpty ? nil : leftSafariWindows
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
        if asked.count == m.apps.count, m.windows.isEmpty, m.leftSpaces.isEmpty, (m.leftSafariWindows ?? []).isEmpty {
            Diagnostics.note("host: \(asked.count) app\(asked.count == 1 ? "" : "s") asked to quit at Margin's last quit: \(alive.count) still running (asked again, \(quit) quit), in \(ms(since: started)) ms")
            checkOrphans("after recovery")
            return
        }
        Diagnostics.note("host: a marker from a Margin that didn't quit cleanly: \(m.apps.count) app\(m.apps.count == 1 ? "" : "s") (\(alive.count) still running, \(quit) quit), "
                         + "\(m.windows.count) window\(m.windows.count == 1 ? "" : "s") (\(outOfFullScreen) out of full screen, \(givenBack) given back where they were), \(destroyed) Space\(destroyed == 1 ? "" : "s") destroyed, "
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

    private func emit(_ event: HostEvent) { onEvent?(event) }

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
