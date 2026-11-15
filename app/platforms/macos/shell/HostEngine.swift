// The host engine (docs/MARGIN-APP.md phase 3, "Mission Control" in its "Not solved yet"): another app's window
// shown in Margin's page area, as the test kit proved it step by step. A state machine over HostSystem, so every
// step and every fallback runs in the unit tests against a stand-in (shell/tests/host-tests.swift).
//
// Showing a host (`open`, `show`), under the freeze, each step verified and timed:
//   1. launch   an app not running is started with no Dock icon (`-NSMenuEnableMenuBarAgent NO`: it never shows
//               its own title strip; Safari also `-AutoShowToolbarInFullScreen YES`). An app already running that
//               Margin didn't start is refused: it keeps its Dock icon and Margin never touches it. Safari is the
//               exception: Margin asks its own extension for a new window there (`requestSafariWindow`) and hosts
//               only that window; Safari is never restarted.
//   2. window   its first window that can go full screen (Safari: the new one Margin asked for, found by the window
//               server: a new layer-0 window of Safari's pid. Accessibility lists only the current Space's windows,
//               and a normal window can't open in Margin's full-screen Space, so Safari's opens on a Desktop).
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
//               bounds are the page area within 1 pt.
// A failure falls back without leaving anything behind: the window out of full screen (its Space then goes), an
// emptied Space destroyed, an app Margin started for that open quit again, the one shown before shown again. A
// Safari window Margin asked for is closed by its copy at every failure after the ask; one whose close isn't
// confirmed is kept in the marker (`leftSafariWindows`) and closed later (the poll, quit, the next launch).
//
// Safety: no window is ever moved or resized through Accessibility; only apps Margin started (and the Safari
// windows it made) are touched; a marker (hosted.json) lists them for the next launch after a crash (`recover`),
// which takes them out of full screen and quits them (never leaving an app saved as in full screen). Every
// operation runs one at a time, in the order asked.

import AppKit

