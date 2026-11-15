// The host engine (HostEngine.swift), part of tests.swift's run, against a stand-in for the system that plays the
// window manager as the test kit measured it (/tmp/margin-toolbar-test mc3-mc4, kit margin5): a full-screen
// window in a Space of its own with one tile, a tile moved into Margin's Space beside Margin's 260-pt one, the
// emptied Space left with no owner until destroyed, a parked tile keeping its place until its window leaves full
// screen, the reservation and the spacing laying the second tile out. Nothing real is launched, put in full screen
// or moved: the clock is the stand-in's own. Also the host's private calls' check (HostCalls.swift) against a fake
// resolver, and its wrappers refusing under MARGIN_APP_TESTS.
import AppKit
import Foundation

final class FakeHostWorld: HostSystem {
    struct App { var pid: pid_t; var bundle: String; var launchedAt: Double?; var policy: HostPolicy; var windows: [Int]; var refusesQuit = false; var sidebarOpen = false }
    struct Win { var pid: pid_t; var fullScreen = false; var spaces: [UInt64]; var priv: UInt64?; var frame: CGRect? = nil } // frame: on a Desktop (none: 100,100 800×600)

    static let marginSpace: UInt64 = 100, marginTile: UInt64 = 101, desktop: UInt64 = 1, marginWindow = 1
    static let display = CGRect(x: 0, y: 33, width: 1512, height: 949) // a full-screen Space's layout area
    static let marginWidth: CGFloat = 260

    var clock = 0.0
    var calls: [String] = []
    var fail: Set<String> = [] // launch, ax, fullScreen, exitFullScreen, moveTile, destroy, park, setCurrent
    var installed: Set<String> = ["com.apple.TextEdit", "com.apple.Notes", "com.apple.Safari"]
    var apps: [pid_t: App] = [:]
    var wins: [Int: Win] = [:]
    var tiles: [UInt64: [UInt64]] = [FakeHostWorld.marginSpace: [FakeHostWorld.marginTile]] // full-screen Spaces and their tiles
    var owner: [UInt64: pid_t] = [:] // a full-screen Space's app (none: Margin's, or emptied)
    var tileWindow: [UInt64: Int] = [FakeHostWorld.marginTile: FakeHostWorld.marginWindow]
    var current = FakeHostWorld.marginSpace
    var privates: Set<UInt64> = []
    var reservation: [UInt64: SlotEdges] = [:]
    var spacing: [UInt64: Double] = [:]
    var nextId: UInt64 = 1000, nextPid: pid_t = 500, nextWindow = 50
    var jumpOnFullScreen = true
    var exitUnparks = false // out of full screen, macOS puts a parked window on a Desktop
    var launchWindows = 1
    var sidebarOpenAtLaunch = false // Safari's windows come up with its sidebar open
    var sidebarKnown = true
    var autoShow: Bool? = true
    var dropped = 0 // the display dropped to the Desktop (a showing Space destroyed)
    var destroyedWithTiles = 0
    var freezes = 0, reveals = 0
    var lastArguments: [String] = []
    var listeners: [pid_t: (Int32) -> Void] = [:]
    var onAppQuit: ((pid_t) -> Void)?
    // Accessibility as on the real Mac: an app's windows listed (and its full screen read or set, its main window
    // read) only while they're on the current Space (verified 2026-11-15: 0 of Safari's 7 windows listed while
    // another Space was current).
    var axCurrentOnly = false
    func onCurrent(_ window: Int) -> Bool { wins[window].map { $0.priv == nil && $0.spaces.contains(current) } ?? false }

    init() { wins[Self.marginWindow] = Win(pid: 1, spaces: [Self.marginSpace]) }

    func now() -> Double { clock }
    func sleep(_ seconds: Double) async { clock += seconds; await Task.yield() }

    // ---- apps ----
    func running(bundleId: String) -> [HostApp] { apps.values.filter { $0.bundle == bundleId }.sorted { $0.pid < $1.pid }.map { HostApp(pid: $0.pid, bundleId: $0.bundle, launchedAt: $0.launchedAt) } }
    func app(pid: pid_t) -> HostApp? { apps[pid].map { HostApp(pid: $0.pid, bundleId: $0.bundle, launchedAt: $0.launchedAt) } }
    func policy(pid: pid_t) -> HostPolicy? { apps[pid]?.policy }
    @discardableResult func start(_ bundle: String, policy: HostPolicy, windows: Int) -> pid_t {
        let pid = nextPid
        nextPid += 1
        var list: [Int] = []
        for _ in 0..<windows { let n = nextWindow; nextWindow += 1; wins[n] = Win(pid: pid, spaces: [Self.desktop]); list.append(n) }
        apps[pid] = App(pid: pid, bundle: bundle, launchedAt: 1_000_000 + Double(pid), policy: policy, windows: list)
        return pid
    }
    func launchDockless(bundleId: String, arguments: [String]) -> Bool {
        calls.append("launch \(bundleId)")
        lastArguments = arguments
        guard !fail.contains("launch"), installed.contains(bundleId), running(bundleId: bundleId).isEmpty else { return false }
        let pid = start(bundleId, policy: .accessory, windows: launchWindows)
        apps[pid]?.sidebarOpen = sidebarOpenAtLaunch
        return true
    }
    func terminate(pid: pid_t) -> Bool {
        calls.append("terminate \(pid)")
        guard let a = apps[pid] else { return false }
        if a.refusesQuit { return true }
        quitNow(pid)
        return true
    }
    func quitNow(_ pid: pid_t) {
        guard let a = apps.removeValue(forKey: pid) else { return }
        for n in a.windows {
            for (space, list) in tiles { tiles[space] = list.filter { tileWindow[$0] != n } }
            wins[n] = nil
        }
        for (space, p) in owner where p == pid { tiles[space] = nil; owner[space] = nil }
        onAppQuit?(pid)
    }

    // ---- windows ----
    func windows(pid: pid_t) async -> [HostWindow]? {
        guard !fail.contains("ax"), let a = apps[pid] else { return nil }
        return a.windows.filter { !axCurrentOnly || onCurrent($0) }.compactMap { n in wins[n].map { HostWindow(number: n, fullScreen: $0.fullScreen) } }
    }
    func setFullScreen(pid: pid_t, window: Int, _ on: Bool) async -> Bool {
        calls.append("fullScreen \(on) \(window)")
        guard !axCurrentOnly || onCurrent(window) else { return false }
        return applyFullScreen(pid: pid, window: window, on)
    }
    // Full screen as macOS does it, whoever asked (Accessibility, or a Safari copy's setWindowState).
    @discardableResult func applyFullScreen(pid: pid_t, window: Int, _ on: Bool) -> Bool {
        guard var w = wins[window], w.pid == pid else { return false }
        if on {
            guard !w.fullScreen, !fail.contains("fullScreen") else { return true }
            let space = nextId, tile = nextId + 1
            nextId += 2
            tiles[space] = [tile]
            owner[space] = pid
            tileWindow[tile] = window
            w.fullScreen = true
            w.spaces = [space]
            w.priv = nil
            if jumpOnFullScreen { current = space }
        } else {
            guard w.fullScreen, !fail.contains("exitFullScreen") else { return true }
            w.fullScreen = false
            for (space, list) in tiles where list.contains(where: { tileWindow[$0] == window }) {
                tiles[space] = list.filter { tileWindow[$0] != window }
                if owner[space] == pid, tiles[space]?.isEmpty == true { tiles[space] = nil; owner[space] = nil } // macOS closes its own Space
            }
            if w.priv == nil || exitUnparks { w.priv = nil; w.spaces = [Self.desktop] }
        }
        wins[window] = w
        return true
    }
    func isFullScreen(pid: pid_t, window: Int) async -> Bool? {
        guard !axCurrentOnly || onCurrent(window) else { return nil }
        return wins[window].flatMap { $0.pid == pid ? $0.fullScreen : nil }
    }
    var main: [pid_t: Int] = [:] // the app's main window; none set: its last window
    func mainWindow(pid: pid_t) async -> Int? {
        guard let n = main[pid] ?? apps[pid]?.windows.last else { return nil }
        return !axCurrentOnly || onCurrent(n) ? n : nil
    }
    func safariSidebar(pid: pid_t) async -> HostSidebar {
        guard sidebarKnown, let a = apps[pid] else { return .unknown }
        return a.sidebarOpen ? .open : .closed
    }
    func pressSafariSidebar(pid: pid_t) async -> Bool {
        calls.append("sidebar \(pid)")
        guard apps[pid] != nil else { return false }
        apps[pid]?.sidebarOpen.toggle()
        return true
    }
    func safariAutoShowsToolbar() -> Bool? { autoShow }

