// The host engine (docs/MARGIN-APP.md phase 3, "Mission Control" in its "Not solved yet"): another app's window
// shown in Margin's page area, as the test kit proved it step by step. A state machine over HostSystem, so every
// step and every fallback runs in the unit tests against a stand-in (shell/tests/host-tests.swift).
//
// Showing a host (`open`, `show`), under the freeze, each step verified and timed:
//   1. launch   an app not running is started with no Dock icon (`-NSMenuEnableMenuBarAgent NO`: it never shows
//               its own title strip; Safari also `-AutoShowToolbarInFullScreen YES`). An app already running (the
//               person opened it, its Dock icon) is hosted as it is: never started again, never quit, its Dock icon
//               left; its window given back exactly as it was when Margin stops hosting it. Safari: Margin asks its
//               own extension for a new window there (`requestSafariWindow`) and hosts only that window; Safari is
//               never restarted.
//   2. window   its main window (Safari: the new one Margin asked for, found by the window server: a new layer-0
//               window of Safari's pid. Accessibility lists only the current Space's windows, and a normal window
//               can't open in Margin's full-screen Space, so Safari's opens on a Desktop). An app the person opened
//               whose window Accessibility can't see (on another Space): found by the window server, its frame and
//               Space recorded, then brought into Margin's Space to be read. Its frame and Space are recorded before
//               anything moves it. The person's window already full screen in a Space of its own: left alone.
//   Window mode (a window whose AXFullScreen isn't settable, or whose full screen failed: backed out first): its
//               normal window brought into Margin's full-screen Space as a window (the bridge, options 7) and placed
//               in the page area by Accessibility (resizable: the page area, within its own minimum and maximum, what's
//               left centred; fixed: centred), checked by the window server; Margin's window its whole width (no
//               tile, nothing reserved: `willWindow`) and kept right below it (`keepAbove`). Parked: its frame given
//               back first (while it's on the current Space, where Accessibility sees it), then into a private Space;
//               shown again: back into Margin's Space and placed again. Given back (closed, quit, a failure): its
//               frame as it was, its Space as it was, and only then is an app Margin started quit, so it saves the
//               frame it had. The steps below are full screen's.
//   3. full screen  AXFullScreen on (Safari's window: its copy's `setWindowState fullscreen`, Accessibility can't see
//               it); done once the window is in a full-screen Space of its own, as the window server reads it.
//               macOS's jump to that Space is undone at once (the display set back to Margin's Space).
//   4. sidebar  (Safari, a window Margin made or a Safari Margin started) its own sidebar hidden by its View menu,
//               only while the hosted window is surely Safari's main one (read again once its tile is in Margin's
//               Space, when Accessibility couldn't see it before).
//   5. park the one shown before: into a private Space, then out of full screen there, so Margin's Space keeps
//               two tiles only (a parked tile keeps its place otherwise).
//   6. tile     the window's tile moved into Margin's full-screen Space, beside Margin's own (index 1).
//   7. destroy  its emptied Space destroyed by the window manager (Mission Control then lists Margin's Space
//               only); never while it's the one showing (that drops the display to the Desktop).
//   8. place    the page area's other edges reserved, and the spacing between the tiles set, until the window's
//               bounds are the page area within 1 pt. Planned from the placement Margin's window gives (the page
//               area, the display's full-screen area, Margin's tile width: HostLayout.plan), never from the windows'
//               bounds mid-transition, so the same placement always gives the same reservation.
// Margin's window leaving full screen (`parkShown`), or the shown window found outside Margin's Space by the poll:
// the one shown is parked at once (nothing of it stands alone in a full-screen Space of its own or on a Desktop);
// shown again when it's asked for in Margin's full screen.
// A failure falls back without leaving anything behind: the window out of full screen (its Space then goes), an
// emptied Space destroyed, an app Margin started for that open quit again, the one shown before shown again. A
// Safari window Margin asked for is closed by its copy at every failure after the ask; one whose close isn't
// confirmed is kept in the marker (`leftSafariWindows`) and closed later (the poll, quit, the next launch).
//
// Safety: the only window Accessibility moves or resizes is a window-mode host's, its frame recorded first (in the
// marker too) and given back before it leaves Margin's Space and before its app is quit; only the apps Margin
// hosts (and the Safari windows it made) are touched; never a click. A marker (hosted.json) lists them for the next
// launch after a crash (`recover`), which takes them out of full screen, gives a window-mode window its frame and its
// Desktop back, puts the person's apps' windows back where they were, and quits only the apps Margin started (never
// leaving an app saved as in full screen or at Margin's page area). Every operation runs one at a time, in order.

import AppKit

final class HostEngine {
    struct Options {
        var launchWait = 10.0 // the app's process after it's asked to start
        var windowWait = 12.0 // its first window (Safari restoring windows can take a while)
        var fullScreenWait = 6.0
        var fullScreenAskAgain = 4.0 // AXFullScreen asked once more if no Space came by then (as the kit did)
        var tileWait = 1.5 // its tile in Margin's Space after the move
        var narrowWait = 0.6 // Margin's window at the sidebar's tile width and steady, when it really narrows
        var narrowEvery = 0.05
        var destroyWait = 1.5
        var placeWait = 1.5 // a tile's reservation taking effect
        var windowPlaceWait = 0.6 // a window-mode host's frame set by Accessibility: at most this long for the window server's bounds
        var placeSettle = 0.1 // ...or as soon as its bounds changed and then held this long (the size it took: its own limits)
        var parkWait = 0.6 // two tries of 300 ms, as the parker
        var exitWait = 7.0 // out of full screen (an app animates it)
        var quitWait = 6.0 // (an iPad app with a window open quits after its own 5 s watchdog: seen out 6 ms after a 5 s wait)
        var closeWait = 1.0 // an iPad app's window closed by its close button before its quit: pressed, then gone
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
    }

    enum Phase: Equatable { case preparing, shown, parked }

