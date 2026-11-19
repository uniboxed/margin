// The hosted parts joined (HostedSession.swift, ShellHostedGlue.swift), part of tests.swift's run: the library (its
// rules from dist/app/library.js, its files in a temporary folder) and the real host engine on the stand-in window
// manager (host-tests.swift FakeHostWorld), with a stand-in Margin window and stand-in Safari copies. What follows:
// a library request becomes the engine's open or show and the copy's hostShow; two web items of one profile are a
// tab switch only; a palette pick is an item added and opened; Safari picked is a web item, Chrome nothing; closing;
// what the UI draws (open items as the window's tabs, the one shown in front); the page area from Margin's own layout,
// the loading animation, Margin's window back into full screen with what it showed; the
// shell with hosting on: no slot, no opening of the browser, no overlay path.
import AppKit
import Foundation

final class FakeHostedWindow: HostedWindow {
    var pageAreaWhyNot: String { "fake" }
    var fullScreenState: String { "fake" }
    var layoutMode: String? { isFullScreen ? "fullscreen" : "windowed" }
    let id: Int
    let number: Int
    var isFullScreen = true // (always, while hosting is on)
    var hosting = false
    var pushed: [String] = []
    var hostings: [Bool] = []
    var fullScreenAsks = 0
    var goesFullScreen = true
    // The theme's layout at the window's whole width: Arcadia's in full screen, its sidebar 260 pt, the page card 8 pt from the other edges.
    var layout = PageLayout(left: 260, top: 8, right: 8, bottom: 8, radius: 6, radii: [6, 6, 6, 6], width: 1512, height: 949, mode: "fullscreen")
    init(id: Int, number: Int) { self.id = id; self.number = number }
    func toFullScreen() { fullScreenAsks += 1; if goesFullScreen { isFullScreen = true } }
    func setHosting(_ on: Bool) {
        guard on != hosting else { return }
        hosting = on
        hostings.append(on)
        if !on { hosted = nil; loading = nil; showing = nil }
    }
    var hosted: Int?
    var hosteds: [Int?] = [] // each setHosted, in order
    func setHosted(_ number: Int?) { guard number != hosted else { return }; hosted = number; hosteds.append(number) }
    var showing: String?
    var showings: [String?] = [] // each setShowing, in order
    var slowShowings: [String] = [] // those said to take a while (the last item at launch: the loader at once)
    var showingApps: [String?] = [] // the app each setShowing named for the loader's icon, in order
    var elsewhere: String? // its card's name (HostedSession `elsewhere`)
    var elsewhereApp: String?
    var elsewherePicture: String?
    func setElsewhere(_ label: String?, app: String?, picture: String?) { elsewhere = label; elsewhereApp = app; elsewherePicture = picture }
    func setShowing(_ label: String?, app: String?, slow: Bool) { guard label != showing else { return }; showing = label; showings.append(label); showingApps.append(app); if slow, let label { slowShowings.append(label) } }
    var moves = 0 // hostedMoved: the hosted window's bounds read again
    func hostedMoved() { moves += 1 }
    var followingPage = false // followsPage: the hosted window follows a drag live
    func followsPage(_ on: Bool) { followingPage = on }
    var minimums: [CGFloat?] = [] // each setPageMinimum (the one shown's own minimum width), in order
    func setPageMinimum(_ width: CGFloat?) { minimums.append(width) }
    var yields: [Int?] = [] // each yield(to:), in order
    func yield(to number: Int?) { yields.append(number) }
    var frontReads: [HostEngine.FrontRead] = [] // each frontRead, in order
    func frontRead(_ read: HostEngine.FrontRead) { frontReads.append(read) }
    var loading: String?
    var loadings: [String?] = [] // each setLoading, in order
    var loadingApps: [String?] = [] // the app each setLoading named for the loader's icon, in order
    func setLoading(_ label: String?, app: String?) { guard label != loading else { return }; loading = label; loadings.append(label); loadingApps.append(app) }
    var remeasures = 0
    func remeasure() { remeasures += 1 }
    var loadingTabs: [Int] = []
    var loadingTabsSaid: [[Int]] = [] // each setLoadingTabs, in order
    func setLoadingTabs(_ numbers: [Int]) { guard numbers != loadingTabs else { return }; loadingTabs = numbers; loadingTabsSaid.append(numbers) }
    var covering: Int?
    var covers: [Int?] = []
    func cover(_ number: Int?) { guard number != covering else { return }; covering = number; covers.append(number) }
    // (As the real one: the page area from its own layout, while hosting in full screen.)
    var hostedPlacement: HostPlacement? {
        guard hosting, isFullScreen, let page = MarginWindowGeometry.pageRect(layout: layout, content: FakeHostWorld.display) else { return nil }
        return HostPlacement(page: page, area: FakeHostWorld.display)
    }
    // (Its launcher's layout, not hosting: the same rect while the sidebar's docked in both.)
    var idleLayout: PageLayout?
    var idlePlacement: HostPlacement? {
        guard isFullScreen, let page = MarginWindowGeometry.pageRect(layout: idleLayout ?? layout, content: FakeHostWorld.display) else { return nil }
        return HostPlacement(page: page, area: FakeHostWorld.display)
    }
    func push(_ json: String) { pushed.append(json) }
}

final class FakeHostedLinks: HostedLinks {
    var profiles: [String] = []
    var asked: [(profile: String, type: String, payload: JSONObject)] = []
    var nextWindow = 90, nextTab = 500
    var onNewWindow: ((Int, JSONObject) -> Void)? // the copy's id for the window it makes, and what it was asked
    var onSetWindowState: ((Int, Bool) -> Void)? // the copy's id, full screen or not
    var onCloseWindow: ((Int) -> Void)?
    var onHostShow: (() -> Void)? // (as the copy is asked for an item's tab)
    var refuse: Set<String> = []
    // A copy not in charge (Safari running an older copy of Margin beside a newer one): this many newWindow asks answered
    // `stale`, the newer copy's link replacing it as it answers (a new epoch).
    var staleNewWindows = 0
    var staleReplaces = true // (false: the stale copy's link isn't replaced as it answers; the test replaces it later)
    func safariProfiles() -> [String] { profiles }
    var menuOpens: [String] = [] // profiles woken through Safari's menu
    var wakes: Set<String> = [] // profiles that link when woken
    var windowsOf: [String: [Int]] = [:]
    var onMenuOpen: ((String) -> Void)? // (the window Safari's menu opens, in the stand-in world)
    var notInMenu: Set<String> = [] // profiles Safari's menu has no item for (their names unknown to Margin)
    func openProfileWindow(_ profile: String, pressed: @escaping @MainActor (Bool) -> Void) -> Bool {
        menuOpens.append(profile)
        let has = !notInMenu.contains(profile)
        DispatchQueue.main.async { MainActor.assumeIsolated { pressed(has) } }
        guard has else { return true }
        onMenuOpen?(profile)
        if wakes.contains(profile) { profiles.append(profile); windowsOf[profile, default: []].append(77) }
        return true
    }
    func windowIds(of profile: String) -> [Int] { windowsOf[profile] ?? [] }
    var restored: [String: [Int]] = [:]
    var epochs: [String: String] = [:]
    func restoredWindowIds(of profile: String) -> [Int]? { profiles.contains(profile) ? (restored[profile] ?? []) : nil }
    func linkEpoch(of profile: String) -> String? { profiles.contains(profile) ? (epochs[profile] ?? "e1") : nil }
    var picture: String? // the copy's answer to hostPicture
    var pictureDelay = 0.0 // ...this long after it's asked
    func request(profile: String, _ type: String, _ payload: JSONObject) async -> (result: JSONObject?, error: String?) {
        asked.append((profile, type, payload))
        guard profiles.contains(profile) else { return (nil, "not linked") }
        if refuse.contains(type) { return (nil, "refused") }
        switch type {
        case "newWindow":
            if staleNewWindows > 0 {
                staleNewWindows -= 1
                if staleReplaces { epochs[profile] = "e\(asked.count + 1)" }
                return (nil, "a newer copy of Margin is running")
            }
            onNewWindow?(nextWindow, payload)
            nextWindow += 1
            return (["windowId": nextWindow - 1, "state": "normal"], nil)
        case "setWindowState":
            guard let id = int(payload["windowId"]) else { return (nil, "no window") }
            onSetWindowState?(id, payload["state"] as? String == "fullscreen")
            return (["windowId": id, "state": payload["state"] ?? "", "landedAt": 1], nil)
        case "closeWindow":
            if let id = int(payload["windowId"]) { onCloseWindow?(id) }
            return ([:], nil)
        case "hostPicture":
            if pictureDelay > 0 { try? await Task.sleep(for: .seconds(pictureDelay)) }
            return (["data": picture ?? NSNull()], nil)
        case "hostShow":
            onHostShow?()
            nextTab += 1
            return (["tabId": nextTab - 1, "created": true], nil)
        default:
            return ([:], nil)
        }
    }
    func types(since: Int = 0) -> [String] { asked.dropFirst(since).map(\.type) }
}

// An engine that only says which app Margin started (the restored-window sweep's one question).
final class StubLaunchEngine: HostedEngine {
    var safariPid: pid_t?
    // (A wake's evidence, as the engine gives it: the windows each press of Safari's menu opens, and whether Safari runs.)
    var windowsPerPress = 0
    var presses = 0
    var runs: Bool?
    func hideWoken(bundleId: String) { presses += 1 }
    func wokenWindows(bundleId: String) -> Int { presses * windowsPerPress }
    func appRuns(bundleId: String) -> Bool? { runs }
    func open(app target: HostTarget, in placement: HostPlacement, marginWindow: Int, marginSpace: UInt64) async -> HostResult { .failed(.margin, "stub") }
    func show(_ id: HostID) async -> HostResult { .failed(.margin, "stub") }
    func close(_ id: HostID) async {}
    func pageRectChanged(_ placement: HostPlacement) async -> Bool { false }
    func parkShown(why: String) async {}
    var shown: HostID? { nil }
    var hasHosts: Bool { false }
    func isHosted(_ id: HostID) -> Bool { false }
    func mode(of id: HostID) -> HostMode? { nil }
    var shownWindow: Int? { nil }
    func activateShown(at point: CGPoint?) async {}
    func fullScreenSpace(ofWindow number: Int) -> UInt64? { nil }
    func target(ofWindow number: Int) -> HostTarget? { nil }
    func launchedPid(bundleId: String) -> pid_t? { bundleId == safariIdentifier ? safariPid : nil }
}

func restoredSweepTests(_ library: Library) {
    let stub = StubLaunchEngine()
    let links = FakeHostedLinks()
    links.profiles = ["s-default", "s-work"]
    links.restored = ["s-default": [5, 6], "s-work": [9]]
    let s = HostedSession(library: library, engine: stub, links: links)
    s.sleep = { _ in await Task.yield() }
    func closes() -> [String] { links.asked.filter { $0.type == "closeWindow" }.map { "\($0.profile):\(int($0.payload["windowId"]) ?? -1)" }.sorted() }
    s.sweepRestoredSafariWindows()
    hostRun { await Task.yield() }
    check("hosted sweep: a Safari the person opened (not started by Margin): none of its windows closed", closes().isEmpty)
    stub.safariPid = 4242
    s.sweepRestoredSafariWindows()
    hostRun { for _ in 0..<5 { await Task.yield() } }
    check("hosted sweep: Safari started by Margin: every restored window of each linked profile closed by its copy", closes() == ["s-default:5", "s-default:6", "s-work:9"], "\(closes())")
    links.asked = []
    s.sweepRestoredSafariWindows()
    hostRun { for _ in 0..<5 { await Task.yield() } }
    check("hosted sweep: once per link (the next poll closes nothing again)", closes().isEmpty, "\(closes())")
    links.epochs["s-work"] = "e2"
    links.restored["s-work"] = [11]
    s.sweepRestoredSafariWindows()
    hostRun { for _ in 0..<5 { await Task.yield() } }
    check("hosted sweep: a profile linked again (Safari reopened it): swept again", closes() == ["s-work:11"], "\(closes())")
    links.asked = []
    s.options.closesRestoredSafariWindows = false
    links.epochs["s-default"] = "e3"
    s.sweepRestoredSafariWindows()
    hostRun { for _ in 0..<5 { await Task.yield() } }
    check("hosted sweep: off: nothing closed", closes().isEmpty)
}