    // ---- the window server ----
    var serverExtra: [ServerWindow] = [] // windows only the window server lists (a small panel, another layer)
    func serverWindows(pid: pid_t) -> [ServerWindow]? {
        guard !fail.contains("server") else { return nil }
        let own = wins.keys.sorted().compactMap { n -> ServerWindow? in
            guard let w = wins[n], w.pid == pid, let b = bounds(window: n) else { return nil }
            return ServerWindow(number: n, pid: pid, bounds: b, onScreen: onCurrent(n))
        }
        return own + serverExtra.filter { $0.pid == pid }
    }
    func spaceOf(window: Int) -> UInt64? { tiles.first { $0.value.contains { tileWindow[$0] == window } }?.key }
    func bounds(window: Int) -> CGRect? {
        guard let w = wins[window] else { return nil }
        guard w.priv == nil, let space = spaceOf(window: window), w.fullScreen || window == Self.marginWindow else { return w.frame ?? CGRect(x: 100, y: 100, width: 800, height: 600) }
        let sidebar = apps[w.pid]?.sidebarOpen == true
        let area = (sidebar ? .zero : (reservation[space] ?? .zero)).inset(Self.display)
        let list = tiles[space] ?? []
        if space == Self.marginSpace {
            if window == Self.marginWindow {
                return list.count == 1 ? CGRect(x: (Self.display.width - Self.marginWidth) / 2, y: Self.display.minY, width: Self.marginWidth, height: Self.display.height)
                    : CGRect(x: area.minX, y: area.minY, width: Self.marginWidth, height: area.height)
            }
            let x = area.minX + Self.marginWidth + CGFloat(spacing[space] ?? 12)
            return CGRect(x: x, y: area.minY, width: area.maxX - x, height: area.height)
        }
        return area
    }
    func spaces(window: Int) -> [UInt64]? { wins[window].map { $0.priv != nil ? [] : $0.spaces } }
    func spaceType(_ space: UInt64) -> Int? { tiles[space] != nil ? 4 : (space == Self.desktop ? 0 : nil) }
    func spaceExists(_ space: UInt64) -> Bool? { tiles[space] != nil || space == Self.desktop }
    func currentSpace(onDisplayOf space: UInt64) -> UInt64? { current }
    func setCurrentSpace(_ space: UInt64) -> Bool { calls.append("current \(space)"); guard !fail.contains("setCurrent") else { return false }; current = space; return true }
    func desktop(onDisplayOf space: UInt64) -> UInt64? { Self.desktop }
    func ownerlessFullScreenSpaces() -> [UInt64]? { tiles.filter { $0.key != Self.marginSpace && $0.value.isEmpty && owner[$0.key] == nil }.map(\.key).sorted() }

    // ---- tiles ----
    func tiles(of space: UInt64) -> [UInt64]? { tiles[space] }
    func moveTile(_ tile: UInt64, to space: UInt64, at index: Int) -> Bool {
        calls.append("tile \(tile) \(space)")
        guard !fail.contains("moveTile"), tiles[space] != nil, let from = tiles.first(where: { $0.value.contains(tile) })?.key else { return false }
        tiles[from] = tiles[from]?.filter { $0 != tile }
        owner[from] = nil // emptied: no owner, still listed until destroyed
        var list = tiles[space] ?? []
        list.insert(tile, at: min(index, list.count))
        tiles[space] = list
        if let n = tileWindow[tile], var w = wins[n], w.priv == nil { w.spaces = [space]; wins[n] = w }
        return true
    }
    func setTileSpacing(_ value: Double, space: UInt64) -> Bool { calls.append("spacing \(Int(value))"); spacing[space] = value; return true }
    func destroyFullScreenSpace(_ space: UInt64) -> Bool {
        calls.append("destroy \(space)")
        guard !fail.contains("destroy") else { return true }
        if current == space { dropped += 1; current = Self.desktop }
        if tiles[space]?.isEmpty == false { destroyedWithTiles += 1 }
        tiles[space] = nil
        owner[space] = nil
        return true
    }
    func reserve(_ edges: SlotEdges, space: UInt64) -> Bool { calls.append("reserve \(edges.text)"); reservation[space] = edges; return true }
    func reserved(space: UInt64) -> SlotEdges? { reservation[space] ?? .zero }

    // ---- parking ----
    func createPrivateSpace() -> UInt64? { let s = nextId; nextId += 1; privates.insert(s); return s }
    func move(window: Int, to space: UInt64) -> Bool {
        calls.append("move \(window) \(space)")
        guard var w = wins[window] else { return false }
        if privates.contains(space) {
            guard !fail.contains("park") else { return false }
            w.priv = space
        } else { w.priv = nil; w.spaces = [space] }
        wins[window] = w
        return true
    }
    func destroyPrivateSpace(_ space: UInt64) -> Bool { privates.remove(space) != nil }

    // ---- the freeze, outside opens ----
    func freeze() -> Bool { freezes += 1; return true }
    func reveal() { reveals += 1 }
    func watchOpens(pid: pid_t, _ heard: @escaping (Int32) -> Void) -> Bool { listeners[pid] = heard; return true }
    func stopWatchingOpens(pid: pid_t) { listeners[pid] = nil }
    func openFromOutside(_ pid: pid_t) {
        listeners[pid]?(HostCalls.openRequestCode)
        apps[pid]?.policy = .regular
        listeners[pid]?(HostCalls.promotedCode)
    }

    var hostedTiles: [UInt64] { (tiles[Self.marginSpace] ?? []).filter { $0 != Self.marginTile } }

    // A window closed by its app (a Safari copy's closeWindow): its tile and its own full-screen Space go with it.
    func closeWindow(_ n: Int) {
        guard let w = wins.removeValue(forKey: n) else { return }
        for (space, list) in tiles where list.contains(where: { tileWindow[$0] == n }) {
            tiles[space] = list.filter { tileWindow[$0] != n }
            if owner[space] == w.pid, tiles[space]?.isEmpty == true { tiles[space] = nil; owner[space] = nil }
        }
        apps[w.pid]?.windows.removeAll { $0 == n }
    }
}