    final class Host {
        let id: HostID
        let target: HostTarget
        let pid: pid_t
        let window: Int
        let launchedByMargin: Bool // its app was started by Margin (with no Dock icon)
        let madeByMargin: Bool // a Safari window Margin's extension made in a Safari Margin didn't start
        let safariWindow: Int? // a Safari window a copy made for Margin: the copy's id for it (full screen and close go through it)
        var phase = Phase.preparing
        var tile: UInt64?
        var fullScreenSpace: UInt64? // its own full-screen Space while it has one
        var privateSpace: UInt64? // while parked
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
    private(set) var leftSpaces: Set<UInt64> = [] // emptied full-screen Spaces a destroy hasn't taken yet
    private(set) var leftSafariWindows: [HostMarker.SafariWindow] = [] // Safari windows Margin asked for, their close not confirmed
    private(set) var placement = HostPlacement.zero // the page area, the display's area, Margin's tile (top-left coordinates)
    var pageRect: CGRect { placement.page }
    private(set) var tiledWidth: CGFloat? // Margin's tile width the one shown was tiled beside (it's never changed while tiled)
    private(set) var marginWindow = 0
    private(set) var marginSpace: UInt64 = 0
    private(set) var busy = false
    private(set) var quitting = false // Margin quits: nothing is shown or activated any more
    private var quitAsked: Set<pid_t> = [] // apps asked to quit during Margin's quit
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
    // Told just before a host's tile goes into Margin's Space (the shell makes Margin's window the sidebar's tile then:
    // alone in its Space, a narrow window would stand in the middle of it while an app starts).
    var willTile: ((HostID) -> Void)?
    // Told just before a window-mode host comes into Margin's Space (the one shown before already out of it): the
    // shell gives Margin's window its whole width and its own layout (no sidebar tile) and answers that placement
    // (`windowed`); nil: the page area the engine has.
    var willWindow: ((HostID) async -> HostPlacement?)?
    // Told the window of the window-mode host now shown in Margin's Space (nil: none is): Margin's window is kept right
    // below it (whenever Margin's window comes to the front, it's ordered below that window again).
    var keepAbove: ((Int?) -> Void)?
    private(set) var windowPage: CGRect? // the page area with Margin's window its whole width (window mode)
    private var aboveSaid: Int?
    private var frozenNow = false

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

    // ---- the API ----

    // Opens `target` (shows it again if it's hosted already) beside Margin's window, at `placement`.
    func open(app target: HostTarget, in placement: HostPlacement, marginWindow: Int, marginSpace: UInt64) async -> HostResult {
        await serial {
            if marginSpace != self.marginSpace || marginWindow != self.marginWindow { self.tiledWidth = nil; self.windowPage = nil } // (another Space: nothing tiled there yet)
            if placement.windowed { self.windowPage = placement.page } else { self.placement = placement }
            self.marginWindow = marginWindow
            self.marginSpace = marginSpace
            return await self.openNow(target)
        }
    }

    func show(_ id: HostID) async -> HostResult {
        await serial {
            guard let host = self.hosts[id] else { return .failed(.window, "not hosted") }
            if self.shown == id { return .shown(id, placed: await self.place(host)) }
            return await self.bringIn(host, isNew: false)
        }
    }

    func close(_ id: HostID) async {
        await serial { await self.closeNow(id, why: "closed") }
    }

    // The placement moved (another theme, the display). Margin's tile width is never changed while the hosted tile is
    // beside it (macOS takes a full-screen tile whose size constraints change out of full screen: seen 2026-11-15 on a
    // sidebar drag), so a new tile width is taken by parking the one shown and bringing it in again (Margin's window
    // takes the new width alone in its Space, `willTile`); anything else is a new reservation.
    func pageRectChanged(_ placement: HostPlacement) async -> Bool {
        await serial {
            // Window mode: Margin's window its whole width, the page area from its own layout: the window placed again
            // (Accessibility), never parked for it.
            if placement.windowed {
                self.windowPage = placement.page
                guard let id = self.shown, let host = self.hosts[id], host.mode == .window else { return true }
                return await self.placeWindow(host)
            }
            self.placement = placement
            guard let id = self.shown, let host = self.hosts[id] else { return true }
            if host.mode == .window { return true } // (a tile's placement while a window is shown: kept for the next tile)
            if let tiled = self.tiledWidth, abs(tiled - placement.tileWidth) > 0.5 {
                Diagnostics.note("host: Margin's tile \(Int(tiled)) → \(Int(placement.tileWidth)): \(id) parked and brought in again beside the new width")
                let frozen = self.holdFreeze()
                defer { self.releaseFreeze(frozen) }
                guard await self.retire(host, putBack: true) else { return await self.place(host) }
                if case .shown = await self.bringIn(host, isNew: false, freezing: false) { return self.shown == id }
                return false
            }
            return await self.place(host)
        }
    }

    // The one shown parked at once, nothing in its place (Margin's window leaving full screen: the hosted window must
    // never be left in a full-screen Space of its own or on a Desktop). Shown again by the next open or show.
    func parkShown(why: String) async {
        await serial { await self.parkShownNow(why: why) }
    }

    // Margin quits: the one shown out of full screen while it's still tiled, then every app Margin started quit, the
    // Safari windows it made closed, its Spaces given back.
    func quitAll() async {
        quitting = true
        await serial {
            let started = self.sys.now()
            self.quitAsked = []
            // (The one shown first, out of full screen while it's still tiled; then the parked ones.)
            let order = (self.shown.map { [$0] } ?? []) + self.hosts.keys.filter { $0 != self.shown }.sorted { $0.raw < $1.raw }
            for id in order { await self.closeNow(id, why: "Margin quits") }
            await self.closeLeftSafariWindows()
            // (An app asked already by its window's close and still running isn't asked and waited for again: one polite
            // quit each, 6 s at most each.)
            for (pid, app) in self.launched where !self.quitAsked.contains(pid) { await self.quitApp(pid, bundle: app.bundleId) }
            if self.marginSpace > 0, let r = self.sys.reserved(space: self.marginSpace), !r.isZero { _ = self.sys.reserve(.zero, space: self.marginSpace) }
            await self.destroyLeftSpaces()
            self.checkOrphans("at quit")
            self.saveMarker()
            Diagnostics.note("host: quit: everything given back in \(self.ms(since: started)) ms")
        }
    }