final class HostEngine {
    struct Options {
        var launchWait = 10.0 // the app's process after it's asked to start
        var windowWait = 12.0 // its first window (Safari restoring windows can take a while)
        var fullScreenWait = 6.0
        var fullScreenAskAgain = 4.0 // AXFullScreen asked once more if no Space came by then (as the kit did)
        var tileWait = 1.5
        var destroyWait = 1.5
        var placeWait = 1.5
        var parkWait = 0.6 // two tries of 300 ms, as the parker
        var exitWait = 7.0 // out of full screen (an app animates it)
        var quitWait = 5.0
        var every = 0.02
        var tolerance: CGFloat = 1
        var safariBundle = safariIdentifier
        var appArguments = ["-NSMenuEnableMenuBarAgent", "NO"]
        var safariArguments = ["-NSMenuEnableMenuBarAgent", "NO", "-AutoShowToolbarInFullScreen", "YES"]
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
        init(id: HostID, target: HostTarget, pid: pid_t, window: Int, launchedByMargin: Bool, madeByMargin: Bool, safariWindow: Int? = nil) {
            self.id = id
            self.target = target
            self.pid = pid
            self.window = window
            self.launchedByMargin = launchedByMargin
            self.madeByMargin = madeByMargin
            self.safariWindow = safariWindow
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
    private(set) var shown: HostID?
    private(set) var launched: [pid_t: HostApp] = [:] // apps Margin started, while they run
    private(set) var leftSpaces: Set<UInt64> = [] // emptied full-screen Spaces a destroy hasn't taken yet
    private(set) var leftSafariWindows: [HostMarker.SafariWindow] = [] // Safari windows Margin asked for, their close not confirmed
    private(set) var pageRect = CGRect.zero // top-left coordinates, as the window server's bounds
    private(set) var marginWindow = 0
    private(set) var marginSpace: UInt64 = 0
    private(set) var busy = false
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
    var hasLeftSafariWindows: Bool { !leftSafariWindows.isEmpty }

    // ---- the API ----

    func open(app target: HostTarget, in pageRect: CGRect, marginWindow: Int, marginSpace: UInt64) async -> HostResult {
        await serial {
            self.pageRect = pageRect
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

    func pageRectChanged(_ rect: CGRect) async -> Bool {
        await serial {
            self.pageRect = rect
            guard let id = self.shown, let host = self.hosts[id] else { return true }
            return await self.place(host)
        }
    }

    // Margin quits: the one shown out of full screen while it's still tiled, then every app Margin started quit, the
    // Safari windows it made closed, its Spaces given back.
    func quitAll() async {
        await serial {
            let started = self.sys.now()
            let order = (self.shown.map { [$0] } ?? []) + self.hosts.keys.filter { $0 != self.shown }.sorted { $0.raw < $1.raw }
            for id in order { await self.closeNow(id, why: "Margin quits") }
            await self.closeLeftSafariWindows()
            for (pid, app) in self.launched { await self.quitApp(pid, bundle: app.bundleId) }
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
            if host.unread >= 2 { windowGone(host) } // twice in a row: one read can miss mid-transition
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

    // ---- what the hosting reads ----

    // Whether `id` is hosted now (opened, shown or parked).
    func isHosted(_ id: HostID) -> Bool { hosts[id] != nil }

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
        if let host = hosts[id] {
            if shown == id { return .shown(id, placed: await place(host)) }
            return await bringIn(host, isNew: false)
        }
        guard sys.spaceType(marginSpace) == ManagedSpace.fullScreenType, sys.spaces(window: marginWindow)?.contains(marginSpace) == true else {
            return fail(id, .margin, "Margin's window isn't in a full-screen Space of its own (\(marginSpace))")
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
            app = first
            if case .app = target, launched[first.pid] == nil {
                return fail(id, .launch, "\(bundle) is already running, not started by Margin: it keeps its Dock icon and isn't hosted")
            }
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
        } else {
            _ = await wait(options.windowWait) {
                number = (await self.sys.windows(pid: app.pid) ?? []).first { !self.isHosted(window: $0.number) }?.number
                return number != nil
            }
        }
        guard let window = number else {
            if startedNow { await quitApp(app.pid, bundle: bundle) }
            return fail(id, .window, "no window that can go full screen within \(Int(options.windowWait)) s")
        }
        times.append("window \(ms(since: windowStarted))")
        let host = Host(id: id, target: target, pid: app.pid, window: window, launchedByMargin: launchedByMargin, madeByMargin: false)
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

    // ---- showing ----

    private func bringIn(_ host: Host, isNew: Bool, retrying: Bool = false) async -> HostResult {
        let started = sys.now()
        var times: [String] = []
        func step(_ name: String, _ t0: Double) { times.append("\(name) \(ms(since: t0))") }
        jumps = 0
        let frozen = sys.freeze()
        defer { if frozen { sys.reveal() } }
        let previous = shown.flatMap { $0 == host.id ? nil : hosts[$0] }

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
        if let reason = await enterFullScreen(host) { return await giveUp(host, isNew: isNew, .fullScreen, reason, previous: nil) }
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
        let wide = sys.bounds(window: marginWindow)?.width
        willTile?(host.id)
        if let wide {
            let narrowed = await wait(options.tileWait) { (self.sys.bounds(window: self.marginWindow)?.width ?? wide) < wide - 1 }
            var last = sys.bounds(window: marginWindow)?.width ?? 0
            _ = await wait(0.6) { // steady for a moment (its resize animates)
                let now = self.sys.bounds(window: self.marginWindow)?.width ?? 0
                defer { last = now }
                return narrowed && abs(now - last) < 0.5
            }
            Diagnostics.note("host: Margin's tile \(narrowed ? "narrowed to \(Int(last))" : "not narrowed (still \(Int(wide)))") before \(host.id) came in")
        }
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

    // The page area: the edges and the spacing reserved, verified on the window's own bounds, sent once more.
    @discardableResult private func place(_ host: Host) async -> Bool {
        guard host.phase == .shown else { return false }
        for attempt in 1...2 {
            guard let margin = sys.bounds(window: marginWindow), let hosted = sys.bounds(window: host.window) else {
                emit(.failed(host.id, .place, "the windows' bounds didn't read"))
                return false
            }
            if HostLayout.near(hosted, pageRect, within: options.tolerance) { return true }
            func r(_ c: CGRect) -> String { "\(Int(c.minX)),\(Int(c.minY)) \(Int(c.width))×\(Int(c.height))" }
            Diagnostics.note("host: place \(host.id) attempt \(attempt): Margin's tile \(r(margin)), hosted \(r(hosted)), reserved \((sys.reserved(space: marginSpace) ?? .zero).text), page \(r(pageRect))")
            var plan = HostLayout.plan(margin: margin, hosted: hosted, reserved: sys.reserved(space: marginSpace) ?? .zero, page: pageRect)
            if plan == nil {
                // Margin's tile still being laid out at its new width: read again for a moment.
                _ = await wait(options.placeWait) {
                    guard let m = self.sys.bounds(window: self.marginWindow), let h = self.sys.bounds(window: host.window) else { return false }
                    plan = HostLayout.plan(margin: m, hosted: h, reserved: self.sys.reserved(space: self.marginSpace) ?? .zero, page: self.pageRect)
                    return plan != nil
                }
            }
            guard let plan else {
                let m2 = sys.bounds(window: marginWindow).map(r) ?? "?", h2 = sys.bounds(window: host.window).map(r) ?? "?"
            Diagnostics.note("host: place \(host.id): no plan (Margin's tile \(m2), hosted \(h2), reserved \((sys.reserved(space: marginSpace) ?? .zero).text))")
            emit(.failed(host.id, .place, "the page area can't be reached beside Margin's tile"))
                return false
            }
            Diagnostics.note("host: place \(host.id) attempt \(attempt): reserving \(plan.edges.text), spacing \(Int(plan.spacing))")
            _ = sys.setTileSpacing(plan.spacing, space: marginSpace)
            _ = sys.reserve(plan.edges, space: marginSpace)
            if await wait(options.placeWait, { self.sys.bounds(window: host.window).map { HostLayout.near($0, self.pageRect, within: self.options.tolerance) } ?? false }) {
                return true
            }
            if attempt == 2 { break }
        }
        emit(.failed(host.id, .place, "its window didn't take the page area's size"))
        return false
    }

    // The one shown before: parked in a private Space, then out of full screen there (its tile then leaves
    // Margin's Space), then checked still parked.
    private func retire(_ host: Host) async -> Bool {
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
            return (copy ? full != true : full == false) && self.sys.tiles(of: self.marginSpace)?.contains(tile) == false
        }
        guard out else {
            // Still full screen: back in Margin's Space, as it was.
            _ = sys.move(window: host.window, to: marginSpace)
            _ = sys.destroyPrivateSpace(priv)
            host.privateSpace = nil
            saveMarker()
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
                return (copy ? full != true : full == false) && (host.tile.map { self.sys.tiles(of: self.marginSpace)?.contains($0) == false } ?? true)
            }
        }
        if let own, sys.spaceExists(own) == true, sys.tiles(of: own)?.isEmpty != false, await !destroyEmptied(own) { leftSpaces.insert(own) }
        host.fullScreenSpace = nil
        host.tile = nil
        if shown == host.id { shown = nil }
        saveMarker()
    }

    // Out of sight in a private Space (not in Mission Control), out of full screen.
    private func park(_ host: Host) async {
        if host.privateSpace == nil, let priv = sys.createPrivateSpace() {
            if sys.move(window: host.window, to: priv), await wait(options.parkWait, { self.sys.spaces(window: host.window) == [] }) {
                host.privateSpace = priv
            } else { _ = sys.destroyPrivateSpace(priv) }
        }
        host.phase = .parked
        saveMarker()
    }

    // ---- closing ----

    private func closeNow(_ id: HostID, why: String) async {
        guard let host = hosts[id] else { return }
        let started = sys.now()
        if host.phase == .shown || host.fullScreenSpace != nil { await backOut(host) }
        let sharesApp = hosts.values.contains { $0.id != id && $0.pid == host.pid }
        let quits = host.launchedByMargin && !sharesApp
        if let ext = host.safariWindow {
            // A window a copy made for Margin: closed by that copy (before its Safari is quit, if Margin started it:
            // a window closed isn't one Safari restores).
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

    // An app Margin started, quit (politely): once gone it's forgotten. One that doesn't quit (it may be asking about
    // unsaved work) has its window put on the Desktop for the person.
    private func quitApp(_ pid: pid_t, bundle: String, parked: Host? = nil) async {
        guard sys.app(pid: pid) != nil else { launched[pid] = nil; saveMarker(); return }
        _ = sys.terminate(pid: pid)
        if await wait(options.quitWait, { self.sys.app(pid: pid) == nil }) {
            launched[pid] = nil
            leftSafariWindows.removeAll { $0.pid == pid } // its windows went with it
        } else {
            if let parked, parked.privateSpace != nil, let desktop = sys.desktop(onDisplayOf: marginSpace) { _ = sys.move(window: parked.window, to: desktop) }
            Diagnostics.warn("host: \(bundle) (pid \(pid)) didn't quit within \(Int(options.quitWait)) s: left running, its window on the Desktop")
            emit(.failed(parked?.id ?? HostID(raw: "app:" + bundle), .quit, "didn't quit"))
        }
        saveMarker()
    }

    // ---- Safari windows Margin asked for ----

    // A Safari window a copy made for Margin, closed by that copy; confirmed by the window server when its number is
    // known. Not confirmed: kept in the marker (`leftSafariWindows`) and closed later. True: closed.
    @discardableResult private func closeAskedSafariWindow(_ ext: Int, profile: String?, pid: pid_t, number: Int?, why: String) async -> Bool {
        var closed = false
        if let closer = closeSafariWindow, await closer(profile, ext) {
            closed = await gone(number)
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
            if await gone(entry.number) {
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
                promote(host, why: "LaunchServices \(code)")
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
        guard let markerURL else { return }
        var m = HostMarker(pid: ownPid, marginSpace: hosts.isEmpty ? nil : marginSpace)
        m.apps = launched.values.sorted { $0.pid < $1.pid }.map { HostMarker.App(pid: $0.pid, bundleId: $0.bundleId, launchedAt: $0.launchedAt) }
        m.windows = hosts.values.sorted { $0.window < $1.window }.map {
            HostMarker.Window(number: $0.window, pid: $0.pid, ownSafariWindow: $0.madeByMargin, privateSpace: $0.privateSpace, fullScreenSpace: $0.fullScreenSpace,
                              safariWindow: $0.safariWindow, profile: $0.profile, appLaunchedAt: $0.safariWindow == nil ? nil : sys.app(pid: $0.pid)?.launchedAt)
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
        var outOfFullScreen = 0
        for w in m.windows {
            let ours = alivePids.contains(w.pid) || (w.ownSafariWindow && sameSafari(w.pid, w.appLaunchedAt))
            if ours, await sys.isFullScreen(pid: w.pid, window: w.number) == true {
                _ = await sys.setFullScreen(pid: w.pid, window: w.number, false)
                if await wait(options.exitWait, { await self.sys.isFullScreen(pid: w.pid, window: w.number) == false }) { outOfFullScreen += 1 }
            }
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
                         + "\(m.windows.count) window\(m.windows.count == 1 ? "" : "s") (\(outOfFullScreen) out of full screen), \(destroyed) emptied Space\(destroyed == 1 ? "" : "s") destroyed, "
                         + "\(leftSafariWindows.count) Safari window\(leftSafariWindows.count == 1 ? "" : "s") Margin asked for still to close, in \(ms(since: started)) ms")
        checkOrphans("after recovery")
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

    private func wait(_ seconds: Double, _ done: () async -> Bool) async -> Bool {
        let until = sys.now() + seconds
        while true {
            if await done() { return true }
            if sys.now() >= until { return false }
            await sys.sleep(options.every)
        }
    }
}
