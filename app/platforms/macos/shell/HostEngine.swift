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
//   2. window   its first window that can go full screen (Safari: the new one Margin asked for).
//   3. full screen  AXFullScreen on; done once the window is in a full-screen Space of its own. macOS's jump to
//               that Space is undone at once (the display set back to Margin's Space).
//   4. sidebar  (Safari, a window Margin made or a Safari Margin started) its own sidebar hidden by its View menu.
//   5. park the one shown before: into a private Space, then out of full screen there, so Margin's Space keeps
//               two tiles only (a parked tile keeps its place otherwise).
//   6. tile     the window's tile moved into Margin's full-screen Space, beside Margin's own (index 1).
//   7. destroy  its emptied Space destroyed by the window manager (Mission Control then lists Margin's Space
//               only); never while it's the one showing (that drops the display to the Desktop).
//   8. place    the page area's other edges reserved, and the spacing between the tiles set, until the window's
//               bounds are the page area within 1 pt.
// A failure falls back without leaving anything behind: the window out of full screen (its Space then goes), an
// emptied Space destroyed, an app Margin started for that open quit again, the one shown before shown again.
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
        var phase = Phase.preparing
        var tile: UInt64?
        var fullScreenSpace: UInt64? // its own full-screen Space while it has one
        var privateSpace: UInt64? // while parked
        var promoted = false
        var outsideOpens = 0
        var unread = 0 // polls in a row its window's bounds didn't read
        init(id: HostID, target: HostTarget, pid: pid_t, window: Int, launchedByMargin: Bool, madeByMargin: Bool) {
            self.id = id
            self.target = target
            self.pid = pid
            self.window = window
            self.launchedByMargin = launchedByMargin
            self.madeByMargin = madeByMargin
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
    private(set) var pageRect = CGRect.zero // top-left coordinates, as the window server's bounds
    private(set) var marginWindow = 0
    private(set) var marginSpace: UInt64 = 0
    private(set) var busy = false
    var onEvent: ((HostEvent) -> Void)?
    // Wired by the shell to the extension's request for a new window (a profile's; nil the default one). True: asked.
    var requestSafariWindow: ((String?) async -> Bool)?
    // Wired by the shell to the extension's close of a window Margin made (by its window number). True: asked.
    var closeSafariWindow: ((Int) async -> Bool)?

    private var tail: Task<Void, Never>?
    private var jumps = 0

    init(system: HostSystem, marker: URL?, options: Options = Options(), pid: Int32 = ProcessInfo.processInfo.processIdentifier) {
        sys = system
        markerURL = marker
        self.options = options
        ownPid = pid
        sys.onAppQuit = { [weak self] pid in self?.appQuit(pid) }
    }

    var hasHosts: Bool { !hosts.isEmpty || !launched.isEmpty }

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
    }

    // At launch, before anything is hosted: a crashed Margin's apps out of full screen and quit, its Spaces given back.
    func recover() async {
        await serial { await self.recoverNow() }
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
        var made = false
        if case .safariWindow(let profile) = target, !launchedByMargin || profile != nil || hosts.values.contains(where: { $0.pid == app.pid }) {
            // A window of Margin's own in Safari: asked of its extension, known as the window that wasn't there before.
            if !launchedByMargin {
                switch sys.safariAutoShowsToolbar() {
                case false?: Diagnostics.note("host: Safari's own AutoShowToolbarInFullScreen is off: its toolbar shows over the page in full screen (known gap; its setting is left as it is)")
                case nil: Diagnostics.note("host: Safari's AutoShowToolbarInFullScreen didn't read: its own setting decides whether its toolbar shows")
                default: break
                }
            }
            let before = Set((await sys.windows(pid: app.pid) ?? []).map(\.number))
            guard let request = requestSafariWindow, await request(profile) else {
                if startedNow { await quitApp(app.pid, bundle: bundle) }
                return fail(id, .window, "Safari's extension wasn't asked for a window (no link)")
            }
            _ = await wait(options.windowWait) {
                number = (await self.sys.windows(pid: app.pid) ?? []).first { !before.contains($0.number) && !$0.fullScreen }?.number
                return number != nil
            }
            made = !launchedByMargin
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
        let host = Host(id: id, target: target, pid: app.pid, window: window, launchedByMargin: launchedByMargin, madeByMargin: made)
        hosts[id] = host
        saveMarker()
        if !sys.watchOpens(pid: app.pid, { [weak self] code in self?.heard(code, pid: app.pid) }) {
            Diagnostics.note("host: \(id): LaunchServices' notifications aren't heard: an open from outside isn't noticed")
        }
        emit(.opened(id, ms: ms(since: started)))
        Diagnostics.note("host: \(id) opened (pid \(app.pid), window \(window)): \(times.joined(separator: ", "))")
        return await bringIn(host, isNew: true)
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
        // Its View menu acts on Safari's main window: read and pressed only while that's the hosted one.
        let sidebarOurs = isSafari(host) && (host.launchedByMargin || host.madeByMargin)
        if sidebarOurs, await sys.mainWindow(pid: host.pid) != host.window {
            sidebar = .unknown
            Diagnostics.note("host: \(host.id): its window isn't Safari's main window: its sidebar is left as it is")
        } else if sidebarOurs {
            t0 = sys.now()
            sidebar = await sys.safariSidebar(pid: host.pid)
            if sidebar == .open {
                let pressed = await sys.pressSafariSidebar(pid: host.pid)
                Diagnostics.note("host: \(host.id): Safari's sidebar \(pressed ? "hidden by its View menu" : "open, and its menu item didn't press")")
                if pressed { sidebar = .closed }
            }
            step("sidebar", t0)
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

    private func enterFullScreen(_ host: Host) async -> String? {
        func ownSpace() -> UInt64? {
            guard let list = sys.spaces(window: host.window) else { return nil }
            return list.first { $0 != marginSpace && sys.spaceType($0) == ManagedSpace.fullScreenType }
        }
        if await sys.isFullScreen(pid: host.pid, window: host.window) != true {
            guard await sys.setFullScreen(pid: host.pid, window: host.window, true) else { return "AXFullScreen couldn't be set" }
        }
        let asked = sys.now()
        var askedAgain = false
        var space: UInt64?
        let came = await wait(options.fullScreenWait) {
            space = ownSpace()
            if let s = space {
                self.undoJump(to: s)
                return await self.sys.isFullScreen(pid: host.pid, window: host.window) == true
            }
            if !askedAgain, self.sys.now() - asked >= self.options.fullScreenAskAgain {
                askedAgain = true
                _ = await self.sys.setFullScreen(pid: host.pid, window: host.window, true)
            }
            return false
        }
        guard came, let space else { return "no full-screen Space of its own within \(Int(options.fullScreenWait)) s" }
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
            guard let plan = HostLayout.plan(margin: margin, hosted: hosted, reserved: sys.reserved(space: marginSpace) ?? .zero, page: pageRect) else {
                emit(.failed(host.id, .place, "the page area can't be reached beside Margin's tile"))
                return false
            }
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
        _ = await sys.setFullScreen(pid: host.pid, window: host.window, false)
        let out = await wait(options.exitWait) {
            await self.sys.isFullScreen(pid: host.pid, window: host.window) == false && self.sys.tiles(of: self.marginSpace)?.contains(tile) == false
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
        if await sys.isFullScreen(pid: host.pid, window: host.window) == true {
            _ = await sys.setFullScreen(pid: host.pid, window: host.window, false)
            _ = await wait(options.exitWait) {
                await self.sys.isFullScreen(pid: host.pid, window: host.window) == false
                    && (host.tile.map { self.sys.tiles(of: self.marginSpace)?.contains($0) == false } ?? true)
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
        if host.madeByMargin || (isSafari(host) && sharesApp) {
            if let closer = closeSafariWindow, await closer(host.window) {
                _ = await wait(options.quitWait) { self.sys.bounds(window: host.window) == nil }
            } else if host.privateSpace != nil, let desktop = sys.desktop(onDisplayOf: marginSpace) {
                _ = sys.move(window: host.window, to: desktop) // not closed: left to the person, on the Desktop
                Diagnostics.note("host: \(id): Safari's window wasn't closed by its extension: left on the Desktop")
            }
        } else if host.launchedByMargin, !sharesApp {
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
        } else {
            if let parked, parked.privateSpace != nil, let desktop = sys.desktop(onDisplayOf: marginSpace) { _ = sys.move(window: parked.window, to: desktop) }
            Diagnostics.warn("host: \(bundle) (pid \(pid)) didn't quit within \(Int(options.quitWait)) s: left running, its window on the Desktop")
            emit(.failed(parked?.id ?? HostID(raw: "app:" + bundle), .quit, "didn't quit"))
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
            HostMarker.Window(number: $0.window, pid: $0.pid, ownSafariWindow: $0.madeByMargin, privateSpace: $0.privateSpace, fullScreenSpace: $0.fullScreenSpace)
        }
        m.leftSpaces = leftSpaces.sorted()
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
        var outOfFullScreen = 0
        for w in m.windows {
            let ours = alivePids.contains(w.pid) || (w.ownSafariWindow && sys.app(pid: w.pid)?.bundleId == options.safariBundle)
            if ours, await sys.isFullScreen(pid: w.pid, window: w.number) == true {
                _ = await sys.setFullScreen(pid: w.pid, window: w.number, false)
                if await wait(options.exitWait, { await self.sys.isFullScreen(pid: w.pid, window: w.number) == false }) { outOfFullScreen += 1 }
            }
            if w.ownSafariWindow, w.privateSpace != nil, let space = m.marginSpace ?? w.fullScreenSpace, let desktop = sys.desktop(onDisplayOf: space) {
                _ = sys.move(window: w.number, to: desktop) // Safari's own window, given back to the person
            }
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
        Diagnostics.note("host: a marker from a Margin that didn't quit cleanly: \(m.apps.count) app\(m.apps.count == 1 ? "" : "s") (\(alive.count) still running, \(quit) quit), "
                         + "\(m.windows.count) window\(m.windows.count == 1 ? "" : "s") (\(outOfFullScreen) out of full screen), \(destroyed) emptied Space\(destroyed == 1 ? "" : "s") destroyed, in \(ms(since: started)) ms")
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