    // The shell's poll: a hosted app quit or promoted, its window gone, a left Space destroyed. Skipped while an
    // operation runs (it reads the same things).
    func poll() {
        guard !busy else { return }
        for host in hosts.values {
            if sys.app(pid: host.pid) == nil { appQuit(host.pid); continue }
            if host.launchedByMargin, !host.promoted, sys.policy(pid: host.pid) == .regular { promote(host, why: "its policy reads regular") }
            if sys.bounds(window: host.window) == nil { host.unread += 1 } else { host.unread = 0 }
            if host.unread >= 2 { windowGone(host); continue } // twice in a row: one read can miss mid-transition
            // Where it mustn't be, twice in a row (one read can miss mid-transition): the one shown outside Margin's
            // Space (Margin's window left full screen, the app left full screen itself), a parked one in a user Space.
            let spaces = sys.spaces(window: host.window)
            let strayed = host.phase == .shown ? (spaces.map { $0 != [marginSpace] } ?? false) : host.phase == .parked && !(spaces ?? []).isEmpty
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

    // At launch, before anything is hosted: a crashed Margin's apps out of full screen and quit, its Spaces given back.
    func recover() async {
        await serial { await self.recoverNow() }
    }

    // The window-mode host shown, its app in front and its window raised (a press in Margin's page area around it:
    // the app keeps the keyboard). Nothing for a tiled one (it's beside Margin's window, never under it); nothing for a
    // press on the hosted window itself (the app has that press already: activating it on every click of its own was
    // one more activation of a no-Dock app for nothing); nothing while an operation runs (a switch, a close, Margin's
    // quit: a window being given back is never activated) or once Margin is quitting.
    func activateShown(at point: CGPoint? = nil) async {
        guard !busy, !quitting, let id = shown, let host = hosts[id], host.mode == .window, host.phase == .shown else { return }
        if let point, let b = sys.bounds(window: host.window), b.contains(point) { return }
        _ = await sys.activate(pid: host.pid, window: host.window)
    }

    // ---- what the hosting reads ----

    // Whether `id` is hosted now (opened, shown or parked).
    func isHosted(_ id: HostID) -> Bool { hosts[id] != nil }

    // How `id` is shown (nil: not hosted).
    func mode(of id: HostID) -> HostMode? { hosts[id]?.mode }

    // The window of the window-mode host shown in Margin's Space, nil if none (Margin's window is kept below it).
    var windowedShown: Int? { shown.flatMap { hosts[$0] }.flatMap { $0.mode == .window && $0.phase == .shown ? $0.window : nil } }

    private func announceAbove() {
        let now = windowedShown
        guard now != aboveSaid else { return }
        aboveSaid = now
        keepAbove?(now)
    }

    // One freeze at a time: a step that freezes inside another's (a give-up's close) doesn't freeze or reveal again.
    private func holdFreeze() -> Bool {
        guard !frozenNow else { return false }
        frozenNow = sys.freeze()
        return frozenNow
    }
    private func releaseFreeze(_ mine: Bool) {
        guard mine else { return }
        frozenNow = false
        sys.reveal()
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
        let started = sys.now()
        var times: [String] = []
        // 1-2. the app, and its window.
        let bundle: String
        switch target {
        case .app(let b): bundle = b
        case .safariWindow: bundle = options.safariBundle
        }
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
            // Every window Safari has now, on every Space (the window server's), and the ones Accessibility lists.
            let before = Set((sys.serverWindows(pid: app.pid) ?? []).map(\.number)).union((await sys.windows(pid: app.pid) ?? []).map(\.number))
            guard let request = requestSafariWindow, let asked = await request(profile) else {
                if startedNow { await quitApp(app.pid, bundle: bundle) }
                return fail(id, .window, "Safari's extension wasn't asked for a window (no link)")
            }
            var seen = 0
            _ = await wait(options.windowWait) {
                (number, seen) = self.newSafariWindow(pid: app.pid, before: before, near: asked.bounds)
                return number != nil
            }
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
        let looking = sys.now()
        _ = await wait(personal ? options.personWindowWait : options.windowWait) {
            let listed = (await self.sys.windows(pid: app.pid) ?? []).filter { !self.isHosted(window: $0.number) }
            let usable = listed.filter { !$0.minimized }
            minimizedOnly = !listed.isEmpty && usable.isEmpty
            if !usable.isEmpty {
                let main = await self.sys.mainWindow(pid: app.pid)
                info = usable.first { $0.number == main } ?? usable.first
                number = info?.number
                return true
            }
            if isApp, personal || self.sys.now() - looking >= self.options.serverAfter, !minimizedOnly, let n = self.frontServerWindow(pid: app.pid) { number = n; return true }
            return false
        }
        guard let window = number else {
            if startedNow { await quitApp(app.pid, bundle: bundle) }
            if personal { return fail(id, .window, minimizedOnly ? "\(bundle) has only minimized windows: left as they are" : "\(bundle) is open with no window Margin can host") }
            return fail(id, .window, "no window within \(Int(options.windowWait)) s")
        }
        times.append("window \(ms(since: windowStarted))\(info == nil ? " (by the window server: on another Space)" : "")\(personal ? ", an app the person opened" : "")")
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

    // An app's front window by the window server (every Space): layer 0, drawn, at least 100×100, not hosted.
    private func frontServerWindow(pid: pid_t) -> Int? {
        (sys.serverWindows(pid: pid) ?? []).filter {
            $0.pid == pid && $0.layer == 0 && $0.alpha > 0 && $0.bounds.width >= 100 && $0.bounds.height >= 100 && !isHosted(window: $0.number)
        }.min { $0.order < $1.order }?.number
    }

    // ---- a new app's window, taken as it is ----

    // Its frame and its Space recorded before anything moves it. The person's window already full screen in a Space of
    // its own: left alone (Margin doesn't move other people's full-screen windows). One Accessibility didn't list (on
    // another Space): brought into Margin's Space (current), where it's read (`look`); still unread: not hosted.
    private func take(_ host: Host) async -> (HostStep, String)? {
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
        guard frozenNow, let desktop = home(host.originalSpace, display: host.originalSpace ?? marginSpace), desktop != marginSpace else {
            Diagnostics.note("host: \(host.id): Accessibility didn't list its window in Margin's Space within \(ms(since: t0)) ms\(frozenNow ? "" : " (no freeze: its Desktop isn't made current)")")
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

    // ---- window mode ----

    // A window-mode host shown: the one shown before out of Margin's Space first (a tiled one parked and out of full
    // screen, so Margin's window can take its whole width alone in its Space), Margin's window its whole width and
    // nothing reserved, then its window into Margin's Space (out of its private Space, or off its Desktop) and placed
    // in the page area, Margin's window kept below it. Under the freeze.
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
        // Margin's window its whole width, its own layout (no tile, no narrowing): nothing reserved at its Space's edges.
        if marginSpace > 0, let r = sys.reserved(space: marginSpace), !r.isZero { _ = sys.reserve(.zero, space: marginSpace) }
        tiledWidth = nil
        if let ask = willWindow {
            t0 = sys.now()
            if let p = await ask(host.id), p.page.width >= 1, p.page.height >= 1 { windowPage = p.page }
            step("Margin's window", t0)
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
        let total = ms(since: started)
        Diagnostics.note("host: \(host.id) shown in window mode in \(total) ms (\(times.joined(separator: ", "))\(frozen ? "; under the freeze" : ""))\(placed ? "" : "; NOT fitted to the page area")")
        emit(.shown(host.id, ms: total))
        return .shown(host.id, placed: placed)
    }

    // The page area for a window-mode host: Margin's own layout's (its whole width), else the one the engine has.
    private var windowArea: CGRect { windowPage ?? placement.page }

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
    // server. True: it's at its recorded frame (or Margin never changed it).
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
        var ok = false
        for _ in 1...2 where !ok {
            _ = await sys.setFrame(pid: host.pid, window: host.window, original, size: host.resizable)
            ok = await wait(options.windowPlaceWait) { self.sys.bounds(window: host.window).map { HostLayout.near($0, original, within: self.options.tolerance) } ?? false }
        }
        if ok { host.frameChanged = false } else { Diagnostics.warn("host: \(host.id): its frame wasn't given back (Accessibility didn't take it): kept in the marker") }
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

    // `freezing`: false when the caller froze the screen already.
    private func bringIn(_ host: Host, isNew: Bool, retrying: Bool = false, freezing: Bool = true) async -> HostResult {
        let started = sys.now()
        var times: [String] = []
        func step(_ name: String, _ t0: Double) { times.append("\(name) \(ms(since: t0))") }
        jumps = 0
        let frozen = freezing ? holdFreeze() : false
        defer { releaseFreeze(frozen) }
        let previous = shown.flatMap { $0 == host.id ? nil : hosts[$0] }

        // A new app's window as it was (its frame, its Space) before anything moves it; then how it's shown.
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

        // A parked window back on its display's Desktop (not showing), to go full screen from there.
        if host.phase == .parked, let priv = host.privateSpace {
            let t0 = sys.now()
            guard let desktop = sys.desktop(onDisplayOf: marginSpace), sys.move(window: host.window, to: desktop),
                  await wait(options.parkWait, { self.sys.spaces(window: host.window)?.contains(desktop) == true }) else {
                return fail(host.id, .unpark, "its window didn't come out of its private Space")
            }
            _ = sys.destroyPrivateSpace(priv)
            host.privateSpace = nil
            saveMarker()
            step("unpark", t0)
        }

        // 3. full screen, in a Space of its own; macOS's jump there undone.
        var t0 = sys.now()
        if let reason = await enterFullScreen(host) {
            // An app's window that didn't go full screen (many AppKit apps refuse it with no Dock icon): backed out of
            // whatever it reached, then shown in window mode. Safari's: failed (its window is Margin's own).
            guard case .app = host.target else { return await giveUp(host, isNew: isNew, .fullScreen, reason, previous: nil) }
            Diagnostics.note("host: \(host.id): full screen failed (\(reason)): backed out, shown in window mode")
            await backOut(host)
            host.mode = .window
            saveMarker()
            return await bringInWindow(host, isNew: isNew, retrying: retrying)
        }
        step("full screen", t0)

        // 4. Safari's own sidebar hidden, in a window Margin may touch.
        var sidebar = HostSidebar.closed
        // Its View menu acts on Safari's main window: read and pressed only while that's surely the hosted one. Its
        // main window is read through Accessibility, which sees only the current Space's windows: unread now (the
        // window in its own full-screen Space, Margin's current), it's read again once its tile is in Margin's Space.
        let sidebarOurs = isSafari(host) && (host.launchedByMargin || host.madeByMargin)
        var sidebarLater = false
        if sidebarOurs {
            let main = await sys.mainWindow(pid: host.pid)
            if main == host.window {
                t0 = sys.now()
                sidebar = await hideSidebar(host)
                step("sidebar", t0)
            } else {
                sidebar = .unknown
                sidebarLater = main == nil
                Diagnostics.note(main == nil ? "host: \(host.id): Safari's main window doesn't read (Accessibility lists only the current Space's windows): its sidebar is read again once its tile is in Margin's Space"
                                             : "host: \(host.id): its window isn't Safari's main window: its sidebar is left as it is")
            }
        }

        // 5. the one shown before parked and out of full screen: Margin's Space keeps two tiles.
        if let previous {
            t0 = sys.now()
            guard await retire(previous) else {
                return await giveUp(host, isNew: isNew, .park, "the one shown before (\(previous.id)) couldn't leave Margin's Space", previous: nil)
            }
            step("park \(previous.id)", t0)
        }

        // 6. its tile into Margin's Space.
        t0 = sys.now()
        guard let own = host.fullScreenSpace, let tiles = sys.tiles(of: own), tiles.count == 1, let tile = tiles.first else {
            return await giveUp(host, isNew: isNew, .tile, "its full-screen Space doesn't have exactly one tile", previous: retrying ? nil : previous)
        }
        host.tile = tile
        // Margin's window narrowed to the sidebar's tile, and laid out at that width ALONE in its Space, before the
        // hosted tile comes in: macOS places the split from the tiles' widths at that moment (seen 2026-11-15: narrowed
        // at the same moment, Margin's 250 pt tile stood centred in half the screen and the hosted one got 643 pt).
        // Waited for only when it really narrows, until it's at the tile's width and steady (its resize animates); at
        // that width already (every switch after the first), not at all (it was a fixed 2.1 s at each switch).
        let target = placement.tileWidth
        willTile?(host.id)
        if let wide = sys.bounds(window: marginWindow)?.width, abs(wide - target) > 1 {
            let n0 = sys.now()
            var last = wide
            let steady = await wait(options.narrowWait, every: options.narrowEvery) {
                let now = self.sys.bounds(window: self.marginWindow)?.width ?? last
                defer { last = now }
                return abs(now - target) <= 1 && abs(now - last) < 0.5
            }
            Diagnostics.note("host: Margin's tile \(steady ? "narrowed \(Int(wide)) → \(Int(last))" : "not at \(Int(target)) (\(Int(last)))") in \(ms(since: n0)) ms before \(host.id) came in")
        }
        tiledWidth = target
        guard sys.moveTile(tile, to: marginSpace, at: 1), await wait(options.tileWait, {
            self.sys.tiles(of: self.marginSpace)?.contains(tile) == true && self.sys.spaces(window: host.window) == [self.marginSpace]
                && self.sys.tiles(of: own)?.isEmpty != false
        }) else {
            return await giveUp(host, isNew: isNew, .tile, "its tile didn't land in Margin's Space", previous: retrying ? nil : previous)
        }
        step("tile", t0)

        // 7. its emptied Space destroyed, Margin's showing first.
        t0 = sys.now()
        host.fullScreenSpace = nil
        if await destroyEmptied(own) { step("destroy", t0) } else {
            leftSpaces.insert(own)
            emit(.failed(host.id, .destroy, "its emptied Space \(own) didn't go: tried again later"))
        }
        host.phase = .shown
        shown = host.id
        saveMarker()

        // 4 again: Safari's main window unread before, read now that its window is in the current Space.
        if sidebarLater {
            t0 = sys.now()
            let main = await sys.mainWindow(pid: host.pid)
            if main == host.window {
                sidebar = await hideSidebar(host)
                step("sidebar", t0)
            } else {
                Diagnostics.note("host: \(host.id): Safari's main window \(main == nil ? "still doesn't read" : "is another window"): it can't be known to be the hosted one, its sidebar is left as it is")
            }
        }

        // 8. the page area.
        t0 = sys.now()
        var placed = await place(host)
        if !placed, sidebarOurs, sidebar == .unknown, await sys.mainWindow(pid: host.pid) == host.window {
            // Its sidebar's state didn't read (another language, the title not learned yet): pressed once, and back
            // if the window still doesn't fit.
            if await sys.pressSafariSidebar(pid: host.pid) {
                placed = await place(host)
                if !placed { _ = await sys.pressSafariSidebar(pid: host.pid) }
                Diagnostics.note("host: \(host.id): its window didn't fit with its sidebar unread: pressed once, \(placed ? "it fits" : "pressed back")")
            }
        }
        step("place", t0)
        let total = ms(since: started)
        Diagnostics.note("host: \(host.id) shown in \(total) ms (\(times.joined(separator: ", "))\(frozen ? "; under the freeze" : "; no freeze")\(jumps > 0 ? "; \(jumps) jump\(jumps == 1 ? "" : "s") undone" : ""))\(placed ? "" : "; NOT fitted to the page area")")
        emit(.shown(host.id, ms: total))
        return .shown(host.id, placed: placed)
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

    private func enterFullScreen(_ host: Host) async -> String? {
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
        if copy {
            if ownSpace() == nil { askCopy() }
        } else if await sys.isFullScreen(pid: host.pid, window: host.window) != true {
            guard await sys.setFullScreen(pid: host.pid, window: host.window, true) else { return "AXFullScreen couldn't be set" }
        }
        let asked = sys.now()
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
            if copy, ask?.answer == false { return "its copy didn't ask Safari for full screen (setWindowState)" }
            return "no full-screen Space of its own within \(Int(options.fullScreenWait)) s"
        }
        host.fullScreenSpace = space
        saveMarker()
        undoJump(to: space)
        return nil
    }

    // macOS shows a window's new full-screen Space: the display set back to Margin's at once (under the freeze it
    // isn't seen). Only that Space: a Space the person went to is left alone.
    private func undoJump(to space: UInt64) {
        guard sys.currentSpace(onDisplayOf: marginSpace) == space else { return }
        if sys.setCurrentSpace(marginSpace) { jumps += 1 }
    }

    // A full-screen Space emptied by a tile move, destroyed by the window manager. Margin's Space showing first:
    // destroying the one showing drops the display to the Desktop.
    private func destroyEmptied(_ space: UInt64) async -> Bool {
        if sys.currentSpace(onDisplayOf: marginSpace) == space {
            _ = sys.setCurrentSpace(marginSpace)
            _ = await wait(0.5) { self.sys.currentSpace(onDisplayOf: self.marginSpace) != space }
        }
        guard sys.currentSpace(onDisplayOf: marginSpace) != space, sys.tiles(of: space)?.isEmpty != false else { return false }
        guard sys.destroyFullScreenSpace(space) else { return false }
        return await wait(options.destroyWait) { self.sys.spaceExists(space) == false }
    }

    private func destroyLeftSpaces() async {
        for space in leftSpaces.sorted() {
            if sys.spaceExists(space) == false { leftSpaces.remove(space); continue }
            if await destroyEmptied(space) { leftSpaces.remove(space) }
        }
        saveMarker()
    }

    // The page area: the edges and the spacing reserved, as planned from the placement (HostLayout.plan), verified on
    // the window's own bounds, sent once more.
    @discardableResult private func place(_ host: Host) async -> Bool {
        guard host.phase == .shown else { return false }
        if host.mode == .window { return await placeWindow(host) }
        func r(_ c: CGRect) -> String { "\(Int(c.minX)),\(Int(c.minY)) \(Int(c.width))×\(Int(c.height))" }
        guard let plan = HostLayout.plan(placement) else {
            Diagnostics.note("host: place \(host.id): no plan (\(placement.text))")
            emit(.failed(host.id, .place, "the page area can't be reached beside Margin's tile"))
            return false
        }
        for attempt in 1...2 {
            guard let hosted = sys.bounds(window: host.window) else {
                emit(.failed(host.id, .place, "the windows' bounds didn't read"))
                return false
            }
            if HostLayout.near(hosted, placement.page, within: options.tolerance) { return true }
            let reserved = sys.reserved(space: marginSpace) ?? .zero
            Diagnostics.note("host: place \(host.id) attempt \(attempt): Margin's tile \(sys.bounds(window: marginWindow).map(r) ?? "?"), hosted \(r(hosted)), reserved \(reserved.text), \(placement.text) → reserving \(plan.edges.text), spacing \(Int(plan.spacing))")
            _ = sys.setTileSpacing(plan.spacing, space: marginSpace)
            if reserved != plan.edges || attempt == 2 { _ = sys.reserve(plan.edges, space: marginSpace) }
            if await wait(options.placeWait, { self.sys.bounds(window: host.window).map { HostLayout.near($0, self.placement.page, within: self.options.tolerance) } ?? false }) {
                return true
            }
        }
        emit(.failed(host.id, .place, "its window didn't take the page area's size"))
        return false
    }

    // The one shown parked with nothing in its place: out of Margin's Space into a private one, out of full screen
    // there; failing that, out of full screen wherever it is, then parked. Margin's Space's reservation given back
    // (Margin's own tile alone takes its whole Space again).
    private func parkShownNow(why: String) async {
        guard let id = shown, let host = hosts[id] else { return }
        let t0 = sys.now()
        // (Strayed, it may be in a full-screen Space of its own by now: given back once it's emptied.)
        let was = (sys.spaces(window: host.window) ?? []).filter { $0 != marginSpace && sys.spaceType($0) == ManagedSpace.fullScreenType }
        if await !retire(host, putBack: false) {
            await backOut(host)
            await park(host)
            emit(.parked(id))
        }
        shown = nil
        tiledWidth = nil
        for space in was where sys.spaceExists(space) == true && sys.tiles(of: space)?.isEmpty != false {
            if await !destroyEmptied(space) { leftSpaces.insert(space) }
        }
        if marginSpace > 0, sys.spaceExists(marginSpace) == true, let r = sys.reserved(space: marginSpace), !r.isZero { _ = sys.reserve(.zero, space: marginSpace) }
        saveMarker()
        Diagnostics.note("host: \(id) parked, nothing shown (\(why)) in \(ms(since: t0)) ms")
        emit(.unshown(id))
    }

    // The poll found a host where it mustn't be: the one shown outside Margin's Space parked with nothing in its place;
    // a parked one in a user Space (macOS put it on a Desktop, its app took it to full screen) parked again.
    private func strayed(_ id: HostID) async {
        guard let host = hosts[id] else { return }
        if host.phase == .shown, shown == id {
            await parkShownNow(why: "its window left Margin's Space")
        } else if host.phase == .parked, let spaces = sys.spaces(window: host.window), !spaces.isEmpty {
            Diagnostics.note("host: \(id): parked, found in a user Space: parked again")
            if await isFullScreen(host) == true || spaces.contains(where: { sys.spaceType($0) == ManagedSpace.fullScreenType }) { await backOut(host) }
            if let priv = host.privateSpace, sys.move(window: host.window, to: priv) {
                _ = await wait(options.parkWait) { self.sys.spaces(window: host.window) == [] }
            } else {
                host.privateSpace = nil
                await park(host)
            }
            saveMarker()
        }
    }

    // The one shown before: parked in a private Space, then out of full screen there (its tile then leaves
    // Margin's Space), then checked still parked. `putBack`: still full screen, it's put back in Margin's Space (a
    // switch that can't go on); else (Margin's window leaving full screen) it's left to the caller.
    private func retire(_ host: Host, putBack: Bool = true) async -> Bool {
        if host.mode == .window { return await retireWindow(host) }
        guard let tile = host.tile else { return false }
        guard let priv = sys.createPrivateSpace() else { return false }
        guard sys.move(window: host.window, to: priv), await wait(options.parkWait, { self.sys.spaces(window: host.window) == [] }) else {
            _ = sys.destroyPrivateSpace(priv)
            return false
        }
        host.privateSpace = priv
        saveMarker()
        _ = await setFullScreen(host, false)
        let copy = viaCopy(host)
        let out = await wait(options.exitWait) {
            // (Through the copy, in its private Space the window's full screen doesn't read: its tile leaving tells.)
            let full = await self.isFullScreen(host)
            // (Margin's Space gone with its window's full screen: no tile of it left there either.)
            return (copy ? full != true : full == false) && self.sys.tiles(of: self.marginSpace)?.contains(tile) != true
        }
        guard out else {
            // Still full screen: back in Margin's Space, as it was (a switch), or left to the caller in its private
            // Space (Margin's window leaving full screen: never put back).
            if putBack {
                _ = sys.move(window: host.window, to: marginSpace)
                _ = sys.destroyPrivateSpace(priv)
                host.privateSpace = nil
                saveMarker()
            }
            return false
        }
        // Out of full screen macOS may put it on a Desktop: parked again.
        if sys.spaces(window: host.window) != [] {
            _ = sys.move(window: host.window, to: priv)
            _ = await wait(options.parkWait) { self.sys.spaces(window: host.window) == [] }
        }
        host.tile = nil
        host.phase = .parked
        if shown == host.id { shown = nil }
        saveMarker()
        emit(.parked(host.id))
        return true
    }

    // A step failed while showing `host`: it leaves full screen (its Space goes with it), an emptied Space of its is
    // destroyed; a new one is closed again, one shown before is parked again. `previous`: the one shown before, already
    // parked by this show: shown again.
    private func giveUp(_ host: Host, isNew: Bool, _ step: HostStep, _ reason: String, previous: Host?) async -> HostResult {
        let result = fail(host.id, step, reason)
        await backOut(host)
        if isNew { await closeNow(host.id, why: "its open failed") } else { await park(host) }
        if let previous, previous.phase == .parked, shown == nil {
            Diagnostics.note("host: \(previous.id) shown again after \(host.id)'s show failed")
            _ = await bringIn(previous, isNew: false, retrying: true)
        }
        return result
    }

    // Out of full screen, wherever it is, and no Space of its left behind.
    private func backOut(_ host: Host) async {
        let own = host.fullScreenSpace
        let copy = viaCopy(host)
        if await isFullScreen(host) == true || (copy && (own != nil || host.tile != nil)) {
            _ = await setFullScreen(host, false)
            _ = await wait(options.exitWait) {
                let full = await self.isFullScreen(host)
                // (Through the copy, out of a private Space: a normal window is one on a Desktop, read by the window
                // server; in no Space at all it's still leaving full screen.)
                return (copy && host.privateSpace != nil ? full != true : full == false) && (host.tile.map { self.sys.tiles(of: self.marginSpace)?.contains($0) != true } ?? true)
            }
        }
        if let own, sys.spaceExists(own) == true, sys.tiles(of: own)?.isEmpty != false, await !destroyEmptied(own) { leftSpaces.insert(own) }
        host.fullScreenSpace = nil
        host.tile = nil
        if shown == host.id { shown = nil }
        saveMarker()
    }

    // Out of sight in a private Space (not in Mission Control), out of full screen; a window-mode one's frame given back
    // first (while it's on the current Space).
    private func park(_ host: Host) async {
        if host.mode == .window { await restoreFrame(host) }
        if host.privateSpace == nil, let priv = sys.createPrivateSpace() {
            if sys.move(window: host.window, to: priv), await wait(options.parkWait, { self.sys.spaces(window: host.window) == [] }) {
                host.privateSpace = priv
                host.away = true
            } else { _ = sys.destroyPrivateSpace(priv) }
        }
        host.phase = .parked
        if shown == host.id { shown = nil }
        saveMarker()
    }

    // ---- closing ----

    // Given back: out of full screen (a window-mode one: its frame as it was, under the freeze while it's shown), the
    // windows of the person's apps and window-mode ones back in their Space, then an app Margin started quit (after
    // its frame is back, so it saves that one); an app the person opened is never quit.
    private func closeNow(_ id: HostID, why: String) async {
        guard let host = hosts[id] else { return }
        let started = sys.now()
        let frozen = host.mode == .window && host.phase == .shown ? holdFreeze() : false
        defer { releaseFreeze(frozen) }
        if host.mode == .window {
            await restoreFrame(host)
            if shown == id { shown = nil }
        } else if host.phase == .shown || host.fullScreenSpace != nil { await backOut(host) }
        let sharesApp = hosts.values.contains { $0.id != id && $0.pid == host.pid }
        let quits = host.launchedByMargin && !sharesApp
        // An iPad app Margin quits: its window closed first, its frame back already (its quit waits 5 s for a window
        // that's open: closeBeforeQuit). Closed, there's nothing to take home; not closed, it goes home as any.
        let closed = quits && host.safariWindow == nil && sys.isUIKitApp(pid: host.pid) ? await closeBeforeQuit(host) : false
        if !closed, host.mode == .window || host.personApp { await returnHome(host) }
        if let ext = host.safariWindow {
            // A window a copy made for Margin: a normal window first (out of its private Space onto the Desktop, out of
            // full screen), then closed by that copy and confirmed by the window server (before its Safari is quit, if
            // Margin started it: a window closed isn't one Safari restores). Seen 2026-11-15: asked to close while
            // still parked or full screen, it wasn't.
            await toNormal(host)
            let closed = await closeAskedSafariWindow(ext, profile: host.profile, pid: host.pid, number: host.window, why: why)
            if !closed, !quits, host.privateSpace != nil, let desktop = sys.desktop(onDisplayOf: marginSpace) {
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
            await quitApp(host.pid, bundle: sys.app(pid: host.pid)?.bundleId ?? id.raw, parked: host)
        }
        if let priv = host.privateSpace { _ = sys.destroyPrivateSpace(priv) }
        hosts[id] = nil
        if !hosts.values.contains(where: { $0.pid == host.pid }) { sys.stopWatchingOpens(pid: host.pid) }
        saveMarker()
        Diagnostics.note("host: \(id) closed (\(why)) in \(ms(since: started)) ms")
        emit(.closed(id))
    }

    // A Safari window Margin made, back to a normal window before its copy closes it: out of its private Space onto
    // its display's Desktop, then out of full screen there (by its copy), waited for until the window server has it in
    // a Space that isn't a full-screen one.
    private func toNormal(_ host: Host) async {
        if let priv = host.privateSpace, let desktop = sys.desktop(onDisplayOf: marginSpace), sys.move(window: host.window, to: desktop) {
            _ = await wait(options.parkWait) { self.sys.spaces(window: host.window)?.contains(desktop) == true }
            _ = sys.destroyPrivateSpace(priv)
            host.privateSpace = nil
            saveMarker()
        }
        guard await isFullScreen(host) == true else { return }
        _ = await setFullScreen(host, false)
        _ = await wait(options.exitWait) { await self.isFullScreen(host) == false }
    }

    // An iPad or Mac Catalyst app's window closed before Margin quits that app (only one Margin started, never the
    // person's): such an app's own quit hides its windows first, and for one started with no Dock icon that hide never
    // comes while a window of its is ordered in, on any Space (its logs, 2026-11-15: FaceTime parked or given back to
    // its Desktop, Maps parked: "App took too long to enter the background-only state", out after its own 5 s
    // watchdog; FaceTime with no window ordered in: out in 0.5 s). Its frame is back first (closing saves it as it is).
    // Accessibility presses its close button on the current Space (where it reads windows): a window elsewhere is
    // brought there first, under the freeze. Gone by the window server's reading: true.
    private func closeBeforeQuit(_ host: Host) async -> Bool {
        let t0 = sys.now()
        let frozen = holdFreeze()
        defer { releaseFreeze(frozen) }
        guard let current = sys.currentSpace(onDisplayOf: host.originalSpace ?? marginSpace) else { return false }
        if sys.spaces(window: host.window)?.contains(current) != true {
            host.away = true
            guard sys.move(window: host.window, to: current), await wait(options.parkWait, { self.sys.spaces(window: host.window)?.contains(current) == true }) else {
                Diagnostics.note("host: \(host.id): its window didn't come to the current Space to be closed: quit with it open")
                return false
            }
            if let priv = host.privateSpace { _ = sys.destroyPrivateSpace(priv); host.privateSpace = nil }
            saveMarker()
        }
        // (Accessibility may list a window brought here a moment late: pressed again until it takes it.)
        let pressed = await wait(options.closeWait, every: options.lookEvery) { await self.sys.close(pid: host.pid, window: host.window) }
        guard pressed, await wait(options.closeWait, { self.sys.bounds(window: host.window) == nil }) else {
            Diagnostics.note("host: \(host.id): its window didn't close by its close button in \(ms(since: t0)) ms (\(pressed ? "pressed" : "not pressed")): quit with it open")
            return false
        }
        host.away = false
        saveMarker()
        Diagnostics.note("host: \(host.id): its window closed before its quit in \(ms(since: t0)) ms (an iPad app's quit waits 5 s for a window that's open)")
        return true
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

    // ---- the crash marker ----

    private func saveMarker() {
        announceAbove()
        guard let markerURL else { return }
        var m = HostMarker(pid: ownPid, marginSpace: hosts.isEmpty ? nil : marginSpace)
        m.apps = launched.values.sorted { $0.pid < $1.pid }.map { HostMarker.App(pid: $0.pid, bundleId: $0.bundleId, launchedAt: $0.launchedAt) }
        m.windows = hosts.values.sorted { $0.window < $1.window }.map {
            var w = HostMarker.Window(number: $0.window, pid: $0.pid, ownSafariWindow: $0.madeByMargin, privateSpace: $0.privateSpace, fullScreenSpace: $0.fullScreenSpace,
                                      safariWindow: $0.safariWindow, profile: $0.profile, appLaunchedAt: $0.safariWindow == nil ? nil : sys.app(pid: $0.pid)?.launchedAt)
            if $0.mode == .window || $0.personApp {
                w.mode = $0.mode
                w.bundleId = $0.bundleId
                w.personApp = $0.personApp
                w.appLaunchedAt = $0.appLaunchedAt
                w.frame = $0.original
                w.originalSpace = $0.originalSpace
                w.frameChanged = $0.frameChanged
                w.resizable = $0.resizable
            }
            return w
        }
        m.leftSpaces = leftSpaces.sorted()
        m.leftSafariWindows = leftSafariWindows.isEmpty ? nil : leftSafariWindows
        if m.isEmpty { try? FileManager.default.removeItem(at: markerURL); return }
        if !m.write(markerURL) { Diagnostics.warn("host: the crash marker wasn't written") }
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
        var outOfFullScreen = 0, givenBack = 0
        for w in m.windows {
            let person = samePerson(w)
            let ours = alivePids.contains(w.pid) || (w.ownSafariWindow && sameSafari(w.pid, w.appLaunchedAt)) || person
            if ours, w.mode != .window, await sys.isFullScreen(pid: w.pid, window: w.number) == true {
                _ = await sys.setFullScreen(pid: w.pid, window: w.number, false)
                if await wait(options.exitWait, { await self.sys.isFullScreen(pid: w.pid, window: w.number) == false }) { outOfFullScreen += 1 }
            }
            // A window-mode window, or the person's own: back in its Space, its frame as it was (before its app is quit
            // below, if Margin started it, so the app saves that frame).
            if ours, w.mode == .window || person, await giveBack(w, marginSpace: m.marginSpace) { givenBack += 1 }
            if w.ownSafariWindow, sameSafari(w.pid, w.appLaunchedAt), w.privateSpace != nil || sys.spaces(window: w.number) == [],
               let space = m.marginSpace ?? w.fullScreenSpace ?? m.leftSpaces.first, let desktop = sys.desktop(onDisplayOf: space) {
                _ = sys.move(window: w.number, to: desktop) // in no Space: on the Desktop until its copy closes it
            }
            // A window a copy made for Margin in a Safari that keeps running: closed by that copy once it links.
            if let ext = w.safariWindow, !alivePids.contains(w.pid), sameSafari(w.pid, w.appLaunchedAt) {
                leftSafariWindows.append(HostMarker.SafariWindow(safariWindow: ext, profile: w.profile, pid: w.pid, appLaunchedAt: w.appLaunchedAt, number: w.number))
            }
        }
        for entry in m.leftSafariWindows ?? [] where !alivePids.contains(entry.pid) && sameSafari(entry.pid, entry.appLaunchedAt) && !leftSafariWindows.contains(entry) {
            leftSafariWindows.append(entry)
        }
        var quit = 0
        for a in alive {
            _ = sys.terminate(pid: a.pid)
            if await wait(options.quitWait, { self.sys.app(pid: a.pid) == nil }) { quit += 1 }
        }
        for w in m.windows { if let p = w.privateSpace { _ = sys.destroyPrivateSpace(p) } }
        let ownerless = Set(sys.ownerlessFullScreenSpaces() ?? [])
        var destroyed = 0
        for space in Set(m.leftSpaces + m.windows.compactMap(\.fullScreenSpace)) where ownerless.contains(space) {
            if let desktop = sys.desktop(onDisplayOf: space), sys.currentSpace(onDisplayOf: space) == space { _ = sys.setCurrentSpace(desktop) }
            if sys.destroyFullScreenSpace(space), await wait(options.destroyWait, { self.sys.spaceExists(space) == false }) { destroyed += 1 }
        }
        if let s = m.marginSpace, sys.spaceExists(s) == true, let r = sys.reserved(space: s), !r.isZero { _ = sys.reserve(.zero, space: s) }
        try? FileManager.default.removeItem(at: markerURL)
        // Safari windows Margin asked for: closed by their copies now if linked, else kept in the marker for the poll.
        if !leftSafariWindows.isEmpty { await closeLeftSafariWindows() }
        Diagnostics.note("host: a marker from a Margin that didn't quit cleanly: \(m.apps.count) app\(m.apps.count == 1 ? "" : "s") (\(alive.count) still running, \(quit) quit), "
                         + "\(m.windows.count) window\(m.windows.count == 1 ? "" : "s") (\(outOfFullScreen) out of full screen, \(givenBack) given back where they were), \(destroyed) emptied Space\(destroyed == 1 ? "" : "s") destroyed, "
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