// A Safari profile's copy as the engine asks it (HostedSession's newWindow, setWindowState, closeWindow): the windows
// it makes open on the Desktop (a normal window can't open in Margin's full-screen Space), with the copy's own ids.
final class FakeSafariCopy {
    let world: FakeHostWorld
    let pid: () -> pid_t?
    var asked: [String?] = []
    var closed: [Int] = []
    var fullScreens: [String] = [] // "<id> on|off"
    var windowOf: [Int: Int] = [:] // the copy's id → the window server's number
    var nextId = 7914
    var makesWindow = true // Safari makes the window it's asked for
    var answersFullScreen = true // the copy asks Safari (false: not linked, busy)
    var fullScreenWorks = true // Safari's window goes full screen when asked
    var closes = true // the copy closes a window when asked
    var bounds: CGRect? = CGRect(x: 100, y: 100, width: 800, height: 600) // as its `windows` list has a new window
    var windowFrame: CGRect? // where Safari opens it (none: at `bounds`)
    var extraOnRequest: [ServerWindow] = [] // other windows Safari makes at that moment (the window server lists them)
    init(_ world: FakeHostWorld, pid: @escaping () -> pid_t?) { self.world = world; self.pid = pid }
    func wire(_ e: HostEngine) {
        e.requestSafariWindow = { [unowned self] p in self.request(p) }
        e.closeSafariWindow = { [unowned self] _, id in self.close(id) }
        e.safariFullScreen = { [unowned self] _, id, on in self.fullScreen(id, on) }
    }
    func request(_ profile: String?) -> HostSafariWindow? {
        asked.append(profile)
        guard let pid = pid() else { return nil }
        let id = nextId
        nextId += 1
        world.serverExtra += extraOnRequest
        if makesWindow {
            let n = world.nextWindow
            world.nextWindow += 1
            world.wins[n] = FakeHostWorld.Win(pid: pid, spaces: [FakeHostWorld.desktop], frame: windowFrame ?? bounds)
            world.apps[pid]?.windows.append(n)
            windowOf[id] = n
        }
        return HostSafariWindow(id: id, bounds: bounds)
    }
    func close(_ id: Int) -> Bool {
        closed.append(id)
        world.calls.append("copy close \(id)")
        guard closes else { return false }
        if let n = windowOf.removeValue(forKey: id) { world.closeWindow(n) }
        return true
    }
    func fullScreen(_ id: Int, _ on: Bool) -> Bool {
        fullScreens.append("\(id) \(on ? "on" : "off")")
        guard answersFullScreen, let n = windowOf[id], let p = world.wins[n]?.pid else { return false }
        if fullScreenWorks || !on { world.applyFullScreen(pid: p, window: n, on) }
        return true
    }
    // Whether the window it made for `id` is still open.
    func isOpen(_ id: Int) -> Bool { windowOf[id].map { world.wins[$0] != nil } ?? false }
}

// The host's private calls, by name (a fake resolver: only lookups, nothing is called).
final class HostFakeResolver: PrivateResolver, @unchecked Sendable {
    var version = "27.2.1"
    var build: String? = "26B131"
    var frameworks = Set(PrivateFramework.allCases)
    var functions = Set(HostCalls.skyFunctions + HostCalls.launchFunctions + HostCalls.launchKeys + HostCalls.noteFunctions)
    var encodings = Dictionary(uniqueKeysWithValues: HostCalls.selectors.map { ($0.label, $0.encoding) })
    var hasClass = true
    func open(_ framework: PrivateFramework) -> Bool { frameworks.contains(framework) }
    func function(_ name: String, in framework: PrivateFramework) -> UnsafeRawPointer? {
        guard frameworks.contains(framework), functions.contains(name) else { return nil }
        return UnsafeRawPointer(bitPattern: 0x1000) // never called
    }
    func objcClass(_ name: String) -> AnyClass? { hasClass && name == HostCalls.destroyClass ? NSObject.self : nil }
    func responds(_ className: String, _ selector: String) -> Bool { hasClass && encodings["\(className) -\(selector)"] != nil }
    func typeEncoding(_ className: String, _ selector: String) -> String? { encodings["\(className) -\(selector)"] }
    func implementation(_ className: String, _ selector: String) -> UnsafeRawPointer? { nil }
}

final class HostBox<T> { var value: T?; var done = false }

// An async call run to its end on the main run loop (the stand-in's clock makes its waits instant).
@discardableResult func hostRun<T>(_ body: @escaping () async -> T) -> T? {
    let box = HostBox<T>()
    Task { box.value = await body(); box.done = true }
    let until = Date().addingTimeInterval(10)
    while !box.done, Date() < until { RunLoop.main.run(until: Date().addingTimeInterval(0.001)) }
    return box.value
}