// The default browser made ready out of sight at Margin's launch (HostedSession.prepareBrowser, Tirth 2026-11-16): the
// real engine on the stand-in window manager playing the real Mac's full-screen pacing (`staged`).
func preparedBrowserTests(_ library: Library) {
    struct Rig { let w: FakeHostWorld; let engine: HostEngine; let links: FakeHostedLinks; let session: HostedSession; let window: FakeHostedWindow; let copy: () -> [Int: Int] }
    func rig() -> Rig {
        let w = FakeHostWorld()
        w.staged = true
        let engine = HostEngine(system: w, marker: nil, pid: 1)
        engine.options.privateRetire = 0
        let links = FakeHostedLinks()
        let session = HostedSession(library: library, engine: engine, links: links)
        session.sleep = { _ in await Task.yield() }
        let window = FakeHostedWindow(id: 1, number: FakeHostWorld.marginWindow)
        session.window = { id in id == nil || id == 1 ? window : nil }
        engine.requestSafariWindow = { await session.requestSafariWindow($0) }
        engine.closeSafariWindow = { await session.closeSafariWindow($0, $1) }
        engine.safariFullScreen = { await session.safariFullScreen($0, $1, $2) }
        engine.safariLinked = { await session.safariLinked($0) }
        engine.onEvent = { session.hostEvent($0) }
        engine.loading = { session.loading($0) }
        engine.hostedWindow = { session.hosted($0) }
        engine.cover = { session.cover($0) }
        final class Box { var windows: [Int: Int] = [:] }
        let box = Box()
        // As the real Mac (2026-11-16): a Safari started with no Dock icon is started hidden; asked for an unfocused
        // window while hidden it answers the window's id but orders nothing in (no window-server window until it's
        // unhidden). Asked focused, it comes to the front (unhidden) and macOS switches to the Space its new window
        // opens in, the Desktop.
        w.launchesHidden = ["com.apple.Safari"]
        links.onNewWindow = { id, payload in
            guard let pid = w.running(bundleId: "com.apple.Safari").first?.pid else { return }
            let n = w.nextWindow
            w.nextWindow += 1
            w.wins[n] = FakeHostWorld.Win(pid: pid, spaces: [FakeHostWorld.desktop])
            w.apps[pid]?.windows.append(n)
            box.windows[id] = n
            w.serverFrom[n] = w.clock + 0.25 // (made in ~250 ms, as the real Mac's log shows for a focused one)
            let focused = payload["background"] as? Bool != true && payload["focused"] as? Bool != false
            if focused {
                if w.hidden.remove(pid) != nil { w.unhiddenAt[pid] = w.clock }
                w.current = FakeHostWorld.desktop
                w.currentSince = w.clock
            } else if w.hidden.contains(pid) {
                w.madeOnUnhide.insert(n)
            }
        }
        links.onSetWindowState = { id, on in
            guard let n = box.windows[id], let pid = w.wins[n]?.pid else { return }
            w.applyFullScreen(pid: pid, window: n, on)
        }
        links.onCloseWindow = { id in if let n = box.windows.removeValue(forKey: id) { w.closeWindow(n) } }
        links.profiles = ["s-default"] // (its copy links as Safari starts)
        return Rig(w: w, engine: engine, links: links, session: session, window: window, copy: { box.windows })
    }
    let safari = HostTarget.safariWindow("s-default").id
    func prepare(_ r: Rig, _ setting: String? = nil) -> [String] {
        var lines: [String] = []
        let echo = Diagnostics.echo
        Diagnostics.echo = { lines.append($0) }
        hostRun { await r.session.prepareBrowser(setting: setting); await r.session.idle() }
        Diagnostics.echo = echo
        return lines
    }
    do {
        let r = rig()
        let lines = prepare(r)
        let n = r.copy()[90] ?? 0
        let host = r.engine.hosts[safari]
        check("prepared: Safari started with no Dock icon at launch, counted as Margin's (its restored windows swept, quit at quit)",
              r.w.calls.contains("launch com.apple.Safari") && r.engine.launchedPid(bundleId: safariIdentifier) != nil, "\(r.w.calls)")
        check("prepared: its window asked of the copy as a blank page, focused (a hidden Safari orders no unfocused window in)",
              r.links.asked.first { $0.type == "newWindow" }.map { $0.payload["url"] as? String == "about:blank" && $0.payload["background"] == nil && $0.payload["focused"] == nil } == true,
              "\(r.links.asked.first { $0.type == "newWindow" }?.payload ?? [:])")
        let unhide = r.w.calls.firstIndex { $0.hasPrefix("unhide") } ?? -1, ask = r.w.calls.firstIndex { $0.hasPrefix("copy") || $0.hasPrefix("reserve") } ?? -1
        check("prepared: the hidden Safari unhidden (never activated) before its window was asked, and the window found",
              unhide >= 0 && (ask < 0 || unhide < ask) && r.w.hidden.isEmpty && n != 0 && r.engine.hosts[safari]?.window == n, "\(r.w.calls)")
        check("prepared: macOS's switch to the Desktop as Safari came to the front undone at once", r.w.current == FakeHostWorld.marginSpace && r.w.offMargin == 0
              && r.w.calls.contains("current \(FakeHostWorld.marginSpace)") && r.w.dropped == 0, "\(r.w.calls)")
        check("prepared: full screen at the page area by the early path, then parked out of sight (a private Space), nothing shown",
              host?.phase == .parked && host?.member == true && r.w.wins[n]?.fullScreen == true && r.w.wins[n]?.priv != nil && r.engine.shown == nil
              && r.w.bounds(window: n) == CGRect(x: 260, y: 41, width: 1244, height: 933), "\(String(describing: host?.phase)) \(String(describing: r.w.wins[n]))")
        check("prepared: never seen: under one freeze (macOS's switch to its new Space undone within one read), Mission Control Margin's only, Margin's window above it while it was in its Space",
              r.w.freezes == 1 && r.w.reveals == 1 && r.w.offMargin <= 0.0051 && r.w.listsMarginOnly && r.w.movedBeforeDelivery == 0 && r.w.lateDrops == 0 && r.window.covers == [n, nil] && r.window.hostings.isEmpty,
              "\(r.window.covers) \(r.w.freezes) \(r.w.offMargin)")
        check("prepared: its app never activated, no loading bar", !r.w.calls.contains { $0.hasPrefix("activate") } && r.window.loadings.isEmpty && r.window.loadingTabsSaid.isEmpty)
        check("prepared: said with its time", lines.contains { $0.contains("browser prepared in") && $0.contains("parked out of sight") }, "\(lines.filter { $0.contains("prepared") })")

        // ---- the first web item: a switch-in, then its tab ----
        let mark = r.links.asked.count, freezes = r.w.freezes
        if library.space(ofWindow: 1) == nil { _ = library.perform("createSpace", ["windowId": 1, "name": "Prepared", "emoji": "⚡"]) }
        library.delegate = r.session
        defer { library.delegate = nil }
        let t0 = r.w.clock
        hostRun { _ = library.perform("newTab", ["windowId": 1, "url": "https://first.example/"]); await r.session.idle() }
        check("prepared: the first web item a switch-in (no new window, no full screen), then its tab",
              r.engine.shown == safari && r.links.types(since: mark) == ["hostShow"] && r.w.inMargin == [n] && r.w.freezes == freezes && r.w.clock - t0 < 0.1,
              "\(r.links.types(since: mark)) \(r.w.clock - t0) \(r.w.inMargin)")

        // ---- quit: the prepared window closed by its copy, the Safari Margin started quit ----
        hostRun { await r.engine.quitAll() }
        check("prepared: quit: its window closed by its copy, Safari (Margin's) quit, nothing left", r.links.types().contains("closeWindow") && r.w.running(bundleId: "com.apple.Safari").isEmpty
              && r.w.listsMarginOnly && r.w.privates.isEmpty, "\(r.links.types()) \(r.w.apps.keys)")
        for item in library.items().map(\.id) { _ = library.perform("closeTab", ["windowId": 1, "tabId": item]) }
    }
    do {
        // The list the new window is told apart from read after Safari's unhide settled: its restored window, ordered in
        // only as it's unhidden, is in it and never taken for the new one. Read at once after the unhide, the restored one
        // looks new (and comes first).
        for settle in [true, false] {
            let r = rig()
            r.w.restoredOnUnhide = ["com.apple.Safari"]
            r.w.axCurrentOnly = true // (Accessibility lists only the current Space's windows: not Safari's on the Desktop)
            if !settle { r.engine.options.unhideSettle = 0; r.engine.options.windowWait = 1 }
            let lines = prepare(r)
            let n = r.copy()[90] ?? 0
            if settle {
                check("prepared: Safari's restored window ordered in as it's unhidden is read before the ask: the new window found, prepared",
                      r.engine.hosts[safari]?.phase == .parked && r.engine.hosts[safari]?.window == n && lines.contains { $0.contains("browser prepared in") }, "\(lines.filter { $0.contains("prepared") || $0.contains("Safari") })")
            } else {
                check("prepared: (the list read at once after the unhide: its restored window, ordered in first, taken for the new one)",
                      r.engine.hosts[safari].map { $0.window != n } ?? true, "\(String(describing: r.engine.hosts[safari]?.window)) \(n) \(lines.filter { $0.contains("prepared") })")
            }
            hostRun { await r.engine.quitAll() }
        }
    }
    do {
        // The prepared window quit unused: closed by its copy too.
        let r = rig()
        _ = prepare(r)
        hostRun { await r.engine.quitAll() }
        check("prepared: quit before it's used: its window closed by its copy, Safari quit", r.links.types().contains("closeWindow") && r.w.running(bundleId: "com.apple.Safari").isEmpty && r.w.listsMarginOnly)
    }
    do {
        // The person's own Safari, running with their windows: used as it is (never restarted or quit, its Dock icon left).
        let r = rig()
        let pid = r.w.start("com.apple.Safari", policy: .regular, windows: 2)
        let theirs = r.w.apps[pid]?.windows ?? []
        _ = prepare(r)
        let n = r.copy()[90] ?? 0
        check("prepared: the person's Safari used as it is: never launched, its windows untouched, Margin's own window prepared",
              !r.w.calls.contains { $0.hasPrefix("launch") } && r.engine.launchedPid(bundleId: safariIdentifier) == nil && r.engine.hosts[safari]?.madeByMargin == true
              && r.engine.hosts[safari]?.phase == .parked && !theirs.contains(n) && theirs.allSatisfy { r.w.wins[$0]?.fullScreen == false && r.w.spaces(window: $0) == [FakeHostWorld.desktop] }, "\(r.w.calls)")
        hostRun { await r.engine.quitAll() }
        check("prepared: quit: Margin's window closed, the person's Safari left running", r.w.apps[pid] != nil && r.w.wins[n] == nil && theirs.allSatisfy { r.w.wins[$0] != nil })
    }
    do {
        // An unsupported setting: Safari, said.
        let r = rig()
        let lines = prepare(r, "chrome")
        check("prepared: an unsupported default browser (chrome): Safari prepared, said once", r.engine.hosts[safari]?.phase == .parked
              && lines.filter { $0.contains("isn't supported yet: Safari") }.count == 1, "\(lines.filter { $0.contains("browser") })")
        check("prepared: the setting's table: safari only, by its bundle", DefaultBrowser.resolve(nil) == ("safari", safariIdentifier) && DefaultBrowser.resolve("Safari").bundleId == safariIdentifier)
        hostRun { await r.engine.quitAll() }
    }
    do {
        // No early full screen: not prepared (it couldn't be out of sight), nothing started.
        let r = rig()
        r.engine.options.earlyFullScreen = false
        let lines = prepare(r)
        check("prepared: no early full screen: not prepared, nothing started, said", r.w.calls.isEmpty && r.engine.hosts.isEmpty
              && lines.contains { $0.contains("browser not prepared") && $0.contains("out of sight") }, "\(r.w.calls) \(lines.filter { $0.contains("prepared") })")
    }
    do {
        // Something shown already (the person picked an app first): not prepared, the app left as it is.
        let r = rig()
        r.engine.options.earlyFullScreen = true
        hostRun { _ = await r.engine.open(app: .app("com.apple.TextEdit"), in: r.window.idlePlacement!, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
        let lines = prepare(r)
        check("prepared: something shown in Margin's window: not prepared, it stays shown", r.engine.shown == HostTarget.app("com.apple.TextEdit").id && r.engine.hosts[safari] == nil
              && lines.contains { $0.contains("browser not prepared") }, "\(lines.filter { $0.contains("prepared") })")
        hostRun { await r.engine.quitAll() }
    }
    // ---- a profile with no window, woken through Safari's menu for the preparation (2026-11-17 14:05) ----
    func wakeRig() -> (Rig, () -> Int?) {
        let r = rig()
        r.links.profiles = [] // (its copy isn't running: the profile has no window)
        r.links.wakes = ["s-default"]
        r.session.options.firstCopiesPace = 0 // (no copy of Safari's own to wait for here)
        final class Woken { var n: Int? }
        let woken = Woken()
        // (The window the menu opens: in the current Space, Margin's, at the normal level, as an accessory Safari's do.)
        r.links.onMenuOpen = { _ in
            guard let pid = r.w.running(bundleId: "com.apple.Safari").first?.pid else { return }
            let n = r.w.nextWindow
            r.w.nextWindow += 1
            r.w.wins[n] = FakeHostWorld.Win(pid: pid, spaces: [r.w.current])
            r.w.apps[pid]?.windows.append(n)
            woken.n = n
        }
        let closes = r.links.onCloseWindow
        r.links.onCloseWindow = { id in if id == 77, let n = woken.n { r.w.closeWindow(n) } else { closes?(id) } }
        return (r, { woken.n })
    }
    do {
        // Something shown before the wake: the profile isn't woken at all (nothing opened for a preparation that won't be).
        let (r, _) = wakeRig()
        hostRun { _ = await r.engine.open(app: .app("com.apple.calculator"), in: r.window.idlePlacement!, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
        let lines = prepare(r)
        check("wake: something shown before a profile with no window would be woken: never woken through Safari's menu, nothing opened, not prepared, said",
              r.links.menuOpens.isEmpty && r.engine.hosts[safari] == nil && lines.contains { $0.contains("browser not prepared") && $0.contains("not woken") },
              "\(r.links.menuOpens) \(lines.filter { $0.contains("prepared") || $0.contains("woken") })")
        hostRun { await r.engine.quitAll() }
    }
    do {
        // Woken with nothing shown, then an app shown before the preparation's turn (its preparation given up): the window
        // the menu opened parked out of sight as it came, and closed by its copy.
        let (r, wokenWindow) = wakeRig()
        let calc = HostTarget.app("com.apple.calculator")
        let place = r.window.idlePlacement!
        let pick = r.links.onMenuOpen
        r.links.onMenuOpen = { p in
            pick?(p)
            Task { _ = await r.engine.open(app: calc, in: place, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
        }
        let lines = prepare(r)
        hostRun { for _ in 0..<20 { await Task.yield() } }
        let n = wokenWindow() ?? -1
        check("wake: the profile woken (nothing shown then), an app shown before the preparation's turn: not prepared, the woken window closed by its copy",
              r.links.menuOpens == ["s-default"] && r.engine.shown == calc.id && r.engine.hosts[safari] == nil
              && r.links.asked.contains { $0.type == "closeWindow" && int($0.payload["windowId"]) == 77 } && r.w.wins[n] == nil
              && lines.contains { $0.contains("the window opened to wake the profile closed (its preparation given up): ok") },
              "\(r.links.asked.map(\.type)) \(String(describing: r.w.wins[n])) \(lines.filter { $0.contains("wake") || $0.contains("prepared") })")
        check("wake: the woken window parked out of sight as it came (it opened in Margin's Space, over what's shown), said once",
              lines.filter { $0.contains("it opened only to wake a profile parked out of sight") }.count == 1, "\(lines.filter { $0.contains("wake") })")
        hostRun { await r.engine.quitAll() }
        check("wake: quit: nothing of it left", r.w.privates.isEmpty && r.w.listsMarginOnly, "\(r.w.privates)")
    }
    do {
        // Woken, and Margin's own window made for it: the woken window closed as before; never parked once Margin asked
        // for its own window (that one is Margin's, prepared as before).
        let (r, wokenWindow) = wakeRig()
        let lines = prepare(r)
        let n = wokenWindow() ?? -1, mine = r.copy()[90] ?? 0
        check("wake: woken and prepared: the woken window closed by its copy, Margin's own window prepared (never taken for a woken one)",
              r.engine.hosts[safari]?.phase == .parked && r.engine.hosts[safari]?.window == mine && r.w.wins[n] == nil
              && lines.contains { $0.contains("the window opened to wake the profile closed: ok") } && lines.contains { $0.contains("browser prepared in") },
              "\(String(describing: r.engine.hosts[safari]?.window)) \(mine) \(lines.filter { $0.contains("wake") || $0.contains("prepared") })")
        hostRun { await r.engine.quitAll() }
    }
}

// ---- a profile's copy waited for, waking it through Safari's menu: evidence decides, time only paces (2026-11-17 20:44:
// Safari's first open took 36 s and failed: a press, a fixed 10 s, a second press, 20 s more, given up) ----
func safariWakeTests(_ library: Library) {
    // A session on a clock of its own: each look advances it by `every`; `at` runs things at a time.
    func rig(linked: [String] = ["s-default"], windowsPerPress: Int = 1, runs: Bool? = true) -> (HostedSession, FakeHostedLinks, StubLaunchEngine, () -> Double, (Double, @escaping () -> Void) -> Void) {
        let stub = StubLaunchEngine()
        stub.windowsPerPress = windowsPerPress
        stub.runs = runs
        let links = FakeHostedLinks()
        links.profiles = linked
        let s = HostedSession(library: library, engine: stub, links: links)
        final class Clock { var t = 100.0; var due: [(Double, () -> Void)] = [] }
        let clock = Clock()
        s.now = { clock.t }
        s.sleep = { d in
            clock.t += d
            for (i, job) in clock.due.enumerated().reversed() where job.0 <= clock.t { clock.due.remove(at: i); job.1() }
            await Task.yield()
        }
        return (s, links, stub, { clock.t - 100 }, { t, f in clock.due.append((100 + t, f)) })
    }
    do {
        // Its window opened at the press; its copy links 35 s later (Safari refusing its native messages while another
        // build's handler is in use): waited for, never pressed again, taken the moment it links.
        let (s, links, _, elapsed, at) = rig()
        at(35) { links.profiles.append("s-p") }
        var ok = false
        hostRun { ok = await s.safariLinked("s-p") }
        check("wake: a press that opened a window: never pressed again; its copy's link waited for (35 s) and taken as it came",
              ok && links.menuOpens == ["s-p"] && s.done.contains { $0.contains("linked in 35.0 s") }, "\(ok) \(links.menuOpens) \(elapsed()) \(s.done.suffix(2))")
        check("wake: the wait said while it lasts", s.done.filter { $0.contains("not linked yet after") }.count >= 6, "\(s.done.suffix(4))")
    }
    do {
        // No window comes of a press (a Safari still starting does nothing at one): pressed again, paced, at most
        // `wakePresses` times, then given up, said why.
        let (s, links, _, elapsed, _) = rig(windowsPerPress: 0)
        var ok = true
        hostRun { ok = await s.safariLinked("s-gone") }
        check("wake: presses that open nothing: pressed again, paced, \(s.options.wakePresses) times, then given up on that evidence",
              !ok && links.menuOpens.count == s.options.wakePresses && links.asked.isEmpty && s.done.contains { $0.contains("opened no window") }, "\(links.menuOpens) \(elapsed()) \(s.done.suffix(2))")
        // ...and a window that comes of the second press: no third.
        let (s2, links2, stub2, _, at2) = rig(windowsPerPress: 0)
        at2(2.5) { stub2.windowsPerPress = 1 }
        at2(12) { links2.profiles.append("s-late") }
        var ok2 = false
        hostRun { ok2 = await s2.safariLinked("s-late") }
        check("wake: a window from the second press: no third, linked", ok2 && links2.menuOpens.count == 2, "\(links2.menuOpens)")
    }
    do {
        // Safari's menu has no item by the name Margin has for the profile (its own names unreadable, 2026-11-18 23:02: four
        // presses and 15 s for nothing): said at once after the one press, never pressed again, not linked.
        let (s, links, _, elapsed, _) = rig(windowsPerPress: 0)
        links.notInMenu = ["s-nameless"]
        var ok = true
        hostRun { ok = await s.safariLinked("s-nameless") }
        check("wake: a profile Safari's menu has no item for: one press, given up at once (not four presses and 15 s), kept as one it can't open",
              !ok && links.menuOpens == ["s-nameless"] && elapsed() < 1 && s.unopenable.contains("s-nameless") && s.done.contains { $0.contains("has no item by the name") },
              "\(ok) \(links.menuOpens) \(elapsed()) \(s.done.suffix(2))")
        var again = true
        hostRun { again = await s.safariLinked("s-nameless") }
        check("wake: … asked again: not pressed again", !again && links.menuOpens == ["s-nameless"])
        s.profileNamesChanged()
        check("wake: … Safari's names read (the folder allowed): it may be opened again", !s.unopenable.contains("s-nameless"))
    }
    do {
        // What it was for no longer wanted (another item picked): no longer waited for, at once.
        let (s, links, _, elapsed, _) = rig()
        var ok = true
        hostRun { ok = await s.safariLinked("s-p", wakeIf: { elapsed() < 3 }) }
        check("wake: not wanted any more (another pick): no longer waited for at once, said", !ok && links.menuOpens == ["s-p"] && elapsed() >= 3 && elapsed() < 3.2
              && s.done.contains { $0.contains("no longer waited for") }, "\(elapsed()) \(s.done.suffix(2))")
    }
    do {
        // Safari quit while waited for: given up at once.
        let (s, _, stub, elapsed, at) = rig()
        at(2) { stub.runs = false }
        var ok = true
        hostRun { ok = await s.safariLinked("s-p") }
        check("wake: Safari quit while its copy was waited for: given up at once, said", !ok && elapsed() >= 2 && elapsed() < 2.2 && s.done.contains { $0.contains("Safari quit") }, "\(elapsed()) \(s.done.suffix(2))")
    }
    do {
        // A Safari just started, no copy linked yet: its own copies first; this profile's among them (a window it
        // restored): never pressed. Another's first: pressed then, at once.
        let (s, links, _, elapsed, at) = rig(linked: [])
        at(4) { links.profiles.append("s-p") }
        var ok = false
        hostRun { ok = await s.safariLinked("s-p") }
        check("wake: a Safari just started: its own copies first, this profile's among them: never pressed", ok && links.menuOpens.isEmpty && elapsed() < 4.2, "\(links.menuOpens) \(elapsed())")
        let (s2, links2, _, elapsed2, at2) = rig(linked: [])
        at2(4) { links2.profiles.append("s-default") }
        at2(9) { links2.profiles.append("s-p") }
        var ok2 = false
        hostRun { ok2 = await s2.safariLinked("s-p") }
        check("wake: a Safari just started, another profile's copy first: pressed as it linked (4 s), linked at 9 s", ok2 && links2.menuOpens == ["s-p"] && s2.done.contains { $0.contains("linked in 9.0 s") }
              && s2.done.contains { $0.contains("press 1") }, "\(links2.menuOpens) \(elapsed2()) \(s2.done)")
    }
    do {
        // A window asked of a copy not in charge (stale) whose link isn't replaced: asked again once it is, however long
        // (no fixed wait gives up on it), and not at all once it's no longer wanted.
        let (s, links, _, elapsed, at) = rig(linked: ["s-default"])
        links.staleNewWindows = 1
        links.staleReplaces = false
        links.epochs["s-default"] = "e0"
        var made: HostSafariWindow?
        at(25) { links.epochs["s-default"] = "e9" }
        hostRun { made = await s.requestSafariWindow("s-default") }
        check("wake: a stale copy's answer: asked again once its link was replaced (25 s), made", made != nil && links.asked.filter { $0.type == "newWindow" }.count == 2 && elapsed() >= 25,
              "\(links.asked.map(\.type)) \(elapsed())")
    }
}

func hostedTests() {
    let echo = Diagnostics.echo
    Diagnostics.echo = { _ in }
    defer { Diagnostics.echo = echo }
    hostedGeometryTests()
    let scriptPath = ProcessInfo.processInfo.environment["MARGIN_LIBRARY_JS"] ?? "../../dist/app/library.js"
    let script = URL(fileURLWithPath: scriptPath)
    let dataRoot = tempFolder("hosted")
    defer { try? FileManager.default.removeItem(at: dataRoot) }
    guard let library = Library.open(dataRoot: dataRoot, script: script, background: false) else { return check("hosted: the library opens (\(scriptPath): npm run build)", false) }
    restoredSweepTests(library)
    preparedBrowserTests(library)
    var n = 0
    library.randomIds = { (0..<4).map { _ in n += 1; return "h\(n)x" } }

    let w = FakeHostWorld()
    let engine = HostEngine(system: w, marker: nil, pid: 1)
    engine.options.privateRetire = 0
    let links = FakeHostedLinks()
    let session = HostedSession(library: library, engine: engine, links: links)
    session.sleep = { _ in await Task.yield() }
    let window = FakeHostedWindow(id: 1, number: FakeHostWorld.marginWindow)
    session.window = { id in id == nil || id == 1 ? window : nil }
    session.appName = { $0 == "com.apple.TextEdit" ? "TextEdit" : nil }
    engine.requestSafariWindow = { await session.requestSafariWindow($0) }
    engine.closeSafariWindow = { await session.closeSafariWindow($0, $1) }
    engine.safariFullScreen = { await session.safariFullScreen($0, $1, $2) }
    engine.safariLinked = { await session.safariLinked($0) }
    engine.onEvent = { session.hostEvent($0) }
    engine.loading = { session.loading($0) }
    engine.hostedWindow = { session.hosted($0) }
    library.delegate = session
    var changes = 0
    session.onChange = { changes += 1 }
    // A Safari Margin starts links its copy (the default profile's), and the copy's newWindow makes a window, on the
    // Desktop: Accessibility doesn't see it there while Margin's Space is current; its copy's setWindowState and
    // closeWindow act on it.
    var copyWindows: [Int: Int] = [:]
    links.onNewWindow = { id, _ in
        guard let pid = w.running(bundleId: "com.apple.Safari").first?.pid else { return }
        let n = w.nextWindow
        w.nextWindow += 1
        w.wins[n] = FakeHostWorld.Win(pid: pid, spaces: [FakeHostWorld.desktop])
        w.apps[pid]?.windows.append(n)
        copyWindows[id] = n
    }
    links.onSetWindowState = { id, on in
        guard let n = copyWindows[id], let pid = w.wins[n]?.pid else { return }
        w.applyFullScreen(pid: pid, window: n, on)
    }
    links.onCloseWindow = { id in if let n = copyWindows.removeValue(forKey: id) { w.closeWindow(n) } }
    let page = CGRect(x: 260, y: 41, width: 1244, height: 933)
    func run(_ body: @escaping () async -> Void) { hostRun { await body(); await session.idle() } }

    let made = library.perform("createSpace", ["windowId": 1, "name": "Home", "emoji": "🏠"])
    let home = (made.result as? JSONObject)?["spaceId"] as? String ?? ""

    // ---- a palette pick: an item added, its app opened in the page area ----
    run { session.openApp("com.apple.TextEdit", windowId: 1) }
    let textEdit = library.items(space: home).first { $0.value["url"] as? String == "app://com.apple.TextEdit" }
    let editItem = textEdit?.id ?? ""
    check("hosted: a palette pick: an item of the window's space, its app's name from the catalog",
          textEdit != nil && library.target(ofItem: editItem) == .app(bundleId: "com.apple.TextEdit", name: "TextEdit"), "\(library.items())")
    check("hosted: Margin's window already full screen (it always is): never asked, hosting above its own layout", window.fullScreenAsks == 0 && window.isFullScreen && window.hostings == [true], "\(window.hostings)")
    check("hosted: the engine opened the app (started with no Dock icon) and shows it", w.calls.contains("launch com.apple.TextEdit") && engine.shown == HostTarget.app("com.apple.TextEdit").id, "\(w.calls)")
    let editWindow = w.running(bundleId: "com.apple.TextEdit").first.flatMap { w.apps[$0.pid]?.windows.first } ?? 0
    check("hosted: the engine was given the page area from Margin's own layout, and its window is there, a member of Margin's Space", engine.pageRect == page && w.bounds(window: editWindow) == page
          && w.wins[editWindow]?.member == true && w.listsMarginOnly, "\(engine.pageRect) \(String(describing: w.bounds(window: editWindow)))")
    check("hosted: the loading animation named the app while it opened, then went", window.loadings == ["TextEdit", nil], "\(window.loadings)")
    check("hosted: … with the app's bundle id for its icon (the page looks it up)", window.loadingApps == ["com.apple.TextEdit", nil], "\(window.loadingApps)")
    check("hosted: Margin's window told the app's window (it's in front of it)", window.hosted == editWindow, "\(window.hosteds)")
    check("hosted: it's the window's item shown, open", session.shown[1] == editItem && session.open[editItem]?.host == HostTarget.app("com.apple.TextEdit").id && changes > 0)
    let editNumber = session.number(ofItem: editItem)
    check("hosted: the theme's loading bar for the app's item while it opened (the page's `loading`), none once it's shown", window.loadingTabsSaid == [[editNumber], []], "\(window.loadingTabsSaid)")

    // ---- the same app picked again: its item, no second launch ----
    run { session.openApp("com.apple.TextEdit", windowId: 1) }
    check("hosted: picked again: the item it has, nothing launched twice", library.items(space: home).filter { $0.value["url"] as? String == "app://com.apple.TextEdit" }.count == 1
          && w.calls.filter { $0 == "launch com.apple.TextEdit" }.count == 1)

    // ---- a typed address (newTab): a web item, Safari started with no Dock icon, its copy's window, the tab ----
    links.profiles = ["s-default"] // (its copy links as Safari starts)
    let mark = links.asked.count
    run { _ = library.perform("newTab", ["windowId": 1, "url": "https://a.example/"]) }
    let aItem = library.items(space: home).first { $0.value["url"] as? String == "https://a.example/" }?.id ?? ""
    let safari = HostTarget.safariWindow("s-default").id
    check("hosted: newTab: Safari started with no Dock icon, its window shown", w.calls.contains("launch com.apple.Safari") && engine.shown == safari, "\(w.calls.suffix(5))")
    check("hosted: the window asked of the default profile's copy, put in full screen by it, then the item's tab in it", links.types(since: mark) == ["newWindow", "setWindowState", "hostShow"] && links.asked.last?.profile == "s-default", "\(links.types(since: mark))")
    let state = links.asked.first { $0.type == "setWindowState" }?.payload ?? [:]
    let safariWindow = copyWindows[90] ?? 0
    check("hosted: setWindowState names the copy's window, full screen, focused, with a notAfter", int(state["windowId"]) == 90 && state["state"] as? String == "fullscreen" && state["focused"] as? Bool == true
          && (num(state["notAfter"]) ?? 0) > Date().timeIntervalSince1970 * 1000, "\(state)")
    check("hosted: Safari's window never put in full screen through Accessibility", !w.calls.contains("fullScreen true \(safariWindow)") && w.wins[safariWindow]?.fullScreen == true)
    let show = links.asked.last?.payload ?? [:]
    check("hosted: hostShow names the hosted window, the item and its address", int(show["windowId"]) == 90 && show["itemId"] as? String == aItem && show["url"] as? String == "https://a.example/", "\(show)")
    check("hosted: the app shown before is parked (still full screen), Safari's window alone in Margin's Space", engine.hosts[HostTarget.app("com.apple.TextEdit").id]?.phase == .parked
          && w.wins[editWindow]?.fullScreen == true && w.inMargin == [safariWindow] && window.loadings.suffix(2) == ["Safari", nil], "\(w.inMargin) \(window.loadings)")
    check("hosted: a web item's loader: Safari's icon (the browser it opens in)", window.loadingApps.suffix(2) == ["com.apple.Safari", nil], "\(window.loadingApps)")
    let aNumber = session.number(ofItem: aItem)
    check("hosted: Safari's first open: the web item's loading bar meanwhile, none after", window.loadingTabsSaid.suffix(2) == [[aNumber], []] && session.safariTabs[aItem] == 500, "\(window.loadingTabsSaid) \(session.safariTabs)")
    session.copyLoading(profile: "s-default", windowId: 90, tabIds: [500])
    check("hosted: the copy says the hosted window's tab is loading: that item's bar", window.loadingTabs == [aNumber], "\(window.loadingTabs)")
    session.copyLoading(profile: "s-default", windowId: 3, tabIds: [500, 501])
    session.copyLoading(profile: "s-work", windowId: 90, tabIds: [])
    check("hosted: another window's (or profile's) loading changes nothing", window.loadingTabs == [aNumber], "\(window.loadingTabs)")
    session.copyLoading(profile: "s-default", windowId: 90, tabIds: [])
    check("hosted: loaded: no bar", window.loadingTabs == [], "\(window.loadingTabs)")

    // ---- a second web item of the same profile: a tab switch only ----
    let calls = w.calls.count
    let mark2 = links.asked.count
    run { _ = library.perform("newTab", ["windowId": 1, "url": "https://b.example/"]) }
    let bItem = library.items(space: home).first { $0.value["url"] as? String == "https://b.example/" }?.id ?? ""
    check("hosted: a second web item of that profile: its tab only, the engine not asked", links.types(since: mark2) == ["hostShow"] && w.calls.count == calls && session.shown[1] == bItem, "\(links.types(since: mark2)) \(w.calls.dropFirst(calls))")
    run { _ = library.perform("activateTab", ["windowId": 1, "tabId": aItem]) }
    check("hosted: back to the first: a tab switch again", links.types(since: mark2) == ["hostShow", "hostShow"] && w.calls.count == calls && session.shown[1] == aItem)

    // ---- what the UI draws ----
    let snap = session.live(library.snapshot())
    let open = snap["openTabs"] as? JSONObject ?? [:]
    let tabs = (open["tabs"] as? JSONObject ?? [:]).values.compactMap { $0 as? JSONObject }
    let kept = open["keptTabs"] as? JSONObject ?? [:]
    let front = tabs.first { $0["active"] as? Bool == true }
    check("hosted: the open items are the window's tabs, the one shown in front, the others kept",
          tabs.count == 3 && front?["mid"] as? String == aItem && int(front?["windowId"]) == 1 && kept[aItem] == nil && kept[editItem] == nil, "\(tabs) \(kept.keys)")
    let source = LibraryWindowSource(library: library, session: session, profileSource: DataSetWindowSource(data: DataSync(store: DataStore(root: tempFolder("hosted-profile"))), pick: { nil }))
    let bNumber = session.number(ofItem: bItem)
    let mark3 = links.asked.count
    run { _ = source.perform("activateTab", ["windowId": 1, "tabId": bNumber, "hint": ["url": "https://b.example/"]]) }
    check("hosted: a press on an open item's row (its number): that item shown", session.shown[1] == bItem && links.types(since: mark3) == ["hostShow"])
    let searched = source.perform("search", ["windowId": 1, "query": "margin app"])
    check("hosted: a search typed in the palette: a web item at the engine's address", searched?["ok"] as? Bool == true
          && library.items(space: home).contains { ($0.value["url"] as? String)?.hasPrefix("https://www.google.com/search?") == true && ($0.value["url"] as? String)?.contains("q=margin%20app") == true })
    run {}
    let unsupported = source.perform("openLauncher", ["windowId": 1])
    check("hosted: a request the library doesn't take: refused, said to the page", unsupported?["ok"] as? Bool == false)
    check("hosted: the UI's own bookkeeping requests: answered quietly", source.perform("sidebarScroll", ["windowId": 1])?["ok"] as? Bool == true)

    // ---- the app's item again: an instant switch ----
    let setStates = links.types().filter { $0 == "setWindowState" }.count
    let loadingsBefore = window.loadings.count
    run { _ = library.perform("activateTab", ["windowId": 1, "tabId": editItem]) }
    check("hosted: the app's item again: shown by the engine at once (no loading), Safari's window parked as it is (its copy not asked)",
          engine.shown == HostTarget.app("com.apple.TextEdit").id && engine.hosts[safari]?.phase == .parked && w.wins[safariWindow]?.fullScreen == true
          && links.types().filter { $0 == "setWindowState" }.count == setStates && window.loadings.count == loadingsBefore && window.hosted == editWindow, "\(window.loadings)")

    // ---- Safari and Chrome picked as apps ----
    let before = library.items().count
    run { session.openApp("com.google.Chrome", windowId: 1) }
    check("hosted: Chrome picked: not supported yet, nothing added or launched", library.items().count == before && !w.calls.contains { $0.contains("Chrome") })
    run { session.openApp("com.apple.Safari", windowId: 1) }
    check("hosted: Safari picked: a new web item in Safari (not Safari hosted as an app)", library.items().count == before + 1
          && library.items().contains { $0.value["url"] as? String == "about:blank" } && engine.shown == safari)

    let beforeOwn = library.items().count
    run { session.openApp("com.unibox.margin", windowId: 1) }
    check("hosted: Margin picked in its own palette: never hosted, a new web item with the surprise instead", library.items().count == beforeOwn + 1
          && library.items().contains { $0.value["url"] as? String == HostedSession.ownAppSurprise } && !engine.isHosted(HostTarget.app("com.unibox.margin").id))

    // ---- the page area moved (another theme): the one shown placed again, with the loading animation ----
    window.layout.left = 300
    let moved = window.hostedPlacement
    let loadingsNow = window.loadings.count
    session.pageRectChanged(window)
    session.pageRectChanged(window) // (a burst of layouts: taken once)
    run {}
    check("hosted: the page area changed: the engine told, Safari's window placed there again, the loading animation meanwhile", moved?.page.minX == 300 && engine.pageRect == moved?.page
          && w.bounds(window: safariWindow) == moved?.page && Array(window.loadings.dropFirst(loadingsNow)) == ["Safari", nil] && w.listsMarginOnly,
          "\(String(describing: moved)) \(engine.pageRect) \(window.loadings)")

    // ---- closing ----
    let mark4 = links.asked.count
    run { _ = library.perform("closeTab", ["windowId": 1, "tabId": aItem]) }
    check("hosted: a web item closed: its tab closed by its copy, archived", links.types(since: mark4).first == "hostClose" && session.open[aItem] == nil
          && library.items().allSatisfy { $0.id != aItem } && (library.values["archive"] as? JSONObject ?? [:]).count >= 1, "\(links.types(since: mark4))")
    run { _ = library.perform("closeTab", ["windowId": 1, "tabId": editItem]) }
    check("hosted: an app item closed: the engine closes its app (quit, Margin started it)", !engine.isHosted(HostTarget.app("com.apple.TextEdit").id) && w.running(bundleId: "com.apple.TextEdit").isEmpty)
    for item in library.items().map(\.id) where session.open[item] != nil { run { _ = library.perform("closeTab", ["windowId": 1, "tabId": item]) } }
    let closeMark = links.asked.count
    run { await engine.close(safari) }
    session.hostEvent(.closed(safari))
    check("hosted: Safari's window closed by its copy before the Safari Margin started is quit", links.types(since: closeMark).contains("closeWindow") && w.wins[safariWindow] == nil && engine.leftSafariWindows.isEmpty, "\(links.types(since: closeMark))")
    run {}
    check("hosted: nothing hosted any more: Margin's window its launcher again", window.hostings.last == false && session.hostingWindow == nil && !engine.hasHosts, "\(window.hostings) \(engine.hosts.keys) \(engine.launched) \(w.calls.suffix(8))")
    check("hosted: the Safari window Margin started quit with Safari, nothing left in Margin's Space", w.running(bundleId: "com.apple.Safari").isEmpty && w.inMargin.isEmpty && w.listsMarginOnly, "\(w.inMargin)")

    // ---- macOS took Margin's window out of full screen while hosting: the app parked at once, back with Margin ----
    run { session.openApp("com.apple.TextEdit", windowId: 1) }
    let wasHosting = session.hostingWindow == 1 && window.hosting
    let editId = HostTarget.app("com.apple.TextEdit").id
    let editNow = w.running(bundleId: "com.apple.TextEdit").first.flatMap { w.apps[$0.pid]?.windows.first } ?? 0
    let editItemNow = session.shown[1]
    session.leavingFullScreen(window)
    window.isFullScreen = false
    w.marginLeavesFullScreen() // (macOS: Margin's window on the Desktop, its Space left with the member in it)
    session.leftFullScreen(window)
    hostRun { await engine.parkShown(why: "the test's") } // (after the session's own ask)
    run {}
    check("hosted: Margin's window out of full screen while hosting: nothing shown in it, the item kept to show again", wasHosting && !window.hosting && session.hostingWindow == nil
          && session.shown[1] == nil && session.resume[1] == editItemNow && editItemNow != nil)
    check("hosted: … the app parked at once, still full screen, in a private Space; Margin's old Space destroyed", engine.shown == nil && engine.hosts[editId]?.phase == .parked
          && w.wins[editNow]?.fullScreen == true && w.wins[editNow]?.priv != nil && w.tiles[FakeHostWorld.marginSpace] == nil && w.destroyedWithWindows == 0, "\(w.tiles) \(String(describing: w.wins[editNow]))")
    // Margin's window goes straight back into full screen (MarginWindowController), and the session hosts it again.
    window.isFullScreen = true
    w.marginEntersFullScreen()
    session.enteredFullScreen(window)
    run {}
    check("hosted: Margin's window back in full screen: the item it showed hosted again, in its Space, at once",
          window.hosting && engine.shown == editId && w.spaces(window: editNow) == [FakeHostWorld.marginSpace] && session.shown[1] == editItemNow && session.resume.isEmpty
          && window.hosted == editNow && w.listsMarginOnly, "\(session.done.suffix(4))")
    // ---- a profile with no window: woken through Safari's menu, its waking window closed after Margin's is made ----
    do {
        let woken = FakeHostedLinks()
        woken.wakes = ["s-quiet"]
        let s2 = HostedSession(library: library, engine: engine, links: woken)
        s2.sleep = { _ in await Task.yield() }
        s2.options.firstCopiesPace = 0
        var linked = false
        var made: HostSafariWindow?
        hostRun { linked = await s2.safariLinked("s-quiet"); made = await s2.requestSafariWindow("s-quiet") }
        check("hosted: a profile with no window is woken once through Safari's menu", woken.menuOpens == ["s-quiet"], "\(woken.menuOpens)")
        check("hosted: then linked, its window made, the waking window closed", linked && made != nil && woken.asked.map(\.type) == ["newWindow", "closeWindow"]
              && int(woken.asked.last?.payload["windowId"]) == 77, "\(woken.asked.map(\.type))")
        // (2026-11-17 real-apps: a copy not in charge answered "a newer copy of Margin is running" and the open failed.)
        let stale = FakeHostedLinks()
        stale.profiles = ["s-default"]
        stale.staleNewWindows = 1
        let s4 = HostedSession(library: library, engine: engine, links: stale)
        s4.sleep = { _ in await Task.yield() }
        var madeAgain: HostSafariWindow?
        hostRun { madeAgain = await s4.requestSafariWindow("s-default") }
        check("hosted: a window asked of a copy not in charge (stale): asked again once another copy's link replaced it, made",
              madeAgain != nil && stale.asked.filter { $0.type == "newWindow" }.count == 2, "\(stale.asked.map(\.type))")
    }
    safariWakeTests(library)
    // ---- an app that can't go full screen (window mode): above Margin's own layout, kept below its window ----
    do {
        let ftId = HostTarget.app("com.apple.FaceTime").id, editId = HostTarget.app("com.apple.TextEdit").id
        run { session.openApp("com.apple.FaceTime", windowId: 1) }
        let ftItem = library.items(space: home).first { $0.value["url"] as? String == "app://com.apple.FaceTime" }?.id ?? ""
        let ftPid = w.running(bundleId: "com.apple.FaceTime").first?.pid ?? 0
        let ftWindow = w.apps[ftPid]?.windows.first ?? 0
        check("hosted window mode: FaceTime picked: shown in window mode, its window at Margin's own page area", engine.shown == ftId && engine.mode(of: ftId) == .window
              && w.bounds(window: ftWindow) == window.hostedPlacement?.page && session.shown[1] == ftItem, "\(session.done.suffix(4))")
        check("hosted window mode: Margin's window told FaceTime's window; TextEdit parked", window.hosted == ftWindow && engine.hosts[editId]?.phase == .parked, "\(window.hosteds)")
        session.pagePressed(window)
        hostRun { for _ in 0..<5 { await Task.yield() } }
        check("hosted window mode: a press in the page area around it: FaceTime given the keyboard (activated, raised)", w.calls.contains("activate \(ftPid) \(ftWindow)"), "\(w.calls.suffix(3))")

        // to the full-screen app, and back: both instant
        let editNowItem = library.items().first { $0.value["url"] as? String == "app://com.apple.TextEdit" }?.id ?? ""
        run { _ = library.perform("activateTab", ["windowId": 1, "tabId": editNowItem]) }
        check("hosted window mode → full screen: TextEdit back in Margin's Space, Margin's window told its window", engine.shown == editId && window.hosted == editNow && engine.hosts[ftId]?.phase == .parked, "\(window.hosteds) \(session.done.suffix(4))")
        run { _ = library.perform("activateTab", ["windowId": 1, "tabId": ftItem]) }
        check("hosted full screen → window mode: FaceTime shown again, Margin's window told its window", engine.shown == ftId && window.hosted == ftWindow
              && w.bounds(window: ftWindow) == window.hostedPlacement?.page && w.inMargin == [ftWindow], "\(session.done.suffix(4))")

        // the page area moves (another theme): placed again by Accessibility, not parked
        let moves = w.calls.filter { $0.hasPrefix("move \(ftWindow) ") }.count
        window.layout.left = 240
        session.pageRectChanged(window)
        run {}
        check("hosted window mode: the page area moved: FaceTime placed there again, never parked for it", w.bounds(window: ftWindow) == window.hostedPlacement?.page && window.hostedPlacement?.page.minX == 240
              && w.calls.filter { $0.hasPrefix("move \(ftWindow) ") }.count == moves, "\(String(describing: w.bounds(window: ftWindow)))")

        // closed: its frame back, then quit
        run { _ = library.perform("closeTab", ["windowId": 1, "tabId": ftItem]) }
        check("hosted window mode: FaceTime's item closed: its frame given back before it was quit", w.frameAtQuit["com.apple.FaceTime"] == FakeHostWorld.defaultFrame && w.running(bundleId: "com.apple.FaceTime").isEmpty
              && w.saved["com.apple.FaceTime"] == FakeHostWorld.defaultFrame, "\(String(describing: w.frameAtQuit))")
        window.layout.left = 300
    }
    run { await engine.quitAll() }

    // ---- Margin's window found windowed anyway (it never should be): asked once more; it won't: nothing hosted ----
    window.isFullScreen = false
    window.goesFullScreen = false
    session.options.fullScreenWait = 0.2
    let launches = w.calls.filter { $0.hasPrefix("launch") }.count
    let asks = window.fullScreenAsks
    run { session.openApp("com.apple.Notes", windowId: 1) }
    check("hosted: Margin's window not in full screen (a safety check): asked once, it didn't go: nothing opened", w.calls.filter { $0.hasPrefix("launch") }.count == launches && !engine.hasHosts
          && window.fullScreenAsks == asks + 1 && session.done.contains { $0.contains("it always is while hosting is on") })
    window.goesFullScreen = true
    window.isFullScreen = true

    hostedShellTests(script: script)
    sidebarResizeTests(script: script)
    liveSidebarResizeTests(script: script)
    hostedFrontTests(script: script)
    hostedResumeTests(script: script)
}

// At launch, the item the window showed last (HostedSession.resumeLast): the library, with an item selected in the
// window's space, a new session and engine as after a relaunch, and a stand-in Margin window not yet in full screen.
// Hosting and the loader are said as the window is made (before its page's hello); the show itself waits for the
// window; nothing selected, or a second window: the launcher as before; a show that fails: the launcher.
func hostedResumeTests(script: URL) {
    let root = tempFolder("hosted-resume")
    defer { try? FileManager.default.removeItem(at: root) }
    guard let library = Library.open(dataRoot: root, script: script, background: false) else { return check("resume: the library opens", false) }
    func launch(fails: Set<String> = [], links: FakeHostedLinks = FakeHostedLinks()) -> (FakeHostWorld, HostEngine, HostedSession, FakeHostedWindow, (@escaping () async -> Void) -> Void) {
        let w = FakeHostWorld()
        w.fail = fails
        let engine = HostEngine(system: w, marker: nil, pid: 1)
        engine.options.privateRetire = 0
        let session = HostedSession(library: library, engine: engine, links: links)
        session.sleep = { _ in await Task.yield() }
        session.appName = { $0 == "com.apple.Notes" ? "Notes" : nil }
        session.options.preparesBrowser = false // (the resume alone: the start's browser below, "the start")
        let window = FakeHostedWindow(id: 1, number: FakeHostWorld.marginWindow)
        session.window = { id in id == nil || id == 1 ? window : nil }
        // (A Safari Margin starts: its copy's newWindow makes a window on the Desktop, its setWindowState acts on it.)
        engine.requestSafariWindow = { await session.requestSafariWindow($0) }
        engine.closeSafariWindow = { await session.closeSafariWindow($0, $1) }
        engine.safariFullScreen = { await session.safariFullScreen($0, $1, $2) }
        engine.safariLinked = { await session.safariLinked($0) }
        var copyWindows: [Int: Int] = [:]
        links.onNewWindow = { id, _ in
            guard let pid = w.running(bundleId: "com.apple.Safari").first?.pid else { return }
            let n = w.nextWindow
            w.nextWindow += 1
            w.wins[n] = FakeHostWorld.Win(pid: pid, spaces: [FakeHostWorld.desktop])
            w.apps[pid]?.windows.append(n)
            copyWindows[id] = n
        }
        links.onSetWindowState = { id, on in
            guard let n = copyWindows[id], let pid = w.wins[n]?.pid else { return }
            w.applyFullScreen(pid: pid, window: n, on)
        }
        links.onCloseWindow = { id in if let n = copyWindows.removeValue(forKey: id) { w.closeWindow(n) } }
        engine.onEvent = { session.hostEvent($0) }
        engine.loading = { session.loading($0) }
        engine.hostedWindow = { session.hosted($0) }
        library.delegate = session
        return (w, engine, session, window, { body in hostRun { await body(); await session.idle() } })
    }
    _ = library.perform("createSpace", ["windowId": 1, "name": "Home", "emoji": "🏠"])

    // ---- nothing selected in the window's space: the launcher, as before ----
    do {
        let (w, engine, session, window, run) = launch()
        session.resumeLast(window)
        run {}
        check("resume: nothing selected in the window's space: nothing hosted, the launcher", !window.hosting && window.showings.isEmpty && engine.shown == nil && w.calls.isEmpty && session.resuming == nil)
        // (An app used in it, as a first run of Margin: selected from now on.)
        run { session.openApp("com.apple.Notes", windowId: 1) }
        check("resume: an app picked and shown: the item selected in its space", engine.shown == HostTarget.app("com.apple.Notes").id
              && library.items().contains { $0.value["url"] as? String == "app://com.apple.Notes" && $0.value["selected"] as? Bool == true }, "\(library.items().map { $0.value })")
        run { await engine.quitAll() }
    }
    let item = library.items().first { $0.value["url"] as? String == "app://com.apple.Notes" }?.id ?? ""
    check("resume: MarginResumeLast: on unless it's set to NO", HostedSession.resumesLast(setting: nil) && HostedSession.resumesLast(setting: true) && !HostedSession.resumesLast(setting: false) && HostedSession.resumesLast(setting: "x"))

    // ---- Margin opened again: that item, behind the loader from the window's making ----
    do {
        let (w, engine, session, window, run) = launch()
        window.isFullScreen = false // (just made: not in full screen yet, its page not loaded)
        session.resumeLast(window)
        check("resume: as the window is made (before its page loads): hosting, the loader with the item's name at once (known to be slow: no grace), its row in front; nothing launched until the window is up",
              window.hosting && window.showings == ["Notes"] && window.slowShowings == ["Notes"] && session.requested[1] == item && session.resuming == 1 && session.hostingWindow == 1
              && !w.calls.contains { $0.hasPrefix("launch") } && (session.live(library.snapshot())["openTabs"] as? JSONObject).flatMap { ($0["tabs"] as? JSONObject)?.values.first as? JSONObject }?["active"] as? Bool == true,
              "\(window.showings) \(window.slowShowings) \(String(describing: session.requested[1]))")
        check("resume: … with the app's bundle id for the loader's icon", window.showingApps == ["com.apple.Notes"], "\(window.showingApps)")
        // (Something that settles hosting meanwhile, an engine event: the loader stays.)
        session.hostEvent(.parked(HostID(raw: "app:none")))
        hostRun { await Task.yield(); return true }
        check("resume: hosting kept while its item is on its way (nothing shown yet isn't the launcher)", window.hosting && window.showing == "Notes")
        window.isFullScreen = true
        run {}
        let notes = w.running(bundleId: "com.apple.Notes").first.flatMap { w.apps[$0.pid]?.windows.first } ?? 0
        check("resume: once Margin's window is in full screen with its page area: the item's app opened and shown at the page area, its item the one shown; the loader cleared; no launcher in between",
              engine.shown == HostTarget.app("com.apple.Notes").id && w.bounds(window: notes) == window.hostedPlacement?.page && session.shown[1] == item && session.requested[1] == nil
              && window.showing == nil && window.hosted == notes && window.hostings == [true] && session.resuming == nil, "\(session.done.suffix(4)) \(window.hostings)")
        // A second window later in the run (⌘N): not its business.
        let second = FakeHostedWindow(id: 2, number: 77)
        session.resumeLast(second)
        check("resume: only the first window of a run: a second one opens on the launcher", !second.hosting && second.showings.isEmpty && session.hostingWindow == 1)
        run { await engine.quitAll() }
    }

    // ---- Margin's window not in full screen in time: the launcher for now, the item once the window is ----
    do {
        let (w, engine, session, window, run) = launch()
        session.options.prepareWindowWait = 0.2
        window.isFullScreen = false
        session.resumeLast(window)
        run {}
        let waited = !window.hosting && window.hostings == [true, false] && engine.shown == nil && session.requested[1] == nil && session.resuming == nil && !w.calls.contains { $0.hasPrefix("launch") }
        window.isFullScreen = true
        session.enteredFullScreen(window)
        run {}
        check("resume: Margin's window not in full screen in time: the launcher for now, nothing launched; its item shown once the window is in full screen",
              waited && engine.shown == HostTarget.app("com.apple.Notes").id && session.shown[1] == item && window.hosting, "waited \(waited) \(window.hostings) \(session.done.suffix(4))")
        run { await engine.quitAll() }
    }

    // ---- its app can't be opened: the launcher, the item kept ----
    do {
        let (w, engine, session, window, run) = launch(fails: ["launch"])
        session.resumeLast(window)
        run {}
        check("resume: the item's show fails (its app doesn't start): the launcher again, nothing left pending, the item still in the library",
              !window.hosting && window.hostings == [true, false] && window.showing == nil && engine.shown == nil && session.requested[1] == nil && session.resuming == nil
              && library.items().contains { $0.id == item }, "\(window.hostings) \(session.done.suffix(3)) \(w.calls.suffix(3))")
    }

    // ---- turned off: the launcher ----
    do {
        let (_, _, session, window, run) = launch()
        session.options.resumesLast = false
        session.resumeLast(window)
        run {}
        check("resume: off: nothing at launch", !window.hosting && window.showings.isEmpty)
    }

    // ---- something else picked while Margin's window is still on its way: that, at once; the last item never opened ----
    do {
        let (w, engine, session, window, run) = launch()
        window.isFullScreen = false
        var sleeps = 0 // (the session's waits, counted: the 30 s for Margin's window is 600 of them)
        session.sleep = { _ in sleeps += 1; await Task.yield() }
        session.resumeLast(window)
        run { session.openApp("com.apple.TextEdit", windowId: 1) }
        check("resume: another item picked while Margin's window isn't up yet: the wait for the last one ends at once (not sat out: \(sleeps) looks, of 600), the picked one shown, the last one's app never started",
              engine.shown == HostTarget.app("com.apple.TextEdit").id && session.done.contains { $0.contains("\(item): not shown") && $0.contains("asked for since") } && sleeps < 100
              && w.running(bundleId: "com.apple.Notes").isEmpty && session.resuming == nil && window.hosting, "\(sleeps) \(session.done.suffix(5))")
        run { await engine.quitAll() }
    }

    // ---- a web item last: the loader with its title while its browser starts (nothing made ready yet), then its window and tab ----
    do {
        let links = FakeHostedLinks()
        links.profiles = ["s-default"] // (its copy links as Safari starts)
        let (_, engine, _, _, run) = launch(links: links)
        run { _ = library.perform("newTab", ["windowId": 1, "url": "https://last.example/", "title": "Last page"]) }
        run { await engine.quitAll() }
    }
    do {
        let page = library.items().first { $0.value["url"] as? String == "https://last.example/" }
        let links = FakeHostedLinks()
        links.profiles = ["s-default"]
        let (w, engine, session, window, run) = launch(links: links)
        window.isFullScreen = false
        session.resumeLast(window)
        let atOnce = window.hosting && window.slowShowings == ["Last page"] && session.requested[1] == page?.id && w.calls.isEmpty && links.asked.isEmpty
        window.isFullScreen = true
        run {}
        let safari = HostTarget.safariWindow("s-default").id
        let shows = links.asked.filter { $0.type == "hostShow" }
        check("resume: a web item last: the loader with its title as the window is made, nothing started yet; then its browser started (no window was made ready: the loader stays for all of it), its window shown with the item's tab, no launcher in between",
              page?.value["selected"] as? Bool == true && atOnce && w.calls.contains("launch com.apple.Safari") && engine.shown == safari && session.shown[1] == page?.id
              && shows.count == 1 && shows.first?.payload["itemId"] as? String == page?.id && window.showing == nil && window.hostings == [true] && session.resuming == nil,
              "at once \(atOnce) \(window.slowShowings) \(session.done.suffix(4)) \(window.hostings)")
        run { await engine.quitAll() }
    }

    // ---- the start (Tirth, 2026-11-18): the default browser first, behind "Getting you started", then the item ----
    let notes = library.items().first { $0.value["url"] as? String == "app://com.apple.Notes" }?.id ?? ""
    if notes.isEmpty { check("start: Notes is an item", false) }
    _ = library.perform("activateTab", ["windowId": 1, "tabId": notes])
    do {
        let (w, engine, session, window, run) = launch()
        session.options.preparesBrowser = true
        window.isFullScreen = true
        session.resumeLast(window)
        let first = window.slowShowings
        let launchedEarly = w.calls.contains { $0.hasPrefix("launch com.apple.Notes") }
        // (The browser's preparation over: ready, or not done.)
        session.preparationOver()
        run {}
        check("start: \"Getting you started\" from the window's first frame while the default browser starts, nothing of the item launched yet; then the item's name, and the item shown",
              first == [HostedSession.startupLabel] && !launchedEarly && window.slowShowings.prefix(2) == [HostedSession.startupLabel, "Notes"]
              && engine.shown == HostTarget.app("com.apple.Notes").id && session.resuming == nil && window.showing == nil,
              "first \(first) all \(window.slowShowings) shown \(String(describing: engine.shown))")
        run { await engine.quitAll() }
    }
    do {
        let (_, engine, session, window, run) = launch()
        session.options.preparesBrowser = true
        session.options.startupWait = 0.05
        window.isFullScreen = true
        session.resumeLast(window)
        // (The preparation never says it's over: the item isn't held longer than `startupWait`.)
        let until = Date().addingTimeInterval(3)
        while engine.shown == nil, Date() < until { run {} ; RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
        check("start: a browser that never gets ready holds the item no longer than its limit", engine.shown == HostTarget.app("com.apple.Notes").id && session.resuming == nil,
              "\(String(describing: engine.shown)) \(window.slowShowings)")
        run { await engine.quitAll() }
    }
    // ---- an item in another Margin window (Tirth, 2026-11-18): its card there, the item back when that window's in front ----
    do {
        let (w, engine, session, window, run) = launch()
        window.isFullScreen = true
        let second = FakeHostedWindow(id: 2, number: 77)
        second.isFullScreen = true
        w.wins[77] = FakeHostWorld.Win(pid: 1, spaces: [FakeHostWorld.marginSpace]) // (a second Margin window, in Margin's Space)
        session.window = { id in id == nil || id == 1 ? window : id == 2 ? second : nil }
        run { session.openApp("com.apple.Notes", windowId: 1) }
        let notesShown = engine.shown == HostTarget.app("com.apple.Notes").id && session.hostingWindow == 1
        run { session.openApp("com.apple.TextEdit", windowId: 2) }
        check("elsewhere: an app opened in a second Margin window: hosted there, the first window's item kept as its card (faded: \"Click to show Notes here\"), not the launcher",
              notesShown && engine.shown == HostTarget.app("com.apple.TextEdit").id && session.hostingWindow == 2 && window.elsewhere == "Notes" && window.elsewhereApp == "com.apple.Notes"
              && !window.hosting && second.elsewhere == nil && session.elsewhere[1] != nil, "\(String(describing: engine.shown)) \(String(describing: window.elsewhere)) \(session.elsewhere)")
        session.focused(1)
        run {}
        check("elsewhere: the first window brought in front: its item hosted there again (the app's one window follows the window in use), the second window's item its card now",
              engine.shown == HostTarget.app("com.apple.Notes").id && session.hostingWindow == 1 && window.elsewhere == nil && second.elsewhere != nil && session.elsewhere[2] != nil && session.elsewhere[1] == nil,
              "\(String(describing: engine.shown)) \(String(describing: second.elsewhere)) \(session.elsewhere)")
        session.focused(1)
        run {}
        check("elsewhere: in front again with its item already there: nothing more", engine.shown == HostTarget.app("com.apple.Notes").id && session.hostingWindow == 1)
        run { await engine.quitAll() }
        _ = library.perform("activateTab", ["windowId": 1, "tabId": notes]) // (Notes the item shown last again, for the tests after)
    }
    // ---- a web item's card in the other window: its page's picture, taken as its window leaves ----
    do {
        let links = FakeHostedLinks()
        links.profiles = ["s-default"]
        links.picture = "data:image/jpeg;base64,QUJD"
        let (w, engine, session, window, run) = launch(links: links)
        window.isFullScreen = true
        let second = FakeHostedWindow(id: 2, number: 77)
        second.isFullScreen = true
        w.wins[77] = FakeHostWorld.Win(pid: 1, spaces: [FakeHostWorld.marginSpace])
        session.window = { id in id == nil || id == 1 ? window : id == 2 ? second : nil }
        run { _ = library.perform("newTab", ["windowId": 1, "url": "https://pictured.example/", "title": "Pictured"]) }
        let item = library.items().first { $0.value["url"] as? String == "https://pictured.example/" }?.id ?? ""
        let safariShown = engine.shown == HostTarget.safariWindow("s-default").id && session.shown[1] == item
        run { session.openApp("com.apple.TextEdit", windowId: 2) }
        let asked = links.asked.first { $0.type == "hostPicture" }
        check("elsewhere: a web item's card: its page's picture, asked of its copy for its window and item as it leaves, given to the card",
              safariShown && window.elsewhere == "Pictured" && window.elsewherePicture == links.picture && int(asked?.payload["windowId"]) == session.safariWindows["s-default"]
              && asked?.payload["itemId"] as? String == item && second.elsewherePicture == nil,
              "\(safariShown) \(String(describing: window.elsewhere)) \(String(describing: asked?.payload))")
        session.focused(1)
        run {}
        check("elsewhere: an app's card (the second window's TextEdit): no picture asked (Margin has none of other apps' windows)",
              second.elsewhere != nil && second.elsewherePicture == nil && window.elsewhere == nil && window.elsewherePicture == nil
              && links.asked.filter { $0.type == "hostPicture" }.count == 1, "\(String(describing: second.elsewhere))")
        // A copy slower than `pictureWait`: the card alone, the move not held for it.
        links.pictureDelay = 2
        session.options.pictureWait = 0.05
        let started = Date()
        session.focused(2)
        run {}
        check("elsewhere: a picture not there in time: the card alone, the move not held for it",
              engine.shown == HostTarget.app("com.apple.TextEdit").id && window.elsewhere == "Pictured" && window.elsewherePicture == nil && Date().timeIntervalSince(started) < 1.5,
              "\(String(describing: engine.shown)) \(String(describing: window.elsewhere)) \(Date().timeIntervalSince(started))")
        run { await engine.quitAll() }
        _ = library.perform("activateTab", ["windowId": 1, "tabId": notes])
    }
    do {
        let (_, engine, session, window, run) = launch()
        session.options.preparesBrowser = true
        window.isFullScreen = true
        session.preparationOver()
        session.resumeLast(window)
        run {}
        check("start: the browser ready before the window: no \"Getting you started\", the item at once", window.slowShowings == ["Notes"] && engine.shown == HostTarget.app("com.apple.Notes").id,
              "\(window.slowShowings)")
        run { await engine.quitAll() }
    }
}

// Margin's window in front of what it hosts, the session's side (DECISIONS.md, 2026-11-17): what Margin's window is
// told as an item is shown (not ready until its tab is in front too; a tab switch in the window shown says nothing);
// a placing again that fails never drops the item (shown again once after a pause, behind the loader; failing that
// too, the launcher with the item kept and its window still hosted, out of sight); a field of Margin's letting go of
// the keys gives them back to the app shown; another app's window in Margin's Space told to Margin's window.
func hostedFrontTests(script: URL) {
    let root = tempFolder("hosted-front")
    defer { try? FileManager.default.removeItem(at: root) }
    guard let library = Library.open(dataRoot: root, script: script, background: false) else { return check("front: the library opens", false) }
    let w = FakeHostWorld()
    let engine = HostEngine(system: w, marker: nil, pid: 1)
    engine.options.privateRetire = 0
    let links = FakeHostedLinks()
    let session = HostedSession(library: library, engine: engine, links: links)
    session.sleep = { _ in await Task.yield() }
    let window = FakeHostedWindow(id: 1, number: FakeHostWorld.marginWindow)
    session.window = { id in id == nil || id == 1 ? window : nil }
    engine.requestSafariWindow = { await session.requestSafariWindow($0) }
    engine.closeSafariWindow = { await session.closeSafariWindow($0, $1) }
    engine.safariFullScreen = { await session.safariFullScreen($0, $1, $2) }
    engine.safariLinked = { await session.safariLinked($0) }
    engine.onEvent = { session.hostEvent($0) }
    engine.loading = { session.loading($0) }
    engine.hostedWindow = { session.hosted($0) }
    engine.others = { session.others($0) }
    library.delegate = session
    links.profiles = ["s-default"]
    var copyWindows: [Int: Int] = [:]
    var ignoredEntries = 0 // asks into full screen its copy answers and Safari doesn't do (mid-change)
    links.onNewWindow = { id, _ in
        guard let pid = w.running(bundleId: "com.apple.Safari").first?.pid else { return }
        let n = w.nextWindow
        w.nextWindow += 1
        w.wins[n] = FakeHostWorld.Win(pid: pid, spaces: [FakeHostWorld.desktop])
        w.apps[pid]?.windows.append(n)
        copyWindows[id] = n
    }
    links.onSetWindowState = { id, on in
        guard let n = copyWindows[id], let pid = w.wins[n]?.pid else { return }
        if on, ignoredEntries > 0 { ignoredEntries -= 1; return }
        w.applyFullScreen(pid: pid, window: n, on)
    }
    links.onCloseWindow = { id in if let n = copyWindows.removeValue(forKey: id) { w.closeWindow(n) } }
    func run(_ body: @escaping () async -> Void = {}) { hostRun { await body(); await session.idle() } }
    func page(_ left: CGFloat) -> CGRect { CGRect(x: left, y: 41, width: 1512 - 8 - left, height: 933) }
    _ = library.perform("createSpace", ["windowId": 1, "name": "Home", "emoji": "🏠"])

    // ---- a web item: not ready until its tab is in front in its window too ----
    run { _ = library.perform("newTab", ["windowId": 1, "url": "https://example.com/", "title": "Example"]) }
    let safari = HostTarget.safariWindow("s-default").id
    let item = library.items().first { $0.value["url"] as? String == "https://example.com/" }?.id ?? ""
    let mine = copyWindows.values.first ?? 0
    guard engine.shown == safari, !item.isEmpty, w.bounds(window: mine) == page(260) else { return check("front: a web item shown in its Safari window", false, "\(session.done.suffix(6))") }
    check("front: a web item's first show: Margin's window told it's being shown, with its title, until its tab is in front too; then nothing pending", window.showings == ["Example", nil] && window.hosted == mine
          && window.loading == nil, "\(window.showings)")
    check("front: … the loader's icon Safari's", window.showingApps.suffix(2) == ["com.apple.Safari", nil], "\(window.showingApps)")
    let showings = window.showings.count
    run { _ = library.perform("newTab", ["windowId": 1, "url": "https://second.example/", "title": "Second"]) }
    check("front: a second web item of the profile (a tab switch in the window shown: Safari's own, in sight): nothing said to Margin's window, no loader", window.showings.count == showings && engine.shown == safari)
    run { _ = library.perform("activateTab", ["windowId": 1, "tabId": item]) }

    // ---- from an app back to the web item: its tab in front while its window is still parked, then the window in ----
    run { session.openApp("com.apple.TextEdit", windowId: 1) }
    var parkedAtTab: Bool?
    links.onHostShow = { parkedAtTab = w.wins[mine]?.priv != nil && w.spaces(window: mine) == [] }
    let showingsMark = window.showings.count
    run { _ = library.perform("activateTab", ["windowId": 1, "tabId": item]) }
    links.onHostShow = nil
    check("front: a web item whose Safari window is there already (parked): its tab asked of the copy while the window is still out of sight, then the window comes in (the right page from the first frame); told as being shown meanwhile",
          parkedAtTab == true && engine.shown == safari && w.inMargin == [mine] && Array(window.showings.dropFirst(showingsMark)) == ["Example", nil] && session.shown[1] == item,
          "parked at its tab \(String(describing: parkedAtTab)) \(window.showings.dropFirst(showingsMark))")

    // ---- a field of Margin's lets go of the keys: the app shown has them again; another window in Margin's Space ----
    let safariPid = w.wins[mine]?.pid ?? 0
    let activations = w.calls.filter { $0 == "activate \(safariPid) \(mine)" }.count
    session.fieldClosed(window)
    run()
    _ = hostRun { await Task.yield(); return true }
    check("front: a field of Margin's (the palette) closed with a host shown: that app activated again", w.calls.filter { $0 == "activate \(safariPid) \(mine)" }.count == activations + 1, "\(w.calls.suffix(3))")
    session.others(777)
    session.others(nil)
    check("front: another app's window in Margin's Space: Margin's window told to let it in front, and when it's gone", window.yields == [.some(777), nil], "\(window.yields)")
    let read = HostEngine.FrontRead(hosted: mine, marginLayer: 1, marginAbove: false)
    session.front(read)
    check("front: the poll's read at rest of Margin's window and the one shown: passed to the Margin window hosting", window.frontReads == [read], "\(window.frontReads)")

    // ---- a placing whose entry into full screen isn't done (twice): the item kept, shown again after a pause ----
    var closes = links.types().filter { $0 == "closeWindow" || $0 == "hostClose" }.count
    var mark = window.showings.count
    ignoredEntries = 2 // (its ask, and the one asked once more)
    window.layout.left = 320
    session.pageRectChanged(window)
    run()
    check("front: a placing that left Safari's window out of full screen (two asks not done): never closed or dropped: shown again once after a pause, at the new page area, its item still the one shown",
          engine.shown == safari && w.bounds(window: mine) == page(320) && w.wins[mine]?.fullScreen == true && w.inMargin == [mine] && session.shown[1] == item && session.open[item] != nil
          && links.types().filter { $0 == "closeWindow" || $0 == "hostClose" }.count == closes && window.hosting && window.hosted == mine
          && session.done.contains { $0.contains("(not fitted)") } && session.done.contains { $0.contains("shown again after its placing failed") }, "\(session.done.suffix(5))")
    check("front: … the loader's name kept up between the two tries (Margin's window told it's still being shown), cleared once it is", Array(window.showings.dropFirst(mark)) == ["Safari", nil], "\(window.showings.dropFirst(mark))")

    // ---- neither try works: the launcher, the item kept and its window still hosted (out of sight); a click shows it ----
    closes = links.types().filter { $0 == "closeWindow" || $0 == "hostClose" }.count
    mark = window.showings.count
    ignoredEntries = 99
    window.layout.left = 300
    session.pageRectChanged(window)
    run()
    check("front: a placing that fails, and again after the pause: nothing shown (the launcher), but nothing torn down: the item kept open, its Safari window still hosted and never asked to close",
          engine.shown == nil && !window.hosting && window.hosted == nil && session.open[item] != nil && library.items().contains { $0.id == item } && engine.isHosted(safari)
          && w.wins[mine] != nil && links.types().filter { $0 == "closeWindow" || $0 == "hostClose" }.count == closes && window.showing == nil
          && session.done.contains { $0.contains("hosted still, out of sight") }, "\(session.done.suffix(5))")
    ignoredEntries = 0
    run { _ = library.perform("activateTab", ["windowId": 1, "tabId": item]) }
    check("front: … and its row clicked once Safari can: shown again, in full screen at the page area", engine.shown == safari && w.bounds(window: mine) == page(300) && w.wins[mine]?.fullScreen == true && w.inMargin == [mine]
          && session.shown[1] == item && window.hosting, "\(session.done.suffix(4))")
}

// The sidebar's edge dragged while hosting (HostedSession.sidebarResizing): the real engine on the stand-in window
// manager, a stand-in Margin window whose layout the test moves as the page would while its handle is dragged. The
// page area's changes are held for the whole drag (Margin's window is in front: the sidebar slides over the hosted
// window as it is); let go, the one shown is placed once, behind the loader, at the page area the drag ended on, from that placement alone (nothing reserved twice, nothing on Margin's own
// Space); a parked one keeps what it had until it's next shown, and is placed once then.
// Live resize (docs/HOSTING-CORE.md "Live resize: tiles in Margin's Space"): the same drag with the stand-in world's
// tiles on: the one shown follows each page area of the drag (nothing held, no loader), the parked one sized once it's
// over, nothing out of or into full screen.
func liveSidebarResizeTests(script: URL) {
    let root = tempFolder("hosted-live-resize")
    defer { try? FileManager.default.removeItem(at: root) }
    guard let library = Library.open(dataRoot: root, script: script, background: false) else { return check("live resize (session): the library opens", false) }
    let w = FakeHostWorld()
    w.tilesOn = true
    w.minSize["com.apple.Notes"] = CGSize(width: 1100, height: 500) // (its tile says so: the page area's floor while it's shown)
    let engine = HostEngine(system: w, marker: nil, pid: 1)
    engine.options.privateRetire = 0
    let session = HostedSession(library: library, engine: engine, links: FakeHostedLinks())
    session.sleep = { _ in await Task.yield() }
    let window = FakeHostedWindow(id: 1, number: FakeHostWorld.marginWindow)
    session.window = { id in id == nil || id == 1 ? window : nil }
    engine.onEvent = { session.hostEvent($0) }
    engine.loading = { session.loading($0) }
    engine.hostedWindow = { session.hosted($0) }
    engine.onMinimum = { session.minimum($0) } // (as ShellHostedGlue wires it)
    library.delegate = session
    func run(_ body: @escaping () async -> Void = {}) { hostRun { await body(); await session.idle() } }
    _ = library.perform("createSpace", ["windowId": 1, "name": "Home", "emoji": "🏠"])
    func windowOf(_ bundle: String) -> Int { w.running(bundleId: bundle).first.flatMap { w.apps[$0.pid]?.windows.first } ?? 0 }
    func count(_ prefix: String, since: Int = 0) -> Int { w.calls.dropFirst(since).filter { $0.hasPrefix(prefix) }.count }
    func page(_ left: CGFloat) -> CGRect { CGRect(x: left, y: 41, width: 1512 - 8 - left, height: 933) }
    run { session.openApp("com.apple.TextEdit", windowId: 1) }
    check("live resize (session): an app with no minimum shown: none told to Margin's window", window.minimums.last == .some(nil) || window.minimums.isEmpty, "\(window.minimums)")
    run { session.openApp("com.apple.Notes", windowId: 1) }
    check("live resize (session): an app with its own minimum shown: its width told to Margin's window (its page's drag stops there)", window.minimums.last == .some(1100), "\(window.minimums)")
    let edit = windowOf("com.apple.TextEdit"), notes = windowOf("com.apple.Notes")
    guard engine.shown == HostTarget.app("com.apple.Notes").id, w.tileOf(notes) != nil, w.tileOf(edit) != nil, w.bounds(window: notes) == page(260) else {
        return check("live resize (session): two apps hosted in tiles of Margin's Space", false, "\(session.done.suffix(6)) \(w.calls.suffix(10))")
    }
    let mark = w.calls.count, loadings = window.loadings.count
    session.sidebarResizing(window, true)
    var followed = true
    for left in [270.0, 285, 300, 322, 340] {
        window.layout.left = left
        session.pageRectChanged(window)
        run { await w.sleep(0.01) }
        if w.bounds(window: notes) != page(CGFloat(left)) { followed = false }
    }
    check("live resize (session): the one shown follows each page area of the drag (its tile's rect), the hole the page area meanwhile, nothing held",
          followed && session.following && window.followingPage && session.resizing == 1 && count("fullScreen", since: mark) == 0 && count("tileRect \(w.tileOf(edit) ?? 0)", since: mark) == 0,
          "\(w.calls.dropFirst(mark))")
    session.sidebarResizing(window, false)
    run()
    for _ in 0..<4 { _ = hostRun { await engine.pageRectChanged(HostPlacement(page: page(340), area: FakeHostWorld.display)) } }
    check("live resize (session): let go: Margin's page area the drag's last, the parked one sized out of sight after it, no loader, nothing in or out of full screen, the hole the window's again",
          engine.pageRect == page(340) && w.bounds(window: notes) == page(340) && w.bounds(window: edit) == page(340) && w.spaces(window: edit) == [] && window.loadings.count == loadings
          && count("fullScreen", since: mark) == 0 && !session.following && !window.followingPage && window.hosted == notes && w.listsMarginOnly, "\(w.calls.dropFirst(mark)) \(window.loadings.dropFirst(loadings))")
}

func sidebarResizeTests(script: URL) {
    let root = tempFolder("hosted-resize")
    defer { try? FileManager.default.removeItem(at: root) }
    guard let library = Library.open(dataRoot: root, script: script, background: false) else { return check("resize: the library opens", false) }
    let w = FakeHostWorld()
    let engine = HostEngine(system: w, marker: nil, pid: 1)
    engine.options.privateRetire = 0
    let session = HostedSession(library: library, engine: engine, links: FakeHostedLinks())
    session.sleep = { _ in await Task.yield() }
    let window = FakeHostedWindow(id: 1, number: FakeHostWorld.marginWindow)
    session.window = { id in id == nil || id == 1 ? window : nil }
    engine.onEvent = { session.hostEvent($0) }
    engine.loading = { session.loading($0) }
    engine.hostedWindow = { session.hosted($0) }
    library.delegate = session
    func run(_ body: @escaping () async -> Void = {}) { hostRun { await body(); await session.idle() } }
    _ = library.perform("createSpace", ["windowId": 1, "name": "Home", "emoji": "🏠"])
    func windowOf(_ bundle: String) -> Int { w.running(bundleId: bundle).first.flatMap { w.apps[$0.pid]?.windows.first } ?? 0 }
    func item(_ bundle: String) -> String { library.items().first { $0.value["url"] as? String == "app://" + bundle }?.id ?? "" }
    func count(_ prefix: String, since: Int = 0) -> Int { w.calls.dropFirst(since).filter { $0.hasPrefix(prefix) }.count }
    // The page area for a sidebar edge at `left`, as Margin's layout gives it (Arcadia's: 8 pt from the other edges).
    func page(_ left: CGFloat) -> CGRect { CGRect(x: left, y: 41, width: 1512 - 8 - left, height: 933) }
    func drag(to lefts: [Double]) { for left in lefts { window.layout.left = left; session.pageRectChanged(window); run() } }

    // Two full-screen apps: Notes shown, TextEdit parked, both placed for the page area beside a 260 pt sidebar.
    run { session.openApp("com.apple.TextEdit", windowId: 1) }
    run { session.openApp("com.apple.Notes", windowId: 1) }
    let edit = windowOf("com.apple.TextEdit"), notes = windowOf("com.apple.Notes")
    let editId = HostTarget.app("com.apple.TextEdit").id, notesId = HostTarget.app("com.apple.Notes").id
    guard engine.shown == notesId, engine.hosts[editId]?.phase == .parked, w.bounds(window: notes) == page(260) else {
        return check("resize: two full-screen apps hosted, one shown and one parked", false, "\(session.done.suffix(6))")
    }

    // ---- a drag: nothing placed while it lasts ----
    var mark = w.calls.count
    var reserves = w.reserves.count
    session.sidebarResizing(window, true)
    drag(to: [270, 285, 300, 322, 340])
    check("resize: while the edge is dragged the page area's changes are held: nothing leaves or enters full screen, nothing is moved or reserved, the engine's page area as it was",
          count("fullScreen", since: mark) == 0 && count("move", since: mark) == 0 && w.reserves.count == reserves && engine.pageRect == page(260) && w.bounds(window: notes) == page(260)
          && session.resizing == 1 && !session.done.contains { $0.hasPrefix("page area changed") }, "\(w.calls.dropFirst(mark))")
    check("resize: the hosted window stays the one shown through the drag (nothing lifted or told again: Margin's window is in front of it anyway)",
          window.hosted == notes && window.loading == nil && window.showing == nil, "\(window.hosteds)")

    // ---- let go: placed once, at the page area the drag ended on ----
    let loadingsAtDrag = window.loadings.count
    session.sidebarResizing(window, false)
    run()
    check("resize: let go over a full-screen member: placed behind the loader (loading said once, then over), its bounds read again after",
          Array(window.loadings.dropFirst(loadingsAtDrag)).count == 2 && window.loadings.last == .some(nil) && window.moves >= 1, "\(window.loadings.dropFirst(loadingsAtDrag)) \(window.moves)")
    let sent = w.reserves.dropFirst(reserves)
    check("resize: let go: the shown window placed once (one exit from full screen, one entry), at the new page area, still a member of Margin's Space",
          count("fullScreen false \(notes)", since: mark) == 1 && count("fullScreen true \(notes)", since: mark) == 1 && w.bounds(window: notes) == page(340)
          && w.spaces(window: notes) == [FakeHostWorld.marginSpace] && w.wins[notes]?.fullScreen == true && engine.shown == notesId && engine.pageRect == page(340)
          && session.done.filter { $0.hasPrefix("page area changed") }.count == 1, "\(w.calls.dropFirst(mark)) \(String(describing: w.bounds(window: notes)))")
    check("resize: its reservation is the new page area's alone (260 → 340: never the two added up), on its own Space, none on Margin's; Mission Control Margin's Space only",
          !sent.isEmpty && sent.allSatisfy { $0.edges == SlotEdges(left: 340, right: 8, top: 8, bottom: 8) && $0.space != FakeHostWorld.marginSpace }
          && (w.reservation[FakeHostWorld.marginSpace] ?? .zero).isZero && w.listsMarginOnly, "\(sent.map { "\($0.space): \($0.edges.text)" })")
    check("resize: then the hosted window shown again in Margin's window, nothing held", window.hosted == notes && session.resizing == nil, "\(window.hosteds)")
    check("resize: the parked one untouched: still full screen, out of sight, placed for the page area it had", count("fullScreen false \(edit)", since: mark) == 0 && count("fullScreen true \(edit)", since: mark) == 0
          && w.wins[edit]?.fullScreen == true && w.spaces(window: edit) == [] && engine.hosts[editId]?.placedPage == page(260), "\(String(describing: engine.hosts[editId]?.placedPage))")

    // ---- the parked one, shown next: placed once then, with the loading bar, never shown at its old place ----
    mark = w.calls.count
    reserves = w.reserves.count
    let loadings = window.loadings.count
    var seenAtOldPlace = false
    let before = engine.hostedWindow
    engine.hostedWindow = { number in if number == edit, w.bounds(window: edit) != page(340) { seenAtOldPlace = true }; before?(number) }
    run { _ = library.perform("activateTab", ["windowId": 1, "tabId": item("com.apple.TextEdit")]) }
    engine.hostedWindow = before
    check("resize: the parked one shown next: placed for the new page area as it's shown (one exit, one entry), the loading bar meanwhile, never in Margin's Space at its old place",
          engine.shown == editId && count("fullScreen false \(edit)", since: mark) == 1 && count("fullScreen true \(edit)", since: mark) == 1 && w.bounds(window: edit) == page(340)
          && !seenAtOldPlace && Array(window.loadings.dropFirst(loadings)).count == 2 && window.loadings.last == .some(nil)
          && w.reserves.dropFirst(reserves).allSatisfy { $0.edges == SlotEdges(left: 340, right: 8, top: 8, bottom: 8) }, "\(w.calls.dropFirst(mark)) \(window.loadings.dropFirst(loadings))")
    mark = w.calls.count
    run { _ = library.perform("activateTab", ["windowId": 1, "tabId": item("com.apple.Notes")]) }
    check("resize: back to the one placed by the drag: a switch, nothing placed again", engine.shown == notesId && count("fullScreen", since: mark) == 0 && w.bounds(window: notes) == page(340), "\(w.calls.dropFirst(mark))")

    // ---- a change asked just before the drag, its turn come during it: held too; a drag back to where it began: nothing placed ----
    mark = w.calls.count
    window.layout.left = 300
    session.pageRectChanged(window) // (queued, not yet run)
    session.sidebarResizing(window, true)
    run()
    drag(to: [280, 310, 340])
    check("resize: a change queued before the drag began isn't placed during it", count("fullScreen", since: mark) == 0 && engine.pageRect == page(340), "\(w.calls.dropFirst(mark))")
    session.sidebarResizing(window, false)
    run()
    check("resize: let go where it began: nothing leaves full screen", count("fullScreen", since: mark) == 0 && w.bounds(window: notes) == page(340) && window.hosted == notes, "\(w.calls.dropFirst(mark))")

    // ---- a window-mode app (one that can't go full screen): it follows the drag live, by Accessibility (one frame set in
    // flight at a time, the newest page area wins), and is checked once at the page area the drag ended on ----
    run { session.openApp("com.apple.FaceTime", windowId: 1) }
    let ft = windowOf("com.apple.FaceTime"), ftId = HostTarget.app("com.apple.FaceTime").id
    check("resize: FaceTime in window mode at the page area", engine.shown == ftId && engine.mode(of: ftId) == .window && w.bounds(window: ft) == page(340), "\(session.done.suffix(4))")
    mark = w.calls.count
    session.sidebarResizing(window, true)
    drag(to: [330, 300, 280, 250])
    let liveFrames = count("frame \(ft)", since: mark)
    check("resize (window mode): it follows the drag live by Accessibility: its frame set as the page area moves (at most once a change), at the drag's last page area, the hole its bounds (read again as it moves), never the page area around it",
          liveFrames >= 1 && liveFrames <= 4 && w.bounds(window: ft) == page(250) && session.following && !window.followingPage, "\(w.calls.dropFirst(mark))")
    let movesBefore = window.moves, loadingsBefore = window.loadings.count
    session.sidebarResizing(window, false)
    run()
    check("resize (window mode): let go: checked at the new page area (already there: nothing set again), never parked or put in full screen for it, no loader (it stays in sight); its bounds read again",
          count("frame \(ft)", since: mark) == liveFrames && w.bounds(window: ft) == page(250) && count("move \(ft)", since: mark) == 0 && count("fullScreen", since: mark) == 0
          && window.hosted == ft && window.loadings.count == loadingsBefore && window.moves == movesBefore + 1 && !session.following && !window.followingPage, "\(w.calls.dropFirst(mark)) \(window.loadings.dropFirst(loadingsBefore))")
    check("resize: both parked full-screen members still as they were (placed again only when shown)", engine.hosts[notesId]?.placedPage == page(340) && engine.hosts[editId]?.placedPage == page(340)
          && w.wins[notes]?.fullScreen == true && w.wins[edit]?.fullScreen == true)

    // ---- Margin's window taken out of full screen mid-drag: the drag is over for hosting, nothing shown or held ----
    session.sidebarResizing(window, true)
    session.leavingFullScreen(window)
    window.isFullScreen = false
    session.leftFullScreen(window)
    run()
    check("resize: Margin's window out of full screen mid-drag: nothing shown in it, not hosting", window.hosted == nil && !window.hosting, "\(window.hosteds)")
    window.isFullScreen = true
    session.sidebarResizing(window, false)
    run()
    check("resize: … and the drag over: nothing held", session.resizing == nil)

    // ---- an app that comes to be shown mid-drag (picked just before the drag): placed once when the drag ends ----
    window.layout.left = 250
    run { _ = library.perform("activateTab", ["windowId": 1, "tabId": item("com.apple.Notes")]) } // (placed for the page area as it is: 250)
    mark = w.calls.count
    session.sidebarResizing(window, true)
    drag(to: [270, 290])
    run { _ = library.perform("activateTab", ["windowId": 1, "tabId": item("com.apple.FaceTime")]) }
    drag(to: [300, 310])
    check("resize: an app shown mid-drag: Margin's window told its window, its frame held from then on", engine.shown == ftId && window.hosted == ft && w.bounds(window: ft) == page(290)
          && count("frame \(ft)", since: mark) <= 1, "\(window.hosteds) \(w.calls.dropFirst(mark))")
    session.sidebarResizing(window, false)
    run()
    check("resize: … placed once more when the drag ends, at the page area it ended on", w.bounds(window: ft) == page(310) && session.resizing == nil,
          "\(String(describing: w.bounds(window: ft)))")

    // ---- nothing shown: a drag is the page's alone ----
    run { await engine.quitAll() }
    run()
    let callsBefore = w.calls.count
    session.sidebarResizing(window, true)
    session.sidebarResizing(window, false)
    run()
    check("resize: nothing hosted: nothing placed, nothing held after", w.calls.count == callsBefore && session.resizing == nil, "\(w.calls.dropFirst(callsBefore))")
}

// The page area while hosting: Margin's own layout at its whole width (the theme's frame around it).
func hostedGeometryTests() {
    let arcadia = PageLayout(left: 260, top: 8, right: 8, bottom: 8, radius: 6, radii: [6, 6, 6, 6], width: 1512, height: 949, mode: "fullscreen")
    let display = CGRect(x: 0, y: 33, width: 1512, height: 949)
    check("hosted: the page area: Margin's whole window less the theme's insets", MarginWindowGeometry.pageRect(layout: arcadia, content: display) == CGRect(x: 260, y: 41, width: 1244, height: 933))
    check("hosted: a layout measured at another size: no page area until the page measures again", MarginWindowGeometry.pageRect(layout: arcadia, content: CGRect(x: 0, y: 33, width: 1200, height: 800)) == nil)
    check("hosted: that page area as its own Space's reservation", HostLayout.plan(HostPlacement(page: CGRect(x: 260, y: 41, width: 1244, height: 933), area: display)) == SlotEdges(left: 260, right: 8, top: 8, bottom: 8))
    check("hosted: a search's address: the engine Safari uses, as learned, else Google's", LibraryWindowSource.searchUrl("a b&c", settings: nil).hasPrefix("https://www.google.com/search?client=safari")
          && LibraryWindowSource.searchUrl("a b&c", settings: nil).contains("q=a%20b%26c")
          && LibraryWindowSource.searchUrl("x", settings: ["safariSearch": ["template": "https://duckduckgo.com/?q=%s"]]) == "https://duckduckgo.com/?q=x"
          && LibraryWindowSource.searchUrl("x", settings: ["safariSearch": ["template": "javascript:%s"]]).hasPrefix("https://www.google.com/"))
}

// The shell: the library is the windows' source, the first run's space, the engine wired to the session.
func hostedShellTests(script: URL) {
    let root = tempFolder("hosted-shell")
    defer { try? FileManager.default.removeItem(at: root) }
    var options = Shell.Options()
    options.harness = true
    options.root = script.deletingLastPathComponent()
    options.dataRoot = root
    let w = FakeHostWorld()
    options.hostSystem = w
    let shell = Shell(link: SocketLink(), apps: StubApps(), hotKeys: FakeRegistrar(), options: options)
    defer { shell.stop {} }
    check("hosted shell: the host engine made on the harness's system", shell.host != nil && shell.library != nil)
    let source = shell.makeHostedSource()
    check("hosted shell: Margin's windows draw the library", source is LibraryWindowSource && shell.hosted != nil && shell.library?.delegate === shell.hosted)
    check("hosted shell: the first run with nothing to import: one space made, for the person to name in the editor",
          shell.library?.spaces().count == 1 && shell.hosted?.firstSpace == shell.library?.spaces().first?.id)
    check("hosted shell: the engine's Safari windows are the copies'", shell.host?.requestSafariWindow != nil && shell.host?.closeSafariWindow != nil && shell.host?.safariFullScreen != nil && shell.host?.safariLinked != nil && shell.host?.loading != nil)
    check("hosted shell: Margin's window told the hosted window, and another app's window in its Space", shell.host?.hostedWindow != nil && shell.host?.others != nil)
    check("hosted shell: a palette pick goes to the session", shell.openApp != nil)
    shell.track()
    check("hosted shell: a read polls the host, nothing to come back for with nothing hosted or linked", shell.pollTimer == nil)
    // An app hosted with no browser's copy linked: the engine's own events start the shell's reads, which then go on
    // while it's hosted (the real screen, 2026-11-17: nothing had started them, the poll never ran).
    if let engine = shell.host {
        hostRun { _ = await engine.open(app: .app("com.apple.TextEdit"), in: HostPlacement(page: CGRect(x: 260, y: 8, width: 1000, height: 700), area: FakeHostWorld.display), marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
        hostRun { await w.sleep(0.05) }
        let before = engine.polls
        check("hosted shell: an app hosted and no copy linked: the shell's reads started by the engine's events, armed again while it's hosted", engine.hasHosts && shell.pollTimer != nil, "hosts \(engine.hasHosts) timer \(shell.pollTimer != nil)")
        shell.track()
        check("hosted shell: and each read polls the host", engine.polls > before && shell.pollTimer != nil, "\(before) → \(engine.polls)")
    }
}