func hostTests() {
    hostCallsTests()
    hostLayoutTests()
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("margin-host-tests-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    var made = 0
    func world() -> (FakeHostWorld, HostEngine, URL) {
        made += 1
        let w = FakeHostWorld()
        let url = folder.appendingPathComponent("\(made)/\(HostMarker.fileName)")
        return (w, HostEngine(system: w, marker: url, pid: 1), url)
    }
    let page = CGRect(x: 276, y: 41, width: 1228, height: 933) // 16 pt after Margin's tile, 8 pt from the other edges
    let textEdit = HostTarget.app("com.apple.TextEdit"), notes = HostTarget.app("com.apple.Notes")
    func open(_ e: HostEngine, _ t: HostTarget, _ rect: CGRect = page) -> HostResult? {
        hostRun { await e.open(app: t, in: rect, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace) }
    }
    func clean(_ w: FakeHostWorld) -> Bool { w.ownerlessFullScreenSpaces() == [] && w.dropped == 0 && w.destroyedWithTiles == 0 }

    // ---- launch → window → full screen → tile → destroy → shown ----
    do {
        let (w, e, marker) = world()
        var events: [HostEvent] = []
        e.onEvent = { events.append($0) }
        let r = open(e, textEdit)
        let pid = w.running(bundleId: "com.apple.TextEdit").first?.pid ?? 0
        let window = w.apps[pid]?.windows.first ?? 0
        check("host: an app opened and shown, fitted to the page area", r == .shown(textEdit.id, placed: true), "\(String(describing: r))")
        check("host: started with no Dock icon, never showing its own title strip", w.apps[pid]?.policy == .accessory && w.lastArguments == ["-NSMenuEnableMenuBarAgent", "NO"], "\(w.lastArguments)")
        check("host: its tile in Margin's Space beside Margin's, two tiles only", w.tiles[FakeHostWorld.marginSpace]?.count == 2 && w.tiles[FakeHostWorld.marginSpace]?.first == FakeHostWorld.marginTile)
        check("host: its window in Margin's Space only, still full screen", w.spaces(window: window) == [FakeHostWorld.marginSpace] && w.wins[window]?.fullScreen == true)
        check("host: its emptied Space destroyed, nothing ownerless, the display never dropped to the Desktop", clean(w) && w.tiles.count == 1, "\(w.tiles)")
        check("host: macOS's jump to its new Space undone, Margin's showing", w.current == FakeHostWorld.marginSpace && w.calls.contains("current \(FakeHostWorld.marginSpace)"))
        check("host: Margin's Space made current before the destroy", (w.calls.firstIndex(of: "current \(FakeHostWorld.marginSpace)") ?? 99) < (w.calls.firstIndex { $0.hasPrefix("destroy") } ?? -1))
        check("host: its window at the page area (edges and spacing reserved)", w.bounds(window: window) == page && w.reservation[FakeHostWorld.marginSpace] == SlotEdges(left: 0, right: 8, top: 8, bottom: 8) && w.spacing[FakeHostWorld.marginSpace] == 16,
              "\(String(describing: w.bounds(window: window))) \(String(describing: w.reservation))")
        check("host: under one freeze, revealed", w.freezes == 1 && w.reveals == 1)
        check("host: opened, then shown", events.count == 2 && { if case .opened = events[0], case .shown = events[1] { return true }; return false }(), "\(events)")
        let m = HostMarker.read(marker)
        check("host: the marker lists the app Margin started and the window it hosts", m?.apps.map(\.pid) == [pid] && m?.windows.map(\.number) == [window] && m?.marginSpace == FakeHostWorld.marginSpace, "\(String(describing: m))")
        check("host: the same target again: shown, nothing launched twice", open(e, textEdit) == .shown(textEdit.id, placed: true) && w.calls.filter { $0.hasPrefix("launch") }.count == 1)
        check("host: no window was moved but by its tile (no Accessibility move or resize exists in the seam)", !w.calls.contains { $0.hasPrefix("move \(window)") })

        // the page area changes
        let page2 = CGRect(x: 272, y: 61, width: 1220, height: 900)
        check("host: a new page area taken", hostRun { await e.pageRectChanged(page2) } == true && w.bounds(window: window) == page2 && w.spacing[FakeHostWorld.marginSpace] == 12)

        // ---- outside open, promotion ----
        w.openFromOutside(pid)
        check("host: an open from outside heard, and the promotion to a Dock app", events.contains(.outsideOpen(textEdit.id)) && events.contains(.promoted(textEdit.id)) && e.hosts[textEdit.id] != nil)
        e.poll()
        check("host: promoted once (the policy's read doesn't say it again)", events.filter { $0 == .promoted(textEdit.id) }.count == 1)

        // ---- close: out of full screen while tiled, then quit ----
        hostRun { await e.close(textEdit.id) }
        let exit = w.calls.firstIndex(of: "fullScreen false \(window)") ?? 99, quit = w.calls.firstIndex(of: "terminate \(pid)") ?? -1
        check("host: closing the one shown: out of full screen first, then quit", exit < quit && w.apps[pid] == nil, "\(w.calls)")
        check("host: closed: Margin's Space back to its own tile, nothing left, the marker gone",
              w.tiles[FakeHostWorld.marginSpace] == [FakeHostWorld.marginTile] && clean(w) && !FileManager.default.fileExists(atPath: marker.path) && e.hosts.isEmpty && e.shown == nil)
    }

    // ---- refused before anything is touched ----
    do {
        let (w, e, _) = world()
        let pid = w.start("com.apple.TextEdit", policy: .regular, windows: 1)
        let r = open(e, textEdit)
        check("host: an app already running, not started by Margin: refused, never touched", { if case .failed(.launch, _) = r { return true }; return false }() && !w.calls.contains { $0.hasPrefix("fullScreen") } && w.apps[pid] != nil, "\(String(describing: r))")
    }
    do {
        let (w, e, _) = world()
        let r = hostRun { await e.open(app: textEdit, in: page, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.desktop) }
        check("host: Margin's window not in a full-screen Space: refused, nothing started", { if case .failed(.margin, _)? = r { return true }; return false }() && w.apps.isEmpty)
    }

    // ---- a failure at each step falls back, leaving nothing ----
    for (what, step) in [("launch", HostStep.launch), ("ax", .window), ("fullScreen", .fullScreen), ("moveTile", .tile)] {
        let (w, e, marker) = world()
        w.fail = [what]
        let r = open(e, textEdit)
        let ok: Bool = { if case .failed(step, _)? = r { return true }; return false }()
        check("host: \(what) fails: \(step.rawValue) failed", ok, "\(String(describing: r))")
        check("host: \(what) fails: the app Margin started quit again, out of full screen first, nothing left", w.apps.isEmpty && clean(w) && w.tiles.count == 1 && w.privates.isEmpty && e.hosts.isEmpty && e.launched.isEmpty,
              "\(w.tiles) \(w.apps.keys) \(w.calls)")
        check("host: \(what) fails: the marker gone, the screen revealed", !FileManager.default.fileExists(atPath: marker.path) && w.freezes == w.reveals && w.current == FakeHostWorld.marginSpace)
    }
    do {
        let (w, e, _) = world()
        w.launchWindows = 0
        let r = open(e, textEdit)
        check("host: no window: failed, the app quit again", { if case .failed(.window, _)? = r { return true }; return false }() && w.apps.isEmpty)
    }
    do {
        let (w, e, marker) = world()
        w.fail = ["destroy"]
        var events: [HostEvent] = []
        e.onEvent = { events.append($0) }
        let r = open(e, textEdit)
        let left = w.ownerlessFullScreenSpaces() ?? []
        check("host: the destroy doesn't take: still shown, the emptied Space kept to try again", r == .shown(textEdit.id, placed: true) && left.count == 1 && e.leftSpaces == Set(left)
              && events.contains { if case .failed(_, .destroy, _) = $0 { return true }; return false } && HostMarker.read(marker)?.leftSpaces == left)
        w.fail = []
        e.poll()
        _ = hostRun { await e.pageRectChanged(page) } // the next operation, after the poll's retry
        check("host: the emptied Space destroyed on a later poll", clean(w) && e.leftSpaces.isEmpty, "\(String(describing: w.ownerlessFullScreenSpaces()))")
    }
    do {
        let (w, e, _) = world()
        var events: [HostEvent] = []
        e.onEvent = { events.append($0) }
        let r = open(e, textEdit, CGRect(x: 100, y: 41, width: 1300, height: 900))
        check("host: a page area that starts under Margin's tile: shown, not fitted, said, nothing reserved", r == .shown(textEdit.id, placed: false)
              && events.contains { if case .failed(_, .place, _) = $0 { return true }; return false } && w.reservation.isEmpty)
    }

    // ---- switching between two apps parks the first ----
    do {
        let (w, e, _) = world()
        _ = open(e, textEdit)
        let a = w.running(bundleId: "com.apple.TextEdit")[0].pid, aw = w.apps[a]!.windows[0]
        w.calls = []
        let r = open(e, notes)
        let b = w.running(bundleId: "com.apple.Notes")[0].pid, bw = w.apps[b]!.windows[0]
        check("host: a second app shown", r == .shown(notes.id, placed: true) && e.shown == notes.id)
        check("host: the first parked: in a private Space, out of full screen, its tile gone", w.wins[aw]?.priv != nil && w.wins[aw]?.fullScreen == false && e.hosts[textEdit.id]?.phase == .parked)
        check("host: Margin's Space keeps two tiles: Margin's and the second app's", w.tiles[FakeHostWorld.marginSpace]?.count == 2 && w.hostedTiles.count == 1 && w.spaces(window: bw) == [FakeHostWorld.marginSpace])
        let bFull = w.calls.firstIndex(of: "fullScreen true \(bw)") ?? 99, aPark = w.calls.firstIndex { $0.hasPrefix("move \(aw) ") } ?? -1
        check("host: the second one's full screen made before the first is parked (the first stays shown meanwhile)", bFull < aPark, "\(w.calls)")
        check("host: nothing ownerless after the switch", clean(w) && w.bounds(window: bw) == page)
        w.calls = []
        let back = hostRun { await e.show(textEdit.id) }
        check("host: shown again: the first back, fitted; the second parked", back == .shown(textEdit.id, placed: true) && w.spaces(window: aw) == [FakeHostWorld.marginSpace] && w.wins[bw]?.priv != nil && e.hosts[notes.id]?.phase == .parked)
        check("host: its private Space given back once shown; one left (the second's)", w.privates.count == 1 && w.privates.first == w.wins[bw]?.priv)
        check("host: unparked to the Desktop, then full screen, under the freeze", (w.calls.firstIndex(of: "move \(aw) \(FakeHostWorld.desktop)") ?? 99) < (w.calls.firstIndex(of: "fullScreen true \(aw)") ?? -1) && w.freezes == w.reveals && clean(w))
        // macOS putting a window it took out of full screen on a Desktop: parked again
        w.exitUnparks = true
        _ = hostRun { await e.show(notes.id) }
        check("host: a window macOS put back on a Desktop after leaving full screen: parked again", w.wins[aw]?.priv != nil && w.spaces(window: aw) == [])

        // ---- quit: every app out of full screen and quit, the marker gone ----
        w.calls = []
        hostRun { await e.quitAll() }
        let bExit = w.calls.firstIndex(of: "fullScreen false \(bw)") ?? 99, bQuit = w.calls.firstIndex(of: "terminate \(b)") ?? -1
        check("host: quit: the one shown out of full screen before it's quit", bExit < bQuit, "\(w.calls)")
        check("host: quit: both apps quit, no private Space, Margin's Space as it was, nothing left", w.apps.isEmpty && w.privates.isEmpty && w.tiles[FakeHostWorld.marginSpace] == [FakeHostWorld.marginTile] && clean(w) && w.reservation[FakeHostWorld.marginSpace] == .zero && !e.hasHosts)
    }
    do {
        let (w, e, _) = world()
        _ = open(e, textEdit)
        let aw = w.apps[w.running(bundleId: "com.apple.TextEdit")[0].pid]!.windows[0]
        w.fail = ["park"]
        let r = open(e, notes)
        check("host: the first can't be parked: the second fails and is closed, the first still shown", { if case .failed(.park, _)? = r { return true }; return false }()
              && e.shown == textEdit.id && w.spaces(window: aw) == [FakeHostWorld.marginSpace] && w.running(bundleId: "com.apple.Notes").isEmpty && clean(w) && w.hostedTiles.count == 1, "\(String(describing: r)) \(w.tiles)")
    }
    do {
        let (w, e, _) = world()
        _ = open(e, textEdit)
        let aw = w.apps[w.running(bundleId: "com.apple.TextEdit")[0].pid]!.windows[0]
        w.fail = ["moveTile"]
        let r = open(e, notes)
        check("host: the second's tile doesn't move: failed, nothing of it left", { if case .failed(.tile, _)? = r { return true }; return false }() && w.running(bundleId: "com.apple.Notes").isEmpty)
        w.fail = []
        check("host: … and the first, parked meanwhile, is tried again", e.shown == textEdit.id || e.hosts[textEdit.id]?.phase == .parked)
        _ = hostRun { await e.show(textEdit.id) }
        check("host: … and shown again", e.shown == textEdit.id && w.spaces(window: aw) == [FakeHostWorld.marginSpace] && clean(w))
    }
    do {
        let (w, e, _) = world()
        _ = open(e, textEdit)
        let pid = w.running(bundleId: "com.apple.TextEdit")[0].pid
        w.apps[pid]?.refusesQuit = true
        var events: [HostEvent] = []
        e.onEvent = { events.append($0) }
        hostRun { await e.close(textEdit.id) }
        check("host: an app that doesn't quit (asking about its work): said, left running, out of full screen", w.apps[pid] != nil && w.wins[w.apps[pid]!.windows[0]]?.fullScreen == false
              && events.contains { if case .failed(_, .quit, _) = $0 { return true }; return false } && clean(w))
    }

    // ---- quit by the person, a window closed ----
    do {
        let (w, e, marker) = world()
        var events: [HostEvent] = []
        e.onEvent = { events.append($0) }
        _ = open(e, textEdit)
        w.quitNow(w.running(bundleId: "com.apple.TextEdit")[0].pid)
        check("host: the app quit by the person: said, forgotten, the marker gone", events.contains(.quitByUser(textEdit.id)) && e.hosts.isEmpty && e.shown == nil && !FileManager.default.fileExists(atPath: marker.path))
        _ = open(e, notes)
        let pid = w.running(bundleId: "com.apple.Notes")[0].pid, n = w.apps[pid]!.windows[0]
        w.wins[n] = nil
        w.tiles[FakeHostWorld.marginSpace] = [FakeHostWorld.marginTile]
        e.poll()
        check("host: its window's bounds unread once: kept (a read can miss mid-transition)", e.hosts[notes.id] != nil && !events.contains(.windowClosed(notes.id)))
        e.poll()
        check("host: its window closed: said, forgotten", events.contains(.windowClosed(notes.id)) && e.hosts.isEmpty)
    }

    // ---- the crash marker, read at the next launch ----
    do {
        let (w, e, marker) = world()
        _ = open(e, textEdit)
        _ = open(e, notes)
        let a = w.running(bundleId: "com.apple.TextEdit")[0].pid, b = w.running(bundleId: "com.apple.Notes")[0].pid
        let bw = w.apps[b]!.windows[0]
        let other = w.start("com.apple.Safari", policy: .regular, windows: 1) // not Margin's: never touched
        // Margin crashes (no quit); the next one reads the marker.
        w.onAppQuit = nil
        w.calls = []
        let next = HostEngine(system: w, marker: marker, pid: 2)
        hostRun { await next.recover() }
        let exit = w.calls.firstIndex(of: "fullScreen false \(bw)") ?? 99, quit = w.calls.firstIndex(of: "terminate \(b)") ?? -1
        check("host: recovery: the shown app out of full screen before it's quit", exit < quit, "\(w.calls)")
        check("host: recovery: both apps quit, their private Spaces given back, the marker gone", w.apps[a] == nil && w.apps[b] == nil && w.privates.isEmpty && !FileManager.default.fileExists(atPath: marker.path))
        check("host: recovery: an app Margin didn't start is left alone", w.apps[other] != nil && !w.calls.contains("terminate \(other)"))
    }
    do {
        let (w, _, marker) = world()
        let pid = w.start("com.apple.TextEdit", policy: .regular, windows: 1)
        var m = HostMarker(pid: 1, marginSpace: nil)
        m.apps = [HostMarker.App(pid: pid, bundleId: "com.apple.TextEdit", launchedAt: 5)] // launched at another time: its pid used again
        _ = m.write(marker)
        let next = HostEngine(system: w, marker: marker, pid: 2)
        hostRun { await next.recover() }
        check("host: recovery: a pid used again by another launch isn't quit", w.apps[pid] != nil && !w.calls.contains("terminate \(pid)"))
    }
    do {
        let (w, _, marker) = world()
        let space: UInt64 = 777
        w.tiles[space] = []
        var m = HostMarker(pid: 1, marginSpace: nil)
        m.leftSpaces = [space]
        _ = m.write(marker)
        let next = HostEngine(system: w, marker: marker, pid: 2)
        hostRun { await next.recover() }
        check("host: recovery: an emptied Space it left destroyed", w.tiles[space] == nil && w.dropped == 0)
    }

    // ---- Safari ----
    do {
        let (w, e, _) = world()
        let safari = HostTarget.safariWindow(nil)
        let r = open(e, safari)
        let started = w.running(bundleId: "com.apple.Safari").first?.pid ?? 0
        check("host: Safari not running: started with no Dock icon and its full-screen toolbar hidden", r == .shown(safari.id, placed: true)
              && w.lastArguments == ["-NSMenuEnableMenuBarAgent", "NO", "-AutoShowToolbarInFullScreen", "YES"] && w.apps[started]?.policy == .accessory, "\(String(describing: r))")
        hostRun { await e.quitAll() }
        check("host: Safari Margin started: quit at quit", w.apps[started] == nil && clean(w))
    }
    do {
        let (w, e, _) = world()
        w.sidebarOpenAtLaunch = true
        let r = open(e, .safariWindow(nil))
        let p = w.running(bundleId: "com.apple.Safari").first?.pid ?? 0
        check("host: Safari's sidebar open: hidden by its View menu, the window fits", r == .shown(HostTarget.safariWindow(nil).id, placed: true) && w.apps[p]?.sidebarOpen == false
              && w.calls.filter { $0.hasPrefix("sidebar") }.count == 1, "\(String(describing: r)) \(w.calls)")
    }
    do {
        let (w, e, _) = world()
        w.sidebarOpenAtLaunch = true
        w.sidebarKnown = false
        let r = open(e, .safariWindow(nil))
        check("host: Safari's sidebar state unread and the window doesn't fit: pressed once, then it fits", r == .shown(HostTarget.safariWindow(nil).id, placed: true)
              && w.calls.filter { $0.hasPrefix("sidebar") }.count == 1, "\(String(describing: r)) \(w.calls)")
    }
    do {
        let (w, e, _) = world()
        w.sidebarKnown = false
        _ = open(e, textEdit)
        check("host: a window that fits: no sidebar pressed for an app that isn't Safari", !w.calls.contains { $0.hasPrefix("sidebar") })
    }
    do {
        let (w, e, markerURL) = world()
        let safariPid = w.start("com.apple.Safari", policy: .regular, windows: 2) // opened the normal way, with the person's windows
        w.apps[safariPid]?.sidebarOpen = true
        w.autoShow = false
        w.axCurrentOnly = true // Accessibility lists only the current Space's windows (Margin's is current)
        let theirs = w.apps[safariPid]!.windows
        let copy = FakeSafariCopy(w) { safariPid }
        copy.wire(e)
        // Safari also makes a small panel and a window on another layer as it opens one (only the window server lists them).
        copy.extraOnRequest = [ServerWindow(number: 4001, pid: safariPid, bounds: CGRect(x: 0, y: 0, width: 120, height: 40)),
                               ServerWindow(number: 4002, pid: safariPid, layer: 8, bounds: CGRect(x: 0, y: 0, width: 900, height: 700))]
        var lines: [String] = []
        let echo = Diagnostics.echo
        Diagnostics.echo = { lines.append($0) }
        let target = HostTarget.safariWindow("Work")
        let axBefore = hostRun { await w.windows(pid: safariPid) }
        let r = open(e, target)
        Diagnostics.echo = echo
        let mine = e.hosts[target.id]?.window ?? 0
        let ext = e.hosts[target.id]?.safariWindow ?? 0
        check("host: Safari's windows on a Desktop while Margin's Space is current: Accessibility lists none (as on the real Mac)", axBefore == [], "\(String(describing: axBefore))")
        check("host: Safari already open: a window of Margin's own asked of its extension, for the profile", r == .shown(target.id, placed: true) && copy.asked == ["Work"] && !theirs.contains(mine) && e.hosts[target.id]?.madeByMargin == true,
              "\(String(describing: r)) \(w.calls)")
        check("host: the new Safari window found by the window server, not Accessibility (the copy's window, not its panel or another layer's)", mine == copy.windowOf[ext] && mine != 4001 && mine != 4002 && ext == 7914)
        check("host: put in full screen by its copy (setWindowState), never through Accessibility", copy.fullScreens == ["7914 on"] && !w.calls.contains("fullScreen true \(mine)") && w.wins[mine]?.fullScreen == true, "\(copy.fullScreens) \(w.calls)")
        check("host: Safari already open: never restarted, its windows untouched", !w.calls.contains { $0.hasPrefix("launch") || $0.hasPrefix("terminate") } && theirs.allSatisfy { w.wins[$0]?.fullScreen == false && w.spaces(window: $0) == [FakeHostWorld.desktop] })
        check("host: Safari's main window unread in its own Space: read again once its tile is in Margin's Space, then its sidebar hidden",
              w.apps[safariPid]?.sidebarOpen == false && w.calls.filter { $0.hasPrefix("sidebar") }.count == 1 && lines.contains { $0.contains("read again once its tile is in Margin's Space") })
        check("host: Safari's AutoShowToolbarInFullScreen off: said as a known gap, its setting not changed", lines.contains { $0.contains("AutoShowToolbarInFullScreen is off") } && w.autoShow == false)
        check("host: the profile's name is never in the log", !lines.contains { $0.contains("Work") } && target.id.description.hasPrefix("safari:p"))
        let m = HostMarker.read(markerURL)
        check("host: the marker has the copy's id for the window, its profile and Safari's launch", m?.windows.first?.safariWindow == ext && m?.windows.first?.profile == "Work" && m?.windows.first?.appLaunchedAt == w.apps[safariPid]?.launchedAt, "\(String(describing: m))")

        // ---- parked (another app shown) and shown again: out of full screen and back by its copy ----
        w.axCurrentOnly = false // (an app Margin starts: its window is found and put in full screen by Accessibility, as on the real Mac)
        _ = open(e, textEdit)
        check("host: Margin's Safari window parked by its copy (normal in its private Space), not Accessibility", copy.fullScreens == ["7914 on", "7914 off"] && e.hosts[target.id]?.phase == .parked
              && w.wins[mine]?.priv != nil && w.wins[mine]?.fullScreen == false && !w.calls.contains("fullScreen false \(mine)"), "\(copy.fullScreens)")
        let back = hostRun { await e.show(target.id) }
        check("host: shown again: full screen by its copy again, fitted", back == .shown(target.id, placed: true) && copy.fullScreens.last == "7914 on" && w.spaces(window: mine) == [FakeHostWorld.marginSpace] && clean(w), "\(String(describing: back))")
        hostRun { await e.quitAll() }
        check("host: quit: Margin's Safari window out of full screen and closed by its copy, Safari left running", copy.closed == [ext] && w.wins[mine] == nil && w.apps[safariPid] != nil && clean(w) && e.leftSafariWindows.isEmpty)
    }
    do {
        let (w, e, _) = world()
        let safariPid = w.start("com.apple.Safari", policy: .regular, windows: 1)
        w.apps[safariPid]?.sidebarOpen = true
        w.main[safariPid] = w.apps[safariPid]!.windows[0] // the person's own window stays Safari's main one
        let copy = FakeSafariCopy(w) { safariPid }
        copy.wire(e)
        let r = open(e, .safariWindow(nil))
        check("host: Margin's Safari window not Safari's main one: its View menu never pressed (it would act on the person's window)",
              !w.calls.contains { $0.hasPrefix("sidebar") } && { if case .shown(_, placed: false)? = r { return true }; return false }(), "\(String(describing: r))")
    }
    do {
        let (w, e, _) = world()
        let safariPid = w.start("com.apple.Safari", policy: .regular, windows: 1)
        w.apps[safariPid]?.sidebarOpen = true
        w.axCurrentOnly = true
        w.main[safariPid] = 9999 // Safari's main window on another Space: never readable
        let copy = FakeSafariCopy(w) { safariPid }
        copy.wire(e)
        var lines: [String] = []
        let echo = Diagnostics.echo
        Diagnostics.echo = { lines.append($0) }
        _ = open(e, .safariWindow(nil))
        Diagnostics.echo = echo
        check("host: Safari's main window never reads: its sidebar left as it is, said, never pressed blindly",
              !w.calls.contains { $0.hasPrefix("sidebar") } && lines.contains { $0.contains("still doesn't read") }, "\(lines.filter { $0.contains("sidebar") })")
    }
    do {
        let (w, e, _) = world()
        let safariPid = w.start("com.apple.Safari", policy: .regular, windows: 1)
        let copy = FakeSafariCopy(w) { safariPid }
        copy.wire(e)
        copy.bounds = CGRect(x: 300, y: 200, width: 900, height: 700)
        // Two new windows at once (another of the person's opened meanwhile): the one at the copy's bounds is Margin's.
        copy.extraOnRequest = [ServerWindow(number: 4100, pid: safariPid, bounds: CGRect(x: 100, y: 100, width: 800, height: 600))]
        let r = open(e, .safariWindow(nil))
        let picked = e.hosts[HostTarget.safariWindow(nil).id]?.window
        check("host: two new Safari windows: the one at the copy's bounds taken", r == .shown(HostTarget.safariWindow(nil).id, placed: true) && picked == copy.windowOf[7914] && picked != 4100, "\(String(describing: r))")
    }
    do {
        let (w, e, _) = world()
        let safariPid = w.start("com.apple.Safari", policy: .regular, windows: 1)
        let copy = FakeSafariCopy(w) { safariPid }
        copy.wire(e)
        copy.windowFrame = CGRect(x: 500, y: 500, width: 800, height: 600) // (not where the copy said)
        copy.bounds = CGRect(x: 300, y: 200, width: 900, height: 700)
        copy.extraOnRequest = [ServerWindow(number: 4100, pid: safariPid, bounds: CGRect(x: 100, y: 100, width: 800, height: 600))]
        let r = open(e, .safariWindow(nil))
        check("host: two new Safari windows, neither at the copy's bounds: neither taken, the one asked for closed by its copy",
              { if case .failed(.window, _)? = r { return true }; return false }() && copy.closed == [7914] && !copy.isOpen(7914) && w.serverWindows(pid: safariPid)?.contains { $0.number == 4100 } == true, "\(String(describing: r))")
    }

    // ---- every failure after a Safari window was asked for closes it ----
    for (what, step) in [("no window", HostStep.window), ("copy refuses full screen", .fullScreen), ("full screen never comes", .fullScreen),
                         ("moveTile", .tile), ("park", .park), ("Margin started Safari, moveTile", .tile)] {
        let (w, e, markerURL) = world()
        let startsSafari = what.hasPrefix("Margin started")
        var safariPid: pid_t = 0
        if !startsSafari { safariPid = w.start("com.apple.Safari", policy: .regular, windows: 1) }
        let copy = FakeSafariCopy(w) { w.running(bundleId: "com.apple.Safari").first?.pid }
        copy.wire(e)
        if what == "park" { _ = open(e, textEdit) }
        w.axCurrentOnly = true
        switch what {
        case "no window": copy.makesWindow = false
        case "copy refuses full screen": copy.answersFullScreen = false
        case "full screen never comes": copy.fullScreenWorks = false
        case "park": w.fail = ["park"]
        default: w.fail = ["moveTile"]
        }
        w.calls = []
        let r = open(e, .safariWindow("Work"))
        w.fail = []
        let ok: Bool = { if case .failed(step, _)? = r { return true }; return false }()
        check("host: Safari, \(what): \(step.rawValue) failed", ok, "\(String(describing: r)) \(w.calls)")
        check("host: Safari, \(what): the window Margin asked for closed by its copy, nothing of it left", copy.closed == [7914] && !copy.isOpen(7914) && e.hosts[HostTarget.safariWindow("Work").id] == nil
              && e.leftSafariWindows.isEmpty && clean(w) && w.privates.isEmpty && w.freezes == w.reveals, "\(copy.closed) \(w.tiles) \(e.leftSafariWindows)")
        if startsSafari {
            let close = w.calls.firstIndex(of: "copy close 7914") ?? 99, quit = w.calls.firstIndex { $0.hasPrefix("terminate") } ?? -1
            check("host: Safari, \(what): closed by its copy before the Safari Margin started is quit", close < quit && w.running(bundleId: "com.apple.Safari").isEmpty, "\(w.calls)")
            check("host: Safari, \(what): the marker gone", !FileManager.default.fileExists(atPath: markerURL.path))
        } else if what == "park" {
            check("host: Safari, park: the app shown before still shown", e.shown == textEdit.id && w.apps[safariPid] != nil)
        } else {
            check("host: Safari, \(what): Safari left running, the person's window untouched, the marker gone", w.apps[safariPid]?.windows.count == 1 && !FileManager.default.fileExists(atPath: markerURL.path))
        }
    }
    do {
        let (w, e, markerURL) = world()
        let safariPid = w.start("com.apple.Safari", policy: .regular, windows: 1)
        let copy = FakeSafariCopy(w) { safariPid }
        copy.wire(e)
        copy.closes = false // its copy gone quiet
        w.fail = ["moveTile"]
        let r = open(e, .safariWindow("Work"))
        w.fail = []
        let left = e.leftSafariWindows.first
        check("host: a failed open whose close isn't confirmed: kept to close later, in the marker", { if case .failed(.tile, _)? = r { return true }; return false }() && copy.isOpen(7914)
              && left?.safariWindow == 7914 && left?.profile == "Work" && left?.number == copy.windowOf[7914] && HostMarker.read(markerURL)?.leftSafariWindows == [left!], "\(String(describing: left))")
        check("host: … out of full screen and on the Desktop meanwhile, in no full-screen Space", w.wins[copy.windowOf[7914] ?? 0]?.fullScreen == false && clean(w))
        copy.closes = true
        e.poll()
        _ = hostRun { await e.pageRectChanged(page) } // the next operation, after the poll's try
        check("host: … closed by its copy on a later poll, the marker gone", !copy.isOpen(7914) && e.leftSafariWindows.isEmpty && !FileManager.default.fileExists(atPath: markerURL.path))
    }
    do {
        // Margin crashed while Margin's Safari window was shown: the next launch closes it by its copy.
        let (w, e, markerURL) = world()
        let safariPid = w.start("com.apple.Safari", policy: .regular, windows: 1)
        let copy = FakeSafariCopy(w) { safariPid }
        copy.wire(e)
        _ = open(e, .safariWindow("Work"))
        let mine = copy.windowOf[7914] ?? 0
        w.onAppQuit = nil
        let next = HostEngine(system: w, marker: markerURL, pid: 2)
        let later = FakeSafariCopy(w) { safariPid }
        later.windowOf = copy.windowOf
        later.closes = false // its copy not linked yet at launch
        later.wire(next)
        hostRun { await next.recover() }
        check("host: recovery: Margin's Safari window kept to close (its copy not linked yet), in the marker", next.leftSafariWindows.map(\.safariWindow) == [7914] && w.apps[safariPid] != nil
              && HostMarker.read(markerURL)?.leftSafariWindows?.first?.number == mine, "\(next.leftSafariWindows)")
        later.closes = true
        next.poll()
        _ = hostRun { await next.recover() } // (the next operation, after the poll's try)
        check("host: recovery: closed by its copy once it links, the marker gone, Safari left running", w.wins[mine] == nil && next.leftSafariWindows.isEmpty && !FileManager.default.fileExists(atPath: markerURL.path) && w.apps[safariPid] != nil && clean(w),
              "\(next.leftSafariWindows) \(w.tiles)")
    }
    do {
        // Safari restarted since (its pid used again): a window of that number is never closed for Margin's.
        let (w, _, markerURL) = world()
        let safariPid = w.start("com.apple.Safari", policy: .regular, windows: 1)
        var m = HostMarker(pid: 1, marginSpace: nil)
        m.leftSafariWindows = [HostMarker.SafariWindow(safariWindow: 3, profile: nil, pid: safariPid, appLaunchedAt: 5, number: w.apps[safariPid]!.windows[0])]
        _ = m.write(markerURL)
        let next = HostEngine(system: w, marker: markerURL, pid: 2)
        let copy = FakeSafariCopy(w) { safariPid }
        copy.wire(next)
        hostRun { await next.recover() }
        check("host: recovery: a Safari window of another Safari launch: forgotten, never closed", copy.closed.isEmpty && next.leftSafariWindows.isEmpty && !FileManager.default.fileExists(atPath: markerURL.path))
    }
    do {
        let (w, e, _) = world()
        let safariPid = w.start("com.apple.Safari", policy: .regular, windows: 1)
        let r = open(e, .safariWindow(nil))
        check("host: Safari already open and no link to ask for a window: failed, Safari untouched", { if case .failed(.window, _)? = r { return true }; return false }() && w.apps[safariPid] != nil && !w.calls.contains { $0.hasPrefix("fullScreen") })
    }

    // ---- one at a time ----
    do {
        let (w, e, _) = world()
        let both = hostRun { () async -> [HostResult] in
            async let one = e.open(app: textEdit, in: page, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace)
            async let two = e.open(app: notes, in: page, marginWindow: FakeHostWorld.marginWindow, marginSpace: FakeHostWorld.marginSpace)
            return await [one, two]
        }
        check("host: two opens at once run one after the other: both shown in turn, two tiles", both?.allSatisfy { if case .shown = $0 { return true }; return false } == true && w.tiles[FakeHostWorld.marginSpace]?.count == 2 && clean(w), "\(String(describing: both))")
    }
}

func hostLayoutTests() {
    let margin = CGRect(x: 0, y: 33, width: 260, height: 949), hosted = CGRect(x: 272, y: 33, width: 1240, height: 949)
    let plan = HostLayout.plan(margin: margin, hosted: hosted, reserved: .zero, page: CGRect(x: 280, y: 41, width: 1224, height: 933))
    check("host layout: the page area's edges and the spacing from the tiles now", plan?.edges == SlotEdges(left: 0, right: 8, top: 8, bottom: 8) && plan?.spacing == 20, "\(String(describing: plan))")
    let again = HostLayout.plan(margin: CGRect(x: 0, y: 41, width: 260, height: 933), hosted: CGRect(x: 280, y: 41, width: 1224, height: 933),
                                reserved: SlotEdges(left: 0, right: 8, top: 8, bottom: 8), page: CGRect(x: 272, y: 33, width: 1240, height: 949))
    check("host layout: from a reservation already set, back to none", again?.edges == .zero && again?.spacing == 12, "\(String(describing: again))")
    check("host layout: a page area under Margin's tile can't be reached", HostLayout.plan(margin: margin, hosted: hosted, reserved: .zero, page: CGRect(x: 200, y: 41, width: 1300, height: 900)) == nil)
    check("host layout: a page area past the display can't be reached", HostLayout.plan(margin: margin, hosted: hosted, reserved: .zero, page: CGRect(x: 280, y: 20, width: 1224, height: 900)) == nil)
    check("host ids: an app by its bundle id, Safari's default profile by name, another profile never", HostTarget.app("com.apple.Notes").id.description == "app:com.apple.Notes" && HostTarget.safariWindow(nil).id.description == "safari:default"
          && !HostTarget.safariWindow("Personal").id.description.contains("Personal") && HostTarget.safariWindow("A").id != HostTarget.safariWindow("B").id)
    var m = HostMarker(pid: 3, marginSpace: 9)
    m.apps = [HostMarker.App(pid: 4, bundleId: "x", launchedAt: 1.5)]
    m.windows = [HostMarker.Window(number: 5, pid: 4, ownSafariWindow: false, privateSpace: 6, fullScreenSpace: nil)]
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("margin-host-marker-\(UUID().uuidString)/\(HostMarker.fileName)")
    check("host marker: written and read back", m.write(url) && HostMarker.read(url) == m)
    try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
}

func hostCallsTests() {
    let base = PrivateCalls.evaluate(FakePrivateResolver())
    let all = HostCalls.evaluate(HostFakeResolver(), base: base)
    check("host calls: all there: the host and outside opens on", all.host && all.opens && all.missing.isEmpty && all.mismatched.isEmpty, "\(all)")
    check("host calls: the counts", all.functionsFound == 15 && all.functionsTotal == 15 && all.selectorsFound == 2 && all.selectorsTotal == 2, "\(all)")
    check("host calls: the launch line", all.line(build: "26B131").hasPrefix("private calls (host) on 26B131: host ok (15/15 functions and keys, 2/2 selectors, encodings ok); outside opens ok"), all.line(build: "26B131"))
    for name in HostCalls.skyFunctions + HostCalls.launchFunctions + HostCalls.launchKeys {
        let r = HostFakeResolver()
        r.functions.remove(name)
        let a = HostCalls.evaluate(r, base: base)
        check("host calls: no \(name): the host off", !a.host && !a.opens && a.missing == [name] && a.reasons["host"] == "\(name) missing", "\(a)")
    }
    for name in HostCalls.noteFunctions {
        let r = HostFakeResolver()
        r.functions.remove(name)
        let a = HostCalls.evaluate(r, base: base)
        check("host calls: no \(name): the host on, outside opens off", a.host && !a.opens && a.reasons["outside opens"] == "\(name) missing", "\(a)")
    }
    do {
        let r = HostFakeResolver()
        r.hasClass = false
        let a = HostCalls.evaluate(r, base: base)
        check("host calls: no destroy class: the host off", !a.host && a.missing == [HostCalls.destroyClass], "\(a)")
    }
    for s in HostCalls.selectors {
        let r = HostFakeResolver()
        r.encodings[s.label] = "@32@0:8Q16Q24"
        let a = HostCalls.evaluate(r, base: base)
        check("host calls: \(s.label)'s encoding changed: the host off", !a.host && a.mismatched == [s.label] && (a.reasons["host"] ?? "").contains("encoding changed"), "\(a)")
    }
    do {
        let r = HostFakeResolver()
        r.frameworks.remove(.launchServices)
        let a = HostCalls.evaluate(r, base: base)
        check("host calls: LaunchServices didn't open: the host off", !a.host && (a.reasons["host"] ?? "").contains("LaunchServices"), "\(a)")
    }
    for (part, off) in [("park", { (b: inout PrivateCalls.Availability) in b.park = false }), ("slot", { $0.slot = false }), ("geometry", { $0.geometry = false }), ("spaces", { $0.spaces = false })] {
        var b = base
        off(&b)
        let a = HostCalls.evaluate(HostFakeResolver(), base: b)
        check("host calls: PrivateCalls' \(part) part off: the host off", !a.host && a.reasons["host"] == "the \(part) part is off", "\(a)")
    }
    let wrappers = HostPrivate(resolver: HostFakeResolver(), availability: all)
    check("host calls: the wrappers refuse under MARGIN_APP_TESTS", wrappers.refuses && wrappers.tiles(of: 5) == nil && !wrappers.moveTile(1, to: 2, at: 1) && wrappers.spaceType(5) == nil
          && !wrappers.destroyFullScreenSpace(5) && !wrappers.setTileSpacing(8, space: 5) && !wrappers.setCurrent(5, display: "Main")
          && !wrappers.launchDockless(URL(fileURLWithPath: "/Applications/TextEdit.app"), arguments: [], done: { _ in }) && wrappers.listen(pid: 1, heard: { _ in }) == nil)
    check("host calls: the real resolver finds nothing in a test", HostCalls.evaluate(RealPrivateResolver(), base: base).host == false)
}
